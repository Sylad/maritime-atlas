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
  { id: 'france',      label: 'France métropole',       center: [2.5, 46.5], zoom: 6, bbox: [-6, 41, 10, 51.5] },
  { id: 'europe',      label: 'Europe étroite',         center: [10, 50],    zoom: 4, bbox: [-15, 35, 30, 65] },
  { id: 'europe-west', label: 'Europe de l\'Ouest',     center: [0, 48],     zoom: 5, bbox: [-12, 35, 15, 60] },
  { id: 'europe-east', label: 'Europe de l\'Est',       center: [22, 48],    zoom: 5, bbox: [10, 35, 35, 60] },
  { id: 'mediterranee',label: 'Méditerranée',           center: [15, 38],    zoom: 5, bbox: [-6, 30, 36, 46] },
  { id: 'manche',      label: 'Manche / Mer du Nord',   center: [0, 51],     zoom: 6, bbox: [-7, 47, 10, 56] },
  { id: 'atlantique',  label: 'Atlantique NE',          center: [-7, 50],    zoom: 5, bbox: [-15, 40, 5, 60] },
  { id: 'baltique',    label: 'Mer Baltique',           center: [20, 59],    zoom: 5, bbox: [10, 53, 30, 65] },
  { id: 'suisse',      label: 'Suisse / Alpes',         center: [8, 46.8],   zoom: 8, bbox: [5, 45.5, 11, 48] },
  { id: 'bulgarie',    label: 'Bulgarie',               center: [25.5, 43],  zoom: 7, bbox: [22, 41, 29, 45] },
];

export function findZone(id: string | null | undefined): MapZone {
  return MAP_ZONES.find((z) => z.id === id) ?? MAP_ZONES.find((z) => z.id === DEFAULT_ZONE_ID)!;
}
