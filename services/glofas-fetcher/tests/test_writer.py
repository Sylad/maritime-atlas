from app.writer import grib_target_path


def test_grib_target_path_layout(tmp_path):
    p = grib_target_path(tmp_path, "2026-05-28T00:00:00Z")
    assert p.parent == tmp_path
    assert p.name == "glofas-2026-05-28T00Z.grib2"
    assert p.parent.exists()


def test_grib_target_path_idempotent(tmp_path):
    p1 = grib_target_path(tmp_path, "2026-05-28T00:00:00Z")
    p2 = grib_target_path(tmp_path, "2026-05-28T00:00:00Z")
    assert p1 == p2
