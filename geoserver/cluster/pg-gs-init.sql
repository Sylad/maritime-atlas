-- Init SQL exécuté par postgres au premier démarrage du conteneur.
-- Reproduit le setup Mini-Blue cible :
--  - DB `maritime` (la même que sur Mini-Blue)
--  - Schema `geoserver` dédié au catalog GS (où vivent JDBCConfig/JDBCStore)
--  - Extensions postgis dans la DB
--  - search_path du user `maritime` = geoserver,public pour que GS
--    voie/crée ses tables dans le schema geoserver par défaut
--
-- Important : ce script tourne dans la DB par défaut au premier boot
-- (= POSTGRES_DB définie dans le compose env). On crée le schema +
-- extensions dans cette DB.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS postgis_raster;

CREATE SCHEMA IF NOT EXISTS geoserver AUTHORIZATION maritime;

-- Toutes les connexions du user maritime utiliseront automatiquement le
-- schema geoserver en premier (sans avoir à passer ?currentSchema=geoserver
-- dans la JDBC URL). Plus simple et compatible avec le mécanisme JNDI natif
-- de l'image OSGeo qui ne supporte pas les query params jdbc personnalisés.
ALTER USER maritime SET search_path TO geoserver, public;
