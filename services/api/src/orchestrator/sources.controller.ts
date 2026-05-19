import { BadRequestException, Body, ConflictException, Controller, Delete, Get, Inject, NotFoundException, Param, ParseIntPipe, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Min } from 'class-validator';
import { desc, eq } from 'drizzle-orm';
import { DB_TOKEN, type Db } from '../db/db.module';
import { dataSources } from '../db/schema';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { OrchestratorRunnerService } from './orchestrator-runner.service';

const VALID_KINDS = ['http_json', 'http_grib', 'http_wfs', 'http_netcdf', 'websocket', 'rmq_consumer', 'sql_aggregate'] as const;
const VALID_SCHEDULE_KINDS = ['cron', 'interval', 'once'] as const;
const VALID_PARSER_KINDS = ['identity', 'json_path', 'grib_wind10m', 'grib_wave', 'netcdf_sst', 'grib_gfs_multi', 'geojson_features', 'csv'] as const;
const VALID_SINK_KINDS = ['pg_insert', 'rmq_publish', 'geotiff_volume'] as const;

export class ToggleEnabledDto {
  @IsBoolean()
  enabled!: boolean;
}

export class UpsertSourceDto {
  @IsString()
  name!: string;

  @IsIn(VALID_KINDS as readonly string[])
  kind!: string;

  @IsOptional() @IsString()
  url?: string;

  @IsOptional() @IsString()
  scheduleExpr?: string;

  @IsOptional() @IsIn(VALID_SCHEDULE_KINDS as readonly string[])
  scheduleKind?: string;

  @IsOptional() @IsInt() @Min(5)
  intervalSeconds?: number;

  @IsOptional() @IsString()
  httpMethod?: string;

  @IsOptional() @IsObject()
  httpHeaders?: Record<string, string>;

  @IsOptional() @IsObject()
  httpParams?: Record<string, string>;

  @IsOptional() @IsIn(VALID_PARSER_KINDS as readonly string[])
  parserKind?: string;

  @IsOptional() @IsObject()
  parserConfig?: Record<string, unknown>;

  @IsOptional() @IsIn(VALID_SINK_KINDS as readonly string[])
  sinkKind?: string;

  @IsOptional() @IsObject()
  sinkConfig?: Record<string, unknown>;

  @IsOptional() @IsString()
  bbox?: string;

  @IsOptional() @IsString()
  sinkLabel?: string;

  @IsOptional() @IsBoolean()
  enabled?: boolean;
}

/**
 * Sprint N2 (2026-05-12) — CRUD complet sources + exécution dynamique.
 *
 *   GET    /admin/sources           → liste
 *   POST   /admin/sources           → crée (avec parser + sink config)
 *   PUT    /admin/sources/:id       → update full
 *   PATCH  /admin/sources/:id       → toggle enabled (back-compat N1)
 *   DELETE /admin/sources/:id       → supprime
 *   POST   /admin/sources/:id/trigger → exécution manuelle (test)
 *
 * Le `OrchestratorRunnerService` est notifié à chaque change pour
 * re-register le scheduler dynamique.
 */
