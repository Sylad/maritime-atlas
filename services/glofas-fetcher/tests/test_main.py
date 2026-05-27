from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.main import app


def test_healthz():
    client = TestClient(app)
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


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
