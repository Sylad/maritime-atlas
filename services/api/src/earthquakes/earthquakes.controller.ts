import { Controller, Get, Inject, Query } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DB_TOKEN, type Db } from '../db/db.module';
import { parseAtWindow } from '../common/at-window.helper';

/**
 * V2 Observation #2 (2026-05-12) — Séismes USGS Earthquakes (DB-backed).
 *
 * Migration : on est passé du proxy direct cache 5min à une ingestion
 * orchestrator + DB. Avantage : visibility dans data_jobs + (à terme)
 * navigation temporelle via ?at=ISO.
 *
 *   GET /api/earthquakes/recent
 *     → GeoJSON FeatureCollection des séismes des dernières 24h.
 *
 * Pas d'auth — donnée publique USGS.
 */
@Controller('earthquakes')
export class EarthquakesController {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  @Get('recent')
  async recent(@Query('at') atIso?: string, @Query('windowSecs') windowStr?: string) {
    // 2026-05-20 cursor-aware (default 24h). Pas de DISTINCT ON, chaque
    // séisme est unique par id.
    const aw = parseAtWindow(atIso, windowStr, 86400);
    const rows = aw.at && aw.from
      ? await this.db.execute(sql`
          SELECT
            id,
            ts::text AS ts,
            EXTRACT(EPOCH FROM (${aw.at} - ts))::INTEGER AS age_seconds,
            mag, place, depth_km, alert, tsunami, sig, url, detail_url, type,
            ST_X(geom) AS lon, ST_Y(geom) AS lat
          FROM (
            SELECT *, ST_SetSRID(ST_MakePoint(lon, lat), 4326) AS geom
            FROM earthquakes
            WHERE ts BETWEEN ${aw.from} AND ${aw.at}
          ) sub
          ORDER BY mag DESC NULLS LAST
        `)
      : await this.db.execute(sql`
          SELECT
            id,
            ts::text AS ts,
            age_seconds,
            mag, place, depth_km, alert, tsunami, sig, url, detail_url, type,
            ST_X(geom) AS lon, ST_Y(geom) AS lat
          FROM v_earthquakes_recent
          ORDER BY mag DESC NULLS LAST
        `);

    const features = (rows as unknown as Array<{
      id: string; ts: string; age_seconds: number;
      mag: number | null; place: string | null; depth_km: number | null;
      alert: string | null; tsunami: number | null; sig: number | null;
      url: string | null; detail_url: string | null; type: string | null;
      lon: number; lat: number;
    }>).map((r) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [r.lon, r.lat, r.depth_km ?? 0] },
      id: r.id,
      properties: {
        mag: r.mag,
        place: r.place,
        time: new Date(r.ts).getTime(),  // epoch ms côté frontend (compat USGS)
        tsunami: r.tsunami ?? 0,
        alert: r.alert,
        sig: r.sig,
        url: r.url,
        type: r.type,
        age_seconds: r.age_seconds,
      },
    }));

    return { type: 'FeatureCollection' as const, features };
  }
}
