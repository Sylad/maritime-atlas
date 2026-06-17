import { BadRequestException, NotFoundException } from '@nestjs/common';
import { MapConfigurationsService } from './map-configurations.service';
import type { MapConfigDto } from './dto';

/**
 * Drizzle's fluent API n'est pas mocké en profondeur (cf palettes.service.spec) :
 * on stub `listMine` (collision/limit) + des chaînes db minimales, et on teste
 * le COMPORTEMENT (limite, collision de nom, ownership) plutôt que le SQL.
 */
const snapshot = {
  version: 1,
  view: { projection: 'globe', center: { lng: 0, lat: 0 }, zoom: 2, bearing: 0, pitch: 0 },
  layers: { visibility: {}, opacities: {}, contours: { sstContours: false, windContours: false, waveContours: false }, zIndex: { autoEnabled: true, order: [] } },
  time: { masterLayerKey: null },
} as unknown as MapConfigDto['snapshot'];

const dto = (name: string): MapConfigDto => ({ name, snapshot });

function ownershipDb(found: unknown[]) {
  // db.select().from().where().limit() → found
  return {
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve(found) }) }) }),
  } as any;
}

describe('MapConfigurationsService', () => {
  it('create: au-delà de la limite → BadRequestException', async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, userId: 1, name: `c${i}`, snapshot }));
    const svc = new MapConfigurationsService({} as any);
    jest.spyOn(svc, 'listMine').mockResolvedValue(many as any);
    await expect(svc.create(1, dto('overflow'))).rejects.toThrow(BadRequestException);
  });

  it('create: nom déjà pris → BadRequestException', async () => {
    const svc = new MapConfigurationsService({} as any);
    jest.spyOn(svc, 'listMine').mockResolvedValue([{ id: 1, userId: 1, name: 'Atlantique', snapshot }] as any);
    await expect(svc.create(1, dto('Atlantique'))).rejects.toThrow(BadRequestException);
  });

  it('create: sous la limite + nom libre → insère', async () => {
    const created = { id: 7, userId: 1, name: 'Manche', snapshot };
    const insertChain: any = { values: jest.fn(() => insertChain), returning: jest.fn(() => Promise.resolve([created])) };
    const db = { insert: jest.fn(() => insertChain) } as any;
    const svc = new MapConfigurationsService(db);
    jest.spyOn(svc, 'listMine').mockResolvedValue([]);
    const out = await svc.create(1, dto('Manche'));
    expect(out.id).toBe(7);
    expect(db.insert).toHaveBeenCalled();
  });

  it('update: config d’un autre user (introuvable) → NotFoundException', async () => {
    const svc = new MapConfigurationsService(ownershipDb([]));
    await expect(svc.update(2, 99, dto('x'))).rejects.toThrow(NotFoundException);
  });

  it('update: collision de nom avec une AUTRE config → BadRequestException', async () => {
    const svc = new MapConfigurationsService(ownershipDb([{ id: 1, userId: 1, name: 'old', snapshot }]));
    jest.spyOn(svc, 'listMine').mockResolvedValue([
      { id: 1, userId: 1, name: 'old', snapshot },
      { id: 2, userId: 1, name: 'taken', snapshot },
    ] as any);
    await expect(svc.update(1, 1, dto('taken'))).rejects.toThrow(BadRequestException);
  });

  it('delete: config introuvable / non possédée → NotFoundException', async () => {
    const svc = new MapConfigurationsService(ownershipDb([]));
    await expect(svc.delete(1, 123)).rejects.toThrow(NotFoundException);
  });
});
