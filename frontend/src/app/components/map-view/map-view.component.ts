import {
  AfterViewInit, ChangeDetectionStrategy, Component, DestroyRef, ElementRef,
  effect, inject, input, signal, viewChild,
} from '@angular/core';
import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl';
import type { MapConfigSnapshot } from '../../models/map-config-snapshot';
import {
  CARTO_DARK_TILES, MAPLIBRE_GLYPHS, RASTER_LAYERS, SAT_DEFAULT_OPACITY,
  SAT_PRODUCTS, SAT_PRODUCT_KEYS, WMS_TILE_SIZE,
} from './map-layers-constants';
import { buildRasterUrl, buildSatWmsUrl } from './map-layers.util';
import { LiveMapHandle, MapViewRegistry } from './map-view-registry.service';

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
    </div>
  `,
  styles: [`
    :host { display: block; width: 100%; height: 100%; }
    .mv-root { position: relative; width: 100%; height: 100%; overflow: hidden; background: #0b1220; border-radius: inherit; }
    .mv-canvas { position: absolute; inset: 0; }
    .mv-canvas.mv-hidden { visibility: hidden; }
    .mv-frozen { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
    .mv-overlay { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #64748b; font-size: 0.9rem; pointer-events: none; }
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
  private readonly mapContainer = viewChild.required<ElementRef<HTMLDivElement>>('mapContainer');

  private map?: MapLibreMap;
  private observer?: IntersectionObserver;
  private resizeObserver?: ResizeObserver;
  private visible = false;
  private rendered = false;

  readonly ready = signal(false);
  readonly frozen = signal(false);
  readonly frozenSrc = signal<string | null>(null);

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
      attributionControl: false,
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
    map.on('load', () => {
      map.setProjection({ type: view?.projection ?? 'mercator' });
      this.applySnapshotLayers(snap);
      this.ready.set(true);
    });
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
    this.applyZOrder(snap.layers?.zIndex?.order ?? []);
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
