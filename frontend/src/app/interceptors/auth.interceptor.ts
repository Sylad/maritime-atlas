import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { AuthService } from '../services/auth.service';

/**
 * Functional interceptor : injecte `Authorization: Bearer <token>` sur les
 * requêtes /api/* uniquement. Les requêtes /geoserver/* restent ouvertes
 * (elles ne touchent pas le backend NestJS).
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  if (!req.url.startsWith('/api/')) {
    return next(req);
  }
  const token = inject(AuthService).getToken();
  if (!token) {
    return next(req);
  }
  return next(req.clone({
    setHeaders: { Authorization: `Bearer ${token}` },
  }));
};
