import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';

/**
 * ais-ingester — connecte à aisstream.io WebSocket, filtre par bbox
 * Bretagne+Gascogne, et publish les messages JSON bruts sur l'exchange
 * RabbitMQ `ais.raw`.
 *
 * Pas de serveur HTTP : c'est un worker headless qui tourne en boucle.
 */
async function bootstrap() {
  const logger = new Logger('Bootstrap');
  // createApplicationContext = pas de HTTP, juste le DI container.
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  // Graceful shutdown : ferme la WS et la connexion AMQP avant exit.
  const shutdown = async (signal: string) => {
    logger.log(`Received ${signal}, shutting down…`);
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  logger.log('ais-ingester started');
}
bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Bootstrap failed:', err);
  process.exit(1);
});
