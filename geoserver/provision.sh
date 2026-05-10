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
      "minx": -6.0, "maxx": 10.0, "miny": 41.0, "maxy": 51.5, "crs": "EPSG:4326"
    },
    "latLonBoundingBox": {
      "minx": -6.0, "maxx": 10.0, "miny": 41.0, "maxy": 51.5, "crs": "EPSG:4326"
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
    <minx>-6.0</minx><maxx>10.0</maxx><miny>41.0</miny><maxy>51.5</maxy>
    <crs>EPSG:4326</crs>
  </nativeBoundingBox>
  <latLonBoundingBox>
    <minx>-6.0</minx><maxx>10.0</maxx><miny>41.0</miny><maxy>51.5</maxy>
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

# ─── CORS (pour Angular dev sur autre origin) ────────────────────────
# CORS est déjà activé via env var dans le docker-compose, juste vérifier.
log "Provisioning complete."
