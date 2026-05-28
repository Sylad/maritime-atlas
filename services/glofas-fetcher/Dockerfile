# services/glofas-fetcher/Dockerfile
# Sidecar léger : télécharge le GloFAS forecast GRIB2 depuis EWDS et le dépose
# dans le coverage dir. PAS de conversion (GeoServer lit le GRIB nativement via
# le plugin NetCDF/GRIB) → pas besoin de GDAL/rasterio/xarray.
FROM python:3.12-slim-bookworm AS base

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/

EXPOSE 8080
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--no-access-log"]
