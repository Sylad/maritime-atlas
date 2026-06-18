import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { AuthService } from '../../services/auth.service';

/**
 * Barre de navigation partagée des pages NON-carte (Accueil dashboard, vue
 * dashboard…). Onglets [Accueil] [Carte] + coin auth. Le GlobeComponent garde
 * son propre header élaboré mais reçoit les mêmes onglets inline.
 */
@Component({
  selector: 'app-nav',
  standalone: true,
  imports: [RouterLink, RouterLinkActive],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="app-nav">
      <a class="brand" routerLink="/" aria-label="Accueil AetherWX">
        <img src="/AetherWX_logo_text.png" alt="AetherWX" class="brand-img" />
      </a>
      <nav class="tabs">
        <a routerLink="/" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }">Accueil</a>
        <a routerLink="/map" routerLinkActive="active">Carte</a>
      </nav>
      <div class="auth">
        <a routerLink="/about" class="lnk">À propos</a>
        @if (currentUser(); as u) {
          <a routerLink="/palettes" class="lnk">{{ '@' + u.username }}</a>
          @if (u.role === 'admin') { <a routerLink="/admin/users" class="lnk admin">ADMIN</a> }
          <button type="button" class="btn" (click)="logout()">Déconnexion</button>
        } @else {
          <a routerLink="/auth/login" class="lnk">Connexion</a>
          <a routerLink="/auth/register" class="lnk">Inscription</a>
        }
      </div>
    </header>
  `,
  styles: [`
    .app-nav {
      display: flex; align-items: center; gap: 1.2rem;
      padding: 0.6rem 1.2rem; background: #0b1220; border-bottom: 1px solid #1e293b;
      color: #e2e8f0; font-size: 0.85rem;
    }
    .brand-img { height: 26px; display: block; }
    .tabs { display: flex; gap: 0.4rem; }
    .tabs a {
      padding: 0.35rem 0.85rem; border-radius: 7px; color: #94a3b8; text-decoration: none; font-weight: 600;
    }
    .tabs a:hover { background: rgba(255,255,255,0.05); color: #e2e8f0; }
    .tabs a.active { background: hsl(224 80% 50% / 0.25); color: #bfdbfe; box-shadow: inset 0 0 0 1px hsl(224 95% 60% / 0.4); }
    .auth { margin-left: auto; display: flex; align-items: center; gap: 0.8rem; }
    .lnk { color: #94a3b8; text-decoration: none; }
    .lnk:hover { color: #e2e8f0; }
    .lnk.admin { color: #fca5a5; font-weight: 700; font-size: 0.75rem; letter-spacing: 0.05em; }
    .btn { background: transparent; border: 1px solid #334155; color: #cbd5e1; padding: 0.3rem 0.7rem; border-radius: 6px; cursor: pointer; }
    .btn:hover { background: rgba(255,255,255,0.06); }
  `],
})
export class AppNavComponent {
  private readonly auth = inject(AuthService);
  readonly currentUser = this.auth.currentUser;
  logout(): void { this.auth.logout(); }
}
