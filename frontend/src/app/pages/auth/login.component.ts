import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../services/auth.service';
import { PalettesService } from '../../services/palettes.service';

@Component({
  selector: 'app-login',
  imports: [FormsModule, RouterLink],
  template: `
    <div class="auth-shell">
      <form class="auth-card" (submit)="$event.preventDefault(); submit()">
        <div class="auth-title">CONNEXION</div>
        <div class="auth-sub">Email ou nom d'utilisateur</div>
        <label>Email ou nom d'utilisateur
          <input type="text" autocomplete="username" required
                 [(ngModel)]="identifier" name="identifier" />
        </label>
        <label>Mot de passe
          <input type="password" autocomplete="current-password" minlength="1" required
                 [(ngModel)]="password" name="password" />
        </label>
        @if (errorMsg()) { <div class="auth-error">{{ errorMsg() }}</div> }
        <button type="submit" class="auth-cta" [disabled]="busy()">
          {{ busy() ? '…' : 'Connexion' }}
        </button>

        <div class="auth-or"><span>ou</span></div>

        <a href="/api/auth/google" class="auth-cta auth-cta-google">
          <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84c-.21 1.12-.84 2.07-1.79 2.71v2.26h2.9c1.7-1.56 2.69-3.87 2.69-6.61z"/>
            <path fill="#34A853" d="M9 18c2.43 0 4.47-.81 5.96-2.18l-2.9-2.26c-.81.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.96v2.33C2.44 15.98 5.48 18 9 18z"/>
            <path fill="#FBBC05" d="M3.95 10.7A5.41 5.41 0 0 1 3.66 9c0-.59.1-1.17.29-1.7V4.96H.96A8.99 8.99 0 0 0 0 9c0 1.45.35 2.82.96 4.04l2.99-2.33z"/>
            <path fill="#EA4335" d="M9 3.58c1.32 0 2.51.46 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0 5.48 0 2.44 2.02.96 4.96L3.95 7.3C4.66 5.16 6.65 3.58 9 3.58z"/>
          </svg>
          Continuer avec Google
        </a>

        <div class="auth-link">Pas de compte ? <a routerLink="/auth/register">Inscris-toi</a></div>
        <a routerLink="/" class="auth-back">← Retour à la carte</a>
      </form>
    </div>
  `,
  styleUrl: './auth.shared.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LoginComponent {
  private readonly auth = inject(AuthService);
  private readonly palettes = inject(PalettesService);
  private readonly router = inject(Router);

  identifier = '';
  password = '';
  readonly busy = signal(false);
  readonly errorMsg = signal<string | null>(null);

  async submit(): Promise<void> {
    this.busy.set(true);
    this.errorMsg.set(null);
    try {
      await this.auth.login(this.identifier.trim().toLowerCase(), this.password);
      await this.palettes.loadMyContext();
      this.router.navigate(['/']);
    } catch (err: any) {
      // Backend renvoie 403 si email pas vérifié → message dédié.
      if (err?.status === 403) {
        this.errorMsg.set('Email pas encore vérifié. Vérifie ta boîte de réception.');
      } else {
        this.errorMsg.set(err?.error?.message ?? 'Identifiants invalides');
      }
    } finally {
      this.busy.set(false);
    }
  }
}
