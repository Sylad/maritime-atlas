from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime

import cdsapi

logger = logging.getLogger(__name__)

DATASET = "cems-glofas-forecast"


@dataclass(frozen=True)
class GlofasFetchRequest:
    """Inputs for a single GloFAS forecast retrieval."""

    run_time: str  # ISO-8601, ex "2026-05-27T00:00:00Z"
    leadtimes: list[int]  # hours from run_time, ex [24, 48, ...]
    thresholds: list[str]  # ex ["Q5", "Q20", "Q50"]

    def to_cdsapi_payload(self) -> dict:
        dt = datetime.fromisoformat(self.run_time.replace("Z", "+00:00"))
        return {
            "system_version": ["operational"],
            "hydrological_model": ["lisflood"],
            "product_type": "ensemble_perturbed_forecasts",
            "variable": "river_discharge_in_the_last_24_hours",
            "year": f"{dt.year:04d}",
            "month": f"{dt.month:02d}",
            "day": f"{dt.day:02d}",
            "leadtime_hour": [str(lh) for lh in self.leadtimes],
            "format": "netcdf",
        }


class GlofasCdsClient:
    """Thin wrapper around cdsapi.Client.

    Loads `~/.cdsapirc` automatically. The K8s Secret
    `glofas-cds-credentials` must be mounted to `/root/.cdsapirc`.
    """

    def __init__(self) -> None:
        self._client = cdsapi.Client()

    def retrieve(self, req: GlofasFetchRequest, target: str) -> None:
        payload = req.to_cdsapi_payload()
        logger.info("cdsapi.retrieve start dataset=%s target=%s", DATASET, target)
        self._client.retrieve(DATASET, payload, target)
        logger.info("cdsapi.retrieve done target=%s", target)
