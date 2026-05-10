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
});

export default configuration;
export type Configuration = ReturnType<typeof configuration>;
