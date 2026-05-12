/**
 * Zones d'arrivée prédéfinies — choisies par le user dans /palettes et
 * appliquées au boot de la carte (DB pour les connectés, localStorage
 * sinon, fallback 'france' pour les nouveaux visiteurs anonymes).
 *
 * bbox = [minLon, minLat, maxLon, maxLat] (EPSG:4326).
 * center / zoom servent à OL.setView() au boot.
 * Le bbox sert aussi à dessiner le rectangle de preview dans la page
 * palettes.
 */
export interface MapZone {
  id: string;
  label: string;
  center: [number, number];     // lon, lat
  zoom: number;
  bbox: [number, number, number, number];
}

export const DEFAULT_ZONE_ID = 'france';

export const MAP_ZONES: MapZone[] = [
  // ─── Régions ───────────────────────────────────────────────
  { id: 'europe',      label: 'Europe étroite',         center: [10, 50],    zoom: 4, bbox: [-15, 35, 30, 65] },
  { id: 'europe-west', label: 'Europe de l\'Ouest',     center: [0, 48],     zoom: 5, bbox: [-12, 35, 15, 60] },
  { id: 'europe-east', label: 'Europe de l\'Est',       center: [22, 48],    zoom: 5, bbox: [10, 35, 35, 60] },
  { id: 'mediterranee',label: 'Méditerranée',           center: [15, 38],    zoom: 5, bbox: [-6, 30, 36, 46] },
  { id: 'manche',      label: 'Manche / Mer du Nord',   center: [0, 51],     zoom: 6, bbox: [-7, 47, 10, 56] },
  { id: 'atlantique',  label: 'Atlantique NE',          center: [-7, 50],    zoom: 5, bbox: [-15, 40, 5, 60] },
  { id: 'baltique',    label: 'Mer Baltique',           center: [20, 59],    zoom: 5, bbox: [10, 53, 30, 65] },
  { id: 'adriatique',  label: 'Adriatique',             center: [16, 43],    zoom: 6, bbox: [12, 39, 20, 46] },
  // ─── Pays ───────────────────────────────────────────────────
  { id: 'france',      label: 'France métropole',       center: [2.5, 46.5], zoom: 6, bbox: [-6, 41, 10, 51.5] },
  { id: 'royaume-uni', label: 'Royaume-Uni',            center: [-2, 54.5],  zoom: 6, bbox: [-9, 49, 2, 61] },
  { id: 'irlande',     label: 'Irlande',                center: [-8, 53.5],  zoom: 7, bbox: [-11, 51, -5, 56] },
  { id: 'allemagne',   label: 'Allemagne',              center: [10, 51.2],  zoom: 6, bbox: [5.5, 47, 15.5, 55.5] },
  { id: 'espagne',     label: 'Espagne',                center: [-3.5, 40],  zoom: 6, bbox: [-10, 35, 5, 44] },
  { id: 'portugal',    label: 'Portugal',               center: [-8, 39.5],  zoom: 7, bbox: [-10, 36.5, -6, 42.5] },
  { id: 'italie',      label: 'Italie',                 center: [12.5, 42.5],zoom: 6, bbox: [6, 36, 19, 47] },
  { id: 'pays-bas',    label: 'Pays-Bas / Belgique',    center: [5, 52],     zoom: 7, bbox: [2, 49.5, 8, 54] },
  { id: 'norvege',     label: 'Norvège côtière',        center: [10, 64],    zoom: 5, bbox: [3, 58, 25, 71] },
  { id: 'grece',       label: 'Grèce / Égée',           center: [24, 38],    zoom: 6, bbox: [19, 34.5, 29, 42] },
  { id: 'pologne',     label: 'Pologne',                center: [19, 52],    zoom: 6, bbox: [14, 49, 24, 55] },
  { id: 'turquie',     label: 'Turquie / Mer Noire',    center: [32, 40.5],  zoom: 5, bbox: [25, 35.5, 45, 46] },
  { id: 'islande',     label: 'Islande',                center: [-19, 65],   zoom: 6, bbox: [-25, 63, -13, 67] },
  { id: 'suisse',      label: 'Suisse / Alpes',         center: [8, 46.8],   zoom: 8, bbox: [5, 45.5, 11, 48] },
  { id: 'bulgarie',    label: 'Bulgarie',               center: [25.5, 43],  zoom: 7, bbox: [22, 41, 29, 45] },
];

export function findZone(id: string | null | undefined): MapZone {
  return MAP_ZONES.find((z) => z.id === id) ?? MAP_ZONES.find((z) => z.id === DEFAULT_ZONE_ID)!;
}
