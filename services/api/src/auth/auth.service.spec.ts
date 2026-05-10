import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';

/**
 * Mock Drizzle-like fluent client. Each chain call returns `this` and the
 * terminal call (limit/returning) returns the rows array.
 */
function makeMockDb(initialRows: Array<Record<string, any>> = []) {
  let rows = [...initialRows];
  let mode: 'select' | 'insert' = 'select';

  const chain: any = {
    select: jest.fn(() => { mode = 'select'; return chain; }),
    from:   jest.fn(() => chain),
    where:  jest.fn(() => chain),
    limit:  jest.fn(() => Promise.resolve(rows)),
    insert: jest.fn(() => { mode = 'insert'; return chain; }),
    values: jest.fn((v) => {
      const row = { id: rows.length + 1, ...v };
      rows.push(row);
      return chain;
    }),
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
    svc = new AuthService(db as any, jwt, config);
  });

  it('register: creates a new user, hashes password, returns token', async () => {
    const out = await svc.register('alice@test.com', 'hunter22');

    const stored = db._rows()[0];
    expect(stored.email).toBe('alice@test.com');
    expect(stored.passwordHash).toBeDefined();
    expect(stored.passwordHash).not.toBe('hunter22');           // hashed
    expect(await bcrypt.compare('hunter22', stored.passwordHash)).toBe(true);

    expect(out.user.email).toBe('alice@test.com');
    const decoded = jwt.verify<{ sub: number; email: string }>(out.token);
    expect(decoded.email).toBe('alice@test.com');
  });

  it('register: throws ConflictException on duplicate email', async () => {
    db._setRows([{ id: 1, email: 'taken@test.com', passwordHash: 'whatever' }]);
    await expect(svc.register('taken@test.com', 'something')).rejects.toThrow(ConflictException);
  });

  it('login: returns token on valid credentials', async () => {
    const passwordHash = await bcrypt.hash('mypass2', 10);
    db._setRows([{ id: 42, email: 'bob@test.com', passwordHash }]);

    const out = await svc.login('bob@test.com', 'mypass2');
    expect(out.user.id).toBe(42);
    const decoded = jwt.verify<{ sub: number; email: string }>(out.token);
    expect(decoded.sub).toBe(42);
  });

  it('login: throws UnauthorizedException on bad password', async () => {
    const passwordHash = await bcrypt.hash('correct', 10);
    db._setRows([{ id: 1, email: 'c@test.com', passwordHash }]);

    await expect(svc.login('c@test.com', 'wrong')).rejects.toThrow(UnauthorizedException);
  });

  it('login: throws UnauthorizedException on unknown email', async () => {
    db._setRows([]);
    await expect(svc.login('nobody@test.com', 'whatever')).rejects.toThrow(UnauthorizedException);
  });
});
