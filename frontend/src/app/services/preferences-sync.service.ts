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
  user: { id: number; email: string; layerOrder?: string[] | null };
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

  /** APEX 18 (2026-05-19) — GET /api/me → ordre user des layers (z-index)
   *  pour sync multi-device. NULL = jamais set côté DB → fallback localStorage. */
  async fetchMyLayerOrder(): Promise<string[] | null> {
    try {
      const res = await firstValueFrom(this.http.get<MeResponse>('/api/me'));
      return res.user?.layerOrder ?? null;
    } catch {
      return null;
    }
  }

  /** 2026-05-20 — GET /api/me → préférences contours isolignes pour sync
   *  multi-device. Structure : {sst, wind, wave} × {show, interval, color}.
   *  NULL = jamais set côté DB → fallback localStorage. */
  async fetchMyContourPrefs(): Promise<Record<string, { show?: boolean; interval?: number; color?: string }> | null> {
    try {
      const res = await firstValueFrom(this.http.get<MeResponse>('/api/me'));
      return (res.user as { contourPrefs?: Record<string, { show?: boolean; interval?: number; color?: string }> })?.contourPrefs ?? null;
    } catch {
      return null;
    }
  }

  /** 2026-05-20 — push debounced (500ms) des prefs contours isolignes.
   *  PUT /api/me/contour-prefs — partial merge côté backend. */
  private contourPushTimer?: ReturnType<typeof setTimeout>;
  scheduleContourPrefsPush(prefs: Record<string, { show?: boolean; interval?: number; color?: string }>): void {
    if (this.contourPushTimer) clearTimeout(this.contourPushTimer);
    this.contourPushTimer = setTimeout(() => {
      this.contourPushTimer = undefined;
      this.http.put('/api/me/contour-prefs', prefs).subscribe({
        error: () => { /* silent — localStorage source */ },
      });
    }, this.DEBOUNCE_MS);
  }

  /** APEX 18 — push debounced (700ms, plus long que le batch state pour
   *  ne pas spammer pendant un DnD multi-rangées). Idempotent côté backend. */
  private orderPushTimer?: ReturnType<typeof setTimeout>;
  private readonly ORDER_DEBOUNCE_MS = 700;
  scheduleLayerOrderPush(order: string[]): void {
    if (this.orderPushTimer) clearTimeout(this.orderPushTimer);
    this.orderPushTimer = setTimeout(() => {
      this.orderPushTimer = undefined;
      this.http.put('/api/me/layer-order', { order }).subscribe({
        error: () => {
          // Silent fail : localStorage reste la source canonique.
        },
      });
    }, this.ORDER_DEBOUNCE_MS);
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
    if (this.orderPushTimer) {
      clearTimeout(this.orderPushTimer);
      this.orderPushTimer = undefined;
    }
  }
}
