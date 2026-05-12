import { HttpClient } from '@angular/common/http';
import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

/** Event SSE poussé par l'orchestrator quand un job est persisté. */
export interface JobStreamEvent {
  type: 'job.completed' | 'heartbeat';
  sourceName?: string;
  status?: 'ok' | 'partial' | 'error';
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number | null;
  recordsOut?: number | null;
  errorMsg?: string | null;
  ts?: string; // pour heartbeat
}

export interface DataSource {
  id: number;
  name: string;
  kind: string;
  url: string | null;
  scheduleExpr: string | null;
  sinkLabel: string | null;
  bbox: string | null;
  enabled: boolean;
  lastRunAt: string | null;
  lastStatus: 'ok' | 'partial' | 'error' | null;
  createdAt: string;
  // N2 additions
  scheduleKind: 'cron' | 'interval' | 'once' | null;
  intervalSeconds: number | null;
  httpMethod: string | null;
  httpHeaders: Record<string, string> | null;
  httpParams: Record<string, string> | null;
  parserKind: 'identity' | 'json_path' | 'grib' | null;
  parserConfig: Record<string, unknown> | null;
  sinkKind: 'pg_insert' | 'rmq_publish' | 'geotiff_volume' | null;
  sinkConfig: Record<string, unknown> | null;
  updatedAt: string | null;
}

export interface DataJob {
  id: number;
  sourceName: string;
  status: 'ok' | 'partial' | 'error';
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  recordsIn: number | null;
  recordsOut: number | null;
  bytesIn: number | null;
  errorKind: string | null;
  errorMsg: string | null;
  meta: Record<string, unknown> | null;
}

export interface UpsertSourceInput {
  name: string;
  kind: string;
  url?: string;
  scheduleExpr?: string;
  scheduleKind?: string;
  intervalSeconds?: number;
  httpMethod?: string;
  httpHeaders?: Record<string, string>;
  httpParams?: Record<string, string>;
  parserKind?: string;
  parserConfig?: Record<string, unknown>;
  sinkKind?: string;
  sinkConfig?: Record<string, unknown>;
  bbox?: string;
  sinkLabel?: string;
  enabled?: boolean;
}

@Injectable({ providedIn: 'root' })
export class OrchestratorService {
  private readonly http = inject(HttpClient);

  readonly sources = signal<DataSource[]>([]);
  readonly jobs = signal<DataJob[]>([]);
  readonly loading = signal(false);
  readonly errorMsg = signal<string | null>(null);
  readonly streamConnected = signal(false);
  readonly lastEventAt = signal<Date | null>(null);

  private es?: EventSource;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectDelay = 1000;
  private readonly MAX_RECONNECT_DELAY = 30_000;

  async loadAll(): Promise<void> {
    this.loading.set(true);
    this.errorMsg.set(null);
    try {
      const [sources, jobs] = await Promise.all([
        firstValueFrom(this.http.get<DataSource[]>('/api/admin/sources')),
        firstValueFrom(this.http.get<DataJob[]>('/api/admin/jobs?limit=500')),
      ]);
      this.sources.set(sources);
      this.jobs.set(jobs);
    } catch (err: any) {
      this.errorMsg.set(err?.error?.message ?? err?.message ?? 'Erreur orchestrator');
    } finally {
      this.loading.set(false);
    }
  }

  async toggle(id: number, enabled: boolean): Promise<void> {
    await firstValueFrom(
      this.http.patch<DataSource>(`/api/admin/sources/${id}`, { enabled }),
    );
    await this.loadAll();
  }

  async create(payload: UpsertSourceInput): Promise<DataSource> {
    const created = await firstValueFrom(
      this.http.post<DataSource>('/api/admin/sources', payload),
    );
    await this.loadAll();
    return created;
  }

  async update(id: number, payload: UpsertSourceInput): Promise<DataSource> {
    const updated = await firstValueFrom(
      this.http.put<DataSource>(`/api/admin/sources/${id}`, payload),
    );
    await this.loadAll();
    return updated;
  }

  async remove(id: number): Promise<void> {
    await firstValueFrom(
      this.http.delete<{ ok: boolean }>(`/api/admin/sources/${id}`),
    );
    await this.loadAll();
  }

  async trigger(id: number): Promise<void> {
    await firstValueFrom(
      this.http.post<{ ok: boolean }>(`/api/admin/sources/${id}/trigger`, {}),
    );
    // En SSE mode, le job apparaîtra via le stream — pas besoin de reload.
    // Si le stream n'est pas connecté (auth perdu ou réseau), on reload
    // quand même après 1.5s pour rester safe.
    if (!this.streamConnected()) {
      setTimeout(() => this.loadAll(), 1500);
    }
  }

  /**
   * Connecte le stream SSE `/api/admin/orchestrator/events?token=<jwt>`.
   * Reconnect avec backoff exponentiel si la connexion tombe. À appeler
   * depuis le component admin (ngOnInit) avec le JWT courant, et
   * `disconnectStream()` à ngOnDestroy.
   */
  connectStream(jwtToken: string): void {
    this.disconnectStream();
    const url = `/api/admin/orchestrator/events?token=${encodeURIComponent(jwtToken)}`;
    const es = new EventSource(url);
    this.es = es;

    es.onopen = () => {
      this.streamConnected.set(true);
      this.reconnectDelay = 1000;
    };

    es.onmessage = (msg) => {
      this.lastEventAt.set(new Date());
      try {
        const ev = JSON.parse(msg.data) as JobStreamEvent;
        if (ev.type === 'heartbeat') return;
        if (ev.type === 'job.completed') this.applyJobEvent(ev);
      } catch {
        // ignore malformed
      }
    };

    es.onerror = () => {
      this.streamConnected.set(false);
      es.close();
      this.es = undefined;
      // Backoff exponentiel jusqu'à 30s max — couvre les redémarrages
      // d'api (rebuild docker compose) sans bombarder le serveur.
      this.reconnectTimer = setTimeout(
        () => this.connectStream(jwtToken),
        this.reconnectDelay,
      );
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.MAX_RECONNECT_DELAY);
    };
  }

  disconnectStream(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.es) {
      this.es.close();
      this.es = undefined;
    }
    this.streamConnected.set(false);
  }

  /** Met à jour les signals locaux sans refetch HTTP : prepend le job
   *  au début de `jobs()`, et update la source correspondante avec
   *  last_run_at + last_status. */
  private applyJobEvent(ev: JobStreamEvent): void {
    if (!ev.sourceName || !ev.startedAt || !ev.status) return;
    const newJob: DataJob = {
      id: Math.floor(Math.random() * 1e9), // placeholder — le refetch alignera
      sourceName: ev.sourceName,
      status: ev.status,
      startedAt: ev.startedAt,
      finishedAt: ev.finishedAt ?? null,
      durationMs: ev.durationMs ?? null,
      recordsIn: null,
      recordsOut: ev.recordsOut ?? null,
      bytesIn: null,
      errorKind: null,
      errorMsg: ev.errorMsg ?? null,
      meta: null,
    };
    // Prepend + cap à 500 (l'historique long se reload via loadAll()).
    this.jobs.update((arr) => [newJob, ...arr].slice(0, 500));
    // Update last_run_at / last_status de la source.
    this.sources.update((arr) =>
      arr.map((s) =>
        s.name === ev.sourceName
          ? { ...s, lastRunAt: ev.finishedAt ?? s.lastRunAt, lastStatus: ev.status ?? s.lastStatus }
          : s,
      ),
    );
  }
}
