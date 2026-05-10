import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PalettesService } from './palettes.service';

/**
 * Note : Drizzle's fluent API is hard to mock cheaply. Instead of trying to
 * impersonate it, we stub PalettesService's methods that go through Drizzle
 * by overriding `listMine` (used for the limit check) + spy on the actual
 * `db` calls only where it matters. Tests focus on BEHAVIOR (limit, ownership,
 * GeoServer side-effects) rather than DB internals.
 */
describe('PalettesService', () => {
  const config = { get: () => 5 } as unknown as ConfigService;
  const geoserver: any = {
    upsertStyle:  jest.fn(() => Promise.resolve()),
    deleteStyle:  jest.fn(() => Promise.resolve()),
    buildSld:     jest.fn(() => '<sld/>'),
    styleNameFor: (uid: number, slug: string) => `user_${uid}_${slug}`,
  };

  beforeEach(() => {
    geoserver.upsertStyle.mockClear();
    geoserver.deleteStyle.mockClear();
  });

  it('create: 6th palette throws BadRequestException (limit 5)', async () => {
    const fiveExisting = Array.from({ length: 5 }, (_, i) => ({
      id: i + 1, userId: 1, slug: `p${i}`, name: `p${i}`, layerKind: 'sst', stops: [], opacity: 0.7,
    }));
    const db = { } as any;
    const svc = new PalettesService(db, geoserver, config);
    jest.spyOn(svc, 'listMine').mockResolvedValue(fiveExisting as any);

    await expect(svc.create(1, {
      name: 'Sixth',
      layerKind: 'sst',
      stops: [{ quantity: 0, color: '#000', opacity: 0 }, { quantity: 1, color: '#fff', opacity: 1 }],
    })).rejects.toThrow(BadRequestException);
    expect(geoserver.upsertStyle).not.toHaveBeenCalled();
  });

  it('create: under limit calls GeoServer with derived slug', async () => {
    const inserted = { id: 99, userId: 7, slug: 'marine-chaude', name: 'Marine chaude', layerKind: 'sst', stops: [], opacity: 0.7 };
    const insertChain: any = {
      values: jest.fn(() => insertChain),
      returning: jest.fn(() => Promise.resolve([inserted])),
    };
    const db = {
      insert: jest.fn(() => insertChain),
      delete: jest.fn(() => ({ where: jest.fn(() => Promise.resolve()) })),
    } as any;
    const svc = new PalettesService(db, geoserver, config);
    jest.spyOn(svc, 'listMine').mockResolvedValue([]);

    const out = await svc.create(7, {
      name: 'Marine chaude',
      layerKind: 'sst',
      stops: [{ quantity: 0, color: '#000000', opacity: 0 }, { quantity: 30, color: '#ff0000', opacity: 1 }],
      opacity: 0.75,
    });
    expect(out.id).toBe(99);
    expect(geoserver.upsertStyle).toHaveBeenCalledWith('user_7_marine-chaude', '<sld/>');
  });

  it('create: appends -2 to slug if duplicate', async () => {
    const existing = [{ id: 1, userId: 7, slug: 'marine', name: 'Marine', layerKind: 'sst', stops: [], opacity: 0.7 }];
    const insertChain: any = {
      values: jest.fn((v) => { insertChain._captured = v; return insertChain; }),
      returning: jest.fn(() => Promise.resolve([{ id: 2, userId: 7, slug: insertChain._captured.slug, name: 'Marine', layerKind: 'sst', stops: [], opacity: 0.7 }])),
    };
    const db = {
      insert: jest.fn(() => insertChain),
      delete: jest.fn(() => ({ where: jest.fn(() => Promise.resolve()) })),
    } as any;
    const svc = new PalettesService(db, geoserver, config);
    jest.spyOn(svc, 'listMine').mockResolvedValue(existing as any);

    const out = await svc.create(7, {
      name: 'Marine',
      layerKind: 'sst',
      stops: [{ quantity: 0, color: '#000', opacity: 0 }, { quantity: 1, color: '#fff', opacity: 1 }],
    });
    expect(out.slug).toBe('marine-2');
    expect(geoserver.upsertStyle).toHaveBeenCalledWith('user_7_marine-2', expect.any(String));
  });

  it('create: rolls back DB row if GeoServer upsert fails', async () => {
    geoserver.upsertStyle.mockRejectedValueOnce(new Error('502 GeoServer down'));
    const inserted = { id: 88, userId: 1, slug: 'oops', name: 'Oops', layerKind: 'sst', stops: [], opacity: 0.7 };
    const insertChain: any = {
      values: jest.fn(() => insertChain),
      returning: jest.fn(() => Promise.resolve([inserted])),
    };
    const deleteWhere = jest.fn(() => Promise.resolve());
    const db = {
      insert: jest.fn(() => insertChain),
      delete: jest.fn(() => ({ where: deleteWhere })),
    } as any;
    const svc = new PalettesService(db, geoserver, config);
    jest.spyOn(svc, 'listMine').mockResolvedValue([]);

    await expect(svc.create(1, {
      name: 'Oops',
      layerKind: 'sst',
      stops: [{ quantity: 0, color: '#000', opacity: 0 }, { quantity: 1, color: '#fff', opacity: 1 }],
    })).rejects.toThrow(BadRequestException);
    expect(deleteWhere).toHaveBeenCalled();   // Rollback fired
  });
});
