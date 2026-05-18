# APEX Task: 12-coverage-row-data-presence-markers

**Created:** 2026-05-18 22h55
**Task:** Indicateurs visuels de présence data dans les sous-barres time-bar étendue

## Flags
- Auto mode: true (-a)
- Save mode: true (-s)

## User Request
> dans les sous barre de temps, la présence de données devrait être indiqué, par des points/barres ou des segements de barre (pour le cas des layers ayant une validité -10minutes+20 minutes) pour aider l'utilisateur à voir la présence de données

## Spec décodée

État actuel : chaque rangée `.ts-coverage-row` a une barre continue `.ts-coverage-bar` qui s'étend de `pastH` à `futureH` (depuis NOW). C'est une plage théorique, pas la présence réelle.

Cible : afficher la présence RÉELLE des granules data :

- **Layers WMS time-enabled (SST/Wind/Wave)** : un point/marqueur PAR validité GS (validityListPerLayer[key])
  - SST = 5-7 points quotidiens
  - Wind GFS = 28 points 6h sur 7 jours
- **Layers vector live (lightning/metar/buoys/quakes/firms/...)** : la validité couvre une plage continue avec une "incertitude" (±10/20min selon refresh interval). Indication par un segment de barre épaisse aux endroits où on a "scan tous les X min".
  - lightning ~1-5 min refresh → segments fins continus
  - metar ~60 min refresh → segments ~60 min
  - buoys ~30 min refresh → segments ~30 min
- Au survol, tooltip "X validités · range : du YY/MM au YY/MM"

## Acceptance Criteria

- [ ] AC1: Sous-barre `.ts-coverage-track` rend des marqueurs ponctuels (`<span class="ts-coverage-tick" style="left: X%"/>`) pour chaque validité WMS de la layer
- [ ] AC2: Pour vector layers, rend des segments épais (largeur basée sur refresh interval) à intervalles réguliers
- [ ] AC3: Le rendu adapte sa densité — downsample affichage si > 30 points pour éviter overdraw visuel
- [ ] AC4: Au hover sur une rangée, tooltip détaillant le nombre de validités + range
- [ ] AC5: Pas de régression sur les autres features APEX 10/11

## Approche technique

1. **Pour les WMS layers** : utiliser `validityListPerLayer[key]` déjà disponible. Map chaque validité → position % sur la track.
2. **Pour les vector layers** : utiliser une grille uniforme générée selon `LAYER_PROFILES[key].stepH` ou un `refreshIntervalH`. Pas de fetch additionnel.
3. **Étendre `TimeSliderLayerCoverage`** avec `validities?: Date[]` (WMS) ou `refreshIntervalMin?: number` (vector).
4. **Côté slider** : template avec @for sur validities + position calculée.

## Files concernés

- `frontend/src/app/components/time-slider/time-slider.component.ts` :
  - Interface TimeSliderLayerCoverage étendue
  - Template `.ts-coverage-row` enrichi avec markers
  - CSS pour les markers (`.ts-coverage-tick`)
- `frontend/src/app/pages/map/map.component.ts` :
  - sliderLayerCoverage computed populate `validities` pour WMS, `refreshIntervalMin` pour vector
