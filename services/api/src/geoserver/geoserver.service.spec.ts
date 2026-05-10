import { ConfigService } from '@nestjs/config';
import { GeoServerService } from './geoserver.service';

describe('GeoServerService.buildSld', () => {
  const svc = new GeoServerService({ get: () => undefined } as unknown as ConfigService);

  it('emits a valid SLD XML with sorted color stops', () => {
    const sld = svc.buildSld('user_1_marine', [
      { quantity: 5, color: '#0000ff', opacity: 0.6 },
      { quantity: 0, color: '#ffffff', opacity: 0.0 },     // intentionally out-of-order
      { quantity: 25, color: '#ff0000', opacity: 0.95, label: 'tempête' },
    ]);
    // Sorted ascending by quantity in the output
    const idx0 = sld.indexOf('quantity="0"');
    const idx5 = sld.indexOf('quantity="5"');
    const idx25 = sld.indexOf('quantity="25"');
    expect(idx0).toBeGreaterThan(0);
    expect(idx5).toBeGreaterThan(idx0);
    expect(idx25).toBeGreaterThan(idx5);
    // Label exposed
    expect(sld).toContain('label="tempête"');
    // Style name in NamedLayer
    expect(sld).toContain('<Name>user_1_marine</Name>');
    // ColorMap ramp
    expect(sld).toContain('<ColorMap type="ramp">');
  });

  it('styleNameFor produces user_<id>_<slug>', () => {
    expect(svc.styleNameFor(42, 'marine-chaude')).toBe('user_42_marine-chaude');
  });
});
