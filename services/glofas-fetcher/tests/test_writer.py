from app.writer import ensure_mosaic_config


def test_ensure_mosaic_config_writes_files(tmp_path):
    ensure_mosaic_config(tmp_path)
    indexer = tmp_path / "indexer.properties"
    timeregex = tmp_path / "timeregex.properties"
    assert indexer.exists()
    assert timeregex.exists()
    assert "TimestampFileNameExtractorSPI" in indexer.read_text()
    assert "yyyyMMdd'T'HHmmss'Z'" in timeregex.read_text()


def test_ensure_mosaic_config_idempotent(tmp_path):
    ensure_mosaic_config(tmp_path)
    ensure_mosaic_config(tmp_path)
    assert (tmp_path / "indexer.properties").exists()
