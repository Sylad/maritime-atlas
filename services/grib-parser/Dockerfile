# Sidecar Python qui parse GRIB/NetCDF pour le runner orchestrator (Node).
# Image GDAL avec outils scientifiques pré-installés (identique au pattern
# weather-fetcher / sst-fetcher pour cohérence).
FROM ghcr.io/osgeo/gdal:ubuntu-small-3.10.1

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3-pip python3-venv curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh

WORKDIR /app

COPY pyproject.toml ./
RUN uv pip install --system --break-system-packages \
    "fastapi>=0.115" "uvicorn[standard]>=0.32" "pydantic>=2.9" \
    "xarray>=2024.10.0" "rioxarray>=0.18.0" "cfgrib>=0.9.14" \
    "eccodes>=2.38.0" "netcdf4>=1.7.1" "numpy>=2.0.0" "requests>=2.32.0"

COPY src ./src

EXPOSE 8500

CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8500"]
