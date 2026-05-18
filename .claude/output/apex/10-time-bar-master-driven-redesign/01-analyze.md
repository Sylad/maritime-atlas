# Step 01 — Analyze

## État actuel — sliderConfig (map.component.ts L2513-2569)

Le computed utilise **les LAYER_PROFILES** (`pastH/futureH/stepH`) pour calculer une **plage continue** :
- minTime = `now - maxPastH * 3_600_000`
- maxTime = `now + maxFutureH * 3_600_000`
- stepMs = `minStepH * 3_600_000`
- Si aucun layer time-enabled → fallback ±6h "plage de courtoisie"

**Problème vs spec Sylvain** :
- ❌ Plage continue alors qu'il veut une plage **alignée sur les validités réelles**
- ❌ Plage de courtoisie même sans layer → veut **disparition complète**
- ❌ Step continu (24h ou 6h) alors qu'il veut **les validités exactes**

## État actuel — Time-slider render (time-slider.component.ts L103-107)

```html
<div class="ts-ticks">
  <span class="ts-tick-min">{{ minTime() | date:'dd/MM' }}</span>
  <span class="ts-tick-mid">{{ midTime() | date:'dd/MM' }}</span>
  <span class="ts-tick-max">{{ maxTime() | date:'dd/MM' }}</span>
</div>
```

**3 ticks fixes** (min/mid/max). Pas de tick per validity. Pas d'option "afficher N ticks selon validityList".

## État actuel — Navigation buttons (time-slider.component.ts L566-625)

`goPrev/goNext/goFirst/goLast/goNow` utilisent **déjà** `validityList()` quand non-vide :
- ⏪⏩ : prev/next dans la liste
- ⏮⏭ : first/last de la liste
- NOW : nearest dans la liste

→ **AC4 OK déjà depuis APEX 06**.

## État actuel — Snap-master au master change (map.component.ts L3232-3286)

Avec les 2 hotfixes APEX 08 (sha-14accfa + sha-813612d) :
- Run 1 (no validities yet) → fallback profile
- Run 2 (validities arrived) → snap à validity closest to NOW
- Label time-bar suit currentTimeSig (externalCurrentTime always bound)

→ **AC5 OK déjà depuis APEX 08**.

## Ce qui manque vraiment

### AC1 — Disparition si 0 data layer
Pas de wrapper `@if` autour de `<app-time-slider>` dans le template parent. Toujours rendue avec plage courtoisie ±6h.

### AC2 — Contenu = validités master only
`sliderConfig` ignore `validityListPerLayer[masterKey]`. Il faut piloter min/max DEPUIS les validités master, pas depuis les profile pastH/futureH.

### AC3 — Apparence adapte aux validités
Slider template doit rendre N ticks au lieu de 3 fixes. Et le slider TRACK doit visuellement marquer chaque validité (ne pas être un range continu).

### AC6 — LIVE follow-along nouvelle validité
Aucun polling périodique du `fetchTimestamps` master après le snap initial. Si fetcher publie un nouveau granule pendant que l'user est sur LIVE, l'app ne snap pas auto. Reste sur l'ancien tick.

## Plan refacto (step-02 next)

1. **`sliderConfig`** : retourne `null` si pas de master data layer. Sinon retourne `{minTime: validities[0], maxTime: validities[len-1], validities, label}` (drop `stepMs` continu, on bosse en mode validité-discrete).
2. **Template parent** : `@if (sliderConfig(); as cfg) { <app-time-slider [...] /> }`
3. **Time-slider** :
   - Accept new optional input `validityTicks: input<Date[]>([])`
   - Si non vide, render N ticks alignés sur les validités (downsample affichage si N > 15)
   - Adapter le `displayTime` cursor pour snap sur la validité la plus proche en drag
4. **LIVE follow-along** :
   - Effect Angular avec `setInterval(60_000)` qui appelle `refresh validityListPerLayer master`
   - Si `isLive()` ET nouvelle validity > closest_old_validity du delta avec NOW → `onTimeChange(new_closest_validity)`
5. **Tests Playwright** : reprendre l'audit APEX 08 + nouveau AC1 (toggle off all → time-bar gone) + AC6 (simulation : modifier localStorage validityList, vérifier que LIVE follow snap).

## Risques

- **Multi-layers + master change** : si user toggle SST → Wind, le master change. La validityList Wind est différente (6h step vs 24h). La time-bar doit refresh proprement, pas garder les ticks SST.
- **Polling LIVE = network noise** : 60s d'intervalle = 1 GetCapabilities par minute = OK, mais à debouncer pour pas chaîner pendant les toggles rapides.
- **Quand fetchValidities returns empty** (race au boot ou error réseau) : pas de validités → fallback temporaire avec profile + label "loading…" (déjà draft dans plan).

## Files à toucher (estimation effort)

- `frontend/src/app/pages/map/map.component.ts` : ~80 lignes
  - sliderConfig refacto (40 lignes)
  - LIVE polling effect nouveau (30 lignes)
  - Template @if wrapper (5 lignes)
- `frontend/src/app/components/time-slider/time-slider.component.ts` : ~50 lignes
  - input validityTicks (3 lignes)
  - ts-ticks rendu N ticks (15 lignes template + 10 lignes computed downsample)
  - Optional : snap cursor visuel sur validity (CSS-only, ~20 lignes)

Total : ~130 lignes diff. Effort réel : 1h30-2h + Playwright audit.
