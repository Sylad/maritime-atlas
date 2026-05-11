import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { AdminSeedService } from './admin-seed.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';
import { MailService } from './mail.service';
import { DormantCleanupService } from './dormant-cleanup.service';
import { GoogleStrategy } from './google.strategy';

@Global()
@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt', session: false }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const expiresIn = config.get<string>('jwtExpiresIn') || '24h';
        return {
          secret: config.get<string>('jwtSecret') || 'dev-secret-change-me',
          signOptions: { expiresIn: expiresIn as any },
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard, RolesGuard, AdminSeedService, MailService, DormantCleanupService, GoogleStrategy],
  exports: [AuthService, JwtAuthGuard, RolesGuard, JwtModule, MailService, DormantCleanupService],
})
export class AuthModule {}
