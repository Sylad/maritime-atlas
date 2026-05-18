# APEX Task: 10-time-bar-master-driven-redesign

**Created:** 2026-05-18 22h45 (apex 09 wrap-up encore en cours)
**Task:** Time-bar entièrement master-driven : disparaît si pas de layer active, ses ticks = validités du master, adapte son apparence, init sélectionne la validité la plus proche de NOW (LIVE), suit les nouvelles validités en LIVE.

## Flags
- Auto mode: true (-a)
- Save mode: true (-s)
- Economy mode: false

## User Request

> bien je ne suis poas convaincu du fonctionnement de la barre de temps, peux tu l'analyser : mais en gros la barre de temps devrait disparaitre si aucun data layers n'est actif, elle ne devrait contenir que les valdité du layer maitre du temps et donc s'adapter en apparence aux validité. Vérifier le fontionnement des boutons next/previous, first/last, et même à l'initialisation (ou changement de maitre du temps), la barre du temps s'initialise avec les validité du layers, et la validité la plus proche de maintenant devrait être selectionné (et dans ce cas live doit être actif, et si une validité devient plus proche de maintenant et live acctif, cette validité devient active.

## Spec décodée

### AC1 — Disparition si 0 layer data actif
- Quand aucune layer "time-enabled data" (SST/Wind/Wave/etc) n'est cochée → la time-bar n'est pas rendue (display:none)
- Vessels, alertes etc. NE comptent PAS comme data layer time-enabled
- Au reload avec 0 layer cochée → 0 time-bar visible

### AC2 — Contenu = validités du master uniquement
- Ce sont les vraies validités GS (`validityListPerLayer[masterKey]`)
- PAS un range continu lissé. PAS de step générique (24h/6h).
- Si master = SST (7 granules quotidiens) → time-bar a 7 ticks
- Si master = Wind GFS (28 ticks 6h sur 7j) → time-bar a 28 ticks
- Pas de fallback step ±6h "plage courtoisie"

### AC3 — Apparence adapte aux validités
- Min = première validité, max = dernière validité
- Pas de tick fantôme entre les validités. Les ticks visibles correspondent aux marques réelles
- Si layout permet, afficher tous les ticks (sinon downsample affichage)

### AC4 — Boutons cohérents
- ⏪ / ⏩ = validité précédente / suivante dans la liste master
- ⏮ / ⏭ = première / dernière validité dans la liste master
- NOW = validité la plus proche de Date.now() dans la liste master

### AC5 — Init / changement master
- Quand le master change (toggle layer, ou première layer cochée), réinit time-bar avec les validités de la nouvelle master
- Sélectionne la validité la plus proche de NOW (= snap-master Run 2 qu'on a déjà patché en APEX 08)
- Si la validité est ≤ X minutes de NOW, mode LIVE activé

### AC6 — LIVE follow-along
- En mode LIVE, si une nouvelle validité plus proche de NOW arrive (publication granule par le fetcher), bascule auto vers cette validité
- Implique un polling périodique du `fetchTimestamps` master + détection diff

### AC7 — Pas de régression
- snap par-source WMS continue de marcher (APEX 08)
- isolines bougent avec raster
- Pas de 502 hors fenêtre forecast wind

## Acceptance Criteria

- [ ] AC1: Time-bar `display:none` si aucune layer data time-enabled active
- [ ] AC2: ts-ticks = validités master only (pas range continu)
- [ ] AC3: Min/max sliderConfig = first/last validity (pas pastH/futureH générique)
- [ ] AC4: ⏪⏩⏮⏭ navigation OK dans la validityList (déjà OK depuis APEX 06)
- [ ] AC5: Au master change, currentTime → validity closest to NOW (APEX 08 hotfix 1 déjà OK)
- [ ] AC6: Polling LIVE refresh → si nouvelle validité ≤ écart actuel à NOW → snap auto
- [ ] AC7: No regression isolines / WMS / 502

## Fichiers concernés (à confirmer en step-01)

- `frontend/src/app/pages/map/map.component.ts` :
  - `sliderConfig` computed (utilise actuellement LAYER_PROFILES.pastH/futureH → à refacto vers `validityListPerLayer[master]`)
  - `validityListPerLayer` effect (déjà en place via APEX 08)
  - Polling LIVE = nouveau setInterval ou utiliser la subscribe RMQ raster.ready ?

- `frontend/src/app/components/time-slider/time-slider.component.ts` :
  - Template : @if wrapper pour AC1 (disparition)
  - Rendu des ticks : passer en mode "validity-tick" plutôt qu'interpolation min→max
