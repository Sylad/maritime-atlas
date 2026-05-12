-- Maritime Atlas — schema initial
--
-- TimescaleDB pour vessel_positions (hypertable partitionné par jour),
-- PostGIS pour les types geometry/geography.
--
-- Hypotheses (post-sprint Europe 2026-05-12, bbox étendu Açores→Pologne) :
--   * Bbox Europe étroite ≈ 170 msg/s peak → ~14-15M positions/jour
--     (×3 vs bbox FR métro pré-sprint).
--   * Hypertable + chunk_time_interval=1d permet INSERT massifs sans
--     bloquer les SELECT spatiaux.
--   * vessels.last_position est dénormalisé pour servir un WFS rapide
--     (last 15 min sans scanner l'historique).

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- ─── Vessels (referential, UPSERT par mmsi) ───────────────────────────
CREATE TABLE IF NOT EXISTS vessels (
  mmsi          BIGINT PRIMARY KEY,
  imo           BIGINT,
  name          TEXT,
  callsign      TEXT,
  ship_type     SMALLINT,                              -- AIS type code (30=fishing, 60=passenger, 70=cargo, 80=tanker…)
  flag          CHAR(2),
  length_m      INT,
  width_m       INT,
  draught_m     REAL,
  destination   TEXT,
  eta           TIMESTAMPTZ,
  first_seen    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen     TIMESTAMPTZ,
  last_position GEOGRAPHY(POINT, 4326)
);

CREATE INDEX IF NOT EXISTS vessels_last_position_gix ON vessels USING GIST (last_position);
CREATE INDEX IF NOT EXISTS vessels_last_seen_idx ON vessels (last_seen DESC);
CREATE INDEX IF NOT EXISTS vessels_ship_type_idx ON vessels (ship_type);

-- ─── Vessel positions (hypertable, ~M lignes/jour) ────────────────────
CREATE TABLE IF NOT EXISTS vessel_positions (
  ts          TIMESTAMPTZ NOT NULL,
  mmsi        BIGINT NOT NULL,
  geom        GEOGRAPHY(POINT, 4326) NOT NULL,
  sog         REAL,                                   -- speed over ground (knots), -1 si N/A
  cog         REAL,                                   -- course over ground (deg)
  heading     REAL,                                   -- true heading (deg), 511 si N/A
  nav_status  SMALLINT                                -- 0=under way, 1=anchored, 5=moored, 8=under way sailing
);

SELECT create_hypertable('vessel_positions', 'ts', chunk_time_interval => INTERVAL '1 day', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS vessel_positions_geom_gix ON vessel_positions USING GIST (geom);
CREATE INDEX IF NOT EXISTS vessel_positions_mmsi_ts_idx ON vessel_positions (mmsi, ts DESC);

-- ─── TTL policies — évite que le NAS sature ──────────────────────────
-- Estimation volume Europe (post-sprint Europe 2026-05-12) :
--   ~14M positions/jour × ~120 octets/ligne ≈ 1.6 GB/jour sans compression.
--   Sur 30 jours retention = ~48 GB.
--   Avec compression TimescaleDB sur chunks > 7j (ratio mesuré 8.9×
--   sur AIS Europe — segmentby mmsi pack très bien les positions
--   sériées d'un même navire) → ~7-8 GB total.
-- Mesure validée 2026-05-12 : 1er chunk compressé 64 MB → 7.4 MB (88.7%
-- saved). Cf force-compress lors du sprint Europe Chantier #5.

-- Compression : chunks > 7 jours compressés (segmentby mmsi → 5-15× ratio)
ALTER TABLE vessel_positions SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'mmsi',
  timescaledb.compress_orderby = 'ts DESC'
);

-- Retention : drop chunks > 30 jours. Modifiable via :
--   SELECT remove_retention_policy('vessel_positions');
--   SELECT add_retention_policy('vessel_positions', INTERVAL '90 days');
DO $$
BEGIN
  -- Compression policy. TimescaleDB 2.18+ renomme `policy_compression`
  -- en `policy_columnstore` — on matche les deux pour rester idempotent
  -- cross-version. Si la policy est déjà créée auto par TS au moment du
  -- `ALTER TABLE ... SET timescaledb.compress` (comportement par défaut
  -- en TS 2.18+), on ne fait rien.
  IF NOT EXISTS (
    SELECT 1 FROM timescaledb_information.jobs
    WHERE hypertable_name = 'vessel_positions'
      AND proc_name IN ('policy_compression', 'policy_columnstore')
  ) THEN
    PERFORM add_compression_policy('vessel_positions', INTERVAL '7 days');
  END IF;

  -- Retention policy
  IF NOT EXISTS (
    SELECT 1 FROM timescaledb_information.jobs
    WHERE proc_name = 'policy_retention' AND hypertable_name = 'vessel_positions'
  ) THEN
    PERFORM add_retention_policy('vessel_positions', INTERVAL '30 days');
  END IF;
END $$;

-- ─── Tracks pré-aggregés par jour (pour WFS rapide) ───────────────────
-- Construit par track-builder via cron horaire. Servi à la map pour
-- tracer les routes complètes des vessels du jour, sans scanner les
-- millions de positions.
CREATE TABLE IF NOT EXISTS vessel_tracks_daily (
  mmsi      BIGINT NOT NULL,
  day       DATE NOT NULL,
  geom      GEOMETRY(LINESTRING, 4326),
  points_n  INT,
  PRIMARY KEY (mmsi, day)
);

CREATE INDEX IF NOT EXISTS vessel_tracks_daily_geom_gix ON vessel_tracks_daily USING GIST (geom);
CREATE INDEX IF NOT EXISTS vessel_tracks_daily_day_idx ON vessel_tracks_daily (day DESC);

-- ─── Areas (MPA, Natura 2000, port polygons, TSS) ─────────────────────
-- Importées en sprint 4 via wdpa-importer. Pour le sprint 1, table vide.
CREATE TABLE IF NOT EXISTS protected_areas (
  id              TEXT PRIMARY KEY,
  name            TEXT,
  designation     TEXT,
  designation_eng TEXT,
  iucn_cat        TEXT,
  marine          BOOLEAN,
  area_km2        REAL,
  geom            GEOMETRY(MULTIPOLYGON, 4326)
);

CREATE INDEX IF NOT EXISTS protected_areas_geom_gix ON protected_areas USING GIST (geom);
CREATE INDEX IF NOT EXISTS protected_areas_designation_idx ON protected_areas (designation);

-- ─── Alerts (sprint 4) ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alerts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ts           TIMESTAMPTZ NOT NULL DEFAULT now(),
  alert_type   TEXT NOT NULL,                          -- 'mpa_intrusion', 'speed_anomaly', 'signal_loss', 'port_arrival'
  vessel_mmsi  BIGINT REFERENCES vessels(mmsi),
  area_id      TEXT REFERENCES protected_areas(id),
  severity     SMALLINT NOT NULL DEFAULT 2,            -- 1=info, 2=warning, 3=critical
  geom         GEOMETRY(POINT, 4326),
  details      JSONB,
  resolved_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS alerts_ts_idx ON alerts (ts DESC);
CREATE INDEX IF NOT EXISTS alerts_unresolved_idx ON alerts (resolved_at) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS alerts_vessel_idx ON alerts (vessel_mmsi);
CREATE INDEX IF NOT EXISTS alerts_geom_gix ON alerts USING GIST (geom);
