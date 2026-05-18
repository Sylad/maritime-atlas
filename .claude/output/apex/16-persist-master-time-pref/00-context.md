# APEX Task: 16-persist-master-time-pref

**Created:** 2026-05-19
**Task:** Persister le master du temps actuel en préférences

## User Request
> et rajouter le layer maitre du temps dans les préférences

## Spec décodée
- Le master courant = `activationOrder[0]` (filtré WMS via masterLayerKey)
- Actuellement `activationOrder` est reconstruit au boot dans l'ordre déclaratif d'animatableLayers (wind > waves > sst > ...). L'ordre user est perdu.
- À persister : `activationOrder` (array de keys) dans layer-prefs-v1
- Au boot : restaurer l'ordre AVANT que l'effect watcher reconstruise depuis 0

## AC
- AC1 : Master sélectionné par user (★ click) survit au reload
- AC2 : Persistance dans localStorage layer-prefs-v1 (même blob que visibility/opacity/zIndex)
- AC3 : Backwards compat — si pas d'activationOrder persisté, fallback comportement actuel
