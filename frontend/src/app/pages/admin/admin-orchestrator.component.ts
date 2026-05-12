import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { OrchestratorService, type DataJob, type DataSource, type UpsertSourceInput } from '../../services/orchestrator.service';

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
  imports: [DatePipe, DecimalPipe, FormsModule, RouterLink, RouterLinkActive],
  template: `
    <div class="orch-shell">
      <header class="orch-header">
        <h1>Admin</h1>
        <nav class="orch-nav">
          <a routerLink="/admin/users" routerLinkActive="active" class="orch-tab">Utilisateurs</a>
          <a routerLink="/admin/orchestrator" routerLinkActive="active" class="orch-tab">Data Orchestrator</a>
        </nav>
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
          </svg>
          <!-- Axe X en HTML pour ne pas être déformé par preserveAspectRatio
               sur le SVG (font-size SVG explose horizontalement quand on
               étire le viewBox au-delà du CSS width). -->
          <div class="orch-xaxis">
            @for (b of buckets24h(); track b.hour) {
              @if (b.hour % 3 === 0) {
                <span class="orch-xlabel" [style.left.%]="xLabelPct(b.hour)">-{{ b.hour }}h</span>
              }
            }
          </div>
        </div>
      </section>

      <!-- ─── Section 2 : table sources ─── -->
      <section class="orch-section">
        <h2>
          Sources ({{ svc.sources().length }})
          <button type="button" class="btn-create" (click)="openCreate()">+ Nouvelle source</button>
        </h2>
        <p class="orch-hint">
          <span class="legend-self">self-managed</span> = scheduler interne du service
          (legacy, le toggle est informatif). <span class="legend-orch">orchestrator</span> = scheduler dynamique géré ici.
        </p>
        <div class="orch-table-wrap">
          <table class="orch-table">
            <thead>
              <tr>
                <th>Source</th>
                <th>Kind</th>
                <th>Schedule</th>
                <th>Dernière exécution</th>
                <th>Status</th>
                <th>24h</th>
                <th>Exécution</th>
                <th>Actions</th>
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
                    @if (!src.scheduleKind) {
                      <span class="pill pill-self" title="Le service gère son propre scheduler — le toggle est informatif tant qu'on n'a pas migré son exécution vers l'orchestrator">self-managed</span>
                    } @else {
                      <label class="toggle" [title]="src.enabled ? 'Activé · orchestrator schedule' : 'Désactivé'">
                        <input type="checkbox" [checked]="src.enabled"
                               (change)="onToggle(src, $any($event.target).checked)" />
                        <span></span>
                      </label>
                    }
                  </td>
                  <td class="orch-actions">
                    @if (src.scheduleKind) {
                      <button type="button" class="btn-trigger" (click)="onTrigger(src)" title="Trigger une exécution manuelle maintenant">▶</button>
                    } @else {
                      <span class="btn-trigger-disabled" title="Source self-managed — pas de trigger orchestrator possible">▶</span>
                    }
                    <button type="button" class="btn-edit" (click)="openEdit(src)" title="Éditer (passer en mode orchestrator possible ici)">Edit</button>
                    <button type="button" class="btn-delete" (click)="onDelete(src)" title="Supprimer (la source de référence — les data_jobs historiques restent)">×</button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </section>

      <!-- ─── Modal create/edit source ─── -->
      @if (formOpen()) {
        <div class="modal-backdrop" (click)="closeForm()">
          <div class="modal" (click)="$event.stopPropagation()">
            <h3>{{ editingId() ? 'Éditer source' : 'Nouvelle source' }}</h3>
            <div class="form-grid">
              <label>Name<input [(ngModel)]="form.name" placeholder="ex: weather-mongo" /></label>
              <label>Kind
                <select [(ngModel)]="form.kind">
                  <option value="http_json">http_json</option>
                  <option value="http_wfs">http_wfs</option>
                  <option value="http_netcdf">http_netcdf</option>
                </select>
              </label>
              <label>URL<input [(ngModel)]="form.url" placeholder="https://…" /></label>
              <label>Schedule kind
                <select [(ngModel)]="form.scheduleKind">
                  <option value="">— (manual only)</option>
                  <option value="cron">cron</option>
                  <option value="interval">interval</option>
                </select>
              </label>
              @if (form.scheduleKind === 'cron') {
                <label>Cron expr (6 fields)<input [(ngModel)]="form.scheduleExpr" placeholder="0 */15 * * * *" /></label>
              }
              @if (form.scheduleKind === 'interval') {
                <label>Interval (s)<input type="number" [(ngModel)]="form.intervalSeconds" placeholder="60" /></label>
              }
              <label>Parser
                <select [(ngModel)]="form.parserKind">
                  <option value="identity">identity</option>
                  <option value="json_path">json_path</option>
                </select>
              </label>
              @if (form.parserKind === 'json_path') {
                <label>Extract path<input [(ngModel)]="form.parserExtractPath" placeholder="$.features[*]" /></label>
              }
              <label>Sink
                <select [(ngModel)]="form.sinkKind">
                  <option value="rmq_publish">rmq_publish</option>
                  <option value="pg_insert">pg_insert</option>
                </select>
              </label>
              @if (form.sinkKind === 'rmq_publish') {
                <label>RMQ exchange<input [(ngModel)]="form.sinkExchange" placeholder="orchestrator.weather" /></label>
                <label>Routing key<input [(ngModel)]="form.sinkRoutingKey" placeholder="weather.point" /></label>
              }
              @if (form.sinkKind === 'pg_insert') {
                <label>PG table<input [(ngModel)]="form.sinkTable" placeholder="my_table" /></label>
                <label class="span2">Columns mapping (JSON 'srcKey → dbCol')
                  <textarea rows="3" [(ngModel)]="form.sinkColumnsJson"
                            placeholder='{"name": "title", "value": "val"}'></textarea>
                </label>
              }
              <label class="span2 row-checkbox">
                <input type="checkbox" [(ngModel)]="form.enabled" />
                Enabled (le runner schedule cette source)
              </label>
              @if (formError()) {
                <div class="form-error span2">{{ formError() }}</div>
              }
            </div>
            <div class="modal-actions">
              <button type="button" class="btn-cancel" (click)="closeForm()">Annuler</button>
              <button type="button" class="btn-save" (click)="onSave()" [disabled]="saving()">
                {{ saving() ? '…' : 'Enregistrer' }}
              </button>
            </div>
          </div>
        </div>
      }

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
      gap: 1.5em;
      margin-bottom: 24px;
      flex-wrap: wrap;
    }
    .orch-header h1 { margin: 0; font-size: 1.4em; font-weight: 600; color: #fbbf24; font-family: 'JetBrains Mono', monospace; letter-spacing: 0.05em; }
    .orch-nav { display: flex; gap: 0.4em; flex: 1; }
    .orch-tab {
      padding: 0.4em 0.9em;
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 4px;
      color: #94a3b8;
      text-decoration: none;
      font-size: 0.82rem;
      font-family: 'JetBrains Mono', monospace;
      transition: all 150ms;
    }
    .orch-tab:hover { color: #e5e7eb; border-color: #60a5fa; }
    .orch-tab.active { background: #fbbf24; color: #0f172a; border-color: #fbbf24; font-weight: 600; }
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
      padding: 12px 12px 8px;
      border-radius: 6px;
      border: 1px solid rgba(255,255,255,0.06);
    }
    .orch-chart { width: 100%; height: 180px; display: block; }
    /* Axe X rendu en HTML pour ne pas être déformé par preserveAspectRatio
       sur le SVG (le viewBox étire les unités, font-size SVG devient
       énorme horizontalement quand le canvas est large). En HTML, le
       texte garde sa taille réelle quelle que soit la largeur. */
    .orch-xaxis {
      position: relative;
      width: 100%;
      height: 16px;
      margin-top: 4px;
    }
    .orch-xlabel {
      position: absolute;
      top: 0;
      transform: translateX(-50%);
      font-size: 0.7rem;
      color: rgba(255, 255, 255, 0.45);
      font-family: 'JetBrains Mono', monospace;
      white-space: nowrap;
    }
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
      padding: 10px 12px;
      text-align: left;
      vertical-align: middle;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      line-height: 1.5;
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

    /* Pills & legend */
    .pill-self {
      background: rgba(148, 163, 184, 0.15);
      color: #94a3b8;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 0.7em;
      font-family: 'JetBrains Mono', monospace;
      letter-spacing: 0.05em;
      cursor: help;
    }
    .legend-self { color: #94a3b8; padding: 0 2px; }
    .legend-orch { color: #22c55e; padding: 0 2px; }

    /* Action buttons */
    .orch-actions { white-space: nowrap; }
    .orch-actions > * { margin-right: 4px; }
    .orch-noaction { color: #475569; font-size: 0.8em; padding-left: 8px; }
    .btn-create {
      margin-left: 12px;
      padding: 4px 12px;
      background: #16a34a;
      color: white;
      border: 0;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.85em;
    }
    .btn-create:hover { background: #15803d; }
    .btn-trigger, .btn-edit, .btn-delete, .btn-trigger-disabled {
      padding: 3px 8px;
      border: 1px solid rgba(255,255,255,0.12);
      background: rgba(255,255,255,0.04);
      color: #cbd5e1;
      border-radius: 3px;
      cursor: pointer;
      font-size: 0.78em;
      font-family: 'JetBrains Mono', monospace;
      display: inline-block;
      vertical-align: middle;
    }
    .btn-trigger { color: #4ade80; }
    .btn-trigger:hover { background: rgba(22, 163, 74, 0.2); }
    .btn-trigger-disabled { color: #475569; cursor: not-allowed; opacity: 0.4; }
    .btn-edit:hover { background: rgba(96, 165, 250, 0.2); color: #93c5fd; }
    .btn-delete { color: #f87171; }
    .btn-delete:hover { background: rgba(220, 38, 38, 0.2); }

    /* Modal */
    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.65);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }
    .modal {
      background: #0f172a;
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 8px;
      padding: 24px;
      width: min(640px, 95vw);
      max-height: 90vh;
      overflow-y: auto;
      color: #e5e7eb;
    }
    .modal h3 { margin: 0 0 16px; font-size: 1.1em; color: #cbd5e1; }
    .form-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px 16px;
    }
    .form-grid label {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 0.78em;
      color: #94a3b8;
    }
    .form-grid label.span2 { grid-column: 1 / -1; }
    .form-grid input, .form-grid select, .form-grid textarea {
      padding: 6px 10px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.12);
      color: #e5e7eb;
      border-radius: 4px;
      font-family: inherit;
      font-size: 0.88em;
    }
    .form-grid textarea { font-family: 'JetBrains Mono', monospace; font-size: 0.82em; }
    .row-checkbox { flex-direction: row !important; align-items: center; gap: 8px !important; color: #cbd5e1 !important; }
    .form-error {
      color: #fca5a5;
      background: rgba(220, 38, 38, 0.1);
      border: 1px solid rgba(220, 38, 38, 0.3);
      padding: 8px;
      border-radius: 4px;
      font-size: 0.85em;
    }
    .modal-actions {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
      margin-top: 20px;
    }
    .btn-cancel, .btn-save {
      padding: 8px 18px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.88em;
      border: 0;
    }
    .btn-cancel { background: rgba(255,255,255,0.08); color: #cbd5e1; }
    .btn-cancel:hover { background: rgba(255,255,255,0.14); }
    .btn-save { background: #2563eb; color: white; }
    .btn-save:hover { background: #1d4ed8; }
    .btn-save:disabled { opacity: 0.5; cursor: not-allowed; }
  `,
  // OnPush désactivé : la modale utilise ngModel two-way binding (form
  // mutable), incompatible avec OnPush sans wrapper signal par champ.
})
export class AdminOrchestratorComponent implements OnInit {
  readonly svc = inject(OrchestratorService);

