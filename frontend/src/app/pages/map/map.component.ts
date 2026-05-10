import { DatePipe } from '@angular/common';
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
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
import { Style, Circle as CircleStyle, Fill, Stroke } from 'ol/style';
import { defaults as defaultControls, ScaleLine } from 'ol/control';
import type { Feature } from 'ol';
import type { FeatureLike } from 'ol/Feature';
import type { Geometry, Point } from 'ol/geom';

import { TimeSliderComponent } from '../../components/time-slider/time-slider.component';
import { VesselsService, type VesselProperties } from '../../services/vessels.service';

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
  imports: [DatePipe, TimeSliderComponent],
  template: `
    <div class="map-container">
      <div class="map" #mapEl></div>

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
      transition: opacity 200ms;
      input { accent-color: var(--accent); cursor: pointer; flex-shrink: 0; }
      &.dim { opacity: 0.45; }
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
  private readonly destroyRef = inject(DestroyRef);

  readonly mapEl = viewChild.required<ElementRef<HTMLDivElement>>('mapEl');
  readonly popupEl = viewChild.required<ElementRef<HTMLDivElement>>('popupEl');

  readonly selectedVessel = signal<VesselProperties | null>(null);
  readonly vesselsCount = signal(0);
  readonly tracksCount = signal(0);
  readonly lastRefreshAt = signal<Date | null>(null);
  readonly errorMsg = signal<string | null>(null);

  // Toggles user — par défaut tout visible
  readonly showVessels = signal(true);
  readonly showTracks = signal(true);
  readonly showSST = signal(true);

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

  ngAfterViewInit(): void {
    this.initMap();
    // Démarre en mode live
    this.applyLayerVisibility();
    this.refreshForTime(new Date());
    this.startLiveLoopIfNeeded();
  }

  ngOnDestroy(): void {
    this.liveSub?.unsubscribe();
    this.trackSub?.unsubscribe();
    this.pastVesselsSub?.unsubscribe();
    if (this.pastFetchDebounce) clearTimeout(this.pastFetchDebounce);
    this.map?.setTarget(undefined);
    this.map?.dispose();
  }

  // ─── Time slider callback ──────────────────────────────────────────
  onTimeChange(t: Date): void {
    this.currentTime = t;
    this.currentTimeSig.set(t);
    this.refreshForTime(t);
    this.startLiveLoopIfNeeded();
    this.applyLayerVisibility();
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
    // SST : update TIME param du WMS source à chaque change si pas futur
    if (this.sstSource && !this.isFuture()) {
      const isoTs = toIsoTimestamp(t);
      this.sstSource.updateParams({ TIME: isoTs });
    }
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
      layers: [baseTile, this.sstLayer, labelsTile, this.trackLayer, this.vesselLayer],
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
