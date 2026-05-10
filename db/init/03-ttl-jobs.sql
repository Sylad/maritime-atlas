-- Maritime Atlas — jobs TTL périodiques
--
-- TimescaleDB gère vessel_positions via add_retention_policy (cf 01-schema.sql).
-- Pour les autres tables, on installe des jobs TimescaleDB user-defined
-- qui s'exécutent en interne (pas besoin de cron externe).
--
-- TimescaleDB user-defined actions tournent dans le contexte du daemon
-- background_workers. Idempotents via test d'existence.

-- ─── Vessels orphelins : last_seen > 60j sans position récente ──────
-- Un MMSI vu une seule fois (faux positifs, mauvais décodage) ou
-- inactif depuis 2 mois pollue la table vessels. Drop pour garder
-- la liste propre.
CREATE OR REPLACE PROCEDURE cleanup_old_vessels(job_id int, config jsonb)
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM vessels
  WHERE last_seen < now() - INTERVAL '60 days'
     OR last_seen IS NULL AND first_seen < now() - INTERVAL '7 days';
  RAISE NOTICE 'cleanup_old_vessels: % rows deleted', (SELECT pg_stat_get_xact_tuples_deleted(c.oid) FROM pg_class c WHERE c.relname = 'vessels');
END $$;

-- ─── Alerts résolus : drop > 90 jours ───────────────────────────────
CREATE OR REPLACE PROCEDURE cleanup_old_alerts(job_id int, config jsonb)
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM alerts
  WHERE resolved_at IS NOT NULL AND resolved_at < now() - INTERVAL '90 days';
END $$;

-- ─── Tracks daily : drop > 90 jours ─────────────────────────────────
CREATE OR REPLACE PROCEDURE cleanup_old_tracks(job_id int, config jsonb)
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM vessel_tracks_daily
  WHERE day < CURRENT_DATE - INTERVAL '90 days';
END $$;

-- ─── Schedule daily à 03:30 UTC (heure creuse) ──────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM timescaledb_information.jobs WHERE proc_name = 'cleanup_old_vessels') THEN
    PERFORM add_job('cleanup_old_vessels', '1 day', initial_start := (CURRENT_DATE + INTERVAL '1 day' + TIME '03:30')::timestamptz);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM timescaledb_information.jobs WHERE proc_name = 'cleanup_old_alerts') THEN
    PERFORM add_job('cleanup_old_alerts', '1 day', initial_start := (CURRENT_DATE + INTERVAL '1 day' + TIME '03:35')::timestamptz);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM timescaledb_information.jobs WHERE proc_name = 'cleanup_old_tracks') THEN
    PERFORM add_job('cleanup_old_tracks', '1 day', initial_start := (CURRENT_DATE + INTERVAL '1 day' + TIME '03:40')::timestamptz);
  END IF;
END $$;
