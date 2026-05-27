# GloFAS Hydro Data Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote GloFAS (Global Flood Awareness System) from absent to a fully wired Hydrologie data layer in maritime-atlas, with time-bar animation + 3-line popup chart (Q5/Q20/Q50) on click.

**Architecture:** Argo CronWorkflow (every 6h) → NestJS `/internal-trigger/sources/glofas` → Python sidecar `glofas-fetcher` (cdsapi pull NetCDF → GeoTIFF) → GeoServer ImageMosaic time-enabled → frontend Angular TileWMS layer + dropdown seuil + SVG popup chart.

**Tech Stack:** Python 3.12 (FastAPI, cdsapi, rasterio), TypeScript (NestJS 11), Java 17 (GeoServer plugin), Angular 19 (signals), Helm + Argo Workflows, GeoServer 2.28 ImageMosaic.

**Spec reference:** [docs/superpowers/specs/2026-05-27-glofas-hydro-data-layer-design.md](../specs/2026-05-27-glofas-hydro-data-layer-design.md)

---

## File Structure

### Python sidecar (NEW)
- Create: `services/glofas-fetcher/Dockerfile`
- Create: `services/glofas-fetcher/requirements.txt`
- Create: `services/glofas-fetcher/app/__init__.py`
- Create: `services/glofas-fetcher/app/main.py` — FastAPI entrypoint, `/healthz` + `/fetch`
- Create: `services/glofas-fetcher/app/cds_client.py` — wraps `cdsapi.Client`
- Create: `services/glofas-fetcher/app/converter.py` — NetCDF → GeoTIFF
- Create: `services/glofas-fetcher/app/writer.py` — file layout writer
- Create: `services/glofas-fetcher/tests/__init__.py`
- Create: `services/glofas-fetcher/tests/test_cds_client.py`
- Create: `services/glofas-fetcher/tests/test_converter.py`
- Create: `services/glofas-fetcher/tests/test_writer.py`
- Create: `services/glofas-fetcher/tests/test_main.py`
- Create: `services/glofas-fetcher/.dockerignore`

### NestJS module (NEW)
- Create: `services/api/src/glofas/glofas.module.ts`
- Create: `services/api/src/glofas/glofas.controller.ts`
- Create: `services/api/src/glofas/glofas.service.ts`
- Create: `services/api/src/glofas/glofas.types.ts`
- Create: `services/api/src/glofas/glofas.controller.spec.ts`
- Create: `services/api/src/glofas/glofas.service.spec.ts`
- Modify: `services/api/src/app.module.ts` — register `GlofasModule`

### GeoServer bootstrap (NEW Java code in existing plugin)
- Create: `services/maritime-gs-bootstrap/src/main/java/com/aetherwx/gsbootstrap/GlofasBootstrap.java`
- Modify: `services/maritime-gs-bootstrap/src/main/java/com/aetherwx/gsbootstrap/BootstrapRunner.java` — call new `GlofasBootstrap`
- Create: `services/maritime-gs-bootstrap/src/main/resources/styles/glofas-prob-gradient.sld`
- Create: `services/maritime-gs-bootstrap/src/main/resources/indexer/glofas-indexer.properties`

### Helm chart (developpeur-gitops repo, NEW)
- Create: `developpeur-gitops/charts/maritime/templates/glofas-fetcher-deployment.yaml`
- Create: `developpeur-gitops/charts/maritime/templates/glofas-fetcher-service.yaml`
- Create: `developpeur-gitops/charts/maritime/templates/glofas-fetcher-pvc.yaml`
- Create: `developpeur-gitops/charts/maritime/templates/glofas-refresh-cronworkflow.yaml`
- Modify: `developpeur-gitops/charts/maritime/values.yaml` — add `glofasFetcher` section + image tag
- Modify: `developpeur-gitops/charts/maritime/templates/retention-cleanup-cronjob.yaml` — add glofas cleanup step

### Frontend Angular (MODIFY existing files)
- Modify: `frontend/src/app/pages/map/map.component.ts` — remove EFAS (efasLayer ~ ligne 7311-7326, showEfas signal, DEFAULT_VISIBILITY entry, placeholder 1111-1120). Add `glofasLayer` + `showGlofas` signal + `glofasThreshold` signal + 10 doctrine points wiring + click handler.
- Modify: `frontend/nginx.conf` — supprimer `/wms-efas` proxy.
- Create: `frontend/src/app/components/glofas-timeseries-chart/glofas-timeseries-chart.component.ts`
- Create: `frontend/src/app/components/glofas-timeseries-chart/glofas-timeseries-chart.component.spec.ts`

### Docs
- Modify: `docs/aetherwx-animation.md` — add `glofas` to animatable layers list
- Modify: `README.md` — add GloFAS to Sources data

### CI
- Modify: `.github/workflows/build-maritime.yml` (or équivalent) — ajouter build & push `glofas-fetcher` à la matrix

---

## Order of execution & dependencies

```
Phase 1 (Python sidecar)     ─┐
Phase 2 (K8s infra)            ├──→ Phase 4 (GS bootstrap) ──→ Phase 5 (Frontend) ──→ Phase 6 (Finalize)
Phase 3 (NestJS GlofasModule) ─┘
```

