"""
weather-fetcher-arome — récupère les forecasts vent à 10m du modèle AROME
de Météo-France (résolution 0.025° ≈ 2.5km, vs GFS 0.25° ≈ 25km).

Source : bucket S3 public PNT (Prévision Numérique du Temps) hébergé par
data.gouv.fr, AUCUNE clé API requise. Documentation officielle :
  https://meteo.data.gouv.fr/datasets/donnees-du-modele-arome

Structure des objets :
  pnt/<RUN_ISO>/arome/0025/SP1/arome__0025__SP1__<H1>H<H2>H__<RUN_ISO>.grib2

Où :
  - <RUN_ISO> = 2026-05-10T00:00:00Z (les 8 runs par jour : 00, 03, …, 21 UTC)
  - SP1 = "Surface Parameters 1" → contient u10, v10, t2m, surface pressure.
  - Les bundles 0025 packent 6 timesteps horaires (00H06H, 07H12H, …) →
    9 fichiers par run pour 0-51h de forecast. ~55MB par bundle.
  - Le modèle 001 (1.3km) est ~3× plus lourd (24MB×52 fichiers/run) — on
    privilégie 0025 pour le ratio gain/coût (10× finer que GFS suffit).

Pattern fichier de sortie : arome_wind_speed_<YYYYMMDDTHHMMSSZ>.tif dans
le coverage dir partagé avec GeoServer. Layer publié = maritime:wind-speed-arome.

GeoJSON arrows : arome_wind_arrows_<ts>.geojson dans /wind-arrows/ avec un
sampling step adapté à la grille fine (4×4 cells au lieu de 2×2 pour le GFS,
sinon ~50000 features pour la bbox France).

Pourquoi un service séparé plutôt qu'un mode AROME=true dans weather-fetcher ?
- Source totalement différente (S3 vs CGI NOMADS), pas de mutualisation utile.
- Schedule différent (AROME runs 8×/jour, on en prend 4 pour limiter la charge).
- Permet de désactiver l'un sans toucher l'autre (compose service profile).
"""
from __future__ import annotations

import json
import logging
import os
import re
import sys
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable

import numpy as np
import pika
import requests
import xarray as xr

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(name)s: %(message)s',
)
log = logging.getLogger('weather-fetcher-arome')

# ─── Config ─────────────────────────────────────────────────────────────
WIND_DIR = Path(os.environ.get('WIND_DIR', '/coverage/wind-speed-arome'))
WIND_ARROWS_DIR = Path(os.environ.get('WIND_ARROWS_DIR', '/wind-arrows'))

RABBITMQ_URL = os.environ.get('RABBITMQ_URL', 'amqp://maritime:maritime@rabbitmq:5672')
GEOSERVER_URL = os.environ.get('GEOSERVER_URL', 'http://geoserver:8080/geoserver')
GEOSERVER_USER = os.environ.get('GEOSERVER_ADMIN_USER', 'admin')
GEOSERVER_PASS = os.environ.get('GEOSERVER_ADMIN_PASSWORD', 'geoserver')

# Sprint Europe 2026-05-12 : AROME reste sur bbox FR métropole, c'est la
# zone native du modèle (~ [-5.5, 41, 10, 52], 0.025° côtier). Les autres
# ingesters (ais, sst, gfs, lightning) sont passés en bbox Europe étroite
# [-15, 35, 30, 65]. AROME devient un "overlay haute-résolution FR" au-dessus
# du GFS Europe. Migration ARPEGE pour couverture Europe = Chantier #2 du
# sprint Europe (à venir).
BBOX_LON = (-6.0, 10.0)
BBOX_LAT = (41.0, 51.5)

# Horizon de forecast — AROME va jusqu'à +51h, on prend 24h par défaut
# (= 4 bundles SP1 × 55MB = ~220MB / run). Configurable par env.
FORECAST_HOURS = int(os.environ.get('FORECAST_HOURS', '24'))
# Sampling temporel — AROME fournit des steps horaires. Pas de step >1 ;
# si Sylvain veut alléger, on filtre par modulo (default 3h pour rester
# alignés avec le slider GFS qui sample par 6h).
SAMPLE_STEP_HOURS = int(os.environ.get('SAMPLE_STEP_HOURS', '3'))

# Bucket public Météo-France PNT (S3-compatible MinIO, hébergé data.gouv.fr).
# Listing via list-type=2 + prefix. Aucune auth requise (open data).
PNT_BUCKET = 'https://object.data.gouv.fr/meteofrance-pnt'
S3_NS = 'http://s3.amazonaws.com/doc/2006-03-01/'


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


