import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { IsIn, IsInt, IsOptional } from 'class-validator';
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

@Controller('me')
@UseGuards(JwtAuthGuard)
export class PreferencesController {
  constructor(private readonly prefs: PreferencesService) {}

  @Get()
  async me(@CurrentUser() user: { sub: number; email: string }) {
    const ctx = await this.prefs.getMyContext(user.sub);
    return { user: { id: user.sub, email: user.email }, ...ctx };
  }

  @Put('preferences')
  async setPreference(@CurrentUser('sub') userId: number, @Body() body: SetPreferenceDto) {
    await this.prefs.setPreference(userId, body.layerKind, body.paletteId ?? null);
    return { ok: true };
  }
}
