import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { IsEmail } from 'class-validator';
import { AuthService } from './auth.service';
import { LoginDto, RegisterDto } from './dto';
import { CurrentUser, JwtAuthGuard } from './jwt-auth.guard';

export class ResendVerificationDto {
  @IsEmail()
  email!: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

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

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser('sub') userId: number) {
    return this.auth.me(userId);
  }
}
