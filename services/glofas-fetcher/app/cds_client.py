from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime

import cdsapi

logger = logging.getLogger(__name__)

# GloFAS forecast vit sur l'EWDS (CEMS Early Warning Data Store), PAS le CDS.
# Depuis 2024-09-26 toutes les données CEMS ont migré CDS → EWDS.
# L'URL EWDS (https://ewds.climate.copernicus.eu/api) est lue depuis ~/.cdsapirc
# (Secret K8s glofas-cds-credentials monté en /root/.cdsapirc).
DATASET = "cems-glofas-forecast"


@dataclass(frozen=True)
class GlofasFetchRequest:
    """Inputs pour une retrieval GloFAS control-forecast (débit rivière).

    On utilise `control_forecast` (run déterministe unique = 1 valeur de débit
    par maille par leadtime), PAS l'ensemble perturbé (51 membres). Le produit
    est servi en GRIB2 uniquement (pas de NetCDF pour ce dataset).
    """

    run_time: str  # ISO-8601, ex "2026-05-28T00:00:00Z"
    leadtimes: list[int]  # heures depuis run_time, ex [24, 48, ..., 168]

    def to_cdsapi_payload(self) -> dict:
        dt = datetime.fromisoformat(self.run_time.replace("Z", "+00:00"))
        return {
            "system_version": ["operational"],
            "hydrological_model": ["lisflood"],
            "product_type": ["control_forecast"],
            "variable": "river_discharge_in_the_last_24_hours",
            "year": [f"{dt.year:04d}"],
            "month": [f"{dt.month:02d}"],
            "day": [f"{dt.day:02d}"],
            "leadtime_hour": [str(lh) for lh in self.leadtimes],
            "data_format": "grib2",
            "download_format": "unarchived",
        }


class GlofasCdsClient:
    """Thin wrapper autour de cdsapi.Client (pointe EWDS via ~/.cdsapirc)."""

    def __init__(self) -> None:
        self._client = cdsapi.Client()

    def retrieve(self, req: GlofasFetchRequest, target: str) -> None:
        payload = req.to_cdsapi_payload()
        logger.info("ewds.retrieve start dataset=%s target=%s", DATASET, target)
        self._client.retrieve(DATASET, payload, target)
        logger.info("ewds.retrieve done target=%s", target)
