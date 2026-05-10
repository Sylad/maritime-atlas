import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export type AlertSeverity = 'info' | 'warning' | 'danger';

export interface AlertProperties {
  id: number;
  ts: string;
  age_seconds: number;
  kind: string;            // 'lightning-proximity' | 'high-wind' | ...
  severity: AlertSeverity;
  mmsi: number | null;
  vessel_name: string | null;
  ship_type: number | null;
  detail: any;
}

export interface AlertsFeatureCollection {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    id?: string;
    properties: AlertProperties;
    geometry: { type: 'Point'; coordinates: [number, number] };
  }>;
  totalFeatures?: number;
  numberMatched?: number;
}

/**
 * Wrapper WFS pour la layer maritime:v_alerts_recent (alertes 1h).
 * Refresh poll 30s. Le frontend pourrait ouvrir un EventSource RMQ
 * via api gateway en sprint 12 si on veut du push live.
 */
@Injectable({ providedIn: 'root' })
export class AlertsService {
  private readonly http = inject(HttpClient);
  private readonly wfsUrl = '/geoserver/maritime/ows';

  readonly latestAlerts = signal<AlertProperties[]>([]);

  async refresh(): Promise<AlertsFeatureCollection> {
    const fc = await firstValueFrom(
      this.http.get<AlertsFeatureCollection>(this.wfsUrl, {
        params: {
          service: 'WFS',
          version: '2.0.0',
          request: 'GetFeature',
          typeName: 'maritime:v_alerts_recent',
          outputFormat: 'application/json',
          srsName: 'EPSG:4326',
          count: '200',
        },
      }),
    );
    // GeoServer serialise les colonnes JSONB comme STRING dans le JSON
    // de sortie. On parse côté frontend pour faciliter le binding template.
    for (const f of fc.features) {
      if (typeof f.properties.detail === 'string') {
        try { f.properties.detail = JSON.parse(f.properties.detail); }
        catch { /* keep as string */ }
      }
    }
    this.latestAlerts.set(fc.features.map((f) => f.properties));
    return fc;
  }

  clear(): void { this.latestAlerts.set([]); }
}
