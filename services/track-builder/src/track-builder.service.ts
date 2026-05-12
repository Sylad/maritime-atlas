import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PgService } from './pg.service';

/**
 * Data Orchestrator MVP S1 — heartbeat client. Silent fail si l'orchestrator
 * est down (mode standalone si ORCHESTRATOR_JOB_TOKEN non set).
 */
const ORCH_API = process.env.ORCHESTRATOR_API ?? 'http://api:3010';
const ORCH_TOKEN = process.env.ORCHESTRATOR_JOB_TOKEN ?? '';
const ORCH_SOURCE = process.env.ORCHESTRATOR_SOURCE_NAME ?? 'track-builder';

async function reportJob(payload: {
  status: 'ok' | 'partial' | 'error';
  startedAt: Date;
  recordsOut?: number;
  durationMs?: number;
  errorKind?: string;
  errorMsg?: string;
  meta?: Record<string, unknown>;
}): Promise<void> {
  if (!ORCH_TOKEN) return;
  try {
    await fetch(`${ORCH_API}/admin/jobs/log`, {
      method: 'POST',
      headers: { 'X-Job-Token': ORCH_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceName: ORCH_SOURCE,
        status: payload.status,
        startedAt: payload.startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: payload.durationMs,
        recordsOut: payload.recordsOut,
        errorKind: payload.errorKind,
        errorMsg: payload.errorMsg,
        meta: payload.meta,
      }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // silent fail — pas de raison de bloquer le cycle métier
  }
}

/**
 * track-builder — agrège les positions (hypertable) en LineStrings
 * journalières dans `vessel_tracks_daily`.
 *
 * Pourquoi : `vessel_positions` peut compter des millions de lignes,
 * scanner pour servir une trace à la map prend des secondes. Une vue
 * pré-aggregée par (mmsi, day) → 1 LineString par vessel-jour permet
 * de servir le WFS instantanément (filtre `day = ...`).
 *
 * Stratégie :
 *   - Cron horaire (00:35 chaque heure) pour rattraper les retards et
 *     mettre à jour le LineString du jour courant en continu.
 *   - Re-aggregate les 25 dernières heures (slack pour rattraper les
 *     positions reçues en retard depuis aisstream.io).
 *   - GROUP BY mmsi + day, ST_MakeLine(geom ORDER BY ts).
 *   - INSERT … ON CONFLICT (mmsi, day) DO UPDATE SET geom = …
 *   - Skip les vessels < 2 positions (LineString impossible).
 *
 * Au boot : run une fois immédiatement pour avoir des tracks dispos
 * sans attendre le prochain trigger cron.
 */
@Injectable()
export class TrackBuilderService implements OnModuleInit {
  private readonly logger = new Logger(TrackBuilderService.name);
  private running = false;

  constructor(private readonly pg: PgService) {}

  async onModuleInit(): Promise<void> {
    // Run immédiat au boot — aggregate ce qui existe déjà.
    setTimeout(() => this.aggregate(), 5000);
  }

  /** Cron à xx:35 chaque heure — décalage volontaire pour éviter les minutes
   *  rondes où d'autres jobs (TimescaleDB compression, retention) tournent. */
  @Cron('0 35 * * * *', { name: 'aggregate-tracks' })
  async scheduledAggregate(): Promise<void> {
    await this.aggregate();
  }

  private async aggregate(): Promise<void> {
    if (this.running) {
      this.logger.warn('Aggregation already running, skipping this trigger');
      return;
    }
    this.running = true;
    const t0 = Date.now();
    const startedAt = new Date(t0);

    try {
      // Ré-agrège tous les jours touchés par les positions des dernières 25h.
      // Le ON CONFLICT update évite les doublons et permet le rattrapage.
      const sql = `
        WITH days_to_rebuild AS (
          SELECT DISTINCT (ts AT TIME ZONE 'UTC')::date AS day
          FROM vessel_positions
          WHERE ts > now() - interval '25 hours'
        ),
        aggregated AS (
          SELECT
            p.mmsi,
            (p.ts AT TIME ZONE 'UTC')::date AS day,
            ST_MakeLine(p.geom::geometry ORDER BY p.ts) AS geom,
            count(*) AS points_n
          FROM vessel_positions p
          JOIN days_to_rebuild d ON (p.ts AT TIME ZONE 'UTC')::date = d.day
          GROUP BY p.mmsi, (p.ts AT TIME ZONE 'UTC')::date
          HAVING count(*) >= 2
        )
        INSERT INTO vessel_tracks_daily (mmsi, day, geom, points_n)
        SELECT mmsi, day, geom, points_n FROM aggregated
        ON CONFLICT (mmsi, day) DO UPDATE
          SET geom = EXCLUDED.geom,
              points_n = EXCLUDED.points_n
        RETURNING mmsi, day, points_n;
      `;
      const result = await this.pg.pool.query(sql);
      const dt = Date.now() - t0;
      const rows = result.rowCount ?? 0;
      this.logger.log(`Aggregated ${rows} tracks in ${dt}ms`);
      await reportJob({ status: 'ok', startedAt, recordsOut: rows, durationMs: dt });
    } catch (err) {
      const e = err as Error;
      this.logger.error(`Aggregation failed: ${e.message}`, e.stack);
      await reportJob({
        status: 'error', startedAt,
        durationMs: Date.now() - t0,
        errorKind: e.name, errorMsg: e.message.slice(0, 500),
      });
    } finally {
      this.running = false;
    }
  }
}
