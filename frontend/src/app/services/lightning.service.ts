import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

export interface LightningProperties {
  ts: string;            // ISO timestamp
  ts_epoch: number;      // epoch seconds (used as feature id)
  age_seconds: number;
  alt: number | null;
  mcg: number | null;
  pol: number | null;
}

export interface LightningFeatureCollection {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    id?: string;
    properties: LightningProperties;
    geometry: { type: 'Point'; coordinates: [number, number] };
  }>;
  totalFeatures?: number;
  numberMatched?: number;
  numberReturned?: number;
}

/**
 * Wrapper WFS pour la layer maritime:v_lightning_recent.
 *
 * La view n'a plus de filtre temporel hardcodé (cf migration
 * 2026-05-15-uniform-retention.sql) : le frontend impose une fenêtre
 * `[at - windowSecs, at]` ancrée sur la time-bar via CQL_FILTER. Permet
 * le replay temporel (slider passé) sans bloquer GeoServer.
 */
@Injectable({ providedIn: 'root' })
export class LightningService {
  private readonly http = inject(HttpClient);
  private readonly wfsUrl = '/geoserver/maritime/ows';

  /**
   * Récupère les strikes dans la fenêtre `[at - windowSecs, at]`.
   * Default = 30 min avant maintenant — équivalent à l'ancien
   * `WHERE ts > now() - INTERVAL '30 minutes'` hardcodé dans la vue.
   */
  fetchRecent(at: Date = new Date(), windowSecs = 1800): Observable<LightningFeatureCollection> {
    const from = new Date(at.getTime() - windowSecs * 1000);
    const cql = `ts BETWEEN '${from.toISOString()}' AND '${at.toISOString()}'`;
    return this.http.get<LightningFeatureCollection>(this.wfsUrl, {
      params: {
        service: 'WFS',
        version: '2.0.0',
        request: 'GetFeature',
        typeName: 'maritime:v_lightning_recent',
        outputFormat: 'application/json',
        srsName: 'EPSG:4326',
        CQL_FILTER: cql,
        count: '500',
      },
    });
  }
}
