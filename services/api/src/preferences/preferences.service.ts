import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DB_TOKEN, type Db } from '../db/db.module';
import { palettes, userLayerPreferences, type Palette, VALID_LAYER_KINDS } from '../db/schema';

export interface MyContext {
  preferences: Array<{
    layerKind: string;
    paletteId: number | null;
    styleName: string | null;
    visible: boolean | null;
    opacity: number | null;
  }>;
  palettes: Palette[];
}

/** Sprint Layer UX V2 Phase C : un layer peut avoir visible / opacity /
    paletteId set indépendamment. `layerKind` accepte n'importe quel
    string (les non-rasters comme `vessels`, `tracks`, etc. n'ont pas
    de palette mais peuvent quand même persister leur visibility/opacity). */
export interface LayerStatePatch {
  visible?: boolean | null;
  opacity?: number | null;
  paletteId?: number | null;
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
          visible: p.visible,
          opacity: p.opacity,
        };
      }),
    };
  }

  /** Upsert palette preference (Phase 5). paletteId=null = revert to defaultStyle.
      Vérifie que la palette existe ET appartient au user + que layerKind est
      bien dans VALID_LAYER_KINDS (palette uniquement pour rasters). */
  async setPreference(userId: number, layerKind: string, paletteId: number | null): Promise<void> {
    if (!VALID_LAYER_KINDS.includes(layerKind as any)) {
      throw new Error(`Invalid palette layerKind: ${layerKind}`);
    }
    if (paletteId !== null) {
      const owned = await this.db.select().from(palettes)
        .where(and(eq(palettes.id, paletteId), eq(palettes.userId, userId))).limit(1);
      if (owned.length === 0) {
        throw new Error('Palette not found or not owned');
      }
    }
    await this.db.insert(userLayerPreferences)
      .values({ userId, layerKind, paletteId })
      .onConflictDoUpdate({
        target: [userLayerPreferences.userId, userLayerPreferences.layerKind],
        set: { paletteId, updatedAt: new Date() },
      });
  }

  /** Phase C UX V2 : upsert layer state (visible / opacity).
      layerKind accepte n'importe quel string (non-restreint au rasters).
      patch peut contenir seulement visible OU opacity, ou les 2. Les
      champs absents du patch sont préservés en DB. */
  async setLayerState(userId: number, layerKind: string, patch: LayerStatePatch): Promise<void> {
    // Validation light : pas d'opacity hors [0,1]
    if (patch.opacity !== undefined && patch.opacity !== null) {
      if (patch.opacity < 0 || patch.opacity > 1 || isNaN(patch.opacity)) {
        throw new Error(`Invalid opacity ${patch.opacity}, must be in [0, 1]`);
      }
    }
    // Lookup existant pour fusionner avec le patch (preserve fields absent du patch)
    const existing = await this.db.select().from(userLayerPreferences)
      .where(and(eq(userLayerPreferences.userId, userId), eq(userLayerPreferences.layerKind, layerKind)))
      .limit(1);
    const merged = {
      visible: patch.visible !== undefined ? patch.visible : existing[0]?.visible ?? null,
      opacity: patch.opacity !== undefined ? patch.opacity : existing[0]?.opacity ?? null,
      paletteId: patch.paletteId !== undefined ? patch.paletteId : existing[0]?.paletteId ?? null,
    };
    await this.db.insert(userLayerPreferences)
      .values({ userId, layerKind, ...merged })
      .onConflictDoUpdate({
        target: [userLayerPreferences.userId, userLayerPreferences.layerKind],
        set: { ...merged, updatedAt: new Date() },
      });
  }

  /** Phase C : batch update layer states (cas du frontend qui sync N layers
      au logout/login). Simpler que N appels setLayerState. */
  async setLayerStates(userId: number, states: Array<{ layerKind: string; patch: LayerStatePatch }>): Promise<void> {
    for (const s of states) {
      await this.setLayerState(userId, s.layerKind, s.patch);
    }
  }
}
