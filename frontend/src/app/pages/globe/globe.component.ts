/**
 * GlobeMapComponent — Phase 5a (2026-05-21) : nouvelle route /globe avec
 * MapLibre 5.24 projection sphère + WebGL wind particles (port sandbox).
 *
 * Choix Phase 5a (validé avec Sylvain) :
 *   - Cohabite avec map.component (OL) sur `/`. Pas de refacto MapEngine
 *     prématurée — on porte progressivement les layers d'ici aux sessions
 *     suivantes (SST, satellites, alerts, lightning, vessels…).
 *   - 2 layers démarrage : SST (raster WMS) + Wind (custom WebGL particles).
 *   - Toggle 2D/3D via lien header simple.
 */

import { CommonModule } from '@angular/common';
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
import { Router, RouterLink } from '@angular/router';

import maplibregl, {
  type CustomLayerInterface,
  type CustomRenderMethodInput,
  type Map as MapLibreMap,
} from 'maplibre-gl';

import { firstValueFrom } from 'rxjs';

import { ArrowsService } from '../../services/arrows.service';
import { AlertsService } from '../../services/alerts.service';
import { LightningService } from '../../services/lightning.service';
import { VesselsService } from '../../services/vessels.service';
import {
  buildWindTexture,
  speedDirToUv,
  WindWebGL,
  type MapLibreCustomLayerRenderArgs,
  type WindGridPoint,
} from './wind-webgl-history';

// Bbox du wind grid GFS Europe étroite (match les arrows prod).
const WIND_BBOX: [number, number, number, number] = [-15, 35, 30, 65];
const DEFAULT_WIND_PARTICLES = 3000;

/** Catalogue satellite — mirror partiel de map.component.SAT_PRODUCTS +
 *  CASCADE_PRODUCTS. Tous les layers sont sur GeoServer workspace `maritime`
 *  derrière /geoserver/aetherwx/wms.
 *  - NASA GIBS : `time` = jour YYYY-MM-DD (J-1 capped, lag ~24h).
 *  - Cascade EUMETSAT/radar : `time` = ISO horodatée (snap quasi-NRT).
 *  - `none` = pas de sat (default).
 */
type SatProduct = {
  key: string;
  label: string;
  gsName: string;
  kind: 'gibs-daily' | 'cascade-realtime';
  attribution: string;
};
const SAT_PRODUCTS: SatProduct[] = [
  { key: 'satTrueColor',      label: 'Vrai couleur MODIS',         gsName: 'sat-modis-true-color',  kind: 'gibs-daily',       attribution: 'NASA GIBS MODIS Terra' },
  { key: 'satTrueColorVIIRS', label: 'Vrai couleur VIIRS',         gsName: 'sat-viirs-true-color',  kind: 'gibs-daily',       attribution: 'NASA GIBS VIIRS SNPP' },
  { key: 'satIR',             label: 'Infrarouge thermique',       gsName: 'sat-modis-ir',          kind: 'gibs-daily',       attribution: 'NASA GIBS MODIS Band 31' },
  { key: 'satWaterVapor',     label: 'Température air',            gsName: 'sat-airs-air-temp',     kind: 'gibs-daily',       attribution: 'NASA GIBS AIRS' },
  { key: 'satCloudTop',       label: 'Sommet des nuages',          gsName: 'sat-modis-cloud-top',   kind: 'gibs-daily',       attribution: 'NASA GIBS MODIS' },
  { key: 'satAerosol',        label: 'Aérosols / poussières',      gsName: 'sat-modis-aerosol',     kind: 'gibs-daily',       attribution: 'NASA GIBS MODIS AOD' },
  { key: 'satDayNight',       label: 'VIIRS jour/nuit',            gsName: 'sat-viirs-day-night',   kind: 'gibs-daily',       attribution: 'NASA GIBS VIIRS DayNight' },
  { key: 'satEuIrRss',        label: 'EUMETSAT IR Europe (5 min)', gsName: 'sat-eu-ir-rss',         kind: 'cascade-realtime', attribution: 'EUMETSAT MSG SEVIRI Rapid Scan' },
  { key: 'satGlobalIrMtg',    label: 'EUMETSAT MTG IR global',     gsName: 'sat-global-ir-mtg',     kind: 'cascade-realtime', attribution: 'EUMETSAT MTG FCI' },
  { key: 'satEuHrvRgb',       label: 'EUMETSAT HRV RGB Europe',    gsName: 'sat-eu-hrv-rgb',        kind: 'cascade-realtime', attribution: 'EUMETSAT MSG SEVIRI HRV' },
  { key: 'radarDwd',          label: 'Radar Allemagne (DWD)',      gsName: 'radar-dwd-de',          kind: 'cascade-realtime', attribution: 'DWD Open Data Radar' },
  { key: 'radarKnmi',         label: 'Radar Pays-Bas (KNMI)',      gsName: 'radar-knmi-nl',         kind: 'cascade-realtime', attribution: 'KNMI Open Geo Radar' },
];

