import { Controller, Get, Inject } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DB_TOKEN, type Db } from '../db/db.module';

/**
 * Endpoints orchestrator public (pas d'auth, anonymisés). Sert à afficher
 * un mini-graph "santé ingestion" sur la map pour donner un signal de
 * vitalité aux visiteurs anonymes.
 *
 *   GET /api/orchestrator/activity-24h
 *     → [{ hour: 0..23, total: N, ok: N, error: N }, …]
 *     hour 0 = la dernière heure complète révolue (heure courante non
 *     incluse pour éviter les buckets partiels).
 */
@Controller('orchestrator')
export class PublicOrchestratorController {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  @Get('activity-24h')
  async activity24h() {
    // Agrégation côté Postgres par bucket d'1h sur les 24h écoulées.
    // Utilise date_trunc + EXTRACT pour calculer l'âge en heures.
    // Buckets vides ne sont pas dans le résultat brut → on remplit
    // côté JS pour garantir 24 entries continues.
    const rows = await this.db.execute(sql`
      SELECT
        EXTRACT(EPOCH FROM (date_trunc('hour', now()) - date_trunc('hour', started_at)))::int / 3600 AS hour_ago,
        COUNT(*)::int AS total,
        SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END)::int AS ok,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END)::int AS error
      FROM data_jobs
      WHERE started_at > now() - INTERVAL '25 hours'
        AND started_at < date_trunc('hour', now())
      GROUP BY hour_ago
      ORDER BY hour_ago
    `);

    const byHour = new Map<number, { total: number; ok: number; error: number }>();
    for (const r of rows as unknown as Array<{ hour_ago: number; total: number; ok: number; error: number }>) {
      byHour.set(r.hour_ago, { total: r.total, ok: r.ok, error: r.error });
    }
    const out: Array<{ hour: number; total: number; ok: number; error: number }> = [];
    for (let h = 0; h < 24; h++) {
      const b = byHour.get(h) ?? { total: 0, ok: 0, error: 0 };
      out.push({ hour: h, ...b });
    }
    return out;
  }
}
