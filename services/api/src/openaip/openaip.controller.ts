import { Controller, Get, HttpException, HttpStatus, Logger, Post, Query } from '@nestjs/common';
import { OpenAIPService } from './openaip.service';

/**
 * G66f (2026-05-27) — endpoints publics OpenAIP airspaces.
 *
 *   GET /api/fir-airspaces
 *     → GeoJSON FeatureCollection des FIR + UIR (lit DB PostGIS).
 *
 *   POST /api/fir-airspaces/sync (admin-only future, pour l'instant ouvert)
 *     → Force un re-sync depuis OpenAIP. Best-effort.
 *
 * Pas d'auth lecture — donnée publique OpenAIP (open data, free tier).
 */
@Controller()
export class OpenAIPController {
  private readonly log = new Logger('OpenAIPController');

  constructor(private readonly openaip: OpenAIPService) {}

  @Get('fir-airspaces')
  async firAirspaces() {
    try {
      return await this.openaip.getFirAirspaces();
    } catch (err) {
      this.log.error(`getFirAirspaces failed: ${err instanceof Error ? err.message : String(err)}`);
      throw new HttpException(
        { error: 'fir_unavailable', message: err instanceof Error ? err.message : 'unknown' },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  @Post('fir-airspaces/sync')
  async sync() {
    try {
      const r = await this.openaip.syncFromOpenAIP();
      return { status: 'ok', ...r };
    } catch (err) {
      this.log.error(`sync failed: ${err instanceof Error ? err.message : String(err)}`);
      throw new HttpException(
        { error: 'sync_failed', message: err instanceof Error ? err.message : 'unknown' },
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  /**
   * G66l — airports IATA commerciaux (~9000 mondiaux).
   *   GET /api/airports             → tous
   *   GET /api/airports?bbox=lon0,lat0,lon1,lat1 → filtré viewport
   */
  @Get('airports')
  async airports(@Query('bbox') bboxStr?: string) {
    try {
      let bbox: [number, number, number, number] | undefined;
      if (bboxStr) {
        const parts = bboxStr.split(',').map(Number);
        if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
          bbox = parts as [number, number, number, number];
        }
      }
      return await this.openaip.getAirports(bbox);
    } catch (err) {
      this.log.error(`getAirports failed: ${err instanceof Error ? err.message : String(err)}`);
      throw new HttpException(
        { error: 'airports_unavailable', message: err instanceof Error ? err.message : 'unknown' },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  @Post('airports/sync')
  async syncAirports() {
    try {
      const r = await this.openaip.syncAirports();
      return { status: 'ok', ...r };
    } catch (err) {
      this.log.error(`airports sync failed: ${err instanceof Error ? err.message : String(err)}`);
      throw new HttpException(
        { error: 'sync_failed', message: err instanceof Error ? err.message : 'unknown' },
        HttpStatus.BAD_GATEWAY,
      );
    }
  }
}
