import { DatePipe } from '@angular/common';
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
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
import GeoJSON from 'ol/format/GeoJSON';
import Overlay from 'ol/Overlay';
import { fromLonLat } from 'ol/proj';
import { Style, Circle as CircleStyle, Fill, Stroke } from 'ol/style';
import { defaults as defaultControls, ScaleLine } from 'ol/control';
import type { Feature } from 'ol';
import type { FeatureLike } from 'ol/Feature';
import type { Geometry, Point } from 'ol/geom';

import { VesselsService, type VesselProperties } from '../../services/vessels.service';

// Bbox Bretagne+Gascogne pour l'init view (centré sur le golfe de Gascogne nord).
const INITIAL_CENTER: [number, number] = [-3.75, 47.5];
const INITIAL_ZOOM = 7;
const REFRESH_INTERVAL_MS = 30_000;

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

@Component({
  selector: 'app-map',
  imports: [DatePipe],
  template: `
    <div class="map-container">
      <div class="map" #mapEl></div>

      <div class="legend">
        <div class="legend-title">MARITIME ATLAS</div>
        <div class="legend-subtitle">Bretagne · Gascogne nord</div>
        @for (cat of categories; track cat.key) {
          <div class="legend-item">
            <span class="legend-dot" [style.background]="cat.color.fill" [style.border-color]="cat.color.stroke"></span>
            <span>{{ cat.color.label }}</span>
          </div>
        }
        <div class="legend-stats">
          <div><strong>{{ vesselsCount() }}</strong> navires actifs</div>
          @if (lastRefreshAt()) {
            <div class="legend-refresh">Rafraîchi à {{ lastRefreshAt() | date:'HH:mm:ss' }}</div>
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

  // viewChild signals (Angular 19) — pas de référence statique nécessaire.
  readonly mapEl = viewChild.required<ElementRef<HTMLDivElement>>('mapEl');
  readonly popupEl = viewChild.required<ElementRef<HTMLDivElement>>('popupEl');

  readonly selectedVessel = signal<VesselProperties | null>(null);
  readonly vesselsCount = signal(0);
  readonly lastRefreshAt = signal<Date | null>(null);
  readonly errorMsg = signal<string | null>(null);

  // Pour la légende.
  readonly categories = (Object.keys(CATEGORY_COLOR) as Category[]).map((key) => ({
    key,
    color: CATEGORY_COLOR[key],
  }));

  private map?: Map;
  private vesselSource?: VectorSource;
  private popupOverlay?: Overlay;
  private refreshSub?: Subscription;
  private readonly geoJsonFmt = new GeoJSON({ featureProjection: 'EPSG:3857', dataProjection: 'EPSG:4326' });

  ngAfterViewInit(): void {
    this.initMap();
    this.startRefreshLoop();
  }

  ngOnDestroy(): void {
    this.refreshSub?.unsubscribe();
    this.map?.setTarget(undefined);
    this.map?.dispose();
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

    // CARTO Dark Matter — base layer sombre, mood océan nuit.
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

    const vesselLayer = new VectorLayer({
      source: this.vesselSource,
      style: (feature: FeatureLike) => this.styleVessel(feature),
      zIndex: 100,
    });

    this.popupOverlay = new Overlay({
      element: this.popupEl().nativeElement,
      positioning: 'bottom-center',
      stopEvent: true,
      offset: [0, -12],
    });

    this.map = new Map({
      target: this.mapEl().nativeElement,
      layers: [baseTile, labelsTile, vesselLayer],
      overlays: [this.popupOverlay],
      controls: defaultControls().extend([new ScaleLine({ units: 'nautical' })]),
      view: new View({
        center: fromLonLat(INITIAL_CENTER),
        zoom: INITIAL_ZOOM,
        minZoom: 4,
        maxZoom: 14,
      }),
    });

    // Click handler : sélectionne un vessel ou ferme le popup.
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

    // Cursor pointer sur les features.
    this.map.on('pointermove', (evt) => {
      const target = this.map!.getTarget() as HTMLElement | null;
      if (!target) return;
      const has = this.map!.hasFeatureAtPixel(evt.pixel);
      target.style.cursor = has ? 'pointer' : '';
    });
  }

  // ─── Refresh loop : fetch WFS toutes les 30s ───────────────────────
  private startRefreshLoop(): void {
    interval(REFRESH_INTERVAL_MS)
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
          // Recharge complet : pour MVP sprint 1.5 c'est suffisant. Sprint 2+
          // on fera un diff (id-based) pour préserver les sélections.
          this.vesselSource.clear();
          const features = this.geoJsonFmt.readFeatures(fc);
          this.vesselSource.addFeatures(features);
        },
        error: (err) => {
          this.errorMsg.set(`Erreur WFS : ${err.message ?? err}`);
        },
      });
  }

  // ─── Style vessel : cercle coloré par catégorie ────────────────────
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
}
