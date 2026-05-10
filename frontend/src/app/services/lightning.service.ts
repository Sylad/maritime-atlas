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
 * Wrapper WFS pour la layer maritime:v_lightning_recent (eclairs des
 * 30 dernières minutes). Refresh frontend toutes les 30s — RabbitMQ
 * topic `lightning.strike` n'est pas encore poussé vers le browser
 * (sprint 8 si on veut push live via SSE/WS).
 */
@Injectable({ providedIn: 'root' })
export class LightningService {
  private readonly http = inject(HttpClient);
  private readonly wfsUrl = '/geoserver/maritime/ows';

  fetchRecent(): Observable<LightningFeatureCollection> {
    return this.http.get<LightningFeatureCollection>(this.wfsUrl, {
      params: {
        service: 'WFS',
        version: '2.0.0',
        request: 'GetFeature',
        typeName: 'maritime:v_lightning_recent',
        outputFormat: 'application/json',
        srsName: 'EPSG:4326',
        count: '500',
      },
    });
  }
}
