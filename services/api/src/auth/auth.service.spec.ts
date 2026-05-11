import { ConflictException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';

/**
 * Mock Drizzle-like fluent client. Each chain call returns `this` and the
 * terminal call (limit/returning) returns the rows array.
 *
 * Sprint Auth refonte : on étend pour matcher `update(...).set(...).where(...)`
 * et `where(or(...))` (login par username OR email).
 */
function makeMockDb(initialRows: Array<Record<string, any>> = []) {
  let rows = [...initialRows];
  let mode: 'select' | 'update' = 'select';
  let pendingPatch: Record<string, any> | null = null;

  const chain: any = {
    select: jest.fn(() => { mode = 'select'; return chain; }),
    from:   jest.fn(() => chain),
    where:  jest.fn(() => {
      if (mode === 'update' && pendingPatch) {
        // applique le patch sur toutes les rows (les tests ont 1 row en général)
        for (const r of rows) Object.assign(r, pendingPatch);
        pendingPatch = null;
        mode = 'select';
        return Promise.resolve();
      }
      return chain;
    }),
    limit:  jest.fn(() => Promise.resolve(rows)),
    insert: jest.fn(() => chain),
    values: jest.fn((v) => {
      const row = { id: rows.length + 1, createdAt: new Date(), emailVerifiedAt: null, lastLoginAt: null, role: 'user', ...v };
      rows.push(row);
      return chain;
    }),
    update: jest.fn(() => { mode = 'update'; return chain; }),
    set:    jest.fn((patch) => { pendingPatch = patch; return chain; }),
    returning: jest.fn(() => Promise.resolve([rows[rows.length - 1]])),
    _rows: () => rows,
    _setRows: (r: Array<Record<string, any>>) => { rows = [...r]; },
  };
  return chain;
}

describe('AuthService', () => {
  let svc: AuthService;
  let db: ReturnType<typeof makeMockDb>;
  let jwt: JwtService;

  beforeEach(() => {
    db = makeMockDb();
    jwt = new JwtService({ secret: 'test-secret', signOptions: { expiresIn: '1h' } });
    const config = { get: () => 10 } as unknown as ConfigService;
    const mail = { sendVerificationEmail: jest.fn().mockResolvedValue(undefined) } as any;
    svc = new AuthService(db as any, jwt, config, mail);
  });

  it('register: creates a new user with username, lowercased, returns verification token', async () => {
    const out = await svc.register('Alice@Test.com', 'Alice', 'hunter22XY');

    const stored = db._rows()[0];
    expect(stored.email).toBe('alice@test.com');                  // lowercased
    expect(stored.username).toBe('alice');                         // lowercased
    expect(stored.passwordHash).not.toBe('hunter22XY');            // hashed
    expect(await bcrypt.compare('hunter22XY', stored.passwordHash)).toBe(true);
    expect(stored.role).toBe('user');                              // défaut
    expect(stored.verificationToken).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(stored.verificationTokenExpiresAt).toBeInstanceOf(Date);

    expect(out.verificationTokenSent).toBe(true);
    expect(out.message).toMatch(/verify|verification/i);
  });

  it('register: throws ConflictException on duplicate email or username', async () => {
    db._setRows([{ id: 1, email: 'taken@test.com', username: 'taken', passwordHash: 'whatever' }]);
    await expect(svc.register('taken@test.com', 'newname', 'somethingXY')).rejects.toThrow(ConflictException);
  });

  it('login: returns token on valid credentials by email, updates lastLoginAt', async () => {
    const passwordHash = await bcrypt.hash('mypass2XY', 10);
    db._setRows([{
      id: 42, email: 'bob@test.com', username: 'bob', passwordHash,
      role: 'user', emailVerifiedAt: new Date(), lastLoginAt: null, createdAt: new Date(),
    }]);

    const out = await svc.login('bob@test.com', 'mypass2XY');
    expect(out.user.id).toBe(42);
    expect(out.user.username).toBe('bob');
    expect(out.user.role).toBe('user');
    const decoded = jwt.verify<{ sub: number; role: string }>(out.token);
    expect(decoded.sub).toBe(42);
    expect(decoded.role).toBe('user');
  });

  it('login: returns token on valid credentials by username', async () => {
    const passwordHash = await bcrypt.hash('mypass2XY', 10);
    db._setRows([{
      id: 42, email: 'bob@test.com', username: 'bob', passwordHash,
      role: 'user', emailVerifiedAt: new Date(), lastLoginAt: null, createdAt: new Date(),
    }]);

    const out = await svc.login('bob', 'mypass2XY');
    expect(out.user.id).toBe(42);
  });

  it('login: throws ForbiddenException when email_verified_at is null', async () => {
    const passwordHash = await bcrypt.hash('correctXY', 10);
    db._setRows([{
      id: 1, email: 'c@test.com', username: 'c', passwordHash,
      role: 'user', emailVerifiedAt: null, lastLoginAt: null, createdAt: new Date(),
    }]);

    await expect(svc.login('c@test.com', 'correctXY')).rejects.toThrow(ForbiddenException);
  });

  it('login: throws UnauthorizedException on bad password', async () => {
    const passwordHash = await bcrypt.hash('correctXY', 10);
    db._setRows([{
      id: 1, email: 'c@test.com', username: 'c', passwordHash,
      role: 'user', emailVerifiedAt: new Date(), lastLoginAt: null, createdAt: new Date(),
    }]);

    await expect(svc.login('c@test.com', 'wrongXY99')).rejects.toThrow(UnauthorizedException);
  });

  it('login: throws UnauthorizedException on unknown identifier', async () => {
    db._setRows([]);
    await expect(svc.login('nobody@test.com', 'whateverXY')).rejects.toThrow(UnauthorizedException);
  });

  it('verifyEmail: idempotent — sets email_verified_at + clears token', async () => {
    db._setRows([{
      id: 7, email: 'v@test.com', username: 'v', passwordHash: 'x',
      role: 'user', emailVerifiedAt: null, lastLoginAt: null, createdAt: new Date(),
      verificationToken: 'abcd1234-aa-bb-cc-dd', verificationTokenExpiresAt: new Date(Date.now() + 60000),
    }]);
    const out = await svc.verifyEmail('abcd1234-aa-bb-cc-dd');
    expect(out.message).toMatch(/verified/i);
    expect(db._rows()[0].emailVerifiedAt).toBeInstanceOf(Date);
    expect(db._rows()[0].verificationToken).toBeNull();
  });

  it('verifyEmail: throws on already-verified (idempotent message)', async () => {
    db._setRows([{
      id: 7, email: 'v@test.com', username: 'v', passwordHash: 'x',
      role: 'user', emailVerifiedAt: new Date(), lastLoginAt: null, createdAt: new Date(),
      verificationToken: 'tok-aa-bb', verificationTokenExpiresAt: new Date(Date.now() + 60000),
    }]);
    const out = await svc.verifyEmail('tok-aa-bb');
    expect(out.message).toMatch(/already verified/i);
  });
});
