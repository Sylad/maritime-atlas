import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

/**
 * Plateformes vagues in-situ EMODnet Physics (sprint Europe Chantier #3,
 * remplace l'ancien référentiel CANDHIS FR-only). Layer EMODnet WFS
 * `ERD_EP_WAVES_INSITU` — ~28 plateformes bbox Europe étroite, agrégées
 * depuis les owners nationaux (CEREMA, MeteoFrance, Puertos del Estado,
 * UK Met Office, …).
 *
 * Deux endpoints WFS côté GeoServer maritime :
 *  - maritime:buoys                       → toutes les plateformes + métadonnées
 *  - maritime:v_buoy_observations_recent  → idem + dernières mesures (vide en
 *    MVP — pas d'ingest NetCDF temps réel, Chantier optionnel post-sprint).
 *
 * ⚠ La colonne PK garde son nom historique `candhis_id` côté backend (et donc
 * côté API GeoServer / frontend). Sa valeur est désormais PLATFORMCODE
 * EMODnet — c'est de la dette technique calculée pour minimiser le churn
 * (cf provisioner GeoServer + nom GeoServer maritime:buoys).
 */

export interface BuoyProperties {
  candhis_id: string;         // = EMODnet PLATFORMCODE
  name: string;               // call_name
  buoy_type: string | null;   // alias platform_type via la vue (compat legacy)
  platform_type?: string | null;
  owner?: string | null;
  country?: string | null;
  wmo?: string | null;
  parameters_group?: string | null;
  data_link?: string | null;
  last_obs_at?: string | null;
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

  /**
   * Récupère la dernière observation par plateforme dans la fenêtre
   * `[at - windowSecs, at]`. Default = 6h avant maintenant — équivalent
   * à l'ancien `WHERE ts > now() - INTERVAL '6 hours'` hardcodé dans la
   * vue (cf migration 2026-05-15-uniform-retention.sql). La vue
   * applique DISTINCT ON (candhis_id) côté SQL, le CQL_FILTER ne
   * change que la borne sup/inf scannée pour le DISTINCT ON.
   */
  fetchRecentObservations(at: Date = new Date(), windowSecs = 6 * 3600): Observable<BuoyObservationFeatureCollection> {
    const from = new Date(at.getTime() - windowSecs * 1000);
    const cql = `ts BETWEEN '${from.toISOString()}' AND '${at.toISOString()}'`;
    return this.http.get<BuoyObservationFeatureCollection>(this.wfsUrl, {
      params: {
        service: 'WFS',
        version: '2.0.0',
        request: 'GetFeature',
        typeName: 'maritime:v_buoy_observations_recent',
        outputFormat: 'application/json',
        srsName: 'EPSG:4326',
        CQL_FILTER: cql,
        count: '500',
      },
    });
  }
}
