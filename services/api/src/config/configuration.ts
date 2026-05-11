/**
 * Pattern factorisé depuis finance-tracker/backend/src/config/configuration.ts.
 * Fail-closed en production : si JWT_SECRET ou DATABASE_URL absent, le boot
 * jette à main.ts.
 */
const configuration = () => ({
  port: parseInt(process.env.PORT ?? '3010', 10),
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:4204',
  databaseUrl: process.env.DATABASE_URL ?? '',
  jwtSecret: process.env.JWT_SECRET ?? '',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '24h',
  geoserverUrl: process.env.GEOSERVER_URL ?? 'http://geoserver:8080/geoserver',
  geoserverUser: process.env.GEOSERVER_ADMIN_USER ?? 'admin',
  geoserverPass: process.env.GEOSERVER_ADMIN_PASSWORD ?? 'geoserver',
  geoserverWorkspace: process.env.GEOSERVER_WORKSPACE ?? 'maritime',
  nodeEnv: process.env.NODE_ENV ?? 'development',
  paletteLimit: parseInt(process.env.PALETTE_LIMIT_PER_USER ?? '5', 10),
  // ─── Sprint Auth refonte ───
  /** Email du compte admin seed. Si déjà en DB, on le promote en admin
      idempotent. Si pas en DB et ADMIN_PASSWORD set, on le crée. */
  adminEmail: process.env.ADMIN_EMAIL ?? 'sylvain.ladoire@gmail.com',
  adminUsername: process.env.ADMIN_USERNAME ?? 'sylvain',
  adminPassword: process.env.ADMIN_PASSWORD ?? '',
  /** Base URL publique pour les liens de vérification email. Utilisée
      par Resend en Phase 2 → https://maritime.sladoire.dev/auth/verify?token=... */
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'http://localhost:4204',
  /** Resend (Phase 2). Si vide, register échoue avant d'écrire en DB
      pour éviter les comptes orphelins sans mail de vérif. */
  resendApiKey: process.env.RESEND_API_KEY ?? '',
  resendFromEmail: process.env.RESEND_FROM_EMAIL ?? 'noreply@sladoire.dev',
  // ─── Cron dormants (Phase 4) ───
  /** Seuil après lequel un user sans connexion récente est supprimé. */
  dormantAfterDays: parseInt(process.env.DORMANT_AFTER_DAYS ?? '90', 10),
  /** Audit avant prod : true = log les candidats sans supprimer. */
  dormantDryRun: (process.env.DORMANT_DRY_RUN ?? 'false').toLowerCase() === 'true',
  // ─── Google OAuth (sprint Auth refonte — Phase 3.5) ───
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
  /** URL de retour Google après l'auth. Doit être whitelist côté Google
      Cloud Console "Identifiants" → "ID client OAuth" → URI de redirection. */
  googleCallbackUrl: process.env.GOOGLE_CALLBACK_URL ?? 'http://localhost:4204/api/auth/google/callback',
});

export default configuration;
export type Configuration = ReturnType<typeof configuration>;
