# Image GDAL avec outils scientifiques pré-installés. Identique à
# weather-fetcher (factorisable plus tard si on multiplie les services).
FROM ghcr.io/osgeo/gdal:ubuntu-small-3.10.1

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3-pip python3-venv curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh

WORKDIR /app

COPY pyproject.toml ./
# cfgrib + eccodes : nécessaires pour décoder les GRIB2 AROME (Météo-France).
# numpy pour calcul wind_speed = sqrt(u² + v²).
RUN uv pip install --system --break-system-packages \
    "xarray>=2024.10.0" "rioxarray>=0.18.0" "cfgrib>=0.9.14" "eccodes>=2.38.0" \
    "numpy>=2.0.0" "requests>=2.32.0" "apscheduler>=3.10.4" "pika>=1.3.2"

COPY src ./src

CMD ["python3", "src/main.py"]
