# AetherWX — Contrat de l'animation time-bar

> **Source de vérité** pour le comportement attendu de l'animation `/globe` (et `/legacy-map`). Doit être lu et respecté **avant** tout fix sur `AnimationPlayer`, `TimeSlider`, `AnimationPanel`, ou les pipelines tile WMS.
>
> Dernière révision : 2026-05-24 (post-marathon G42–G49 + 7h de debug stérile)

## 1. Promesse au user

> « Quand je clique ▶ avec une layer raster active, le curseur du time-bar **saute discrètement** d'une validité réelle du master à la suivante (pas linéairement à l'heure). À chaque saut, la tile affichée **change visuellement**. Si aucune validité n'existe dans la fenêtre demandée, on me le **dit clairement** (message UI), on n'invente pas un comportement bidon. »

C'est tout. Le reste découle.

## 2. Invariants

Ces propriétés DOIVENT être vraies après chaque commit qui touche l'animation. Tout fix qui les viole est un régression à rejeter.

| # | Invariant | Vérification |
|---|---|---|
| I-1 | **Validity-driven** : l'animation itère STRICTEMENT les timestamps réels du master layer (depuis GS GetCapabilities ou client-generated grid). PAS de step 1h linéaire. | Cursor positions sur le slider = ensemble fini de N validités, pas un glissement continu |
| I-2 | **Fail loud** : si `fetchTimestamps()` renvoie [] ou si le filter window vide tout → ALERT UI explicite + return early. JAMAIS de fallback silencieux. | `animPlayer.start()` throw, globe affiche `alert(...)` |
| I-3 | **Tile change per frame** : à chaque saut de cursor, le `<canvas>` MapLibre doit afficher une tile dont le contenu PNG diffère de la frame précédente (sauf si data identique côté GS, ce qui est rare). | md5 du canvas à frame N ≠ md5 frame N-1 sur ≥ 50% des layers actives |
| I-4 | **GWC HIT after MISS** : sur le 2e cycle d'animation (loop) ou un replay manuel, les tile responses doivent contenir `geowebcache-cache-result: HIT`. | Headers `geowebcache-*` présents, ratio HIT/MISS > 0% au second loop |
| I-5 | **Stop = clean** : click Stop → `frameTime$` emits return-to-now + `finished$` emits → globe cleanup les pre-loaded frames → MapLibre ne fetch plus aucune tile d'animation. | `kubectl logs frontend-pod` ou Playwright network panel : 0 nouveau fetch 3s après Stop |
| I-6 | **Step adapté au master** : `AnimationPanel` doit afficher le step natif du master (1 jour, 6h, 5min, …) et désactiver les durées qui ne produiraient < 2 frames. | Toggle SST → "6 heures" disabled, "3 jours" enabled |

## 3. Pipeline (single flow, no branch)

```
[User click ▶] 
   ↓
TimeSlider.togglePlay() 
   ↓
emit playClicked → globe.onSliderPlayClicked()
   ↓
globe.openAnimationPanel() ← AnimationPanel se rend
   ↓ user choisit duration/direction/speed/loop
   ↓ click Lancer
AnimationPanel emit launch(opts)
   ↓
globe.onAnimationLaunch(opts) :
   1. fetchTimestamps(master, wide-range) → allTs
   2. Si masterDirection=past → re-anchor sur allTs[last]
   3. Compute window [start, end] depuis effectiveOpts
   4. filtered = allTs.filter(t in window)
   5. ❌ Si filtered.length === 0 → alert UI + return  ← I-2
   6. Pre-load N frames sources MapLibre (visibility=none)
   7. waitForSourcesIdle()
   8. animPlayer.start({...opts, timestamps: filtered}) ← I-1
       ↓ throw si filtered vide (double safety) ← I-2
       ↓ emit première frame
   ↓
Tick toutes les `speed-derived ms` :
   - frameIndex++
   - emit timestamps[frameIndex]
   - globe.subscribe(frameTime$) → switchAnimationFrame(idx) → MapLibre visibility swap
   - PAS de setTiles() pendant le play → tiles déjà loaded ← I-3
   ↓ fin de séquence
Si loop=false : finishedSubject.next() → globe.cleanupAnimationFrames()
   ↓ MapLibre layers remove → 0 fetch ← I-5
```

**Branches interdites** :
- ❌ `if (timestamps empty) { fallback step 1h }` — viole I-1, I-2. Vécu G44b-G47.
- ❌ `if (no master) { animate cursor without tile refresh }` — viole I-3.
- ❌ `setTiles()` pendant play — viole I-3, I-4 (chaque frame = N tile fetches inutiles).

## 4. Catalog des layers animatables

