"""
weather-fetcher-arpege — récupère les forecasts vent à 10m du modèle ARPEGE
de Météo-France (résolution 0.1° ≈ 11km sur Europe, vs GFS 0.25° ≈ 25km).

Sprint Europe 2026-05-12 — Chantier #2 : ARPEGE remplace AROME en tant que
modèle météo principal. ARPEGE couvre toute l'Europe étroite (Açores → Pologne,
Méditerranée → Cap Nord) là où AROME ne couvre que la métropole FR. La perte de
résolution est limitée (11 km vs 2.5 km) et le gain de couverture est massif.

Source : bucket S3 public PNT (Prévision Numérique du Temps) hébergé par
data.gouv.fr, AUCUNE clé API requise. Documentation officielle :
  https://meteo.data.gouv.fr/datasets/donnees-du-modele-arpege

Structure des objets :
  pnt/<RUN_ISO>/arpege/01/SP1/arpege__01__SP1__<H1>H<H2>H__<RUN_ISO>.grib2

Où :
  - <RUN_ISO> = 2026-05-12T00:00:00Z (4 runs/jour : 00, 06, 12, 18 UTC,
    contre 8 pour AROME — c'est le cycle ARPEGE)
  - SP1 = "Surface Parameters 1" → contient u10, v10, t2m, surface pressure.
  - Les bundles 01 packent ~12 timesteps horaires (000H012H, 013H024H, …) →
    9 fichiers par run pour 0-102h de forecast. ~30MB par bundle.

Pattern fichier de sortie : arpege_wind_speed_<YYYYMMDDTHHMMSSZ>.tif dans
le coverage dir partagé avec GeoServer. Layer publié = maritime:wind-speed-arpege.

GeoJSON arrows : arpege_wind_arrows_<ts>.geojson dans /wind-arrows/. Sampling
step 3×3 sur la grille 0.1° (≈ 0.3° entre flèches) — densité comparable au GFS
0.25° step 2×2 sans surcharger.

Pourquoi un service séparé plutôt qu'un mode ARPEGE=true dans weather-fetcher ?
- Source totalement différente (S3 vs CGI NOMADS), pas de mutualisation utile.
- Schedule différent (ARPEGE runs 4×/jour avec latence ~3h).
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

import numpy as np
import pika
import requests
import xarray as xr

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(name)s: %(message)s',
)
log = logging.getLogger('weather-fetcher-arpege')

# ─── Orchestrator client (Data Orchestrator MVP S1, 2026-05-12) ──────
_ORCH_API = os.environ.get('ORCHESTRATOR_API', 'http://api:3010')
_ORCH_TOKEN = os.environ.get('ORCHESTRATOR_JOB_TOKEN', '')
_ORCH_SOURCE = os.environ.get('ORCHESTRATOR_SOURCE_NAME', 'weather-fetcher-arpege')

def report_job(status: str, started_at: datetime, **kwargs: object) -> None:
    if not _ORCH_TOKEN:
        return
    try:
        requests.post(
            f'{_ORCH_API}/admin/jobs/log',
            json={
                'sourceName': _ORCH_SOURCE,
                'status': status,
                'startedAt': started_at.isoformat(),
                'finishedAt': datetime.now(timezone.utc).isoformat(),
                **kwargs,
            },
            headers={'X-Job-Token': _ORCH_TOKEN, 'Content-Type': 'application/json'},
            timeout=5,
        )
    except Exception as exc:  # noqa: BLE001
        log.warning('report_job failed: %s', exc)

# ─── Config ─────────────────────────────────────────────────────────────
WIND_DIR = Path(os.environ.get('WIND_DIR', '/coverage/wind-speed-arpege'))
WIND_ARROWS_DIR = Path(os.environ.get('WIND_ARROWS_DIR', '/wind-arrows'))

RABBITMQ_URL = os.environ.get('RABBITMQ_URL', 'amqp://maritime:maritime@rabbitmq:5672')
GEOSERVER_URL = os.environ.get('GEOSERVER_URL', 'http://geoserver:8080/geoserver')
GEOSERVER_USER = os.environ.get('GEOSERVER_ADMIN_USER', 'admin')
GEOSERVER_PASS = os.environ.get('GEOSERVER_ADMIN_PASSWORD', 'geoserver')
GEOSERVER_WORKSPACE = os.environ.get('GEOSERVER_WORKSPACE', 'aetherwx')  # G47 — workspace en env (Sprint 0 rename)

# Sprint Europe 2026-05-12 : bbox Europe étroite — cohérence avec ais, sst,
# gfs, lightning. ARPEGE 0.1° couvre nativement un domaine global (publié par
# Météo-France sur leur S3 public), le subset xarray gère la sélection bbox.
BBOX_LON = (-15.0, 30.0)
BBOX_LAT = (35.0, 65.0)

# Horizon de forecast — ARPEGE va jusqu'à +102h, on prend 48h par défaut
# (= 4 bundles SP1 × 30MB ≈ 120MB / run). Configurable par env.
FORECAST_HOURS = int(os.environ.get('FORECAST_HOURS', '48'))
# Sampling temporel — ARPEGE fournit des steps horaires dans chaque bundle 12h.
# Pas de step >1 ; pour alléger on filtre par modulo (default 3h pour rester
# alignés avec le slider GFS qui sample par 6h).
SAMPLE_STEP_HOURS = int(os.environ.get('SAMPLE_STEP_HOURS', '3'))

# Bucket public Météo-France PNT (S3 OVH, rétention 14j, runs toutes les 3h).
# Listing via list-type=2 + prefix. Aucune auth requise (open data).
#
# 2026-05-18 : migration host data.gouv.fr → OVH direct. L'ancien host
# `object.data.gouv.fr/meteofrance-pnt/` a cessé de servir le 14/05/2026
# (le bucket lui-même publie toujours, c'est juste le frontend qui a sauté).
# Structure des keys INCHANGÉE — c'est le même bucket sous un autre DNS.
# Sortie en env var pour pouvoir repivoter sans rebuild si nouveau host.
PNT_BUCKET = os.environ.get(
    'PNT_BUCKET',
    'https://meteofrance-pnt.s3.rbx.io.cloud.ovh.net',
)
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
SuggestedFormat=org.geotools.gce.geotiff.GeoTiffFormat
SuggestedSPI=it.geosolutions.imageioimpl.plugins.tiff.TIFFImageReaderSpi
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
            f"{GEOSERVER_URL}/rest/workspaces/{GEOSERVER_WORKSPACE}/coveragestores/{store_name}.json",
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
                'workspace': {'name': GEOSERVER_WORKSPACE},
                'url': f'file://{coverage_dir}',
            },
        }
        r = requests.post(
            f"{GEOSERVER_URL}/rest/workspaces/{GEOSERVER_WORKSPACE}/coveragestores",
            json=store_payload,
            auth=(GEOSERVER_USER, GEOSERVER_PASS),
            timeout=60,
        )
        if r.status_code not in (200, 201):
            log.warning('Step 1 (store) HTTP %d: %s', r.status_code, r.text[:300])
            return False

        r2 = requests.post(
            f"{GEOSERVER_URL}/rest/workspaces/{GEOSERVER_WORKSPACE}/coveragestores/{store_name}/external.imagemosaic",
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
            f"{GEOSERVER_URL}/rest/workspaces/{GEOSERVER_WORKSPACE}/coveragestores/{store_name}/coverages",
            data=coverage_xml,
            headers={'Content-Type': 'text/xml'},
            auth=(GEOSERVER_USER, GEOSERVER_PASS),
            timeout=30,
        )
        if r3.status_code in (200, 201):
            log.info('Mosaic %s published with time dim', store_name)
            # Step 4 : applique le SLD partagé avec la layer wind-speed GFS,
            # sinon GeoServer sert un gris quasi-invisible (style raster
            # par défaut). Le style 'wind-speed-rainbow' est uploadé par
            # provision.sh au boot du cluster.
            try:
                style_payload = {'layer': {'defaultStyle': {
                    'name': 'wind-speed-rainbow', 'workspace': GEOSERVER_WORKSPACE,
                }}}
                r4 = requests.put(
                    f"{GEOSERVER_URL}/rest/layers/{GEOSERVER_WORKSPACE}:{coverage_name}",
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
            f"{GEOSERVER_URL}/rest/workspaces/{GEOSERVER_WORKSPACE}/coveragestores/{store_name}/external.imagemosaic",
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


# ─── ARPEGE S3 listing & fetch ──────────────────────────────────────────
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


def latest_arpege_run() -> datetime | None:
    """ARPEGE runs 4×/jour (00, 06, 12, 18 UTC). Mise à dispo ~3h après l'heure
    du run. On scanne les 24 dernières heures et on retient le run le plus
    récent qui a au moins 1 bundle SP1 01 dispo."""
    now = datetime.now(timezone.utc)
    # Range 48h plutôt que 24h pour absorber les périodes où Météo-France
    # n'a pas publié récemment (bucket S3 publish peut retarder, observé
    # 2026-05-12 avec aucun run récent disponible côté serveur).
    for hours_back in range(0, 48, 6):
        candidate = (now - timedelta(hours=hours_back)).replace(minute=0, second=0, microsecond=0)
        run_hour = (candidate.hour // 6) * 6
        run = candidate.replace(hour=run_hour)
        run_iso = run.strftime('%Y-%m-%dT%H:%M:%SZ')
        prefix = f'pnt/{run_iso}/arpege/01/SP1/'
        keys = s3_list_keys(prefix, max_pages=1)
        if len(keys) >= 1:
            log.info('Latest ARPEGE run = %s (%d SP1 bundles)', run_iso, len(keys))
            return run
    log.warning('No ARPEGE run found in last 48h')
    return None


def fetch_object(url: str, dest: Path) -> bool:
    try:
        with requests.get(url, stream=True, timeout=300) as r:
            if r.status_code != 200:
                log.info('ARPEGE fetch %s → HTTP %d (skip)', url[-80:], r.status_code)
                return False
            dest.parent.mkdir(parents=True, exist_ok=True)
            with open(dest, 'wb') as f:
                for chunk in r.iter_content(chunk_size=256 * 1024):
                    f.write(chunk)
        size = dest.stat().st_size
        log.info('ARPEGE fetched %s (%.1f MB)', dest.name, size / 1e6)
        return size > 1000
    except Exception as exc:
        log.warning('ARPEGE fetch failed: %s', exc)
        return False


# ─── Arrows GeoJSON (préfixé arpege_ pour distinguer du GFS) ─────────────
def generate_arrows_geojson(u: xr.DataArray, v: xr.DataArray, speed: xr.DataArray,
                            valid_time: datetime, step_lon: int = 3, step_lat: int = 3) -> Path | None:
    """Idem weather-fetcher.generate_arrows_geojson mais avec :
    - préfixe arpege_ pour ne pas collisioner avec les arrows GFS
    - step 3×3 par défaut (grille 2.5× plus dense que GFS, 3×3 donne une
      densité visuelle équivalente à GFS step 2×2 ≈ 0.3°).
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
            'forecast_run': 'Météo-France ARPEGE 0.1°',
            'sampling': f'{step_lon}x{step_lat} grid step',
        },
    }
    WIND_ARROWS_DIR.mkdir(parents=True, exist_ok=True)
    ts_str = valid_time.strftime('%Y%m%dT%H%M%SZ')
    out = WIND_ARROWS_DIR / f'arpege_wind_arrows_{ts_str}.geojson'
    out.write_text(json.dumps(geojson, separators=(',', ':')))
    update_arrows_manifest()
    return out


