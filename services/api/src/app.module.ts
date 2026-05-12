import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import configuration from './config/configuration';
import { DbModule } from './db/db.module';
import { AuthModule } from './auth/auth.module';
import { PalettesModule } from './palettes/palettes.module';
import { PreferencesModule } from './preferences/preferences.module';
import { GeoServerModule } from './geoserver/geoserver.module';
import { AdminModule } from './admin/admin.module';
import { OrchestratorModule } from './orchestrator/orchestrator.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    ScheduleModule.forRoot(),
    DbModule,
    GeoServerModule,
    AuthModule,
    PalettesModule,
    PreferencesModule,
    AdminModule,
    OrchestratorModule,
  ],
})
export class AppModule {}
