-- Maritime Atlas — sprint 10 alerts engine
--
-- Persist les alertes générées par alerts-engine (subscriber RMQ pour
-- ais.positions + lightning.strike + raster.ready). Retention 7 jours
-- (l'alerte plus vieille perd son sens opérationnel).

-- Drop & recreate (idempotent en dev — schema simple, on accepte la perte
-- des alertes lors d'un changement de migration).
DROP TABLE IF EXISTS alerts CASCADE;

CREATE TABLE alerts (
  ts            TIMESTAMPTZ NOT NULL DEFAULT now(),
  id            BIGSERIAL,
  kind          TEXT NOT NULL,                       -- 'lightning-proximity' | 'storm-cargo' | 'high-wind'
  severity      TEXT NOT NULL,                       -- 'info' | 'warning' | 'danger'
  mmsi          BIGINT,
  vessel_name   TEXT,
  ship_type     SMALLINT,
  geom          GEOGRAPHY(POINT, 4326) NOT NULL,
  detail        JSONB,
  PRIMARY KEY (ts, id)                               -- composite : ts est obligatoire dans la PK pour hypertable
);

CREATE INDEX IF NOT EXISTS alerts_kind_idx ON alerts (kind, ts DESC);
CREATE INDEX IF NOT EXISTS alerts_geom_idx ON alerts USING GIST (geom);

SELECT create_hypertable(
  'alerts', 'ts',
  chunk_time_interval => INTERVAL '7 days',
  if_not_exists => true
);
SELECT add_retention_policy(
  'alerts', INTERVAL '1 day',
  if_not_exists => true
);

-- ─── Vue "alertes récentes" exposée via GeoServer ───────────────────
-- Pas de filtre temporel hardcodé : le frontend pose CQL_FILTER ancré
-- sur la time-bar (fenêtre par défaut 1h). La rétention 1j cap le
-- volume sans tronquer le replay temporel.
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
