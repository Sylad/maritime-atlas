import { Injectable } from '@angular/core';

/**
 * Plafond global de cartes MapLibre VIVANTES (2026-06-17). Un navigateur ne
 * supporte qu'un nombre limité de contextes WebGL (~8-16). Un dashboard peut
 * contenir beaucoup de widgets carte → on garde au plus MAX_LIVE instances
 * réellement rendues (priorité aux visibles), les autres sont gelées en image
 * figée (cf MapViewComponent.freeze()). Stratégie d'éviction : LRU, en
 * préférant les cartes hors-écran.
 */
export interface LiveMapHandle {
  /** Gèle la carte (capture canvas → image, libère le contexte WebGL). */
  freeze(): void;
  /** true si la carte est actuellement hors du viewport. */
  isHidden(): boolean;
  /** true si la carte a rendu au moins une frame (gel = image non vide). */
  isRendered(): boolean;
}

export const MAX_LIVE_MAPS = 6;

@Injectable({ providedIn: 'root' })
export class MapViewRegistry {
  /** Ordre = ancienneté d'usage (index 0 = le moins récemment touché). */
  private readonly live: LiveMapHandle[] = [];

  /**
   * Demande à passer une carte en vivant. Si le plafond est atteint, gèle la
   * meilleure victime (hors-écran d'abord, sinon la plus ancienne). Retourne
   * true si le passage en vivant est autorisé.
   */
  requestLive(handle: LiveMapHandle): boolean {
    if (this.live.includes(handle)) { this.touch(handle); return true; }
    while (this.live.length >= MAX_LIVE_MAPS) {
      const victim = this.pickVictim(handle);
      if (!victim) break;
      this.remove(victim);
      victim.freeze();
    }
    this.live.push(handle);
    return true;
  }

  /** Marque une carte comme récemment utilisée (la protège de l'éviction). */
  touch(handle: LiveMapHandle): void {
    const i = this.live.indexOf(handle);
    if (i >= 0) { this.live.splice(i, 1); this.live.push(handle); }
  }

  /** Retire une carte du registre (sur gel ou destruction). */
  remove(handle: LiveMapHandle): void {
    const i = this.live.indexOf(handle);
    if (i >= 0) this.live.splice(i, 1);
  }

  /**
   * Victime d'éviction, par ordre de préférence (le gel d'une carte non encore
   * rendue donnerait une image vide, donc on l'évite tant qu'on peut) :
   *   1. hors-écran ET déjà rendue   2. déjà rendue   3. hors-écran   4. n'importe.
   */
  private pickVictim(exclude: LiveMapHandle): LiveMapHandle | null {
    const others = this.live.filter((h) => h !== exclude);
    return others.find((h) => h.isHidden() && h.isRendered())
      ?? others.find((h) => h.isRendered())
      ?? others.find((h) => h.isHidden())
      ?? others[0]
      ?? null;
  }
}
