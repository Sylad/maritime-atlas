# candhis-fetcher — bouées houlographes CEREMA
#
# Image légère : pas besoin de GDAL/xarray comme weather-fetcher, juste
# requests + psycopg + apscheduler. Le seed des bouées passe par un
# GeoPackage SQLite parsé via stdlib sqlite3 (pas de fiona/geopandas).
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY pyproject.toml ./
RUN pip install --no-cache-dir \
    "requests>=2.32.0" \
    "psycopg[binary]>=3.2.0" \
    "apscheduler>=3.10.4"

COPY src ./src

CMD ["python", "src/main.py"]
