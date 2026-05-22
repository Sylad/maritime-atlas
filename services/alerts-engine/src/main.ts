/**
 * alerts-engine — moteur de règles consommant les events maritimes.
 *
 * Souscrit à 3 sources RMQ :
 *   - `ais.positions` (topic, routing `*.position`) → règle high-wind-cargo
 *   - `lightning.strike` (topic, routing `#`)       → règle lightning-proximity
 *   - `raster.ready` (fanout)                       → invalidate cache vent
 *
 * Persiste les alertes en hypertable `alerts` (retention 14j) et publie
 * sur exchange `alerts.maritime` (topic, routing `<severity>.<kind>`)
 * pour permettre des subscriptions ciblées en aval (notif push, mail, etc.).
 *
 * Cooldown 30min par (mmsi, kind) pour éviter le spam d'alertes répétées
 * pour le même navire pendant qu'il traverse une zone à risque.
 */
import amqp from 'amqplib';
import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

// ─── Config ──────────────────────────────────────────────────────────
const DATABASE_URL = process.env.DATABASE_URL ?? '';
const RABBITMQ_URL = process.env.RABBITMQ_URL ?? '';
const WIND_ARROWS_DIR = process.env.WIND_ARROWS_DIR ?? '/wind-arrows';
const WIND_SPEED_ALERT_THRESHOLD = parseFloat(process.env.WIND_SPEED_ALERT_THRESHOLD ?? '10'); // m/s
const LIGHTNING_PROXIMITY_KM = parseFloat(process.env.LIGHTNING_PROXIMITY_KM ?? '10');
const COOLDOWN_MIN = parseInt(process.env.COOLDOWN_MIN ?? '30', 10);

const pg = new Pool({ connectionString: DATABASE_URL, max: 5 });
let publishChannel: amqp.Channel | null = null;

// ─── Wind grid cache (loaded from /wind-arrows/) ─────────────────────
interface WindPoint {
  lon: number;
  lat: number;
  speed: number;
  dirTo: number;
}
let windGrid: WindPoint[] = [];
let windGridValidUntil: Date | null = null;

