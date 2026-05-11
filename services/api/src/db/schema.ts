import { pgTable, serial, text, integer, timestamp, real, jsonb, primaryKey, uniqueIndex } from 'drizzle-orm/pg-core';

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
