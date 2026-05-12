import proj4 from 'proj4';
import { register } from 'ol/proj/proj4';

/**
 * Projections OL supportées. EPSG:3857 (Web Mercator) est le défaut OL
 * et fonctionne nativement. EPSG:4326 (lat/lon equirectangular) aussi.
 * EPSG:3035 (Lambert Azimuthal Equal-Area Europe) nécessite proj4 register.
 *
 * Phase C.4 (2026-05-12) — Sylvain a demandé un sélecteur projection
 * dans /palettes (avec warning sur l'effet potentiel sur les particules
 * de vent et flèches qui sont en lon/lat).
 */
export interface MapProjection {
  code: string;
  label: string;
  desc: string;
  /** Proj4 definition string — seulement pour les non-natives OL. */
  proj4Def?: string;
}

export const DEFAULT_PROJECTION = 'EPSG:3857';

export const MAP_PROJECTIONS: MapProjection[] = [
  {
    code: 'EPSG:3857',
    label: 'Web Mercator (défaut)',
    desc: 'Standard web maps. Bonne pour navigation et zoom uniforme.',
  },
  {
    code: 'EPSG:4326',
    label: 'WGS84 lat/lon',
    desc: 'Equirectangulaire. Distortion forte aux pôles, mais pas de déformation longitudinale.',
  },
  {
    code: 'EPSG:3035',
    label: 'Lambert Europe (LAEA)',
    desc: 'Lambert Azimuthal Equal-Area centré Europe. Conserve les surfaces — meilleure perception géographique pour le périmètre Europe étroite.',
    proj4Def: '+proj=laea +lat_0=52 +lon_0=10 +x_0=4321000 +y_0=3210000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  },
];

let projectionsRegistered = false;

/** À appeler 1× au boot avant toute création de View OL. Idempotent. */
export function registerCustomProjections(): void {
  if (projectionsRegistered) return;
  for (const p of MAP_PROJECTIONS) {
    if (p.proj4Def) {
      proj4.defs(p.code, p.proj4Def);
    }
  }
  register(proj4);
  projectionsRegistered = true;
}

export function findProjection(code: string | null | undefined): MapProjection {
  return MAP_PROJECTIONS.find((p) => p.code === code) ?? MAP_PROJECTIONS[0];
}
