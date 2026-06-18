/**
 * Construction des couches VECTEUR MapLibre (2026-06-18) — port fidèle du
 * toggleVector du GlobeComponent, factorisé en util PUR réutilisable. Objectif :
 * une source unique de vérité pour le styling vecteur, que la widget utilise
 * dès maintenant et que le globe pourra adopter lors d'une passe d'unification.
 *
 * Ne gère PAS le fetch (qui dépend de services Angular) — uniquement
 * addSource/addLayer une fois la FeatureCollection obtenue.
 */
import type { Map as MapLibreMap } from 'maplibre-gl';

export type VectorKind =
  | 'lightning' | 'alerts' | 'vessels' | 'metar' | 'hubeau' | 'piezo'
  | 'quakes' | 'firms' | 'buoys' | 'sigmet' | 'taf' | 'cables' | 'fir' | 'airports';

export const VECTOR_KINDS: VectorKind[] = [
  'lightning', 'alerts', 'vessels', 'metar', 'hubeau', 'piezo',
  'quakes', 'firms', 'buoys', 'sigmet', 'taf', 'cables', 'fir', 'airports',
];

/** IDs MapLibre des couches par kind (pour remove). */
export const VECTOR_LAYER_IDS: Record<VectorKind, string[]> = {
  lightning: ['vec-lightning'],
  alerts: ['vec-alerts'],
  vessels: ['vec-vessels-clusters', 'vec-vessels-cluster-count', 'vec-vessels-points'],
  metar: ['vec-metar'],
  hubeau: ['vec-hubeau'],
  piezo: ['vec-piezo'],
  quakes: ['vec-quakes'],
  firms: ['vec-firms'],
  buoys: ['vec-buoys'],
  sigmet: ['vec-sigmet-fill', 'vec-sigmet-line'],
  taf: ['vec-taf'],
  cables: ['vec-cables'],
  fir: ['vec-fir-line'],
  airports: ['vec-airports-clusters', 'vec-airports-count', 'vec-airports-points', 'vec-airports-dot'],
};

export function vectorUsesCluster(kind: VectorKind): boolean {
  return kind === 'vessels' || kind === 'airports';
}

export function vectorClusterMaxZoom(kind: VectorKind): number {
  return kind === 'airports' ? 6 : 12;
}

const SIMPLE_POINT_PAINT: Partial<Record<VectorKind, { color: string; radius: number; stroke: string }>> = {
  metar: { color: '#fbbf24', radius: 4, stroke: '#92400e' },
  hubeau: { color: '#06b6d4', radius: 5, stroke: '#0e7490' },
  piezo: { color: '#8b5cf6', radius: 5, stroke: '#6d28d9' },
  quakes: { color: '#ef4444', radius: 5, stroke: '#7f1d1d' },
};

const SYMBOL_GLYPH: Partial<Record<VectorKind, { glyph: string; color: string; size: number }>> = {
  firms: { glyph: '🔥', color: '#f97316', size: 18 },
  buoys: { glyph: '⚓', color: '#10b981', size: 16 },
};

