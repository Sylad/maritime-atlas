import { Module } from '@nestjs/common';
import { HubeauController } from './hubeau.controller';

/**
 * V2 Hydrologie #1 — débits rivières Hub'eau France.
 * Données ingérées par l'orchestrator dynamique (source `hubeau-debits-fr`,
 * cron 15min, Hub'eau API → table hubeau_observations). Ce module n'expose
 * que l'endpoint lecture pour le frontend.
 */
@Module({
  controllers: [HubeauController],
})
export class HubeauModule {}
