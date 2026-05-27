import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { GlofasService } from './glofas.service';
import { GlofasTimeSeriesResponse } from './glofas.types';

@Controller('glofas')
export class GlofasController {
  constructor(private readonly service: GlofasService) {}

  @Get('timeseries')
  async getTimeSeries(
    @Query('lon') lonStr?: string,
    @Query('lat') latStr?: string,
  ): Promise<GlofasTimeSeriesResponse> {
    const lon = Number(lonStr);
    const lat = Number(latStr);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      throw new BadRequestException('lon and lat must be finite numbers');
    }
    if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
      throw new BadRequestException('lon/lat out of range');
    }
    return this.service.getTimeSeries(lon, lat);
  }
}
