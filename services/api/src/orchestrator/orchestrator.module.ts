import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { SourcesController } from './sources.controller';
import { JobsController } from './jobs.controller';
import { PublicOrchestratorController } from './public-orchestrator.controller';
import { OrchestratorRunnerService } from './orchestrator-runner.service';

/**
 * Data Orchestrator Sprints N1 + N2 (2026-05-12).
 *
 * N1 (visibility-only) :
 *   GET    /admin/sources                  → liste les sources seedées (admin)
 *   PATCH  /admin/sources/:id              → toggle enabled (admin, back-compat)
 *   GET    /admin/jobs?source=…            → historique exécutions (admin)
 *   POST   /admin/jobs/log                 → endpoint shared-secret ingesters
 *   GET    /orchestrator/activity-24h      → aggregate public anonymisé
 *
 * N2 (dynamic execution + CRUD) :
 *   POST   /admin/sources                  → crée
 *   PUT    /admin/sources/:id              → update
 *   DELETE /admin/sources/:id              → supprime
 *   POST   /admin/sources/:id/trigger      → exécution manuelle
 *   `OrchestratorRunnerService` schedule les sources `enabled=true` avec
 *   schedule_kind défini (cron ou interval), exécute fetch→parse→sink.
 *
 * Voir `maritime_orchestrator_scope_2026_05_11.md` pour l'archi 7 sprints.
 */
@Module({
  imports: [ScheduleModule],
  controllers: [SourcesController, JobsController, PublicOrchestratorController],
  providers: [OrchestratorRunnerService],
  exports: [OrchestratorRunnerService],
})
export class OrchestratorModule {}
