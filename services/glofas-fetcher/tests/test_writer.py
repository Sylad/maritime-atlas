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
