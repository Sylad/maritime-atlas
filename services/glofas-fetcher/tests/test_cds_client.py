from unittest.mock import MagicMock, patch

from app.cds_client import GlofasCdsClient, GlofasFetchRequest


def test_fetch_request_builds_control_forecast_grib_payload():
    """Vérifie que le payload matche le schéma EWDS cems-glofas-forecast."""
    req = GlofasFetchRequest(
        run_time="2026-05-28T00:00:00Z",
        leadtimes=[24, 48, 72, 96, 120, 144, 168],
    )
    payload = req.to_cdsapi_payload()
    assert payload["product_type"] == ["control_forecast"]
    assert payload["variable"] == "river_discharge_in_the_last_24_hours"
    assert payload["system_version"] == ["operational"]
    assert payload["hydrological_model"] == ["lisflood"]
    assert payload["year"] == ["2026"]
    assert payload["month"] == ["05"]
    assert payload["day"] == ["28"]
    assert payload["leadtime_hour"] == ["24", "48", "72", "96", "120", "144", "168"]
    assert payload["data_format"] == "grib2"
    assert payload["download_format"] == "unarchived"


@patch("app.cds_client.cdsapi.Client")
def test_client_retrieves_and_writes_target(mock_cdsapi_client):
    """Le client appelle cdsapi.retrieve avec dataset + payload + target."""
    mock_instance = MagicMock()
    mock_cdsapi_client.return_value = mock_instance

    client = GlofasCdsClient()
    req = GlofasFetchRequest(run_time="2026-05-28T00:00:00Z", leadtimes=[24])
    client.retrieve(req, target="/tmp/test.grib2")

    mock_instance.retrieve.assert_called_once()
    args, _ = mock_instance.retrieve.call_args
    assert args[0] == "cems-glofas-forecast"
    assert args[2] == "/tmp/test.grib2"
