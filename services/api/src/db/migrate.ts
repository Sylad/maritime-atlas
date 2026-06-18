/**
 * Migrations Drizzle au boot. Approche pragmatique pour un service jeune :
 * on génère les CREATE TABLE en SQL inline plutôt que de packager le dossier
 * drizzle/ via drizzle-kit. Quand le projet grossit, basculer sur
 * drizzle-kit + dossier `drizzle/` mounté côté image.
 *
 * Sprint Auth refonte (2026-05-11) : ajout colonnes username, role,
 * email_verified_at, last_login_at, verification_token. Toutes les
 * ALTER sont guard `IF NOT EXISTS` pour idempotence et la backfill
 * username/email_verified_at est dans un bloc DO $$ ... $$ qui ne
 * touche que les rangées NULL.
 */
import postgres from 'postgres';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id          SERIAL PRIMARY KEY,
  email       TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users (email);

CREATE TABLE IF NOT EXISTS palettes (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL,
  layer_kind  TEXT NOT NULL,
  stops       JSONB NOT NULL,
  opacity     REAL NOT NULL DEFAULT 0.7,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS palettes_user_slug_idx ON palettes (user_id, slug);

CREATE TABLE IF NOT EXISTS user_layer_preferences (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  layer_kind  TEXT NOT NULL,
  palette_id  INTEGER REFERENCES palettes(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, layer_kind)
);
-- Sprint Layer UX V2 Phase C (2026-05-11) : visibility + opacity per layer
-- pour TOUTES les layers (vessels, tracks, sst, rain, ...). user_layer_preferences
-- couvre désormais le state complet par layer (visibility + opacity + palette).
ALTER TABLE user_layer_preferences ADD COLUMN IF NOT EXISTS visible BOOLEAN;
ALTER TABLE user_layer_preferences ADD COLUMN IF NOT EXISTS opacity REAL;
ALTER TABLE user_layer_preferences DROP CONSTRAINT IF EXISTS user_layer_preferences_opacity_check;
ALTER TABLE user_layer_preferences ADD CONSTRAINT user_layer_preferences_opacity_check
  CHECK (opacity IS NULL OR (opacity >= 0 AND opacity <= 1));

-- ─── Sprint Auth refonte : colonnes additionnelles users ───
ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_token TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_token_expires_at TIMESTAMPTZ;
-- Sprint Auth refonte Phase B (2026-05-11) : forgot password / reset
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_token TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_expires_at TIMESTAMPTZ;
-- Phase C.3 (2026-05-12) : zone d'arrivée préférée, slug parmi MAP_ZONES
-- (france, europe, europe-west, europe-east, mediterranee, manche,
-- atlantique, baltique, suisse, bulgarie). NULL = fallback 'france'.
ALTER TABLE users ADD COLUMN IF NOT EXISTS default_zone TEXT;
-- Phase C.4 (2026-05-12) : projection OL préférée — 'EPSG:3857' (défaut),
-- 'EPSG:4326', 'EPSG:3035' (Lambert LAEA Europe).
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_projection TEXT;
-- 2026-05-19 APEX 18 : ordre user des layers (z-index) sync multi-device.
-- JSONB array de strings (layerKind), persiste l'ordre du DnD time-bar.
-- NULL = pas encore set → fallback localStorage / ordre déclaratif.
ALTER TABLE users ADD COLUMN IF NOT EXISTS layer_order JSONB;

-- 2026-05-20 : préférences contours isolignes (interval + color hex) sync
-- multi-device. Structure : { sst: {show, interval, color}, wind: {...}, wave: {...} }.
-- Règle "user qui revient retrouve sa config sur tout device" — le show
-- est aussi dans layer_states mais on garde tout dans contour_prefs pour
-- cohérence (1 set complet en DB).
ALTER TABLE users ADD COLUMN IF NOT EXISTS contour_prefs JSONB;

-- Backfill username + email_verified_at pour les users existants
-- (créés avant la refonte). username dérivé du local-part email avec
-- suffixe _N en cas de collision. email_verified_at = now() pour ne
-- pas casser l'accès des comptes legacy.
DO $$
DECLARE
  r RECORD;
  base TEXT;
  candidate TEXT;
  n INT;
BEGIN
  FOR r IN SELECT id, email FROM users WHERE username IS NULL LOOP
    base := lower(regexp_replace(split_part(r.email, '@', 1), '[^a-z0-9_-]', '', 'g'));
    IF base = '' OR length(base) < 3 THEN base := 'user' || r.id; END IF;
    candidate := base;
    n := 1;
    WHILE EXISTS (SELECT 1 FROM users WHERE username = candidate AND id <> r.id) LOOP
      candidate := base || '_' || n;
      n := n + 1;
    END LOOP;
    UPDATE users SET
      username = candidate,
      email_verified_at = COALESCE(email_verified_at, now())
    WHERE id = r.id;
  END LOOP;
END $$;

-- Une fois backfill OK, NOT NULL + UNIQUE INDEX sur username.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'username' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE users ALTER COLUMN username SET NOT NULL;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS users_username_idx ON users (username);

-- Check role enum
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('user', 'admin'));

