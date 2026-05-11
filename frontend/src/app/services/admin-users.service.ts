import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { Role } from './auth.service';

export interface AdminUser {
  id: number;
  email: string;
  username: string;
  role: Role;
  emailVerifiedAt: string | null;
  lastLoginAt: string | null;
  createdAt: string;
}

@Injectable({ providedIn: 'root' })
export class AdminUsersService {
  private readonly http = inject(HttpClient);

  readonly users = signal<AdminUser[]>([]);
  readonly loading = signal(false);
  readonly errorMsg = signal<string | null>(null);

  async load(): Promise<void> {
    this.loading.set(true);
    this.errorMsg.set(null);
    try {
      const list = await firstValueFrom(this.http.get<AdminUser[]>('/api/admin/users'));
      this.users.set(list);
    } catch (err: any) {
      this.errorMsg.set(err?.error?.message ?? 'Erreur chargement utilisateurs');
    } finally {
      this.loading.set(false);
    }
  }

  async setRole(id: number, role: Role): Promise<void> {
    const updated = await firstValueFrom(
      this.http.put<AdminUser>(`/api/admin/users/${id}`, { role }),
    );
    this.users.update((list) => list.map((u) => (u.id === id ? updated : u)));
  }

  async deleteUser(id: number): Promise<void> {
    await firstValueFrom(this.http.delete(`/api/admin/users/${id}`));
    this.users.update((list) => list.filter((u) => u.id !== id));
  }
}
