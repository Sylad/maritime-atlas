import { ChangeDetectionStrategy, Component, computed, effect, input, output, signal } from '@angular/core';
import { DatePipe } from '@angular/common';

/**
 * Time slider globale pour explorer le passé / présent / futur.
 *
 * Range : [minTime, maxTime] (par défaut [now-30d, now+5d]).
 * Le composant émet `timeChange` à chaque déplacement du cursor.
 *
 * Modes implicites :
 *   - **Live** : currentTime ≈ now (±5min) → l'UI parent affiche les
 *     vessels live + auto-refresh
 *   - **History** : currentTime < now → tracks du jour + SST raster
 *   - **Forecast** : currentTime > now → futur, vide pour l'instant
 *     (sprint 5 : modèles forecast)
 *
 * Boutons : -1j / -1h / play-pause / +1h / +1j / now (recentrage live).
 * Play auto-advance : 6h/seconde réel (1 jour visible = 4 secondes).
 */
@Component({
  selector: 'app-time-slider',
  imports: [DatePipe],
  template: `
    <div class="time-slider">
      <div class="ts-controls">
        <button type="button" class="ts-btn" (click)="step(-bigStepMs())" [title]="'-' + bigStepLabel()">⏮&#xFE0E;</button>
        <button type="button" class="ts-btn" (click)="step(-smallStepMs())" [title]="'-' + smallStepLabel()">⏪&#xFE0E;</button>
        <button
          type="button"
          class="ts-btn ts-btn-play"
          [class.playing]="playing()"
          (click)="togglePlay()"
          [title]="playing() ? 'Pause' : 'Play (6h/s)'">
          {{ playing() ? '⏸︎' : '▶︎' }}
        </button>
        <button type="button" class="ts-btn" (click)="step(smallStepMs())" [title]="'+' + smallStepLabel()">⏩&#xFE0E;</button>
        <button type="button" class="ts-btn" (click)="step(bigStepMs())" [title]="'+' + bigStepLabel()">⏭&#xFE0E;</button>
        <button
          type="button"
          class="ts-btn ts-btn-now"
          [class.active]="isLive()"
          (click)="goNow()"
          title="Retour au temps réel">◉ NOW</button>
      </div>

      <div class="ts-track-wrap">
        <div class="ts-label" [class.live]="isLive()" [class.future]="isFuture()">
          @if (isLive()) {
            <span class="ts-live-dot"></span> LIVE
          } @else if (isFuture()) {
            <span class="ts-future">FORECAST</span>
          }
          {{ currentTime() | date:'EEE dd MMM yyyy · HH:mm' }}
          @if (statusLabel()) {
            <span class="ts-status">{{ statusLabel() }}</span>
          }
        </div>

        <div class="ts-track" (pointerdown)="onTrackClick($event)" #track>
          <!-- Marker "now" position -->
          <div class="ts-now-marker" [style.left.%]="nowPercent()" title="Maintenant"></div>
          <!-- Past zone (gauche du now) -->
          <div class="ts-past-zone" [style.width.%]="nowPercent()"></div>
          <!-- Cursor (position currentTime) -->
          <div class="ts-cursor" [style.left.%]="cursorPercent()" (pointerdown)="onCursorDrag($event)"></div>
        </div>

        <div class="ts-ticks">
          <span class="ts-tick-min">{{ minTime() | date:'dd/MM' }}</span>
          <span class="ts-tick-mid">{{ midTime() | date:'dd/MM' }}</span>
          <span class="ts-tick-max">{{ maxTime() | date:'dd/MM' }}</span>
        </div>
      </div>
    </div>
  `,
  styles: `
    :host {
      display: block;
      position: fixed;
      bottom: 0.7em;
      /* Centré avec marges latérales pour laisser visibles les controls
         OpenLayers (Attribution (i) + ScaleLine) en bas-droite et le
         bouton zoom OL en bas-gauche. */
      left: 50%;
      transform: translateX(-50%);
      width: calc(100% - 260px);
      max-width: 1320px;
      background: rgb(15, 23, 42);
      border: 1px solid hsl(224 85% 55% / 0.5);
      border-radius: 10px;
      padding: 0.55em 1em;
      z-index: 20;
      /* Glow neon cyan, cohérent avec legend + popup attribution */
      box-shadow:
        0 0 0 1px hsl(224 95% 60% / 0.2),
        0 0 16px 1px hsl(224 95% 60% / 0.26),
        0 0 40px 4px hsl(224 90% 55% / 0.13),
        0 10px 30px -6px rgba(0, 0, 0, 0.7);
      @media (max-width: 760px) {
        width: calc(100% - 1.4em);
        bottom: 0.5em;
        padding: 0.5em 0.65em;
      }
    }
    .time-slider {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 1.5em;
      align-items: center;
      margin: 0 auto;
      @media (max-width: 760px) {
        grid-template-columns: 1fr;     /* stack vertical : label puis controls+track */
        gap: 0.5em;
      }
    }
    .ts-controls {
      display: flex;
      gap: 0.3em;
      align-items: center;
      @media (max-width: 760px) {
        justify-content: space-between;
        gap: 0.2em;
      }
    }
    .ts-btn {
      background: var(--bg-3);
      border: 1px solid var(--border);
      color: var(--fg-muted);
      width: 36px;
      height: 32px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.9rem;
      transition: all 150ms;
      /* Force text presentation des emoji ⏪ ⏩ ⏮ ⏭ etc — sinon
         certains browsers les rendent en multicolore (fond bleu pour
         ⏪ ⏩ notamment). Avec U+FE0E variation selector ça respecte. */
      font-variant-emoji: text;
      &:hover { color: var(--fg); border-color: var(--accent); }
      @media (max-width: 760px) {
        width: 32px;
        height: 30px;
        font-size: 0.8rem;
      }
    }
    .ts-btn-play {
      width: 44px;
      &.playing {
        background: rgba(45, 212, 191, 0.2);
        color: var(--accent-bright);
        border-color: var(--accent);
      }
    }
    .ts-btn-now {
      width: auto;
      padding: 0 0.7em;
      font-family: var(--font-mono);
      font-size: 0.7rem;
      letter-spacing: 0.1em;
      &.active {
        background: rgba(45, 212, 191, 0.15);
        color: var(--accent-bright);
        border-color: var(--accent);
      }
      @media (max-width: 760px) {
        padding: 0 0.5em;
        font-size: 0.6rem;
      }
    }

    .ts-track-wrap {
      display: flex;
      flex-direction: column;
      gap: 0.4em;
    }
    .ts-label {
      font-family: var(--font-mono);
      font-size: 0.85rem;
      color: var(--fg);
      letter-spacing: 0.05em;
      display: flex;
      align-items: center;
      gap: 0.5em;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      &.live {
        color: var(--accent-bright);
      }
      &.future {
        color: var(--warning);
      }
      @media (max-width: 760px) {
        font-size: 0.72rem;
        gap: 0.4em;
        justify-content: center;
      }
    }
    .ts-live-dot {
      width: 8px; height: 8px;
      background: var(--accent-bright);
      border-radius: 50%;
      box-shadow: 0 0 8px var(--accent-bright);
      animation: pulse 1.5s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }
    .ts-future {
      font-family: var(--font-mono);
      font-size: 0.7rem;
      letter-spacing: 0.15em;
      padding: 0.15em 0.5em;
      border: 1px solid var(--warning);
      border-radius: 3px;
    }

    .ts-track {
      position: relative;
      height: 12px;
      background: var(--bg-3);
      border: 1px solid var(--border);
      border-radius: 6px;
      cursor: pointer;
      user-select: none;
    }
    .ts-past-zone {
      position: absolute;
      top: 0; left: 0; bottom: 0;
      background: linear-gradient(to right, rgba(45, 212, 191, 0.05), rgba(45, 212, 191, 0.18));
      border-radius: 5px 0 0 5px;
      pointer-events: none;
    }
    .ts-now-marker {
      position: absolute;
      top: -3px; bottom: -3px;
      width: 2px;
      background: var(--accent-bright);
      transform: translateX(-1px);
      pointer-events: none;
      box-shadow: 0 0 6px var(--accent-bright);
    }
    .ts-cursor {
      position: absolute;
      top: -4px;
      width: 14px;
      height: 18px;
      background: var(--fg);
      border: 1px solid var(--accent);
      border-radius: 3px;
      transform: translateX(-7px);
      cursor: ew-resize;
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.5);
    }

    .ts-status {
      margin-left: 1em;
      font-family: var(--font-mono);
      font-size: 0.65rem;
      letter-spacing: 0.1em;
      color: var(--fg-dim);
      opacity: 0.8;
    }
    .ts-ticks {
      display: flex;
      justify-content: space-between;
      font-family: var(--font-mono);
      font-size: 0.65rem;
      color: var(--fg-dim);
      padding: 0 2px;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TimeSliderComponent {
  // Inputs : range [min, max]. Defaults [now-7d, now+5d] — fenêtre 12 jours
  // alignée sur la rétention météo (GFS/ARPEGE/WW3 forecasts = 7j de passé).
  // Choix volontaire : slider plus précis (chaque pixel = ~25min vs ~110min
  // pour un slider 30j), et garantit qu'il existe toujours des données
  // météo pour chaque position du cursor (au lieu du dégradé "rien").
  readonly minTime = input<Date>(new Date(Date.now() - 7 * 86400_000));
  readonly maxTime = input<Date>(new Date(Date.now() + 5 * 86400_000));
  /** Step en ms — drive les boutons "+/- N" + le snap au drag/click.
   *  0 (default) = pas de snap, step buttons = ±1h. Set par le parent
   *  selon les layers actifs (cf sliderConfig dans map.component). */
  readonly stepMs = input<number>(0);
  /** Label compact affiché à côté du timestamp ("Δ 6h • -24h → +72h",
   *  "LIVE", "FORECAST"). Drive par le parent selon les layers. */
  readonly statusLabel = input<string>('');

  // Output : émet à chaque changement de cursor (drag, click track, btn).
  readonly timeChange = output<Date>();
  /** Émis quand l'utilisateur clique le bouton play/pause. Si le parent
   *  gère un AnimationPlayer externe (via [externalAnimationActive]), il
   *  intercepte cet event pour open la modal ou pause/resume. Sinon
   *  fallback sur le startPlay/stopPlay interne ("+6h/sec"). */
  readonly playClicked = output<void>();

  /** Quand true, le bouton play affiche ⏸ et togglePlay émet juste
   *  playClicked au parent (mode "AnimationPlayer externe"). */
  readonly externalAnimationActive = input<boolean>(false);

  /** Optionnel — quand le parent pilote le temps de l'extérieur (anim
   *  player, restore session…), il passe la Date courante ici et le
   *  signal interne `currentTime` se sync. Sans cet input, le slider
   *  reste piloté uniquement par ses propres interactions. */
  readonly externalCurrentTime = input<Date | null>(null);

  // État interne
  readonly currentTime = signal<Date>(new Date());
  private readonly legacyPlaying = signal(false);
  /** Computed exposé au template : OR du mode externe + mode legacy. */
  readonly playing = computed<boolean>(() => this.externalAnimationActive() || this.legacyPlaying());
  private playTimer?: ReturnType<typeof setInterval>;
  private nowTickTimer?: ReturnType<typeof setInterval>;
  private dragRaf?: number;

  constructor() {
    // Tick "now marker" toutes les minutes pour faire avancer le repère "now"
    // sur la track (sinon il reste figé à la valeur du chargement de la page).
    this.nowTickTimer = setInterval(() => {
      // Force a re-evaluation in computed signals
      if (this.isLive()) {
        this.setTime(new Date());
      }
    }, 60_000);

    // Sync externe → interne. Quand le parent pilote le temps (animation
    // player notamment), le `currentTime` interne suit. On évite de
    // ré-émettre timeChange pour ne pas boucler — c'est juste un mirror
    // visuel (label date + position cursor).
    effect(() => {
      const ext = this.externalCurrentTime();
      if (!ext) return;
      if (ext.getTime() !== this.currentTime().getTime()) {
        this.currentTime.set(ext);
      }
    });
  }

  // ─── Computed ──────────────────────────────────────────────────────
  readonly midTime = computed(() => new Date((this.minTime().getTime() + this.maxTime().getTime()) / 2));

  readonly cursorPercent = computed(() => {
    const min = this.minTime().getTime();
    const max = this.maxTime().getTime();
    const cur = this.currentTime().getTime();
    return Math.max(0, Math.min(100, ((cur - min) / (max - min)) * 100));
  });

  readonly nowPercent = computed(() => {
    const min = this.minTime().getTime();
    const max = this.maxTime().getTime();
    const now = Date.now();
    return Math.max(0, Math.min(100, ((now - min) / (max - min)) * 100));
  });

  readonly isLive = computed(() => Math.abs(Date.now() - this.currentTime().getTime()) < 5 * 60_000);
  readonly isFuture = computed(() => this.currentTime().getTime() > Date.now() + 5 * 60_000);

  // ─── Step buttons computed ─────────────────────────────────────────
  /** Small step = la granularité native (stepMs si fourni, sinon 1h). */
  readonly smallStepMs = computed(() => this.stepMs() || 3_600_000);
  /** Big step = 4× small step, plafonné à 24h. */
  readonly bigStepMs = computed(() => Math.min(this.smallStepMs() * 4, 86_400_000));
  readonly smallStepLabel = computed(() => this.formatDuration(this.smallStepMs()));
  readonly bigStepLabel = computed(() => this.formatDuration(this.bigStepMs()));

  private formatDuration(ms: number): string {
    if (ms >= 86_400_000) return `${Math.round(ms / 86_400_000)}j`;
    if (ms >= 3_600_000) return `${Math.round(ms / 3_600_000)}h`;
    return `${Math.round(ms / 60_000)}min`;
  }

  /** Snap ms timestamp to multiple of stepMs (depuis epoch 0 UTC). */
  private snapToStep(t: number): number {
    const step = this.stepMs();
    if (step <= 0) return t;
    return Math.round(t / step) * step;
  }

  // ─── Actions ───────────────────────────────────────────────────────
  setTime(t: Date): void {
    const min = this.minTime().getTime();
    const max = this.maxTime().getTime();
    const snapped = this.snapToStep(t.getTime());
    const clamped = new Date(Math.max(min, Math.min(max, snapped)));
    this.currentTime.set(clamped);
    this.timeChange.emit(clamped);
  }

  step(deltaMs: number): void {
    this.setTime(new Date(this.currentTime().getTime() + deltaMs));
  }

  goNow(): void {
    this.stopPlay();
    this.setTime(new Date());
  }

  togglePlay(): void {
    // Toujours notifier le parent — s'il gère un AnimationPlayer externe,
    // il intercepte (ouvre la modal, pause, resume…). Si le parent ne
    // fait rien (cas standalone / test), on fallback sur le start/stop
    // interne "+6h/s".
    this.playClicked.emit();
    if (this.externalAnimationActive()) return;
    if (this.legacyPlaying()) this.stopPlay();
    else this.startPlay();
  }

  private startPlay(): void {
    this.legacyPlaying.set(true);
    // 6h advance per second de temps réel. L'animation s'arrête à NOW :
    // au-delà = forecast pas dispo, donc inutile de traverser. L'utilisateur
    // doit explicitement déplacer le cursor au-delà de NOW pour voir le futur.
    this.playTimer = setInterval(() => {
      const cur = this.currentTime().getTime();
      const next = cur + 6 * 3600_000;
      const limit = Math.min(this.maxTime().getTime(), Date.now());
      // Si on est déjà ≥ NOW, ou si l'avance dépasse NOW, on stoppe à NOW.
      if (cur >= limit || next >= limit) {
        this.setTime(new Date(limit));
        this.stopPlay();
        return;
      }
      this.setTime(new Date(next));
    }, 1000);
  }

  private stopPlay(): void {
    this.legacyPlaying.set(false);
    if (this.playTimer) clearInterval(this.playTimer);
    this.playTimer = undefined;
  }

  // ─── Drag/click sur la track ───────────────────────────────────────
  onTrackClick(event: PointerEvent): void {
    // Seulement si on clique pas sur le cursor lui-même (qui a son own handler)
    const target = event.target as HTMLElement;
    if (target.classList.contains('ts-cursor')) return;
    const track = (event.currentTarget as HTMLElement);
    this.updateFromPointer(track, event.clientX);
  }

  onCursorDrag(event: PointerEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.stopPlay();
    const track = (event.currentTarget as HTMLElement).parentElement!;
    const onMove = (e: PointerEvent) => {
      if (this.dragRaf) cancelAnimationFrame(this.dragRaf);
      this.dragRaf = requestAnimationFrame(() => this.updateFromPointer(track, e.clientX));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (this.dragRaf) cancelAnimationFrame(this.dragRaf);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  private updateFromPointer(track: HTMLElement, clientX: number): void {
    const rect = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const min = this.minTime().getTime();
    const max = this.maxTime().getTime();
    this.setTime(new Date(min + ratio * (max - min)));
  }
}
