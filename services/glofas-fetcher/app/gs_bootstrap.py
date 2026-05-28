from __future__ import annotations

import logging
import os

import requests

logger = logging.getLogger(__name__)

# Store REST name (snake) vs coverage/layer name (dash, auto-discover par GeoServer).
STORE_NAME = "glofas"
COVERAGE_NAME = "glofas-discharge"
COVERAGE_DIR = "/coverage/glofas"


def _gs_conf() -> tuple[str, str, str, str] | None:
    url = os.environ.get("GEOSERVER_URL")
    if not url:
        return None
    user = os.environ.get("GEOSERVER_ADMIN_USER", "admin")
    pwd = os.environ.get("GEOSERVER_ADMIN_PASSWORD", "geoserver")
    ws = os.environ.get("GEOSERVER_WORKSPACE", "aetherwx")
    return url.rstrip("/"), user, pwd, ws


def _store_exists(base: str, ws: str, auth: tuple[str, str]) -> bool:
    try:
        r = requests.get(
            f"{base}/rest/workspaces/{ws}/coveragestores/{STORE_NAME}.json",
            auth=auth, timeout=10,
        )
        return r.status_code == 200
    except Exception:
        return False


def _harvest(base: str, ws: str, auth: tuple[str, str]) -> None:
    """Re-scan le dossier coverage → ajoute les nouveaux granules à l'index mosaic."""
    r = requests.post(
        f"{base}/rest/workspaces/{ws}/coveragestores/{STORE_NAME}/external.imagemosaic",
        data=COVERAGE_DIR, headers={"Content-Type": "text/plain"}, auth=auth, timeout=120,
    )
    if r.status_code in (200, 201, 202):
        logger.info("gs harvest OK (mosaic reindexed)")
    else:
        logger.warning("gs harvest HTTP %d: %s", r.status_code, r.text[:200])


def _create(base: str, ws: str, auth: tuple[str, str]) -> None:
    """Crée store ImageMosaic + harvest + coverage layer avec dimension TIME.
    Pattern 3 étapes (cf sst-fetcher)."""
    # 1. store
    r = requests.post(
        f"{base}/rest/workspaces/{ws}/coveragestores",
        json={"coverageStore": {"name": STORE_NAME, "type": "ImageMosaic", "enabled": True,
                                 "workspace": {"name": ws}, "url": f"file://{COVERAGE_DIR}"}},
        auth=auth, timeout=60,
    )
    if r.status_code not in (200, 201):
        logger.warning("gs create store HTTP %d: %s", r.status_code, r.text[:200])
        return
    # 2. harvest (génère l'index shapefile)
    _harvest(base, ws, auth)
    # 3. coverage layer + time dimension
    coverage_xml = f"""<coverage>
  <name>{COVERAGE_NAME}</name>
  <nativeName>{STORE_NAME}</nativeName>
  <title>GloFAS river discharge forecast</title>
  <enabled>true</enabled>
  <metadata>
    <entry key="time">
      <dimensionInfo>
        <enabled>true</enabled>
        <presentation>LIST</presentation>
        <units>ISO8601</units>
        <defaultValue><strategy>MAXIMUM</strategy></defaultValue>
      </dimensionInfo>
    </entry>
  </metadata>
</coverage>"""
    r3 = requests.post(
        f"{base}/rest/workspaces/{ws}/coveragestores/{STORE_NAME}/coverages",
        data=coverage_xml, headers={"Content-Type": "text/xml"}, auth=auth, timeout=60,
    )
    if r3.status_code in (200, 201):
        logger.info("gs coverage %s published with time dim", COVERAGE_NAME)
    else:
        logger.warning("gs create coverage HTTP %d: %s", r3.status_code, r3.text[:200])


def ensure_geoserver_layer() -> None:
    """Idempotent : crée le layer GloFAS sur GeoServer s'il n'existe pas, sinon
    reindex (nouveaux granules du dernier run). Skip silencieux si GEOSERVER_URL
    absent (mode standalone/test). Le style SLD `glofas-discharge` + son
    assignation default sont gérés par maritime-style-bootstrap (déclaratif)."""
    conf = _gs_conf()
    if not conf:
        logger.info("gs bootstrap skipped (GEOSERVER_URL not set)")
        return
    base, user, pwd, ws = conf
    auth = (user, pwd)
    try:
        if _store_exists(base, ws, auth):
            _harvest(base, ws, auth)
        else:
            _create(base, ws, auth)
    except Exception as exc:
        logger.warning("gs bootstrap failed (non-fatal): %s", exc)
