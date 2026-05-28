# services/glofas-fetcher/Dockerfile
# Télécharge le GloFAS forecast GRIB2 depuis EWDS et le convertit en GeoTIFF
# par validité (1 fichier par leadtime) via rasterio/GDAL. GDAL lit le GRIB
# PDT 4.73 que le reader NetCDF-Java de GeoServer ne décode pas → on sert via
# ImageMosaic de GeoTIFFs (pattern sst/weather-fetcher). D'où le besoin GDAL.
FROM python:3.12-slim-bookworm AS base

# rasterio a besoin des libs GDAL natives
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgdal-dev \
    gdal-bin \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/

EXPOSE 8080
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--no-access-log"]

# 2026-05-28 build trigger: A2 GRIB pivot (eb06b11) jamais buildé car push groupé
