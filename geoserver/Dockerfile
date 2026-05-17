# ─── Custom GeoServer image — sprint refacto 2026-05-16 v3 ──────────
#
# Décision pragmatique 2026-05-16 17h30 :
# - L'image docker.osgeo.org/geoserver supporte nativement l'install
#   d'extensions au boot via INSTALL_EXTENSIONS=true + STABLE_EXTENSIONS=...
#   + COMMUNITY_EXTENSIONS=... — téléchargement depuis OSGeo Nexus
#   (source stable, pas SourceForge qui sort des 404 transients).
# - Donc on ne bake PAS les plugins dans l'image (zéro 404 au build).
# - Plugins activés via env vars dans le Deployment K8s.
#
# Cette image custom ne fait QUE :
#  1. Ajouter pg-jdbc driver dans tomcat/lib/ (requis JNDI Tomcat datasource)
#  2. Installer postgresql-client + gettext-base (requis par cluster-bootstrap.sh)
#  3. Copier le template context.xml.tpl (datasource JNDI jdbc/geoserver)
#  4. Copier le custom IDW process JAR (V2 2026-05-12)
#
# Le rest = défauts de l'image officielle GS, déterministe.

ARG GS_VERSION=2.28.3
FROM docker.osgeo.org/geoserver:${GS_VERSION}

USER root

# postgresql-client + gettext-base pour cluster-bootstrap.sh (psql + envsubst)
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates postgresql-client gettext-base && \
    rm -rf /var/lib/apt/lists/*

# pg-jdbc driver pour Tomcat JNDI datasource (DOIT être dans tomcat/lib/
# pour le ClassLoader Tomcat racine, pas le webapp ClassLoader).
ARG PG_JDBC_VERSION=42.7.4
RUN curl -fL --retry 5 --retry-delay 3 --retry-all-errors \
      -o /usr/local/tomcat/lib/postgresql-${PG_JDBC_VERSION}.jar \
      "https://jdbc.postgresql.org/download/postgresql-${PG_JDBC_VERSION}.jar" && \
    ls -lh /usr/local/tomcat/lib/postgresql-*.jar

# ── Plugins GeoServer via OSGeo Nexus (URLs stables) ───────────────
# JDBCConfig + JDBCStore (community) : catalog GS centralisé en Postgres.
# WPS + Control-Flow (extension) : requis pour désérialiser les ServiceInfo
#   stockés dans le catalog JDBCConfig — sans le JAR du plugin, le pod GS
#   pète CannotResolveClassException au boot (cas observé Mini-Blue
#   2026-05-17 après promotion sprint refacto v3).
#
# Nexus expose les JARs individuels. JDBC/WPS/Control-Flow n'ont pas de
# deps externes hors pg-jdbc (déjà dans tomcat/lib) et libs déjà bundlées
# dans l'image GS base.
ARG GS_VERSION=2.28.3
ARG NEXUS_RELEASE=https://repo.osgeo.org/repository/release/org/geoserver
RUN curl -fL --retry 5 --retry-delay 3 --retry-all-errors \
      -o /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/gs-jdbcconfig-${GS_VERSION}.jar \
      "${NEXUS_RELEASE}/community/gs-jdbcconfig/${GS_VERSION}/gs-jdbcconfig-${GS_VERSION}.jar" && \
    curl -fL --retry 5 --retry-delay 3 --retry-all-errors \
      -o /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/gs-jdbcstore-${GS_VERSION}.jar \
      "${NEXUS_RELEASE}/community/gs-jdbcstore/${GS_VERSION}/gs-jdbcstore-${GS_VERSION}.jar" && \
    curl -fL --retry 5 --retry-delay 3 --retry-all-errors \
      -o /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/gs-wps-core-${GS_VERSION}.jar \
      "${NEXUS_RELEASE}/extension/gs-wps-core/${GS_VERSION}/gs-wps-core-${GS_VERSION}.jar" && \
    curl -fL --retry 5 --retry-delay 3 --retry-all-errors \
      -o /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/gs-control-flow-${GS_VERSION}.jar \
      "${NEXUS_RELEASE}/extension/gs-control-flow/${GS_VERSION}/gs-control-flow-${GS_VERSION}.jar" && \
    ls -lh /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/gs-jdbc* \
           /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/gs-wps* \
           /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/gs-control-flow*

# Tomcat context.xml template — datasource JNDI jdbc/geoserver centralisée
COPY tomcat-context.xml.tpl /usr/local/tomcat/conf/context.xml.tpl

# Custom IDW process (V2 2026-05-12)
COPY plugins/ /tmp/idw-plugins/
RUN if ls /tmp/idw-plugins/*.jar 1> /dev/null 2>&1; then \
      cp /tmp/idw-plugins/*.jar /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/ && \
      ls -lh /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/gs-idw* && \
      echo "Custom IDW plugin installed"; \
    else \
      echo "No custom plugins in plugins/, skipping"; \
    fi && rm -rf /tmp/idw-plugins

# Sanity check
RUN ls -lh /usr/local/tomcat/lib/postgresql-*.jar /usr/local/tomcat/conf/context.xml.tpl && \
    echo "──── Build OK : pg-jdbc + context.xml.tpl + custom IDW ────"
