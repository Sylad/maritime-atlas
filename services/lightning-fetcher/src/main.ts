/**
 * lightning-fetcher — consume Blitzortung WebSocket stream, decode LZW,
 * filter bbox France, persist to PostGIS hypertable.
 *
 * Blitzortung est un réseau communautaire de détecteurs d'éclairs. Le
 * stream public est documenté ici : https://blitzortung.org/en/live_lightning_data.php
 *
 * Protocole :
 *   - Connecter wss://ws1.blitzortung.org/ (et ws2/ws3/ws4 en fallback)
 *   - À l'open, envoyer `{"a":111}` pour s'abonner aux strikes globaux
 *   - Réception : messages texte LZW-compressed, contenant un JSON
 *     { time: ns_epoch, lat, lon, alt, mcg, pol, status, ... }
 *
 * Ce service :
 *   - Filtre la bbox France métropole (cohérence avec autres layers)
 *   - INSERT dans hypertable `lightning_strikes` (retention 7j)
 *   - Publish chaque strike filtré sur exchange `lightning.strike` topic
 *     (routing key = geohash3, permet downstream alerting par zone)
 *   - Reconnect avec backoff exponentiel
 */
import WebSocket from 'ws';
import { Client as PgClient } from 'pg';
import amqp from 'amqplib';

// ─── Config ──────────────────────────────────────────────────────────
const WS_ENDPOINTS = [
  'wss://ws1.blitzortung.org/',
  'wss://ws2.blitzortung.org/',
  'wss://ws3.blitzortung.org/',
];
// Sprint Europe 2026-05-12 : bbox élargi de FR métro à Europe étroite
// (Açores → Pologne, Méditerranée → Cap Nord). Volume strikes ×10-100×
// pendant orages — la hypertable lightning_strikes scale OK avec
// la retention 7j déjà en place.
const BBOX = {
  minLon: -15.0,
  maxLon: 30.0,
  minLat: 35.0,
  maxLat: 65.0,
};

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const RABBITMQ_URL = process.env.RABBITMQ_URL ?? '';

// ─── LZW decoder ─────────────────────────────────────────────────────
// Algorithme LZW utilisé par Blitzortung pour compresser les strikes
// (économise ~70% de bande passante sur des messages JSON répétitifs).
function lzwDecode(input: string): string {
  const dict: Record<number, string> = {};
  const data = input.split('');
  let currChar = data[0];
  let oldPhrase = currChar;
  const out: string[] = [currChar];
  let code = 256;
  let phrase: string;
  for (let i = 1; i < data.length; i++) {
    const currCode = data[i].charCodeAt(0);
    if (currCode < 256) {
      phrase = data[i];
    } else {
      phrase = dict[currCode] ? dict[currCode] : (oldPhrase + currChar);
    }
    out.push(phrase);
    currChar = phrase.charAt(0);
    dict[code] = oldPhrase + currChar;
    code++;
    oldPhrase = phrase;
  }
  return out.join('');
}

// ─── Strike type ─────────────────────────────────────────────────────
interface BlitzortungStrike {
  time: number;           // nanoseconds epoch
  lat: number;
  lon: number;
  alt?: number;
  pol?: number;
  mds?: number;
  mcg?: number;           // received_count
  status?: number;
  region?: number;
  sig?: Array<unknown>;
}

// ─── Postgres + RabbitMQ setup ───────────────────────────────────────
let pg: PgClient | null = null;
let rmqChannel: amqp.Channel | null = null;

async function setupPg(): Promise<void> {
  if (!DATABASE_URL) {
    console.warn('[lightning] DATABASE_URL not set — running in dry-run mode');
    return;
  }
  pg = new PgClient({ connectionString: DATABASE_URL });
  await pg.connect();
  console.log('[lightning] PG connected');
}

async function setupRmq(): Promise<void> {
  if (!RABBITMQ_URL) return;
  try {
    const conn = await amqp.connect(RABBITMQ_URL);
    // 2026-05-22 — handlers error/close pour eviter une stale connection
    // silencieuse après un rolling restart broker. Pattern identique à
    // alerts-engine (cf bug observé bump RMQ 4.3.0).
    conn.on('error', (err) => {
      console.error('[lightning] amqp connection error — exiting for restart:', err.message);
      process.exit(1);
    });
    conn.on('close', () => {
      console.error('[lightning] amqp connection closed — exiting for restart');
      process.exit(1);
    });
    rmqChannel = await conn.createChannel();
    rmqChannel.on('error', (err) => {
      console.error('[lightning] amqp channel error — exiting for restart:', err.message);
      process.exit(1);
    });
    rmqChannel.on('close', () => {
      console.error('[lightning] amqp channel closed — exiting for restart');
      process.exit(1);
    });
    await rmqChannel.assertExchange('lightning.strike', 'topic', { durable: true });
    console.log('[lightning] RMQ connected');
  } catch (err) {
    console.warn('[lightning] RMQ setup failed (continuing without):', (err as Error).message);
  }
}

