import { UnauthorizedException, ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { JwtAuthGuard } from './jwt-auth.guard';

function ctxWith(headers: Record<string, string | undefined>): ExecutionContext {
  const req: any = { headers, user: undefined };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe('JwtAuthGuard', () => {
  const jwt = new JwtService({ secret: 'guard-test', signOptions: { expiresIn: '1h' } });
  const guard = new JwtAuthGuard(jwt);

  it('throws UnauthorizedException when Authorization header missing', async () => {
    await expect(guard.canActivate(ctxWith({}))).rejects.toThrow(UnauthorizedException);
  });

  it('throws UnauthorizedException when token invalid', async () => {
    const ctx = ctxWith({ authorization: 'Bearer not.a.real.jwt' });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('returns true and populates req.user when token valid', async () => {
    const token = jwt.sign({ sub: 99, email: 'h@test.com' });
    const ctx = ctxWith({ authorization: `Bearer ${token}` });
    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
    const req = ctx.switchToHttp().getRequest() as any;
    expect(req.user.sub).toBe(99);
    expect(req.user.email).toBe('h@test.com');
  });
});