-- ─── Data Orchestrator MVP Sprint 1 (2026-05-12) — visibility-only ───
-- Référentiel data_sources (seed manuel des 6 ingesters) + hypertable
-- data_jobs (1 ligne par cycle d'exécution reporté via POST /admin/jobs/log).
CREATE TABLE IF NOT EXISTS data_sources (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL,
  url             TEXT,
  schedule_expr   TEXT,
  sink_label      TEXT,
  bbox            TEXT,
  enabled         BOOLEAN NOT NULL DEFAULT FALSE,
  last_run_at     TIMESTAMPTZ,
  last_status     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS data_sources_name_idx ON data_sources (name);

-- Sprint N2 : colonnes additionnelles pour exécution dynamique. ALTERs
-- idempotents pour ne pas casser les seeds existants.
ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS schedule_kind TEXT;
ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS interval_seconds INTEGER;
ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS http_method TEXT DEFAULT 'GET';
ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS http_headers JSONB;
ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS http_params JSONB;
ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS parser_kind TEXT DEFAULT 'identity';
ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS parser_config JSONB;
ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS sink_kind TEXT DEFAULT 'rmq_publish';
ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS sink_config JSONB;
ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS data_jobs (
  id              BIGSERIAL,
  source_name     TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('ok', 'partial', 'error')),
  started_at      TIMESTAMPTZ NOT NULL,
  finished_at     TIMESTAMPTZ,
  duration_ms     INTEGER,
  records_in      INTEGER,
  records_out     INTEGER,
  bytes_in        INTEGER,
  error_kind      TEXT,
  error_msg       TEXT,
  meta            JSONB,
  PRIMARY KEY (started_at, id)
);
CREATE INDEX IF NOT EXISTS data_jobs_source_started_idx
  ON data_jobs (source_name, started_at DESC);

-- Hypertable + retention 90j. if_not_exists pour idempotence.
SELECT create_hypertable('data_jobs', 'started_at',
  chunk_time_interval => INTERVAL '7 days',
  if_not_exists => TRUE);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM timescaledb_information.jobs
    WHERE proc_name = 'policy_retention' AND hypertable_name = 'data_jobs'
  ) THEN
    PERFORM add_retention_policy('data_jobs', INTERVAL '90 days');
  END IF;
END $$;

-- Seed manuel des 6 sources actuelles. ON CONFLICT (name) DO NOTHING pour
-- ne pas écraser les modifs faites côté UI (toggle enabled, etc.).
INSERT INTO data_sources (name, kind, url, schedule_expr, sink_label, bbox) VALUES
  ('ais-ingester',       'websocket', 'wss://stream.aisstream.io/v0/stream',           'continu (WSS)',
   'RMQ ais.raw',                                                                       '[-15,35,30,65]'),
  ('ais-decoder',        'rmq_consumer', 'amqp://rabbitmq:5672 (queue ais.raw)',       'continu (RMQ)',
   'PostGIS vessel_positions + UPSERT vessels',                                         NULL),
  ('sst-fetcher',        'http_netcdf', 'https://www.ncei.noaa.gov/data/sea-surface-temperature-optimum-interpolation/v2.1', 'cron 06:00 UTC',
   '/coverage/sst-daily/*.tif',                                                         '[-15,35,30,65]'),
  ('weather-fetcher',    'http_grib',  'https://nomads.ncep.noaa.gov/cgi-bin/...',     'cron 4×/jour',
   '/coverage/wind-speed + /wind-arrows/wind_arrows_*.geojson',                        '[-15,35,30,65]'),
  ('weather-fetcher-arpege', 'http_grib', 'https://object.data.gouv.fr/meteofrance-pnt/pnt/<RUN>/arpege/01/SP1/', 'cron 03:30 / 09:30 / 15:30 / 21:30 UTC',
   '/coverage/wind-speed-arpege + arpege_wind_arrows_*.geojson',                       '[-15,35,30,65]'),
  ('weather-fetcher-arome', 'http_grib', 'https://object.data.gouv.fr/meteofrance-pnt/pnt/<RUN>/arome/0025/SP1/', 'cron 02:30 / 08:30 / 14:30 / 20:30 UTC',
   '/coverage/wind-speed-arome + arome_wind_arrows_*.geojson',                         '[-6,41,10,51.5]'),
  ('lightning-fetcher',  'websocket',  'wss://ws1.blitzortung.org/',                   'continu (WSS)',
   'PostGIS lightning_strikes + RMQ lightning.strike',                                  '[-15,35,30,65]'),
  ('buoy-fetcher',       'http_wfs',   'https://geoserver.emodnet-physics.eu/geoserver/emodnet/ows', 'cron 1×/jour',
   'PostGIS buoys',                                                                     '[-15,35,30,65]'),
  ('track-builder',      'sql_aggregate', 'PostGIS vessel_positions',                  'cron xx:35 chaque heure',
   'PostGIS vessel_tracks_daily (LineString par mmsi/day)',                            '[-15,35,30,65]')
ON CONFLICT (name) DO NOTHING;

