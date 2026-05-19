import { Module } from '@nestjs/common';
import { AvailabilityController } from './availability.controller';

/**
 * APEX 14 (2026-05-19) — Availability bins endpoint.
 * Lectures-seule, no auth. Données dérivées des tables des vector layers
 * (lightning_strikes, metar_observations, etc.) bucketées en intervalles
 * temporels pour rendre des markers data presence dans la time-bar.
 */
@Module({
  controllers: [AvailabilityController],
})
export class AvailabilityModule {}
