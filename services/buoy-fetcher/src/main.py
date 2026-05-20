"""
buoy-fetcher — référentiel des plateformes marines mesurant les vagues sur
l'Europe, sourcé chez EMODnet Physics.

Sprint Europe Chantier #3 — migration CANDHIS → EMODnet Physics 2026-05-12.
L'ancien service `candhis-fetcher` couvrait 118 bouées houlographes FR
(CEREMA, métropole + outre-mer) via un GeoPackage data.gouv.fr + une API
CANDHIS optionnelle (clé sur demande email) pour les obs temps réel.

EMODnet Physics agrège des plateformes in-situ pour toute l'Europe via un
GeoServer public exposant des layers WFS. La layer pertinente pour
l'équivalent CANDHIS = mesure de vagues = :
    `EMODnet:ERD_EP_WAVES_INSITU`

Schéma WFS (extraits utiles) :
    PLATFORMCODE          → identifiant unique (notre `candhis_id` legacy)
    call_name             → nom human-readable
    latitude / longitude  → géométrie POINT
    WMO                   → code WMO (parfois null)
    platform_type_longname
    data_owner_longname
    data_owner_country_longname
    parameters / parameters_group_longname
    lastDateObservationDT
    dataLink              → URL NetCDF source

Pas de clé API requise : WFS public sous licence open (cf
https://emodnet.ec.europa.eu/en/about-emodnet — usage non-commercial libre,
attribution requise).

⚠ La table PostGIS s'appelle toujours `buoys` et garde la colonne PK nommée
`candhis_id` — c'est de la dette technique calculée, ça évite de toucher
au provisioner GeoServer (featuretypes maritime:buoys +
v_buoy_observations_recent) et au frontend. Sémantiquement la valeur dans
candhis_id est désormais PLATFORMCODE EMODnet.

Le service ne fetch plus d'observations temps réel (les obs EMODnet sont
dans des NetCDF par plateforme — lourd à orchestrer pour 28 plateformes,
out-of-scope du Chantier #3 MVP). La popup frontend affichera "Dernière
observation: <date>" via la colonne `last_obs_at` du référentiel.
"""
from __future__ import annotations

import logging
import os
import sys
import time
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlencode

import psycopg
import requests
from apscheduler.schedulers.blocking import BlockingScheduler

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(name)s: %(message)s',
)
log = logging.getLogger('buoy-fetcher')

# ─── Orchestrator client (Data Orchestrator MVP S1, 2026-05-12) ──────
_ORCH_API = os.environ.get('ORCHESTRATOR_API', 'http://api:3010')
_ORCH_TOKEN = os.environ.get('ORCHESTRATOR_JOB_TOKEN', '')
_ORCH_SOURCE = os.environ.get('ORCHESTRATOR_SOURCE_NAME', 'buoy-fetcher')

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
DATABASE_URL = os.environ['DATABASE_URL']

EMODNET_WFS_URL = os.environ.get(
    'EMODNET_WFS_URL',
    'https://geoserver.emodnet-physics.eu/geoserver/emodnet/ows',
)
EMODNET_LAYER = os.environ.get('EMODNET_LAYER', 'EMODnet:ERD_EP_WAVES_INSITU')

# Sprint Europe : bbox Europe étroite (cohérence avec ais/gfs/sst/arpege).
# WFS BBOX param attend "minLat,minLon,maxLat,maxLon,EPSG:4326".
BBOX_MIN_LAT = float(os.environ.get('BUOY_BBOX_MIN_LAT', '35.0'))
BBOX_MIN_LON = float(os.environ.get('BUOY_BBOX_MIN_LON', '-15.0'))
BBOX_MAX_LAT = float(os.environ.get('BUOY_BBOX_MAX_LAT', '65.0'))
BBOX_MAX_LON = float(os.environ.get('BUOY_BBOX_MAX_LON', '30.0'))

# Re-seed quotidien (le référentiel EMODnet bouge rarement, 1×/jour suffit).
FETCH_INTERVAL_MIN = int(os.environ.get('BUOY_FETCH_INTERVAL_MIN', '1440'))

