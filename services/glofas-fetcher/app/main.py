from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import FastAPI
from pydantic import BaseModel, Field

from app.cds_client import GlofasCdsClient, GlofasFetchRequest
from app.writer import grib_target_path

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

app = FastAPI(title="glofas-fetcher")

DEFAULT_LEADTIMES = [24, 48, 72, 96, 120, 144, 168]


def _coverage_base_dir() -> Path:
    return Path(os.environ.get("COVERAGE_BASE_DIR", "/coverage/glofas"))


def _default_run_time() -> str:
    """Run de référence = HIER 00:00 UTC. Le run du jour courant n'est pas
    encore publié sur EWDS au moment où le CronWorkflow tourne (06:00 UTC) —
    les jours dispos en `operational` s'arrêtent à J-1. Calcul Python fiable
    (busybox `date -d yesterday` du conteneur curl ne parse pas 'yesterday')."""
    return (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%dT00:00:00Z")


class FetchRequest(BaseModel):
    # run_time optionnel : si absent → hier 00:00 UTC (cf _default_run_time).
    run_time: str | None = Field(None, description="ISO-8601 UTC. Absent → hier 00:00 UTC.")
    leadtimes: list[int] = Field(default_factory=lambda: list(DEFAULT_LEADTIMES))


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
    run_time = req.run_time or _default_run_time()
    logger.info("fetch start run=%s leadtimes=%s", run_time, req.leadtimes)
    cds = GlofasCdsClient()
    target = grib_target_path(_coverage_base_dir(), run_time)
    cds.retrieve(
        GlofasFetchRequest(run_time=run_time, leadtimes=req.leadtimes),
        target=str(target),
    )
    size = target.stat().st_size if target.exists() else 0
    logger.info("fetch done target=%s bytes=%d", target, size)
    dt = datetime.fromisoformat(run_time.replace("Z", "+00:00"))
    return FetchResponse(run=dt.strftime("%Y-%m-%dT%HZ"), bytes=size)
