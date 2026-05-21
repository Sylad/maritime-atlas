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
 * Wrapper WFS pour la layer aetherwx:v_alerts_recent.
 *
 * La view n'a plus de filtre temporel hardcodé (cf migration
 * 2026-05-15-uniform-retention.sql) : le frontend impose une fenêtre
 * `[at - windowSecs, at]` ancrée sur la time-bar via CQL_FILTER. Ça
 * permet le replay temporel (slider passé) sans bloquer GeoServer.
 */
@Injectable({ providedIn: 'root' })
export class AlertsService {
  private readonly http = inject(HttpClient);
  private readonly wfsUrl = '/geoserver/maritime/ows';

  readonly latestAlerts = signal<AlertProperties[]>([]);

  /**
   * Récupère les alertes dans la fenêtre `[at - windowSecs, at]`.
   * Default = 1h avant maintenant — équivalent à l'ancien filtre
   * `WHERE ts > now() - INTERVAL '1 hour'` qui était hardcodé dans
   * la vue SQL avant la migration time-bar.
   */
  async refresh(at: Date = new Date(), windowSecs = 3600): Promise<AlertsFeatureCollection> {
    const from = new Date(at.getTime() - windowSecs * 1000);
    const cql = `ts BETWEEN '${from.toISOString()}' AND '${at.toISOString()}'`;
    const fc = await firstValueFrom(
      this.http.get<AlertsFeatureCollection>(this.wfsUrl, {
        params: {
          service: 'WFS',
          version: '2.0.0',
          request: 'GetFeature',
          typeName: 'aetherwx:v_alerts_recent',
          outputFormat: 'application/json',
          srsName: 'EPSG:4326',
          CQL_FILTER: cql,
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
