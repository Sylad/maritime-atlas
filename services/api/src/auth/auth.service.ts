import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { eq, or } from 'drizzle-orm';
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { DB_TOKEN, type Db } from '../db/db.module';
import { users, type User, type Role } from '../db/schema';
import type { JwtPayload, UserPublic } from './dto';
import { MailService } from './mail.service';

const BCRYPT_ROUNDS = 10;
/** Verification token life. 24h c'est confortable (le user a le temps de
    cliquer le lien sans renvoyer un nouveau mail). */
const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly mail: MailService,
  ) {}

  /**
   * Inscription : crée un user `email_verified_at=null` (login bloqué tant
   * que pas vérifié) + un verification_token à 24h.
   *
   * Retourne le token de vérification au caller (le mail Resend sera envoyé
   * en Phase 2 ; en attendant le caller peut afficher le token en dev OU
   * le backend peut juste loguer). NE retourne PAS de JWT — un user doit
   * d'abord vérifier son email pour se connecter (fail-closed).
   */
  async register(email: string, username: string, password: string): Promise<{ message: string; verificationTokenSent: boolean }> {
    const normalizedUsername = username.toLowerCase();
    const normalizedEmail = email.toLowerCase();

    const existing = await this.db.select().from(users)
      .where(or(eq(users.email, normalizedEmail), eq(users.username, normalizedUsername)))
      .limit(1);
    if (existing.length > 0) {
      // Message générique pour ne pas leak quel champ existe déjà
      throw new ConflictException('Email or username already taken');
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const verificationToken = randomUUID();
    const verificationTokenExpiresAt = new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS);

    await this.db.insert(users).values({
      email: normalizedEmail,
      username: normalizedUsername,
      passwordHash,
      role: 'user',
      verificationToken,
      verificationTokenExpiresAt,
    });

    this.logger.log(`Register OK : ${normalizedEmail} (@${normalizedUsername}) — verification token expires ${verificationTokenExpiresAt.toISOString()}`);
    // Envoi du mail Resend (best-effort — n'échoue pas le register si SMTP KO).
    // Le user pourra resend via /auth/resend-verification.
    await this.mail.sendVerificationEmail(normalizedEmail, normalizedUsername, verificationToken);
    return {
      message: 'Account created. Check your inbox for the verification link.',
      verificationTokenSent: true,
    };
  }

  /**
   * Renvoie un mail de vérification au user dont l'email est fourni.
   * Idempotent : si déjà vérifié, retourne success sans rien envoyer.
   * Génère un nouveau token (le précédent est invalidé) avec TTL 24h.
   */
  async resendVerification(email: string): Promise<{ message: string }> {
    const normalizedEmail = email.toLowerCase().trim();
    const found = await this.db.select().from(users).where(eq(users.email, normalizedEmail)).limit(1);
    if (found.length === 0) {
      // Réponse identique pour ne pas leak l'existence d'un compte (énumération).
      return { message: 'If the email exists, a verification link was sent.' };
    }
    const user = found[0];
    if (user.emailVerifiedAt) {
      return { message: 'Email already verified. Just log in.' };
    }
    const verificationToken = randomUUID();
    const verificationTokenExpiresAt = new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS);
    await this.db.update(users)
      .set({ verificationToken, verificationTokenExpiresAt })
      .where(eq(users.id, user.id));
    await this.mail.sendVerificationEmail(user.email, user.username, verificationToken);
    return { message: 'If the email exists, a verification link was sent.' };
  }

  /**
   * Login : accepte username OU email comme identifier. Refuse si le
   * compte n'est pas vérifié (email_verified_at IS NULL). Met à jour
   * last_login_at pour le cron de suppression dormants (Phase 4).
   */
  async login(identifier: string, password: string): Promise<{ token: string; user: UserPublic }> {
    const normalized = identifier.toLowerCase().trim();
    const isEmail = normalized.includes('@');
    const where = isEmail ? eq(users.email, normalized) : eq(users.username, normalized);
    const found = await this.db.select().from(users).where(where).limit(1);
    if (found.length === 0) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const user = found[0];
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      throw new UnauthorizedException('Invalid credentials');
    }
    if (!user.emailVerifiedAt) {
      throw new ForbiddenException('Email not verified. Check your inbox for the verification link.');
    }

    const now = new Date();
    await this.db.update(users).set({ lastLoginAt: now }).where(eq(users.id, user.id));

    return {
      token: this.signToken(user),
      user: this.toPublic({ ...user, lastLoginAt: now }),
    };
  }

  /**
   * Verify email via token UUID v4 (envoyé par mail).
   * Idempotent : si déjà vérifié, retourne success sans re-set.
   */
  async verifyEmail(token: string): Promise<{ message: string }> {
    if (!token || token.length < 8) {
      throw new BadRequestException('Invalid verification token');
    }
    const found = await this.db.select().from(users).where(eq(users.verificationToken, token)).limit(1);
    if (found.length === 0) {
      throw new BadRequestException('Unknown verification token');
    }
    const user = found[0];
    if (user.emailVerifiedAt) {
      return { message: 'Email already verified.' };
    }
    if (user.verificationTokenExpiresAt && user.verificationTokenExpiresAt < new Date()) {
      throw new BadRequestException('Verification token expired. Request a new one.');
    }
    await this.db.update(users)
      .set({ emailVerifiedAt: new Date(), verificationToken: null, verificationTokenExpiresAt: null })
      .where(eq(users.id, user.id));
    this.logger.log(`Email verified : ${user.email} (@${user.username})`);
    return { message: 'Email verified. You can now log in.' };
  }

  /**
   * Pour /auth/me — retourne le user depuis le JWT payload (lecture DB).
   * Refuse si pas trouvé en DB (compte supprimé pendant la durée de vie
   * du JWT — rare mais possible avec le cron dormants).
   */
  async me(userId: number): Promise<UserPublic> {
    const found = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (found.length === 0) {
      throw new UnauthorizedException('User no longer exists');
    }
    return this.toPublic(found[0]);
  }

  signToken(user: Pick<User, 'id' | 'email' | 'username' | 'role'>): string {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      username: user.username,
      role: user.role as Role,
    };
    return this.jwt.sign(payload);
  }

  toPublic(u: User): UserPublic {
    return {
      id: u.id,
      email: u.email,
      username: u.username,
      role: u.role as Role,
      emailVerifiedAt: u.emailVerifiedAt,
      lastLoginAt: u.lastLoginAt,
      createdAt: u.createdAt,
    };
  }
}
