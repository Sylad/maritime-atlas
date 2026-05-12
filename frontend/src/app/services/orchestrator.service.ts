import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

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
    // Pause courte avant de reload : laisser le runner finir + persister.
    setTimeout(() => this.loadAll(), 1500);
  }
}
