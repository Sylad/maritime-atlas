"""
weather-fetcher — récupère les forecasts vent (GFS) et vagues (WaveWatch III)
NOAA NOMADS, recadre sur la France métropole, exporte en GeoTIFF time-tagged
dans les mosaic stores GeoServer (volumes partagés), et publish raster.ready
sur RabbitMQ.

Sources :
- GFS (Global Forecast System) — vent à 10m (composantes U/V → speed sqrt)
  https://nomads.ncep.noaa.gov/, runs 00/06/12/18 UTC, forecast +384h
  Subset bbox FR via filter_gfs_0p25.pl CGI (renvoie GRIB2 minimal).

- WW3 (WaveWatch III) — hauteur significative (HTSGW) + direction (DIRPW)
  https://nomads.ncep.noaa.gov/, runs 00/06/12/18 UTC, forecast +180h
  Subset via filter_gfswave.pl CGI.

Pour un MVP utile sans saturer le NAS, on prend :
  - Run le plus récent dispo
  - Forecast de h=0 à h=FORECAST_HOURS (default 72h = 3 jours) par pas de
    FORECAST_STEP heures (default 6h) → 13 timesteps × 2 layers = 26 GeoTIFFs
    par run, ~50KB chacun = ~1.3MB par run, ~5MB par jour.

Pattern fichier : <var>_YYYYMMDDTHHMMSSZ.tif. Le timeregex GeoServer extrait
le timestamp du nom et active la time dim.

3 layers exposés in fine côté GeoServer :
  - maritime:wind_speed (m/s)
  - maritime:wave_hs (m)
  - maritime:wave_dir (degrés cardinaux, 0=Nord)
"""
from __future__ import annotations

import json
import logging
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import numpy as np
import pika
import requests
import xarray as xr

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(name)s: %(message)s',
)
log = logging.getLogger('weather-fetcher')

# ─── Config ─────────────────────────────────────────────────────────────
WIND_DIR = Path(os.environ.get('WIND_DIR', '/coverage/wind-speed'))
WAVE_HS_DIR = Path(os.environ.get('WAVE_HS_DIR', '/coverage/wave-hs'))
WAVE_DIR_DIR = Path(os.environ.get('WAVE_DIR_DIR', '/coverage/wave-dir'))
# Sprint 6 : arrows GeoJSON pour flèches de vent côté frontend.
# Volume séparé (pas /coverage) car ce n'est pas un raster GeoServer.
WIND_ARROWS_DIR = Path(os.environ.get('WIND_ARROWS_DIR', '/wind-arrows'))

RABBITMQ_URL = os.environ.get('RABBITMQ_URL', 'amqp://maritime:maritime@rabbitmq:5672')
GEOSERVER_URL = os.environ.get('GEOSERVER_URL', 'http://geoserver:8080/geoserver')
GEOSERVER_USER = os.environ.get('GEOSERVER_ADMIN_USER', 'admin')
GEOSERVER_PASS = os.environ.get('GEOSERVER_ADMIN_PASSWORD', 'geoserver')

# Bbox Europe étroite (sprint Europe 2026-05-12) — cohérence avec sst + ais.
# Açores → Pologne, Méditerranée → Cap Nord. GFS 0.25° couvre toute la Terre,
# le subset NOMADS gère la bbox sans souci de coverage.
BBOX_LON = (-15.0, 30.0)
BBOX_LAT = (35.0, 65.0)

# Forecast horizon. 72h × pas 6h = 13 timesteps. Ajustable via env.
FORECAST_HOURS = int(os.environ.get('FORECAST_HOURS', '72'))
FORECAST_STEP = int(os.environ.get('FORECAST_STEP', '6'))

# NOMADS endpoints (CGI subsetters renvoient un GRIB2 minimal).
GFS_BASE = 'https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl'
WW3_BASE = 'https://nomads.ncep.noaa.gov/cgi-bin/filter_gfswave.pl'


