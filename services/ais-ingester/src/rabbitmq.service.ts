import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqplib';

/**
 * Connexion AMQP partagée + helpers publish/consume.
 *
 * Pattern : on déclare les exchanges au boot (idempotent côté RabbitMQ),
 * et on garde un channel ouvert pour la durée de vie du process.
 * Reconnect automatique si la connexion meurt (RabbitMQ restart, etc.).
 */
@Injectable()
export class RabbitMqService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RabbitMqService.name);
  private connection?: amqp.ChannelModel;
  private channel?: amqp.Channel;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    await this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.channel?.close();
      await this.connection?.close();
    } catch (err) {
      this.logger.warn(`Error closing AMQP: ${(err as Error).message}`);
    }
  }

  private async connect(): Promise<void> {
    const url = this.config.get<string>('RABBITMQ_URL') ?? 'amqp://maritime:maritime@rabbitmq:5672';
    let attempt = 0;
    while (true) {
      try {
        this.connection = await amqp.connect(url);
        this.channel = await this.connection.createChannel();
        // Exchanges déclarés une fois au boot.
        await this.channel.assertExchange('ais.raw', 'direct', { durable: true });
        await this.channel.assertExchange('ais.positions', 'topic', { durable: true });
        await this.channel.assertExchange('raster.ready', 'fanout', { durable: true });
        await this.channel.assertExchange('alerts', 'topic', { durable: true });
        await this.channel.assertExchange('geoserver.sync', 'fanout', { durable: true });

        this.connection.on('error', (err) => {
          this.logger.error(`AMQP connection error: ${err.message}`);
        });
        this.connection.on('close', () => {
          this.logger.warn('AMQP connection closed, reconnecting in 5s…');
          setTimeout(() => this.connect(), 5000);
        });

        this.logger.log(`AMQP connected to ${url.replace(/\/\/[^@]+@/, '//***@')}`);
        return;
      } catch (err) {
        attempt++;
        const delay = Math.min(30000, 1000 * 2 ** attempt);
        this.logger.warn(`AMQP connect failed (${(err as Error).message}), retry in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  /**
   * Publish JSON sur un exchange avec routing key. Persistent=true pour
   * que les messages survivent à un restart RabbitMQ.
   */
  publish(exchange: string, routingKey: string, payload: unknown): boolean {
    if (!this.channel) {
      this.logger.warn('AMQP channel not ready, dropping message');
      return false;
    }
    const buffer = Buffer.from(JSON.stringify(payload));
    return this.channel.publish(exchange, routingKey, buffer, { persistent: true, contentType: 'application/json' });
  }
}