# ─── GeoServer ImageMosaic config (identique pattern weather-fetcher) ───
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
            # Step 4 : applique le SLD partagé avec la layer wind-speed GFS,
            # sinon GeoServer sert un gris quasi-invisible (style raster
            # par défaut). Le style 'wind-speed-rainbow' a été uploadé par
            # provision.sh au boot du cluster.
            try:
                style_payload = {'layer': {'defaultStyle': {
                    'name': 'wind-speed-rainbow', 'workspace': 'maritime',
                }}}
                r4 = requests.put(
                    f"{GEOSERVER_URL}/rest/layers/maritime:{coverage_name}",
                    json=style_payload,
                    auth=(GEOSERVER_USER, GEOSERVER_PASS),
                    timeout=15,
                )
                if r4.status_code in (200, 201):
                    log.info('Style wind-speed-rainbow bound to %s', coverage_name)
                else:
                    log.warning('Style binding HTTP %d: %s', r4.status_code, r4.text[:200])
            except Exception as exc:
                log.warning('Style binding failed: %s', exc)
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


# ─── AROME S3 listing & fetch ───────────────────────────────────────────
def s3_list_keys(prefix: str, max_pages: int = 5) -> list[str]:
    """List S3 keys under a prefix via list-type=2 + pagination
    NextContinuationToken. Le bucket meteofrance-pnt parle protocole S3 v2."""
    keys: list[str] = []
    token = None
    for _ in range(max_pages):
        params = f'list-type=2&prefix={prefix}&max-keys=1000'
        if token:
            params += f'&continuation-token={requests.utils.quote(token, safe="")}'
        url = f'{PNT_BUCKET}?{params}'
        try:
            r = requests.get(url, timeout=30)
            if r.status_code != 200:
                log.warning('S3 list %s HTTP %d', prefix, r.status_code)
                break
            # ElementTree parse — l'XML S3 utilise un namespace.
            root = ET.fromstring(r.content)
            for c in root.findall(f'{{{S3_NS}}}Contents'):
                k = c.find(f'{{{S3_NS}}}Key')
                if k is not None and k.text:
                    keys.append(k.text)
            truncated = root.find(f'{{{S3_NS}}}IsTruncated')
            if truncated is None or truncated.text != 'true':
                break
            nct = root.find(f'{{{S3_NS}}}NextContinuationToken')
            token = nct.text if nct is not None else None
            if not token:
                break
        except Exception as exc:
            log.warning('S3 list parse fail: %s', exc)
            break
    return keys


def latest_arome_run() -> datetime | None:
    """AROME runs toutes les 3h (00, 03, 06, 09, 12, 15, 18, 21 UTC). La
    mise à dispo des fichiers se fait ~2h après l'heure du run. On scanne
    les 24 dernières heures et on retient le run le plus récent qui a au
    moins 4 bundles SP1 0025 dispo (soit ≥ 24h de forecast)."""
    now = datetime.now(timezone.utc)
    for hours_back in range(0, 30, 3):
        candidate = (now - timedelta(hours=hours_back)).replace(minute=0, second=0, microsecond=0)
        run_hour = (candidate.hour // 3) * 3
        run = candidate.replace(hour=run_hour)
        run_iso = run.strftime('%Y-%m-%dT%H:%M:%SZ')
        prefix = f'pnt/{run_iso}/arome/0025/SP1/'
        keys = s3_list_keys(prefix, max_pages=1)
        # Heuristique : on accepte le run dès qu'il a ≥ 1 bundle SP1 dispo
        # (run en cours de publication). Le fetch ultérieur filtrera ceux
        # qui manquent.
        if len(keys) >= 1:
            log.info('Latest AROME run = %s (%d SP1 bundles)', run_iso, len(keys))
            return run
    log.warning('No AROME run found in last 30h')
    return None


def fetch_object(url: str, dest: Path) -> bool:
    try:
        with requests.get(url, stream=True, timeout=300) as r:
            if r.status_code != 200:
                log.info('AROME fetch %s → HTTP %d (skip)', url[-80:], r.status_code)
                return False
            dest.parent.mkdir(parents=True, exist_ok=True)
            with open(dest, 'wb') as f:
                for chunk in r.iter_content(chunk_size=256 * 1024):
                    f.write(chunk)
        size = dest.stat().st_size
        log.info('AROME fetched %s (%.1f MB)', dest.name, size / 1e6)
        return size > 1000  # filtre les empty/error bodies
    except Exception as exc:
        log.warning('AROME fetch failed: %s', exc)
        return False


# ─── Arrows GeoJSON (préfixé arome_ pour distinguer du GFS) ─────────────
def generate_arrows_geojson(u: xr.DataArray, v: xr.DataArray, speed: xr.DataArray,
                            valid_time: datetime, step_lon: int = 4, step_lat: int = 4) -> Path | None:
    """Idem weather-fetcher.generate_arrows_geojson mais avec :
    - préfixe arome_ pour ne pas collisioner avec les arrows GFS
    - step 4×4 par défaut (grille 16× plus dense que GFS, 2×2 donnerait 4× trop
      de flèches pour la même lisibilité visuelle).
    """
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
                continue
            uu = float(u_arr[j, i])
            vv = float(v_arr[j, i])
            theta_math = np.degrees(np.arctan2(vv, uu))
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
            'forecast_run': 'Météo-France AROME 0.025°',
            'sampling': f'{step_lon}x{step_lat} grid step',
        },
    }
    WIND_ARROWS_DIR.mkdir(parents=True, exist_ok=True)
    ts_str = valid_time.strftime('%Y%m%dT%H%M%SZ')
    out = WIND_ARROWS_DIR / f'arome_wind_arrows_{ts_str}.geojson'
    out.write_text(json.dumps(geojson, separators=(',', ':')))
    update_arrows_manifest()
    return out


