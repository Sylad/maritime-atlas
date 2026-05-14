import {
  ChangeDetectionStrategy,
  Component,
  computed,
  EventEmitter,
  Input,
  Output,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  AnimationDirection,
  AnimationDuration,
  AnimationOptions,
  AnimationSpeed,
} from '../../services/animation-player.service';

/**
 * Animation Panel — popup compact qui collecte les options d'animation
 * (durée, direction, vitesse, loop, suivi temps réel) et émet un event
 * `launch` quand l'utilisateur clique Lancer.
 *
 * Visuel : carte centrée avec border claude-cyan (cohérent avec la
 * legend.data-catalog du map). Animation d'apparition fade + scale.
 */
@Component({
  selector: 'app-animation-panel',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ap-backdrop" (click)="onCancel()"></div>

    <div class="ap-modal" role="dialog" aria-modal="true" aria-label="Configurer animation">
      <header class="ap-head">
        <span class="ap-title">▶ Animation</span>
        <button type="button" class="ap-close" (click)="onCancel()" aria-label="Fermer">×</button>
      </header>

      <div class="ap-body">
        <!-- Master layer info -->
        @if (masterLayerLabel) {
          <section class="ap-master">
            <span class="ap-master-icon">⏱</span>
            <div>
              <div class="ap-master-label">Maître du temps</div>
              <div class="ap-master-value">{{ masterLayerLabel }}</div>
              <small class="ap-hint">L'animation parcourt les dates pour lesquelles cette couche a des données. Les autres couches s'adaptent au plus proche.</small>
            </div>
          </section>
        }

        <!-- Durée -->
        <section class="ap-group">
          <div class="ap-label">Durée</div>
          <div class="ap-grid-2">
            @for (d of durations; track d.value) {
              <button type="button"
                      class="ap-btn"
                      [class.is-active]="duration() === d.value"
                      (click)="duration.set(d.value)">
                {{ d.label }}
                <small>{{ d.frames }} frames</small>
              </button>
            }
          </div>
        </section>

        <!-- Direction -->
        <section class="ap-group">
          <div class="ap-label">Direction</div>
          <div class="ap-row">
            @for (d of directions; track d.value) {
              <button type="button"
                      class="ap-btn ap-btn-narrow"
                      [class.is-active]="direction() === d.value"
                      (click)="direction.set(d.value)">
                {{ d.label }}
              </button>
            }
          </div>
          <small class="ap-hint">
            @if (direction() === 'auto') {
              {{ forecastActive ? 'Auto → futur (forecast active)' : 'Auto → passé' }}
            } @else if (direction() === 'past') {
              de {{ anchorIso }} vers {{ rangeStartIso() }}
            } @else {
              de {{ anchorIso }} vers {{ rangeEndIso() }}
            }
          </small>
        </section>

        <!-- Vitesse -->
        <section class="ap-group">
          <div class="ap-label">Vitesse</div>
          <div class="ap-row">
            @for (s of speeds; track s) {
              <button type="button"
                      class="ap-btn ap-btn-narrow"
                      [class.is-active]="speed() === s"
                      (click)="speed.set(s)">
                {{ s }}×
              </button>
            }
          </div>
          <small class="ap-hint">{{ speedHint() }}</small>
        </section>

        <!-- Step (info only) -->
        <section class="ap-group ap-group-info">
          <div class="ap-label">Step</div>
          <div class="ap-value">1 heure (arrondie)</div>
          <small class="ap-hint">Match la granularité native des modèles forecast.</small>
        </section>

        <!-- Toggles -->
        <section class="ap-group ap-toggles">
          <label class="ap-toggle">
            <input type="checkbox" [checked]="loop()" (change)="loop.set($any($event.target).checked)" />
            <span>Boucle infinie 🔁</span>
          </label>
          <label class="ap-toggle">
            <input type="checkbox" [checked]="followRealTime()" (change)="followRealTime.set($any($event.target).checked)" />
            <span>Suivre temps réel 🔄</span>
            <small>Rafraîchit la fenêtre à chaque boucle pour intégrer les nouvelles données ingérées.</small>
          </label>
        </section>
      </div>

      <footer class="ap-foot">
        <button type="button" class="ap-cancel" (click)="onCancel()">Annuler</button>
        <button type="button" class="ap-launch" (click)="onLaunch()">▶ Lancer</button>
      </footer>
    </div>
  `,
  styles: [`
    :host {
      position: fixed;
      inset: 0;
      z-index: 1000;
      pointer-events: none;
    }
    .ap-backdrop {
      position: absolute;
      inset: 0;
      background: rgba(0, 0, 0, 0.55);
      backdrop-filter: blur(4px);
      pointer-events: auto;
      animation: fade 180ms ease-out;
    }
    .ap-modal {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: min(420px, 92vw);
      max-height: 88vh;
      overflow-y: auto;
      background: rgb(15, 23, 42);
      border: 1px solid hsl(224 85% 55% / 0.5);
      border-radius: 10px;
      box-shadow:
        0 0 0 1px hsl(224 95% 60% / 0.2),
        0 0 16px 1px hsl(224 95% 60% / 0.26),
        0 0 40px 6px hsl(224 90% 55% / 0.18),
        0 14px 40px -10px rgba(0, 0, 0, 0.8);
      pointer-events: auto;
      animation: pop 220ms cubic-bezier(0.2, 0.9, 0.3, 1.1);
      color: var(--fg, #e8e6e3);
      font-family: inherit;
    }
    @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
    @keyframes pop {
      from { opacity: 0; transform: translate(-50%, -46%) scale(0.96); }
      to   { opacity: 1; transform: translate(-50%, -50%) scale(1); }
    }
    .ap-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.9em 1.2em;
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    .ap-title {
      font-family: var(--font-mono, monospace);
      font-size: 0.85rem;
      letter-spacing: 0.15em;
      color: var(--accent, #67e8f9);
      text-transform: uppercase;
      font-weight: 700;
    }
    .ap-close {
      background: transparent;
      border: 0;
      color: var(--fg-muted, #a8a29e);
      font-size: 1.4rem;
      cursor: pointer;
      line-height: 1;
      padding: 0 0.2em;
    }
    .ap-close:hover { color: var(--fg, #e8e6e3); }
    .ap-body {
      padding: 1.2em;
      display: flex;
      flex-direction: column;
      gap: 1.2em;
    }
    .ap-group { display: flex; flex-direction: column; gap: 0.5em; }
    .ap-master {
      display: flex;
      gap: 0.7em;
      align-items: flex-start;
      padding: 0.7em 0.9em;
      background: hsl(224 80% 50% / 0.10);
      border: 1px solid hsl(224 95% 60% / 0.45);
      border-radius: 8px;
      box-shadow: 0 0 18px hsl(224 95% 60% / 0.20) inset;
    }
    .ap-master-icon {
      font-size: 1.3rem;
      line-height: 1;
      filter: drop-shadow(0 0 8px hsl(224 95% 60% / 0.8));
      font-variant-emoji: text;
    }
    .ap-master-label {
      font-family: var(--font-mono, monospace);
      font-size: 0.65rem;
      letter-spacing: 0.15em;
      text-transform: uppercase;
      color: var(--accent, #67e8f9);
      opacity: 0.85;
    }
    .ap-master-value {
      font-size: 0.95rem;
      color: var(--fg, #e8e6e3);
      font-weight: 600;
      margin: 2px 0 4px;
    }
    .ap-label {
      font-family: var(--font-mono, monospace);
      font-size: 0.7rem;
      letter-spacing: 0.15em;
      text-transform: uppercase;
      color: var(--accent, #67e8f9);
      opacity: 0.85;
    }
    .ap-grid-2 {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 0.45em;
    }
    .ap-row {
      display: flex;
      gap: 0.45em;
      flex-wrap: wrap;
    }
    .ap-btn {
      flex: 1 1 auto;
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.08);
      color: var(--fg, #e8e6e3);
      padding: 0.6em 0.8em;
      border-radius: 6px;
      cursor: pointer;
      font: inherit;
      transition: all 120ms ease-out;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
      min-height: 2.6em;
    }
    .ap-btn-narrow {
      flex-direction: row;
      justify-content: center;
      min-height: 2.2em;
    }
    .ap-btn small {
      font-size: 0.65rem;
      color: var(--fg-muted, #a8a29e);
    }
    .ap-btn:hover {
      border-color: hsl(224 85% 55% / 0.6);
      background: rgba(255,255,255,0.06);
    }
    .ap-btn.is-active {
      border-color: hsl(224 95% 60% / 0.9);
      background: hsl(224 80% 50% / 0.18);
      box-shadow: 0 0 12px hsl(224 95% 60% / 0.25) inset;
    }
    .ap-btn.is-active small { color: var(--fg, #e8e6e3); }
    .ap-hint {
      color: var(--fg-muted, #a8a29e);
      font-size: 0.72rem;
      line-height: 1.4;
    }
    .ap-value {
      font-size: 0.9rem;
      color: var(--fg, #e8e6e3);
    }
    .ap-toggles { gap: 0.7em; }
    .ap-toggle {
      display: flex;
      align-items: center;
      gap: 0.5em;
      cursor: pointer;
      font-size: 0.85rem;
      flex-wrap: wrap;
    }
    .ap-toggle small {
      flex-basis: 100%;
      font-size: 0.7rem;
      color: var(--fg-muted, #a8a29e);
      padding-left: 1.6em;
    }
    .ap-toggle input { accent-color: hsl(224 95% 60%); }
    .ap-foot {
      display: flex;
      justify-content: flex-end;
      gap: 0.6em;
      padding: 1em 1.2em;
      border-top: 1px solid rgba(255,255,255,0.06);
    }
    .ap-cancel, .ap-launch {
      padding: 0.6em 1.2em;
      border-radius: 6px;
      border: 1px solid rgba(255,255,255,0.08);
      cursor: pointer;
      font: inherit;
      transition: all 120ms ease-out;
    }
    .ap-cancel {
      background: transparent;
      color: var(--fg-muted, #a8a29e);
    }
    .ap-cancel:hover {
      color: var(--fg, #e8e6e3);
      border-color: rgba(255,255,255,0.2);
    }
    .ap-launch {
      background: linear-gradient(180deg, hsl(224 80% 55%), hsl(224 85% 45%));
      border-color: hsl(224 95% 60% / 0.6);
      color: white;
      font-weight: 600;
      box-shadow: 0 4px 16px hsl(224 90% 50% / 0.4);
    }
    .ap-launch:hover {
      filter: brightness(1.1);
      box-shadow: 0 6px 20px hsl(224 90% 50% / 0.55);
    }
  `],
})
export class AnimationPanelComponent {
  /** Date courante du slider — utilisée comme ancre par défaut. */
  @Input({ required: true }) anchor!: Date;

  /** Indique s'il y a au moins une couche forecast active actuellement.
   *  Sert au mode "Auto" pour choisir past vs future. */
  @Input() forecastActive = false;

  /** Phase 1 v2 : nom du "layer maître du temps" actuel. Affiché dans
   *  la modal pour que l'user sache quel layer pilote la séquence de
   *  timestamps. null = aucun layer animable actif. */
  @Input() masterLayerLabel: string | null = null;

  @Output() launch = new EventEmitter<AnimationOptions>();
  @Output() cancel = new EventEmitter<void>();

  // ── Form state (signals) ─────────────────────────────────────────
  readonly duration = signal<AnimationDuration>('24h');
  readonly direction = signal<AnimationDirection>('auto');
  readonly speed = signal<AnimationSpeed>(4);
  readonly loop = signal<boolean>(true);
  readonly followRealTime = signal<boolean>(true);

  // ── Constants ────────────────────────────────────────────────────
  readonly durations: Array<{ value: AnimationDuration; label: string; frames: number }> = [
    { value: '6h',  label: '6 heures',  frames: 6 },
    { value: '24h', label: '24 heures', frames: 24 },
    { value: '3d',  label: '3 jours',   frames: 72 },
    { value: '7d',  label: '7 jours',   frames: 168 },
  ];

  readonly directions: Array<{ value: AnimationDirection; label: string }> = [
    { value: 'auto',   label: 'Auto' },
    { value: 'past',   label: '⏪ Passé' },
    { value: 'future', label: '⏩ Futur' },
  ];

  readonly speeds: AnimationSpeed[] = [1, 2, 4, 8];

  // ── Computed previews ────────────────────────────────────────────
  readonly anchorIso = ''; // sera ré-calculé ci-dessous

  readonly rangeStartIso = computed<string>(() => {
    const hours = this.durationHours();
    const start = new Date(this.anchor.getTime() - hours * 3_600_000);
    return formatIsoShort(start);
  });

  readonly rangeEndIso = computed<string>(() => {
    const hours = this.durationHours();
    const end = new Date(this.anchor.getTime() + hours * 3_600_000);
    return formatIsoShort(end);
  });

  readonly speedHint = computed<string>(() => {
    const ms = this.speedMs();
    const framesPerSec = 1000 / ms;
    return `~${framesPerSec.toFixed(1)} frame/sec — ${formatDurationFor(this.durationHours(), framesPerSec)}`;
  });

  ngOnInit(): void {
    // Patch read-only anchor preview après init
    (this as unknown as { anchorIso: string }).anchorIso = formatIsoShort(this.anchor);
  }

  // ── Internals ────────────────────────────────────────────────────
  private durationHours(): number {
    const map = { '6h': 6, '24h': 24, '3d': 72, '7d': 168 };
    return map[this.duration()];
  }
  private speedMs(): number {
    const map = { 1: 1000, 2: 500, 4: 250, 8: 125 };
    return map[this.speed()];
  }

  onLaunch(): void {
    this.launch.emit({
      anchor: this.anchor,
      duration: this.duration(),
      direction: this.direction(),
      speed: this.speed(),
      loop: this.loop(),
      followRealTime: this.followRealTime(),
      forecastActive: this.forecastActive,
    });
  }

  onCancel(): void {
    this.cancel.emit();
  }
}

function formatIsoShort(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}h`;
}

function formatDurationFor(totalHours: number, framesPerSec: number): string {
  const totalSec = totalHours / framesPerSec;
  if (totalSec < 60) return `${totalSec.toFixed(0)}s pour ${totalHours}h`;
  const min = Math.floor(totalSec / 60);
  const sec = Math.round(totalSec % 60);
  return `${min}m${sec.toString().padStart(2, '0')} pour ${totalHours}h`;
}
