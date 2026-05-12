import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export interface LayerPref {
  layerKind: string;
  paletteId: number | null;
  styleName: string | null;
  visible: boolean | null;
  opacity: number | null;
}

interface MeResponse {
  user: { id: number; email: string };
  preferences: LayerPref[];
  palettes: unknown[];
}

/**
 * Phase C.2 (2026-05-12) — sync prefs frontend ↔ DB pour users connectés.
 *
 * Pattern :
 *   - Anonymous : localStorage only (Phase A inchangé)
 *   - Connecté login → fetchMyPrefs() : DB wins sur localStorage
 *   - Toggle/opacity change → pushBatch() debounced 500ms
 *
 * Le batch endpoint backend (PUT /api/me/layer-states) accepte un array
 * de patches, idempotent. Permet d'envoyer toutes les prefs visibles +
 * opacity en 1 seule requête (plutôt que N PUT /api/me/layer-state).
 */
@Injectable({ providedIn: 'root' })
export class PreferencesSyncService {
  private readonly http = inject(HttpClient);
  private pushTimer?: ReturnType<typeof setTimeout>;
  private readonly DEBOUNCE_MS = 500;

  /** GET /api/me → liste des prefs DB (visible/opacity par layer). */
  async fetchMyPrefs(): Promise<LayerPref[]> {
    try {
      const res = await firstValueFrom(this.http.get<MeResponse>('/api/me'));
      return res.preferences ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Push batch debounced 500ms. Si la fonction est appelée plusieurs fois
   * en moins de 500ms (typique du drag opacity slider), seul le dernier
   * snapshot est envoyé. Idempotent côté backend (upsert).
   */
  schedulePushBatch(states: Array<{ layerKind: string; visible?: boolean | null; opacity?: number | null }>): void {
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => {
      this.pushTimer = undefined;
      this.http.put('/api/me/layer-states', { states }).subscribe({
        error: () => {
          // Silent fail : localStorage reste la source canonique. Le user
          // reverra ses prefs au prochain merge réussi.
        },
      });
    }, this.DEBOUNCE_MS);
  }

  /** Annule un push en cours (utile au logout). */
  cancel(): void {
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
      this.pushTimer = undefined;
    }
  }
}
