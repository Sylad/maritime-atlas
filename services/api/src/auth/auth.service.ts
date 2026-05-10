import { ConflictException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import * as bcrypt from 'bcryptjs';
import { DB_TOKEN, type Db } from '../db/db.module';
import { users } from '../db/schema';
import type { JwtPayload } from './dto';

const BCRYPT_ROUNDS = 10;

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async register(email: string, password: string): Promise<{ token: string; user: { id: number; email: string } }> {
    const existing = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
    if (existing.length > 0) {
      throw new ConflictException('Email already registered');
    }
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const [created] = await this.db.insert(users)
      .values({ email, passwordHash })
      .returning({ id: users.id, email: users.email });
    return { token: this.signToken(created.id, created.email), user: created };
  }

  async login(email: string, password: string): Promise<{ token: string; user: { id: number; email: string } }> {
    const found = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
    if (found.length === 0) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const ok = await bcrypt.compare(password, found[0].passwordHash);
    if (!ok) {
      throw new UnauthorizedException('Invalid credentials');
    }
    return {
      token: this.signToken(found[0].id, found[0].email),
      user: { id: found[0].id, email: found[0].email },
    };
  }

  private signToken(userId: number, email: string): string {
    const payload: JwtPayload = { sub: userId, email };
    return this.jwt.sign(payload);
  }
}
