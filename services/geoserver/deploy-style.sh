#!/usr/bin/env bash
# Deploy SLD style proprement sur cluster GeoServer maritime :
# 1) PUT via REST (catalog DB JDBCConfig)
# 2) docker cp dans CHAQUE replica (workaround JDBCConfig SLD disk drift)
# 3) POST /rest/reload (invalide les caches mémoire)
#
# Usage : deploy-style.sh <style-name>
# Assumes SLD file is at /volume2/docker/developpeur/maritime-atlas/services/geoserver/styles/<style-name>.sld

set -euo pipefail
STYLE="${1:?usage: $0 <style-name>}"
SLD_PATH="/volume2/docker/developpeur/maritime-atlas/services/geoserver/styles/${STYLE}.sld"

if [ ! -f "$SLD_PATH" ]; then
  echo "ERROR: SLD file not found: $SLD_PATH" >&2
  exit 1
fi

echo "→ PUT REST catalog..."
curl -s -u admin:geoserver -X PUT \
  -H "Content-Type: application/vnd.ogc.sld+xml" \
  --data-binary "@${SLD_PATH}" \
  "http://localhost:8080/geoserver/rest/workspaces/maritime/styles/${STYLE}?raw=true" \
  -w "  REST status: %{http_code}\n"

echo "→ docker cp dans les 3 replicas (workaround disk drift)..."
for i in 1 2 3; do
  docker cp "$SLD_PATH" \
    "maritime-geoserver-${i}:/opt/geoserver_data/workspaces/maritime/styles/${STYLE}.sld"
  echo "  geoserver-${i}: OK"
done

echo "→ reload GeoServer..."
curl -s -u admin:geoserver -X POST \
  "http://localhost:8080/geoserver/rest/reload" \
  -w "  reload status: %{http_code}\n"

echo "✓ Done. Style '$STYLE' deployed across cluster."