def update_arrows_manifest() -> None:
    """Re-écrit le manifest commun à TOUTES les sources de flèches.
    Scan disque pour wind (GFS) / wave (WW3) / arpege / arome — chaque
    service écrit les 4 keys à chaque cycle, le manifest reste cohérent
    peu importe quel service tourne en isolation.

    Phase C.6 (2026-05-12) : AROME réintroduit en parallèle d'ARPEGE,
    on doit scanner les deux côté arpege pour ne pas écraser la clé
    `arome` quand seul arpege a tourné."""
    manifest_path = WIND_ARROWS_DIR / 'manifest.json'

    wind_ts = sorted([
        p.stem.replace('wind_arrows_', '')
        for p in WIND_ARROWS_DIR.glob('wind_arrows_*.geojson')
    ])
    wave_ts = sorted([
        p.stem.replace('wave_arrows_', '')
        for p in WIND_ARROWS_DIR.glob('wave_arrows_*.geojson')
    ])
    arpege_ts = sorted([
        p.stem.replace('arpege_wind_arrows_', '')
        for p in WIND_ARROWS_DIR.glob('arpege_wind_arrows_*.geojson')
    ])
    arome_ts = sorted([
        p.stem.replace('arome_wind_arrows_', '')
        for p in WIND_ARROWS_DIR.glob('arome_wind_arrows_*.geojson')
    ])

    manifest = {
        'wind': wind_ts,
        'wave': wave_ts,
        'arpege': arpege_ts,
        'arome': arome_ts,
        'patterns': {
            'wind': '/wind-arrows/wind_arrows_{ts}.geojson',
            'wave': '/wind-arrows/wave_arrows_{ts}.geojson',
            'arpege': '/wind-arrows/arpege_wind_arrows_{ts}.geojson',
            'arome': '/wind-arrows/arome_wind_arrows_{ts}.geojson',
        },
        'updated_at': datetime.now(timezone.utc).isoformat(),
    }
    manifest_path.write_text(json.dumps(manifest, separators=(',', ':')))


