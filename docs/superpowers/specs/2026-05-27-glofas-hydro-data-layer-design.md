# GloFAS — Forecast crues comme data layer Hydrologie

**Date**: 2026-05-27
**Statut**: design validé brainstorm, prêt pour writing-plans
**Apps affectées**: maritime-atlas (aetherwx)
**Doctrine de référence**: `data_layer_policy_2026_05_19`

## Contexte

EFAS forecast crues existe actuellement dans aetherwx comme overlay tile WMS dans le groupe **Sources** du menu carte (à côté de Bathymétrie, EEZ, MPA). Cette classification est sémantiquement incorrecte :

- Sources = couches de référence statiques (bathymétrie, zones géopolitiques).
- EFAS = donnée hydrologique forecast 10j, sa place est dans la section **Hydrologie** aux côtés de Hub'eau débits et Hub'eau piézo.

Par ailleurs, EFAS n'est pas câblé comme un vrai data layer maritime :
- absent de `animatableLayers` / `LAYER_PROFILES` / `validityListPerLayer`,
- pas de time-bar, pas de rétention backend,
- toggle UI désactivé (placeholder "accès limité — compte EMS requis" lignes 1111-1120 de `map.component.ts`),
- proxy nginx `/wms-efas` en place mais inutilisé côté UI active.

