import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

const TOKEN_KEY = 'maritime.auth.token';
const USER_KEY = 'maritime.auth.user';

export interface AuthUser {
  id: number;
  email: string;
}

interface AuthResponse {
  token: string;
  user: AuthUser;
}

/**
 * Auth state local au frontend. Le token JWT vit en localStorage (24h
 * expiration côté backend). Sur boot, on rehydrate depuis localStorage et
 * expose un signal `currentUser`. La liste de signals laisse le map
 * component réagir aux login/logout sans subscription manuelle.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);

  readonly currentUser = signal<AuthUser | null>(this.loadUser());
  readonly isAuthenticated = computed(() => this.currentUser() !== null);

  getToken(): string | null {
    return localStorage.getItem(TOKEN_KEY);
  }

  async register(email: string, password: string): Promise<AuthUser> {
    const res = await firstValueFrom(
      this.http.post<AuthResponse>('/api/auth/register', { email, password }),
    );
    this.persist(res);
    return res.user;
  }

  async login(email: string, password: string): Promise<AuthUser> {
    const res = await firstValueFrom(
      this.http.post<AuthResponse>('/api/auth/login', { email, password }),
    );
    this.persist(res);
    return res.user;
  }

  logout(): void {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    this.currentUser.set(null);
  }

  private persist(res: AuthResponse): void {
    localStorage.setItem(TOKEN_KEY, res.token);
    localStorage.setItem(USER_KEY, JSON.stringify(res.user));
    this.currentUser.set(res.user);
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
