#!/bin/bash
set -e

# ─── GeoServer cluster bootstrap — sprint refacto archi 2026-05-16 ───
#
# Wrapper d'entrypoint pour les replicas geoserver. Rôle (dans l'ordre) :
#  1. CREATE DATABASE `geoserver` si absente (idempotent côté Postgres).
#  2. envsubst sur le template Tomcat context.xml.tpl → context.xml
#     (datasource JNDI jdbc/geoserver, sessions store, etc.)
#  3. CREATE TABLE `tomcat_sessions` (requis par JDBC sessions Tomcat).
#  4. Templater jdbcconfig.properties / jdbcstore.properties en mode
#     JNDI (jndiName référence le datasource Tomcat, pas de credentials
#     hardcodés).
#  5. Détection idempotence : si les tables JDBCConfig existent déjà
#     (premier replica les a créées), bascule initdb=false / import=false
#     pour éviter les race conditions multi-replica.
#  6. Déléguer à l'entrypoint kartoza (/scripts/start.sh).
#
# Ce script est mounté via ConfigMap (cluster-bootstrap-script) en
# /scripts/cluster-bootstrap.sh, et appelé comme entrypoint custom du
# pod GS (override de l'ENTRYPOINT kartoza). Idempotent et safe à run
# sur chaque restart.
# ─────────────────────────────────────────────────────────────────────

GEOSERVER_DATA_DIR="${GEOSERVER_DATA_DIR:-/opt/geoserver_data}"
TOMCAT_CONTEXT_TPL="${TOMCAT_CONTEXT_TPL:-/usr/local/tomcat/conf/context.xml.tpl}"
TOMCAT_CONTEXT="${TOMCAT_CONTEXT:-/usr/local/tomcat/conf/context.xml}"

NODE_ID="${GEOSERVER_NODE_ID:-${HOSTNAME:-unknown}}"
echo "[cluster-bootstrap] node-id=${NODE_ID}"

# ── 1. CREATE DATABASE geoserver if missing ─────────────────────────
# Note : on connecte initialement à la DB par défaut (POSTGRES_DB =
# maritime habituellement) pour pouvoir lancer CREATE DATABASE. Postgres
# ne supporte pas CREATE DATABASE IF NOT EXISTS, on simule via SELECT.
if [ -n "${GEOSERVER_DB_NAME:-}" ] && command -v psql >/dev/null 2>&1; then
  echo "[cluster-bootstrap] ensure DB '${GEOSERVER_DB_NAME}' exists in pg-catalog…"
  DB_EXISTS=$(PGPASSWORD="${POSTGRES_PASSWORD}" psql \
    -h "${POSTGRES_HOST}" -p "${POSTGRES_PORT:-5432}" \
    -U "${POSTGRES_USER}" -d "${POSTGRES_DB:-postgres}" \
    -tAc "SELECT 1 FROM pg_database WHERE datname='${GEOSERVER_DB_NAME}'" 2>/dev/null || echo "")
  if [ "$DB_EXISTS" = "1" ]; then
    echo "[cluster-bootstrap]   DB already exists, skipping CREATE"
  else
    PGPASSWORD="${POSTGRES_PASSWORD}" psql \
      -h "${POSTGRES_HOST}" -p "${POSTGRES_PORT:-5432}" \
      -U "${POSTGRES_USER}" -d "${POSTGRES_DB:-postgres}" \
      -c "CREATE DATABASE \"${GEOSERVER_DB_NAME}\";" \
      2>&1 | sed 's/^/[cluster-bootstrap]   /' || \
      echo "[cluster-bootstrap]   WARN: CREATE DATABASE failed (maybe race with another replica)"
  fi
fi

# ── 2. envsubst sur context.xml.tpl → context.xml ──────────────────
# Le template versionné contient ${POSTGRES_HOST}, ${GEOSERVER_DB_USER},
# ${GEOSERVER_DB_PASSWORD}, etc. envsubst injecte depuis les env vars
# du pod (qui viennent du Deployment + Secrets K8s).
if [ -f "${TOMCAT_CONTEXT_TPL}" ]; then
  echo "[cluster-bootstrap] templating Tomcat context.xml from ${TOMCAT_CONTEXT_TPL}"
  envsubst < "${TOMCAT_CONTEXT_TPL}" > "${TOMCAT_CONTEXT}"
  echo "[cluster-bootstrap]   wrote ${TOMCAT_CONTEXT}"
fi

