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
