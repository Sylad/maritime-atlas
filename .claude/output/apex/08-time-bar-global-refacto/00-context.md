# APEX Task: 08-time-bar-global-refacto

**Created:** 2026-05-18 matin (suite marathon weekend 14-17 mai)
**Task:** Refacto time-bar global — audit toutes layers + animation + edge cases

## Flags
- Auto mode: false (validation plan attendue avant exec)
- Save mode: true
- Economy mode: true (code connu de la session précédente, agents non nécessaires)

## User Request

> on reprend le backlog : Refacto time-bar global (audit toutes layers + animation + edge cases)

Spec consolidée depuis [[maritime-state-2026-05-17-end-of-marathon]] (citation Sylvain verbatim hier soir 23h) :

> "refaire un tour sur tous les layers actuels, la barre de temps fonctionne rarement. Pareil il faut checker l'animation, c'est bancal. Quand on passe de 0 layer sélectionné à 1 layer, la barre de temps et le temps de la map sont foireux. Il va falloir améliorer grandement la façon de fonctionner de cette barre de temps."

## Contexte précédent (à respecter)

Marathon 2026-05-17 a livré (à NE PAS casser) :
- `snapToStep` Math.floor (root cause drift currentTime)
- `parseTimeDimension` DOMParser
- `validityList` master (signal `masterValidityList`)
- Boutons ⏪⏩⏮⏭ par validité du master
- TIME exact (drop range 30j) côté refreshForTime
- Snap floor 24h SST / 6h forecast côté frontend
- Time dim activée côté GS sur 5 coverages (PUT REST)
- SLD contour-only + layers contour dédiées pour SST + wind + wave
- Retire guard `!isFuture()` sur SST/contours (currentTime jamais forcé fix)

## Acceptance Criteria

- [ ] AC1: Au boot SANS layer active, time-bar montre une plage de courtoisie (±6h ou similar), cursor = now snap 30min, pas de freeze ni drift
- [ ] AC2: Toggle 1ère layer (0→1) : currentTime snap à la validité la plus proche de NOW dans cette layer (pas un mix LAYER_PROFILES), plage + step alignés sur cette layer uniquement
- [ ] AC3: Toggle layers supplémentaires : plage = union des plages individuelles, step = granularité la plus fine, currentTime préservé si possible (sinon snap au plus proche valide)
- [ ] AC4: Toggle dernière layer off : retour à AC1 (plage courtoisie, pas de cursor orphelin)
- [ ] AC5: ⏪⏩ navigation par validité du master, mais snap par layer (chaque source WMS reçoit son propre snap floor selon sa granularité native — 24h SST, 6h forecast)
- [ ] AC6: ⏮⏭ extrême passé/futur des validités master
- [ ] AC7: NOW snap à la validité la plus proche de now dans le master
- [ ] AC8: Animation player : config (durée, vitesse) doit refléter la granularité du master, pas un step 1h fixe quand master a 24h
- [ ] AC9: Audit visuel Playwright sur 5+ layers représentatives (SST, wind, wave, vessels, tracks, alerts) : pour chacune, click ⏪⏩ change l'image GS demandée
- [ ] AC10: Pas de régression sur les fix marathon (isolines, layers qui disparaissent, image identique sur tous TIME)

## Périmètre (in / out)

**In** :
- map.component.ts (refreshForTime, applyLayerVisibility, snap-master, effect activationOrder, sliderConfig, masterValidityList, animPlayer wiring)
- time-slider.component.ts (computed, setTime/step/goPrev/goNext/goFirst/goLast/goNow, snapToStep, isLive/isFuture)
- animation-player.service.ts (audit nearestNowProvider + range computation)

**Out** :
- god component refacto Vague 1 (extract template/styles, AbortController) — sprint séparé
- gs-hz-cluster baked — sprint séparé
- Sources de données / SLDs côté GS (déjà refactor weekend, stable)
