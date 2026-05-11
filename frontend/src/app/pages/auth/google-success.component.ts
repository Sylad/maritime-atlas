import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../services/auth.service';

/**
 * Landing post-callback Google OAuth. Le backend redirige vers
 *    /auth/google-success#token=<JWT>&created=<0|1>
 * en URL fragment (les fragments ne sont PAS envoyés au serveur — moins
 * de fuite logs).
 *
 * Comportement :
 *  - Parse le fragment, persiste le token via AuthService (re-using
 *    le pattern login.persist), fetch /auth/me pour récupérer le user,
 *    puis redirige vers / ou /palettes.
 *  - Si pas de token dans le fragment ou si /auth/me fail → affiche
 *    un message d'erreur + lien retour vers /auth/login.
 */
@Component({
  selector: 'app-google-success',
  imports: [RouterLink],
  template: `
    <div class="auth-shell">
      <div class="auth-card">
        <div class="auth-title">CONNEXION GOOGLE</div>
        @if (busy()) {
          <div class="auth-sub">Finalisation de la connexion…</div>
        } @else if (errorMsg()) {
          <div class="auth-error">{{ errorMsg() }}</div>
          <a routerLink="/auth/login" class="auth-link">← Retour à la connexion</a>
        }
      </div>
    </div>
  `,
  styleUrl: './auth.shared.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GoogleSuccessComponent implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);

  readonly busy = signal(true);
  readonly errorMsg = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    try {
      // Parse URL fragment : #token=...&created=0|1
      const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
      const params = new URLSearchParams(hash);
      const token = params.get('token');
      const created = params.get('created') === '1';
      if (!token) throw new Error('Token Google manquant dans la redirection');

      // Persiste le token + fetch /auth/me pour hydrater le signal currentUser
      localStorage.setItem('maritime.auth.token', token);
      const user = await firstValueFrom(
        this.http.get<{ id: number; email: string; username: string; role: 'user' | 'admin' }>('/api/auth/me'),
      );
      localStorage.setItem('maritime.auth.user', JSON.stringify({
        id: user.id, email: user.email, username: user.username, role: user.role,
      }));
      this.auth.currentUser.set({ id: user.id, email: user.email, username: user.username, role: user.role });

      // Nettoie le fragment (sécurité : token ne reste pas dans l'historique
      // browser avec back/forward). Replace au lieu de push pour qu'un click
      // back ne revienne pas sur cette page.
      window.history.replaceState({}, document.title, '/');
      // Redirige : nouveau compte → about (présentation), existant → carte.
      this.router.navigate([created ? '/about' : '/']);
    } catch (err: any) {
      this.errorMsg.set(err?.message ?? 'Erreur lors de la connexion Google');
      this.busy.set(false);
    }
  }
}
