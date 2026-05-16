#!/usr/bin/env python3
"""Maritime Style Bootstrap — declarative, idempotent GS style provisioning.

Sert à déclarer les styles SLD custom et leurs default-style sur
GeoServer de manière déclarative. Tourne comme Job K8s (Helm hook
post-install/post-upgrade) sur chaque cluster qui consomme le chart
maritime.

Variables env :
    GS_URL       : URL GeoServer interne (default http://geoserver:8080/geoserver)
    GS_USER      : default admin
    GS_PASSWORD  : default geoserver
    GS_WORKSPACE : default maritime

Pattern utilisé via lib `geoserver-rest` :
  1. delete_style (idempotent)
  2. upload_style → POST text/xml entry + PUT sld+xml body SANS ?raw=true
  3. publish_style → set default style sur les layers déclarés

Le bug ?raw=true du script bash précédent (qui créait un style fantôme
StyleNotDefined au rendering) ne se reproduit pas ici. Cf mémoire
geoserver_rest_style_create_pattern.md.
"""

import os
import sys
from pathlib import Path

import requests
from geo.Geoserver import Geoserver, GeoserverException

GS_URL = os.environ.get("GS_URL", "http://geoserver:8080/geoserver")
GS_USER = os.environ.get("GS_USER", "admin")
GS_PASSWORD = os.environ.get("GS_PASSWORD", "geoserver")
WORKSPACE = os.environ.get("GS_WORKSPACE", "maritime")

STYLES_DIR = Path("/app/styles")

# ── Catalog déclaratif des styles à provisionner ────────────────────
#
# Ajouter une entrée ici pour qu'un nouveau SLD soit auto-déployé sur
# les 2 clusters au prochain ArgoCD sync. Les SLDs eux-mêmes doivent
# être dans /app/styles/<name>.sld (copiés par le Dockerfile).
#
# default_for : liste des layers qui doivent utiliser ce style en
# default. Vide [] = style disponible mais pas en default (le toggle
# frontend peut le sélectionner explicitement via STYLES=...).
STYLES_TO_DEPLOY = [
    # ── SST : style "direct" sans IDW (Sylvain 2026-05-16) — validé visuellement.
    # Render fullscreen ~0.5s vs 10-21s. Combiné avec `defaultWMSInterpolationMethod
    # =Bicubic` côté LayerInfo, les couleurs sont lissées sans le coût IDW.
    {
        "name": "sst-direct",
        "default_for": ["sst-daily"],
    },
    # ── Wind / Wave : retour aux styles IDW (Sylvain 2026-05-16 PM) — les
    # variantes "direct" rendaient un gris uniforme sur les data wind-speed/
    # wave-hs (résolution native trop sparse pour ColorMap direct + Bicubic
    # produit des artefacts négatifs). On garde wind-direct / wave-direct
    # disponibles (default_for=[]) pour toggle frontend explicit, mais le
    # default revient sur les IDW qui rendent correctement (au prix de 10-21s).
    {
        "name": "wind-speed-idw",
        "default_for": ["wind-speed", "wind-speed-arpege", "wind-speed-arome"],
    },
    {
        "name": "wave-hs-only",
        "default_for": ["wave-hs"],
    },
    # ── Styles "direct" wind/wave : disponibles, pas en default
    {"name": "wind-direct",           "default_for": []},
    {"name": "wave-direct",           "default_for": []},
    # ── Autres styles legacy (toggle isolignes etc.) — disponibles, pas en default
    {"name": "sst-only",              "default_for": []},
    {"name": "sst-with-contours",     "default_for": []},
    {"name": "wave-hs-with-contours", "default_for": []},
]

# Configuration interpolation Layer-level (Sylvain 2026-05-16). Bicubic
# uniquement sur sst-daily où sst-direct rend correctement. Pour wind* /
# wave* on retire Bicubic (revert Nearest implicite) parce que combiné aux
# styles wind-speed-idw / wave-hs-only il produit du gris uniforme. À
# ré-activer si on revient sur wind-direct / wave-direct un jour.
RASTER_LAYERS_INTERPOLATION = [
    {"layer": "sst-daily",         "method": "Bicubic"},
    {"layer": "wave-hs",           "method": "Nearest"},
    {"layer": "wave-dir",          "method": "Nearest"},
    {"layer": "wind-speed",        "method": "Nearest"},
    {"layer": "wind-speed-arpege", "method": "Nearest"},
    {"layer": "wind-speed-arome",  "method": "Nearest"},
]

