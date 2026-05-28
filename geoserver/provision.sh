#!/bin/sh
set -e

# ─── GeoServer auto-provisioning ─────────────────────────────────────
#
# Crée idempotamment workspace + datastore PostGIS + feature types pour
# le projet maritime-atlas. Réutilise le pattern "config au boot" sans
# avoir à toucher à la UI clic-clic.
#
# Pour un setup pro on utilise un JAR Spring custom dans WEB-INF/lib qui
# auto-config au démarrage. Ici on prend l'approche plus simple : un
# sidecar bash qui frappe la REST API. Reproductible, versionné, lisible.
#
# Idempotence : chaque call POST est encadré d'un check existence. Si la
# resource existe (HTTP 200), on skip. Sinon on crée.
#
# Usage : sidecar dans docker-compose, dépend de geoserver:healthy.
# ─────────────────────────────────────────────────────────────────────

GS_URL="${GEOSERVER_URL:-http://geoserver:8080/geoserver}"
GS_USER="${GEOSERVER_ADMIN_USER:-admin}"
GS_PASS="${GEOSERVER_ADMIN_PASSWORD:-geoserver}"
WS="maritime"
STORE="maritime-pg"

# PostGIS connection params (depuis le réseau docker compose)
PG_HOST="${POSTGRES_HOST:-postgres}"
PG_PORT="${POSTGRES_PORT:-5432}"
PG_DB="${POSTGRES_DB:-maritime}"
PG_USER="${POSTGRES_USER:-maritime}"
PG_PASS="${POSTGRES_PASSWORD:-maritime}"

AUTH="-u ${GS_USER}:${GS_PASS}"

log() { echo "[provision] $*"; }

# ─── Wait for GeoServer up ───────────────────────────────────────────
log "Waiting for GeoServer at ${GS_URL}…"
until curl -sf $AUTH "${GS_URL}/rest/about/status" > /dev/null 2>&1; do
  sleep 3
done
log "GeoServer ready."

# ─── Workspace ───────────────────────────────────────────────────────
exists() {
  # $1 = relative path under /rest. Returns 0 if 200, 1 otherwise.
  code=$(curl -s -o /dev/null -w "%{http_code}" $AUTH "${GS_URL}/rest/$1")
  [ "$code" = "200" ]
}

if exists "workspaces/${WS}.json"; then
  log "Workspace '${WS}' already exists."
else
  log "Creating workspace '${WS}'…"
  curl -sf $AUTH -X POST "${GS_URL}/rest/workspaces" \
    -H "Content-Type: application/json" \
    -d "{\"workspace\":{\"name\":\"${WS}\"}}"
  log "  → done."
fi

# ─── Set workspace as default (optional) ─────────────────────────────
curl -sf $AUTH -X PUT "${GS_URL}/rest/workspaces/default" \
  -H "Content-Type: application/json" \
  -d "{\"workspace\":{\"name\":\"${WS}\"}}" || true

# ─── PostGIS datastore ───────────────────────────────────────────────
if exists "workspaces/${WS}/datastores/${STORE}.json"; then
  log "Datastore '${STORE}' already exists."
else
  log "Creating PostGIS datastore '${STORE}'…"
  cat > /tmp/datastore.json <<EOF
{
  "dataStore": {
    "name": "${STORE}",
    "type": "PostGIS",
    "enabled": true,
    "connectionParameters": {
      "entry": [
        {"@key": "dbtype",     "\$": "postgis"},
        {"@key": "host",       "\$": "${PG_HOST}"},
        {"@key": "port",       "\$": "${PG_PORT}"},
        {"@key": "database",   "\$": "${PG_DB}"},
        {"@key": "schema",     "\$": "public"},
        {"@key": "user",       "\$": "${PG_USER}"},
        {"@key": "passwd",     "\$": "${PG_PASS}"},
        {"@key": "Expose primary keys", "\$": "true"},
        {"@key": "validate connections", "\$": "true"},
        {"@key": "preparedStatements", "\$": "true"}
      ]
    }
  }
}
EOF
  curl -sf $AUTH -X POST "${GS_URL}/rest/workspaces/${WS}/datastores" \
    -H "Content-Type: application/json" --data @/tmp/datastore.json
  log "  → done."
fi

# ─── Feature types (layers) ──────────────────────────────────────────
publish_feature() {
  layer="$1"
  title="$2"
  if exists "workspaces/${WS}/datastores/${STORE}/featuretypes/${layer}.json"; then
    log "Layer '${layer}' already published."
    return
  fi
  log "Publishing layer '${layer}'…"
  cat > /tmp/featuretype.json <<EOF
{
  "featureType": {
    "name": "${layer}",
    "nativeName": "${layer}",
    "title": "${title}",
    "srs": "EPSG:4326",
    "nativeBoundingBox": {
      "minx": -15.0, "maxx": 30.0, "miny": 35.0, "maxy": 65.0, "crs": "EPSG:4326"
    },
    "latLonBoundingBox": {
      "minx": -15.0, "maxx": 30.0, "miny": 35.0, "maxy": 65.0, "crs": "EPSG:4326"
    },
    "enabled": true
  }
}
EOF
  curl -sf $AUTH -X POST "${GS_URL}/rest/workspaces/${WS}/datastores/${STORE}/featuretypes" \
    -H "Content-Type: application/json" --data @/tmp/featuretype.json
  log "  → published."
}

