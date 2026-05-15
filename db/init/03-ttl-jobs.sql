-- Maritime Atlas — jobs TTL périodiques
--
-- TimescaleDB gère vessel_positions via add_retention_policy (cf 01-schema.sql).
-- Pour les autres tables, on installe des jobs TimescaleDB user-defined
-- qui s'exécutent en interne (pas besoin de cron externe).
--
-- TimescaleDB user-defined actions tournent dans le contexte du daemon
-- background_workers. Idempotents via test d'existence.

-- ─── Vessels orphelins : last_seen > 1j ────────────────────────────
-- Alignement -1j/+7j (Sylvain 2026-05-15). On nettoie l'historique
-- du referential vessels au-delà de la fenêtre time-bar — un MMSI
-- pas vu depuis 24h n'apparaît plus sur aucun layer time-anchored,
-- inutile de le garder.
CREATE OR REPLACE PROCEDURE cleanup_old_vessels(job_id int, config jsonb)
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM vessels WHERE last_seen < now() - INTERVAL '1 day';
END $$;

-- ─── Tracks daily : drop > 7 jours ──────────────────────────────────
-- Aggregé 1 row/mmsi/jour, faible volume → garde 7j (la time-bar
-- couvre 1j passé mais on garde 1 semaine pour le confort).
CREATE OR REPLACE PROCEDURE cleanup_old_tracks(job_id int, config jsonb)
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM vessel_tracks_daily
  WHERE day < CURRENT_DATE - INTERVAL '7 days';
END $$;

-- ─── Schedule daily à 03:30 UTC (heure creuse) ──────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM timescaledb_information.jobs WHERE proc_name = 'cleanup_old_vessels') THEN
    PERFORM add_job('cleanup_old_vessels', '1 day', initial_start := (CURRENT_DATE + INTERVAL '1 day' + TIME '03:30')::timestamptz);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM timescaledb_information.jobs WHERE proc_name = 'cleanup_old_tracks') THEN
    PERFORM add_job('cleanup_old_tracks', '1 day', initial_start := (CURRENT_DATE + INTERVAL '1 day' + TIME '03:40')::timestamptz);
  END IF;
END $$;
