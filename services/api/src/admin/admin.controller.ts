import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, ParseIntPipe, Post, Put, UseGuards } from '@nestjs/common';
import { IsIn } from 'class-validator';
import { eq, desc } from 'drizzle-orm';
import { Inject } from '@nestjs/common';
import { DB_TOKEN, type Db } from '../db/db.module';
import { users, VALID_ROLES, type Role } from '../db/schema';
import { JwtAuthGuard, CurrentUser } from '../auth/jwt-auth.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { AuthService } from '../auth/auth.service';
import { DormantCleanupService } from '../auth/dormant-cleanup.service';

export class UpdateRoleDto {
  @IsIn(VALID_ROLES as readonly string[])
  role!: Role;
}

/**
 * Endpoints admin (RBAC strict — @Roles('admin') sur toutes les routes).
 *
 *   GET    /admin/users        → liste tous les users (sans password_hash)
 *   PUT    /admin/users/:id    → change le role d'un user
 *   DELETE /admin/users/:id    → supprime un user (cascade palettes + prefs)
 *
 * Garde-fou : un admin ne peut PAS se rétrograder lui-même ni se supprimer
 * (sinon plus aucun admin → bricked). Le seed admin Sylvain reste donc
 * toujours présent au minimum.
 */
@Controller('admin/users')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class AdminUsersController {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly auth: AuthService,
    private readonly dormantCleanup: DormantCleanupService,
  ) {}

  @Get()
  async list() {
    const rows = await this.db.select().from(users).orderBy(desc(users.createdAt));
    return rows.map((u) => this.auth.toPublic(u));
  }

  @Put(':id')
  async setRole(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: UpdateRoleDto,
    @CurrentUser('sub') currentUserId: number,
  ) {
    if (id === currentUserId && body.role !== 'admin') {
      throw new ForbiddenException('You cannot demote yourself');
    }
    const found = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    if (found.length === 0) {
      throw new NotFoundException(`User ${id} not found`);
    }
    if (found[0].role === body.role) {
      return this.auth.toPublic(found[0]); // no-op
    }
    await this.db.update(users).set({ role: body.role }).where(eq(users.id, id));
    return this.auth.toPublic({ ...found[0], role: body.role });
  }

  /** Trigger manuel du cleanup dormants — pour audit avant de laisser
      tourner le cron quotidien. Respecte DORMANT_DRY_RUN env. */
  @Post('cleanup-dormants')
  async triggerDormantCleanup() {
    return this.dormantCleanup.runCleanup();
  }

  @Delete(':id')
  async deleteUser(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser('sub') currentUserId: number,
  ) {
    if (id === currentUserId) {
      throw new ForbiddenException('You cannot delete yourself');
    }
    const found = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    if (found.length === 0) {
      throw new NotFoundException(`User ${id} not found`);
    }
    await this.db.delete(users).where(eq(users.id, id));
    return { message: `User ${found[0].username} (${found[0].email}) deleted.` };
  }
}
