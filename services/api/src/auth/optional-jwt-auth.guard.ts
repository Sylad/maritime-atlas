import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import type { JwtPayload } from './dto';

/**
 * Guard d'authentification OPTIONNELLE (2026-06-18). Si un Bearer token valide
 * est présent, pose `req.user` (comme JwtAuthGuard). Sinon, laisse passer en
 * anonyme (pas d'exception). Sert aux routes lisibles à la fois par un
 * propriétaire connecté ET par un visiteur anonyme (ex : GET /dashboards/:id
 * qui renvoie le dashboard s'il est public OU possédé par l'appelant).
 */
@Injectable()
export class OptionalJwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { user?: JwtPayload }>();
    const auth = req.headers['authorization'];
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
      try {
        req.user = await this.jwt.verifyAsync<JwtPayload>(auth.slice(7));
      } catch {
        // token invalide/expiré → on reste anonyme (pas d'exception)
      }
    }
    return true;
  }
}
