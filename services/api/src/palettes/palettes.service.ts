import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq } from 'drizzle-orm';
import { DB_TOKEN, type Db } from '../db/db.module';
import { palettes, type Palette, type PaletteStop } from '../db/schema';
import { GeoServerService } from '../geoserver/geoserver.service';
import type { PaletteDto } from './dto';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // strip accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'palette';
}

@Injectable()
export class PalettesService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly geoserver: GeoServerService,
    private readonly config: ConfigService,
  ) {}

  async listMine(userId: number): Promise<Palette[]> {
    return this.db.select().from(palettes).where(eq(palettes.userId, userId));
  }

  async create(userId: number, dto: PaletteDto): Promise<Palette> {
    // Enforce limit
    const existing = await this.listMine(userId);
    const limit = this.config.get<number>('paletteLimit') ?? 5;
    if (existing.length >= limit) {
      throw new BadRequestException(`Palette limit reached (max ${limit})`);
    }

    // Build a unique slug for this user
    const baseSlug = slugify(dto.name);
    let slug = baseSlug;
    let counter = 2;
    const existingSlugs = new Set(existing.map((p) => p.slug));
    while (existingSlugs.has(slug)) {
      slug = `${baseSlug}-${counter++}`;
    }

    const stops = dto.stops as PaletteStop[];
    const [created] = await this.db.insert(palettes).values({
      userId,
      name: dto.name,
      slug,
      layerKind: dto.layerKind,
      stops,
      opacity: dto.opacity ?? 0.7,
    }).returning();

    // Mirror to GeoServer (best-effort: rollback DB if fails)
    try {
      const styleName = this.geoserver.styleNameFor(userId, slug);
      await this.geoserver.upsertStyle(styleName, this.geoserver.buildSld(styleName, stops));
    } catch (err) {
      await this.db.delete(palettes).where(eq(palettes.id, created.id));
      throw new BadRequestException(`GeoServer style upsert failed: ${(err as Error).message}`);
    }
    return created;
  }

  async update(userId: number, id: number, dto: PaletteDto): Promise<Palette> {
    const found = await this.db.select().from(palettes)
      .where(and(eq(palettes.id, id), eq(palettes.userId, userId))).limit(1);
    if (found.length === 0) {
      throw new NotFoundException('Palette not found');
    }
    const stops = dto.stops as PaletteStop[];
    const [updated] = await this.db.update(palettes)
      .set({
        name: dto.name,
        layerKind: dto.layerKind,
        stops,
        opacity: dto.opacity ?? found[0].opacity,
        updatedAt: new Date(),
      })
      .where(eq(palettes.id, id))
      .returning();
    // Mirror update to GeoServer (style name unchanged, slug stable)
    const styleName = this.geoserver.styleNameFor(userId, found[0].slug);
    await this.geoserver.upsertStyle(styleName, this.geoserver.buildSld(styleName, stops));
    return updated;
  }

  async delete(userId: number, id: number): Promise<void> {
    const found = await this.db.select().from(palettes)
      .where(and(eq(palettes.id, id), eq(palettes.userId, userId))).limit(1);
    if (found.length === 0) {
      throw new NotFoundException('Palette not found');
    }
    await this.db.delete(palettes).where(eq(palettes.id, id));
    const styleName = this.geoserver.styleNameFor(userId, found[0].slug);
    // Best-effort : if GeoServer fails, log but don't fail the user-facing operation
    try {
      await this.geoserver.deleteStyle(styleName);
    } catch {
      // swallow — caller has already committed the DB delete
    }
  }

  /** Cross-user check helper for guard logic (and used by tests). */
  async ensureOwnership(userId: number, paletteId: number): Promise<void> {
    const found = await this.db.select().from(palettes)
      .where(and(eq(palettes.id, paletteId), eq(palettes.userId, userId))).limit(1);
    if (found.length === 0) {
      throw new ForbiddenException();
    }
  }
}
