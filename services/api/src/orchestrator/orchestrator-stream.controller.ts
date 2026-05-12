import { Controller, Query, Sse, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Observable, map, merge, interval, startWith } from 'rxjs';
import { OrchestratorRunnerService } from './orchestrator-runner.service';
import type { JwtPayload } from '../auth/dto';

/**
 * Sprint N3 (2026-05-12) — SSE live reload pour /admin/orchestrator.
 *
 * EventSource ne supporte PAS les headers customs côté navigateur, donc
 * le JWT est passé en query param `?token=...`. On valide manuellement
 * via JwtService et on vérifie le rôle admin avant de subscribe au
 * stream. Le risque "token dans URL log" est limité ici : endpoint
 * admin-only, déploiement privé NAS + sladoire.dev derrière Cloudflare.
 *
 * Heartbeat 25s : envoie un comment SSE pour garder la connexion ouverte
 * malgré les proxies qui ferment les idle connections > 30s (cf
 * nginx default proxy_read_timeout 60s, mais idle TCP peut tomber
 * avant).
 */
@Controller('admin/orchestrator')
export class OrchestratorStreamController {
  constructor(
    private readonly runner: OrchestratorRunnerService,
    private readonly jwt: JwtService,
  ) {}

  @Sse('events')
  async events(@Query('token') token?: string): Promise<Observable<MessageEvent>> {
    if (!token) {
      throw new UnauthorizedException('Missing token query param');
    }
    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException('Invalid token');
    }
    if (payload.role !== 'admin') {
      throw new UnauthorizedException('Admin role required');
    }

    // Stream principal = bus events du runner. Heartbeat tous les 25s
    // pour éviter timeout proxies (envoyé comme un MessageEvent vide
    // type 'heartbeat' que le client peut ignorer).
    const heartbeat$ = interval(25_000).pipe(
      startWith(0),
      map(() => ({ data: { type: 'heartbeat', ts: new Date().toISOString() } } as MessageEvent)),
    );
    const jobs$ = this.runner.events$.pipe(
      map((ev) => ({ data: ev } as MessageEvent)),
    );
    return merge(heartbeat$, jobs$);
  }
}
