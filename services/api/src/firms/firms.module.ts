import { Module } from '@nestjs/common';
import { FirmsController } from './firms.controller';

/**
 * V2 Observation #3 — Hotspots feux NASA FIRMS MODIS.
 * Données ingérées par orchestrator (source `firms-modis-eu`,
 * cron 1h, CSV → table firms_observations).
 */
@Module({
  controllers: [FirmsController],
})
export class FirmsModule {}
