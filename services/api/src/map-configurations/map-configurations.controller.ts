import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, UseGuards } from '@nestjs/common';
import { CurrentUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MapConfigurationsService } from './map-configurations.service';
import { MapConfigDto } from './dto';

@Controller('map-configs')
@UseGuards(JwtAuthGuard)
export class MapConfigurationsController {
  constructor(private readonly configs: MapConfigurationsService) {}

  @Get()
  list(@CurrentUser('sub') userId: number) {
    return this.configs.listMine(userId);
  }

  @Post()
  create(@CurrentUser('sub') userId: number, @Body() body: MapConfigDto) {
    return this.configs.create(userId, body);
  }

  @Put(':id')
  update(@CurrentUser('sub') userId: number, @Param('id', ParseIntPipe) id: number, @Body() body: MapConfigDto) {
    return this.configs.update(userId, id, body);
  }

  @Delete(':id')
  async remove(@CurrentUser('sub') userId: number, @Param('id', ParseIntPipe) id: number) {
    await this.configs.delete(userId, id);
    return { ok: true };
  }
}
