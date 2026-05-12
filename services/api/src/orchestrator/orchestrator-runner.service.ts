import { Injectable, Logger, OnModuleInit, Inject, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CronJob } from 'cron';
import { SchedulerRegistry } from '@nestjs/schedule';
import { eq } from 'drizzle-orm';
import { Subject } from 'rxjs';
import { DB_TOKEN, type Db } from '../db/db.module';
import { dataSources, dataJobs, type DataSource } from '../db/schema';
import { connect, type Channel, type ChannelModel } from 'amqplib';

/** Event poussé sur le bus SSE quand un job est persisté (runner OU
 *  POST /admin/jobs/log depuis les ingesters externes). Format minimal
 *  pour ne pas inflate le payload SSE — le client refetch le détail
 *  si besoin. */
export interface JobStreamEvent {
  type: 'job.completed';
  sourceName: string;
  status: 'ok' | 'partial' | 'error';
  startedAt: string;        // ISO
  finishedAt: string;       // ISO
  durationMs: number | null;
  recordsOut: number | null;
  errorMsg: string | null;
}

/**
 * Sprint N2 (2026-05-12) — exécution dynamique des sources `enabled=true`.
 *
 * Au boot et à chaque `reload()` (déclenché par les controllers
 * POST/PUT/PATCH/DELETE sur `/admin/sources`), on :
 *   1. Read sources `enabled=true` ET `schedule_kind IS NOT NULL`
 *   2. Pour chaque source, registre un cron job (via SchedulerRegistry)
 *      ou un setInterval.
 *   3. Au tick, exécute la chaîne fetch → parse → sink, persiste un
 *      row dans data_jobs (via le helper interne, pas via le HTTP
 *      endpoint — on est dans la même process).
 *
 * Les sources legacy (schedule_kind=NULL) sont skippées : elles ont
 * leur propre scheduler embarqué (apscheduler Python, @Cron NestJS).
 *
 * Parsers supportés :
 *   - identity    → pass-through (le sink reçoit le body brut)
 *   - json_path   → extractPath dot/$.features[*]/etc., array iterable
 *
 * Sinks supportés :
 *   - rmq_publish → JSON.stringify + publish sur (exchange, routingKey)
 *   - pg_insert   → SQL INSERT dynamique sur (table, columns map)
 */

type RegisteredJob = {
  type: 'cron' | 'interval';
  name: string;
  cleanup: () => void;
};