def update_arrows_manifest() -> None:
    """Re-écrit le manifest commun à toutes les sources de flèches. On
    LIT les entries existantes (wind GFS + wave WW3) et on ajoute la
    section `arome`. Pattern défensif : on ne perd jamais les listes des
    autres sources même si ce service tourne en isolation."""
    manifest_path = WIND_ARROWS_DIR / 'manifest.json'
    existing: dict = {}
    if manifest_path.exists():
        try:
            existing = json.loads(manifest_path.read_text())
        except Exception:
            existing = {}

    # Re-scan disque pour TOUTES les listes (source of truth = fichiers).
    wind_ts = sorted([
        p.stem.replace('wind_arrows_', '')
        for p in WIND_ARROWS_DIR.glob('wind_arrows_*.geojson')
    ])
    wave_ts = sorted([
        p.stem.replace('wave_arrows_', '')
        for p in WIND_ARROWS_DIR.glob('wave_arrows_*.geojson')
    ])
    arome_ts = sorted([
        p.stem.replace('arome_wind_arrows_', '')
        for p in WIND_ARROWS_DIR.glob('arome_wind_arrows_*.geojson')
    ])

    manifest = {
        'wind': wind_ts,
        'wave': wave_ts,
        'arome': arome_ts,
        'patterns': {
            'wind': '/wind-arrows/wind_arrows_{ts}.geojson',
            'wave': '/wind-arrows/wave_arrows_{ts}.geojson',
            'arome': '/wind-arrows/arome_wind_arrows_{ts}.geojson',
        },
        'updated_at': datetime.now(timezone.utc).isoformat(),
    }
    manifest_path.write_text(json.dumps(manifest, separators=(',', ':')))


