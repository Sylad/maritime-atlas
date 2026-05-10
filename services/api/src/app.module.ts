import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';
import { DbModule } from './db/db.module';
import { AuthModule } from './auth/auth.module';
import { PalettesModule } from './palettes/palettes.module';
import { PreferencesModule } from './preferences/preferences.module';
import { GeoServerModule } from './geoserver/geoserver.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    DbModule,
    GeoServerModule,
    AuthModule,
    PalettesModule,
    PreferencesModule,
  ],
})
export class AppModule {}
