import { ChangeDetectionStrategy, Component, inject, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MapConfigsService } from '../../services/map-configs.service';
import type { MapConfig } from '../../models/map-config-snapshot';

/**
 * Panneau « Mes configurations de carte » (2026-06-17). Réservé aux users
 * connectés (monté derrière @if(isAuthenticated()) côté globe).
 *
 * Le panneau gère lui-même la liste + le rename + la suppression (via
 * MapConfigsService). Les actions qui ont besoin de l'état VIVANT de la carte
 * remontent au parent (globe) par events :
 *   - saveNew(name)     → globe.serializeMapConfig() puis create()
 *   - overwrite(config) → globe.serializeMapConfig() puis update()
 *   - apply(config)     → globe.applyMapConfig(config.snapshot)
 *
 * Visuel aligné sur AnimationPanel (modal sombre, accent cyan).
 */
@Component({
  selector: 'app-map-configs-panel',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="mc-backdrop" (click)="close.emit()"></div>

    <div class="mc-modal" role="dialog" aria-modal="true" aria-label="Mes configurations de carte">
      <header class="mc-head">
        <span class="mc-title">🗺 Mes configs</span>
        <button type="button" class="mc-close" (click)="close.emit()" aria-label="Fermer">×</button>
      </header>

      <div class="mc-body">
        <!-- Sauvegarder l'état courant -->
        <section class="mc-save">
          <input class="mc-input" type="text" maxlength="60" [(ngModel)]="newName"
                 placeholder="Nom de la config…" (keydown.enter)="onSaveNew()" />
          <button type="button" class="mc-btn mc-btn-primary"
                  [disabled]="!newName.trim() || busy()" (click)="onSaveNew()">
            💾 Sauvegarder l'état actuel
          </button>
        </section>

        @if (error()) { <p class="mc-error">{{ error() }}</p> }

        <!-- Liste -->
        <section class="mc-list">
          @if (configs().length === 0) {
            <p class="mc-empty">Aucune config sauvegardée pour l'instant.</p>
          }
          @for (c of configs(); track c.id) {
            <div class="mc-row">
              @if (editingId() === c.id) {
                <input class="mc-input mc-input-inline" type="text" maxlength="60" [(ngModel)]="editName"
                       (keydown.enter)="onRenameCommit(c)" (keydown.escape)="editingId.set(null)" />
                <div class="mc-actions">
                  <button type="button" class="mc-btn" (click)="onRenameCommit(c)" [disabled]="busy()">✓</button>
                  <button type="button" class="mc-btn" (click)="editingId.set(null)">×</button>
                </div>
              } @else {
                <div class="mc-meta">
                  <span class="mc-name" [title]="c.name">{{ c.name }}</span>
                  <small class="mc-date">maj {{ c.updatedAt | date:'dd/MM HH:mm' }}</small>
                </div>
                <div class="mc-actions">
                  <button type="button" class="mc-btn mc-btn-primary" (click)="apply.emit(c)" title="Afficher cette config">Appliquer</button>
                  <button type="button" class="mc-btn" (click)="overwrite.emit(c)" [disabled]="busy()" title="Remplacer par l'état actuel">Écraser</button>
                  <button type="button" class="mc-btn" (click)="startRename(c)" title="Renommer">✎</button>
                  <button type="button" class="mc-btn mc-btn-danger" (click)="onDelete(c)" [disabled]="busy()" title="Supprimer">🗑</button>
                </div>
              }
            </div>
          }
        </section>
      </div>
    </div>
  `,
  styles: [`
    :host { position: fixed; inset: 0; z-index: 1000; pointer-events: none; }
    .mc-backdrop {
      position: absolute; inset: 0; background: rgba(0,0,0,0.55);
      backdrop-filter: blur(4px); pointer-events: auto; animation: fade 180ms ease-out;
    }
    .mc-modal {
      position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
      width: min(460px, 94vw); max-height: 88vh; overflow-y: auto;
      background: rgb(15, 23, 42); border: 1px solid hsl(224 85% 55% / 0.5); border-radius: 10px;
      box-shadow: 0 0 0 1px hsl(224 95% 60% / 0.2), 0 0 16px 1px hsl(224 95% 60% / 0.26),
        0 0 40px 6px hsl(224 90% 55% / 0.18), 0 14px 40px -10px rgba(0,0,0,0.8);
      pointer-events: auto; animation: pop 220ms cubic-bezier(0.2,0.9,0.3,1.1);
      color: var(--fg, #e8e6e3); font-family: inherit;
    }
    @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
    @keyframes pop {
      from { opacity: 0; transform: translate(-50%, -46%) scale(0.96); }
      to   { opacity: 1; transform: translate(-50%, -50%) scale(1); }
    }
    .mc-head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 0.9em 1.2em; border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    .mc-title {
      font-family: var(--font-mono, monospace); font-size: 0.85rem; letter-spacing: 0.15em;
      color: var(--accent, #67e8f9); text-transform: uppercase; font-weight: 700;
    }
    .mc-close { background: transparent; border: 0; color: var(--fg-muted, #a8a29e); font-size: 1.4rem; cursor: pointer; line-height: 1; padding: 0 0.2em; }
    .mc-close:hover { color: var(--fg, #e8e6e3); }
    .mc-body { padding: 1.2em; display: flex; flex-direction: column; gap: 1em; }
    .mc-save { display: flex; flex-direction: column; gap: 0.5em; }
    .mc-input {
      width: 100%; box-sizing: border-box; padding: 0.55em 0.7em; border-radius: 6px;
      background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.12);
      color: var(--fg, #e8e6e3); font-family: inherit; font-size: 0.9rem;
    }
    .mc-input:focus { outline: none; border-color: hsl(224 95% 60% / 0.7); }
    .mc-input-inline { flex: 1; }
    .mc-error { color: #fca5a5; font-size: 0.8rem; margin: 0; }
    .mc-empty { color: var(--fg-muted, #a8a29e); font-size: 0.85rem; font-style: italic; margin: 0.3em 0; }
    .mc-list { display: flex; flex-direction: column; gap: 0.45em; }
    .mc-row {
      display: flex; align-items: center; justify-content: space-between; gap: 0.6em;
      padding: 0.5em 0.65em; border-radius: 7px; background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.07);
    }
    .mc-meta { display: flex; flex-direction: column; min-width: 0; }
    .mc-name { font-weight: 600; font-size: 0.92rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .mc-date { color: var(--fg-muted, #a8a29e); font-size: 0.68rem; }
    .mc-actions { display: flex; gap: 0.3em; flex-shrink: 0; }
    .mc-btn {
      padding: 0.35em 0.6em; border-radius: 6px; cursor: pointer; font-size: 0.78rem;
      background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); color: var(--fg, #e8e6e3);
    }
    .mc-btn:hover:not(:disabled) { background: rgba(255,255,255,0.12); }
    .mc-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .mc-btn-primary { background: hsl(224 80% 50% / 0.25); border-color: hsl(224 95% 60% / 0.55); color: #bfdbfe; }
    .mc-btn-primary:hover:not(:disabled) { background: hsl(224 80% 55% / 0.40); }
    .mc-btn-danger:hover:not(:disabled) { background: hsl(0 70% 45% / 0.35); border-color: hsl(0 80% 60% / 0.5); }
  `],
})
export class MapConfigsPanelComponent {
  private readonly service = inject(MapConfigsService);

  readonly close = output<void>();
  /** Demande de sauvegarde d'une NOUVELLE config (le globe sérialise l'état). */
  readonly saveNew = output<string>();
  /** Demande d'écrasement d'une config existante par l'état courant. */
  readonly overwrite = output<MapConfig>();
  /** Demande d'application d'une config sur la carte. */
  readonly apply = output<MapConfig>();

  readonly configs = this.service.myConfigs;
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly editingId = signal<number | null>(null);

  newName = '';
  editName = '';

  onSaveNew(): void {
    const name = this.newName.trim();
    if (!name) return;
    this.error.set(null);
    this.saveNew.emit(name);
    this.newName = '';
  }

  startRename(c: MapConfig): void {
    this.editName = c.name;
    this.editingId.set(c.id);
  }

  async onRenameCommit(c: MapConfig): Promise<void> {
    const name = this.editName.trim();
    if (!name || name === c.name) { this.editingId.set(null); return; }
    await this.run(() => this.service.update(c.id, name, c.snapshot));
    this.editingId.set(null);
  }

  async onDelete(c: MapConfig): Promise<void> {
    if (!confirm(`Supprimer la config « ${c.name} » ?`)) return;
    await this.run(() => this.service.remove(c.id));
  }

  private async run(op: () => Promise<unknown>): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await op();
    } catch (e) {
      this.error.set((e as { error?: { message?: string } })?.error?.message ?? 'Erreur réseau');
    } finally {
      this.busy.set(false);
    }
  }
}
