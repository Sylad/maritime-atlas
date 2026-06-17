import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DB_TOKEN, type Db } from '../db/db.module';
import { mapConfigurations, type MapConfiguration } from '../db/schema';
import type { MapConfigDto } from './dto';

/** Limite par user — garde-fou anti-spam, alignée sur l'esprit de paletteLimit. */
const CONFIG_LIMIT = 50;

@Injectable()
export class MapConfigurationsService {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  async listMine(userId: number): Promise<MapConfiguration[]> {
    return this.db.select().from(mapConfigurations)
      .where(eq(mapConfigurations.userId, userId))
      .orderBy(desc(mapConfigurations.updatedAt));
  }

  async create(userId: number, dto: MapConfigDto): Promise<MapConfiguration> {
    const existing = await this.listMine(userId);
    if (existing.length >= CONFIG_LIMIT) {
      throw new BadRequestException(`Map config limit reached (max ${CONFIG_LIMIT})`);
    }
    if (existing.some((c) => c.name === dto.name)) {
      throw new BadRequestException(`Une config nommée « ${dto.name} » existe déjà`);
    }
    const [created] = await this.db.insert(mapConfigurations).values({
      userId,
      name: dto.name,
      snapshot: dto.snapshot,
    }).returning();
    return created;
  }

  async update(userId: number, id: number, dto: MapConfigDto): Promise<MapConfiguration> {
    await this.ensureOwnership(userId, id);
    // Collision de nom avec une AUTRE config du même user.
    const clash = (await this.listMine(userId)).find((c) => c.name === dto.name && c.id !== id);
    if (clash) {
      throw new BadRequestException(`Une config nommée « ${dto.name} » existe déjà`);
    }
    const [updated] = await this.db.update(mapConfigurations)
      .set({ name: dto.name, snapshot: dto.snapshot, updatedAt: new Date() })
      .where(eq(mapConfigurations.id, id))
      .returning();
    return updated;
  }

  async delete(userId: number, id: number): Promise<void> {
    await this.ensureOwnership(userId, id);
    await this.db.delete(mapConfigurations).where(eq(mapConfigurations.id, id));
  }

  private async ensureOwnership(userId: number, id: number): Promise<void> {
    const found = await this.db.select().from(mapConfigurations)
      .where(and(eq(mapConfigurations.id, id), eq(mapConfigurations.userId, userId))).limit(1);
    if (found.length === 0) {
      throw new NotFoundException('Map config not found');
    }
  }
}
