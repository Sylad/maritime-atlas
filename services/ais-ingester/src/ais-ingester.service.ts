import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import WebSocket from 'ws';
import { RabbitMqService } from './rabbitmq.service';

/**
 * Connecte à aisstream.io WebSocket avec subscription bbox-filtrée.
 *
 * aisstream.io expose un free-tier WebSocket : tu envoies en premier
 * message un JSON de subscription avec ton API key + une bounding box,
 * puis tu reçois ensuite tous les messages AIS (PositionReport,
 * StaticDataReport, etc.) qui matchent.
 *
 * Reference protocole : https://aisstream.io/documentation
 *
 * On publish chaque message brut sur l'exchange `ais.raw` avec routing
 * key `position` ou `static`. Le ais-decoder consume et fait l'INSERT
 * PostGIS + UPSERT vessels.
 */
@Injectable()
export class AisIngesterService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AisIngesterService.name);
  private ws?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private msgCount = 0;
  private statsInterval?: NodeJS.Timeout;

  constructor(
    private readonly config: ConfigService,
    private readonly rabbit: RabbitMqService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.connect();
    // Stats log toutes les 60s
    this.statsInterval = setInterval(() => {
      if (this.msgCount > 0) {
        this.logger.log(`Throughput: ${this.msgCount} msg/min`);
        this.msgCount = 0;
      }
    }, 60_000);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.statsInterval) clearInterval(this.statsInterval);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  private connect(): void {
    const apiKey = this.config.get<string>('AISSTREAM_API_KEY');
    if (!apiKey || apiKey === 'your-api-key-here') {
      this.logger.error('AISSTREAM_API_KEY not set — get a free key at https://aisstream.io and update .env');
      return;
    }

    // Defaults Europe étroite (sprint Europe 2026-05-12). Override via
    // AIS_BBOX_* env vars dans .env si besoin de zoom local.
    const swLat = parseFloat(this.config.get<string>('AIS_BBOX_SW_LAT') ?? '35.0');
    const swLon = parseFloat(this.config.get<string>('AIS_BBOX_SW_LON') ?? '-15.0');
    const neLat = parseFloat(this.config.get<string>('AIS_BBOX_NE_LAT') ?? '65.0');
    const neLon = parseFloat(this.config.get<string>('AIS_BBOX_NE_LON') ?? '30.0');

    this.logger.log(`Connecting to aisstream.io with bbox SW=(${swLat},${swLon}) NE=(${neLat},${neLon})`);
    this.ws = new WebSocket('wss://stream.aisstream.io/v0/stream');

    this.ws.on('open', () => {
      this.logger.log('WebSocket connected, sending subscription');
      const subscription = {
        APIKey: apiKey,
        BoundingBoxes: [[[swLat, swLon], [neLat, neLon]]],
        // Si on veut filtrer par type de message :
        // FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
      };
      this.ws?.send(JSON.stringify(subscription));
    });

    this.ws.on('message', (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        const messageType = data.MessageType;
        if (!messageType) return;

        // Routing key par type de message → permet aux consumers de
        // se binder sélectivement (decoder veut tout, futur dashboard
        // veut juste positions).
        const routingKey = messageType === 'PositionReport' ? 'position'
          : messageType === 'ShipStaticData' ? 'static'
          : 'other';

        this.rabbit.publish('ais.raw', routingKey, data);
        this.msgCount++;
      } catch (err) {
        this.logger.warn(`Failed to process message: ${(err as Error).message}`);
      }
    });

    this.ws.on('error', (err) => {
      this.logger.error(`WebSocket error: ${err.message}`);
    });

    this.ws.on('close', (code, reason) => {
      this.logger.warn(`WebSocket closed (code=${code}, reason=${reason}) — reconnecting in 5s`);
      this.reconnectTimer = setTimeout(() => this.connect(), 5000);
    });
  }
}
