import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DB_TOKEN, type Db } from '../db/db.module';
import { palettes, userLayerPreferences, type Palette, VALID_LAYER_KINDS } from '../db/schema';

export interface MyContext {
  preferences: Array<{ layerKind: string; paletteId: number | null; styleName: string | null }>;
  palettes: Palette[];
}

@Injectable()
export class PreferencesService {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  async getMyContext(userId: number): Promise<MyContext> {
    const myPalettes = await this.db.select().from(palettes).where(eq(palettes.userId, userId));
    const prefs = await this.db.select().from(userLayerPreferences).where(eq(userLayerPreferences.userId, userId));
    return {
      palettes: myPalettes,
      preferences: prefs.map((p) => {
        const pal = myPalettes.find((x) => x.id === p.paletteId);
        return {
          layerKind: p.layerKind,
          paletteId: p.paletteId,
          styleName: pal ? `user_${userId}_${pal.slug}` : null,
        };
      }),
    };
  }

  /** Upsert one preference. paletteId=null means "clear preference" → revert to defaultStyle. */
  async setPreference(userId: number, layerKind: string, paletteId: number | null): Promise<void> {
    if (!VALID_LAYER_KINDS.includes(layerKind as any)) {
      throw new Error(`Invalid layerKind: ${layerKind}`);
    }
    if (paletteId !== null) {
      const owned = await this.db.select().from(palettes)
        .where(and(eq(palettes.id, paletteId), eq(palettes.userId, userId))).limit(1);
      if (owned.length === 0) {
        throw new Error('Palette not found or not owned');
      }
    }
    // Drizzle PG insert + onConflictDoUpdate is the canonical upsert.
    await this.db.insert(userLayerPreferences)
      .values({ userId, layerKind, paletteId })
      .onConflictDoUpdate({
        target: [userLayerPreferences.userId, userLayerPreferences.layerKind],
        set: { paletteId, updatedAt: new Date() },
      });
  }
}
