import { IsEmail, IsString, MinLength } from 'class-validator';

export class CredentialsDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(6)
  password!: string;
}

export interface JwtPayload {
  sub: number;       // user id
  email: string;
  iat?: number;
  exp?: number;
}
