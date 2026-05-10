import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export interface PaletteStop {
  quantity: number;
  color: string;
  opacity: number;
  label?: string;
}

export type LayerKind = 'sst' | 'wind' | 'waves' | 'wave-dir';

export interface Palette {
  id: number;
  userId: number;
  name: string;
  slug: string;
  layerKind: LayerKind;
  stops: PaletteStop[];
  opacity: number;
}

export interface PalettePayload {
  name: string;
  layerKind: LayerKind;
  stops: PaletteStop[];
  opacity?: number;
}

export interface MyContext {
  user: { id: number; email: string };
  palettes: Palette[];
  preferences: Array<{ layerKind: LayerKind; paletteId: number | null; styleName: string | null }>;
}

@Injectable({ providedIn: 'root' })
export class PalettesService {
  private readonly http = inject(HttpClient);

  /** Mes palettes (rafraichies au login + après chaque mutation). */
  readonly myPalettes = signal<Palette[]>([]);
  /** Mapping layerKind → styleName?, peuplé via /api/me. */
  readonly myPreferences = signal<Record<string, string | null>>({});

  async loadMyContext(): Promise<MyContext> {
    const ctx = await firstValueFrom(this.http.get<MyContext>('/api/me'));
    this.myPalettes.set(ctx.palettes);
    const prefs: Record<string, string | null> = {};
    for (const p of ctx.preferences) prefs[p.layerKind] = p.styleName;
    this.myPreferences.set(prefs);
    return ctx;
  }

  async list(): Promise<Palette[]> {
    const ps = await firstValueFrom(this.http.get<Palette[]>('/api/palettes'));
    this.myPalettes.set(ps);
    return ps;
  }

  async create(payload: PalettePayload): Promise<Palette> {
    const p = await firstValueFrom(this.http.post<Palette>('/api/palettes', payload));
    await this.list();
    return p;
  }

  async update(id: number, payload: PalettePayload): Promise<Palette> {
    const p = await firstValueFrom(this.http.put<Palette>(`/api/palettes/${id}`, payload));
    await this.list();
    return p;
  }

  async remove(id: number): Promise<void> {
    await firstValueFrom(this.http.delete(`/api/palettes/${id}`));
    await this.list();
    // Reload context to clear any preference that referenced this palette.
    await this.loadMyContext();
  }

  async setPreference(layerKind: LayerKind, paletteId: number | null): Promise<void> {
    await firstValueFrom(this.http.put('/api/me/preferences', { layerKind, paletteId }));
    await this.loadMyContext();
  }

  /** Reset state on logout. */
  clear(): void {
    this.myPalettes.set([]);
    this.myPreferences.set({});
  }
}
