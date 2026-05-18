# APEX Task: 11-collapse-panel-and-master-icon-and-drag-zindex

**Created:** 2026-05-18 22h25
**Task:** 3 features UX panneau gauche + time-bar étendue

## Flags
- Auto mode: true (-a)
- Save mode: true (-s)
- Economy mode: false

## User Request
> un click sur l'icone aetherwx devrait réduire le panneau de gauche à un bouton, un click sur le bouton rééaffiche le panneau de gauche. Je ne voit toujours pas d'icone de time leader dans le panneau de gauche. Mais je me disais qu'une chose plus simple, le time leader pourrais être indique/changer par un icone dans les liste des time bar, sous la time barre princtipale quand elle est agrandie. Deplus on pourrait avoir un systeme de drag and drop des ces lignes, pour changer le z-index des layers!

## 3 features

### Feature 1 — Toggle panneau gauche (click logo AetherWX)
- AC1 : Click sur logo AetherWX (en haut-gauche, `app-root header`) → le panneau de gauche se collapse
- AC2 : Quand collapsed, un petit bouton (icône menu / hamburger / AetherWX mini) reste visible
- AC3 : Click sur ce bouton → panneau redéployé
- AC4 : État persisté en localStorage (`maritime.panel-collapsed-v1`)

### Feature 2 — Time leader icône dans la time-bar étendue
- AC5 : Quand la time-bar est étendue (▲ bouton), les rangées layers (sst/wind/waves/etc) s'affichent
- AC6 : Chaque rangée a une icône à gauche (e.g., ⏱ ou étoile)
- AC7 : La layer master courante a une icône DIFFÉRENTE (e.g., ⭐ filled vs ☆ outline)
- AC8 : Click sur l'icône d'une rangée non-master → bascule master vers cette layer (réordonne `activationOrder` pour mettre cette layer en tête)
- AC9 : Le label master au-dessus de la track ("X validités · obs/forecast") suit le master courant

### Feature 3 — Drag-and-drop rangées = z-index OL
- AC10 : Les rangées dans la time-bar étendue sont draggables (HTML5 drag-and-drop ou pointer-based)
- AC11 : Quand l'user drag une rangée à une nouvelle position, l'ordre est persisté et le z-index OL des layers est mis à jour (`setZIndex`)
- AC12 : L'ordre est persisté en localStorage (e.g., `maritime.layer-zindex-v1`)
- AC13 : Au reload, l'ordre de la time-bar étendue ET le z-index OL des layers reflètent l'ordre persisté

## Files concernés (à confirmer step-01)
- `frontend/src/app/pages/map/map.component.ts` :
  - Header avec logo AetherWX
  - Panneau gauche (Catalog/Maritime sections)
  - Signal `panelCollapsed` à ajouter
  - Méthode pour réordonner activationOrder + setZIndex OL
- `frontend/src/app/components/time-slider/time-slider.component.ts` :
  - Mode expanded (▲ bouton + `layerCoverage` rendu)
  - Ajout icône master par rangée + binding click handler
  - HTML5 drag-and-drop (`draggable`, `dragstart`, `dragover`, `drop`)