@Controller('admin/sources')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class SourcesController {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly runner: OrchestratorRunnerService,
  ) {}

  @Get()
  async list() {
    return this.db
      .select()
      .from(dataSources)
      .orderBy(desc(dataSources.lastRunAt), dataSources.name);
  }

  @Post()
  async create(@Body() body: UpsertSourceDto) {
    if (body.scheduleKind === 'interval' && !body.intervalSeconds) {
      throw new BadRequestException('intervalSeconds required for schedule_kind=interval');
    }
    if (body.scheduleKind === 'cron' && !body.scheduleExpr) {
      throw new BadRequestException('scheduleExpr required for schedule_kind=cron');
    }
    const existing = await this.db.select().from(dataSources).where(eq(dataSources.name, body.name)).limit(1);
    if (existing.length > 0) {
      throw new ConflictException(`Source ${body.name} already exists`);
    }
    const [created] = await this.db.insert(dataSources).values({
      name: body.name,
      kind: body.kind,
      url: body.url,
      scheduleExpr: body.scheduleExpr,
      scheduleKind: body.scheduleKind,
      intervalSeconds: body.intervalSeconds,
      httpMethod: body.httpMethod ?? 'GET',
      httpHeaders: body.httpHeaders,
      httpParams: body.httpParams,
      parserKind: body.parserKind ?? 'identity',
      parserConfig: body.parserConfig,
      sinkKind: body.sinkKind ?? 'rmq_publish',
      sinkConfig: body.sinkConfig,
      bbox: body.bbox,
      sinkLabel: body.sinkLabel,
      enabled: body.enabled ?? false,
    }).returning();
    await this.runner.reload();
    return created;
  }

  @Put(':id')
  async update(@Param('id', ParseIntPipe) id: number, @Body() body: UpsertSourceDto) {
    const found = await this.db.select().from(dataSources).where(eq(dataSources.id, id)).limit(1);
    if (found.length === 0) {
      throw new NotFoundException(`Source ${id} not found`);
    }
    await this.db.update(dataSources).set({
      name: body.name,
      kind: body.kind,
      url: body.url,
      scheduleExpr: body.scheduleExpr,
      scheduleKind: body.scheduleKind,
      intervalSeconds: body.intervalSeconds,
      httpMethod: body.httpMethod ?? 'GET',
      httpHeaders: body.httpHeaders,
      httpParams: body.httpParams,
      parserKind: body.parserKind ?? 'identity',
      parserConfig: body.parserConfig,
      sinkKind: body.sinkKind ?? 'rmq_publish',
      sinkConfig: body.sinkConfig,
      bbox: body.bbox,
      sinkLabel: body.sinkLabel,
      enabled: body.enabled ?? false,
      updatedAt: new Date(),
    }).where(eq(dataSources.id, id));
    const [updated] = await this.db.select().from(dataSources).where(eq(dataSources.id, id));
    await this.runner.reload();
    return updated;
  }

  @Patch(':id')
  async toggle(@Param('id', ParseIntPipe) id: number, @Body() body: ToggleEnabledDto) {
    const found = await this.db.select().from(dataSources).where(eq(dataSources.id, id)).limit(1);
    if (found.length === 0) {
      throw new NotFoundException(`Source ${id} not found`);
    }
    await this.db.update(dataSources).set({ enabled: body.enabled, updatedAt: new Date() }).where(eq(dataSources.id, id));
    const [updated] = await this.db.select().from(dataSources).where(eq(dataSources.id, id));
    await this.runner.reload();
    return updated;
  }

  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number) {
    const found = await this.db.select().from(dataSources).where(eq(dataSources.id, id)).limit(1);
    if (found.length === 0) {
      throw new NotFoundException(`Source ${id} not found`);
    }
    await this.db.delete(dataSources).where(eq(dataSources.id, id));
    await this.runner.reload();
    return { ok: true };
  }

  @Post(':id/trigger')
  async trigger(@Param('id', ParseIntPipe) id: number) {
    const found = await this.db.select().from(dataSources).where(eq(dataSources.id, id)).limit(1);
    if (found.length === 0) {
      throw new NotFoundException(`Source ${id} not found`);
    }
    const src = found[0];
    if (!src.scheduleKind) {
      throw new BadRequestException(`Source ${src.name} is self-managed (no schedule_kind set)`);
    }
    // Fire-and-forget : on retourne immédiatement, le runner persiste
    // un data_jobs en async.
    this.runner.runOnce(src).catch(() => {
      // Errors persisted as data_jobs row anyway by runOnce.
    });
    return { ok: true, message: `Triggered ${src.name}` };
  }

  /** 2026-05-19 APEX Satellites — backfill historique d'une source à URL
   *  templatée `{date}` / `{date-N}`. Lance `days` runs séquentiels (J-1..J-N)
   *  pour seed GeoServer avec une vraie série temporelle. Synchrone (await)
   *  car NASA GIBS sait être lent → on veut un compte-rendu en fin de loop.
   *
   *  Cas d'usage : après ajout d'une layer sat-* en BDD, la source ne tire
   *  qu'1 TIFF/jour via son cron → 1 seule validité GS → time-bar next/prev
   *  no-op. Le backfill résout en seedant N validités d'un coup. */
  @Post(':id/backfill')
  async backfill(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { days?: number },
  ) {
    const days = Math.max(1, Math.min(30, Number(body?.days ?? 7)));
    const found = await this.db.select().from(dataSources).where(eq(dataSources.id, id)).limit(1);
    if (found.length === 0) {
      throw new NotFoundException(`Source ${id} not found`);
    }
    const src = found[0];
    if (!src.url || !/\{date(-\d+)?\}/.test(src.url)) {
      throw new BadRequestException(`Source ${src.name} url has no {date} placeholder, cannot backfill`);
    }
    // Synchrone : le caller voit le résultat. Pour des backfills longs,
    // appeler en background depuis un job mais ici 7-14 j × ~1-3s/img = OK.
    const result = await this.runner.runBackfill(src, days);
    return { ok: result.errors.length === 0, ...result, days, source: src.name };
  }
}