| Master layer key | gsLayerName | Type | Grain natif (stepMs) | Animation window typique | Master eligible |
|---|---|---|---|---|---|
| `sst` | `aetherwx:sst-daily` | WMS raster | 24h (1 jour) | past 7d → 7 frames | ✅ |
| `windForecast` | `aetherwx:wind-speed` | WMS raster | 6h | future 7d → 28 frames | ✅ |
| `wavesForecast` | `aetherwx:wave-hs` | WMS raster | 6h | future 7d → 28 frames | ✅ |
| `windArrows` | GeoJSON arrows (pre-gen) | Vector | 6h (alignée wind forecast) | future 7d | ✅ |
| `waveArrows` | GeoJSON arrows | Vector | 6h | future 7d | ✅ |
| `satTrueColor`, `satIR`, … (7 NASA) | `aetherwx:sat-modis-*` etc. | WMS raster | 24h | past 7d → 7 frames | ✅ |
| `satEuIrRss`, `satEuHrvRgb` (EUMETSAT) | `aetherwx:sat-eu-*` | WMS cascade | 5min | past 1h → 12 frames | ✅ |
| `radarDwd`, `radarKnmi` | `aetherwx:radar-*` | WMS cascade | 5min | past 1h | ❌ (cascade lent) |
| `windParticles` | WebGL custom | particles | 1h | future 168h | ✅ (visu only) |
| `lightning`, `alerts`, `vessels`, `metar`, `hubeau`, `piezo`, `quakes`, `firms`, `buoys`, `tracks`, `rain` | Vector | variable | varie | ❌ (master) |

## 5. Pre-conditions infrastructure

Avant de claim "animation marche", la couche GS+GWC doit avoir :

1. **Workspace `aetherwx` actif** (post-Sprint 0 rename, cf G46) — pas de référence à `maritime:*` dans le catalog ni les workspaces/dirs.
2. **GWC Direct WMS Integration ON** — `gwc-gs.xml` contient `<directWMSIntegrationEnabled>true</directWMSIntegrationEnabled>` (cf G42c-G42d).
3. **Gridset EPSG:3857** créé (alias 900913 mais code OGC officiel, cf G42c).
4. **GWC layers configured** avec parameterFilters regex `.*` sur TIME, STYLES, ENV, VIEWPARAMS, INTERPOLATIONS (cf G42, G43c, G48).
5. **DiskQuota 2 GB + LFU eviction** (cf G45).
6. **Coverages créées dans le bon workspace** — `sst-fetcher`, `weather-fetcher`, etc. utilisent `GEOSERVER_WORKSPACE` env var (cf G47).
7. **Tile size 256×256 aligné grille GWC** — pas de 1024 (cf G43b, sinon `Miss-Reason: request does not align to grid`).

Si l'UN de ces points casse, l'animation marche en surface mais GS cravache.

## 6. Pré-flight checklist (à exécuter AVANT de dire "fix done")

```bash
# 1. WMS GetMap chaque layer raster → 200 image/png
/check-layer-coherence-globe   # (skill existant)

# 2. Run le smoke test animation E2E
/maritime-anim-test            # (le skill garde-fou)

# 3. Si l'un des 2 fail → ne PAS pousser le commit, debug avant.
```

## 7. Pitfalls vécus (à ne pas répéter)

- **Fallback step 1h legacy** dans `AnimationPlayer.tick()` masquait tous les bugs en amont (GS timeout, window mismatch, parser raté). **Supprimé G49**.
- **`workspaces/maritime/` orphelin** sur disque GS référençait des `LayerInfoImpl-HEX:HEX:HEX` stale qui faisaient throw GWC. **Supprimé au boot par bootstrap.sh G46**.
- **`requireTiledParameter=true`** dans gwc-gs.xml + frontend qui n'envoyait pas `&tiled=true` → GWC bypass total. **Fix G42c (false côté GS) + tiled=true côté front G42c**.
- **`styleParameterFilter` natif re-qualifie le style** avec workspace prefix (`sst-direct` → `aetherwx:sst-direct`) puis échoue. **Bypass via `regexParameterFilter` regex `.*` G43c**.
- **GWC layer config in-memory stale** (LayerInfoImpl IDs anciens) → DELETE GWC entry via REST force GS à régénérer depuis le catalog. **G48 ajoute le DELETE before PUT**.
- **Tile 1024×1024** pas aligné sur grille GWC 256 → `Miss-Reason: request does not align to grid`. **Revert 256 G43b**.
- **`stop()` n'émettait pas `finished$`** → cleanup pas appelé → MapLibre fetch en boucle même après Stop. **Fix G44**.
- **Default speed 4× + loop=true** → 15000+ requests/min. **Reset 1× + loop=false G44**.
- **MapLibre image source** plate ne marche pas en projection globe (distorsion sphère). **Garder raster tiles G38**.

## 8. Tags Gxx référencés

Pour traçabilité historique. Chaque `Gxx` est un commit avec contexte précis (voir `git log`).

| Tag | Sujet |
|---|---|
| G37 | Stop animation fire `finished$` + no double-play |
| G38 | Revert SST tiles (vs image source) |
| G39 | Re-anchor animation window sur LATEST validity |
| G40/43b | Tile size 1024 → revert 256 (alignement GWC) |
| G41 | Pre-load animation frames SST (cache local) |
| G42 / G42c-g | GWC config + Direct WMS Integration + EPSG:3857 gridset + cleanup stale files |
| G43c | regexParameterFilter STYLES (bypass natif buggy) |
| G44 | Default speed 1× + loop=false |
| G45 | GWC DiskQuota 2 GB + LFU |
| G46 | Bootstrap rm workspaces/maritime/ + LayerInfoImpl-*.xml |
| G47 | Fetchers workspace via env var (Sprint 0 drift) |
| G48 | DELETE before PUT GWC layer config |
| **G49** | **Fail loud sur timestamps=[]** (le fix qu'on aurait dû faire dès le début) |
