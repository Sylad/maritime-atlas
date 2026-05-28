from __future__ import annotations

from datetime import datetime
from pathlib import Path


def grib_target_path(base: Path, run_time: str) -> Path:
    """Chemin du GRIB téléchargé pour un run GloFAS.

    Layout flat (un fichier par run) — GeoServer ImageMosaic scanne le
    dossier et lit chaque GRIB nativement via le plugin NetCDF/GRIB. La
    dimension TIME est extraite automatiquement des steps de forecast
    internes au GRIB (pas de conversion GeoTIFF côté sidecar).

    Ex: /coverage/glofas/glofas-2026-05-28T00Z.grib2
    """
    dt = datetime.fromisoformat(run_time.replace("Z", "+00:00"))
    run_compact = dt.strftime("%Y-%m-%dT%HZ")
    base.mkdir(parents=True, exist_ok=True)
    return base / f"glofas-{run_compact}.grib2"
