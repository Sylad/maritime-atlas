import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../services/auth.service';
import { PalettesService } from '../../services/palettes.service';

@Component({
  selector: 'app-register',
  imports: [FormsModule, RouterLink],
  template: `
    <div class="auth-shell">
      <form class="auth-card" (submit)="$event.preventDefault(); submit()">
        <div class="auth-title">INSCRIPTION</div>
        <div class="auth-sub">Crée un compte pour personnaliser tes palettes</div>
        <label>Email
          <input type="email" autocomplete="email" required [(ngModel)]="email" name="email" />
        </label>
        <label>Mot de passe (≥6)
          <input type="password" autocomplete="new-password" minlength="6" required [(ngModel)]="password" name="password" />
        </label>
        @if (errorMsg()) { <div class="auth-error">{{ errorMsg() }}</div> }
        <button type="submit" class="auth-cta" [disabled]="busy()">
          {{ busy() ? '…' : 'Créer le compte' }}
        </button>
        <div class="auth-link">Déjà inscrit ? <a routerLink="/auth/login">Connexion</a></div>
        <a routerLink="/" class="auth-back">← Retour à la carte</a>
      </form>
    </div>
  `,
  styleUrl: './auth.shared.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RegisterComponent {
  private readonly auth = inject(AuthService);
  private readonly palettes = inject(PalettesService);
  private readonly router = inject(Router);

  email = '';
  password = '';
  readonly busy = signal(false);
  readonly errorMsg = signal<string | null>(null);

  async submit(): Promise<void> {
    this.busy.set(true);
    this.errorMsg.set(null);
    try {
      await this.auth.register(this.email.trim(), this.password);
      await this.palettes.loadMyContext();
      this.router.navigate(['/']);
    } catch (err: any) {
      const msg = err?.error?.message
        ?? (err?.status === 409 ? 'Cet email est déjà utilisé' : 'Erreur inscription');
      this.errorMsg.set(Array.isArray(msg) ? msg.join(', ') : msg);
    } finally {
      this.busy.set(false);
    }
  }
}
