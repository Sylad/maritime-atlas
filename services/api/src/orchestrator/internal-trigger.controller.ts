import { BadRequestException, Controller, ForbiddenException, Headers, Inject, NotFoundException, Param, ParseIntPipe, Post } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DB_TOKEN, type Db } from '../db/db.module';
import { dataSources } from '../db/schema';
import { OrchestratorRunnerService } from './orchestrator-runner.service';

/**
 * G12g (2026-05-22) — trigger endpoint pour Argo Workflows.
 *
 * Pourquoi pas réutiliser /admin/orchestrator/sources/:id/trigger ?
 *   → Ce dernier est protégé par JwtAuthGuard + RolesGuard('admin'). Un
 *     workflow K8s n'a pas de JWT user.
 *
 * Pattern : header `X-Service-Token` avec valeur partagée via Secret K8s
 * `maritime-shared-env.INTERNAL_TRIGGER_TOKEN` (généré aléatoire, jamais
 * commit). Argo Workflow lit ce Secret via envFrom + envoie le header.
 *
 * Sécurité : équivalent à un Bearer statique. Acceptable pour un trigger
 * read-only qui dispatch vers le runner existant (pas d'écriture directe DB).
 * Rotation : changer la valeur dans le Secret + redéployer api + workflow.
 *
 * Route : POST /internal-trigger/sources/:id  (PAS sous /admin/* pour clarifier).
 */
@Controller('internal-trigger')
export class InternalTriggerController {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly runner: OrchestratorRunnerService,
  ) {}

  @Post('sources/:id')
  async trigger(
    @Param('id', ParseIntPipe) id: number,
    @Headers('x-service-token') token?: string,
  ) {
    const expected = process.env.INTERNAL_TRIGGER_TOKEN;
    if (!expected || expected.length < 16) {
      throw new BadRequestException('INTERNAL_TRIGGER_TOKEN not configured (>= 16 chars)');
    }
    if (token !== expected) {
      throw new ForbiddenException('Invalid X-Service-Token');
    }
    const rows = await this.db.select().from(dataSources).where(eq(dataSources.id, id));
    if (rows.length === 0) throw new NotFoundException(`Source ${id} not found`);
    const src = rows[0];
    // Fire-and-forget — runner persistera le job result dans data_jobs.
    this.runner.runOnce(src).catch(() => {
      /* errors persisted as data_jobs row by runOnce */
    });
    return { ok: true, sourceId: id, sourceName: src.name };
  }
}
