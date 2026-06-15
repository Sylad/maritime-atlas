from __future__ import annotations

from pathlib import Path

# Config ImageMosaic GeoServer (pattern sst/weather-fetcher) : le timeregex
# extrait la validité du nom de fichier discharge_<YYYYMMDDTHHMMSSZ>.tif.
INDEXER_PROPERTIES = """\
TimeAttribute=time
Schema=*the_geom:Polygon,location:String,time:java.util.Date
PropertyCollectors=TimestampFileNameExtractorSPI[timeregex](time)
Caching=false
LooseBBox=true
Heterogeneous=false
SuggestedFormat=org.geotools.gce.geotiff.GeoTiffFormat
SuggestedSPI=it.geosolutions.imageioimpl.plugins.tiff.TIFFImageReaderSpi
"""

TIMEREGEX_PROPERTIES = """\
regex=[0-9]{8}T[0-9]{6}Z,format=yyyyMMdd'T'HHmmss'Z'
"""


def ensure_mosaic_config(coverage_dir: Path) -> None:
    """Écrit indexer.properties + timeregex.properties dans le dossier coverage
    (idempotent) pour que GeoServer active la dimension TIME sur l'ImageMosaic."""
    coverage_dir.mkdir(parents=True, exist_ok=True)
    (coverage_dir / "indexer.properties").write_text(INDEXER_PROPERTIES)
    (coverage_dir / "timeregex.properties").write_text(TIMEREGEX_PROPERTIES)
