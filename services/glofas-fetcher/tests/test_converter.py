from pathlib import Path

import pytest
import rasterio

from app.converter import netcdf_to_geotiffs


def test_netcdf_to_geotiffs_writes_one_tif_per_leadtime(tmp_path):
    src = Path(__file__).parent / "fixtures" / "glofas_minimal.nc"
    out_dir = tmp_path / "out"
    out_dir.mkdir()

    written = netcdf_to_geotiffs(
        src_netcdf=src,
        out_dir=out_dir,
        run_time="2026-05-27T00:00:00Z",
        threshold="Q5",
    )

    # 7 leadtimes in fixture → 7 GeoTIFFs
    assert len(written) == 7
    for p in written:
        assert p.exists()
        assert p.suffix == ".tif"
        with rasterio.open(p) as ds:
            assert ds.crs is not None
            assert ds.crs.to_epsg() == 4326
            assert ds.count == 1
            assert ds.width > 0 and ds.height > 0