**Blocage EFAS** : après vérification des [conditions of access](https://european-flood.emergency.copernicus.eu/en/efas-conditions-access), les forecasts temps réel sont réservés aux "EFAS partners" — autorités nationales/régionales légalement chargées de la prévision crue. Un projet solo dev / hobbyist ne remplit pas ces critères ; l'application sera refusée par SMHI (centre de dissémination EFAS).

**Pivot retenu** : utiliser **GloFAS** (Global Flood Awareness System) — même équipe JRC, même algos, même seuils, **couverture mondiale** (au lieu d'Europe seulement), distribué via **Copernicus Climate Data Store (CDS)** en accès libre (compte ECMWF gratuit immédiat, API Python `cdsapi`, NetCDF).

## Objectif

Promouvoir GloFAS au rang de vrai data layer maritime dans la section Hydrologie, conformément à la doctrine `data_layer_policy_2026_05_19` (rétention, time-bar, cohérence data↔time-bar invariant). Ajouter une killer feature hydro pro : courbe time series locale au clic, affichant les 3 seuils Q5/Q20/Q50 superposés.

## Non-objectifs

- Pas de migration EFAS → GloFAS si EFAS devient un jour accessible : on reste sur GloFAS, qui couvre déjà le besoin et offre la couverture mondiale.
- Pas de chart-au-clic pour les autres data layers (Hub'eau / piézo) dans cette itération — on garde le scope serré au seul GloFAS.
- Pas de seasonal forecast (CEMS publie aussi `glofas-seasonal` à 4 mois d'horizon) — on reste sur le forecast 10j strict.
- Pas de modification de la doctrine `data_layer_policy_2026_05_19` ; on s'y conforme strictement.

## Architecture

```
┌───────────────────────────────────────────────────────────────────────┐
│  Argo CronWorkflow "glofas-refresh"  (cron: 0 */6 * * *)               │
│  step "trigger": curl -X POST                                          │
│    http://maritime-api.aetherwx.svc.cluster.local./internal-trigger/  │
│    sources/glofas                                                      │
│    -H "X-Service-Token: $SERVICE_TOKEN"                                │
│  (set -e + echo URL + cat response → anti silent-failure G12g)         │
└───────────────────────────────┬───────────────────────────────────────┘
                                ▼
┌───────────────────────────────────────────────────────────────────────┐
│  NestJS GlofasService (services/api/src/glofas/)                       │
│  POST http://glofas-fetcher.aetherwx.svc.cluster.local.:8080/fetch     │
│  Body: { run_time: latest, leadtimes: [24..168 step 24], thresholds:   │
│    [Q5, Q20, Q50] }                                                    │
│  Timeout: 1h (cdsapi queue peut être long)                             │
│  Retry: 3 tentatives espacées 10min (workflow-level)                   │
└───────────────────────────────┬───────────────────────────────────────┘
                                ▼
┌───────────────────────────────────────────────────────────────────────┐
│  Sidecar Python "glofas-fetcher"  (FastAPI, image dédiée)              │
│  1. cdsapi.retrieve('cems-glofas-forecast', { ... })                   │
│  2. Convert NetCDF → GeoTIFFs (gdal_translate via Python)              │
│  3. Layout: /coverage/glofas/<run_iso>/<threshold>/<leadtime>.tif       │
│     ex: /coverage/glofas/2026-05-27T00Z/Q5/072.tif                     │
│  4. Trigger GS reindex via REST (PUT coveragestore reload)             │
│  5. Return 200 { written: 21, run: '2026-05-27T00Z' }                  │
└───────────────────────────────┬───────────────────────────────────────┘
                                ▼
┌───────────────────────────────────────────────────────────────────────┐
│  GeoServer — coverage store + 3 layers WMS time-enabled               │
│  Store: aetherwx:glofas (ImageMosaic, indexed PostGIS)                 │
│  Layers:                                                               │
│    aetherwx:glofas-flood-prob-q5                                       │
│    aetherwx:glofas-flood-prob-q20                                      │
│    aetherwx:glofas-flood-prob-q50                                      │
│  PRESENTATION: LIST (timestamps explicites depuis index)               │
│  Style: glofas-prob-gradient (0% bleu → 50% jaune → 100% rouge)        │
└───────────────────────────────────────────────────────────────────────┘
```

## Composants à créer / modifier

| Composant | Type | Localisation | Action |
|---|---|---|---|
| `glofas-refresh.yaml` | Argo CronWorkflow | `developpeur-gitops/charts/maritime/templates/argo-workflows/` | Créer |
| `glofas/glofas.module.ts` + controller + service | NestJS | `services/api/src/glofas/` | Créer |
| `glofas-fetcher` Dockerfile + `app.py` (FastAPI) | Python sidecar | `services/glofas-fetcher/` | Créer |
| Helm deployment + service | K8s | `developpeur-gitops/charts/maritime/templates/glofas-fetcher-*.yaml` | Créer |
| PVC `coverage-glofas` (20Gi RWX) | K8s | `developpeur-gitops/charts/maritime/templates/glofas-fetcher-pvc.yaml` | Créer |
| Secret `glofas-cds-credentials` (`.cdsapirc` UID + key) | K8s | hors gitops, `kubectl create secret` manuel | Créer hors-repo |
| Coverage store + layers + style GS | Bootstrap Java | `services/maritime-gs-bootstrap/src/main/java/.../GlofasBootstrap.java` | Créer (pattern plugin Java durable, cf [[feedback_geoserver_java_plugin_over_rest]]) |
| `efasLayer` + `showEfas` signal | Frontend Angular | `frontend/src/app/pages/map/map.component.ts` | Supprimer (~30 lignes) |
| `glofasLayer` + `showGlofas` signal + dropdown seuil | Frontend Angular | `frontend/src/app/pages/map/map.component.ts` | Créer |
| Placeholder désactivé "Prévisions crues" lignes 1111-1120 | Frontend Angular | `frontend/src/app/pages/map/map.component.ts` | Remplacer par vrai toggle |
| `glofas-timeseries-chart.component.ts` | Frontend Angular | `frontend/src/app/components/glofas-timeseries-chart/` | Créer (SVG inline ~80 lignes, pattern miroir `ingestion-mini-chart`) |
| Endpoint REST `/api/glofas/timeseries?lon=&lat=` | NestJS | `services/api/src/glofas/glofas.controller.ts` | Créer |
| `maritime-retention-cleanup` CronJob | K8s | `developpeur-gitops/charts/maritime/templates/retention-cleanup-cronjob.yaml` | Modifier (ajouter cleanup `/coverage/glofas/`) |
| Doc `docs/aetherwx-animation.md` | Markdown | `maritime-atlas/docs/` | Mettre à jour (ajouter glofas à la liste des layers animables) |
| `wms-efas` proxy nginx | Frontend nginx | `frontend/nginx.conf` | Supprimer (proxy obsolète) |

## Détail des composants

### Argo CronWorkflow `glofas-refresh`

- Schedule : `0 */6 * * *` (toutes les 6h, aligné sur les runs GloFAS publiés à 00, 06, 12, 18 UTC).
- Pattern set -e + echo + cat response (anti [[argo_workflows_g12g_silent_failure_pattern]]).
- Timeout step : 3600s (cdsapi queue peut être longue).
- Retry policy : 3 tentatives, backoff exponentiel 10min / 30min / 60min.
- Service token : K8s Secret `internal-trigger-service-token`, mounted comme env var.

### NestJS GlofasService + controller

Endpoints :

1. `POST /internal-trigger/sources/glofas` — auth `X-Service-Token`, body vide, déclenche le fetch.
2. `GET /api/glofas/timeseries?lon=X&lat=Y` — public (cohérent avec les autres APIs aetherwx), retourne JSON :

```json
[
  { "ts": "2026-05-27T00:00:00Z", "Q5": 0.45, "Q20": 0.12, "Q50": 0.03 },
  { "ts": "2026-05-28T00:00:00Z", "Q5": 0.52, "Q20": 0.18, "Q50": 0.05 },
  ...
]
```

Implémentation du timeseries :
- Boucle 3 seuils × 7 timestamps = 21 GetFeatureInfo WMS parallèles vers GS local.
- Cache en mémoire TTL 1h, key = `(lon_rounded4, lat_rounded4, run_ts)`.
- Si tous les seuils retournent `nodata` (point océan / désert) → 200 `{ available: false }`.

Module structure (miroir des modules existants comme `hubeau/`):
```
services/api/src/glofas/
├── glofas.module.ts
├── glofas.controller.ts        # routes /api/glofas/* + /internal-trigger/sources/glofas
├── glofas.service.ts           # logic fetch + timeseries
└── glofas.types.ts             # interfaces TS partagées
```

### Python sidecar `glofas-fetcher`

- Image base : `python:3.12-slim-bookworm` (cohérent avec grib-parser, [[undici_alpine_musl_external_fetch_bug]] OK car pas Node).
- Deps : `cdsapi`, `fastapi`, `uvicorn`, `xarray`, `netCDF4`, `rasterio` (GDAL bindings).
- Endpoint `POST /fetch` accepte `{ run_time, leadtimes, thresholds }`, retourne `{ written, run }`.
- Endpoint `GET /healthz` pour K8s liveness/readiness probe.
- Logging structuré JSON stdout pour ingestion par observabilité.
- `.cdsapirc` monté depuis Secret K8s en `/root/.cdsapirc`.
- Concurrency : 1 fetch à la fois (cdsapi single-request, queue côté Copernicus de toute façon).

### GeoServer coverage store + layers + style

**Pattern durable via plugin Java** (`maritime-gs-bootstrap`, cf [[feedback_geoserver_java_plugin_over_rest]]) :

- `GlofasBootstrap.java` avec `@PostConstruct` qui :
  1. Crée le coverage store `aetherwx:glofas` (type ImageMosaic, indexer en PostGIS).
  2. Crée les 3 layers `aetherwx:glofas-flood-prob-q{5,20,50}` (un par seuil, filter sur le path).
  3. Configure `PRESENTATION=LIST` (timestamps explicites depuis l'index PostGIS).
  4. Crée le style `glofas-prob-gradient` (SLD gradient 0→100%, bleu→jaune→rouge).
  5. Assigne le style par défaut à chaque layer.

Indexer config (`indexer.properties`) :
```
TimeAttribute=time
Schema=*the_geom:Polygon,location:String,time:java.util.Date,threshold:String,leadtime:Integer
PropertyCollectors=TimestampFileNameExtractorSPI[timeregex](time),StringFileNameExtractorSPI[thresholdregex](threshold),IntegerFileNameExtractorSPI[leadtimeregex](leadtime)
```

Style SLD `glofas-prob-gradient` :
```xml
<RasterSymbolizer>
  <ColorMap type="ramp">
    <ColorMapEntry color="#3b82f6" quantity="0"   opacity="0"/>
    <ColorMapEntry color="#3b82f6" quantity="10"  opacity="0.3"/>
    <ColorMapEntry color="#eab308" quantity="50"  opacity="0.6"/>
    <ColorMapEntry color="#f97316" quantity="75"  opacity="0.7"/>
    <ColorMapEntry color="#dc2626" quantity="100" opacity="0.85"/>
  </ColorMap>
</RasterSymbolizer>
```

### Frontend Angular — toggle Hydrologie + dropdown seuil

Section Hydrologie cible :
```
▼ 🌊 Hydrologie          (count)
   ▣  Hub'eau débits FR        [count]
   ▣  Hub'eau piézo FR         [count]
   ▣  GloFAS forecast crues 7j [Q5 ▼]   ← NOUVEAU
   ☐  Qualité eau              à venir
```

- Toggle binding : `showGlofas` signal.
- Sub-panel quand `showGlofas() === true` :
  - Slider opacité (pattern existant).
  - **Dropdown seuil** : `Q5 / Q20 / Q50` (default Q5). Pilote le paramètre `LAYERS` du `TileWMS` source côté carte (`aetherwx:glofas-flood-prob-q{N}`).

### Frontend Angular — wiring data layer (10 points doctrine)

| # | Point | Valeur GloFAS |
|---|---|---|
| 1 | `animatableLayers` | `{ key: 'glofas', label: 'GloFAS forecast crues', type: 'wms', gsLayerName: 'aetherwx:glofas-flood-prob-q5', active: () => this.showGlofas() }` — note : on register Q5 par défaut, le dropdown change dynamiquement |
| 2 | `LAYER_PROFILES.glofas` | `{ kind: 'forecast', stepH: 24, pastH: 168, futureH: 168 }` |
| 3 | `LAYER_COLORS.glofas` | `#3b82f6` (cohérent avec gradient) |
| 4 | `LAYER_REFRESH_MIN` | N/A (raster, pas vector) |
| 5 | `sliderLayerCoverage` push | rangée slider quand `showGlofas() === true` |
| 6 | `validityListPerLayer` effect | timestamps depuis GS GetCapabilities (PRESENTATION=LIST) |
| 7 | `activeLayersCount` | inclure glofas |
| 8 | `applyLayerVisibility` | `if (this.glofasLayer) this.glofasLayer.setVisible(this.showGlofas())` |
| 9 | Persist / restore localStorage | `showGlofas` + seuil sélectionné dans `DEFAULT_VISIBILITY` + vis loader |
| 10 | Effect réactif `show*` signal | refresh WMS `TIME` param sur cursor change |

### Frontend Angular — chart popup au clic

Composant `glofas-timeseries-chart`:
- Inputs : `series: { ts: string; Q5: number; Q20: number; Q50: number }[]`, `lon: number`, `lat: number`.
- Template : SVG inline 320×140px (cohérent avec `ingestion-mini-chart`).
  - 3 polylines : Q5 jaune `#eab308`, Q20 orange `#f97316`, Q50 rouge `#dc2626`.
  - Grille X : 7 ticks (J+1 ... J+7), labels rotated -45°.
  - Grille Y : 0%, 25%, 50%, 75%, 100% horizontal lines.
  - Legend en haut : 3 swatches avec labels.
- Pas de tooltip interactif dans cette itération (out of scope, peut s'ajouter plus tard).

Handler clic carte :
```typescript
onMapClick(evt: MapBrowserEvent) {
  if (!this.showGlofas()) return;
  const pixel = this.map.getEventPixel(evt.originalEvent);
  const hit = this.map.forEachLayerAtPixel(pixel, l => l === this.glofasLayer);
  if (!hit) return;
  const [lon, lat] = toLonLat(evt.coordinate);
  this.fetchGlofasTimeSeries(lon, lat).then(rows => {
    if (rows.length === 0) {
      this.toastService.info('Pas de prévision GloFAS à cet endroit');
      return;
    }
    this.openGlofasPopup({ lon, lat, series: rows });
  });
}
```

Popup affichée dans le side panel existant (pattern miroir hubeau / piezo : `selectedGlofas` signal + bloc HTML dédié dans le template, déclenchant l'affichage du composant chart).

### Rétention

Stricte, alignée time-bar : **7j past + 7j future** (`pastH: 168`, `futureH: 168`).

CronJob `maritime-retention-cleanup` : ajouter une étape :
```bash
# Glofas — drop coverage files hors window
find /coverage/glofas -mindepth 2 -maxdepth 2 -type d -name '????-??-??T??Z' \
  -mmin +$((7*24*60+60)) -print -exec rm -rf {} +
```

Et purge correspondante des rows ImageMosaic dans la DB PostGIS (table `glofas` indexée par `time`).

## Pièges connus à éviter (mémoire projet)

- ✅ `set -e` + `echo URL` + `cat response` dans le step Argo (anti [[argo_workflows_g12g_silent_failure_pattern]]).
- ✅ Bootstrap GS via plugin Java + `@PostConstruct`, pas REST PUT seul ([[feedback_geoserver_java_plugin_over_rest]] + [[geoserver_rest_put_persistence_bug_2026_05_24]]).
- ✅ Trailing dot DNS sur les FQDN K8s (`*.aetherwx.svc.cluster.local.`) — anti [[curl_musl_alpine_ndots_dns_fail]].
- ✅ Secret CDS créé manuellement hors gitops (le UID + API key Copernicus ne doit jamais être commité).
- ✅ Pas de cascade WMS — on sert le layer depuis GS local en ImageMosaic, donc le bug [[geoserver_cascade_wms_no_time_forward_bug]] ne s'applique pas, le param TIME forward normalement.
- ✅ Image Python sidecar = `python:3.12-slim-bookworm`, pas Alpine (anti [[undici_alpine_musl_external_fetch_bug]] dans l'esprit, et `cdsapi` + `rasterio` ont des deps natives plus simples sur glibc).
- ✅ Aucun `Date` binding direct à postgres.js dans le service Glofas — `.toISOString()` systématique ([[postgres_js_date_binding_serialization]]).
- ✅ Animation fail-loud : si GloFAS active et timestamps vides → throw + alerte UI, pas de fallback silencieux ([[feedback_animation_no_silent_fallback]]).
- ✅ Le test `/maritime-anim-test` doit passer avant tout bump frontend tag dans gitops (RÈGLE 1 maritime-animation).

## Risks & open questions

À résoudre pendant la phase writing-plans :

| Risk | Mitigation prévue |
|---|---|
| Dataset CDS exact : `cems-glofas-forecast` v3 vs v4 ? | Vérifier sur catalog CDS au moment de l'implémentation. Default = dernière version stable. |
| Le produit `flood_probability` est-il directement servi par CDS, ou faut-il le calculer depuis `river_discharge` + thresholds historiques ? | Si calcul nécessaire, ajouter une étape `compute_probability.py` dans le sidecar, avec table de référence des seuils Q5/Q20/Q50 par mailles 0.05° (téléchargée 1× au déploiement). |
| Délais queue CDS — runs 6h pourraient être bloqués pendant 1-6h | Workflow retry 3× avec backoff, et fallback "garder la run précédente si la nouvelle échoue 3×". |
| Coverage spatial : monde entier 0.05° → ~16 millions de pixels par GeoTIFF × 21 tiles par run × 28 runs sur 7j past + 7j future + frais de cleanup = volume disque PVC | Estimer empiriquement après le 1er run. PVC pré-dimensionné à 20Gi, monitorer. |
| Latence 21 GetFeatureInfo parallèles côté backend pour chart popup | Cache TTL 1h, et si p95 > 2s en prod → migrer vers WPS custom (1 seule request, pattern [[geoserver_custom_wps_process_recipe]]). |
| Compte ECMWF requis pour cdsapi | Démarche manuelle Sylvain : créer compte sur https://cds.climate.copernicus.eu, récupérer UID + API key, créer Secret K8s. À faire avant le 1er rollout. |
| Le bug [[geoserver_cascade_wms_no_time_forward_bug]] est-il vraiment hors scope ? | Oui : on n'utilise plus de cascade, GloFAS est servi depuis ImageMosaic local. Validé. |

## Critères de validation (Definition of Done)

- [ ] Le toggle "GloFAS forecast crues" apparaît dans la section Hydrologie du menu carte (et non plus dans Sources).
- [ ] Le placeholder "Prévisions crues — accès limité" (lignes 1111-1120 actuel de `map.component.ts`) est retiré.
- [ ] Le proxy nginx `/wms-efas` est supprimé de la config frontend.
- [ ] Activer GloFAS allume la couche raster sur la carte avec le seuil sélectionné (Q5 par défaut).
- [ ] La time-bar montre des timestamps J-7 → J+7 avec step 24h quand GloFAS est master du temps.
- [ ] Le `/maritime-anim-test` passe avec GloFAS allumé seul.
- [ ] Cliquer sur un point dans la zone GloFAS ouvre le popup chart avec 3 courbes Q5 / Q20 / Q50.
- [ ] Cliquer sur un point hors zone GloFAS affiche un toast "Pas de prévision GloFAS à cet endroit".
- [ ] Le CronWorkflow `glofas-refresh` tourne toutes les 6h et son dernier run est `Succeeded` dans ArgoCD.
- [ ] Les fichiers `/coverage/glofas/<run>/` plus vieux que 7j sont nettoyés par le CronJob retention.
- [ ] L'image `glofas-fetcher` est dans GHCR, taggée par commit SHA, et déployée dans aetherwx via gitops.
- [ ] La doc `docs/aetherwx-animation.md` est mise à jour pour mentionner GloFAS dans la liste des layers animables.
- [ ] README aetherwx liste GloFAS dans la section Sources data.

## Prochaine étape

Invoquer la skill `writing-plans` pour produire le plan d'implémentation détaillé (ordre des PR, dependencies, tests à écrire, smoke tests post-déploiement).
