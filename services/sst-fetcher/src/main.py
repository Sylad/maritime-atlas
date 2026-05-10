"""
sst-fetcher — récupère les NetCDF SST quotidiens NOAA OISST v2.1, les
recadre sur la France métropole, exporte en GeoTIFF dans le mosaic store
GeoServer (volume partagé), et publish raster.ready sur RabbitMQ.

Source : NOAA NCEI Optimum Interpolation SST (OISST) v2.1
  https://www.ncei.noaa.gov/products/optimum-interpolation-sst
  Résolution 0.25° (~25km), couverture globale, quotidien depuis 1981.
  Latence publication ~1-2 jours.

Pattern :
  1. cron quotidien 06:00 UTC
  2. Pour chaque jour manquant des 7 derniers (rattrapage), download
     le NetCDF correspondant depuis le serveur NCEI HTTPS.
  3. Subset à la bbox France via xarray.sel().
  4. Export GeoTIFF avec rioxarray (auto-CRS WGS84, compression LZW).
  5. Publish 'sst' sur exchange raster.ready avec metadata.
  6. Optionnel : POST GeoServer REST pour reindex le mosaic store.

Au boot : run un fetch initial pour avoir des données dispos sans
attendre 24h.
"""
from __future__ import annotations

import logging
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import json
import pika
import requests
import xarray as xr

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(name)s: %(message)s',
)
log = logging.getLogger('sst-fetcher')

# ─── Config ─────────────────────────────────────────────────────────────
COVERAGE_DIR = Path(os.environ.get('COVERAGE_DIR', '/coverage/sst-daily'))
RABBITMQ_URL = os.environ.get('RABBITMQ_URL', 'amqp://maritime:maritime@rabbitmq:5672')
GEOSERVER_URL = os.environ.get('GEOSERVER_URL', 'http://geoserver:8080/geoserver')
GEOSERVER_USER = os.environ.get('GEOSERVER_ADMIN_USER', 'admin')
GEOSERVER_PASS = os.environ.get('GEOSERVER_ADMIN_PASSWORD', 'geoserver')

# Bbox France métropole (matche ais-ingester pour cohérence visu).
BBOX_LON = (-6.0, 10.0)
BBOX_LAT = (41.0, 51.5)

# OISST v2.1 : URL pattern par date.
NCEI_BASE = 'https://www.ncei.noaa.gov/data/sea-surface-temperature-optimum-interpolation/v2.1/access/avhrr'

# Rattrapage : on tente les 7 derniers jours, skippe les fichiers déjà
# présents en local (run idempotent).
LOOKBACK_DAYS = int(os.environ.get('LOOKBACK_DAYS', '7'))

# Override start date pour tester sur un range historique connu (NOAA n'a
# pas de data du futur). Format YYYY-MM-DD. Exemple :
#   SST_START_DATE=2024-05-15 → fetch 2024-05-15 → 2024-05-21
SST_START_DATE = os.environ.get('SST_START_DATE', '').strip()


# ─── RabbitMQ ───────────────────────────────────────────────────────────
def publish_raster_ready(payload: dict) -> None:
    """Best-effort : si RabbitMQ down, log mais ne fail pas le fetch."""
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
        log.warning('Failed to publish raster.ready: %s', exc)


# ─── GeoServer ImageMosaic config ───────────────────────────────────────
LAYER_NAME = 'sst_daily'

# indexer.properties + timeregex.properties dans le coverage dir → permettent
# à GeoServer d'extraire le timestamp depuis le nom de fichier 'sst_YYYYMMDD.tif'
# et de servir le mosaic en WMS time-enabled.
INDEXER_PROPERTIES = """\
TimeAttribute=time
Schema=*the_geom:Polygon,location:String,time:java.util.Date
PropertyCollectors=TimestampFileNameExtractorSPI[timeregex](time)
Caching=false
LooseBBox=true
Heterogeneous=false
"""

TIMEREGEX_PROPERTIES = """\
regex=[0-9]{8},format=yyyyMMdd
"""


