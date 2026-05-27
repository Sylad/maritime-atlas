import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { GlofasController } from './glofas.controller';
import { GlofasService } from './glofas.service';

/**
 * Task 11 — GET /api/glofas/timeseries?lon=X&lat=Y
 * Queries GeoServer WMS GetFeatureInfo on the 3 glofas-flood-prob-{q5,q20,q50}
 * layers (Task 13) at 7 leadtimes, in parallel, with 1h in-memory cache.
 */
@Module({
  imports: [HttpModule],
  controllers: [GlofasController],
  providers: [GlofasService],
})
export class GlofasModule {}
