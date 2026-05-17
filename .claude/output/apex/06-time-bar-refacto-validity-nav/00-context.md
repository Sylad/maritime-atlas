# APEX Task: 06-time-bar-refacto-validity-nav

**Created:** 2026-05-17 22h00 (suite marathon weekend, après root cause Math.round→Math.floor)
**Task:** Refactor time-bar : navigation par "validité" du master + default time = now (snap 30min)

## Flags
- Auto mode: true (-a)
- Save mode: true (-s)
- Economy mode: false

## User Request
> analyse le fonctionnement de la barre du temps, le fonctionnement ne semble pas naturel, la difficulté étant que l'on a des layers dans le passé, et d'autres dans le futur. la date par défaut doit être maintenant (on arrondit à la demi heure près). Les boutons de la barre du temps, on va les modifier : les boutons ⏪︎/⏩︎, on va les changer : ca va passer à la validité précédente/suivante. les boutons ⏮︎ ⏭︎ nous font aller de la date la plus ancienne à la date la plus récente

## Spec décodée

- **Date par défaut au boot** = `new Date()` snap-à-30min (pas à 1h ni à 24h)
- **⏪︎ / ⏩︎** (small step) = previous/next "validité" = timestep réel disponible côté master du temps (pas un +1h aveugle)
- **⏮︎ / ⏭︎** (big step) = première/dernière validité disponible (extrême passé / extrême futur de la fenêtre master)

"Validité" = timestamp pour lequel le master layer a effectivement un granule publié côté GS. C'est ce que `fetchTimestamps(master)` retourne (cf nearestNowProvider l.3477-3493 du map.component).

## Contexte session

- Bug "layers disparaissent" résolu plus tôt ce soir via `Math.round → Math.floor` dans snapToStep (root cause = drift currentTime vers le futur).
- Pattern SLD contours OL séparés validé pour SST (à dupliquer pour wave/wind plus tard).
- Cluster Mini-Blue stable, 1 replica GS, sha-015d521 live.

## Acceptance Criteria

- [ ] AC1: Au boot, currentTime = `new Date()` snap 30min (snapToStep avec stepMs=30min en fallback si pas de master, sinon snap au tick master le plus proche dans le passé via Math.floor)
- [ ] AC2: ⏪︎ click → navigateur cherche le timestamp master immédiatement INFÉRIEUR à currentTime dans la liste fetchTimestamps. setTime(prev).
- [ ] AC3: ⏩︎ click → idem mais timestamp immédiatement SUPÉRIEUR à currentTime.
- [ ] AC4: ⏮︎ click → setTime(min(fetchTimestamps)) — première validité (extrême passé)
- [ ] AC5: ⏭︎ click → setTime(max(fetchTimestamps)) — dernière validité (extrême futur)
- [ ] AC6: Si aucun master actif (catalogue tout off), fallback step ±30min sur ⏪︎/⏩︎ et bornes calculées de la time-bar sur ⏮︎/⏭︎
- [ ] AC7: Pas de régression isolines SST / fix layers visibles