/** Date du jour J-1 capped pour NASA GIBS (lag ~24h). Format YYYY-MM-DD UTC. */
function gibsDailyDate(): string {
  const eff = new Date(Date.now() - 24 * 3_600_000);
  return `${eff.getUTCFullYear()}-${String(eff.getUTCMonth() + 1).padStart(2, '0')}-${String(eff.getUTCDate()).padStart(2, '0')}`;
}

@Component({
  selector: 'app-globe',
  standalone: true,
  imports: [CommonModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="globe-root">
      <header class="globe-header">
        <div class="brand">
          <span class="brand-icon">🌍</span>
          <span class="brand-title">AetherWX</span>
          <span class="brand-mode">— Globe 3D <span class="brand-mode-pill">spike</span></span>
        </div>
        <nav class="nav-links">
          <a routerLink="/" class="nav-link">← Carte 2D</a>
        </nav>
      </header>

      <div #mapContainer class="map-container"></div>

      <aside class="controls">
        <h2>Couches</h2>

        <div class="row">
          <button
            type="button"
            class="btn"
            [class.active]="projection() === 'globe'"
            (click)="setProjection('globe')"
          >🌍 Globe</button>
          <button
            type="button"
            class="btn"
            [class.active]="projection() === 'mercator'"
            (click)="setProjection('mercator')"
          >🗺 Mercator</button>
        </div>

        <div class="row">
          <button
            type="button"
            class="btn"
            [class.active]="!showSst()"
            (click)="toggleSst(false)"
          >SST off</button>
          <button
            type="button"
            class="btn"
            [class.active]="showSst()"
            (click)="toggleSst(true)"
          >SST live</button>
        </div>

        <div class="row">
          <button
            type="button"
            class="btn"
            [class.active]="!showWind()"
            (click)="toggleWind(false)"
          >Vent off</button>
          <button
            type="button"
            class="btn"
            [class.active]="showWind()"
            (click)="toggleWind(true)"
            [disabled]="windLoading()"
          >🌬 Particules WebGL</button>
        </div>

        @if (windLoading()) {
          <div class="info">Chargement grid vent…</div>
        }
        @if (windError()) {
          <div class="info error">{{ windError() }}</div>
        }
        @if (showWind() && !windLoading() && !windError()) {
          <div class="info">Wind GFS — {{ DEFAULT_WIND_PARTICLES }} particules</div>
        }

        <label class="sat-label">
          <span class="sat-title">📡 Imagerie satellite / radar</span>
          <select class="sat-select" [value]="activeSat()" (change)="onSatChange($any($event.target).value)">
            <option value="none">— Aucune</option>
            <optgroup label="NASA GIBS (journalier J-1)">
              @for (p of GIBS_PRODUCTS; track p.key) {
                <option [value]="p.key">{{ p.label }}</option>
              }
            </optgroup>
            <optgroup label="EUMETSAT / Radar (NRT)">
              @for (p of CASCADE_PRODUCTS; track p.key) {
                <option [value]="p.key">{{ p.label }}</option>
              }
            </optgroup>
          </select>
        </label>
        @if (activeSat() !== 'none') {
          <div class="info">{{ currentSatAttribution() }}</div>
        }

        <div class="row">
          <button
            type="button"
            class="btn"
            [class.active]="showLightning()"
            (click)="toggleVector('lightning')"
            [disabled]="vectorLoading() === 'lightning'"
          >⚡ Foudre</button>
          <button
            type="button"
            class="btn"
            [class.active]="showAlerts()"
            (click)="toggleVector('alerts')"
            [disabled]="vectorLoading() === 'alerts'"
          >⚠ Alertes</button>
        </div>
        <div class="row">
          <button
            type="button"
            class="btn full"
            [class.active]="showVessels()"
            (click)="toggleVector('vessels')"
            [disabled]="vectorLoading() === 'vessels'"
          >🚢 Navires AIS (cluster)</button>
        </div>
        @if (vectorCounts().lightning != null && showLightning()) {
          <div class="info">Foudre 30 min — {{ vectorCounts().lightning }} strikes</div>
        }
        @if (vectorCounts().alerts != null && showAlerts()) {
          <div class="info">Alertes 1h — {{ vectorCounts().alerts }} actives</div>
        }
        @if (vectorCounts().vessels != null && showVessels()) {
          <div class="info">Navires live — {{ vectorCounts().vessels }} positions</div>
        }

        <div class="info subtle">
          MapLibre 5.24 + WebGL2 GPGPU. Bbox Europe [{{ WIND_BBOX.join(', ') }}].
        </div>
      </aside>

      <div class="fps" aria-label="frames per second">FPS {{ fps() }}</div>
    </div>
  `,
  styles: `
    :host { display: block; height: 100%; }
    .globe-root {
      position: absolute;
      inset: 0;
      background: #0a0e1a;
      color: #e6ecf3;
      font-family: system-ui, -apple-system, sans-serif;
    }
    .globe-header {
      position: absolute;
      top: 0; left: 0; right: 0;
      z-index: 20;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 14px;
      background: rgba(10, 14, 26, 0.78);
      border-bottom: 1px solid #1c2333;
      backdrop-filter: blur(6px);
    }
    .brand { display: flex; align-items: baseline; gap: 8px; font-size: 14px; }
    .brand-icon { font-size: 18px; }
    .brand-title { font-weight: 600; color: #c9d6e8; letter-spacing: .04em; }
    .brand-mode { color: #8a96a8; font-size: 12px; }
    .brand-mode-pill {
      display: inline-block;
      padding: 1px 6px;
      margin-left: 4px;
      background: #3b5bff;
      color: #fff;
      border-radius: 4px;
      font-size: 10px;
      letter-spacing: .04em;
    }
    .nav-links { display: flex; gap: 12px; }
    .nav-link {
      color: #c9d6e8;
      text-decoration: none;
      font-size: 13px;
      padding: 4px 10px;
      border: 1px solid #2a3245;
      border-radius: 6px;
      background: rgba(20, 24, 38, 0.6);
      transition: background .15s;
    }
    .nav-link:hover { background: #2a3448; }

    .map-container {
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
    }

    .controls {
      position: absolute;
      top: 56px;
      left: 14px;
      z-index: 10;
      width: 260px;
      padding: 10px 12px;
      background: rgba(20, 24, 38, 0.92);
      border: 1px solid #2a3245;
      border-radius: 8px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
    }
    .controls h2 {
      margin: 0 0 8px;
      font-size: 12px;
      color: #c9d6e8;
      letter-spacing: .07em;
      text-transform: uppercase;
    }
    .controls .row {
      display: flex;
      gap: 6px;
      margin-bottom: 8px;
      flex-wrap: wrap;
    }
    .controls .btn {
      flex: 1;
      background: #1c2333;
      color: #e6ecf3;
      border: 1px solid #3a4458;
      padding: 6px 10px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      transition: background .15s, border-color .15s;
    }
    .controls .btn:hover:not(:disabled) { background: #2a3448; }
    .controls .btn.active { background: #3b5bff; border-color: #5878ff; }
    .controls .btn:disabled { opacity: .5; cursor: progress; }
    .controls .btn.full { flex: 1 1 100%; }
    .controls .info {
      font-size: 11px;
      color: #8a96a8;
      margin-top: 6px;
      line-height: 1.4;
    }
    .controls .info.subtle { opacity: .7; margin-top: 10px; }
    .controls .info.error { color: #f87171; }

    .sat-label {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-top: 10px;
      margin-bottom: 4px;
    }
    .sat-title {
      font-size: 11px;
      color: #c9d6e8;
      letter-spacing: .03em;
    }
    .sat-select {
      background: #1c2333;
      color: #e6ecf3;
      border: 1px solid #3a4458;
      padding: 6px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
    }
    .sat-select:hover { background: #2a3448; }
    .sat-select:focus-visible {
      outline: 2px solid #5878ff;
      outline-offset: 1px;
    }

    .fps {
      position: absolute;
      top: 56px;
      right: 14px;
      z-index: 10;
      padding: 6px 10px;
      background: rgba(20, 24, 38, 0.92);
      border: 1px solid #2a3245;
      border-radius: 8px;
      font-family: ui-monospace, monospace;
      font-size: 12px;
    }

    /* Override MapLibre popup pour matcher le thème dark du site.
       Le default MapLibre est fond blanc + texte noir = invisible ici. */
    ::ng-deep .maplibregl-popup-content {
      background: rgba(20, 24, 38, 0.95) !important;
      color: #e6ecf3 !important;
      border: 1px solid #2a3245;
      border-radius: 8px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
      padding: 12px 28px 12px 14px !important;  /* right extra pour close button */
      font: 12px system-ui, -apple-system, sans-serif;
      max-width: 280px;
      position: relative;
    }
    ::ng-deep .maplibregl-popup-tip {
      border-top-color: rgba(20, 24, 38, 0.95) !important;
      border-bottom-color: rgba(20, 24, 38, 0.95) !important;
      border-left-color: rgba(20, 24, 38, 0.95) !important;
      border-right-color: rgba(20, 24, 38, 0.95) !important;
    }
    ::ng-deep .maplibregl-popup-close-button {
      position: absolute !important;
      top: 4px !important;
      right: 6px !important;
      color: #8a96a8 !important;
      font-size: 18px !important;
      line-height: 1;
      padding: 2px 6px !important;
      background: transparent !important;
      border: 0 !important;
    }
    ::ng-deep .maplibregl-popup-close-button:hover {
      color: #e6ecf3 !important;
      background: transparent !important;
    }
  `,
})
export class GlobeComponent implements AfterViewInit, OnDestroy {
  private readonly arrows = inject(ArrowsService);
  private readonly alertsService = inject(AlertsService);
  private readonly lightningService = inject(LightningService);
  private readonly vesselsService = inject(VesselsService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  readonly mapContainer = viewChild.required<ElementRef<HTMLDivElement>>('mapContainer');

  readonly projection = signal<'globe' | 'mercator'>('globe');
  readonly showSst = signal(false);
  readonly showWind = signal(false);
  readonly windLoading = signal(false);
  readonly windError = signal<string | null>(null);
  readonly fps = signal('—');
  /** Sélecteur radio mutuellement exclusif. 'none' = pas de sat actif. */
  readonly activeSat = signal<string>('none');
  readonly showLightning = signal(false);
  readonly showAlerts = signal(false);
  readonly showVessels = signal(false);
  readonly vectorLoading = signal<string | null>(null);
  readonly vectorCounts = signal<{ lightning?: number; alerts?: number; vessels?: number }>({});

  // Expose templates constants
  protected readonly WIND_BBOX = WIND_BBOX;
  protected readonly DEFAULT_WIND_PARTICLES = DEFAULT_WIND_PARTICLES;
  protected readonly GIBS_PRODUCTS = SAT_PRODUCTS.filter((p) => p.kind === 'gibs-daily');
  protected readonly CASCADE_PRODUCTS = SAT_PRODUCTS.filter((p) => p.kind === 'cascade-realtime');
  protected currentSatAttribution(): string {
    const k = this.activeSat();
    const p = SAT_PRODUCTS.find((x) => x.key === k);
    return p?.attribution ?? '';
  }

  private map?: MapLibreMap;
  private windEngine?: WindWebGL;
  private windLayer?: CustomLayerInterface;
  private windGridCache?: WindGridPoint[];
  private rafHandle?: number;
  private lastFpsTime = performance.now();
  private frameCount = 0;
  private moveHandlers: Array<{ event: string; handler: () => void }> = [];

  ngAfterViewInit(): void {
    this._initMap();
    this._startFpsLoop();
  }

  ngOnDestroy(): void {
    if (this.rafHandle !== undefined) cancelAnimationFrame(this.rafHandle);
    this.windEngine = undefined;
    this.windLayer = undefined;
    this.map?.remove();
  }

  setProjection(p: 'globe' | 'mercator') {
    if (this.projection() === p) return;
    this.projection.set(p);
    this.map?.setProjection({ type: p });
  }

  toggleSst(on: boolean) {
    if (this.showSst() === on) return;
    this.showSst.set(on);
    const map = this.map;
    if (!map) return;
    const layerId = 'sst-wms';
    const sourceId = 'sst-wms';
    if (on) {
      if (!map.getSource(sourceId)) {
        map.addSource(sourceId, {
          type: 'raster',
          tiles: [
            '/geoserver/aetherwx/wms' +
              '?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap' +
              '&LAYERS=aetherwx:sst-daily&STYLES=&FORMAT=image/png&TRANSPARENT=true' +
              // 2026-05-21 — INTERPOLATIONS=bicubic param GS vendor pour
              // interpolation raster côté serveur (anti-pixellisation). Match
              // ce que la /map prod fait. Cf [[geoserver_wms_interpolations_param]].
              '&INTERPOLATIONS=bicubic' +
              '&SRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256',
          ],
          tileSize: 256,
        });
      }
      if (!map.getLayer(layerId)) {
        // Insert SST under wind particles for proper z-ordering.
        const before = map.getLayer('wind-webgl') ? 'wind-webgl' : undefined;
        map.addLayer(
          { id: layerId, type: 'raster', source: sourceId, paint: { 'raster-opacity': 0.7 } },
          before,
        );
      } else {
        map.setLayoutProperty(layerId, 'visibility', 'visible');
      }
    } else {
      if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', 'none');
    }
  }

  async toggleVector(kind: 'lightning' | 'alerts' | 'vessels') {
    const sigMap = {
      lightning: this.showLightning,
      alerts: this.showAlerts,
      vessels: this.showVessels,
    } as const;
    const showSig = sigMap[kind];
    const turningOn = !showSig();
    showSig.set(turningOn);

    const map = this.map;
    if (!map) return;
    const sourceId = `vec-${kind}`;
    const layerIds: Record<typeof kind, string[]> = {
      lightning: ['vec-lightning'],
      alerts: ['vec-alerts'],
      // 2026-05-21 — glyphs URL ajouté au style MapLibre (cf style.glyphs)
      // → symbol text layer fonctionne maintenant. Count visible sur cluster.
      vessels: ['vec-vessels-clusters', 'vec-vessels-cluster-count', 'vec-vessels-points'],
    };

    // Toggle off : retire les layers + source
    if (!turningOn) {
      for (const lid of layerIds[kind]) {
        if (map.getLayer(lid)) map.removeLayer(lid);
      }
      if (map.getSource(sourceId)) map.removeSource(sourceId);
      this.vectorCounts.update((c) => ({ ...c, [kind]: undefined }));
      return;
    }

    // Toggle on : fetch GeoJSON + addSource + addLayer(s)
    this.vectorLoading.set(kind);
    try {
      const fc = await this._fetchVectorFc(kind);
      if (map.getSource(sourceId)) map.removeSource(sourceId);
      const useCluster = kind === 'vessels';
      map.addSource(sourceId, {
        type: 'geojson',
        data: fc as any,
        cluster: useCluster,
        clusterRadius: 40,
        clusterMaxZoom: 12,
      } as any);

      if (kind === 'lightning') {
        map.addLayer({
          id: 'vec-lightning',
          type: 'circle',
          source: sourceId,
          paint: {
            'circle-radius': 4,
            'circle-color': '#fde047',
            'circle-stroke-width': 1,
            'circle-stroke-color': '#fbbf24',
            'circle-opacity': 0.85,
          },
        });
      } else if (kind === 'alerts') {
        map.addLayer({
          id: 'vec-alerts',
          type: 'circle',
          source: sourceId,
          paint: {
            'circle-radius': 7,
            'circle-color': [
              'match',
              ['get', 'severity'],
              'danger', '#dc2626',
              'warning', '#f97316',
              'info', '#38bdf8',
              '#94a3b8',
            ],
            'circle-stroke-width': 2,
            'circle-stroke-color': '#fff',
            'circle-opacity': 0.9,
          },
        });
      } else {
        // Vessels : 3 layers (cluster bubbles + count + unclustered points).
        map.addLayer({
          id: 'vec-vessels-clusters',
          type: 'circle',
          source: sourceId,
          filter: ['has', 'point_count'],
          paint: {
            'circle-color': [
              'step', ['get', 'point_count'],
              '#22c55e', 25,
              '#3b82f6', 100,
              '#a855f7',
            ],
            'circle-radius': [
              'step', ['get', 'point_count'],
              12, 25,
              16, 100,
              22,
            ],
            'circle-opacity': 0.85,
            'circle-stroke-color': '#0f172a',
            'circle-stroke-width': 1.5,
          },
        });
        // 2026-05-21 — count cluster sur les bubbles (Sylvain feedback).
        map.addLayer({
          id: 'vec-vessels-cluster-count',
          type: 'symbol',
          source: sourceId,
          filter: ['has', 'point_count'],
          layout: {
            'text-field': '{point_count_abbreviated}',
            'text-font': ['Open Sans Regular'],
            'text-size': 12,
            'text-allow-overlap': true,
            'text-ignore-placement': true,
          },
          paint: {
            'text-color': '#ffffff',
            'text-halo-color': 'rgba(0,0,0,0.5)',
            'text-halo-width': 1,
          },
        });
        map.addLayer({
          id: 'vec-vessels-points',
          type: 'circle',
          source: sourceId,
          filter: ['!', ['has', 'point_count']],
          paint: {
            'circle-radius': 3,
            'circle-color': '#22c55e',
            'circle-stroke-color': '#0f172a',
            'circle-stroke-width': 1,
          },
        });
      }

      this.vectorCounts.update((c) => ({ ...c, [kind]: fc.features?.length ?? 0 }));
      this.vectorLoading.set(null);
    } catch (err) {
      console.error(`[globe] ${kind} fetch failed`, err);
      this.vectorLoading.set(null);
      showSig.set(false);
    }
  }

  private async _fetchVectorFc(kind: 'lightning' | 'alerts' | 'vessels'): Promise<{ features: any[] }> {
    if (kind === 'lightning') {
      return await firstValueFrom(this.lightningService.fetchRecent(new Date(), 1800));
    }
    if (kind === 'alerts') {
      return await this.alertsService.refresh(new Date(), 3600);
    }
    return await firstValueFrom(this.vesselsService.fetchLiveVessels(new Date(), 900));
  }

  onSatChange(key: string) {
    if (this.activeSat() === key) return;
    const prev = this.activeSat();
    this.activeSat.set(key);
    const map = this.map;
    if (!map) return;

    // Retire la source/layer précédente (s'il y en avait une).
    if (prev !== 'none') {
      const prevLayerId = `sat-${prev}`;
      if (map.getLayer(prevLayerId)) map.removeLayer(prevLayerId);
      if (map.getSource(prevLayerId)) map.removeSource(prevLayerId);
    }
    if (key === 'none') return;

    const product = SAT_PRODUCTS.find((p) => p.key === key);
    if (!product) return;
    const sourceId = `sat-${product.key}`;
    const layerId = sourceId;

    const timeParam =
      product.kind === 'gibs-daily'
        ? gibsDailyDate()
        : new Date(Date.now() - 5 * 60_000).toISOString().split('.')[0] + 'Z';

    const url =
      '/geoserver/aetherwx/wms' +
      '?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap' +
      `&LAYERS=aetherwx:${product.gsName}` +
      `&TIME=${encodeURIComponent(timeParam)}` +
      '&STYLES=&FORMAT=image/png&TRANSPARENT=true' +
      '&SRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256';

    map.addSource(sourceId, { type: 'raster', tiles: [url], tileSize: 256, attribution: product.attribution });

    // z-order : sat sous SST (si présent) et sous wind ; sat-cascade
    // (EUMETSAT/radar) au-dessus du basemap mais sous tout le reste.
    const before = map.getLayer('sst-wms')
      ? 'sst-wms'
      : map.getLayer('wind-webgl')
        ? 'wind-webgl'
        : undefined;
    map.addLayer({ id: layerId, type: 'raster', source: sourceId, paint: { 'raster-opacity': 0.85 } }, before);
  }

  async toggleWind(on: boolean) {
    if (this.showWind() === on) return;
    this.showWind.set(on);
    const map = this.map;
    if (!map) return;

    if (!on) {
      if (this.windLayer && map.getLayer(this.windLayer.id)) {
        map.removeLayer(this.windLayer.id);
      }
      this.windLayer = undefined;
      this.windEngine = undefined;
      return;
    }

    this.windLoading.set(true);
    this.windError.set(null);
    try {
      const grid = await this._loadWindGrid();
      const windData = buildWindTexture(grid, WIND_BBOX, 512, 256);
      const self = this;
      const layer: CustomLayerInterface = {
        id: 'wind-webgl',
        type: 'custom',
        onAdd(_map, gl) {
          // MapLibre fournit un WebGL2RenderingContext en interne.
          self.windEngine = new WindWebGL(gl as WebGL2RenderingContext, { bounds: WIND_BBOX });
          self.windEngine.setNumParticles(DEFAULT_WIND_PARTICLES);
          self.windEngine.setWind(windData);
        },
        render(_gl, args) {
          if (!self.windEngine) return;
          self.windEngine.draw(args as unknown as MapLibreCustomLayerRenderArgs);
          self.map?.triggerRepaint();
        },
        onRemove() {
          // engine refs cleared by caller in ngOnDestroy/toggleWind(false)
        },
      };
      this.windLayer = layer;
      map.addLayer(layer);
      this.windLoading.set(false);
    } catch (err) {
      console.error('[globe] wind grid load failed', err);
      this.windError.set(err instanceof Error ? err.message : 'erreur de chargement');
      this.windLoading.set(false);
      this.showWind.set(false);
    }
  }

  private async _loadWindGrid(): Promise<WindGridPoint[]> {
    if (this.windGridCache) return this.windGridCache;
    const manifest = await this.arrows.getManifest();
    if (!manifest) throw new Error('manifest indisponible');
    const tsList = manifest.wind ?? [];
    if (tsList.length === 0) throw new Error('aucun timestamp wind dans le manifest');
    const nearest = this.arrows.findNearestTs(tsList, new Date()) ?? tsList[tsList.length - 1];
    const fc = await this.arrows.fetchArrows('wind', nearest);
    const grid: WindGridPoint[] = fc.features
      .filter((f) => f.geometry?.type === 'Point')
      .map((f) => {
        const props = f.properties as { speed?: number; dirTo?: number };
        const speed = props.speed ?? 0;
        const dirTo = props.dirTo ?? 0;
        const { u, v } = speedDirToUv(speed, dirTo);
        const [lon, lat] = f.geometry.coordinates;
        return { lon, lat, u, v };
      });
    this.windGridCache = grid;
    return grid;
  }

  private _initMap(): void {
    const container = this.mapContainer().nativeElement;
    const map = new maplibregl.Map({
      container,
      style: {
        version: 8,
        // Glyphs URL nécessaire pour les symbol text layers (count cluster
        // vessels). Source publique OpenMapTiles fonts. Sans ça, ajouter
        // une layer type=symbol crash MapLibre.
        glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
        sources: {
          'carto-dark': {
            type: 'raster',
            tiles: [
              'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
              'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
              'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
              'https://d.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
            ],
            tileSize: 256,
            attribution: '© OpenStreetMap contributors, © CARTO',
          },
        },
        layers: [{ id: 'carto-dark', type: 'raster', source: 'carto-dark' }],
      },
      center: [2, 30],
      zoom: 1.4,
    });

    // 2026-05-20 — bug MapLibre 5.24 : la spec `projection` au constructor
    // n'active pas le globe au boot ET n'est pas dans les MapOptions typings
    // strict. Appel explicite setProjection() après load pour la sandbox JS,
    // ici on le fait au load aussi pour Angular TS.
    map.on('load', () => {
      map.setProjection({ type: 'globe' });
    });

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }));
    map.addControl(new maplibregl.ScaleControl({ unit: 'nautical' }));

    const onMoveStart = () => this.windEngine?.setMoving(true);
    const onMoveEnd = () => this.windEngine?.setMoving(false);
    for (const ev of ['movestart', 'zoomstart', 'pitchstart', 'rotatestart']) {
      map.on(ev as any, onMoveStart);
      this.moveHandlers.push({ event: ev, handler: onMoveStart });
    }
    for (const ev of ['moveend', 'zoomend', 'pitchend', 'rotateend']) {
      map.on(ev as any, onMoveEnd);
      this.moveHandlers.push({ event: ev, handler: onMoveEnd });
    }
    map.on('resize', () => this.windEngine?.resize());

    // 2026-05-21 — Popups click sur vessels / lightning / alerts.
    // Pattern MapLibre standard : queryRenderedFeatures sur le pixel cliqué,
    // détecte la layer source, build HTML avec props feature, ouvre Popup.
    // Cluster vessels → zoom-in au lieu de popup (comme /map OL prod).
    map.on('click', (e) => {
      const allLayers = ['vec-vessels-clusters', 'vec-vessels-points', 'vec-lightning', 'vec-alerts'];
      const existing = allLayers.filter((id) => map.getLayer(id));
      if (existing.length === 0) return;

      const features = map.queryRenderedFeatures(e.point, { layers: existing });
      if (features.length === 0) return;
      const f = features[0];
      const layerId = f.layer.id;
      const p = (f.properties ?? {}) as Record<string, unknown>;

      // Cluster vessel → zoom-in (pas de popup)
      if (layerId === 'vec-vessels-clusters') {
        const clusterId = p['cluster_id'];
        const src = map.getSource(f.source) as maplibregl.GeoJSONSource & {
          getClusterExpansionZoom?: (id: number) => Promise<number>;
        };
        if (typeof clusterId === 'number' && src.getClusterExpansionZoom) {
          src.getClusterExpansionZoom(clusterId).then((zoom: number) => {
            const coords = (f.geometry as GeoJSON.Point).coordinates as [number, number];
            map.easeTo({ center: coords, zoom });
          });
        }
        return;
      }

      // Helpers
      const fmtRelTime = (isoOrTs: unknown): string => {
        if (!isoOrTs) return '';
        const d = new Date(String(isoOrTs));
        if (isNaN(d.getTime())) return String(isoOrTs);
        const diffSec = Math.round((Date.now() - d.getTime()) / 1000);
        if (diffSec < 60) return `il y a ${diffSec}s`;
        const diffMin = Math.round(diffSec / 60);
        if (diffMin < 60) return `il y a ${diffMin} min`;
        const diffH = Math.round(diffMin / 60);
        if (diffH < 24) return `il y a ${diffH}h`;
        return `il y a ${Math.round(diffH / 24)}j`;
      };
      const row = (label: string, value: string | number | undefined | null, unit = ''): string => {
        if (value === null || value === undefined || value === '') return '';
        return `<div style="display:flex;justify-content:space-between;gap:12px;margin-top:3px"><span style="color:#8a96a8;font-size:11px">${label}</span><span style="font-weight:500">${value}${unit}</span></div>`;
      };

      // Build popup HTML selon le type de layer
      let html = '';
      if (layerId === 'vec-vessels-points') {
        const name = (p['vessel_name'] || p['name'] || '') as string;
        const mmsi = p['mmsi'] as number | undefined;
        const sog = p['sog'] as number | undefined;
        const cog = (p['cog'] ?? p['heading']) as number | undefined;
        const destination = p['destination'] as string | undefined;
        const shipType = p['ship_type'] as number | undefined;
        const lengthM = p['length_m'] as number | undefined;
        const flag = p['flag'] as string | undefined;
        const lastSeen = (p['last_seen'] || p['ts']) as string | undefined;
        html = `
          <div>
            <div style="font-size:13px;font-weight:600;color:#e6ecf3;border-bottom:1px solid #2a3245;padding-bottom:6px;margin-bottom:4px">🚢 ${name || `MMSI ${mmsi ?? '?'}`}</div>
            ${row('MMSI', mmsi)}
            ${row('Vitesse', sog != null ? sog.toFixed(1) : null, ' kn')}
            ${row('Cap', cog != null ? Math.round(cog) : null, '°')}
            ${row('Destination', destination)}
            ${row('Type', shipType)}
            ${row('Longueur', lengthM, ' m')}
            ${row('Pavillon', flag)}
            ${row('Dernier signal', fmtRelTime(lastSeen))}
          </div>`;
      } else if (layerId === 'vec-lightning') {
        const ts = p['ts'] as string | undefined;
        const strength = p['strength'] as number | undefined;
        html = `
          <div>
            <div style="font-size:13px;font-weight:600;color:#fde047;border-bottom:1px solid #2a3245;padding-bottom:6px;margin-bottom:4px">⚡ Éclair</div>
            ${row('Heure', fmtRelTime(ts))}
            ${row('Intensité', strength)}
          </div>`;
      } else if (layerId === 'vec-alerts') {
        const kind = p['kind'] as string | undefined;
        const severity = (p['severity'] as string | undefined) ?? 'info';
        const target = (p['vessel_name'] || (p['mmsi'] ? `MMSI ${p['mmsi']}` : '')) as string;
        const ts = p['ts'] as string | undefined;
        const colorMap: Record<string, string> = { danger: '#dc2626', warning: '#f97316', info: '#38bdf8' };
        const color = colorMap[severity] ?? '#94a3b8';
        html = `
          <div>
            <div style="font-size:13px;font-weight:600;color:${color};border-bottom:1px solid #2a3245;padding-bottom:6px;margin-bottom:4px">⚠ ${kind ?? 'Alerte'} <span style="font-size:10px;text-transform:uppercase;opacity:.8">(${severity})</span></div>
            ${row('Cible', target)}
            ${row('Heure', fmtRelTime(ts))}
          </div>`;
      }

      if (html) {
        // Ancrer la popup sur les coords EXACTES du feature, pas e.lngLat
        // (position du curseur). Sinon sur le globe sphère projection, le
        // popup peut se retrouver positionné bizarrement (panneau en bas
        // de la map au lieu de bulle pointant sur le vessel cliqué).
        const featureCoords = (f.geometry as GeoJSON.Point).coordinates as [number, number];
        new maplibregl.Popup({
          closeButton: true,
          maxWidth: '260px',
          anchor: 'bottom',  // pointe vers le bas = bulle au-dessus du point cliqué
          offset: 8,
        })
          .setLngLat(featureCoords)
          .setHTML(html)
          .addTo(map);
      }
    });

    // Cursor pointer sur hover (UX feedback que c'est cliquable)
    const setCursor = (cursor: string) => () => {
      map.getCanvas().style.cursor = cursor;
    };
    for (const layerId of ['vec-vessels-clusters', 'vec-vessels-points', 'vec-lightning', 'vec-alerts']) {
      map.on('mouseenter', layerId, setCursor('pointer'));
      map.on('mouseleave', layerId, setCursor(''));
    }

    this.map = map;
  }

  private _startFpsLoop(): void {
    const tick = () => {
      this.frameCount++;
      const now = performance.now();
      if (now - this.lastFpsTime >= 500) {
        const f = Math.round((this.frameCount * 1000) / (now - this.lastFpsTime));
        this.fps.set(String(f));
        this.frameCount = 0;
        this.lastFpsTime = now;
      }
      this.rafHandle = requestAnimationFrame(tick);
    };
    this.rafHandle = requestAnimationFrame(tick);
  }
}