# ─── RabbitMQ ───────────────────────────────────────────────────────────
def publish_raster_ready(payload: dict) -> None:
    try:
        params = pika.URLParameters(RABBITMQ_URL)
        conn = pika.BlockingConnection(params)
        ch = conn.channel()
        ch.exchange_declare(exchange='raster.ready', exchange_type='fanout', durable=True)
        ch.basic_publish(
            exchange='raster.ready',
            routing_key='',
            body=json.dumps(payload).encode('utf-8'),
            properties=pika.BasicProperties(content_type='application/json', delivery_mode=2),
        )
        conn.close()
        log.info('Published raster.ready: %s', payload)
    except Exception as exc:
        log.warning('raster.ready publish failed: %s', exc)


# ─── GeoServer ImageMosaic config ───────────────────────────────────────
INDEXER_PROPERTIES = """\
TimeAttribute=time
Schema=*the_geom:Polygon,location:String,time:java.util.Date
PropertyCollectors=TimestampFileNameExtractorSPI[timeregex](time)
Caching=false
LooseBBox=true
Heterogeneous=false
"""

# Format pattern : YYYYMMDDTHHMMSSZ → 16 chars, regex robuste.
TIMEREGEX_PROPERTIES = """\
regex=[0-9]{8}T[0-9]{6}Z,format=yyyyMMdd'T'HHmmss'Z'
"""


def ensure_mosaic_config_files(coverage_dir: Path) -> None:
    coverage_dir.mkdir(parents=True, exist_ok=True)
    (coverage_dir / 'indexer.properties').write_text(INDEXER_PROPERTIES)
    (coverage_dir / 'timeregex.properties').write_text(TIMEREGEX_PROPERTIES)


def coverage_store_exists(store_name: str) -> bool:
    try:
        r = requests.get(
            f"{GEOSERVER_URL}/rest/workspaces/maritime/coveragestores/{store_name}.json",
            auth=(GEOSERVER_USER, GEOSERVER_PASS),
            timeout=10,
        )
        return r.status_code == 200
    except Exception:
        return False