def ensure_mosaic_config_files() -> None:
    """Pose indexer.properties + timeregex.properties dans le coverage dir.
    Idempotent : si déjà présents, no-op."""
    indexer = COVERAGE_DIR / 'indexer.properties'
    timeregex = COVERAGE_DIR / 'timeregex.properties'
    if not indexer.exists():
        indexer.write_text(INDEXER_PROPERTIES)
        log.info('Wrote %s', indexer)
    if not timeregex.exists():
        timeregex.write_text(TIMEREGEX_PROPERTIES)
        log.info('Wrote %s', timeregex)


def coverage_store_exists() -> bool:
    """GET /rest/workspaces/maritime/coveragestores/{name}.json → 200 si existe."""
    try:
        r = requests.get(
            f"{GEOSERVER_URL}/rest/workspaces/maritime/coveragestores/{LAYER_NAME}.json",
            auth=(GEOSERVER_USER, GEOSERVER_PASS),
            timeout=10,
        )
        return r.status_code == 200
    except Exception:
        return False


# Le coverage layer name est le nom du dossier (sst-daily, avec dash) car
# c'est ce que GeoServer auto-discover via les .properties files. Le store
# en revanche utilise le nom snake_case pour cohérence URL REST.
COVERAGE_NAME = 'sst-daily'


