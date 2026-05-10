import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PgService } from './pg.service';
import { RabbitMqConsumer } from './rabbitmq-consumer.service';

/**
 * ais-decoder — consume les messages aisstream.io bruts et fait :
 *   1. PositionReport → INSERT vessel_positions + UPDATE vessels.last_*
 *   2. ShipStaticData → UPSERT vessels (name, type, dimensions, destination)
 *
 * Plus, publish un événement enrichi sur `ais.positions` avec une
 * routing key `<geohash3>.<ship_type_bucket>` pour que les density
 * workers downstream se bindent par zone.
 *
 * Pattern aisstream message :
 * {
 *   "MessageType": "PositionReport",
 *   "MetaData": { "MMSI", "ShipName", "time_utc", "latitude", "longitude" },
 *   "Message": {
 *     "PositionReport": { "Sog", "Cog", "TrueHeading", "NavigationalStatus" }
 *   }
 * }
 */
@Injectable()
export class AisDecoderService implements OnModuleInit {
  private readonly logger = new Logger(AisDecoderService.name);
  private positionCount = 0;
  private staticCount = 0;
  private statsInterval?: NodeJS.Timeout;

  constructor(
    private readonly pg: PgService,
    private readonly rabbit: RabbitMqConsumer,
  ) {}

  onModuleInit(): void {
    this.rabbit.setHandler((data, rk) => this.handle(data, rk));
    this.statsInterval = setInterval(() => {
      if (this.positionCount > 0 || this.staticCount > 0) {
        this.logger.log(`Decoded ${this.positionCount} positions + ${this.staticCount} static msg in last minute`);
        this.positionCount = 0;
        this.staticCount = 0;
      }
    }, 60_000);
  }

