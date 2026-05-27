import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { sql } from 'drizzle-orm';
import { DB_TOKEN, type Db } from '../db/db.module';

interface VatspyFeature {
  type: 'Feature';
  properties: {
    id?: string;          // ICAO code (LECM, LFFF, ...) ou sub-sector (LECM-N)
    oceanic?: string;     // "1" si FIR océanique
    label_lon?: string;
    label_lat?: string;
    region?: string;      // EMEA, AMER, APAC, ...
    division?: string;    // VATEUD, VATUSA, ...
  };
  geometry: { type: string; coordinates: unknown };
}

interface VatspyFC {
  type: 'FeatureCollection';
  features: VatspyFeature[];
}

/**
 * G66k (2026-05-27) — bascule de source FIR : OpenAIP (~63 FIR partielles) →
 * VATSpy Data Project (~430 FIR mondiales complètes ICAO).
 *
 * Pourquoi VATSpy ?
 * - OpenAIP n'a pas l'Espagne, Italie, Portugal, Afrique, Moyen-Orient,
 *   Amérique du Sud (focus pilotage GA, pas couverture ATC globale).
 *   Confirmé live 2026-05-27 : `country=ES&type=10 → 0 items`.
 * - VATSpy (https://github.com/vatsimnetwork/vatspy-data-project) est la
 *   source canonique communautaire ICAO FIR maintenue par les VATSIM users.
 *   1 fichier GeoJSON ~2MB, AIRAC-aware, license open source.
 * - 1038 features total = 430 FIR parents + 608 sub-sectors. On garde
 *   seulement les FIR parents (id sans `-`).
 *
 * Schema VATSpy properties :
 *   - id (ICAO code, ex "LECM", "LFFF")
 *   - oceanic ("0" ou "1")
 *   - region (EMEA, AMER, APAC, ...)
 *   - division (VATEUD, VATUSA, ...)
 *   - label_lon / label_lat (position du label sur la map)
 *
 * NOTE : openaipApiKey reste lue côté config car peut servir plus tard pour
 * d'autres endpoints OpenAIP (airports, navaids — mieux couverts qu'avec FIR).
 *
 * @see https://github.com/vatsimnetwork/vatspy-data-project
 */
@Injectable()
export class OpenAIPService implements OnModuleInit {
  private readonly log = new Logger('OpenAIPService');
  private static readonly VATSPY_URL =
    'https://github.com/vatsimnetwork/vatspy-data-project/raw/master/Boundaries.geojson';
  private syncInProgress = false;

  constructor(
    private readonly _config: ConfigService,
    @Inject(DB_TOKEN) private readonly db: Db,
  ) {}

  /** Au boot : si table vide, lance un sync initial (best-effort). */
  async onModuleInit(): Promise<void> {
    try {
      const rows = await this.db.execute(sql`SELECT COUNT(*) AS n FROM fir_airspaces`);
      const n = Number((rows as unknown as Array<{ n: string | number }>)[0]?.n ?? 0);
      if (n === 0) {
        this.log.log('fir_airspaces table empty — déclenche sync VATSpy initial (fire-and-forget).');
        void this.syncFromOpenAIP().catch((err) => {
          this.log.error(`Initial sync échoué : ${err instanceof Error ? err.message : String(err)}`);
        });
      } else {
        this.log.log(`fir_airspaces déjà peuplée (${n} rows) — skip initial sync.`);
      }
    } catch (err) {
      this.log.warn(`onModuleInit count check failed : ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Cron : tous les dimanches 03:00 UTC. AIRAC cycle 28j → weekly OK. */
  @Cron('0 3 * * 0', { name: 'vatspy-fir-sync', timeZone: 'UTC' })
  async cronSync(): Promise<void> {
    this.log.log('Cron weekly sync VATSpy FIR…');
    await this.syncFromOpenAIP();
  }

  /**
   * Méthode keeps `syncFromOpenAIP` name pour compat avec OpenAIPController
   * (POST /api/fir-airspaces/sync). Sous le capot, fetch VATSpy.
   */
  async syncFromOpenAIP(): Promise<{ inserted: number; updated: number }> {
    if (this.syncInProgress) {
      this.log.warn('Sync FIR déjà en cours, skip.');
      return { inserted: 0, updated: 0 };
    }
    this.syncInProgress = true;
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    const seenIds: string[] = [];
    try {
      const resp = await fetch(OpenAIPService.VATSPY_URL, {
        headers: { 'User-Agent': 'aetherwx/vatspy-sync', 'Accept': 'application/geo+json,application/json' },
      });
      if (!resp.ok) {
        throw new Error(`VATSpy Boundaries.geojson HTTP ${resp.status}`);
      }
      const fc = await resp.json() as VatspyFC;
      if (fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
        throw new Error('VATSpy response not a FeatureCollection');
      }
      for (const feat of fc.features) {
        const id = feat.properties?.id;
        if (!id || !feat.geometry) { skipped++; continue; }
        // Filter : on garde seulement les FIR parents (pas les sub-sectors
        // qui contiennent un `-` séparateur, ex "LECM-N", "LFFF-E").
        if (id.includes('-')) { skipped++; continue; }
        seenIds.push(id);
        const country = id.substring(0, 2);   // ICAO country prefix (LE, LF, EG, ...)
        const isOceanic = feat.properties?.oceanic === '1';
        const geomJson = JSON.stringify(feat.geometry);
        const result = await this.db.execute(sql`
          INSERT INTO fir_airspaces (
            openaip_id, name, country, icao_class, type,
            upper_limit_ft, lower_limit_ft, activity, on_demand,
            geom, updated_at
          ) VALUES (
            ${id},
            ${id},
            ${country},
            ${null},
            ${isOceanic ? 'UIR' : 'FIR'},
            ${null},
            ${null},
            ${feat.properties?.region ?? null},
            ${null},
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
        if (wasInsert) inserted++; else updated++;
      }
      // DELETE les rows pas vus dans le batch courant (cleanup obsolètes +
      // anciennes entries OpenAIP qui avaient des `_id` MongoDB longs).
      let deleted = 0;
      if (seenIds.length > 0) {
        // Escape simple quotes pour éviter injection (mais les ICAO codes
        // sont alphanumériques uniquement, donc safe en pratique).
        const escapedIds = seenIds.map((i) => `'${i.replace(/'/g, "''")}'`).join(',');
        const delResult = await this.db.execute(sql`
          DELETE FROM fir_airspaces
          WHERE openaip_id NOT IN ${sql.raw(`(${escapedIds})`)}
        `);
        deleted = Number((delResult as unknown as { count?: number }).count ?? 0);
      }
      this.log.log(`Sync VATSpy terminé : ${inserted} insérés, ${updated} updatés, ${deleted} supprimés, ${skipped} skipped (sub-sectors).`);
      return { inserted, updated };
    } finally {
      this.syncInProgress = false;
    }
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
        activity: r['activity'],   // VATSpy region (EMEA/AMER/APAC) stocké ici
        onDemand: r['on_demand'],
      },
    }));
    return { type: 'FeatureCollection', features };
  }
}
