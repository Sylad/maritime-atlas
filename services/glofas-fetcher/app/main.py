from __future__ import annotations

import logging
import os
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI
from pydantic import BaseModel, Field

from app.cds_client import GlofasCdsClient, GlofasFetchRequest
from app.writer import grib_target_path

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

app = FastAPI(title="glofas-fetcher")


def _coverage_base_dir() -> Path:
    return Path(os.environ.get("COVERAGE_BASE_DIR", "/coverage/glofas"))


class FetchRequest(BaseModel):
    run_time: str = Field(..., description="ISO-8601 UTC, ex 2026-05-28T00:00:00Z")
    leadtimes: list[int] = Field(..., min_length=1)


class FetchResponse(BaseModel):
    run: str
    bytes: int


@app.get("/healthz")
def healthz() -> dict:
    return {"status": "ok"}


@app.post("/fetch", response_model=FetchResponse)
def fetch(req: FetchRequest) -> FetchResponse:
    """Télécharge le GloFAS control-forecast GRIB2 (river discharge) pour un run
    et le dépose tel quel dans le dossier coverage. GeoServer (plugin GRIB)
    le sert directement via ImageMosaic — pas de conversion ici."""
    logger.info("fetch start run=%s leadtimes=%s", req.run_time, req.leadtimes)
    cds = GlofasCdsClient()
    target = grib_target_path(_coverage_base_dir(), req.run_time)
    cds.retrieve(
        GlofasFetchRequest(run_time=req.run_time, leadtimes=req.leadtimes),
        target=str(target),
    )
    size = target.stat().st_size if target.exists() else 0
    logger.info("fetch done target=%s bytes=%d", target, size)
    dt = datetime.fromisoformat(req.run_time.replace("Z", "+00:00"))
    return FetchResponse(run=dt.strftime("%Y-%m-%dT%HZ"), bytes=size)
