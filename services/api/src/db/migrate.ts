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
  ('lightning-fetcher',  'websocket',  'wss://ws1.blitzortung.org/',                   'continu (WSS)',
   'PostGIS lightning_strikes + RMQ lightning.strike',                                  '[-15,35,30,65]'),
  ('buoy-fetcher',       'http_wfs',   'https://geoserver.emodnet-physics.eu/geoserver/emodnet/ows', 'cron 1×/jour',
   'PostGIS buoys',                                                                     '[-15,35,30,65]'),
  ('track-builder',      'sql_aggregate', 'PostGIS vessel_positions',                  'cron xx:35 chaque heure',
   'PostGIS vessel_tracks_daily (LineString par mmsi/day)',                            '[-15,35,30,65]')
ON CONFLICT (name) DO NOTHING;
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