def create_mosaic_store() -> bool:
    """Crée le coverage store ImageMosaic + publie le layer + active time dim.

    Pattern GeoServer REST en 3 étapes (testé manuellement, c'est la séquence
    qui marche pour ImageMosaic+timeregex) :
      1. POST /coveragestores : crée le store (JSON, url=file:///dir)
      2. POST /external.imagemosaic : scan le dir, génère sst-daily.shp/.dbf
         (l'index features). PATH SANS PRÉFIXE file:// — GeoServer prend juste
         un chemin absolu.
      3. POST /coverages : publie la coverage layer avec time dim activé.
    """
    log.info('Creating ImageMosaic coverage store %s…', LAYER_NAME)
    try:
        # ─── Step 1: store ────────────────────────────────────────────
        store_payload = {
            'coverageStore': {
                'name': LAYER_NAME,
                'type': 'ImageMosaic',
                'enabled': True,
                'workspace': {'name': 'maritime'},
                'url': f'file://{COVERAGE_DIR}',
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
        log.info('Step 1/3 — store created')

        # ─── Step 2: harvest (scan dir → index files) ────────────────
        # GeoServer veut le path SANS file:// prefix.
        r2 = requests.post(
            f"{GEOSERVER_URL}/rest/workspaces/maritime/coveragestores/{LAYER_NAME}/external.imagemosaic",
            data=str(COVERAGE_DIR),
            headers={'Content-Type': 'text/plain'},
            auth=(GEOSERVER_USER, GEOSERVER_PASS),
            timeout=60,
        )
        if r2.status_code not in (200, 201, 202):
            log.warning('Step 2 (harvest) HTTP %d: %s', r2.status_code, r2.text[:300])
            return False
        log.info('Step 2/3 — harvested (index files generated)')

        # ─── Step 3: coverage layer + time dimension ─────────────────
        coverage_xml = f"""<coverage>
  <name>{COVERAGE_NAME}</name>
  <nativeName>{COVERAGE_NAME}</nativeName>
  <title>SST daily — NOAA OISST v2.1</title>
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
            f"{GEOSERVER_URL}/rest/workspaces/maritime/coveragestores/{LAYER_NAME}/coverages",
            data=coverage_xml,
            headers={'Content-Type': 'text/xml'},
            auth=(GEOSERVER_USER, GEOSERVER_PASS),
            timeout=30,
        )
        if r3.status_code in (200, 201):
            log.info('Step 3/3 — coverage layer published with time dim')
            return True
        log.warning('Step 3 (coverage) HTTP %d: %s', r3.status_code, r3.text[:300])
        return False
    except Exception as exc:
        log.error('Mosaic store create failed: %s', exc)
        return False


def trigger_geoserver_reindex() -> None:
    """POST harvest avec path absolu → réindexe le store (ré-scan le dir)."""
    try:
        r = requests.post(
            f"{GEOSERVER_URL}/rest/workspaces/maritime/coveragestores/{LAYER_NAME}/external.imagemosaic",
            data=str(COVERAGE_DIR),
            headers={'Content-Type': 'text/plain'},
            auth=(GEOSERVER_USER, GEOSERVER_PASS),
            timeout=30,
        )
        if r.status_code in (200, 201, 202):
            log.info('GeoServer reindex OK')
        else:
            log.warning('GeoServer reindex HTTP %d: %s', r.status_code, r.text[:200])
    except Exception as exc:
        log.warning('GeoServer reindex skipped: %s', exc)


# ─── NOAA OISST fetch ───────────────────────────────────────────────────
def output_path_for(date: datetime) -> Path:
    """Format pattern attendu par GeoServer ImageMosaic timeregex :
    sst_YYYYMMDD.tif (le timeregex parse les 8 chiffres après 'sst_').
    """
    return COVERAGE_DIR / f"sst_{date.strftime('%Y%m%d')}.tif"


def url_for(date: datetime) -> str:
    return (
        f"{NCEI_BASE}/{date.strftime('%Y%m')}/"
        f"oisst-avhrr-v02r01.{date.strftime('%Y%m%d')}.nc"
    )


def fetch_and_convert(date: datetime) -> bool:
    """Renvoie True si le fichier a été créé/mis à jour, False si skipped."""
    out = output_path_for(date)
    if out.exists():
        log.debug('SST %s already present, skip', date.strftime('%Y-%m-%d'))
        return False

    url = url_for(date)
    log.info('Fetching SST %s from %s', date.strftime('%Y-%m-%d'), url)
    tmp_nc = COVERAGE_DIR / f"_tmp_{date.strftime('%Y%m%d')}.nc"

    try:
        # Download NetCDF (~1.6 MB par jour)
        with requests.get(url, stream=True, timeout=120) as r:
            if r.status_code == 404:
                # Fichier pas encore publié (latence NCEI ~1-2j sur le jour J)
                log.info('SST %s not yet published (404), will retry next run',
                         date.strftime('%Y-%m-%d'))
                return False
            r.raise_for_status()
            tmp_nc.parent.mkdir(parents=True, exist_ok=True)
            with open(tmp_nc, 'wb') as f:
                for chunk in r.iter_content(chunk_size=64 * 1024):
                    f.write(chunk)

        # Subset bbox France + export GeoTIFF
        # mask_and_scale=True (default) applique scale_factor + offset en
        # float32 lors du lazy-load. Sans ça, certains pipelines OpenDAP
        # ré-encodent les valeurs en int16 raw lors de to_raster, et
        # GeoServer voit 1200-2000 au lieu de 12-20°C.
        ds = xr.open_dataset(tmp_nc, mask_and_scale=True)
        # OISST utilise lon en [0, 360] pour certains datasets et [-180, 180]
        # pour d'autres. On normalise pour avoir [-180, 180].
        if ds['lon'].max() > 180:
            ds = ds.assign_coords(lon=(((ds['lon'] + 180) % 360) - 180)).sortby('lon')

        sst = ds['sst'].sel(
            lon=slice(BBOX_LON[0], BBOX_LON[1]),
            lat=slice(BBOX_LAT[0], BBOX_LAT[1]),
        )
        # Squeeze time + zlev (single-element dims) pour avoir un raster 2D
        if 'time' in sst.dims:
            sst = sst.isel(time=0)
        if 'zlev' in sst.dims:
            sst = sst.isel(zlev=0)

        # rioxarray attend x/y comme noms de dim ; OISST utilise lon/lat.
        # Force lat décroissant (north→south) pour que le GeoTIFF soit
        # north-up (sinon Origin = (lon_min, lat_min) = coin sud-ouest et
        # le raster est flippé verticalement → "tuiles inversées" côté WMS).
        sst = sst.sortby('lat', ascending=False)
        # Cast en float32 explicite : sécurise le contenu réel du GeoTIFF
        # (sinon rio.to_raster peut écrire un int16 raw avec scale_factor
        # en metadata seulement, ce que GeoServer lit comme valeur brute).
        sst = sst.astype('float32')
        sst = sst.rio.set_spatial_dims(x_dim='lon', y_dim='lat', inplace=False)
        sst = sst.rio.write_crs('EPSG:4326')
        sst.rio.to_raster(
            out,
            driver='GTiff',
            compress='LZW',
            tiled=True,
            blockxsize=256,
            blockysize=256,
        )
        log.info('Wrote %s (%d bytes)', out, out.stat().st_size)
        ds.close()
        tmp_nc.unlink(missing_ok=True)

        publish_raster_ready({
            'type': 'sst',
            'date': date.strftime('%Y-%m-%d'),
            'path': str(out),
            'bbox': {'lon': BBOX_LON, 'lat': BBOX_LAT},
        })
        return True
    except Exception as exc:
        log.error('SST fetch %s failed: %s', date.strftime('%Y-%m-%d'), exc)
        tmp_nc.unlink(missing_ok=True)
        return False


def cleanup_old_files(retention_days: int = 30) -> None:
    """Sprint 10b — supprime les .tif plus vieux que retention_days dans
    COVERAGE_DIR. SST = 30 jours (cohérent avec vessel_positions TTL)."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)
    removed = 0
    for tif in COVERAGE_DIR.glob('sst_*.tif'):
        try:
            date_str = tif.stem.split('_', 1)[1]  # 'sst_20240515' → '20240515'
            file_date = datetime.strptime(date_str, '%Y%m%d').replace(tzinfo=timezone.utc)
            if file_date < cutoff:
                tif.unlink()
                removed += 1
        except (ValueError, IndexError):
            continue
    if removed > 0:
        log.info('Cleanup: removed %d SST tif older than %dd', removed, retention_days)


def run_fetch_cycle() -> None:
    """Tente LOOKBACK_DAYS jours (skip ceux déjà présents)."""
    log.info('SST fetch cycle starting (lookback %dd)', LOOKBACK_DAYS)
    ensure_mosaic_config_files()
    cleanup_old_files(retention_days=int(os.environ.get('SST_RETENTION_DAYS', '30')))

    if SST_START_DATE:
        try:
            start = datetime.strptime(SST_START_DATE, '%Y-%m-%d').replace(tzinfo=timezone.utc)
            log.info('Override start date: %s (env SST_START_DATE)', SST_START_DATE)
            dates = [start + timedelta(days=i) for i in range(LOOKBACK_DAYS)]
        except ValueError:
            log.error('Invalid SST_START_DATE %s, falling back to default lookback', SST_START_DATE)
            today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
            dates = [today - timedelta(days=i) for i in range(1, LOOKBACK_DAYS + 1)]
    else:
        today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
        dates = [today - timedelta(days=i) for i in range(1, LOOKBACK_DAYS + 1)]

    any_new = False
    for date in dates:
        if fetch_and_convert(date):
            any_new = True

    # Wait pour laisser GeoServer démarrer si on est très tôt au boot.
    for _ in range(10):
        try:
            r = requests.get(f"{GEOSERVER_URL}/rest/about/status",
                             auth=(GEOSERVER_USER, GEOSERVER_PASS), timeout=5)
            if r.status_code == 200:
                break
        except Exception:
            pass
        time.sleep(3)

    # Crée le store si pas là ET qu'on a au moins 1 GeoTIFF (sinon GeoServer
    # 400 pour dir vide). Sinon réindex si nouveau fichier.
    has_geotiffs = any(COVERAGE_DIR.glob('sst_*.tif'))
    if has_geotiffs and not coverage_store_exists():
        create_mosaic_store()
    elif any_new:
        trigger_geoserver_reindex()
    log.info('SST fetch cycle done')


def main() -> None:
    COVERAGE_DIR.mkdir(parents=True, exist_ok=True)
    log.info('sst-fetcher starting (coverage_dir=%s)', COVERAGE_DIR)

    # Run immédiat au boot
    run_fetch_cycle()

    # Boucle cron 06:00 UTC quotidien (NOAA publie autour de 02:00 UTC)
    from apscheduler.schedulers.blocking import BlockingScheduler
    sched = BlockingScheduler(timezone='UTC')
    sched.add_job(run_fetch_cycle, 'cron', hour=6, minute=0)
    log.info('Scheduler armed (06:00 UTC daily)')
    try:
        sched.start()
    except (KeyboardInterrupt, SystemExit):
        sys.exit(0)


if __name__ == '__main__':
    main()
