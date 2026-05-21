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

/** GeoJSON FeatureCollection typé pour tracks daily (LineStrings). */
export interface TrackProperties {
  mmsi: number;
  day: string;          // ISO date YYYY-MM-DD
  points_n: number;
}
export interface TracksFeatureCollection {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    id?: string;
    properties: TrackProperties;
    geometry: { type: 'LineString'; coordinates: [number, number][] };
  }>;
  totalFeatures: number;
  numberMatched: number;
  numberReturned: number;
}

/**
 * Wrapper WFS GeoServer pour les couches :
 *   - aetherwx:v_vessels_live → positions live (last 15 min)
 *   - aetherwx:vessel_tracks_daily → tracks aggregés par jour (LineStrings)
 *
 * En dev nginx proxy /geoserver/* → http://geoserver:8080/geoserver/* —
 * pas besoin de gérer CORS côté front, conf portée par le reverse proxy.
 */
@Injectable({ providedIn: 'root' })
export class VesselsService {
  private readonly http = inject(HttpClient);
  private readonly wfsUrl = '/geoserver/maritime/ows';

  /**
   * Positions live filtrées sur les `windowSecs` dernières secondes avant `at`
   * (default : 15 min avant maintenant). Le CQL_FILTER côté WFS borne le volume
   * pour éviter le OOM GeoServer quand la table contient bcp de vessels actifs
   * récents (e.g. v_vessels_live alterée en prod pour fenêtre 24h → 20k+ rows).
   *
   * `at` permet d'aligner sur la barre de temps : en mode replay, le live-loop
   * peut demander la fenêtre [t-15min, t] correspondant à la date sélectionnée
   * plutôt que la fenêtre fixe DB-side.
   */
  fetchLiveVessels(at: Date = new Date(), windowSecs = 900): Observable<VesselsFeatureCollection> {
    const from = new Date(at.getTime() - windowSecs * 1000);
    const cql = `last_seen BETWEEN '${from.toISOString()}' AND '${at.toISOString()}'`;
    return this.http.get<VesselsFeatureCollection>(this.wfsUrl, {
      params: {
        service: 'WFS',
        version: '2.0.0',
        request: 'GetFeature',
        typeName: 'aetherwx:v_vessels_live',
        outputFormat: 'application/json',
        srsName: 'EPSG:4326',
        CQL_FILTER: cql,
        count: '5000',
      },
    });
  }

  /**
   * Replay temporel : positions des navires à un instant T donné, avec une
   * fenêtre `windowSecs` autour. Implémenté côté GeoServer via SQL view
   * paramétrable `vessels_at_time` (DISTINCT ON mmsi + ORDER BY ts DESC) —
   * cf geoserver/provision.sh. Garantit 1 position par MMSI = la dernière
   * connue dans [T-window, T+window].
   *
   * Cap à 5000 features (suffisant pour France métro où on tourne autour de
   * 1500-3000 navires actifs simultanés).
   */
  fetchVesselsAtTime(at: Date, windowSecs = 300): Observable<VesselsFeatureCollection> {
    return this.http.get<VesselsFeatureCollection>(this.wfsUrl, {
      params: {
        service: 'WFS',
        version: '2.0.0',
        request: 'GetFeature',
        typeName: 'aetherwx:vessels_at_time',
        outputFormat: 'application/json',
        srsName: 'EPSG:4326',
        viewparams: `at:${at.toISOString()};window:${windowSecs}`,
        count: '5000',
      },
    });
  }

  /**
   * Tracks d'un jour donné via CQL_FILTER. L'index (mmsi, day) sur
   * vessel_tracks_daily fait que la requête est instantanée même sur
   * 100 jours d'historique. Cap à 5000 features pour éviter le DOM
   * choke (5000 LineStrings de quelques dizaines de points = OK).
   */
  fetchTracksForDay(day: string): Observable<TracksFeatureCollection> {
    return this.http.get<TracksFeatureCollection>(this.wfsUrl, {
      params: {
        service: 'WFS',
        version: '2.0.0',
        request: 'GetFeature',
        typeName: 'aetherwx:vessel_tracks_daily',
        outputFormat: 'application/json',
        srsName: 'EPSG:4326',
        CQL_FILTER: `day='${day}'`,
        count: '5000',
      },
    });
  }
}
