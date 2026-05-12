"""
grib-parser — sidecar FastAPI appelé par le runner orchestrator (Node)
pour parser GRIB/NetCDF + écrire des GeoTIFFs dans le volume coverage
partagé avec GeoServer.

Sprint N4 (2026-05-12) du data orchestrator. Premier brick pour migrer
les fetchers historiques (sst-fetcher, weather-fetcher, …) vers
l'orchestration dynamique sans réécrire xarray+rioxarray en Node.

Pattern de découplage :
- Le runner Node parle HTTP avec ce sidecar (POST /parse).
- Le sidecar fetch le fichier (HTTP), parse (cfgrib/xarray), reproject
  vers EPSG:4326 (rioxarray), écrit le GeoTIFF dans le volume partagé.
- Le runner reçoit le path + meta, trigger un reindex GeoServer si
  l'option `reindex_geoserver_store` est précisée.

Endpoints :
  GET  /health                 → {"ok": true}
  POST /parse                  → parse un GRIB unique
                                  body : {url, kind, output_dir,
                                          valid_time?, bbox?, vars?}
                                  → {paths: [...], records_out: N,
                                     bytes_in: N, error?: str}

Sécurité : pas d'auth (le sidecar n'est exposé que sur le réseau
interne docker compose, pas de port publié). Si on l'expose, ajouter
un shared secret ORCHESTRATOR_PARSER_TOKEN.
"""
from __future__ import annotations

import logging
import os
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Literal, Optional

import numpy as np
import requests
import xarray as xr
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(name)s: %(message)s',
)
log = logging.getLogger('grib-parser')

app = FastAPI(title='grib-parser', version='0.1.0')


# ─── Models ─────────────────────────────────────────────────────────────
ParserKind = Literal['grib_wind10m', 'grib_wave', 'netcdf_sst', 'identity']


class ParseRequest(BaseModel):
    """Requête de parsing.

    Pour `kind='grib_wind10m'` : extrait u10/v10 → speed (sqrt) en GeoTIFF.
    Pour `kind='grib_wave'`    : extrait swh (Hs) en GeoTIFF.
    Pour `kind='netcdf_sst'`   : extrait sst (NOAA OISST) en GeoTIFF.
    Pour `kind='identity'`     : juste télécharge, pas de reprojection."""
    url: str = Field(..., description='URL du fichier source (GRIB ou NetCDF)')
    kind: ParserKind = Field(..., description='Type de parsing')
    output_dir: str = Field(..., description='Dossier de sortie (path absolu monté en volume)')
    output_prefix: str = Field('output', description='Préfixe nom de fichier (ex: arpege_wind_speed)')
    valid_time: Optional[str] = Field(None, description='ISO datetime pour le nom de fichier')
    bbox: Optional[list[float]] = Field(None, description='[minLon, minLat, maxLon, maxLat] EPSG:4326')


class ParseResponse(BaseModel):
    ok: bool
    paths: list[str] = Field(default_factory=list)
    records_out: int = 0
    bytes_in: int = 0
    error: Optional[str] = None


# ─── Health ─────────────────────────────────────────────────────────────
@app.get('/health')
def health() -> dict:
    return {'ok': True, 'service': 'grib-parser', 'version': '0.1.0'}


