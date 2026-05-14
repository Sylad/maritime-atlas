#!/usr/bin/env bash
# Deploy SLD style proprement sur GeoServer K8s + optionnellement set
# comme default style sur un ou plusieurs layers.
#
# Workflow (équivalent K8s du legacy deploy-style.sh NAS) :
#   1. PUT REST catalog (JDBCConfig DB)
#   2. kubectl cp dans le pod (workaround JDBCConfig disk drift —
#      GS rend depuis le fichier disque, REST ne touche que la DB)
#   3. Si --default-for fourni, PUT layer.xml pour set le defaultStyle
#   4. POST /rest/reload pour invalider les caches mémoire
#
# Usage :
#   ./k8s-deploy-style.sh <style-name> [--default-for layer1,layer2,...]
#
# Exemple :
#   ./k8s-deploy-style.sh wind-speed-idw \
#     --default-for wind-speed,wind-speed-arpege,wind-speed-arome

set -euo pipefail

STYLE="${1:?usage: $0 <style-name> [--default-for layer1,layer2,...]}"
shift || true

DEFAULT_FOR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --default-for) DEFAULT_FOR="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SLD_PATH="${SCRIPT_DIR}/styles/${STYLE}.sld"

if [ ! -f "$SLD_PATH" ]; then
  echo "ERROR: SLD file not found: $SLD_PATH" >&2
  exit 1
fi

NAMESPACE="${NAMESPACE:-maritime}"
WORKSPACE="${WORKSPACE:-maritime}"
GS_USER="${GS_USER:-admin}"
GS_PASS="${GS_PASS:-geoserver}"

POD=$(kubectl get pod -n "$NAMESPACE" -l app=geoserver -o jsonpath='{.items[0].metadata.name}')
if [ -z "$POD" ]; then
  echo "ERROR: no geoserver pod found in namespace $NAMESPACE" >&2
  exit 1
fi
echo "→ Target pod: $POD (namespace: $NAMESPACE)"

# Run REST + kubectl cp through a small Python helper inside the pod —
# pour les pods geoserver alpine qui n'ont pas curl/wget out of the box,
# on utilise un kubectl exec avec un curl côté host.
GS_URL_INTERNAL="http://localhost:8080/geoserver"

run_rest() {
  local method="$1" path="$2" content_type="$3" body_file="${4:-}"
  if [ -n "$body_file" ]; then
    kubectl exec -n "$NAMESPACE" "$POD" -- sh -c "curl -s -u ${GS_USER}:${GS_PASS} \
      -X $method -H 'Content-Type: $content_type' \
      --data-binary @- ${GS_URL_INTERNAL}${path} -w 'HTTP %{http_code}\n'" \
      < "$body_file"
  else
    kubectl exec -n "$NAMESPACE" "$POD" -- sh -c "curl -s -u ${GS_USER}:${GS_PASS} \
      -X $method ${GS_URL_INTERNAL}${path} -w 'HTTP %{http_code}\n'"
  fi
}

# 1) Check if style exists; create or update accordingly
echo "→ Step 1/4 : Push SLD body via REST (catalog DB)..."
if run_rest GET "/rest/workspaces/${WORKSPACE}/styles/${STYLE}.xml" "" 2>&1 | grep -q "HTTP 200"; then
  echo "  (style exists → PUT raw body)"
  run_rest PUT "/rest/workspaces/${WORKSPACE}/styles/${STYLE}?raw=true" "application/vnd.ogc.sld+xml" "$SLD_PATH"
else
  echo "  (new style → POST create then PUT body)"
  # Create style entry
  kubectl exec -n "$NAMESPACE" "$POD" -- sh -c "curl -s -u ${GS_USER}:${GS_PASS} \
    -X POST -H 'Content-Type: application/xml' \
    -d '<style><name>${STYLE}</name><filename>${STYLE}.sld</filename></style>' \
    ${GS_URL_INTERNAL}/rest/workspaces/${WORKSPACE}/styles -w 'HTTP %{http_code}\n'"
  # Then PUT the SLD content
  run_rest PUT "/rest/workspaces/${WORKSPACE}/styles/${STYLE}?raw=true" "application/vnd.ogc.sld+xml" "$SLD_PATH"
fi

# 2) Copy the SLD file directly into the pod's data directory
#    (workaround JDBCConfig disk drift documented in geoserver_jdbcconfig_sld_disk_drift)
echo "→ Step 2/4 : kubectl cp SLD onto pod disk (JDBCConfig workaround)..."
TMP_REMOTE="/tmp/${STYLE}.sld"
kubectl cp "$SLD_PATH" "$NAMESPACE/$POD:$TMP_REMOTE"
kubectl exec -n "$NAMESPACE" "$POD" -- sh -c "mkdir -p /opt/geoserver_data/workspaces/${WORKSPACE}/styles && mv $TMP_REMOTE /opt/geoserver_data/workspaces/${WORKSPACE}/styles/${STYLE}.sld"
echo "  copied to /opt/geoserver_data/workspaces/${WORKSPACE}/styles/${STYLE}.sld"

# 3) Optionally set as default style for one or more layers
if [ -n "$DEFAULT_FOR" ]; then
  echo "→ Step 3/4 : Set as default style on layers: $DEFAULT_FOR"
  IFS=',' read -ra LAYERS <<< "$DEFAULT_FOR"
  for LAYER in "${LAYERS[@]}"; do
    LAYER=$(echo "$LAYER" | xargs)  # trim
    BODY="<layer><defaultStyle><name>${WORKSPACE}:${STYLE}</name><workspace>${WORKSPACE}</workspace></defaultStyle></layer>"
    kubectl exec -n "$NAMESPACE" "$POD" -- sh -c "curl -s -u ${GS_USER}:${GS_PASS} \
      -X PUT -H 'Content-Type: application/xml' \
      -d '${BODY}' \
      ${GS_URL_INTERNAL}/rest/layers/${WORKSPACE}:${LAYER} -w '  ${LAYER}: HTTP %{http_code}\n'"
  done
else
  echo "→ Step 3/4 : (no --default-for, skipping default-style assignment)"
fi

# 4) Reload to invalidate in-memory caches
echo "→ Step 4/4 : Reload GeoServer..."
run_rest POST "/rest/reload" "application/xml"

echo "✓ Done. Style '$STYLE' deployed."