async function reloadWindGrid(): Promise<void> {
  try {
    const manifestPath = path.join(WIND_ARROWS_DIR, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      log('wind manifest not found, skipping reload');
      return;
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const timestamps: string[] = manifest.wind ?? [];
    if (timestamps.length === 0) return;
    // Find the closest forecast timestep to "now"
    const now = Date.now();
    let bestTs = timestamps[0];
    let bestDelta = Math.abs(parseTs(bestTs).getTime() - now);
    for (const ts of timestamps) {
      const d = Math.abs(parseTs(ts).getTime() - now);
      if (d < bestDelta) { bestTs = ts; bestDelta = d; }
    }
    const file = path.join(WIND_ARROWS_DIR, `wind_arrows_${bestTs}.geojson`);
    if (!fs.existsSync(file)) return;
    const fc = JSON.parse(fs.readFileSync(file, 'utf8'));
    windGrid = fc.features.map((f: any) => ({
      lon: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
      speed: f.properties.speed,
      dirTo: f.properties.dirTo,
    }));
    windGridValidUntil = new Date(parseTs(bestTs).getTime() + 3 * 3600_000);
    log(`wind grid reloaded: ${windGrid.length} points, ts=${bestTs}`);
  } catch (err) {
    console.error('[alerts] reloadWindGrid failed:', (err as Error).message);
  }
}

function parseTs(ts: string): Date {
  // YYYYMMDDTHHMMSSZ → ISO
  return new Date(`${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T${ts.slice(9, 11)}:${ts.slice(11, 13)}:${ts.slice(13, 15)}Z`);
}

function nearestWind(lat: number, lon: number): WindPoint | null {
  if (windGrid.length === 0) return null;
  let best = windGrid[0];
  let bestD2 = (best.lat - lat) ** 2 + (best.lon - lon) ** 2;
  for (const p of windGrid) {
    const d2 = (p.lat - lat) ** 2 + (p.lon - lon) ** 2;
    if (d2 < bestD2) { best = p; bestD2 = d2; }
  }
  // Reject if too far (>0.5° = ~50km — pas pertinent pour notre maillage 0.25°)
  if (Math.sqrt(bestD2) > 0.5) return null;
  return best;
}

// ─── Cooldown deduplication ──────────────────────────────────────────
const cooldown = new Map<string, number>();   // `${mmsi}:${kind}` → ms epoch

function onCooldown(mmsi: number, kind: string): boolean {
  const key = `${mmsi}:${kind}`;
  const last = cooldown.get(key);
  if (!last) return false;
  return (Date.now() - last) < COOLDOWN_MIN * 60_000;
}
function markEmitted(mmsi: number, kind: string): void {
  cooldown.set(`${mmsi}:${kind}`, Date.now());
}

// ─── Emit alert ─────────────────────────────────────────────────────
type Severity = 'info' | 'warning' | 'danger';

interface AlertPayload {
  kind: string;
  severity: Severity;
  mmsi: number | null;
  vesselName: string | null;
  shipType: number | null;
  lat: number;
  lon: number;
  detail: Record<string, unknown>;
}

async function emitAlert(a: AlertPayload): Promise<void> {
  try {
    await pg.query(
      `INSERT INTO alerts (kind, severity, mmsi, vessel_name, ship_type, geom, detail)
       VALUES ($1, $2, $3, $4, $5, ST_SetSRID(ST_MakePoint($6, $7), 4326), $8)`,
      [a.kind, a.severity, a.mmsi, a.vesselName, a.shipType, a.lon, a.lat, JSON.stringify(a.detail)],
    );
  } catch (err) {
    console.error('[alerts] insert failed:', (err as Error).message);
  }
  if (publishChannel) {
    publishChannel.publish(
      'alerts.maritime',
      `${a.severity}.${a.kind}`,
      Buffer.from(JSON.stringify({ ts: new Date().toISOString(), ...a })),
      { contentType: 'application/json', persistent: true },
    );
  }
  log(`emit ${a.severity}.${a.kind} mmsi=${a.mmsi} ${JSON.stringify(a.detail)}`);
}

// ─── Rule 1 : high wind on cargo/tanker (ship_type 70-89) ───────────
interface PositionEvent {
  mmsi: number;
  ts: string;
  lat: number;
  lon: number;
  sog?: number;
  cog?: number;
}

let ruleHighWindHits = 0;

async function onPosition(evt: PositionEvent): Promise<void> {
  if (windGrid.length === 0) return;
  const wp = nearestWind(evt.lat, evt.lon);
  if (!wp || wp.speed < WIND_SPEED_ALERT_THRESHOLD) return;
  if (onCooldown(evt.mmsi, 'high-wind')) return;

  // Query vessels for ship_type (decoder n'inclut pas ship_type dans le
  // payload — économise bande passante en délégant au consumer)
  const res = await pg.query<{ name: string | null; ship_type: number | null }>(
    'SELECT name, ship_type FROM vessels WHERE mmsi = $1 LIMIT 1', [evt.mmsi],
  );
  const ship = res.rows[0];
  if (!ship?.ship_type) return;
  const isCargoOrTanker = ship.ship_type >= 70 && ship.ship_type <= 89;
  if (!isCargoOrTanker) return;

  const severity: Severity = wp.speed >= 20 ? 'danger' : 'warning';
  markEmitted(evt.mmsi, 'high-wind');
  ruleHighWindHits++;
  await emitAlert({
    kind: 'high-wind',
    severity,
    mmsi: evt.mmsi,
    vesselName: ship.name,
    shipType: ship.ship_type,
    lat: evt.lat, lon: evt.lon,
    detail: {
      windSpeed: wp.speed,
      windDirTo: wp.dirTo,
      threshold: WIND_SPEED_ALERT_THRESHOLD,
    },
  });
}

// ─── Rule 2 : lightning proximity ────────────────────────────────────
interface LightningEvent {
  ts: string;
  lat: number;
  lon: number;
  alt?: number;
  mcg?: number;
}

let ruleLightningHits = 0;

async function onLightning(evt: LightningEvent): Promise<void> {
  const res = await pg.query<{
    mmsi: number; name: string | null; ship_type: number | null;
    lat: number; lon: number; distance_m: number;
  }>(
    `SELECT v.mmsi, v.name, v.ship_type,
            ST_Y(v.last_position::geometry) AS lat,
            ST_X(v.last_position::geometry) AS lon,
            ST_Distance(v.last_position, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) AS distance_m
     FROM vessels v
     WHERE v.last_seen > now() - INTERVAL '5 minutes'
       AND v.last_position IS NOT NULL
       AND ST_DWithin(v.last_position, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)
     ORDER BY distance_m ASC
     LIMIT 20`,
    [evt.lon, evt.lat, LIGHTNING_PROXIMITY_KM * 1000],
  );
  for (const v of res.rows) {
    if (onCooldown(v.mmsi, 'lightning-proximity')) continue;
    markEmitted(v.mmsi, 'lightning-proximity');
    ruleLightningHits++;
    const severity: Severity = v.distance_m < 3000 ? 'danger' : 'warning';
    await emitAlert({
      kind: 'lightning-proximity',
      severity,
      mmsi: v.mmsi,
      vesselName: v.name,
      shipType: v.ship_type,
      lat: v.lat, lon: v.lon,
      detail: {
        strikeAt: { lat: evt.lat, lon: evt.lon, ts: evt.ts },
        distanceM: Math.round(v.distance_m),
        thresholdKm: LIGHTNING_PROXIMITY_KM,
      },
    });
  }
}

// ─── Boot ────────────────────────────────────────────────────────────
function log(msg: string): void {
  console.log(`[alerts] ${msg}`);
}

async function main(): Promise<void> {
  if (!DATABASE_URL || !RABBITMQ_URL) {
    console.error('DATABASE_URL and RABBITMQ_URL required');
    process.exit(1);
  }
  log(`starting (wind threshold ${WIND_SPEED_ALERT_THRESHOLD} m/s, lightning ${LIGHTNING_PROXIMITY_KM}km, cooldown ${COOLDOWN_MIN}min)`);
  await reloadWindGrid();
  // Reload toutes les 30 min au cas où on rate l'event raster.ready
  setInterval(reloadWindGrid, 30 * 60_000);

  const conn = await amqp.connect(RABBITMQ_URL);
  // 2026-05-22 — bug observé après bump RMQ 4.2.6→4.3.0 : connexion AMQP
  // perdue silencieusement pendant le rolling restart du broker, le pod
  // continue de log les stats mais ne consomme plus rien (queues
  // `alerts-engine.ais.positions` accumulaient 7k+ msg, 0 consumer côté
  // broker). Sans error/close handler, amqplib n'auto-reconnect pas.
  //
  // Fix : on log + on `process.exit(1)` au moindre incident → K8s redémarre
  // le pod et reprend une connexion fraîche (durée d'indisponibilité = ~30s,
  // bien meilleure que la stale connection silencieuse). Idempotent côté
  // queues (durable, x-message-ttl 60s absorbe le gap).
  conn.on('error', (err) => {
    console.error('[alerts] amqp connection error — exiting for restart:', err.message);
    process.exit(1);
  });
  conn.on('close', () => {
    console.error('[alerts] amqp connection closed — exiting for restart');
    process.exit(1);
  });
  const ch = await conn.createChannel();
  ch.on('error', (err) => {
    console.error('[alerts] amqp channel error — exiting for restart:', err.message);
    process.exit(1);
  });
  ch.on('close', () => {
    console.error('[alerts] amqp channel closed — exiting for restart');
    process.exit(1);
  });
  publishChannel = ch;

  // Outbound exchange
  await ch.assertExchange('alerts.maritime', 'topic', { durable: true });

  // Subscribe ais.positions
  await ch.assertExchange('ais.positions', 'topic', { durable: true });
  const aisQ = await ch.assertQueue('alerts-engine.ais.positions', {
    durable: true,
    arguments: { 'x-message-ttl': 60_000, 'x-max-length': 50_000 },
  });
  await ch.bindQueue(aisQ.queue, 'ais.positions', '*.position');
  ch.prefetch(50);
  ch.consume(aisQ.queue, (msg) => {
    if (!msg) return;
    try {
      const evt: PositionEvent = JSON.parse(msg.content.toString());
      onPosition(evt).catch((err) => console.error('[alerts] onPosition err:', err));
    } catch { /* ignore malformed */ }
    ch.ack(msg);
  });

  // Subscribe lightning.strike
  await ch.assertExchange('lightning.strike', 'topic', { durable: true });
  const lqQ = await ch.assertQueue('alerts-engine.lightning.strike', {
    durable: true,
    arguments: { 'x-message-ttl': 60_000 },
  });
  await ch.bindQueue(lqQ.queue, 'lightning.strike', '#');
  ch.consume(lqQ.queue, (msg) => {
    if (!msg) return;
    try {
      const evt: LightningEvent = JSON.parse(msg.content.toString());
      onLightning(evt).catch((err) => console.error('[alerts] onLightning err:', err));
    } catch { /* ignore */ }
    ch.ack(msg);
  });

  // Subscribe raster.ready
  await ch.assertExchange('raster.ready', 'fanout', { durable: true });
  const rqQ = await ch.assertQueue('', { exclusive: true });
  await ch.bindQueue(rqQ.queue, 'raster.ready', '');
  ch.consume(rqQ.queue, (msg) => {
    if (!msg) return;
    try {
      const evt = JSON.parse(msg.content.toString());
      if (evt.type === 'weather' || evt.new_files?.wind_arrows > 0) {
        log('raster.ready (weather) — reloading wind grid');
        reloadWindGrid();
      }
    } catch { /* ignore */ }
    ch.ack(msg);
  });

  // Periodic stats
  setInterval(() => {
    log(`stats last 60s: high-wind=${ruleHighWindHits}, lightning=${ruleLightningHits}, cooldown=${cooldown.size}`);
    ruleHighWindHits = 0;
    ruleLightningHits = 0;
  }, 60_000);

  log('subscribed to ais.positions + lightning.strike + raster.ready');
}

main().catch((err) => {
  console.error('[alerts] fatal:', err);
  process.exit(1);
});
