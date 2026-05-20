import { Controller, Get } from '@nestjs/common';
import { BEACHES, type Beach } from './beaches.data';
import { SKI_STATIONS, type SkiStation } from './ski-stations.data';

/**
 * Sprint L outdoor MVP (2026-05-20) — endpoints publics plages + stations ski.
 *
 *   GET /api/outdoor/beaches.geojson       → 37 plages françaises curées (côtières + lacs)
 *   GET /api/outdoor/ski-stations.geojson  → 26 stations ski (Alpes + Pyrénées + Vosges + Jura + Massif Central)
 *
 * Dataset statique pour l'instant. La qualité eau live + neige live seront
 * ajoutées dans une phase suivante via Hub'Eau / OpenSnowMap / ANENA BERA.
 * Les popups embarquent un lien vers les portails officiels.
 *
 * Pas d'auth — c'est de la donnée publique curée.
 */
@Controller('outdoor')
export class OutdoorController {
  @Get('beaches.geojson')
  beaches() {
    return {
      type: 'FeatureCollection' as const,
      features: BEACHES.map(toBeachFeature),
    };
  }

  @Get('ski-stations.geojson')
  skiStations() {
    return {
      type: 'FeatureCollection' as const,
      features: SKI_STATIONS.map(toSkiFeature),
    };
  }
}

function toBeachFeature(b: Beach) {
  return {
    type: 'Feature' as const,
    geometry: { type: 'Point' as const, coordinates: [b.lon, b.lat] },
    properties: {
      id: b.id,
      name: b.name,
      dep: b.dep,
      type: b.type,
      region: b.region,
      qualityUrl: b.qualityUrl,
    },
  };
}

function toSkiFeature(s: SkiStation) {
  return {
    type: 'Feature' as const,
    geometry: { type: 'Point' as const, coordinates: [s.lon, s.lat] },
    properties: {
      id: s.id,
      name: s.name,
      massif: s.massif,
      altMin: s.altMin,
      altMax: s.altMax,
      kmPistes: s.kmPistes,
      website: s.website,
    },
  };
}
