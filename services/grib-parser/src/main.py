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
import rioxarray  # noqa: F401  — registers xr.DataArray.rio accessor
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
    # ─── Sprint N4 Phase 2 : auto-create GeoServer store ───
    geoserver_create_if_missing: Optional[bool] = Field(False)
    geoserver_workspace: Optional[str] = Field('maritime')
    geoserver_store: Optional[str] = Field(None)
    geoserver_coverage: Optional[str] = Field(None, description='Nom de la coverage (= basename output_dir)')
    geoserver_title: Optional[str] = Field(None)


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
            _maybe_geoserver(req, out_dir)
            return ParseResponse(ok=True, paths=[str(path)], records_out=1, bytes_in=bytes_in)

        if req.kind == 'grib_wave':
            path = _parse_grib_wave(tmp_path, out_dir, req.output_prefix, ts_str, req.bbox)
            _maybe_geoserver(req, out_dir)
            return ParseResponse(ok=True, paths=[str(path)], records_out=1, bytes_in=bytes_in)

        if req.kind == 'netcdf_sst':
            path = _parse_netcdf_sst(tmp_path, out_dir, req.output_prefix, ts_str, req.bbox)
            _maybe_geoserver(req, out_dir)
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


# ─── GeoServer auto-create + reindex (Sprint N4 Phase 2) ─────────────
GEOSERVER_URL = os.environ.get('GEOSERVER_URL', 'http://geoserver:8080/geoserver')
GEOSERVER_USER = os.environ.get('GEOSERVER_ADMIN_USER', 'admin')
GEOSERVER_PASS = os.environ.get('GEOSERVER_ADMIN_PASSWORD', 'geoserver')

INDEXER_PROPERTIES = """\
TimeAttribute=time
Schema=*the_geom:Polygon,location:String,time:java.util.Date
PropertyCollectors=TimestampFileNameExtractorSPI[timeregex](time)
Caching=false
LooseBBox=true
Heterogeneous=false
"""
TIMEREGEX_PROPERTIES = """\
regex=[0-9]{8}T[0-9]{6}Z,format=yyyyMMdd'T'HHmmss'Z'
"""


def _maybe_geoserver(req: ParseRequest, out_dir: Path) -> None:
    """Si geoserver_create_if_missing=True : crée le coveragestore si
    manquant, ou trigger un reindex external.imagemosaic sinon. Best
    effort — n'échoue pas la requête si GeoServer est down."""
    if not req.geoserver_create_if_missing:
        return
    if not req.geoserver_store or not req.geoserver_coverage:
        log.warning('geoserver_create_if_missing=True but store/coverage missing — skip')
        return
    try:
        _ensure_indexer_props(out_dir)
        if _coverage_store_exists(req.geoserver_workspace, req.geoserver_store):
            _trigger_reindex(req.geoserver_workspace, req.geoserver_store, out_dir)
        else:
            _create_mosaic_store(
                req.geoserver_workspace, req.geoserver_store,
                req.geoserver_coverage, out_dir,
                req.geoserver_title or f'{req.geoserver_coverage}',
            )
    except Exception as exc:
        log.warning('GeoServer step failed: %s', exc)


def _ensure_indexer_props(coverage_dir: Path) -> None:
    coverage_dir.mkdir(parents=True, exist_ok=True)
    (coverage_dir / 'indexer.properties').write_text(INDEXER_PROPERTIES)
    (coverage_dir / 'timeregex.properties').write_text(TIMEREGEX_PROPERTIES)


def _coverage_store_exists(workspace: str, store: str) -> bool:
    try:
        r = requests.get(
            f'{GEOSERVER_URL}/rest/workspaces/{workspace}/coveragestores/{store}.json',
            auth=(GEOSERVER_USER, GEOSERVER_PASS), timeout=10,
        )
        return r.status_code == 200
    except Exception:
        return False


def _trigger_reindex(workspace: str, store: str, coverage_dir: Path) -> None:
    r = requests.post(
        f'{GEOSERVER_URL}/rest/workspaces/{workspace}/coveragestores/{store}/external.imagemosaic',
        data=str(coverage_dir),
        headers={'Content-Type': 'text/plain'},
        auth=(GEOSERVER_USER, GEOSERVER_PASS), timeout=30,
    )
    if r.status_code in (200, 201, 202):
        log.info('Reindex %s OK', store)
    else:
        log.warning('Reindex %s HTTP %d: %s', store, r.status_code, r.text[:200])


def _create_mosaic_store(workspace: str, store: str, coverage: str,
                          coverage_dir: Path, title: str) -> None:
    """3 steps : create store, harvest external.imagemosaic, publish
    coverage avec time dimension MAXIMUM. Pattern identique aux services
    historiques weather-fetcher / sst-fetcher."""
    log.info('Creating ImageMosaic %s/%s', workspace, store)
    # Step 1 : create coveragestore
    r1 = requests.post(
        f'{GEOSERVER_URL}/rest/workspaces/{workspace}/coveragestores',
        json={'coverageStore': {
            'name': store, 'type': 'ImageMosaic', 'enabled': True,
            'workspace': {'name': workspace},
            'url': f'file://{coverage_dir}',
        }},
        auth=(GEOSERVER_USER, GEOSERVER_PASS), timeout=60,
    )
    if r1.status_code not in (200, 201):
        log.warning('Store create HTTP %d: %s', r1.status_code, r1.text[:200])
        return
    # Step 2 : harvest les GeoTIFFs existants
    r2 = requests.post(
        f'{GEOSERVER_URL}/rest/workspaces/{workspace}/coveragestores/{store}/external.imagemosaic',
        data=str(coverage_dir),
        headers={'Content-Type': 'text/plain'},
        auth=(GEOSERVER_USER, GEOSERVER_PASS), timeout=60,
    )
    if r2.status_code not in (200, 201, 202):
        log.warning('Harvest HTTP %d: %s', r2.status_code, r2.text[:200])
        return
    # Step 3 : publish coverage avec time dim
    coverage_xml = f"""<coverage>
  <name>{coverage}</name>
  <nativeName>{coverage}</nativeName>
  <title>{title}</title>
  <enabled>true</enabled>
  <metadata>
    <entry key="time">
      <dimensionInfo>
        <enabled>true</enabled>
        <presentation>LIST</presentation>
        <units>ISO8601</units>
        <defaultValue><strategy>MAXIMUM</strategy></defaultValue>
      </dimensionInfo>
    </entry>
  </metadata>
</coverage>"""
    r3 = requests.post(
        f'{GEOSERVER_URL}/rest/workspaces/{workspace}/coveragestores/{store}/coverages',
        data=coverage_xml,
        headers={'Content-Type': 'text/xml'},
        auth=(GEOSERVER_USER, GEOSERVER_PASS), timeout=30,
    )
    if r3.status_code in (200, 201):
        log.info('Mosaic %s published with time dim', store)
    else:
        log.warning('Coverage publish HTTP %d: %s', r3.status_code, r3.text[:200])


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
