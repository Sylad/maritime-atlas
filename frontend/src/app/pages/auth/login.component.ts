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
