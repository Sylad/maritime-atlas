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
   * Trouve la frame la plus récente <= atUnixSec, avec fallback sur la
   * plus ancienne disponible si rien dans le passé du cursor.
   *
   * Rationale : le user attend que le slider montre "le dernier état connu
   * jusqu'à cet instant" — pas un forecast nowcast s'il existe. Sinon en
   * mode REPLAY on verrait jamais l'archive si le cursor est entre deux frames.
   *
   * Renvoie null si l'écart entre la frame retenue et le cursor > 30 min
   * (au-delà = la layer perd son sens).
   */
  findNearestFrame(snapshot: RainViewerSnapshot, atUnixSec: number): RainFrame | null {
    if (snapshot.all.length === 0) return null;
    // Take the latest frame with time <= cursor
    const eligible = snapshot.all.filter(f => f.time <= atUnixSec);
    let chosen: RainFrame;
    if (eligible.length > 0) {
      chosen = eligible[eligible.length - 1]; // déjà sorted ascending
    } else {
      // Cursor avant la plus ancienne frame — on prend la plus ancienne quand même
      chosen = snapshot.all[0];
    }
    const delta = Math.abs(chosen.time - atUnixSec);
    return delta <= 30 * 60 ? chosen : null;
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
