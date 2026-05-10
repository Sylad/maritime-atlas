import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

/**
 * Manifest publié par weather-fetcher (GFS) + weather-fetcher-arome (AROME).
 * Chaque source liste les timestamps GeoJSON dispos. `arome` ajouté en
 * sprint 11 (modèle haute-résolution Météo-France 0.025°).
 */
export interface ArrowsManifest {
  wind: string[];      // GFS 10m wind — 'YYYYMMDDTHHMMSSZ' compact
  wave: string[];      // WW3 primary wave dir
  arome?: string[];    // AROME 10m wind (Météo-France) — optionnel (peut être
                       // absent au boot si weather-fetcher-arome n'a pas
                       // encore tourné, ou si volume séparé). Le frontend
                       // dégrade gracieusement (fallback GFS).
  patterns: { wind: string; wave: string; arome?: string };
  updated_at: string;
}

// 'wind' = GFS (NOAA, fichiers wind_arrows_*.geojson)
// 'arome' = AROME (Météo-France, fichiers arome_wind_arrows_*.geojson)
// 'wave' = WW3 (NOAA, wave_arrows_*.geojson)
export type ArrowsKind = 'wind' | 'wave' | 'arome';

export interface WindArrowFeature {
  speed: number;       // m/s
  dirTo: number;       // compass degrees, where wind goes TO (0=N, 90=E)
  dirFrom: number;
}

export interface WaveArrowFeature {
  hs: number;          // significant height (m)
  dirTo: number;
  dirFrom: number;
}

/** Minimal GeoJSON FC pour notre cas (sans @types/geojson). */
export interface ArrowsFeatureCollection {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    geometry: { type: 'Point'; coordinates: [number, number] };
    properties: WindArrowFeature | WaveArrowFeature;
  }>;
  properties?: { valid_time?: string; forecast_run?: string; sampling?: string };
}

/**
 * Sert le manifest + résolveur "ts le plus proche du cursor". Cache local
 * (signal-based) pour ne pas re-hammer nginx à chaque tick du slider.
 */
@Injectable({ providedIn: 'root' })
export class ArrowsService {
  private readonly http = inject(HttpClient);
  private manifestCache?: { manifest: ArrowsManifest; fetchedAt: number };
  private readonly CACHE_TTL_MS = 5 * 60_000;

  readonly lastErrorMsg = signal<string | null>(null);

  async getManifest(): Promise<ArrowsManifest | null> {
    const now = Date.now();
    if (this.manifestCache && now - this.manifestCache.fetchedAt < this.CACHE_TTL_MS) {
      return this.manifestCache.manifest;
    }
    try {
      const m = await firstValueFrom(this.http.get<ArrowsManifest>('/wind-arrows/manifest.json'));
      this.manifestCache = { manifest: m, fetchedAt: now };
      this.lastErrorMsg.set(null);
      return m;
    } catch (err: any) {
      this.lastErrorMsg.set(err?.message ?? 'manifest indispo');
      return null;
    }
  }

  /** Trouve le ts compact le plus proche d'un cursor (Date). Retourne null si > 12h d'écart. */
  findNearestTs(timestamps: string[], cursor: Date): string | null {
    if (timestamps.length === 0) return null;
    const target = cursor.getTime();
    let best = timestamps[0];
    let bestDelta = Math.abs(this.parseTs(best).getTime() - target);
    for (const ts of timestamps) {
      const d = Math.abs(this.parseTs(ts).getTime() - target);
      if (d < bestDelta) { best = ts; bestDelta = d; }
    }
    return bestDelta <= 12 * 3600_000 ? best : null;
  }

  /** GeoJSON pour un kind (wind|wave|arome) à un ts donné. AROME utilise un
   *  préfixe arome_wind_arrows_ (volume partagé avec GFS, on évite la collision
   *  en disambiguisant côté nom de fichier). */
  fetchArrows(kind: ArrowsKind, ts: string): Promise<ArrowsFeatureCollection> {
    const url = kind === 'arome'
      ? `/wind-arrows/arome_wind_arrows_${ts}.geojson`
      : `/wind-arrows/${kind}_arrows_${ts}.geojson`;
    return firstValueFrom(this.http.get<ArrowsFeatureCollection>(url));
  }

  /** Parse un ts compact YYYYMMDDTHHMMSSZ en Date UTC. */
  private parseTs(ts: string): Date {
    // 20260510T120000Z → 2026-05-10T12:00:00Z
    const iso = `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T${ts.slice(9, 11)}:${ts.slice(11, 13)}:${ts.slice(13, 15)}Z`;
    return new Date(iso);
  }
}
