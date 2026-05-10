import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema';

export const DB_TOKEN = 'DB_TOKEN';
export type Db = ReturnType<typeof drizzle<typeof schema>>;

const dbProvider = {
  provide: DB_TOKEN,
  inject: [ConfigService],
  useFactory: (config: ConfigService): Db => {
    const url = config.get<string>('databaseUrl');
    if (!url) {
      throw new Error('DATABASE_URL is required');
    }
    const client = postgres(url, {
      max: 10,
      idle_timeout: 20,
      connect_timeout: 10,
    });
    return drizzle(client, { schema });
  },
};

@Global()
@Module({
  providers: [dbProvider],
  exports: [dbProvider],
})
export class DbModule {}
