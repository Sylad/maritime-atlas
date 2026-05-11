"""
candhis-fetcher — référentiel + observations temps réel des bouées CANDHIS
(houlographes CEREMA).

Deux sources, deux modes de fonctionnement :

1. **Référentiel des bouées** (toujours ON) — seed unique au boot puis
   refresh quotidien. Source : GeoPackage public sur data.gouv.fr (Licence
   Ouverte Etalab 2.0, aucune clé requise) :
     https://www.data.gouv.fr/datasets/stations-de-mesure-de-candhis...
   Il y a 118 stations couvrant France métropole + Outre-Mer.
   On parse le GPKG via stdlib sqlite3 (pas de fiona/geopandas pour garder
   l'image légère). Géométrie POINT WKB encodée selon spec GeoPackage 1.2.

2. **Observations temps réel** (optionnel, ON si CANDHIS_API_KEY défini) —
   appel horaire à `getCampListeTR.php?type=2` (TR directionnel H13) et
   `type=1` (TR directionnel Hm0), insertion dans la hypertable
   `buoy_observations`. Doc API officielle : doc/04_Candhis_API_v1_*.pdf.

L'API CANDHIS exige une clé d'accès délivrée sur demande email
(candhis@cerema.fr). Sans clé, le service tourne quand même et publie le
référentiel — la couche `maritime:buoys` est affichable, juste sans
métrique temps réel. Quand la clé arrive et est ajoutée au .env, le
service consomme les obs automatiquement.

Politesse réseau (CEREMA est un service public, on ne le martèle pas) :
  - fetch des obs toutes les 60 min (configurable)
  - 1 User-Agent identifiant clairement le projet
  - retries avec backoff exponentiel (max 3 tentatives)
"""
from __future__ import annotations

import logging
import os
import struct
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import psycopg
import requests
from apscheduler.schedulers.blocking import BlockingScheduler

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(name)s: %(message)s',
)
log = logging.getLogger('candhis-fetcher')

# ─── Config ─────────────────────────────────────────────────────────────
DATABASE_URL = os.environ['DATABASE_URL']
CANDHIS_API_KEY = os.environ.get('CANDHIS_API_KEY', '').strip()
CANDHIS_API_BASE = os.environ.get(
    'CANDHIS_API_BASE',
    'https://candhis.cerema.fr/API/v1',
)
CANDHIS_GPKG_URL = os.environ.get(
    'CANDHIS_GPKG_URL',
    'https://static.data.gouv.fr/resources/'
    'candhis-houlographes-de-lobservatoire-cotier-national-de-mesure-in-situ-'
    'des-etats-de-mer-france-metropole-et-outre-mer/'
    '20241203-105508/candhis-houlographes-202412.gpkg',
)
FETCH_INTERVAL_MIN = int(os.environ.get('CANDHIS_FETCH_INTERVAL_MIN', '60'))
USER_AGENT = os.environ.get(
    'CANDHIS_USER_AGENT',
    'maritime-atlas/0.1 (https://maritime.sladoire.dev; sylvain.ladoire@gmail.com)',
)
REQUEST_TIMEOUT = int(os.environ.get('CANDHIS_REQUEST_TIMEOUT', '60'))


# ─── Helpers : parsing GPKG WKB ──────────────────────────────────────────
def parse_gpkg_point(blob: bytes) -> tuple[float, float] | None:
    """Parse le format GeoPackage (header GP + WKB Point) → (lon, lat).

    Spec GeoPackage 1.2 §2.1.3.1 :
        magic[2]=b'GP' + version[1] + flags[1] + srs_id[4] + envelope[?]
        + WKB classique (byte_order[1] + type[4] + x[8] + y[8])

    flags bits :
        bit 1: envelope present si != 0 (0=none, 1=xy, 2=xyz, ...)
        bit 0: byte order (1=little-endian)
    """
    if not blob or len(blob) < 8:
        return None
    if blob[:2] != b'GP':
        return None
    flags = blob[3]
    env_code = (flags >> 1) & 0x07
    env_sizes = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}
    env_size = env_sizes.get(env_code, 0)
    offset = 8 + env_size  # skip header + envelope
    if len(blob) < offset + 21:
        return None
    wkb_byte_order = blob[offset]
    endian = '<' if wkb_byte_order == 1 else '>'
    geom_type = struct.unpack(endian + 'I', blob[offset + 1:offset + 5])[0]
    if geom_type != 1:  # Point only
        return None
    lon, lat = struct.unpack(endian + 'dd', blob[offset + 5:offset + 21])
    return (lon, lat)