publish_feature "v_vessels_live" "Vessels live (last 15 minutes)"
publish_feature "v_vessels_live_categorized" "Vessels live categorized by ship type"
publish_feature "vessel_tracks_daily" "Vessel tracks aggregated by day (LineStrings)"
publish_feature "v_lightning_recent" "Lightning strikes (last 30 minutes, Blitzortung)"
publish_feature "v_alerts_recent" "Alerts last 1h (lightning-proximity, high-wind)"
# Sprint Europe Chantier #3 : plateformes vagues EMODnet Physics (~28 Europe)
# remplace l'ex-référentiel CANDHIS FR-only (118 bouées CEREMA).
publish_feature "buoys" "Wave platforms (EMODnet Physics, Europe-wide)"
publish_feature "v_buoy_observations_recent" "Wave platforms latest observations (Hm0, Tp, peak dir) — empty in EMODnet MVP"

# ─── SQL view paramétrée : vessels à un instant T ────────────────────
# Permet le replay temporel piloté par le time slider. Le client passe
# `viewparams=at:ISO;window:300` et GS substitue dans le SQL — DISTINCT ON
# garde la dernière position par MMSI dans la fenêtre [at-window, at+window].
# Index naturel sur (mmsi, ts DESC) couvre la requête.
publish_sql_view() {
  layer="vessels_at_time"
  if exists "workspaces/${WS}/datastores/${STORE}/featuretypes/${layer}.json"; then
    log "SQL view '${layer}' already published."
    return
  fi
  log "Publishing SQL view '${layer}' (XML)…"
  # XML format pour SQL view paramétrée — plus fiable que JSON pour les
  # JDBC virtual tables (substitution des params %at% / %window%).
  # Le SQL utilise des CDATA pour préserver les caractères spéciaux.
  cat > /tmp/vessels_at_time.xml <<'XML_EOF'
<featureType>
  <name>vessels_at_time</name>
  <nativeName>vessels_at_time</nativeName>
  <title>Vessels at specific time (parameterized)</title>
  <srs>EPSG:4326</srs>
  <nativeBoundingBox>
    <minx>-15.0</minx><maxx>30.0</maxx><miny>35.0</miny><maxy>65.0</maxy>
    <crs>EPSG:4326</crs>
  </nativeBoundingBox>
  <latLonBoundingBox>
    <minx>-15.0</minx><maxx>30.0</maxx><miny>35.0</miny><maxy>65.0</maxy>
    <crs>EPSG:4326</crs>
  </latLonBoundingBox>
  <metadata>
    <entry key="JDBC_VIRTUAL_TABLE">
      <virtualTable>
        <name>vessels_at_time</name>
        <sql><![CDATA[SELECT DISTINCT ON (vp.mmsi) vp.mmsi, vp.ts AS last_seen, v.name, v.callsign, v.ship_type, v.flag, v.length_m, v.width_m, v.destination, vp.geom::geometry(Point, 4326) AS geom FROM vessel_positions vp LEFT JOIN vessels v USING (mmsi) WHERE vp.ts BETWEEN ('%at%')::timestamptz - make_interval(secs => (%window%)::int) AND ('%at%')::timestamptz + make_interval(secs => (%window%)::int) ORDER BY vp.mmsi, vp.ts DESC]]></sql>
        <geometry>
          <name>geom</name>
          <type>Point</type>
          <srid>4326</srid>
        </geometry>
        <parameter>
          <name>at</name>
          <defaultValue>2020-01-01T00:00:00Z</defaultValue>
          <regexpValidator>^[0-9TZ:.\-+]+$</regexpValidator>
        </parameter>
        <parameter>
          <name>window</name>
          <defaultValue>300</defaultValue>
          <regexpValidator>^[0-9]+$</regexpValidator>
        </parameter>
      </virtualTable>
    </entry>
  </metadata>
  <enabled>true</enabled>
</featureType>
XML_EOF
  curl -sf $AUTH -X POST "${GS_URL}/rest/workspaces/${WS}/datastores/${STORE}/featuretypes" \
    -H "Content-Type: application/xml" --data @/tmp/vessels_at_time.xml
  log "  → SQL view published."
}

publish_sql_view

