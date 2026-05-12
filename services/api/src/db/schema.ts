import { pgTable, serial, text, integer, timestamp, real, jsonb, boolean, primaryKey, uniqueIndex, bigserial } from 'drizzle-orm/pg-core';

/**
 * 3 tables only. Schéma volontairement isolé du schéma TimescaleDB
 * existant (vessels, vessel_positions, etc.) — aucun FK croisé.
 *
 * Sprint Auth refonte (2026-05-11) : ajout username (unique, lowercase),
 * role ('user' | 'admin'), email_verified_at, last_login_at, verification_*.
 */

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull(),
  /** Lowercased, 3-30 chars, [a-z0-9_-]. Unique. Sert au login en alternative
      à l'email. Pour les users pré-refonte, backfill = email local-part. */
  username: text('username').notNull(),
  passwordHash: text('password_hash').notNull(),
  /** 'user' (défaut) ou 'admin'. Promoted via UI admin ou seed initial. */
  role: text('role').notNull().default('user'),
  /** NULL = pas encore vérifié → login refusé (fail-closed). Pre-refonte
      users sont backfill avec now() pour ne pas casser leur accès. */
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  /** Mis à jour à chaque login réussi. Sert au cron de suppression
      des dormants 3 mois (Phase 4). */
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  /** Token UUID v4 généré au register, envoyé par mail Resend (Phase 2). */
  verificationToken: text('verification_token'),
  verificationTokenExpiresAt: timestamp('verification_token_expires_at', { withTimezone: true }),
  /** Token UUID v4 pour reset password — envoyé par mail Resend.
      Phase B Auth refonte (2026-05-11). TTL 1h. */
  passwordResetToken: text('password_reset_token'),
  passwordResetExpiresAt: timestamp('password_reset_expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  emailIdx: uniqueIndex('users_email_idx').on(t.email),
  usernameIdx: uniqueIndex('users_username_idx').on(t.username),
}));

/**
 * `layer_kind` ∈ { 'sst', 'wind', 'waves', 'wave-dir' }. Validation côté
 * service (pas de CHECK constraint pour rester portable). 1 palette par
 * (user_id, slug) pour permettre 5 palettes par user — slug dérivé du nom.
 */
export const palettes = pgTable('palettes', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  layerKind: text('layer_kind').notNull(),
  // stops = JSON array of { quantity: number, color: string, opacity: number, label?: string }
  stops: jsonb('stops').notNull(),
  opacity: real('opacity').notNull().default(0.7),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  userSlugIdx: uniqueIndex('palettes_user_slug_idx').on(t.userId, t.slug),
}));

export const userLayerPreferences = pgTable('user_layer_preferences', {
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  layerKind: text('layer_kind').notNull(),
  paletteId: integer('palette_id').references(() => palettes.id, { onDelete: 'set null' }),
  /** Phase C UX V2 : state per layer pour TOUTES les layers (pas juste rasters).
      NULL = défaut app (cf. DEFAULT_VISIBILITY/OPACITIES côté frontend). */
  visible: boolean('visible'),
  opacity: real('opacity'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.layerKind] }),
}));

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Palette = typeof palettes.$inferSelect;
export type NewPalette = typeof palettes.$inferInsert;
export type UserLayerPref = typeof userLayerPreferences.$inferSelect;

/** Stop d'une palette user (élément de `palettes.stops`). */
export interface PaletteStop {
  quantity: number;
  color: string;     // hex #rrggbb
  opacity: number;   // 0..1
  label?: string;
}

export const VALID_LAYER_KINDS = ['sst', 'wind', 'waves', 'wave-dir'] as const;
export type LayerKind = typeof VALID_LAYER_KINDS[number];

export const VALID_ROLES = ['user', 'admin'] as const;
export type Role = typeof VALID_ROLES[number];

/**
 * Data Orchestrator MVP Sprint 1 (2026-05-12) — visibility-only.
 *
 * Référentiel des sources de données ingérées. À ce stade aucune
 * exécution dynamique : on liste les 6 services existants seed manuel
 * (ais-ingester, ais-decoder, sst-fetcher, weather-fetcher,
 * weather-fetcher-arpege, lightning-fetcher, buoy-fetcher) et chaque
 * cycle POST `/admin/jobs/log` un récap d'exécution.
 *
 * Les colonnes `parser_kind/sink_kind/etc.` sont snapshotées dès maintenant
 * pour préparer les Sprints 2-7 (exécution dynamique) — `enabled=false`
 * par défaut signifie "le row sert juste de référentiel pour les logs,
 * pas d'orchestration auto".
 */
