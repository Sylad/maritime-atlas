import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { JwtPayload } from './dto';
import type { Role } from '../db/schema';

const ROLES_KEY = 'maritime:roles';

/**
 * Decorator pour restreindre une route à certains rôles.
 *
 * Usage :
 *   @UseGuards(JwtAuthGuard, RolesGuard)
 *   @Roles('admin')
 *   @Get('/admin/users')
 *   listAllUsers() { ... }
 *
 * L'ordre des guards compte : JwtAuthGuard pose req.user.role, RolesGuard
 * le lit. Si pas de @Roles, le RolesGuard laisse passer (= contrôle uniquement
 * d'authentification, pas d'autorisation).
 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required || required.length === 0) {
      return true; // pas de restriction de rôle → on laisse passer
    }
    const req = ctx.switchToHttp().getRequest<Request & { user?: JwtPayload }>();
    const userRole = req.user?.role;
    if (!userRole) {
      // JwtAuthGuard a déjà dû jeter — défense en profondeur
      throw new ForbiddenException('No role attached to request');
    }
    if (!required.includes(userRole)) {
      throw new ForbiddenException(`Role '${userRole}' insufficient (required: ${required.join(', ')})`);
    }
    return true;
  }
}
