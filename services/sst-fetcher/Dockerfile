# Pour les libs scientifiques (xarray + GDAL via rioxarray), l'image
# osgeo/gdal a déjà tout préinstallé et économise ~10 min de build.
FROM ghcr.io/osgeo/gdal:ubuntu-small-3.10.1

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3-pip python3-venv curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install uv (fast Python package manager — pattern moderne)
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh

WORKDIR /app

COPY pyproject.toml ./
RUN uv pip install --system --break-system-packages \
    "xarray>=2024.10.0" "rioxarray>=0.18.0" "netcdf4>=1.7.0" \
    "requests>=2.32.0" "apscheduler>=3.10.4" "pika>=1.3.2"

COPY src ./src

CMD ["python3", "src/main.py"]