-- Sprint N5 (2026-05-12) : weather-fetcher GFS migré vers orchestrator
-- dynamique (sidecar Python grib-parser → multi-fhour CGI subsetter
-- NOMADS → N GeoTIFFs/cycle). Remplace progressivement weather-fetcher
-- legacy (qu'on laisse tourner en parallèle pendant la bascule).
INSERT INTO data_sources (
  name, kind, url, schedule_kind, schedule_expr,
  parser_kind, parser_config,
  sink_kind, sink_config, sink_label, bbox, enabled
) VALUES (
  'weather-orchestrator-gfs-wind',
  'http_grib',
  'nomads://gfs_0p25 multi-fhour',
  'cron',
  '15 4,10,16,22 * * *',
  'grib_gfs_multi',
  '{"fhours": [0, 6, 12, 24, 48]}',
  'geotiff_volume',
  '{"output_dir": "/coverage/wind-speed-gfs", "output_prefix": "gfs_wind_speed", "bbox": [-15, 35, 30, 65], "geoserver_create_if_missing": true, "geoserver_workspace": "aetherwx", "geoserver_store": "wind-speed-gfs", "geoserver_coverage": "wind-speed-gfs", "geoserver_title": "Wind Speed (GFS 0.25° via orchestrator)"}',
  '/coverage/wind-speed-gfs (5 fhours/cycle)',
  '[-15,35,30,65]',
  false
)
ON CONFLICT (name) DO NOTHING;

-- ─── V2 Observation #1 — METAR observations (2026-05-12) ────────────
-- Source : NOAA Aviation Weather Center JSON, ~35 aéroports européens
-- en 1 call HTTP. Refresh 30min via orchestrator (kind=http_json,
-- parser=identity, sink=pg_insert avec ON CONFLICT DO NOTHING).
-- Stockage dénormalisé (lat/lon dans chaque obs) — plus simple qu'une
-- table stations séparée pour ~35 stations qui bougent jamais.
CREATE TABLE IF NOT EXISTS metar_observations (
  ts             TIMESTAMPTZ NOT NULL,
  icao           TEXT NOT NULL,
  station_name   TEXT,
  lat            REAL,
  lon            REAL,
  elevation_m    INTEGER,
  temp_c         REAL,
  dewp_c         REAL,
  wind_dir_deg   REAL,
  wind_speed_kt  REAL,
  wind_gust_kt   REAL,
  altimeter_hpa  REAL,
  weather_str    TEXT,
  raw            TEXT,
  source         TEXT NOT NULL DEFAULT 'noaa-awc'
);
CREATE UNIQUE INDEX IF NOT EXISTS metar_obs_ts_icao_uidx
  ON metar_observations (ts, icao);
SELECT create_hypertable(
  'metar_observations', 'ts',
  chunk_time_interval => INTERVAL '7 days',
  if_not_exists => TRUE
);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM timescaledb_information.jobs
    WHERE proc_name = 'policy_retention' AND hypertable_name = 'metar_observations'
  ) THEN
    PERFORM add_retention_policy('metar_observations', INTERVAL '30 days');
  END IF;
END $$;

-- Vue dernière obs par station (≤6h) avec géom PostGIS, exposée par
-- l'endpoint GET /api/metar/recent en GeoJSON.
CREATE OR REPLACE VIEW v_metar_recent AS
SELECT DISTINCT ON (icao)
  icao,
  station_name,
  ts,
  EXTRACT(EPOCH FROM (now() - ts))::INTEGER AS age_seconds,
  temp_c, dewp_c, wind_dir_deg, wind_speed_kt, wind_gust_kt,
  altimeter_hpa, weather_str, raw,
  ST_SetSRID(ST_MakePoint(lon, lat), 4326) AS geom
FROM metar_observations
WHERE ts > now() - INTERVAL '6 hours'
ORDER BY icao, ts DESC;

-- Orchestrator source METAR : NOAA AWC JSON bulk, ~35 aéroports EU.
-- Cron toutes les 30min. URL fix (pas de date dynamique car NOAA renvoie
-- toujours les obs les plus récentes pour les ids passés).
INSERT INTO data_sources (
  name, kind, url, schedule_kind, schedule_expr,
  parser_kind, parser_config,
  sink_kind, sink_config, sink_label, bbox, enabled
) VALUES (
  'metar-fetcher-eu',
  'http_json',
  'https://aviationweather.gov/api/data/metar?ids=LFPG,LFPO,LFLY,LFML,LFBO,LFBD,LFRS,LFRN,LFST,EGLL,EGKK,EGCC,EGPH,EDDF,EDDM,EDDB,EDDH,EHAM,EBBR,LEMD,LEBL,LIRF,LIMC,LICC,LSZH,LOWW,ESSA,ENGM,EFHK,EKCH,EPWA,LKPR,LGAV,LPPT,BIKF&format=json&hours=2',
  'cron',
  '*/30 * * * *',
  'identity',
  NULL,
  'pg_insert',
  '{"table": "metar_observations", "onConflict": "(ts, icao) DO NOTHING", "nullifyNonNumeric": ["wdir", "wspd", "wgst", "temp", "dewp", "altim"], "columns": {"reportTime": "ts", "icaoId": "icao", "name": "station_name", "lat": "lat", "lon": "lon", "elev": "elevation_m", "temp": "temp_c", "dewp": "dewp_c", "wdir": "wind_dir_deg", "wspd": "wind_speed_kt", "wgst": "wind_gust_kt", "altim": "altimeter_hpa", "wxString": "weather_str", "rawOb": "raw"}}',
  'PostGIS metar_observations (~35 aéroports EU)',
  '[-25,30,40,70]',
  true
)
ON CONFLICT (name) DO NOTHING;