export const dataSources = pgTable('data_sources', {
  id: serial('id').primaryKey(),
  /** Identifiant slug-style, ex: 'sst-fetcher'. UNIQUE. */
  name: text('name').notNull(),
  /** Catégorie : 'http_json', 'http_grib', 'websocket', 'sql_view'. Sert
   *  au futur dispatcher de stratégie d'exécution. */
  kind: text('kind').notNull(),
  /** URL source. Informatif en MVP (le service tape déjà l'URL en dur). */
  url: text('url'),
  /** Fréquence informative : 'cron 02:30 / 08:30 / …' ou 'continu WS'. */
  scheduleExpr: text('schedule_expr'),
  /** Nom du sink (PostGIS table cible, ou volume coverage). Informatif. */
  sinkLabel: text('sink_label'),
  /** Bbox cible (cohérence avec sprint Europe — informatif). */
  bbox: text('bbox'),
  /** Activé pour orchestration auto. */
  enabled: boolean('enabled').notNull().default(false),
  /** Mis à jour à chaque reportJob() reçu. NULL = jamais reporté. */
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  /** Dernier status reçu via reportJob() : 'ok' | 'partial' | 'error'. */
  lastStatus: text('last_status'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  // ─── Sprint N2 : exécution dynamique ──────────────────────────────
  /** 'cron' (expr cron 6-fields), 'interval' (interval_seconds), 'once'
   *  (déclenché manuellement uniquement). NULL = legacy seed (les
   *  ingesters historiques continuent à se scheduler eux-mêmes). */
  scheduleKind: text('schedule_kind'),
  /** Pour scheduleKind='interval' : nombre de secondes entre runs. */
  intervalSeconds: integer('interval_seconds'),
  /** HTTP method (GET, POST, …) pour kind='http_json'. */
  httpMethod: text('http_method').default('GET'),
  /** Headers HTTP additionnels (JSON objet). */
  httpHeaders: jsonb('http_headers'),
  /** Query params (JSON objet, encodé safe). */
  httpParams: jsonb('http_params'),
  /** Parser kind : 'identity' (pass-through), 'json_path' (extract via
   *  jq-like path), 'grib' (sidecar Python — N4+). */
  parserKind: text('parser_kind').default('identity'),
  /** Config parser : pour 'json_path', { extractPath: '$.features[*]' }. */
  parserConfig: jsonb('parser_config'),
  /** Sink kind : 'pg_insert' (table + columns), 'rmq_publish' (exchange
   *  + routing), 'geotiff_volume' (N4+). */
  sinkKind: text('sink_kind').default('rmq_publish'),
  /** Config sink : pour 'pg_insert', { table, columns: { sourceKey: dbColumn } }
   *  ; pour 'rmq_publish', { exchange, routingKey }. */
  sinkConfig: jsonb('sink_config'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  nameIdx: uniqueIndex('data_sources_name_idx').on(t.name),
}));

/**
 * Hypertable historique des exécutions des sources. PK composite
 * `(started_at, id)` obligatoire en hypertable + serial (cf. memory
 * `timescale_hypertable_serial_pk.md`).
 *
 * Drizzle ne sait pas exprimer `SELECT create_hypertable()` — la
 * conversion en hypertable est faite côté `migrate.ts` SQL inline.
 */
export const dataJobs = pgTable('data_jobs', {
  id: bigserial('id', { mode: 'number' }).notNull(),
  /** FK logique vers data_sources.name (pas FK SQL pour éviter le
   *  coupling lors des truncate / migration). */
  sourceName: text('source_name').notNull(),
  status: text('status').notNull(), // 'ok' | 'partial' | 'error'
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  durationMs: integer('duration_ms'),
  recordsIn: integer('records_in'),
  recordsOut: integer('records_out'),
  bytesIn: integer('bytes_in'),
  errorKind: text('error_kind'),
  errorMsg: text('error_msg'),
  /** JSON libre pour metadata parser-specific (run_iso, bundle keys, etc.). */
  meta: jsonb('meta'),
}, (t) => ({
  pk: primaryKey({ columns: [t.startedAt, t.id] }),
}));

export type DataSource = typeof dataSources.$inferSelect;
export type DataJob = typeof dataJobs.$inferSelect;

export const VALID_JOB_STATUS = ['ok', 'partial', 'error'] as const;
export type JobStatus = typeof VALID_JOB_STATUS[number];
