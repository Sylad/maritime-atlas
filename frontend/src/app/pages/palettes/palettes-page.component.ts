import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { PalettesService, type Palette, type PaletteStop, type LayerKind } from '../../services/palettes.service';
import { PaletteEditorComponent } from '../../components/palette-editor/palette-editor.component';
import { ZonePreviewComponent } from '../../components/zone-preview/zone-preview.component';
import { MAP_ZONES, findZone, DEFAULT_ZONE_ID } from '../../services/map-zones';
import { MAP_PROJECTIONS, DEFAULT_PROJECTION } from '../../services/map-projections';

@Component({
  selector: 'app-palettes-page',
  imports: [RouterLink, PaletteEditorComponent, ZonePreviewComponent],
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
        <!-- Phase C.3 (2026-05-12) : zone d'arrivée. Sauvegardée en DB,
             utilisée au boot de la carte (DB > localStorage > 'france'). -->
        <section class="zone-section">
          <h2>Zone d'arrivée par défaut</h2>
          <p class="zone-hint">Quand tu ouvres la carte, voici la zone sur laquelle tu atterris. Modifiable à tout moment.</p>
          <div class="zone-layout">
            <ul class="zone-list">
              @for (z of zones; track z.id) {
                <li>
                  <button type="button"
                          class="zone-btn"
                          [class.active]="selectedZoneId() === z.id"
                          (click)="selectZone(z.id)">
                    {{ z.label }}
                  </button>
                </li>
              }
            </ul>
            <div class="zone-preview-wrap">
              <app-zone-preview [zoneId]="selectedZoneId()" />
              @if (zoneSaveMsg()) {
                <div class="zone-save-msg" [class.error]="zoneSaveError()">{{ zoneSaveMsg() }}</div>
              }
            </div>
          </div>
        </section>

        <!-- Phase C.4 (2026-05-12) : projection OL. Sauvegardée en DB.
             Le changement nécessite un reload de la page (la map ne se
             reconstruit pas en runtime). -->
        <section class="projection-section">
          <h2>Projection cartographique</h2>
          <p class="projection-hint">Type de projection utilisé pour le rendu de la carte. Le changement nécessite un reload de la page.</p>
          <div class="projection-radios">
            @for (p of projections; track p.code) {
              <label class="projection-radio" [class.active]="selectedProjection() === p.code">
                <input type="radio" name="projection"
                       [value]="p.code"
                       [checked]="selectedProjection() === p.code"
                       (change)="selectProjection(p.code)" />
                <div>
                  <div class="proj-label">{{ p.label }}</div>
                  <div class="proj-desc">{{ p.desc }}</div>
                </div>
              </label>
            }
          </div>
          <div class="projection-warning">
            ⚠ L'orientation visuelle des vents change selon la projection (méridiens parallèles
            en Mercator, convergents en Lambert). Les rasters WMS (vent / vagues / SST) sont
            reprojetés à la volée par GeoServer — léger surcoût CPU côté serveur en EPSG:3035.
          </div>
          @if (projectionSaveMsg()) {
            <div class="projection-save-msg" [class.error]="projectionSaveError()">{{ projectionSaveMsg() }}</div>
          }
        </section>

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

  // ─── Phase C.3 : zone d'arrivée ─────────────────────────────────────
  readonly zones = MAP_ZONES;
  readonly selectedZoneId = signal<string>(DEFAULT_ZONE_ID);
  readonly zoneSaveMsg = signal<string | null>(null);
  readonly zoneSaveError = signal<boolean>(false);

  // ─── Phase C.4 : projection ─────────────────────────────────────────
  readonly projections = MAP_PROJECTIONS;
  readonly selectedProjection = signal<string>(DEFAULT_PROJECTION);
  readonly projectionSaveMsg = signal<string | null>(null);
  readonly projectionSaveError = signal<boolean>(false);

  ngOnInit(): void {
    this.palettesSvc.loadMyContext().catch((e) => this.errorMsg.set(`Chargement: ${e?.message ?? e}`));
    // Hydrate depuis le user actuel (UserPublic returned by /auth/me).
    const u = this.user();
    if (u?.defaultZone) this.selectedZoneId.set(u.defaultZone);
    if (u?.preferredProjection) this.selectedProjection.set(u.preferredProjection);
  }

  async selectZone(id: string): Promise<void> {
    this.selectedZoneId.set(id);
    this.zoneSaveMsg.set(null);
    this.zoneSaveError.set(false);
    try {
      await this.palettesSvc.setDefaultZone(id);
      // Phase C.3 fix : push la valeur dans le signal + localStorage USER_KEY
      // pour que buildInitialView() de la map la lise au prochain boot.
      this.auth.patchCurrentUser({ defaultZone: id });
      const z = findZone(id);
      this.zoneSaveMsg.set(`Zone enregistrée : ${z.label}`);
      setTimeout(() => this.zoneSaveMsg.set(null), 3000);
    } catch (err: any) {
      this.zoneSaveError.set(true);
      this.zoneSaveMsg.set(`Erreur : ${err?.error?.message ?? err?.message ?? err}`);
    }
  }

  async selectProjection(code: string): Promise<void> {
    this.selectedProjection.set(code);
    this.projectionSaveMsg.set(null);
    this.projectionSaveError.set(false);
    try {
      await this.palettesSvc.setPreferredProjection(code);
      // Phase C.4 fix : push la valeur dans le signal + localStorage USER_KEY.
      // buildInitialView() lit currentUser.preferredProjection au boot map ;
      // sans ce patch, l'ancienne valeur du JWT login restait dans le signal
      // → projection jamais appliquée + radio reset sur l'ancienne valeur
      // au retour sur la page palettes.
      this.auth.patchCurrentUser({ preferredProjection: code });
      this.projectionSaveMsg.set('Projection enregistrée. Recharge la carte pour l\'appliquer.');
      setTimeout(() => this.projectionSaveMsg.set(null), 5000);
    } catch (err: any) {
      this.projectionSaveError.set(true);
      this.projectionSaveMsg.set(`Erreur : ${err?.error?.message ?? err?.message ?? err}`);
    }
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
