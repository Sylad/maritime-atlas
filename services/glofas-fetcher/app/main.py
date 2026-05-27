from __future__ import annotations

import logging
import os
import tempfile
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI
from pydantic import BaseModel, Field

from app.cds_client import GlofasCdsClient, GlofasFetchRequest
from app.converter import netcdf_to_geotiffs
from app.writer import coverage_dir_for_run

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

app = FastAPI(title="glofas-fetcher")


def _coverage_base_dir() -> Path:
    return Path(os.environ.get("COVERAGE_BASE_DIR", "/coverage/glofas"))


class FetchRequest(BaseModel):
    run_time: str = Field(..., description="ISO-8601 UTC, ex 2026-05-27T00:00:00Z")
    leadtimes: list[int] = Field(..., min_length=1)
    thresholds: list[str] = Field(..., min_length=1)


class FetchResponse(BaseModel):
    run: str
    written: int


@app.get("/healthz")
def healthz() -> dict:
    return {"status": "ok"}


@app.post("/fetch", response_model=FetchResponse)
def fetch(req: FetchRequest) -> FetchResponse:
    logger.info(
        "fetch start run=%s leadtimes=%s thresholds=%s",
        req.run_time, req.leadtimes, req.thresholds,
    )
    cds = GlofasCdsClient()
    base_dir = _coverage_base_dir()
    total_written = 0

    for threshold in req.thresholds:
        with tempfile.NamedTemporaryFile(suffix=".nc", delete=False) as tmp:
            nc_path = Path(tmp.name)
        try:
            cds.retrieve(
                GlofasFetchRequest(
                    run_time=req.run_time,
                    leadtimes=req.leadtimes,
                    thresholds=[threshold],
                ),
                target=str(nc_path),
            )
            out_dir = coverage_dir_for_run(base_dir, req.run_time, threshold)
            written = netcdf_to_geotiffs(
                src_netcdf=nc_path,
                out_dir=out_dir,
                run_time=req.run_time,
                threshold=threshold,
            )
            total_written += len(written)
        finally:
            nc_path.unlink(missing_ok=True)

    dt = datetime.fromisoformat(req.run_time.replace("Z", "+00:00"))
    return FetchResponse(run=dt.strftime("%Y-%m-%dT%HZ"), written=total_written)
