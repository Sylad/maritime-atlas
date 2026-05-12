import { Body, Controller, Get, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { IsEmail } from 'class-validator';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { LoginDto, RegisterDto } from './dto';
import { CurrentUser, JwtAuthGuard } from './jwt-auth.guard';
import type { GoogleProfilePublic } from './google.strategy';

export class ResendVerificationDto {
  @IsEmail()
  email!: string;
}

export class ForgotPasswordDto {
  @IsEmail()
  email!: string;
}

import { IsString, MinLength } from 'class-validator';
export class ResetPasswordDto {
  @IsString()
  @MinLength(8)
  token!: string;

  @IsString()
  @MinLength(8)
  newPassword!: string;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  @Post('register')
  register(@Body() body: RegisterDto) {
    return this.auth.register(body.email, body.username, body.password);
  }

  @Post('login')
  login(@Body() body: LoginDto) {
    return this.auth.login(body.identifier, body.password);
  }

  /** Lien envoyé par mail. GET pour qu'un click direct depuis le mail
      marche sans middleware POST. Token en query string. */
  @Get('verify')
  verify(@Query('token') token: string) {
    return this.auth.verifyEmail(token);
  }

  /** Renvoie un nouveau lien de vérification si le user a perdu le précédent
      ou si le token a expiré (>24h). Réponse identique succès/inexistant
      pour éviter l'énumération de comptes. */
  @Post('resend-verification')
  resendVerification(@Body() body: ResendVerificationDto) {
    return this.auth.resendVerification(body.email);
  }

  /** Phase B — Forgot password : envoie un mail de reset (TTL 1h).
      Réponse identique succès/inexistant pour empêcher l'énumération. */
  @Post('forgot-password')
  forgotPassword(@Body() body: ForgotPasswordDto) {
    return this.auth.forgotPassword(body.email);
  }

  /** Phase B — Reset password : valide le token + update password_hash. */
  @Post('reset-password')
  resetPassword(@Body() body: ResetPasswordDto) {
    return this.auth.resetPassword(body.token, body.newPassword);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser('sub') userId: number) {
    return this.auth.me(userId);
  }

  /**
   * Start Google OAuth flow — le @UseGuards(AuthGuard('google')) déclenche
   * un 302 vers Google avec les bons params. Le user revient via
   * /auth/google/callback. Aucune body, juste un point d'entrée.
   */
  @Get('google')
  @UseGuards(AuthGuard('google'))
  googleStart(): void {
    // Pas de code ici — le guard redirect au boot du handler.
  }

  /**
   * Callback Google. Le guard valide le code + hydrate req.user via la
   * GoogleStrategy. On délègue à AuthService pour login/create, puis on
   * redirige vers le frontend avec `#token=<JWT>` en URL fragment (les
   * fragments ne sont PAS envoyés côté serveur — moins de fuite logs).
   */
  @Get('google/callback')
  @UseGuards(AuthGuard('google'))
  async googleCallback(
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const profile = req.user as GoogleProfilePublic;
    const { token, user, created } = await this.auth.loginOrCreateGoogleUser(profile);
    // Reconstruit la base depuis les headers de la requête entrante
    // (Google a renvoyé sur GOOGLE_CALLBACK_URL = host public). Avec
    // trust proxy activé côté main.ts, req.protocol respecte
    // X-Forwarded-Proto donc on aura https en prod via nginx → api.
    // Fallback PUBLIC_BASE_URL si jamais req.hostname est vide
    // (ex: appel direct au container hors-proxy).
    const proto = req.protocol;
    const host = req.headers.host || req.hostname;
    const dynBase = host ? `${proto}://${host}` : '';
    const base = (dynBase || this.config.get<string>('publicBaseUrl') || '').replace(/\/$/, '');
    const redirectUrl = `${base}/auth/google-success#token=${encodeURIComponent(token)}&created=${created ? '1' : '0'}`;
    res.redirect(redirectUrl);
  }
}
