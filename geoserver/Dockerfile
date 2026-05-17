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
# 2026-05-17 ajout gs-hz-cluster (Hazelcast clustering) :
# - Pas dispo sur OSGeo Nexus (community module, pas extension stable)
# - Build from source dans un stage maven multi-stage
# - Cible : synchro cache catalog entre les N replicas GS via Hazelcast
#   gossip (auto-discovery K8s Service). Sans ça, PUT REST sur 1 replica
#   ne propage pas → autre replica garde son cache stale → bug observé
#   2026-05-17 lors des mutations REST refacto.
#
# Cette image custom :
#  1. Bake gs-hz-cluster + deps Hazelcast via maven multi-stage
#  2. Ajoute pg-jdbc driver dans tomcat/lib/ (requis JNDI Tomcat datasource)
#  3. Installe postgresql-client + gettext-base (requis par cluster-bootstrap.sh)
#  4. Bake gs-jdbcconfig + gs-jdbcstore + gs-wps-core + gs-control-flow depuis OSGeo Nexus
#  5. Copie le template context.xml.tpl (datasource JNDI jdbc/geoserver)
#  6. Copie le custom IDW process JAR (V2 2026-05-12)
#
# Le rest = défauts de l'image officielle GS, déterministe.

ARG GS_VERSION=2.28.3

# ── Builder stage : gs-hz-cluster + deps Hazelcast from source ──────
# Clone shallow du tag GS exact + mvn package du module community/hz-cluster
# + dependency:copy-dependencies pour récupérer hazelcast / hazelcast-spring
# / hazelcast-wm / metrics-servlet. Tout part dans /hz-jars/ pour copy
# vers le runtime stage en dessous.
FROM maven:3.9-eclipse-temurin-17 AS hz-builder
ARG GS_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch ${GS_VERSION} https://github.com/geoserver/geoserver.git /src
WORKDIR /src/src/community/hz-cluster
# Le pom du module hérite des repos OSGeo + Maven Central via le parent
# geoserver. mvn -am construit aussi les modules amont nécessaires
# (gs-main, gs-web-core, etc.) sans full-build du monorepo.
RUN mvn -B -DskipTests dependency:copy-dependencies -DoutputDirectory=/hz-deps && \
    mvn -B -DskipTests package
RUN mkdir -p /hz-jars && \
    cp target/gs-hz-cluster-*.jar /hz-jars/ && \
    cp /hz-deps/hazelcast*.jar /hz-jars/ 2>/dev/null || true && \
    cp /hz-deps/metrics-servlet*.jar /hz-jars/ 2>/dev/null || true && \
    ls -lh /hz-jars/

# ── Runtime stage ───────────────────────────────────────────────────
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

# ── gs-hz-cluster (Hazelcast clustering) — copy from builder stage ──
# Synchro cache catalog cross-replica via Hazelcast gossip K8s. La conf
# hazelcast.xml + cluster.properties est montée par un ConfigMap (voir
# templates/geoserver-hz-config.yaml).
COPY --from=hz-builder /hz-jars/*.jar /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/

# Sanity check
RUN ls -lh /usr/local/tomcat/lib/postgresql-*.jar /usr/local/tomcat/conf/context.xml.tpl && \
    ls -lh /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/gs-hz-cluster* /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/hazelcast*.jar && \
    echo "──── Build OK : pg-jdbc + context.xml.tpl + IDW + gs-hz-cluster ────"
