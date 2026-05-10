import { DatePipe } from '@angular/common';
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  OnDestroy,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { interval, startWith, Subscription, switchMap } from 'rxjs';

import Map from 'ol/Map';
import View from 'ol/View';
import TileLayer from 'ol/layer/Tile';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import XYZ from 'ol/source/XYZ';
import TileWMS from 'ol/source/TileWMS';
import GeoJSON from 'ol/format/GeoJSON';
import Overlay from 'ol/Overlay';
import { fromLonLat } from 'ol/proj';
import { Style, Circle as CircleStyle, Fill, Stroke, Icon } from 'ol/style';
import { defaults as defaultControls, ScaleLine } from 'ol/control';
import type { Feature } from 'ol';
import type { FeatureLike } from 'ol/Feature';
import type { Geometry, Point } from 'ol/geom';

import { Router, RouterLink } from '@angular/router';
import type { LayerKind, Palette } from '../../services/palettes.service';
import { TimeSliderComponent } from '../../components/time-slider/time-slider.component';
import { VesselsService, type VesselProperties } from '../../services/vessels.service';
import { RainviewerService, type RainViewerSnapshot } from '../../services/rainviewer.service';
import { AuthService } from '../../services/auth.service';
import { PalettesService } from '../../services/palettes.service';
import { ArrowsService, type ArrowsKind } from '../../services/arrows.service';

// France métropole — centré sur l'hexagone, zoom large.
const INITIAL_CENTER: [number, number] = [3.0, 46.5];
const INITIAL_ZOOM = 6;
const REFRESH_INTERVAL_MS = 30_000;
const LIVE_THRESHOLD_MS = 5 * 60_000; // ±5min = considéré live

// Couleurs par catégorie ship_type (cf v_vessels_live_categorized).
type Category = 'fishing-leisure' | 'passenger' | 'cargo' | 'tanker' | 'other';

const CATEGORY_COLOR: Record<Category, { fill: string; stroke: string; label: string }> = {
  'fishing-leisure': { fill: '#fbbf24', stroke: '#fde68a', label: 'Pêche / loisir' },
  passenger:        { fill: '#34d399', stroke: '#6ee7b7', label: 'Passagers' },
  cargo:            { fill: '#60a5fa', stroke: '#93c5fd', label: 'Cargo' },
  tanker:           { fill: '#f87171', stroke: '#fca5a5', label: 'Tanker' },
  other:            { fill: '#9ca3af', stroke: '#d1d5db', label: 'Autres' },
};

