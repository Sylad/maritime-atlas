import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { Dashboard, DashboardWidget } from '../models/dashboard.model';

/**
 * CRUD des dashboards (/api/dashboards). Lecture publique pour public/default/
 * :id (anonyme OK côté API) ; écritures réservées au propriétaire ; setDefault
 * réservé admin.
 */
@Injectable({ providedIn: 'root' })
export class DashboardsService {
  private readonly http = inject(HttpClient);

  readonly myDashboards = signal<Dashboard[]>([]);

  async listMine(): Promise<Dashboard[]> {
    const ds = await firstValueFrom(this.http.get<Dashboard[]>('/api/dashboards'));
    this.myDashboards.set(ds);
    return ds;
  }

  listPublic(): Promise<Dashboard[]> {
    return firstValueFrom(this.http.get<Dashboard[]>('/api/dashboards/public'));
  }

  getDefault(): Promise<Dashboard | null> {
    return firstValueFrom(this.http.get<Dashboard | null>('/api/dashboards/default'));
  }

  getOne(id: number): Promise<Dashboard> {
    return firstValueFrom(this.http.get<Dashboard>(`/api/dashboards/${id}`));
  }

  async create(name: string, widgets: DashboardWidget[] = []): Promise<Dashboard> {
    const d = await firstValueFrom(this.http.post<Dashboard>('/api/dashboards', { name, widgets }));
    await this.listMine();
    return d;
  }

  async update(id: number, name: string, widgets: DashboardWidget[]): Promise<Dashboard> {
    const d = await firstValueFrom(this.http.put<Dashboard>(`/api/dashboards/${id}`, { name, widgets }));
    await this.listMine();
    return d;
  }

  async remove(id: number): Promise<void> {
    await firstValueFrom(this.http.delete(`/api/dashboards/${id}`));
    await this.listMine();
  }

  async setVisibility(id: number, isPublic: boolean): Promise<Dashboard> {
    const d = await firstValueFrom(this.http.put<Dashboard>(`/api/dashboards/${id}/visibility`, { isPublic }));
    await this.listMine();
    return d;
  }

  /** Admin : marque un dashboard public comme défaut global. */
  setDefault(id: number): Promise<Dashboard> {
    return firstValueFrom(this.http.put<Dashboard>(`/api/dashboards/${id}/default`, {}));
  }

  clear(): void {
    this.myDashboards.set([]);
  }
}