-- ─── V2 Hydrologie #1 — Débits rivières Hub'eau France (2026-05-12) ─
-- Source : Hub'eau Eaufrance API v2 (hydrometrie/observations_tr) →
-- ~1500 stations France, débits en L/s natif. Cron 15min via orchestrator
-- (kind=http_json, parser=json_path extractPath=$.data, sink=pg_insert).
-- Rows avec code_station NULL (déclarés par Hub'eau pour certaines obs
-- temporaires) seront rejetés par la NOT NULL — la cycle status reste
-- 'partial' mais le reste continue.
CREATE TABLE IF NOT EXISTS hubeau_observations (
  ts             TIMESTAMPTZ NOT NULL,
  code_station   TEXT NOT NULL,
  lat            REAL,
  lon            REAL,
  debit_l_s      REAL,
  qualif         TEXT,
  source         TEXT NOT NULL DEFAULT 'hubeau-fr'
);
CREATE UNIQUE INDEX IF NOT EXISTS hubeau_obs_ts_station_uidx
  ON hubeau_observations (ts, code_station);
SELECT create_hypertable(
  'hubeau_observations', 'ts',
  chunk_time_interval => INTERVAL '7 days',
  if_not_exists => TRUE
);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM timescaledb_information.jobs
    WHERE proc_name = 'policy_retention' AND hypertable_name = 'hubeau_observations'
  ) THEN
    PERFORM add_retention_policy('hubeau_observations', INTERVAL '30 days');
  END IF;
END $$;

-- Vue dernière obs par station ≤2h. Débit converti en m³/s pour l'UI.
CREATE OR REPLACE VIEW v_hubeau_recent AS
SELECT DISTINCT ON (code_station)
  code_station,
  ts,
  EXTRACT(EPOCH FROM (now() - ts))::INTEGER AS age_seconds,
  debit_l_s,
  debit_l_s / 1000.0 AS debit_m3_s,
  qualif,
  ST_SetSRID(ST_MakePoint(lon, lat), 4326) AS geom
FROM hubeau_observations
WHERE ts > now() - INTERVAL '2 hours'
ORDER BY code_station, ts DESC;

INSERT INTO data_sources (
  name, kind, url, schedule_kind, schedule_expr,
  parser_kind, parser_config,
  sink_kind, sink_config, sink_label, bbox, enabled
) VALUES (
  'hubeau-debits-fr',
  'http_json',
  'https://hubeau.eaufrance.fr/api/v2/hydrometrie/observations_tr?grandeur_hydro=Q&size=2000&sort=desc',
  'cron',
  '*/15 * * * *',
  'json_path',
  '{"extractPath": "$.data[*]"}',
  'pg_insert',
  '{"table": "hubeau_observations", "onConflict": "(ts, code_station) DO NOTHING", "nullifyNonNumeric": ["latitude", "longitude", "resultat_obs"], "columns": {"date_obs": "ts", "code_station": "code_station", "latitude": "lat", "longitude": "lon", "resultat_obs": "debit_l_s", "libelle_qualification_obs": "qualif"}}',
  'PostGIS hubeau_observations (~500 stations FR par cycle)',
  '[-5,41,10,51.5]',
  true
)
ON CONFLICT (name) DO NOTHING;

-- ─── V2 Hydrologie #2 — Niveaux piézométriques Hub'eau (2026-05-12) ─
-- Source : Hub'eau API v1 niveaux_nappes/chroniques_tr → ~1500 piézomètres
-- France, niveau eau (m NGF) + profondeur nappe (m sous sol).
-- Cron 1h via orchestrator (piezo bouge slowly vs débit). Même pattern
-- que hubeau-debits-fr mais URL + colonnes différentes.
CREATE TABLE IF NOT EXISTS hubeau_piezo (
  ts                TIMESTAMPTZ NOT NULL,
  code_bss          TEXT NOT NULL,
  lat               REAL,
  lon               REAL,
  niveau_eau_ngf    REAL,   -- m NGF (Nivellement Général Français)
  profondeur_nappe  REAL,   -- m sous le sol (utile pour suivi)
  altitude_station  REAL,
  source            TEXT NOT NULL DEFAULT 'hubeau-piezo-fr'
);
CREATE UNIQUE INDEX IF NOT EXISTS hubeau_piezo_ts_bss_uidx
  ON hubeau_piezo (ts, code_bss);
SELECT create_hypertable(
  'hubeau_piezo', 'ts',
  chunk_time_interval => INTERVAL '30 days',
  if_not_exists => TRUE
);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM timescaledb_information.jobs
    WHERE proc_name = 'policy_retention' AND hypertable_name = 'hubeau_piezo'
  ) THEN
    PERFORM add_retention_policy('hubeau_piezo', INTERVAL '90 days');
  END IF;
END $$;

