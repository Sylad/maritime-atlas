import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { AuthService } from '../services/auth.service';

/**
 * Functional interceptor : injecte `Authorization: Bearer <token>` sur les
 * requêtes /api/* uniquement (les requêtes /geoserver/* restent ouvertes,
 * elles ne touchent pas le backend NestJS).
 *
 * Sur 401 d'une route /api/* (token Google expiré, JWT 24h écoulé, origin
 * cross-localStorage…), force `auth.logout()` + redirect `/auth/login` pour
 * éviter l'état UI incohérent "currentUser non-null mais session morte"
 * (signalé Sylvain 2026-05-15). Les endpoints publics `/api/auth/*` sont
 * exemptés du redirect — sinon une mauvaise saisie de mot de passe causerait
 * une boucle login→401→login.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  if (!req.url.startsWith('/api/')) {
    return next(req);
  }

  const auth = inject(AuthService);
  const router = inject(Router);
  const token = auth.getToken();
  const authed = token
    ? next(req.clone({ setHeaders: { Authorization: `Bearer ${token}` } }))
    : next(req);

  return authed.pipe(
    catchError((err: unknown) => {
      if (err instanceof HttpErrorResponse && err.status === 401 && !req.url.startsWith('/api/auth/')) {
        auth.logout();
        // navigateByUrl plutôt que navigate (pas de query params merge),
        // remplace l'URL courante pour éviter le back vers la route protégée.
        router.navigateByUrl('/auth/login', { replaceUrl: true });
      }
      return throwError(() => err);
    }),
  );
};
