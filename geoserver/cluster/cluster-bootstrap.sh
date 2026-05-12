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

# Ensure the `geoserver` Postgres schema exists before JDBCStore/Config
# tente CREATE TABLE. Idempotent (CREATE SCHEMA IF NOT EXISTS).
# psql baké dans l'image custom via apt postgresql-client.
if command -v psql >/dev/null 2>&1; then
  echo "[cluster-bootstrap] ensure geoserver schema in Postgres…"
  PGPASSWORD="${POSTGRES_PASSWORD}" psql \
    -h "${POSTGRES_HOST}" -p "${POSTGRES_PORT}" \
    -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" \
    -c "CREATE SCHEMA IF NOT EXISTS geoserver;" \
    -v ON_ERROR_STOP=1 \
    2>&1 | sed 's/^/[cluster-bootstrap]   /' || \
    echo "[cluster-bootstrap]   WARN: schema creation failed (continuing)"
else
  echo "[cluster-bootstrap] psql not available — skip schema bootstrap"
fi

echo "[cluster-bootstrap] templating JDBCConfig + JDBCStore properties…"

# Crée les sous-dossiers si absents (premier boot).
mkdir -p "${GEOSERVER_DATA_DIR}/jdbcconfig"
mkdir -p "${GEOSERVER_DATA_DIR}/jdbcstore"
mkdir -p "${GEOSERVER_DATA_DIR}/jdbcstore/scripts"
mkdir -p "${GEOSERVER_DATA_DIR}/jdbcconfig/scripts"

# Copy SQL init scripts (bakés dans l'image à /opt/jdbc-scripts/).
# JDBCStore en a besoin pour CREATE TABLE resource au premier boot.
if [ -d "/opt/jdbc-scripts/jdbcstore" ]; then
  cp -n /opt/jdbc-scripts/jdbcstore/*.sql "${GEOSERVER_DATA_DIR}/jdbcstore/scripts/" 2>/dev/null || true
fi
if [ -d "/opt/jdbc-scripts/jdbcconfig" ]; then
  cp -n /opt/jdbc-scripts/jdbcconfig/*.sql "${GEOSERVER_DATA_DIR}/jdbcconfig/scripts/" 2>/dev/null || true
fi

# Détection idempotence : si la table `object` (JDBCConfig) existe déjà
# en DB, le premier replica a déjà initialisé. Les replicas suivants
# doivent démarrer avec `initdb=false` / `import=false` pour ne pas
# tenter de recréer les tables (CREATE TABLE sans IF NOT EXISTS → fail).
# C'est LE fix de la race condition multi-replica détectée 2026-05-11.
JDBC_INIT_FLAGS="initdb=true"
JDBC_IMPORT_FLAGS="import=true"
JDBCSTORE_INIT_FLAGS="initdb=true"
if command -v psql >/dev/null 2>&1; then
  TABLE_EXISTS=$(PGPASSWORD="${POSTGRES_PASSWORD}" psql \
    -h "${POSTGRES_HOST}" -p "${POSTGRES_PORT}" \
    -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" \
    -tAc "SELECT to_regclass('geoserver.object') IS NOT NULL AND to_regclass('geoserver.resources') IS NOT NULL" 2>/dev/null || echo "f")
  if [ "$TABLE_EXISTS" = "t" ]; then
    echo "[cluster-bootstrap] JDBC tables already initialized — using initdb=false"
    JDBC_INIT_FLAGS="initdb=false"
    JDBC_IMPORT_FLAGS="import=false"
    JDBCSTORE_INIT_FLAGS="initdb=false"
  else
    echo "[cluster-bootstrap] JDBC tables NOT yet initialized — using initdb=true (first replica)"
  fi
fi

# Templating : on lit le template depuis /cluster-config (read-only, monté
# via compose), envsubst injecte POSTGRES_HOST/PORT/DB/USER/PASSWORD,
# on écrit le résultat dans le data_dir partagé. Le sed après envsubst
# bascule initdb/import à false si les tables existent déjà.
envsubst < /cluster-config/jdbcconfig.properties \
  | sed -E "s/^initdb=true/${JDBC_INIT_FLAGS}/" \
  | sed -E "s/^import=true/${JDBC_IMPORT_FLAGS}/" \
  > "${GEOSERVER_DATA_DIR}/jdbcconfig/jdbcconfig.properties"

envsubst < /cluster-config/jdbcstore.properties \
  | sed -E "s/^initdb=true/${JDBCSTORE_INIT_FLAGS}/" \
  > "${GEOSERVER_DATA_DIR}/jdbcstore/jdbcstore.properties"

# Control-Flow extension config : limites concurrent requests par service.
# Copié direct (pas de templating, valeurs hardcodées calibrées NAS quad-core).
# Idempotent : 3 replicas écrivent le même fichier.
if [ -f /cluster-config/controlflow.properties ]; then
  cp /cluster-config/controlflow.properties "${GEOSERVER_DATA_DIR}/controlflow.properties"
  echo "[cluster-bootstrap] control-flow config installed"
fi

# Marqueur d'identité pour debug — visible dans les logs Docker via
# l'env CLUSTER_NODE_ID que chaque replica expose.
echo "${NODE_ID}" > "${GEOSERVER_DATA_DIR}/node-id-${NODE_ID}"

echo "[cluster-bootstrap] done, handing over to GeoServer startup…"

# Délègue à l'entrypoint officiel de l'image. Le path /opt/startup.sh
# est documenté dans https://github.com/geoserver/docker.
exec /opt/startup.sh "$@"