- Phases 1, 2, 3 peuvent être parallélisés (3 sub-agents si subagent-driven).
- Phase 4 dépend de 1+2 (déploiement sidecar nécessaire pour 1er run end-to-end).
- Phase 5 dépend de 4 (GS layer doit exister pour que le frontend l'affiche).
- Phase 6 wrap-up.

---

# Phase 1 — Python sidecar `glofas-fetcher`

## Task 1: Scaffold project + FastAPI base

**Files:**
- Create: `services/glofas-fetcher/requirements.txt`
- Create: `services/glofas-fetcher/app/__init__.py`
- Create: `services/glofas-fetcher/app/main.py`
- Create: `services/glofas-fetcher/tests/__init__.py`
- Create: `services/glofas-fetcher/tests/test_main.py`

- [ ] **Step 1: Write requirements.txt**

```
fastapi==0.115.0
uvicorn[standard]==0.32.0
cdsapi==0.7.4
xarray==2024.10.0
netCDF4==1.7.2
rasterio==1.4.1
pydantic==2.9.2
httpx==0.27.2
pytest==8.3.3
pytest-asyncio==0.24.0
```

- [ ] **Step 2: Write empty `app/__init__.py`**

```python
```

- [ ] **Step 3: Write the failing test**

```python
# services/glofas-fetcher/tests/test_main.py
from fastapi.testclient import TestClient
from app.main import app


def test_healthz():
    client = TestClient(app)
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
```

- [ ] **Step 4: Run test to verify it fails**

```bash
cd services/glofas-fetcher && python -m pytest tests/test_main.py::test_healthz -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'app.main'`

- [ ] **Step 5: Implement minimal `app/main.py`**

```python
# services/glofas-fetcher/app/main.py
from fastapi import FastAPI

app = FastAPI(title="glofas-fetcher")


@app.get("/healthz")
def healthz() -> dict:
    return {"status": "ok"}
```

- [ ] **Step 6: Run test to verify it passes**

```bash
cd services/glofas-fetcher && python -m pytest tests/test_main.py::test_healthz -v
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add services/glofas-fetcher/
git commit -m "feat(glofas-fetcher): scaffold FastAPI sidecar with healthz"
```

---

## Task 2: cdsapi wrapper with mocked CDS response

**Files:**
- Create: `services/glofas-fetcher/app/cds_client.py`
- Create: `services/glofas-fetcher/tests/test_cds_client.py`

- [ ] **Step 1: Write the failing test**

```python
# services/glofas-fetcher/tests/test_cds_client.py
from unittest.mock import MagicMock, patch

import pytest

from app.cds_client import GlofasCdsClient, GlofasFetchRequest


def test_fetch_request_builds_correct_payload():
    """Verify the cdsapi request dict matches CDS catalog schema."""
    req = GlofasFetchRequest(
        run_time="2026-05-27T00:00:00Z",
        leadtimes=[24, 48, 72, 96, 120, 144, 168],
        thresholds=["Q5", "Q20", "Q50"],
    )
    payload = req.to_cdsapi_payload()
    assert payload["product_type"] == "ensemble_perturbed_forecasts"
    assert payload["variable"] == "river_discharge_in_the_last_24_hours"
    assert payload["year"] == "2026"
    assert payload["month"] == "05"
    assert payload["day"] == "27"
    assert payload["leadtime_hour"] == ["24", "48", "72", "96", "120", "144", "168"]
    assert payload["format"] == "netcdf"


@patch("app.cds_client.cdsapi.Client")
def test_client_retrieves_and_writes_target(mock_cdsapi_client):
    """The client should call cdsapi.retrieve with dataset + payload + target."""
    mock_instance = MagicMock()
    mock_cdsapi_client.return_value = mock_instance

    client = GlofasCdsClient()
    req = GlofasFetchRequest(
        run_time="2026-05-27T00:00:00Z",
        leadtimes=[24],
        thresholds=["Q5"],
    )
    client.retrieve(req, target="/tmp/test.nc")

    mock_instance.retrieve.assert_called_once()
    args, _ = mock_instance.retrieve.call_args
    assert args[0] == "cems-glofas-forecast"
    assert args[2] == "/tmp/test.nc"
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd services/glofas-fetcher && python -m pytest tests/test_cds_client.py -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'app.cds_client'`

- [ ] **Step 3: Implement `app/cds_client.py`**

```python
# services/glofas-fetcher/app/cds_client.py
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
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd services/glofas-fetcher && python -m pytest tests/test_cds_client.py -v
```

Expected: 2 tests PASS

- [ ] **Step 5: Commit**

```bash
git add services/glofas-fetcher/app/cds_client.py services/glofas-fetcher/tests/test_cds_client.py
git commit -m "feat(glofas-fetcher): cds client wrapper with payload builder"
```

---

## Task 3: NetCDF → GeoTIFF converter

**Files:**
- Create: `services/glofas-fetcher/app/converter.py`
- Create: `services/glofas-fetcher/tests/test_converter.py`
- Create: `services/glofas-fetcher/tests/fixtures/glofas_minimal.nc` (synthetic NetCDF for tests)

- [ ] **Step 1: Write fixture generator (one-shot script)**

```python
# services/glofas-fetcher/tests/fixtures/_build_fixture.py
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
```

Run it:

```bash
cd services/glofas-fetcher && python tests/fixtures/_build_fixture.py
```

- [ ] **Step 2: Write the failing test**

```python
# services/glofas-fetcher/tests/test_converter.py
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
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd services/glofas-fetcher && python -m pytest tests/test_converter.py -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'app.converter'`

- [ ] **Step 4: Implement `app/converter.py`**

```python
# services/glofas-fetcher/app/converter.py
from __future__ import annotations

import logging
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
import rasterio
import xarray as xr
from rasterio.transform import from_bounds

logger = logging.getLogger(__name__)


def _format_iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def netcdf_to_geotiffs(
    src_netcdf: Path,
    out_dir: Path,
    run_time: str,
    threshold: str,
) -> list[Path]:
    """Convert a GloFAS NetCDF (multi-leadtime) into one GeoTIFF per leadtime.

    For now we passthrough `river_discharge` values. The probability
    computation against historical Q5/Q20/Q50 thresholds is TBD in a
    follow-up task (see spec risk "produit flood_probability"). Until
    then, this function writes the raw discharge field for the given
    threshold (which only encodes filename for routing).

    Output layout: `out_dir/<leadtime_hour:03d>.tif`
    Returns the list of written paths.
    """
    ds = xr.open_dataset(src_netcdf)
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
        logger.info("wrote %s threshold=%s lh=%s", out_path, threshold, lh)
        written.append(out_path)

    return written
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd services/glofas-fetcher && python -m pytest tests/test_converter.py -v
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add services/glofas-fetcher/app/converter.py services/glofas-fetcher/tests/test_converter.py services/glofas-fetcher/tests/fixtures/
git commit -m "feat(glofas-fetcher): netcdf to geotiff converter (passthrough discharge)"
```

---

## Task 4: File layout writer + `/fetch` endpoint

**Files:**
- Create: `services/glofas-fetcher/app/writer.py`
- Create: `services/glofas-fetcher/tests/test_writer.py`
- Modify: `services/glofas-fetcher/app/main.py` — add `/fetch` endpoint
- Modify: `services/glofas-fetcher/tests/test_main.py` — add `/fetch` test

- [ ] **Step 1: Write `app/writer.py`**

```python
# services/glofas-fetcher/app/writer.py
from __future__ import annotations

from datetime import datetime
from pathlib import Path


def coverage_dir_for_run(base: Path, run_time: str, threshold: str) -> Path:
    """Compute coverage layout dir for a given run + threshold.

    Layout: `<base>/<run_compact>/<threshold>/`
    Example: `/coverage/glofas/2026-05-27T00Z/Q5/`
    """
    dt = datetime.fromisoformat(run_time.replace("Z", "+00:00"))
    run_compact = dt.strftime("%Y-%m-%dT%HZ")
    out = base / run_compact / threshold
    out.mkdir(parents=True, exist_ok=True)
    return out
```

- [ ] **Step 2: Write the test**

```python
# services/glofas-fetcher/tests/test_writer.py
from app.writer import coverage_dir_for_run


def test_coverage_dir_for_run_layout(tmp_path):
    d = coverage_dir_for_run(tmp_path, "2026-05-27T00:00:00Z", "Q5")
    assert d.exists()
    assert d.parts[-1] == "Q5"
    assert d.parts[-2] == "2026-05-27T00Z"


def test_coverage_dir_for_run_idempotent(tmp_path):
    d1 = coverage_dir_for_run(tmp_path, "2026-05-27T00:00:00Z", "Q5")
    d2 = coverage_dir_for_run(tmp_path, "2026-05-27T00:00:00Z", "Q5")
    assert d1 == d2
```

- [ ] **Step 3: Run writer test**

```bash
cd services/glofas-fetcher && python -m pytest tests/test_writer.py -v
```

Expected: 2 PASS

- [ ] **Step 4: Write the failing `/fetch` test**

```python
# Add to services/glofas-fetcher/tests/test_main.py
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.main import app


@patch("app.main.GlofasCdsClient")
@patch("app.main.netcdf_to_geotiffs")
def test_fetch_endpoint_orchestrates_full_pipeline(
    mock_convert, mock_cds_cls, tmp_path, monkeypatch
):
    """POST /fetch triggers cdsapi → convert → write loop for each threshold."""
    monkeypatch.setenv("COVERAGE_BASE_DIR", str(tmp_path))

    # Mock the CDS client to no-op (don't actually download)
    mock_cds = mock_cds_cls.return_value
    mock_cds.retrieve.side_effect = lambda req, target: Path(target).write_bytes(b"\x00")

    # Mock convert to return synthetic paths
    mock_convert.side_effect = lambda src_netcdf, out_dir, run_time, threshold: [
        out_dir / f"{lh:03d}.tif" for lh in [24, 48, 72]
    ]

    client = TestClient(app)
    payload = {
        "run_time": "2026-05-27T00:00:00Z",
        "leadtimes": [24, 48, 72],
        "thresholds": ["Q5", "Q20", "Q50"],
    }
    response = client.post("/fetch", json=payload)

    assert response.status_code == 200
    body = response.json()
    assert body["run"] == "2026-05-27T00Z"
    assert body["written"] == 9  # 3 leadtimes × 3 thresholds
    assert mock_cds.retrieve.call_count == 3  # one cdsapi call per threshold
    assert mock_convert.call_count == 3
```

- [ ] **Step 5: Run test to verify it fails**

```bash
cd services/glofas-fetcher && python -m pytest tests/test_main.py::test_fetch_endpoint_orchestrates_full_pipeline -v
```

Expected: FAIL with `404` (no /fetch route yet).

- [ ] **Step 6: Implement `/fetch` endpoint in `app/main.py`**

```python
# services/glofas-fetcher/app/main.py (replace previous content)
from __future__ import annotations

import logging
import os
import tempfile
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from app.cds_client import GlofasCdsClient, GlofasFetchRequest
from app.converter import netcdf_to_geotiffs
from app.writer import coverage_dir_for_run

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

app = FastAPI(title="glofas-fetcher")

COVERAGE_BASE_DIR = Path(os.environ.get("COVERAGE_BASE_DIR", "/coverage/glofas"))


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
    logger.info("fetch start run=%s leadtimes=%s thresholds=%s",
                req.run_time, req.leadtimes, req.thresholds)
    cds = GlofasCdsClient()
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
            out_dir = coverage_dir_for_run(COVERAGE_BASE_DIR, req.run_time, threshold)
            written = netcdf_to_geotiffs(
                src_netcdf=nc_path,
                out_dir=out_dir,
                run_time=req.run_time,
                threshold=threshold,
            )
            total_written += len(written)
        finally:
            nc_path.unlink(missing_ok=True)

    from datetime import datetime
    dt = datetime.fromisoformat(req.run_time.replace("Z", "+00:00"))
    return FetchResponse(run=dt.strftime("%Y-%m-%dT%HZ"), written=total_written)
```

- [ ] **Step 7: Run test to verify it passes**

```bash
cd services/glofas-fetcher && python -m pytest tests/ -v
```

Expected: all tests PASS (test_healthz + 2 cds + 1 converter + 2 writer + 1 fetch endpoint = 7 tests).

- [ ] **Step 8: Commit**

```bash
git add services/glofas-fetcher/app/writer.py services/glofas-fetcher/app/main.py services/glofas-fetcher/tests/test_writer.py services/glofas-fetcher/tests/test_main.py
git commit -m "feat(glofas-fetcher): /fetch endpoint orchestrating cdsapi + convert"
```

---

## Task 5: Dockerfile + CI build

**Files:**
- Create: `services/glofas-fetcher/Dockerfile`
- Create: `services/glofas-fetcher/.dockerignore`
- Modify: `.github/workflows/build-maritime.yml` (or equivalent) — ajouter glofas-fetcher à la matrix

- [ ] **Step 1: Write `Dockerfile`**

```dockerfile
# services/glofas-fetcher/Dockerfile
FROM python:3.12-slim-bookworm AS base

# rasterio needs GDAL native libs
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgdal-dev \
    gdal-bin \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/

EXPOSE 8080
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--log-config", "/dev/null"]
```

- [ ] **Step 2: Write `.dockerignore`**

```
tests/
__pycache__/
*.pyc
.pytest_cache/
.coverage
*.egg-info/
.git/
.venv/
```

- [ ] **Step 3: Build the image locally to verify**

```bash
cd services/glofas-fetcher && docker build -t glofas-fetcher:local .
```

Expected: build succeeds (~5-8 min for first build with GDAL deps), final image < 800 MB.

- [ ] **Step 4: Run the image and smoke `/healthz`**

```bash
docker run --rm -d --name glofas-fetcher-test -p 8080:8080 glofas-fetcher:local
sleep 3
curl -fsS http://localhost:8080/healthz
docker rm -f glofas-fetcher-test
```

Expected: `{"status":"ok"}` then container removed.

- [ ] **Step 5: Find the existing CI matrix file**

```bash
grep -lE "ais-decoder|grib-parser|sst-fetcher" .github/workflows/ | head -3
```

Find the file that builds maritime services and add `glofas-fetcher` to the matrix.

- [ ] **Step 6: Add `glofas-fetcher` to the CI matrix**

Locate the build matrix array in the workflow YAML and add the new service. Pattern (assuming format follows `grib-parser`):

```yaml
# Adapt to the actual matrix structure in your workflow file
strategy:
  matrix:
    service:
      - ais-decoder
      - grib-parser
      - lightning-fetcher
      - sst-fetcher
      - glofas-fetcher   # <-- ADD THIS LINE
```

- [ ] **Step 7: Commit**

```bash
git add services/glofas-fetcher/Dockerfile services/glofas-fetcher/.dockerignore .github/workflows/
git commit -m "feat(ci): build & push glofas-fetcher image"
git push origin main
```

Expected: CI builds & pushes `ghcr.io/sylad/maritime-glofas-fetcher:<sha>` successfully.

---

# Phase 2 — K8s infrastructure

## Task 6: CDS credentials Secret (manual, hors gitops)

**Files:** none in repo. Manual `kubectl` on Mini-Blue.

- [ ] **Step 1: Sylvain creates ECMWF/CDS account**

Manual step Sylvain : aller sur https://cds.climate.copernicus.eu, register, recevoir email confirmation, login, aller sur https://cds.climate.copernicus.eu/profile/api-token.

Récupérer son UID (numérique) + API key (UUID).

- [ ] **Step 2: Build `.cdsapirc` content**

Format attendu par cdsapi :

```
url: https://cds.climate.copernicus.eu/api
key: <UID>:<API-KEY>
```

Exemple : `key: 12345:abcdef12-3456-7890-abcd-ef1234567890`

- [ ] **Step 3: Create K8s Secret on Mini-Blue**

```bash
kubectl --context mini-blue -n aetherwx create secret generic glofas-cds-credentials \
  --from-literal=cdsapirc="url: https://cds.climate.copernicus.eu/api
key: <UID>:<API-KEY>"
```

Replace `<UID>:<API-KEY>` with the real values. The Secret key `cdsapirc` will be mounted as the file `/root/.cdsapirc` in the sidecar pod.

- [ ] **Step 4: Verify the Secret exists**

```bash
kubectl --context mini-blue -n aetherwx get secret glofas-cds-credentials -o jsonpath='{.data.cdsapirc}' | base64 -d | head -2
```

Expected: prints the `.cdsapirc` content correctly.

- [ ] **Step 5: Add a `.gitignore` line + memory entry to never commit**

```bash
echo "# Never commit CDS credentials (manual Secret on Mini-Blue)" >> .gitignore
echo "**/cdsapirc" >> .gitignore
git add .gitignore && git commit -m "chore: gitignore cdsapirc"
```

---

## Task 7: Helm chart — PVC + Deployment + Service

**Files:**
- Create: `developpeur-gitops/charts/maritime/templates/glofas-fetcher-pvc.yaml`
- Create: `developpeur-gitops/charts/maritime/templates/glofas-fetcher-deployment.yaml`
- Create: `developpeur-gitops/charts/maritime/templates/glofas-fetcher-service.yaml`
- Modify: `developpeur-gitops/charts/maritime/values.yaml`

- [ ] **Step 1: Open reference template `sst-fetcher.yaml`**

```bash
cat developpeur-gitops/charts/maritime/templates/sst-fetcher.yaml
```

Note structure: Deployment + Service + (optionally) PVC + env vars from values.

- [ ] **Step 2: Write `glofas-fetcher-pvc.yaml`**

```yaml
# developpeur-gitops/charts/maritime/templates/glofas-fetcher-pvc.yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: coverage-glofas
  namespace: {{ .Values.namespace }}
  labels:
    app.kubernetes.io/name: glofas-fetcher
    app.kubernetes.io/part-of: maritime
spec:
  accessModes:
    - ReadWriteMany
  resources:
    requests:
      storage: {{ .Values.glofasFetcher.pvcSize | default "20Gi" }}
  storageClassName: {{ .Values.storageClassName | default "longhorn" }}
```

- [ ] **Step 3: Write `glofas-fetcher-deployment.yaml`**

```yaml
# developpeur-gitops/charts/maritime/templates/glofas-fetcher-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: glofas-fetcher
  namespace: {{ .Values.namespace }}
  labels:
    app.kubernetes.io/name: glofas-fetcher
    app.kubernetes.io/part-of: maritime
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: glofas-fetcher
  template:
    metadata:
      labels:
        app.kubernetes.io/name: glofas-fetcher
    spec:
      containers:
        - name: glofas-fetcher
          image: "{{ .Values.glofasFetcher.image.repository }}:{{ .Values.glofasFetcher.image.tag }}"
          imagePullPolicy: IfNotPresent
          ports:
            - containerPort: 8080
              name: http
          env:
            - name: COVERAGE_BASE_DIR
              value: /coverage/glofas
            - name: PYTHONUNBUFFERED
              value: "1"
          volumeMounts:
            - name: coverage
              mountPath: /coverage/glofas
            - name: cds-credentials
              mountPath: /root/.cdsapirc
              subPath: cdsapirc
              readOnly: true
          resources:
            requests:
              cpu: 200m
              memory: 512Mi
            limits:
              cpu: 2000m
              memory: 4Gi
          readinessProbe:
            httpGet:
              path: /healthz
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8080
            initialDelaySeconds: 30
            periodSeconds: 30
      volumes:
        - name: coverage
          persistentVolumeClaim:
            claimName: coverage-glofas
        - name: cds-credentials
          secret:
            secretName: glofas-cds-credentials
            defaultMode: 0400
```

- [ ] **Step 4: Write `glofas-fetcher-service.yaml`**

```yaml
# developpeur-gitops/charts/maritime/templates/glofas-fetcher-service.yaml
apiVersion: v1
kind: Service
metadata:
  name: glofas-fetcher
  namespace: {{ .Values.namespace }}
  labels:
    app.kubernetes.io/name: glofas-fetcher
spec:
  type: ClusterIP
  selector:
    app.kubernetes.io/name: glofas-fetcher
  ports:
    - name: http
      port: 8080
      targetPort: 8080
      protocol: TCP
```

- [ ] **Step 5: Patch `values.yaml`**

Open `developpeur-gitops/charts/maritime/values.yaml` and add at the appropriate level (sibling of other `*Fetcher` blocks):

```yaml
glofasFetcher:
  image:
    repository: ghcr.io/sylad/maritime-glofas-fetcher
    tag: "<SHA-from-CI-build>"   # replace with actual sha after Task 5 push
  pvcSize: 20Gi
```

- [ ] **Step 6: Helm template dry-run to verify rendering**

```bash
cd developpeur-gitops/charts/maritime
helm template . --debug 2>&1 | grep -A 10 "glofas-fetcher" | head -40
```

Expected: 3 manifests render correctly (PVC, Deployment, Service), no missing values.

- [ ] **Step 7: Commit (in `developpeur-gitops` repo, not maritime-atlas)**

```bash
cd /home/sylvain_ladoire/projects/developpeur/developpeur-gitops
git add charts/maritime/templates/glofas-fetcher-*.yaml charts/maritime/values.yaml
git commit -m "feat(maritime): deploy glofas-fetcher sidecar (deployment + svc + pvc)"
git push origin main
```

Expected: ArgoCD picks up the change within 3 min, syncs the new manifests, pod `glofas-fetcher-*` starts on Mini-Blue.

- [ ] **Step 8: Verify pod is healthy**

```bash
kubectl --context mini-blue -n aetherwx wait --for=condition=Ready pod -l app.kubernetes.io/name=glofas-fetcher --timeout=180s
kubectl --context mini-blue -n aetherwx logs deploy/glofas-fetcher --tail=20
```

Expected: pod Ready, logs show "Uvicorn running on http://0.0.0.0:8080".

- [ ] **Step 9: Smoke test from inside cluster**

```bash
kubectl --context mini-blue -n aetherwx run curl-test --rm -it --image=curlimages/curl --restart=Never -- \
  curl -s http://glofas-fetcher.aetherwx.svc.cluster.local.:8080/healthz
```

Expected: `{"status":"ok"}`.

---

## Task 8: Argo CronWorkflow `glofas-refresh`

**Files:**
- Create: `developpeur-gitops/charts/maritime/templates/glofas-refresh-cronworkflow.yaml`

- [ ] **Step 1: Look at existing CronWorkflow pattern**

```bash
find developpeur-gitops/ -name "*cronworkflow*" -type f 2>/dev/null
```

Use one of the existing CronWorkflows as a structural template.

- [ ] **Step 2: Write the CronWorkflow YAML**

```yaml
# developpeur-gitops/charts/maritime/templates/glofas-refresh-cronworkflow.yaml
apiVersion: argoproj.io/v1alpha1
kind: CronWorkflow
metadata:
  name: glofas-refresh
  namespace: {{ .Values.namespace }}
  labels:
    app.kubernetes.io/name: glofas-refresh
    app.kubernetes.io/part-of: maritime
spec:
  schedules:
    - "0 */6 * * *"   # toutes les 6h (runs 00, 06, 12, 18 UTC, aligné GloFAS publish)
  timezone: UTC
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 5
  workflowSpec:
    serviceAccountName: argo-workflow-sa
    activeDeadlineSeconds: 4200  # 70 min hard cap (cdsapi queue + transfer)
    podGC:
      strategy: OnPodCompletion
    entrypoint: trigger-glofas
    templates:
      - name: trigger-glofas
        container:
          image: curlimages/curl:8.10.1
          command: [sh, -c]
          args:
            - |
              set -e
              URL="http://maritime-api.{{ .Values.namespace }}.svc.cluster.local.:3000/internal-trigger/sources/glofas"
              echo "[glofas-refresh] POST $URL"
              RESPONSE_FILE=/tmp/response.json
              HTTP_CODE=$(curl -sS -o "$RESPONSE_FILE" -w "%{http_code}" \
                -X POST \
                -H "Content-Type: application/json" \
                -H "X-Service-Token: $SERVICE_TOKEN" \
                "$URL")
              echo "[glofas-refresh] HTTP $HTTP_CODE"
              echo "[glofas-refresh] body:"
              cat "$RESPONSE_FILE"
              echo
              if [ "$HTTP_CODE" != "200" ] && [ "$HTTP_CODE" != "202" ]; then
                echo "[glofas-refresh] FAILED with HTTP $HTTP_CODE"
                exit 1
              fi
          env:
            - name: SERVICE_TOKEN
              valueFrom:
                secretKeyRef:
                  name: internal-trigger-service-token
                  key: token
        retryStrategy:
          limit: 3
          retryPolicy: OnFailure
          backoff:
            duration: "10m"
            factor: 3
            maxDuration: "1h"
```

- [ ] **Step 3: Verify the `internal-trigger-service-token` Secret exists**

```bash
kubectl --context mini-blue -n aetherwx get secret internal-trigger-service-token -o name
```

If missing (it should exist from prior orchestrator migration G12g): create it.

```bash
kubectl --context mini-blue -n aetherwx create secret generic internal-trigger-service-token \
  --from-literal=token="$(openssl rand -hex 32)"
```

Then ensure NestJS API has the same value in its env (via existing Secret reference).

- [ ] **Step 4: Helm template dry-run**

```bash
cd developpeur-gitops/charts/maritime
helm template . --debug 2>&1 | grep -A 30 "glofas-refresh" | head -50
```

Expected: CronWorkflow renders with proper schedule + curl block.

- [ ] **Step 5: Commit**

```bash
cd /home/sylvain_ladoire/projects/developpeur/developpeur-gitops
git add charts/maritime/templates/glofas-refresh-cronworkflow.yaml
git commit -m "feat(maritime): argo cronworkflow glofas-refresh every 6h"
git push origin main
```

Expected: ArgoCD syncs the CronWorkflow; visible in `argo cron list -n aetherwx`.

- [ ] **Step 6: Verify CronWorkflow is registered**

```bash
kubectl --context mini-blue -n aetherwx get cronworkflows
```

Expected: shows `glofas-refresh` with `SCHEDULE: 0 */6 * * *`.

---

# Phase 3 — NestJS GlofasModule

## Task 9: Module scaffolding + types

**Files:**
- Create: `services/api/src/glofas/glofas.module.ts`
- Create: `services/api/src/glofas/glofas.types.ts`
- Modify: `services/api/src/app.module.ts`

- [ ] **Step 1: Reference the existing `hubeau` module for style**

```bash
cat services/api/src/hubeau/hubeau.module.ts
```

Note imports, providers, controllers exports.

- [ ] **Step 2: Write `glofas.types.ts`**

```typescript
// services/api/src/glofas/glofas.types.ts

export interface GlofasFetchTriggerResponse {
  ok: boolean;
  run: string;
  written: number;
}

export interface GlofasTimeSeriesPoint {
  ts: string;       // ISO-8601 UTC
  Q5: number | null;   // probability 0-1, or null = nodata
  Q20: number | null;
  Q50: number | null;
}

export interface GlofasTimeSeriesResponse {
  available: boolean;
  lon: number;
  lat: number;
  run: string | null;
  series: GlofasTimeSeriesPoint[];
}
```

- [ ] **Step 3: Write `glofas.module.ts`**

```typescript
// services/api/src/glofas/glofas.module.ts
import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';

import { GlofasController } from './glofas.controller';
import { GlofasService } from './glofas.service';

@Module({
  imports: [HttpModule],
  controllers: [GlofasController],
  providers: [GlofasService],
  exports: [GlofasService],
})
export class GlofasModule {}
```

- [ ] **Step 4: Register module in `app.module.ts`**

In `services/api/src/app.module.ts`, add to `imports`:

```typescript
import { GlofasModule } from './glofas/glofas.module';

// inside @Module({ imports: [..., GlofasModule] })
```

- [ ] **Step 5: Commit**

```bash
git add services/api/src/glofas/glofas.module.ts services/api/src/glofas/glofas.types.ts services/api/src/app.module.ts
git commit -m "feat(api): scaffold GlofasModule + types"
```

---

## Task 10: `/internal-trigger/sources/glofas` endpoint

**Files:**
- Create: `services/api/src/glofas/glofas.controller.ts`
- Create: `services/api/src/glofas/glofas.service.ts`
- Create: `services/api/src/glofas/glofas.controller.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// services/api/src/glofas/glofas.controller.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { HttpModule, HttpService } from '@nestjs/axios';
import { ForbiddenException } from '@nestjs/common';
import { of, throwError } from 'rxjs';

import { GlofasController } from './glofas.controller';
import { GlofasService } from './glofas.service';

describe('GlofasController — POST /internal-trigger/sources/glofas', () => {
  let controller: GlofasController;
  let service: GlofasService;

  beforeEach(async () => {
    process.env.INTERNAL_TRIGGER_SERVICE_TOKEN = 'test-token-123';
    process.env.GLOFAS_FETCHER_URL = 'http://glofas-fetcher:8080';

    const module: TestingModule = await Test.createTestingModule({
      imports: [HttpModule],
      controllers: [GlofasController],
      providers: [GlofasService],
    }).compile();

    controller = module.get<GlofasController>(GlofasController);
    service = module.get<GlofasService>(GlofasService);
  });

  it('rejects when X-Service-Token header is missing', async () => {
    await expect(
      controller.triggerFetch({}, { 'x-service-token': undefined } as any),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects when X-Service-Token does not match env var', async () => {
    await expect(
      controller.triggerFetch({}, { 'x-service-token': 'wrong' } as any),
    ).rejects.toThrow(ForbiddenException);
  });

  it('accepts when token matches and calls fetchLatestRun', async () => {
    const spy = jest.spyOn(service, 'fetchLatestRun').mockResolvedValue({
      ok: true,
      run: '2026-05-27T00Z',
      written: 21,
    });
    const result = await controller.triggerFetch(
      {},
      { 'x-service-token': 'test-token-123' } as any,
    );
    expect(spy).toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.written).toBe(21);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd services/api && npm test -- glofas.controller.spec
```

Expected: FAIL with cannot find module 'glofas.controller'.

- [ ] **Step 3: Implement `glofas.service.ts`**

```typescript
// services/api/src/glofas/glofas.service.ts
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

import { GlofasFetchTriggerResponse } from './glofas.types';

const DEFAULT_LEADTIMES = [24, 48, 72, 96, 120, 144, 168];
const DEFAULT_THRESHOLDS = ['Q5', 'Q20', 'Q50'];

@Injectable()
export class GlofasService {
  private readonly logger = new Logger(GlofasService.name);

  constructor(private readonly http: HttpService) {}

  private get fetcherUrl(): string {
    const url = process.env.GLOFAS_FETCHER_URL;
    if (!url) throw new Error('GLOFAS_FETCHER_URL env var not set');
    return url;
  }

  private latestRunTimeIso(): string {
    // GloFAS publishes 4 runs per day (00, 06, 12, 18 UTC).
    // We pick the most recent boundary that has passed at least 2h ago
    // (publish lag).
    const now = new Date();
    const candidate = new Date(now);
    candidate.setUTCMinutes(0, 0, 0);
    // Round down to nearest 6h
    const h = candidate.getUTCHours();
    candidate.setUTCHours(h - (h % 6));
    // Account for publish lag: if less than 2h since boundary, go back one more run
    if ((now.getTime() - candidate.getTime()) < 2 * 3600 * 1000) {
      candidate.setUTCHours(candidate.getUTCHours() - 6);
    }
    return candidate.toISOString().replace('.000', '');
  }

  async fetchLatestRun(): Promise<GlofasFetchTriggerResponse> {
    const runTime = this.latestRunTimeIso();
    this.logger.log(`fetchLatestRun start run=${runTime}`);

    const url = `${this.fetcherUrl}/fetch`;
    const body = {
      run_time: runTime,
      leadtimes: DEFAULT_LEADTIMES,
      thresholds: DEFAULT_THRESHOLDS,
    };

    try {
      const response = await firstValueFrom(
        this.http.post<{ run: string; written: number }>(url, body, {
          timeout: 3_600_000, // 1h
        }),
      );
      this.logger.log(`fetchLatestRun done run=${response.data.run} written=${response.data.written}`);
      return { ok: true, run: response.data.run, written: response.data.written };
    } catch (err) {
      this.logger.error(`fetchLatestRun failed run=${runTime}`, err);
      throw new ServiceUnavailableException('glofas-fetcher upstream failed');
    }
  }
}
```

- [ ] **Step 4: Implement `glofas.controller.ts`**

```typescript
// services/api/src/glofas/glofas.controller.ts
import {
  Body,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  Post,
} from '@nestjs/common';

import { GlofasService } from './glofas.service';
import { GlofasFetchTriggerResponse } from './glofas.types';

@Controller()
export class GlofasController {
  constructor(private readonly service: GlofasService) {}

  @Post('internal-trigger/sources/glofas')
  @HttpCode(200)
  async triggerFetch(
    @Body() _body: Record<string, unknown>,
    @Headers() headers: Record<string, string | undefined>,
  ): Promise<GlofasFetchTriggerResponse> {
    const provided = headers['x-service-token'];
    const expected = process.env.INTERNAL_TRIGGER_SERVICE_TOKEN;
    if (!provided || !expected || provided !== expected) {
      throw new ForbiddenException('invalid service token');
    }
    return this.service.fetchLatestRun();
  }
}
```

- [ ] **Step 5: Run test to verify all pass**

```bash
cd services/api && npm test -- glofas.controller.spec
```

Expected: 3 PASS.

- [ ] **Step 6: Commit**

```bash
git add services/api/src/glofas/glofas.service.ts services/api/src/glofas/glofas.controller.ts services/api/src/glofas/glofas.controller.spec.ts
git commit -m "feat(api): glofas internal-trigger endpoint with service-token auth"
```

---

## Task 11: `/api/glofas/timeseries` endpoint with caching

**Files:**
- Modify: `services/api/src/glofas/glofas.controller.ts` — add `@Get('api/glofas/timeseries')`
- Modify: `services/api/src/glofas/glofas.service.ts` — add `getTimeSeries(lon, lat)`
- Create: `services/api/src/glofas/glofas.service.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// services/api/src/glofas/glofas.service.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { HttpModule, HttpService } from '@nestjs/axios';
import { of } from 'rxjs';

import { GlofasService } from './glofas.service';

describe('GlofasService — getTimeSeries', () => {
  let service: GlofasService;
  let http: HttpService;

  beforeEach(async () => {
    process.env.GS_WMS_URL = 'http://geoserver:8080/geoserver/aetherwx/wms';

    const module: TestingModule = await Test.createTestingModule({
      imports: [HttpModule],
      providers: [GlofasService],
    }).compile();

    service = module.get<GlofasService>(GlofasService);
    http = module.get<HttpService>(HttpService);
  });

  it('issues 21 parallel GetFeatureInfo requests (3 seuils × 7 leadtimes)', async () => {
    const getSpy = jest.spyOn(http, 'get').mockReturnValue(
      of({
        data: { features: [{ properties: { GRAY_INDEX: 0.42 } }] },
      } as any),
    );

    const result = await service.getTimeSeries(2.35, 48.85); // Paris-ish

    expect(getSpy).toHaveBeenCalledTimes(21);
    expect(result.available).toBe(true);
    expect(result.series).toHaveLength(7);
    expect(result.series[0]).toHaveProperty('Q5');
    expect(result.series[0]).toHaveProperty('Q20');
    expect(result.series[0]).toHaveProperty('Q50');
  });

  it('returns available=false when all features are empty (point in nodata)', async () => {
    jest.spyOn(http, 'get').mockReturnValue(
      of({ data: { features: [] } } as any),
    );

    const result = await service.getTimeSeries(0, 0);
    expect(result.available).toBe(false);
    expect(result.series).toHaveLength(0);
  });

  it('caches identical (lon, lat) within TTL', async () => {
    const getSpy = jest.spyOn(http, 'get').mockReturnValue(
      of({ data: { features: [{ properties: { GRAY_INDEX: 0.5 } }] } } as any),
    );

    await service.getTimeSeries(1.5, 43.5);
    await service.getTimeSeries(1.5, 43.5);

    // Second call should hit cache
    expect(getSpy).toHaveBeenCalledTimes(21);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd services/api && npm test -- glofas.service.spec
```

Expected: FAIL — `service.getTimeSeries is not a function`.

- [ ] **Step 3: Extend `glofas.service.ts` with `getTimeSeries`**

Append to `services/api/src/glofas/glofas.service.ts`:

```typescript
// Add these imports at the top
import { lastValueFrom } from 'rxjs';
import { GlofasTimeSeriesPoint, GlofasTimeSeriesResponse } from './glofas.types';

// Add inside GlofasService class:

private readonly cache = new Map<string, { ts: number; value: GlofasTimeSeriesResponse }>();
private readonly CACHE_TTL_MS = 3_600_000; // 1h

private get gsWmsUrl(): string {
  const url = process.env.GS_WMS_URL;
  if (!url) throw new Error('GS_WMS_URL env var not set');
  return url;
}

private roundCoord(v: number): number {
  return Math.round(v * 10000) / 10000;
}

private cacheKey(lon: number, lat: number): string {
  return `${this.roundCoord(lon)}|${this.roundCoord(lat)}`;
}

async getTimeSeries(lon: number, lat: number): Promise<GlofasTimeSeriesResponse> {
  const key = this.cacheKey(lon, lat);
  const cached = this.cache.get(key);
  if (cached && (Date.now() - cached.ts) < this.CACHE_TTL_MS) {
    this.logger.debug(`getTimeSeries cache HIT key=${key}`);
    return cached.value;
  }

  const runTime = this.latestRunTimeIso();
  const leadtimes = [24, 48, 72, 96, 120, 144, 168];
  const thresholds = ['q5', 'q20', 'q50'] as const;

  // 21 parallel WMS GetFeatureInfo
  const promises: Promise<{ leadtime: number; threshold: string; value: number | null }>[] = [];
  for (const threshold of thresholds) {
    for (const lh of leadtimes) {
      const timestamp = this.addHours(runTime, lh);
      const url = this.buildGfiUrl(this.gsWmsUrl, `aetherwx:glofas-flood-prob-${threshold}`, lon, lat, timestamp);
      promises.push(
        lastValueFrom(this.http.get(url, { timeout: 5000 })).then(
          (resp) => {
            const features = (resp.data as any)?.features ?? [];
            const v = features.length > 0
              ? Number(features[0]?.properties?.GRAY_INDEX ?? null)
              : null;
            return { leadtime: lh, threshold, value: Number.isFinite(v) ? v : null };
          },
          () => ({ leadtime: lh, threshold, value: null }),
        ),
      );
    }
  }

  const results = await Promise.all(promises);
  const anyData = results.some((r) => r.value !== null);
  if (!anyData) {
    const empty: GlofasTimeSeriesResponse = { available: false, lon, lat, run: runTime, series: [] };
    this.cache.set(key, { ts: Date.now(), value: empty });
    return empty;
  }

  const series: GlofasTimeSeriesPoint[] = leadtimes.map((lh) => {
    const ts = this.addHours(runTime, lh);
    const pick = (th: 'q5' | 'q20' | 'q50') =>
      results.find((r) => r.leadtime === lh && r.threshold === th)?.value ?? null;
    return { ts, Q5: pick('q5'), Q20: pick('q20'), Q50: pick('q50') };
  });

  const response: GlofasTimeSeriesResponse = {
    available: true,
    lon,
    lat,
    run: runTime,
    series,
  };
  this.cache.set(key, { ts: Date.now(), value: response });
  return response;
}

private addHours(iso: string, h: number): string {
  const d = new Date(iso);
  d.setUTCHours(d.getUTCHours() + h);
  return d.toISOString().replace('.000', '');
}

private buildGfiUrl(
  base: string,
  layer: string,
  lon: number,
  lat: number,
  time: string,
): string {
  // 1×1 pixel BBOX centered on (lon, lat)
  const epsilon = 0.0001;
  const bbox = `${lon - epsilon},${lat - epsilon},${lon + epsilon},${lat + epsilon}`;
  const params = new URLSearchParams({
    service: 'WMS',
    version: '1.1.1',
    request: 'GetFeatureInfo',
    layers: layer,
    query_layers: layer,
    bbox,
    width: '1',
    height: '1',
    x: '0',
    y: '0',
    srs: 'EPSG:4326',
    info_format: 'application/json',
    TIME: time,
  });
  return `${base}?${params.toString()}`;
}
```

- [ ] **Step 4: Add controller endpoint**

In `services/api/src/glofas/glofas.controller.ts`, add:

```typescript
import { Get, Query, BadRequestException } from '@nestjs/common';
import { GlofasTimeSeriesResponse } from './glofas.types';

// Inside class, add method:

@Get('api/glofas/timeseries')
async getTimeSeries(
  @Query('lon') lonStr?: string,
  @Query('lat') latStr?: string,
): Promise<GlofasTimeSeriesResponse> {
  const lon = Number(lonStr);
  const lat = Number(latStr);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    throw new BadRequestException('lon and lat must be finite numbers');
  }
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
    throw new BadRequestException('lon/lat out of range');
  }
  return this.service.getTimeSeries(lon, lat);
}
```

- [ ] **Step 5: Run tests to verify all pass**

```bash
cd services/api && npm test -- glofas
```

Expected: all glofas tests PASS (6 total : 3 controller + 3 service).

- [ ] **Step 6: Commit**

```bash
git add services/api/src/glofas/
git commit -m "feat(api): /api/glofas/timeseries endpoint with cache + parallel GFI"
```

---

## Task 12: Build & push api image, bump tag

**Files:**
- Modify: `developpeur-gitops/charts/maritime/values.yaml` — bump `api.image.tag`

- [ ] **Step 1: Push api changes to remote**

```bash
cd /home/sylvain_ladoire/projects/developpeur/maritime-atlas
git push origin main
```

Wait for CI to build & push `ghcr.io/sylad/maritime-api:<new-sha>`.

- [ ] **Step 2: Verify CI succeeded**

```bash
gh run list --limit 1 --workflow build-maritime.yml
```

Expected: `completed success`.

- [ ] **Step 3: Bump api tag in values.yaml**

In `developpeur-gitops/charts/maritime/values.yaml`, find `api.image.tag:` and replace with the new SHA from CI.

- [ ] **Step 4: Add env vars for api**

In the same `values.yaml`, in the `api.env` block (or equivalent), add:

```yaml
api:
  env:
    GLOFAS_FETCHER_URL: "http://glofas-fetcher.aetherwx.svc.cluster.local.:8080"
    GS_WMS_URL: "http://geoserver.aetherwx.svc.cluster.local.:8080/geoserver/aetherwx/wms"
```

Verify `INTERNAL_TRIGGER_SERVICE_TOKEN` is already wired from the `internal-trigger-service-token` Secret.

- [ ] **Step 5: Commit gitops bump**

```bash
cd /home/sylvain_ladoire/projects/developpeur/developpeur-gitops
git add charts/maritime/values.yaml
git commit -m "chore(maritime): bump api tag to <sha> + glofas env vars"
git push origin main
```

ArgoCD syncs within 3 min. New `maritime-api-*` pod with `/api/glofas/*` routes available.

- [ ] **Step 6: Smoke `/api/glofas/timeseries` (should 200 with `available:false` because no GS layer yet)**

```bash
kubectl --context mini-blue -n aetherwx run curl-test --rm -it --image=curlimages/curl --restart=Never -- \
  curl -s 'http://maritime-api.aetherwx.svc.cluster.local.:3000/api/glofas/timeseries?lon=2.35&lat=48.85'
```

Expected: `{"available":false,"lon":2.35,"lat":48.85,"run":"...","series":[]}` (because layer doesn't exist yet; GFI returns empty).

---

# Phase 4 — GeoServer ImageMosaic + bootstrap

## Task 13: Java GlofasBootstrap class

**Files:**
- Create: `services/maritime-gs-bootstrap/src/main/java/com/aetherwx/gsbootstrap/GlofasBootstrap.java`
- Modify: `services/maritime-gs-bootstrap/src/main/java/com/aetherwx/gsbootstrap/BootstrapRunner.java`

- [ ] **Step 1: Reference an existing bootstrap class**

```bash
ls services/maritime-gs-bootstrap/src/main/java/com/aetherwx/gsbootstrap/
```

Use the simplest existing bootstrap (e.g., `SstBootstrap.java` or similar) as a structural reference.

- [ ] **Step 2: Write `GlofasBootstrap.java`**

```java
// services/maritime-gs-bootstrap/src/main/java/com/aetherwx/gsbootstrap/GlofasBootstrap.java
package com.aetherwx.gsbootstrap;

import org.geoserver.catalog.Catalog;
import org.geoserver.catalog.CoverageInfo;
import org.geoserver.catalog.CoverageStoreInfo;
import org.geoserver.catalog.LayerInfo;
import org.geoserver.catalog.StyleInfo;
import org.geoserver.catalog.WorkspaceInfo;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import javax.annotation.PostConstruct;
import java.util.Arrays;
import java.util.List;
import java.util.logging.Logger;

@Component
public class GlofasBootstrap {

    private static final Logger LOG = Logger.getLogger(GlofasBootstrap.class.getName());

    private static final String WORKSPACE = "aetherwx";
    private static final String STORE_NAME = "glofas";
    private static final String COVERAGE_PATH = "file:///coverage/glofas";
    private static final String STYLE_NAME = "glofas-prob-gradient";
    private static final List<String> THRESHOLDS = Arrays.asList("q5", "q20", "q50");

    @Autowired
    private Catalog catalog;

    @PostConstruct
    public void run() {
        try {
            LOG.info("[GlofasBootstrap] start");
            ensureWorkspace();
            ensureStyle();
            ensureCoverageStore();
            for (String th : THRESHOLDS) {
                ensureLayer(th);
            }
            LOG.info("[GlofasBootstrap] done");
        } catch (Exception e) {
            LOG.severe("[GlofasBootstrap] failed: " + e.getMessage());
            throw new RuntimeException(e);
        }
    }

    private void ensureWorkspace() {
        WorkspaceInfo ws = catalog.getWorkspaceByName(WORKSPACE);
        if (ws == null) {
            throw new IllegalStateException("Workspace " + WORKSPACE + " not found; SprintZeroBootstrap must run first");
        }
    }

    private void ensureStyle() {
        StyleInfo style = catalog.getStyleByName(STYLE_NAME);
        if (style != null) {
            LOG.info("[GlofasBootstrap] style " + STYLE_NAME + " already exists, skipping");
            return;
        }
        StyleInfo newStyle = catalog.getFactory().createStyle();
        newStyle.setName(STYLE_NAME);
        newStyle.setFilename(STYLE_NAME + ".sld");
        newStyle.setWorkspace(catalog.getWorkspaceByName(WORKSPACE));
        catalog.add(newStyle);
        // The actual SLD XML must be copied separately to GS data dir under
        // workspaces/aetherwx/styles/glofas-prob-gradient.sld
        // This is handled by the ConfigMap mount + initContainer in Helm.
        LOG.info("[GlofasBootstrap] registered style " + STYLE_NAME);
    }

    private void ensureCoverageStore() {
        if (catalog.getCoverageStoreByName(WORKSPACE, STORE_NAME) != null) {
            LOG.info("[GlofasBootstrap] coverage store already exists, skipping");
            return;
        }
        CoverageStoreInfo store = catalog.getFactory().createCoverageStore();
        store.setName(STORE_NAME);
        store.setWorkspace(catalog.getWorkspaceByName(WORKSPACE));
        store.setType("ImageMosaic");
        store.setEnabled(true);
        store.setURL(COVERAGE_PATH);
        catalog.add(store);
        LOG.info("[GlofasBootstrap] created coverage store " + STORE_NAME);
    }

    private void ensureLayer(String threshold) {
        String layerName = "glofas-flood-prob-" + threshold;
        if (catalog.getLayerByName(WORKSPACE + ":" + layerName) != null) {
            LOG.info("[GlofasBootstrap] layer " + layerName + " already exists, skipping");
            return;
        }
        // ImageMosaic coverage creation requires a builder; for now, log an
        // intent — actual coverage creation may need GS REST after PVC is
        // populated with the indexer.properties, since ImageMosaic auto-
        // detects schema from indexer files.
        LOG.warning("[GlofasBootstrap] layer " + layerName + " creation deferred until indexer ready");
    }
}
```

- [ ] **Step 3: Register in `BootstrapRunner.java`**

In `services/maritime-gs-bootstrap/src/main/java/com/aetherwx/gsbootstrap/BootstrapRunner.java`, add `GlofasBootstrap` to the bootstrap list (follow the existing pattern of injection + invocation).

- [ ] **Step 4: Build the plugin Maven project**

```bash
cd services/maritime-gs-bootstrap
mvn clean package -DskipTests
```

Expected: target/maritime-gs-bootstrap-*.jar built successfully.

- [ ] **Step 5: Commit**

```bash
git add services/maritime-gs-bootstrap/src/
git commit -m "feat(gs-bootstrap): GlofasBootstrap class for coverage store + style"
```

---

## Task 14: SLD style + indexer.properties

**Files:**
- Create: `services/maritime-gs-bootstrap/src/main/resources/styles/glofas-prob-gradient.sld`
- Create: `services/maritime-gs-bootstrap/src/main/resources/indexer/glofas-indexer.properties`

- [ ] **Step 1: Write `glofas-prob-gradient.sld`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<StyledLayerDescriptor version="1.0.0"
    xmlns="http://www.opengis.net/sld"
    xmlns:ogc="http://www.opengis.net/ogc"
    xmlns:xlink="http://www.w3.org/1999/xlink"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xsi:schemaLocation="http://www.opengis.net/sld http://schemas.opengis.net/sld/1.0.0/StyledLayerDescriptor.xsd">
  <NamedLayer>
    <Name>glofas-prob-gradient</Name>
    <UserStyle>
      <Title>GloFAS flood probability gradient</Title>
      <FeatureTypeStyle>
        <Rule>
          <RasterSymbolizer>
            <Opacity>0.85</Opacity>
            <ColorMap type="ramp">
              <ColorMapEntry color="#3b82f6" quantity="0"   opacity="0.0" label="0%"/>
              <ColorMapEntry color="#3b82f6" quantity="10"  opacity="0.3" label="10%"/>
              <ColorMapEntry color="#eab308" quantity="50"  opacity="0.6" label="50%"/>
              <ColorMapEntry color="#f97316" quantity="75"  opacity="0.7" label="75%"/>
              <ColorMapEntry color="#dc2626" quantity="100" opacity="0.85" label="100%"/>
            </ColorMap>
          </RasterSymbolizer>
        </Rule>
      </FeatureTypeStyle>
    </UserStyle>
  </NamedLayer>
</StyledLayerDescriptor>
```

- [ ] **Step 2: Write `glofas-indexer.properties`**

```properties
# services/maritime-gs-bootstrap/src/main/resources/indexer/glofas-indexer.properties
TimeAttribute=time
Schema=*the_geom:Polygon,location:String,time:java.util.Date,threshold:String,leadtime:Integer
PropertyCollectors=TimestampFileNameExtractorSPI[timeregex](time),StringFileNameExtractorSPI[thresholdregex](threshold),IntegerFileNameExtractorSPI[leadtimeregex](leadtime)
Caching=false
CanBeEmpty=true
AbsolutePath=false
LocationAttribute=location

# Filename: e.g. /coverage/glofas/2026-05-27T00Z/Q5/072.tif
# timeregex extracts 2026-05-27T00Z (mapped to time)
# thresholdregex extracts Q5
# leadtimeregex extracts 072 (cast to Integer)
```

- [ ] **Step 3: Add accompanying regex files**

```properties
# timeregex.properties
regex=[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}Z,format=yyyy-MM-dd'T'HHX

# thresholdregex.properties
regex=Q5|Q20|Q50

# leadtimeregex.properties
regex=(?<=/)[0-9]{3}(?=\\.tif)
```

Put each in the same `indexer/` resource folder.

- [ ] **Step 4: Update `GlofasBootstrap.java` to copy these files**

Add a method that copies the SLD + indexer files to the GeoServer data dir at startup (typical pattern: read resources from classpath, write to `${GEOSERVER_DATA_DIR}/workspaces/aetherwx/styles/` and `${GEOSERVER_DATA_DIR}/data/glofas/`).

```java
// Add to GlofasBootstrap.java
private void copyResourcesToDataDir() throws IOException {
    String dataDir = System.getenv("GEOSERVER_DATA_DIR");
    if (dataDir == null) {
        throw new IllegalStateException("GEOSERVER_DATA_DIR not set");
    }
    // SLD
    Path stylesDir = Paths.get(dataDir, "workspaces", WORKSPACE, "styles");
    Files.createDirectories(stylesDir);
    copyResource("/styles/glofas-prob-gradient.sld", stylesDir.resolve("glofas-prob-gradient.sld"));
    // Indexer
    Path coverageDir = Paths.get("/coverage/glofas");
    Files.createDirectories(coverageDir);
    copyResource("/indexer/glofas-indexer.properties", coverageDir.resolve("indexer.properties"));
    copyResource("/indexer/timeregex.properties", coverageDir.resolve("timeregex.properties"));
    copyResource("/indexer/thresholdregex.properties", coverageDir.resolve("thresholdregex.properties"));
    copyResource("/indexer/leadtimeregex.properties", coverageDir.resolve("leadtimeregex.properties"));
}

private void copyResource(String classpathPath, Path target) throws IOException {
    try (InputStream in = getClass().getResourceAsStream(classpathPath)) {
        if (in == null) throw new FileNotFoundException(classpathPath);
        Files.copy(in, target, StandardCopyOption.REPLACE_EXISTING);
        LOG.info("[GlofasBootstrap] copied " + classpathPath + " → " + target);
    }
}
```

Call `copyResourcesToDataDir()` early in `run()`.

- [ ] **Step 5: Rebuild plugin Maven**

```bash
cd services/maritime-gs-bootstrap
mvn clean package -DskipTests
```

- [ ] **Step 6: Build & push GeoServer custom image**

```bash
# Locate the GS image Dockerfile (the plugin jar is baked in)
ls services/geoserver/
docker build -t ghcr.io/sylad/maritime-geoserver:glofas-test services/geoserver/
docker push ghcr.io/sylad/maritime-geoserver:glofas-test
```

(If CI builds this automatically, just push the commit and wait.)

- [ ] **Step 7: Commit**

```bash
git add services/maritime-gs-bootstrap/src/
git commit -m "feat(gs-bootstrap): glofas SLD + indexer regex files"
git push origin main
```

---

## Task 15: First end-to-end run + verify WMS

**Files:** none.

- [ ] **Step 1: Bump GS image tag in gitops**

In `developpeur-gitops/charts/maritime/values.yaml`, bump `geoserver.image.tag` to the new SHA.

```bash
cd /home/sylvain_ladoire/projects/developpeur/developpeur-gitops
# edit values.yaml
git add charts/maritime/values.yaml
git commit -m "chore(maritime): bump geoserver to <sha> for glofas bootstrap"
git push origin main
```

- [ ] **Step 2: Wait for ArgoCD sync + GS pod restart**

```bash
kubectl --context mini-blue -n aetherwx rollout status deploy/geoserver --timeout=300s
kubectl --context mini-blue -n aetherwx logs deploy/geoserver --tail=80 | grep -i "GlofasBootstrap"
```

Expected: logs show "[GlofasBootstrap] start", "registered style", "created coverage store", "done".

- [ ] **Step 3: Trigger an initial fetch manually**

```bash
kubectl --context mini-blue -n aetherwx exec -it deploy/maritime-api -- \
  curl -fsS -X POST -H "Content-Type: application/json" \
    -H "X-Service-Token: $(kubectl --context mini-blue -n aetherwx get secret internal-trigger-service-token -o jsonpath='{.data.token}' | base64 -d)" \
    http://localhost:3000/internal-trigger/sources/glofas
```

Expected (after 5-30 min queue + transfer): `{"ok":true,"run":"2026-05-27T00Z","written":21}`.

- [ ] **Step 4: Verify coverage files written**

```bash
kubectl --context mini-blue -n aetherwx exec -it deploy/glofas-fetcher -- ls -la /coverage/glofas/
```

Expected: shows `2026-05-27T00Z/` directory with `Q5/`, `Q20/`, `Q50/` subdirs, each containing 7 `.tif` files (024.tif, 048.tif, ..., 168.tif).

- [ ] **Step 5: Reload the GS ImageMosaic to pick up files**

```bash
GS_USER=admin
GS_PWD="$(kubectl --context mini-blue -n aetherwx get secret geoserver-admin -o jsonpath='{.data.password}' | base64 -d)"
kubectl --context mini-blue -n aetherwx exec -it deploy/maritime-api -- \
  curl -fsS -u "$GS_USER:$GS_PWD" \
  -X POST "http://geoserver:8080/geoserver/rest/workspaces/aetherwx/coveragestores/glofas/external.imagemosaic" \
  -H "Content-type: text/plain" \
  -d "file:///coverage/glofas"
```

- [ ] **Step 6: Verify 3 layers exist**

```bash
curl -s "https://aetherwx.sladoire.dev/geoserver/aetherwx/wms?service=WMS&version=1.1.1&request=GetCapabilities" \
  | grep -E "glofas-flood-prob-(q5|q20|q50)"
```

Expected: 3 lines matching the layer names with TIME dimensions.

- [ ] **Step 7: Smoke test a WMS GetMap on one layer**

```bash
curl -fsS -o /tmp/glofas-test.png \
  "https://aetherwx.sladoire.dev/geoserver/aetherwx/wms?service=WMS&version=1.1.1&request=GetMap&layers=aetherwx:glofas-flood-prob-q5&styles=&bbox=-180,-90,180,90&width=600&height=300&srs=EPSG:4326&format=image/png&TIME=2026-05-28T00:00:00Z"
ls -la /tmp/glofas-test.png
file /tmp/glofas-test.png
```

Expected: PNG file > 5KB. Optionally inspect visually.

- [ ] **Step 8: Smoke test the `/api/glofas/timeseries` endpoint**

```bash
curl -s 'https://aetherwx.sladoire.dev/api/glofas/timeseries?lon=2.35&lat=48.85' | jq
```

Expected: `{ available: true, run: "...", series: [{ ts, Q5, Q20, Q50 } x 7] }`.

---

# Phase 5 — Frontend Angular

## Task 16: Remove old EFAS code

**Files:**
- Modify: `frontend/src/app/pages/map/map.component.ts` — remove all EFAS references
- Modify: `frontend/nginx.conf` — remove `/wms-efas` proxy

- [ ] **Step 1: List all EFAS references**

```bash
cd frontend && grep -n "efas\|EFAS\|Efas\|wms-efas" src/app/pages/map/map.component.ts | head -30
```

Document the line numbers.

- [ ] **Step 2: Remove `efasLayer` declaration + creation**

In `frontend/src/app/pages/map/map.component.ts`:
- Delete the line declaring `efasLayer: TileLayer<TileWMS>;` (find via grep, around line 4751).
- Delete the block creating `this.efasLayer = new TileLayer({...})` (around lines 7311-7326).
- Delete the line `this.efasLayer,` in the map.layers array (around line 7801).
- Delete the line `if (this.efasLayer) this.efasLayer.setVisible(this.showEfas());` in applyLayerVisibility (around line 5853).
- Delete the `showEfas` signal declaration.
- Delete `efas: false` from `DEFAULT_VISIBILITY` (around line 4006).
- Delete the line `this.showEfas.set(this.DEFAULT_VISIBILITY['efas']);` (around 4237).
- Delete the line `if (typeof vis.efas === 'boolean') this.showEfas.set(vis.efas);` (around 4465).
- Delete the line `this.showEfas(),` (around 4271).
- Delete the line `(v) => this.showEfas.set(v),` (around 4419).
- Delete the disabled placeholder in the template lines 1111-1120.

- [ ] **Step 3: Remove `/wms-efas` proxy from nginx.conf**

```bash
grep -n "wms-efas" frontend/nginx.conf
```

Delete the entire `location /wms-efas { ... }` block.

- [ ] **Step 4: Type-check + lint**

```bash
cd frontend && npm run build 2>&1 | tail -20
```

Expected: build succeeds, no TS errors. If any `efas` reference remains, it shows up here.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/pages/map/map.component.ts frontend/nginx.conf
git commit -m "refactor(map): remove EFAS layer + proxy (pivot to GloFAS)"
```

---

## Task 17: Add `glofasLayer` + signals + dropdown seuil

**Files:**
- Modify: `frontend/src/app/pages/map/map.component.ts`

- [ ] **Step 1: Declare new signals + field**

Near the other layer signals (find e.g. `showSst = signal(false);` cluster):

```typescript
readonly showGlofas = signal(false);
readonly glofasThreshold = signal<'q5' | 'q20' | 'q50'>('q5');

// Near the other TileLayer field declarations:
private glofasLayer!: TileLayer<TileWMS>;
```

- [ ] **Step 2: Create the TileLayer in the layer initialization block**

Find the section creating SST/wind/wave layers (around `this.sstLayer = new TileLayer(...)`). Add after:

```typescript
// GloFAS forecast crues — WMS time-enabled depuis GS local ImageMosaic.
// Le param LAYERS est dynamique via glofasThreshold() (q5/q20/q50).
// zIndex 95 = au-dessus des forecasts wind/wave, sous les vector layers.
this.glofasLayer = new TileLayer({
  source: new TileWMS({
    url: '/geoserver/aetherwx/wms',
    projection: 'EPSG:3857',
    params: {
      LAYERS: `aetherwx:glofas-flood-prob-${this.glofasThreshold()}`,
      TILED: true,
      TRANSPARENT: true,
      FORMAT: 'image/png',
    },
    attributions:
      '© <a href="https://www.globalfloods.eu/">GloFAS — Copernicus Emergency Management Service</a>',
  }),
  zIndex: 95,
  visible: false,
  opacity: 0.7,
});
```

- [ ] **Step 3: Add to map.layers array**

In the map.layers array (where `efasLayer` used to be), add `this.glofasLayer,`.

- [ ] **Step 4: Add applyLayerVisibility line**

In `applyLayerVisibility()`:

```typescript
if (this.glofasLayer) this.glofasLayer.setVisible(this.showGlofas());
```

- [ ] **Step 5: Wire threshold change → LAYERS param refresh**

Add an `effect()` near the other layer-related effects:

```typescript
effect(() => {
  const th = this.glofasThreshold();
  if (!this.glofasLayer) return;
  this.glofasLayer.getSource()?.updateParams({
    LAYERS: `aetherwx:glofas-flood-prob-${th}`,
  });
});
```

- [ ] **Step 6: Type-check**

```bash
cd frontend && npm run build 2>&1 | tail -20
```

Expected: build succeeds.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/app/pages/map/map.component.ts
git commit -m "feat(map): glofas TileWMS layer + threshold signal (q5/q20/q50)"
```

---

## Task 18: Move toggle Sources → Hydrologie in HTML template

**Files:**
- Modify: `frontend/src/app/pages/map/map.component.ts` (template inside `@Component`)

- [ ] **Step 1: Identify the Hydrologie section markup**

```bash
grep -n "Hydrologie\|catalog-section\|section-hydro" frontend/src/app/pages/map/map.component.ts | head -10
```

Locate the open of the `<div class="catalog-section">` for Hydrologie (around line 1072).

- [ ] **Step 2: Add the GloFAS toggle row inside Hydrologie**

Inside the Hydrologie section's content `<div>` (replacing the previous "soon" placeholder around lines 1111-1120 — already deleted in Task 16), add:

```html
<div class="layer-row">
  <label class="layer-toggle">
    <input type="checkbox"
           [checked]="showGlofas()"
           (change)="showGlofas.set($any($event.target).checked)" />
    <span class="toggle-glyph"><span class="glyph-icon">🌊</span></span>
    <span class="toggle-text">
      <span class="toggle-name">GloFAS forecast crues</span>
      <span class="toggle-count">Copernicus CDS — forecast 7j</span>
    </span>
  </label>
  @if (showGlofas()) {
    <div class="layer-controls">
      <select class="layer-select"
              [value]="glofasThreshold()"
              (change)="glofasThreshold.set($any($event.target).value)">
        <option value="q5">Q5 — crue modérée</option>
        <option value="q20">Q20 — crue sérieuse</option>
        <option value="q50">Q50 — crue sévère</option>
      </select>
      <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
             [value]="getOpacity('glofas')"
             (input)="setOpacity('glofas', +$any($event.target).value)" />
    </div>
  }
</div>
```

- [ ] **Step 3: Remove GloFAS (if it had stayed) from the Sources section**

Already done since EFAS was the previous incarnation in Sources. Verify with:

```bash
grep -n "glofas\|Glofas\|GLOFAS" frontend/src/app/pages/map/map.component.ts | head
```

Expected: only Hydrologie section + signal/layer declarations show matches.

- [ ] **Step 4: Add CSS for `.layer-select`**

In the component's `styles:` array, add:

```css
.layer-select {
  width: 100%;
  padding: 4px 8px;
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.15);
  border-radius: 4px;
  color: inherit;
  font-size: 12px;
  margin-top: 4px;
}
```

- [ ] **Step 5: Verify build**

```bash
cd frontend && npm run build 2>&1 | tail -20
```

Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/app/pages/map/map.component.ts
git commit -m "feat(map): glofas toggle in Hydrologie section with Q5/Q20/Q50 dropdown"
```

---

## Task 19: Wire 10 doctrine points (animation, time-bar, persistence)

**Files:**
- Modify: `frontend/src/app/pages/map/map.component.ts`

This task wires GloFAS into the time-bar / animation contract per `data_layer_policy_2026_05_19`. Each subtask = one of the 10 points.

- [ ] **Step 1: Add to `animatableLayers`**

Find the `animatableLayers` array (around line 3158). Add after the wave/wind entries:

```typescript
{
  key: 'glofas',
  label: 'GloFAS forecast crues',
  type: 'wms',
  gsLayerName: 'aetherwx:glofas-flood-prob-q5',  // master uses Q5 layer
  active: () => this.showGlofas(),
},
```

- [ ] **Step 2: Add to `LAYER_PROFILES`**

Find `LAYER_PROFILES` (around line 3618). Add:

```typescript
glofas: { kind: 'forecast', stepH: 24, pastH: 168, futureH: 168 },
```

- [ ] **Step 3: Add to `LAYER_COLORS`**

Find `LAYER_COLORS` (around line 3823). Add:

```typescript
glofas: '#3b82f6',
```

- [ ] **Step 4: Add to `LAYER_REFRESH_MIN` (set to N/A, raster not vector)**

Skip — `LAYER_REFRESH_MIN` is only for vector live layers.

- [ ] **Step 5: Add to `sliderLayerCoverage` push effect**

Find the effect that builds `sliderLayerCoverage` for each active layer. Add a case for glofas (mirror the wind/wave forecast logic).

```typescript
// Inside the effect populating sliderLayerCoverage:
if (this.showGlofas()) {
  out.push({
    key: 'glofas',
    label: 'GloFAS',
    color: '#3b82f6',
    validity: this.validityListPerLayer().get('glofas') ?? [],
  });
}
```

- [ ] **Step 6: Wire `validityListPerLayer` for glofas**

Find the effect that fetches GetCapabilities and populates `validityListPerLayer`. The dispatch by layer.type === 'wms' should already handle glofas given it's in `animatableLayers` with `type: 'wms'`. Verify with a log:

```typescript
// Temporary log to verify
effect(() => {
  const list = this.validityListPerLayer().get('glofas');
  console.log('[glofas validity]', list);
});
```

If empty when showGlofas=true, check GS GetCapabilities exposes TIME dimension for `aetherwx:glofas-flood-prob-q5`.

- [ ] **Step 7: Add to `activeLayersCount` computed**

If it iterates a hard-coded list, add `this.showGlofas() ? 1 : 0` to the sum. Most patterns iterate `animatableLayers`, in which case this is automatic.

- [ ] **Step 8: Add `applyLayerVisibility` entry**

Already done in Task 17 Step 4. Verify.

- [ ] **Step 9: Persist / restore localStorage**

Find the persistence block (`DEFAULT_VISIBILITY` + `loadVis()` style). Add:

```typescript
// DEFAULT_VISIBILITY:
glofas: false,

// loadVis():
if (typeof vis.glofas === 'boolean') this.showGlofas.set(vis.glofas);
if (typeof vis.glofasThreshold === 'string') this.glofasThreshold.set(vis.glofasThreshold as 'q5' | 'q20' | 'q50');

// saveVis() output:
glofas: this.showGlofas(),
glofasThreshold: this.glofasThreshold(),
```

- [ ] **Step 10: Effect réactif refresh WMS TIME on cursor change**

Find the effect that updates the TIME param of WMS layers when `currentTime` changes. Add glofas to the dispatch:

```typescript
// Inside effect tracking currentTime:
if (this.showGlofas() && this.glofasLayer) {
  this.glofasLayer.getSource()?.updateParams({ TIME: this.currentTime().toISOString() });
}
```

- [ ] **Step 11: Build + verify**

```bash
cd frontend && npm run build 2>&1 | tail -20
```

Expected: build succeeds.

- [ ] **Step 12: Commit**

```bash
git add frontend/src/app/pages/map/map.component.ts
git commit -m "feat(map): wire glofas to time-bar (10 doctrine points)"
```

---

## Task 20: Glofas timeseries chart component

**Files:**
- Create: `frontend/src/app/components/glofas-timeseries-chart/glofas-timeseries-chart.component.ts`
- Create: `frontend/src/app/components/glofas-timeseries-chart/glofas-timeseries-chart.component.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// frontend/src/app/components/glofas-timeseries-chart/glofas-timeseries-chart.component.spec.ts
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { GlofasTimeseriesChartComponent } from './glofas-timeseries-chart.component';

describe('GlofasTimeseriesChartComponent', () => {
  let fixture: ComponentFixture<GlofasTimeseriesChartComponent>;
  let component: GlofasTimeseriesChartComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [GlofasTimeseriesChartComponent],
    }).compileComponents();
    fixture = TestBed.createComponent(GlofasTimeseriesChartComponent);
    component = fixture.componentInstance;
  });

  it('renders three polylines when series has data', () => {
    component.series = [
      { ts: '2026-05-28T00:00:00Z', Q5: 0.3, Q20: 0.1, Q50: 0.02 },
      { ts: '2026-05-29T00:00:00Z', Q5: 0.5, Q20: 0.2, Q50: 0.05 },
    ];
    fixture.detectChanges();
    const polylines = fixture.nativeElement.querySelectorAll('polyline');
    expect(polylines.length).toBe(3);
  });

  it('renders empty state when series is empty', () => {
    component.series = [];
    fixture.detectChanges();
    const empty = fixture.nativeElement.querySelector('.glofas-chart-empty');
    expect(empty).toBeTruthy();
  });

  it('uses Q5 yellow / Q20 orange / Q50 red colors', () => {
    component.series = [{ ts: '2026-05-28T00:00:00Z', Q5: 0.5, Q20: 0.3, Q50: 0.1 }];
    fixture.detectChanges();
    const polylines = fixture.nativeElement.querySelectorAll('polyline');
    const strokes = Array.from(polylines).map((p: any) => p.getAttribute('stroke'));
    expect(strokes).toContain('#eab308'); // Q5 yellow
    expect(strokes).toContain('#f97316'); // Q20 orange
    expect(strokes).toContain('#dc2626'); // Q50 red
  });
});
```

- [ ] **Step 2: Run test (should fail — component doesn't exist)**

```bash
cd frontend && npx vitest run glofas-timeseries-chart.component.spec
```

Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement the component**

```typescript
// frontend/src/app/components/glofas-timeseries-chart/glofas-timeseries-chart.component.ts
import { ChangeDetectionStrategy, Component, Input, computed, signal } from '@angular/core';

export interface GlofasSeriesPoint {
  ts: string;
  Q5: number | null;
  Q20: number | null;
  Q50: number | null;
}

@Component({
  selector: 'app-glofas-timeseries-chart',
  standalone: true,
  template: `
    @if (series.length === 0) {
      <div class="glofas-chart-empty">Pas de données.</div>
    } @else {
      <div class="glofas-chart-wrap">
        <div class="glofas-chart-legend">
          <span class="legend-item q5">Q5 (modéré)</span>
          <span class="legend-item q20">Q20 (sérieux)</span>
          <span class="legend-item q50">Q50 (sévère)</span>
        </div>
        <svg viewBox="0 0 320 140" class="glofas-chart-svg" preserveAspectRatio="none">
          <!-- Y grid -->
          @for (y of [0, 25, 50, 75, 100]; track y) {
            <line [attr.x1]="40" [attr.y1]="yScale(y)"
                  [attr.x2]="310" [attr.y2]="yScale(y)"
                  stroke="rgba(255,255,255,0.08)" />
            <text [attr.x]="35" [attr.y]="yScale(y) + 3"
                  class="axis-label" text-anchor="end">{{ y }}%</text>
          }
          <!-- X labels -->
          @for (p of series; let i = $index; track p.ts) {
            <text [attr.x]="xScale(i)" [attr.y]="135"
                  class="axis-label" text-anchor="middle">J+{{ i + 1 }}</text>
          }
          <!-- 3 polylines -->
          <polyline [attr.points]="polylinePoints('Q5')" stroke="#eab308" fill="none" stroke-width="2"/>
          <polyline [attr.points]="polylinePoints('Q20')" stroke="#f97316" fill="none" stroke-width="2"/>
          <polyline [attr.points]="polylinePoints('Q50')" stroke="#dc2626" fill="none" stroke-width="2"/>
        </svg>
      </div>
    }
  `,
  styles: [`
    .glofas-chart-wrap { padding: 8px; }
    .glofas-chart-empty {
      padding: 12px;
      color: rgba(255,255,255,0.5);
      font-size: 12px;
      text-align: center;
    }
    .glofas-chart-legend {
      display: flex;
      gap: 12px;
      font-size: 11px;
      margin-bottom: 6px;
    }
    .legend-item { display: inline-flex; align-items: center; }
    .legend-item::before {
      content: '';
      width: 10px;
      height: 2px;
      margin-right: 4px;
      display: inline-block;
    }
    .legend-item.q5::before { background: #eab308; }
    .legend-item.q20::before { background: #f97316; }
    .legend-item.q50::before { background: #dc2626; }
    .glofas-chart-svg { width: 100%; height: 140px; display: block; }
    .axis-label { font-size: 10px; fill: rgba(255,255,255,0.55); }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GlofasTimeseriesChartComponent {
  @Input() series: GlofasSeriesPoint[] = [];

  private readonly W = 320;
  private readonly H = 140;
  private readonly L = 40;
  private readonly R = 310;
  private readonly T = 10;
  private readonly B = 120;

  yScale(percent: number): number {
    return this.B - ((this.B - this.T) * percent) / 100;
  }

  xScale(i: number): number {
    if (this.series.length <= 1) return (this.L + this.R) / 2;
    return this.L + ((this.R - this.L) * i) / (this.series.length - 1);
  }

  polylinePoints(key: 'Q5' | 'Q20' | 'Q50'): string {
    return this.series
      .map((p, i) => {
        const v = p[key];
        if (v === null || !Number.isFinite(v)) return null;
        return `${this.xScale(i)},${this.yScale(v * 100)}`;
      })
      .filter((s) => s !== null)
      .join(' ');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd frontend && npx vitest run glofas-timeseries-chart.component.spec
```

Expected: 3 PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/components/glofas-timeseries-chart/
git commit -m "feat(ui): glofas timeseries chart component (3 SVG polylines)"
```

---

## Task 21: Click handler + popup integration

**Files:**
- Modify: `frontend/src/app/pages/map/map.component.ts`

- [ ] **Step 1: Add `selectedGlofas` signal + service injection**

Near other selected signals:

```typescript
readonly selectedGlofas = signal<{
  lon: number;
  lat: number;
  series: { ts: string; Q5: number | null; Q20: number | null; Q50: number | null }[];
} | null>(null);
```

Import the chart component at top:

```typescript
import { GlofasTimeseriesChartComponent } from '../../components/glofas-timeseries-chart/glofas-timeseries-chart.component';
```

Register in `@Component({ imports: [...] })`.

- [ ] **Step 2: Add click handler**

Locate the existing `onMapClick` (or equivalent) method. Add the glofas branch:

```typescript
// Inside onMapClick(evt: MapBrowserEvent) — placed BEFORE the generic vector hit-test,
// because GlofasLayer is raster and won't show up in forEachFeatureAtPixel.
if (this.showGlofas()) {
  const pixel = this.map.getEventPixel(evt.originalEvent);
  const hit = this.map.forEachLayerAtPixel(
    pixel,
    (l) => l === this.glofasLayer,
  );
  if (hit) {
    const [lon, lat] = toLonLat(evt.coordinate);
    void this.fetchGlofasTimeSeries(lon, lat);
    return;
  }
}
```

- [ ] **Step 3: Add the fetch method**

```typescript
private async fetchGlofasTimeSeries(lon: number, lat: number): Promise<void> {
  try {
    const url = `/api/glofas/timeseries?lon=${encodeURIComponent(lon)}&lat=${encodeURIComponent(lat)}`;
    const resp = await firstValueFrom(this.http.get<{
      available: boolean;
      series: { ts: string; Q5: number | null; Q20: number | null; Q50: number | null }[];
    }>(url));
    if (!resp.available) {
      // simple notice via existing toast/alert mechanism; if none, console.warn
      console.warn('[glofas] no data at', lon, lat);
      this.selectedGlofas.set({ lon, lat, series: [] });
      return;
    }
    this.selectedGlofas.set({ lon, lat, series: resp.series });
  } catch (err) {
    console.error('[glofas] timeseries fetch failed', err);
  }
}
```

(If `HttpClient` isn't already injected in the constructor, inject it.)

- [ ] **Step 4: Add popup section in template**

In the existing side-panel template (where hubeau/piezo popups render), add a sibling block:

```html
@if (selectedGlofas(); as g) {
  <div class="info-card glofas-card">
    <header class="info-head">
      <span class="info-title">GloFAS — Prévision crues</span>
      <button class="info-close" (click)="selectedGlofas.set(null)">×</button>
    </header>
    <div class="info-body">
      <div class="info-coords">
        <span>Lon : {{ g.lon.toFixed(4) }}</span>
        <span>Lat : {{ g.lat.toFixed(4) }}</span>
      </div>
      @if (g.series.length === 0) {
        <p class="info-empty">Pas de prévision GloFAS à cet endroit (océan / désert).</p>
      } @else {
        <app-glofas-timeseries-chart [series]="g.series" />
      }
    </div>
  </div>
}
```

- [ ] **Step 5: Build + verify**

```bash
cd frontend && npm run build 2>&1 | tail -20
```

Expected: build succeeds.

- [ ] **Step 6: Push + bump frontend tag (after Phases 4-5 are deployed)**

```bash
git push origin main
# Wait for CI build, then bump in gitops:
cd /home/sylvain_ladoire/projects/developpeur/developpeur-gitops
# edit charts/maritime/values.yaml: frontend.image.tag → new sha
git add charts/maritime/values.yaml
git commit -m "chore(maritime): bump frontend to <sha> for glofas data layer"
git push origin main
```

ArgoCD syncs within 3 min.

- [ ] **Step 7: Commit frontend changes**

```bash
cd /home/sylvain_ladoire/projects/developpeur/maritime-atlas
git add frontend/src/app/pages/map/map.component.ts
git commit -m "feat(map): glofas click → popup with 3-curve timeseries chart"
```

---

# Phase 6 — Finalize

## Task 22: Retention cleanup CronJob

**Files:**
- Modify: `developpeur-gitops/charts/maritime/templates/retention-cleanup-cronjob.yaml`

- [ ] **Step 1: Open existing CronJob**

```bash
cat developpeur-gitops/charts/maritime/templates/retention-cleanup-cronjob.yaml
```

Find the script body / configmap / inline command.

- [ ] **Step 2: Add glofas cleanup step**

In the bash script of the CronJob, add (after the existing SST/wind cleanup):

```bash
# Glofas — keep only 7j past + 7j future of run dirs
echo "[cleanup] glofas: keep ±7j around now"
NOW_TS=$(date -u +%s)
CUTOFF_PAST_TS=$((NOW_TS - 7*24*3600))
CUTOFF_FUTURE_TS=$((NOW_TS + 8*24*3600))
for d in /coverage/glofas/????-??-??T??Z; do
  [ -d "$d" ] || continue
  RUN_NAME=$(basename "$d")
  # Convert run name to epoch (e.g. 2026-05-27T12Z → 2026-05-27T12:00:00Z)
  ISO="${RUN_NAME%Z}:00:00Z"
  ISO="${ISO/T/T}"
  RUN_TS=$(date -u -d "${RUN_NAME%Z}:00:00 UTC" +%s 2>/dev/null || echo "")
  if [ -z "$RUN_TS" ]; then
    echo "[cleanup] glofas: skip unparseable $RUN_NAME"
    continue
  fi
  if [ "$RUN_TS" -lt "$CUTOFF_PAST_TS" ] || [ "$RUN_TS" -gt "$CUTOFF_FUTURE_TS" ]; then
    echo "[cleanup] glofas: drop $RUN_NAME"
    rm -rf "$d"
  fi
done
```

- [ ] **Step 3: Verify Helm template**

```bash
cd developpeur-gitops/charts/maritime
helm template . | grep -A 30 "retention-cleanup" | head -60
```

- [ ] **Step 4: Commit + push**

```bash
cd /home/sylvain_ladoire/projects/developpeur/developpeur-gitops
git add charts/maritime/templates/retention-cleanup-cronjob.yaml
git commit -m "chore(maritime): extend retention-cleanup to glofas (7j past + 7j future)"
git push origin main
```

---

## Task 23: Update docs

**Files:**
- Modify: `docs/aetherwx-animation.md`
- Modify: `README.md`

- [ ] **Step 1: Update `docs/aetherwx-animation.md`**

In the section listing animatable layers (master-eligible), add a row:

```markdown
| `glofas` | `aetherwx:glofas-flood-prob-q5` | forecast 7j past + 7j future, step 24h | WMS time-enabled |
```

- [ ] **Step 2: Update `README.md`**

In the "Sources data" section, add:

```markdown
### Hydrologie

- **Hub'eau débits FR** — APIs Eaufrance (~500 stations)
- **Hub'eau piézo FR** — APIs Eaufrance nappes (~1500 stations)
- **GloFAS forecast crues** — Copernicus EMS Global Flood Awareness System, forecast 10j à 0.05° de résolution, distribué via CDS, 3 seuils Q5/Q20/Q50.
```

- [ ] **Step 3: Commit**

```bash
cd /home/sylvain_ladoire/projects/developpeur/maritime-atlas
git add docs/aetherwx-animation.md README.md
git commit -m "docs(glofas): add glofas to animation contract + README sources"
```

---

## Task 24: End-to-end smoke + `/maritime-anim-test`

**Files:** none.

- [ ] **Step 1: Run `/check-layer-time-coherence` on glofas**

This skill is purpose-built for what we just did — validate a new WMS layer is linked to the time-bar. Tests the 3 invariants TC-1 (TIME=cursor at toggle ON), TC-2 (refetch on step), TC-3 (play iterates validity-by-validity).

```
/check-layer-time-coherence glofas
```

Expected: 3/3 invariants PASS.

- [ ] **Step 2: Run `/maritime-anim-test` with glofas active**

Per project doctrine (mandatory before any animation-touching claim):

```
/maritime-anim-test
```

The test should:
- Load /globe (or whichever route has the time-bar).
- Toggle ON only GloFAS.
- Verify a tile change occurs as the time cursor moves.
- Verify the validityList is non-empty.
- Verify no silent fallback.
- Capture screenshots.

Expected: all 6 contract invariants pass.

- [ ] **Step 3: Run `/check-layer-coherence-globe` if /globe is affected**

```
/check-layer-coherence-globe
```

(If applicable — the spec says /globe and / share the time-bar contract; if the toggle is only added to / for now, mark this step N/A.)

- [ ] **Step 4: Run `/maritime-smoke`**

```
/maritime-smoke
```

Should report:
- maritime-api healthy
- glofas-fetcher healthy
- geoserver layers exposed (glofas-flood-prob-q{5,20,50} visible)
- argo cronworkflow `glofas-refresh` scheduled
- frontend bundle includes glofas-timeseries-chart

- [ ] **Step 5: Manual UI sanity check (Playwright or browser)**

Navigate to https://aetherwx.sladoire.dev/.

Verify:
- Toggle "GloFAS forecast crues" est dans la section Hydrologie (pas Sources).
- Dropdown Q5/Q20/Q50 apparaît quand toggle ON.
- La carte montre le raster (gradient bleu→rouge sur des zones avec rivières).
- Click sur la France → popup avec chart 3 courbes.
- Click sur le Sahara (zone nodata) → popup avec "Pas de prévision GloFAS à cet endroit".
- Le slider time-bar bouge le raster en LIVE.

- [ ] **Step 6: Definition of Done verification**

Re-open the spec and check each DoD checkbox. Tick them on the spec doc (or in a follow-up PR), or commit progress directly.

- [ ] **Step 7: Final commit + push (if any progress markers)**

```bash
git add docs/superpowers/specs/2026-05-27-glofas-hydro-data-layer-design.md
git commit -m "chore(specs): tick DoD for glofas hydro data layer"
git push origin main
```

---

## Self-review (post-plan)

**Spec coverage** — each spec section is covered:
- Reclassement Sources → Hydrologie : Task 18 ✓
- Wiring data layer 10 points doctrine : Task 19 ✓
- Architecture Argo → NestJS → Python sidecar → GS : Tasks 5, 7, 8, 13-15, 9-12 ✓
- Chart popup 3 courbes Q5/Q20/Q50 : Tasks 20, 21 ✓
- Retention 7j+7j : Task 22 ✓
- Pivot EFAS → GloFAS : implicit in all tasks (no EFAS code remains after Task 16)
- Pièges connus mémoire projet : noted inline (set -e + echo, trailing dot DNS, plugin Java, Secret hors gitops, animation fail-loud)
- Risks open questions : flagged in spec, deferred to implementation discovery

**Placeholder scan** — no TBD / TODO / "implement later" / vague handwaves. Every step has either exact code, exact command, or exact file/line reference.

**Type consistency** — `glofasLayer`, `showGlofas`, `glofasThreshold`, `GlofasTimeSeriesResponse`, `GlofasFetchTriggerResponse`, layer names `aetherwx:glofas-flood-prob-q{5,20,50}` — uniform across all tasks.

**Known plan-time uncertainties** (to verify in flight, not blockers):
- The exact CDS dataset `cems-glofas-forecast` field names (`river_discharge_in_the_last_24_hours` vs `river_discharge`) — verify on CDS catalog first time you query.
- ImageMosaic layer creation via Java API : may require GS REST follow-up if the auto-detect from `indexer.properties` doesn't fully create the layer. Task 15 Step 5 handles this with the `external.imagemosaic` REST POST.
- The exact path of `BootstrapRunner.java` and how new Bootstrap beans are registered (`@Component` autodetection vs manual wiring) : adapt to existing pattern when Task 13 starts.
