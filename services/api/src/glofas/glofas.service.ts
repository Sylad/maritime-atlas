import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { AxiosResponse } from 'axios';
import {
  GlofasTimeSeriesPoint,
  GlofasTimeSeriesResponse,
} from './glofas.types';

/**
 * Task 11 — GloFAS point-wise time series.
 *
 * Queries the 3 GeoServer WMS time-enabled layers
 *   aetherwx:glofas-flood-prob-{q5,q20,q50}
 * (Task 13 fed by the `glofas-fetcher` Python sidecar) via GetFeatureInfo at
 * 7 leadtimes [24,48,72,96,120,144,168]h relative to today 00:00 UTC.
 *
 * 21 parallel requests → 7 time-series points {Q5,Q20,Q50}.
 *
 * Cache: 1h in-memory keyed by ("lon|lat" rounded to 1e-4°).
 */
const LEADTIMES_H = [24, 48, 72, 96, 120, 144, 168] as const;
const THRESHOLDS = ['q5', 'q20', 'q50'] as const;
type Threshold = (typeof THRESHOLDS)[number];

const CACHE_TTL_MS = 60 * 60 * 1000; // 1h
const BBOX_HALF = 0.0001; // ~11m at equator, 1×1 px GFI

interface GfiFeature {
  properties?: Record<string, unknown>;
}
interface GfiResponse {
  features?: GfiFeature[];
}

@Injectable()
export class GlofasService {
  private readonly logger = new Logger(GlofasService.name);
  private readonly cache = new Map<
    string,
    { ts: number; value: GlofasTimeSeriesResponse }
  >();

  constructor(private readonly http: HttpService) {}

  private getWmsUrl(): string {
    return (
      process.env.GS_WMS_URL ||
      'http://geoserver:8080/geoserver/aetherwx/wms'
    );
  }

  /** today 00:00 UTC ISO — matches the run reference used by the CronWorkflow. */
  private getRunTimeIso(): string {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  private addHoursIso(baseIso: string, hours: number): string {
    const d = new Date(baseIso);
    d.setUTCHours(d.getUTCHours() + hours);
    return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  private buildGfiUrl(
    lon: number,
    lat: number,
    threshold: Threshold,
    timeIso: string,
  ): string {
    const minx = lon - BBOX_HALF;
    const miny = lat - BBOX_HALF;
    const maxx = lon + BBOX_HALF;
    const maxy = lat + BBOX_HALF;
    const params = new URLSearchParams({
      SERVICE: 'WMS',
      VERSION: '1.1.1',
      REQUEST: 'GetFeatureInfo',
      LAYERS: `aetherwx:glofas-flood-prob-${threshold}`,
      QUERY_LAYERS: `aetherwx:glofas-flood-prob-${threshold}`,
      SRS: 'EPSG:4326',
      BBOX: `${minx},${miny},${maxx},${maxy}`,
      WIDTH: '1',
      HEIGHT: '1',
      X: '0',
      Y: '0',
      INFO_FORMAT: 'application/json',
      FEATURE_COUNT: '1',
      TIME: timeIso,
    });
    return `${this.getWmsUrl()}?${params.toString()}`;
  }

  private extractPixelValue(data: unknown): number | null {
    if (!data || typeof data !== 'object') return null;
    const features = (data as GfiResponse).features;
    if (!Array.isArray(features) || features.length === 0) return null;
    const props = features[0].properties;
    if (!props || typeof props !== 'object') return null;
    const raw =
      (props as Record<string, unknown>)['GRAY_INDEX'] ??
      (props as Record<string, unknown>)['gray_index'] ??
      (props as Record<string, unknown>)['value'];
    if (raw === null || raw === undefined) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  async getTimeSeries(
    lon: number,
    lat: number,
  ): Promise<GlofasTimeSeriesResponse> {
    const key = `${lon.toFixed(4)}|${lat.toFixed(4)}`;
    const cached = this.cache.get(key);
    const now = Date.now();
    if (cached && now - cached.ts < CACHE_TTL_MS) {
      return cached.value;
    }

    const run = this.getRunTimeIso();
    // Build 21 requests (3 thresholds × 7 leadtimes), preserving order so we
    // can index back into [leadtime][threshold] after Promise.all resolves.
    const tasks: Array<{
      threshold: Threshold;
      leadtimeH: number;
      ts: string;
      url: string;
    }> = [];
    for (const leadtimeH of LEADTIMES_H) {
      const ts = this.addHoursIso(run, leadtimeH);
      for (const threshold of THRESHOLDS) {
        tasks.push({
          threshold,
          leadtimeH,
          ts,
          url: this.buildGfiUrl(lon, lat, threshold, ts),
        });
      }
    }

    const responses = await Promise.all(
      tasks.map((t) =>
        firstValueFrom(this.http.get(t.url))
          .then((r: AxiosResponse<unknown>) => this.extractPixelValue(r.data))
          .catch((err: unknown) => {
            this.logger.warn(
              `GFI failed [${t.threshold} +${t.leadtimeH}h]: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
            return null;
          }),
      ),
    );

    // Re-assemble into 7 points × 3 thresholds.
    const series: GlofasTimeSeriesPoint[] = LEADTIMES_H.map((leadtimeH, i) => {
      const base = i * THRESHOLDS.length;
      return {
        ts: tasks[base].ts,
        Q5: responses[base + 0],
        Q20: responses[base + 1],
        Q50: responses[base + 2],
      };
    });

    const anyValue = responses.some((v) => v !== null);
    const result: GlofasTimeSeriesResponse = anyValue
      ? { available: true, lon, lat, run, series }
      : { available: false, lon, lat, run, series: [] };

    this.cache.set(key, { ts: now, value: result });
    return result;
  }
}
