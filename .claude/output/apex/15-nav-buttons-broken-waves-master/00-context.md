# APEX Task: 15-nav-buttons-broken-waves-master

**Created:** 2026-05-18 23h55 (à exécuter DEMAIN)
**Task:** Boutons ⏪⏩⏮⏭ inactifs quand waves ou waveArrows devient master

## User Request
> vérifier pourquoi les bouton next/previous ne marchent plus une fois que les layers waves ou wave-arrows passnet maître du temps

## Hypothèses pré-diagnostic (à valider demain)

### H1 — validityListPerLayer.waves / .waveArrows vide
Le effect GetCapabilities ne populate `newMap['waves']` que si `wantWaves` est true. Idem pour waveArrows avec `wantWaveArrows`. Si l'user clique ★ sur waves SANS que showWaves soit true (cas où waveArrows seul est actif puis devient master), validityListPerLayer.waves est undefined.

→ sliderConfig pour masterKey='waves' :
  - `validities = validityListPerLayer.waves` = undefined
  - Fallback loading state avec stepMs/profile pastH/futureH
  - cfg.validities = [] (loading)
- Slider reçoit validityList = [] → goPrev/goNext fallback step ±30min
- Le step ±30min DEVRAIT bouger curseur d'1 demi-heure. Mais peut-être que `stopPlay()` + le snap-master immédiat le ramène à NOW ?

### H2 — wave-dir GS sans time dim activée
parseTimeDimension('wave-dir', xml) retourne [] si pas de `<Dimension name="time">` sur le layer côté GS. Vérifier WMS GetCapabilities :

```bash
kubectl -n maritime exec deploy/geoserver -- curl -s -u admin:geoserver \
  'http://localhost:8080/geoserver/maritime/wms?service=WMS&version=1.3.0&request=GetCapabilities' \
  | grep -A2 '<Name>wave-dir</Name>'
```

Si pas de Dimension time → waveArrows master = validityList vide.

### H3 — stepMs=0 + master change réinitialise currentTime
sliderConfig pour master avec validités retourne `stepMs: 0`. Si validities vide → fallback `stepMs = profile.stepH * 3_600_000`.
Le slider snapToStep avec stepMs=0 NO-OP. Avec stepMs>0 floor à la step.

Si goPrev/goNext appellent setTime(date) avec validityList vide :
- Fallback this.step(-FALLBACK_STEP_MS) → setTime(currentTime - 30min)
- Mais snapToStep peut floor au step 6h (forecast wave) → reste sur le même tick

## AC

- [ ] AC1: Reproduire le bug — activer SEULEMENT waveArrows (waves off), le devient master → click ⏪⏩ ne change pas le currentTime
- [ ] AC2: Identifier laquelle des 3 hypothèses (ou autre) est la cause
- [ ] AC3: Fix qui marche pour waves master + waveArrows master + windArrows master + windParticles master
- [ ] AC4: Pas de régression sur sst/wind master (nav OK avant)

## Diagnostic rapide

```bash
# Check wave-dir time dim côté GS
kubectl -n maritime exec deploy/geoserver -- curl -s -u admin:geoserver \
  "http://localhost:8080/geoserver/maritime/wms?service=WMS&version=1.3.0&request=GetCapabilities" \
  | grep -B2 -A5 '<Name>wave-dir</Name>' | head -20
```

```ts
// Reprod côté UI :
// - Active waveArrows seul
// - Click ★ sur waveArrows pour le devenir master
// - Inspect Console : validityListPerLayer.waveArrows = ?
//   sliderConfig().validities.length = ?
```

## Effort estimé
~30 min diagnostic + 30 min fix + 15 min Playwright validate. Total ~1h15.

## Files à modifier (prévision)

- `frontend/src/app/pages/map/map.component.ts` :
  - Si H1 : ajouter wantWaves OR wantWaveArrows pour fetch wave-hs ET wave-dir
  - Si H2 : activer time dim côté GS (REST PUT sur coverage)
  - Si H3 : ajuster setTime quand validities vide
- Possible : `frontend/src/app/components/time-slider/time-slider.component.ts` setTime() pour clamp/snap correct en mode loading
