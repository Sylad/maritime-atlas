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
def test_fetch_endpoint_downloads_grib(mock_cds_cls, tmp_path, monkeypatch):
    """POST /fetch télécharge le GRIB et le dépose dans le coverage dir."""
    monkeypatch.setenv("COVERAGE_BASE_DIR", str(tmp_path))

    # Mock le client CDS : écrit un faux GRIB de 1234 octets dans target
    mock_cds = mock_cds_cls.return_value
    mock_cds.retrieve.side_effect = lambda req, target: Path(target).write_bytes(b"\x00" * 1234)

    client = TestClient(app)
    payload = {"run_time": "2026-05-28T00:00:00Z", "leadtimes": [24, 48, 72, 96, 120, 144, 168]}
    response = client.post("/fetch", json=payload)

    assert response.status_code == 200
    body = response.json()
    assert body["run"] == "2026-05-28T00Z"
    assert body["bytes"] == 1234
    mock_cds.retrieve.assert_called_once()
    # Le GRIB a été déposé au bon endroit
    assert (tmp_path / "glofas-2026-05-28T00Z.grib2").exists()
