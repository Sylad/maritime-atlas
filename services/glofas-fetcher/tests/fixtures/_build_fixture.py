"""Run once: python tests/fixtures/_build_fixture.py to regenerate fixture."""
import numpy as np
import xarray as xr

lons = np.linspace(-180, 180, 21)  # 18° step for tiny fixture
lats = np.linspace(-90, 90, 11)
times = np.arange(24, 169, 24)  # 7 leadtimes

data = np.random.rand(len(times), len(lats), len(lons)) * 100  # discharge values

ds = xr.Dataset(
    {"river_discharge": (("time", "latitude", "longitude"), data)},
    coords={
        "time": ("time", times, {"units": "hours since 2026-05-27T00:00:00Z"}),
        "latitude": ("latitude", lats, {"units": "degrees_north"}),
        "longitude": ("longitude", lons, {"units": "degrees_east"}),
    },
)
ds.to_netcdf("tests/fixtures/glofas_minimal.nc")
print("Wrote tests/fixtures/glofas_minimal.nc")