  // ─── Chart layout constants ────────────────────────────────────────
  readonly chartWidth = 600;
  readonly chartHeight = 180;
  readonly chartMaxH = 180; // height totale = barres (axe X rendu en HTML, hors viewBox)
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

  // ─── Form state (modal create/edit) ──────────────────────────────
  readonly formOpen = signal(false);
  readonly editingId = signal<number | null>(null);
  readonly saving = signal(false);
  readonly formError = signal<string | null>(null);

  form = this.blankForm();

  private blankForm() {
    return {
      name: '',
      kind: 'http_json',
      url: '',
      scheduleKind: '',
      scheduleExpr: '',
      intervalSeconds: 60 as number | null,
      parserKind: 'identity',
      parserExtractPath: '',
      sinkKind: 'rmq_publish',
      sinkExchange: '',
      sinkRoutingKey: '',
      sinkTable: '',
      sinkColumnsJson: '',
      enabled: false,
    };
  }

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

  openCreate(): void {
    this.form = this.blankForm();
    this.editingId.set(null);
    this.formError.set(null);
    this.formOpen.set(true);
  }

  openEdit(src: DataSource): void {
    this.form = {
      name: src.name,
      kind: src.kind,
      url: src.url ?? '',
      scheduleKind: src.scheduleKind ?? '',
      scheduleExpr: src.scheduleExpr ?? '',
      intervalSeconds: src.intervalSeconds ?? 60,
      parserKind: src.parserKind ?? 'identity',
      parserExtractPath: (src.parserConfig as { extractPath?: string } | null)?.extractPath ?? '',
      sinkKind: src.sinkKind ?? 'rmq_publish',
      sinkExchange: (src.sinkConfig as { exchange?: string } | null)?.exchange ?? '',
      sinkRoutingKey: (src.sinkConfig as { routingKey?: string } | null)?.routingKey ?? '',
      sinkTable: (src.sinkConfig as { table?: string } | null)?.table ?? '',
      sinkColumnsJson: JSON.stringify((src.sinkConfig as { columns?: object } | null)?.columns ?? {}, null, 2),
      enabled: src.enabled,
    };
    this.editingId.set(src.id);
    this.formError.set(null);
    this.formOpen.set(true);
  }

