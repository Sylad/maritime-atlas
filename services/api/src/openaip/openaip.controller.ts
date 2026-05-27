import { Controller, Get, HttpException, HttpStatus, Logger, Post } from '@nestjs/common';
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
}