# ─── DB connection ──────────────────────────────────────────────────────
def connect_db() -> psycopg.Connection:
    # autocommit ON pour CREATE EXTENSION + create_hypertable côté init
    return psycopg.connect(DATABASE_URL, autocommit=True)


def ensure_schema(conn: psycopg.Connection) -> None:
    """Crée idempotamment les tables buoys + buoy_observations.

    Pattern aligné avec le reste du projet : on évite les ALTER + UPDATE
    sur tables d'utilisateurs (api/Drizzle), le schema buoys vit dans son
    coin (provisioner-side, pas Drizzle).
    """
    with conn.cursor() as cur:
        cur.execute("""
        CREATE TABLE IF NOT EXISTS buoys (
          candhis_id    TEXT PRIMARY KEY,                -- code campagne "02911"
          name          TEXT NOT NULL,                   -- "Les Pierres Noires"
          geom          GEOMETRY(POINT, 4326) NOT NULL,
          buoy_type     TEXT,                            -- "TR directionnel H13" | "TR directionnel Hm0" | ...
          source        TEXT NOT NULL DEFAULT 'data.gouv.fr-gpkg',
          first_seen    TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_updated  TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        """)
        cur.execute("""
        CREATE INDEX IF NOT EXISTS buoys_geom_gix ON buoys USING GIST (geom);
        """)

        cur.execute("""
        CREATE TABLE IF NOT EXISTS buoy_observations (
          ts           TIMESTAMPTZ NOT NULL,
          candhis_id   TEXT NOT NULL,
          hm0          REAL,           -- hauteur significative spectrale (m), null si non dispo
          h13          REAL,           -- H1/3 (m) houlo non-directionnel ou H13 directionnel
          hmax         REAL,           -- hauteur max sur la mesure (m)
          tp           REAL,           -- période au pic (s)
          th13         REAL,           -- période H1/3 (s)
          t02          REAL,           -- période moyenne T02 (s)
          peak_dir     REAL,           -- direction au pic (deg, 0=Nord)
          peak_spread  REAL,           -- étalement au pic (deg)
          temp_water   REAL,           -- température mer (°C), 999.9 = N/A côté API
          raw          JSONB           -- snapshot des colonnes brutes (debug + future-proof)
        );
        """)

        # Hypertable + retention 30j (cohérent avec vessel_positions).
        # ⚠ pas de PK car hypertable avec PK simple non partitionnée échoue.
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
        # Unicité (ts, candhis_id) → INSERT idempotent (ON CONFLICT DO NOTHING).
        cur.execute("""
        CREATE UNIQUE INDEX IF NOT EXISTS buoy_obs_ts_candhis_uidx
          ON buoy_observations (ts, candhis_id);
        """)

        # Retention 30j idempotent.
        cur.execute("""
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM timescaledb_information.jobs
            WHERE proc_name = 'policy_retention'
              AND hypertable_name = 'buoy_observations'
          ) THEN
            PERFORM add_retention_policy('buoy_observations', INTERVAL '30 days');
          END IF;
        END $$;
        """)

        # Vue "récente" exposée via WFS (1h fenêtre — les CANDHIS ne pushent
        # qu'une mesure / 30min, donc 1h garantit qu'on a la dernière).
        cur.execute("""
        CREATE OR REPLACE VIEW v_buoy_observations_recent AS
        SELECT
          o.candhis_id,
          b.name,
          b.buoy_type,
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
          WHERE ts > now() - INTERVAL '6 hours'
          ORDER BY candhis_id, ts DESC
        ) o
        JOIN buoys b USING (candhis_id);
        """)
    log.info('schema ensured (buoys, buoy_observations, v_buoy_observations_recent)')