# ── Catalog déclaratif des feature types à reconfigurer ─────────────
#
# Ajouter une entrée ici quand un featuretype a besoin d'une liste
# d'attributs explicite (au lieu de laisser GS auto-introspecter).
#
# vessel_tracks_daily : désactivé 2026-05-16 — la vue SQL côté pg-data
# n'expose pas la colonne mmsi (changement de schéma post-refacto). Le
# PUT déclaratif retournait HTTP 500 "CQL source expression for attribute
# mmsi refers to attributes unavailable in the data source". À ré-activer
# quand la vue sera fixée côté ingester/migration DB.
FEATURETYPES_TO_CONFIGURE = [
    # {
    #     "datastore": "maritime-pg",
    #     "name": "vessel_tracks_daily",
    #     "attributes": [
    #         {"name": "mmsi", "binding": "java.lang.Long", "nillable": False},
    #         {"name": "day", "binding": "java.sql.Date", "nillable": False},
    #         {"name": "geom", "binding": "org.locationtech.jts.geom.LineString", "nillable": True},
    #         {"name": "points_n", "binding": "java.lang.Integer", "nillable": True},
    #     ],
    # },
]


def _attribute_xml(attr: dict) -> str:
    return (
        f"    <attribute>\n"
        f"      <name>{attr['name']}</name>\n"
        f"      <binding>{attr['binding']}</binding>\n"
        f"      <minOccurs>0</minOccurs>\n"
        f"      <maxOccurs>1</maxOccurs>\n"
        f"      <nillable>{'true' if attr.get('nillable', True) else 'false'}</nillable>\n"
        f"    </attribute>"
    )


def configure_featuretype(entry: dict) -> bool:
    """PUT le featuretype avec la liste d'attributs explicite. Idempotent."""
    ds = entry["datastore"]
    name = entry["name"]
    attrs = entry["attributes"]

    body = (
        f"<featureType>\n"
        f"  <attributes>\n"
        + "\n".join(_attribute_xml(a) for a in attrs) + "\n"
        f"  </attributes>\n"
        f"</featureType>"
    )

    url = f"{GS_URL}/rest/workspaces/{WORKSPACE}/datastores/{ds}/featuretypes/{name}"
    try:
        r = requests.put(
            url,
            data=body,
            headers={"Content-Type": "text/xml"},
            auth=(GS_USER, GS_PASSWORD),
            timeout=30,
        )
        if r.status_code in (200, 201):
            attr_names = ", ".join(a["name"] for a in attrs)
            print(f"  feature {name}: attributes set ({attr_names})", flush=True)
            return True
        print(f"  ✗ feature {name}: HTTP {r.status_code} — {r.text[:200]}", flush=True)
        return False
    except requests.RequestException as e:
        print(f"  ✗ feature {name}: FAILED — {e}", flush=True)
        return False