-- Vue : dernière obs par station ≤7j (piezo refresh lentement, parfois 1/jour).
CREATE OR REPLACE VIEW v_hubeau_piezo_recent AS
SELECT DISTINCT ON (code_bss)
  code_bss,
  ts,
  EXTRACT(EPOCH FROM (now() - ts))::INTEGER AS age_seconds,
  niveau_eau_ngf,
  profondeur_nappe,
  altitude_station,
  ST_SetSRID(ST_MakePoint(lon, lat), 4326) AS geom
FROM hubeau_piezo
WHERE ts > now() - INTERVAL '7 days'
ORDER BY code_bss, ts DESC;

INSERT INTO data_sources (
  name, kind, url, schedule_kind, schedule_expr,
  parser_kind, parser_config,
  sink_kind, sink_config, sink_label, bbox, enabled
) VALUES (
  'hubeau-piezo-fr',
  'http_json',
  'https://hubeau.eaufrance.fr/api/v1/niveaux_nappes/chroniques_tr?size=2000&sort=desc',
  'cron',
  '5 */1 * * *',
  'json_path',
  '{"extractPath": "$.data[*]"}',
  'pg_insert',
  '{"table": "hubeau_piezo", "onConflict": "(ts, code_bss) DO NOTHING", "columns": {"date_mesure": "ts", "code_bss": "code_bss", "latitude": "lat", "longitude": "lon", "niveau_eau_ngf": "niveau_eau_ngf", "profondeur_nappe": "profondeur_nappe", "altitude_station": "altitude_station"}}',
  -- NOTE 2026-05-12 : disabled par défaut. L''API Hub''eau v1
  -- niveaux_nappes/chroniques_tr ne supporte pas le "latest par station"
  -- via un simple bulk query — chaque page liste les obs d''UNE seule
  -- station triées par date. Pour avoir un overview, il faudra paginer
  -- par bbox ou par département. À reprendre dans un sprint dédié.
  'PostGIS hubeau_piezo — DISABLED (per-station pagination needed)',
  '[-5,41,10,51.5]',
  false
)
ON CONFLICT (name) DO NOTHING;

-- ─── V2 Observation #2 — Séismes USGS (orchestrator + DB, 2026-05-12) ─
-- Migration : on remplace le proxy NestJS cache-only par un vrai
-- pipeline orchestrator. Avantage : visibility dans data_jobs +
-- possibilité de navigation temporelle (à terme on supportera ts=NOW
-- vs ts=AT_TIME dans le endpoint).
--
-- Parser_kind geojson_features flatten les FeatureCollection USGS
-- (coords + properties) en records plats pour le pg_insert.
CREATE TABLE IF NOT EXISTS earthquakes (
  ts          TIMESTAMPTZ NOT NULL,
  id          TEXT NOT NULL,             -- USGS event id (eg "nc75359521")
  mag         REAL,
  place       TEXT,
  lat         REAL,
  lon         REAL,
  depth_km    REAL,
  alert       TEXT,                       -- green/yellow/orange/red ou NULL
  tsunami     INTEGER,                    -- 0|1
  sig         INTEGER,                    -- significance 0-1000
  url         TEXT,
  detail_url  TEXT,
  type        TEXT,                       -- earthquake / explosion / ...
  source      TEXT NOT NULL DEFAULT 'usgs'
);
CREATE UNIQUE INDEX IF NOT EXISTS earthquakes_id_ts_uidx
  ON earthquakes (id, ts);
SELECT create_hypertable(
  'earthquakes', 'ts',
  chunk_time_interval => INTERVAL '7 days',
  if_not_exists => TRUE
);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM timescaledb_information.jobs
    WHERE proc_name = 'policy_retention' AND hypertable_name = 'earthquakes'
  ) THEN
    PERFORM add_retention_policy('earthquakes', INTERVAL '90 days');
  END IF;
END $$;

-- Vue séismes 24h glissantes avec géom. À terme, l'endpoint
-- /api/earthquakes/recent?at=ISO pourra filtrer sur ts proche d'un
-- instant donné (navigation time slider).
CREATE OR REPLACE VIEW v_earthquakes_recent AS
SELECT
  id, ts,
  EXTRACT(EPOCH FROM (now() - ts))::INTEGER AS age_seconds,
  mag, place, depth_km, alert, tsunami, sig, url, detail_url, type,
  ST_SetSRID(ST_MakePoint(lon, lat), 4326) AS geom
FROM earthquakes
WHERE ts > now() - INTERVAL '24 hours'
ORDER BY ts DESC;

INSERT INTO data_sources (
  name, kind, url, schedule_kind, schedule_expr,
  parser_kind, parser_config,
  sink_kind, sink_config, sink_label, bbox, enabled
) VALUES (
  'usgs-earthquakes-day',
  'http_json',
  'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson',
  'cron',
  '*/5 * * * *',
  'geojson_features',
  '{"epochMsFields": ["time", "updated"]}',
  'pg_insert',
  '{"table": "earthquakes", "onConflict": "(id, ts) DO NOTHING", "columns": {"time": "ts", "id": "id", "mag": "mag", "place": "place", "lat": "lat", "lon": "lon", "depth": "depth_km", "alert": "alert", "tsunami": "tsunami", "sig": "sig", "url": "url", "detail": "detail_url", "type": "type"}}',
  'PostGIS earthquakes (USGS all_day feed)',
  '[-180,-90,180,90]',
  true
)
ON CONFLICT (name) DO NOTHING;

