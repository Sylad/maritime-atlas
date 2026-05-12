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
}
