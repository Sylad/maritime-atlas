/**
 * Sprint L outdoor MVP (2026-05-20) — top stations ski françaises curées.
 *
 * Dataset statique : nom, coordonnées, massif, altitudes min/max, taille
 * estimée (km pistes), URL officielle pour conditions neige live.
 *
 * Pour évolution : remplacer par fetcher OpenSnowMap.org ou skiinfo.fr pour
 * snow heights live + bulletin avalanche ANENA.
 */
export interface SkiStation {
  id: string;
  name: string;
  lon: number;
  lat: number;
  massif: string;
  altMin: number;
  altMax: number;
  kmPistes: number;
  website: string;
}

export const SKI_STATIONS: SkiStation[] = [
  // Alpes du Nord — grandes domaines
  { id: 'val-tho', name: 'Val Thorens', lon: 6.5800, lat: 45.2980, massif: 'Trois Vallées', altMin: 2300, altMax: 3230, kmPistes: 600, website: 'https://www.valthorens.com' },
  { id: 'meribel', name: 'Méribel', lon: 6.5645, lat: 45.3955, massif: 'Trois Vallées', altMin: 1450, altMax: 2952, kmPistes: 600, website: 'https://www.meribel.net' },
  { id: 'courchevel', name: 'Courchevel', lon: 6.6345, lat: 45.4150, massif: 'Trois Vallées', altMin: 1300, altMax: 3000, kmPistes: 600, website: 'https://www.courchevel.com' },
  { id: 'tignes', name: 'Tignes', lon: 6.9080, lat: 45.4685, massif: 'Espace Killy', altMin: 1550, altMax: 3456, kmPistes: 300, website: 'https://www.tignes.net' },
  { id: 'val-d-isere', name: 'Val d\'Isère', lon: 6.9805, lat: 45.4485, massif: 'Espace Killy', altMin: 1850, altMax: 3456, kmPistes: 300, website: 'https://www.valdisere.com' },
  { id: 'la-plagne', name: 'La Plagne', lon: 6.6800, lat: 45.5085, massif: 'Paradiski', altMin: 1250, altMax: 3250, kmPistes: 425, website: 'https://www.la-plagne.com' },
  { id: 'les-arcs', name: 'Les Arcs', lon: 6.8330, lat: 45.5720, massif: 'Paradiski', altMin: 810, altMax: 3226, kmPistes: 425, website: 'https://www.lesarcs.com' },
  { id: 'chamonix', name: 'Chamonix-Mont-Blanc', lon: 6.8696, lat: 45.9237, massif: 'Mont-Blanc', altMin: 1035, altMax: 3842, kmPistes: 170, website: 'https://www.chamonix.com' },
  { id: 'megeve', name: 'Megève', lon: 6.6175, lat: 45.8568, massif: 'Mont-Blanc', altMin: 1113, altMax: 2350, kmPistes: 445, website: 'https://www.megeve.com' },
  { id: 'la-clusaz', name: 'La Clusaz', lon: 6.4243, lat: 45.9043, massif: 'Aravis', altMin: 1100, altMax: 2600, kmPistes: 220, website: 'https://www.laclusaz.com' },
  { id: 'le-grand-bornand', name: 'Le Grand-Bornand', lon: 6.4290, lat: 45.9420, massif: 'Aravis', altMin: 1000, altMax: 2100, kmPistes: 90, website: 'https://www.legrandbornand.com' },
  { id: 'flaine', name: 'Flaine', lon: 6.6920, lat: 46.0010, massif: 'Grand Massif', altMin: 700, altMax: 2500, kmPistes: 265, website: 'https://www.flaine.com' },
  { id: 'avoriaz', name: 'Avoriaz', lon: 6.7770, lat: 46.1880, massif: 'Portes du Soleil', altMin: 1100, altMax: 2466, kmPistes: 650, website: 'https://www.avoriaz.com' },
  { id: 'morzine', name: 'Morzine', lon: 6.7095, lat: 46.1810, massif: 'Portes du Soleil', altMin: 1000, altMax: 2466, kmPistes: 650, website: 'https://www.morzine.com' },
  // Alpes du Sud
  { id: 'serre-chevalier', name: 'Serre Chevalier', lon: 6.5520, lat: 44.9410, massif: 'Hautes-Alpes', altMin: 1200, altMax: 2800, kmPistes: 250, website: 'https://www.serre-chevalier.com' },
  { id: 'les-deux-alpes', name: 'Les 2 Alpes', lon: 6.1240, lat: 45.0080, massif: 'Oisans', altMin: 1300, altMax: 3600, kmPistes: 200, website: 'https://www.les2alpes.com' },
  { id: 'alpe-d-huez', name: 'Alpe d\'Huez', lon: 6.0680, lat: 45.0900, massif: 'Oisans', altMin: 1250, altMax: 3330, kmPistes: 250, website: 'https://www.alpedhuez.com' },
  { id: 'isola-2000', name: 'Isola 2000', lon: 7.1380, lat: 44.1900, massif: 'Mercantour', altMin: 1810, altMax: 2610, kmPistes: 120, website: 'https://www.isola2000.com' },
  // Vosges
  { id: 'la-bresse', name: 'La Bresse-Hohneck', lon: 6.9320, lat: 48.0030, massif: 'Vosges', altMin: 900, altMax: 1350, kmPistes: 33, website: 'https://www.labresse.net' },
  { id: 'gerardmer', name: 'Gérardmer-La Mauselaine', lon: 6.8950, lat: 48.0660, massif: 'Vosges', altMin: 750, altMax: 1140, kmPistes: 40, website: 'https://www.gerardmer.net' },
  // Jura
  { id: 'metabief', name: 'Métabief', lon: 6.3490, lat: 46.7720, massif: 'Jura', altMin: 920, altMax: 1430, kmPistes: 40, website: 'https://www.station-metabief.com' },
  // Massif Central
  { id: 'le-mont-dore', name: 'Le Mont-Dore', lon: 2.8060, lat: 45.5740, massif: 'Massif Central', altMin: 1050, altMax: 1846, kmPistes: 41, website: 'https://www.sancy.com' },
  // Pyrénées
  { id: 'la-mongie', name: 'La Mongie / Grand Tourmalet', lon: 0.1850, lat: 42.9090, massif: 'Pyrénées', altMin: 1500, altMax: 2500, kmPistes: 100, website: 'https://www.grand-tourmalet.com' },
  { id: 'saint-lary', name: 'Saint-Lary-Soulan', lon: 0.3260, lat: 42.8030, massif: 'Pyrénées', altMin: 1700, altMax: 2515, kmPistes: 100, website: 'https://www.saintlary.com' },
  { id: 'cauterets', name: 'Cauterets', lon: -0.1230, lat: 42.8530, massif: 'Pyrénées', altMin: 1850, altMax: 2415, kmPistes: 36, website: 'https://www.cauterets.com' },
  { id: 'font-romeu', name: 'Font-Romeu / Pyrénées 2000', lon: 2.0560, lat: 42.5095, massif: 'Pyrénées', altMin: 1700, altMax: 2200, kmPistes: 56, website: 'https://www.font-romeu.fr' },
];
