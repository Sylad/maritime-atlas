import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

/**
 * Properties exposées par la SQL view v_vessels_live (cf db/init/02-views.sql).
 * Le srid 4326 est imposé via param srsName de la requête WFS.
 */
export interface VesselProperties {
  mmsi: number;
  name: string | null;
  callsign: string | null;
  ship_type: number | null;
  flag: string | null;
  length_m: number | null;
  width_m: number | null;
  destination: string | null;
  last_seen: string;             // ISO timestamp
}

/** GeoJSON FeatureCollection typé pour vessels. */
export interface VesselsFeatureCollection {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    id?: string;
    properties: VesselProperties;
    geometry: { type: 'Point'; coordinates: [number, number] };
  }>;
  totalFeatures: number;
  numberMatched: number;
  numberReturned: number;
  timeStamp: string;
}

/**
 * Wrapper WFS GeoServer pour la couche maritime:v_vessels_live.
 * En dev nginx proxy /geoserver/* → http://geoserver:8080/geoserver/* —
 * pas besoin de gérer CORS côté front, et la conf est portée par le
 * reverse proxy nginx.
 */
@Injectable({ providedIn: 'root' })
export class VesselsService {
  private readonly http = inject(HttpClient);
  private readonly wfsUrl = '/geoserver/maritime/ows';

  fetchLiveVessels(): Observable<VesselsFeatureCollection> {
    return this.http.get<VesselsFeatureCollection>(this.wfsUrl, {
      params: {
        service: 'WFS',
        version: '2.0.0',
        request: 'GetFeature',
        typeName: 'maritime:v_vessels_live',
        outputFormat: 'application/json',
        srsName: 'EPSG:4326',
      },
    });
  }
}