def main() -> int:
    print(f"→ Connecting to {GS_URL} as {GS_USER} (workspace={WORKSPACE})…", flush=True)
    geo = Geoserver(GS_URL, username=GS_USER, password=GS_PASSWORD)

    # Sanity check : list workspaces pour valider que la connexion fonctionne
    try:
        workspaces = geo.get_workspaces()
        print(f"  connection OK ({len(workspaces.get('workspaces', {}).get('workspace', []) or [])} workspaces visible)", flush=True)
    except Exception as e:
        print(f"ERROR: cannot connect to GeoServer: {e}", file=sys.stderr, flush=True)
        return 1

    failures = []
    for entry in STYLES_TO_DEPLOY:
        name = entry["name"]
        default_for = entry.get("default_for", [])
        sld_path = STYLES_DIR / f"{name}.sld"

        if not sld_path.exists():
            print(f"  ✗ {name}: SLD missing at {sld_path}", flush=True)
            failures.append(name)
            continue

        # 1. Delete existing (idempotent) — raw REST avec recurse=true&purge=true
        # geoserver-rest delete_style ne passe pas ces query params → si le
        # style est default_for d'un layer ou a un SLD persistant disque, le
        # DELETE silently retourne 200 sans purger, puis upload POST fail
        # avec "already exists". Recurse force GS à clear les références
        # depuis les layers, purge=true vire les SLDs sur disque.
        try:
            r = requests.delete(
                f"{GS_URL}/rest/workspaces/{WORKSPACE}/styles/{name}?recurse=true&purge=true",
                auth=(GS_USER, GS_PASSWORD),
                timeout=15,
            )
            if r.status_code in (200, 404):
                print(f"  cleanup {name}: OK (HTTP {r.status_code})", flush=True)
            else:
                print(f"  cleanup {name}: HTTP {r.status_code} — {r.text[:200]}", flush=True)
        except requests.RequestException as e:
            print(f"  cleanup {name}: skipped ({e})", flush=True)

        # 2a. POST entry + PUT body — crée le descriptor proprement.
        # Si "already exists" malgré le DELETE recurse+purge (le catalog
        # JDBCConfig peut garder une trace fantôme post-DELETE 200), on
        # fall-through vers 2b qui PUT raw=true le SLD body. L'entry existe
        # déjà côté catalog, donc skip la recréation → le PUT raw=true qui
        # suit override le body et garantit le SLD correct.
        try:
            geo.upload_style(
                path=str(sld_path),
                name=name,
                workspace=WORKSPACE,
                sld_version="1.0.0",
            )
            print(f"  upload {name}: OK (descriptor created)", flush=True)
        except GeoserverException as e:
            if "already exists" in str(e):
                print(f"  upload {name}: descriptor déjà présent → fall-through raw-override", flush=True)
            else:
                print(f"  ✗ upload {name}: FAILED — {e}", flush=True)
                failures.append(name)
                continue

        # 2b. Re-PUT with ?raw=true to preserve the original SLD body
        # (GeoServer réécrit le <NamedLayer><Name> au PUT non-raw pour
        # le faire matcher le style name, ce qui casse le rendering si
        # le SLD utilisait la chaîne magique "Default Styler"). Le PUT
        # ?raw=true override la DB avec le SLD bit-exact du fichier.
        try:
            with open(sld_path, "rb") as f:
                raw = f.read()
            r = requests.put(
                f"{GS_URL}/rest/workspaces/{WORKSPACE}/styles/{name}?raw=true",
                data=raw,
                auth=(GS_USER, GS_PASSWORD),
                headers={"Content-Type": "application/vnd.ogc.sld+xml"},
                timeout=30,
            )
            r.raise_for_status()
            print(f"  raw-override {name}: OK (NamedLayer preserved)", flush=True)
        except requests.RequestException as e:
            body = ""
            if hasattr(e, "response") and e.response is not None:
                body = e.response.text[:300]
            print(f"  ✗ raw-override {name}: FAILED — {e}\n     body: {body}", flush=True)
            # Si style fallback (pas en default_for), warning only — n'empêche
            # pas le Job d'exit 0 puisque le style n'est pas utilisé en rendu.
            if default_for:
                failures.append(name)
            else:
                print(f"     skipping (fallback style, default_for=[])", flush=True)
            continue

        # 3. Set default on each layer
        for layer in default_for:
            try:
                geo.publish_style(
                    layer_name=layer,
                    style_name=name,
                    workspace=WORKSPACE,
                )
                print(f"  default-style {layer} → {name}: OK", flush=True)
            except GeoserverException as e:
                print(f"  ✗ default-style {layer} → {name}: FAILED — {e}", flush=True)
                failures.append(f"{layer}/{name}")

    # ── Reconfigure feature types (attribute lists) ─────────────────
    if FEATURETYPES_TO_CONFIGURE:
        print(f"→ Reconfiguring {len(FEATURETYPES_TO_CONFIGURE)} featuretype(s)…", flush=True)
        for ft_entry in FEATURETYPES_TO_CONFIGURE:
            if not configure_featuretype(ft_entry):
                failures.append(f"ft/{ft_entry['name']}")

    # ── Configure interpolation Layer-level (Bicubic) ──────────────
    # Set sur LayerInfo via REST PUT. Le SLD direct n'interpole pas
    # ColorMap par défaut — Bicubic ici lisse les transitions sans IDW.
    if RASTER_LAYERS_INTERPOLATION:
        print(f"→ Setting interpolation on {len(RASTER_LAYERS_INTERPOLATION)} raster layer(s)…", flush=True)
        for entry in RASTER_LAYERS_INTERPOLATION:
            layer = entry["layer"]
            method = entry["method"]
            url = f"{GS_URL}/rest/layers/{WORKSPACE}:{layer}"
            body = f"<layer><defaultWMSInterpolationMethod>{method}</defaultWMSInterpolationMethod></layer>"
            try:
                r = requests.put(
                    url, data=body,
                    headers={"Content-Type": "application/xml"},
                    auth=(GS_USER, GS_PASSWORD),
                    timeout=15,
                )
                if r.status_code in (200, 201):
                    print(f"  layer {layer} → interpolation {method}: OK", flush=True)
                else:
                    print(f"  ✗ layer {layer}: HTTP {r.status_code} — {r.text[:200]}", flush=True)
                    failures.append(f"interp/{layer}")
            except requests.RequestException as e:
                print(f"  ✗ layer {layer}: {e}", flush=True)
                failures.append(f"interp/{layer}")

    # 4. Reload to invalidate in-memory cache (single call for all)
    try:
        geo.reload()
        print("→ Reload OK", flush=True)
    except GeoserverException as e:
        print(f"→ Reload failed: {e}", flush=True)

    if failures:
        print(f"\n✗ FAILED: {failures}", flush=True)
        return 1
    print(f"\n✓ All styles provisioned successfully ({len(STYLES_TO_DEPLOY)} declared)", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
