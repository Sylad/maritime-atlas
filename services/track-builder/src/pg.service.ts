import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';

@Injectable()
export class PgService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PgService.name);
  pool!: Pool;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const connectionString = this.config.get<string>('DATABASE_URL');
    if (!connectionString) throw new Error('DATABASE_URL not set');
    this.pool = new Pool({
      connectionString,
      max: 4,
      idleTimeoutMillis: 30000,
    });
    let attempt = 0;
    while (true) {
      try {
        await this.pool.query('SELECT 1');
        break;
      } catch (err) {
        attempt++;
        const delay = Math.min(30000, 1000 * 2 ** attempt);
        this.logger.warn(`PG connect failed (${(err as Error).message}), retry in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    this.logger.log('PostgreSQL pool ready');
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }
}
