# APEX Task: 05-isolines-raster-and-layers-disappear

**Created:** 2026-05-17 20h45 (fin de marathon weekend GS refacto)
**Task:** Diagnostic 2 bugs persistants : (1) isolines ne s'appliquent pas sur le raster interpolé, (2) layers disparaissent au bout d'1 min sans nouvelle requête

## Flags
- Auto mode: true
- Save mode: true
- Economy mode: false (besoin d'agents Explore parallèles)
- Branch mode: false (workflow solo direct main)

## User Request
> recherche pourquoi les layers isolines ne s'applique pas sur les raster interpollé!!!! Et en parralèle, recherche pourquoi les layers disparaissent au bout d'une minute

## Contexte session
- Sprint refacto GS catalog JDBC 2026-05-16/17 en cours
- Fait dans la journée : INTERPOLATIONS=bicubic, gate visibility WFS, SLD sst-contours-only séparé, sstContoursLayer dédiée, fix trigger applyLayerVisibility(showSstContours)
- Frontend rolling sha-1274c48 en cours via ArgoCD
- Sylvain épuisé, 4 jours de friction K8s, layers continuent à disparaître après ~1min
- Screenshot post-fix montre carte VIDE (juste contours pays) malgré SST + Isolignes cochés

## Acceptance Criteria
- [ ] AC1: Identifier pourquoi le SLD sst-contours-only IDWContour ne reflète PAS les valeurs IDW interpolées du raster (incohérence visuelle isolines vs raster)
- [ ] AC2: Identifier le mécanisme qui fait disparaître les layers après ~60-300s SANS nouvelle requête réseau
- [ ] AC3: Proposer un fix concret pour chaque bug (peut être différents fixes)
- [ ] AC4: Validation visuelle via Playwright après deploy
