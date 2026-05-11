import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';

/**
 * Route guard pour /admin/* — refuse l'accès si pas connecté OU pas admin.
 * Redirige vers /auth/login (si pas connecté) ou / (si user normal qui
 * tente d'accéder à un espace admin).
 */
export const adminGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const u = auth.currentUser();
  if (!u) {
    router.navigate(['/auth/login']);
    return false;
  }
  if (u.role !== 'admin') {
    router.navigate(['/']);
    return false;
  }
  return true;
};
