import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { and, eq, lt, ne, sql } from 'drizzle-orm';
import { DB_TOKEN, type Db } from '../db/db.module';
import { users } from '../db/schema';

/**
 * Cron quotidien (03:00 Europe/Paris) qui supprime les comptes dormants.
 *
 * Politique (Sylvain 2026-05-11) :
 *  - Un user dont `last_login_at` est plus vieux que `DORMANT_AFTER_DAYS`
 *    (défaut 90j = 3 mois) → supprimé. Cascade via ON DELETE CASCADE sur
 *    palettes + user_layer_preferences (schema Drizzle).
 *  - Garde-fous :
 *      - Les `role='admin'` sont préservés inconditionnellement
 *        (sinon brick possible si un admin part en vacances).
 *      - Les users jamais connectés (`last_login_at IS NULL`) sont
 *        évalués sur `created_at` au lieu de `last_login_at` — si un
 *        compte créé depuis > 90j n'a JAMAIS été vérifié + login, c'est
 *        un compte fantôme à nettoyer.
 *  - Mode dry-run : si DORMANT_DRY_RUN=true, log les IDs candidats
 *    SANS les supprimer (utile pour audit avant prod).
 *
 * Configurable via env :
 *   - DORMANT_AFTER_DAYS=90       (par défaut)
 *   - DORMANT_DRY_RUN=false       (par défaut false en prod)
 *   - DORMANT_CRON='0 3 * * *'    (cron expression, par défaut 03:00 daily)
 */
@Injectable()
export class DormantCleanupService {
  private readonly logger = new Logger(DormantCleanupService.name);
  private readonly dormantAfterDays: number;
  private readonly dryRun: boolean;

  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    config: ConfigService,
  ) {
    this.dormantAfterDays = config.get<number>('dormantAfterDays') ?? 90;
    this.dryRun = config.get<boolean>('dormantDryRun') ?? false;
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM, {
    name: 'dormant-cleanup',
    timeZone: 'Europe/Paris',
  })
  async handleDormantCleanup(): Promise<void> {
    await this.runCleanup();
  }

  /** Exécution publique pour les tests + admin trigger manuel (futur). */
  async runCleanup(): Promise<{ candidates: number; deleted: number; dryRun: boolean }> {
    const cutoff = new Date(Date.now() - this.dormantAfterDays * 86400_000);
    this.logger.log(`Cleanup dormants : cutoff=${cutoff.toISOString()} (last_login_at OR created_at < cutoff), dryRun=${this.dryRun}`);

    // last_login_at NULL → fallback created_at. SQL : COALESCE(last_login_at, created_at) < cutoff.
    // Drizzle ne supporte pas COALESCE direct dans where, on passe par sql template.
    const candidates = await this.db.select({
      id: users.id,
      email: users.email,
      username: users.username,
      lastLoginAt: users.lastLoginAt,
      createdAt: users.createdAt,
    })
      .from(users)
      .where(and(
        ne(users.role, 'admin'),
        lt(sql`COALESCE(${users.lastLoginAt}, ${users.createdAt})`, cutoff),
      ));

    if (candidates.length === 0) {
      this.logger.log('Cleanup dormants : aucun candidat — OK');
      return { candidates: 0, deleted: 0, dryRun: this.dryRun };
    }

    this.logger.warn(`Cleanup dormants : ${candidates.length} candidat(s) → ${this.dryRun ? 'DRY-RUN, aucune suppression' : 'suppression en cours'}`);
    for (const u of candidates) {
      this.logger.warn(`  - id=${u.id} username=${u.username} email=${u.email} lastLogin=${u.lastLoginAt?.toISOString() ?? 'never'} created=${u.createdAt.toISOString()}`);
    }

    if (this.dryRun) {
      return { candidates: candidates.length, deleted: 0, dryRun: true };
    }

    let deleted = 0;
    for (const u of candidates) {
      await this.db.delete(users).where(eq(users.id, u.id));
      deleted++;
    }
    this.logger.log(`Cleanup dormants : ${deleted} user(s) supprimé(s) (cascade palettes + preferences)`);
    return { candidates: candidates.length, deleted, dryRun: false };
  }
}
