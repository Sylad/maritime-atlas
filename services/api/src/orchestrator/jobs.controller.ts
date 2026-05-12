import { BadRequestException, Body, Controller, Get, Headers, Inject, Post, Query, UnauthorizedException, UseGuards } from '@nestjs/common';
import { IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, Min } from 'class-validator';
import { ConfigService } from '@nestjs/config';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DB_TOKEN, type Db } from '../db/db.module';
import { dataJobs, dataSources, VALID_JOB_STATUS, type JobStatus } from '../db/schema';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { OrchestratorRunnerService } from './orchestrator-runner.service';

/**
 * Payload envoyé par les ingesters à chaque fin de cycle (cron tick ou
 * batch WSS). Authentification via header `X-Job-Token` = env
 * `ORCHESTRATOR_JOB_TOKEN` (shared secret, pas un JWT pour rester
 * simple côté Python).
 */
export class LogJobDto {
  @IsString()
  sourceName!: string;

  @IsIn(VALID_JOB_STATUS as readonly string[])
  status!: JobStatus;

  /** ISO datetime — début du cycle côté ingester. */
  @IsString()
  startedAt!: string;

  /** ISO datetime — fin du cycle côté ingester. */
  @IsOptional() @IsString()
  finishedAt?: string;

  @IsOptional() @IsInt() @Min(0)
  durationMs?: number;

  @IsOptional() @IsInt() @Min(0)
  recordsIn?: number;

  @IsOptional() @IsInt() @Min(0)
  recordsOut?: number;

  @IsOptional() @IsInt() @Min(0)
  bytesIn?: number;

  @IsOptional() @IsString()
  errorKind?: string;

  @IsOptional() @IsString()
  errorMsg?: string;

  @IsOptional() @IsObject()
  meta?: Record<string, unknown>;
}

@Controller('admin/jobs')
export class JobsController {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly config: ConfigService,
    private readonly runner: OrchestratorRunnerService,
  ) {}

  /**
   * Endpoint shared-secret (pas de JWT — facilite l'appel depuis les
   * ingesters Python qui n'ont pas de session). Le secret est dans
   * l'env `ORCHESTRATOR_JOB_TOKEN` côté api ET côté chaque ingester.
   */
  @Post('log')
  async log(
    @Headers('x-job-token') token: string | undefined,
    @Body() body: LogJobDto,
  ) {
    const expected = this.config.get<string>('ORCHESTRATOR_JOB_TOKEN', '');
    if (!expected) {
      throw new BadRequestException('Orchestrator token not configured server-side');
    }
    if (token !== expected) {
      throw new UnauthorizedException('Invalid job token');
    }

    // Cross-check : la source doit exister dans data_sources (sinon
    // typo silencieuse côté ingester → on rejette).
    const src = await this.db
      .select()
      .from(dataSources)
      .where(eq(dataSources.name, body.sourceName))
      .limit(1);
    if (src.length === 0) {
      throw new BadRequestException(`Unknown source: ${body.sourceName}`);
    }

    const startedAt = new Date(body.startedAt);
    const finishedAt = body.finishedAt ? new Date(body.finishedAt) : new Date();
    const durationMs = body.durationMs ?? Math.max(0, finishedAt.getTime() - startedAt.getTime());

    await this.db.insert(dataJobs).values({
      sourceName: body.sourceName,
      status: body.status,
      startedAt,
      finishedAt,
      durationMs,
      recordsIn: body.recordsIn,
      recordsOut: body.recordsOut,
      bytesIn: body.bytesIn,
      errorKind: body.errorKind,
      errorMsg: body.errorMsg,
      meta: body.meta,
    });

    // Update source last_run_at + last_status (cheap UPSERT-style).
    await this.db
      .update(dataSources)
      .set({ lastRunAt: finishedAt, lastStatus: body.status })
      .where(eq(dataSources.name, body.sourceName));

    // Push SSE event pour que les clients connectés voient l'update live
    // (sans avoir à attendre le refetch 60s).
    this.runner.emitJobCompleted({
      type: 'job.completed',
      sourceName: body.sourceName,
      status: body.status,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs,
      recordsOut: body.recordsOut ?? null,
      errorMsg: body.errorMsg ?? null,
    });

    return { ok: true };
  }

  /**
   * GET /admin/jobs?source=sst-fetcher&limit=50&status=error
   * Lit l'historique paginé. RBAC admin (JWT).
   */
  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  async list(
    @Query('source') source?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    const lim = Math.min(parseInt(limit ?? '100', 10) || 100, 500);
    const conds: any[] = [];
    if (source) conds.push(eq(dataJobs.sourceName, source));
    if (status && (VALID_JOB_STATUS as readonly string[]).includes(status)) {
      conds.push(eq(dataJobs.status, status));
    }
    const where = conds.length === 0 ? undefined
                : conds.length === 1 ? conds[0]
                : and(...conds);
    const q = this.db.select().from(dataJobs);
    const rows = await (where ? q.where(where) : q)
      .orderBy(desc(dataJobs.startedAt))
      .limit(lim);
    return rows;
  }
}
