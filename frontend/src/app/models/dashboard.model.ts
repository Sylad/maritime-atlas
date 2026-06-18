import type { MapConfigSnapshot } from './map-config-snapshot';

/**
 * Widget d'un dashboard (2026-06-18). `type` ouvert (futurs 'image', …).
 * Pour 'map', `config.snapshot` embarque l'état carte inline (copié depuis une
 * config de carte sauvegardée) ; `sourceMapConfigId` garde la provenance.
 */
export interface DashboardWidget {
  id: string;
  type: 'map';
  /** Position/taille dans la grille gridster. */
  grid: { x: number; y: number; cols: number; rows: number };
  config: {
    title?: string;
    snapshot?: MapConfigSnapshot;
    sourceMapConfigId?: number;
  };
}

export interface Dashboard {
  id: number;
  userId: number;
  name: string;
  isPublic: boolean;
  isDefault: boolean;
  widgets: DashboardWidget[];
  createdAt: string;
  updatedAt: string;
}
