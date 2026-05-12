import { Module } from '@nestjs/common';
import { MetarController } from './metar.controller';

/**
 * V2 Observation #1 — METAR observations.
 * Données ingérées par l'orchestrator dynamique (source `metar-fetcher-eu`,
 * cron 30min, NOAA AWC JSON → table metar_observations). Ce module n'expose
 * que l'endpoint lecture pour le frontend.
 */
@Module({
  controllers: [MetarController],
})
export class MetarModule {}