@Injectable()
export class OrchestratorRunnerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrchestratorRunnerService.name);
  private rmqChannel: Channel | null = null;
  private rmqConn: ChannelModel | null = null;
  private registered: Map<number, RegisteredJob> = new Map();
  /** Bus d'events pour SSE — exposé via .events() pour le controller SSE.
   *  Push par runCycle() ET par JobsController.log() (ingesters externes). */
  readonly events$ = new Subject<JobStreamEvent>();

  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly config: ConfigService,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  /** Pousse un event sur le bus SSE. Appelé par runCycle() après l'insert
   *  data_jobs ET par JobsController.log() pour les ingesters externes
   *  (sst/weather/buoy/track-builder qui reportent via HTTP). */
  emitJobCompleted(ev: JobStreamEvent): void {
    this.events$.next(ev);
  }

  async onModuleInit(): Promise<void> {
    // Connect RMQ best-effort (le sink rmq_publish en dépend).
    const rmqUrl = this.config.get<string>('rabbitMqUrl');
    if (rmqUrl) {
      try {
        this.rmqConn = await connect(rmqUrl);
        this.rmqChannel = await this.rmqConn.createChannel();
        this.logger.log('RMQ connected (orchestrator runner)');
      } catch (err) {
        this.logger.warn(`RMQ connect failed: ${(err as Error).message} — sink rmq_publish disabled`);
      }
    }
    await this.reload();
  }

  async onModuleDestroy(): Promise<void> {
    for (const [, job] of this.registered) job.cleanup();
    this.registered.clear();
    try { await this.rmqChannel?.close(); } catch {}
    try { await this.rmqConn?.close(); } catch {}
  }

  /** Refresh complet : drop tous les jobs registered + re-register depuis DB. */
  async reload(): Promise<void> {
    for (const [, job] of this.registered) job.cleanup();
    this.registered.clear();

    const sources = await this.db.select().from(dataSources);
    let scheduled = 0;
    for (const src of sources) {
      if (!src.enabled) continue;
      if (!src.scheduleKind) continue;
      try {
        this.registerSource(src);
        scheduled++;
      } catch (err) {
        this.logger.error(`Failed to register source ${src.name}: ${(err as Error).message}`);
      }
    }
    this.logger.log(`Orchestrator reload : ${scheduled} sources scheduled`);
  }

  private registerSource(src: DataSource): void {
    const name = `orchestrator-src-${src.id}`;
    if (src.scheduleKind === 'cron') {
      if (!src.scheduleExpr) throw new Error(`scheduleExpr required for cron`);
      const job = new CronJob(src.scheduleExpr, () => this.runOnceSilent(src));
      this.scheduler.addCronJob(name, job);
      job.start();
      this.registered.set(src.id, {
        type: 'cron', name,
        cleanup: () => {
          try { job.stop(); } catch {}
          try { this.scheduler.deleteCronJob(name); } catch {}
        },
      });
    } else if (src.scheduleKind === 'interval') {
      if (!src.intervalSeconds || src.intervalSeconds < 5) {
        throw new Error(`intervalSeconds >= 5 required for interval schedule`);
      }
      const handle = setInterval(() => this.runOnceSilent(src), src.intervalSeconds * 1000);
      this.scheduler.addInterval(name, handle);
      this.registered.set(src.id, {
        type: 'interval', name,
        cleanup: () => {
          clearInterval(handle);
          try { this.scheduler.deleteInterval(name); } catch {}
        },
      });
    } else if (src.scheduleKind === 'once') {
      // Trigger manuel uniquement — pas de schedule auto.
    } else {
      throw new Error(`Unknown scheduleKind: ${src.scheduleKind}`);
    }
  }

  /** Public : exécution one-shot (depuis le bouton trigger UI). Resolve
   *  même en cas d'erreur (l'erreur est persistée dans data_jobs). */
  async runOnce(src: DataSource): Promise<void> {
    await this.runCycle(src);
  }

  /** Pour les ticks scheduler internes — fire-and-forget. */
  private runOnceSilent(src: DataSource): void {
    this.runCycle(src).catch(() => {});
  }

  // ─── Cycle : fetch → parse → sink + log job ─────────────────────────
  private async runCycle(src: DataSource): Promise<void> {
    const startedAt = new Date();
    let status: 'ok' | 'partial' | 'error' = 'ok';
    let errorKind: string | undefined;
    let errorMsg: string | undefined;
    let recordsIn = 0;
    let recordsOut = 0;
    let bytesIn = 0;
    let meta: Record<string, unknown> | undefined;

    // Sprint N4 (2026-05-12) : si parser_kind est un des kinds GRIB/NetCDF,
    // on délègue au sidecar Python qui fetch+parse+écrit le GeoTIFF d'un
    // coup, puis on trigger reindex GeoServer si sink_config le précise.
    const sidecarKinds = ['grib_wind10m', 'grib_wave', 'netcdf_sst', 'grib_gfs_multi'];
    if (src.parserKind && sidecarKinds.includes(src.parserKind)) {
      try {
        const result = await this.runSidecarCycle(src);
        bytesIn = result.bytesIn;
        recordsIn = result.recordsIn;
        recordsOut = result.recordsOut;
        status = result.status;
        errorKind = result.errorKind;
        errorMsg = result.errorMsg;
        meta = { kind: src.kind, parserKind: src.parserKind, sinkKind: src.sinkKind, paths: result.paths };
      } catch (err) {
        status = 'error';
        errorKind = (err as Error).name;
        errorMsg = (err as Error).message.slice(0, 500);
        this.logger.warn(`Sidecar cycle ${src.name} failed: ${errorMsg}`);
      } finally {
        await this.persistJob(src, startedAt, status, errorKind, errorMsg,
          recordsIn, recordsOut, bytesIn, meta);
      }
      return;
    }

    try {
      // FETCH
      const fetched = await this.fetch(src);
      bytesIn = fetched.bytes;
      // PARSE
      const records = this.parse(src, fetched.body);
      recordsIn = records.length;
      // SINK
      for (const r of records) {
        try {
          await this.sink(src, r);
          recordsOut++;
        } catch (err) {
          status = 'partial';
          if (!errorMsg) errorMsg = `sink: ${(err as Error).message}`.slice(0, 500);
          if (!errorKind) errorKind = (err as Error).name;
        }
      }
      if (recordsIn > 0 && recordsOut === 0) status = 'error';
      meta = { kind: src.kind, parserKind: src.parserKind, sinkKind: src.sinkKind };
    } catch (err) {
      status = 'error';
      errorKind = (err as Error).name;
      errorMsg = (err as Error).message.slice(0, 500);
      this.logger.warn(`Cycle ${src.name} failed: ${errorMsg}`);
    } finally {
      await this.persistJob(src, startedAt, status, errorKind, errorMsg,
        recordsIn, recordsOut, bytesIn, meta);
    }
  }

  /** Persiste data_jobs + update data_sources + emit SSE event. Extrait
   *  pour être réutilisé par runCycle classique + runSidecarCycle. */
  private async persistJob(
    src: DataSource, startedAt: Date,
    status: 'ok' | 'partial' | 'error',
    errorKind: string | undefined, errorMsg: string | undefined,
    recordsIn: number, recordsOut: number, bytesIn: number,
    meta: Record<string, unknown> | undefined,
  ): Promise<void> {
    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();
    await this.db.insert(dataJobs).values({
      sourceName: src.name,
      status,
      startedAt,
      finishedAt,
      durationMs,
      recordsIn, recordsOut, bytesIn,
      errorKind, errorMsg,
      meta,
    });
    await this.db.update(dataSources)
      .set({ lastRunAt: finishedAt, lastStatus: status })
      .where(eq(dataSources.id, src.id));
    this.emitJobCompleted({
      type: 'job.completed',
      sourceName: src.name,
      status,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs,
      recordsOut,
      errorMsg: errorMsg ?? null,
    });
  }

  // ─── Sidecar GRIB/NetCDF cycle (Sprint N4) ──────────────────────────
  /** Appelle le sidecar Python grib-parser via HTTP POST /parse, puis
   *  trigger un reindex GeoServer si `sink_config.geoserver_store` est
   *  précisé. Retourne les stats du cycle pour persistJob. */
  private async runSidecarCycle(src: DataSource): Promise<{
    bytesIn: number; recordsIn: number; recordsOut: number;
    status: 'ok' | 'partial' | 'error';
    errorKind?: string; errorMsg?: string;
    paths: string[];
  }> {
    // Pour grib_gfs_multi l'URL est ignorée côté sidecar (le sidecar
    // construit lui-même les URLs CGI subsetter NOMADS). On accepte donc
    // une src.url vide pour ce kind (utile pour la DB).
    const isMultiFetch = src.parserKind === 'grib_gfs_multi';
    if (!src.url && !isMultiFetch) throw new Error('url required for sidecar cycle');
    const sinkCfg = (src.sinkConfig ?? {}) as {
      output_dir?: string; output_prefix?: string;
      geoserver_store?: string; geoserver_workspace?: string;
      geoserver_coverage?: string; geoserver_title?: string;
      geoserver_create_if_missing?: boolean;
      valid_time?: string; bbox?: number[];
    };
    if (!sinkCfg.output_dir) throw new Error('sink_config.output_dir required');
    const baseUrl = this.config.get<string>('gribParserUrl') ?? 'http://grib-parser:8500';

    // Expand URL templating ({{today:YYYYMMDD}}, {{today_offset:-2,YYYYMM}}…).
    // Permet aux sources d'avoir une URL stable côté DB malgré une date
    // qui change chaque jour (typique des datasets quotidiens OISST,
    // ARPEGE runs, etc.).
    const expandedUrl = src.url ? this.expandUrlTemplate(src.url, new Date()) : '';

    const payload = {
      url: expandedUrl,
      kind: src.parserKind,
      output_dir: sinkCfg.output_dir,
      output_prefix: sinkCfg.output_prefix ?? src.name,
      valid_time: sinkCfg.valid_time,
      bbox: sinkCfg.bbox,
      // Sprint N5 : pour grib_gfs_multi, fhours[] est dans parser_config.
      // Plus généralement, on pass parser_config through pour que le sidecar
      // puisse lire ses paramètres spécifiques au parser_kind.
      parser_config: src.parserConfig ?? null,
      // Sprint N4 Phase 2 : auto-create du coveragestore GeoServer au 1er
      // cycle, idempotent les fois suivantes (le sidecar check d'abord
      // l'existence via REST).
      geoserver_create_if_missing: sinkCfg.geoserver_create_if_missing,
      geoserver_workspace: sinkCfg.geoserver_workspace ?? 'maritime',
      geoserver_store: sinkCfg.geoserver_store,
      geoserver_coverage: sinkCfg.geoserver_coverage,
      geoserver_title: sinkCfg.geoserver_title,
    };
    const resp = await fetch(`${baseUrl}/parse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(300_000),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Sidecar HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }
    const result = await resp.json() as {
      ok: boolean; paths: string[]; records_out: number; bytes_in: number; error?: string;
    };

    const status: 'ok' | 'partial' | 'error' = result.ok ? 'ok' : 'error';
    const errorMsg = result.error;

    // Sprint N4 Phase 2 : le sidecar Python gère lui-même la création
    // du store + reindex GeoServer (passé via geoserver_create_if_missing
    // dans le payload). Pas besoin de double-job côté runner.

    return {
      bytesIn: result.bytes_in,
      recordsIn: result.ok ? 1 : 0,
      recordsOut: result.records_out,
      status,
      errorMsg,
      paths: result.paths,
    };
  }

  /** Sprint N4 Phase 2 : expand URL template avec dates relatives.
   *
   *  Tokens supportés :
   *    {{today:YYYYMMDD}}            → "20260512" (UTC)
   *    {{today:YYYY-MM-DD}}          → "2026-05-12"
   *    {{today:YYYYMM}}              → "202605"
   *    {{today_offset:N,FORMAT}}     → today + N days (peut être négatif)
   *    {{today_offset:-2,YYYYMMDD}}  → "20260510"
   *
   *  Tout segment qui n'est pas un token reconnu reste tel quel.
   *  L'URL non-templatée passe through (back-compat avec sources
   *  N4 Phase 1 qui ont des URL absolues fixes). */
  private expandUrlTemplate(template: string, now: Date): string {
    return template.replace(/\{\{(today|today_offset):([^}]+)\}\}/g, (_, type, arg) => {
      let date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      let fmt = arg as string;
      if (type === 'today_offset') {
        const [offsetStr, ...fmtParts] = arg.split(',');
        const offset = parseInt(offsetStr, 10);
        if (!isNaN(offset)) date.setUTCDate(date.getUTCDate() + offset);
        fmt = fmtParts.join(',');
      }
      return this.formatDate(date, fmt);
    });
  }

  private formatDate(d: Date, fmt: string): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return fmt
      .replace('YYYY', String(d.getUTCFullYear()))
      .replace('MM', pad(d.getUTCMonth() + 1))
      .replace('DD', pad(d.getUTCDate()))
      .replace('HH', pad(d.getUTCHours()));
  }

  /** POST external.imagemosaic au GeoServer REST pour qu'il indexe le
   *  nouveau GeoTIFF dans le mosaic store time-aware. */
  private async triggerGeoServerReindex(workspace: string, store: string, coverageDir: string): Promise<void> {
    const gsUrl = this.config.get<string>('geoserverUrl');
    const user = this.config.get<string>('geoserverUser') ?? 'admin';
    const pass = this.config.get<string>('geoserverPass') ?? 'geoserver';
    const url = `${gsUrl}/rest/workspaces/${workspace}/coveragestores/${store}/external.imagemosaic`;
    const auth = Buffer.from(`${user}:${pass}`).toString('base64');
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Authorization: `Basic ${auth}` },
      body: coverageDir,
      signal: AbortSignal.timeout(30_000),
    });
    if (![200, 201, 202].includes(resp.status)) {
      throw new Error(`GeoServer reindex HTTP ${resp.status}`);
    }
  }

  // ─── FETCH ──────────────────────────────────────────────────────────
  private async fetch(src: DataSource): Promise<{ body: unknown; bytes: number }> {
    if (src.kind === 'http_json' || src.kind === 'http_wfs' || src.kind === 'http_netcdf') {
      if (!src.url) throw new Error('url required');
      const params = (src.httpParams ?? {}) as Record<string, string>;
      const qs = new URLSearchParams(params).toString();
      const url = qs ? `${src.url}${src.url.includes('?') ? '&' : '?'}${qs}` : src.url;
      const headers = (src.httpHeaders ?? {}) as Record<string, string>;
      const method = (src.httpMethod ?? 'GET') as string;
      const resp = await fetch(url, { method, headers, signal: AbortSignal.timeout(30_000) });
      const text = await resp.text();
      const bytes = new TextEncoder().encode(text).length;
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${text.slice(0, 200)}`);
      // Tentative JSON parse pour les payloads JSON, sinon raw text.
      try { return { body: JSON.parse(text), bytes }; }
      catch { return { body: text, bytes }; }
    }
    throw new Error(`Unsupported fetch kind: ${src.kind}`);
  }

  // ─── PARSE ──────────────────────────────────────────────────────────
  private parse(src: DataSource, body: unknown): unknown[] {
    const kind = src.parserKind ?? 'identity';
    if (kind === 'identity') {
      // Si body est un array, on l'itère. Sinon, on wrap en single-item.
      return Array.isArray(body) ? body : [body];
    }
    if (kind === 'json_path') {
      const cfg = (src.parserConfig ?? {}) as { extractPath?: string };
      const path = cfg.extractPath ?? '$';
      return this.applyJsonPath(body, path);
    }
    if (kind === 'csv') {
      // V2 (2026-05-12) : parser CSV simple. Header sur 1ère ligne, valeurs
      // séparées par virgule (pas de quote handling — KISS pour FIRMS).
      // Auto-cast les valeurs numériques.
      //
      // Options parser_config :
      //   bboxFilter: true  → filtre les rows aux coords lon/lat dans
      //                       src.bbox (string JSON "[minLon,minLat,maxLon,maxLat]").
      //   compositeTime: { dateField, timeField, target } → combine un
      //                       champ date "2026-05-12" + un champ time "0037"
      //                       (HHMM) en un ISO timestamp dans target.
      const cfg = (src.parserConfig ?? {}) as {
        bboxFilter?: boolean;
        compositeTime?: { dateField: string; timeField: string; target: string };
      };
      const text = body as unknown;
      if (typeof text !== 'string') return [];
      const lines = (text as string).trim().split(/\r?\n/);
      if (lines.length < 2) return [];
      const headers = lines[0].split(',').map((h) => h.trim());
      let records = lines.slice(1).map((line) => {
        const values = line.split(',');
        const record: Record<string, unknown> = {};
        headers.forEach((h, i) => {
          const v = values[i]?.trim() ?? '';
          record[h] = v !== '' && !isNaN(+v) ? +v : (v === '' ? null : v);
        });
        return record;
      });
      // Bbox filter
      if (cfg.bboxFilter && src.bbox) {
        try {
          const bbox = JSON.parse(src.bbox) as number[];
          records = records.filter((r) =>
            typeof r['longitude'] === 'number' && typeof r['latitude'] === 'number'
            && (r['longitude'] as number) >= bbox[0] && (r['longitude'] as number) <= bbox[2]
            && (r['latitude'] as number) >= bbox[1] && (r['latitude'] as number) <= bbox[3]
          );
        } catch {}
      }
      // Composite time (date + HHMM → ISO)
      if (cfg.compositeTime) {
        const { dateField, timeField, target } = cfg.compositeTime;
        records.forEach((r) => {
          const d = r[dateField];
          const t = String(r[timeField] ?? '').padStart(4, '0');
          if (typeof d === 'string' && t.length === 4 && /^\d{4}$/.test(t)) {
            r[target] = `${d}T${t.slice(0, 2)}:${t.slice(2, 4)}:00Z`;
          }
        });
      }
      return records;
    }
    if (kind === 'geojson_features') {
      // V2 (2026-05-12) : flatten un GeoJSON FeatureCollection en records
      // plats. Extract `geometry.coordinates[0..2]` → lon, lat, depth.
      // Spread tous les `properties` au top-level + ajoute `id` depuis
      // feature.id. Réutilisable pour tout feed GeoJSON natif (USGS,
      // NOAA, EMSC, etc.).
      //
      // Optionnel : `parser_config.epochMsFields: ['time', 'updated']`
      // convertit ces champs (epoch ms number) en ISO string acceptée
      // par PostgreSQL TIMESTAMPTZ.
      const cfg = (src.parserConfig ?? {}) as { epochMsFields?: string[] };
      const epochFields = new Set(cfg.epochMsFields ?? []);
      const fc = body as { features?: Array<{ id?: string; geometry?: { coordinates?: number[] }; properties?: Record<string, unknown> }> };
      const features = fc?.features ?? [];
      return features.map((f) => {
        const coords = f.geometry?.coordinates ?? [];
        const props = f.properties ?? {};
        const record: Record<string, unknown> = {
          id: f.id ?? null,
          lon: coords[0] ?? null,
          lat: coords[1] ?? null,
          depth: coords[2] ?? null,
        };
        for (const [k, v] of Object.entries(props)) {
          record[k] = (epochFields.has(k) && typeof v === 'number')
            ? new Date(v).toISOString()
            : v;
        }
        return record;
      });
    }
    throw new Error(`Unsupported parser kind: ${kind}`);
  }

  /** Mini-jsonpath : supporte $, $.foo, $.foo.bar, $.foo[*], $.foo[*].bar.
   *  Pour le full jq-like, on passera à un sidecar Python en N4. */
  private applyJsonPath(input: unknown, path: string): unknown[] {
    if (!path || path === '$') return Array.isArray(input) ? input : [input];
    const tokens = path.replace(/^\$\.?/, '').split('.').filter(Boolean);
    let cur: unknown[] = [input];
    for (const tok of tokens) {
      const wildcardMatch = tok.match(/^(.+?)\[\*\]$/);
      const key = wildcardMatch ? wildcardMatch[1] : tok;
      cur = cur.flatMap((node) => {
        if (node == null) return [];
        const v = (node as Record<string, unknown>)[key];
        if (v == null) return [];
        if (wildcardMatch && Array.isArray(v)) return v;
        return [v];
      });
    }
    return cur;
  }

  // ─── SINK ───────────────────────────────────────────────────────────
  private async sink(src: DataSource, record: unknown): Promise<void> {
    const kind = src.sinkKind ?? 'rmq_publish';
    if (kind === 'rmq_publish') {
      if (!this.rmqChannel) throw new Error('RMQ channel not available');
      const cfg = (src.sinkConfig ?? {}) as { exchange?: string; routingKey?: string };
      const exchange = cfg.exchange ?? `orchestrator.${src.name}`;
      const routingKey = cfg.routingKey ?? src.name;
      // Assert exchange à la 1ère fois (idempotent).
      await this.rmqChannel.assertExchange(exchange, 'topic', { durable: true });
      const payload = Buffer.from(JSON.stringify(record));
      this.rmqChannel.publish(exchange, routingKey, payload, {
        contentType: 'application/json', persistent: false,
      });
      return;
    }
    if (kind === 'pg_insert') {
      const cfg = (src.sinkConfig ?? {}) as {
        table?: string;
        columns?: Record<string, string>;
        /** Suffixe ON CONFLICT optionnel — ex: "(ts, icao) DO NOTHING".
         *  Whitelisté caractère par caractère pour éviter SQL injection. */
        onConflict?: string;
        /** V2 (2026-05-12) : srcKeys des champs qui DOIVENT être numériques.
         *  Si la valeur entrante n'est pas un number, on la convertit en
         *  null (au lieu de laisser PG rejeter avec "invalid input syntax").
         *  Typique : METAR wdir = "VRB" quand le vent est variable. */
        nullifyNonNumeric?: string[];
      };
      if (!cfg.table) throw new Error('sinkConfig.table required for pg_insert');
      const cols = cfg.columns ?? {};
      const nullifyNumeric = new Set(cfg.nullifyNonNumeric ?? []);
      const rec = (record ?? {}) as Record<string, unknown>;
      const dbColumns: string[] = [];
      const values: unknown[] = [];
      const placeholders: string[] = [];
      let i = 1;
      for (const [srcKey, dbCol] of Object.entries(cols)) {
        dbColumns.push(this.safeIdent(dbCol));
        let v: unknown = rec[srcKey];
        if (nullifyNumeric.has(srcKey) && v != null && typeof v !== 'number') {
          v = null;
        }
        values.push(v ?? null);
        placeholders.push(`$${i++}`);
      }
      if (dbColumns.length === 0) throw new Error('No columns mapping in sinkConfig');
      const conflict = cfg.onConflict ? ` ON CONFLICT ${this.safeOnConflict(cfg.onConflict)}` : '';
      const sql = `INSERT INTO ${this.safeIdent(cfg.table)} (${dbColumns.join(', ')}) VALUES (${placeholders.join(', ')})${conflict}`;
      // db.execute(rawSql) — Drizzle execute attend du sql tagged. On
      // utilise le client pg direct via $client.
      const pgClient = (this.db as unknown as { $client: { unsafe: (sql: string, params: unknown[]) => Promise<unknown> } }).$client;
      await pgClient.unsafe(sql, values);
      return;
    }
    throw new Error(`Unsupported sink kind: ${kind}`);
  }

  /** Whitelist [a-zA-Z0-9_] pour éviter SQL injection sur les identifiants
   *  dynamiques table/column. Si l'utilisateur a un nom avec caractère
   *  louche, le sink reject. */
  private safeIdent(s: string): string {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s)) {
      throw new Error(`Unsafe SQL identifier: ${s}`);
    }
    return s;
  }

  /** Whitelist ON CONFLICT clauses. Supports patterns comme :
   *    (col1, col2) DO NOTHING
   *    ON CONSTRAINT my_idx DO NOTHING
   *  Caractères autorisés : a-zA-Z0-9_, parenthèses, virgules, espaces, "DO NOTHING". */
  private safeOnConflict(s: string): string {
    if (!/^[a-zA-Z0-9_(),\s]+$/.test(s)) {
      throw new Error(`Unsafe ON CONFLICT clause: ${s}`);
    }
    return s;
  }
}
