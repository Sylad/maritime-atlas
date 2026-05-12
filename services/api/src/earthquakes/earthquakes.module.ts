import { Module } from '@nestjs/common';
import { EarthquakesController } from './earthquakes.controller';

/**
 * V2 Observation #2 — Séismes USGS Earthquakes.
 * Pas d'ingestion DB, juste un proxy avec cache 5min vers le feed
 * USGS public (déjà GeoJSON natif).
 */
@Module({
  controllers: [EarthquakesController],
})
export class EarthquakesModule {}
