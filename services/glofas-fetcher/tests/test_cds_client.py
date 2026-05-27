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
