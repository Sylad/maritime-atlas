-- Maritime Atlas — schema initial
--
-- TimescaleDB pour vessel_positions (hypertable partitionné par jour),
-- PostGIS pour les types geometry/geography.
--
-- Hypotheses :
--   * Bbox Bretagne+golfe Gascogne ≈ 50 msg/s peak → ~4M positions/jour.
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

-- Compression policy : compresse les chunks > 7 jours pour économiser
-- ~10× sur le disque. Désactivé si tu veux garder l'INSERT fluide au
-- début, à activer quand le volume devient lourd.
-- ALTER TABLE vessel_positions SET (timescaledb.compress, timescaledb.compress_segmentby = 'mmsi');
-- SELECT add_compression_policy('vessel_positions', INTERVAL '7 days');

-- Retention : drop chunks > 90 jours pour ne pas exploser le disque NAS.
-- À activer quand tu auras atteint un état stable.
-- SELECT add_retention_policy('vessel_positions', INTERVAL '90 days');

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
