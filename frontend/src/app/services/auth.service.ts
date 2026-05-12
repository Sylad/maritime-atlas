import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

const TOKEN_KEY = 'maritime.auth.token';
const USER_KEY = 'maritime.auth.user';

export type Role = 'user' | 'admin';

export interface AuthUser {
  id: number;
  email: string;
  username: string;
  role: Role;
  /** Phase C.3 (2026-05-12) : zone d'arrivée préférée — slug ∈ MAP_ZONES.
   *  NULL = jamais choisi → fallback 'france'. */
  defaultZone?: string | null;
  /** Phase C.4 (2026-05-12) : projection préférée OL — code EPSG. */
  preferredProjection?: string | null;
}

interface LoginResponse {
  token: string;
  user: AuthUser & {
    emailVerifiedAt: string | null;
    lastLoginAt: string | null;
    createdAt: string;
    defaultZone?: string | null;
    preferredProjection?: string | null;
  };
}

interface RegisterResponse {
  message: string;
  verificationTokenSent: boolean;
}

/**
 * Auth state local au frontend.
 *
 * Sprint Auth refonte (Phase 2) :
 *  - register prend (email, username, password) et NE retourne PAS de
 *    token — le user doit vérifier son email d'abord (lien Resend).
 *    L'UI redirige vers /auth/verify-pending après register.
 *  - login prend (identifier, password) où identifier = email OU username.
 *  - currentUser inclut maintenant username + role (pour l'UI admin).
 *
 * Le token JWT vit en localStorage (24h expiration côté backend). Sur
 * boot, on rehydrate depuis localStorage et expose des signals.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);

  readonly currentUser = signal<AuthUser | null>(this.loadUser());
  readonly isAuthenticated = computed(() => this.currentUser() !== null);
  readonly isAdmin = computed(() => this.currentUser()?.role === 'admin');

  getToken(): string | null {
    return localStorage.getItem(TOKEN_KEY);
  }

  /** Crée un compte. Le user reçoit un mail Resend avec lien de vérification.
      L'UI doit afficher "vérifie ton email" et ne pas faire login auto. */
  async register(email: string, username: string, password: string): Promise<RegisterResponse> {
    return firstValueFrom(
      this.http.post<RegisterResponse>('/api/auth/register', { email, username, password }),
    );
  }

  /** identifier = email OU username. Backend choisit le bon champ via présence du @. */
  async login(identifier: string, password: string): Promise<AuthUser> {
    const res = await firstValueFrom(
      this.http.post<LoginResponse>('/api/auth/login', { identifier, password }),
    );
    this.persist(res);
    return res.user;
  }

  async verifyEmail(token: string): Promise<{ message: string }> {
    return firstValueFrom(
      this.http.get<{ message: string }>(`/api/auth/verify?token=${encodeURIComponent(token)}`),
    );
  }

  async resendVerification(email: string): Promise<{ message: string }> {
    return firstValueFrom(
      this.http.post<{ message: string }>('/api/auth/resend-verification', { email }),
    );
  }

  logout(): void {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    this.currentUser.set(null);
  }

  private persist(res: LoginResponse): void {
    localStorage.setItem(TOKEN_KEY, res.token);
    const user: AuthUser = {
      id: res.user.id,
      email: res.user.email,
      username: res.user.username,
      role: res.user.role,
      defaultZone: res.user.defaultZone ?? null,
      preferredProjection: res.user.preferredProjection ?? null,
    };
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    this.currentUser.set(user);
  }

  /** Phase C.3+C.4 (2026-05-12) : update partiel du user signal +
   *  localStorage USER_KEY, utilisé après les PUT /api/me/default-zone
   *  ou /preferred-projection pour que le signal currentUser reflète
   *  immédiatement la nouvelle pref sans nécessiter un re-login. */
  patchCurrentUser(patch: Partial<AuthUser>): void {
    const cur = this.currentUser();
    if (!cur) return;
    const next: AuthUser = { ...cur, ...patch };
    localStorage.setItem(USER_KEY, JSON.stringify(next));
    this.currentUser.set(next);
  }

  private loadUser(): AuthUser | null {
    try {
      const raw = localStorage.getItem(USER_KEY);
      return raw ? (JSON.parse(raw) as AuthUser) : null;
    } catch {
      return null;
    }
  }
}
