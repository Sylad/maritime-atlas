# buoy-fetcher — référentiel des plateformes marines EMODnet Physics.
#
# Image légère : pas besoin de GDAL/xarray comme weather-fetcher, juste
# requests + psycopg + apscheduler. Le seed des bouées vient maintenant
# d'un WFS GeoServer EMODnet (réponse JSON), donc on n'a même plus besoin
# de sqlite3 pour parser un GeoPackage.
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