# ─── SLD styles pour les rasters météo ───────────────────────────────
# Wind / waves utilisent le style "raster" gris par défaut, peu visible.
# On uploade des SLD coloriés et on les associe comme defaultStyle.
upload_style() {
  style="$1"      # nom du style (ex: wind-speed-rainbow)
  sld_file="$2"   # chemin vers le .sld monté dans le container
  layer="$3"      # layer à styler (ex: wind-speed) — workspace maritime
  if exists "workspaces/${WS}/styles/${style}.json"; then
    log "Style '${style}' already exists, refreshing SLD body."
    curl -sf $AUTH -X PUT "${GS_URL}/rest/workspaces/${WS}/styles/${style}" \
      -H "Content-Type: application/vnd.ogc.sld+xml" \
      --data @"${sld_file}" >/dev/null
  else
    log "Creating style '${style}'…"
    # Step 1: register the style entry (filename = name.sld)
    curl -sf $AUTH -X POST "${GS_URL}/rest/workspaces/${WS}/styles" \
      -H "Content-Type: application/json" \
      -d "{\"style\":{\"name\":\"${style}\",\"filename\":\"${style}.sld\"}}"
    # Step 2: PUT the SLD body
    curl -sf $AUTH -X PUT "${GS_URL}/rest/workspaces/${WS}/styles/${style}" \
      -H "Content-Type: application/vnd.ogc.sld+xml" \
      --data @"${sld_file}" >/dev/null
  fi
  # Associate as defaultStyle on the layer
  curl -sf $AUTH -X PUT "${GS_URL}/rest/layers/${WS}:${layer}" \
    -H "Content-Type: application/json" \
    -d "{\"layer\":{\"defaultStyle\":{\"name\":\"${style}\",\"workspace\":\"${WS}\"}}}" >/dev/null
  log "  → '${style}' applied to ${layer}"
}

# Les fichiers SLD sont montés via le compose (cf docker-compose.yml).
if [ -f "/styles/sst-rainbow.sld" ]; then
  upload_style "sst-rainbow" "/styles/sst-rainbow.sld" "sst-daily"
fi
if [ -f "/styles/wind-speed-rainbow.sld" ]; then
  upload_style "wind-speed-rainbow" "/styles/wind-speed-rainbow.sld" "wind-speed"
  # Sprint 11 + Europe Chantier #2 + Phase C.6 (AROME réintroduit
  # 2026-05-12) — 3 sources vent coexistent : GFS / ARPEGE / AROME.
  # Les mosaic stores (wind_speed_arpege / wind_speed_arome) sont créés
  # au premier cycle de leurs services respectifs. Si la layer existe
  # déjà au boot, on lui ré-applique le SLD (idempotent). Le 404
  # silencieux couvre le premier-boot (layer pas encore créée).
  upload_style "wind-speed-rainbow" "/styles/wind-speed-rainbow.sld" "wind-speed-arpege"
  upload_style "wind-speed-rainbow" "/styles/wind-speed-rainbow.sld" "wind-speed-arome"
fi
if [ -f "/styles/wave-hs-rainbow.sld" ]; then
  upload_style "wave-hs-rainbow" "/styles/wave-hs-rainbow.sld" "wave-hs"
fi
# NOTE (G69 2026-05-28) — provision.sh est LEGACY (Docker Swarm) et n'est PAS
# exécuté dans le déploiement K8s actuel (ni COPY dans geoserver/Dockerfile, ni
# invoqué par un template Helm). Le provisioning des styles en K8s passe par le
# service `maritime-style-bootstrap` (bootstrap.py + Job ArgoCD). Les 4 styles
# GFS (temp-2m-thermal / pressure-msl-ramp / humidity-2m-blue / precipitation-6h-log)
# sont déclarés là-bas, PAS ici.
# Style points + labels pour les bouées (vector, pas raster). Le 404
# silencieux couvre le premier boot avant buoy-fetcher seed.
if [ -f "/styles/buoys-default.sld" ]; then
  upload_style "buoys-default" "/styles/buoys-default.sld" "buoys"
fi

# ─── Cluster sanity check (sprint 9) ─────────────────────────────────
# Depuis sprint 9, GEOSERVER_URL pointe sur un LB nginx interne qui
# fanouts vers 3 replicas (geoserver-1, geoserver-2, geoserver-3). Ces
# replicas partagent leur catalog via JDBCConfig (Postgres). On vérifie
# que les 3 replicas répondent et que le workspace `maritime` qu'on
# vient de créer est bien visible depuis chacun — preuve de sync via DB.
#
# Important : on tape les replicas en direct (bypass LB) pour valider
# que la conf JDBCConfig est OK. Si un replica voit pas le workspace,
# c'est qu'il est resté sur son catalog XML local — bug de conf.
if [ -z "${SKIP_CLUSTER_CHECK:-}" ]; then
  log "Cluster sanity check — vérification que les 3 replicas voient le workspace…"
  for node in geoserver-1 geoserver-2 geoserver-3; do
    if curl -sf $AUTH "http://${node}:8080/geoserver/rest/workspaces/${WS}.json" \
        > /dev/null 2>&1; then
      log "  ✓ ${node} voit le workspace '${WS}'"
    else
      log "  ✗ ${node} ne voit PAS '${WS}' — JDBCConfig probablement pas init."
      log "    Inspecte : docker compose logs ${node} | grep -i jdbcconfig"
      # Non-fatal — le sidecar a quand même fait son job sur le LB.
    fi
  done
fi

# ─── CORS (pour Angular dev sur autre origin) ────────────────────────
# CORS est déjà activé via env var dans le docker-compose, juste vérifier.
log "Provisioning complete."
