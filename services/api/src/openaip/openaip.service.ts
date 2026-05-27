import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { sql } from 'drizzle-orm';
import { DB_TOKEN, type Db } from '../db/db.module';

interface OpenAIPLimit {
  value?: number;
  unit?: number; // 1=FL flight level, 6=feet AMSL, etc. (cf doc OpenAIP)
}

interface OpenAIPAirspaceItem {
  _id?: string;
  id?: string;
  name?: string;
  country?: string;
  icaoClass?: string;
  activity?: string;
  onDemand?: boolean;
  upperLimit?: OpenAIPLimit;
  lowerLimit?: OpenAIPLimit;
  geometry?: { type: string; coordinates: unknown };
}

/**
 * G66f (2026-05-27) — Sync OpenAIP FIR/UIR airspaces vers PostGIS.
 *
 * Architecture (sur recommandation Sylvain) :
 * - Table `fir_airspaces` (PostGIS Geometry 4326) — voir migrate.ts
 * - Sync au boot si table vide
 * - Cron hebdomadaire dimanche 03:00 UTC (cycle AIRAC = 28j, weekly amplement OK)
 * - Endpoint /api/fir-airspaces lit la DB → GeoJSON FeatureCollection
 *
 * Pourquoi en DB plutôt qu'en mémoire :
 * - Survit aux restarts du pod
 * - Partagé entre replicas
 * - Permet des spatial joins futurs (ex: ST_Contains pour mapper un vessel
 *   à sa FIR de survol)
 * - AIRAC cycle 28j → refresh weekly suffit, pas de stress sur free tier
 *   OpenAIP
 *
 * Type codes OpenAIP airspaces :
 *   - 14 = FIR (Flight Information Region)
 *   - 15 = UIR (Upper Information Region)
 * Cf https://api.core.openaip.net/api/docs (header `x-openaip-api-key` — G66h
 * 2026-05-27 : ancien `x-openaip-client-id` deprecated, renvoie 403
 * "No authenticated user found. Verify user first").
 */
@Injectable()
export class OpenAIPService implements OnModuleInit {
  private readonly log = new Logger('OpenAIPService');
  private readonly apiKey: string;
  private syncInProgress = false;

  constructor(
    private readonly config: ConfigService,
    @Inject(DB_TOKEN) private readonly db: Db,
  ) {
    this.apiKey = config.get<string>('openaipApiKey') ?? '';
    if (!this.apiKey) {
      this.log.warn('OPENAIP_API_KEY non configuré — sync FIR désactivée.');
    }
  }