-- ─── V2 Observation #3 — Feux FIRMS NASA MODIS (2026-05-12) ─────────
-- Source : FIRMS NASA CSV public (pas de clé API), MODIS C6.1 NRT 24h.
-- ~3500 hotspots monde/24h, on bbox EU large → ~50-200 hotspots/cycle.
-- Cron 1h. Parser csv (nouveau kind) avec bboxFilter + compositeTime
-- pour combiner acq_date + acq_time (HHMM) → ts ISO.
CREATE TABLE IF NOT EXISTS firms_observations (
  ts          TIMESTAMPTZ NOT NULL,
  lat         REAL NOT NULL,
  lon         REAL NOT NULL,
  brightness  REAL,    -- K (température brillance)
  bright_t31  REAL,
  frp         REAL,    -- Fire Radiative Power (MW)
  confidence  INTEGER, -- 0-100
  satellite   TEXT,    -- T (Terra) ou A (Aqua)
  daynight    TEXT,    -- D ou N
  scan        REAL,
  track       REAL,
  source      TEXT NOT NULL DEFAULT 'firms-modis-c6.1'
);
CREATE UNIQUE INDEX IF NOT EXISTS firms_obs_ts_loc_uidx
  ON firms_observations (ts, lat, lon);
SELECT create_hypertable(
  'firms_observations', 'ts',
  chunk_time_interval => INTERVAL '7 days',
  if_not_exists => TRUE
);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM timescaledb_information.jobs
    WHERE proc_name = 'policy_retention' AND hypertable_name = 'firms_observations'
  ) THEN
    PERFORM add_retention_policy('firms_observations', INTERVAL '14 days');
  END IF;
END $$;

-- Vue 24h glissantes avec géom. À terme, l'endpoint /api/firms/recent?at=ISO
-- pourra filtrer pour navigation temporelle.
CREATE OR REPLACE VIEW v_firms_recent AS
SELECT
  ts,
  lat, lon, brightness, bright_t31, frp, confidence, satellite, daynight,
  EXTRACT(EPOCH FROM (now() - ts))::INTEGER AS age_seconds,
  ST_SetSRID(ST_MakePoint(lon, lat), 4326) AS geom
FROM firms_observations
WHERE ts > now() - INTERVAL '24 hours'
ORDER BY ts DESC;

INSERT INTO data_sources (
  name, kind, url, schedule_kind, schedule_expr,
  parser_kind, parser_config,
  sink_kind, sink_config, sink_label, bbox, enabled
) VALUES (
  'firms-modis-eu',
  'http_json',
  'https://firms.modaps.eosdis.nasa.gov/data/active_fire/modis-c6.1/csv/MODIS_C6_1_Global_24h.csv',
  'cron',
  '20 */1 * * *',
  'csv',
  '{"bboxFilter": true, "compositeTime": {"dateField": "acq_date", "timeField": "acq_time", "target": "ts"}}',
  'pg_insert',
  '{"table": "firms_observations", "onConflict": "(ts, lat, lon) DO NOTHING", "columns": {"ts": "ts", "latitude": "lat", "longitude": "lon", "brightness": "brightness", "bright_t31": "bright_t31", "frp": "frp", "confidence": "confidence", "satellite": "satellite", "daynight": "daynight", "scan": "scan", "track": "track"}}',
  'PostGIS firms_observations (~150 hotspots/cycle EU bbox)',
  '[-25,30,40,70]',
  true
)
ON CONFLICT (name) DO NOTHING;

