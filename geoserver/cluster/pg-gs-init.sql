-- Init SQL exécuté par postgres au premier démarrage du conteneur.
-- Crée les extensions PostGIS dans la DB geoserver (création automatique
-- de spatial_ref_sys avec ses 8500 SRS — requis par Kartoza/OSGeo GS
-- wait-for-postgres et par ImageMosaic JDBC pour stocker la geometry des
-- granules).
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS postgis_raster;