  closeForm(): void {
    this.formOpen.set(false);
  }

  async onSave(): Promise<void> {
    this.formError.set(null);
    this.saving.set(true);
    try {
      const payload: UpsertSourceInput = {
        name: this.form.name.trim(),
        kind: this.form.kind,
        url: this.form.url.trim() || undefined,
        scheduleKind: this.form.scheduleKind || undefined,
        scheduleExpr: this.form.scheduleExpr.trim() || undefined,
        intervalSeconds: this.form.scheduleKind === 'interval' ? Number(this.form.intervalSeconds) : undefined,
        parserKind: this.form.parserKind,
        parserConfig: this.form.parserKind === 'json_path' && this.form.parserExtractPath
          ? { extractPath: this.form.parserExtractPath }
          : undefined,
        sinkKind: this.form.sinkKind,
        sinkConfig: this.buildSinkConfig(),
        enabled: this.form.enabled,
      };
      if (this.editingId() != null) {
        await this.svc.update(this.editingId()!, payload);
      } else {
        await this.svc.create(payload);
      }
      this.closeForm();
    } catch (err: any) {
      const msg = err?.error?.message ?? err?.message ?? 'Erreur';
      this.formError.set(Array.isArray(msg) ? msg.join(' · ') : String(msg));
    } finally {
      this.saving.set(false);
    }
  }

