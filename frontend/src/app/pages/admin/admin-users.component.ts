import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { AdminUsersService, type AdminUser } from '../../services/admin-users.service';
import { AuthService } from '../../services/auth.service';

/**
 * Espace admin — table users + actions promote/demote/delete.
 *
 * Garde-fous UI :
 *  - Bouton "Demote" caché pour l'admin courant (server-side aussi check)
 *  - Bouton "Delete" demande confirmation native + caché pour soi-même
 *  - Indicateur visuel "Tu" sur la ligne du current user
 */
@Component({
  selector: 'app-admin-users',
  imports: [DatePipe, RouterLink],
  template: `
    <div class="admin-shell">
      <header class="admin-header">
        <h1>Gestion utilisateurs</h1>
        <a routerLink="/" class="admin-back">← Carte</a>
      </header>

      @if (service.loading()) {
        <div class="admin-loading">Chargement…</div>
      } @else if (service.errorMsg()) {
        <div class="admin-error">{{ service.errorMsg() }}</div>
      } @else {
        <div class="admin-stats">
          <span>{{ service.users().length }} utilisateur(s)</span>
          <span>·</span>
          <span>{{ adminCount() }} admin</span>
          <span>·</span>
          <span>{{ verifiedCount() }} vérifié(s)</span>
        </div>

        <div class="admin-table-wrap">
          <table class="admin-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Username</th>
                <th>Email</th>
                <th>Rôle</th>
                <th>Vérifié</th>
                <th>Dernière connex.</th>
                <th>Créé</th>
                <th class="admin-actions-col">Actions</th>
              </tr>
            </thead>
            <tbody>
              @for (u of service.users(); track u.id) {
                <tr [class.is-self]="u.id === selfId()">
                  <td class="mono">{{ u.id }}</td>
                  <td><strong>{{ u.username }}</strong>@if (u.id === selfId()) { <span class="self-tag">tu</span> }</td>
                  <td class="mono">{{ u.email }}</td>
                  <td>
                    <span class="role-pill" [class.role-admin]="u.role === 'admin'">{{ u.role }}</span>
                  </td>
                  <td>
                    @if (u.emailVerifiedAt) {
                      <span class="ok" [title]="u.emailVerifiedAt">✓</span>
                    } @else {
                      <span class="ko" title="Pas encore vérifié">✗</span>
                    }
                  </td>
                  <td class="mono">
                    {{ u.lastLoginAt ? (u.lastLoginAt | date:'dd/MM HH:mm') : '—' }}
                  </td>
                  <td class="mono">{{ u.createdAt | date:'dd/MM/yy' }}</td>
                  <td class="admin-actions-col">
                    @if (u.role === 'user') {
                      <button type="button" class="btn btn-promote" (click)="promote(u)">Promote</button>
                    } @else if (u.id !== selfId()) {
                      <button type="button" class="btn btn-demote" (click)="demote(u)">Demote</button>
                    }
                    @if (u.id !== selfId()) {
                      <button type="button" class="btn btn-danger" (click)="del(u)">Suppr</button>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </div>
  `,
  styles: `
    :host { display: block; min-height: 100vh; background: var(--bg); color: var(--fg); padding: 1.5em; font-family: var(--font-sans); }
    .admin-header { display: flex; align-items: baseline; gap: 1em; justify-content: space-between; margin-bottom: 1em; }
    .admin-header h1 { margin: 0; font-size: 1.4rem; font-weight: 600; color: var(--accent-bright); font-family: var(--font-mono); letter-spacing: 0.05em; }
    .admin-back { color: var(--fg-muted); text-decoration: none; font-size: 0.85rem; &:hover { color: var(--accent-bright); } }
    .admin-stats { display: flex; gap: 0.6em; font-size: 0.8rem; color: var(--fg-muted); font-family: var(--font-mono); margin-bottom: 1em; }
    .admin-loading, .admin-error { padding: 1em; color: var(--fg-muted); }
    .admin-error { color: var(--negative); border: 1px solid rgba(239,68,68,0.4); border-radius: 6px; background: rgba(239,68,68,0.08); }
    .admin-table-wrap { background: rgb(15, 23, 42); border: 1px solid hsl(224 85% 55% / 0.5); border-radius: 8px; overflow-x: auto; box-shadow: 0 8px 24px -4px rgba(0,0,0,0.7); }
    .admin-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
    .admin-table th { text-align: left; padding: 0.7em 0.8em; background: var(--bg-3); color: var(--fg-muted); font-weight: 600; font-family: var(--font-mono); font-size: 0.7rem; letter-spacing: 0.08em; text-transform: uppercase; border-bottom: 1px solid var(--border); }
    .admin-table td { padding: 0.6em 0.8em; border-bottom: 1px solid var(--border); }
    .admin-table tr.is-self { background: hsl(224 80% 30% / 0.08); }
    .admin-table tr:hover { background: hsl(224 80% 30% / 0.15); }
    .mono { font-family: var(--font-mono); font-size: 0.78rem; }
    .self-tag { margin-left: 0.4em; padding: 1px 5px; border-radius: 3px; background: var(--accent); color: var(--bg); font-size: 0.65rem; letter-spacing: 0.1em; font-family: var(--font-mono); }
    .role-pill { display: inline-block; padding: 2px 8px; border-radius: 3px; background: var(--bg-3); color: var(--fg-muted); font-size: 0.7rem; font-family: var(--font-mono); letter-spacing: 0.1em; text-transform: uppercase; }
    .role-pill.role-admin { background: var(--accent-bright); color: var(--bg); font-weight: 600; }
    .ok { color: var(--accent-bright); font-weight: 600; }
    .ko { color: var(--negative); font-weight: 600; }
    .admin-actions-col { width: 1px; white-space: nowrap; }
    .btn { padding: 4px 10px; margin-right: 0.3em; border: 1px solid var(--border); background: var(--bg-3); color: var(--fg-muted); border-radius: 4px; cursor: pointer; font-size: 0.72rem; font-family: var(--font-mono); transition: all 150ms; }
    .btn:hover { color: var(--fg); border-color: var(--accent); }
    .btn-promote:hover { border-color: var(--accent-bright); color: var(--accent-bright); }
    .btn-demote:hover { border-color: var(--warning); color: var(--warning); }
    .btn-danger:hover { border-color: var(--negative); color: var(--negative); }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminUsersComponent implements OnInit {
  protected readonly service = inject(AdminUsersService);
  private readonly auth = inject(AuthService);

  readonly selfId = computed(() => this.auth.currentUser()?.id ?? -1);
  readonly adminCount = computed(() => this.service.users().filter((u) => u.role === 'admin').length);
  readonly verifiedCount = computed(() => this.service.users().filter((u) => u.emailVerifiedAt !== null).length);

  ngOnInit(): void {
    this.service.load();
  }

  async promote(u: AdminUser): Promise<void> {
    await this.service.setRole(u.id, 'admin');
  }

  async demote(u: AdminUser): Promise<void> {
    if (!confirm(`Rétrograder ${u.username} en simple user ?`)) return;
    await this.service.setRole(u.id, 'user');
  }

  async del(u: AdminUser): Promise<void> {
    if (!confirm(`Supprimer DÉFINITIVEMENT ${u.username} (${u.email}) ?\n\nLes palettes et préférences de ce user seront aussi supprimées (cascade).`)) return;
    await this.service.deleteUser(u.id);
  }
}
