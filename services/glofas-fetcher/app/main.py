from __future__ import annotations

import logging
import os
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import FastAPI
from pydantic import BaseModel, Field

from app.cds_client import GlofasCdsClient, GlofasFetchRequest
from app.converter import grib_to_geotiffs
from app.writer import ensure_mosaic_config

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

app = FastAPI(title="glofas-fetcher")

DEFAULT_LEADTIMES = [24, 48, 72, 96, 120, 144, 168]


def _coverage_base_dir() -> Path:
    return Path(os.environ.get("COVERAGE_BASE_DIR", "/coverage/glofas"))


def _default_run_time() -> str:
    """Run de référence = HIER 00:00 UTC. Le run du jour courant n'est pas
    encore publié sur EWDS (les jours dispos en `operational` s'arrêtent à J-1).
    Calcul Python fiable (busybox `date -d yesterday` du conteneur curl KO)."""
    return (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%dT00:00:00Z")


class FetchRequest(BaseModel):
    run_time: str | None = Field(None, description="ISO-8601 UTC. Absent → hier 00:00 UTC.")
    leadtimes: list[int] = Field(default_factory=lambda: list(DEFAULT_LEADTIMES))


class FetchResponse(BaseModel):
    run: str
    written: int


@app.get("/healthz")
def healthz() -> dict:
    return {"status": "ok"}


@app.post("/fetch", response_model=FetchResponse)
def fetch(req: FetchRequest) -> FetchResponse:
    """Télécharge le GloFAS control-forecast GRIB2 (river discharge) puis le
    convertit en 1 GeoTIFF par validité dans le dossier coverage. GeoServer
    sert via ImageMosaic (GDAL lit le GRIB PDT 4.73, que NetCDF-Java ne décode
    pas — cf converter.py)."""
    run_time = req.run_time or _default_run_time()
    logger.info("fetch start run=%s leadtimes=%s", run_time, req.leadtimes)
    base_dir = _coverage_base_dir()
    ensure_mosaic_config(base_dir)
    cds = GlofasCdsClient()

    with tempfile.NamedTemporaryFile(suffix=".grib2", delete=False) as tmp:
        grib_path = Path(tmp.name)
    try:
        cds.retrieve(
            GlofasFetchRequest(run_time=run_time, leadtimes=req.leadtimes),
            target=str(grib_path),
        )
        written = grib_to_geotiffs(grib_path, base_dir, run_time, req.leadtimes)
    finally:
        grib_path.unlink(missing_ok=True)

    logger.info("fetch done run=%s written=%d geotiffs", run_time, len(written))
    dt = datetime.fromisoformat(run_time.replace("Z", "+00:00"))
    return FetchResponse(run=dt.strftime("%Y-%m-%dT%HZ"), written=len(written))
