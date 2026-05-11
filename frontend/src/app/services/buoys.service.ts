import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

/**
 * CANDHIS (CEREMA) wave buoys — référentiel statique (~118 stations
 * France métropole + Outre-Mer) et observations les plus récentes.
 *
 * Source : https://candhis.cerema.fr/ (Licence Ouverte Etalab 2.0).
 *
 * Deux endpoints WFS :
 *  - maritime:buoys                       → tous les points (nom + id)
 *  - maritime:v_buoy_observations_recent  → idem + dernières mesures (Hm0, Tp...)
 *
 * Si CANDHIS_API_KEY est absente côté backend, v_buoy_observations_recent
 * renverra 0 features (la couche buoys est seule peuplée). Le frontend
 * sait gérer ce cas — pas d'erreur, juste pas de métrique sur le popup.
 */

export interface BuoyProperties {
  candhis_id: string;
  name: string;
  buoy_type: string | null;
  source: string | null;
}

export interface BuoyObservationProperties extends BuoyProperties {
  ts: string;
  age_seconds: number | null;
  hm0: number | null;
  h13: number | null;
  hmax: number | null;
  tp: number | null;
  th13: number | null;
  t02: number | null;
  peak_dir: number | null;
  peak_spread: number | null;
  temp_water: number | null;
}

export interface BuoyFeatureCollection {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    id?: string;
    properties: BuoyProperties;
    geometry: { type: 'Point'; coordinates: [number, number] };
  }>;
  totalFeatures?: number;
  numberMatched?: number;
  numberReturned?: number;
}

export interface BuoyObservationFeatureCollection {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    id?: string;
    properties: BuoyObservationProperties;
    geometry: { type: 'Point'; coordinates: [number, number] };
  }>;
  totalFeatures?: number;
  numberMatched?: number;
  numberReturned?: number;
}

@Injectable({ providedIn: 'root' })
export class BuoysService {
  private readonly http = inject(HttpClient);
  private readonly wfsUrl = '/geoserver/maritime/ows';

  fetchReferential(): Observable<BuoyFeatureCollection> {
    return this.http.get<BuoyFeatureCollection>(this.wfsUrl, {
      params: {
        service: 'WFS',
        version: '2.0.0',
        request: 'GetFeature',
        typeName: 'maritime:buoys',
        outputFormat: 'application/json',
        srsName: 'EPSG:4326',
        count: '500',
      },
    });
  }

  fetchRecentObservations(): Observable<BuoyObservationFeatureCollection> {
    return this.http.get<BuoyObservationFeatureCollection>(this.wfsUrl, {
      params: {
        service: 'WFS',
        version: '2.0.0',
        request: 'GetFeature',
        typeName: 'maritime:v_buoy_observations_recent',
        outputFormat: 'application/json',
        srsName: 'EPSG:4326',
        count: '500',
      },
    });
  }
}
