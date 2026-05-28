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

ARG GS_VERSION=2.28.4

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
    # G60 (2026-05-24) — metrics-core REQUIS par HzSynchronizer (utilise
    # com.codahale.metrics.MetricRegistry). Sans ça : NoClassDefFoundError
    # + HzSynchronizerInitializer failed + Hazelcast jamais init au runtime.
    cp /hz-deps/metrics-core*.jar /hz-jars/ 2>/dev/null || true && \
    ls -lh /hz-jars/

# ── Builder stage : maritime GWC init plugin (G63) ──────────────────
# Compile le plugin Java fr.sladoire.maritime.gwc.init qui crée
# programmatiquement le S3 BlobStore + assigne les layers au boot GS.
# Source dans services/geoserver-gwc-init/. Le JAR final ~5KB est baked
# dans WEB-INF/lib/ et auto-discovered par Spring via applicationContext.xml.
FROM maven:3.9-eclipse-temurin-17 AS gwc-init-builder
COPY maritime-gwc-init/ /src/
WORKDIR /src
RUN mvn -B -DskipTests package && \
    ls -lh target/*.jar

# ── Builder stage : maritime Cascade Time Forward plugin (G65) ──────
# Compile le plugin Java fr.sladoire.maritime.cascade qui wrap le
# HTTPClient des WMSStoreInfo pour injecter le param TIME dans les
# URLs cascade GetMap upstream. Fix bug GeoTools WMSCoverageReader/
# WMSLayer (0 forward de TIME par design, cf G64b).
FROM maven:3.9-eclipse-temurin-17 AS cascade-time-builder
COPY maritime-cascade-time-forward/ /src/
WORKDIR /src
RUN mvn -B -DskipTests package && \
    ls -lh target/*.jar

# ── Runtime stage ───────────────────────────────────────────────────
FROM docker.osgeo.org/geoserver:${GS_VERSION}

USER root

# postgresql-client + gettext-base pour cluster-bootstrap.sh (psql + envsubst)
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates postgresql-client gettext-base unzip && \
    rm -rf /var/lib/apt/lists/*

# pg-jdbc driver pour Tomcat JNDI datasource (DOIT être dans tomcat/lib/
# pour le ClassLoader Tomcat racine, pas le webapp ClassLoader).
ARG PG_JDBC_VERSION=42.7.4
RUN curl -fL --retry 5 --retry-delay 3 --retry-all-errors \
      -o /usr/local/tomcat/lib/postgresql-${PG_JDBC_VERSION}.jar \
      "https://jdbc.postgresql.org/download/postgresql-${PG_JDBC_VERSION}.jar" && \
    ls -lh /usr/local/tomcat/lib/postgresql-*.jar

# ── Plugins GeoServer ───────────────────────────────────────────────
# Stratégie 2026-05-18 (fix post-rebuild Big-Blue) : pour les EXTENSIONS
# STABLES (wps, control-flow), download le BUNDLE ZIP qui contient TOUS
# les JARs deps (gs-wps-core + gt-xsd-wps + gt-process-* + jaxb, etc).
# Le JAR seul gs-wps-core ne suffit PAS — la classe `org.geotools.wps.
# WPSConfiguration` vient de gt-xsd-wps qui est dans le bundle.
#
# Source bundle ZIPs : OSGeo Build server (URLs stables, déterministe).
#
# Pour les COMMUNITY modules (jdbcconfig, jdbcstore), garde le JAR direct
# depuis Nexus — leurs deps sont déjà bundlées dans l'image GS base.
ARG GS_VERSION=2.28.4
ARG NEXUS_RELEASE=https://repo.osgeo.org/repository/release/org/geoserver
ARG SF_RELEASE=https://sourceforge.net/projects/geoserver/files/GeoServer

# 1) Community JARs (jdbcconfig + jdbcstore) — JAR seul OK
RUN curl -fL --retry 5 --retry-delay 3 --retry-all-errors \
      -o /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/gs-jdbcconfig-${GS_VERSION}.jar \
      "${NEXUS_RELEASE}/community/gs-jdbcconfig/${GS_VERSION}/gs-jdbcconfig-${GS_VERSION}.jar" && \
    curl -fL --retry 5 --retry-delay 3 --retry-all-errors \
      -o /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/gs-jdbcstore-${GS_VERSION}.jar \
      "${NEXUS_RELEASE}/community/gs-jdbcstore/${GS_VERSION}/gs-jdbcstore-${GS_VERSION}.jar" && \
    ls -lh /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/gs-jdbc*

# 2) Extension bundle ZIPs (wps + control-flow) depuis SourceForge.
#    Le ZIP contient gs-<ext>-core + ses deps transitives (gt-xsd-wps,
#    gt-process-*, jaxb-* etc.) — TOUS nécessaires au runtime.
#    Bake direct le contenu du ZIP dans WEB-INF/lib.
#    SF URL pattern : .../GeoServer/${GS_VERSION}/extensions/geoserver-${GS_VERSION}-<ext>-plugin.zip/download
#    Cf. commit 92ffbed (curl --retry sur SF pour 404 transient).
RUN cd /tmp && \
    curl -fL --retry 8 --retry-delay 5 --retry-all-errors \
      -o wps-plugin.zip \
      "${SF_RELEASE}/${GS_VERSION}/extensions/geoserver-${GS_VERSION}-wps-plugin.zip/download" && \
    unzip -o wps-plugin.zip -d /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/ && \
    curl -fL --retry 8 --retry-delay 5 --retry-all-errors \
      -o controlflow-plugin.zip \
      "${SF_RELEASE}/${GS_VERSION}/extensions/geoserver-${GS_VERSION}-control-flow-plugin.zip/download" && \
    unzip -o controlflow-plugin.zip -d /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/ && \
    rm -f /tmp/wps-plugin.zip /tmp/controlflow-plugin.zip && \
    ls -lh /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/gs-wps-core* \
           /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/gt-xsd-wps* \
           /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/gs-control-flow*

# G58 (2026-05-24) — GWC S3 blobstore plugin. Permet de stocker le cache
# de tuiles GWC dans SeaweedFS / S3-compatible au lieu de l'emptyDir
# per-pod. Pré-requis pour clusteriser N replicas GS (G60). Sans ce
# plugin, /gwc/rest/blobstores PUT renvoie CannotResolveClassException
# S3BlobStore au runtime.
RUN cd /tmp && \
    curl -fL --retry 8 --retry-delay 5 --retry-all-errors \
      -o gwc-s3-plugin.zip \
      "${SF_RELEASE}/${GS_VERSION}/extensions/geoserver-${GS_VERSION}-gwc-s3-plugin.zip/download" && \
    unzip -o gwc-s3-plugin.zip -d /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/ && \
    rm -f /tmp/gwc-s3-plugin.zip && \
    ls -lh /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/gs-gwc-s3* \
           /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/aws-java-sdk-s3* 2>&1 | head -5

# 2026-05-28 — NetCDF + GRIB coverage readers (extensions officielles
# supportées). Requis pour servir le forecast GloFAS GRIB2 nativement via
# ImageMosaic (dimension TIME auto-extraite des steps de forecast), sans
# convertir en GeoTIFF côté sidecar. La GRIB extension dépend des libs
# NetCDF-Java/cdm → installer les 2 bundles. Pattern bundle ZIP SourceForge
# (comme wps/control-flow/gwc-s3).
RUN cd /tmp && \
    curl -fL --retry 8 --retry-delay 5 --retry-all-errors \
      -o netcdf-plugin.zip \
      "${SF_RELEASE}/${GS_VERSION}/extensions/geoserver-${GS_VERSION}-netcdf-plugin.zip/download" && \
    unzip -o netcdf-plugin.zip -d /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/ && \
    curl -fL --retry 8 --retry-delay 5 --retry-all-errors \
      -o grib-plugin.zip \
      "${SF_RELEASE}/${GS_VERSION}/extensions/geoserver-${GS_VERSION}-grib-plugin.zip/download" && \
    unzip -o grib-plugin.zip -d /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/ && \
    rm -f /tmp/netcdf-plugin.zip /tmp/grib-plugin.zip && \
    ls -lh /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/gs-netcdf* \
           /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/gs-grib* \
           /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/cdm* 2>&1 | head -8

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

# ── maritime GWC init plugin (G63) ──────────────────────────────────
# Plugin Java Spring qui crée le BlobStore S3 + assigne les layers au
# boot GS (via ContextRefreshedEvent post-boot async). Évite le bug
# REST PUT non-persistant.
# Config via env vars : GWC_S3_ACCESS_KEY/SECRET_KEY/ENDPOINT/BUCKET
# (injectées dans le Deployment depuis Secret maritime-seaweedfs-s3).
COPY --from=gwc-init-builder /src/target/gs-gwc-init-*.jar /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/

# ── maritime Cascade Time Forward plugin (G65) ──────────────────────
# Plugin Java Spring qui wrap le HTTPClient de chaque WMSStoreInfo
# pour injecter TIME dans les URLs cascade GetMap upstream. Fix le
# bug GeoTools `WMSCoverageReader` / `WMSLayer` (0 forward de TIME
# par design, vu marathon G64b).
COPY --from=cascade-time-builder /src/target/gs-cascade-time-forward-*.jar /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/

# Sanity check
RUN ls -lh /usr/local/tomcat/lib/postgresql-*.jar /usr/local/tomcat/conf/context.xml.tpl && \
    ls -lh /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/gs-hz-cluster* \
            /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/hazelcast*.jar \
            /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/gs-gwc-init*.jar \
            /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/gs-cascade-time-forward*.jar && \
    echo "──── Build OK : pg-jdbc + context.xml.tpl + IDW + gs-hz-cluster + maritime-gwc-init + maritime-cascade-time-forward ────"
