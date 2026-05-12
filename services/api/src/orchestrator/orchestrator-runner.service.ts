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
    const sidecarKinds = ['grib_wind10m', 'grib_wave', 'netcdf_sst'];
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
    if (!src.url) throw new Error('url required for sidecar cycle');
    const sinkCfg = (src.sinkConfig ?? {}) as {
      output_dir?: string; output_prefix?: string;
      geoserver_store?: string; geoserver_workspace?: string;
      valid_time?: string; bbox?: number[];
    };
    if (!sinkCfg.output_dir) throw new Error('sink_config.output_dir required');
    const baseUrl = this.config.get<string>('gribParserUrl') ?? 'http://grib-parser:8500';

    const payload = {
      url: src.url,
      kind: src.parserKind,
      output_dir: sinkCfg.output_dir,
      output_prefix: sinkCfg.output_prefix ?? src.name,
      valid_time: sinkCfg.valid_time,
      bbox: sinkCfg.bbox,
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

    let status: 'ok' | 'partial' | 'error' = result.ok ? 'ok' : 'error';
    const errorMsg = result.error;

    // Optionnel : trigger reindex GeoServer si le sink précise un store.
    if (result.ok && sinkCfg.geoserver_store && this.config.get<string>('geoserverUrl')) {
      try {
        await this.triggerGeoServerReindex(
          sinkCfg.geoserver_workspace ?? 'maritime',
          sinkCfg.geoserver_store,
          sinkCfg.output_dir,
        );
      } catch (err) {
        status = 'partial';
      }
    }

    return {
      bytesIn: result.bytes_in,
      recordsIn: result.ok ? 1 : 0,
      recordsOut: result.records_out,
      status,
      errorMsg,
      paths: result.paths,
    };
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
      const cfg = (src.sinkConfig ?? {}) as { table?: string; columns?: Record<string, string> };
      if (!cfg.table) throw new Error('sinkConfig.table required for pg_insert');
      const cols = cfg.columns ?? {};
      const rec = (record ?? {}) as Record<string, unknown>;
      const dbColumns: string[] = [];
      const values: unknown[] = [];
      const placeholders: string[] = [];
      let i = 1;
      for (const [srcKey, dbCol] of Object.entries(cols)) {
        dbColumns.push(this.safeIdent(dbCol));
        values.push(rec[srcKey] ?? null);
        placeholders.push(`$${i++}`);
      }
      if (dbColumns.length === 0) throw new Error('No columns mapping in sinkConfig');
      const sql = `INSERT INTO ${this.safeIdent(cfg.table)} (${dbColumns.join(', ')}) VALUES (${placeholders.join(', ')})`;
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
}
