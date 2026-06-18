import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import {
  DisplayGrid, GridsterComponent, GridsterConfig, GridsterItem,
  GridsterItemComponent, GridType,
} from 'angular-gridster2';
import { AppNavComponent } from '../../components/app-nav/app-nav.component';
import { MapViewComponent } from '../../components/map-view/map-view.component';
import { AuthService } from '../../services/auth.service';
import { DashboardsService } from '../../services/dashboards.service';
import { MapConfigsService } from '../../services/map-configs.service';
import type { Dashboard, DashboardWidget } from '../../models/dashboard.model';

interface ViewItem { widget: DashboardWidget; item: GridsterItem; }

/**
 * Page `/dashboard/:id` (Phase 3) — rend les widgets d'un dashboard dans une
 * grille angular-gridster2. Lecture seule par défaut ; le propriétaire peut
 * éditer (ajouter une widget carte depuis une config sauvegardée, déplacer/
 * redimensionner, supprimer, renommer, basculer public) puis enregistrer.
 *
 * Widget carte = MapViewComponent allégé (pas de chrome) alimenté par le
 * snapshot inline de la widget.
 */
@Component({
  selector: 'app-dashboard-view',
  standalone: true,
  imports: [AppNavComponent, GridsterComponent, GridsterItemComponent, MapViewComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-nav />
    @if (dashboard(); as d) {
      <div class="dv-toolbar">
        <span class="dv-title">{{ d.name }}</span>
        @if (d.isDefault) { <span class="badge badge-def">défaut</span> }
        <span class="badge" [class.badge-pub]="d.isPublic">{{ d.isPublic ? 'public' : 'privé' }}</span>
        <span class="spacer"></span>
        @if (isOwner()) {
          @if (editing()) {
            <button class="btn" (click)="openPicker()">+ Widget carte</button>
            <button class="btn" (click)="rename(d)">Renommer</button>
            <button class="btn" (click)="toggleVisibility(d)" [disabled]="busy() || (d.isDefault && d.isPublic)">
              {{ d.isPublic ? 'Rendre privé' : 'Rendre public' }}
            </button>
            <button class="btn btn-primary" (click)="save()" [disabled]="busy()">Enregistrer</button>
            <button class="btn" (click)="setEditing(false)">Terminer</button>
          } @else {
            <button class="btn btn-primary" (click)="setEditing(true)">Éditer</button>
          }
        }
      </div>

      @if (picker()) {
        <div class="dv-picker">
          <span class="dv-picker-label">Choisir une config de carte :</span>
          @if (mapConfigs().length === 0) { <span class="dv-picker-empty">Aucune config — crées-en depuis la carte.</span> }
          @for (c of mapConfigs(); track c.id) {
            <button class="btn" (click)="addMapWidget(c.id, c.name, c.snapshot)">{{ c.name }}</button>
          }
          <button class="btn btn-ghost" (click)="picker.set(false)">Annuler</button>
        </div>
      }

      <gridster [options]="options" class="dv-grid">
        @for (vi of items(); track vi.widget.id) {
          <gridster-item [item]="vi.item">
            <div class="widget">
              <div class="widget-head">
                <span>{{ vi.widget.config.title || 'Carte' }}</span>
                @if (editing()) { <button class="widget-x" (click)="removeWidget(vi)">×</button> }
              </div>
              <div class="widget-body">
                @if (vi.widget.config.snapshot) {
                  <app-map-view [snapshot]="vi.widget.config.snapshot" [interactive]="editing()" />
                } @else {
                  <div class="widget-empty">Widget non configurée</div>
                }
              </div>
            </div>
          </gridster-item>
        }
      </gridster>

      @if (items().length === 0) {
        <p class="dv-empty">{{ isOwner() ? 'Dashboard vide — passe en édition pour ajouter une widget.' : 'Ce dashboard est vide.' }}</p>
      }
    } @else if (error()) {
      <p class="dv-error">{{ error() }}</p>
    } @else {
      <p class="dv-loading">Chargement…</p>
    }
  `,
  styles: [`
    :host { display: block; background: #0b1220; min-height: 100vh; color: #e2e8f0; }
    .dv-toolbar { display: flex; align-items: center; gap: 0.6rem; padding: 0.6rem 1.2rem; border-bottom: 1px solid #1e293b; }
    .dv-title { font-weight: 700; font-size: 1rem; }
    .spacer { margin-left: auto; }
    .badge { font-size: 0.65rem; padding: 2px 7px; border-radius: 999px; background: #1e293b; color: #94a3b8; }
    .badge-pub { background: hsl(150 60% 30% / 0.4); color: #6ee7b7; }
    .badge-def { background: hsl(45 90% 50% / 0.25); color: #fcd34d; }
    .dv-picker { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; padding: 0.6rem 1.2rem; background: #111c2e; border-bottom: 1px solid #1e293b; }
    .dv-picker-label { color: #94a3b8; font-size: 0.85rem; }
    .dv-picker-empty { color: #64748b; font-style: italic; font-size: 0.82rem; }
    .dv-grid { display: block; width: 100%; height: calc(100vh - 96px); background: #0b1220; }
    .btn { font-size: 0.8rem; padding: 0.35rem 0.75rem; border-radius: 6px; cursor: pointer; background: rgba(255,255,255,0.06); border: 1px solid #334155; color: #e2e8f0; }
    .btn:hover:not(:disabled) { background: rgba(255,255,255,0.12); }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-primary { background: hsl(224 80% 50% / 0.3); border-color: hsl(224 95% 60% / 0.5); color: #bfdbfe; }
    .btn-ghost { background: transparent; }
    .widget { width: 100%; height: 100%; display: flex; flex-direction: column; background: #111c2e; border: 1px solid #1e293b; border-radius: 10px; overflow: hidden; }
    .widget-head { display: flex; align-items: center; justify-content: space-between; padding: 0.4rem 0.7rem; font-size: 0.78rem; color: #93c5fd; border-bottom: 1px solid #1e293b; }
    .widget-x { background: transparent; border: 0; color: #f87171; font-size: 1.1rem; line-height: 1; cursor: pointer; }
    .widget-body { flex: 1; min-height: 0; position: relative; }
    .widget-empty { display: flex; align-items: center; justify-content: center; height: 100%; color: #64748b; font-size: 0.85rem; }
    .dv-empty, .dv-loading, .dv-error { padding: 2rem; color: #64748b; }
    .dv-error { color: #fca5a5; }
  `],
})
export class DashboardViewComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly auth = inject(AuthService);
  private readonly service = inject(DashboardsService);
  private readonly mapCfgService = inject(MapConfigsService);

  readonly dashboard = signal<Dashboard | null>(null);
  readonly items = signal<ViewItem[]>([]);
  readonly editing = signal(false);
  readonly picker = signal(false);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly mapConfigs = this.mapCfgService.myConfigs;

  readonly isOwner = computed(() => {
    const d = this.dashboard();
    return !!d && this.auth.currentUser()?.id === d.userId;
  });

  options: GridsterConfig = {
    // Fit : la grille remplit la hauteur du conteneur (.dv-grid a une hauteur
    // explicite). VerticalFixed s'effondrait sans hauteur de conteneur.
    gridType: GridType.Fit,
    displayGrid: DisplayGrid.None,
    draggable: { enabled: false },
    resizable: { enabled: false },
    pushItems: true,
    minCols: 12, maxCols: 12, minRows: 8, margin: 10,
  };

  constructor() {
    const id = Number(this.route.snapshot.paramMap.get('id'));
    const wantEdit = this.route.snapshot.queryParamMap.get('edit') === '1';
    void this.load(id, wantEdit);
  }

  private async load(id: number, wantEdit: boolean): Promise<void> {
    try {
      const d = await this.service.getOne(id);
      this.dashboard.set(d);
      this.items.set(d.widgets.map((w) => ({ widget: structuredClone(w), item: { x: w.grid.x, y: w.grid.y, cols: w.grid.cols, rows: w.grid.rows } })));
      if (wantEdit && this.isOwner()) this.setEditing(true);
    } catch {
      this.error.set('Dashboard introuvable ou accès refusé.');
    }
  }

  setEditing(on: boolean): void {
    this.editing.set(on);
    this.options = {
      ...this.options,
      draggable: { enabled: on },
      resizable: { enabled: on },
      displayGrid: on ? DisplayGrid.Always : DisplayGrid.None,
    };
    this.options.api?.optionsChanged?.();
    if (!on) this.picker.set(false);
  }

  openPicker(): void {
    this.picker.set(true);
    if (this.mapConfigs().length === 0) void this.mapCfgService.list().catch(() => {});
  }

  addMapWidget(sourceMapConfigId: number, title: string, snapshot: DashboardWidget['config']['snapshot']): void {
    const nextY = this.items().reduce((m, vi) => Math.max(m, vi.item.y + vi.item.rows), 0);
    const widget: DashboardWidget = {
      id: crypto.randomUUID(),
      type: 'map',
      grid: { x: 0, y: nextY, cols: 4, rows: 4 },
      config: { title, snapshot, sourceMapConfigId },
    };
    this.items.update((arr) => [...arr, { widget, item: { x: 0, y: nextY, cols: 4, rows: 4 } }]);
    this.picker.set(false);
  }

  removeWidget(vi: ViewItem): void {
    this.items.update((arr) => arr.filter((x) => x !== vi));
  }

  async save(): Promise<void> {
    const d = this.dashboard();
    if (!d) return;
    const widgets: DashboardWidget[] = this.items().map((vi) => ({
      ...vi.widget,
      grid: { x: vi.item.x, y: vi.item.y, cols: vi.item.cols, rows: vi.item.rows },
    }));
    await this.run(async () => {
      const updated = await this.service.update(d.id, d.name, widgets);
      this.dashboard.set(updated);
    });
  }

  async rename(d: Dashboard): Promise<void> {
    const name = prompt('Nouveau nom ?', d.name)?.trim();
    if (!name || name === d.name) return;
    const widgets = this.currentWidgets();
    await this.run(async () => { this.dashboard.set(await this.service.update(d.id, name, widgets)); });
  }

  async toggleVisibility(d: Dashboard): Promise<void> {
    await this.run(async () => { this.dashboard.set(await this.service.setVisibility(d.id, !d.isPublic)); });
  }

  private currentWidgets(): DashboardWidget[] {
    return this.items().map((vi) => ({ ...vi.widget, grid: { x: vi.item.x, y: vi.item.y, cols: vi.item.cols, rows: vi.item.rows } }));
  }

  private async run(op: () => Promise<unknown>): Promise<void> {
    this.busy.set(true); this.error.set(null);
    try { await op(); }
    catch (e) { this.error.set((e as { error?: { message?: string } })?.error?.message ?? 'Erreur réseau'); }
    finally { this.busy.set(false); }
  }
}
