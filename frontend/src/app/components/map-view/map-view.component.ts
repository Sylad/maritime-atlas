import {
  AfterViewInit, ChangeDetectionStrategy, Component, DestroyRef, ElementRef,
  computed, effect, inject, input, signal, viewChild,
} from '@angular/core';
import maplibregl, { type CustomLayerInterface, type Map as MapLibreMap } from 'maplibre-gl';
import type { MapConfigSnapshot } from '../../models/map-config-snapshot';
import {
  ARROW_DEFAULT_OPACITY, CARTO_DARK_TILES, DEFAULT_WIND_PARTICLES, isTimeEnabledKey,
  layerLabel, MAPLIBRE_GLYPHS, RASTER_LAYERS, SAT_DEFAULT_OPACITY, SAT_PRODUCTS,
  SAT_PRODUCT_KEYS, WAVE_ARROW_COLOR, WAVE_ARROWS_LAYER_ID, WIND_ARROW_COLOR,
  WIND_ARROWS_LAYER_ID, WIND_BBOX, WIND_PARTICLES_LAYER_ID, WMS_TILE_SIZE,
} from './map-layers-constants';
import { buildRasterUrl, buildSatWmsUrl } from './map-layers.util';
import { LiveMapHandle, MapViewRegistry } from './map-view-registry.service';
import { firstValueFrom } from 'rxjs';
import { ArrowsService } from '../../services/arrows.service';
import { AlertsService } from '../../services/alerts.service';
import { LightningService } from '../../services/lightning.service';
import { VesselsService } from '../../services/vessels.service';
import { BuoysService } from '../../services/buoys.service';
import {
  addVectorLayers, VECTOR_KINDS, VECTOR_LAYER_IDS, vectorClusterMaxZoom, vectorUsesCluster,
  type VectorKind,
} from './vector-layers.util';
import {
  buildWindTexture, speedDirToUv, WindWebGL,
  type MapLibreCustomLayerRenderArgs, type WindGridPoint,
} from '../../pages/globe/wind-webgl-history';

/**
 * MapViewComponent (2026-06-17) — carte MapLibre EMBARQUABLE et SANS CHROME,
 * pilotée par un `MapConfigSnapshot`. Conçue pour les widgets de dashboard :
 * pas de panneau de layers, pas de time-bar, pas d'animation, pas de vecteurs
 * live ni de wind particles — uniquement les RASTERS du snapshot (SST,
 * forecast, satellites, contours, overlays statiques) à l'instant présent.
 *
 * - Lazy : la carte n'est instanciée que lorsqu'elle entre dans le viewport.
 * - Plafond WebGL : au-delà de MAX_LIVE_MAPS cartes vivantes, les moins
 *   récemment vues sont GELÉES en image figée (cf MapViewRegistry).
 * - `interactive` (défaut false) : pan/zoom désactivés en contexte widget.
 *
 * Le GlobeComponent prod n'est PAS touché ; ce composant réutilise seulement
 * les constantes/utils purs partagés (map-layers-constants / map-layers.util).
 */
