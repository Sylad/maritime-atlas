/**
 * Sprint L outdoor MVP (2026-05-20) — top plages françaises curées.
 *
 * Dataset statique : nom, coordonnées, département, type (côtière | lac),
 * URL officielle baignades.sante.gouv.fr pour la qualité eau live.
 *
 * Pour évolution : remplacer par un fetcher Hub'eau / EEA qui pull
 * dynamiquement les qualités annuelles + sites enregistrés.
 */
export interface Beach {
  id: string;
  name: string;
  lon: number;
  lat: number;
  dep: string;
  type: 'cotiere' | 'lac';
  region: string;
  qualityUrl: string;
}

const BAIGNADES_PORTAL = 'https://baignades.sante.gouv.fr/baignades/editorial/fr/cartographie/cartographie.html';

export const BEACHES: Beach[] = [
  // Méditerranée — Côte d'Azur + Provence
  { id: 'nice-promenade', name: 'Plage de Nice (Promenade des Anglais)', lon: 7.2683, lat: 43.6953, dep: '06', type: 'cotiere', region: 'Côte d\'Azur', qualityUrl: BAIGNADES_PORTAL },
  { id: 'cannes-croisette', name: 'Plage de la Croisette', lon: 7.0146, lat: 43.5476, dep: '06', type: 'cotiere', region: 'Côte d\'Azur', qualityUrl: BAIGNADES_PORTAL },
  { id: 'antibes-salis', name: 'Plage de la Salis', lon: 7.1300, lat: 43.5764, dep: '06', type: 'cotiere', region: 'Côte d\'Azur', qualityUrl: BAIGNADES_PORTAL },
  { id: 'st-tropez-pampelonne', name: 'Plage de Pampelonne', lon: 6.6655, lat: 43.2444, dep: '83', type: 'cotiere', region: 'Côte d\'Azur', qualityUrl: BAIGNADES_PORTAL },
  { id: 'cassis-arene', name: 'Plage de l\'Arène (Cassis)', lon: 5.5388, lat: 43.2152, dep: '13', type: 'cotiere', region: 'Provence', qualityUrl: BAIGNADES_PORTAL },
  { id: 'marseille-prado', name: 'Plage du Prado', lon: 5.3725, lat: 43.2575, dep: '13', type: 'cotiere', region: 'Provence', qualityUrl: BAIGNADES_PORTAL },
  { id: 'la-ciotat-mugel', name: 'Plage du Mugel (La Ciotat)', lon: 5.6021, lat: 43.1729, dep: '13', type: 'cotiere', region: 'Provence', qualityUrl: BAIGNADES_PORTAL },
  // Languedoc
  { id: 'palavas-est', name: 'Plage Est (Palavas-les-Flots)', lon: 3.9305, lat: 43.5267, dep: '34', type: 'cotiere', region: 'Languedoc', qualityUrl: BAIGNADES_PORTAL },
  { id: 'la-grande-motte', name: 'Plage du Couchant (La Grande-Motte)', lon: 4.0820, lat: 43.5645, dep: '34', type: 'cotiere', region: 'Languedoc', qualityUrl: BAIGNADES_PORTAL },
  { id: 'sete-corniche', name: 'Plage de la Corniche (Sète)', lon: 3.6730, lat: 43.3895, dep: '34', type: 'cotiere', region: 'Languedoc', qualityUrl: BAIGNADES_PORTAL },
  // Atlantique — Aquitaine
  { id: 'biarritz-grande', name: 'Grande Plage (Biarritz)', lon: -1.5613, lat: 43.4847, dep: '64', type: 'cotiere', region: 'Pays Basque', qualityUrl: BAIGNADES_PORTAL },
  { id: 'hossegor-centrale', name: 'Plage Centrale (Hossegor)', lon: -1.4350, lat: 43.6580, dep: '40', type: 'cotiere', region: 'Landes', qualityUrl: BAIGNADES_PORTAL },
  { id: 'lacanau-ocean', name: 'Plage Centrale (Lacanau-Océan)', lon: -1.2025, lat: 45.0010, dep: '33', type: 'cotiere', region: 'Gironde', qualityUrl: BAIGNADES_PORTAL },
  { id: 'arcachon-pereire', name: 'Plage Pereire (Arcachon)', lon: -1.1900, lat: 44.6700, dep: '33', type: 'cotiere', region: 'Gironde', qualityUrl: BAIGNADES_PORTAL },
  // Atlantique — Vendée + Charente
  { id: 'royan-grande-conche', name: 'Grande Conche (Royan)', lon: -1.0250, lat: 45.6260, dep: '17', type: 'cotiere', region: 'Charente-Maritime', qualityUrl: BAIGNADES_PORTAL },
  { id: 'la-rochelle-minimes', name: 'Plage des Minimes', lon: -1.1620, lat: 46.1410, dep: '17', type: 'cotiere', region: 'Charente-Maritime', qualityUrl: BAIGNADES_PORTAL },
  { id: 'sables-grande', name: 'Grande Plage (Sables-d\'Olonne)', lon: -1.7820, lat: 46.4970, dep: '85', type: 'cotiere', region: 'Vendée', qualityUrl: BAIGNADES_PORTAL },
  { id: 'noirmoutier-luzeronde', name: 'Plage de Luzeronde (Noirmoutier)', lon: -2.2685, lat: 46.9885, dep: '85', type: 'cotiere', region: 'Vendée', qualityUrl: BAIGNADES_PORTAL },
  // Bretagne
  { id: 'la-baule', name: 'Plage de La Baule', lon: -2.3870, lat: 47.2880, dep: '44', type: 'cotiere', region: 'Loire-Atlantique', qualityUrl: BAIGNADES_PORTAL },
  { id: 'carnac-grande', name: 'Grande Plage (Carnac)', lon: -3.0760, lat: 47.5780, dep: '56', type: 'cotiere', region: 'Bretagne sud', qualityUrl: BAIGNADES_PORTAL },
  { id: 'quiberon-port-maria', name: 'Plage de Port-Maria (Quiberon)', lon: -3.1230, lat: 47.4790, dep: '56', type: 'cotiere', region: 'Bretagne sud', qualityUrl: BAIGNADES_PORTAL },
  { id: 'concarneau-cabellou', name: 'Plage du Cabellou (Concarneau)', lon: -3.9230, lat: 47.8480, dep: '29', type: 'cotiere', region: 'Bretagne sud', qualityUrl: BAIGNADES_PORTAL },
  { id: 'la-torche', name: 'La Torche (Plomeur)', lon: -4.3490, lat: 47.8330, dep: '29', type: 'cotiere', region: 'Bretagne sud', qualityUrl: BAIGNADES_PORTAL },
  { id: 'crozon-morgat', name: 'Plage de Morgat (Crozon)', lon: -4.5045, lat: 48.2280, dep: '29', type: 'cotiere', region: 'Bretagne nord', qualityUrl: BAIGNADES_PORTAL },
  { id: 'perros-trestraou', name: 'Plage de Trestraou (Perros-Guirec)', lon: -3.4490, lat: 48.8205, dep: '22', type: 'cotiere', region: 'Côtes d\'Armor', qualityUrl: BAIGNADES_PORTAL },
  { id: 'st-malo-sillon', name: 'Plage du Sillon (Saint-Malo)', lon: -2.0290, lat: 48.6505, dep: '35', type: 'cotiere', region: 'Bretagne nord', qualityUrl: BAIGNADES_PORTAL },
  // Normandie + Hauts-de-France
  { id: 'deauville', name: 'Plage de Deauville', lon: 0.0735, lat: 49.3580, dep: '14', type: 'cotiere', region: 'Normandie', qualityUrl: BAIGNADES_PORTAL },
  { id: 'cabourg', name: 'Plage de Cabourg', lon: -0.1320, lat: 49.2860, dep: '14', type: 'cotiere', region: 'Normandie', qualityUrl: BAIGNADES_PORTAL },
  { id: 'le-touquet', name: 'Plage du Touquet', lon: 1.5800, lat: 50.5240, dep: '62', type: 'cotiere', region: 'Hauts-de-France', qualityUrl: BAIGNADES_PORTAL },
  { id: 'wimereux', name: 'Plage de Wimereux', lon: 1.6080, lat: 50.7665, dep: '62', type: 'cotiere', region: 'Hauts-de-France', qualityUrl: BAIGNADES_PORTAL },
  // Corse
  { id: 'palombaggia', name: 'Plage de Palombaggia', lon: 9.3290, lat: 41.5640, dep: '2A', type: 'cotiere', region: 'Corse', qualityUrl: BAIGNADES_PORTAL },
  { id: 'rondinara', name: 'Plage de Rondinara', lon: 9.2820, lat: 41.5060, dep: '2A', type: 'cotiere', region: 'Corse', qualityUrl: BAIGNADES_PORTAL },
  { id: 'calvi', name: 'Plage de Calvi', lon: 8.7610, lat: 42.5640, dep: '2B', type: 'cotiere', region: 'Corse', qualityUrl: BAIGNADES_PORTAL },
  // Lacs majeurs
  { id: 'annecy-imperial', name: 'Plage Impérial (Annecy)', lon: 6.1490, lat: 45.9145, dep: '74', type: 'lac', region: 'Lac d\'Annecy', qualityUrl: BAIGNADES_PORTAL },
  { id: 'aix-bains', name: 'Plage Municipale (Aix-les-Bains)', lon: 5.8855, lat: 45.6920, dep: '73', type: 'lac', region: 'Lac du Bourget', qualityUrl: BAIGNADES_PORTAL },
  { id: 'leman-thonon', name: 'Plage de Thonon (Léman)', lon: 6.4830, lat: 46.3735, dep: '74', type: 'lac', region: 'Lac Léman', qualityUrl: BAIGNADES_PORTAL },
  { id: 'sanguinet', name: 'Lac de Sanguinet', lon: -1.0830, lat: 44.4860, dep: '40', type: 'lac', region: 'Landes', qualityUrl: BAIGNADES_PORTAL },
];
