/**
 * Sprint L outdoor MVP (2026-05-20) — helpers pour les layers OL plages + ski.
 *
 * À wire dans map.component.ts :
 *
 *   1. Importer createBeachesLayer / createSkiLayer ici
 *   2. Dans ngOnInit/init map : appeler les factories, stocker dans this.beachesLayer / this.skiLayer
 *   3. Ajouter au map.addLayer() (zIndex 130 entre alerts et météo)
 *   4. Ajouter signals showBeaches / showSki + effect setVisible
 *   5. Ajouter toggle UI dans la légende (catégorie 🏖 Outdoor)
 *   6. Ajouter le click handler popup (cf onBeachClick / onSkiClick)
 *   7. Persist showBeaches/showSki dans localStorage + DB sync
 *
 * Pas de LAYER_PROFILES (static obs, pas de validity), pas dans la time-bar,
 * pas d'opacity slider (la layer est points discrets, opacity 1 par défaut).
 */
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import GeoJSON from 'ol/format/GeoJSON';
import { Feature } from 'ol';
import { Point } from 'ol/geom';
import { Style, Icon, Circle, Fill, Stroke, Text } from 'ol/style';
import type { FeatureLike } from 'ol/Feature';

const PROJ = 'EPSG:3857';
const DATA_PROJ = 'EPSG:4326';

const BEACH_FILL = '#0ea5e9';   // sky-blue (mer)
const BEACH_LAKE_FILL = '#22d3ee'; // cyan (lac)
const BEACH_STROKE = '#0c4a6e';

const SKI_FILL = '#e2e8f0';      // slate-200 (neige)
const SKI_STROKE = '#475569';

/** Fetch GeoJSON depuis /api/outdoor/beaches.geojson et populate une VectorSource OL. */
export async function fetchBeaches(source: VectorSource): Promise<number> {
  const res = await fetch('/api/outdoor/beaches.geojson');
  if (!res.ok) throw new Error(`Beaches fetch failed: ${res.status}`);
  const geojson = await res.json();
  const features = new GeoJSON().readFeatures(geojson, {
    dataProjection: DATA_PROJ,
    featureProjection: PROJ,
  });
  source.clear();
  source.addFeatures(features);
  return features.length;
}

/** Fetch GeoJSON depuis /api/outdoor/ski-stations.geojson. */
export async function fetchSkiStations(source: VectorSource): Promise<number> {
  const res = await fetch('/api/outdoor/ski-stations.geojson');
  if (!res.ok) throw new Error(`Ski stations fetch failed: ${res.status}`);
  const geojson = await res.json();
  const features = new GeoJSON().readFeatures(geojson, {
    dataProjection: DATA_PROJ,
    featureProjection: PROJ,
  });
  source.clear();
  source.addFeatures(features);
  return features.length;
}

export function createBeachesLayer(): { layer: VectorLayer<VectorSource>; source: VectorSource } {
  const source = new VectorSource({
    attributions: 'Plages curées · Qualité eau : baignades.sante.gouv.fr',
  });
  const layer = new VectorLayer({
    source,
    style: (f: FeatureLike) => styleBeach(f as Feature<Point>),
    zIndex: 130,
    visible: false,
    declutter: true,
  });
  return { layer, source };
}

export function createSkiLayer(): { layer: VectorLayer<VectorSource>; source: VectorSource } {
  const source = new VectorSource({
    attributions: 'Stations ski curées · Conditions neige : sites officiels',
  });
  const layer = new VectorLayer({
    source,
    style: (f: FeatureLike) => styleSki(f as Feature<Point>),
    zIndex: 131,
    visible: false,
    declutter: true,
  });
  return { layer, source };
}

function styleBeach(f: Feature<Point>): Style {
  const isLake = f.get('type') === 'lac';
  return new Style({
    image: new Circle({
      radius: 6,
      fill: new Fill({ color: isLake ? BEACH_LAKE_FILL : BEACH_FILL }),
      stroke: new Stroke({ color: BEACH_STROKE, width: 1.5 }),
    }),
    text: new Text({
      text: '🏖',
      font: '14px sans-serif',
      offsetY: -2,
    }),
  });
}

function styleSki(f: Feature<Point>): Style {
  const km = (f.get('kmPistes') as number) ?? 0;
  // Rayon proportionnel à la taille du domaine (km pistes).
  const radius = km > 400 ? 9 : km > 200 ? 7 : km > 100 ? 6 : 5;
  return new Style({
    image: new Circle({
      radius,
      fill: new Fill({ color: SKI_FILL }),
      stroke: new Stroke({ color: SKI_STROKE, width: 1.5 }),
    }),
    text: new Text({
      text: '⛷',
      font: '14px sans-serif',
      offsetY: -2,
    }),
  });
}

/** Popup HTML pour une plage. À appeler depuis le map.on('singleclick') existant. */
export function beachPopupHtml(props: Record<string, unknown>): string {
  const name = String(props['name'] ?? 'Plage');
  const region = String(props['region'] ?? '');
  const dep = String(props['dep'] ?? '');
  const isLake = props['type'] === 'lac';
  const qualityUrl = String(props['qualityUrl'] ?? '');
  return `
    <div class="popup-card">
      <div class="popup-title">🏖 ${name}</div>
      <div class="popup-sub">${region} · ${dep} · ${isLake ? 'Lac' : 'Côtière'}</div>
      <a href="${qualityUrl}" target="_blank" rel="noopener" class="popup-link">
        → Qualité eau (baignades.sante.gouv.fr)
      </a>
    </div>
  `.trim();
}

/** Popup HTML pour une station ski. */
export function skiPopupHtml(props: Record<string, unknown>): string {
  const name = String(props['name'] ?? 'Station');
  const massif = String(props['massif'] ?? '');
  const altMin = Number(props['altMin'] ?? 0);
  const altMax = Number(props['altMax'] ?? 0);
  const kmPistes = Number(props['kmPistes'] ?? 0);
  const website = String(props['website'] ?? '');
  return `
    <div class="popup-card">
      <div class="popup-title">⛷ ${name}</div>
      <div class="popup-sub">${massif} · ${altMin}–${altMax} m · ${kmPistes} km pistes</div>
      <a href="${website}" target="_blank" rel="noopener" class="popup-link">
        → Conditions neige (site officiel)
      </a>
    </div>
  `.trim();
}