# ── 3. CREATE TABLE tomcat_sessions if missing ──────────────────────
# Tomcat PersistentManager + DataSourceStore ne crée PAS la table tout
# seul (contrairement à JDBCConfig/JDBCStore). On s'en occupe ici en SQL
# idempotent. Schema standard Tomcat 9 docs.
if command -v psql >/dev/null 2>&1; then
  echo "[cluster-bootstrap] ensure tomcat_sessions table in DB '${GEOSERVER_DB_NAME}'…"
  PGPASSWORD="${GEOSERVER_DB_PASSWORD}" psql \
    -h "${POSTGRES_HOST}" -p "${POSTGRES_PORT:-5432}" \
    -U "${GEOSERVER_DB_USER}" -d "${GEOSERVER_DB_NAME}" \
    -v ON_ERROR_STOP=0 \
    -c "CREATE TABLE IF NOT EXISTS tomcat_sessions (
          session_id     VARCHAR(100) NOT NULL PRIMARY KEY,
          valid_session  CHAR(1)      NOT NULL,
          max_inactive   INT          NOT NULL,
          last_access    BIGINT       NOT NULL,
          app_name       VARCHAR(255),
          session_data   BYTEA
        );
        CREATE INDEX IF NOT EXISTS idx_tomcat_sessions_app
          ON tomcat_sessions(app_name);" \
    2>&1 | sed 's/^/[cluster-bootstrap]   /' || \
    echo "[cluster-bootstrap]   WARN: tomcat_sessions create failed (continuing)"
fi

# ── 4. JDBCConfig / JDBCStore properties — mode JNDI ───────────────
# Le mode JNDI évite de hardcoder les credentials dans des properties
# files au format texte. Le datasource jdbc/geoserver déclaré dans
# context.xml est référencé par jndiName.
#
# JDBCConfig docs : https://docs.geoserver.org/latest/en/user/community/jdbcconfig/installation.html
mkdir -p "${GEOSERVER_DATA_DIR}/jdbcconfig"
mkdir -p "${GEOSERVER_DATA_DIR}/jdbcstore"
mkdir -p "${GEOSERVER_DATA_DIR}/jdbcstore/scripts"

# Détection idempotence multi-replica : si les tables JDBCConfig ont
# déjà été créées (le premier replica est passé avant nous), bascule
# initdb=false / import=false pour éviter les CREATE TABLE en collision.
JDBC_INIT=true
JDBC_IMPORT=true
if command -v psql >/dev/null 2>&1; then
  TABLE_EXISTS=$(PGPASSWORD="${GEOSERVER_DB_PASSWORD}" psql \
    -h "${POSTGRES_HOST}" -p "${POSTGRES_PORT:-5432}" \
    -U "${GEOSERVER_DB_USER}" -d "${GEOSERVER_DB_NAME}" \
    -tAc "SELECT to_regclass('object') IS NOT NULL AND to_regclass('resource') IS NOT NULL" 2>/dev/null || echo "f")
  if [ "$TABLE_EXISTS" = "t" ]; then
    echo "[cluster-bootstrap] JDBCConfig tables already initialized → initdb=false import=false"
    JDBC_INIT=false
    JDBC_IMPORT=false
  fi
fi

cat > "${GEOSERVER_DATA_DIR}/jdbcconfig/jdbcconfig.properties" <<EOF
# Generated by cluster-bootstrap.sh — JNDI mode (datasource jdbc/geoserver)
enabled=true
initdb=${JDBC_INIT}
import=${JDBC_IMPORT}
jndiName=java:comp/env/jdbc/geoserver
EOF

cat > "${GEOSERVER_DATA_DIR}/jdbcstore/jdbcstore.properties" <<EOF
# Generated by cluster-bootstrap.sh — JNDI mode (datasource jdbc/geoserver)
enabled=true
initdb=${JDBC_INIT}
jndiName=java:comp/env/jdbc/geoserver
EOF

# ── 5. ControlFlow config — copie depuis ConfigMap (si présent) ────
if [ -f /cluster-config/controlflow.properties ]; then
  cp /cluster-config/controlflow.properties "${GEOSERVER_DATA_DIR}/controlflow.properties"
  echo "[cluster-bootstrap] control-flow config installed"
fi

# Marqueur d'identité pour debug — visible dans les logs Docker et
# corrélable avec l'env GEOSERVER_NODE_ID (= ${HOSTNAME} = nom du pod).
echo "${NODE_ID}" > "${GEOSERVER_DATA_DIR}/.node-id-${NODE_ID}"

echo "[cluster-bootstrap] done, handing over to GeoServer (kartoza entrypoint)…"

# ── 6. Délègue à l'entrypoint kartoza ───────────────────────────────
# Kartoza utilise /scripts/start.sh comme entrypoint. Ne pas le shunter.
# Si on tourne sur l'image OSGeo c'est /opt/startup.sh — détection.
if [ -x /scripts/start.sh ]; then
  exec /scripts/start.sh "$@"
elif [ -x /opt/startup.sh ]; then
  exec /opt/startup.sh "$@"
else
  echo "[cluster-bootstrap] FATAL : no known GS entrypoint found"
  exit 1
fi
