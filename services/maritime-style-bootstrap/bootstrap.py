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
    # Wind : style default raster-only ; with-contours déjà existant côté image GS,
    # ne pas l'écraser ici (frontend swap STYLES quand isolignes ON).
    {
        "name": "wind-speed-idw",
        "default_for": ["wind-speed", "wind-speed-arpege", "wind-speed-arome"],
    },
    # SST : default = raster-only. Le style with-contours est aussi déployé
    # (sans default_for) pour rester sélectionnable par le toggle frontend.
    {
        "name": "sst-only",
        "default_for": ["sst-daily"],
    },
    {
        "name": "sst-with-contours",
        "default_for": [],
    },
    # Wave Hs : même pattern que SST.
    {
        "name": "wave-hs-only",
        "default_for": ["wave-hs"],
    },
    {
        "name": "wave-hs-with-contours",
        "default_for": [],
    },
]


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

        # 1. Delete existing (idempotent)
        try:
            geo.delete_style(style_name=name, workspace=WORKSPACE)
            print(f"  cleanup {name}: OK", flush=True)
        except GeoserverException as e:
            # 404 expected if style doesn't exist yet → no-op
            print(f"  cleanup {name}: skipped ({e})", flush=True)

        # 2a. POST entry + PUT body — crée le descriptor proprement
        try:
            geo.upload_style(
                path=str(sld_path),
                name=name,
                workspace=WORKSPACE,
                sld_version="1.0.0",
            )
            print(f"  upload {name}: OK (descriptor created)", flush=True)
        except GeoserverException as e:
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
            print(f"  ✗ raw-override {name}: FAILED — {e}", flush=True)
            failures.append(name)
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
