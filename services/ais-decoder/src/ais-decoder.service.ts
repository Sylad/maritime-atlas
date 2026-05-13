import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PgService } from './pg.service';
import { RabbitMqConsumer } from './rabbitmq-consumer.service';

/**
 * ais-decoder — consume les messages aisstream.io bruts et fait :
 *   1. PositionReport → INSERT vessel_positions + UPSERT vessels.last_*
 *   2. ShipStaticData → UPSERT vessels (name, type, dimensions, destination)
 *
 * V2 (2026-05-13) — BATCH INSERT pour éviter la lock contention Postgres
 * quand plusieurs replicas decoders tournent en parallèle (autoscaler scale
 * 1-5 sur queue depth). Cas observé : 5 decoders × 8 msg/s = 40 msg/s
 * cumulé. Cause = chaque message déclenche 2 INSERTs + 1 COMMIT (≥ 50ms
 * IO/lock). Avec batch 100, le throughput devient ~500 msg/s par decoder
 * (×10-50 vs single-row).
 *
 * Pattern :
 *   - handle() push dans le buffer (RMQ ack reste par-message)
 *   - flushBatch() exécute multi-row INSERT toutes les N messages OU
 *     toutes les T ms (whichever first)
 *   - Si crash entre ack et flush : perte de max BATCH_SIZE messages,
 *     acceptable pour event stream AIS (positions continues).
 *
 * Plus, publish un événement enrichi sur `ais.positions` avec une
 * routing key `<geohash3>.<ship_type_bucket>` pour que les density
 * workers downstream se bindent par zone.
 */
