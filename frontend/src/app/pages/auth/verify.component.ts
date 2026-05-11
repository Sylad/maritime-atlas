import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { AuthService } from '../../services/auth.service';

/**
 * Landing page pour le lien envoyé par mail :
 *   https://maritime.sladoire.dev/auth/verify?token=<UUID>
 *
 * Affiche un loading puis success/error. Idempotent côté backend (déjà
 * vérifié = success silencieux).
 */
@Component({
  selector: 'app-verify',
  imports: [RouterLink],
  template: `
    <div class="auth-shell">
      <div class="auth-card">
        <div class="auth-title">VÉRIFICATION EMAIL</div>
        @if (busy()) {
          <div class="auth-sub">Vérification en cours…</div>
        } @else if (success()) {
          <div class="auth-sub">{{ msg() }}</div>
          <a routerLink="/auth/login" class="auth-cta auth-cta-link">Aller à la connexion</a>
        } @else {
          <div class="auth-error">{{ msg() || 'Lien invalide ou expiré.' }}</div>
          <a routerLink="/auth/register" class="auth-link">S'inscrire à nouveau</a>
        }
        <a routerLink="/" class="auth-back">← Retour à la carte</a>
      </div>
    </div>
  `,
  styleUrl: './auth.shared.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VerifyComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly auth = inject(AuthService);

  readonly busy = signal(true);
  readonly success = signal(false);
  readonly msg = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    const token = this.route.snapshot.queryParamMap.get('token');
    if (!token) {
      this.busy.set(false);
      this.msg.set('Lien invalide : token manquant.');
      return;
    }
    try {
      const res = await this.auth.verifyEmail(token);
      this.success.set(true);
      this.msg.set(res.message);
    } catch (err: any) {
      this.msg.set(err?.error?.message ?? 'Lien expiré ou déjà utilisé.');
    } finally {
      this.busy.set(false);
    }
  }
}
