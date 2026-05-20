import { Controller, Get, Inject, Query } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DB_TOKEN, type Db } from '../db/db.module';
import { parseAtWindow } from '../common/at-window.helper';

/**
 * V2 Observation #1 (2026-05-12) — endpoint public METAR.
 *
 *   GET /api/metar/recent
 *     → GeoJSON FeatureCollection des dernières obs METAR (≤6h) par
 *       station, ~35 aéroports européens. Refresh côté frontend toutes
 *       les ~60s (les obs NOAA-AWC arrivent toutes les ~30min).
 *
 * Pas d'auth — c'est de la donnée publique gratuite NOAA-AWC.
 *
 * Format Feature :
 *   geometry: Point (lon, lat)
 *   properties: { icao, station_name, ts, age_seconds, temp_c, dewp_c,
 *                 wind_dir_deg, wind_speed_kt, wind_gust_kt,
 *                 altimeter_hpa, weather_str, raw }
 */
@Controller('metar')
export class MetarController {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  @Get('recent')
  async recent(@Query('at') atIso?: string, @Query('windowSecs') windowStr?: string) {
    // 2026-05-20 cursor-aware : si ?at=ISO fourni, requête custom sur la
    // table metar_observations (DISTINCT ON par icao) au lieu de la vue.
    // Sinon fallback sur v_metar_recent (mode "live" historique).
    const aw = parseAtWindow(atIso, windowStr, 21600); // 6h default

    const rows = aw.at && aw.from
      ? await this.db.execute(sql`
          SELECT DISTINCT ON (icao)
            icao, station_name,
            ts::text AS ts,
            EXTRACT(EPOCH FROM (${aw.at} - ts))::INTEGER AS age_seconds,
            temp_c, dewp_c, wind_dir_deg, wind_speed_kt, wind_gust_kt,
            altimeter_hpa, weather_str, raw,
            ST_X(geom) AS lon, ST_Y(geom) AS lat
          FROM (
            SELECT *, ST_SetSRID(ST_MakePoint(lon, lat), 4326) AS geom
            FROM metar_observations
            WHERE ts BETWEEN ${aw.from} AND ${aw.at}
          ) sub
          ORDER BY icao, ts DESC
        `)
      : await this.db.execute(sql`
          SELECT
            icao, station_name,
            ts::text AS ts,
            age_seconds,
            temp_c, dewp_c, wind_dir_deg, wind_speed_kt, wind_gust_kt,
            altimeter_hpa, weather_str, raw,
            ST_X(geom) AS lon, ST_Y(geom) AS lat
          FROM v_metar_recent
          ORDER BY icao
        `);

    const features = (rows as unknown as Array<{
      icao: string; station_name: string | null; ts: string; age_seconds: number;
      temp_c: number | null; dewp_c: number | null;
      wind_dir_deg: number | null; wind_speed_kt: number | null; wind_gust_kt: number | null;
      altimeter_hpa: number | null; weather_str: string | null; raw: string | null;
      lon: number; lat: number;
    }>).map((r) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [r.lon, r.lat] },
      properties: {
        icao: r.icao,
        station_name: r.station_name,
        ts: r.ts,
        age_seconds: r.age_seconds,
        temp_c: r.temp_c,
        dewp_c: r.dewp_c,
        wind_dir_deg: r.wind_dir_deg,
        wind_speed_kt: r.wind_speed_kt,
        wind_gust_kt: r.wind_gust_kt,
        altimeter_hpa: r.altimeter_hpa,
        weather_str: r.weather_str,
        raw: r.raw,
      },
    }));

    return { type: 'FeatureCollection' as const, features };
  }
}
