import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

/**
 * RainViewer public API : http://api.rainviewer.com/public/weather-maps.json
 *
 * - Free, sans clé API, CORS *
 * - Couvre past 2h (frames toutes les 10 min) + future 30 min (nowcast)
 * - Tiles XYZ classiques : {host}{path}/{size}/{z}/{x}/{y}/{color}/{options}.png
 *   color: 0-8 (4 = "Original" rainbow lisible)
 *   options: {snow}_{smooth} — "1_1" = neige + smooth ON
 *
 * Résolution radar ~1km côtier, dégrade au large. Couverture mondiale,
 * idéale pour superposer aux trajectoires AIS pour voir les évitements
 * météo (cargo qui contourne une dépression, etc.).
 */
export interface RainFrame {
  /** Unix epoch en secondes (UTC). */
  time: number;
  /** Path à concaténer après host pour construire l'URL tile. */
  path: string;
}

export interface RainViewerSnapshot {
  host: string;
  past: RainFrame[];
  nowcast: RainFrame[];
  /** Sorted ascending (past + nowcast concaténés) — pratique pour binary search. */
  all: RainFrame[];
}

@Injectable({ providedIn: 'root' })
export class RainviewerService {
  private readonly http = inject(HttpClient);
  private readonly indexUrl = 'https://api.rainviewer.com/public/weather-maps.json';

  // Cache 5 min — le serveur RainViewer se met à jour toutes les 10min, pas
  // la peine de hammerer.
  private cached?: { snapshot: RainViewerSnapshot; fetchedAt: number };
  private readonly CACHE_TTL_MS = 5 * 60_000;

  async getSnapshot(): Promise<RainViewerSnapshot> {
    const now = Date.now();
    if (this.cached && now - this.cached.fetchedAt < this.CACHE_TTL_MS) {
      return this.cached.snapshot;
    }
    const raw = await firstValueFrom(
      this.http.get<{ host: string; radar: { past: RainFrame[]; nowcast: RainFrame[] } }>(this.indexUrl),
    );
    const snapshot: RainViewerSnapshot = {
      host: raw.host,
      past: raw.radar.past ?? [],
      nowcast: raw.radar.nowcast ?? [],
      all: [...(raw.radar.past ?? []), ...(raw.radar.nowcast ?? [])].sort((a, b) => a.time - b.time),
    };
    this.cached = { snapshot, fetchedAt: now };
    return snapshot;
  }

  /**
   * Trouve la frame la plus proche d'un timestamp donné (en secondes Unix).
   * Renvoie null si l'écart > 15 min — au-delà, on n'a pas de donnée pertinente
   * et on doit cacher la layer plutôt qu'afficher des tiles obsolètes.
   */
  findNearestFrame(snapshot: RainViewerSnapshot, atUnixSec: number): RainFrame | null {
    if (snapshot.all.length === 0) return null;
    let best = snapshot.all[0];
    let bestDelta = Math.abs(best.time - atUnixSec);
    for (const f of snapshot.all) {
      const d = Math.abs(f.time - atUnixSec);
      if (d < bestDelta) {
        best = f;
        bestDelta = d;
      }
    }
    return bestDelta <= 15 * 60 ? best : null;
  }

  /**
   * Construit l'URL template XYZ pour OpenLayers, paramétrée par la frame
   * choisie. Color schema 4 = "Original" (rainbow), bien lisible sur fond
   * sombre Carto. Options "1_1" = snow + smooth.
   */
  buildTileUrl(host: string, path: string, color = 4, options = '1_1', size = 256): string {
    return `${host}${path}/${size}/{z}/{x}/{y}/${color}/${options}.png`;
  }
}
