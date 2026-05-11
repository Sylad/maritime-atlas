import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import * as bcrypt from 'bcryptjs';
import { DB_TOKEN, type Db } from '../db/db.module';
import { users } from '../db/schema';

/**
 * Seed admin idempotent au boot du service api.
 *
 * Logique :
 *  - Si `ADMIN_EMAIL` absent → no-op.
 *  - Si user déjà en DB par email → promote role='admin' + email_verified_at=now()
 *    sans toucher au passwordHash (le user a possiblement déjà set son mdp).
 *  - Si user pas en DB :
 *      - ADMIN_PASSWORD set → on crée le compte admin avec ce mdp + verified
 *      - ADMIN_PASSWORD absent → warn et skip (admin créera son compte
 *        normalement via /auth/register puis on re-boot pour le promote)
 *
 * Le défaut ADMIN_EMAIL = sylvain.ladoire@gmail.com est codé dans
 * configuration.ts ; au premier boot prod, mettre ADMIN_PASSWORD dans
 * `.env` pour bootstrap. À retirer du .env ensuite (le compte existe,
 * le seed deviendra un promote idempotent).
 */
@Injectable()
export class AdminSeedService implements OnModuleInit {
  private readonly logger = new Logger(AdminSeedService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    const adminEmail = (this.config.get<string>('adminEmail') || '').toLowerCase().trim();
    const adminUsername = (this.config.get<string>('adminUsername') || 'sylvain').toLowerCase().trim();
    const adminPassword = this.config.get<string>('adminPassword') || '';

    if (!adminEmail) {
      this.logger.log('Seed admin: ADMIN_EMAIL non set → skip');
      return;
    }

    const existing = await this.db.select().from(users).where(eq(users.email, adminEmail)).limit(1);
    if (existing.length > 0) {
      const u = existing[0];
      if (u.role === 'admin' && u.emailVerifiedAt) {
        this.logger.log(`Seed admin: ${adminEmail} déjà admin + vérifié → no-op`);
        return;
      }
      await this.db.update(users)
        .set({
          role: 'admin',
          emailVerifiedAt: u.emailVerifiedAt ?? new Date(),
        })
        .where(eq(users.id, u.id));
      this.logger.log(`Seed admin: ${adminEmail} promoted to role=admin (was ${u.role})`);
      return;
    }

    if (!adminPassword) {
      this.logger.warn(`Seed admin: ${adminEmail} pas en DB et ADMIN_PASSWORD non set → skip creation. Set ADMIN_PASSWORD dans .env pour bootstrap.`);
      return;
    }

    const passwordHash = await bcrypt.hash(adminPassword, 10);
    await this.db.insert(users).values({
      email: adminEmail,
      username: adminUsername,
      passwordHash,
      role: 'admin',
      emailVerifiedAt: new Date(),
    });
    this.logger.log(`Seed admin: créé ${adminEmail} (@${adminUsername}) avec role=admin`);
  }
}
