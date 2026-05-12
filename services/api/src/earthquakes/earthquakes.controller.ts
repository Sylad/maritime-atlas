import { Controller, Get } from '@nestjs/common';

/**
 * V2 Observation #2 (2026-05-12) — Séismes USGS Earthquakes.
 *
 * USGS expose un GeoJSON natif via leur feed public — pas besoin
 * d'ingestion DB. On fait juste un proxy avec cache mémoire 5min
 * pour éviter de spammer leur endpoint (TTL = leur refresh rate
 * environ).
 *
 *   GET /api/earthquakes/recent
 *     → GeoJSON FeatureCollection des séismes des dernières 24h
 *       (~50-200 séismes monde, on bbox EU côté frontend).
 *
 * Pas d'auth — feed USGS public. Pas de DB.
 */
@Controller('earthquakes')
export class EarthquakesController {
  /** Cache mémoire process-level. 5min TTL aligné sur le refresh
   *  côté USGS. */
  private cache: { ts: number; data: unknown } | null = null;
  private readonly CACHE_TTL_MS = 5 * 60_000;

  @Get('recent')
  async recent() {
    const now = Date.now();
    if (this.cache && now - this.cache.ts < this.CACHE_TTL_MS) {
      return this.cache.data;
    }
    try {
      const resp = await fetch(
        'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson',
        { signal: AbortSignal.timeout(15_000) },
      );
      if (!resp.ok) throw new Error(`USGS HTTP ${resp.status}`);
      const data = await resp.json();
      this.cache = { ts: now, data };
      return data;
    } catch (err) {
      // Renvoie le cache stale plutôt que rien, sinon FeatureCollection vide.
      if (this.cache) return this.cache.data;
      return { type: 'FeatureCollection', features: [], error: (err as Error).message };
    }
  }
}