# ─── GRIB → GeoTIFF (par timestep) ──────────────────────────────────────
def grib_to_geotiffs(grib: Path, run: datetime) -> dict[datetime, Path]:
    """Charge un bundle GRIB2 AROME SP1 (multi-step) + sépare chaque
    timestep en GeoTIFF distinct. Renvoie {valid_time: path}.

    AROME 0025 packe 6 forecasts horaires par fichier. cfgrib expose ça
    comme dimension `step` (timedelta), donc on itère ds.step.values.
    """
    out: dict[datetime, Path] = {}
    try:
        # cfgrib filtre sur typeOfLevel='heightAboveGround' + level=10 pour
        # ne charger QUE le vent à 10m (sinon on charge aussi t2m, etc.,
        # mélange de niveaux qui empêche un open_dataset clean).
        ds = xr.open_dataset(
            grib,
            engine='cfgrib',
            backend_kwargs={
                'indexpath': '',
                'filter_by_keys': {'typeOfLevel': 'heightAboveGround', 'level': 10},
            },
        )
    except Exception as exc:
        log.warning('GRIB open failed (%s) — skip', exc)
        return out

    # Normalise lon en [-180, 180]
    if 'longitude' in ds.coords:
        if float(ds['longitude'].max()) > 180:
            ds = ds.assign_coords(longitude=(((ds['longitude'] + 180) % 360) - 180))
            ds = ds.sortby('longitude')

    # Subset bbox France (au cas où AROME inclurait des marges)
    ds = ds.sel(
        longitude=slice(BBOX_LON[0], BBOX_LON[1]),
        latitude=slice(BBOX_LAT[1], BBOX_LAT[0]),  # AROME = north-up donc lat descend
    )
    if ds.longitude.size == 0 or ds.latitude.size == 0:
        # Inversion latitude (selon convention du grid) — fallback
        ds = ds.sel(
            longitude=slice(BBOX_LON[0], BBOX_LON[1]),
            latitude=slice(BBOX_LAT[0], BBOX_LAT[1]),
        )

    if 'u10' not in ds.variables or 'v10' not in ds.variables:
        log.warning('No u10/v10 in %s (vars=%s) — skip', grib.name, list(ds.variables))
        ds.close()
        return out

    # AROME : si le bundle a une dim "step", chaque step = 1 forecast hour
    # depuis run. Sinon (rare), on traite comme un single timestep à h=0.
    steps = ds['step'].values if 'step' in ds.dims else [np.timedelta64(0, 'h')]
    has_step_dim = 'step' in ds.dims

    for s_val in steps:
        ds_t = ds.sel(step=s_val) if has_step_dim else ds
        # Convertit timedelta64 → heures puis valid_time
        td = s_val if isinstance(s_val, np.timedelta64) else np.timedelta64(int(s_val), 'h')
        fhour = int(td / np.timedelta64(1, 'h'))
        # Filtre par SAMPLE_STEP_HOURS pour limiter la cadence (default 3h).
        if fhour % SAMPLE_STEP_HOURS != 0:
            continue
        valid_time = run + timedelta(hours=fhour)
        ts_str = valid_time.strftime('%Y%m%dT%H%M%SZ')

        u = ds_t['u10'].astype('float32')
        v = ds_t['v10'].astype('float32')
        speed = np.sqrt(u ** 2 + v ** 2)
        speed.name = 'wind_speed'
        speed.attrs['units'] = 'm s-1'
        speed.attrs['long_name'] = 'Wind speed at 10m (AROME)'

        dest = WIND_DIR / f'arome_wind_speed_{ts_str}.tif'
        if dest.exists():
            log.debug('Skip %s (already exists)', dest.name)
            continue

        # Export GeoTIFF — pattern identique weather-fetcher (north-up).
        da = speed
        if 'latitude' in da.coords:
            da = da.sortby('latitude', ascending=False)
        if 'longitude' in da.dims:
            da = da.rename({'longitude': 'x', 'latitude': 'y'})
        da = da.rio.set_spatial_dims(x_dim='x', y_dim='y', inplace=False)
        da = da.rio.write_crs('EPSG:4326')
        dest.parent.mkdir(parents=True, exist_ok=True)
        da.rio.to_raster(dest, driver='GTiff', compress='LZW', tiled=True,
                         blockxsize=256, blockysize=256)
        out[valid_time] = dest
        log.info('Exported %s (fhour=+%dh)', dest.name, fhour)

        # Arrows GeoJSON (en parallèle, déjà samplé par SAMPLE_STEP_HOURS).
        try:
            # Pour les arrows on a besoin de u/v alignés en lat/lon comme `speed`.
            u_aligned = u.sortby('latitude', ascending=False) if 'latitude' in u.coords else u
            v_aligned = v.sortby('latitude', ascending=False) if 'latitude' in v.coords else v
            spd_aligned = speed.sortby('latitude', ascending=False) if 'latitude' in speed.coords else speed
            generate_arrows_geojson(u_aligned, v_aligned, spd_aligned, valid_time)
        except Exception as exc:
            log.warning('arrows GeoJSON gen failed for %s: %s', ts_str, exc)

    ds.close()
    return out


# ─── Bundle filename helpers ────────────────────────────────────────────
# arome__0025__SP1__00H06H__2026-05-10T00:00:00Z.grib2
BUNDLE_RE = re.compile(r'arome__0025__SP1__(\d+)H(\d+)H__')


def bundle_first_hour(key: str) -> int | None:
    """Extrait l'heure de début du bundle depuis le nom du fichier S3."""
    m = BUNDLE_RE.search(key)
    if not m:
        return None
    return int(m.group(1))


