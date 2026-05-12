import { Module } from '@nestjs/common';
import { SourcesController } from './sources.controller';
import { JobsController } from './jobs.controller';
import { PublicOrchestratorController } from './public-orchestrator.controller';

/**
 * Data Orchestrator MVP Sprint 1 (2026-05-12) — visibility-only.
 *
 *   GET    /admin/sources                  → liste les sources seedées (admin)
 *   PATCH  /admin/sources/:id              → toggle enabled (admin)
 *   GET    /admin/jobs?source=…            → historique exécutions (admin)
 *   POST   /admin/jobs/log                 → endpoint shared-secret ingesters
 *   GET    /orchestrator/activity-24h      → aggregate public anonymisé
 *
 * Voir `maritime_orchestrator_scope_2026_05_11.md` pour l'archi 7 sprints.
 */
@Module({
  controllers: [SourcesController, JobsController, PublicOrchestratorController],
})
export class OrchestratorModule {}
