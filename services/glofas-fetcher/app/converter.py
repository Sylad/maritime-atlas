from __future__ import annotations

import logging
from pathlib import Path

import numpy as np
import rasterio
import xarray as xr
from rasterio.transform import from_bounds

logger = logging.getLogger(__name__)


def netcdf_to_geotiffs(
    src_netcdf: Path,
    out_dir: Path,
    run_time: str,
    threshold: str,
) -> list[Path]:
    """Convert a GloFAS NetCDF (multi-leadtime) into one GeoTIFF per leadtime.

    For now we passthrough `river_discharge` values. The probability
    computation against historical Q5/Q20/Q50 thresholds is a follow-up
    risk noted in the spec ("produit flood_probability"). `run_time` and
    `threshold` are tagged into each TIFF for downstream metadata routing.

    Output layout: `out_dir/<leadtime_hour:03d>.tif`
    Returns the list of written paths.
    """
    with xr.open_dataset(src_netcdf) as ds:
        if "river_discharge" not in ds.data_vars:
            raise KeyError(f"river_discharge missing in {src_netcdf}")

        lons = ds.longitude.values
        lats = ds.latitude.values
        transform = from_bounds(
            west=float(lons.min()),
            south=float(lats.min()),
            east=float(lons.max()),
            north=float(lats.max()),
            width=len(lons),
            height=len(lats),
        )

        written: list[Path] = []
        for i, lh in enumerate(ds.time.values):
            arr = ds.river_discharge.isel(time=i).values.astype(np.float32)
            out_path = out_dir / f"{int(lh):03d}.tif"
            with rasterio.open(
                out_path,
                "w",
                driver="GTiff",
                height=arr.shape[0],
                width=arr.shape[1],
                count=1,
                dtype=arr.dtype,
                crs="EPSG:4326",
                transform=transform,
                nodata=-9999.0,
                compress="DEFLATE",
            ) as dst:
                dst.write(arr, 1)
                dst.update_tags(RUN_TIME=run_time, THRESHOLD=threshold, LEADTIME_H=int(lh))
            logger.info("wrote %s threshold=%s lh=%s", out_path, threshold, lh)
            written.append(out_path)

    return written
