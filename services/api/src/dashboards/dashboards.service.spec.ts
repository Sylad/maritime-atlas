import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DashboardsService } from './dashboards.service';

/** db.select().from().where().limit() → rows (chaîne Drizzle minimale). */
function selectDb(rows: unknown[]) {
  return { select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }) }) } as any;
}

const dash = (over: Record<string, unknown> = {}) => ({ id: 1, userId: 1, name: 'd', isPublic: false, isDefault: false, widgets: [], ...over });

describe('DashboardsService', () => {
  it('update: dashboard non possédé → ForbiddenException', async () => {
    const svc = new DashboardsService(selectDb([]));
    await expect(svc.update(2, 1, { name: 'x', widgets: [] })).rejects.toThrow(ForbiddenException);
  });

  it('delete: dashboard non possédé → ForbiddenException', async () => {
    const svc = new DashboardsService(selectDb([]));
    await expect(svc.delete(2, 1)).rejects.toThrow(ForbiddenException);
  });

  it('setVisibility: repasser privé un dashboard DÉFAUT → BadRequestException', async () => {
    const svc = new DashboardsService(selectDb([dash({ isPublic: true, isDefault: true })]));
    await expect(svc.setVisibility(1, 1, false)).rejects.toThrow(BadRequestException);
  });

  it('setDefault: dashboard introuvable → NotFoundException', async () => {
    const svc = new DashboardsService(selectDb([]));
    await expect(svc.setDefault(99)).rejects.toThrow(NotFoundException);
  });

  it('setDefault: dashboard NON public → BadRequestException', async () => {
    const svc = new DashboardsService(selectDb([dash({ isPublic: false })]));
    await expect(svc.setDefault(1)).rejects.toThrow(BadRequestException);
  });

  it('setDefault: public → unset l’ancien défaut puis set le nouveau', async () => {
    const updates: unknown[] = [];
    const db: any = {
      select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([dash({ id: 5, isPublic: true })]) }) }) }),
      update: () => ({
        set: (v: unknown) => {
          updates.push(v);
          return { where: () => ({ returning: () => Promise.resolve([dash({ id: 5, isPublic: true, isDefault: true })]) }) };
        },
      }),
    };
    const svc = new DashboardsService(db);
    const out = await svc.setDefault(5);
    expect(out.isDefault).toBe(true);
    // 1er update = unset ancien défaut (isDefault:false), 2e = set nouveau.
    expect(updates[0]).toEqual({ isDefault: false });
    expect((updates[1] as { isDefault: boolean }).isDefault).toBe(true);
  });
});
