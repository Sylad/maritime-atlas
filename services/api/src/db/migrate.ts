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

-- ─── Sprint Auth refonte : colonnes additionnelles users ───
ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_token TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_token_expires_at TIMESTAMPTZ;

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