@Component({
  selector: 'app-map-view',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="mv-root">
      <div #mapContainer class="mv-canvas" [class.mv-hidden]="frozen()"></div>
      @if (frozen() && frozenSrc()) {
        <img class="mv-frozen" [src]="frozenSrc()" alt="" aria-hidden="true" />
      }
      @if (!ready() && !frozen()) {
        <div class="mv-overlay mv-loading">…</div>
      }

      <!-- Menu read-only des couches de la widget -->
      @if (!frozen()) {
        @if (showMenu()) {
          <div class="mv-menu">
            <div class="mv-menu-head"><span>Couches</span><button type="button" (click)="showMenu.set(false)">×</button></div>
            @for (l of activeLayers(); track l.key) { <div class="mv-menu-row">{{ l.label }}</div> }
            @if (activeLayers().length === 0) { <div class="mv-menu-empty">aucune couche</div> }
          </div>
        } @else {
          <button type="button" class="mv-menu-btn" (click)="showMenu.set(true)" title="Couches">☰</button>
        }
      }

      <!-- Time-bar simplifiée (si des couches time-enabled sont actives) -->
      @if (!frozen() && hasTimeLayers()) {
        <div class="mv-timebar">
          <input type="range" [min]="timeMinMs" [max]="timeMaxMs" [step]="TIME_STEP_MS" [value]="timeValueMs()" (input)="onTimeInput($event)" />
          <span class="mv-time-label">{{ timeLabel() }}</span>
        </div>
      }
    </div>
  `,
  styles: [`
    :host { display: block; width: 100%; height: 100%; }
    .mv-root { position: relative; width: 100%; height: 100%; overflow: hidden; background: #0b1220; border-radius: inherit; }
    .mv-canvas { position: absolute; inset: 0; }
    .mv-canvas.mv-hidden { visibility: hidden; }
    .mv-frozen { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
    .mv-overlay { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #64748b; font-size: 0.9rem; pointer-events: none; }
    .mv-menu-btn { position: absolute; top: 8px; left: 8px; z-index: 2; width: 28px; height: 28px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.2); background: rgba(15,23,42,0.85); color: #e2e8f0; cursor: pointer; }
    .mv-menu { position: absolute; top: 8px; left: 8px; z-index: 2; min-width: 160px; max-width: 70%; background: rgba(15,23,42,0.92); border: 1px solid rgba(255,255,255,0.15); border-radius: 8px; color: #e2e8f0; font-size: 0.72rem; overflow: hidden; }
    .mv-menu-head { display: flex; align-items: center; justify-content: space-between; padding: 0.3rem 0.5rem; border-bottom: 1px solid rgba(255,255,255,0.1); font-weight: 600; color: #93c5fd; }
    .mv-menu-head button { background: transparent; border: 0; color: #94a3b8; cursor: pointer; font-size: 1rem; line-height: 1; }
    .mv-menu-row { padding: 0.25rem 0.5rem; border-bottom: 1px solid rgba(255,255,255,0.05); }
    .mv-menu-empty { padding: 0.3rem 0.5rem; color: #64748b; font-style: italic; }
    .mv-timebar { position: absolute; left: 8px; right: 8px; bottom: 8px; z-index: 2; display: flex; align-items: center; gap: 0.5rem; padding: 0.3rem 0.6rem; background: rgba(15,23,42,0.85); border: 1px solid rgba(255,255,255,0.12); border-radius: 8px; }
    .mv-timebar input[type=range] { flex: 1; accent-color: #60a5fa; }
    .mv-time-label { font-size: 0.68rem; color: #cbd5e1; white-space: nowrap; font-variant-numeric: tabular-nums; }
  `],
})
export class MapViewComponent implements AfterViewInit, LiveMapHandle {
  /** Snapshot complet de l'état carte à afficher. */
  readonly snapshot = input.required<MapConfigSnapshot>();
  /** Autorise pan/zoom (défaut false : widget figé). */
  readonly interactive = input(false);

  private readonly registry = inject(MapViewRegistry);
  private readonly destroyRef = inject(DestroyRef);
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly arrows = inject(ArrowsService);
  private readonly alertsService = inject(AlertsService);
  private readonly lightningService = inject(LightningService);
  private readonly vesselsService = inject(VesselsService);
  private readonly buoysService = inject(BuoysService);
  private readonly mapContainer = viewChild.required<ElementRef<HTMLDivElement>>('mapContainer');

  private map?: MapLibreMap;
  private observer?: IntersectionObserver;
  private resizeObserver?: ResizeObserver;
  private visible = false;
  private rendered = false;

  // Flèches + particules de vent (parité globe).
  private windEngine?: WindWebGL;
  private windLayer?: CustomLayerInterface;
  private windGridCache?: WindGridPoint[];
  private waveEngine?: WindWebGL;
  private waveLayer?: CustomLayerInterface;
  private waveGridCache?: WindGridPoint[];
  private lastWindArrowsTs?: string;
  private lastWaveArrowsTs?: string;

  readonly ready = signal(false);
  readonly frozen = signal(false);
  readonly frozenSrc = signal<string | null>(null);

  // ─── Menu read-only des couches ───
  readonly showMenu = signal(false);
  readonly activeLayers = computed<Array<{ key: string; label: string }>>(() => {
    const snap = this.snapshot();
    const vis = snap.layers?.visibility ?? {};
    const contours = snap.layers?.contours ?? { sstContours: false, windContours: false, waveContours: false };
    const out: Array<{ key: string; label: string }> = [];
    for (const key of Object.keys(RASTER_LAYERS)) {
      if (key.endsWith('Contours')) continue;
      if (vis[key]) out.push({ key, label: layerLabel(key) });
    }
    for (const ck of ['sstContours', 'windContours', 'waveContours'] as const) {
      if (contours[ck]) out.push({ key: ck, label: layerLabel(ck) });
    }
    for (const p of SAT_PRODUCTS) if (vis[p.key]) out.push({ key: p.key, label: layerLabel(p.key) });
    if (vis['windArrows']) out.push({ key: 'windArrows', label: layerLabel('windArrows') });
    if (vis['waveArrows']) out.push({ key: 'waveArrows', label: layerLabel('waveArrows') });
    if (vis['wind']) out.push({ key: 'wind', label: layerLabel('wind') });
    for (const kind of VECTOR_KINDS) if (vis[kind]) out.push({ key: kind, label: layerLabel(kind) });
    return out;
  });

  // ─── Time-bar simplifiée (now ±7j, pas 6h) ───
  readonly TIME_STEP_MS = 6 * 3_600_000;
  private readonly anchorMs = Date.now();
  readonly timeMinMs = this.anchorMs - 7 * 24 * 3_600_000;
  readonly timeMaxMs = this.anchorMs + 7 * 24 * 3_600_000;
  readonly timeValueMs = signal(this.anchorMs);
  readonly hasTimeLayers = computed(() => this.activeLayers().some((l) => isTimeEnabledKey(l.key)));
  readonly timeLabel = computed(() => {
    const d = new Date(this.timeValueMs());
    return d.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  });

  onTimeInput(ev: Event): void {
    const ms = Number((ev.target as HTMLInputElement).value);
    this.timeValueMs.set(ms);
    this.refreshTimeLayers(new Date(ms));
  }

  constructor() {
    // Ré-applique les layers si le snapshot change pendant que la carte est vivante.
    effect(() => {
      const snap = this.snapshot();
      if (this.map && this.map.isStyleLoaded() && !this.frozen()) {
        this.applySnapshotLayers(snap);
      }
    });
    this.destroyRef.onDestroy(() => this.teardown());
  }

  ngAfterViewInit(): void {
    this.observer = new IntersectionObserver((entries) => {
      const e = entries[0];
      this.visible = e.isIntersecting;
      if (e.isIntersecting) this.goLive();
    }, { threshold: 0.01 });
    this.observer.observe(this.host.nativeElement);
    // Resize de la carte quand le conteneur change (ex : redim widget gridster).
    this.resizeObserver = new ResizeObserver(() => this.map?.resize());
    this.resizeObserver.observe(this.mapContainer().nativeElement);
  }

  // ─── LiveMapHandle ───
  isHidden(): boolean { return !this.visible; }
  isRendered(): boolean { return this.rendered; }

  /** Gèle la carte : capture le canvas en image (si déjà rendu) puis libère le
   *  contexte WebGL. Si pas encore rendu, pas d'image (fond sombre) — la carte
   *  se reconstruira proprement au prochain passage en vivant. */
  freeze(): void {
    const map = this.map;
    if (!map) return;
    if (this.rendered) {
      try { this.frozenSrc.set(map.getCanvas().toDataURL('image/jpeg', 0.8)); }
      catch { this.frozenSrc.set(null); }
    } else {
      this.frozenSrc.set(null);
    }
    this.frozen.set(true);
    map.remove();
    this.map = undefined;
    this.rendered = false;
  }

  // ─── Cycle de vie carte ───
  private goLive(): void {
    if (this.map) { this.registry.touch(this); return; }
    if (!this.registry.requestLive(this)) return;
    this.frozen.set(false);
    this.frozenSrc.set(null);
    this.initMap();
  }

  private initMap(): void {
    const snap = this.snapshot();
    const view = snap.view;
    const map = new maplibregl.Map({
      container: this.mapContainer().nativeElement,
      attributionControl: { compact: true },
      interactive: this.interactive(),
      // Nécessaire pour geler la carte via canvas.toDataURL() (MapLibre 5.x :
      // preserveDrawingBuffer est dans canvasContextAttributes).
      canvasContextAttributes: { preserveDrawingBuffer: true },
      style: {
        version: 8,
        glyphs: MAPLIBRE_GLYPHS,
        sources: { 'carto-dark': { type: 'raster', tiles: CARTO_DARK_TILES, tileSize: 256 } },
        layers: [{ id: 'carto-dark', type: 'raster', source: 'carto-dark' }],
      },
      center: view ? [view.center.lng, view.center.lat] : [2, 40],
      zoom: view?.zoom ?? 2,
      bearing: view?.bearing ?? 0,
      pitch: view?.pitch ?? 0,
    });
    this.map = map;
    // Contrôles légers du widget : zoom, échelle nautique (attribution gérée
    // par attributionControl compact ci-dessus).
    map.addControl(new maplibregl.NavigationControl({ showCompass: false, visualizePitch: false }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'nautical' }), 'bottom-left');
    map.on('load', () => {
      map.setProjection({ type: view?.projection ?? 'mercator' });
      this.addArrowIconToMap(map);
      this.applySnapshotLayers(snap);
      this.ready.set(true);
    });
    // Particules : pause pendant les mouvements de caméra (parité globe).
    for (const ev of ['movestart', 'zoomstart', 'pitchstart', 'rotatestart']) {
      map.on(ev as keyof maplibregl.MapEventType, () => this.windEngine?.setMoving(true));
    }
    for (const ev of ['moveend', 'zoomend', 'pitchend', 'rotateend']) {
      map.on(ev as keyof maplibregl.MapEventType, () => this.windEngine?.setMoving(false));
    }
    // Première frame complète (tuiles chargées) → carte gelable sans image vide.
    map.once('idle', () => { this.rendered = true; });
  }

  // ─── Construction des layers depuis le snapshot ───
  private applySnapshotLayers(snap: MapConfigSnapshot): void {
    const map = this.map;
    if (!map) return;
    const when = new Date();
    const vis = snap.layers?.visibility ?? {};
    const opa = snap.layers?.opacities ?? {};
    const contours = snap.layers?.contours ?? { sstContours: false, windContours: false, waveContours: false };

    // Rasters GeoServer + overlays statiques (hors clés contours).
    for (const key of Object.keys(RASTER_LAYERS)) {
      if (key.endsWith('Contours')) continue;
      const desc = RASTER_LAYERS[key];
      if (vis[key]) this.addRaster(desc.layerId, buildRasterUrl(desc, when), opa[key] ?? desc.defaultOpacity, desc.attribution);
      else this.removeRaster(desc.layerId);
    }
    // Contours (overlay isolignes).
    for (const ck of ['sstContours', 'windContours', 'waveContours'] as const) {
      const desc = RASTER_LAYERS[ck];
      if (contours[ck]) this.addRaster(desc.layerId, buildRasterUrl(desc, when), opa[ck] ?? desc.defaultOpacity);
      else this.removeRaster(desc.layerId);
    }
    // Satellites.
    for (const p of SAT_PRODUCTS) {
      const id = `sat-${p.key}`;
      if (vis[p.key]) this.addRaster(id, buildSatWmsUrl(p, when), opa[p.key] ?? SAT_DEFAULT_OPACITY, p.attribution);
      else this.removeRaster(id);
    }
    // Flèches de vent / vagues (couche symboles + GeoJSON par temps).
    if (vis['windArrows']) this.ensureArrows('wind', when, opa['windArrows'] ?? ARROW_DEFAULT_OPACITY);
    else this.removeArrows(WIND_ARROWS_LAYER_ID);
    if (vis['waveArrows']) this.ensureArrows('wave', when, opa['waveArrows'] ?? ARROW_DEFAULT_OPACITY);
    else this.removeArrows(WAVE_ARROWS_LAYER_ID);
    // Particules de vent (couche WebGL custom).
    if (vis['wind']) void this.ensureWindParticles(opa['windParticles']);
    else this.removeWindParticles();
    // Particules de vagues (couche WebGL custom) — parité globe.
    if (vis['waveParticles']) void this.ensureWaveParticles(opa['waveParticles']);
    else this.removeWaveParticles();
    // Couches vecteur (navires/alertes/foudre/metar/séismes/firms/bouées/…).
    for (const kind of VECTOR_KINDS) {
      if (vis[kind]) void this.ensureVector(kind);
      else this.removeVector(kind);
    }

    this.applyZOrder(snap.layers?.zIndex?.order ?? []);
  }

  // ─── Couches vecteur (parité globe toggleVector, styling via util partagé) ───
  private async ensureVector(kind: VectorKind): Promise<void> {
    const map = this.map;
    if (!map) return;
    const sourceId = `vec-${kind}`;
    if (map.getSource(sourceId)) return; // déjà présente
    try {
      const fc = await this.fetchVectorFc(kind);
      if (!this.map || this.map.getSource(sourceId)) return;
      this.map.addSource(sourceId, {
        type: 'geojson',
        data: fc as never,
        cluster: vectorUsesCluster(kind),
        clusterRadius: 40,
        clusterMaxZoom: vectorClusterMaxZoom(kind),
      } as never);
      addVectorLayers(this.map, kind, sourceId);
    } catch { /* fetch vecteur échoué (souvent data absente) — silencieux */ }
  }

  private removeVector(kind: VectorKind): void {
    const map = this.map;
    if (!map) return;
    for (const id of VECTOR_LAYER_IDS[kind]) if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(`vec-${kind}`)) map.removeSource(`vec-${kind}`);
  }

  /** Fetch FeatureCollection d'un kind vecteur (miroir globe _fetchVectorFc). */
  private async fetchVectorFc(kind: VectorKind): Promise<{ features: unknown[] }> {
    if (kind === 'sigmet') return this.fetchJson('/aviation-airsigmet?format=geojson&hours=2');
    if (kind === 'taf') return this.fetchJson('/aviation-taf?format=geojson&hours=12&bbox=-90,-180,90,180');
    if (kind === 'fir') return this.fetchJson('/api/fir-airspaces');
    if (kind === 'airports') return this.fetchJson('/api/airports');
    if (kind === 'cables') {
      try { return await this.fetchJson('/cables-geo'); } catch { return { features: [] }; }
    }
    if (kind === 'lightning') return firstValueFrom(this.lightningService.fetchRecent(new Date(), 1800)) as Promise<{ features: unknown[] }>;
    if (kind === 'alerts') return this.alertsService.refresh(new Date(), 3600) as Promise<{ features: unknown[] }>;
    if (kind === 'vessels') return firstValueFrom(this.vesselsService.fetchLiveVessels(new Date(), 900)) as Promise<{ features: unknown[] }>;
    if (kind === 'buoys') return firstValueFrom(this.buoysService.fetchReferential()) as Promise<{ features: unknown[] }>;
    const at = new Date().toISOString();
    const endpoint = kind === 'piezo' ? '/api/hubeau/piezo/recent'
      : kind === 'quakes' ? '/api/earthquakes/recent'
      : `/api/${kind}/recent`;
    return this.fetchJson(`${endpoint}?at=${encodeURIComponent(at)}`);
  }

  private async fetchJson(url: string): Promise<{ features: unknown[] }> {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`${url} → HTTP ${resp.status}`);
    return resp.json();
  }

  // ─── Flèches vent/vagues (parité globe addArrowsLayer/refreshArrows) ───
  private ensureArrows(kind: 'wind' | 'wave', when: Date, opacity: number): void {
    const map = this.map;
    if (!map) return;
    const layerId = kind === 'wind' ? WIND_ARROWS_LAYER_ID : WAVE_ARROWS_LAYER_ID;
    if (!map.getLayer(layerId)) {
      this.addArrowsLayer(map, layerId, (kind === 'wind' ? WIND_ARROW_COLOR : WAVE_ARROW_COLOR));
    }
    map.setPaintProperty(layerId, 'icon-opacity', opacity);
    void this.refreshArrows(kind, when);
  }

  private addArrowsLayer(map: MapLibreMap, sourceId: string, colorExpr: unknown): void {
    if (map.getSource(sourceId)) map.removeSource(sourceId);
    map.addSource(sourceId, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: sourceId,
      type: 'symbol',
      source: sourceId,
      layout: {
        'icon-image': 'arrow-tip',
        'icon-rotate': ['get', 'dirTo'],
        'icon-rotation-alignment': 'map',
        'icon-size': 0.6,
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
      paint: {
        'icon-color': colorExpr as never,
        'icon-halo-color': '#0f172a',
        'icon-halo-width': 1.5,
      },
    });
  }

  private async refreshArrows(kind: 'wind' | 'wave', when: Date): Promise<void> {
    const map = this.map;
    if (!map) return;
    const manifest = await this.arrows.getManifest();
    if (!manifest) return;
    const layerId = kind === 'wind' ? WIND_ARROWS_LAYER_ID : WAVE_ARROWS_LAYER_ID;
    const list = kind === 'wind' ? manifest.wind : manifest.wave;
    const ts = this.arrows.findNearestTs(list, when);
    const src = map.getSource(layerId) as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    const last = kind === 'wind' ? this.lastWindArrowsTs : this.lastWaveArrowsTs;
    if (!ts) { src.setData({ type: 'FeatureCollection', features: [] } as never); return; }
    if (ts === last) return;
    try {
      const fc = await this.arrows.fetchArrows(kind, ts);
      src.setData(fc as never);
      if (kind === 'wind') this.lastWindArrowsTs = ts; else this.lastWaveArrowsTs = ts;
    } catch { /* fetch flèches échoué — silencieux */ }
  }

  private removeArrows(layerId: string): void {
    const map = this.map;
    if (!map) return;
    if (map.getLayer(layerId)) map.removeLayer(layerId);
    if (map.getSource(layerId)) map.removeSource(layerId);
    if (layerId === WIND_ARROWS_LAYER_ID) this.lastWindArrowsTs = undefined;
    if (layerId === WAVE_ARROWS_LAYER_ID) this.lastWaveArrowsTs = undefined;
  }

  /** Icône SDF flèche 'arrow-tip' (re-colorable via icon-color). Parité globe. */
  private addArrowIconToMap(map: MapLibreMap): void {
    if (map.hasImage('arrow-tip')) return;
    const size = 32;
    const cv = document.createElement('canvas');
    cv.width = size; cv.height = size;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = 'rgba(255,255,255,1)';
    ctx.beginPath();
    ctx.moveTo(size / 2, 2);
    ctx.lineTo(size - 6, size - 4);
    ctx.lineTo(size / 2, size - 10);
    ctx.lineTo(6, size - 4);
    ctx.closePath();
    ctx.fill();
    const data = ctx.getImageData(0, 0, size, size);
    map.addImage('arrow-tip', { width: size, height: size, data: data.data }, { sdf: true });
  }

  // ─── Particules de vent WebGL (parité globe toggleWind/_loadWindGrid) ───
  private async ensureWindParticles(opacity?: number): Promise<void> {
    const map = this.map;
    if (!map || map.getLayer(WIND_PARTICLES_LAYER_ID)) return;
    try {
      const grid = await this.loadWindGrid();
      const windData = buildWindTexture(grid, WIND_BBOX, 512, 256);
      const self = this;
      const layer: CustomLayerInterface = {
        id: WIND_PARTICLES_LAYER_ID,
        type: 'custom',
        onAdd(_m, gl) {
          self.windEngine = new WindWebGL(gl as WebGL2RenderingContext, { bounds: WIND_BBOX });
          self.windEngine.setNumParticles(DEFAULT_WIND_PARTICLES);
          self.windEngine.setWind(windData);
          if (opacity != null) self.windEngine.opacity = opacity;
        },
        render(_gl, args) {
          if (!self.windEngine) return;
          self.windEngine.draw(args as unknown as MapLibreCustomLayerRenderArgs);
          self.map?.triggerRepaint();
        },
        onRemove() { /* refs nettoyées par removeWindParticles */ },
      };
      this.windLayer = layer;
      if (this.map && !this.map.getLayer(WIND_PARTICLES_LAYER_ID)) this.map.addLayer(layer);
    } catch { /* grid vent indispo — silencieux */ }
  }

  private async loadWindGrid(): Promise<WindGridPoint[]> {
    if (this.windGridCache) return this.windGridCache;
    const manifest = await this.arrows.getManifest();
    if (!manifest) throw new Error('manifest indisponible');
    const tsList = manifest.wind ?? [];
    if (tsList.length === 0) throw new Error('aucun timestamp wind');
    const nearest = this.arrows.findNearestTs(tsList, new Date()) ?? tsList[tsList.length - 1];
    const fc = await this.arrows.fetchArrows('wind', nearest);
    const grid: WindGridPoint[] = fc.features
      .filter((f) => f.geometry?.type === 'Point')
      .map((f) => {
        const props = f.properties as { speed?: number; dirTo?: number };
        const { u, v } = speedDirToUv(props.speed ?? 0, props.dirTo ?? 0);
        const [lon, lat] = f.geometry.coordinates;
        return { lon, lat, u, v };
      });
    this.windGridCache = grid;
    return grid;
  }

  private removeWindParticles(): void {
    const map = this.map;
    if (map && this.windLayer && map.getLayer(this.windLayer.id)) map.removeLayer(this.windLayer.id);
    this.windLayer = undefined;
    this.windEngine = undefined;
  }

  // ─── Particules de vagues (parité globe : WindWebGL, lineWidth 3.0, plus lent,
  //     alimenté hs WW3, masque terre via canal B de buildWindTexture). ───
  private async ensureWaveParticles(opacity?: number): Promise<void> {
    const map = this.map;
    if (!map || map.getLayer('wave-webgl')) return;
    try {
      const grid = await this.loadWaveGrid();
      const waveData = buildWindTexture(grid, WIND_BBOX, 512, 256);
      const self = this;
      const layer: CustomLayerInterface = {
        id: 'wave-webgl',
        type: 'custom',
        onAdd(_m, gl) {
          self.waveEngine = new WindWebGL(gl as WebGL2RenderingContext, { bounds: WIND_BBOX, lineWidth: 3.0, speedFactor: 0.15 });
          self.waveEngine.setNumParticles(DEFAULT_WIND_PARTICLES);
          self.waveEngine.setWind(waveData);
          if (opacity != null) self.waveEngine.opacity = opacity;
        },
        render(_gl, args) {
          if (!self.waveEngine) return;
          self.waveEngine.draw(args as unknown as MapLibreCustomLayerRenderArgs);
          self.map?.triggerRepaint();
        },
        onRemove() { /* refs nettoyées par removeWaveParticles */ },
      };
      this.waveLayer = layer;
      if (this.map && !this.map.getLayer('wave-webgl')) this.map.addLayer(layer);
    } catch { /* grid vagues indispo — silencieux */ }
  }

  private async loadWaveGrid(): Promise<WindGridPoint[]> {
    if (this.waveGridCache) return this.waveGridCache;
    const manifest = await this.arrows.getManifest();
    if (!manifest) throw new Error('manifest indisponible');
    const tsList = manifest.wave ?? [];
    if (tsList.length === 0) throw new Error('aucun timestamp wave');
    const nearest = this.arrows.findNearestTs(tsList, new Date()) ?? tsList[tsList.length - 1];
    const fc = await this.arrows.fetchArrows('wave', nearest);
    const grid: WindGridPoint[] = fc.features
      .filter((f) => f.geometry?.type === 'Point')
      .map((f) => {
        // WaveArrowFeature porte `hs` (pas `speed`) ; hs réel → couleur bleue,
        // mouvement via speedFactor de l'engine (cf globe.component).
        const props = f.properties as { hs?: number; dirTo?: number };
        const { u, v } = speedDirToUv(props.hs ?? 0, props.dirTo ?? 0);
        const [lon, lat] = f.geometry.coordinates;
        return { lon, lat, u, v };
      });
    this.waveGridCache = grid;
    return grid;
  }

  private removeWaveParticles(): void {
    const map = this.map;
    if (map && this.waveLayer && map.getLayer(this.waveLayer.id)) map.removeLayer(this.waveLayer.id);
    this.waveLayer = undefined;
    this.waveEngine = undefined;
  }

  private addRaster(id: string, url: string, opacity: number, attribution?: string): void {
    const map = this.map;
    if (!map) return;
    if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(id)) map.removeSource(id);
    map.addSource(id, { type: 'raster', tiles: [url], tileSize: WMS_TILE_SIZE, ...(attribution ? { attribution } : {}) });
    map.addLayer({ id, type: 'raster', source: id, paint: { 'raster-opacity': opacity } });
  }

  private removeRaster(id: string): void {
    const map = this.map;
    if (!map) return;
    if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(id)) map.removeSource(id);
  }

  /** Time-bar : rafraîchit les sources time-enabled (setTiles) + flèches au scrub. */
  private refreshTimeLayers(when: Date): void {
    const map = this.map;
    if (!map) return;
    const snap = this.snapshot();
    const vis = snap.layers?.visibility ?? {};
    const contours = snap.layers?.contours ?? { sstContours: false, windContours: false, waveContours: false };
    const setTiles = (id: string, url: string) => {
      const src = map.getSource(id) as unknown as { setTiles?: (t: string[]) => void } | undefined;
      src?.setTiles?.([url]);
    };
    for (const key of Object.keys(RASTER_LAYERS)) {
      const desc = RASTER_LAYERS[key];
      if (desc.timeKind === 'none') continue;
      const on = key.endsWith('Contours') ? (contours as Record<string, boolean>)[key] : vis[key];
      if (on) setTiles(desc.layerId, buildRasterUrl(desc, when));
    }
    for (const p of SAT_PRODUCTS) {
      if (vis[p.key]) setTiles(`sat-${p.key}`, buildSatWmsUrl(p, when));
    }
    if (vis['windArrows']) void this.refreshArrows('wind', when);
    if (vis['waveArrows']) void this.refreshArrows('wave', when);
  }

  private keyToLayerId(key: string): string | null {
    if (RASTER_LAYERS[key]) return RASTER_LAYERS[key].layerId;
    if (SAT_PRODUCT_KEYS.has(key)) return `sat-${key}`;
    return null;
  }

  private applyZOrder(order: string[]): void {
    const map = this.map;
    if (!map || order.length === 0) return;
    for (let i = order.length - 1; i >= 0; i--) {
      const id = this.keyToLayerId(order[i]);
      if (id && map.getLayer(id)) { try { map.moveLayer(id); } catch { /* race */ } }
    }
  }

  private teardown(): void {
    this.observer?.disconnect();
    this.resizeObserver?.disconnect();
    this.registry.remove(this);
    this.map?.remove();
    this.map = undefined;
  }
}
