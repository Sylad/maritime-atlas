import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { OrchestratorService, type DataJob, type DataSource } from '../../services/orchestrator.service';

/**
 * Data Orchestrator MVP S1 (2026-05-12) — admin page.
 *
 *   /admin/orchestrator
 *
 * Sections :
 *   - "Sources" — table 1 ligne par ingester avec status, sparkline 24h,
 *     toggle enabled (préparation Sprint N2 — orchestration auto).
 *   - "Activité 24h" — graphe agrégé bars par tranches d'1h des derniers
 *     jobs (ok/partial/error en stack vert/orange/rouge).
 *   - "Jobs récents" — DataTable 50 derniers jobs cross-sources (filtre
 *     status + source). Lecture des erreurs au passage.
 */

interface HourBucket {
  hour: number;     // 0..23 = heures depuis maintenant (0 = la plus récente)
  ts: Date;         // début de la tranche
  counts: { ok: number; partial: number; error: number };
}

@Component({
  selector: 'app-admin-orchestrator',
  imports: [DatePipe, DecimalPipe, RouterLink],
  template: `
    <div class="orch-shell">
      <header class="orch-header">
        <h1>Data Orchestrator</h1>
        <a routerLink="/" class="orch-back">← Carte</a>
      </header>

      @if (svc.loading() && svc.sources().length === 0) {
        <div class="orch-loading">Chargement…</div>
      } @else if (svc.errorMsg()) {
        <div class="orch-error">{{ svc.errorMsg() }}</div>
      }

      <!-- ─── Section 1 : graphe agrégé activité 24h ─── -->
      <section class="orch-section">
        <h2>Activité dernières 24h
          <button type="button" class="btn-refresh" (click)="reload()">↻</button>
        </h2>
        <p class="orch-hint">{{ totalLast24h() }} jobs sur les 24 dernières heures.
          Vert = ok · Orange = partial · Rouge = error.</p>
        <div class="orch-chart-wrap">
          <svg [attr.viewBox]="'0 0 ' + chartWidth + ' ' + chartHeight"
               class="orch-chart" preserveAspectRatio="none">
            <!-- Axe Y discret -->
            <line x1="0" [attr.y1]="chartHeight - 0.5"
                  [attr.x2]="chartWidth" [attr.y2]="chartHeight - 0.5"
                  stroke="rgba(255,255,255,0.15)" stroke-width="0.5" />
            @for (b of buckets24h(); track b.hour) {
              <g [attr.transform]="'translate(' + barX(b.hour) + ',0)'">
                <!-- error -->
                @if (b.counts.error > 0) {
                  <rect x="0" [attr.y]="barY(totalForBucket(b))"
                        [attr.width]="barWidth"
                        [attr.height]="barH(b.counts.error)"
                        fill="#dc2626" />
                }
                <!-- partial empilé au-dessus -->
                @if (b.counts.partial > 0) {
                  <rect x="0" [attr.y]="barY(b.counts.ok + b.counts.partial)"
                        [attr.width]="barWidth"
                        [attr.height]="barH(b.counts.partial)"
                        fill="#f59e0b" />
                }
                <!-- ok en haut -->
                @if (b.counts.ok > 0) {
                  <rect x="0" [attr.y]="barY(b.counts.ok)"
                        [attr.width]="barWidth"
                        [attr.height]="barH(b.counts.ok)"
                        fill="#16a34a" />
                }
              </g>
            }
            <!-- Labels heures (tous les 3h) -->
            @for (b of buckets24h(); track b.hour) {
              @if (b.hour % 3 === 0) {
                <text [attr.x]="barX(b.hour) + barWidth/2"
                      [attr.y]="chartHeight - 2"
                      text-anchor="middle"
                      font-size="6" fill="rgba(255,255,255,0.45)"
                      font-family="JetBrains Mono, monospace">
                  -{{ b.hour }}h
                </text>
              }
            }
          </svg>
        </div>
      </section>

      <!-- ─── Section 2 : table sources ─── -->
      <section class="orch-section">
        <h2>Sources ({{ svc.sources().length }})</h2>
        <div class="orch-table-wrap">
          <table class="orch-table">
            <thead>
              <tr>
                <th>Source</th>
                <th>Kind</th>
                <th>Schedule</th>
                <th>Dernière exécution</th>
                <th>Status</th>
                <th>24h (sparkline)</th>
                <th>Enabled</th>
              </tr>
            </thead>
            <tbody>
              @for (src of svc.sources(); track src.id) {
                <tr>
                  <td><strong>{{ src.name }}</strong></td>
                  <td><code>{{ src.kind }}</code></td>
                  <td class="orch-schedule">{{ src.scheduleExpr }}</td>
                  <td class="mono">
                    {{ src.lastRunAt ? (src.lastRunAt | date:'dd/MM HH:mm:ss') : '—' }}
                  </td>
                  <td>
                    @if (src.lastStatus === 'ok') {
                      <span class="pill pill-ok">ok</span>
                    } @else if (src.lastStatus === 'partial') {
                      <span class="pill pill-partial">partial</span>
                    } @else if (src.lastStatus === 'error') {
                      <span class="pill pill-error">error</span>
                    } @else {
                      <span class="pill pill-na">—</span>
                    }
                  </td>
                  <td class="orch-spark-cell">
                    <svg [attr.viewBox]="'0 0 ' + sparkW + ' ' + sparkH"
                         class="orch-spark" preserveAspectRatio="none">
                      @for (b of sparkBuckets(src.name); track b.hour) {
                        @if (totalForBucket(b) > 0) {
                          <rect [attr.x]="sparkX(b.hour)"
                                [attr.y]="sparkY(totalForBucket(b))"
                                [attr.width]="sparkBarWidth"
                                [attr.height]="sparkH - sparkY(totalForBucket(b))"
                                [attr.fill]="sparkColor(b)" />
                        }
                      }
                    </svg>
                  </td>
                  <td>
                    <label class="toggle">
                      <input type="checkbox" [checked]="src.enabled"
                             (change)="onToggle(src, $any($event.target).checked)" />
                      <span></span>
                    </label>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </section>

      <!-- ─── Section 3 : derniers jobs ─── -->
      <section class="orch-section">
        <h2>Jobs récents ({{ recentJobs().length }})</h2>
        <div class="orch-table-wrap">
          <table class="orch-table">
            <thead>
              <tr>
                <th>Source</th>
                <th>Début</th>
                <th>Durée</th>
                <th>Records out</th>
                <th>Status</th>
                <th>Erreur</th>
              </tr>
            </thead>
            <tbody>
              @for (j of recentJobs(); track j.id) {
                <tr [class.is-error]="j.status === 'error'">
                  <td><strong>{{ j.sourceName }}</strong></td>
                  <td class="mono">{{ j.startedAt | date:'dd/MM HH:mm:ss' }}</td>
                  <td class="mono">
                    {{ j.durationMs != null ? ((j.durationMs/1000) | number:'1.1-1') + 's' : '—' }}
                  </td>
                  <td class="mono">{{ j.recordsOut ?? '—' }}</td>
                  <td>
                    @if (j.status === 'ok') { <span class="pill pill-ok">ok</span> }
                    @else if (j.status === 'partial') { <span class="pill pill-partial">partial</span> }
                    @else { <span class="pill pill-error">error</span> }
                  </td>
                  <td class="orch-err">
                    @if (j.errorMsg) {
                      <span [title]="j.errorMsg">{{ j.errorKind }}: {{ j.errorMsg.slice(0, 60) }}</span>
                    } @else { — }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </section>
    </div>
  `,
  styles: `
    .orch-shell {
      padding: 24px;
      max-width: 1400px;
      margin: 0 auto;
      color: #e5e7eb;
      font-family: Inter, system-ui, sans-serif;
    }
    .orch-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
    }
    .orch-header h1 { margin: 0; font-size: 1.6em; font-weight: 600; }
    .orch-back {
      color: #93c5fd;
      text-decoration: none;
      font-size: 0.9em;
    }
    .orch-back:hover { color: #bfdbfe; }
    .orch-section { margin-bottom: 32px; }
    .orch-section h2 {
      font-size: 1.1em;
      font-weight: 500;
      color: #cbd5e1;
      margin: 0 0 8px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .btn-refresh {
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.12);
      color: #cbd5e1;
      padding: 2px 10px;
      cursor: pointer;
      font-size: 0.85em;
      border-radius: 4px;
    }
    .btn-refresh:hover { background: rgba(255,255,255,0.12); }
    .orch-hint { color: #94a3b8; font-size: 0.85em; margin: 4px 0 12px; }
    .orch-loading, .orch-error {
      padding: 16px;
      background: rgba(255,255,255,0.04);
      border-radius: 6px;
      margin-bottom: 16px;
    }
    .orch-error { color: #fca5a5; }
    .orch-chart-wrap {
      background: rgba(15, 23, 42, 0.6);
      padding: 12px;
      border-radius: 6px;
      border: 1px solid rgba(255,255,255,0.06);
    }
    .orch-chart { width: 100%; height: 120px; display: block; }
    .orch-table-wrap {
      background: rgba(15, 23, 42, 0.6);
      border-radius: 6px;
      border: 1px solid rgba(255,255,255,0.06);
      overflow-x: auto;
    }
    .orch-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.9em;
    }
    .orch-table th, .orch-table td {
      padding: 8px 12px;
      text-align: left;
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    .orch-table th {
      font-weight: 500;
      color: #94a3b8;
      background: rgba(255,255,255,0.03);
      font-size: 0.8em;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .orch-table tr:hover { background: rgba(255,255,255,0.03); }
    .orch-table tr.is-error { background: rgba(220, 38, 38, 0.06); }
    .mono { font-family: JetBrains Mono, monospace; font-size: 0.88em; color: #cbd5e1; }
    code { font-family: JetBrains Mono, monospace; font-size: 0.85em; color: #fbbf24; }
    .orch-schedule { color: #94a3b8; font-size: 0.85em; }
    .orch-err {
      color: #fca5a5;
      font-size: 0.82em;
      max-width: 340px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .pill {
      display: inline-block;
      padding: 2px 10px;
      border-radius: 4px;
      font-size: 0.75em;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .pill-ok { background: rgba(22, 163, 74, 0.2); color: #4ade80; }
    .pill-partial { background: rgba(245, 158, 11, 0.2); color: #fbbf24; }
    .pill-error { background: rgba(220, 38, 38, 0.2); color: #f87171; }
    .pill-na { background: rgba(148, 163, 184, 0.15); color: #94a3b8; }
    .orch-spark-cell { width: 120px; }
    .orch-spark { width: 110px; height: 28px; display: block; }
    .toggle {
      position: relative;
      display: inline-block;
      width: 36px;
      height: 18px;
      cursor: pointer;
    }
    .toggle input { display: none; }
    .toggle span {
      position: absolute;
      inset: 0;
      background: rgba(148, 163, 184, 0.35);
      border-radius: 9px;
      transition: background 0.2s;
    }
    .toggle span::before {
      content: '';
      position: absolute;
      left: 2px;
      top: 2px;
      width: 14px;
      height: 14px;
      background: white;
      border-radius: 50%;
      transition: transform 0.2s;
    }
    .toggle input:checked + span { background: #22c55e; }
    .toggle input:checked + span::before { transform: translateX(18px); }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminOrchestratorComponent implements OnInit {
  readonly svc = inject(OrchestratorService);

  // ─── Chart layout constants ────────────────────────────────────────
  readonly chartWidth = 600;
  readonly chartHeight = 120;
  readonly chartMaxH = 100; // height reserved for bars (chartHeight - 20 pour labels)
  readonly barWidth = (this.chartWidth / 24) - 1;
  readonly sparkW = 110;
  readonly sparkH = 28;
  readonly sparkBarWidth = (this.sparkW / 24) - 0.5;

  // ─── Computed: buckets de 1h sur les 24 dernières heures ──────────
  readonly buckets24h = computed<HourBucket[]>(() => {
    const jobs = this.svc.jobs();
    return this.computeBuckets(jobs, /* sourceFilter */ null);
  });

  readonly totalLast24h = computed(() =>
    this.buckets24h().reduce((s, b) => s + this.totalForBucket(b), 0),
  );

  readonly recentJobs = computed<DataJob[]>(() => this.svc.jobs().slice(0, 50));

  /** Max bucket count cross-sources (pour l'échelle Y du graphe principal). */
  private readonly maxBucketTotal = computed(() => {
    const maxByBucket = Math.max(1, ...this.buckets24h().map((b) => this.totalForBucket(b)));
    return maxByBucket;
  });

  /** Max bucket count par-source (pour échelle indépendante des sparklines). */
  private sparkMaxBySource = new Map<string, number>();

  ngOnInit(): void {
    this.svc.loadAll();
    // Auto-refresh toutes les 60s pour suivre les jobs cron qui arrivent.
    setInterval(() => this.svc.loadAll(), 60_000);
  }

  reload(): void {
    this.svc.loadAll();
  }

  async onToggle(src: DataSource, checked: boolean): Promise<void> {
    await this.svc.toggle(src.id, checked);
  }

  // ─── Helpers chart (main) ──────────────────────────────────────────
  totalForBucket(b: HourBucket): number {
    return b.counts.ok + b.counts.partial + b.counts.error;
  }
  barX(hour: number): number {
    // hour=0 (récent) à droite ; hour=23 (vieux) à gauche.
    return (23 - hour) * (this.chartWidth / 24) + 0.5;
  }
  barY(value: number): number {
    const max = this.maxBucketTotal();
    return this.chartMaxH - (this.chartMaxH * value / max);
  }
  barH(value: number): number {
    const max = this.maxBucketTotal();
    return (this.chartMaxH * value / max);
  }

  // ─── Helpers sparkline (per-source) ────────────────────────────────
  sparkBuckets(sourceName: string): HourBucket[] {
    return this.computeBuckets(this.svc.jobs(), sourceName);
  }
  sparkX(hour: number): number {
    return (23 - hour) * (this.sparkW / 24) + 0.25;
  }
  sparkY(value: number): number {
    const max = this.sparkMaxBySource.get('__current__') ?? 1;
    return this.sparkH - (this.sparkH * value / max);
  }
  sparkColor(b: HourBucket): string {
    if (b.counts.error > 0) return '#dc2626';
    if (b.counts.partial > 0) return '#f59e0b';
    return '#16a34a';
  }

  // ─── Compute buckets de 1h ─────────────────────────────────────────
  private computeBuckets(jobs: DataJob[], sourceFilter: string | null): HourBucket[] {
    const now = Date.now();
    const buckets: HourBucket[] = [];
    for (let h = 0; h < 24; h++) {
      buckets.push({
        hour: h,
        ts: new Date(now - h * 3600_000),
        counts: { ok: 0, partial: 0, error: 0 },
      });
    }
    let maxLocal = 1;
    for (const j of jobs) {
      if (sourceFilter && j.sourceName !== sourceFilter) continue;
      const t = new Date(j.startedAt).getTime();
      const ageH = Math.floor((now - t) / 3600_000);
      if (ageH < 0 || ageH >= 24) continue;
      const b = buckets[ageH];
      if (j.status === 'ok') b.counts.ok++;
      else if (j.status === 'partial') b.counts.partial++;
      else if (j.status === 'error') b.counts.error++;
      maxLocal = Math.max(maxLocal, this.totalForBucket(b));
    }
    if (sourceFilter) {
      this.sparkMaxBySource.set('__current__', maxLocal);
    }
    return buckets;
  }
}