  /** Au boot : si table vide, lance un sync initial (best-effort). */
  async onModuleInit(): Promise<void> {
    if (!this.apiKey) return;
    try {
      const rows = await this.db.execute(sql`SELECT COUNT(*) AS n FROM fir_airspaces`);
      const n = Number((rows as unknown as Array<{ n: string | number }>)[0]?.n ?? 0);
      if (n === 0) {
        this.log.log('fir_airspaces table empty — déclenche sync OpenAIP initial (fire-and-forget).');
        // Fire-and-forget : ne bloque pas le boot. Le 1er request /api/fir-airspaces
        // pendant la sync renverra une FC vide, mais c'est OK pour bootstrapping.
        void this.syncFromOpenAIP().catch((err) => {
          this.log.error(`Initial sync échoué : ${err instanceof Error ? err.message : String(err)}`);
        });
      } else {
        this.log.log(`fir_airspaces déjà peuplée (${n} rows) — skip initial sync.`);
      }
    } catch (err) {
      // Migration peut-être pas encore appliquée — non-fatal.
      this.log.warn(`onModuleInit count check failed : ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Cron : tous les dimanches 03:00 UTC. AIRAC cycle 28j → weekly OK. */
  @Cron('0 3 * * 0', { name: 'openaip-fir-sync', timeZone: 'UTC' })
  async cronSync(): Promise<void> {
    if (!this.apiKey) return;
    this.log.log('Cron weekly sync OpenAIP FIR/UIR…');
    await this.syncFromOpenAIP();
  }

  /**
   * Fetch + UPSERT FIR + UIR depuis OpenAIP. Lock concurrent calls via
   * `syncInProgress` (évite 2 sync simultanés si boot + cron se chevauchent).
   */
  async syncFromOpenAIP(): Promise<{ inserted: number; updated: number }> {
    if (!this.apiKey) {
      throw new Error('OPENAIP_API_KEY missing');
    }
    if (this.syncInProgress) {
      this.log.warn('Sync OpenAIP déjà en cours, skip.');
      return { inserted: 0, updated: 0 };
    }
    this.syncInProgress = true;
    let inserted = 0;
    let updated = 0;
    try {
      for (const [typeCode, typeLabel] of [[14, 'FIR'], [15, 'UIR']] as const) {
        const items = await this.fetchAllPages(typeCode);
        for (const item of items) {
          if (!item.geometry || !item._id) continue;
          const id = item._id ?? item.id;
          if (!id) continue;
          // ST_GeomFromGeoJSON pour parser la geometry GeoJSON serialisée.
          const geomJson = JSON.stringify(item.geometry);
          // upperLimit/lowerLimit : extraire value en feet si dispo
          const upperFt = item.upperLimit?.value ?? null;
          const lowerFt = item.lowerLimit?.value ?? null;
          // UPSERT idempotent — type peut changer si OpenAIP recatégorise.
          const result = await this.db.execute(sql`
            INSERT INTO fir_airspaces (
              openaip_id, name, country, icao_class, type,
              upper_limit_ft, lower_limit_ft, activity, on_demand,
              geom, updated_at
            ) VALUES (
              ${id},
              ${item.name ?? '(unnamed)'},
              ${item.country ?? null},
              ${item.icaoClass ?? null},
              ${typeLabel},
              ${upperFt},
              ${lowerFt},
              ${item.activity ?? null},
              ${item.onDemand ?? null},
              ST_SetSRID(ST_GeomFromGeoJSON(${geomJson}), 4326),
              NOW()
            )
            ON CONFLICT (openaip_id) DO UPDATE SET
              name = EXCLUDED.name,
              country = EXCLUDED.country,
              icao_class = EXCLUDED.icao_class,
              type = EXCLUDED.type,
              upper_limit_ft = EXCLUDED.upper_limit_ft,
              lower_limit_ft = EXCLUDED.lower_limit_ft,
              activity = EXCLUDED.activity,
              on_demand = EXCLUDED.on_demand,
              geom = EXCLUDED.geom,
              updated_at = NOW()
            RETURNING (xmax = 0) AS inserted
          `);
          const wasInsert = (result as unknown as Array<{ inserted: boolean }>)[0]?.inserted;
          if (wasInsert) inserted++;
          else updated++;
        }
      }
      this.log.log(`Sync OpenAIP terminé : ${inserted} insérés, ${updated} updatés.`);
      return { inserted, updated };
    } finally {
      this.syncInProgress = false;
    }
  }

  /** Pagine sur /api/airspaces?type=<n>&limit=1000 jusqu'à totalPages. */
  private async fetchAllPages(typeCode: number): Promise<OpenAIPAirspaceItem[]> {
    const out: OpenAIPAirspaceItem[] = [];
    let page = 1;
    const limit = 1000;
    while (true) {
      const url = `https://api.core.openaip.net/api/airspaces?type=${typeCode}&limit=${limit}&page=${page}`;
      const resp = await fetch(url, {
        headers: {
          'x-openaip-api-key': this.apiKey,
          'Accept': 'application/json',
          'User-Agent': 'aetherwx/openaip-sync',
        },
      });
      if (!resp.ok) {
        throw new Error(`OpenAIP /airspaces type=${typeCode} page=${page} HTTP ${resp.status}`);
      }
      const body = (await resp.json()) as { items?: OpenAIPAirspaceItem[]; totalPages?: number };
      const items = body.items ?? [];
      out.push(...items);
      const totalPages = body.totalPages ?? 1;
      if (page >= totalPages) break;
      page++;
      if (page > 20) {
        this.log.warn(`OpenAIP pagination cap atteint (page=${page}, type=${typeCode}).`);
        break;
      }
    }
    return out;
  }

  /** Lit la table fir_airspaces et retourne une FeatureCollection GeoJSON. */
  async getFirAirspaces(): Promise<{ type: 'FeatureCollection'; features: unknown[] }> {
    const rows = await this.db.execute(sql`
      SELECT
        openaip_id, name, country, icao_class, type,
        upper_limit_ft, lower_limit_ft, activity, on_demand,
        ST_AsGeoJSON(geom)::json AS geometry
      FROM fir_airspaces
      ORDER BY type, country, name
    `);
    const features = (rows as Array<Record<string, unknown>>).map((r) => ({
      type: 'Feature' as const,
      geometry: r['geometry'],
      properties: {
        id: r['openaip_id'],
        name: r['name'],
        country: r['country'],
        icaoClass: r['icao_class'],
        type: r['type'],
        upperLimitFt: r['upper_limit_ft'],
        lowerLimitFt: r['lower_limit_ft'],
        activity: r['activity'],
        onDemand: r['on_demand'],
      },
    }));
    return { type: 'FeatureCollection', features };
  }
}
