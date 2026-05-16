# ─── Custom GeoServer image — sprint refacto archi 2026-05-16 v2 ────
#
# Décision pragmatique 2026-05-16 17h : on abandonne kartoza/geoserver
# (3 pièges identifiés : download plugins runtime depuis build.geoserver.org
# qui retourne 404 par moments, volume /settings non-documenté, bug
# postgres_ready_status appelé hors short-circuit DB_BACKEND).
#
# Retour sur l'image officielle docker.osgeo.org/geoserver qui :
#  - N'a PAS de plugin download runtime (zéro 404 surprise)
#  - N'a PAS de bug HOST/DB_BACKEND
#  - Démarre via /opt/startup.sh (déterministe)
#  - Avait DÉJÀ les plugins gwc-s3, jdbcconfig, jdbcstore, control-flow,
#    wps, idw-custom préinstallés via Maven Nexus (cf Dockerfile v1)
#
# On garde le VRAI gain du sprint : datasource JNDI Tomcat (context.xml.tpl)
# qui centralise les credentials Postgres pour tous les plugins JDBC.

ARG GS_VERSION=2.28.0
FROM docker.osgeo.org/geoserver:${GS_VERSION}

ARG GWC_S3_URL=https://downloads.sourceforge.net/project/geoserver/GeoServer/${GS_VERSION}/extensions/geoserver-${GS_VERSION}-gwc-s3-plugin.zip
ARG WPS_URL=https://downloads.sourceforge.net/project/geoserver/GeoServer/${GS_VERSION}/extensions/geoserver-${GS_VERSION}-wps-plugin.zip
ARG CONTROLFLOW_URL=https://downloads.sourceforge.net/project/geoserver/GeoServer/${GS_VERSION}/extensions/geoserver-${GS_VERSION}-control-flow-plugin.zip
ARG NEXUS_BASE=https://repo.osgeo.org/repository/release/org/geoserver/community
ARG JDBCCONFIG_JAR_URL=${NEXUS_BASE}/gs-jdbcconfig/${GS_VERSION}/gs-jdbcconfig-${GS_VERSION}.jar
ARG JDBCSTORE_JAR_URL=${NEXUS_BASE}/gs-jdbcstore/${GS_VERSION}/gs-jdbcstore-${GS_VERSION}.jar

USER root

# postgresql-client + gettext-base nécessaires pour cluster-bootstrap.sh
# (psql + envsubst).
RUN apt-get update && \
    apt-get install -y --no-install-recommends unzip curl ca-certificates postgresql-client gettext-base && \
    rm -rf /var/lib/apt/lists/*

# ── Plugins préinstallés (zéro runtime download) ────────────────────
RUN mkdir -p /tmp/plugins && cd /tmp/plugins && \
    # gwc-s3 stable depuis SourceForge (NON depuis build.geoserver.org)
    curl -fL -o gwc-s3.zip "$GWC_S3_URL" && \
    unzip -o gwc-s3.zip "*.jar" -d gwc-s3-jars/ && \
    cp gwc-s3-jars/*.jar /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/ && \
    # wps stable
    curl -fL -o wps.zip "$WPS_URL" && \
    unzip -o wps.zip "*.jar" -d wps-jars/ && \
    cp wps-jars/*.jar /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/ && \
    # control-flow stable (rate-limiting requêtes concurrentes)
    curl -fL -o cf.zip "$CONTROLFLOW_URL" && \
    unzip -o cf.zip "*.jar" -d cf-jars/ && \
    cp cf-jars/*.jar /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/ && \
    # JDBCConfig + JDBCStore community via Maven Nexus (JAR direct)
    curl -fL -o /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/gs-jdbcconfig-${GS_VERSION}.jar "$JDBCCONFIG_JAR_URL" && \
    curl -fL -o /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/gs-jdbcstore-${GS_VERSION}.jar "$JDBCSTORE_JAR_URL" && \
    # Extract SQL init scripts depuis JARs JDBC* pour bootstrap au runtime
    mkdir -p /opt/jdbc-scripts/jdbcstore /opt/jdbc-scripts/jdbcconfig && \
    unzip -o -j /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/gs-jdbcstore-${GS_VERSION}.jar \
      "org/geoserver/jdbcstore/internal/*.sql" -d /opt/jdbc-scripts/jdbcstore/ && \
    unzip -o -j /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/gs-jdbcconfig-${GS_VERSION}.jar \
      "org/geoserver/jdbcconfig/internal/*.sql" -d /opt/jdbc-scripts/jdbcconfig/ && \
    cd / && rm -rf /tmp/plugins && \
    apt-get remove --purge -y unzip && apt-get autoremove --purge -y && \
    echo "Plugins installed in WEB-INF/lib : gwc-s3 + wps + control-flow + jdbcconfig + jdbcstore ${GS_VERSION}"

# ── PostgreSQL JDBC driver pour Tomcat JNDI datasource ──────────────
# Le driver DOIT être dans tomcat/lib/ (ClassLoader Tomcat racine, pas webapp)
# pour que la datasource JNDI <Resource> du context.xml fonctionne.
ARG PG_JDBC_VERSION=42.7.4
RUN curl -fL -o /usr/local/tomcat/lib/postgresql-${PG_JDBC_VERSION}.jar \
      "https://jdbc.postgresql.org/download/postgresql-${PG_JDBC_VERSION}.jar" && \
    ls -lh /usr/local/tomcat/lib/postgresql-*.jar

# ── Custom IDW process (V2 2026-05-12) ──────────────────────────────
COPY plugins/ /tmp/idw-plugins/
RUN if ls /tmp/idw-plugins/*.jar 1> /dev/null 2>&1; then \
      cp /tmp/idw-plugins/*.jar /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/ && \
      ls -lh /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/gs-idw* && \
      echo "Custom IDW plugin installed"; \
    else \
      echo "No custom plugins in plugins/, skipping"; \
    fi && rm -rf /tmp/idw-plugins

# ── Tomcat context.xml template — datasource JNDI jdbc/geoserver ────
# Le wrapper cluster-bootstrap.sh (monté via ConfigMap dans K8s) fait
# envsubst → context.xml au boot, ce qui centralise tous les credentials
# Postgres dans 1 endroit unique (au lieu de 4 properties files).
COPY tomcat-context.xml.tpl /usr/local/tomcat/conf/context.xml.tpl

# ── Sanity check des plugins ──────────────────────────────────────
RUN ls /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/ | \
      grep -E "jdbcconfig|jdbcstore|gwc-s3|control-flow|wps|idw" | \
      sort && \
    ls /usr/local/tomcat/lib/postgresql-*.jar && \
    echo "──── Build OK ────"