@Injectable()
export class AisDecoderService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AisDecoderService.name);
  private positionCount = 0;
  private staticCount = 0;
  private statsInterval?: NodeJS.Timeout;
  private flushInterval?: NodeJS.Timeout;

  /** Buffer batch INSERT. Flush si size >= BATCH_SIZE ou interval expire. */
  private positionBuffer: BufferedPosition[] = [];
  private staticBuffer: BufferedStatic[] = [];
  private readonly BATCH_SIZE = 100;
  private readonly FLUSH_INTERVAL_MS = 1000;

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
    // Flush timer : capte les batches courts pendant les périodes calmes.
    this.flushInterval = setInterval(() => {
      void this.flushAll();
    }, this.FLUSH_INTERVAL_MS);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.statsInterval) clearInterval(this.statsInterval);
    if (this.flushInterval) clearInterval(this.flushInterval);
    // Flush final pour les messages en buffer.
    await this.flushAll();
  }

  private async handle(raw: unknown, _routingKey: string): Promise<void> {
    const data = raw as AisStreamMessage;
    if (!data?.MessageType || !data?.MetaData) return;

    const mmsi = Number(data.MetaData.MMSI);
    if (!Number.isFinite(mmsi) || mmsi <= 0) return;
    const lat = Number(data.MetaData.latitude);
    const lon = Number(data.MetaData.longitude);
    const ts = data.MetaData.time_utc
      ? new Date(data.MetaData.time_utc.replace(' +0000 UTC', 'Z').replace(' UTC', 'Z'))
      : new Date();

    if (data.MessageType === 'PositionReport') {
      const pr = data.Message?.PositionReport;
      if (!pr || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
      const sog = typeof pr.Sog === 'number' && Number.isFinite(pr.Sog) ? pr.Sog : null;
      const cog = typeof pr.Cog === 'number' && Number.isFinite(pr.Cog) ? pr.Cog : null;
      const heading =
        typeof pr.TrueHeading === 'number' && Number.isFinite(pr.TrueHeading) && pr.TrueHeading !== 511
          ? pr.TrueHeading
          : null;
      const navStatus =
        typeof pr.NavigationalStatus === 'number' && Number.isFinite(pr.NavigationalStatus)
          ? pr.NavigationalStatus
          : null;

      this.positionBuffer.push({
        ts, mmsi, lat, lon, sog, cog, heading, navStatus,
        shipName: data.MetaData.ShipName?.trim() ?? null,
      });

      // Publish enrichi sur ais.positions (sprint 2+ : density worker
      // consume, alert engine consume…). Routing key par geohash niveau 3
      // (~150km cellules) + ship_type pour subscriptions par zone+type.
      // Publish reste per-message (RMQ pub est cheap, pas le bottleneck).
      const geohash = this.geohash3(lat, lon);
      this.rabbit.publish('ais.positions', `${geohash}.position`, {
        mmsi, ts: ts.toISOString(), lat, lon, sog, cog, heading, navStatus,
      });

      if (this.positionBuffer.length >= this.BATCH_SIZE) {
        await this.flushPositions();
      }
    } else if (data.MessageType === 'ShipStaticData') {
      const sd = data.Message?.ShipStaticData;
      if (!sd) return;
      // Dimensions = (A,B,C,D) — A=bow, B=stern → length=A+B, width=C+D
      const lengthM = (Number(sd.Dimension?.A) || 0) + (Number(sd.Dimension?.B) || 0);
      const widthM = (Number(sd.Dimension?.C) || 0) + (Number(sd.Dimension?.D) || 0);

      this.staticBuffer.push({
        mmsi,
        name: sd.Name?.trim() || null,
        callsign: sd.CallSign?.trim() || null,
        shipType: typeof sd.Type === 'number' && Number.isFinite(sd.Type) ? sd.Type : null,
        lengthM,
        widthM,
        draughtM:
          typeof sd.MaximumStaticDraught === 'number' && Number.isFinite(sd.MaximumStaticDraught)
            ? sd.MaximumStaticDraught
            : null,
        destination: sd.Destination?.trim() || null,
        eta: this.parseEta(sd.Eta),
        ts,
      });

      if (this.staticBuffer.length >= this.BATCH_SIZE) {
        await this.flushStatic();
      }
    }
  }

  private async flushAll(): Promise<void> {
    if (this.positionBuffer.length > 0) await this.flushPositions();
    if (this.staticBuffer.length > 0) await this.flushStatic();
  }

  /**
   * Flush batch positions : 1 transaction avec multi-row INSERT vessel_positions
   * + multi-row UPSERT vessels. Postgres optimise les batches au-dessus de
   * ~10 lignes (1 lock acquire, 1 WAL flush, 1 commit).
   *
   * V2.1 (2026-05-13) — fix 2 régressions V2 :
   *  1. "ON CONFLICT DO UPDATE command cannot affect row a second time" :
   *     PG refuse 2 lignes avec le même PK dans le même UPSERT. Dedupe par
   *     mmsi avant INSERT INTO vessels (garde l'entry la plus fraîche).
   *  2. "deadlock detected" : 3 decoders parallèles qui UPSERTent les mêmes
   *     mmsi dans des ordres différents → deadlock. Fix = trier par PK
   *     avant INSERT pour que tous les decoders acquièrent les locks dans
   *     le même ordre.
   *  3. Pas d'ON CONFLICT sur vessel_positions : l'hypertable n'a ni PK ni
   *     unique sur (ts, mmsi). Les doublons RMQ-redelivery sont bénins
   *     (les queries "last_position" filtrent par MAX(ts) côté API).
   */
  private async flushPositions(): Promise<void> {
    if (this.positionBuffer.length === 0) return;
    const raw = this.positionBuffer.splice(0);

    // Dedupe vessel_positions par (ts, mmsi) — last wins
    const posMap = new Map<string, BufferedPosition>();
    for (const p of raw) {
      posMap.set(`${p.ts.getTime()}_${p.mmsi}`, p);
    }
    // Dedupe vessels par mmsi — keep the freshest by ts
    const vesMap = new Map<number, BufferedPosition>();
    for (const p of raw) {
      const existing = vesMap.get(p.mmsi);
      if (!existing || p.ts.getTime() > existing.ts.getTime()) {
        vesMap.set(p.mmsi, p);
      }
    }
    // Tri par PK : indispensable pour éviter cross-deadlock entre decoders
    const posBatch = [...posMap.values()].sort((a, b) => {
      const dt = a.ts.getTime() - b.ts.getTime();
      return dt !== 0 ? dt : a.mmsi - b.mmsi;
    });
    const vesBatch = [...vesMap.values()].sort((a, b) => a.mmsi - b.mmsi);

    const client = await this.pg.pool.connect();
    try {
      await client.query('BEGIN');

      // vessel_positions : multi-row INSERT (append-only, pas de conflict possible)
      const posPlaceholders: string[] = [];
      const posValues: unknown[] = [];
      let i = 1;
      for (const p of posBatch) {
        posPlaceholders.push(
          `($${i}, $${i + 1}, ST_SetSRID(ST_MakePoint($${i + 2}, $${i + 3}), 4326)::geography, $${i + 4}, $${i + 5}, $${i + 6}, $${i + 7})`,
        );
        posValues.push(p.ts, p.mmsi, p.lon, p.lat, p.sog, p.cog, p.heading, p.navStatus);
        i += 8;
      }
      // Pas d'ON CONFLICT : l'hypertable vessel_positions n'a ni PK ni unique
      // sur (ts, mmsi) — c'est l'usage Timescale "append-only event stream".
      // Les doublons éventuels (RMQ redelivery) sont tolérés et bénins :
      // les queries "last_position" filtrent par MAX(ts) côté API.
      await client.query(
        `INSERT INTO vessel_positions (ts, mmsi, geom, sog, cog, heading, nav_status) VALUES ${posPlaceholders.join(', ')}`,
        posValues,
      );

      // vessels : multi-row UPSERT — 1 row par mmsi grâce au dedupe.
      const vesPlaceholders: string[] = [];
      const vesValues: unknown[] = [];
      i = 1;
      for (const p of vesBatch) {
        vesPlaceholders.push(
          `($${i}, $${i + 1}, $${i + 2}, ST_SetSRID(ST_MakePoint($${i + 3}, $${i + 4}), 4326)::geography)`,
        );
        vesValues.push(p.mmsi, p.shipName, p.ts, p.lon, p.lat);
        i += 5;
      }
      await client.query(
        `INSERT INTO vessels (mmsi, name, last_seen, last_position) VALUES ${vesPlaceholders.join(', ')}
         ON CONFLICT (mmsi) DO UPDATE SET
           name = COALESCE(vessels.name, EXCLUDED.name),
           last_seen = GREATEST(EXCLUDED.last_seen, vessels.last_seen),
           last_position = CASE
             WHEN EXCLUDED.last_seen > vessels.last_seen THEN EXCLUDED.last_position
             ELSE vessels.last_position
           END`,
        vesValues,
      );

      await client.query('COMMIT');
      this.positionCount += raw.length;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch {}
      // Re-buffer les messages pour retry (priorité haute) — sinon perte définitive.
      this.positionBuffer.unshift(...raw);
      this.logger.warn(`flushPositions failed (batch=${raw.length}, will retry): ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }

  /**
   * Flush batch static data. Multi-row INSERT...ON CONFLICT avec COALESCE
   * sur chaque colonne (préserve les valeurs existantes si new = null).
   *
   * V2.1 (2026-05-13) — dedupe par mmsi + tri par mmsi pour éviter le
   * "ON CONFLICT cannot affect row a second time" et le deadlock cross-decoder.
   * Pour les doublons : on garde l'entry la plus fraîche (ts max), et on
   * fusionne les champs non-null par OR si plusieurs entries différentes.
   */
  private async flushStatic(): Promise<void> {
    if (this.staticBuffer.length === 0) return;
    const raw = this.staticBuffer.splice(0);

    // Dedupe par mmsi — fusion : last ts wins pour last_seen/ts, COALESCE pour les champs nullable
    const merged = new Map<number, BufferedStatic>();
    for (const s of raw) {
      const existing = merged.get(s.mmsi);
      if (!existing) {
        merged.set(s.mmsi, { ...s });
      } else {
        merged.set(s.mmsi, {
          mmsi: s.mmsi,
          name: existing.name ?? s.name,
          callsign: existing.callsign ?? s.callsign,
          shipType: existing.shipType ?? s.shipType,
          lengthM: existing.lengthM || s.lengthM,
          widthM: existing.widthM || s.widthM,
          draughtM: existing.draughtM ?? s.draughtM,
          destination: existing.destination ?? s.destination,
          eta: existing.eta ?? s.eta,
          ts: s.ts.getTime() > existing.ts.getTime() ? s.ts : existing.ts,
        });
      }
    }
    const batch = [...merged.values()].sort((a, b) => a.mmsi - b.mmsi);

    const client = await this.pg.pool.connect();
    try {
      const placeholders: string[] = [];
      const values: unknown[] = [];
      let i = 1;
      for (const s of batch) {
        placeholders.push(
          `($${i}, $${i + 1}, $${i + 2}, $${i + 3}, NULLIF($${i + 4}, 0), NULLIF($${i + 5}, 0), $${i + 6}, $${i + 7}, $${i + 8}, $${i + 9})`,
        );
        values.push(
          s.mmsi, s.name, s.callsign, s.shipType,
          s.lengthM, s.widthM, s.draughtM, s.destination, s.eta, s.ts,
        );
        i += 10;
      }
      await client.query(
        `INSERT INTO vessels (mmsi, name, callsign, ship_type, length_m, width_m, draught_m, destination, eta, last_seen)
         VALUES ${placeholders.join(', ')}
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
        values,
      );
      this.staticCount += raw.length;
    } catch (err) {
      this.staticBuffer.unshift(...raw);
      this.logger.warn(`flushStatic failed (batch=${raw.length}, will retry): ${(err as Error).message}`);
    } finally {
      client.release();
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

// ─── Types batch internes ─────────────────────────────────────────────
interface BufferedPosition {
  ts: Date;
  mmsi: number;
  lat: number;
  lon: number;
  sog: number | null;
  cog: number | null;
  heading: number | null;
  navStatus: number | null;
  shipName: string | null;
}

interface BufferedStatic {
  mmsi: number;
  name: string | null;
  callsign: string | null;
  shipType: number | null;
  lengthM: number;
  widthM: number;
  draughtM: number | null;
  destination: string | null;
  eta: Date | null;
  ts: Date;
}