/** Ajoute les couches MapLibre d'un kind vecteur (la source `sourceId` existe déjà). */
export function addVectorLayers(map: MapLibreMap, kind: VectorKind, sourceId: string): void {
  const simple = SIMPLE_POINT_PAINT[kind];
  const glyph = SYMBOL_GLYPH[kind];
  if (simple) {
    map.addLayer({
      id: `vec-${kind}`, type: 'circle', source: sourceId,
      paint: {
        'circle-radius': simple.radius, 'circle-color': simple.color,
        'circle-stroke-width': 1, 'circle-stroke-color': simple.stroke, 'circle-opacity': 0.85,
      },
    });
  } else if (glyph) {
    map.addLayer({
      id: `vec-${kind}`, type: 'symbol', source: sourceId,
      layout: { 'text-field': glyph.glyph, 'text-font': ['Open Sans Regular'], 'text-size': glyph.size, 'text-allow-overlap': true, 'text-ignore-placement': true },
      paint: { 'text-color': glyph.color, 'text-halo-color': 'rgba(0,0,0,0.85)', 'text-halo-width': 1.5, 'text-opacity': 0.95 },
    });
  } else if (kind === 'lightning') {
    map.addLayer({
      id: 'vec-lightning', type: 'symbol', source: sourceId,
      layout: { 'text-field': '⚡', 'text-font': ['Open Sans Regular'], 'text-size': 18, 'text-allow-overlap': true, 'text-ignore-placement': true },
      paint: { 'text-color': '#fde047', 'text-halo-color': 'rgba(0,0,0,0.85)', 'text-halo-width': 1.5, 'text-opacity': 0.95 },
    });
  } else if (kind === 'alerts') {
    map.addLayer({
      id: 'vec-alerts', type: 'circle', source: sourceId,
      paint: {
        'circle-radius': 7,
        'circle-color': ['match', ['get', 'severity'], 'danger', '#dc2626', 'warning', '#f97316', 'info', '#38bdf8', '#94a3b8'],
        'circle-stroke-width': 2, 'circle-stroke-color': '#fff', 'circle-opacity': 0.9,
      },
    });
  } else if (kind === 'sigmet') {
    map.addLayer({ id: 'vec-sigmet-fill', type: 'fill', source: sourceId, paint: { 'fill-color': '#dc2626', 'fill-opacity': 0.18 } });
    map.addLayer({ id: 'vec-sigmet-line', type: 'line', source: sourceId, paint: { 'line-color': '#dc2626', 'line-width': 1.5, 'line-opacity': 0.85 } });
  } else if (kind === 'taf') {
    map.addLayer({ id: 'vec-taf', type: 'circle', source: sourceId, paint: { 'circle-radius': 4, 'circle-color': '#3b82f6', 'circle-stroke-width': 1, 'circle-stroke-color': '#1e3a8a', 'circle-opacity': 0.85 } });
  } else if (kind === 'cables') {
    map.addLayer({ id: 'vec-cables', type: 'line', source: sourceId, paint: { 'line-color': '#f59e0b', 'line-width': 1.4, 'line-opacity': 0.75 } });
  } else if (kind === 'fir') {
    map.addLayer({
      id: 'vec-fir-line', type: 'line', source: sourceId,
      paint: { 'line-color': ['match', ['get', 'type'], 'UIR', '#64748b', '#94a3b8'], 'line-width': 0.8, 'line-opacity': 0.55, 'line-dasharray': [2, 2] },
    });
  } else if (kind === 'airports') {
    map.addLayer({
      id: 'vec-airports-clusters', type: 'circle', source: sourceId, filter: ['has', 'point_count'],
      paint: {
        'circle-color': ['step', ['get', 'point_count'], '#0ea5e9', 25, '#6366f1', 100, '#a855f7'],
        'circle-radius': ['step', ['get', 'point_count'], 11, 25, 15, 100, 20],
        'circle-opacity': 0.8, 'circle-stroke-color': '#0f172a', 'circle-stroke-width': 1.5,
      },
    });
    map.addLayer({
      id: 'vec-airports-count', type: 'symbol', source: sourceId, filter: ['has', 'point_count'],
      layout: { 'text-field': '{point_count_abbreviated}', 'text-font': ['Open Sans Regular'], 'text-size': 11, 'text-allow-overlap': true },
      paint: { 'text-color': '#ffffff' },
    });
    map.addLayer({
      id: 'vec-airports-points', type: 'symbol', source: sourceId, filter: ['!', ['has', 'point_count']],
      layout: { 'text-field': '{iataCode}', 'text-font': ['Open Sans Regular'], 'text-size': 10, 'text-offset': [0, 0.9], 'text-anchor': 'top', 'text-optional': true },
      paint: { 'text-color': '#7dd3fc', 'text-halo-color': '#0f172a', 'text-halo-width': 1.2 },
    });
    map.addLayer({
      id: 'vec-airports-dot', type: 'circle', source: sourceId, filter: ['!', ['has', 'point_count']],
      paint: { 'circle-radius': 3.5, 'circle-color': '#0ea5e9', 'circle-stroke-color': '#e0f2fe', 'circle-stroke-width': 1 },
    });
  } else {
    // vessels : cluster bubbles + count + points.
    map.addLayer({
      id: 'vec-vessels-clusters', type: 'circle', source: sourceId, filter: ['has', 'point_count'],
      paint: {
        'circle-color': ['step', ['get', 'point_count'], '#22c55e', 25, '#3b82f6', 100, '#a855f7'],
        'circle-radius': ['step', ['get', 'point_count'], 12, 25, 16, 100, 22],
        'circle-opacity': 0.85, 'circle-stroke-color': '#0f172a', 'circle-stroke-width': 1.5,
      },
    });
    map.addLayer({
      id: 'vec-vessels-cluster-count', type: 'symbol', source: sourceId, filter: ['has', 'point_count'],
      layout: { 'text-field': '{point_count_abbreviated}', 'text-font': ['Open Sans Regular'], 'text-size': 12, 'text-allow-overlap': true, 'text-ignore-placement': true },
      paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(0,0,0,0.5)', 'text-halo-width': 1 },
    });
    map.addLayer({
      id: 'vec-vessels-points', type: 'circle', source: sourceId, filter: ['!', ['has', 'point_count']],
      paint: { 'circle-radius': 3, 'circle-color': '#22c55e', 'circle-stroke-color': '#0f172a', 'circle-stroke-width': 1 },
    });
  }
}