-- ─── G66f (2026-05-27) — FIR/UIR airspaces (OpenAIP) ────────────────
-- Donnée quasi-statique (AIRAC 28j cycle). Refresh cron hebdo via
-- OpenAIPService.syncFromOpenAIP() — voir services/api/src/openaip/.
-- ~250 FIR + UIR mondiaux. Stockés en PostGIS Polygon/MultiPolygon
-- EPSG:4326 pour permettre des ST_Contains() futurs (ex: "quelle FIR
-- contient ce navire"). Pas un hypertable (non time-series).
CREATE TABLE IF NOT EXISTS fir_airspaces (
  openaip_id     TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  country        TEXT,
  icao_class     TEXT,
  type           TEXT NOT NULL,             -- 'FIR' ou 'UIR'
  upper_limit_ft INTEGER,
  lower_limit_ft INTEGER,
  activity       TEXT,
  on_demand      BOOLEAN,
  geom           GEOMETRY(Geometry, 4326) NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fir_airspaces_geom_gidx
  ON fir_airspaces USING GIST (geom);
CREATE INDEX IF NOT EXISTS fir_airspaces_type_idx
  ON fir_airspaces (type);

-- ─── G66l (2026-05-27) — Airports OpenAIP (IATA commerciaux) ────────
-- Donnée quasi-statique. Sync cron hebdo via OpenAIPService.syncAirports().
-- Filter : iataCode != null (≈9000 commerciaux mondiaux). PostGIS Point
-- EPSG:4326 + GIST pour bbox queries futures + cluster MapLibre côté front.
CREATE TABLE IF NOT EXISTS airports (
  openaip_id   TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  icao_code    TEXT,
  iata_code    TEXT,
  country      TEXT,
  type         INTEGER,        -- code type OpenAIP (3=intl, 9=IFR, etc.)
  elevation_ft INTEGER,
  geom         GEOMETRY(Point, 4326) NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS airports_geom_gidx
  ON airports USING GIST (geom);
CREATE INDEX IF NOT EXISTS airports_iata_idx
  ON airports (iata_code);

-- ─── APEX Satellites Phase 4 (2026-05-19) — NASA GIBS via GeoServer ─
-- Refacto Phase 4 : on bascule du sink file_save (nginx static) vers le
-- pattern canonique grib-parser sidecar + ImageMosaic GeoServer.
--
-- 7 produits satellite NASA GIBS (WMTS public, license PD). Chaque source
-- demande à grib-parser de fetcher l'image WMS au FORMAT image/tiff
-- (GeoTIFF avec EPSG:4326 baked-in), de la déposer dans
-- /coverage/sat-<product>/sat-<product>_YYYYMMDD'T'HHMMSSZ.tif, et de
-- créer/reindexer la coverage aetherwx:sat-<product> dans GeoServer.
-- Le frontend consomme via WMS standard, comme SST/wind/waves.
INSERT INTO data_sources (
  name, kind, url, schedule_kind, schedule_expr,
  parser_kind, parser_config,
  sink_kind, sink_config, sink_label, bbox, enabled
) VALUES
  ('satellite-modis-true-color',
   'http_satellite',
   'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.1.1&LAYERS=MODIS_Terra_CorrectedReflectance_TrueColor&TIME={date}&BBOX=-25,30,40,70&SRS=EPSG:4326&WIDTH=2600&HEIGHT=1600&FORMAT=image/tiff',
   'cron', '30 3 * * *',
   'sat_geotiff', NULL,
   'geotiff_volume',
   '{"output_dir": "/coverage/sat-modis-true-color", "output_prefix": "sat-modis-true-color", "geoserver_create_if_missing": true, "geoserver_workspace": "aetherwx", "geoserver_store": "sat-modis-true-color", "geoserver_coverage": "sat-modis-true-color", "geoserver_title": "Satellite MODIS Terra True Color (NASA GIBS)"}',
   '/coverage/sat-modis-true-color/ + aetherwx:sat-modis-true-color WMS',
   '[-25,30,40,70]', false),
  ('satellite-viirs-true-color',
   'http_satellite',
   'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.1.1&LAYERS=VIIRS_SNPP_CorrectedReflectance_TrueColor&TIME={date}&BBOX=-25,30,40,70&SRS=EPSG:4326&WIDTH=2600&HEIGHT=1600&FORMAT=image/tiff',
   'cron', '35 3 * * *',
   'sat_geotiff', NULL,
   'geotiff_volume',
   '{"output_dir": "/coverage/sat-viirs-true-color", "output_prefix": "sat-viirs-true-color", "geoserver_create_if_missing": true, "geoserver_workspace": "aetherwx", "geoserver_store": "sat-viirs-true-color", "geoserver_coverage": "sat-viirs-true-color", "geoserver_title": "Satellite VIIRS SNPP True Color (NASA GIBS)"}',
   '/coverage/sat-viirs-true-color/ + aetherwx:sat-viirs-true-color WMS',
   '[-25,30,40,70]', false),
  ('satellite-modis-ir',
   'http_satellite',
   'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.1.1&LAYERS=MODIS_Terra_Brightness_Temp_Band31_Day&TIME={date}&BBOX=-25,30,40,70&SRS=EPSG:4326&WIDTH=2048&HEIGHT=1260&FORMAT=image/tiff',
   'cron', '40 3 * * *',
   'sat_geotiff', NULL,
   'geotiff_volume',
   '{"output_dir": "/coverage/sat-modis-ir", "output_prefix": "sat-modis-ir", "geoserver_create_if_missing": true, "geoserver_workspace": "aetherwx", "geoserver_store": "sat-modis-ir", "geoserver_coverage": "sat-modis-ir", "geoserver_title": "Satellite MODIS IR Brightness Temp band 31"}',
   '/coverage/sat-modis-ir/ + aetherwx:sat-modis-ir WMS',
   '[-25,30,40,70]', false),
  ('satellite-airs-air-temp',
   'http_satellite',
   'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.1.1&LAYERS=AIRS_L2_Surface_Air_Temperature_Day&TIME={date}&BBOX=-25,30,40,70&SRS=EPSG:4326&WIDTH=1300&HEIGHT=800&FORMAT=image/tiff',
   'cron', '45 3 * * *',
   'sat_geotiff', NULL,
   'geotiff_volume',
   '{"output_dir": "/coverage/sat-airs-air-temp", "output_prefix": "sat-airs-air-temp", "geoserver_create_if_missing": true, "geoserver_workspace": "aetherwx", "geoserver_store": "sat-airs-air-temp", "geoserver_coverage": "sat-airs-air-temp", "geoserver_title": "Satellite AIRS Surface Air Temperature"}',
   '/coverage/sat-airs-air-temp/ + aetherwx:sat-airs-air-temp WMS',
   '[-25,30,40,70]', false),
  ('satellite-modis-cloud-top',
   'http_satellite',
   'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.1.1&LAYERS=MODIS_Terra_Cloud_Top_Pressure_Day&TIME={date}&BBOX=-25,30,40,70&SRS=EPSG:4326&WIDTH=1300&HEIGHT=800&FORMAT=image/tiff',
   'cron', '50 3 * * *',
   'sat_geotiff', NULL,
   'geotiff_volume',
   '{"output_dir": "/coverage/sat-modis-cloud-top", "output_prefix": "sat-modis-cloud-top", "geoserver_create_if_missing": true, "geoserver_workspace": "aetherwx", "geoserver_store": "sat-modis-cloud-top", "geoserver_coverage": "sat-modis-cloud-top", "geoserver_title": "Satellite MODIS Cloud Top Pressure"}',
   '/coverage/sat-modis-cloud-top/ + aetherwx:sat-modis-cloud-top WMS',
   '[-25,30,40,70]', false),
  ('satellite-modis-aerosol',
   'http_satellite',
   'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.1.1&LAYERS=MODIS_Combined_Value_Added_AOD&TIME={date}&BBOX=-25,30,40,70&SRS=EPSG:4326&WIDTH=1300&HEIGHT=800&FORMAT=image/tiff',
   'cron', '55 3 * * *',
   'sat_geotiff', NULL,
   'geotiff_volume',
   '{"output_dir": "/coverage/sat-modis-aerosol", "output_prefix": "sat-modis-aerosol", "geoserver_create_if_missing": true, "geoserver_workspace": "aetherwx", "geoserver_store": "sat-modis-aerosol", "geoserver_coverage": "sat-modis-aerosol", "geoserver_title": "Satellite MODIS Aerosol Optical Depth"}',
   '/coverage/sat-modis-aerosol/ + aetherwx:sat-modis-aerosol WMS',
   '[-25,30,40,70]', false),
  ('satellite-viirs-day-night',
   'http_satellite',
   'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.1.1&LAYERS=VIIRS_SNPP_DayNightBand_ENCC&TIME={date}&BBOX=-25,30,40,70&SRS=EPSG:4326&WIDTH=2048&HEIGHT=1260&FORMAT=image/tiff',
   'cron', '0 4 * * *',
   'sat_geotiff', NULL,
   'geotiff_volume',
   '{"output_dir": "/coverage/sat-viirs-day-night", "output_prefix": "sat-viirs-day-night", "geoserver_create_if_missing": true, "geoserver_workspace": "aetherwx", "geoserver_store": "sat-viirs-day-night", "geoserver_coverage": "sat-viirs-day-night", "geoserver_title": "Satellite VIIRS Day/Night Band"}',
   '/coverage/sat-viirs-day-night/ + aetherwx:sat-viirs-day-night WMS',
   '[-25,30,40,70]', false)
ON CONFLICT (name) DO UPDATE SET
  kind = EXCLUDED.kind,
  url = EXCLUDED.url,
  parser_kind = EXCLUDED.parser_kind,
  sink_kind = EXCLUDED.sink_kind,
  sink_config = EXCLUDED.sink_config,
  sink_label = EXCLUDED.sink_label;

-- ─── Configurations de carte nommées (2026-06-17) ──────────────────
-- Snapshot autonome de l'état du globe (layers/opacités/contours/z-index/
-- master temps/vue) en JSONB. 1 config par (user_id, name). FK cascade
-- sur users → suppression user purge ses configs.
CREATE TABLE IF NOT EXISTS map_configurations (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  snapshot    JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS map_configurations_user_name_idx
  ON map_configurations (user_id, name);

-- ─── Dashboards (2026-06-18) ───────────────────────────────────────
-- Agencements de widgets. Privé par défaut, public sur demande du
-- propriétaire, UN seul défaut global (index partiel unique). FK cascade
-- sur users. widgets = JSONB array (snapshot inline par widget map).
CREATE TABLE IF NOT EXISTS dashboards (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  is_public   BOOLEAN NOT NULL DEFAULT FALSE,
  is_default  BOOLEAN NOT NULL DEFAULT FALSE,
  widgets     JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Au plus UN dashboard par défaut sur toute la base.
CREATE UNIQUE INDEX IF NOT EXISTS dashboards_single_default_idx
  ON dashboards (is_default) WHERE is_default;
CREATE INDEX IF NOT EXISTS dashboards_user_idx ON dashboards (user_id);
CREATE INDEX IF NOT EXISTS dashboards_public_idx ON dashboards (is_public) WHERE is_public;
`;

export async function runMigrations(databaseUrl: string): Promise<void> {
  const client = postgres(databaseUrl, { max: 1, connect_timeout: 10 });
  try {
    await client.unsafe(SCHEMA_SQL);
  } finally {
    await client.end({ timeout: 5 });
  }
}

if (require.main === module) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL required');
    process.exit(1);
  }
  runMigrations(url).then(() => {
    console.log('Migrations OK');
    process.exit(0);
  }).catch((err) => {
    console.error('Migrations failed:', err);
    process.exit(1);
  });
}
