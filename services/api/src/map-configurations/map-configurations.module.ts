import { Module } from '@nestjs/common';
import { MapConfigurationsService } from './map-configurations.service';
import { MapConfigurationsController } from './map-configurations.controller';

@Module({
  controllers: [MapConfigurationsController],
  providers: [MapConfigurationsService],
  exports: [MapConfigurationsService],
})
export class MapConfigurationsModule {}
