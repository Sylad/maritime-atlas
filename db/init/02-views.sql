-- Maritime Atlas — vues SQL exposées via GeoServer
--
-- GeoServer expose les vues comme layers WFS (vector) ou WMS-styled
-- (rendered). On évite de pointer GeoServer directement sur la table
-- vessel_positions (4M lignes/jour) — on lui donne des vues focalisées
-- sur "ce que la map affiche".

-- ─── Live vessels (vue sans filtre temporel) ─────────────────────────
-- Sert le layer "Vessels live" de la map. Le frontend pose CQL_FILTER
-- `last_seen BETWEEN [t-15min, t]` ancré sur la time-bar, qui sert
-- aussi pour le replay temporel. La rétention -1j sur vessels (cleanup
-- procedure) borne implicitement le volume scanné.
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

-- ─── Vessels par catégorie (pour styling GeoServer) ──────────────────
-- AIS ship_type buckets standard :
--   30=fishing, 31-32=towing, 33=dredging, 34=diving, 35=military,
--   36=sailing, 37=pleasure
--   60-69=passenger (60=ferry, etc.)
--   70-79=cargo
--   80-89=tanker
--   90+=other
CREATE OR REPLACE VIEW v_vessels_live_categorized AS
SELECT
  v.*,
  CASE
    WHEN v.ship_type BETWEEN 30 AND 37 THEN 'fishing-leisure'
    WHEN v.ship_type BETWEEN 60 AND 69 THEN 'passenger'
    WHEN v.ship_type BETWEEN 70 AND 79 THEN 'cargo'
    WHEN v.ship_type BETWEEN 80 AND 89 THEN 'tanker'
    ELSE 'other'
  END AS category
FROM v_vessels_live v;

-- ─── Tracks du jour (sprint 2) ───────────────────────────────────────
-- Vue paramétrée NON-utilisée encore — placeholder pour le sprint 2.
-- À ce stade vessel_tracks_daily est vide.
CREATE OR REPLACE VIEW v_tracks_today AS
SELECT mmsi, day, geom, points_n
FROM vessel_tracks_daily
WHERE day = CURRENT_DATE;

-- ─── Stats live (sprint 2 dashboard) ─────────────────────────────────
CREATE OR REPLACE VIEW v_stats_live AS
SELECT
  COUNT(*) FILTER (WHERE last_seen > now() - INTERVAL '15 min') AS vessels_live,
  COUNT(*) FILTER (WHERE last_seen > now() - INTERVAL '1 hour') AS vessels_1h,
  COUNT(DISTINCT flag) FILTER (WHERE last_seen > now() - INTERVAL '15 min') AS flags_live,
  COUNT(*) FILTER (WHERE ship_type BETWEEN 70 AND 89 AND last_seen > now() - INTERVAL '15 min') AS commercial_live
FROM vessels;