# ─── Step 1: seed referential ───────────────────────────────────────────
def seed_buoys_from_gpkg(conn: psycopg.Connection) -> int:
    """Télécharge le GPKG public et UPSERT les 118 bouées.

    Retourne le nombre de bouées upserted.
    """
    log.info('Downloading CANDHIS GPKG referential from %s', CANDHIS_GPKG_URL)
    resp = requests.get(
        CANDHIS_GPKG_URL,
        headers={'User-Agent': USER_AGENT},
        timeout=REQUEST_TIMEOUT,
    )
    resp.raise_for_status()

    with tempfile.NamedTemporaryFile(suffix='.gpkg', delete=False) as f:
        f.write(resp.content)
        tmp_path = Path(f.name)

    try:
        # On lit le GPKG via sqlite3 stdlib (c'est un SQLite déguisé).
        import sqlite3
        sqcon = sqlite3.connect(str(tmp_path))
        sqcon.row_factory = sqlite3.Row
        sqcur = sqcon.cursor()
        # Trouve la table de features (devine via gpkg_contents data_type='features')
        sqcur.execute(
            "SELECT table_name FROM gpkg_contents WHERE data_type = 'features' LIMIT 1"
        )
        row = sqcur.fetchone()
        if not row:
            log.error('No feature table found in GPKG')
            return 0
        feature_table = row[0]
        log.info('GPKG feature table: %s', feature_table)

        sqcur.execute(f'SELECT * FROM "{feature_table}"')
        rows = sqcur.fetchall()
        log.info('GPKG rows: %d', len(rows))

        # Schema attendu : geom, NomCampagne, Latitude, Longitude, CodeCampagne
        upserted = 0
        with conn.cursor() as cur:
            for r in rows:
                code = (r['CodeCampagne'] or '').strip()
                if not code:
                    continue
                name_full = (r['NomCampagne'] or '').strip()
                # NomCampagne arrive sous "05901_Dunkerque" → on garde la
                # partie après '_'. Si pas de '_' on garde tel quel.
                name = name_full.split('_', 1)[1] if '_' in name_full else name_full
                lonlat = parse_gpkg_point(r['geom'])
                if not lonlat:
                    log.warning('skip %s : unparseable geom', code)
                    continue
                lon, lat = lonlat
                cur.execute(
                    """
                    INSERT INTO buoys (candhis_id, name, geom, source, last_updated)
                    VALUES (
                      %s, %s,
                      ST_SetSRID(ST_MakePoint(%s, %s), 4326),
                      'data.gouv.fr-gpkg',
                      now()
                    )
                    ON CONFLICT (candhis_id) DO UPDATE
                       SET name = EXCLUDED.name,
                           geom = EXCLUDED.geom,
                           last_updated = now()
                    """,
                    (code, name, lon, lat),
                )
                upserted += 1
        log.info('Upserted %d buoys into Postgres', upserted)
        return upserted
    finally:
        sqcon.close()
        try:
            tmp_path.unlink()
        except OSError:
            pass


# ─── Step 2: fetch real-time observations (requires API key) ────────────
def candhis_api_call(path: str, params: dict[str, Any]) -> dict[str, Any] | None:
    """Wrapper API CANDHIS avec retries exponentiels.

    Retourne le JSON décodé si success, sinon None.
    """
    if not CANDHIS_API_KEY:
        return None
    url = f'{CANDHIS_API_BASE}/{path}'
    headers = {
        'Authorization': CANDHIS_API_KEY,
        'User-Agent': USER_AGENT,
        # Doc API : content-type obligatoire dans les exemples Python officiels.
        'Content-Type': 'application/json',
    }
    last_err: Exception | None = None
    for attempt in range(3):
        try:
            r = requests.get(url, headers=headers, params=params, timeout=REQUEST_TIMEOUT)
            if r.status_code == 429:
                log.warning('CANDHIS 429 quota — sleeping 5min before next try')
                time.sleep(300)
                continue
            if r.status_code == 401:
                log.error('CANDHIS 401 invalid API key — disabling obs fetch until restart')
                return None
            r.raise_for_status()
            data = r.json()
            if not data.get('success'):
                log.info(
                    'CANDHIS %s says success=false: %s',
                    path, data.get('message', '?'),
                )
                return None
            return data
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            log.warning('CANDHIS %s attempt %d failed: %s', path, attempt + 1, exc)
            time.sleep(2 ** attempt)
    log.error('CANDHIS %s failed after retries: %s', path, last_err)
    return None


def fetch_realtime_obs(conn: psycopg.Connection) -> int:
    """Fetch les dernières observations TR pour tous les houlographes des
    types 1 (Hm0 directionnel) et 2 (H13 directionnel) via
    getCampListeTR.php.

    Retourne le nombre de lignes INSERT.
    """
    if not CANDHIS_API_KEY:
        log.info('CANDHIS_API_KEY not set — skipping real-time obs fetch')
        return 0

    total_inserted = 0
    # Type 0 = non-directionnel H13 (entête : Date, H1/3, Hmax, TH1/3, T. au pic, Temp. mer)
    # Type 1 = directionnel Hm0   (entête : Date, Hm0, Hmax, T02, Dir. au pic, Temp. mer)
    # Type 2 = directionnel H13   (entête : Date, H1/3, Hmax, TH1/3, Dir. au pic, Etal. au pic, Temp. mer)
    for type_code in (0, 1, 2):
        data = candhis_api_call('getCampListeTR.php', {'type': type_code})
        if not data:
            continue
        entete = data.get('entete') or []
        results = data.get('results') or []
        if not results:
            continue
        # Index colonnes selon entête réelle (robuste si l'ordre change).
        idx = {name: i for i, name in enumerate(entete)}
        log.info(
            'CANDHIS type=%d entete=%s nbLig=%d',
            type_code, entete, len(results),
        )
        with conn.cursor() as cur:
            for row in results:
                inserted = upsert_observation(cur, type_code, idx, row)
                if inserted:
                    total_inserted += 1
    log.info('CANDHIS realtime obs : %d new rows inserted', total_inserted)
    return total_inserted


