-- Maritime Atlas — Uniformisation rétention "-1j / +7j" + désactivation
-- des filtres temporels hardcodés dans les views WFS.
--
-- Rationale (Sylvain 2026-05-15) : la time-bar de la map slide entre
-- maintenant - 1j et maintenant + 7j. Aucune donnée hors de cette fenêtre
-- ne sert au rendu : on aligne la rétention dessus. Les filtres
-- `WHERE ts > now() - INTERVAL` à l'intérieur des views WFS empêchaient
-- le replay temporel (slider passé impossible) — on les supprime, le
-- frontend pose désormais CQL_FILTER ancré sur currentTimeSig().
--
-- Idempotent : utilise IF NOT EXISTS / remove_retention_policy avant
-- recréer. Réversible : `add_retention_policy('vessel_positions',
-- INTERVAL '30 days')` pour rétablir l'ancien comportement.

-- ─── 1. Rétention TimescaleDB alignée -1j ───────────────────────────
-- vessel_positions : 30j → 1j. Volume Europe ≈ 14M positions/jour ⇒
-- on garde 1 chunk + le courant. La couverture utile temps-bar = -1j.
SELECT remove_retention_policy('vessel_positions', if_exists => true);
SELECT add_retention_policy('vessel_positions', INTERVAL '1 day', if_not_exists => true);

-- lightning_strikes : 7j → 1j. Strikes très éphémères, 1d largement suffit.
SELECT remove_retention_policy('lightning_strikes', if_exists => true);
SELECT add_retention_policy('lightning_strikes', INTERVAL '1 day', if_not_exists => true);

-- alerts : 14j → 1j. Une alerte > 24h n'a plus de pertinence opérationnelle.
SELECT remove_retention_policy('alerts', if_exists => true);
SELECT add_retention_policy('alerts', INTERVAL '1 day', if_not_exists => true);

-- buoy_observations : 30j → 1j (la vue ne retourne de toute façon que
-- la mesure la plus récente par plateforme).
SELECT remove_retention_policy('buoy_observations', if_exists => true);
SELECT add_retention_policy('buoy_observations', INTERVAL '1 day', if_not_exists => true);

-- ─── 2. Cleanup tables non-hypertable ──────────────────────────────
-- vessels (referential, PRIMARY KEY mmsi) : pas un hypertable, donc
-- pas de add_retention_policy. On reprend cleanup_old_vessels existant
-- en passant de 60j → 1j.
CREATE OR REPLACE PROCEDURE cleanup_old_vessels(job_id int, config jsonb)
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM vessels WHERE last_seen < now() - INTERVAL '1 day';
END $$;

-- vessel_tracks_daily (aggregé 1 row par mmsi×jour) : nouvelle procédure
-- 7j (vs 90j). Les tracks à J-1 sont utiles pour le replay du slider,
-- mais inutile de conserver 3 mois.
CREATE OR REPLACE PROCEDURE cleanup_old_tracks(job_id int, config jsonb)
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM vessel_tracks_daily WHERE day < CURRENT_DATE - INTERVAL '7 days';
END $$;

-- ─── 3. Views WFS : supprimer les filtres temporels hardcodés ──────
-- Le frontend pose CQL_FILTER ancré sur currentTimeSig() pour borner
-- la fenêtre affichée. Les views n'imposent plus de filtre — la
-- rétention -1j fait office de cap supérieur.

-- v_vessels_live : on remplace le WHERE 15min (alteré en prod à 24h
-- → 21k vessels → OOM GS) par une vue sans filtre. Frontend filtre
-- via CQL_FILTER + count=5000 cap.
CREATE OR REPLACE VIEW v_vessels_live AS
SELECT
  v.mmsi,
  v.name,
  v.callsign,
  v.ship_type,
  v.flag,
  v.length_m,
  v.width_m,
  v.destination,
  v.last_seen,
  v.last_position::geometry AS geom
FROM vessels v
WHERE v.last_position IS NOT NULL;

CREATE OR REPLACE VIEW v_lightning_recent AS
SELECT
  EXTRACT(EPOCH FROM ts) AS ts_epoch,
  ts,
  EXTRACT(EPOCH FROM (now() - ts))::INTEGER AS age_seconds,
  geom::geometry AS geom,
  alt,
  mcg,
  pol
FROM lightning_strikes;

CREATE OR REPLACE VIEW v_alerts_recent AS
SELECT
  id,
  ts,
  EXTRACT(EPOCH FROM (now() - ts))::INTEGER AS age_seconds,
  kind,
  severity,
  mmsi,
  vessel_name,
  ship_type,
  geom::geometry AS geom,
  detail
FROM alerts
ORDER BY ts DESC;

-- v_buoy_observations_recent : DISTINCT ON par plateforme (1 obs
-- par buoy, la plus récente toutes périodes confondues). Frontend
-- pose CQL_FILTER sur `ts` pour la fenêtre voulue.
CREATE OR REPLACE VIEW v_buoy_observations_recent AS
SELECT
  o.candhis_id,
  b.name,
  b.platform_type AS buoy_type,
  b.geom,
  o.ts,
  EXTRACT(EPOCH FROM (now() - o.ts))::INTEGER AS age_seconds,
  o.hm0,
  o.h13,
  o.hmax,
  o.tp,
  o.th13,
  o.t02,
  o.peak_dir,
  o.peak_spread,
  o.temp_water
FROM (
  SELECT DISTINCT ON (candhis_id) *
  FROM buoy_observations
  ORDER BY candhis_id, ts DESC
) o
JOIN buoys b USING (candhis_id);

-- ─── 4. GeoServer featuretype reset après ALTER schema ──────────────
-- Si on reset les view definitions sur des layers déjà publiés en
-- WFS, GeoServer cache l'ancien schéma → 400 ServiceException sur
-- les nouvelles requêtes. La rocade manuelle = `curl POST
-- /rest/reset` ; gère côté Job style-bootstrap ou redémarrage GS
-- post-migration (cf geoserver_gotchas.md mémoire).

COMMIT;
