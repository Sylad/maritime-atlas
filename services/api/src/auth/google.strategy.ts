import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { Strategy, type VerifyCallback, type Profile } from 'passport-google-oauth20';

/**
 * Profile Google extrait à l'étape callback. Le PassportStrategy hydrate
 * req.user avec ce shape ; le controller le récupère via @Req() puis
 * délègue à AuthService.findOrCreateGoogleUser.
 */
export interface GoogleProfilePublic {
  googleId: string;
  email: string;
  displayName: string;
  givenName?: string;
  familyName?: string;
  picture?: string;
}

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(config: ConfigService) {
    const clientID = config.get<string>('googleClientId');
    const clientSecret = config.get<string>('googleClientSecret');
    const callbackURL = config.get<string>('googleCallbackUrl');

    // Si les creds Google ne sont pas configurées en env, la strategy doit
    // quand même se construire pour ne pas planter le boot du module —
    // les routes /auth/google répondront 500 utilisateur final, lisible.
    super({
      clientID: clientID || 'NOT_CONFIGURED',
      clientSecret: clientSecret || 'NOT_CONFIGURED',
      callbackURL: callbackURL || 'http://localhost:4204/api/auth/google/callback',
      scope: ['email', 'profile'],
    });
  }

  validate(
    _accessToken: string,
    _refreshToken: string,
    profile: Profile,
    done: VerifyCallback,
  ): void {
    const email = profile.emails?.[0]?.value?.toLowerCase();
    if (!email) {
      done(new Error('Google profile missing email — vérifier scope email accordé'));
      return;
    }
    const user: GoogleProfilePublic = {
      googleId: profile.id,
      email,
      displayName: profile.displayName || email.split('@')[0],
      givenName: profile.name?.givenName,
      familyName: profile.name?.familyName,
      picture: profile.photos?.[0]?.value,
    };
    done(null, user);
  }
}
