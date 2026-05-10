import { Module } from '@nestjs/common';
import { PalettesService } from './palettes.service';
import { PalettesController } from './palettes.controller';

@Module({
  controllers: [PalettesController],
  providers: [PalettesService],
  exports: [PalettesService],
})
export class PalettesModule {}
