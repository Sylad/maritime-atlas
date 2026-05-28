from __future__ import annotations

import logging
from datetime import datetime, timedelta
from pathlib import Path

import rasterio

logger = logging.getLogger(__name__)


def grib_to_geotiffs(
    src_grib: Path,
    out_dir: Path,
    run_time: str,
    leadtimes: list[int],
) -> list[Path]:
    """Convertit le GRIB GloFAS control-forecast (1 band par leadtime) en
    1 GeoTIFF par validité.

    Pourquoi convertir (et pas laisser GeoServer lire le GRIB) : le GRIB
    GloFAS utilise le Product Definition Template 4.73 que NetCDF-Java (le
    reader GRIB de GeoServer) ne sait pas décoder. GDAL, lui, lit les valeurs
    (warning "Template 4.73 not recognized" mais raster OK). On sert donc via
    ImageMosaic de GeoTIFFs (pattern sst/weather-fetcher).

    Nommage : `discharge_<YYYYMMDDTHHMMSSZ>.tif` où le timestamp = validité
    (run_time + leadtime). Le timeregex de l'ImageMosaic extrait la dimension
    TIME du nom. Une validité écrite par un run plus récent écrase l'ancienne
    (collision de nom) → "latest run wins" automatique.

    Mapping positionnel band i → leadtimes[i] : les métadonnées de temps du
    GRIB ne sont pas fiables sous PDT 73, mais l'ordre des messages GRIB suit
    l'ordre des leadtimes demandés.
    """
    run_dt = datetime.fromisoformat(run_time.replace("Z", "+00:00"))
    written: list[Path] = []
    with rasterio.open(src_grib) as ds:
        n = ds.count
        if n != len(leadtimes):
            logger.warning("grib bands=%d != leadtimes=%d — mapping positional min", n, len(leadtimes))
        # Profile propre : on NE copie PAS le profile GRIB (blocs 7200×1 incompatibles
        # avec tiled). On reconstruit avec des tuiles 256×256 (multiples de 16).
        crs = ds.crs
        transform = ds.transform
        nodata = ds.nodata
        for i in range(min(n, len(leadtimes))):
            band = i + 1
            lh = leadtimes[i]
            validity = run_dt + timedelta(hours=lh)
            ts = validity.strftime("%Y%m%dT%H%M%SZ")
            arr = ds.read(band)
            out_path = out_dir / f"discharge_{ts}.tif"
            with rasterio.open(
                out_path,
                "w",
                driver="GTiff",
                height=arr.shape[0],
                width=arr.shape[1],
                count=1,
                dtype=arr.dtype,
                crs=crs,
                transform=transform,
                nodata=nodata,
                compress="DEFLATE",
                tiled=True,
                blockxsize=256,
                blockysize=256,
            ) as dst:
                dst.write(arr, 1)
                dst.update_tags(RUN_TIME=run_time, LEADTIME_H=lh, VALIDITY=ts)
            logger.info("wrote %s (band %d, lh %dh, validity %s)", out_path.name, band, lh, ts)
            written.append(out_path)
    return written
