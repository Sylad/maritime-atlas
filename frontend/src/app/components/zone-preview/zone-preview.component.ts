import { ChangeDetectionStrategy, Component, ElementRef, ViewChild, effect, input } from '@angular/core';
import Map from 'ol/Map';
import View from 'ol/View';
import TileLayer from 'ol/layer/Tile';
import XYZ from 'ol/source/XYZ';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import Feature from 'ol/Feature';
import { Polygon } from 'ol/geom';
import { fromLonLat } from 'ol/proj';
import { Style, Stroke, Fill } from 'ol/style';
import { defaults as defaultControls } from 'ol/control';
import { findZone } from '../../services/map-zones';

/**
 * Phase C.3 (2026-05-12) — mini map OL qui montre le rectangle d'une zone
 * sélectionnée. Utilisée dans la page /palettes pour previewer la "zone
 * d'arrivée" avant qu'elle soit validée.
 *
 * Pattern : carte fixe centrée sur l'Europe-monde (zoom 2), un layer
 * vector dessine le polygone correspondant au bbox de la zone passée
 * en input. Quand l'input `zoneId` change, le polygone est mis à jour
 * sans recréer le map (cheap).
 */
@Component({
  selector: 'app-zone-preview',
  template: `<div #mapEl class="zone-preview-map"></div>`,
  styles: `
    :host { display: block; width: 100%; }
    .zone-preview-map {
      width: 100%;
      height: 220px;
      border-radius: 6px;
      overflow: hidden;
      border: 1px solid rgba(255, 255, 255, 0.1);
      background: #0a0e1a;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ZonePreviewComponent {
  readonly zoneId = input<string>('france');

  @ViewChild('mapEl', { static: true }) mapEl!: ElementRef<HTMLDivElement>;

  private map?: Map;
  private rectSource?: VectorSource;

  constructor() {
    // Effect réactif sur le zoneId — redessine le rectangle quand change.
    effect(() => {
      const id = this.zoneId();
      queueMicrotask(() => this.drawZoneRect(id));
    });
  }

  ngAfterViewInit(): void {
    this.rectSource = new VectorSource();
    this.map = new Map({
      target: this.mapEl.nativeElement,
      controls: defaultControls({ attribution: false, zoom: false, rotate: false }),
      layers: [
        new TileLayer({
          // Phase C.5 : passe par notre proxy_cache nginx (mêmes tiles
          // CARTO, mais cachées 30j localement).
          source: new XYZ({
            url: '/carto-tiles/dark_nolabels/{z}/{x}/{y}.png',
            attributions: '',
          }),
        }),
        new VectorLayer({
          source: this.rectSource,
          style: new Style({
            stroke: new Stroke({ color: '#fbbf24', width: 2 }),
            fill: new Fill({ color: 'rgba(251, 191, 36, 0.18)' }),
          }),
        }),
      ],
      view: new View({
        center: fromLonLat([10, 50]),
        zoom: 3,
        minZoom: 2,
        maxZoom: 6,
      }),
    });
    // Initial draw — peut arriver avant le 1er effect tick si l'input
    // a une valeur dès le bind.
    this.drawZoneRect(this.zoneId());
  }

  ngOnDestroy(): void {
    if (this.map) {
      this.map.setTarget(undefined);
      this.map = undefined;
    }
  }

  private drawZoneRect(zoneId: string): void {
    if (!this.rectSource || !this.map) return;
    const z = findZone(zoneId);
    const [minLon, minLat, maxLon, maxLat] = z.bbox;
    const ring: [number, number][] = [
      [minLon, minLat],
      [maxLon, minLat],
      [maxLon, maxLat],
      [minLon, maxLat],
      [minLon, minLat],
    ].map(([lon, lat]) => fromLonLat([lon, lat]) as [number, number]);
    const poly = new Polygon([ring]);
    this.rectSource.clear();
    this.rectSource.addFeature(new Feature(poly));
    // Ne pas auto-fit — la carte garde un cadrage stable pour comparer les
    // zones entre elles. Si la zone sort du viewport, c'est OK : ça montre
    // qu'elle est par exemple plus à l'Est que France.
  }
}
