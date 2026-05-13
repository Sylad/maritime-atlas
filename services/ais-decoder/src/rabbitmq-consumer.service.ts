import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqplib';

type MessageHandler = (data: unknown, routingKey: string) => Promise<void>;

/**
 * Consumer AMQP avec reconnection auto. Bind sur l'exchange `ais.raw`
 * via une queue dédiée par service. Le message handler est une callback
 * fournie par AisDecoderService.
 *
 * Le pattern channel.prefetch(50) limite le batch en flight pour éviter
 * de saturer le PG pool si les INSERTs sont lents.
 */
@Injectable()
export class RabbitMqConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RabbitMqConsumer.name);
  private connection?: amqp.ChannelModel;
  private channel?: amqp.Channel;
  private handler?: MessageHandler;

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

  setHandler(handler: MessageHandler): void {
    this.handler = handler;
  }

  /** Permet à AisDecoderService de publish des messages enrichis sur ais.positions. */
  publish(exchange: string, routingKey: string, payload: unknown): boolean {
    if (!this.channel) return false;
    const buf = Buffer.from(JSON.stringify(payload));
    return this.channel.publish(exchange, routingKey, buf, { persistent: true, contentType: 'application/json' });
  }

  private async connect(): Promise<void> {
    const url = this.config.get<string>('RABBITMQ_URL') ?? 'amqp://maritime:maritime@rabbitmq:5672';
    let attempt = 0;
    while (true) {
      try {
        this.connection = await amqp.connect(url);
        this.channel = await this.connection.createChannel();
        // prefetch=200 (V2 2026-05-13) : avec batch INSERT 100 par decoder,
        // le pipeline RMQ→Batch→DB→Ack→RMQ a besoin de plus de messages en
        // flight pour ne pas idle entre 2 batches. Avant : prefetch=50 →
        // saturé immédiatement → 133/s cumulé sur 5 decoders. Après : ~300+/s.
        await this.channel.prefetch(200);

        // Idempotent declarations (l'ingester les déclare aussi)
        await this.channel.assertExchange('ais.raw', 'direct', { durable: true });
        await this.channel.assertExchange('ais.positions', 'topic', { durable: true });

        // Queue durable propre au decoder
        const q = await this.channel.assertQueue('ais.decoder', { durable: true });
        // Bind toutes les routing keys de ais.raw
        await this.channel.bindQueue(q.queue, 'ais.raw', 'position');
        await this.channel.bindQueue(q.queue, 'ais.raw', 'static');

        this.channel.consume(q.queue, async (msg) => {
          if (!msg) return;
          try {
            const data = JSON.parse(msg.content.toString());
            if (this.handler) await this.handler(data, msg.fields.routingKey);
            this.channel?.ack(msg);
          } catch (err) {
            this.logger.warn(`Handler error: ${(err as Error).message}`);
            // requeue=false pour éviter loop sur message invalide
            this.channel?.nack(msg, false, false);
          }
        });

        this.connection.on('close', () => {
          this.logger.warn('AMQP connection closed, reconnecting in 5s…');
          setTimeout(() => this.connect(), 5000);
        });
        this.logger.log(`AMQP consumer ready on queue ais.decoder`);
        return;
      } catch (err) {
        attempt++;
        const delay = Math.min(30000, 1000 * 2 ** attempt);
        this.logger.warn(`AMQP connect failed (${(err as Error).message}), retry in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
}
