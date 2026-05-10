#!/bin/bash
set -e

# ─── GeoServer cluster bootstrap (Sprint 9) ──────────────────────────
#
# Wrapper d'entrypoint pour les replicas geoserver. Rôle :
#  1. Templater jdbcconfig.properties et jdbcstore.properties avec les
#     credentials Postgres (envsubst sur les placeholders ${VAR}).
#  2. Les déposer aux emplacements attendus par GeoServer :
#        ${GEOSERVER_DATA_DIR}/jdbcconfig/jdbcconfig.properties
#        ${GEOSERVER_DATA_DIR}/jdbcstore/jdbcstore.properties
#  3. Marquer le replica avec son ID (utile pour les logs et l'audit
#     côté provisioner) via un fichier `node-id`.
#  4. Déléguer à l'entrypoint officiel de l'image (/opt/startup.sh).
#
# Important : ce script tourne sur CHAQUE replica au boot. Comme les 3
# replicas partagent le même volume `geoserver-data`, écrire le même
# fichier 3× est OK (idempotent, contenu identique).
#
# Le templating utilise envsubst qui ne touche pas aux $ littéraux —
# uniquement aux ${VAR_NAME}. C'est exactement ce qu'on veut.
# ─────────────────────────────────────────────────────────────────────

GEOSERVER_DATA_DIR="${GEOSERVER_DATA_DIR:-/opt/geoserver_data}"
NODE_ID="${GEOSERVER_NODE_ID:-unknown}"

echo "[cluster-bootstrap] node-id=${NODE_ID}"
echo "[cluster-bootstrap] templating JDBCConfig + JDBCStore properties…"

# Crée les sous-dossiers si absents (premier boot).
mkdir -p "${GEOSERVER_DATA_DIR}/jdbcconfig"
mkdir -p "${GEOSERVER_DATA_DIR}/jdbcstore"

# Templating : on lit le template depuis /cluster-config (read-only, monté
# via compose), envsubst injecte POSTGRES_HOST/PORT/DB/USER/PASSWORD,
# on écrit le résultat dans le data_dir partagé.
envsubst < /cluster-config/jdbcconfig.properties \
  > "${GEOSERVER_DATA_DIR}/jdbcconfig/jdbcconfig.properties"

envsubst < /cluster-config/jdbcstore.properties \
  > "${GEOSERVER_DATA_DIR}/jdbcstore/jdbcstore.properties"

# Marqueur d'identité pour debug — visible dans les logs Docker via
# l'env CLUSTER_NODE_ID que chaque replica expose.
echo "${NODE_ID}" > "${GEOSERVER_DATA_DIR}/node-id-${NODE_ID}"

echo "[cluster-bootstrap] done, handing over to GeoServer startup…"

# Délègue à l'entrypoint officiel de l'image. Le path /opt/startup.sh
# est documenté dans https://github.com/geoserver/docker.
exec /opt/startup.sh "$@"
