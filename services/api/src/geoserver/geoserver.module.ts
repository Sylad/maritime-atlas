import { Global, Module } from '@nestjs/common';
import { GeoServerService } from './geoserver.service';

@Global()
@Module({
  providers: [GeoServerService],
  exports: [GeoServerService],
})
export class GeoServerModule {}
