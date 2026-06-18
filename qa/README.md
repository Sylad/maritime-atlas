# qa/ — harnais QA layers aetherwx

Détection déterministe des régressions de layers. **Aucun LLM dans le verdict.**

## Commandes
- `node qa/gen-manifest.mjs`  → régénère `layers.manifest.json` depuis le registry FE (`globe.component.ts`).
- `SKIP_GETCAPS=1 node qa/drift.mjs`  → vérifie qu'aucun layer FE n'est hors couverture (gate CI). Sans `SKIP_GETCAPS`, croise aussi GetCapabilities prod.
- `node qa/check-data.mjs`  → D1 : données raster (GetMap cache-busté + détecteur PNG uniforme) + vector (WFS GetFeature / endpoint API). Exit 1 si FAIL.
- `BASE_URL=<url avec hook ?qa=1> node qa/check-ui.mjs`  → D2 : toggle + opacity + z-index (P2, nécessite le hook `__aetherwxQA` déployé).
- `node qa/check-time.mjs [--layer=sst] [--flaky[=K]]`  → D3 : time-coherence TC-1/2/3 par layer raster timeEnabled (le `TIME` des GetMap suit la time-bar). `--flaky=K` (défaut 10) relance K cycles de play sur un master et exige K/K → traque l'anim « 1/100 ». Nécessite un `DISPLAY` (WebGL : `DISPLAY=:0` WSLg OK, sinon `xvfb-run -a node qa/check-time.mjs`). Le sweep complet (~20 rasters) est lent (>9 min) ; préférer `--layer=` ou le subset coverages en gate.

Override prod : `GS_URL=...` / `BASE_URL=...` (défauts = `https://aetherwx.sladoire.dev[/geoserver]`).

## Verdicts
| Verdict | Sens | Bloque ? |
|---|---|---|
| PASS | OK, vraies données / câblage correct | non |
| BLANK | rendu/pipeline vide (coverage vide, hors fenêtre, bbox) | non (rapporté) |
| FAIL | cassé (exception, ≠200, json invalide, opacity morte) | **oui (exit 1)** |
| UPSTREAM | dépendance externe down (EUMETSAT/radar/GIBS) | non (rapporté) |
| SKIP | non applicable | non |

## Anti-drift
La liste des layers est **dérivée** de `globe.component.ts` (jamais en dur) :
- `parse-registry.mjs` extrait `animatableLayersGlobe` (raster) + `SAT_PRODUCTS` (sat).
- `lib/vector-sources.mjs` mappe chaque vector kind → WFS typeName / endpoint API.
- Ajouter un layer FE sans régénérer le manifest → `drift.mjs` échoue (gate CI).
- Ajouter un vector kind à `_fetchVectorFc` sans entrée dans `vector-sources.mjs` → `gen-manifest.mjs` throw.

## Caveats connus
- **NASA GIBS** : `check-data.mjs` envoie `time=now`, mais GIBS publie en J-2 → BLANK attendu (pas un vrai cassé). Time-handling par famille à raffiner (cf spec §3.2).
- **EUMETSAT / radar** : `upstreamDependent=true` → un ServiceException upstream sort UPSTREAM, pas FAIL (non bloquant).

## Auto-validation
Casser délibérément un layer (manifest ou coverage staging) et vérifier qu'il sort FAIL.
Un test QA qu'on n'a jamais vu échouer ne vaut rien.

## Tests unitaires (logique pure)
`node --test qa/lib/*.test.mjs` → verdict, parse-registry, png-uniform.
