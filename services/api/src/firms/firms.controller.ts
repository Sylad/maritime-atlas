import { Controller, Get, Inject, Query } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DB_TOKEN, type Db } from '../db/db.module';
import { parseAtWindow } from '../common/at-window.helper';

/**
 * V2 Observation #3 (2026-05-12) — Hotspots feux NASA FIRMS MODIS.
 *
 *   GET /api/firms/recent
 *     → GeoJSON FeatureCollection des détections de feux des dernières
 *       24h dans la bbox EU (~50-200 hotspots/cycle).
 *
 * Pas d'auth — donnée publique FIRMS (NASA Open Data).
 *
 * Format Feature :
 *   geometry: Point (lon, lat)
 *   properties: { ts, brightness, bright_t31, frp, confidence, satellite,
 *                 daynight, age_seconds }
 */
@Controller('firms')
export class FirmsController {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  @Get('recent')
  async recent(@Query('at') atIso?: string, @Query('windowSecs') windowStr?: string) {
    // 2026-05-20 cursor-aware (default 24h).
    const aw = parseAtWindow(atIso, windowStr, 86400);
    const rows = aw.at && aw.from
      ? await this.db.execute(sql`
          SELECT
            ts::text AS ts,
            EXTRACT(EPOCH FROM (${aw.at} - ts))::INTEGER AS age_seconds,
            brightness, bright_t31, frp, confidence, satellite, daynight,
            ST_X(geom) AS lon, ST_Y(geom) AS lat
          FROM (
            SELECT *, ST_SetSRID(ST_MakePoint(lon, lat), 4326) AS geom
            FROM firms_observations
            WHERE ts BETWEEN ${aw.from} AND ${aw.at}
          ) sub
          ORDER BY frp DESC NULLS LAST
        `)
      : await this.db.execute(sql`
          SELECT
            ts::text AS ts,
            age_seconds,
            brightness, bright_t31, frp, confidence, satellite, daynight,
            ST_X(geom) AS lon, ST_Y(geom) AS lat
          FROM v_firms_recent
          ORDER BY frp DESC NULLS LAST
        `);

    const features = (rows as unknown as Array<{
      ts: string; age_seconds: number;
      brightness: number | null; bright_t31: number | null;
      frp: number | null; confidence: number | null;
      satellite: string | null; daynight: string | null;
      lon: number; lat: number;
    }>).map((r) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [r.lon, r.lat] },
      properties: {
        ts: r.ts,
        age_seconds: r.age_seconds,
        brightness: r.brightness,
        bright_t31: r.bright_t31,
        frp: r.frp,
        confidence: r.confidence,
        satellite: r.satellite,
        daynight: r.daynight,
      },
    }));

    return { type: 'FeatureCollection' as const, features };
  }
}