def create_mosaic_store(store_name: str, coverage_name: str, coverage_dir: Path, title: str) -> bool:
    """Pattern 3 étapes (cf sst-fetcher pour le détail)."""
    log.info('Creating ImageMosaic %s (dir=%s)…', store_name, coverage_dir)
    try:
        store_payload = {
            'coverageStore': {
                'name': store_name,
                'type': 'ImageMosaic',
                'enabled': True,
                'workspace': {'name': 'maritime'},
                'url': f'file://{coverage_dir}',
            },
        }
        r = requests.post(
            f"{GEOSERVER_URL}/rest/workspaces/maritime/coveragestores",
            json=store_payload,
            auth=(GEOSERVER_USER, GEOSERVER_PASS),
            timeout=60,
        )
        if r.status_code not in (200, 201):
            log.warning('Step 1 (store) HTTP %d: %s', r.status_code, r.text[:300])
            return False

        r2 = requests.post(
            f"{GEOSERVER_URL}/rest/workspaces/maritime/coveragestores/{store_name}/external.imagemosaic",
            data=str(coverage_dir),
            headers={'Content-Type': 'text/plain'},
            auth=(GEOSERVER_USER, GEOSERVER_PASS),
            timeout=60,
        )
        if r2.status_code not in (200, 201, 202):
            log.warning('Step 2 (harvest) HTTP %d: %s', r2.status_code, r2.text[:300])
            return False

        # Strategy MAXIMUM = quand TIME absent côté requête, GS prend le dernier
        # timestep dispo. NEAREST nécessite un referenceValue qu'on n'a pas
        # (ServiceException sinon, qui SKIP la layer en GetCapabilities).
        coverage_xml = f"""<coverage>
  <name>{coverage_name}</name>
  <nativeName>{coverage_name}</nativeName>
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
            f"{GEOSERVER_URL}/rest/workspaces/maritime/coveragestores/{store_name}/coverages",
            data=coverage_xml,
            headers={'Content-Type': 'text/xml'},
            auth=(GEOSERVER_USER, GEOSERVER_PASS),
            timeout=30,
        )
        if r3.status_code in (200, 201):
            log.info('Mosaic %s published with time dim', store_name)
            return True
        log.warning('Step 3 (coverage) HTTP %d: %s', r3.status_code, r3.text[:300])
        return False
    except Exception as exc:
        log.error('Mosaic %s create failed: %s', store_name, exc)
        return False


def trigger_reindex(store_name: str, coverage_dir: Path) -> None:
    try:
        r = requests.post(
            f"{GEOSERVER_URL}/rest/workspaces/maritime/coveragestores/{store_name}/external.imagemosaic",
            data=str(coverage_dir),
            headers={'Content-Type': 'text/plain'},
            auth=(GEOSERVER_USER, GEOSERVER_PASS),
            timeout=30,
        )
        if r.status_code in (200, 201, 202):
            log.info('Reindex %s OK', store_name)
        else:
            log.warning('Reindex %s HTTP %d', store_name, r.status_code)
    except Exception as exc:
        log.warning('Reindex %s failed: %s', store_name, exc)


# ─── Fetch GRIB2 helpers ────────────────────────────────────────────────
def latest_gfs_run() -> datetime:
    """NOAA publie un run GFS toutes les 6h (00, 06, 12, 18 UTC). Latence
    de mise à dispo des fichiers ~3-4h après l'heure du run. On prend donc
    le run le plus récent dispo, soit (now - 4h) arrondi à 6h."""
    now = datetime.now(timezone.utc) - timedelta(hours=4)
    run_hour = (now.hour // 6) * 6
    return now.replace(hour=run_hour, minute=0, second=0, microsecond=0)


def gfs_url(run: datetime, fhour: int) -> str:
    """URL CGI subset GFS pour vent à 10m (UGRD + VGRD)."""
    yyyymmdd = run.strftime('%Y%m%d')
    hh = run.strftime('%H')
    fff = f"{fhour:03d}"
    return (
        f"{GFS_BASE}?"
        f"file=gfs.t{hh}z.pgrb2.0p25.f{fff}"
        f"&var_UGRD=on&var_VGRD=on"
        f"&lev_10_m_above_ground=on"
        f"&subregion=&leftlon={BBOX_LON[0]}&rightlon={BBOX_LON[1]}"
        f"&toplat={BBOX_LAT[1]}&bottomlat={BBOX_LAT[0]}"
        f"&dir=%2Fgfs.{yyyymmdd}%2F{hh}%2Fatmos"
    )


def ww3_url(run: datetime, fhour: int) -> str:
    """URL CGI subset WaveWatch III pour HTSGW + DIRPW."""
    yyyymmdd = run.strftime('%Y%m%d')
    hh = run.strftime('%H')
    fff = f"{fhour:03d}"
    return (
        f"{WW3_BASE}?"
        f"file=gfswave.t{hh}z.global.0p25.f{fff}.grib2"
        f"&var_HTSGW=on&var_DIRPW=on"
        f"&subregion=&leftlon={BBOX_LON[0]}&rightlon={BBOX_LON[1]}"
        f"&toplat={BBOX_LAT[1]}&bottomlat={BBOX_LAT[0]}"
        f"&dir=%2Fgfs.{yyyymmdd}%2F{hh}%2Fwave%2Fgridded"
    )


def fetch_grib(url: str, dest: Path) -> bool:
    try:
        with requests.get(url, stream=True, timeout=120) as r:
            if r.status_code != 200:
                log.info('GRIB fetch %s → HTTP %d (skip)', url[-60:], r.status_code)
                return False
            dest.parent.mkdir(parents=True, exist_ok=True)
            with open(dest, 'wb') as f:
                for chunk in r.iter_content(chunk_size=64 * 1024):
                    f.write(chunk)
        return dest.stat().st_size > 200  # filtre les "empty grib" (~50 bytes)
    except Exception as exc:
        log.warning('GRIB fetch failed: %s', exc)
        return False


def generate_arrows_geojson(u: xr.DataArray, v: xr.DataArray, speed: xr.DataArray,
                            valid_time: datetime, step_lon: int = 2, step_lat: int = 2) -> Path | None:
    """Génère un GeoJSON FeatureCollection de points avec direction + force du
    vent. Sample 1 point sur `step_lon`×`step_lat` cellules de la grille GFS
    pour avoir ~150-300 flèches (sinon overdraw illisible sur la carte).

    Convention compass :
      - dirTo: 0=N, 90=E, 180=S, 270=W (vers où le vent VA)
      - dirFrom: dirTo + 180 mod 360 (D'OÙ vient le vent — convention météo)
    """
    # Récupère lat/lon ordonnés. NB : weather-fetcher normalise lon en [-180,180]
    # mais ne sort pas par lat — on lit ds.coords directement.
    if 'longitude' not in u.coords or 'latitude' not in u.coords:
        return None
    lons = u['longitude'].values
    lats = u['latitude'].values
    u_arr = u.values
    v_arr = v.values
    spd_arr = speed.values

    features = []
    for j in range(0, len(lats), step_lat):
        for i in range(0, len(lons), step_lon):
            spd = float(spd_arr[j, i])
            if not np.isfinite(spd) or spd < 0.5:
                continue  # skip near-zero (illisible) et NaN
            uu = float(u_arr[j, i])
            vv = float(v_arr[j, i])
            # math angle (counter-clockwise from east)
            theta_math = np.degrees(np.arctan2(vv, uu))   # 0=E, 90=N
            # convert to compass (clockwise from north)
            dir_to = (90 - theta_math) % 360
            dir_from = (dir_to + 180) % 360
            features.append({
                'type': 'Feature',
                'geometry': {
                    'type': 'Point',
                    'coordinates': [round(float(lons[i]), 4), round(float(lats[j]), 4)],
                },
                'properties': {
                    'speed': round(spd, 2),
                    'dirTo': round(float(dir_to), 1),
                    'dirFrom': round(float(dir_from), 1),
                },
            })

    geojson = {
        'type': 'FeatureCollection',
        'features': features,
        'properties': {
            'valid_time': valid_time.isoformat(),
            'forecast_run': 'GFS 0.25°',
            'sampling': f'{step_lon}x{step_lat} grid step',
        },
    }
    WIND_ARROWS_DIR.mkdir(parents=True, exist_ok=True)
    ts_str = valid_time.strftime('%Y%m%dT%H%M%SZ')
    out = WIND_ARROWS_DIR / f'wind_arrows_{ts_str}.geojson'
    out.write_text(json.dumps(geojson, separators=(',', ':')))
    update_arrows_manifest()
    return out


def generate_wave_arrows_geojson(hs: xr.DataArray, direction: xr.DataArray,
                                  valid_time: datetime, step_lon: int = 2, step_lat: int = 2) -> Path | None:
    """Idem wind, mais pour WW3. WW3 DIRPW = direction D'OÙ viennent les vagues
    (convention météo). On stocke les deux conventions pour laisser le frontend
    choisir l'orientation des flèches."""
    if 'longitude' not in hs.coords or 'latitude' not in hs.coords:
        return None
    lons = hs['longitude'].values
    lats = hs['latitude'].values
    hs_arr = hs.values
    dir_arr = direction.values

    features = []
    for j in range(0, len(lats), step_lat):
        for i in range(0, len(lons), step_lon):
            h = float(hs_arr[j, i])
            d_from = float(dir_arr[j, i])
            if not np.isfinite(h) or not np.isfinite(d_from) or h < 0.1:
                continue  # Pas de vague côté terre (NaN sur land mask)
            d_to = (d_from + 180) % 360
            features.append({
                'type': 'Feature',
                'geometry': {
                    'type': 'Point',
                    'coordinates': [round(float(lons[i]), 4), round(float(lats[j]), 4)],
                },
                'properties': {
                    'hs': round(h, 2),
                    'dirFrom': round(d_from, 1),
                    'dirTo': round(d_to, 1),
                },
            })

    geojson = {
        'type': 'FeatureCollection',
        'features': features,
        'properties': {
            'valid_time': valid_time.isoformat(),
            'forecast_run': 'NOAA WaveWatch III 0.25°',
            'sampling': f'{step_lon}x{step_lat} grid step',
        },
    }
    WIND_ARROWS_DIR.mkdir(parents=True, exist_ok=True)
    ts_str = valid_time.strftime('%Y%m%dT%H%M%SZ')
    out = WIND_ARROWS_DIR / f'wave_arrows_{ts_str}.geojson'
    out.write_text(json.dumps(geojson, separators=(',', ':')))
    # Manifest mis à jour conjointement avec wind_arrows
    update_arrows_manifest()
    return out


def update_arrows_manifest() -> None:
    """Synchronise un manifest unique listant les ts dispos pour vent + vagues.
    Le frontend l'interroge pour trouver le ts le plus proche du cursor."""
    wind_ts = sorted([
        p.stem.replace('wind_arrows_', '')
        for p in WIND_ARROWS_DIR.glob('wind_arrows_*.geojson')
    ])
    wave_ts = sorted([
        p.stem.replace('wave_arrows_', '')
        for p in WIND_ARROWS_DIR.glob('wave_arrows_*.geojson')
    ])
    manifest = {
        'wind': wind_ts,
        'wave': wave_ts,
        'patterns': {
            'wind': '/wind-arrows/wind_arrows_{ts}.geojson',
            'wave': '/wind-arrows/wave_arrows_{ts}.geojson',
        },
        'updated_at': datetime.now(timezone.utc).isoformat(),
    }
    (WIND_ARROWS_DIR / 'manifest.json').write_text(json.dumps(manifest, separators=(',', ':')))


def grib_to_geotiffs(grib: Path, valid_time: datetime) -> dict[str, Path]:
    """Charge le GRIB2 + écrit chaque var en GeoTIFF dans son dossier dédié.
    Renvoie {var_name: path}."""
    out: dict[str, Path] = {}
    ts_str = valid_time.strftime('%Y%m%dT%H%M%SZ')
    try:
        ds = xr.open_dataset(grib, engine='cfgrib', backend_kwargs={'indexpath': ''})
    except Exception as exc:
        log.warning('GRIB open failed (%s) — skip', exc)
        return out

    # Normalise lon en [-180, 180] pour rioxarray + GeoServer EPSG:4326
    if 'longitude' in ds.coords:
        if float(ds['longitude'].max()) > 180:
            ds = ds.assign_coords(longitude=(((ds['longitude'] + 180) % 360) - 180))
            ds = ds.sortby('longitude')

    def export(da: xr.DataArray, dest: Path) -> None:
        # Force latitude décroissante avant rename (north-up GeoTIFF,
        # sinon Origin = coin sud-ouest et le WMS sert des tuiles flippées
        # verticalement). Le sortby doit se faire AVANT le set_spatial_dims.
        if 'latitude' in da.coords:
            da = da.sortby('latitude', ascending=False)
        # Renomme dims en x/y pour rioxarray
        da = da.rename({'longitude': 'x', 'latitude': 'y'}) if 'longitude' in da.dims else da
        da = da.rio.set_spatial_dims(x_dim='x', y_dim='y', inplace=False)
        da = da.rio.write_crs('EPSG:4326')
        dest.parent.mkdir(parents=True, exist_ok=True)
        da.rio.to_raster(dest, driver='GTiff', compress='LZW', tiled=True,
                         blockxsize=128, blockysize=128)

    # Vent : speed = sqrt(u² + v²) — un seul GeoTIFF, plus simple côté GeoServer
    if 'u10' in ds.variables and 'v10' in ds.variables:
        u = ds['u10'].astype('float32')
        v = ds['v10'].astype('float32')
        speed = np.sqrt(u ** 2 + v ** 2)
        speed.name = 'wind_speed'
        speed.attrs['units'] = 'm s-1'
        speed.attrs['long_name'] = 'Wind speed at 10m'
        dest = WIND_DIR / f'wind_speed_{ts_str}.tif'
        if not dest.exists():
            export(speed, dest)
            out['wind_speed'] = dest

        # Sprint 6 : GeoJSON arrows (point + speed + dirTo en compass).
        # Convention :
        #   - U/V composantes m/s en repère mathématique (u→est, v→nord)
        #   - dirTo = direction où le vent VA (compass : 0=N, 90=E, 180=S, 270=O)
        #   - dirFrom = +180 mod 360 = origine météo classique (D'OÙ vient le vent)
        # Pour les flèches "pointe = direction du voyage", on tourne la pointe
        # de l'icône (qui pointe nord par défaut) de `dirTo` degrés horloge.
        try:
            arrows_path = generate_arrows_geojson(u, v, speed, valid_time)
            if arrows_path is not None:
                out['wind_arrows'] = arrows_path
        except Exception as exc:
            log.warning('arrows GeoJSON generation failed: %s', exc)

    # Vagues HS + DIRPW (les deux toujours ensemble dans WW3 gridded)
    hs_var = 'swh' if 'swh' in ds.variables else ('HTSGW' if 'HTSGW' in ds.variables else None)
    dir_var = next((v for v in ('dirpw', 'mwd', 'DIRPW') if v in ds.variables), None)

    if hs_var:
        hs = ds[hs_var].astype('float32')
        hs.attrs['units'] = 'm'
        dest = WAVE_HS_DIR / f'wave_hs_{ts_str}.tif'
        if not dest.exists():
            export(hs, dest)
            out['wave_hs'] = dest

    if dir_var:
        d = ds[dir_var].astype('float32')
        d.attrs['units'] = 'degrees'
        dest = WAVE_DIR_DIR / f'wave_dir_{ts_str}.tif'
        if not dest.exists():
            export(d, dest)
            out['wave_dir'] = dest

    # Sprint 6b : GeoJSON arrows pour les vagues. WW3 retourne DIRPW =
    # "primary wave direction" en degrés compass D'OÙ viennent les vagues
    # (convention météo standard, comme le vent météo). On génère donc :
    #   - dirFrom = valeur DIRPW telle quelle
    #   - dirTo   = (dirFrom + 180) % 360
    # Pour une flèche pointant vers où les vagues se DIRIGENT, rotate de dirTo.
    if hs_var and dir_var:
        try:
            arrows_path = generate_wave_arrows_geojson(
                ds[hs_var].astype('float32'),
                ds[dir_var].astype('float32'),
                valid_time,
            )
            if arrows_path is not None:
                out['wave_arrows'] = arrows_path
        except Exception as exc:
            log.warning('wave arrows GeoJSON failed: %s', exc)

    ds.close()
    return out


# ─── Cycle ──────────────────────────────────────────────────────────────
def cleanup_old_files(retention_days: int = 7) -> None:
    """Sprint 10b — supprime .tif et .geojson plus vieux que retention_days.
    Forecasts météo deviennent obsolètes vite, 7j suffit. Parse le timestamp
    YYYYMMDDTHHMMSSZ depuis le nom de fichier."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)
    removed = 0
    for d in (WIND_DIR, WAVE_HS_DIR, WAVE_DIR_DIR, WIND_ARROWS_DIR):
        if not d.exists():
            continue
        for f in list(d.glob('*.tif')) + list(d.glob('*.geojson')):
            try:
                parts = f.stem.split('_')
                ts_token = next((p for p in parts if len(p) == 16 and p.endswith('Z') and 'T' in p), None)
                if not ts_token:
                    continue
                file_date = datetime.strptime(ts_token, '%Y%m%dT%H%M%SZ').replace(tzinfo=timezone.utc)
                if file_date < cutoff:
                    f.unlink()
                    removed += 1
            except (ValueError, IndexError):
                continue
    if removed > 0:
        log.info('Cleanup: removed %d weather files older than %dd', removed, retention_days)


def run_fetch_cycle() -> None:
    log.info('weather-fetcher cycle starting (forecast=%dh, step=%dh)',
             FORECAST_HOURS, FORECAST_STEP)
    cleanup_old_files(retention_days=int(os.environ.get('WEATHER_RETENTION_DAYS', '7')))
    for d in (WIND_DIR, WAVE_HS_DIR, WAVE_DIR_DIR):
        ensure_mosaic_config_files(d)

    run = latest_gfs_run()
    log.info('Using GFS run %s', run.isoformat())

    fhours = list(range(0, FORECAST_HOURS + 1, FORECAST_STEP))
    new_files: dict[str, list[Path]] = {'wind_speed': [], 'wave_hs': [], 'wave_dir': []}

    for fhour in fhours:
        valid_time = run + timedelta(hours=fhour)
        ts_str = valid_time.strftime('%Y%m%dT%H%M%SZ')
        log.debug('--- fhour=%d valid=%s ---', fhour, ts_str)

        # GFS wind
        gfs_grib = WIND_DIR / f'_tmp_gfs_{ts_str}.grib2'
        if fetch_grib(gfs_url(run, fhour), gfs_grib):
            paths = grib_to_geotiffs(gfs_grib, valid_time)
            for var, p in paths.items():
                new_files.setdefault(var, []).append(p)
            gfs_grib.unlink(missing_ok=True)
            (gfs_grib.with_suffix('.grib2.idx')).unlink(missing_ok=True)

        # WW3 waves
        ww3_grib = WAVE_HS_DIR / f'_tmp_ww3_{ts_str}.grib2'
        if fetch_grib(ww3_url(run, fhour), ww3_grib):
            paths = grib_to_geotiffs(ww3_grib, valid_time)
            for var, p in paths.items():
                new_files.setdefault(var, []).append(p)
            ww3_grib.unlink(missing_ok=True)
            (ww3_grib.with_suffix('.grib2.idx')).unlink(missing_ok=True)

    log.info('Cycle done — new GeoTIFFs: wind=%d, wave_hs=%d, wave_dir=%d',
             len(new_files['wind_speed']), len(new_files['wave_hs']), len(new_files['wave_dir']))

    # Wait for GeoServer (au boot peut être lent)
    for _ in range(10):
        try:
            r = requests.get(f"{GEOSERVER_URL}/rest/about/status",
                             auth=(GEOSERVER_USER, GEOSERVER_PASS), timeout=5)
            if r.status_code == 200:
                break
        except Exception:
            pass
        time.sleep(3)

    # Pour chaque store, créer s'il n'existe pas (avec ≥1 GeoTIFF), sinon réindexer
    # coverage_name doit matcher le nom du DOSSIER (cf bug SST sprint 3) —
    # GeoServer auto-discover via le path, le store name est arbitraire mais
    # le coverage doit reprendre le basename du dir.
    layers = [
        ('wind_speed', 'wind-speed', WIND_DIR, 'Wind speed at 10m (NOAA GFS)'),
        ('wave_hs',    'wave-hs',    WAVE_HS_DIR, 'Significant wave height (NOAA WW3)'),
        ('wave_dir',   'wave-dir',   WAVE_DIR_DIR, 'Primary wave direction (NOAA WW3)'),
    ]
    for store, coverage, cdir, title in layers:
        has_tifs = any(cdir.glob('*_*.tif'))
        if has_tifs and not coverage_store_exists(store):
            create_mosaic_store(store, coverage, cdir, title)
        elif new_files.get(store):
            trigger_reindex(store, cdir)

    publish_raster_ready({
        'type': 'weather',
        'run': run.isoformat(),
        'forecast_hours': FORECAST_HOURS,
        'new_files': {k: len(v) for k, v in new_files.items()},
    })
    log.info('weather-fetcher cycle done')


def main() -> None:
    for d in (WIND_DIR, WAVE_HS_DIR, WAVE_DIR_DIR):
        d.mkdir(parents=True, exist_ok=True)
    log.info('weather-fetcher starting')

    run_fetch_cycle()

    # Cron 4×/jour calé sur les runs NOAA + 4h de latence — donc 04, 10, 16, 22 UTC
    from apscheduler.schedulers.blocking import BlockingScheduler
    sched = BlockingScheduler(timezone='UTC')
    sched.add_job(run_fetch_cycle, 'cron', hour='4,10,16,22', minute=15)
    log.info('Scheduler armed (04:15 / 10:15 / 16:15 / 22:15 UTC)')
    try:
        sched.start()
    except (KeyboardInterrupt, SystemExit):
        sys.exit(0)


if __name__ == '__main__':
    main()
