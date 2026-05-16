#!/bin/bash
set -e

# ─── GeoServer cluster bootstrap — sprint refacto v2 (validé sandbox Big-Blue 2026-05-16) ──
#
# Conventions OSGeo natives utilisées :
#  - L'image docker.osgeo.org/geoserver gère la datasource JNDI nativement via
#    server.xml templated par /opt/startup.sh à partir des env :
#      POSTGRES_USERNAME (pas POSTGRES_USER !)
#      POSTGRES_PASSWORD
#      POSTGRES_HOST / POSTGRES_PORT / POSTGRES_DB
#      POSTGRES_JNDI_ENABLED=true
#      POSTGRES_JNDI_RESOURCE_NAME (default jdbc/postgres)
#  - Donc on n'a PAS besoin de templater un context.xml custom — l'image fait
#    déjà le boulot.
#
# Le wrapper fait juste :
#  1. Wait DB reachable
#  2. CREATE TABLE tomcat_sessions (Tomcat PersistentManager ne le crée pas auto)
#  3. Extract SQL init scripts depuis les JARs JDBCStore + JDBCConfig
#  4. Écrit jdbcconfig.properties + jdbcstore.properties en mode JNDI jdbc/postgres
#  5. exec /opt/startup.sh (entrypoint OSGeo)

GEOSERVER_DATA_DIR="${GEOSERVER_DATA_DIR:-/opt/geoserver_data}"
NODE_ID="${HOSTNAME:-unknown}"
LIB_DIR=/usr/local/tomcat/webapps/geoserver/WEB-INF/lib

echo "[cluster-bootstrap] node=${NODE_ID}"

if command -v psql >/dev/null 2>&1; then
  echo "[cluster-bootstrap] waiting for DB..."
  for i in $(seq 1 30); do
    if PGPASSWORD="${POSTGRES_PASSWORD}" psql \
        -h "${POSTGRES_HOST}" -p "${POSTGRES_PORT:-5432}" \
        -U "${POSTGRES_USERNAME}" -d "${POSTGRES_DB}" \
        -c "SELECT 1" >/dev/null 2>&1; then
      echo "[cluster-bootstrap]   DB reachable on try $i"
      break
    fi
    sleep 2
  done
fi

# CREATE TABLE tomcat_sessions (idempotent)
PGPASSWORD="${POSTGRES_PASSWORD}" psql \
  -h "${POSTGRES_HOST}" -p "${POSTGRES_PORT:-5432}" \
  -U "${POSTGRES_USERNAME}" -d "${POSTGRES_DB}" \
  -c "CREATE TABLE IF NOT EXISTS tomcat_sessions (
        session_id    VARCHAR(100) PRIMARY KEY,
        valid_session CHAR(1) NOT NULL,
        max_inactive  INT NOT NULL,
        last_access   BIGINT NOT NULL,
        app_name      VARCHAR(255),
        session_data  BYTEA);
      CREATE INDEX IF NOT EXISTS idx_tomcat_sessions_app ON tomcat_sessions(app_name);" \
  2>&1 | head -5

mkdir -p "${GEOSERVER_DATA_DIR}/jdbcconfig/scripts" "${GEOSERVER_DATA_DIR}/jdbcstore/scripts"

# Extract SQL init scripts depuis les JARs (requis par JDBCStore qui sinon
# lance IllegalStateException: Init script does not exist: jdbcstore/scripts/init.postgres.sql)
JDBCSTORE_JAR=$(ls $LIB_DIR/gs-jdbcstore-*.jar 2>/dev/null | head -1)
JDBCCONFIG_JAR=$(ls $LIB_DIR/gs-jdbcconfig-*.jar 2>/dev/null | head -1)
if [ -n "$JDBCSTORE_JAR" ]; then
  cd /tmp && unzip -o -j "$JDBCSTORE_JAR" "org/geoserver/jdbcstore/internal/*.sql" \
    -d "${GEOSERVER_DATA_DIR}/jdbcstore/scripts/" >/dev/null 2>&1 || true
  echo "[cluster-bootstrap] jdbcstore SQL scripts extracted"
fi
if [ -n "$JDBCCONFIG_JAR" ]; then
  cd /tmp && unzip -o -j "$JDBCCONFIG_JAR" "org/geoserver/jdbcconfig/internal/*.sql" \
    -d "${GEOSERVER_DATA_DIR}/jdbcconfig/scripts/" >/dev/null 2>&1 || true
  echo "[cluster-bootstrap] jdbcconfig SQL scripts extracted"
fi

# Détection idempotence : tables JDBCConfig déjà créées ?
JDBC_INIT=true
TABLE_EXISTS=$(PGPASSWORD="${POSTGRES_PASSWORD}" psql \
  -h "${POSTGRES_HOST}" -p "${POSTGRES_PORT:-5432}" \
  -U "${POSTGRES_USERNAME}" -d "${POSTGRES_DB}" \
  -tAc "SELECT to_regclass('object') IS NOT NULL" 2>/dev/null || echo "f")
[ "$TABLE_EXISTS" = "t" ] && JDBC_INIT=false

cat > "${GEOSERVER_DATA_DIR}/jdbcconfig/jdbcconfig.properties" <<EOF
enabled=true
initdb=${JDBC_INIT}
import=${JDBC_INIT}
jndiName=java:comp/env/jdbc/postgres
EOF
cat > "${GEOSERVER_DATA_DIR}/jdbcstore/jdbcstore.properties" <<EOF
enabled=true
initdb=${JDBC_INIT}
jndiName=java:comp/env/jdbc/postgres
EOF

echo "[cluster-bootstrap] done, exec /opt/startup.sh"
exec /opt/startup.sh "$@"
