import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, UseGuards } from '@nestjs/common';
import { CurrentUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/optional-jwt-auth.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { DashboardsService } from './dashboards.service';
import { DashboardDto, VisibilityDto } from './dto';

/**
 * Routes dashboards. Lecture publique pour `public`/`default`/`:id` (anonyme
 * autorisé via OptionalJwtAuthGuard) ; écritures réservées au propriétaire
 * (JwtAuthGuard) ; `:id/default` réservé admin.
 *
 * Ordre des routes : les chemins statiques (`public`, `default`) AVANT `:id`.
 */
@Controller('dashboards')
export class DashboardsController {
  constructor(private readonly dashboards: DashboardsService) {}

  // ─── Lecture ───
  @Get()
  @UseGuards(JwtAuthGuard)
  listMine(@CurrentUser('sub') userId: number) {
    return this.dashboards.listMine(userId);
  }

  @Get('public')
  listPublic() {
    return this.dashboards.listPublic();
  }

  @Get('default')
  getDefault() {
    return this.dashboards.getDefault();
  }

  @Get(':id')
  @UseGuards(OptionalJwtAuthGuard)
  getOne(@CurrentUser('sub') userId: number | undefined, @Param('id', ParseIntPipe) id: number) {
    return this.dashboards.getOne(userId ?? null, id);
  }

  // ─── Écritures (propriétaire) ───
  @Post()
  @UseGuards(JwtAuthGuard)
  create(@CurrentUser('sub') userId: number, @Body() body: DashboardDto) {
    return this.dashboards.create(userId, body);
  }

  @Put(':id')
  @UseGuards(JwtAuthGuard)
  update(@CurrentUser('sub') userId: number, @Param('id', ParseIntPipe) id: number, @Body() body: DashboardDto) {
    return this.dashboards.update(userId, id, body);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  async remove(@CurrentUser('sub') userId: number, @Param('id', ParseIntPipe) id: number) {
    await this.dashboards.delete(userId, id);
    return { ok: true };
  }

  @Put(':id/visibility')
  @UseGuards(JwtAuthGuard)
  setVisibility(@CurrentUser('sub') userId: number, @Param('id', ParseIntPipe) id: number, @Body() body: VisibilityDto) {
    return this.dashboards.setVisibility(userId, id, body.isPublic);
  }

  // ─── Admin : dashboard par défaut ───
  @Put(':id/default')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  setDefault(@Param('id', ParseIntPipe) id: number) {
    return this.dashboards.setDefault(id);
  }
}
