import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard, CurrentUser } from '../auth/jwt-auth.guard';
import { PreferencesService } from './preferences.service';
import { VALID_LAYER_KINDS } from '../db/schema';

class SetPreferenceDto {
  @IsIn(VALID_LAYER_KINDS as unknown as string[])
  layerKind!: string;

  @IsOptional()
  @IsInt()
  paletteId!: number | null;
}

/** Phase C UX V2 : layer state patch (visible / opacity). layerKind libre. */
class LayerStateDto {
  @IsString()
  layerKind!: string;

  @IsOptional()
  @IsBoolean()
  visible?: boolean | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  opacity?: number | null;
}

class BatchLayerStateDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LayerStateDto)
  states!: LayerStateDto[];
}

@Controller('me')
@UseGuards(JwtAuthGuard)
export class PreferencesController {
  constructor(private readonly prefs: PreferencesService) {}

  @Get()
  async me(@CurrentUser() user: { sub: number; email: string }) {
    const ctx = await this.prefs.getMyContext(user.sub);
    return { user: { id: user.sub, email: user.email }, ...ctx };
  }

  /** Phase 5 : set palette pour un layer raster (sst/wind/waves/wave-dir). */
  @Put('preferences')
  async setPreference(@CurrentUser('sub') userId: number, @Body() body: SetPreferenceDto) {
    await this.prefs.setPreference(userId, body.layerKind, body.paletteId ?? null);
    return { ok: true };
  }

  /** Phase C UX V2 : set layer state (visible / opacity). layerKind libre.
      Pour 1 layer à la fois — utile au drag d'opacity slider (debounced 500ms). */
  @Put('layer-state')
  async setLayerState(@CurrentUser('sub') userId: number, @Body() body: LayerStateDto) {
    await this.prefs.setLayerState(userId, body.layerKind, {
      visible: body.visible,
      opacity: body.opacity,
    });
    return { ok: true };
  }

  /** Phase C UX V2 : batch sync (cas du logout localStorage → login merge DB). */
  @Put('layer-states')
  async setLayerStates(@CurrentUser('sub') userId: number, @Body() body: BatchLayerStateDto) {
    await this.prefs.setLayerStates(
      userId,
      body.states.map((s) => ({
        layerKind: s.layerKind,
        patch: { visible: s.visible, opacity: s.opacity },
      })),
    );
    return { ok: true };
  }
}
