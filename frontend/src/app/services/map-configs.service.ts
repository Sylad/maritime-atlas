import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { MapConfig, MapConfigSnapshot } from '../models/map-config-snapshot';

/**
 * CRUD des configurations de carte nommées (/api/map-configs). Réservé aux
 * users authentifiés (interceptor JWT + JwtAuthGuard côté API).
 */
@Injectable({ providedIn: 'root' })
export class MapConfigsService {
  private readonly http = inject(HttpClient);

  /** Mes configs (rafraîchies après chaque mutation). */
  readonly myConfigs = signal<MapConfig[]>([]);

  async list(): Promise<MapConfig[]> {
    const cs = await firstValueFrom(this.http.get<MapConfig[]>('/api/map-configs'));
    this.myConfigs.set(cs);
    return cs;
  }

  async create(name: string, snapshot: MapConfigSnapshot): Promise<MapConfig> {
    const c = await firstValueFrom(this.http.post<MapConfig>('/api/map-configs', { name, snapshot }));
    await this.list();
    return c;
  }

  async update(id: number, name: string, snapshot: MapConfigSnapshot): Promise<MapConfig> {
    const c = await firstValueFrom(this.http.put<MapConfig>(`/api/map-configs/${id}`, { name, snapshot }));
    await this.list();
    return c;
  }

  async remove(id: number): Promise<void> {
    await firstValueFrom(this.http.delete(`/api/map-configs/${id}`));
    await this.list();
  }

  /** Reset state on logout. */
  clear(): void {
    this.myConfigs.set([]);
  }
}
