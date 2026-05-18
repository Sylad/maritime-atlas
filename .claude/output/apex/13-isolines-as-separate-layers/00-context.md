# APEX Task: 13-isolines-as-separate-layers

**Created:** 2026-05-18 23h05 (à exécuter DEMAIN)
**Task:** Isolines = layers séparées avec opacity + color picker

## User Request
> à faire demain: il faudra considéré les layers isolines comme un layer séparé, pour pouvoir l'afficher sans le raster, ces nouveaux layers devrons avoir un control, d'opacité et un color picker pour changer la couleur de la ligne

## Spec décodée

État actuel : `showSstContours`, `showWindContours`, `showWaveContours` sont des sous-toggles dépendants du raster parent (cf catalog-section Maritime). Si SST raster est OFF, les isolines SST sont ignorées.

Cible :
- **AC1** — Chaque isoline devient une layer top-level dans le catalogue (3 nouvelles entries : "Isolines SST", "Isolines Vent", "Isolines Vagues")
- **AC2** — Activable/désactivable indépendamment du raster correspondant
- **AC3** — Slider d'opacité dédié par isoline layer (déjà patron `getOpacity`/`setOpacity` existant)
- **AC4** — Color picker pour changer la couleur des lignes (CSS color input ou palette restreinte)
- **AC5** — La couleur custom passe au SLD via env var STROKE_COLOR (paramètre dynamique GS) OU via création/modif de style user dédié par layer
- **AC6** — Persistance en localStorage + DB user prefs (palette ID)

## Files concernés (estimation)

- `frontend/src/app/pages/map/map.component.ts` :
  - Signals `showSstContours`/`showWindContours`/`showWaveContours` déjà présents
  - Refacto : ajouter 3 entries indépendantes dans catalog-section
  - Layer OL `sstContoursLayer` + `windContoursLayer` + `wavesContoursLayer` déjà séparées
  - Persistance opacity nouvelle (clés `sstContours`, `windContours`, `waveContours`)
- Color picker component nouveau OU input HTML5 `<input type="color">`
- SLD côté GS : nécessite un styleparam `STROKE_COLOR` (env vars OGC) OU upload styles user dynamique

## Approche

**Approche A (simple)** : input HTML5 `<input type="color">` → couleur passée en `env=stroke:#abcdef` côté WMS GetMap. Le SLD `sst-contours-only` doit alors accepter `${env('stroke','#ffffff')}` dans son LineSymbolizer. Modif SLD côté GS = REST PUT ou re-upload.

**Approche B (riche)** : pattern user palette existant (cf `palettesSvc.myPreferences`) appliqué aux contours. Plus lourd.

**Pour DEMAIN**, démarrer par A (~2-3h).

## TODO avant le sprint demain

- Confirmer que les SLD `sst-contours-only` / `wind-speed-contours-only` / `wave-hs-contours-only` peuvent accepter un env param `stroke`. Tester REST GS avec `&env=stroke:#ff0000` et regarder si la ligne change.
- Si non : modifier les 3 SLDs pour utiliser `${env('stroke','#FFFFFF')}` dans le `<CssParameter name="stroke">`.