USER_AGENT = os.environ.get(
    'BUOY_USER_AGENT',
    'aetherwx/0.1 (https://aetherwx.sladoire.dev; sylvain.ladoire@gmail.com)',
)
REQUEST_TIMEOUT = int(os.environ.get('BUOY_REQUEST_TIMEOUT', '60'))


# ─── DB ─────────────────────────────────────────────────────────────────
def connect_db() -> psycopg.Connection:
    return psycopg.connect(DATABASE_URL, autocommit=True)


def ensure_schema(conn: psycopg.Connection) -> None:
    """Crée idempotamment les tables buoys + buoy_observations.

    Détection schéma legacy CANDHIS (colonne `buoy_type` toujours présente
    mais sans `platform_type`) → DROP one-shot et recreate avec nouveau
    schema EMODnet. Cette migration n'affecte que ce service ; le reste
    de la stack (provisioner GeoServer, frontend) parle toujours la même
    API publique (table buoys, colonne candhis_id PK).
    """
    with conn.cursor() as cur:
        cur.execute("""
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'buoys' AND column_name = 'buoy_type' LIMIT 1
        """)
        has_legacy_col = cur.fetchone() is not None
        cur.execute("""
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'buoys' AND column_name = 'platform_type' LIMIT 1
        """)
        has_new_col = cur.fetchone() is not None

        if has_legacy_col and not has_new_col:
            log.info('Legacy CANDHIS schema detected — migrating to EMODnet schema')
            cur.execute('DROP VIEW IF EXISTS v_buoy_observations_recent CASCADE')
            cur.execute('DROP TABLE IF EXISTS buoy_observations CASCADE')
            cur.execute('DROP TABLE IF EXISTS buoys CASCADE')

        cur.execute("""
        CREATE TABLE IF NOT EXISTS buoys (
          candhis_id            TEXT PRIMARY KEY,
          name                  TEXT NOT NULL,
          geom                  GEOMETRY(POINT, 4326) NOT NULL,
          platform_type         TEXT,
          owner                 TEXT,
          country               TEXT,
          wmo                   TEXT,
          parameters            TEXT,
          parameters_group      TEXT,
          data_link             TEXT,
          last_obs_at           TIMESTAMPTZ,
          source                TEXT NOT NULL DEFAULT 'emodnet-physics-wfs',
          first_seen            TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_updated          TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        """)
        cur.execute("CREATE INDEX IF NOT EXISTS buoys_geom_gix ON buoys USING GIST (geom);")

        cur.execute("""
        CREATE TABLE IF NOT EXISTS buoy_observations (
          ts           TIMESTAMPTZ NOT NULL,
          candhis_id   TEXT NOT NULL,
          hm0          REAL,
          h13          REAL,
          hmax         REAL,
          tp           REAL,
          th13         REAL,
          t02          REAL,
          peak_dir     REAL,
          peak_spread  REAL,
          temp_water   REAL,
          raw          JSONB
        );
        """)
        cur.execute("""
            SELECT create_hypertable(
              'buoy_observations', 'ts',
              chunk_time_interval => INTERVAL '7 days',
              if_not_exists => TRUE
            );
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS buoy_obs_candhis_ts_idx
              ON buoy_observations (candhis_id, ts DESC);
        """)
        cur.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS buoy_obs_ts_candhis_uidx
              ON buoy_observations (ts, candhis_id);
        """)
        cur.execute("""
            DO $$
            BEGIN
              IF NOT EXISTS (
                SELECT 1 FROM timescaledb_information.jobs
                WHERE proc_name = 'policy_retention'
                  AND hypertable_name = 'buoy_observations'
              ) THEN
                PERFORM add_retention_policy('buoy_observations', INTERVAL '1 day');
              END IF;
            END $$;
        """)

        # Vue "récente" — MVP EMODnet n'a pas d'obs TR, donc en pratique
        # cette vue ne retourne rien tant que buoy_observations reste
        # vide. Le frontend dégrade gracieusement (popup affiche les
        # métadonnées plateforme + last_obs_at au lieu de Hm0/Hmax).
        cur.execute("""
        CREATE OR REPLACE VIEW v_buoy_observations_recent AS
        SELECT
          o.candhis_id,
          b.name,
          b.platform_type AS buoy_type,
          b.geom,
          o.ts,
          EXTRACT(EPOCH FROM (now() - o.ts))::INTEGER AS age_seconds,
          o.hm0,
          o.h13,
          o.hmax,
          o.tp,
          o.th13,
          o.t02,
          o.peak_dir,
          o.peak_spread,
          o.temp_water
        FROM (
          SELECT DISTINCT ON (candhis_id) *
          FROM buoy_observations
          ORDER BY candhis_id, ts DESC
        ) o
        JOIN buoys b USING (candhis_id);
        """)
    log.info('schema ensured (buoys EMODnet schema, buoy_observations, v_buoy_observations_recent)')


# ─── EMODnet WFS fetch ──────────────────────────────────────────────────
def fetch_emodnet_wave_platforms() -> list[dict[str, Any]]:
    """Fetch EMODnet WAVES_INSITU layer en JSON via WFS GetFeature.

    Retourne une liste de features GeoJSON. Filtré côté serveur par BBOX
    Europe étroite — le WFS gère le BBOX param avec EPSG:4326. Si la layer
    grossit, on devra paginer via startIndex/count — pour l'instant
    (~28 features Europe), tout passe en 1 requête.
    """
    params = {
        'service': 'WFS',
        'version': '2.0.0',
        'request': 'GetFeature',
        'typeNames': EMODNET_LAYER,
        'outputFormat': 'application/json',
        'srsName': 'EPSG:4326',
        # ⚠ EMODnet interprète le param BBOX en `minLon,minLat,maxLon,maxLat`
        # malgré la spec WFS 2.0 qui demande lat-d'abord pour EPSG:4326.
        # Bug confirmé en probing (BBOX lat-first → renvoie des features
        # hors zone). On reste pragmatique : lon-first ici, c'est ce qui
        # marche.
        'BBOX': f'{BBOX_MIN_LON},{BBOX_MIN_LAT},{BBOX_MAX_LON},{BBOX_MAX_LAT},EPSG:4326',
        'count': '5000',
    }
    # Préserve les `:` et `,` non-encodés dans `typeNames` / `BBOX` — le
    # redirect 302 EMODnet (`geoserver` → `prod-geoserver`) re-encodait les
    # `%3A` en `%253A`, causant un 400 côté serveur. On construit la query
    # nous-mêmes avec safe=':,/' pour bypasser le double-encoding.
    query = urlencode(params, safe=':,/')
    full_url = f'{EMODNET_WFS_URL}?{query}'
    last_err: Exception | None = None
    for attempt in range(3):
        try:
            r = requests.get(
                full_url,
                headers={'User-Agent': USER_AGENT},
                timeout=REQUEST_TIMEOUT,
            )
            r.raise_for_status()
            data = r.json()
            features = data.get('features', [])
            log.info('EMODnet WFS returned %d features (layer=%s)', len(features), EMODNET_LAYER)
            return features
        except Exception as exc:
            last_err = exc
            log.warning('EMODnet WFS attempt %d failed: %s', attempt + 1, exc)
            time.sleep(2 ** attempt)
    log.error('EMODnet WFS failed after retries: %s', last_err)
    return []


def _parse_iso_dt(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        # EMODnet renvoie "2025-04-12T08:00:00Z" — Python ne mange pas le Z.
        return datetime.fromisoformat(s.replace('Z', '+00:00'))
    except (TypeError, ValueError):
        return None


def upsert_platforms(conn: psycopg.Connection, features: list[dict[str, Any]]) -> int:
    """UPSERT chaque feature EMODnet dans la table buoys.

    Retourne le nombre de lignes effectivement upsertées (les features
    sans PLATFORMCODE ou sans géométrie POINT sont skippées).
    """
    upserted = 0
    with conn.cursor() as cur:
        for feat in features:
            props = feat.get('properties', {}) or {}
            geom = feat.get('geometry', {}) or {}
            code = (props.get('PLATFORMCODE') or '').strip()
            if not code:
                continue
            if geom.get('type') != 'Point':
                continue
            coords = geom.get('coordinates') or []
            if len(coords) < 2:
                continue
            # geometry.coordinates = [lon, lat] standard GeoJSON. On
            # cross-check via les props `latitude` / `longitude` qui sont
            # toujours présentes (cf DescribeFeatureType).
            prop_lat = props.get('latitude')
            prop_lon = props.get('longitude')
            if prop_lat is not None and prop_lon is not None:
                lon, lat = float(prop_lon), float(prop_lat)
            else:
                lon, lat = float(coords[0]), float(coords[1])

            name = (props.get('call_name') or code).strip() or code
            platform_type = props.get('platform_type_longname') or None
            owner = props.get('data_owner_longname') or None
            country = props.get('data_owner_country_longname') or None
            wmo = props.get('WMO') or None
            parameters = props.get('parameters') or None
            parameters_group = props.get('parameters_group_longname') or None
            data_link = props.get('dataLink') or None
            last_obs_at = _parse_iso_dt(props.get('lastDateObservationDT'))

            cur.execute(
                """
                INSERT INTO buoys (
                  candhis_id, name, geom, platform_type, owner, country,
                  wmo, parameters, parameters_group, data_link, last_obs_at,
                  source, last_updated
                ) VALUES (
                  %s, %s, ST_SetSRID(ST_MakePoint(%s, %s), 4326),
                  %s, %s, %s, %s, %s, %s, %s, %s,
                  'emodnet-physics-wfs', now()
                )
                ON CONFLICT (candhis_id) DO UPDATE SET
                  name             = EXCLUDED.name,
                  geom             = EXCLUDED.geom,
                  platform_type    = EXCLUDED.platform_type,
                  owner            = EXCLUDED.owner,
                  country          = EXCLUDED.country,
                  wmo              = EXCLUDED.wmo,
                  parameters       = EXCLUDED.parameters,
                  parameters_group = EXCLUDED.parameters_group,
                  data_link        = EXCLUDED.data_link,
                  last_obs_at      = EXCLUDED.last_obs_at,
                  source           = EXCLUDED.source,
                  last_updated     = now()
                """,
                (
                    code, name, lon, lat,
                    platform_type, owner, country,
                    wmo, parameters, parameters_group, data_link, last_obs_at,
                ),
            )
            upserted += 1
    log.info('Upserted %d EMODnet platforms into buoys table', upserted)
    return upserted


# ─── Cron jobs ──────────────────────────────────────────────────────────
def job_referential() -> None:
    started_at = datetime.now(timezone.utc)
    try:
        features = fetch_emodnet_wave_platforms()
        if not features:
            log.warning('No EMODnet features — referential left as-is')
            report_job('partial', started_at, errorKind='EmptyFeatures',
                       errorMsg='EMODnet WFS returned 0 features')
            return
        conn = connect_db()
        try:
            ts_start = datetime.now()
            count = upsert_platforms(conn, features)
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM buoys WHERE last_updated < %s - INTERVAL '60 seconds'",
                    (ts_start,),
                )
                deleted = cur.rowcount or 0
                if deleted > 0:
                    log.info('Cleaned up %d stale plateformes', deleted)
            log.info('Referential refresh complete: %d upserted, %d removed',
                     count, deleted)
            report_job('ok', started_at, recordsIn=len(features),
                       recordsOut=count, meta={'removed': deleted})
        finally:
            conn.close()
    except Exception as exc:
        log.exception('job_referential failed')
        report_job('error', started_at,
                   errorKind=type(exc).__name__,
                   errorMsg=str(exc)[:500])


def main() -> None:
    log.info(
        'buoy-fetcher starting — EMODnet Physics WFS layer=%s bbox=[%g,%g,%g,%g]',
        EMODNET_LAYER, BBOX_MIN_LON, BBOX_MIN_LAT, BBOX_MAX_LON, BBOX_MAX_LAT,
    )

    conn = connect_db()
    ensure_schema(conn)
    conn.close()
    job_referential()

    # Référentiel re-seedé toutes les FETCH_INTERVAL_MIN minutes (défaut
    # 24h). Le WFS EMODnet est largement dimensionné, mais on reste poli.
    sched = BlockingScheduler(timezone='UTC')
    sched.add_job(
        job_referential,
        'interval',
        minutes=FETCH_INTERVAL_MIN,
        id='referential-loop',
    )
    log.info('Scheduler started. Referential re-seed every %dmin.', FETCH_INTERVAL_MIN)
    try:
        sched.start()
    except (KeyboardInterrupt, SystemExit):
        log.info('buoy-fetcher shutting down')


if __name__ == '__main__':
    sys.exit(main())