# ─── Parse endpoint ─────────────────────────────────────────────────────
@app.post('/parse', response_model=ParseResponse)
def parse(req: ParseRequest) -> ParseResponse:
    """Fetch + parse + write GeoTIFF. Synchrone : peut prendre 10-60s
    selon la taille du fichier (GRIB AROME ≈ 55 MB / cycle). Le runner
    Node a un timeout 300s côté fetch HTTP."""
    log.info('Parse kind=%s url=%s', req.kind, req.url[-80:])
    try:
        # 1. Fetch
        with tempfile.NamedTemporaryFile(suffix='.dat', delete=False) as tmp:
            tmp_path = Path(tmp.name)
        bytes_in = _download(req.url, tmp_path)
        # 2. Parse + write
        out_dir = Path(req.output_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        valid_time = _parse_iso(req.valid_time) if req.valid_time else None
        ts_str = (valid_time or datetime.utcnow()).strftime('%Y%m%dT%H%M%SZ')

        if req.kind == 'identity':
            # On copie juste le fichier brut
            final = out_dir / f'{req.output_prefix}_{ts_str}.bin'
            final.write_bytes(tmp_path.read_bytes())
            return ParseResponse(ok=True, paths=[str(final)], records_out=1, bytes_in=bytes_in)

        if req.kind == 'grib_wind10m':
            path = _parse_grib_wind10m(tmp_path, out_dir, req.output_prefix, ts_str, req.bbox)
            return ParseResponse(ok=True, paths=[str(path)], records_out=1, bytes_in=bytes_in)

        if req.kind == 'grib_wave':
            path = _parse_grib_wave(tmp_path, out_dir, req.output_prefix, ts_str, req.bbox)
            return ParseResponse(ok=True, paths=[str(path)], records_out=1, bytes_in=bytes_in)

        if req.kind == 'netcdf_sst':
            path = _parse_netcdf_sst(tmp_path, out_dir, req.output_prefix, ts_str, req.bbox)
            return ParseResponse(ok=True, paths=[str(path)], records_out=1, bytes_in=bytes_in)

        raise HTTPException(status_code=400, detail=f'Unknown kind: {req.kind}')

    except HTTPException:
        raise
    except Exception as exc:
        log.exception('Parse failed')
        return ParseResponse(ok=False, error=f'{type(exc).__name__}: {exc}'[:500])
    finally:
        try:
            tmp_path.unlink(missing_ok=True)
            (tmp_path.with_suffix('.grib2.idx')).unlink(missing_ok=True)
        except Exception:
            pass


# ─── Helpers ────────────────────────────────────────────────────────────
def _download(url: str, dest: Path) -> int:
    with requests.get(url, stream=True, timeout=300) as r:
        if r.status_code != 200:
            raise HTTPException(status_code=502, detail=f'Upstream HTTP {r.status_code}')
        size = 0
        with open(dest, 'wb') as f:
            for chunk in r.iter_content(chunk_size=256 * 1024):
                f.write(chunk)
                size += len(chunk)
    return size


def _parse_iso(s: str) -> datetime:
    return datetime.fromisoformat(s.replace('Z', '+00:00'))


def _subset(ds: xr.Dataset, bbox: Optional[list[float]]) -> xr.Dataset:
    """Subset bbox [minLon, minLat, maxLon, maxLat]. Normalise lon
    [-180,180] si nécessaire. Tolère les conventions lat asc/desc."""
    if 'longitude' in ds.coords and float(ds['longitude'].max()) > 180:
        ds = ds.assign_coords(longitude=(((ds['longitude'] + 180) % 360) - 180))
        ds = ds.sortby('longitude')
    if not bbox:
        return ds
    minLon, minLat, maxLon, maxLat = bbox
    # lat-asc puis lat-desc en fallback
    try:
        sub = ds.sel(longitude=slice(minLon, maxLon), latitude=slice(maxLat, minLat))
        if sub.latitude.size == 0:
            sub = ds.sel(longitude=slice(minLon, maxLon), latitude=slice(minLat, maxLat))
    except Exception:
        sub = ds.sel(longitude=slice(minLon, maxLon), latitude=slice(minLat, maxLat))
    return sub


def _to_geotiff(da: xr.DataArray, dest: Path) -> None:
    """Export DataArray vers GeoTIFF EPSG:4326 north-up. Convention :
    latitude descendante (origin = coin nord-ouest), x=lon / y=lat
    dims pour rioxarray."""
    if 'latitude' in da.coords:
        da = da.sortby('latitude', ascending=False)
    if 'longitude' in da.dims:
        da = da.rename({'longitude': 'x', 'latitude': 'y'})
    da = da.rio.set_spatial_dims(x_dim='x', y_dim='y', inplace=False)
    da = da.rio.write_crs('EPSG:4326')
    dest.parent.mkdir(parents=True, exist_ok=True)
    da.rio.to_raster(dest, driver='GTiff', compress='LZW', tiled=True,
                     blockxsize=256, blockysize=256)


def _parse_grib_wind10m(src: Path, out_dir: Path, prefix: str, ts_str: str,
                        bbox: Optional[list[float]]) -> Path:
    """GRIB → speed=sqrt(u10² + v10²) → GeoTIFF. cfgrib filter sur
    heightAboveGround:10 pour ne charger QUE le vent à 10m (sinon
    plusieurs niveaux empêchent un open_dataset clean)."""
    ds = xr.open_dataset(
        src, engine='cfgrib',
        backend_kwargs={
            'indexpath': '',
            'filter_by_keys': {'typeOfLevel': 'heightAboveGround', 'level': 10},
        },
    )
    ds = _subset(ds, bbox)
    if 'u10' not in ds.variables or 'v10' not in ds.variables:
        ds.close()
        raise HTTPException(status_code=422, detail='No u10/v10 in GRIB')
    u = ds['u10'].astype('float32')
    v = ds['v10'].astype('float32')
    speed = np.sqrt(u ** 2 + v ** 2)
    speed.name = 'wind_speed'
    speed.attrs['units'] = 'm s-1'
    dest = out_dir / f'{prefix}_{ts_str}.tif'
    _to_geotiff(speed, dest)
    ds.close()
    return dest


def _parse_grib_wave(src: Path, out_dir: Path, prefix: str, ts_str: str,
                     bbox: Optional[list[float]]) -> Path:
    """GRIB → swh (Hs) en GeoTIFF. cfgrib filter sur surface."""
    ds = xr.open_dataset(
        src, engine='cfgrib',
        backend_kwargs={
            'indexpath': '',
            'filter_by_keys': {'typeOfLevel': 'surface'},
        },
    )
    ds = _subset(ds, bbox)
    # Conventional NOAA WW3 names : 'swh' (sig wave height) ou 'htsgwsfc'
    candidate = next((v for v in ('swh', 'htsgwsfc', 'shww') if v in ds.variables), None)
    if not candidate:
        ds.close()
        raise HTTPException(status_code=422, detail=f'No wave var in GRIB (vars={list(ds.variables)})')
    da = ds[candidate].astype('float32')
    da.name = 'wave_hs'
    da.attrs['units'] = 'm'
    dest = out_dir / f'{prefix}_{ts_str}.tif'
    _to_geotiff(da, dest)
    ds.close()
    return dest


def _parse_netcdf_sst(src: Path, out_dir: Path, prefix: str, ts_str: str,
                      bbox: Optional[list[float]]) -> Path:
    """NOAA OISST NetCDF → sst (°C) en GeoTIFF. Le NetCDF contient
    `sst[time=1, zlev=1, lat=N, lon=M]` — on squeeze dimensions."""
    ds = xr.open_dataset(src, engine='netcdf4', mask_and_scale=True)
    if 'sst' not in ds.variables:
        ds.close()
        raise HTTPException(status_code=422, detail='No sst variable in NetCDF')
    # Normalise lon if needed
    if 'lon' in ds.coords:
        ds = ds.rename({'lon': 'longitude'})
    if 'lat' in ds.coords:
        ds = ds.rename({'lat': 'latitude'})
    ds = _subset(ds, bbox)
    da = ds['sst'].astype('float32').squeeze()
    da.name = 'sst'
    da.attrs['units'] = '°C'
    dest = out_dir / f'{prefix}_{ts_str}.tif'
    _to_geotiff(da, dest)
    ds.close()
    return dest
