import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';

/**
 * Phase B — Reset password landing. Le lien du mail Resend ouvre
 * `/auth/reset-password?token=<UUID>`. On affiche un form avec le
 * nouveau mot de passe (≥8 chars). POST /auth/reset-password retourne
 * un message confirmé puis on redirige user vers /auth/login.
 */
@Component({
  selector: 'app-reset-password',
  imports: [FormsModule, RouterLink],
  template: `
    <div class="auth-shell">
      <form class="auth-card" (submit)="$event.preventDefault(); submit()">
        <div class="auth-title">NOUVEAU MOT DE PASSE</div>
        @if (success()) {
          <div class="auth-info">{{ msg() }}</div>
          <a routerLink="/auth/login" class="auth-cta auth-cta-link">Aller à la connexion</a>
        } @else if (!token()) {
          <div class="auth-error">Lien invalide ou expiré (token manquant).</div>
          <a routerLink="/auth/forgot-password" class="auth-link">Demander un nouveau lien</a>
        } @else {
          <div class="auth-sub">
            Choisis un nouveau mot de passe (≥8 caractères).
          </div>
          <label>Nouveau mot de passe
            <input type="password" autocomplete="new-password" minlength="8" required
                   [(ngModel)]="newPassword" name="newPassword" />
          </label>
          <label>Confirme le mot de passe
            <input type="password" autocomplete="new-password" minlength="8" required
                   [(ngModel)]="confirmPassword" name="confirmPassword" />
          </label>
          @if (errorMsg()) { <div class="auth-error">{{ errorMsg() }}</div> }
          <button type="submit" class="auth-cta" [disabled]="busy() || !canSubmit()">
            {{ busy() ? '…' : 'Réinitialiser' }}
          </button>
        }
        <a routerLink="/" class="auth-back">← Retour à la carte</a>
      </form>
    </div>
  `,
  styleUrl: './auth.shared.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ResetPasswordComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly route = inject(ActivatedRoute);

  readonly token = signal<string | null>(null);
  newPassword = '';
  confirmPassword = '';
  readonly busy = signal(false);
  readonly errorMsg = signal<string | null>(null);
  readonly success = signal(false);
  readonly msg = signal<string | null>(null);

  ngOnInit(): void {
    this.token.set(this.route.snapshot.queryParamMap.get('token'));
  }

  canSubmit(): boolean {
    return this.newPassword.length >= 8 && this.newPassword === this.confirmPassword;
  }

  async submit(): Promise<void> {
    if (this.newPassword !== this.confirmPassword) {
      this.errorMsg.set('Les 2 mots de passe ne correspondent pas');
      return;
    }
    this.busy.set(true);
    this.errorMsg.set(null);
    try {
      const res = await firstValueFrom(
        this.http.post<{ message: string }>('/api/auth/reset-password', {
          token: this.token(),
          newPassword: this.newPassword,
        }),
      );
      this.msg.set(res.message);
      this.success.set(true);
    } catch (err: any) {
      this.errorMsg.set(err?.error?.message ?? 'Lien expiré ou invalide');
    } finally {
      this.busy.set(false);
    }
  }
}
