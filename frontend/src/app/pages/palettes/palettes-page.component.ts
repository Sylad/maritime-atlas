import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { PalettesService, type Palette, type PaletteStop, type LayerKind } from '../../services/palettes.service';
import { PaletteEditorComponent } from '../../components/palette-editor/palette-editor.component';

@Component({
  selector: 'app-palettes-page',
  imports: [RouterLink, PaletteEditorComponent],
  template: `
    <div class="page-shell">
      <header class="page-header">
        <a routerLink="/" class="back-link">← Carte</a>
        <h1>Mes palettes</h1>
        <div class="user">
          {{ user()?.email }}
          <button type="button" class="logout" (click)="logout()">Déconnexion</button>
        </div>
      </header>

      <main class="page-main">
        <section class="palettes-list">
          <div class="palettes-meta">
            <strong>{{ palettes().length }}</strong> / {{ MAX }} palettes
          </div>
          @if (palettes().length === 0) {
            <div class="empty">Pas encore de palette. Crée la première ci-dessous.</div>
          }
          <div class="cards">
            @for (p of palettes(); track p.id) {
              <div class="card">
                <div class="card-head">
                  <div class="card-name">{{ p.name }}</div>
                  <div class="card-layer">{{ layerLabel(p.layerKind) }}</div>
                </div>
                <div class="card-grad" [style.background]="gradientFor(p.stops)"></div>
                <div class="card-stops">{{ p.stops.length }} stops</div>
                <div class="card-actions">
                  <button type="button" (click)="edit(p)">Éditer</button>
                  <button type="button" class="danger" (click)="remove(p.id)">Supprimer</button>
                </div>
              </div>
            }
          </div>
        </section>

        <section class="editor-pane">
          <h2>{{ editing() ? 'Modifier' : 'Nouvelle palette' }}</h2>
          @if (canCreate() || editing()) {
            <app-palette-editor
              [initial]="editing()"
              (save)="onSave($event)"
              (cancel)="cancelEdit()" />
          } @else {
            <div class="limit-msg">Limite atteinte ({{ MAX }} palettes max). Supprime-en une pour en créer une nouvelle.</div>
          }
          @if (errorMsg()) { <div class="page-error">{{ errorMsg() }}</div> }
        </section>
      </main>
    </div>
  `,
  styleUrl: './palettes-page.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PalettesPageComponent {
  private readonly auth = inject(AuthService);
  private readonly palettesSvc = inject(PalettesService);
  private readonly router = inject(Router);

  readonly MAX = 5;
  readonly user = this.auth.currentUser;
  readonly palettes = this.palettesSvc.myPalettes;
  readonly editing = signal<Palette | null>(null);
  readonly errorMsg = signal<string | null>(null);

  readonly canCreate = computed(() => this.palettes().length < this.MAX && !this.editing());

  ngOnInit(): void {
    this.palettesSvc.loadMyContext().catch((e) => this.errorMsg.set(`Chargement: ${e?.message ?? e}`));
  }

  layerLabel(k: LayerKind): string {
    return ({ sst: 'SST', wind: 'Vent', waves: 'Vagues', 'wave-dir': 'Direction vagues' } as const)[k];
  }

  gradientFor(stops: PaletteStop[]): string {
    const sorted = [...stops].sort((a, b) => a.quantity - b.quantity);
    if (sorted.length < 2) return 'transparent';
    const min = sorted[0].quantity, max = sorted[sorted.length - 1].quantity;
    const span = max - min || 1;
    const css = sorted.map((s) => {
      const pct = ((s.quantity - min) / span) * 100;
      return `${this.hexToRgba(s.color, s.opacity)} ${pct.toFixed(1)}%`;
    });
    return `linear-gradient(to right, ${css.join(', ')})`;
  }

  edit(p: Palette): void { this.editing.set(p); }
  cancelEdit(): void { this.editing.set(null); }

  async onSave(payload: { name: string; layerKind: LayerKind; stops: PaletteStop[] }): Promise<void> {
    this.errorMsg.set(null);
    try {
      if (this.editing()) {
        await this.palettesSvc.update(this.editing()!.id, payload);
      } else {
        await this.palettesSvc.create(payload);
      }
      this.editing.set(null);
    } catch (err: any) {
      this.errorMsg.set(err?.error?.message ?? 'Erreur enregistrement');
    }
  }

  async remove(id: number): Promise<void> {
    if (!confirm('Supprimer cette palette ?')) return;
    await this.palettesSvc.remove(id);
  }

  logout(): void {
    this.auth.logout();
    this.palettesSvc.clear();
    this.router.navigate(['/auth/login']);
  }

  private hexToRgba(hex: string, opacity: number): string {
    const h = hex.replace('#', '');
    const expand = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const r = parseInt(expand.slice(0, 2), 16);
    const g = parseInt(expand.slice(2, 4), 16);
    const b = parseInt(expand.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${opacity})`;
  }
}