# ─── GRIB → GeoTIFF (par timestep) ──────────────────────────────────────
def grib_to_geotiffs(grib: Path, run: datetime) -> dict[datetime, Path]:
    """Charge un bundle GRIB2 ARPEGE SP1 (multi-step) + sépare chaque
    timestep en GeoTIFF distinct. Renvoie {valid_time: path}.

    ARPEGE 01 packe ~12 forecasts horaires par bundle (000H012H, 013H024H, …).
    cfgrib expose ça comme dimension `step` (timedelta), donc on itère
    ds.step.values.
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

    # Subset bbox Europe (ARPEGE 01 publié couvre un domaine global / Europe
    # étendu — on découpe).
    ds = ds.sel(
        longitude=slice(BBOX_LON[0], BBOX_LON[1]),
        latitude=slice(BBOX_LAT[1], BBOX_LAT[0]),  # ARPEGE = north-up donc lat descend
    )
    if ds.longitude.size == 0 or ds.latitude.size == 0:
        ds = ds.sel(
            longitude=slice(BBOX_LON[0], BBOX_LON[1]),
            latitude=slice(BBOX_LAT[0], BBOX_LAT[1]),
        )

    if 'u10' not in ds.variables or 'v10' not in ds.variables:
        log.warning('No u10/v10 in %s (vars=%s) — skip', grib.name, list(ds.variables))
        ds.close()
        return out

    steps = ds['step'].values if 'step' in ds.dims else [np.timedelta64(0, 'h')]
    has_step_dim = 'step' in ds.dims

    for s_val in steps:
        ds_t = ds.sel(step=s_val) if has_step_dim else ds
        td = s_val if isinstance(s_val, np.timedelta64) else np.timedelta64(int(s_val), 'h')
        fhour = int(td / np.timedelta64(1, 'h'))
        if fhour % SAMPLE_STEP_HOURS != 0:
            continue
        valid_time = run + timedelta(hours=fhour)
        ts_str = valid_time.strftime('%Y%m%dT%H%M%SZ')

        u = ds_t['u10'].astype('float32')
        v = ds_t['v10'].astype('float32')
        speed = np.sqrt(u ** 2 + v ** 2)
        speed.name = 'wind_speed'
        speed.attrs['units'] = 'm s-1'
        speed.attrs['long_name'] = 'Wind speed at 10m (ARPEGE)'

        dest = WIND_DIR / f'arpege_wind_speed_{ts_str}.tif'
        if dest.exists():
            log.debug('Skip %s (already exists)', dest.name)
            continue

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

        try:
            u_aligned = u.sortby('latitude', ascending=False) if 'latitude' in u.coords else u
            v_aligned = v.sortby('latitude', ascending=False) if 'latitude' in v.coords else v
            spd_aligned = speed.sortby('latitude', ascending=False) if 'latitude' in speed.coords else speed
            generate_arrows_geojson(u_aligned, v_aligned, spd_aligned, valid_time)
        except Exception as exc:
            log.warning('arrows GeoJSON gen failed for %s: %s', ts_str, exc)

    ds.close()
    return out


# ─── Bundle filename helpers ────────────────────────────────────────────
# arpege__01__SP1__000H012H__2026-05-12T00:00:00Z.grib2
BUNDLE_RE = re.compile(r'arpege__01__SP1__(\d+)H(\d+)H__')


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
        for f in list(d.glob('arpege_*.tif')) + list(d.glob('arpege_*.geojson')):
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
        log.info('Cleanup: removed %d ARPEGE files older than %dd', removed, retention_days)


# ─── Cycle ──────────────────────────────────────────────────────────────
def run_fetch_cycle() -> None:
    _started_at = datetime.now(timezone.utc)
    try:
        _records_out = _do_fetch_cycle()
        report_job('ok', _started_at, recordsOut=_records_out)
    except Exception as exc:  # noqa: BLE001
        log.exception('weather-fetcher-arpege cycle failed')
        report_job('error', _started_at,
                   errorKind=type(exc).__name__,
                   errorMsg=str(exc)[:500])
        raise


def _do_fetch_cycle() -> int:
    """Returns count of new ARPEGE GeoTIFFs produced."""
    log.info('weather-fetcher-arpege cycle starting (forecast=%dh, step=%dh)',
             FORECAST_HOURS, SAMPLE_STEP_HOURS)
    cleanup_old_files(retention_days=int(os.environ.get('WEATHER_RETENTION_DAYS', '7')))
    ensure_mosaic_config_files(WIND_DIR)

    run = latest_arpege_run()
    if run is None:
        log.warning('No ARPEGE run available — abort cycle')
        return

    run_iso = run.strftime('%Y-%m-%dT%H:%M:%SZ')
    prefix = f'pnt/{run_iso}/arpege/01/SP1/'
    all_keys = s3_list_keys(prefix, max_pages=2)
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

    log.info('Cycle done — new ARPEGE GeoTIFFs: %d', len(new_tiffs))

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
    store = 'wind_speed_arpege'
    coverage = 'wind-speed-arpege'
    title = 'Wind speed at 10m (Météo-France ARPEGE 0.1°)'
    has_tifs = any(WIND_DIR.glob('arpege_*.tif'))
    if has_tifs and not coverage_store_exists(store):
        create_mosaic_store(store, coverage, WIND_DIR, title)
    elif new_tiffs:
        trigger_reindex(store, WIND_DIR)

    publish_raster_ready({
        'type': 'weather-arpege',
        'run': run.isoformat(),
        'forecast_hours': FORECAST_HOURS,
        'new_files': len(new_tiffs),
    })
    log.info('weather-fetcher-arpege cycle done')
    return len(new_tiffs)


def main() -> None:
    WIND_DIR.mkdir(parents=True, exist_ok=True)
    WIND_ARROWS_DIR.mkdir(parents=True, exist_ok=True)
    log.info('weather-fetcher-arpege starting')

    # --once : mode Argo CronWorkflow (un cycle puis exit 0). Idempotent.
    if '--once' in sys.argv:
        log.info('Running in --once mode (Argo-triggered)')
        run_fetch_cycle()
        return

    run_fetch_cycle()

    # ARPEGE publie 4 runs/jour (00, 06, 12, 18 UTC) avec ~3h de latence.
    # Cron 03:30 / 09:30 / 15:30 / 21:30 UTC pour récupérer chaque run dès
    # qu'il est complet sur S3.
    from apscheduler.schedulers.blocking import BlockingScheduler
    sched = BlockingScheduler(timezone='UTC')
    sched.add_job(run_fetch_cycle, 'cron', hour='3,9,15,21', minute=30)
    log.info('Scheduler armed (03:30 / 09:30 / 15:30 / 21:30 UTC)')
    try:
        sched.start()
    except (KeyboardInterrupt, SystemExit):
        sys.exit(0)


if __name__ == '__main__':
    main()