def _safe_float(v: Any) -> float | None:
    """Convert API value to float, returning None for missing/sentinel."""
    if v is None or v == '':
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    # CANDHIS sentinel : 999.9999 → N/A
    if abs(f - 999.9999) < 0.001 or abs(f - 999) < 0.001:
        return None
    return f


def upsert_observation(
    cur: psycopg.Cursor,
    type_code: int,
    idx: dict[str, int],
    row: list[Any],
) -> bool:
    """Parse une ligne d'observation et l'insère. Retourne True si insert."""
    def col(name: str) -> Any:
        i = idx.get(name)
        return row[i] if i is not None and i < len(row) else None

    # getCampListeTR renvoie en plus une colonne "Campagne" en début
    candhis_id = (col('Campagne') or '').strip()
    if not candhis_id:
        return False
    ts_str = (col('Date') or '').strip()
    if not ts_str:
        return False
    # Format API : "2024-03-04 10:30" — UTC (cf. doc API §4.6 "Heure (TU)")
    try:
        ts = datetime.strptime(ts_str, '%Y-%m-%d %H:%M').replace(tzinfo=timezone.utc)
    except ValueError:
        log.warning('skip row, bad date: %s', ts_str)
        return False

    hm0 = _safe_float(col('Hm0 (m)'))
    h13 = _safe_float(col('H1/3 (m)'))
    hmax = _safe_float(col('Hmax (m)'))
    tp = _safe_float(col('T. au pic (s)'))
    th13 = _safe_float(col('TH1/3 (s)'))
    t02 = _safe_float(col('T02 (s)'))
    peak_dir = _safe_float(col('Dir. au pic (°)'))
    peak_spread = _safe_float(col('Etal. au pic (°)'))
    temp_water = _safe_float(col('Temp. mer (°C)'))

    import json as _json
    raw = _json.dumps({entete: row[i] for entete, i in idx.items() if i < len(row)})

    cur.execute(
        """
        INSERT INTO buoy_observations (
            ts, candhis_id, hm0, h13, hmax, tp, th13, t02,
            peak_dir, peak_spread, temp_water, raw
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)
        ON CONFLICT (ts, candhis_id) DO NOTHING
        """,
        (
            ts, candhis_id, hm0, h13, hmax, tp, th13, t02,
            peak_dir, peak_spread, temp_water, raw,
        ),
    )
    return cur.rowcount > 0


# ─── Cron jobs ──────────────────────────────────────────────────────────
def job_observations() -> None:
    try:
        conn = connect_db()
        fetch_realtime_obs(conn)
        conn.close()
    except Exception:  # noqa: BLE001
        log.exception('job_observations failed')


def job_referential() -> None:
    try:
        conn = connect_db()
        seed_buoys_from_gpkg(conn)
        conn.close()
    except Exception:  # noqa: BLE001
        log.exception('job_referential failed')


def main() -> None:
    log.info(
        'candhis-fetcher starting (interval=%dmin, api_key=%s, gpkg=%s)',
        FETCH_INTERVAL_MIN,
        'set' if CANDHIS_API_KEY else 'NOT SET (obs disabled, ref only)',
        CANDHIS_GPKG_URL.split('/')[-1],
    )

    # Init schema + premier seed du référentiel
    conn = connect_db()
    ensure_schema(conn)
    seed_buoys_from_gpkg(conn)
    conn.close()

    # Première passe d'observations si la clé est dispo
    if CANDHIS_API_KEY:
        job_observations()

    # Scheduler : référentiel 1×/jour à 04:30 UTC (heure creuse, après les
    # cleanup_old_* timescaledb à 03:30), observations toutes les
    # FETCH_INTERVAL_MIN minutes.
    sched = BlockingScheduler(timezone='UTC')
    sched.add_job(
        job_referential,
        'cron',
        hour=4, minute=30,
        id='referential-daily',
    )
    sched.add_job(
        job_observations,
        'interval',
        minutes=FETCH_INTERVAL_MIN,
        id='obs-loop',
    )
    log.info('Scheduler started. obs every %dmin, ref daily 04:30Z.', FETCH_INTERVAL_MIN)
    try:
        sched.start()
    except (KeyboardInterrupt, SystemExit):
        log.info('candhis-fetcher shutting down')


if __name__ == '__main__':
    sys.exit(main())
