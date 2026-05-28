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
@patch("app.main.grib_to_geotiffs")
def test_fetch_endpoint_downloads_and_converts(mock_convert, mock_cds_cls, tmp_path, monkeypatch):
    """POST /fetch : download GRIB → convert en GeoTIFF par validité → coverage dir."""
    monkeypatch.setenv("COVERAGE_BASE_DIR", str(tmp_path))

    # Mock CDS : écrit un faux GRIB dans target
    mock_cds = mock_cds_cls.return_value
    mock_cds.retrieve.side_effect = lambda req, target: Path(target).write_bytes(b"GRIB\x00")
    # Mock convert : retourne 7 chemins synthétiques (1 par leadtime)
    mock_convert.side_effect = lambda src, out_dir, run_time, leadtimes: [
        out_dir / f"discharge_{lh:03d}.tif" for lh in leadtimes
    ]

    client = TestClient(app)
    payload = {"run_time": "2026-05-27T00:00:00Z", "leadtimes": [24, 48, 72, 96, 120, 144, 168]}
    response = client.post("/fetch", json=payload)

    assert response.status_code == 200
    body = response.json()
    assert body["run"] == "2026-05-27T00Z"
    assert body["written"] == 7
    mock_cds.retrieve.assert_called_once()
    mock_convert.assert_called_once()
    # indexer.properties + timeregex écrits dans le coverage dir
    assert (tmp_path / "indexer.properties").exists()
    assert (tmp_path / "timeregex.properties").exists()


@patch("app.main.GlofasCdsClient")
@patch("app.main.grib_to_geotiffs")
def test_fetch_defaults_run_time_to_yesterday(mock_convert, mock_cds_cls, tmp_path, monkeypatch):
    """Sans run_time, le sidecar utilise hier (run du jour pas publié EWDS)."""
    monkeypatch.setenv("COVERAGE_BASE_DIR", str(tmp_path))
    mock_cds_cls.return_value.retrieve.side_effect = lambda req, target: Path(target).write_bytes(b"GRIB")
    mock_convert.side_effect = lambda src, out_dir, run_time, leadtimes: []

    client = TestClient(app)
    response = client.post("/fetch", json={})  # ni run_time ni leadtimes
    assert response.status_code == 200
    # run = hier, format compact
    from datetime import datetime, timedelta, timezone
    expected = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%dT00Z")
    assert response.json()["run"] == expected
