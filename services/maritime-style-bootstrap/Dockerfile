# Maritime Style Bootstrap — Job container
#
# Sert à déclarer (de manière idempotente, déclarative et gitops-friendly)
# les styles SLD et leurs default-style associations côté GeoServer.
#
# Exécuté comme Helm post-install/post-upgrade Job → tourne sur chaque
# cluster K8s qui consomme le chart maritime. Les 2 clusters (Big-Blue
# + Mini-Blue) restent donc synchros automatiquement, sans drift entre
# REST manuel sur l'un et oubli sur l'autre.
#
# Utilise la lib geoserver-rest (celle qui sous-tend le MCP
# mahdin75/geoserver-mcp) — pattern POST text/xml + PUT sld+xml sans
# ?raw=true validé 2026-05-14.
FROM python:3.10-slim

WORKDIR /app

# geoserver-rest + ses deps (requests). Pin la version pour reproductibilité.
RUN pip install --no-cache-dir geoserver-rest==2.10.0

# Script Python + SLDs
COPY bootstrap.py /app/
COPY styles/ /app/styles/

ENV PYTHONUNBUFFERED=1

ENTRYPOINT ["python", "/app/bootstrap.py"]
