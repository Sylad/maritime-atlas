/**
 * Snapshot COMPLET et autonome de l'état de la carte /globe (2026-06-17).
 *
 * Sert deux usages :
 *  1. « Configurations de carte » nommées — un user connecté sauvegarde
 *     l'état courant du globe et le réapplique plus tard (cf
 *     MapConfigsPanelComponent + /api/map-configs).
 *  2. À terme, alimenter une widget « map » dans la page /dashboard.
 *
 * Volontairement AUTONOME (aucune FK) : tout ce qui décrit la carte est
 * embarqué inline pour que la suppression d'une palette ou la mutation
 * d'une autre ressource ne casse jamais une config sauvegardée.
 *
 * `version` permet une migration douce : tout ajout de champ doit rester
 * additif (les anciens snapshots restent lisibles), et un bump de version
 * déclenche une normalisation côté applyMapConfig().
 */
export interface MapConfigSnapshot {
  version: 1;
  view: {
    projection: 'globe' | 'mercator';
    center: { lng: number; lat: number };
    zoom: number;
    bearing: number;
    pitch: number;
  };
  layers: {
    /** Visibilité par clé de layer (sst, wind, lightning, …, + clés sat). */
    visibility: Record<string, boolean>;
    /** Opacité 0..1 par clé de layer. */
    opacities: Record<string, number>;
    /** Overlays isolignes (show-only ; intervalle/couleur fixés côté GeoServer
     *  pour l'instant — réservés à un futur contrôle UI). */
    contours: { sstContours: boolean; windContours: boolean; waveContours: boolean };
    /** Ordre z-index manuel + bascule auto/manuel. */
    zIndex: { autoEnabled: boolean; order: string[] };
    /**
     * RÉSERVÉ (v1 : non peuplé). Quand le globe exposera le choix de palette
     * par layer, on embarquera ici les stops inline (autonome, pas de FK
     * paletteId) : { sst: [{quantity,color,opacity,label?}], … }.
     */
    palettes?: Record<string, Array<{ quantity: number; color: string; opacity: number; label?: string }>>;
  };
  time: {
    /** Layer maître du temps (null = auto-pick côté globe). Aucun timestamp
     *  absolu n'est figé : à l'application, le curseur se cale sur la validité
     *  la plus proche de « maintenant ». */
    masterLayerKey: string | null;
  };
}

/** Métadonnées renvoyées par l'API pour une config sauvegardée. */
export interface MapConfig {
  id: number;
  name: string;
  snapshot: MapConfigSnapshot;
  createdAt: string;
  updatedAt: string;
}
