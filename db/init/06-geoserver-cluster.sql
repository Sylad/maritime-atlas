-- ─── Sprint 9 — GeoServer cluster bootstrap ─────────────────────────
--
-- 3 replicas GeoServer partagent leur catalog (workspaces/layers/styles)
-- via les community extensions `jdbcconfig` + `jdbcstore`. Plutôt qu'une
-- base séparée, on isole tout dans un schema `geoserver` de la base
-- `maritime` existante : un seul service Postgres à backup, une seule
-- ressource à monitorer.
--
-- GeoServer crée lui-même ses tables (objects, properties, blobs, …) au
-- premier boot — on a juste besoin d'un schema vierge dédié et d'un user
-- avec les droits dessus.
--
-- Référence : https://docs.geoserver.org/latest/en/user/community/jdbcconfig/
-- ─────────────────────────────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS geoserver;

-- Le user `maritime` (POSTGRES_USER par défaut) sert les datastores
-- des services métier (vessels, foudre, alerts). On lui donne aussi
-- ownership du schema geoserver pour que JDBCConfig puisse créer ses
-- tables au premier boot du cluster. Pas de séparation user pour
-- éviter de multiplier les secrets dans le compose — le schema isole
-- déjà bien les concerns.
ALTER SCHEMA geoserver OWNER TO CURRENT_USER;
GRANT ALL ON SCHEMA geoserver TO CURRENT_USER;

-- Note importante : ce script tourne UNE FOIS, à l'init de la base
-- (entrypoint Postgres docker-entrypoint-initdb.d). Si tu veux remettre
-- à zéro le catalog GeoServer pour reprovisionner via le sidecar bash,
-- il faut :
--
--   docker compose down
--   docker volume rm maritime-atlas_geoserver-data
--   docker compose exec postgres psql -U maritime -d maritime -c \
--     "DROP SCHEMA geoserver CASCADE; CREATE SCHEMA geoserver;"
--   docker compose up -d
--
-- Le bootstrap JDBCConfig (initdb=true dans jdbcconfig.properties) va
-- recréer les tables au démarrage du premier replica, puis le sidecar
-- geoserver-provisioner va re-publier workspace/datastore/layers via
-- l'API REST — exactement la même chaîne d'init qu'avant le sprint 9.
