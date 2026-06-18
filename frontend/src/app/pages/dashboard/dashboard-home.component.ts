import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { AppNavComponent } from '../../components/app-nav/app-nav.component';
import { AuthService } from '../../services/auth.service';
import { DashboardsService } from '../../services/dashboards.service';
import type { Dashboard } from '../../models/dashboard.model';

/**
 * Page Accueil `/` (Phase 3) — gestionnaire/sélecteur de dashboards.
 *  - Anonyme : dashboard par défaut (s'il existe) + liste des publics.
 *  - Connecté : « Mes tableaux de bord » (créer/ouvrir/supprimer/public) + publics.
 *  - Admin : bouton « Définir par défaut » sur les dashboards publics.
 * Le rendu des widgets se fait dans DashboardViewComponent (/dashboard/:id).
 */
@Component({
  selector: 'app-dashboard-home',
  standalone: true,
  imports: [AppNavComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-nav />
    <main class="home">
      @if (error()) { <p class="err">{{ error() }}</p> }

      @if (isAuthenticated()) {
        <section class="sec">
          <div class="sec-head">
            <h2>Mes tableaux de bord</h2>
            <button class="btn btn-primary" (click)="onCreate()" [disabled]="busy()">+ Nouveau</button>
          </div>
          @if (mine().length === 0) { <p class="empty">Aucun tableau de bord. Crées-en un.</p> }
          <div class="grid">
            @for (d of mine(); track d.id) {
              <div class="card" (click)="open(d)">
                <div class="card-top">
                  <span class="card-name">{{ d.name }}</span>
                  <span class="badges">
                    @if (d.isDefault) { <span class="badge badge-def">défaut</span> }
                    <span class="badge" [class.badge-pub]="d.isPublic">{{ d.isPublic ? 'public' : 'privé' }}</span>
                  </span>
                </div>
                <div class="card-sub">{{ d.widgets.length }} widget(s)</div>
                <div class="card-actions" (click)="$event.stopPropagation()">
                  <button class="btn" (click)="open(d)">Ouvrir</button>
                  <button class="btn" (click)="toggleVisibility(d)" [disabled]="busy() || (d.isDefault && d.isPublic)"
                          [title]="d.isDefault ? 'Un dashboard par défaut reste public' : ''">
                    {{ d.isPublic ? 'Rendre privé' : 'Rendre public' }}
                  </button>
                  <button class="btn btn-danger" (click)="remove(d)" [disabled]="busy()">Supprimer</button>
                </div>
              </div>
            }
          </div>
        </section>
      }

      <section class="sec">
        <h2>{{ isAuthenticated() ? 'Tableaux publics' : 'Tableaux de bord' }}</h2>
        @if (defaultDash(); as def) {
          <div class="card card-feature" (click)="open(def)">
            <div class="card-top">
              <span class="card-name">⭐ {{ def.name }}</span>
              <span class="badge badge-def">défaut</span>
            </div>
            <div class="card-sub">{{ def.widgets.length }} widget(s)</div>
          </div>
        }
        @if (publics().length === 0 && !defaultDash()) { <p class="empty">Aucun tableau public pour le moment.</p> }
        <div class="grid">
          @for (d of otherPublics(); track d.id) {
            <div class="card" (click)="open(d)">
              <div class="card-top">
                <span class="card-name">{{ d.name }}</span>
                @if (d.isDefault) { <span class="badge badge-def">défaut</span> }
              </div>
              <div class="card-sub">{{ d.widgets.length }} widget(s)</div>
              @if (isAdmin() && !d.isDefault) {
                <div class="card-actions" (click)="$event.stopPropagation()">
                  <button class="btn" (click)="makeDefault(d)" [disabled]="busy()">Définir par défaut</button>
                </div>
              }
            </div>
          }
        </div>
      </section>
    </main>
  `,
  styles: [`
    .home { padding: 1.5rem; background: #0b1220; min-height: calc(100vh - 44px); color: #e2e8f0; }
    .sec { margin-bottom: 2rem; }
    .sec-head { display: flex; align-items: center; justify-content: space-between; }
    h2 { font-size: 1.05rem; margin: 0 0 0.8rem; color: #cbd5e1; }
    .err { color: #fca5a5; }
    .empty { color: #64748b; font-style: italic; font-size: 0.9rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 1rem; }
    .card { background: #111c2e; border: 1px solid #1e293b; border-radius: 10px; padding: 0.9rem; cursor: pointer; transition: border-color 0.15s; }
    .card:hover { border-color: hsl(224 95% 60% / 0.5); }
    .card-feature { border-color: hsl(45 90% 55% / 0.4); background: hsl(45 60% 20% / 0.15); margin-bottom: 1rem; }
    .card-top { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
    .card-name { font-weight: 600; font-size: 0.95rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .card-sub { color: #64748b; font-size: 0.78rem; margin-top: 0.3rem; }
    .badges { display: flex; gap: 0.3rem; flex-shrink: 0; }
    .badge { font-size: 0.65rem; padding: 2px 7px; border-radius: 999px; background: #1e293b; color: #94a3b8; }
    .badge-pub { background: hsl(150 60% 30% / 0.4); color: #6ee7b7; }
    .badge-def { background: hsl(45 90% 50% / 0.25); color: #fcd34d; }
    .card-actions { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.7rem; }
    .btn { font-size: 0.78rem; padding: 0.35rem 0.7rem; border-radius: 6px; cursor: pointer; background: rgba(255,255,255,0.06); border: 1px solid #334155; color: #e2e8f0; }
    .btn:hover:not(:disabled) { background: rgba(255,255,255,0.12); }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-primary { background: hsl(224 80% 50% / 0.3); border-color: hsl(224 95% 60% / 0.5); color: #bfdbfe; }
    .btn-danger:hover:not(:disabled) { background: hsl(0 70% 45% / 0.35); }
  `],
})
export class DashboardHomeComponent {
  private readonly auth = inject(AuthService);
  private readonly service = inject(DashboardsService);
  private readonly router = inject(Router);

  readonly isAuthenticated = this.auth.isAuthenticated;
  readonly isAdmin = this.auth.isAdmin;

  readonly mine = signal<Dashboard[]>([]);
  readonly publics = signal<Dashboard[]>([]);
  readonly defaultDash = signal<Dashboard | null>(null);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  /** Publics hors celui déjà mis en avant comme défaut. */
  otherPublics(): Dashboard[] {
    const defId = this.defaultDash()?.id;
    return this.publics().filter((d) => d.id !== defId);
  }

  constructor() { void this.load(); }

  private async load(): Promise<void> {
    this.error.set(null);
    try {
      const [pub, def] = await Promise.all([this.service.listPublic(), this.service.getDefault()]);
      this.publics.set(pub);
      this.defaultDash.set(def);
      if (this.isAuthenticated()) this.mine.set(await this.service.listMine());
    } catch {
      this.error.set('Chargement des tableaux de bord impossible.');
    }
  }

  open(d: Dashboard): void { void this.router.navigate(['/dashboard', d.id]); }

  async onCreate(): Promise<void> {
    const name = prompt('Nom du tableau de bord ?')?.trim();
    if (!name) return;
    await this.run(async () => {
      const d = await this.service.create(name);
      void this.router.navigate(['/dashboard', d.id], { queryParams: { edit: 1 } });
    });
  }

  async toggleVisibility(d: Dashboard): Promise<void> {
    await this.run(async () => { await this.service.setVisibility(d.id, !d.isPublic); await this.load(); });
  }

  async remove(d: Dashboard): Promise<void> {
    if (!confirm(`Supprimer « ${d.name} » ?`)) return;
    await this.run(async () => { await this.service.remove(d.id); await this.load(); });
  }

  async makeDefault(d: Dashboard): Promise<void> {
    await this.run(async () => { await this.service.setDefault(d.id); await this.load(); });
  }

  private async run(op: () => Promise<unknown>): Promise<void> {
    this.busy.set(true); this.error.set(null);
    try { await op(); }
    catch (e) { this.error.set((e as { error?: { message?: string } })?.error?.message ?? 'Erreur réseau'); }
    finally { this.busy.set(false); }
  }
}
