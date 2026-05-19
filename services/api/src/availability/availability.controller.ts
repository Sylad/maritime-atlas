import {
  Controller,
  Get,
  Inject,
  Param,
  Query,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DB_TOKEN, type Db } from '../db/db.module';

/**
 * APEX 14 (2026-05-19) — endpoint public pour récupérer la VRAIE présence
 * de données par layer vector, agrégée en bins temporels. Le frontend
 * utilise ça pour rendre des markers data presence dans la time-bar
 * étendue (chaque rangée vector) au lieu de la cadence supposée
 * `refreshIntervalMin`.
 *
 *   GET /api/availability/:layerKey?from=ISO&to=ISO&bin=300
 *     → JSON `{ bins: [{ t: epoch_seconds, count: int }, ...] }`
 *
 * `bin` = taille du bucket en secondes (default 300 = 5 min). `from`/`to`
 * en ISO 8601 (UTC). Pas d'auth — c'est du métadata publique.
 *
 * Sans TimescaleDB on bucket via `floor(extract(epoch from ts) / bin) * bin`
 * + group by — performant si index sur ts (présent sur toutes les tables
 * concernées via clé primary ou index dédié).
 */
type LayerTableConfig = { table: string; tsCol: string };

const LAYER_TABLES: Record<string, LayerTableConfig> = {
  lightning: { table: 'lightning_strikes',    tsCol: 'ts' },
  metar:     { table: 'metar_observations',   tsCol: 'ts' },
  hubeau:    { table: 'hubeau_observations',  tsCol: 'ts' },
  piezo:     { table: 'hubeau_piezo',         tsCol: 'ts' },
  quakes:    { table: 'earthquakes',          tsCol: 'ts' },
  firms:     { table: 'firms_observations',   tsCol: 'ts' },
  buoys:     { table: 'buoy_observations',    tsCol: 'ts' },
  alerts:    { table: 'alerts',               tsCol: 'ts' },
  vessels:   { table: 'vessel_positions',     tsCol: 'ts' },
};

@Controller('availability')
export class AvailabilityController {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  @Get(':layerKey')
  async getBins(
    @Param('layerKey') layerKey: string,
    @Query('from') fromIso?: string,
    @Query('to') toIso?: string,
    @Query('bin') binStr?: string,
  ): Promise<{ bins: Array<{ t: number; count: number }> }> {
    const cfg = LAYER_TABLES[layerKey];
    if (!cfg) {
      throw new HttpException(
        `Unknown layerKey: ${layerKey}. Valid: ${Object.keys(LAYER_TABLES).join(',')}`,
        HttpStatus.NOT_FOUND,
      );
    }
    // Window default = last 7d. Bin default = 300s (5 min).
    const now = Date.now();
    const from = fromIso ? new Date(fromIso) : new Date(now - 7 * 86_400_000);
    const to = toIso ? new Date(toIso) : new Date(now);
    const bin = Math.max(60, Math.min(86_400, Number(binStr) || 300));

    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      throw new HttpException('Invalid from/to ISO date', HttpStatus.BAD_REQUEST);
    }
    if (to.getTime() <= from.getTime()) {
      return { bins: [] };
    }

    // Postgres-pur bucket : floor(epoch / bin) * bin → bin start timestamp.
    // sql.raw nécessaire pour interpoler le nom de table + colonne (validés
    // côté LAYER_TABLES, pas d'input user direct).
    const rows = await this.db.execute(
      sql`
        SELECT
          (floor(extract(epoch from ${sql.raw(cfg.tsCol)}) / ${bin}) * ${bin})::bigint AS bin_t,
          count(*)::int AS cnt
        FROM ${sql.raw(cfg.table)}
        WHERE ${sql.raw(cfg.tsCol)} >= ${from.toISOString()}::timestamptz
          AND ${sql.raw(cfg.tsCol)} <  ${to.toISOString()}::timestamptz
        GROUP BY bin_t
        ORDER BY bin_t ASC
      `,
    );

    const bins = (rows as unknown as Array<{ bin_t: string | number; cnt: number }>).map(
      (r) => ({ t: Number(r.bin_t), count: Number(r.cnt) }),
    );
    return { bins };
  }
}
