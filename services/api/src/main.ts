import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger, ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { runMigrations } from './db/migrate';

async function bootstrap() {
  const log = new Logger('main');

  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  // Trust nginx front-proxy : sans ça req.protocol retourne 'http' (lien
  // interne nas→api) et le callback Google fait du `http://...` alors que
  // le user vient en HTTPS via maritime.sladoire.dev. Avec trust proxy,
  // req.protocol respecte X-Forwarded-Proto et req.hostname respecte Host.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  const config = app.get(ConfigService);

  // Fail-closed en prod sur les secrets critiques.
  const jwtSecret = config.get<string>('jwtSecret');
  const databaseUrl = config.get<string>('databaseUrl');
  if (config.get<string>('nodeEnv') === 'production') {
    if (!jwtSecret) throw new Error('JWT_SECRET required in production');
    if (!databaseUrl) throw new Error('DATABASE_URL required in production');
  }

  // Migrations Drizzle au boot — idempotent. En dev permet de partir d'une
  // DB vierge sans avoir à lancer un script séparé.
  if (databaseUrl) {
    try {
      await runMigrations(databaseUrl);
      log.log('DB migrations applied');
    } catch (err) {
      log.error(`DB migrations failed: ${(err as Error).message}`);
      throw err;
    }
  }

  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }));

  const corsOrigin = config.get<string>('corsOrigin');
  app.enableCors({
    origin: corsOrigin === '*' ? true : (corsOrigin?.split(',').map((s) => s.trim()) ?? false),
    credentials: true,
  });

  const port = config.get<number>('port') ?? 3010;
  await app.listen(port, '0.0.0.0');
  log.log(`maritime-api listening on :${port}`);
}

bootstrap().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