function categoryOf(shipType: number | null): Category {
  if (shipType == null) return 'other';
  if (shipType >= 30 && shipType <= 37) return 'fishing-leisure';
  if (shipType >= 60 && shipType <= 69) return 'passenger';
  if (shipType >= 70 && shipType <= 79) return 'cargo';
  if (shipType >= 80 && shipType <= 89) return 'tanker';
  return 'other';
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function toIsoTimestamp(d: Date): string {
  return d.toISOString();
}

@Component({
  selector: 'app-map',
  imports: [DatePipe, TimeSliderComponent, RouterLink],
  template: `
    <div class="map-container">
      <div class="map" #mapEl></div>

      <div class="auth-corner">
        @if (currentUser(); as u) {
          <a routerLink="/palettes" class="auth-link">{{ u.email }}</a>
          <span class="auth-sep">·</span>
          <button type="button" class="auth-btn" (click)="logout()">Déconnexion</button>
        } @else {
          <a routerLink="/auth/login" class="auth-link">Connexion</a>
          <span class="auth-sep">·</span>
          <a routerLink="/auth/register" class="auth-link">Inscription</a>
        }
      </div>

      <div class="legend">
        <div class="legend-title">MARITIME ATLAS</div>
        <div class="legend-subtitle">France métropole</div>

        <div class="layer-toggles">
          <label class="layer-toggle" [class.dim]="!vesselsActive()">
            <input type="checkbox" [checked]="showVessels()" (change)="showVessels.set($any($event.target).checked)" />
            <span class="toggle-glyph">
              <span class="glyph-dot" style="background:#34d399;border-color:#6ee7b7"></span>
              <span class="glyph-dot" style="background:#60a5fa;border-color:#93c5fd"></span>
              <span class="glyph-dot" style="background:#f87171;border-color:#fca5a5"></span>
            </span>
            <span class="toggle-text">
              <span class="toggle-name">Navires</span>
              <span class="toggle-count">{{ vesselsCount() }} positions</span>
            </span>
          </label>
          <label class="layer-toggle" [class.dim]="!tracksActive()">
            <input type="checkbox" [checked]="showTracks()" (change)="showTracks.set($any($event.target).checked)" />
            <span class="toggle-glyph">
              <svg viewBox="0 0 24 12" width="24" height="12" aria-hidden="true">
                <path d="M0,8 C5,2 10,11 14,5 S22,3 24,7" fill="none" stroke="rgba(45, 212, 191, 0.7)" stroke-width="1.5" />
              </svg>
            </span>
            <span class="toggle-text">
              <span class="toggle-name">Trajets</span>
              <span class="toggle-count">{{ tracksCount() }} agrégés/jour</span>
            </span>
          </label>
          <label class="layer-toggle" [class.dim]="!sstActive()">
            <input type="checkbox" [checked]="showSST()" (change)="showSST.set($any($event.target).checked)" />
            <span class="toggle-glyph">
              <span class="glyph-gradient"></span>
            </span>
            <span class="toggle-text">
              <span class="toggle-name">SST</span>
              <span class="toggle-count">température mer (NOAA)</span>
            </span>
            @if (isAuthenticated() && palettesFor('sst').length > 0) {
              <select class="palette-select" [value]="prefFor('sst')" (change)="setPalettePref('sst', $any($event.target).value)" (click)="$event.stopPropagation()">
                <option value="">Style par défaut</option>
                @for (p of palettesFor('sst'); track p.id) { <option [value]="p.id">{{ p.name }}</option> }
              </select>
            }
          </label>
          <label class="layer-toggle" [class.dim]="!rainActive()">
            <input type="checkbox" [checked]="showRain()" (change)="showRain.set($any($event.target).checked)" />
            <span class="toggle-glyph">
              <span class="glyph-rain"></span>
            </span>
            <span class="toggle-text">
              <span class="toggle-name">Radar pluie</span>
              <span class="toggle-count">{{ rainStatus() }}</span>
            </span>
          </label>
          <label class="layer-toggle" [class.dim]="!windActive()">
            <input type="checkbox" [checked]="showWind()" (change)="showWind.set($any($event.target).checked)" />
            <span class="toggle-glyph">
              <span class="glyph-wind"></span>
            </span>
            <span class="toggle-text">
              <span class="toggle-name">Vent</span>
              <span class="toggle-count">forecast 10m (GFS)</span>
            </span>
            @if (isAuthenticated() && palettesFor('wind').length > 0) {
              <select class="palette-select" [value]="prefFor('wind')" (change)="setPalettePref('wind', $any($event.target).value)" (click)="$event.stopPropagation()">
                <option value="">Style par défaut</option>
                @for (p of palettesFor('wind'); track p.id) { <option [value]="p.id">{{ p.name }}</option> }
              </select>
            }
          </label>
          <label class="layer-toggle" [class.dim]="!wavesActive()">
            <input type="checkbox" [checked]="showWaves()" (change)="showWaves.set($any($event.target).checked)" />
            <span class="toggle-glyph">
              <span class="glyph-waves"></span>
            </span>
            <span class="toggle-text">
              <span class="toggle-name">Vagues</span>
              <span class="toggle-count">hauteur sig. (WW3)</span>
            </span>
            @if (isAuthenticated() && palettesFor('waves').length > 0) {
              <select class="palette-select" [value]="prefFor('waves')" (change)="setPalettePref('waves', $any($event.target).value)" (click)="$event.stopPropagation()">
                <option value="">Style par défaut</option>
                @for (p of palettesFor('waves'); track p.id) { <option [value]="p.id">{{ p.name }}</option> }
              </select>
            }
          </label>
          <label class="layer-toggle" [class.dim]="!showWindArrows()">
            <input type="checkbox" [checked]="showWindArrows()" (change)="showWindArrows.set($any($event.target).checked)" />
            <span class="toggle-glyph">
              <span class="glyph-arrow glyph-arrow-wind">↑</span>
            </span>
            <span class="toggle-text">
              <span class="toggle-name">Vent flèches</span>
              <span class="toggle-count">{{ windArrowsStatus() }}</span>
            </span>
          </label>
          <label class="layer-toggle" [class.dim]="!showWaveArrows()">
            <input type="checkbox" [checked]="showWaveArrows()" (change)="showWaveArrows.set($any($event.target).checked)" />
            <span class="toggle-glyph">
              <span class="glyph-arrow glyph-arrow-wave">↑</span>
            </span>
            <span class="toggle-text">
              <span class="toggle-name">Vagues flèches</span>
              <span class="toggle-count">{{ waveArrowsStatus() }}</span>
            </span>
          </label>
        </div>

        <div class="legend-section-title">Catégories navires</div>
        @for (cat of categories; track cat.key) {
          <div class="legend-item">
            <span class="legend-dot" [style.background]="cat.color.fill" [style.border-color]="cat.color.stroke"></span>
            <span>{{ cat.color.label }}</span>
          </div>
        }

        <div class="legend-stats">
          <div class="legend-mode" [class.live]="modeIsLive()" [class.future]="modeIsFuture()">
            @if (modeIsLive()) { ● LIVE }
            @else if (modeIsFuture()) { ◷ FORECAST }
            @else { ◷ REPLAY }
          </div>
          @if (lastRefreshAt()) {
            <div class="legend-refresh">refresh {{ lastRefreshAt() | date:'HH:mm:ss' }}</div>
          }
          @if (errorMsg()) {
            <div class="legend-error">{{ errorMsg() }}</div>
          }
        </div>
      </div>

      <!-- Popup overlay (positionné par OL via Overlay) -->
      <div class="popup" #popupEl [class.visible]="selectedVessel() !== null">
        @if (selectedVessel(); as v) {
          <button class="popup-close" type="button" (click)="closePopup()">×</button>
          <div class="popup-name">{{ v.name || ('MMSI ' + v.mmsi) }}</div>
          <div class="popup-meta">
            <span class="badge" [style.background]="categoryColor(v.ship_type)">
              {{ categoryLabel(v.ship_type) }}
            </span>
            @if (v.flag) { <span class="popup-flag">{{ v.flag }}</span> }
          </div>
          <div class="popup-row"><span>MMSI</span><strong class="mono">{{ v.mmsi }}</strong></div>
          @if (v.callsign) {
            <div class="popup-row"><span>Indicatif</span><strong class="mono">{{ v.callsign }}</strong></div>
          }
          @if (v.length_m) {
            <div class="popup-row"><span>Dimensions</span><strong>{{ v.length_m }} × {{ v.width_m || '?' }} m</strong></div>
          }
          @if (v.destination) {
            <div class="popup-row"><span>Destination</span><strong>{{ v.destination }}</strong></div>
          }
          <div class="popup-row"><span>Vu</span><strong>{{ v.last_seen | date:'HH:mm:ss' }}</strong></div>
        }
      </div>

      <app-time-slider (timeChange)="onTimeChange($event)" />
    </div>
  `,
  styles: `
    :host {
      display: block;
      height: 100%;
      width: 100%;
    }
    .map-container {
      position: relative;
      height: 100%;
      width: 100%;
    }
    .map {
      height: 100%;
      width: 100%;
      background: var(--bg-2);
    }
    .auth-corner {
      position: absolute;
      top: 1em; right: 1em;
      z-index: 10;
      display: flex; align-items: center; gap: 0.5em;
      background: rgba(19, 24, 38, 0.92);
      border: 1px solid var(--border);
      backdrop-filter: blur(8px);
      border-radius: 8px;
      padding: 0.5em 0.9em;
      font-size: 0.78rem;
      color: var(--fg-muted);
    }
    .auth-link {
      color: var(--accent-bright);
      text-decoration: none;
      &:hover { color: var(--fg); }
    }
    .auth-sep { color: var(--fg-dim); }
    .auth-btn {
      background: transparent;
      border: 0;
      color: var(--fg-muted);
      cursor: pointer;
      font: inherit;
      padding: 0;
      &:hover { color: var(--negative); }
    }
    .palette-select {
      background: var(--bg-3);
      border: 1px solid var(--border);
      color: var(--fg);
      font-size: 0.7rem;
      padding: 0.15em 0.3em;
      border-radius: 4px;
      margin-left: auto;
      max-width: 110px;
    }
    .legend {
      position: absolute;
      top: 1em;
      left: 1em;
      background: rgba(19, 24, 38, 0.92);
      backdrop-filter: blur(8px);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1em 1.2em;
      box-shadow: var(--shadow);
      z-index: 10;
      min-width: 200px;
    }
    .legend-title {
      font-family: var(--font-mono);
      font-size: 0.7rem;
      letter-spacing: 0.2em;
      color: var(--accent);
      font-weight: 700;
    }
    .legend-subtitle {
      font-size: 0.75rem;
      color: var(--fg-muted);
      margin-bottom: 0.8em;
    }
    .layer-toggles {
      display: flex;
      flex-direction: column;
      gap: 0.5em;
      margin: 0.4em 0 1em;
      padding-bottom: 0.8em;
      border-bottom: 1px solid var(--border);
    }
    .layer-toggle {
      display: flex;
      align-items: center;
      gap: 0.6em;
      font-size: 0.8rem;
      color: var(--fg);
      cursor: pointer;
      input {
        accent-color: var(--accent);
        cursor: pointer;
        flex-shrink: 0;
        width: 16px;
        height: 16px;
      }
      /* Dim only the visual preview + label, NOT the checkbox itself —
         so on/off state is always crystal clear. */
      &.dim {
        .toggle-glyph, .toggle-text { opacity: 0.4; transition: opacity 200ms; }
      }
    }
    .toggle-glyph {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      width: 38px;
      flex-shrink: 0;
    }
    .glyph-dot {
      display: inline-block;
      width: 8px; height: 8px;
      border-radius: 50%;
      border: 1px solid;
    }
    .glyph-gradient {
      display: inline-block;
      width: 36px;
      height: 8px;
      border-radius: 2px;
      background: linear-gradient(to right, #1e3a8a 0%, #06b6d4 30%, #fde047 60%, #ef4444 100%);
      border: 1px solid rgba(255,255,255,0.15);
    }
    .glyph-rain {
      display: inline-block;
      width: 36px;
      height: 8px;
      border-radius: 2px;
      /* gradient pluie : transparent → bleu clair → vert → jaune → rouge (intensité radar) */
      background: linear-gradient(to right, rgba(255,255,255,0.05) 0%, #38bdf8 25%, #4ade80 50%, #fbbf24 75%, #ef4444 100%);
      border: 1px solid rgba(255,255,255,0.15);
    }
    .glyph-wind {
      display: inline-block;
      width: 36px;
      height: 8px;
      border-radius: 2px;
      /* gradient force vent (Beaufort) : calme → frais → fort → tempête */
      background: linear-gradient(to right, #cbd5e1 0%, #38bdf8 35%, #fbbf24 70%, #dc2626 100%);
      border: 1px solid rgba(255,255,255,0.15);
    }
    .glyph-waves {
      display: inline-block;
      width: 36px;
      height: 8px;
      border-radius: 2px;
      /* gradient hauteur vagues : plat → houle → forte → grosse mer */
      background: linear-gradient(to right, #1e3a8a 0%, #06b6d4 30%, #fbbf24 70%, #ef4444 100%);
      border: 1px solid rgba(255,255,255,0.15);
    }
    .glyph-arrow {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 16px;
      border-radius: 2px;
      font-size: 0.95rem;
      line-height: 1;
      border: 1px solid rgba(255,255,255,0.15);
    }
    .glyph-arrow-wind {
      background: linear-gradient(to right, rgba(56,189,248,0.25), rgba(220,38,38,0.45));
      color: #fde047;
    }
    .glyph-arrow-wave {
      background: linear-gradient(to right, rgba(14,165,233,0.25), rgba(239,68,68,0.45));
      color: #06b6d4;
    }
    .toggle-text {
      display: flex;
      flex-direction: column;
      line-height: 1.15;
    }
    .toggle-name {
      color: var(--fg);
      font-weight: 500;
    }
    .toggle-count {
      font-family: var(--font-mono);
      font-size: 0.65rem;
      color: var(--fg-dim);
      margin-top: 1px;
    }
    .legend-section-title {
      font-family: var(--font-mono);
      font-size: 0.6rem;
      letter-spacing: 0.15em;
      color: var(--fg-dim);
      text-transform: uppercase;
      margin: 0 0 0.3em;
    }
    .legend-item {
      display: flex;
      align-items: center;
      gap: 0.5em;
      font-size: 0.8rem;
      color: var(--fg);
      padding: 0.15em 0;
    }
    .legend-dot {
      display: inline-block;
      width: 12px; height: 12px;
      border-radius: 50%;
      border: 1px solid;
    }
    .legend-stats {
      margin-top: 0.8em;
      padding-top: 0.8em;
      border-top: 1px solid var(--border);
      font-size: 0.75rem;
      color: var(--fg-muted);
      strong { color: var(--accent-bright); }
    }
    .legend-mode {
      font-family: var(--font-mono);
      font-size: 0.7rem;
      letter-spacing: 0.15em;
      color: var(--fg-muted);
      &.live { color: var(--accent-bright); }
      &.future { color: var(--warning); }
    }
    .legend-refresh {
      font-family: var(--font-mono);
      font-size: 0.65rem;
      color: var(--fg-dim);
      margin-top: 0.2em;
    }
    .legend-error {
      color: var(--negative);
      font-size: 0.7rem;
      margin-top: 0.4em;
    }

    .popup {
      position: absolute;
      pointer-events: auto;
      background: rgba(19, 24, 38, 0.96);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 0.8em 1em;
      min-width: 240px;
      box-shadow: var(--shadow);
      transform: translate(-50%, calc(-100% - 12px));
      visibility: hidden;
      &.visible { visibility: visible; }

      &::after {
        content: '';
        position: absolute;
        bottom: -7px;
        left: 50%;
        transform: translateX(-50%) rotate(45deg);
        width: 12px; height: 12px;
        background: rgba(19, 24, 38, 0.96);
        border-right: 1px solid var(--border);
        border-bottom: 1px solid var(--border);
      }
    }
    .popup-close {
      position: absolute;
      top: 0.3em; right: 0.3em;
      background: none;
      border: none;
      color: var(--fg-dim);
      font-size: 1.4em;
      line-height: 1;
      cursor: pointer;
      padding: 0.2em 0.4em;
      &:hover { color: var(--fg); }
    }
    .popup-name {
      font-weight: 700;
      color: var(--fg);
      margin-bottom: 0.4em;
      padding-right: 1.5em;
    }
    .popup-meta {
      display: flex;
      gap: 0.5em;
      align-items: center;
      margin-bottom: 0.6em;
    }
    .badge {
      font-size: 0.7rem;
      padding: 0.15em 0.5em;
      border-radius: 4px;
      color: var(--bg);
      font-weight: 600;
    }
    .popup-flag {
      font-family: var(--font-mono);
      font-size: 0.7rem;
      color: var(--fg-muted);
    }
    .popup-row {
      display: flex;
      justify-content: space-between;
      padding: 0.2em 0;
      font-size: 0.78rem;
      span { color: var(--fg-muted); }
      strong { color: var(--fg); }
    }
    .mono { font-family: var(--font-mono); font-size: 0.72rem; }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MapComponent implements AfterViewInit, OnDestroy {
  private readonly vessels = inject(VesselsService);
  private readonly rainviewer = inject(RainviewerService);
  private readonly arrows = inject(ArrowsService);
  private readonly auth = inject(AuthService);
  private readonly palettesSvc = inject(PalettesService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  readonly currentUser = this.auth.currentUser;
  readonly isAuthenticated = this.auth.isAuthenticated;

  readonly mapEl = viewChild.required<ElementRef<HTMLDivElement>>('mapEl');
  readonly popupEl = viewChild.required<ElementRef<HTMLDivElement>>('popupEl');

  readonly selectedVessel = signal<VesselProperties | null>(null);
  readonly vesselsCount = signal(0);
  readonly tracksCount = signal(0);
  readonly lastRefreshAt = signal<Date | null>(null);
  readonly errorMsg = signal<string | null>(null);

  // Toggles user — par défaut tout visible (sauf rain/wind/waves : opt-in
  // pour éviter d'écraser l'image avec des tiles tant que pas demandé)
  readonly showVessels = signal(true);
  readonly showTracks = signal(true);
  readonly showSST = signal(true);
  readonly showRain = signal(false);
  readonly showWind = signal(false);
  readonly showWaves = signal(false);
  readonly showWindArrows = signal(false);
  readonly showWaveArrows = signal(false);
  readonly windArrowsStatus = signal('forecast vent (GFS)');
  readonly waveArrowsStatus = signal('vagues primaires (WW3)');

  // Mode courant (signal-driven, recalculé à chaque tick du time slider).
  // Sert à colorer les badges + griser les toggles dont la layer ne peut
  // PAS s'afficher dans le mode courant (ex: navires en futur, SST en futur).
  readonly currentTimeSig = signal<Date>(new Date());
  readonly modeIsLive = computed(() => Math.abs(Date.now() - this.currentTimeSig().getTime()) < LIVE_THRESHOLD_MS);
  readonly modeIsFuture = computed(() => this.currentTimeSig().getTime() > Date.now() + LIVE_THRESHOLD_MS);
  // "Active" = la couche a effectivement de quoi s'afficher dans le mode courant.
  readonly vesselsActive = computed(() => this.showVessels() && !this.modeIsFuture());
  readonly tracksActive  = computed(() => this.showTracks() && !this.modeIsLive() && !this.modeIsFuture());
  readonly sstActive     = computed(() => this.showSST() && !this.modeIsFuture());
  // Rain : RainViewer ne couvre que [-2h, +30min]. Hors fenêtre = inutile.
  readonly rainStatus    = signal('précipitations 10min');
  readonly rainActive    = computed(() => this.showRain() && this.rainHasFrameForCurrent());
  // Wind/Waves : forecast NOAA jusqu'à +72h. Pas de back-history (on garde
  // que les forecasts les plus récents). Donc visible si le cursor est
  // dans [run-1h, run+forecast_hours].
  readonly windActive    = computed(() => this.showWind());
  readonly wavesActive   = computed(() => this.showWaves());
  // Helper : true si une frame RainViewer est dispo pour le cursor courant.
  // Mis à jour à chaque tick via updateRainLayer().
  private rainHasFrame = signal(false);
  private rainHasFrameForCurrent(): boolean {
    return this.rainHasFrame();
  }

  // Catégories pour la légende
  readonly categories = (Object.keys(CATEGORY_COLOR) as Category[]).map((key) => ({
    key,
    color: CATEGORY_COLOR[key],
  }));

  private map?: Map;
  private vesselSource?: VectorSource;
  private trackSource?: VectorSource;
  private vesselLayer?: VectorLayer<VectorSource>;
  private trackLayer?: VectorLayer<VectorSource>;
  private sstLayer?: TileLayer<TileWMS>;
  private sstSource?: TileWMS;
  private rainLayer?: TileLayer<XYZ>;
  private rainSource?: XYZ;
  private rainSnapshot?: RainViewerSnapshot;
  private rainSnapshotTimer?: ReturnType<typeof setInterval>;
  private currentRainPath?: string;
  private windLayer?: TileLayer<TileWMS>;
  private windSource?: TileWMS;
  private wavesLayer?: TileLayer<TileWMS>;
  private wavesSource?: TileWMS;
  private windArrowsLayer?: VectorLayer<VectorSource>;
  private windArrowsSource?: VectorSource;
  private waveArrowsLayer?: VectorLayer<VectorSource>;
  private waveArrowsSource?: VectorSource;
  private lastWindArrowsTs?: string;
  private lastWaveArrowsTs?: string;
  private arrowsFetchDebounce?: ReturnType<typeof setTimeout>;
  private popupOverlay?: Overlay;
  private liveSub?: Subscription;
  private trackSub?: Subscription;
  private pastVesselsSub?: Subscription;
  private currentTime: Date = new Date();
  private lastTrackDay: string | null = null;
  // Coalesce past-mode vessel fetches : si l'utilisateur drag rapidement
  // le slider, on n'envoie qu'une requête après ~150ms d'inactivité.
  private pastFetchDebounce?: ReturnType<typeof setTimeout>;
  private readonly geoJsonFmt = new GeoJSON({ featureProjection: 'EPSG:3857', dataProjection: 'EPSG:4326' });

  constructor() {
    // Effect réactif : à chaque changement de signal toggle, on ré-applique
    // la visibility des layers OL. Sans ça, cocher/décocher un toggle ne
    // déclenche aucune mise à jour côté Map (les layers OL ne sont pas
    // bound aux signals — ils sont créés impérativement dans initMap).
    effect(() => {
      // Read pour s'abonner — le get suffit avec signals
      this.showVessels(); this.showTracks(); this.showSST();
      this.showRain();    this.showWind();   this.showWaves();
      this.showWindArrows(); this.showWaveArrows();
      // Defer pour s'exécuter après ngAfterViewInit (this.*Layer dispo)
      queueMicrotask(() => {
        this.applyLayerVisibility();
        // Si on vient d'activer un toggle arrows, déclenche un fetch
        if (this.showWindArrows() || this.showWaveArrows()) {
          this.refreshArrowsForTime(this.currentTime);
        }
      });
    });

    // Effect réactif : applique le style user préféré sur chaque layer WMS.
    // Quand le user choisit/clear un palette pour une layer, on update le
    // STYLES param du TileWMS source — GeoServer applique alors le style
    // user_<id>_<slug> au lieu du defaultStyle.
    effect(() => {
      const prefs = this.palettesSvc.myPreferences();
      queueMicrotask(() => this.applyUserStyles(prefs));
    });
  }

  /** Mémoize la liste des palettes par layer kind. */
  palettesFor(kind: LayerKind): Palette[] {
    return this.palettesSvc.myPalettes().filter((p) => p.layerKind === kind);
  }

  /** Préférence courante (string id ou '') pour le <select>. */
  prefFor(kind: LayerKind): string {
    const styleName = this.palettesSvc.myPreferences()[kind];
    if (!styleName) return '';
    // Look up the palette id matching this style
    const found = this.palettesSvc.myPalettes().find(
      (p) => `user_${p.userId}_${p.slug}` === styleName.replace(/^maritime:/, ''),
    );
    return found ? String(found.id) : '';
  }

  async setPalettePref(kind: LayerKind, value: string): Promise<void> {
    const id = value === '' ? null : Number(value);
    try {
      await this.palettesSvc.setPreference(kind, id);
    } catch (err) {
      console.error('setPalettePref failed', err);
    }
  }

  logout(): void {
    this.auth.logout();
    this.palettesSvc.clear();
    // Force WMS layers to drop their custom STYLES (back to default)
    this.applyUserStyles({});
    this.router.navigate(['/auth/login']);
  }

  /**
   * Applique le STYLES param sur les sources WMS selon les préférences user.
   * `prefs` keys = layerKind, values = "user_<id>_<slug>" (ou null/absent).
   * Quand absent → on reset le STYLES à '' (= defaultStyle côté GeoServer).
   */
  private applyUserStyles(prefs: Record<string, string | null>): void {
    const styleParam = (kind: string): string => {
      const sn = prefs[kind];
      return sn ? `maritime:${sn}` : '';
    };
    if (this.sstSource)   this.sstSource.updateParams({ STYLES: styleParam('sst') });
    if (this.windSource)  this.windSource.updateParams({ STYLES: styleParam('wind') });
    if (this.wavesSource) this.wavesSource.updateParams({ STYLES: styleParam('waves') });
  }

  ngAfterViewInit(): void {
    this.initMap();
    // Démarre en mode live
    this.applyLayerVisibility();
    this.refreshForTime(new Date());
    this.startLiveLoopIfNeeded();
    // Bootstrap snapshot RainViewer + refresh toutes les 5 min (le serveur
    // RV ajoute une frame toutes les 10min, donc 5min de poll = au pire on
    // découvre la nouvelle frame avec 5min de retard, OK).
    this.refreshRainSnapshot();
    this.rainSnapshotTimer = setInterval(() => this.refreshRainSnapshot(), 5 * 60_000);
    // Bootstrap palette preferences si déjà connecté (le token est en
    // localStorage et restaure currentUser via signal au chargement).
    if (this.isAuthenticated()) {
      this.palettesSvc.loadMyContext().catch(() => {/* token expiré ou api down — silence */});
    }
  }

  ngOnDestroy(): void {
    this.liveSub?.unsubscribe();
    this.trackSub?.unsubscribe();
    this.pastVesselsSub?.unsubscribe();
    if (this.pastFetchDebounce) clearTimeout(this.pastFetchDebounce);
    if (this.rainSnapshotTimer) clearInterval(this.rainSnapshotTimer);
    if (this.arrowsFetchDebounce) clearTimeout(this.arrowsFetchDebounce);
    this.map?.setTarget(undefined);
    this.map?.dispose();
  }

  // ─── Time slider callback ──────────────────────────────────────────
  onTimeChange(t: Date): void {
    this.currentTime = t;
    this.currentTimeSig.set(t);
    this.refreshForTime(t);
    this.startLiveLoopIfNeeded();
    this.updateRainLayer(t);
    this.refreshArrowsForTime(t);
    this.applyLayerVisibility();
  }

  // ─── RainViewer ───────────────────────────────────────────────────
  private async refreshRainSnapshot(): Promise<void> {
    try {
      this.rainSnapshot = await this.rainviewer.getSnapshot();
      // Re-eval du cursor courant avec le nouveau snapshot
      this.updateRainLayer(this.currentTime);
      this.applyLayerVisibility();
    } catch (err) {
      // Silencieux : RainViewer indispo n'empêche rien d'autre
      this.rainStatus.set('indisponible');
    }
  }

  /**
   * Sélectionne la frame RainViewer la plus proche du cursor courant et
   * met à jour l'URL XYZ de la layer. Si aucune frame ≤ 15min, cache la
   * layer et signale "hors fenêtre" dans le toggle.
   */
  private updateRainLayer(t: Date): void {
    if (!this.rainSource || !this.rainSnapshot) return;
    const atSec = Math.floor(t.getTime() / 1000);
    const frame = this.rainviewer.findNearestFrame(this.rainSnapshot, atSec);
    if (!frame) {
      this.rainHasFrame.set(false);
      this.rainStatus.set('hors fenêtre (-2h, +30min)');
      return;
    }
    // Évite de re-set le source.url si on est déjà sur la même frame —
    // sinon OL refait tous les fetchs tile à chaque tick du slider.
    if (this.currentRainPath !== frame.path) {
      this.currentRainPath = frame.path;
      const url = this.rainviewer.buildTileUrl(this.rainSnapshot.host, frame.path);
      this.rainSource.setUrl(url);
    }
    this.rainHasFrame.set(true);
    const deltaMin = Math.round((atSec - frame.time) / 60);
    const sign = deltaMin === 0 ? '=' : (deltaMin > 0 ? `+${deltaMin}min` : `${deltaMin}min`);
    this.rainStatus.set(`frame ${sign} du cursor`);
  }

  // ─── Layer visibility logic (combine user toggles + currentTime mode) ─
  private isLive(): boolean {
    return Math.abs(Date.now() - this.currentTime.getTime()) < LIVE_THRESHOLD_MS;
  }
  private isFuture(): boolean {
    return this.currentTime.getTime() > Date.now() + LIVE_THRESHOLD_MS;
  }

  private applyLayerVisibility(): void {
    if (!this.vesselLayer || !this.trackLayer || !this.sstLayer) return;
    // Vessels = visible en live ET en past (replay via SQL view paramétrable
    // vessels_at_time). Pas en futur (pas de forecast trajectoire).
    this.vesselLayer.setVisible(this.showVessels() && !this.isFuture());
    // Tracks = past only — résumé daily (LineStrings agrégés)
    this.trackLayer.setVisible(this.showTracks() && !this.isLive() && !this.isFuture());
    // SST = past only (forecast pas dispo)
    this.sstLayer.setVisible(this.showSST() && !this.isFuture());
    // Rain : visible si toggle ON + frame disponible pour le cursor courant
    if (this.rainLayer) {
      this.rainLayer.setVisible(this.showRain() && this.rainHasFrame());
    }
    // Wind/Waves : visibles à n'importe quel moment où il y a un forecast
    // (NOAA accepte TIME=NEAREST → matche le timestep le plus proche).
    if (this.windLayer)  this.windLayer.setVisible(this.showWind());
    if (this.wavesLayer) this.wavesLayer.setVisible(this.showWaves());
    // Arrows : visibles si toggle ON. Le contenu est rafraîchi par
    // refreshArrowsForTime() à chaque cursor change.
    if (this.windArrowsLayer) this.windArrowsLayer.setVisible(this.showWindArrows());
    if (this.waveArrowsLayer) this.waveArrowsLayer.setVisible(this.showWaveArrows());
  }

  /**
   * Fetch arrows GeoJSON pour vent + vagues au cursor courant. Debounce
   * 200ms pendant les drags du slider pour éviter le spam réseau.
   * "Gaffe au sens" : convention adoptée = la flèche pointe vers OÙ va le vent
   * (et la houle). dirTo (compass deg) → rotation OL en radians.
   */
  private refreshArrowsForTime(t: Date): void {
    if (this.arrowsFetchDebounce) clearTimeout(this.arrowsFetchDebounce);
    this.arrowsFetchDebounce = setTimeout(() => this.doRefreshArrows(t), 200);
  }

  private async doRefreshArrows(t: Date): Promise<void> {
    const wantWind = this.showWindArrows();
    const wantWave = this.showWaveArrows();
    if (!wantWind && !wantWave) return;
    const manifest = await this.arrows.getManifest();
    if (!manifest) return;
    if (wantWind && this.windArrowsSource) {
      const ts = this.arrows.findNearestTs(manifest.wind, t);
      if (!ts) {
        this.windArrowsSource.clear();
        this.windArrowsStatus.set('hors fenêtre forecast');
      } else if (ts !== this.lastWindArrowsTs) {
        try {
          const fc = await this.arrows.fetchArrows('wind', ts);
          this.windArrowsSource.clear();
          const features = this.geoJsonFmt.readFeatures(fc);
          this.windArrowsSource.addFeatures(features);
          this.lastWindArrowsTs = ts;
          this.windArrowsStatus.set(this.formatTsLabel(ts, t));
        } catch (err: any) {
          this.windArrowsStatus.set(`erreur: ${err?.message ?? err}`);
        }
      }
    }
    if (wantWave && this.waveArrowsSource) {
      const ts = this.arrows.findNearestTs(manifest.wave, t);
      if (!ts) {
        this.waveArrowsSource.clear();
        this.waveArrowsStatus.set('hors fenêtre forecast');
      } else if (ts !== this.lastWaveArrowsTs) {
        try {
          const fc = await this.arrows.fetchArrows('wave', ts);
          this.waveArrowsSource.clear();
          const features = this.geoJsonFmt.readFeatures(fc);
          this.waveArrowsSource.addFeatures(features);
          this.lastWaveArrowsTs = ts;
          this.waveArrowsStatus.set(this.formatTsLabel(ts, t));
        } catch (err: any) {
          this.waveArrowsStatus.set(`erreur: ${err?.message ?? err}`);
        }
      }
    }
  }

  private formatTsLabel(ts: string, cursor: Date): string {
    // 20260510T120000Z → "10/05 12:00 (±Nh du cursor)"
    const date = new Date(
      `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T${ts.slice(9, 11)}:${ts.slice(11, 13)}:${ts.slice(13, 15)}Z`,
    );
    const deltaMin = Math.round((date.getTime() - cursor.getTime()) / 60_000);
    const deltaStr = Math.abs(deltaMin) < 60
      ? `${deltaMin > 0 ? '+' : ''}${deltaMin}min`
      : `${deltaMin > 0 ? '+' : ''}${Math.round(deltaMin / 60)}h`;
    return `${date.getUTCDate().toString().padStart(2, '0')}/${(date.getUTCMonth() + 1).toString().padStart(2, '0')} ${date.getUTCHours().toString().padStart(2, '0')}h · ${deltaStr}`;
  }

  /**
   * SVG inline data-URL arrow pointant vers le haut (NORD). Rotated par OL
   * via `Icon.rotation` (radians) pour matcher `dirTo` compass.
   * Le shaft est plus long pour rendre visible la direction même à petit zoom.
   */
  private arrowDataUrl(color: string): string {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
      <path d="M12 2 L17 12 L13 11 L13 22 L11 22 L11 11 L7 12 Z" fill="${color}" stroke="#0a0e1a" stroke-width="0.6"/>
    </svg>`;
    return 'data:image/svg+xml;base64,' + btoa(svg);
  }

  private styleArrow(kind: ArrowsKind, feat: FeatureLike): Style {
    const props = feat.getProperties() as { speed?: number; hs?: number; dirTo: number };
    const value = kind === 'wind' ? (props.speed ?? 0) : (props.hs ?? 0);
    const color = this.colorForArrow(kind, value);
    const scale = kind === 'wind' ? this.scaleForWind(value) : this.scaleForWaves(value);
    return new Style({
      image: new Icon({
        src: this.arrowDataUrl(color),
        rotation: ((props.dirTo ?? 0) * Math.PI) / 180,
        rotateWithView: true,
        scale,
        anchor: [0.5, 0.5],
      }),
    });
  }

  private colorForArrow(kind: ArrowsKind, v: number): string {
    if (kind === 'wind') {
      // Beaufort-like : ≤3 bleu, ≤6 cyan, ≤10 vert, ≤14 jaune, ≤18 orange, >18 rouge
      if (v <= 3)  return '#38bdf8';
      if (v <= 6)  return '#06b6d4';
      if (v <= 10) return '#22c55e';
      if (v <= 14) return '#fde047';
      if (v <= 18) return '#fb923c';
      return '#dc2626';
    } else {
      if (v <= 0.5) return '#1e40af';
      if (v <= 1.5) return '#0ea5e9';
      if (v <= 2.5) return '#06b6d4';
      if (v <= 4)   return '#22c55e';
      if (v <= 6)   return '#fbbf24';
      return '#dc2626';
    }
  }

  private scaleForWind(v: number): number {
    return Math.min(1.0, 0.55 + v * 0.025);   // 0.55 (calm) → 1.0 (storm)
  }
  private scaleForWaves(v: number): number {
    return Math.min(1.0, 0.6 + v * 0.07);     // 0.6 (flat) → 1.0 (rough)
  }

  // ─── Refresh : déclenche le bon fetch selon currentTime ─────────────
  private refreshForTime(t: Date): void {
    const isLive = Math.abs(Date.now() - t.getTime()) < LIVE_THRESHOLD_MS;
    if (isLive) {
      // En mode live, le startLiveLoopIfNeeded gère le fetch vessels.
      this.trackSource?.clear();
      this.tracksCount.set(0);
      this.lastTrackDay = null;
      this.cancelPastVesselsFetch();
      this.closePopup();
    } else if (!this.isFuture()) {
      // Past mode : tracks daily (LineStrings) + vessels positions à T (debounced).
      const day = toIsoDate(t);
      if (day !== this.lastTrackDay) {
        this.lastTrackDay = day;
        this.fetchTracks(day);
      }
      this.scheduleFetchVesselsAt(t);
    } else {
      // Future : aucun fetch (forecast pas implémenté).
      this.cancelPastVesselsFetch();
      this.vesselSource?.clear();
      this.vesselsCount.set(0);
    }
    // Snap-to-latest pour les WMS time-enabled : on passe une PLAGE
    // [old, cursor] au lieu d'un instant pile. GeoServer ImageMosaic
    // matche le timestep le plus récent dispo dans la plage — donc on
    // affiche toujours la dernière donnée connue jusqu'au cursor, plutôt
    // qu'une tile vide quand l'instant exact n'est pas indexé.
    const isoTs = toIsoTimestamp(t);
    const timeRange = `1970-01-01T00:00:00Z/${isoTs}`;
    if (this.sstSource && !this.isFuture()) {
      this.sstSource.updateParams({ TIME: timeRange });
    }
    // Wind/Waves : forecast peut couvrir le passé (run analyse) ET le futur
    // jusqu'à +72h. On utilise la même plage [past..cursor] pour le past
    // mode, mais en mode futur on accepte aussi le forecast.
    if (this.windSource)  this.windSource.updateParams({ TIME: timeRange });
    if (this.wavesSource) this.wavesSource.updateParams({ TIME: timeRange });
  }

  /**
   * Debounce les fetches WFS pendant le drag du slider — évite de spammer
   * GeoServer (la SQL view scanne vessel_positions et coûte ~50-200ms).
   * Fenêtre par défaut ±5min : compromis entre densité (assez de bateaux
   * visibles) et précision temporelle.
   */
  private scheduleFetchVesselsAt(t: Date): void {
    if (this.pastFetchDebounce) clearTimeout(this.pastFetchDebounce);
    this.pastFetchDebounce = setTimeout(() => this.fetchVesselsAt(t), 150);
  }

  private fetchVesselsAt(t: Date): void {
    this.pastVesselsSub?.unsubscribe();
    this.pastVesselsSub = this.vessels
      .fetchVesselsAtTime(t, 300)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (fc) => {
          this.errorMsg.set(null);
          this.lastRefreshAt.set(new Date());
          this.vesselsCount.set(fc.features.length);
          if (!this.vesselSource) return;
          this.vesselSource.clear();
          const features = this.geoJsonFmt.readFeatures(fc);
          this.vesselSource.addFeatures(features);
        },
        error: (err) => {
          this.errorMsg.set(`Erreur WFS replay : ${err.message ?? err}`);
          this.vesselsCount.set(0);
        },
      });
  }

  private cancelPastVesselsFetch(): void {
    if (this.pastFetchDebounce) {
      clearTimeout(this.pastFetchDebounce);
      this.pastFetchDebounce = undefined;
    }
    this.pastVesselsSub?.unsubscribe();
    this.pastVesselsSub = undefined;
  }

  private startLiveLoopIfNeeded(): void {
    if (!this.isLive()) {
      this.liveSub?.unsubscribe();
      this.liveSub = undefined;
      return;
    }
    if (this.liveSub) return; // déjà actif
    this.liveSub = interval(REFRESH_INTERVAL_MS)
      .pipe(
        startWith(0),
        switchMap(() => this.vessels.fetchLiveVessels()),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (fc) => {
          this.errorMsg.set(null);
          this.lastRefreshAt.set(new Date());
          this.vesselsCount.set(fc.features.length);
          if (!this.vesselSource) return;
          this.vesselSource.clear();
          const features = this.geoJsonFmt.readFeatures(fc);
          this.vesselSource.addFeatures(features);
        },
        error: (err) => this.errorMsg.set(`Erreur WFS live : ${err.message ?? err}`),
      });
  }

  private fetchTracks(day: string): void {
    this.trackSub?.unsubscribe();
    this.trackSub = this.vessels
      .fetchTracksForDay(day)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (fc) => {
          this.errorMsg.set(null);
          this.tracksCount.set(fc.features.length);
          this.vesselsCount.set(0);
          if (!this.trackSource) return;
          this.trackSource.clear();
          const features = this.geoJsonFmt.readFeatures(fc);
          this.trackSource.addFeatures(features);
        },
        error: (err) => {
          this.errorMsg.set(`Erreur WFS tracks : ${err.message ?? err}`);
          this.tracksCount.set(0);
        },
      });
  }

  closePopup(): void {
    this.selectedVessel.set(null);
    this.popupOverlay?.setPosition(undefined);
  }

  categoryLabel(shipType: number | null): string {
    return CATEGORY_COLOR[categoryOf(shipType)].label;
  }
  categoryColor(shipType: number | null): string {
    return CATEGORY_COLOR[categoryOf(shipType)].fill;
  }

  // ─── Map init ───────────────────────────────────────────────────────
  private initMap(): void {
    this.vesselSource = new VectorSource();
    this.trackSource = new VectorSource();

    const baseTile = new TileLayer({
      source: new XYZ({
        url: 'https://{a-d}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png',
        attributions: '© OpenStreetMap, © CARTO',
        maxZoom: 19,
      }),
    });

    const labelsTile = new TileLayer({
      source: new XYZ({
        url: 'https://{a-d}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png',
        attributions: '',
        maxZoom: 19,
      }),
      zIndex: 50,
    });

    // SST raster layer — WMS time-enabled depuis GeoServer ImageMosaic.
    // Le param TIME est mis à jour par refreshForTime() à chaque change
    // de currentTime.
    this.sstSource = new TileWMS({
      url: '/geoserver/maritime/wms',
      params: {
        LAYERS: 'maritime:sst-daily',
        TILED: true,
        TRANSPARENT: true,
      },
      serverType: 'geoserver',
    });
    this.sstLayer = new TileLayer({
      source: this.sstSource,
      opacity: 0.6,           // semi-transparent pour voir base layer en dessous
      zIndex: 30,             // sous les labels
      visible: false,
    });

    // Vent (force, m/s) — WMS time-enabled depuis ImageMosaic GeoServer.
    // GeoServer applique automatiquement un style "raster" arc-en-ciel par
    // défaut sur les valeurs réelles ; on pourra customiser via SLD plus tard.
    this.windSource = new TileWMS({
      url: '/geoserver/maritime/wms',
      params: { LAYERS: 'maritime:wind-speed', TILED: true, TRANSPARENT: true },
      serverType: 'geoserver',
    });
    this.windLayer = new TileLayer({
      source: this.windSource,
      opacity: 0.55,
      zIndex: 32,
      visible: false,
    });

    // Vagues (hauteur sig., m) — WMS time-enabled.
    this.wavesSource = new TileWMS({
      url: '/geoserver/maritime/wms',
      params: { LAYERS: 'maritime:wave-hs', TILED: true, TRANSPARENT: true },
      serverType: 'geoserver',
    });
    this.wavesLayer = new TileLayer({
      source: this.wavesSource,
      opacity: 0.55,
      zIndex: 33,
      visible: false,
    });

    // Sprint 6 : flèches vent + flèches vagues. VectorSource alimenté à
    // chaque tick du time slider via fetch GeoJSON (manifest + nearest ts).
    this.windArrowsSource = new VectorSource();
    this.windArrowsLayer = new VectorLayer({
      source: this.windArrowsSource,
      style: (feat: FeatureLike) => this.styleArrow('wind', feat),
      zIndex: 95,
      visible: false,
      declutter: true,
    });
    this.waveArrowsSource = new VectorSource();
    this.waveArrowsLayer = new VectorLayer({
      source: this.waveArrowsSource,
      style: (feat: FeatureLike) => this.styleArrow('wave', feat),
      zIndex: 96,
      visible: false,
      declutter: true,
    });

    // Radar pluie via RainViewer XYZ tiles. URL initiale "transparent" =
    // 1×1 png vide, on remplace via setUrl() dès qu'un snapshot est dispo.
    // Crossorigin obligatoire pour permettre canvas readback (au cas où).
    this.rainSource = new XYZ({
      url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAarVyFEAAAAASUVORK5CYII=',
      crossOrigin: 'anonymous',
      attributions: '© <a href="https://rainviewer.com" target="_blank">RainViewer</a>',
      maxZoom: 12,
    });
    this.rainLayer = new TileLayer({
      source: this.rainSource,
      opacity: 0.7,
      zIndex: 40,             // au-dessus du SST mais sous les vessels/labels
      visible: false,
    });

    this.vesselLayer = new VectorLayer({
      source: this.vesselSource,
      style: (feature: FeatureLike) => this.styleVessel(feature),
      zIndex: 100,
      visible: true,
    });

    this.trackLayer = new VectorLayer({
      source: this.trackSource,
      style: () => this.styleTrack(),
      zIndex: 90,
      visible: false,
    });

    this.popupOverlay = new Overlay({
      element: this.popupEl().nativeElement,
      positioning: 'bottom-center',
      stopEvent: true,
      offset: [0, -12],
    });

    this.map = new Map({
      target: this.mapEl().nativeElement,
      layers: [
        baseTile,
        this.sstLayer,
        this.windLayer,
        this.wavesLayer,
        this.rainLayer,
        labelsTile,
        this.waveArrowsLayer,
        this.windArrowsLayer,
        this.trackLayer,
        this.vesselLayer,
      ],
      overlays: [this.popupOverlay],
      controls: defaultControls().extend([new ScaleLine({ units: 'nautical' })]),
      view: new View({
        center: fromLonLat(INITIAL_CENTER),
        zoom: INITIAL_ZOOM,
        minZoom: 4,
        maxZoom: 14,
      }),
    });

    // Click handler : sélectionne un vessel.
    this.map.on('singleclick', (evt) => {
      const feat = this.map!.forEachFeatureAtPixel(
        evt.pixel,
        (f) => f as Feature<Geometry>,
        { hitTolerance: 4 },
      );
      if (feat) {
        const props = feat.getProperties() as VesselProperties & { geometry?: Geometry };
        delete props.geometry;
        this.selectedVessel.set(props);
        const geom = feat.getGeometry();
        if (geom?.getType() === 'Point') {
          this.popupOverlay?.setPosition((geom as Point).getCoordinates());
        }
      } else {
        this.closePopup();
      }
    });

    this.map.on('pointermove', (evt) => {
      const target = this.map!.getTarget() as HTMLElement | null;
      if (!target) return;
      const has = this.map!.hasFeatureAtPixel(evt.pixel);
      target.style.cursor = has ? 'pointer' : '';
    });
  }

  // ─── Styles ─────────────────────────────────────────────────────────
  private styleVessel(feature: FeatureLike): Style {
    const props = feature.getProperties() as VesselProperties;
    const cat = categoryOf(props.ship_type);
    const colors = CATEGORY_COLOR[cat];
    return new Style({
      image: new CircleStyle({
        radius: 5,
        fill: new Fill({ color: colors.fill }),
        stroke: new Stroke({ color: colors.stroke, width: 1.5 }),
      }),
    });
  }

  private styleTrack(): Style {
    return new Style({
      stroke: new Stroke({
        color: 'rgba(45, 212, 191, 0.5)',
        width: 1.2,
      }),
    });
  }
}
