# Maritime Atlas

Atlas live du trafic maritime — Bretagne + golfe de Gascogne nord.

Suivi temps réel des navires (AIS), température de surface de la mer (SST),
zones marines protégées, courants océaniques. Architecture microservices
avec ingestion multi-source, RabbitMQ comme glue, GeoServer (replicas
Docker Swarm à terme) pour servir les layers, Angular + OpenLayers
pour la viz.

## Architecture

```
[aisstream.io WS] ──► [ais-ingester] ──► [RabbitMQ ais.raw]
                                              │
                                              ▼
                                     [ais-decoder × N]
                                              │
                                  ┌───────────┼───────────┐
                                  ▼           ▼           ▼
                            [PostGIS]   [ais.positions] [vessels UPSERT]
                                  │           │
                                  ▼           ▼
                          [GeoServer WFS] [density-aggregator] (sprint 5)
                                  │
                                  ▼
                          [Angular + OL UI] (sprint 1.5)
```

## Stack

- **PostgreSQL 16 + PostGIS 3.4 + TimescaleDB** : `vessel_positions` hypertable, ~4M lignes/jour bbox Bretagne.
- **RabbitMQ 3.13** : exchange `ais.raw` (direct), `ais.positions` (topic), futurs `raster.ready`, `alerts`, `geoserver.sync`.
- **GeoServer 2.27** : WFS layer `v_vessels_live` (rafraîchi 30s). Mosaic stores raster timeseries au sprint 4+.
- **NestJS 11** : services `ais-ingester` (WebSocket producer), `ais-decoder` (consumer + writer PostGIS).
- **Angular 19 + OpenLayers 10** : UI map (sprint 1.5).

## Démarrer

### 1. Prérequis

- Docker + Docker Compose
- Une API key gratuite sur [aisstream.io](https://aisstream.io) (créer un compte → settings → générer la key)

### 2. Configuration

```bash
cp .env.example .env
# Édite .env, remplace AISSTREAM_API_KEY par ta vraie clé
```

### 3. Boot

```bash
docker compose up -d --build

# Vérifier que tout est sain :
docker compose ps
docker compose logs -f ais-ingester ais-decoder
```

### 4. Smoke tests

```bash
# Postgres : devrait afficher des MMSI au bout de quelques secondes
docker compose exec postgres psql -U maritime -d maritime -c \
  "SELECT count(*) FROM vessel_positions WHERE ts > now() - interval '1 minute';"

# RabbitMQ Management UI : http://localhost:15672 (maritime / maritime)
# → Exchanges : ais.raw doit recevoir des messages

# GeoServer : http://localhost:8080/geoserver (admin / geoserver)
```

### 5. Configurer le layer GeoServer

Une fois que `vessel_positions` se remplit :

1. Ouvre http://localhost:8080/geoserver
2. **Stores** → **Add new Store** → **PostGIS** :
   - Workspace : `maritime`
   - Data Source Name : `maritime-pg`
   - host=`postgres`, port=`5432`, database=`maritime`, schema=`public`
   - user=`maritime`, password=`maritime`
3. **Save**
4. Pour la **vue** `v_vessels_live` : Layers → Add new layer → choisis le store → publish `v_vessels_live` (geom column = `geom`, SRID=4326).
5. **Layer Preview** → OpenLayers preview → tu vois les bateaux !

## Sprint plan

| Sprint | Livrable | Focus |
|---|---|---|
| **1** ⏳ | AIS → PostGIS → GeoServer WFS layer | Pipeline producer/consumer/storage |
| **1.5** | Angular + OL UI : map + WFS layer + popup | Front MVP |
| **2** | Track builder (vessel_tracks_daily) + time slider OL | Aggregation + temporel |
| **3** | SST raster (NOAA OISST quotidien) → mosaic store | Premier raster timeseries |
| **4** | Aires marines protégées (WDPA) + alert engine | Polygons + rule engine |
| **5** | Density heatmap raster (aggregated AIS) | GeoTIFF généré dynamiquement |
| **6** | Replicas GeoServer Docker Swarm + sync RabbitMQ | Pattern préféré : `geoserver.sync` fanout |
| **7** | Currents Copernicus (NetCDF→GeoTIFF flow vectors) | Conversion raster + flow viz OL |
| **8** | Détections comportements (vessel turns off AIS, anchor anormale) | Rule engine étendu |
| **9** | Ports + arrivées/départs (port-call detection) | Événement géo + dashboard |

## Sources de données

| Donnée | Source | Format | Fréquence | Sprint |
|---|---|---|---|---|
| Positions AIS | aisstream.io | JSON WS | seconde | 1 |
| Détails navires | OpenSky / aisstream `ShipStaticData` | JSON WS | event | 1 |
| Aires marines protégées | WDPA (UNEP-WCMC) | shapefile | snapshot | 4 |
| SST | NOAA OISST sur AWS | GeoTIFF | quotidien | 3 |
| Density pêche | Global Fishing Watch (CC-BY-NC) | GeoTIFF | mensuel | 5 |
| Courants | Copernicus Marine | NetCDF | 6h | 7 |

## Bbox

```
Bretagne + golfe de Gascogne nord
SW: (46.0°N, -6.5°W)   NE: (49.0°N, -1.0°W)
```

À étendre vers la Manche centrale ou la Méditerranée si la zone semble trop calme.

## Licences sources

- aisstream.io : free tier non-commercial, attribution requise
- WDPA : free for non-commercial, attribution UNEP-WCMC
- NOAA / NASA : public domain
- Copernicus : free, attribution requise
- Global Fishing Watch : CC-BY-NC

## Stack alignée avec mon taff

J'utilise déjà à Campbell Scientific (Neo) : Angular + OpenLayers + GeoServer
Docker Swarm replicas + RabbitMQ pour synchroniser les replicas. Ce repo
est un terrain de jeu **maritime** plutôt que **météo aéroport** pour
explorer les mêmes patterns d'architecture sur un domaine différent.
