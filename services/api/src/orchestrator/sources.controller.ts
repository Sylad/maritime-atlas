import { Body, Controller, Get, Inject, NotFoundException, Param, ParseIntPipe, Patch, UseGuards } from '@nestjs/common';
import { IsBoolean } from 'class-validator';
import { desc, eq } from 'drizzle-orm';
import { DB_TOKEN, type Db } from '../db/db.module';
import { dataSources } from '../db/schema';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';

export class ToggleEnabledDto {
  @IsBoolean()
  enabled!: boolean;
}

/**
 * GET    /admin/sources       → liste toutes les sources (avec last_run_at + last_status)
 * PATCH  /admin/sources/:id   → toggle `enabled` (informatif en MVP, sera consommé par
 *                               le scheduler dynamique en Sprint N2)
 *
 * Toutes les routes RBAC strict admin (réutilise pattern `admin/users`).
 */
@Controller('admin/sources')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class SourcesController {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  @Get()
  async list() {
    return this.db
      .select()
      .from(dataSources)
      .orderBy(desc(dataSources.lastRunAt), dataSources.name);
  }

  @Patch(':id')
  async toggle(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: ToggleEnabledDto,
  ) {
    const found = await this.db.select().from(dataSources).where(eq(dataSources.id, id)).limit(1);
    if (found.length === 0) {
      throw new NotFoundException(`Source ${id} not found`);
    }
    await this.db.update(dataSources).set({ enabled: body.enabled }).where(eq(dataSources.id, id));
    const updated = await this.db.select().from(dataSources).where(eq(dataSources.id, id)).limit(1);
    return updated[0];
  }
}
