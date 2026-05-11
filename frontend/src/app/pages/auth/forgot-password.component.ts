import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

/**
 * Phase B — Forgot password. Form qui POST /auth/forgot-password
 * avec l'email du user. Affiche un message générique succès/erreur
 * (le backend renvoie le même quoi qu'il arrive pour éviter
 * l'énumération de comptes).
 */
@Component({
  selector: 'app-forgot-password',
  imports: [FormsModule, RouterLink],
  template: `
    <div class="auth-shell">
      <form class="auth-card" (submit)="$event.preventDefault(); submit()">
        <div class="auth-title">MOT DE PASSE OUBLIÉ</div>
        <div class="auth-sub">
          Indique ton email — si un compte existe, tu recevras un lien
          de réinitialisation (valide 1h).
        </div>
        @if (sent()) {
          <div class="auth-info">{{ msg() }}</div>
          <a routerLink="/auth/login" class="auth-link">Retour à la connexion</a>
        } @else {
          <label>Email
            <input type="email" autocomplete="email" required
                   [(ngModel)]="email" name="email" />
          </label>
          @if (errorMsg()) { <div class="auth-error">{{ errorMsg() }}</div> }
          <button type="submit" class="auth-cta" [disabled]="busy()">
            {{ busy() ? '…' : 'Envoyer le lien' }}
          </button>
          <a routerLink="/auth/login" class="auth-link">← Retour à la connexion</a>
        }
        <a routerLink="/" class="auth-back">← Retour à la carte</a>
      </form>
    </div>
  `,
  styleUrl: './auth.shared.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ForgotPasswordComponent {
  private readonly http = inject(HttpClient);

  email = '';
  readonly busy = signal(false);
  readonly errorMsg = signal<string | null>(null);
  readonly sent = signal(false);
  readonly msg = signal<string | null>(null);

  async submit(): Promise<void> {
    this.busy.set(true);
    this.errorMsg.set(null);
    try {
      const res = await firstValueFrom(
        this.http.post<{ message: string }>('/api/auth/forgot-password', { email: this.email.trim().toLowerCase() }),
      );
      this.msg.set(res.message);
      this.sent.set(true);
    } catch (err: any) {
      this.errorMsg.set(err?.error?.message ?? 'Erreur — réessaie plus tard');
    } finally {
      this.busy.set(false);
    }
  }
}
