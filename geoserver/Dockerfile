# Custom GeoServer image avec 3 extensions pré-installées :
#  - gwc-s3 (stable extension promoted) depuis SourceForge
#  - jdbcconfig (community) depuis OSGeo Nexus
#  - jdbcstore (community) depuis OSGeo Nexus
#
# La tentative 2026-05-11 avec snapshot `2.28-SNAPSHOT` depuis
# build.geoserver.org échouait sur `NoClassDefFoundError
# org/geoserver/util/SortedProperties` — le snapshot était en avance
# sur le runtime stable. La fix : utiliser les JARs Maven release
# tagués (2.28.3) depuis Nexus, alignés au runtime exact.
#
# Refs :
#  - gwc-s3 : sf.net/projects/geoserver/files/GeoServer/<ver>/extensions/
#  - JDBC : repo.osgeo.org/repository/release/org/geoserver/community/

FROM docker.osgeo.org/geoserver:2.28.3

ARG GS_VERSION=2.28.3
ARG GWC_S3_URL=https://downloads.sourceforge.net/project/geoserver/GeoServer/${GS_VERSION}/extensions/geoserver-${GS_VERSION}-gwc-s3-plugin.zip
ARG WPS_URL=https://downloads.sourceforge.net/project/geoserver/GeoServer/${GS_VERSION}/extensions/geoserver-${GS_VERSION}-wps-plugin.zip
ARG CONTROLFLOW_URL=https://downloads.sourceforge.net/project/geoserver/GeoServer/${GS_VERSION}/extensions/geoserver-${GS_VERSION}-control-flow-plugin.zip
ARG NEXUS_BASE=https://repo.osgeo.org/repository/release/org/geoserver/community
ARG JDBCCONFIG_JAR_URL=${NEXUS_BASE}/gs-jdbcconfig/${GS_VERSION}/gs-jdbcconfig-${GS_VERSION}.jar
ARG JDBCSTORE_JAR_URL=${NEXUS_BASE}/gs-jdbcstore/${GS_VERSION}/gs-jdbcstore-${GS_VERSION}.jar

USER root

RUN apt-get update && \
    apt-get install -y --no-install-recommends unzip curl ca-certificates postgresql-client && \
    rm -rf /var/lib/apt/lists/* && \
    mkdir -p /tmp/plugins && cd /tmp/plugins && \
    # gwc-s3 : zip avec ses JARs deps (aws-sdk, jackson, etc.)
    curl -fL -o gwc-s3.zip "$GWC_S3_URL" && \
    unzip -o gwc-s3.zip "*.jar" -d gwc-s3-jars/ && \
    cp gwc-s3-jars/*.jar /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/ && \
    # wps : extension stable, requise pour exposer les processes (custom + builtin GeoTools)
    curl -fL -o wps.zip "$WPS_URL" && \
    unzip -o wps.zip "*.jar" -d wps-jars/ && \
    cp wps-jars/*.jar /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/ && \
    # control-flow : limite les requêtes concurrentes pour éviter l'effondrement
    # quand un client OL spam des tuiles 256x256 (saturait l'IDW parallel stream).
    # Config dans $GEOSERVER_DATA_DIR/controlflow.properties (copié au bootstrap).
    curl -fL -o cf.zip "$CONTROLFLOW_URL" && \
    unzip -o cf.zip "*.jar" -d cf-jars/ && \
    cp cf-jars/*.jar /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/ && \
    # JDBCConfig + JDBCStore : JARs direct depuis Nexus (déjà compilés
    # par l'upstream GeoServer release pipeline, alignés au runtime).
    curl -fL -o /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/gs-jdbcconfig-${GS_VERSION}.jar "$JDBCCONFIG_JAR_URL" && \
    curl -fL -o /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/gs-jdbcstore-${GS_VERSION}.jar "$JDBCSTORE_JAR_URL" && \
    # Extract JDBCStore + JDBCConfig SQL init scripts depuis les JARs.
    # JDBCStore les cherche dans ${data_dir}/jdbcstore/scripts/ — le
    # cluster-bootstrap.sh copiera depuis /opt/jdbc-scripts/ au boot.
    mkdir -p /opt/jdbc-scripts/jdbcstore /opt/jdbc-scripts/jdbcconfig && \
    unzip -o -j /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/gs-jdbcstore-${GS_VERSION}.jar \
      "org/geoserver/jdbcstore/internal/*.sql" -d /opt/jdbc-scripts/jdbcstore/ && \
    unzip -o -j /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/gs-jdbcconfig-${GS_VERSION}.jar \
      "org/geoserver/jdbcconfig/internal/*.sql" -d /opt/jdbc-scripts/jdbcconfig/ && \
    ls -la /opt/jdbc-scripts/jdbcstore/ /opt/jdbc-scripts/jdbcconfig/ && \
    cd / && rm -rf /tmp/plugins && \
    apt-get remove --purge -y unzip && apt-get autoremove --purge -y && \
    echo "Plugins installed in WEB-INF/lib : gwc-s3 + jdbcconfig + jdbcstore ${GS_VERSION}"
# curl et postgresql-client gardés (healthcheck compose + bootstrap CREATE SCHEMA).
# unzip vire après extraction.

# V2 (2026-05-12) : custom WPS process IDW. Le JAR est built à part dans
# services/geoserver-idw-process/ (voir README) et placé dans
# geoserver/plugins/ avant docker build. Le COPY est conditionnel — si
# le dir est vide ou absent, le build continue (Dockerfile COPY * fail
# sur empty, donc on touch un placeholder).
COPY plugins/ /tmp/idw-plugins/
RUN if ls /tmp/idw-plugins/*.jar 1> /dev/null 2>&1; then \
      cp /tmp/idw-plugins/*.jar /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/ && \
      ls -lh /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/gs-idw* && \
      echo "Custom IDW plugin installed"; \
    else \
      echo "No custom plugins in plugins/, skipping"; \
    fi && rm -rf /tmp/idw-plugins
