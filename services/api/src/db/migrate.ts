/**
 * Migrations Drizzle au boot. Approche pragmatique pour un service jeune :
 * on génère les CREATE TABLE en SQL inline plutôt que de packager le dossier
 * drizzle/ via drizzle-kit. Quand le projet grossit, basculer sur
 * drizzle-kit + dossier `drizzle/` mounté côté image.
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
