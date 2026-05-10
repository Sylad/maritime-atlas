import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, UseGuards } from '@nestjs/common';
import { JwtAuthGuard, CurrentUser } from '../auth/jwt-auth.guard';
import { PalettesService } from './palettes.service';
import { PaletteDto } from './dto';

@Controller('palettes')
@UseGuards(JwtAuthGuard)
export class PalettesController {
  constructor(private readonly palettes: PalettesService) {}

  @Get()
  list(@CurrentUser('sub') userId: number) {
    return this.palettes.listMine(userId);
  }

  @Post()
  create(@CurrentUser('sub') userId: number, @Body() body: PaletteDto) {
    return this.palettes.create(userId, body);
  }

  @Put(':id')
  update(@CurrentUser('sub') userId: number, @Param('id', ParseIntPipe) id: number, @Body() body: PaletteDto) {
    return this.palettes.update(userId, id, body);
  }

  @Delete(':id')
  async remove(@CurrentUser('sub') userId: number, @Param('id', ParseIntPipe) id: number) {
    await this.palettes.delete(userId, id);
    return { ok: true };
  }
}
