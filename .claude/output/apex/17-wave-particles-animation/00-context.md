# APEX Task: 17-wave-particles-animation

**Created:** 2026-05-19
**Task:** Représentation particules pour les vagues (pattern wind-particles adapté)

## User Request
> vagues, je pense que l'on pourrait avoir un mode de représentation comme les particules de vent (peut-être à adapter, car ce n'est pas la même ordre de grandeur)

## Différences vent vs vagues à considérer
- **Vent** : vecteur (vitesse + direction), particules drift avec vitesse 0-30 m/s
- **Vagues** : direction d'arrivée (wave-dir) + amplitude (wave-hs en m, 0-10m)
  - Période = lenteur du déplacement particles (différent de la vitesse drift vent)
  - L'animation doit refléter la propagation des houles (oscillation + drift)

## Pattern à adapter
- Cf `particlesEngine` (canvas WebGL) actuel pour wind
- 2 sources GS : wave-dir (direction) + wave-hs (hauteur en m)
- Layer signal `showWaveParticles` à ajouter
- Représentation : particules orientées par wave-dir, taille proportionnelle à wave-hs

## Effort estimé
~3-5h (depend de la qualité visuelle souhaitée).
