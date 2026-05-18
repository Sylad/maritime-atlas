import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { DatePipe } from '@angular/common';

/**
 * Une ligne de couverture pour un layer actif (V1 : window continue).
 *  - name       : identifiant utilisé pour le label monospace
 *  - color      : couleur CSS de la sous-barre (alignée avec la legend)
 *  - pastH      : extension dans le passé en heures (0 = pas de coverage passé)
 *  - futureH    : extension dans le futur en heures (0 = pas de coverage futur)
 *
 * V2 ajoutera `ticks: Date[]` pour les timesteps réels WMS/WFS.
 */
export interface TimeSliderLayerCoverage {
  /** Nom affiché dans le label de rangée (e.g., 'sst', 'wind-arrows'). */
  name: string;
  /** Clé interne stable (ex : 'sst', 'wind', 'windArrows') — sert à identifier
   *  cette rangée lors des emit masterChange / reorderRequest. */
  key: string;
  color: string;
  pastH: number;
  futureH: number;
  /** 2026-05-18 APEX 11 — true si cette layer est le master du temps courant.
   *  Le composant affiche une icône distinctive (⭐ vs ☆) qui permet à l'user
   *  de basculer le master en cliquant sur l'icône d'une autre rangée. */
  isMaster: boolean;
  /** 2026-05-18 APEX 12 — validités RÉELLES de cette layer (WMS time-enabled
   *  uniquement). Rendues comme marqueurs ponctuels dans la sous-barre.
   *  Vide ou undefined pour les vector layers (cf refreshIntervalMin). */
  validities?: Date[];
  /** 2026-05-18 APEX 12 — pour les vector layers live (lightning/metar/etc.),
   *  intervalle de refresh (minutes). Rendu comme segments fins continus à
   *  cette cadence (ex: lightning 1min, metar 60min, buoys 30min). */
  refreshIntervalMin?: number;
}

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
        <button type="button" class="ts-btn" (click)="goFirst()" title="Première validité (extrême passé)">⏮&#xFE0E;</button>
        <button type="button" class="ts-btn" (click)="goPrev()" title="Validité précédente">⏪&#xFE0E;</button>
        <button
          type="button"
          class="ts-btn ts-btn-play"
          [class.playing]="playing()"
          (click)="togglePlay()"
          [title]="playing() ? 'Pause' : 'Play (6h/s)'">
          {{ playing() ? '⏸︎' : '▶︎' }}
        </button>
        <button type="button" class="ts-btn" (click)="goNext()" title="Validité suivante">⏩&#xFE0E;</button>
        <button type="button" class="ts-btn" (click)="goLast()" title="Dernière validité (extrême futur)">⏭&#xFE0E;</button>
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
          {{ displayTime() | date:'EEE dd MMM yyyy · HH:mm' }}
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

        <!-- Panneau expandable : sous-barres coverage par layer actif.
             2026-05-18 APEX 11 — ajout icône master (⭐ / ☆) à gauche + DnD pour
             réordonner z-index. Le drag se fait sur la rangée entière, l'icône
             ⭐ est cliquable sans déclencher le drag (stopPropagation). -->
        @if (expanded() && layerCoverage().length > 0) {
          <div class="ts-coverage">
            @for (cov of layerCoverage(); track cov.key) {
              <div class="ts-coverage-row"
                   draggable="true"
                   [class.is-drag-over]="dragOverKey() === cov.key"
                   [class.is-master]="cov.isMaster"
                   (dragstart)="onCoverageDragStart($event, cov.key)"
                   (dragover)="onCoverageDragOver($event, cov.key)"
                   (dragleave)="onCoverageDragLeave($event, cov.key)"
                   (drop)="onCoverageDrop($event, cov.key)"
                   (dragend)="onCoverageDragEnd()">
                <button type="button"
                        class="ts-coverage-master-btn"
                        [class.is-master]="cov.isMaster"
                        [title]="cov.isMaster ? 'Maître du temps actuel' : 'Définir comme maître du temps'"
                        (click)="onMasterIconClick($event, cov.key)">{{ cov.isMaster ? '★' : '☆' }}</button>
                <span class="ts-coverage-drag-handle" aria-hidden="true" title="Glisser pour réordonner z-index">⋮⋮</span>
                <span class="ts-coverage-label">{{ cov.name }}</span>
                <div class="ts-coverage-track"
                     [title]="coverageTrackTooltip(cov)">
                  <!-- Plage théorique (pastH/futureH) — sert de fond mais visuellement
                       discret (opacity réduit) si on a déjà des markers concrets. -->
                  <div
                    class="ts-coverage-bar"
                    [class.ts-coverage-bar-faded]="hasConcreteMarkers(cov)"
                    [style.background]="cov.color"
                    [style.left.%]="coverageLeftPercent(cov)"
                    [style.width.%]="coverageWidthPercent(cov)"></div>
                  <!-- 2026-05-18 APEX 12 — markers data presence.
                       Variant 1 : pour les WMS time-enabled (validities[]), 1 tick par validity.
                       Variant 2 : pour les vector layers (refreshIntervalMin), segments fins. -->
                  @if (cov.validities && cov.validities.length > 0) {
                    @for (v of visibleValidityMarkers(cov); track v.getTime()) {
                      <span class="ts-coverage-marker ts-coverage-marker-tick"
                            [style.background]="cov.color"
                            [style.left.%]="positionPercentForDate(v)"></span>
                    }
                  } @else if (cov.refreshIntervalMin && cov.refreshIntervalMin > 0) {
                    @for (seg of visibleVectorSegments(cov); track seg.t) {
                      <span class="ts-coverage-marker ts-coverage-marker-seg"
                            [style.background]="cov.color"
                            [style.left.%]="positionPercentForTimestamp(seg.t)"
                            [style.width.%]="seg.widthPercent"></span>
                    }
                  }
                </div>
              </div>
            }
          </div>
        }

        <div class="ts-ticks">
          @if (visibleValidityTicks().length > 0) {
            <!-- 2026-05-18 APEX 10 — ticks alignés sur les validités RÉELLES du master.
                 Position % calculée linéairement entre minTime et maxTime. Downsample
                 si > MAX_VISIBLE_TICKS pour rester lisible. -->
            @for (tick of visibleValidityTicks(); track tick.getTime()) {
              <span class="ts-tick-validity"
                    [style.left.%]="tickPositionPercent(tick)"
                    [title]="tick | date:'EEE dd/MM HH:mm':'UTC':'fr-FR'">{{ tick | date:'dd/MM' }}</span>
            }
          } @else {
            <!-- Fallback "loading" ou stepMs-driven (validités pas encore arrivées). -->
            <span class="ts-tick-min">{{ minTime() | date:'dd/MM' }}</span>
            <span class="ts-tick-mid">{{ midTime() | date:'dd/MM' }}</span>
            <span class="ts-tick-max">{{ maxTime() | date:'dd/MM' }}</span>
          }
        </div>
      </div>

      <button
        type="button"
        class="ts-expand-btn"
        (click)="toggleExpanded()"
        [class.expanded]="expanded()"
        [title]="expanded() ? 'Réduire' : 'Voir la couverture data par layer'">
        {{ expanded() ? '▼' : '▲' }}
      </button>
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
      position: relative;  /* container pour les ticks validity en absolute */
      display: flex;
      justify-content: space-between;
      font-family: var(--font-mono);
      font-size: 0.65rem;
      color: var(--fg-dim);
      padding: 0 2px;
      min-height: 1em;  /* évite collapse quand ticks absolute */
    }
    /* 2026-05-18 APEX 10 — ticks alignés sur validités master.
       Positionnement absolute selon [style.left.%] pour matcher la track.
       transform translateX(-50%) recentre le label sur sa position. */
    .ts-tick-validity {
      position: absolute;
      transform: translateX(-50%);
      white-space: nowrap;
      &:first-child { transform: translateX(0); }  /* pas de décalage gauche pour 1er tick */
      &:last-child  { transform: translateX(-100%); }  /* recalé entièrement à gauche pour dernier */
    }

    /* Bouton expand : à droite du grid, vertical hauteur match track-wrap */
    .time-slider {
      grid-template-columns: auto 1fr auto;
    }
    .ts-expand-btn {
      align-self: stretch;
      background: var(--bg-3);
      border: 1px solid var(--border);
      color: var(--fg-dim);
      width: 28px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.75rem;
      font-family: var(--font-mono);
      transition: all 150ms;
      &:hover { color: var(--fg); border-color: var(--accent); }
      &.expanded {
        color: var(--accent-bright);
        border-color: var(--accent);
        background: rgba(45, 212, 191, 0.1);
      }
    }

    /* Panneau expandable : sous-barres par layer actif. Affiche jusqu'à
     * 3 lignes sans scroll ; au-delà, scroll vertical (cap 5 = limite UX
     * coté map.component, mais le scroll gère proprement même en léger
     * dépassement). */
    .ts-coverage {
      display: flex;
      flex-direction: column;
      gap: 0.2em;
      padding: 0.4em 0 0.2em;
      /* 3 lignes × (8px barre + 0.2em gap + label line-height ~14px) ≈ 90px */
      max-height: 90px;
      overflow-y: auto;
      scrollbar-width: thin;
      scrollbar-color: hsl(224 60% 35%) transparent;
    }
    .ts-coverage-row {
      display: grid;
      /* 2026-05-18 APEX 11 — 4 colonnes : master-btn ★, drag-handle ⋮⋮, label, track. */
      grid-template-columns: 1.2em 0.9em 5em 1fr;
      gap: 0.4em;
      align-items: center;
      padding: 1px 0;
      border-radius: 4px;
      cursor: grab;
      transition: background 120ms;
      &:hover { background: rgba(255,255,255,0.03); }
      &.is-drag-over {
        background: rgba(45, 212, 191, 0.12);
        outline: 1px dashed var(--accent);
        outline-offset: -1px;
      }
      &.is-master .ts-coverage-label {
        color: var(--accent-bright);
        font-weight: 600;
      }
    }
    .ts-coverage-master-btn {
      background: transparent;
      border: 0;
      padding: 0;
      cursor: pointer;
      font-size: 0.95rem;
      line-height: 1;
      color: var(--fg-dim);
      transition: color 150ms;
      &.is-master {
        color: var(--accent-bright);
      }
      &:hover { color: var(--fg); }
    }
    .ts-coverage-drag-handle {
      color: var(--fg-muted);
      font-family: var(--font-mono);
      font-size: 0.65rem;
      letter-spacing: -0.1em;
      cursor: grab;
      user-select: none;
    }
    .ts-coverage-label {
      font-family: var(--font-mono);
      font-size: 0.65rem;
      color: var(--fg-dim);
      text-align: right;
      letter-spacing: 0.05em;
      text-overflow: ellipsis;
      overflow: hidden;
      white-space: nowrap;
    }
    .ts-coverage-track {
      position: relative;
      height: 8px;
      background: var(--bg-3);
      border-radius: 4px;
      overflow: hidden;
    }
    .ts-coverage-bar {
      position: absolute;
      top: 1px;
      bottom: 1px;
      border-radius: 3px;
      opacity: 0.7;
      transition: opacity 150ms;
      &:hover { opacity: 1; }
      /* 2026-05-18 APEX 12 — quand on a des markers concrets dessus, on fade
         la barre de fond pour mettre l'accent sur les markers. */
      &.ts-coverage-bar-faded {
        opacity: 0.15;
        &:hover { opacity: 0.35; }
      }
    }
    /* 2026-05-18 APEX 12 — markers data presence dans la sous-barre.
       Tick = point ponctuel (WMS validité). Seg = segment fin (vector live). */
    .ts-coverage-marker {
      position: absolute;
      top: 0;
      bottom: 0;
      opacity: 0.95;
      pointer-events: none;
    }
    .ts-coverage-marker-tick {
      width: 2px;
      transform: translateX(-1px);
      border-radius: 1px;
    }
    .ts-coverage-marker-seg {
      height: 4px;
      top: 2px;
      border-radius: 2px;
      opacity: 0.6;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TimeSliderComponent {
  // Inputs : range [min, max]. Defaults ±6h — courtoisie quand aucun layer
  // actif (le parent override avec sliderConfig() dérivé de LAYER_PROFILES
  // dès qu'un layer est activé).
  readonly minTime = input<Date>(new Date(Date.now() - 6 * 3_600_000));
  readonly maxTime = input<Date>(new Date(Date.now() + 6 * 3_600_000));
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

  /** 2026-05-18 APEX 11 — Émis quand l'user click l'icône ⭐ d'une rangée
   *  layer-coverage non-master, pour basculer le master du temps vers cette
   *  layer. Le parent met cette key en TÊTE de activationOrder. */
  readonly masterChange = output<string>();

  /** 2026-05-18 APEX 11 — Émis quand l'user drag-and-drop une rangée à
   *  une nouvelle position. Le parent réordonne layerZIndexOrder + applique
   *  setZIndex aux layers OL correspondantes. */
  readonly reorderRequest = output<{ fromKey: string; toKey: string }>();

  /** Quand true, le bouton play affiche ⏸ et togglePlay émet juste
   *  playClicked au parent (mode "AnimationPlayer externe"). */
  readonly externalAnimationActive = input<boolean>(false);

  /** Optionnel — quand le parent pilote le temps de l'extérieur (anim
   *  player, restore session…), il passe la Date courante ici et le
   *  signal interne `currentTime` se sync. Sans cet input, le slider
   *  reste piloté uniquement par ses propres interactions. */
  readonly externalCurrentTime = input<Date | null>(null);

  /** Liste des layers actifs avec leur coverage (V1 : window continue
   *  basée sur pastH/futureH de LAYER_PROFILES). Quand l'utilisateur
   *  expand le slider, ces layers sont rendus comme sous-barres alignées
   *  avec l'axe temps principal. V2 (TODO) : timesteps discrets via WMS
   *  GetCapabilities ou WFS DISTINCT(ts). */
  readonly layerCoverage = input<TimeSliderLayerCoverage[]>([]);

  /** Liste des validités (timestamps) publiées par le master du temps.
   *  Drive les boutons de navigation ⏪︎/⏩︎ (validité précédente/suivante)
   *  et ⏮︎/⏭︎ (première/dernière validité). Si vide (aucun master ou master
   *  vector), fallback step ±30min. Spec 2026-05-17 Sylvain. */
  readonly validityList = input<Date[]>([]);

  readonly expanded = signal(false);
  toggleExpanded(): void { this.expanded.update((v) => !v); }

  /** 2026-05-18 APEX 11 — état interne pour drag-and-drop visuel des rangées
   *  coverage. Stocke la clé en cours de drag et celle survolée pour highlight. */
  private readonly draggedKey = signal<string | null>(null);
  readonly dragOverKey = signal<string | null>(null);

  onMasterIconClick(evt: MouseEvent, key: string): void {
    evt.stopPropagation();  // ne pas déclencher le drag de la rangée
    this.masterChange.emit(key);
  }

  onCoverageDragStart(evt: DragEvent, key: string): void {
    this.draggedKey.set(key);
    if (evt.dataTransfer) {
      evt.dataTransfer.effectAllowed = 'move';
      evt.dataTransfer.setData('text/plain', key);
    }
  }

  onCoverageDragOver(evt: DragEvent, key: string): void {
    evt.preventDefault();  // permet le drop
    if (evt.dataTransfer) evt.dataTransfer.dropEffect = 'move';
    if (this.draggedKey() && this.draggedKey() !== key) {
      this.dragOverKey.set(key);
    }
  }

  onCoverageDragLeave(_evt: DragEvent, key: string): void {
    if (this.dragOverKey() === key) this.dragOverKey.set(null);
  }

  onCoverageDrop(evt: DragEvent, toKey: string): void {
    evt.preventDefault();
    const fromKey = this.draggedKey();
    this.dragOverKey.set(null);
    this.draggedKey.set(null);
    if (!fromKey || fromKey === toKey) return;
    this.reorderRequest.emit({ fromKey, toKey });
  }

  onCoverageDragEnd(): void {
    this.draggedKey.set(null);
    this.dragOverKey.set(null);
  }

  // État interne
  readonly currentTime = signal<Date>(new Date());
  /** Temps à afficher = externe (anim player) en priorité, sinon interne.
   *  Plus fiable qu'un effect() qui set currentTime — évite les loops et
   *  les soucis de change detection sur OnPush. */
  readonly displayTime = computed<Date>(() => this.externalCurrentTime() ?? this.currentTime());
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

  }

  // ─── Computed ──────────────────────────────────────────────────────
  readonly midTime = computed(() => new Date((this.minTime().getTime() + this.maxTime().getTime()) / 2));

  /** 2026-05-18 APEX 10 — Liste des validités à afficher comme ticks sous la
   *  track. Si validityList contient ≤ MAX_VISIBLE_TICKS, on les affiche
   *  toutes. Sinon on downsample uniformément (1 tick sur N) en gardant
   *  TOUJOURS le premier et le dernier. Évite l'amas visuel pour les
   *  longues séries (wind forecast = 28 ticks 6h sur 7j). */
  private readonly MAX_VISIBLE_TICKS = 8;
  readonly visibleValidityTicks = computed<Date[]>(() => {
    const list = this.validityList();
    if (list.length === 0) return [];
    if (list.length <= this.MAX_VISIBLE_TICKS) return [...list];
    const step = Math.ceil(list.length / this.MAX_VISIBLE_TICKS);
    const sampled: Date[] = [];
    for (let i = 0; i < list.length; i += step) sampled.push(list[i]);
    // Garantit la présence du dernier élément (sinon downsample peut le rater)
    if (sampled[sampled.length - 1].getTime() !== list[list.length - 1].getTime()) {
      sampled.push(list[list.length - 1]);
    }
    return sampled;
  });

  /** Position en % de la track pour une validité (interpolation linéaire). */
  tickPositionPercent(tick: Date): number {
    const min = this.minTime().getTime();
    const max = this.maxTime().getTime();
    if (max === min) return 0;
    return Math.max(0, Math.min(100, ((tick.getTime() - min) / (max - min)) * 100));
  }

  readonly cursorPercent = computed(() => {
    const min = this.minTime().getTime();
    const max = this.maxTime().getTime();
    const cur = this.displayTime().getTime();
    return Math.max(0, Math.min(100, ((cur - min) / (max - min)) * 100));
  });

  readonly nowPercent = computed(() => {
    const min = this.minTime().getTime();
    const max = this.maxTime().getTime();
    const now = Date.now();
    return Math.max(0, Math.min(100, ((now - min) / (max - min)) * 100));
  });

  /** Position du début de la sous-barre coverage en % de l'axe slider.
   *  Aligned avec la track principale (même minTime/maxTime). */
  coverageLeftPercent(cov: TimeSliderLayerCoverage): number {
    const min = this.minTime().getTime();
    const max = this.maxTime().getTime();
    const start = Date.now() - cov.pastH * 3_600_000;
    return Math.max(0, Math.min(100, ((start - min) / (max - min)) * 100));
  }

  coverageWidthPercent(cov: TimeSliderLayerCoverage): number {
    const min = this.minTime().getTime();
    const max = this.maxTime().getTime();
    const start = Date.now() - cov.pastH * 3_600_000;
    const end = Date.now() + cov.futureH * 3_600_000;
    const clampedStart = Math.max(start, min);
    const clampedEnd = Math.min(end, max);
    const width = Math.max(0, ((clampedEnd - clampedStart) / (max - min)) * 100);
    return width;
  }

  // ─── 2026-05-18 APEX 12 — markers data presence ──────────────────────
  /** True si la rangée a des markers concrets (validities OU segments vector).
   *  Quand true, on fade la barre de fond pour mettre l'accent sur les markers. */
  hasConcreteMarkers(cov: TimeSliderLayerCoverage): boolean {
    return (!!cov.validities && cov.validities.length > 0)
      || (!!cov.refreshIntervalMin && cov.refreshIntervalMin > 0);
  }

  /** Position % d'une date sur la track. Identique à tickPositionPercent mais
   *  exposé sous nom différent pour clarté (markers vs ticks de validité). */
  positionPercentForDate(d: Date): number {
    return this.tickPositionPercent(d);
  }
  positionPercentForTimestamp(t: number): number {
    return this.tickPositionPercent(new Date(t));
  }

  /** Downsample des validités pour les markers : max 30 visibles sinon
   *  l'overdraw rend la barre illisible. Pour ≤30 validités, on garde tout. */
  private readonly MAX_VISIBLE_MARKERS = 30;
  visibleValidityMarkers(cov: TimeSliderLayerCoverage): Date[] {
    const list = cov.validities ?? [];
    if (list.length <= this.MAX_VISIBLE_MARKERS) return list;
    const step = Math.ceil(list.length / this.MAX_VISIBLE_MARKERS);
    const out: Date[] = [];
    for (let i = 0; i < list.length; i += step) out.push(list[i]);
    return out;
  }

  /** Segments rendus pour les vector layers (refreshIntervalMin). 2026-05-18
   *  APEX 12 — génère des segments sur TOUTE la fenêtre slider visible
   *  [minTime, maxTime] (pas limité à pastH/futureH du vector). Pour les
   *  layers "live" comme lightning/metar, on suppose présence continue à la
   *  cadence de refresh sur toute la timeline visible. Capped à
   *  MAX_VISIBLE_MARKERS pour éviter l'overdraw. */
  visibleVectorSegments(cov: TimeSliderLayerCoverage): Array<{ t: number; widthPercent: number }> {
    const refreshMs = (cov.refreshIntervalMin ?? 0) * 60_000;
    if (refreshMs <= 0) return [];
    const min = this.minTime().getTime();
    const max = this.maxTime().getTime();
    const trackMs = max - min;
    if (trackMs <= 0) return [];

    // Downsample : si la fenêtre contient trop de cycles refresh, espace les
    // segments visibles pour rester sous MAX_VISIBLE_MARKERS.
    const slots = Math.floor(trackMs / refreshMs);
    if (slots <= 0) return [];
    const stride = Math.max(1, Math.ceil(slots / this.MAX_VISIBLE_MARKERS));
    const visibleStep = refreshMs * stride;
    const widthPercent = Math.max(0.3, ((visibleStep * 0.6) / trackMs) * 100);

    const out: Array<{ t: number; widthPercent: number }> = [];
    for (let t = min; t <= max; t += visibleStep) out.push({ t, widthPercent });
    return out;
  }

  /** Tooltip détaillé pour le hover sur la sous-barre. */
  coverageTrackTooltip(cov: TimeSliderLayerCoverage): string {
    const range = `${cov.name} : -${cov.pastH}h → +${cov.futureH}h`;
    if (cov.validities && cov.validities.length > 0) {
      const first = cov.validities[0];
      const last = cov.validities[cov.validities.length - 1];
      return `${range}\n${cov.validities.length} validités du ${first.toISOString().slice(0,10)} au ${last.toISOString().slice(0,10)}`;
    }
    if (cov.refreshIntervalMin && cov.refreshIntervalMin > 0) {
      return `${range}\nrafraîchi toutes les ${cov.refreshIntervalMin}min`;
    }
    return range;
  }

  // LIVE strict (Sylvain 2026-05-16) : true uniquement quand le cursor est
  // sur l'instant le plus proche de maintenant compte tenu du pas. Avec
  // stepMs=0 (live, pas de snap) on conserve une tolerance d'1 minute pour
  // que le badge ne clignote pas durant nowTick. Avec stepMs > 0 (forecast/
  // obs) on accepte ±stepMs/2 — le snap garantit qu'on tombe sur un
  // multiple, l'écart max au "now snapped" est stepMs/2.
  readonly isLive = computed(() => {
    const delta = Math.abs(Date.now() - this.displayTime().getTime());
    const tol = this.stepMs() > 0 ? this.stepMs() / 2 : 60_000;
    return delta < tol;
  });
  readonly isFuture = computed(() => {
    const delta = this.displayTime().getTime() - Date.now();
    const tol = this.stepMs() > 0 ? this.stepMs() / 2 : 60_000;
    return delta > tol;
  });

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

  /** Snap ms timestamp to multiple of stepMs (depuis epoch 0 UTC).
   *  2026-05-17 : Math.round → Math.floor pour ne JAMAIS snap vers le
   *  futur. Le Math.round pouvait pousser currentTime jusqu'à +step/2
   *  dans le futur (ex : t=20:45 + step=6h → round = 24:00 = +3h15 futur
   *  → isFuture()=true → layers SST+contours setVisible(false) → bug
   *  "layers disparaissent silencieusement" qui a pourri 4 jours.
   *  Math.floor garantit currentTime ≤ t, donc jamais dans le futur si
   *  caller passe Date.now() (cf NOW button qui faisait setTime(new Date())). */
  private snapToStep(t: number): number {
    const step = this.stepMs();
    if (step <= 0) return t;
    return Math.floor(t / step) * step;
  }

  // ─── Actions ───────────────────────────────────────────────────────
  setTime(t: Date): void {
    const min = this.minTime().getTime();
    const max = this.maxTime().getTime();
    const list = this.validityList();
    let target: Date;

    if (list.length > 0) {
      // 2026-05-18 APEX 10 — la time-bar est une barre de STEPS pilotée par
      // les validités du master. Tout click/drag/step entre 2 validités snap
      // à la validité la PLUS PROCHE (nearest neighbor dans validityList).
      // Le but : afficher uniquement les données réellement publiées par GS,
      // pas un timestamp intermédiaire qui retournerait une image vide ou
      // un nearestMatch arbitraire côté serveur.
      const cur = t.getTime();
      target = list.reduce((b: Date, c: Date) =>
        Math.abs(c.getTime() - cur) < Math.abs(b.getTime() - cur) ? c : b,
      );
    } else {
      // Fallback rétro-compat : pas de validityList (loading state ou master
      // sans GS time-dim) → snap-to-step continu (stepMs).
      const snapped = this.snapToStep(t.getTime());
      target = new Date(Math.max(min, Math.min(max, snapped)));
    }

    this.currentTime.set(target);
    this.timeChange.emit(target);
  }

  step(deltaMs: number): void {
    this.setTime(new Date(this.currentTime().getTime() + deltaMs));
  }

  // ─── Navigation par validité du master (Sylvain 2026-05-17) ──────
  // Spec : ⏪︎/⏩︎ = validité précédente/suivante du master, ⏮︎/⏭︎ =
  // extrême passé/futur de la liste des validités. Fallback step ±30min
  // si validityList vide (aucun master ou master vector live).
  private readonly FALLBACK_STEP_MS = 30 * 60_000;

  goPrev(): void {
    this.stopPlay();
    const list = this.validityList();
    if (list.length === 0) { this.step(-this.FALLBACK_STEP_MS); return; }
    const cur = this.displayTime().getTime();
    // Cherche le dernier timestamp strictement < cur
    let prev: Date | null = null;
    for (const t of list) {
      if (t.getTime() < cur) prev = t;
      else break;  // list est triée croissant
    }
    if (prev) this.setTime(prev);
    // Si déjà sur le 1er (ou avant), on ne bouge pas (clamp implicite)
  }

  goNext(): void {
    this.stopPlay();
    const list = this.validityList();
    if (list.length === 0) { this.step(+this.FALLBACK_STEP_MS); return; }
    const cur = this.displayTime().getTime();
    const next = list.find((t) => t.getTime() > cur);
    if (next) this.setTime(next);
  }

  goFirst(): void {
    this.stopPlay();
    const list = this.validityList();
    if (list.length > 0) {
      this.setTime(list[0]);
    } else {
      this.setTime(this.minTime());
    }
  }

  goLast(): void {
    this.stopPlay();
    const list = this.validityList();
    if (list.length > 0) {
      this.setTime(list[list.length - 1]);
    } else {
      this.setTime(this.maxTime());
    }
  }

  goNow(): void {
    this.stopPlay();
    const list = this.validityList();
    const now = Date.now();
    if (list.length > 0) {
      // Snap au timestamp validité le plus proche de now (toutes directions)
      // = nearest neighbor dans la liste triée.
      const closest = list.reduce((best, cur) =>
        Math.abs(cur.getTime() - now) < Math.abs(best.getTime() - now) ? cur : best,
      );
      this.setTime(closest);
    } else {
      // Pas de master = snap 30min sur new Date() (Math.floor → passé proche)
      this.setTime(new Date());
    }
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