# ─── Cleanup ────────────────────────────────────────────────────────────
def cleanup_old_files(retention_days: int = 7) -> None:
    cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)
    removed = 0
    for d in (WIND_DIR, WIND_ARROWS_DIR):
        if not d.exists():
            continue
        for f in list(d.glob('arome_*.tif')) + list(d.glob('arome_*.geojson')):
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
        log.info('Cleanup: removed %d AROME files older than %dd', removed, retention_days)


# ─── Cycle ──────────────────────────────────────────────────────────────
def run_fetch_cycle() -> None:
    log.info('weather-fetcher-arome cycle starting (forecast=%dh, step=%dh)',
             FORECAST_HOURS, SAMPLE_STEP_HOURS)
    cleanup_old_files(retention_days=int(os.environ.get('WEATHER_RETENTION_DAYS', '7')))
    ensure_mosaic_config_files(WIND_DIR)

    run = latest_arome_run()
    if run is None:
        log.warning('No AROME run available — abort cycle')
        return

    run_iso = run.strftime('%Y-%m-%dT%H:%M:%SZ')
    prefix = f'pnt/{run_iso}/arome/0025/SP1/'
    all_keys = s3_list_keys(prefix, max_pages=2)
    # On ne garde que les bundles dont l'heure de début ≤ FORECAST_HOURS.
    relevant = []
    for k in all_keys:
        h = bundle_first_hour(k)
        if h is None:
            continue
        if h <= FORECAST_HOURS:
            relevant.append(k)
    relevant.sort(key=lambda k: bundle_first_hour(k) or 0)
    log.info('Will fetch %d bundles for first %dh of forecast', len(relevant), FORECAST_HOURS)

    new_tiffs: list[Path] = []
    for key in relevant:
        url = f'{PNT_BUCKET}/{key}'
        tmp = WIND_DIR / f'_tmp_{Path(key).name}'
        if not fetch_object(url, tmp):
            continue
        try:
            paths = grib_to_geotiffs(tmp, run)
            new_tiffs.extend(paths.values())
        finally:
            tmp.unlink(missing_ok=True)
            (tmp.with_suffix('.grib2.idx')).unlink(missing_ok=True)

    log.info('Cycle done — new AROME GeoTIFFs: %d', len(new_tiffs))

    # Wait for GeoServer
    for _ in range(10):
        try:
            r = requests.get(f"{GEOSERVER_URL}/rest/about/status",
                             auth=(GEOSERVER_USER, GEOSERVER_PASS), timeout=5)
            if r.status_code == 200:
                break
        except Exception:
            pass
        time.sleep(3)

    # Create or reindex le mosaic store
    store = 'wind_speed_arome'
    coverage = 'wind-speed-arome'  # doit matcher le basename du dossier
    title = 'Wind speed at 10m (Météo-France AROME 0.025°)'
    has_tifs = any(WIND_DIR.glob('arome_*.tif'))
    if has_tifs and not coverage_store_exists(store):
        create_mosaic_store(store, coverage, WIND_DIR, title)
    elif new_tiffs:
        trigger_reindex(store, WIND_DIR)

    publish_raster_ready({
        'type': 'weather-arome',
        'run': run.isoformat(),
        'forecast_hours': FORECAST_HOURS,
        'new_files': len(new_tiffs),
    })
    log.info('weather-fetcher-arome cycle done')


def main() -> None:
    WIND_DIR.mkdir(parents=True, exist_ok=True)
    WIND_ARROWS_DIR.mkdir(parents=True, exist_ok=True)
    log.info('weather-fetcher-arome starting')

    run_fetch_cycle()

    # AROME publie 8 runs/jour (00, 03, …, 21 UTC) avec ~2h de latence.
    # On en prend 4×/jour (alignés sur les runs principaux) pour limiter
    # la charge réseau et disque (~1GB / jour pour 24h de forecast × 4 runs).
    # Cron 02:30 / 08:30 / 14:30 / 20:30 UTC.
    from apscheduler.schedulers.blocking import BlockingScheduler
    sched = BlockingScheduler(timezone='UTC')
    sched.add_job(run_fetch_cycle, 'cron', hour='2,8,14,20', minute=30)
    log.info('Scheduler armed (02:30 / 08:30 / 14:30 / 20:30 UTC)')
    try:
        sched.start()
    except (KeyboardInterrupt, SystemExit):
        sys.exit(0)


if __name__ == '__main__':
    main()
