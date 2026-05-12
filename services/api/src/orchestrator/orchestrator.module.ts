import { Module } from '@nestjs/common';
import { SourcesController } from './sources.controller';
import { JobsController } from './jobs.controller';

/**
 * Data Orchestrator MVP Sprint 1 (2026-05-12) — visibility-only.
 *
 *   GET    /admin/sources          → liste les 6 sources seedées (+ derniers status)
 *   PATCH  /admin/sources/:id      → toggle `enabled` (prépare Sprint N2)
 *   GET    /admin/jobs?source=…    → historique exécutions (filtrable)
 *   POST   /admin/jobs/log         → endpoint shared-secret pour les ingesters
 *
 * Voir `maritime_orchestrator_scope_2026_05_11.md` pour l'archi 7 sprints.
 */
@Module({
  controllers: [SourcesController, JobsController],
})
export class OrchestratorModule {}
