import { Controller, Get, Inject } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DB_TOKEN, type Db } from '../db/db.module';

/**
 * V2 Hydrologie #1 (2026-05-12) — endpoint public débits rivières
 * Hub'eau Eaufrance.
 *
 *   GET /api/hubeau/recent
 *     → GeoJSON FeatureCollection des dernières obs débit (≤2h) par
 *       station, ~500 stations France par cycle (~1500 actives au total).
 *       Refresh côté frontend 60s (les obs Hub'eau arrivent toutes les
 *       ~15min).
 *
 * Pas d'auth — donnée publique gratuite Hub'eau (data.gouv.fr).
 *
 * Format Feature :
 *   geometry: Point (lon, lat)
 *   properties: { code_station, ts, age_seconds, debit_l_s, debit_m3_s, qualif }
 */
@Controller('hubeau')
export class HubeauController {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  @Get('piezo/recent')
  async piezoRecent() {
    const rows = await this.db.execute(sql`
      SELECT
        code_bss,
        ts::text AS ts,
        age_seconds,
        niveau_eau_ngf,
        profondeur_nappe,
        altitude_station,
        ST_X(geom) AS lon,
        ST_Y(geom) AS lat
      FROM v_hubeau_piezo_recent
      ORDER BY code_bss
    `);
    const features = (rows as unknown as Array<{
      code_bss: string; ts: string; age_seconds: number;
      niveau_eau_ngf: number | null; profondeur_nappe: number | null;
      altitude_station: number | null;
      lon: number; lat: number;
    }>).map((r) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [r.lon, r.lat] },
      properties: {
        code_bss: r.code_bss,
        ts: r.ts,
        age_seconds: r.age_seconds,
        niveau_eau_ngf: r.niveau_eau_ngf,
        profondeur_nappe: r.profondeur_nappe,
        altitude_station: r.altitude_station,
      },
    }));
    return { type: 'FeatureCollection' as const, features };
  }

  @Get('recent')
  async recent() {
    const rows = await this.db.execute(sql`
      SELECT
        code_station,
        ts::text AS ts,
        age_seconds,
        debit_l_s,
        debit_m3_s,
        qualif,
        ST_X(geom) AS lon,
        ST_Y(geom) AS lat
      FROM v_hubeau_recent
      ORDER BY debit_m3_s DESC NULLS LAST
    `);

    const features = (rows as unknown as Array<{
      code_station: string; ts: string; age_seconds: number;
      debit_l_s: number | null; debit_m3_s: number | null;
      qualif: string | null;
      lon: number; lat: number;
    }>).map((r) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [r.lon, r.lat] },
      properties: {
        code_station: r.code_station,
        ts: r.ts,
        age_seconds: r.age_seconds,
        debit_l_s: r.debit_l_s,
        debit_m3_s: r.debit_m3_s,
        qualif: r.qualif,
      },
    }));

    return { type: 'FeatureCollection' as const, features };
  }
}
