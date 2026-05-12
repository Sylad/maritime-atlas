import { IsEmail, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import type { Role } from '../db/schema';

/** Inscription : email + username + password. Username lowercased,
    3-30 chars, [a-z0-9_-] uniquement (slug-friendly). */
export class RegisterDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(30)
  @Matches(/^[a-z0-9_-]+$/i, { message: 'username must be alphanumeric, dash or underscore' })
  username!: string;

  @IsString()
  @MinLength(8)
  password!: string;
}

/** Login accepte un identifier = username OU email. Le service détermine
    quel champ matcher (présence du `@` = email, sinon username). */
export class LoginDto {
  @IsString()
  @MinLength(3)
  identifier!: string;

  @IsString()
  @MinLength(1)
  password!: string;
}

/** JWT payload. role et username ajoutés Sprint Auth refonte pour
    permettre @Roles('admin') sans round-trip DB. */
export interface JwtPayload {
  sub: number;       // user id
  email: string;
  username: string;
  role: Role;
  iat?: number;
  exp?: number;
}

/** Représentation publique d'un user (renvoyée par /auth/me et /admin/users). */
export interface UserPublic {
  id: number;
  email: string;
  username: string;
  role: Role;
  emailVerifiedAt: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  /** Phase C.3 (2026-05-12) : slug de zone d'arrivée préférée. NULL =
   *  fallback 'france' au boot de la carte. */
  defaultZone: string | null;
  /** Phase C.4 (2026-05-12) : projection OL préférée — code EPSG.
   *  NULL = fallback 'EPSG:3857'. */
  preferredProjection: string | null;
}