  private async handle(raw: unknown, _routingKey: string): Promise<void> {
    const data = raw as AisStreamMessage;
    if (!data?.MessageType || !data?.MetaData) return;

    const mmsi = Number(data.MetaData.MMSI);
    if (!Number.isFinite(mmsi) || mmsi <= 0) return;
    const lat = Number(data.MetaData.latitude);
    const lon = Number(data.MetaData.longitude);
    const ts = data.MetaData.time_utc ? new Date(data.MetaData.time_utc.replace(' +0000 UTC', 'Z').replace(' UTC', 'Z')) : new Date();

    if (data.MessageType === 'PositionReport') {
      const pr = data.Message?.PositionReport;
      if (!pr || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
      const sog = Number.isFinite(pr.Sog) ? pr.Sog : null;
      const cog = Number.isFinite(pr.Cog) ? pr.Cog : null;
      const heading = Number.isFinite(pr.TrueHeading) && pr.TrueHeading !== 511 ? pr.TrueHeading : null;
      const navStatus = Number.isFinite(pr.NavigationalStatus) ? pr.NavigationalStatus : null;

      // INSERT position + UPSERT vessels (last_seen + last_position)
      // dans une seule transaction pour cohérence.
      const client = await this.pg.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO vessel_positions (ts, mmsi, geom, sog, cog, heading, nav_status)
           VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $5, $6, $7, $8)`,
          [ts, mmsi, lon, lat, sog, cog, heading, navStatus],
        );
        await client.query(
          `INSERT INTO vessels (mmsi, name, last_seen, last_position)
           VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography)
           ON CONFLICT (mmsi) DO UPDATE SET
             name = COALESCE(vessels.name, EXCLUDED.name),
             last_seen = EXCLUDED.last_seen,
             last_position = EXCLUDED.last_position`,
          [mmsi, data.MetaData.ShipName ?? null, ts, lon, lat],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      this.positionCount++;

      // Publish enrichi sur ais.positions (sprint 2+ : density worker
      // consume, alert engine consume…). Routing key par geohash niveau 3
      // (~150km cellules) + ship_type pour subscriptions par zone+type.
      const geohash = this.geohash3(lat, lon);
      this.rabbit.publish('ais.positions', `${geohash}.position`, {
        mmsi, ts: ts.toISOString(), lat, lon, sog, cog, heading, navStatus,
      });
    } else if (data.MessageType === 'ShipStaticData') {
      const sd = data.Message?.ShipStaticData;
      if (!sd) return;
      // Dimensions = (A,B,C,D) — A=bow, B=stern → length=A+B, width=C+D
      const lengthM = (Number(sd.Dimension?.A) || 0) + (Number(sd.Dimension?.B) || 0);
      const widthM = (Number(sd.Dimension?.C) || 0) + (Number(sd.Dimension?.D) || 0);

      await this.pg.pool.query(
        `INSERT INTO vessels (mmsi, name, callsign, ship_type, length_m, width_m, draught_m, destination, eta, last_seen)
         VALUES ($1, $2, $3, $4, NULLIF($5, 0), NULLIF($6, 0), $7, $8, $9, $10)
         ON CONFLICT (mmsi) DO UPDATE SET
           name = COALESCE(EXCLUDED.name, vessels.name),
           callsign = COALESCE(EXCLUDED.callsign, vessels.callsign),
           ship_type = COALESCE(EXCLUDED.ship_type, vessels.ship_type),
           length_m = COALESCE(EXCLUDED.length_m, vessels.length_m),
           width_m = COALESCE(EXCLUDED.width_m, vessels.width_m),
           draught_m = COALESCE(EXCLUDED.draught_m, vessels.draught_m),
           destination = COALESCE(EXCLUDED.destination, vessels.destination),
           eta = COALESCE(EXCLUDED.eta, vessels.eta),
           last_seen = GREATEST(EXCLUDED.last_seen, vessels.last_seen)`,
        [
          mmsi,
          sd.Name?.trim() || null,
          sd.CallSign?.trim() || null,
          Number.isFinite(sd.Type) ? sd.Type : null,
          lengthM,
          widthM,
          Number.isFinite(sd.MaximumStaticDraught) ? sd.MaximumStaticDraught : null,
          sd.Destination?.trim() || null,
          this.parseEta(sd.Eta),
          ts,
        ],
      );

      this.staticCount++;
    }
  }

  /** Geohash niveau 3 — ~150km cells. Suffit pour binder ais.positions par zone. */
  private geohash3(lat: number, lon: number): string {
    const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
    let bits = 0, bit = 0, evenBit = true;
    let latMin = -90, latMax = 90, lonMin = -180, lonMax = 180;
    let hash = '';
    while (hash.length < 3) {
      if (evenBit) {
        const mid = (lonMin + lonMax) / 2;
        if (lon >= mid) { bits = (bits << 1) | 1; lonMin = mid; }
        else { bits <<= 1; lonMax = mid; }
      } else {
        const mid = (latMin + latMax) / 2;
        if (lat >= mid) { bits = (bits << 1) | 1; latMin = mid; }
        else { bits <<= 1; latMax = mid; }
      }
      evenBit = !evenBit;
      bit++;
      if (bit === 5) { hash += BASE32[bits]; bits = 0; bit = 0; }
    }
    return hash;
  }

  /** ETA AIS = MM-DD HH:MM (sans année). Convertit en TIMESTAMPTZ best-effort. */
  private parseEta(eta?: { Month?: number; Day?: number; Hour?: number; Minute?: number }): Date | null {
    if (!eta || !eta.Month || !eta.Day) return null;
    if (eta.Month < 1 || eta.Month > 12 || eta.Day < 1 || eta.Day > 31) return null;
    const now = new Date();
    const year = eta.Month >= now.getUTCMonth() + 1 ? now.getUTCFullYear() : now.getUTCFullYear() + 1;
    const d = new Date(Date.UTC(year, eta.Month - 1, eta.Day, eta.Hour ?? 0, eta.Minute ?? 0));
    return Number.isFinite(d.getTime()) ? d : null;
  }
}

// ─── Types AIS Stream ─────────────────────────────────────────────────
interface AisStreamMessage {
  MessageType: 'PositionReport' | 'ShipStaticData' | string;
  MetaData?: {
    MMSI?: number;
    ShipName?: string;
    time_utc?: string;
    latitude?: number;
    longitude?: number;
  };
  Message?: {
    PositionReport?: {
      Sog?: number;
      Cog?: number;
      TrueHeading?: number;
      NavigationalStatus?: number;
    };
    ShipStaticData?: {
      Name?: string;
      CallSign?: string;
      Type?: number;
      Destination?: string;
      MaximumStaticDraught?: number;
      Dimension?: { A?: number; B?: number; C?: number; D?: number };
      Eta?: { Month?: number; Day?: number; Hour?: number; Minute?: number };
    };
  };
}
