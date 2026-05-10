-- Maritime Atlas — sprint 7 lightning strikes
--
-- Source : Blitzortung community network (relayée par lightning-fetcher
-- via WSS). Volume estimé : 10-100 strikes/min en mode actif sur bbox FR,
-- ~5-15K strikes/jour en moyenne.
--
-- TimescaleDB hypertable + retention 7 jours (historique court — l'éclair
-- est un événement vraiment éphémère, pas la peine de garder plus).

CREATE TABLE IF NOT EXISTS lightning_strikes (
  ts          TIMESTAMPTZ NOT NULL,
  geom        GEOGRAPHY(POINT, 4326) NOT NULL,
  alt         REAL,                    -- altitude détectée (m, ~ niveau nuage)
  mcg         INTEGER,                 -- received_count Blitzortung (proxy signal strength)
  pol         SMALLINT,                -- polarité (-1 / +1) si dispo
  status      SMALLINT                 -- bitmask Blitzortung interne
);

SELECT create_hypertable(
  'lightning_strikes', 'ts',
  chunk_time_interval => INTERVAL '1 day',
  if_not_exists => true
);

-- Index spatial pour les SELECT bbox/ST_DWithin du frontend
CREATE INDEX IF NOT EXISTS lightning_strikes_geom_idx
  ON lightning_strikes USING GIST (geom);

-- Retention 7 jours — au-delà, ça n'apporte rien (les strikes ne se
-- consultent pas comme un track historique).
SELECT add_retention_policy(
  'lightning_strikes', INTERVAL '7 days',
  if_not_exists => true
);

-- ─── Vue "strikes récents" exposée via GeoServer WFS ─────────────────
-- 30 min = window logique. Affiché en frontend comme overlay punctual
-- pulsé pour signaler les éclairs très récents (<2min).
CREATE OR REPLACE VIEW v_lightning_recent AS
SELECT
  -- Pseudo-id stable pour OL feature tracking (basé sur ts+lat+lon)
  EXTRACT(EPOCH FROM ts) AS ts_epoch,
  ts,
  EXTRACT(EPOCH FROM (now() - ts))::INTEGER AS age_seconds,
  geom::geometry AS geom,
  alt,
  mcg,
  pol
FROM lightning_strikes
WHERE ts > now() - INTERVAL '30 minutes';
