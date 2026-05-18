# APEX Task: 14-wfs-real-validity-bins

**Created:** 2026-05-18 23h25 (à exécuter DEMAIN)
**Task:** Markers data presence des vector layers via vraies WFS bins (pas cadence supposée)

## User Request
> il faudra faire l'équivalent pour les WFS

## État actuel (APEX 12)
Vector layers (lightning, metar, buoys, vessels, alerts, hubeau, piezo, quakes,
firms, tracks) → segments à intervalle régulier via LAYER_REFRESH_MIN (hypothèse
de présence continue à la cadence de refresh). Pas la VRAIE présence.

## Cible
Pour chaque rangée vector active, afficher des markers basés sur les VRAIES
timestamps présentes en DB Postgres (pg-data) via une query WFS sur la
featureType correspondante.

## FeatureTypes WFS exposés (Big-Blue checked)
- v_vessels_live, v_vessels_live_categorized, vessel_tracks_daily, vessels_at_time
- v_alerts_recent
- v_lightning_recent
- v_buoy_observations_recent, buoys

## Approche recommandée — endpoint NestJS dédié /api/availability/<layerKey>
- Le backend NestJS connaît déjà les tables Postgres (cf maritime-api)
- Query SQL avec TimescaleDB time_bucket : SELECT time_bucket('5 min', ts) as bin, count(*) FROM ... GROUP BY bin
- Retourne JSON : [{bin: "2026-05-18T20:00:00Z", count: 42}, ...]
- Frontend rend les bins comme markers avec opacity proportionnel au count
- Cache backend Redis ou in-memory ~30s

## AC
- AC1 : endpoint /api/availability/<layerKey>?from=&to=&bin=5min retourne array bins
- AC2 : 1 query par layer vector active (parallèles) au lieu de segments simulés
- AC3 : Markers rendus avec opacity = log(count) pour densité visuelle
- AC4 : Cache backend pour pas spammer la DB à chaque toggle
- AC5 : Fallback gracieux si endpoint timeout : segments refresh comme aujourd'hui

## Effort estimé
~3-4h (backend 2h + frontend 1h + tests 30min).
