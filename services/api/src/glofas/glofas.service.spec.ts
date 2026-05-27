import { Test, TestingModule } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { AxiosResponse } from 'axios';
import { Observable, of } from 'rxjs';
import { GlofasService } from './glofas.service';

const mkResponse = (data: unknown): Observable<AxiosResponse<unknown>> =>
  of({
    data,
    status: 200,
    statusText: 'OK',
    headers: {},
    config: { headers: {} as never },
  } as AxiosResponse<unknown>);

describe('GlofasService', () => {
  let service: GlofasService;
  let http: HttpService;

  beforeEach(async () => {
    process.env.GS_WMS_URL = 'http://geoserver:8080/geoserver/aetherwx/wms';

    const httpMock = {
      get: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GlofasService,
        { provide: HttpService, useValue: httpMock },
      ],
    }).compile();

    service = module.get<GlofasService>(GlofasService);
    http = module.get<HttpService>(HttpService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('issues 21 parallel GetFeatureInfo requests (3 seuils × 7 leadtimes)', async () => {
    const getSpy = jest
      .spyOn(http, 'get')
      .mockReturnValue(
        mkResponse({ features: [{ properties: { GRAY_INDEX: 0.42 } }] }),
      );

    const res = await service.getTimeSeries(2.5, 48.8);

    expect(getSpy).toHaveBeenCalledTimes(21);
    expect(res.available).toBe(true);
    expect(res.series).toHaveLength(7);
    for (const point of res.series) {
      expect(typeof point.ts).toBe('string');
      expect(typeof point.Q5).toBe('number');
      expect(typeof point.Q20).toBe('number');
      expect(typeof point.Q50).toBe('number');
      expect(point.Q5).toBeCloseTo(0.42);
    }
  });

  it('returns available=false when all features are empty (point in nodata)', async () => {
    jest.spyOn(http, 'get').mockReturnValue(mkResponse({ features: [] }));

    const res = await service.getTimeSeries(0, 0);

    expect(res.available).toBe(false);
    expect(res.series).toEqual([]);
    expect(res.lon).toBe(0);
    expect(res.lat).toBe(0);
  });

  it('caches identical (lon, lat) within TTL', async () => {
    const getSpy = jest
      .spyOn(http, 'get')
      .mockReturnValue(
        mkResponse({ features: [{ properties: { GRAY_INDEX: 0.1 } }] }),
      );

    await service.getTimeSeries(7.5, 50.8);
    await service.getTimeSeries(7.5, 50.8);

    expect(getSpy).toHaveBeenCalledTimes(21);
  });
});
