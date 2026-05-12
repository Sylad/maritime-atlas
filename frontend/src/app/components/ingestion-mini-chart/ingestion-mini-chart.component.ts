import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

interface PublicActivityPoint {
  hour: number;     // 0 = dernière heure révolue, 23 = il y a ~24h
  total: number;
  ok: number;
  error: number;
}

/**
 * Mini-graph "santé ingestion" visible par tous (anonymous + connectés).
 * Récupère `/api/orchestrator/activity-24h` toutes les 2 min — endpoint
 * public anonymisé (pas de noms de sources). Rendu SVG inline 24 barres,
 * ok vert / error rouge stacké.
 *
 * Pensé pour aller dans le `.legend-subtitle` zone (sidebar gauche map)
 * comme signal de vitalité de la stack.
 */
@Component({
  selector: 'app-ingestion-mini-chart',
  standalone: true,
  template: `
    <div class="mini-wrap" [title]="tooltipText()">
      <svg viewBox="0 0 120 24" class="mini-svg" preserveAspectRatio="none">
        @for (p of points(); track p.hour) {
          @if (p.total > 0) {
            <!-- Erreur en bas (empilage classique) -->
            @if (p.error > 0) {
              <rect [attr.x]="x(p.hour)" [attr.y]="yError(p)"
                    [attr.width]="barW" [attr.height]="hError(p)"
                    fill="#dc2626" />
            }
            <!-- OK en haut -->
            @if (p.ok > 0) {
              <rect [attr.x]="x(p.hour)" [attr.y]="yOk(p)"
                    [attr.width]="barW" [attr.height]="hOk(p)"
                    fill="#16a34a" />
            }
          }
        }
      </svg>
      <div class="mini-label">
        <span class="mini-count">{{ total24h() }}</span> jobs / 24h
        @if (errorCount() > 0) {
          <span class="mini-err">· {{ errorCount() }} err</span>
        }
      </div>
    </div>
  `,
  styles: `
    .mini-wrap {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 4px 0 2px;
      width: 100%;
      cursor: help;
    }
    .mini-svg {
      width: 100%;
      height: 18px;
      display: block;
    }
    .mini-label {
      font-size: 0.65rem;
      color: rgba(255, 255, 255, 0.45);
      font-family: 'JetBrains Mono', monospace;
      display: flex;
      gap: 4px;
      align-items: baseline;
    }
    .mini-count { color: rgba(74, 222, 128, 0.9); font-weight: 600; }
    .mini-err { color: rgba(248, 113, 113, 0.85); }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class IngestionMiniChartComponent implements OnInit, OnDestroy {
  private readonly http = inject(HttpClient);
  private timer?: ReturnType<typeof setInterval>;

  readonly points = signal<PublicActivityPoint[]>([]);
  readonly barW = 4.5;
  private readonly chartH = 18;

  readonly total24h = computed(() => this.points().reduce((s, p) => s + p.total, 0));
  readonly errorCount = computed(() => this.points().reduce((s, p) => s + p.error, 0));
  readonly maxBucket = computed(() => Math.max(1, ...this.points().map((p) => p.total)));

  readonly tooltipText = computed(() => {
    const t = this.total24h();
    const e = this.errorCount();
    return `Ingestion 24h: ${t} jobs (${e} erreurs). Mise à jour /2 min.`;
  });

  ngOnInit(): void {
    this.load();
    this.timer = setInterval(() => this.load(), 120_000);
  }

  ngOnDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async load(): Promise<void> {
    try {
      const data = await firstValueFrom(
        this.http.get<PublicActivityPoint[]>('/api/orchestrator/activity-24h'),
      );
      this.points.set(data);
    } catch {
      // Fail-silent : on garde le dernier state, le visuel reste sans
      // afficher d'erreur explicite (composant secondaire).
    }
  }

  // hour=0 = dernière heure révolue → à droite ; hour=23 = vieux → à gauche
  x(hour: number): number {
    return (23 - hour) * 5 + 0.5;
  }
  hError(p: PublicActivityPoint): number {
    return (this.chartH * p.error) / this.maxBucket();
  }
  yError(p: PublicActivityPoint): number {
    return this.chartH - this.hError(p);
  }
  hOk(p: PublicActivityPoint): number {
    return (this.chartH * p.ok) / this.maxBucket();
  }
  yOk(p: PublicActivityPoint): number {
    return this.chartH - this.hError(p) - this.hOk(p);
  }
}
