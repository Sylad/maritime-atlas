import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DB_TOKEN, type Db } from '../db/db.module';
import { dashboards, type Dashboard } from '../db/schema';
import type { DashboardDto } from './dto';

const DASHBOARD_LIMIT = 30;

@Injectable()
export class DashboardsService {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  /** Les dashboards du user (privés + publics), récents d'abord. */
  async listMine(userId: number): Promise<Dashboard[]> {
    return this.db.select().from(dashboards)
      .where(eq(dashboards.userId, userId))
      .orderBy(desc(dashboards.updatedAt));
  }

  /** Tous les dashboards publics (tous users). */
  async listPublic(): Promise<Dashboard[]> {
    return this.db.select().from(dashboards)
      .where(eq(dashboards.isPublic, true))
      .orderBy(desc(dashboards.isDefault), desc(dashboards.updatedAt));
  }

  /** Le dashboard par défaut global, ou null. */
  async getDefault(): Promise<Dashboard | null> {
    const rows = await this.db.select().from(dashboards)
      .where(eq(dashboards.isDefault, true)).limit(1);
    return rows[0] ?? null;
  }

  /** Un dashboard accessible à l'appelant : possédé OU public. Sinon 404. */
  async getOne(userId: number | null, id: number): Promise<Dashboard> {
    const rows = await this.db.select().from(dashboards).where(eq(dashboards.id, id)).limit(1);
    const dash = rows[0];
    if (!dash) throw new NotFoundException('Dashboard not found');
    if (!dash.isPublic && dash.userId !== userId) throw new NotFoundException('Dashboard not found');
    return dash;
  }

  async create(userId: number, dto: DashboardDto): Promise<Dashboard> {
    const existing = await this.listMine(userId);
    if (existing.length >= DASHBOARD_LIMIT) {
      throw new BadRequestException(`Dashboard limit reached (max ${DASHBOARD_LIMIT})`);
    }
    const [created] = await this.db.insert(dashboards).values({
      userId,
      name: dto.name,
      widgets: dto.widgets,
      isPublic: false,
      isDefault: false,
    }).returning();
    return created;
  }

  async update(userId: number, id: number, dto: DashboardDto): Promise<Dashboard> {
    await this.ensureOwner(userId, id);
    const [updated] = await this.db.update(dashboards)
      .set({ name: dto.name, widgets: dto.widgets, updatedAt: new Date() })
      .where(eq(dashboards.id, id))
      .returning();
    return updated;
  }

  async delete(userId: number, id: number): Promise<void> {
    await this.ensureOwner(userId, id);
    await this.db.delete(dashboards).where(eq(dashboards.id, id));
  }

  /** Toggle public/privé (owner). Refuse de repasser privé si défaut global. */
  async setVisibility(userId: number, id: number, isPublic: boolean): Promise<Dashboard> {
    const dash = await this.ensureOwner(userId, id);
    if (dash.isDefault && !isPublic) {
      throw new BadRequestException('Le dashboard par défaut ne peut pas redevenir privé');
    }
    const [updated] = await this.db.update(dashboards)
      .set({ isPublic, updatedAt: new Date() })
      .where(eq(dashboards.id, id))
      .returning();
    return updated;
  }

  /**
   * Admin : marque un dashboard PUBLIC comme défaut global. Exige is_public,
   * déplace le flag (unset l'ancien défaut). Le dashboard reste verrouillé
   * public (cf setVisibility). Idempotent.
   */
  async setDefault(id: number): Promise<Dashboard> {
    const rows = await this.db.select().from(dashboards).where(eq(dashboards.id, id)).limit(1);
    const dash = rows[0];
    if (!dash) throw new NotFoundException('Dashboard not found');
    if (!dash.isPublic) throw new BadRequestException('Un dashboard doit être public pour devenir défaut');
    // Unset l'ancien défaut (l'index partiel unique interdit deux défauts).
    await this.db.update(dashboards).set({ isDefault: false }).where(eq(dashboards.isDefault, true));
    const [updated] = await this.db.update(dashboards)
      .set({ isDefault: true, updatedAt: new Date() })
      .where(eq(dashboards.id, id))
      .returning();
    return updated;
  }

  private async ensureOwner(userId: number, id: number): Promise<Dashboard> {
    const rows = await this.db.select().from(dashboards)
      .where(and(eq(dashboards.id, id), eq(dashboards.userId, userId))).limit(1);
    if (rows.length === 0) throw new ForbiddenException('Dashboard not found or not owned');
    return rows[0];
  }
}
