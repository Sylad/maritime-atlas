import { BadRequestException, Body, Controller, Get, Inject, Put, UseGuards } from '@nestjs/common';
import { IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { eq } from 'drizzle-orm';
import { JwtAuthGuard, CurrentUser } from '../auth/jwt-auth.guard';
import { PreferencesService } from './preferences.service';
import { users, VALID_LAYER_KINDS } from '../db/schema';
import { DB_TOKEN, type Db } from '../db/db.module';

/** Phase C.3 : zones d'arrivée prédéfinies (cf frontend map-zones.ts).
 *  À garder synchronisée avec MAP_ZONES côté frontend (sinon 400 sur les
 *  zones nouvelles non-whitelistées ici). */
const VALID_ZONE_IDS = [
  // Régions
  'europe', 'europe-west', 'europe-east', 'mediterranee', 'manche',
  'atlantique', 'baltique', 'adriatique',
  // Pays
  'france', 'royaume-uni', 'irlande', 'allemagne', 'espagne', 'portugal',
  'italie', 'pays-bas', 'norvege', 'grece', 'pologne', 'turquie',
  'islande', 'suisse', 'bulgarie',
] as const;

class SetDefaultZoneDto {
  @IsIn(VALID_ZONE_IDS as unknown as string[])
  zone!: string;
}

/** Phase C.4 : projections OL supportées (cf frontend map-projections.ts). */
const VALID_PROJECTION_CODES = ['EPSG:3857', 'EPSG:4326', 'EPSG:3035'] as const;

class SetProjectionDto {
  @IsIn(VALID_PROJECTION_CODES as unknown as string[])
  projection!: string;
}

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
  constructor(
    private readonly prefs: PreferencesService,
    @Inject(DB_TOKEN) private readonly db: Db,
  ) {}

  @Get()
  async me(@CurrentUser() user: { sub: number; email: string }) {
    const ctx = await this.prefs.getMyContext(user.sub);
    // Lookup defaultZone + preferredProjection (Phase C.3 + C.4)
    // directement sur users — pas d'index séparé, requête trivial.
    const rows = await this.db.select({
      defaultZone: users.defaultZone,
      preferredProjection: users.preferredProjection,
    }).from(users).where(eq(users.id, user.sub)).limit(1);
    return {
      user: {
        id: user.sub,
        email: user.email,
        defaultZone: rows[0]?.defaultZone ?? null,
        preferredProjection: rows[0]?.preferredProjection ?? null,
      },
      ...ctx,
    };
  }

  /** Phase C.3 : set la zone d'arrivée préférée. La validation du slug
   *  est faite via @IsIn dans le DTO. */
  @Put('default-zone')
  async setDefaultZone(@CurrentUser('sub') userId: number, @Body() body: SetDefaultZoneDto) {
    await this.db.update(users).set({ defaultZone: body.zone }).where(eq(users.id, userId));
    return { ok: true, zone: body.zone };
  }

  /** Phase C.4 : set la projection OL préférée. */
  @Put('preferred-projection')
  async setProjection(@CurrentUser('sub') userId: number, @Body() body: SetProjectionDto) {
    await this.db.update(users).set({ preferredProjection: body.projection }).where(eq(users.id, userId));
    return { ok: true, projection: body.projection };
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
