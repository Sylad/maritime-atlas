# Custom GeoServer image avec extension gwc-s3 pré-installée.
#
# Pourquoi pas l'INSTALL_EXTENSIONS runtime ? La community-latest URL
# 404 pour gwc-s3 (cf. agent research). On bake les JARs au build via
# SourceForge release artifacts pour garantir reproductibilité.
#
# Stable extension promoted en 2.28 — pattern URL :
#   geoserver-X.Y.Z-gwc-s3-plugin.zip sur sf.net/projects/geoserver

FROM docker.osgeo.org/geoserver:2.28.2

ARG GWC_S3_VERSION=2.28.2
ARG GWC_S3_URL=https://downloads.sourceforge.net/project/geoserver/GeoServer/${GWC_S3_VERSION}/extensions/geoserver-${GWC_S3_VERSION}-gwc-s3-plugin.zip

USER root

RUN apt-get update && \
    apt-get install -y --no-install-recommends unzip curl ca-certificates && \
    rm -rf /var/lib/apt/lists/* && \
    mkdir -p /tmp/gwc && cd /tmp/gwc && \
    curl -fL -o gwc-s3.zip "$GWC_S3_URL" && \
    unzip -o gwc-s3.zip && \
    cp *.jar /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/ && \
    cd / && rm -rf /tmp/gwc && \
    apt-get remove --purge -y unzip && apt-get autoremove --purge -y && \
    echo "GWC-S3 plugin v${GWC_S3_VERSION} installed in WEB-INF/lib"
# curl gardé (healthcheck compose l'utilise). unzip vire après extraction.

# Restore the default user from the base image (probably geoserver:geoserver
# or root depending on the official image). Le entrypoint du cluster
# bootstrap est déjà bind-mounted en root via compose, donc pas de souci.
