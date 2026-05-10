import { PreferencesService } from './preferences.service';

describe('PreferencesService.getMyContext', () => {
  it('joins user palettes with preferences and emits styleName for each pref', async () => {
    const myPalettes = [
      { id: 11, userId: 3, slug: 'azure', name: 'Azure', layerKind: 'sst', stops: [], opacity: 0.7 },
      { id: 12, userId: 3, slug: 'storm', name: 'Storm', layerKind: 'wind', stops: [], opacity: 0.7 },
    ];
    const prefs = [
      { userId: 3, layerKind: 'sst', paletteId: 11, updatedAt: new Date() },
      { userId: 3, layerKind: 'wind', paletteId: 12, updatedAt: new Date() },
    ];

    let call = 0;
    const db: any = {
      select: () => db,
      from: () => db,
      where: () => Promise.resolve(call++ === 0 ? myPalettes : prefs),
    };
    const svc = new PreferencesService(db);

    const out = await svc.getMyContext(3);
    expect(out.palettes).toHaveLength(2);
    expect(out.preferences).toHaveLength(2);
    expect(out.preferences[0]).toEqual({ layerKind: 'sst',  paletteId: 11, styleName: 'user_3_azure' });
    expect(out.preferences[1]).toEqual({ layerKind: 'wind', paletteId: 12, styleName: 'user_3_storm' });
  });
});