  private buildSinkConfig(): Record<string, unknown> | undefined {
    if (this.form.sinkKind === 'rmq_publish') {
      const exchange = this.form.sinkExchange.trim();
      const routingKey = this.form.sinkRoutingKey.trim();
      if (!exchange && !routingKey) return undefined;
      return { exchange, routingKey };
    }
    if (this.form.sinkKind === 'pg_insert') {
      const table = this.form.sinkTable.trim();
      let columns: Record<string, string> = {};
      try {
        columns = this.form.sinkColumnsJson.trim()
          ? JSON.parse(this.form.sinkColumnsJson)
          : {};
      } catch {
        throw new Error('Colonnes JSON invalides');
      }
      return { table, columns };
    }
    return undefined;
  }

  async onDelete(src: DataSource): Promise<void> {
    if (!confirm(`Supprimer la source "${src.name}" ? (jobs historiques préservés)`)) return;
    try {
      await this.svc.remove(src.id);
    } catch (err: any) {
      alert(`Erreur suppression: ${err?.error?.message ?? err?.message ?? err}`);
    }
  }

  async onTrigger(src: DataSource): Promise<void> {
    try {
      await this.svc.trigger(src.id);
    } catch (err: any) {
      alert(`Erreur trigger: ${err?.error?.message ?? err?.message ?? err}`);
    }
  }

  // ─── Helpers chart (main) ──────────────────────────────────────────
  totalForBucket(b: HourBucket): number {
    return b.counts.ok + b.counts.partial + b.counts.error;
  }
  barX(hour: number): number {
    // hour=0 (récent) à droite ; hour=23 (vieux) à gauche.
    return (23 - hour) * (this.chartWidth / 24) + 0.5;
  }

  /** Position du label axe X en % du wrapper (HTML, pas SVG) — centré
   *  sur le milieu de la barre correspondante. */
  xLabelPct(hour: number): number {
    const barCenterUnits = (23 - hour) * (this.chartWidth / 24) + this.barWidth / 2 + 0.5;
    return (barCenterUnits / this.chartWidth) * 100;
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
