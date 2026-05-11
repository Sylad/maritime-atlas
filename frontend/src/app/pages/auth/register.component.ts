import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-register',
  imports: [FormsModule, RouterLink],
  template: `
    <div class="auth-shell">
      @if (registered()) {
        <div class="auth-card">
          <div class="auth-title">VÉRIFIE TON EMAIL</div>
          <div class="auth-sub">
            On vient d'envoyer un lien de vérification à <strong>{{ email }}</strong>.
            Click sur le lien dans le mail (valide 24h) pour activer ton compte,
            puis viens te connecter.
          </div>
          <button type="button" class="auth-cta" (click)="resend()" [disabled]="resending()">
            {{ resending() ? '…' : 'Renvoyer le mail' }}
          </button>
          @if (resendMsg()) { <div class="auth-info">{{ resendMsg() }}</div> }
          <a routerLink="/auth/login" class="auth-link">Aller à la connexion</a>
          <a routerLink="/" class="auth-back">← Retour à la carte</a>
        </div>
      } @else {
        <form class="auth-card" (submit)="$event.preventDefault(); submit()">
          <div class="auth-title">INSCRIPTION</div>
          <div class="auth-sub">Crée un compte pour personnaliser tes palettes</div>
          <label>Email
            <input type="email" autocomplete="email" required [(ngModel)]="email" name="email" />
          </label>
          <label>Nom d'utilisateur (3-30 chars, [a-z0-9_-])
            <input type="text" autocomplete="username" minlength="3" maxlength="30"
                   pattern="[a-zA-Z0-9_-]+" required
                   [(ngModel)]="username" name="username" />
          </label>
          <label>Mot de passe (≥8)
            <input type="password" autocomplete="new-password" minlength="8" required
                   [(ngModel)]="password" name="password" />
          </label>
          @if (errorMsg()) { <div class="auth-error">{{ errorMsg() }}</div> }
          <button type="submit" class="auth-cta" [disabled]="busy()">
            {{ busy() ? '…' : 'Créer le compte' }}
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

          <div class="auth-link">Déjà inscrit ? <a routerLink="/auth/login">Connexion</a></div>
          <a routerLink="/" class="auth-back">← Retour à la carte</a>
        </form>
      }
    </div>
  `,
  styleUrl: './auth.shared.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RegisterComponent {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  email = '';
  username = '';
  password = '';
  readonly busy = signal(false);
  readonly errorMsg = signal<string | null>(null);
  readonly registered = signal(false);
  readonly resending = signal(false);
  readonly resendMsg = signal<string | null>(null);

  async submit(): Promise<void> {
    this.busy.set(true);
    this.errorMsg.set(null);
    try {
      await this.auth.register(this.email.trim().toLowerCase(), this.username.trim().toLowerCase(), this.password);
      this.registered.set(true);
    } catch (err: any) {
      const msg = err?.error?.message
        ?? (err?.status === 409 ? 'Cet email ou nom d\'utilisateur est déjà pris' : 'Erreur inscription');
      this.errorMsg.set(Array.isArray(msg) ? msg.join(', ') : msg);
    } finally {
      this.busy.set(false);
    }
  }

  async resend(): Promise<void> {
    this.resending.set(true);
    this.resendMsg.set(null);
    try {
      const res = await this.auth.resendVerification(this.email);
      this.resendMsg.set(res.message);
    } catch {
      this.resendMsg.set('Impossible de renvoyer le mail. Réessaie plus tard.');
    } finally {
      this.resending.set(false);
    }
  }
}
