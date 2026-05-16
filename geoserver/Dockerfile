# ─── Custom GeoServer image — sprint refacto archi 2026-05-16 ───────
#
# Pivot vers kartoza/geoserver (Sylvain 2026-05-16) qui :
#  - embarque déjà beaucoup de plugins community/stable
#  - télécharge les plugins additionnels au build via les ARG
#    STABLE_EXTENSIONS / COMMUNITY_EXTENSIONS (kartoza convention)
#  - vient avec un entrypoint optimisé + healthcheck + env vars
#  - tourne sur Tomcat 9
#
# https://hub.docker.com/r/kartoza/geoserver
#
# Plugins maritimes requis (cf mémoire maritime_geoserver_target_architecture) :
#  - jdbcconfig    : catalog GS en Postgres
#  - jdbcstore     : resources (SLDs, icons) en Postgres
#  - jdbc-sessions : sessions Tomcat partagées entre replicas
#  - control-flow  : rate-limit requêtes (calibré quad-core)
#  - gwc-s3        : tile cache sur SeaweedFS (sprint refacto)
#  - cluster       : sync inter-replicas via RabbitMQ
#  - wps           : exposition processes spatiaux + custom IDW
#
# Plus le custom IDW process JAR copié depuis services/geoserver-idw-process/.

ARG GS_VERSION=2.28.0
FROM kartoza/geoserver:${GS_VERSION}

# ── Plugins kartoza-managed (téléchargés au build via env vars) ─────
# Kartoza scanne ces env au build time et inclut les plugins. Le format
# attendu est <name>-plugin (sans le préfixe geoserver-X.Y.Z-).
#
# stable    : extensions officielles maintenues activement
# community : extensions community moins testées (JDBC*, gwc-s3 sont là)
ENV STABLE_EXTENSIONS="wps-plugin,control-flow-plugin"
ENV COMMUNITY_EXTENSIONS="jdbcconfig-plugin,jdbcstore-plugin,gwc-s3-plugin,jms-cluster-plugin"

# ── Note JDBC Sessions ──────────────────────────────────────────────
# Pas un plugin GS — c'est une fonctionnalité Tomcat native via le
# PersistentManager + JDBCStore. Configuré dans context.xml ci-dessous,
# pas via un JAR additionnel. Cf https://tomcat.apache.org/tomcat-9.0-doc/config/manager.html

USER root

# ── Custom IDW process (V2 2026-05-12) ──────────────────────────────
# Le JAR est built à part dans services/geoserver-idw-process/ et placé
# dans geoserver/plugins/ avant docker build. COPY conditionnel — si dir
# vide, build continue (touch d'un placeholder pour empêcher COPY * fail).
COPY plugins/ /tmp/idw-plugins/
RUN if ls /tmp/idw-plugins/*.jar 1> /dev/null 2>&1; then \
      cp /tmp/idw-plugins/*.jar /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/ && \
      ls -lh /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/gs-idw* && \
      echo "Custom IDW plugin installed"; \
    else \
      echo "No custom plugins in plugins/, skipping"; \
    fi && rm -rf /tmp/idw-plugins

# ── PostgreSQL JDBC driver pour Tomcat (JNDI datasource) ────────────
# Kartoza inclut probablement déjà postgresql.jar dans GS WEB-INF/lib,
# mais pour JNDI datasource Tomcat le driver DOIT être dans tomcat/lib/
# (chargé par le ClassLoader Tomcat racine, pas le webapp ClassLoader).
# Idempotent : si déjà présent, on ne touche pas.
ARG PG_JDBC_VERSION=42.7.4
RUN if [ ! -f /usr/local/tomcat/lib/postgresql-${PG_JDBC_VERSION}.jar ]; then \
      curl -fL -o /usr/local/tomcat/lib/postgresql-${PG_JDBC_VERSION}.jar \
        "https://jdbc.postgresql.org/download/postgresql-${PG_JDBC_VERSION}.jar"; \
    fi && \
    ls -lh /usr/local/tomcat/lib/postgresql-*.jar

# ── postgresql-client pour init container schema CREATE / DB exists ─
# Réutilisé par cluster-bootstrap.sh pour CREATE SCHEMA IF NOT EXISTS,
# détection tables existantes (initdb=false safe), etc.
RUN apt-get update && \
    apt-get install -y --no-install-recommends postgresql-client gettext-base && \
    rm -rf /var/lib/apt/lists/*

# ── Tomcat context.xml — JNDI datasource jdbc/geoserver ─────────────
# Source of truth unique pour les credentials Postgres GS. Toutes les
# connexions GS (JDBCConfig, JDBCStore, JDBC Sessions, ImageMosaic JDBC)
# référencent ce datasource via JNDI au lieu de hardcoder host/user/pwd
# dans chaque properties file. Cf cahier des charges Sylvain 2026-05-16.
#
# Le fichier utilise des ${env} substituts ; envsubst au boot inject les
# valeurs depuis les env vars du pod (POSTGRES_HOST / GEOSERVER_DB_USER /
# GEOSERVER_DB_PASSWORD).
#
# `context.xml.tpl` est le template versionné ; le entrypoint custom
# `cluster-bootstrap.sh` fait envsubst → context.xml au boot. Ça évite
# de devoir rebuild l'image quand un secret change.
COPY tomcat-context.xml.tpl /usr/local/tomcat/conf/context.xml.tpl
RUN echo "Tomcat context.xml template installed"

# ── Entrypoint custom (cluster bootstrap) ───────────────────────────
# Garde le pattern actuel : on enrobe l'entrypoint kartoza pour
# templater les properties + créer le SCHEMA Postgres avant que GS
# démarre. cluster-bootstrap.sh est COPY plus tard depuis le helm chart
# via ConfigMap (cleaner que dans l'image).
#
# On ne touche pas à l'ENTRYPOINT kartoza ici — il sera override au
# pod via command/args dans le Deployment Helm (cf maritime chart).

# ── Sanity check des plugins installés ──────────────────────────────
RUN ls /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/ | \
      grep -E "jdbcconfig|jdbcstore|gwc-s3|control-flow|wps|jms-cluster|idw" | \
      sort && \
    echo "──── Plugin install OK ────"