// ─── Strike handling ─────────────────────────────────────────────────
let counter = 0;
let counterInBbox = 0;
let lastLogAt = Date.now();

function insideBbox(lat: number, lon: number): boolean {
  return lat >= BBOX.minLat && lat <= BBOX.maxLat && lon >= BBOX.minLon && lon <= BBOX.maxLon;
}

async function handleStrike(strike: BlitzortungStrike): Promise<void> {
  counter++;
  if (!insideBbox(strike.lat, strike.lon)) {
    return;
  }
  counterInBbox++;
  const ts = new Date(strike.time / 1e6); // nanoseconds → ms

  if (pg) {
    try {
      await pg.query(
        `INSERT INTO lightning_strikes (ts, geom, alt, mcg, pol, status)
         VALUES ($1, ST_SetSRID(ST_MakePoint($2, $3), 4326), $4, $5, $6, $7)`,
        [
          ts,
          strike.lon,
          strike.lat,
          strike.alt ?? null,
          strike.mcg ?? null,
          strike.pol ?? null,
          strike.status ?? null,
        ],
      );
    } catch (err) {
      console.error('[lightning] PG insert failed:', (err as Error).message);
    }
  }

  if (rmqChannel) {
    const routingKey = geohash3(strike.lat, strike.lon);
    rmqChannel.publish(
      'lightning.strike',
      routingKey,
      Buffer.from(JSON.stringify({
        ts: ts.toISOString(),
        lat: strike.lat,
        lon: strike.lon,
        alt: strike.alt,
        mcg: strike.mcg,
      })),
      { contentType: 'application/json', persistent: false },
    );
  }
}

/** geohash 3-char (precision ~150km) pour routing key RMQ. */
function geohash3(lat: number, lon: number): string {
  const base32 = '0123456789bcdefghjkmnpqrstuvwxyz';
  let latLo = -90, latHi = 90, lonLo = -180, lonHi = 180;
  let isLon = true;
  let bit = 0;
  let ch = 0;
  let s = '';
  while (s.length < 3) {
    if (isLon) {
      const mid = (lonLo + lonHi) / 2;
      if (lon >= mid) { ch = (ch << 1) | 1; lonLo = mid; } else { ch = ch << 1; lonHi = mid; }
    } else {
      const mid = (latLo + latHi) / 2;
      if (lat >= mid) { ch = (ch << 1) | 1; latLo = mid; } else { ch = ch << 1; latHi = mid; }
    }
    isLon = !isLon;
    if (++bit === 5) { s += base32[ch]; ch = 0; bit = 0; }
  }
  return s;
}

// ─── WebSocket loop with reconnect ───────────────────────────────────
let endpointIdx = 0;
let reconnectDelayMs = 1000;
const RECONNECT_MAX_MS = 60_000;

function connect(): void {
  const url = WS_ENDPOINTS[endpointIdx];
  console.log('[lightning] Connecting to', url);
  const ws = new WebSocket(url);

  ws.on('open', () => {
    console.log('[lightning] WS open, subscribing');
    ws.send('{"a":111}');     // subscribe to global strike stream
    reconnectDelayMs = 1000;  // reset backoff
  });

  ws.on('message', (data) => {
    let raw: string;
    if (Buffer.isBuffer(data)) {
      raw = data.toString('utf8');
    } else if (typeof data === 'string') {
      raw = data;
    } else {
      return;
    }
    try {
      const decoded = lzwDecode(raw);
      const strike: BlitzortungStrike = JSON.parse(decoded);
      if (typeof strike.lat === 'number' && typeof strike.lon === 'number') {
        handleStrike(strike).catch((e) => console.error('[lightning] handle err:', e));
      }
    } catch {
      // Certains messages sont du JSON brut non-LZW (heartbeat etc.), skip silencieusement
      try {
        const direct = JSON.parse(raw);
        if (typeof direct.lat === 'number' && typeof direct.lon === 'number') {
          handleStrike(direct);
        }
      } catch { /* ignore */ }
    }

    // Log toutes les 30s : combien de strikes globaux vs en bbox
    const now = Date.now();
    if (now - lastLogAt > 30_000) {
      console.log(`[lightning] last 30s: ${counter} global, ${counterInBbox} in bbox EU`);
      counter = 0;
      counterInBbox = 0;
      lastLogAt = now;
    }
  });

  ws.on('close', (code, reason) => {
    console.warn('[lightning] WS close:', code, reason.toString());
    endpointIdx = (endpointIdx + 1) % WS_ENDPOINTS.length;
    setTimeout(connect, reconnectDelayMs);
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_MS);
  });

  ws.on('error', (err) => {
    console.error('[lightning] WS error:', err.message);
    // close handler will fire next
  });
}

// ─── Boot ────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log('[lightning] Starting (bbox Europe étroite)');
  await setupPg();
  await setupRmq();
  connect();
}

main().catch((err) => {
  console.error('[lightning] Fatal:', err);
  process.exit(1);
});
