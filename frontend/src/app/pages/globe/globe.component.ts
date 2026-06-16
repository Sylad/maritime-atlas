/**
 * GlobeMapComponent — Phase 5a (2026-05-21) : nouvelle route /globe avec
 * MapLibre 5.24 projection sphère + WebGL wind particles (port sandbox).
 *
 * Choix Phase 5a (validé avec Sylvain) :
 *   - Cohabite avec map.component (OL) sur `/`. Pas de refacto MapEngine
 *     prématurée — on porte progressivement les layers d'ici aux sessions
 *     suivantes (SST, satellites, alerts, lightning, vessels…).
 *   - 2 layers démarrage : SST (raster WMS) + Wind (custom WebGL particles).
 *   - Toggle 2D/3D via lien header simple.
 */

import { CommonModule } from '@angular/common';
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  OnDestroy,
  signal,
  viewChild,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';

import { TimeSliderComponent, TimeSliderLayerCoverage } from '../../components/time-slider/time-slider.component';
import { IngestionMiniChartComponent } from '../../components/ingestion-mini-chart/ingestion-mini-chart.component';
import { AnimationPanelComponent } from '../../components/animation-panel/animation-panel.component';
import { AnimationControlsComponent } from '../../components/animation-controls/animation-controls.component';
import { AnimationPlayerService, type AnimationOptions } from '../../services/animation-player.service';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import maplibregl, {
  type CustomLayerInterface,
  type CustomRenderMethodInput,
  type Map as MapLibreMap,
} from 'maplibre-gl';

import { firstValueFrom } from 'rxjs';

import { ArrowsService } from '../../services/arrows.service';
import { AlertsService } from '../../services/alerts.service';
import { AuthService } from '../../services/auth.service';
import { LightningService } from '../../services/lightning.service';
import { PreferencesSyncService } from '../../services/preferences-sync.service';
import { RainviewerService } from '../../services/rainviewer.service';
import { VesselsService } from '../../services/vessels.service';
import { BuoysService } from '../../services/buoys.service';
import {
  buildWindTexture,
  speedDirToUv,
  WindWebGL,
  type MapLibreCustomLayerRenderArgs,
  type WindGridPoint,
} from './wind-webgl-history';

// Bbox du wind grid GFS Europe étroite (match les arrows prod).
const WIND_BBOX: [number, number, number, number] = [-15, 35, 30, 65];
const DEFAULT_WIND_PARTICLES = 3000;

/** Catalogue satellite — mirror partiel de map.component.SAT_PRODUCTS +
 *  CASCADE_PRODUCTS. Tous les layers sont sur GeoServer workspace `maritime`
 *  derrière /geoserver/aetherwx/wms.
 *  - NASA GIBS : `time` = jour YYYY-MM-DD (J-1 capped, lag ~24h).
 *  - Cascade EUMETSAT/radar : `time` = ISO horodatée (snap quasi-NRT).
 *  - `none` = pas de sat (default).
 */
type SatProduct = {
  key: string;
  label: string;
  gsName: string;
  /** G56 (2026-05-24) — workspace GS où le layer est publié. NASA GIBS
   *  sat dans `aetherwx-sat` (split pour accélérer GetCap principal),
   *  cascade EUMETSAT/radar dans `aetherwx`. */
  workspace: 'aetherwx' | 'aetherwx-sat';
  kind: 'gibs-daily' | 'cascade-realtime';
  attribution: string;
};
const SAT_PRODUCTS: SatProduct[] = [
  { key: 'satTrueColor',      label: 'Vrai couleur MODIS',         gsName: 'sat-modis-true-color',  workspace: 'aetherwx-sat', kind: 'gibs-daily',       attribution: 'NASA GIBS MODIS Terra' },
  { key: 'satTrueColorVIIRS', label: 'Vrai couleur VIIRS',         gsName: 'sat-viirs-true-color',  workspace: 'aetherwx-sat', kind: 'gibs-daily',       attribution: 'NASA GIBS VIIRS SNPP' },
  { key: 'satIR',             label: 'Infrarouge thermique',       gsName: 'sat-modis-ir',          workspace: 'aetherwx-sat', kind: 'gibs-daily',       attribution: 'NASA GIBS MODIS Band 31' },
  { key: 'satWaterVapor',     label: 'Température air',            gsName: 'sat-airs-air-temp',     workspace: 'aetherwx-sat', kind: 'gibs-daily',       attribution: 'NASA GIBS AIRS' },
  { key: 'satCloudTop',       label: 'Sommet des nuages',          gsName: 'sat-modis-cloud-top',   workspace: 'aetherwx-sat', kind: 'gibs-daily',       attribution: 'NASA GIBS MODIS' },
  { key: 'satAerosol',        label: 'Aérosols / poussières',      gsName: 'sat-modis-aerosol',     workspace: 'aetherwx-sat', kind: 'gibs-daily',       attribution: 'NASA GIBS MODIS AOD' },
  { key: 'satDayNight',       label: 'VIIRS jour/nuit',            gsName: 'sat-viirs-day-night',   workspace: 'aetherwx-sat', kind: 'gibs-daily',       attribution: 'NASA GIBS VIIRS DayNight' },
  { key: 'satEuIrRss',        label: 'EUMETSAT IR Europe (5 min)', gsName: 'sat-eu-ir-rss',         workspace: 'aetherwx',     kind: 'cascade-realtime', attribution: 'EUMETSAT MSG SEVIRI Rapid Scan' },
  { key: 'satGlobalIrMtg',    label: 'EUMETSAT MTG IR global',     gsName: 'sat-global-ir-mtg',     workspace: 'aetherwx',     kind: 'cascade-realtime', attribution: 'EUMETSAT MTG FCI' },
  { key: 'satEuHrvRgb',       label: 'EUMETSAT HRV RGB Europe',    gsName: 'sat-eu-hrv-rgb',        workspace: 'aetherwx',     kind: 'cascade-realtime', attribution: 'EUMETSAT MSG SEVIRI HRV' },
  { key: 'radarDwd',          label: 'Radar Allemagne (DWD)',      gsName: 'radar-dwd-de',          workspace: 'aetherwx',     kind: 'cascade-realtime', attribution: 'DWD Open Data Radar' },
  { key: 'radarKnmi',         label: 'Radar Pays-Bas (KNMI)',      gsName: 'radar-knmi-nl',         workspace: 'aetherwx',     kind: 'cascade-realtime', attribution: 'KNMI Open Geo Radar' },
];

/** Date du jour J-2 capped pour NASA GIBS (lag ~24-48h selon ingest GS).
 *  2026-05-22 — J-1 ne marche pas sur certains produits ("Could not find
 *  a match for time"). On utilise J-2 par sécurité. Format YYYY-MM-DD UTC. */
function gibsDailyDate(): string {
  const eff = new Date(Date.now() - 48 * 3_600_000);
  return `${eff.getUTCFullYear()}-${String(eff.getUTCMonth() + 1).padStart(2, '0')}-${String(eff.getUTCDate()).padStart(2, '0')}`;
}

@Component({
  selector: 'app-globe',
  standalone: true,
  imports: [CommonModule, RouterLink, TimeSliderComponent, IngestionMiniChartComponent, AnimationPanelComponent, AnimationControlsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="globe-root" [class.is-animating]="isAnimating()">
      <header class="globe-header">
        <div class="brand">
          <!-- G27 — click sur icon globe = toggle drawer (remplace ☰ et ✕).
               G64 (2026-05-24) — disabled pendant animation pour éviter
               qu'on rouvre le panneau et qu'on perturbe les couches. -->
          <button type="button" class="brand-icon-btn"
                  (click)="toggleLegend()"
                  [disabled]="isAnimating()"
                  [title]="isAnimating() ? 'Verrouillé pendant l\\'animation' : (legendOpen() ? 'Réduire les couches' : 'Afficher les couches')"
                  [attr.aria-expanded]="legendOpen()"
                  aria-label="Afficher / masquer le panneau des couches">
            <img src="/AetherWX_logo_tap.png" alt="" class="brand-icon-img" aria-hidden="true" />
          </button>
          <img src="/AetherWX_logo_text.png" alt="AetherWX" class="brand-text-img" />
          <span class="brand-mode">— Globe 3D <span class="brand-mode-pill">spike</span></span>
        </div>
        <!-- G64 (2026-05-24) — pendant animation : nav-links désactivés
             (pointer-events:none + opacity via .is-animating sur globe-root)
             pour empêcher navigation accidentelle ou logout en plein anim. -->
        <nav class="nav-links" [attr.aria-disabled]="isAnimating()"
             [title]="isAnimating() ? 'Navigation verrouillée pendant l\\'animation' : null">
          <a routerLink="/about" class="nav-link" [attr.tabindex]="isAnimating() ? -1 : null">À propos</a>
          <!-- G18 M15 (audit G-7) — auth corner -->
          <span class="nav-sep">·</span>
          @if (currentUser(); as u) {
            <a routerLink="/palettes" class="nav-link" [attr.tabindex]="isAnimating() ? -1 : null">{{ '@' + u.username }}</a>
            @if (u.role === 'admin') {
              <span class="nav-sep">·</span>
              <a routerLink="/admin/users" class="nav-link nav-admin-pill" title="Espace admin" [attr.tabindex]="isAnimating() ? -1 : null">ADMIN</a>
            }
            <span class="nav-sep">·</span>
            <button type="button" class="nav-btn" (click)="logout()" [disabled]="isAnimating()">Déconnexion</button>
          } @else {
            <a routerLink="/auth/login" class="nav-link" [attr.tabindex]="isAnimating() ? -1 : null">Connexion</a>
            <span class="nav-sep">·</span>
            <a routerLink="/auth/register" class="nav-link" [attr.tabindex]="isAnimating() ? -1 : null">Inscription</a>
          }
        </nav>
      </header>

      <div #mapContainer class="map-container"></div>

      <!-- G27 — hamburger retiré : le click sur l'icône globe du header
           toggle le drawer (cf .brand-icon-btn). -->


      <!-- G19 (2026-05-22) — Template panneau gauche porté à l'identique de
           /legacy-map (template + CSS) pour parité visuelle 100%. Bindings
           adaptés au modèle globe (showSst au lieu de showSST, etc.).
           G64 (2026-05-24) — masqué pendant animation (cf .legend--anim-hidden)
           pour libérer la vue map en mode lecture animation. -->
      <div class="legend data-catalog"
           [class.legend--closed]="!legendOpen()"
           [class.legend--anim-hidden]="isAnimating()">
        <!-- G27 — bouton ✕ retiré : le click sur l'icône globe header
             toggle le drawer (entry point unique). -->

        <!-- 2026-05-20 — Bouton ✕ close mobile : logo header caché donc plus
             de surface pour fermer le panneau. Visible uniquement ≤ 760px. -->
        <button type="button" class="legend-close-mobile"
                title="Fermer le panneau"
                aria-label="Fermer le panneau"
                (click)="toggleLegend()">✕</button>

        <!-- 2026-05-20 — Mode simple/avancé mobile (Sylvain). Toggle visible
             uniquement sur mobile ≤ 760px. -->
        <div class="mobile-mode-bar">
          <button type="button" class="mobile-mode-toggle"
                  (click)="mobileSimpleMode.set(!mobileSimpleMode())">
            {{ mobileSimpleMode() ? '⊕ Vue avancée' : '⊖ Vue simple' }}
          </button>
        </div>

        @if (mobileSimpleMode()) {
          <div class="essential-layers">
            <div class="essential-layers-title">Layers essentielles</div>
            <div class="essential-grid">
              <label class="essential-toggle" [class.active]="showVessels()">
                <input type="checkbox" [checked]="showVessels()" (change)="toggleVector('vessels')" />
                <span class="essential-icon">🚢</span>
                <span class="essential-label">Navires</span>
              </label>
              <label class="essential-toggle" [class.active]="showWind()">
                <input type="checkbox" [checked]="showWind()" (change)="toggleWind(!showWind())" />
                <span class="essential-icon">💨</span>
                <span class="essential-label">Vent</span>
              </label>
              <label class="essential-toggle" [class.active]="showRain()">
                <input type="checkbox" [checked]="showRain()" (change)="toggleRain(!showRain())" />
                <span class="essential-icon">🌧</span>
                <span class="essential-label">Pluie</span>
              </label>
              <label class="essential-toggle" [class.active]="showSatEuIrRss()">
                <input type="checkbox" [checked]="showSatEuIrRss()" (change)="toggleSatLayer('satEuIrRss', !showSatEuIrRss())" />
                <span class="essential-icon">🛰</span>
                <span class="essential-label">Sat IR</span>
              </label>
              <label class="essential-toggle" [class.active]="showLightning()"
                     [class.mode-incompatible]="!!layerModeWarning('lightning')"
                     [title]="layerModeWarning('lightning')">
                <input type="checkbox" [checked]="showLightning()" (change)="toggleVector('lightning')" />
                <span class="essential-icon">⚡</span>
                <span class="essential-label">Foudre</span>
              </label>
              <label class="essential-toggle" [class.active]="showAlerts()"
                     [class.mode-incompatible]="!!layerModeWarning('alerts')"
                     [title]="layerModeWarning('alerts')">
                <input type="checkbox" [checked]="showAlerts()" (change)="toggleVector('alerts')" />
                <span class="essential-icon">⚠</span>
                <span class="essential-label">Alertes</span>
              </label>
            </div>
            <p class="essential-hint">Tap "Vue avancée" pour toutes les layers + isolignes + opacité.</p>
          </div>
        }

        <div class="layer-toggles" [class.layer-toggles-hidden]="mobileSimpleMode()">
          <!-- Projection toggle (hors sections) -->
          <div class="layer-row projection-row">
            <div class="proj-buttons">
              <button type="button" class="proj-btn"
                [class.active]="projection() === 'globe'"
                (click)="setProjection('globe')">🌍 Globe</button>
              <button type="button" class="proj-btn"
                [class.active]="projection() === 'mercator'"
                (click)="setProjection('mercator')">🗺 Mercator</button>
            </div>
          </div>

          <!-- ═══ Section MARITIME ═══════════════════════════════════ -->
          <div class="catalog-section" [class.is-open]="catalogSections().maritime">
            <button type="button" class="catalog-section-head section-maritime"
                    (click)="toggleCatalogSection('maritime')"
                    [attr.aria-expanded]="catalogSections().maritime">
              <span class="head-chevron">{{ catalogSections().maritime ? '▼' : '▶' }}</span>
              <span class="head-icon">🌊</span>
              <span class="head-name">Maritime</span>
              <span class="head-count">{{ catalogSectionCount('maritime').active }}/{{ catalogSectionCount('maritime').total }}</span>
            </button>
            @if (catalogSections().maritime) {
            <div class="catalog-section-body">
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!vesselsActive()"
                       [class.mode-incompatible]="!!layerModeWarning('vessels')"
                       [title]="layerModeWarning('vessels')">
                  <input type="checkbox" [checked]="showVessels()" (change)="toggleVector('vessels')" />
                  <span class="toggle-glyph">
                    <span class="glyph-dot" style="background:#34d399;border-color:#6ee7b7"></span>
                    <span class="glyph-dot" style="background:#60a5fa;border-color:#93c5fd"></span>
                    <span class="glyph-dot" style="background:#f87171;border-color:#fca5a5"></span>
                  </span>
                  <span class="toggle-text">
                    <span class="toggle-name">Navires</span>
                    <span class="toggle-count">{{ vectorCounts()['vessels'] ?? 0 }} positions</span>
                  </span>
                </label>
                @if (showVessels()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getLayerOpacity('vessels')"
                         (input)="setLayerOpacity('vessels', +$any($event.target).value)" />
                }
              </div>
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!tracksActive()"
                       [class.mode-incompatible]="!!layerModeWarning('tracks')"
                       [title]="layerModeWarning('tracks')">
                  <input type="checkbox" [checked]="showTracks()" (change)="toggleTracks(!showTracks())" />
                  <span class="toggle-glyph">
                    <svg viewBox="0 0 24 12" width="24" height="12" aria-hidden="true">
                      <path d="M0,8 C5,2 10,11 14,5 S22,3 24,7" fill="none" stroke="rgba(45, 212, 191, 0.7)" stroke-width="1.5" />
                    </svg>
                  </span>
                  <span class="toggle-text">
                    <span class="toggle-name">Trajets</span>
                    <span class="toggle-count">{{ vectorCounts()['tracks'] ?? 0 }} polylines</span>
                  </span>
                </label>
                @if (showTracks()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getLayerOpacity('tracks')"
                         (input)="setLayerOpacity('tracks', +$any($event.target).value)" />
                }
              </div>
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!showAlerts()"
                       [class.mode-incompatible]="!!layerModeWarning('alerts')"
                       [title]="layerModeWarning('alerts')">
                  <input type="checkbox" [checked]="showAlerts()" (change)="toggleVector('alerts')" />
                  <span class="toggle-glyph">
                    <span class="glyph-alert">⚠</span>
                  </span>
                  <span class="toggle-text">
                    <span class="toggle-name">Alertes</span>
                    <span class="toggle-count">{{ vectorCounts()['alerts'] ?? 0 }} actives</span>
                  </span>
                </label>
                @if (showAlerts()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getLayerOpacity('alerts')"
                         (input)="setLayerOpacity('alerts', +$any($event.target).value)" />
                }
              </div>
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!showBuoys()"
                       [class.mode-incompatible]="!!layerModeWarning('buoys')"
                       [title]="layerModeWarning('buoys')">
                  <input type="checkbox" [checked]="showBuoys()" (change)="toggleVector('buoys')" />
                  <span class="toggle-glyph">
                    <span class="glyph-buoy">⚓</span>
                  </span>
                  <span class="toggle-text">
                    <span class="toggle-name">Plateformes vagues</span>
                    <span class="toggle-count">{{ vectorCounts()['buoys'] ?? 0 }} stations</span>
                  </span>
                </label>
                @if (showBuoys()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getLayerOpacity('buoys')"
                         (input)="setLayerOpacity('buoys', +$any($event.target).value)" />
                }
              </div>
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!sstActive()">
                  <input type="checkbox" [checked]="showSst()" (change)="toggleSst(!showSst())" />
                  <span class="toggle-glyph">
                    <span class="glyph-gradient"></span>
                  </span>
                  <span class="toggle-text">
                    <span class="toggle-name">SST</span>
                    <span class="toggle-count">température mer (NOAA)</span>
                  </span>
                </label>
                @if (showSst()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getLayerOpacity('sst')"
                         (input)="setLayerOpacity('sst', +$any($event.target).value)" />
                }
                <!-- isolignes SST -->
                <div class="contour-control">
                  <label class="contour-toggle">
                    <input type="checkbox" [checked]="showSstContours()" (change)="toggleSstContours(!showSstContours())" />
                    <span>Isolignes</span>
                  </label>
                  @if (showSstContours()) {
                    <input class="layer-opacity layer-opacity-contour" type="range" min="0" max="1" step="0.05" title="Opacité isolignes"
                           [value]="getLayerOpacity('sstContours')"
                           (input)="setLayerOpacity('sstContours', +$any($event.target).value)" />
                  }
                </div>
              </div>
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!showWavesForecast()">
                  <input type="checkbox" [checked]="showWavesForecast()" (change)="toggleWavesForecast(!showWavesForecast())" />
                  <span class="toggle-glyph">
                    <span class="glyph-waves"></span>
                  </span>
                  <span class="toggle-text">
                    <span class="toggle-name">Vagues</span>
                    <span class="toggle-count">hauteur sig. (WW3)</span>
                  </span>
                </label>
                @if (showWavesForecast()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getLayerOpacity('wavesForecast')"
                         (input)="setLayerOpacity('wavesForecast', +$any($event.target).value)" />
                }
                <div class="contour-control">
                  <label class="contour-toggle">
                    <input type="checkbox" [checked]="showWaveContours()" (change)="toggleWaveContours(!showWaveContours())" />
                    <span>Isolignes</span>
                  </label>
                  @if (showWaveContours()) {
                    <input class="layer-opacity layer-opacity-contour" type="range" min="0" max="1" step="0.05" title="Opacité isolignes"
                           [value]="getLayerOpacity('waveContours')"
                           (input)="setLayerOpacity('waveContours', +$any($event.target).value)" />
                  }
                </div>
              </div>
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!showWaveArrows()">
                  <input type="checkbox" [checked]="showWaveArrows()" (change)="toggleWaveArrows(!showWaveArrows())" />
                  <span class="toggle-glyph">
                    <span class="glyph-arrow glyph-arrow-wave">↑</span>
                  </span>
                  <span class="toggle-text">
                    <span class="toggle-name">Vagues flèches</span>
                    <span class="toggle-count">direction houle</span>
                  </span>
                </label>
                @if (showWaveArrows()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getLayerOpacity('waveArrows')"
                         (input)="setLayerOpacity('waveArrows', +$any($event.target).value)" />
                }
              </div>
            </div>
            }
          </div>

          <!-- ═══ Section OBSERVATION ════════════════════════════════ -->
          <div class="catalog-section" [class.is-open]="catalogSections().observation">
            <button type="button" class="catalog-section-head section-observation"
                    (click)="toggleCatalogSection('observation')"
                    [attr.aria-expanded]="catalogSections().observation">
              <span class="head-chevron">{{ catalogSections().observation ? '▼' : '▶' }}</span>
              <span class="head-icon">👁</span>
              <span class="head-name">Observation</span>
              <span class="head-count">{{ catalogSectionCount('observation').active }}/{{ catalogSectionCount('observation').total }}</span>
            </button>
            @if (catalogSections().observation) {
            <div class="catalog-section-body">
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!showLightning()"
                       [class.mode-incompatible]="!!layerModeWarning('lightning')"
                       [title]="layerModeWarning('lightning')">
                  <input type="checkbox" [checked]="showLightning()" (change)="toggleVector('lightning')" />
                  <span class="toggle-glyph">
                    <span class="glyph-zap">⚡</span>
                  </span>
                  <span class="toggle-text">
                    <span class="toggle-name">Foudre</span>
                    <span class="toggle-count">{{ vectorCounts()['lightning'] ?? 0 }} strikes 30 min</span>
                  </span>
                </label>
                @if (showLightning()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getLayerOpacity('lightning')"
                         (input)="setLayerOpacity('lightning', +$any($event.target).value)" />
                }
              </div>
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!showMetar()"
                       [class.mode-incompatible]="!!layerModeWarning('metar')"
                       [title]="layerModeWarning('metar')">
                  <input type="checkbox" [checked]="showMetar()" (change)="toggleVector('metar')" />
                  <span class="toggle-glyph"><span class="glyph-icon">🛬</span></span>
                  <span class="toggle-text">
                    <span class="toggle-name">METAR aéroports</span>
                    <span class="toggle-count">{{ vectorCounts()['metar'] ?? 0 }} stations</span>
                  </span>
                </label>
                @if (showMetar()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getLayerOpacity('metar')"
                         (input)="setLayerOpacity('metar', +$any($event.target).value)" />
                }
              </div>
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!showQuakes()"
                       [class.mode-incompatible]="!!layerModeWarning('quakes')"
                       [title]="layerModeWarning('quakes')">
                  <input type="checkbox" [checked]="showQuakes()" (change)="toggleVector('quakes')" />
                  <span class="toggle-glyph"><span class="glyph-icon">🌋</span></span>
                  <span class="toggle-text">
                    <span class="toggle-name">Séismes USGS</span>
                    <span class="toggle-count">{{ vectorCounts()['quakes'] ?? 0 }} events</span>
                  </span>
                </label>
                @if (showQuakes()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getLayerOpacity('quakes')"
                         (input)="setLayerOpacity('quakes', +$any($event.target).value)" />
                }
              </div>
              <!-- G66 (2026-05-27) — SIGMET / AIRMET impl : fetch direct
                   aviationweather.gov GeoJSON (CORS ouvert). Vector polygons + lines. -->
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!showSigmet()">
                  <input type="checkbox" [checked]="showSigmet()" (change)="toggleVector('sigmet')" />
                  <span class="toggle-glyph"><span class="glyph-icon">⚠</span></span>
                  <span class="toggle-text">
                    <span class="toggle-name">SIGMET / AIRMET</span>
                    <span class="toggle-count">{{ vectorCounts()['sigmet'] ?? 0 }} avertissements aéro</span>
                  </span>
                </label>
                @if (showSigmet()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getLayerOpacity('sigmet')"
                         (input)="setLayerOpacity('sigmet', +$any($event.target).value)" />
                }
              </div>
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!showFirms()"
                       [class.mode-incompatible]="!!layerModeWarning('firms')"
                       [title]="layerModeWarning('firms')">
                  <input type="checkbox" [checked]="showFirms()" (change)="toggleVector('firms')" />
                  <span class="toggle-glyph"><span class="glyph-icon">🔥</span></span>
                  <span class="toggle-text">
                    <span class="toggle-name">Feux NASA FIRMS</span>
                    <span class="toggle-count">{{ vectorCounts()['firms'] ?? 0 }} hotspots</span>
                  </span>
                </label>
                @if (showFirms()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getLayerOpacity('firms')"
                         (input)="setLayerOpacity('firms', +$any($event.target).value)" />
                }
              </div>
            </div>
            }
          </div>

          <!-- ═══ Section SATELLITES (NASA GIBS + EUMETSAT) ══════════ -->
          <div class="catalog-section" [class.is-open]="catalogSections().satellites">
            <button type="button" class="catalog-section-head section-satellites"
                    (click)="toggleCatalogSection('satellites')"
                    [attr.aria-expanded]="catalogSections().satellites">
              <span class="head-chevron">{{ catalogSections().satellites ? '▼' : '▶' }}</span>
              <span class="head-icon">🛰</span>
              <span class="head-name">Satellites</span>
              <span class="head-count">{{ catalogSectionCount('satellites').active }}/{{ catalogSectionCount('satellites').total }}</span>
            </button>
            @if (catalogSections().satellites) {
            <div class="catalog-section-body">
              <div class="sat-date-label" title="Date d'imagerie satellite — suit le cursor time-slider">
                📅 Imagerie du {{ currentSatDate() }}
              </div>
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!showSatTrueColor()">
                  <input type="checkbox" [checked]="showSatTrueColor()" (change)="toggleSatLayer('satTrueColor', !showSatTrueColor())" />
                  <span class="toggle-glyph"><span class="glyph-icon">🌍</span></span>
                  <span class="toggle-text">
                    <span class="toggle-name">Vrai couleur MODIS</span>
                    <span class="toggle-count">Terra · daily VIS</span>
                  </span>
                </label>
                @if (showSatTrueColor()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getLayerOpacity('satTrueColor')"
                         (input)="setLayerOpacity('satTrueColor', +$any($event.target).value)" />
                }
              </div>
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!showSatTrueColorVIIRS()">
                  <input type="checkbox" [checked]="showSatTrueColorVIIRS()" (change)="toggleSatLayer('satTrueColorVIIRS', !showSatTrueColorVIIRS())" />
                  <span class="toggle-glyph"><span class="glyph-icon">🌐</span></span>
                  <span class="toggle-text">
                    <span class="toggle-name">Vrai couleur VIIRS</span>
                    <span class="toggle-count">SNPP · daily VIS HD</span>
                  </span>
                </label>
                @if (showSatTrueColorVIIRS()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getLayerOpacity('satTrueColorVIIRS')"
                         (input)="setLayerOpacity('satTrueColorVIIRS', +$any($event.target).value)" />
                }
              </div>
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!showSatIR()">
                  <input type="checkbox" [checked]="showSatIR()" (change)="toggleSatLayer('satIR', !showSatIR())" />
                  <span class="toggle-glyph"><span class="glyph-icon">🔥</span></span>
                  <span class="toggle-text">
                    <span class="toggle-name">Infrarouge thermique</span>
                    <span class="toggle-count">MODIS · band 31 day</span>
                  </span>
                </label>
                @if (showSatIR()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getLayerOpacity('satIR')"
                         (input)="setLayerOpacity('satIR', +$any($event.target).value)" />
                }
              </div>
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!showSatWaterVapor()">
                  <input type="checkbox" [checked]="showSatWaterVapor()" (change)="toggleSatLayer('satWaterVapor', !showSatWaterVapor())" />
                  <span class="toggle-glyph"><span class="glyph-icon">💧</span></span>
                  <span class="toggle-text">
                    <span class="toggle-name">Température air (proxy évap.)</span>
                    <span class="toggle-count">AIRS · surface air temp</span>
                  </span>
                </label>
                @if (showSatWaterVapor()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getLayerOpacity('satWaterVapor')"
                         (input)="setLayerOpacity('satWaterVapor', +$any($event.target).value)" />
                }
              </div>
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!showSatCloudTop()">
                  <input type="checkbox" [checked]="showSatCloudTop()" (change)="toggleSatLayer('satCloudTop', !showSatCloudTop())" />
                  <span class="toggle-glyph"><span class="glyph-icon">☁</span></span>
                  <span class="toggle-text">
                    <span class="toggle-name">Sommet des nuages</span>
                    <span class="toggle-count">MODIS · pression top</span>
                  </span>
                </label>
                @if (showSatCloudTop()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getLayerOpacity('satCloudTop')"
                         (input)="setLayerOpacity('satCloudTop', +$any($event.target).value)" />
                }
              </div>
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!showSatAerosol()">
                  <input type="checkbox" [checked]="showSatAerosol()" (change)="toggleSatLayer('satAerosol', !showSatAerosol())" />
                  <span class="toggle-glyph"><span class="glyph-icon">💨</span></span>
                  <span class="toggle-text">
                    <span class="toggle-name">Aérosols / poussières</span>
                    <span class="toggle-count">MODIS · AOD combiné</span>
                  </span>
                </label>
                @if (showSatAerosol()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getLayerOpacity('satAerosol')"
                         (input)="setLayerOpacity('satAerosol', +$any($event.target).value)" />
                }
              </div>
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!showSatDayNight()">
                  <input type="checkbox" [checked]="showSatDayNight()" (change)="toggleSatLayer('satDayNight', !showSatDayNight())" />
                  <span class="toggle-glyph"><span class="glyph-icon">🌙</span></span>
                  <span class="toggle-text">
                    <span class="toggle-name">VIIRS jour/nuit</span>
                    <span class="toggle-count">lumières urbaines + navires</span>
                  </span>
                </label>
                @if (showSatDayNight()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getLayerOpacity('satDayNight')"
                         (input)="setLayerOpacity('satDayNight', +$any($event.target).value)" />
                }
              </div>
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!showSatRainviewer()">
                  <input type="checkbox" [checked]="showSatRainviewer()" (change)="toggleSatRainviewer(!showSatRainviewer())" />
                  <span class="toggle-glyph"><span class="glyph-icon">☁</span></span>
                  <span class="toggle-text">
                    <span class="toggle-name">Satellite IR (RainViewer)</span>
                    <span class="toggle-count">global · NRT 10 min</span>
                  </span>
                </label>
                @if (showSatRainviewer()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getLayerOpacity('satRainviewer')"
                         (input)="setLayerOpacity('satRainviewer', +$any($event.target).value)" />
                }
              </div>
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!showSatEuIrRss()">
                  <input type="checkbox" [checked]="showSatEuIrRss()" (change)="toggleSatLayer('satEuIrRss', !showSatEuIrRss())" />
                  <span class="toggle-glyph"><span class="glyph-icon">🌡</span></span>
                  <span class="toggle-text">
                    <span class="toggle-name">IR Europe (5 min)</span>
                    <span class="toggle-count">EUMETSAT MSG RSS</span>
                  </span>
                </label>
                @if (showSatEuIrRss()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getLayerOpacity('satEuIrRss')"
                         (input)="setLayerOpacity('satEuIrRss', +$any($event.target).value)" />
                }
              </div>
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!showSatGlobalIrMtg()">
                  <input type="checkbox" [checked]="showSatGlobalIrMtg()" (change)="toggleSatLayer('satGlobalIrMtg', !showSatGlobalIrMtg())" />
                  <span class="toggle-glyph"><span class="glyph-icon">🌐</span></span>
                  <span class="toggle-text">
                    <span class="toggle-name">IR global (10 min)</span>
                    <span class="toggle-count">EUMETSAT MTG FCI</span>
                  </span>
                </label>
                @if (showSatGlobalIrMtg()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getLayerOpacity('satGlobalIrMtg')"
                         (input)="setLayerOpacity('satGlobalIrMtg', +$any($event.target).value)" />
                }
              </div>
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!showSatEuHrvRgb()">
                  <input type="checkbox" [checked]="showSatEuHrvRgb()" (change)="toggleSatLayer('satEuHrvRgb', !showSatEuHrvRgb())" />
                  <span class="toggle-glyph"><span class="glyph-icon">☀</span></span>
                  <span class="toggle-text">
                    <span class="toggle-name">Visible HRV RGB Europe (15 min)</span>
                    <span class="toggle-count">EUMETSAT MSG SEVIRI HRV</span>
                  </span>
                </label>
                @if (showSatEuHrvRgb()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getLayerOpacity('satEuHrvRgb')"
                         (input)="setLayerOpacity('satEuHrvRgb', +$any($event.target).value)" />
                }
              </div>
              @if (currentSatAttribution()) {
                <div class="legend-section-title" style="margin-top:0.6em;">{{ currentSatAttribution() }}</div>
              }
            </div>
            }
          </div>

          <!-- ═══ Section RADAR ═══════════════════════════════════════ -->
          <div class="catalog-section" [class.is-open]="catalogSections().radar">
            <button type="button" class="catalog-section-head section-radar"
                    (click)="toggleCatalogSection('radar')"
                    [attr.aria-expanded]="catalogSections().radar">
              <span class="head-chevron">{{ catalogSections().radar ? '▼' : '▶' }}</span>
              <span class="head-icon">📡</span>
              <span class="head-name">Radar</span>
              <span class="head-count">{{ catalogSectionCount('radar').active }}/{{ catalogSectionCount('radar').total }}</span>
            </button>
            @if (catalogSections().radar) {
            <div class="catalog-section-body">
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!showRain()">
                  <input type="checkbox" [checked]="showRain()" (change)="toggleRain(!showRain())" />
                  <span class="toggle-glyph"><span class="glyph-icon">🌧</span></span>
                  <span class="toggle-text">
                    <span class="toggle-name">Précipitations RainViewer</span>
                    <span class="toggle-count">radar global NRT</span>
                  </span>
                </label>
                @if (showRain()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getLayerOpacity('rain')"
                         (input)="setLayerOpacity('rain', +$any($event.target).value)" />
                }
              </div>
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!showRadarDwd()">
                  <input type="checkbox" [checked]="showRadarDwd()" (change)="toggleSatLayer('radarDwd', !showRadarDwd())" />
                  <span class="toggle-glyph"><span class="glyph-icon">🇩🇪</span></span>
                  <span class="toggle-text">
                    <span class="toggle-name">Radar Allemagne (5 min)</span>
                    <span class="toggle-count">DWD Open Data</span>
                  </span>
                </label>
                @if (showRadarDwd()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getLayerOpacity('radarDwd')"
                         (input)="setLayerOpacity('radarDwd', +$any($event.target).value)" />
                }
              </div>
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!showRadarKnmi()">
                  <input type="checkbox" [checked]="showRadarKnmi()" (change)="toggleSatLayer('radarKnmi', !showRadarKnmi())" />
                  <span class="toggle-glyph"><span class="glyph-icon">🇳🇱</span></span>
                  <span class="toggle-text">
                    <span class="toggle-name">Radar Pays-Bas (5 min)</span>
                    <span class="toggle-count">KNMI Open Geo</span>
                  </span>
                </label>
                @if (showRadarKnmi()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getLayerOpacity('radarKnmi')"
                         (input)="setLayerOpacity('radarKnmi', +$any($event.target).value)" />
                }
              </div>
            </div>
            }
          </div>

          <!-- ═══ Section FORECAST ═══════════════════════════════════ -->
          <div class="catalog-section" [class.is-open]="catalogSections().forecast">
            <button type="button" class="catalog-section-head section-forecast"
                    (click)="toggleCatalogSection('forecast')"
                    [attr.aria-expanded]="catalogSections().forecast">
              <span class="head-chevron">{{ catalogSections().forecast ? '▼' : '▶' }}</span>
              <span class="head-icon">🌤</span>
              <span class="head-name">Forecast</span>
              <span class="head-count">{{ catalogSectionCount('forecast').active }}/{{ catalogSectionCount('forecast').total }}</span>
            </button>
            @if (catalogSections().forecast) {
            <div class="catalog-section-body">
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!windActive()">
                  <input type="checkbox" [checked]="showWindForecast()" (change)="toggleWindForecast(!showWindForecast())" />
                  <span class="toggle-glyph">
                    <span class="glyph-wind"></span>
                  </span>
                  <span class="toggle-text">
                    <span class="toggle-name">Vent</span>
                    <span class="toggle-count">GFS · raster</span>
                  </span>
                </label>
                @if (showWindForecast()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getLayerOpacity('windForecast')"
                         (input)="setLayerOpacity('windForecast', +$any($event.target).value)" />
                }
                <div class="contour-control">
                  <label class="contour-toggle">
                    <input type="checkbox" [checked]="showWindContours()" (change)="toggleWindContours(!showWindContours())" />
                    <span>Isolignes</span>
                  </label>
                  @if (showWindContours()) {
                    <input class="layer-opacity layer-opacity-contour" type="range" min="0" max="1" step="0.05" title="Opacité isolignes"
                           [value]="getLayerOpacity('windContours')"
                           (input)="setLayerOpacity('windContours', +$any($event.target).value)" />
                  }
                </div>
              </div>
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!showWindArrows()">
                  <input type="checkbox" [checked]="showWindArrows()" (change)="toggleWindArrows(!showWindArrows())" />
                  <span class="toggle-glyph">
                    <span class="glyph-arrow glyph-arrow-wind">↑</span>
                  </span>
                  <span class="toggle-text">
                    <span class="toggle-name">Vent flèches</span>
                    <span class="toggle-count">GFS · direction</span>
                  </span>
                </label>
                @if (showWindArrows()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getLayerOpacity('windArrows')"
                         (input)="setLayerOpacity('windArrows', +$any($event.target).value)" />
                }
              </div>
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!showWind()">
                  <input type="checkbox" [checked]="showWind()" (change)="toggleWind(!showWind())" />
                  <span class="toggle-glyph">
                    <span class="glyph-particles">∿∿∿</span>
                  </span>
                  <span class="toggle-text">
                    <span class="toggle-name">Vent particules</span>
                    <span class="toggle-count">WebGL · {{ DEFAULT_WIND_PARTICLES }} pts</span>
                  </span>
                </label>
                @if (showWind()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getLayerOpacity('windParticles')"
                         (input)="setLayerOpacity('windParticles', +$any($event.target).value)" />
                }
              </div>
              <!-- G66 (2026-05-27) — placeholders V2 paramètres météo activés.
                   4 layers Forecast GFS scaffold côté frontend (WMS time-driven).
                   Les coverages GS aetherwx:temp-2m / pressure-msl / humidity-2m /
                   precipitation-6h doivent être publiées par weather-fetcher pour
                   afficher de la data. Sinon : tiles vides silencieuses. -->
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!showTemp2m()">
                  <input type="checkbox" [checked]="showTemp2m()" (change)="toggleTemp2m(!showTemp2m())" />
                  <span class="toggle-glyph"><span class="glyph-icon">🌡</span></span>
                  <span class="toggle-text">
                    <span class="toggle-name">Température 2m</span>
                    <span class="toggle-count">GFS · raster · scaffold</span>
                  </span>
                </label>
                @if (showTemp2m()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getLayerOpacity('temp2m')"
                         (input)="setLayerOpacity('temp2m', +$any($event.target).value)" />
                }
              </div>
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!showPressureMsl()">
                  <input type="checkbox" [checked]="showPressureMsl()" (change)="togglePressureMsl(!showPressureMsl())" />
                  <span class="toggle-glyph"><span class="glyph-icon">⊙</span></span>
                  <span class="toggle-text">
                    <span class="toggle-name">Pression MSL</span>
                    <span class="toggle-count">isobares + dépressions · scaffold</span>
                  </span>
                </label>
                @if (showPressureMsl()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getLayerOpacity('pressureMsl')"
                         (input)="setLayerOpacity('pressureMsl', +$any($event.target).value)" />
                }
              </div>
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!showHumidity()">
                  <input type="checkbox" [checked]="showHumidity()" (change)="toggleHumidity(!showHumidity())" />
                  <span class="toggle-glyph"><span class="glyph-icon">💧</span></span>
                  <span class="toggle-text">
                    <span class="toggle-name">Humidité</span>
                    <span class="toggle-count">relative 2m · scaffold</span>
                  </span>
                </label>
                @if (showHumidity()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getLayerOpacity('humidity')"
                         (input)="setLayerOpacity('humidity', +$any($event.target).value)" />
                }
              </div>
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!showPrecipitation()">
                  <input type="checkbox" [checked]="showPrecipitation()" (change)="togglePrecipitation(!showPrecipitation())" />
                  <span class="toggle-glyph"><span class="glyph-icon">🌧</span></span>
                  <span class="toggle-text">
                    <span class="toggle-name">Précipitations</span>
                    <span class="toggle-count">forecast cumul 6h · scaffold</span>
                  </span>
                </label>
                @if (showPrecipitation()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getLayerOpacity('precipitation')"
                         (input)="setLayerOpacity('precipitation', +$any($event.target).value)" />
                }
              </div>
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!showTaf()">
                  <input type="checkbox" [checked]="showTaf()" (change)="toggleVector('taf')" />
                  <span class="toggle-glyph"><span class="glyph-icon">✈</span></span>
                  <span class="toggle-text">
                    <span class="toggle-name">TAF</span>
                    <span class="toggle-count">{{ vectorCounts()['taf'] ?? 0 }} aéroports</span>
                  </span>
                </label>
                @if (showTaf()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getLayerOpacity('taf')"
                         (input)="setLayerOpacity('taf', +$any($event.target).value)" />
                }
              </div>
            </div>
            }
          </div>

          <!-- ═══ Section HYDROLOGIE ═════════════════════════════════ -->
          <div class="catalog-section" [class.is-open]="catalogSections().hydrology">
            <button type="button" class="catalog-section-head section-hydrology"
                    (click)="toggleCatalogSection('hydrology')"
                    [attr.aria-expanded]="catalogSections().hydrology">
              <span class="head-chevron">{{ catalogSections().hydrology ? '▼' : '▶' }}</span>
              <span class="head-icon">💧</span>
              <span class="head-name">Hydrologie</span>
              <span class="head-count">{{ catalogSectionCount('hydrology').active }}/{{ catalogSectionCount('hydrology').total }}</span>
            </button>
            @if (catalogSections().hydrology) {
            <div class="catalog-section-body">
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!showHubeau()"
                       [class.mode-incompatible]="!!layerModeWarning('hubeau')"
                       [title]="layerModeWarning('hubeau')">
                  <input type="checkbox" [checked]="showHubeau()" (change)="toggleVector('hubeau')" />
                  <span class="toggle-glyph"><span class="glyph-icon">≈</span></span>
                  <span class="toggle-text">
                    <span class="toggle-name">Débits rivières FR</span>
                    <span class="toggle-count">{{ vectorCounts()['hubeau'] ?? 0 }} stations</span>
                  </span>
                </label>
                @if (showHubeau()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getLayerOpacity('hubeau')"
                         (input)="setLayerOpacity('hubeau', +$any($event.target).value)" />
                }
              </div>
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!showPiezo()"
                       [class.mode-incompatible]="!!layerModeWarning('piezo')"
                       [title]="layerModeWarning('piezo')">
                  <input type="checkbox" [checked]="showPiezo()" (change)="toggleVector('piezo')" />
                  <span class="toggle-glyph"><span class="glyph-icon">🪣</span></span>
                  <span class="toggle-text">
                    <span class="toggle-name">Niveaux piézo FR</span>
                    <span class="toggle-count">{{ vectorCounts()['piezo'] ?? 0 }} stations</span>
                  </span>
                </label>
                @if (showPiezo()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getLayerOpacity('piezo')"
                         (input)="setLayerOpacity('piezo', +$any($event.target).value)" />
                }
              </div>
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!showGlofas()"
                       title="GloFAS river discharge forecast — Copernicus EWDS (débit rivières, prévision crues 7j)">
                  <input type="checkbox" [checked]="showGlofas()" (change)="toggleGlofas(!showGlofas())" />
                  <span class="toggle-glyph"><span class="glyph-icon">🌊</span></span>
                  <span class="toggle-text">
                    <span class="toggle-name">GloFAS forecast crues</span>
                    <span class="toggle-count">Copernicus EWDS · forecast 7j</span>
                  </span>
                </label>
                @if (showGlofas()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getLayerOpacity('glofas')"
                         (input)="setLayerOpacity('glofas', +$any($event.target).value)" />
                }
              </div>
              <div class="layer-row layer-soon">
                <label class="layer-toggle dim">
                  <input type="checkbox" disabled />
                  <span class="toggle-glyph"><span class="glyph-icon">⚗</span></span>
                  <span class="toggle-text">
                    <span class="toggle-name">Qualité eau <span class="soon-tag">à venir</span></span>
                    <span class="toggle-count">EEA WISE masses d'eau</span>
                  </span>
                </label>
              </div>
            </div>
            }
          </div>

          <!-- ═══ Section SOURCES ════════════════════════════════════ -->
          <div class="catalog-section" [class.is-open]="catalogSections().sources">
            <button type="button" class="catalog-section-head section-sources"
                    (click)="toggleCatalogSection('sources')"
                    [attr.aria-expanded]="catalogSections().sources">
              <span class="head-chevron">{{ catalogSections().sources ? '▼' : '▶' }}</span>
              <span class="head-icon">🗺</span>
              <span class="head-name">Sources</span>
              <span class="head-count">{{ catalogSectionCount('sources').active }}/{{ catalogSectionCount('sources').total }}</span>
            </button>
            @if (catalogSections().sources) {
            <div class="catalog-section-body">
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!showBathy()">
                  <input type="checkbox" [checked]="showBathy()" (change)="toggleBathy(!showBathy())" />
                  <span class="toggle-glyph"><span class="glyph-icon">≋</span></span>
                  <span class="toggle-text">
                    <span class="toggle-name">Bathymétrie</span>
                    <span class="toggle-count">EMODnet mean atlas</span>
                  </span>
                </label>
                @if (showBathy()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getLayerOpacity('bathy')"
                         (input)="setLayerOpacity('bathy', +$any($event.target).value)" />
                }
              </div>
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!showEez()">
                  <input type="checkbox" [checked]="showEez()" (change)="toggleEez(!showEez())" />
                  <span class="toggle-glyph"><span class="glyph-icon">⛓</span></span>
                  <span class="toggle-text">
                    <span class="toggle-name">EEZ (zones éco. excl.)</span>
                    <span class="toggle-count">Marine Regions VLIZ</span>
                  </span>
                </label>
                @if (showEez()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getLayerOpacity('eez')"
                         (input)="setLayerOpacity('eez', +$any($event.target).value)" />
                }
              </div>
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!showMpa()">
                  <input type="checkbox" [checked]="showMpa()" (change)="toggleMpa(!showMpa())" />
                  <span class="toggle-glyph"><span class="glyph-icon">🦑</span></span>
                  <span class="toggle-text">
                    <span class="toggle-name">MPA (aires marines)</span>
                    <span class="toggle-count">EMODnet Human Activities</span>
                  </span>
                </label>
                @if (showMpa()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getLayerOpacity('mpa')"
                         (input)="setLayerOpacity('mpa', +$any($event.target).value)" />
                }
              </div>
              <!-- G66 (2026-05-27) — Câbles sous-marins impl. Source =
                   submarinecablemap.com (TeleGeography GeoJSON public, CORS ouvert
                   sur cdn.submarinecablemap.com). MapLibre line layer #f59e0b. -->
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!showCables()">
                  <input type="checkbox" [checked]="showCables()" (change)="toggleVector('cables')" />
                  <span class="toggle-glyph"><span class="glyph-icon">━</span></span>
                  <span class="toggle-text">
                    <span class="toggle-name">Câbles sous-marins</span>
                    <span class="toggle-count">{{ vectorCounts()['cables'] ?? 0 }} câbles · TeleGeography</span>
                  </span>
                </label>
              </div>
              <!-- G66f (2026-05-27) — FIR/UIR airspaces (OpenAIP via API NestJS,
                   PostGIS table fir_airspaces, sync weekly cron). -->
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!showFir()">
                  <input type="checkbox" [checked]="showFir()" (change)="toggleVector('fir')" />
                  <span class="toggle-glyph"><span class="glyph-icon">✈</span></span>
                  <span class="toggle-text">
                    <span class="toggle-name">FIR / UIR airspaces</span>
                    <span class="toggle-count">{{ vectorCounts()['fir'] ?? 0 }} zones · VATSpy</span>
                  </span>
                </label>
                @if (showFir()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getLayerOpacity('fir')"
                         (input)="setLayerOpacity('fir', +$any($event.target).value)" />
                }
              </div>
              <!-- G66l (2026-05-27) — Airports IATA commerciaux (OpenAIP via API
                   NestJS, PostGIS table airports, sync weekly cron). Cluster. -->
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!showAirports()">
                  <input type="checkbox" [checked]="showAirports()" (change)="toggleVector('airports')" />
                  <span class="toggle-glyph"><span class="glyph-icon">✈</span></span>
                  <span class="toggle-text">
                    <span class="toggle-name">Aéroports (IATA)</span>
                    <span class="toggle-count">{{ vectorCounts()['airports'] ?? 0 }} aéroports · OpenAIP</span>
                  </span>
                </label>
              </div>
            </div>
            }
          </div>

          <!-- Reset button : restaure les défauts visibility + opacity -->
          <button type="button" class="layer-reset" (click)="resetLayerPrefs()" title="Restaure l'affichage par défaut">
            ↺ Réinitialiser l'affichage
          </button>
        </div>

        <!-- 2026-05-19 — warning cap5 (>5 layers actifs) inline. -->
        @if (cap5Warning(); as msg) {
          <div class="cap5-inline" role="status">⚠ {{ msg }}</div>
        }

        <div class="legend-stats">
          <div class="legend-mode"
               [class.live]="modeIsLive()"
               [class.future]="modeIsFuture()"
               [title]="modeIsLive()
                 ? 'Cursor sur le temps réel — données live'
                 : modeIsFuture()
                   ? 'Cursor dans le futur — affichage forecast (wind/wave)'
                   : 'Cursor dans le passé — affichage archive (replay)'">
            @if (modeIsLive()) { ● LIVE }
            @else if (modeIsFuture()) { ◷ FORECAST }
            @else { ◷ REPLAY }
          </div>
          @if (lastRefreshAt()) {
            <div class="legend-refresh">refresh {{ lastRefreshAt() | date:'HH:mm:ss' }}</div>
          }
          @if (windError()) {
            <div class="legend-error">{{ windError() }}</div>
          }
        </div>

        <!-- G20 (2026-05-22) — Mini-graph ingestion 24h (parité /legacy-map) -->
        <div class="legend-section-title legend-ingestion-title">Ingestion 24h</div>
        <app-ingestion-mini-chart />
      </div>

      <div class="fps" aria-label="frames per second">FPS {{ fps() }}</div>

      <!-- G18 M5 — Alerts feed panel (parité /legacy-map, 10 dernières alertes). -->
      @if (showAlerts() && alertsList().length > 0) {
        <aside class="alerts-panel" aria-label="Alertes actives">
          <div class="alerts-panel-title">Alertes actives ({{ alertsList().length }})</div>
          <div class="alerts-feed">
            @for (a of alertsList().slice(0, 10); track a.id) {
              <div class="alert-item" [class.danger]="a.severity === 'danger'" [class.warning]="a.severity === 'warning'">
                <div class="alert-head">
                  <span class="alert-kind">{{ alertKindLabel(a.kind) }}</span>
                  <span class="alert-age">{{ formatAge(a.age_seconds) }}</span>
                </div>
                <div class="alert-meta">
                  {{ a.vessel_name || ('MMSI ' + a.mmsi) }}
                  @if (a.kind === 'high-wind') {
                    · {{ a.detail?.windSpeed | number:'1.0-1' }} m/s
                  } @else if (a.kind === 'lightning-proximity') {
                    · {{ a.detail?.distanceM | number:'1.0-0' }} m
                  }
                </div>
              </div>
            }
          </div>
        </aside>
      }

      <!-- G6 (2026-05-22) — time-bar /globe. Inputs minimaux (minTime,
           maxTime, layerCoverage). G6b ajoutera validityList + WMS time
           refresh + master du temps. -->
      @if (sliderLayerCoverage().length > 0) {
        <app-time-slider
          [minTime]="sliderMinTime()"
          [maxTime]="sliderMaxTime()"
          [layerCoverage]="sliderLayerCoverage()"
          [validityList]="masterValidityList()"
          [stepMs]="masterStepMs()"
          [externalCurrentTime]="currentTime()"
          [externalAnimationActive]="animPlayer.state() !== 'idle'"
          [autoZIndexEnabled]="autoZIndexEnabled()"
          (timeChange)="onSliderTimeChange($event)"
          (playClicked)="onSliderPlayClicked()"
          (masterChange)="setMasterLayer($event)"
          (reorderRequest)="reorderLayerByDrag($event.fromKey, $event.toKey)"
          (autoZIndexEnabledChange)="onAutoZIndexToggleChange($event)" />
      }

      <!-- G21 — modal animation config (parité /legacy-map). -->
      @if (animPanelOpen()) {
        <app-animation-panel
          [anchor]="currentTime()"
          [forecastActive]="isForecastActive()"
          [masterLayerLabel]="masterLayerLabel()"
          [masterStepMs]="masterStepMs()"
          (launch)="onAnimationLaunch($event)"
          (cancel)="closeAnimationPanel()" />
      }
      <!-- G21 — controls floattants (play/pause/stop/speed) au-dessus du slider.
           Visibilité gérée en interne par le composant via animPlayer.state(). -->
      <app-animation-controls />

      <!-- G53 (2026-05-24) — overlay préparation animation. Phase 1 :
           GetCapabilities (récup validités master). Phase 2 : pré-chargement
           des tuiles WMS (master + sub rasters actifs). backdrop-filter blur
           masque la map pendant la prépa, barre de progression event-driven
           via MapLibre data events sur source loaded. -->
      @if (animLoadingState(); as st) {
        <div class="anim-loading-overlay" role="alert" aria-busy="true">
          <div class="anim-loading-card">
            <div class="anim-loading-title">Préparation animation</div>
            <div class="anim-loading-label">{{ st.label }}</div>
            <div class="anim-loading-bar">
              <div
                class="anim-loading-bar-fill"
                [style.width.%]="(st.total > 0 ? st.done / st.total : 0) * 100"></div>
            </div>
            <div class="anim-loading-count">
              @if (st.phase === 'capabilities') {
                Récupération des validités GeoServer…
              } @else {
                {{ st.done }} / {{ st.total }} tuiles chargées
              }
            </div>
            <button
              type="button"
              class="anim-loading-cancel"
              (click)="cancelAnimLoading()"
              title="Annuler le chargement et fermer">
              Annuler
            </button>
          </div>
        </div>
      }
    </div>
  `,
  styles: `
    :host { display: block; height: 100%; }
    .globe-root {
      position: absolute;
      inset: 0;
      background: #0a0e1a;
      color: #e6ecf3;
      font-family: system-ui, -apple-system, sans-serif;
    }
    .globe-header {
      position: absolute;
      top: 0; left: 0; right: 0;
      z-index: 20;
      display: flex;
      align-items: center;
      justify-content: space-between;
      /* G43 (2026-05-23) — padding compact 0.1em vertical + 1em horizontal. */
      padding: 0.1em 1em;
      gap: 0.1em;
      background:
        linear-gradient(90deg,
          rgba(0, 2, 8, 0.96) 0,
          rgba(0, 2, 8, 0.94) 310px,
          rgba(7, 12, 24, 0.88) 430px,
          rgba(10, 14, 26, 0.78) 620px),
        rgba(10, 14, 26, 0.78);
      /* G26 — cyan glow (parité drawer + nav buttons) */
      border-bottom: 1px solid hsl(224 85% 55% / 0.5);
      box-shadow:
        0 0 0 1px hsl(224 95% 60% / 0.12),
        0 6px 16px -2px hsl(224 95% 60% / 0.22),
        0 0 30px -4px hsl(224 90% 55% / 0.18);
      backdrop-filter: blur(6px);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 0.1em;
      font-size: 14px;
      padding-right: 1.2em;
      background: linear-gradient(90deg, rgba(0, 2, 8, 0.48), rgba(0, 2, 8, 0));
      border-radius: 999px;
    }
    .brand-icon { font-size: 18px; }
    /* G27 — bouton clickable (toggle drawer) avec hover/focus glow */
    .brand-icon-btn {
      padding: 0;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 50%;
      cursor: pointer;
      line-height: 0;
      transition: filter 150ms, transform 150ms, border-color 150ms;
    }
    .brand-icon-btn:hover {
      filter: brightness(1.15);
      transform: scale(1.03);
      border-color: hsl(224 85% 55% / 0.5);
    }
    .brand-icon-btn:focus-visible {
      outline: 2px solid hsl(224 95% 65%);
      outline-offset: 1px;
    }
    /* G26/G27 — duo icon (globe) + wordmark text. Tailles compactes
       car padding header réduit (4px vs 8px) → image ~28px lisible. */
    .brand-icon-img {
      height: 32px;
      width: 32px;
      object-fit: contain;
      display: block;
    }
    .brand-text-img {
      height: 22px;
      width: auto;
      object-fit: contain;
      display: block;
    }
    .brand-title { font-weight: 600; color: #c9d6e8; letter-spacing: .04em; }
    .brand-mode { color: #8a96a8; font-size: 12px; }
    .brand-mode-pill {
      display: inline-block;
      padding: 1px 6px;
      margin-left: 4px;
      background: #3b5bff;
      color: #fff;
      border-radius: 4px;
      font-size: 10px;
      letter-spacing: .04em;
    }
    .nav-links { display: flex; align-items: center; gap: 0.1em; flex-wrap: wrap; }
    /* G24 — boutons header harmonisés : hauteur fixe 28px, padding égaux,
       border cyan glow comme le drawer (parité bordure magnifique demandée). */
    .nav-link, .nav-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 28px;
      padding: 0 12px;
      box-sizing: border-box;
      color: #c9d6e8;
      text-decoration: none;
      font-size: 13px;
      font-family: inherit;
      line-height: 1;
      border: 1px solid hsl(224 85% 55% / 0.5);
      border-radius: 6px;
      background: rgba(15, 23, 42, 0.85);
      cursor: pointer;
      transition: background .15s, border-color .15s, box-shadow .15s;
      /* Glow neon cyan (même style que .legend drawer) */
      box-shadow:
        0 0 0 1px hsl(224 95% 60% / 0.12),
        0 0 8px 0 hsl(224 95% 60% / 0.18);
    }
    .nav-link:hover, .nav-btn:hover {
      background: rgba(30, 40, 70, 0.95);
      border-color: hsl(224 95% 65%);
      box-shadow:
        0 0 0 1px hsl(224 95% 65% / 0.25),
        0 0 14px 0 hsl(224 95% 60% / 0.35);
    }
    /* G18 M15 — auth corner (parité /legacy-map) */
    .nav-sep { color: #4a5566; font-size: 11px; }
    .nav-btn[type="button"] {
      /* Distinction Déconnexion : reste dans le même size mais teinte rouge */
      background: rgba(80, 30, 30, 0.55);
      color: #fecaca;
      border-color: hsl(0 60% 50% / 0.6);
      box-shadow:
        0 0 0 1px hsl(0 70% 55% / 0.15),
        0 0 8px 0 hsl(0 80% 55% / 0.18);
    }
    .nav-btn[type="button"]:hover {
      background: rgba(120, 40, 40, 0.75);
      color: #fff;
      border-color: hsl(0 70% 60%);
      box-shadow:
        0 0 0 1px hsl(0 80% 60% / 0.3),
        0 0 14px 0 hsl(0 80% 60% / 0.4);
    }
    .nav-admin-pill {
      background: rgba(120, 80, 30, 0.5);
      border-color: #8b6020;
      color: #fde68a;
      font-weight: 600;
      letter-spacing: 0.05em;
    }

    .map-container {
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
    }

    /* ═══════════════════════════════════════════════════════════════
       G19 (2026-05-22) — Style panneau gauche porté à l'identique
       depuis /legacy-map pour parité visuelle 100%. Glow neon cyan
       OL-Companion + data-catalog accordion + glyphs colorés.
       Les CSS vars (--bg-2, --fg, --accent, etc.) sont définies dans
       styles.scss global.
       ═══════════════════════════════════════════════════════════════ */
    .legend {
      position: absolute;
      /* G23 — top 56px pour éviter overlap avec header bar full-width.
         (Avant : top 1em → header z-index 100 cachait wordmark logo.) */
      top: 60px;
      left: 1em;
      background: rgb(15, 23, 42);
      border: 1px solid hsl(224 85% 55% / 0.5);
      border-radius: 8px;
      padding: 1em 1.2em;
      z-index: 10;
      min-width: 200px;
      width: 320px;
      max-height: calc(100vh - 80px);
      overflow-y: auto;
      /* Glow neon cyan, inspiré OL Companion sidebar */
      box-shadow:
        0 0 0 1px hsl(224 95% 60% / 0.2),
        0 0 16px 1px hsl(224 95% 60% / 0.26),
        0 0 40px 4px hsl(224 90% 55% / 0.13),
        0 10px 30px -6px rgba(0, 0, 0, 0.7);
    }
    .legend.legend--closed {
      display: none;
    }

    /* G64 (2026-05-24) — Pendant animation : legend masqué (slide-out left)
       pour libérer la map. Animation ease 200ms pour ne pas surprendre. */
    .legend.legend--anim-hidden {
      transform: translateX(-110%);
      opacity: 0;
      pointer-events: none;
      transition: transform 200ms ease, opacity 150ms ease;
    }

    /* G64 — nav-links + brand button désactivés pendant animation : opacity
       réduite + cursor not-allowed + pointer-events none pour les <a>.
       Le bouton .brand-icon-btn utilise [disabled] natif. */
    .globe-root.is-animating .nav-links {
      opacity: 0.35;
      pointer-events: none;
      cursor: not-allowed;
    }
    .globe-root.is-animating .brand-icon-btn[disabled] {
      opacity: 0.4;
      cursor: not-allowed;
    }

    /* Bouton hamburger réouverture (legend collapsed). */
    .legend-close-mobile {
      display: none;
    }
    .legend-toggle {
      display: none;
      &.is-collapsed {
        display: flex;
      }
      position: absolute;
      /* G26 — décalé sous header bar (était caché derrière). */
      top: 70px;
      left: 14px;
      z-index: 11;
      width: 44px;
      height: 44px;
      border-radius: 8px;
      background: rgb(15, 23, 42);
      border: 1px solid hsl(224 85% 55% / 0.5);
      color: var(--accent-bright);
      font-size: 1.4rem;
      line-height: 1;
      cursor: pointer;
      align-items: center;
      justify-content: center;
      transition: color 150ms, border-color 150ms;
      box-shadow: 0 4px 12px -2px rgba(0, 0, 0, 0.6);
      &:hover, &:focus-visible {
        color: var(--fg);
        border-color: var(--accent-bright);
      }
    }

    /* G26 — bouton close minimal flottant top-right du drawer */
    .data-catalog .catalog-close-btn {
      position: absolute;
      top: 8px;
      right: 8px;
      background: transparent;
      color: #8a96a8;
      border: 1px solid hsl(224 50% 35% / 0.6);
      border-radius: 4px;
      padding: 2px 8px;
      cursor: pointer;
      font-size: 13px;
      line-height: 1;
      z-index: 2;
      transition: background 150ms, color 150ms, border-color 150ms;
    }
    .data-catalog .catalog-close-btn:hover {
      background: hsl(0 60% 40% / 0.3);
      color: #fff;
      border-color: hsl(0 60% 55%);
    }

    /* cap5 warning inline */
    .cap5-inline {
      background: rgba(220, 38, 38, 0.18);
      border: 1px solid rgba(220, 38, 38, 0.55);
      color: rgb(252, 165, 165);
      font-family: var(--font-mono);
      font-size: 0.7rem;
      padding: 0.45em 0.7em;
      border-radius: 6px;
      letter-spacing: 0.03em;
      margin: 0.6em 0;
      line-height: 1.35;
      animation: cap5-inline-in 200ms ease-out;
    }
    @keyframes cap5-inline-in {
      from { opacity: 0; transform: translateY(-4px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    /* ═══ Data catalog accordion ═══ */
    .catalog-section {
      display: flex;
      flex-direction: column;
      border-bottom: 1px solid rgba(255,255,255,0.04);
    }
    .catalog-section:last-of-type { border-bottom: 0; }
    .catalog-section-head {
      display: flex;
      align-items: center;
      gap: 0.5em;
      width: 100%;
      padding: 0.6em 0;
      background: transparent;
      border: 0;
      cursor: pointer;
      color: var(--fg);
      font-size: 0.8rem;
      font-family: inherit;
      text-align: left;
      position: relative;
      transition: color 150ms ease;
    }
    .catalog-section-head:hover {
      color: var(--accent-bright);
    }
    .catalog-section-head::before {
      content: '';
      position: absolute;
      left: -1.2em;
      top: 50%;
      transform: translateY(-50%);
      width: 3px;
      height: 18px;
      border-radius: 0 2px 2px 0;
      background: currentColor;
      opacity: 0;
      transition: opacity 200ms ease;
    }
    .catalog-section.is-open .catalog-section-head::before { opacity: 1; }
    .catalog-section-head.section-maritime    { color: #60a5fa; }
    .catalog-section-head.section-observation { color: #a78bfa; }
    .catalog-section-head.section-satellites  { color: #fbbf24; }
    .catalog-section-head.section-forecast    { color: #fb923c; }
    .catalog-section-head.section-hydrology   { color: #22d3ee; }
    .catalog-section-head.section-sources     { color: #94a3b8; }
    .catalog-section-head.section-radar       { color: #3b82f6; }
    .sat-date-label {
      font-family: var(--font-mono);
      font-size: 0.72rem;
      color: var(--fg-muted);
      padding: 0.25em 0.5em 0.4em 0.5em;
      letter-spacing: 0.05em;
    }
    .catalog-section-head .head-chevron {
      font-size: 0.55rem;
      width: 0.8em;
      color: var(--fg-dim);
      transition: transform 200ms ease;
    }
    .catalog-section-head .head-icon {
      font-size: 0.95rem;
      filter: drop-shadow(0 0 6px currentColor);
    }
    .catalog-section-head .head-name {
      flex: 1;
      font-weight: 600;
      letter-spacing: 0.04em;
      color: var(--fg);
    }
    .catalog-section.is-open .catalog-section-head .head-name {
      color: inherit;
    }
    .catalog-section-head .head-count {
      font-family: var(--font-mono);
      font-size: 0.65rem;
      color: var(--fg-dim);
      background: rgba(255,255,255,0.06);
      padding: 0.1em 0.55em;
      border-radius: 999px;
      letter-spacing: 0.02em;
    }
    .catalog-section.is-open .catalog-section-head .head-count {
      color: currentColor;
      background: color-mix(in srgb, currentColor 18%, transparent);
    }
    .catalog-section-body {
      display: flex;
      flex-direction: column;
      gap: 0.4em;
      padding: 0.3em 0 0.8em 0.4em;
      animation: catalogSlideIn 180ms ease-out;
    }
    @keyframes catalogSlideIn {
      from { opacity: 0; transform: translateY(-4px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    /* Projection switch (Globe/Mercator) — hors sections */
    .projection-row {
      padding-bottom: 0.4em;
      margin-bottom: 0.3em;
      border-bottom: 1px dashed rgba(255,255,255,0.06);
    }
    .proj-buttons { display: flex; gap: 0.4em; }
    .proj-btn {
      flex: 1;
      background: var(--bg-3);
      color: var(--fg);
      border: 1px solid var(--border);
      padding: 0.35em 0.5em;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.72rem;
      font-family: var(--font-mono);
      letter-spacing: 0.05em;
      transition: background 150ms, border-color 150ms;
    }
    .proj-btn:hover { background: hsl(224 30% 18%); }
    .proj-btn.active {
      background: hsl(224 85% 30% / 0.45);
      border-color: var(--accent-bright);
      color: var(--accent-bright);
    }

    /* isolignes sous-toggle */
    .contour-control {
      display: flex;
      align-items: center;
      gap: 0.5em;
      margin-left: 1.6em;
      margin-top: 0.3em;
      font-size: 0.7rem;
      color: var(--fg-muted);
    }
    .contour-toggle {
      display: flex;
      align-items: center;
      gap: 0.3em;
      cursor: pointer;
      input {
        accent-color: var(--accent);
        width: 12px;
        height: 12px;
      }
    }
    .contour-control input[type="range"] {
      flex: 1;
      max-width: 90px;
      height: 3px;
      appearance: none;
      background: var(--bg-3);
      border-radius: 2px;
      accent-color: var(--accent);
    }
    .layer-opacity-contour {
      max-width: 60px;
    }
    /* Placeholder rows = "à venir" */
    .layer-row.layer-soon {
      opacity: 0.45;
      pointer-events: none;
      cursor: default;
    }
    .layer-row.layer-soon .toggle-glyph .glyph-icon {
      display: inline-block;
      font-size: 0.95rem;
      width: 1.4em;
      text-align: center;
      opacity: 0.7;
    }
    .layer-row.layer-soon .soon-tag {
      font-size: 0.55rem;
      letter-spacing: 0.12em;
      margin-left: 0.4em;
      text-transform: uppercase;
      color: var(--fg-dim);
      vertical-align: 0.05em;
    }
    .layer-toggles {
      display: flex;
      flex-direction: column;
      gap: 0.7em;
      margin: 0.4em 0 1em;
      padding-bottom: 0.8em;
      border-bottom: 1px solid var(--border);
    }
    .layer-row {
      display: flex;
      flex-direction: column;
      gap: 0.15em;
    }
    .layer-opacity {
      width: 100%;
      height: 4px;
      appearance: none;
      background: var(--bg-3);
      border-radius: 2px;
      cursor: pointer;
      margin-left: 1.6em;
      width: calc(100% - 1.6em);
      accent-color: var(--accent);
      &::-webkit-slider-thumb {
        appearance: none;
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: var(--accent-bright);
        cursor: ew-resize;
        border: 0;
      }
      &::-moz-range-thumb {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: var(--accent-bright);
        cursor: ew-resize;
        border: 0;
      }
    }
    .layer-reset {
      margin-top: 0.6em;
      padding: 0.4em 0.7em;
      background: transparent;
      border: 1px solid var(--border);
      color: var(--fg-muted);
      border-radius: 5px;
      cursor: pointer;
      font-size: 0.7rem;
      font-family: var(--font-mono);
      letter-spacing: 0.05em;
      transition: color 150ms, border-color 150ms;
      &:hover {
        color: var(--accent-bright);
        border-color: var(--accent);
      }
    }
    .layer-toggle {
      display: flex;
      align-items: center;
      gap: 0.6em;
      font-size: 0.8rem;
      color: var(--fg);
      cursor: pointer;
      input {
        accent-color: var(--accent);
        cursor: pointer;
        flex-shrink: 0;
        width: 16px;
        height: 16px;
      }
      &.dim {
        .toggle-glyph, .toggle-text { opacity: 0.4; transition: opacity 200ms; }
      }
      &.mode-incompatible {
        .toggle-glyph, .toggle-text { opacity: 0.45; }
        position: relative;
      }
      &.mode-incompatible::after {
        content: '⏱';
        position: absolute;
        right: 0;
        top: 50%;
        transform: translateY(-50%);
        font-size: 0.65rem;
        color: hsl(45 95% 60%);
        opacity: 0.85;
      }
    }
    .toggle-glyph {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      width: 38px;
      flex-shrink: 0;
    }
    .glyph-dot {
      display: inline-block;
      width: 8px; height: 8px;
      border-radius: 50%;
      border: 1px solid;
    }
    .glyph-gradient {
      display: inline-block;
      width: 36px;
      height: 8px;
      border-radius: 2px;
      background: linear-gradient(to right, #1e3a8a 0%, #06b6d4 30%, #fde047 60%, #ef4444 100%);
      border: 1px solid rgba(255,255,255,0.15);
    }
    .glyph-rain {
      display: inline-block;
      width: 36px;
      height: 8px;
      border-radius: 2px;
      background: linear-gradient(to right, rgba(255,255,255,0.05) 0%, #38bdf8 25%, #4ade80 50%, #fbbf24 75%, #ef4444 100%);
      border: 1px solid rgba(255,255,255,0.15);
    }
    .glyph-wind {
      display: inline-block;
      width: 36px;
      height: 8px;
      border-radius: 2px;
      background: linear-gradient(to right, #cbd5e1 0%, #38bdf8 35%, #fbbf24 70%, #dc2626 100%);
      border: 1px solid rgba(255,255,255,0.15);
    }
    .glyph-waves {
      display: inline-block;
      width: 36px;
      height: 8px;
      border-radius: 2px;
      background: linear-gradient(to right, #1e3a8a 0%, #06b6d4 30%, #fbbf24 70%, #ef4444 100%);
      border: 1px solid rgba(255,255,255,0.15);
    }
    .glyph-arrow {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 16px;
      border-radius: 2px;
      font-size: 0.95rem;
      line-height: 1;
      border: 1px solid rgba(255,255,255,0.15);
    }
    .glyph-arrow-wind {
      background: linear-gradient(to right, rgba(56,189,248,0.25), rgba(220,38,38,0.45));
      color: #fde047;
    }
    .glyph-arrow-wave {
      background: linear-gradient(to right, rgba(14,165,233,0.25), rgba(239,68,68,0.45));
      color: #06b6d4;
    }
    .glyph-zap {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 16px;
      border-radius: 2px;
      font-size: 0.95rem;
      line-height: 1;
      border: 1px solid rgba(253,224,71,0.4);
      background: linear-gradient(to right, rgba(15,23,42,0.6), rgba(253,224,71,0.25));
      color: #fde047;
      text-shadow: 0 0 4px rgba(253,224,71,0.6);
    }
    .glyph-alert {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 16px;
      border-radius: 2px;
      font-size: 0.95rem;
      line-height: 1;
      border: 1px solid rgba(251,146,60,0.45);
      background: linear-gradient(to right, rgba(251,146,60,0.18), rgba(220,38,38,0.32));
      color: #fbbf24;
    }
    .glyph-buoy {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 16px;
      border-radius: 2px;
      font-size: 0.95rem;
      line-height: 1;
      border: 1px solid rgba(56,189,248,0.4);
      background: linear-gradient(to right, rgba(15,23,42,0.6), rgba(56,189,248,0.25));
      color: #38bdf8;
    }
    .glyph-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 16px;
      font-size: 0.95rem;
      line-height: 1;
    }
    .glyph-particles {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 16px;
      border-radius: 2px;
      font-size: 0.65rem;
      letter-spacing: -0.1em;
      line-height: 1;
      border: 1px solid rgba(34,197,94,0.4);
      background: linear-gradient(to right, rgba(56,189,248,0.2), rgba(34,197,94,0.3), rgba(253,224,71,0.3));
      color: var(--accent-bright);
      text-shadow: 0 0 3px rgba(94,234,212,0.6);
    }

    .toggle-text {
      display: flex;
      flex-direction: column;
      line-height: 1.15;
    }
    .toggle-name {
      color: var(--fg);
      font-weight: 500;
    }
    .toggle-count {
      font-family: var(--font-mono);
      font-size: 0.65rem;
      color: var(--fg-dim);
      margin-top: 1px;
    }

    .legend-section-title {
      font-family: var(--font-mono);
      font-size: 0.6rem;
      letter-spacing: 0.15em;
      color: var(--fg-dim);
      text-transform: uppercase;
      margin: 0 0 0.3em;
    }
    .legend-stats {
      margin-top: 0.8em;
      padding-top: 0.8em;
      border-top: 1px solid var(--border);
      font-size: 0.75rem;
      color: var(--fg-muted);
    }
    .legend-mode {
      font-family: var(--font-mono);
      font-size: 0.7rem;
      letter-spacing: 0.15em;
      color: var(--fg-muted);
      &.live { color: var(--accent-bright); }
      &.future { color: var(--warning); }
    }
    .legend-error {
      color: var(--negative);
      font-size: 0.7rem;
      margin-top: 0.4em;
    }

    /* G18 M13 — LegendGraphic inline (parité /legacy-map). */
    .legend-graphic {
      margin-top: 6px;
      padding: 4px 6px;
      background: rgba(15, 23, 42, 0.7);
      border: 1px solid hsl(224 85% 55% / 0.25);
      border-radius: 4px;
      display: flex;
      justify-content: center;
    }
    .legend-graphic img {
      display: block;
      height: 120px;
      width: auto;
      max-width: 100%;
    }

    /* mobile mode bar / essential layers — default desktop hidden. */
    .mobile-mode-bar { display: none; }
    .essential-layers { display: none; }
    .layer-toggles-hidden {
      /* desktop : ignore le flag, l'UI complète reste visible */
    }

    /* ── Responsive mobile (≤ 760px) ── */
    @media (max-width: 760px) {
      .legend-toggle {
        display: flex;
      }
      .legend {
        top: 0.7em;
        left: 0.7em;
        right: 0.7em;
        max-width: none;
        width: calc(100vw - 1.4em);
        max-height: 78vh;
        overflow-y: auto;
        padding: 1em 1em 1em 3.6em;
        z-index: 10;
        &.legend--closed {
          display: none;
        }
      }
      .data-catalog .catalog-header,
      .catalog-header {
        display: none;
      }
      .legend-close-mobile {
        display: block;
        position: absolute;
        top: 0.5em;
        right: 0.5em;
        z-index: 12;
        width: 32px;
        height: 32px;
        border: 1px solid hsl(224 30% 30%);
        background: hsl(224 30% 12%);
        color: hsl(224 95% 75%);
        border-radius: 50%;
        font-size: 0.9rem;
        cursor: pointer;
        padding: 0;
        line-height: 30px;
      }
      .legend-close-mobile:hover {
        background: hsl(224 85% 55% / 0.25);
      }
      .layer-toggle input[type="checkbox"] {
        width: 22px;
        height: 22px;
      }
      .mobile-mode-bar {
        display: flex;
        justify-content: flex-end;
        padding: 0.4em 0 0.6em 0;
      }
      .mobile-mode-toggle {
        background: hsl(224 30% 12%);
        border: 1px solid hsl(224 85% 55% / 0.4);
        color: hsl(224 95% 75%);
        padding: 0.4em 0.9em;
        border-radius: 16px;
        font-size: 0.72rem;
        font-family: var(--font-mono);
        cursor: pointer;
        letter-spacing: 0.05em;
      }
      .mobile-mode-toggle:hover {
        background: hsl(224 85% 55% / 0.2);
      }
      .essential-layers {
        display: block;
      }
      .essential-layers-title {
        font-size: 0.62rem;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: hsl(224 25% 65%);
        margin-bottom: 0.5em;
      }
      .essential-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 0.5em;
      }
      .essential-toggle {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 0.8em 0.4em;
        background: hsl(224 30% 12%);
        border: 1px solid hsl(224 30% 22%);
        border-radius: 8px;
        cursor: pointer;
        gap: 0.3em;
        min-height: 72px;
        transition: background 150ms, border-color 150ms;
        input {
          position: absolute;
          opacity: 0;
          pointer-events: none;
        }
      }
      .essential-toggle.active {
        background: hsl(224 85% 30% / 0.35);
        border-color: hsl(224 85% 60%);
      }
      .essential-toggle.mode-incompatible {
        opacity: 0.5;
      }
      .essential-icon {
        font-size: 1.4rem;
        line-height: 1;
      }
      .essential-label {
        font-size: 0.7rem;
        color: hsl(224 15% 90%);
      }
      .essential-hint {
        margin-top: 0.8em;
        font-size: 0.62rem;
        color: hsl(224 25% 55%);
        font-style: italic;
      }
      .layer-toggles-hidden {
        display: none;
      }
    }

    /* G22 — FPS déplacé en bottom-right pour éviter overlap avec
       NavigationControl MapLibre (zoom +/- + boussole). */
    .fps {
      position: absolute;
      bottom: 100px;
      right: 14px;
      z-index: 10;
      padding: 4px 8px;
      background: rgba(20, 24, 38, 0.85);
      border: 1px solid #2a3245;
      border-radius: 6px;
      font-family: ui-monospace, monospace;
      font-size: 11px;
      opacity: 0.7;
    }
    .fps:hover { opacity: 1; }

    /* G23 — décale les controls top-right MapLibre sous le header (56px). */
    ::ng-deep .maplibregl-ctrl-top-right {
      top: 56px !important;
    }

    /* G22 — Style MapLibre controls cohérent avec le reste du UI. */
    ::ng-deep .maplibregl-ctrl-group {
      background: rgba(20, 24, 38, 0.92) !important;
      border: 1px solid #2a3245 !important;
      border-radius: 8px !important;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5) !important;
      overflow: hidden;
    }
    ::ng-deep .maplibregl-ctrl-group button {
      background: transparent !important;
      color: #c9d6e8 !important;
      border-bottom: 1px solid #2a3245 !important;
      transition: background 150ms;
    }
    ::ng-deep .maplibregl-ctrl-group button:last-child { border-bottom: none !important; }
    ::ng-deep .maplibregl-ctrl-group button:hover { background: rgba(59, 91, 255, 0.18) !important; }
    ::ng-deep .maplibregl-ctrl-group button:focus-visible {
      outline: 2px solid #5878ff !important;
      outline-offset: 1px;
    }
    /* Inverse les icônes SVG par defaut blanches sur fond dark */
    ::ng-deep .maplibregl-ctrl-icon { filter: invert(0.85); }
    /* G22 — Attribution : fond dark + couleurs cohérentes.
       G23 — bottom-right offset + max-width pour ne pas déborder time-bar. */
    ::ng-deep .maplibregl-ctrl-bottom-right {
      bottom: 120px !important; /* au-dessus de la time-bar */
      max-width: 360px;
    }
    ::ng-deep .maplibregl-ctrl-attrib {
      background: rgba(20, 24, 38, 0.85) !important;
      color: #8a96a8 !important;
      border: 1px solid #2a3245 !important;
      border-radius: 6px 0 0 0 !important;
      font-family: ui-monospace, monospace;
      font-size: 10px;
      padding: 3px 8px !important;
      max-width: 360px;
      white-space: normal !important;
      word-wrap: break-word;
      line-height: 1.45;
    }
    ::ng-deep .maplibregl-ctrl-attrib-inner {
      white-space: normal !important;
    }
    ::ng-deep .maplibregl-ctrl-attrib a { color: #5878ff !important; text-decoration: none; }
    ::ng-deep .maplibregl-ctrl-attrib a:hover { text-decoration: underline; }
    /* Scale */
    ::ng-deep .maplibregl-ctrl-scale {
      background: rgba(20, 24, 38, 0.85) !important;
      color: #c9d6e8 !important;
      border: 1px solid #2a3245 !important;
      border-top: none !important;
      font-family: ui-monospace, monospace;
      font-size: 10px;
    }

    /* G18 M5 — alerts feed panel (parité /legacy-map).
       G24 — top: 240px pour passer SOUS les controls MapLibre top-right
       (zoom + reset bearing prennent ~100px depuis top: 56px). */
    .alerts-panel {
      position: absolute;
      top: 240px;
      right: 14px;
      z-index: 10;
      width: 260px;
      max-height: calc(100vh - 380px);
      overflow-y: auto;
      background: rgba(20, 24, 38, 0.95);
      border: 1px solid #2a3245;
      border-radius: 8px;
      padding: 10px 12px;
      font-size: 12px;
      color: #e6ecf3;
    }
    .alerts-panel-title {
      font-weight: 600;
      font-size: 12px;
      color: #f97316;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 8px;
    }
    .alerts-feed { display: flex; flex-direction: column; gap: 6px; }
    .alert-item {
      padding: 6px 8px;
      background: rgba(50, 60, 80, 0.5);
      border-left: 3px solid #94a3b8;
      border-radius: 4px;
      line-height: 1.4;
    }
    .alert-item.warning { border-left-color: #f97316; background: rgba(80, 50, 30, 0.5); }
    .alert-item.danger  { border-left-color: #dc2626; background: rgba(80, 30, 30, 0.5); }
    .alert-head {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      font-weight: 500;
    }
    .alert-kind { color: #fff; }
    .alert-age { color: #94a3b8; font-family: ui-monospace, monospace; font-size: 11px; }
    .alert-meta { color: #b0bac8; font-size: 11px; margin-top: 2px; }

    /* Override MapLibre popup pour matcher le thème dark du site.
       Le default MapLibre est fond blanc + texte noir = invisible ici. */
    /* CRITIQUE : forcer position: absolute sur le wrapper. MapLibre default est
       absolute mais semble override en static (probably Tailwind reset ou autre).
       Sans absolute, le transform calculé par MapLibre est ignoré → la popup
       tombe en flow naturel en bas du map-container (bug "popup hors map"). */
    ::ng-deep .maplibregl-popup {
      position: absolute !important;
    }
    ::ng-deep .maplibregl-popup-content {
      background: rgba(20, 24, 38, 0.95) !important;
      color: #e6ecf3 !important;
      border: 1px solid #2a3245;
      border-radius: 8px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
      padding: 12px 28px 12px 14px !important;  /* right extra pour close button */
      font: 12px system-ui, -apple-system, sans-serif;
      max-width: 280px;
      /* PAS de position: relative — cassait le transform du parent .maplibregl-popup. */
    }
    ::ng-deep .maplibregl-popup-tip {
      border-top-color: rgba(20, 24, 38, 0.95) !important;
      border-bottom-color: rgba(20, 24, 38, 0.95) !important;
      border-left-color: rgba(20, 24, 38, 0.95) !important;
      border-right-color: rgba(20, 24, 38, 0.95) !important;
    }
    /* G22 — popup close button visible (user feedback "invisible") :
       le default est text-color noir sur fond white, ici fond dark donc
       texte noir = invisible. Override color + bg + size pour cohérence. */
    ::ng-deep .maplibregl-popup-close-button {
      color: #c9d6e8 !important;
      font-size: 18px !important;
      line-height: 1 !important;
      padding: 4px 8px !important;
      border-radius: 4px;
      transition: background 150ms;
    }
    ::ng-deep .maplibregl-popup-close-button:hover {
      background: rgba(220, 38, 38, 0.4) !important;
      color: #fff !important;
    }
    /* G53 (2026-05-24) — overlay préparation animation. backdrop blur cache
       la map pendant que les frames se chargent. Carte centrée avec barre
       progression linear-gradient cyan→indigo (parité reste du UI globe). */
    .anim-loading-overlay {
      position: absolute;
      inset: 0;
      z-index: 10000;
      background: rgba(10, 14, 26, 0.55);
      backdrop-filter: blur(10px) saturate(120%);
      -webkit-backdrop-filter: blur(10px) saturate(120%);
      display: flex;
      align-items: center;
      justify-content: center;
      animation: anim-loading-fade-in 0.18s ease-out;
    }
    @keyframes anim-loading-fade-in { from { opacity: 0 } to { opacity: 1 } }
    .anim-loading-card {
      min-width: 320px;
      max-width: 480px;
      padding: 28px 36px;
      background: rgba(15, 23, 42, 0.92);
      border: 1px solid hsl(224 85% 55% / 0.4);
      border-radius: 12px;
      box-shadow:
        0 0 0 1px hsl(224 95% 60% / 0.12),
        0 12px 40px rgba(0, 0, 0, 0.4),
        0 0 30px -4px hsl(224 90% 55% / 0.25);
      text-align: center;
    }
    .anim-loading-title {
      font-size: 0.78rem;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: hsl(224 90% 75% / 0.9);
      margin-bottom: 10px;
    }
    .anim-loading-label {
      font-size: 1.05rem;
      font-weight: 500;
      color: #e2e8f0;
      margin-bottom: 16px;
    }
    .anim-loading-bar {
      height: 6px;
      background: hsl(224 85% 55% / 0.18);
      border-radius: 999px;
      overflow: hidden;
      margin-bottom: 10px;
    }
    .anim-loading-bar-fill {
      height: 100%;
      width: 0%;
      background: linear-gradient(90deg, hsl(195 95% 55%) 0%, hsl(224 85% 60%) 100%);
      border-radius: 999px;
      transition: width 0.18s ease-out;
    }
    .anim-loading-count {
      font-size: 0.78rem;
      color: rgba(148, 163, 184, 0.85);
      font-variant-numeric: tabular-nums;
      margin-bottom: 18px;
    }
    .anim-loading-cancel {
      padding: 8px 22px;
      background: transparent;
      border: 1px solid hsl(224 30% 50% / 0.5);
      border-radius: 6px;
      color: hsl(224 30% 80%);
      font-size: 0.82rem;
      font-weight: 500;
      cursor: pointer;
      transition: background 150ms, border-color 150ms, color 150ms;
    }
    .anim-loading-cancel:hover {
      background: hsl(0 70% 50% / 0.15);
      border-color: hsl(0 70% 60% / 0.6);
      color: hsl(0 80% 85%);
    }
    .anim-loading-cancel:focus-visible {
      outline: 2px solid hsl(0 70% 60%);
      outline-offset: 2px;
    }
  `,
})
export class GlobeComponent implements AfterViewInit, OnDestroy {
  private readonly arrows = inject(ArrowsService);
  private readonly alertsService = inject(AlertsService);
  private readonly lightningService = inject(LightningService);
  private readonly vesselsService = inject(VesselsService);
  /** G24 — BuoysService injecté pour fetchReferential WFS (vs ancien /api/buoys/recent 404). */
  private readonly buoysService = inject(BuoysService);
  private readonly rainviewerService = inject(RainviewerService);
  private readonly auth = inject(AuthService);
  /** G18 M15 (2026-05-22) — auth corner (parité /legacy-map) */
  readonly currentUser = this.auth.currentUser;
  readonly isAuthenticated = this.auth.isAuthenticated;
  logout(): void { this.auth.logout(); }
  private readonly prefsSync = inject(PreferencesSyncService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  readonly mapContainer = viewChild.required<ElementRef<HTMLDivElement>>('mapContainer');

  constructor() {
    // G7 (2026-05-22) — effect auto Z-index reorder. Recompute l'ordre
    // hiérarchique (sat→raster→radar→WFS→anim) à chaque changement
    // d'activation, tant que autoZIndexEnabled() est true. Cf Sprint Z /map.
    effect(() => {
      const enabled = this.autoZIndexEnabled();
      // Subscribe aux signaux activation
      void this.activeSat();
      // G16 — subscribe les 13 sat signals individuels
      for (const sig of Object.values(this.satShowSignals())) { void sig(); }
      void this.showSst();
      void this.showWind();
      void this.showLightning();
      void this.showAlerts();
      void this.showVessels();
      void this.showMetar();
      void this.showHubeau();
      void this.showPiezo();
      void this.showQuakes();
      void this.showFirms();
      void this.showBuoys();
      void this.showTracks();
      void this.showRain();
      void this.showWindForecast();
      void this.showWavesForecast();
      void this.showWindArrows();
      void this.showWaveArrows();
      void this.showBathy();
      void this.showEez();
      void this.showMpa();
      void this.showGlofas();
      if (!enabled) return;
      const auto = this.computeAutoZIndexOrder();
      if (auto.length === 0) return;
      const current = this.layerZIndexOrder();
      if (auto.length === current.length && auto.every((k, i) => k === current[i])) return;
      this.layerZIndexOrder.set(auto);
      queueMicrotask(() => this.applyMapLibreZIndex());
    }, { allowSignalWrites: true });

    // G11e (2026-05-22) — persist globe prefs (show* + autoZIndex + master + projection)
    // au moindre changement. Restore en ngAfterViewInit avant _initMap.
    effect(() => {
      void this.showSst(); void this.showWind(); void this.activeSat();
      // G16 — subscribe les 13 sat signals pour persist auto
      for (const sig of Object.values(this.satShowSignals())) { void sig(); }
      void this.showLightning(); void this.showAlerts(); void this.showVessels();
      void this.showMetar(); void this.showHubeau(); void this.showPiezo();
      void this.showQuakes(); void this.showFirms(); void this.showBuoys();
      void this.showTracks(); void this.showRain();
      void this.showWindForecast(); void this.showWavesForecast();
      void this.showWindArrows(); void this.showWaveArrows();
      void this.showSstContours(); void this.showWindContours(); void this.showWaveContours();
      void this.showBathy(); void this.showEez(); void this.showMpa(); void this.showGlofas();
      void this.autoZIndexEnabled(); void this.masterLayerKey(); void this.projection();
      this.persistGlobePrefs();
    });

    // G18 M3 — mode-aware visibility : quand le cursor passe en future/past,
    // les layers incompatibles (live-only/past-only/no-future) sont masquées
    // via setLayoutProperty visibility='none' sans toucher au showX signal
    // (donc le toggle reste "actif" + grisé pour rappeler que la layer est
    // toggled on mais hidden par contexte temporel). Reverse au retour live.
    //
    // IMPORTANT : lire TOUS les *Active() AVANT le early return sur this.map,
    // sinon le 1er run (constructor, map undefined) court-circuite les reads
    // et l'effect ne se subscribe jamais aux signaux. Bug vécu 2026-05-22.
    // G22 (2026-05-23) — refresh attribution custom quand layers changent.
    effect(() => {
      void this.showSst(); void this.showWindForecast(); void this.showWavesForecast();
      void this.showWindArrows(); void this.showWaveArrows();
      void this.showVessels(); void this.showTracks();
      void this.showAlerts(); void this.showLightning();
      void this.showMetar(); void this.showHubeau(); void this.showPiezo();
      void this.showQuakes(); void this.showFirms(); void this.showBuoys();
      void this.showRain(); void this.showRadarDwd(); void this.showRadarKnmi();
      // G66 (2026-05-27) — nouveaux vector layers dans le graph de deps pour
      // que l'attribution se refresh à leur toggle (sinon source pas créditée).
      void this.showSigmet(); void this.showTaf(); void this.showCables();
      void this.showFir(); void this.showAirports();
      for (const sig of Object.values(this.satShowSignals())) { void sig(); }
      const map = this.map;
      if (map) this.refreshAttribution(map);
    });

    // G22 (2026-05-23) — auto-close popup quand la layer source est désactivée.
    effect(() => {
      const showMap: Record<string, boolean> = {
        vessels: this.showVessels(),
        tracks: this.showTracks(),
        alerts: this.showAlerts(),
        lightning: this.showLightning(),
        metar: this.showMetar(),
        hubeau: this.showHubeau(),
        piezo: this.showPiezo(),
        quakes: this.showQuakes(),
        firms: this.showFirms(),
        buoys: this.showBuoys(),
      };
      const key = this.activePopupLayerKey;
      if (key && key in showMap && !showMap[key]) {
        this.activePopup?.remove();
        this.activePopup = undefined;
        this.activePopupLayerKey = undefined;
      }
    });

    effect(() => {
      // Capture state via reads — subscribe meme si map undefined au 1er run.
      // Couvre vector (9) + raster SST (no-future) + line tracks (past-only).
      // Contours SST = no-future comme le raster parent (cohérence).
      const states: Array<[boolean, string[]]> = [
        [this.vesselsActive(),   ['vec-vessels-clusters', 'vec-vessels-cluster-count', 'vec-vessels-points']],
        [this.alertsActive(),    ['vec-alerts']],
        [this.lightningActive(), ['vec-lightning']],
        [this.metarActive(),     ['vec-metar']],
        [this.hubeauActive(),    ['vec-hubeau']],
        [this.piezoActive(),     ['vec-piezo']],
        [this.quakesActive(),    ['vec-quakes']],
        [this.firmsActive(),     ['vec-firms']],
        [this.buoysActive(),     ['vec-buoys']],
        [this.sstActive(),       ['sst-wms']],
        [this.tracksActive(),    ['vec-tracks']],
        // SST contours suit la même logique que SST raster (no-future)
        [this.showSstContours() && !this.modeIsFuture(), ['sst-contours-wms']],
      ];
      const map = this.map;
      if (!map) return;
      for (const [active, layerIds] of states) {
        for (const lid of layerIds) {
          if (!map.getLayer(lid)) continue;
          map.setLayoutProperty(lid, 'visibility', active ? 'visible' : 'none');
        }
      }
    });
  }

  readonly projection = signal<'globe' | 'mercator'>('globe');
  readonly showSst = signal(false);
  readonly showWind = signal(false);
  readonly windLoading = signal(false);
  readonly windError = signal<string | null>(null);
  readonly fps = signal('—');
  /** Sélecteur radio mutuellement exclusif. 'none' = pas de sat actif. */
  /** @deprecated G16 (2026-05-22) — Conservé pour compat persist localStorage
   *  legacy. Le nouveau modèle = 1 signal show* par produit sat, plusieurs
   *  peuvent être actifs simultanément (stacking radar + sat IR + …). */
  readonly activeSat = signal<string>('none');

  /** G16 — toggles individuels par produit sat. Lecture seule via
   *  isSatActive(key) ou directement le bon signal. */
  readonly showSatTrueColor      = signal(false);
  readonly showSatTrueColorVIIRS = signal(false);
  readonly showSatIR             = signal(false);
  readonly showSatWaterVapor     = signal(false);
  readonly showSatCloudTop       = signal(false);
  readonly showSatAerosol        = signal(false);
  readonly showSatDayNight       = signal(false);
  readonly showSatRainviewer     = signal(false);
  readonly showSatEuIrRss        = signal(false);
  readonly showSatGlobalIrMtg    = signal(false);
  readonly showSatEuHrvRgb       = signal(false);
  readonly showRadarDwd          = signal(false);
  readonly showRadarKnmi         = signal(false);

  /** Map key → signal pour usage dynamique (templates @for / autres methods). */
  private satShowSignals(): Record<string, ReturnType<typeof signal<boolean>>> {
    return {
      satTrueColor: this.showSatTrueColor,
      satTrueColorVIIRS: this.showSatTrueColorVIIRS,
      satIR: this.showSatIR,
      satWaterVapor: this.showSatWaterVapor,
      satCloudTop: this.showSatCloudTop,
      satAerosol: this.showSatAerosol,
      satDayNight: this.showSatDayNight,
      satRainviewer: this.showSatRainviewer,
      satEuIrRss: this.showSatEuIrRss,
      satGlobalIrMtg: this.showSatGlobalIrMtg,
      satEuHrvRgb: this.showSatEuHrvRgb,
      radarDwd: this.showRadarDwd,
      radarKnmi: this.showRadarKnmi,
    };
  }

  /** Reader pour le template. */
  isSatActive(key: string): boolean {
    const sig = this.satShowSignals()[key];
    return sig ? sig() : false;
  }
  readonly showLightning = signal(false);
  readonly showAlerts = signal(false);
  readonly showVessels = signal(false);
  /** G8 (2026-05-22) — 6 layers vector portées depuis /map. */
  readonly showMetar = signal(false);
  readonly showHubeau = signal(false);
  readonly showPiezo = signal(false);
  readonly showQuakes = signal(false);
  readonly showFirms = signal(false);
  readonly showBuoys = signal(false);
  readonly showTracks = signal(false);
  readonly showRain = signal(false);
  /** G9 (2026-05-22) — 4 layers forecast portées depuis /map. */
  readonly showWindForecast = signal(false);
  readonly showWavesForecast = signal(false);
  readonly showWindArrows = signal(false);
  readonly showWaveArrows = signal(false);
  /** G18 M4 (2026-05-22) — isolines contour overlays (SLDs déjà côté GS).
   *  WMS GetMap avec STYLES dédié + INTERPOLATIONS=bicubic pour alignement
   *  avec le raster sous-jacent. Cf /legacy-map sstContoursLayer. */
  readonly showSstContours = signal(false);
  readonly showWindContours = signal(false);
  readonly showWaveContours = signal(false);
  /** G11b (2026-05-22) — 3 layers statiques sources science (EMODnet/Marine
   *  Regions) via proxy nginx maritime. G68 (2026-05-28) — EFAS retiré
   *  (overlay statique archive) au profit de GloFAS raster time-animé. */
  readonly showBathy = signal(false);
  readonly showEez = signal(false);
  readonly showMpa = signal(false);
  /** G68 (2026-05-28) — GloFAS river discharge forecast (Copernicus EWDS),
   *  raster GS time-enabled (pattern forecast SST/wind). Remplace showEfas. */
  readonly showGlofas = signal(false);
  /** G66 (2026-05-27) — placeholders impl. Câbles sous-marins (TeleGeography
   *  GeoJSON via proxy /cables-geo), SIGMET/AIRMET + TAF (AviationWeather.gov
   *  GeoJSON CORS-ouvert). 4 layers GFS Forecast (Temp2m/Pression/Humidité/
   *  Précip) en frontend scaffold — la requête WMS pointera vers les coverages
   *  aetherwx:* qui seront publiées par weather-fetcher quand les variables
   *  GFS seront ajoutées au subset (TMP_2maboveground/PRMSL/RH/APCP). Tant que
   *  ça, MapLibre affichera des tiles 404 silencieusement. */
  readonly showCables = signal(false);
  readonly showSigmet = signal(false);
  readonly showTaf = signal(false);
  /** G66f (2026-05-27) — FIR + UIR airspaces (OpenAIP via API NestJS proxy). */
  readonly showFir = signal(false);
  /** G66l (2026-05-27) — Airports IATA commerciaux (OpenAIP, cluster). */
  readonly showAirports = signal(false);
  readonly showTemp2m = signal(false);
  readonly showPressureMsl = signal(false);
  readonly showHumidity = signal(false);
  readonly showPrecipitation = signal(false);
  readonly vectorLoading = signal<string | null>(null);
  readonly vectorCounts = signal<Record<string, number | undefined>>({});

  /** G6 (2026-05-22) — temps courant du globe, drive l'overlay time-bar.
   *  Default = maintenant. Future G6b : drive les WMS time-enabled
   *  (sat cascade, sst, etc.) via setSource() au changement. */
  readonly currentTime = signal<Date>(new Date());

  /** G20 (2026-05-22) — dernier refresh tick (affiché sous LIVE badge).
   *  Met à jour à chaque fetch vector ou WMS refresh. Parité /legacy-map. */
  readonly lastRefreshAt = signal<Date | null>(null);

  /** G18 (2026-05-22) — drawer legend collapsible (parite /legacy-map).
   *  Default true = ouvert. Mobile : collapse via bouton close. */
  readonly legendOpen = signal<boolean>(true);

  /** G18 — attribution box collapsible (en bas du drawer, parite /map). */
  readonly attrOpen = signal<boolean>(false);

  toggleLegend(): void { this.legendOpen.update((v) => !v); }
  toggleAttrCollapsed(): void { this.attrOpen.update((v) => !v); }

  /** G18 M10 (2026-05-22) — mobile simple mode (parité /legacy-map).
   *  Default true sur ≤760px, false desktop. Affiche grid 2×3 de 6 toggles
   *  essentiels au lieu des catalog sections complètes. Toggle button
   *  "⊕ Vue avancée" pour repasser à l'UI complète. Persisté localStorage
   *  clé partagée avec /map. */
  readonly mobileSimpleMode = signal<boolean>(this.loadMobileSimpleMode());

  private loadMobileSimpleMode(): boolean {
    try {
      const v = localStorage.getItem('aetherwx.mobile-simple-mode');
      if (v !== null) return v === '1';
    } catch {}
    return typeof window !== 'undefined' && window.innerWidth <= 760;
  }
  private persistMobileSimpleOnChange = effect(() => {
    const v = this.mobileSimpleMode();
    try { localStorage.setItem('aetherwx.mobile-simple-mode', v ? '1' : '0'); } catch {}
  });

  /** G18 M11 (2026-05-22) — cache MMSI → vessel name pour le popup tracks.
   *  Peuplé à chaque fetch vessels via _fetchVectorFc('vessels'). */
  private vesselNameCache = new Map<number, string>();

  /** G22 (2026-05-23) — popup actif + sa layer source pour auto-close.
   *  Quand la layer source est désactivée, le popup doit se fermer. */
  private activePopup?: maplibregl.Popup;
  private activePopupLayerKey?: string;
  vesselNameLookup(mmsi: number): string | null {
    return this.vesselNameCache.get(mmsi) ?? null;
  }

  /** G18 M14 (2026-05-22) — cap 5 layers actifs (audit gap G-4).
   *  Count tout layer rasterized ou vector visible. Au-dessus de 5,
   *  affiche un warning inline pour prévenir lenteur rendering. */
  private readonly MAX_ACTIVE_LAYERS = 5;
  readonly activeLayersCount = computed(() => {
    let n = 0;
    if (this.showSst() || this.showSstContours()) n++;
    if (this.showWindForecast() || this.showWindContours()) n++;
    if (this.showWavesForecast() || this.showWaveContours()) n++;
    if (this.showWind()) n++;
    if (this.showVessels()) n++;
    if (this.showAlerts()) n++;
    if (this.showLightning()) n++;
    if (this.showMetar()) n++;
    if (this.showHubeau()) n++;
    if (this.showPiezo()) n++;
    if (this.showQuakes()) n++;
    if (this.showFirms()) n++;
    if (this.showBuoys()) n++;
    if (this.showTracks()) n++;
    if (this.showRain()) n++;
    if (this.showWindArrows()) n++;
    if (this.showWaveArrows()) n++;
    if (this.showBathy() || this.showEez() || this.showMpa()) n++;
    if (this.showGlofas()) n++;
    for (const sig of Object.values(this.satShowSignals())) if (sig()) n++;
    return n;
  });
  readonly cap5Warning = computed<string | null>(() => {
    const n = this.activeLayersCount();
    if (n > this.MAX_ACTIVE_LAYERS) {
      return `${n} layers actifs — réduis pour éviter le rendu lent (max recommandé ${this.MAX_ACTIVE_LAYERS}).`;
    }
    return null;
  });

  /** G22 (2026-05-23) — attribution custom selon layers actives + mention
   *  Claude (user feedback "on se cache pas nous"). */
  private currentAttributionControl?: maplibregl.AttributionControl;
  computeCustomAttribution(): string[] {
    const out: string[] = [];
    // G23 — toujours visible (basemap)
    out.push('© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors');
    out.push('© <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>');
    if (this.showSst()) out.push('SST NOAA');
    if (this.showWindForecast() || this.showWindArrows() || this.showWind()) out.push('Vent NOAA GFS');
    if (this.showWavesForecast() || this.showWaveArrows()) out.push('Vagues NOAA WW3');
    if (this.showVessels() || this.showTracks()) out.push('AIS aishub');
    if (this.showLightning()) out.push('Blitzortung');
    if (this.showMetar()) out.push('METAR NOAA AWC');
    if (this.showHubeau() || this.showPiezo()) out.push('Hub\'eau');
    if (this.showQuakes()) out.push('USGS');
    if (this.showFirms()) out.push('NASA FIRMS');
    if (this.showBuoys()) out.push('EMODnet');
    if (this.showRain()) out.push('RainViewer');
    if (this.showRadarDwd()) out.push('DWD');
    if (this.showRadarKnmi()) out.push('KNMI');
    // G66 (2026-05-27) — attribution des nouveaux vector layers (obligatoire).
    if (this.showSigmet() || this.showTaf()) out.push('<a href="https://aviationweather.gov" target="_blank" rel="noopener">NOAA Aviation Weather</a>');
    if (this.showCables()) out.push('<a href="https://www.submarinecablemap.com" target="_blank" rel="noopener">TeleGeography</a>');
    if (this.showFir()) out.push('<a href="https://github.com/vatsimnetwork/vatspy-data-project" target="_blank" rel="noopener">VATSpy</a> / VATSIM');
    if (this.showAirports()) out.push('<a href="https://www.openaip.net" target="_blank" rel="noopener">OpenAIP</a>');
    let satAttr = false;
    for (const [k, sig] of Object.entries(this.satShowSignals())) {
      if (!sig()) continue;
      const product = SAT_PRODUCTS.find((p) => p.key === k);
      if (product?.kind === 'gibs-daily' && !out.includes('NASA GIBS')) out.push('NASA GIBS');
      else if (product?.kind === 'cascade-realtime' && !out.includes('EUMETSAT')) out.push('EUMETSAT');
      satAttr = true;
    }
    // Toujours visible : conception + crédits map base
    out.push('<a href="https://github.com/Sylad/maritime-atlas" target="_blank" rel="noopener">AetherWX</a> — conçu avec <a href="https://claude.com" target="_blank" rel="noopener">Claude</a> Code par <b>Sylvain Ladoire</b>');
    return out;
  }
  private refreshAttribution(map: MapLibreMap): void {
    if (this.currentAttributionControl) {
      try { map.removeControl(this.currentAttributionControl); } catch { /* déjà removed */ }
    }
    this.currentAttributionControl = new maplibregl.AttributionControl({
      compact: true,
      customAttribution: this.computeCustomAttribution(),
    });
    map.addControl(this.currentAttributionControl);
  }

  /** G18 M13 (2026-05-22) — URL GetLegendGraphic pour les WMS time-enabled.
   *  Render côté GeoServer un PNG palette 20×120 du SLD courant. Inclus en
   *  inline <img> dans le drawer quand layer actif. Parité /legacy-map. */
  legendGraphicUrl(layerKey: string): string | null {
    const gsName = this.gsLayerNameForKey(layerKey);
    if (!gsName) return null;
    return '/geoserver/aetherwx/wms' +
      '?REQUEST=GetLegendGraphic&VERSION=1.0.0&FORMAT=image/png' +
      '&WIDTH=20&HEIGHT=120' +
      '&LEGEND_OPTIONS=fontColor:0xffffff;fontAntiAliasing:true;bgColor:0x0f172a;dpi:96' +
      `&LAYER=${encodeURIComponent(gsName)}`;
  }
  private gsLayerNameForKey(key: string): string | null {
    if (key === 'sst')           return 'aetherwx:sst-daily';
    if (key === 'windForecast')  return 'aetherwx:wind-speed';
    if (key === 'wavesForecast') return 'aetherwx:wave-hs';
    if (key === 'glofas')        return 'aetherwx:glofas-discharge';
    // G56 — workspace dépend du kind : gibs-daily → aetherwx-sat, cascade → aetherwx
    if (key.startsWith('sat') || key.startsWith('radar')) {
      const product = SAT_PRODUCTS.find((p) => p.key === key);
      return product ? `${product.workspace}:${product.gsName}` : null;
    }
    return null;
  }

  /** G18 M5 (2026-05-22) — alerts feed exposé du AlertsService.
   *  Panel dédié à droite quand showAlerts() && alertsList().length > 0. */
  readonly alertsList = this.alertsService.latestAlerts;

  alertKindLabel(kind: string): string {
    if (kind === 'high-wind') return 'Vent fort';
    if (kind === 'lightning-proximity') return 'Foudre à proximité';
    return kind;
  }

  formatAge(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}min`;
    return `${Math.round(seconds / 3600)}h`;
  }

  /** G18 M6 (2026-05-22) — reset toutes les layers à OFF + clear prefs.
   *  Parité /legacy-map resetLayerPrefs. Appelé via le button "↺ Reset"
   *  en bas du drawer. */
  resetLayerPrefs(): void {
    // Vector layers : passe par toggleVector pour bien removeLayer/removeSource
    for (const k of ['lightning', 'alerts', 'vessels', 'metar', 'hubeau', 'piezo', 'quakes', 'firms', 'buoys'] as const) {
      if ((this as any)[`show${k.charAt(0).toUpperCase()}${k.slice(1)}`]()) {
        void this.toggleVector(k);
      }
    }
    if (this.showTracks()) void this.toggleTracks(false);
    if (this.showRain())   void this.toggleRain(false);
    // Raster forecast
    if (this.showWindForecast())  this.toggleWindForecast(false);
    if (this.showWavesForecast()) this.toggleWavesForecast(false);
    if (this.showWindArrows())    this.toggleWindArrows(false);
    if (this.showWaveArrows())    this.toggleWaveArrows(false);
    // M4 contours
    if (this.showSstContours())  this.toggleSstContours(false);
    if (this.showWindContours()) this.toggleWindContours(false);
    if (this.showWaveContours()) this.toggleWaveContours(false);
    // Dynamics
    if (this.showSst())  this.toggleSst(false);
    if (this.showWind()) void this.toggleWind(false);
    // Sat layers (G16)
    for (const [k, sig] of Object.entries(this.satShowSignals())) {
      if (sig()) this.toggleSatLayer(k, false);
    }
    // Sources statiques
    if (this.showBathy()) this.toggleBathy(false);
    if (this.showEez())   this.toggleEez(false);
    if (this.showMpa())   this.toggleMpa(false);
    if (this.showGlofas()) this.toggleGlofas(false);
    // Opacities reset + clear localStorage
    this.layerOpacities.set({ ...this.LAYER_OPACITY_DEFAULTS });
    try {
      localStorage.removeItem('globe.prefs-v1');
      localStorage.removeItem('globe.layer-opacities-v1');
    } catch { /* silence */ }
  }

  /** G18 M3 (2026-05-22) — UX mode-aware (parité /map line 4524+).
   *  Détecte si cursor time-bar est sur "live" (±5min de now), futur ou passé.
   *  Sert à griser les toggles dont la layer ne peut PAS s'afficher (ex :
   *  vessels en future, METAR en past). Le `currentTime` signal de globe
   *  drive ces 3 computeds. */
  private static readonly LIVE_THRESHOLD_MS = 5 * 60_000;
  readonly modeIsLive   = computed(() => Math.abs(Date.now() - this.currentTime().getTime()) < GlobeComponent.LIVE_THRESHOLD_MS);
  readonly modeIsFuture = computed(() => this.currentTime().getTime() > Date.now() + GlobeComponent.LIVE_THRESHOLD_MS);
  readonly modeIsPast   = computed(() => !this.modeIsLive() && !this.modeIsFuture());

  /** Mapping layer→restrictions mode-aware (parité /map line 4589).
   *  - 'live-only' : alerts, buoys, lightning, metar, hubeau, piezo, quakes, firms
   *  - 'past-only' : tracks (granularité 1j)
   *  - 'no-future' : vessels (pas de forecast trajectoire)
   *  Retourne tooltip si incompatible, '' sinon. */
  layerModeWarning(key: string): string {
    const isLive = this.modeIsLive();
    const isFuture = this.modeIsFuture();
    const isPast = this.modeIsPast();
    const LIVE_ONLY = new Set(['alerts', 'buoys', 'lightning', 'metar', 'hubeau', 'piezo', 'quakes', 'firms']);
    const PAST_ONLY = new Set(['tracks']);
    const NO_FUTURE = new Set(['vessels']);
    if (LIVE_ONLY.has(key) && !isLive) {
      return 'Layer live-only — affichée seulement quand le cursor est sur maintenant. Clique NOW.';
    }
    if (PAST_ONLY.has(key) && !isPast) {
      return 'Layer past-only — affichée seulement en mode replay. Recule la time-bar.';
    }
    if (NO_FUTURE.has(key) && isFuture) {
      return 'Pas de forecast pour cette layer — recule la time-bar.';
    }
    return '';
  }

  /** *Active computeds : layer toggled ON ET compatible avec mode courant.
   *  Sert au rendu (apply visibility) et au styling (dim si toggled mais
   *  incompatible). */
  readonly vesselsActive  = computed(() => this.showVessels()  && !this.modeIsFuture());
  readonly tracksActive   = computed(() => this.showTracks()   && this.modeIsPast());
  readonly alertsActive   = computed(() => this.showAlerts()   && this.modeIsLive());
  readonly lightningActive = computed(() => this.showLightning() && this.modeIsLive());
  readonly metarActive    = computed(() => this.showMetar()    && this.modeIsLive());
  readonly hubeauActive   = computed(() => this.showHubeau()   && this.modeIsLive());
  readonly piezoActive    = computed(() => this.showPiezo()    && this.modeIsLive());
  readonly quakesActive   = computed(() => this.showQuakes()   && this.modeIsLive());
  readonly firmsActive    = computed(() => this.showFirms()    && this.modeIsLive());
  readonly buoysActive    = computed(() => this.showBuoys()    && this.modeIsLive());
  readonly sstActive      = computed(() => this.showSst()      && !this.modeIsFuture());
  /** G19 — wind (raster forecast) active = toggle ON. Pas de restriction mode
   *  pour le forecast (peut être past/live/future selon disponibilité GFS). */
  readonly windActive     = computed(() => this.showWindForecast());

  /** G19 (2026-05-22) — date d'imagerie satellite affichée dans le header
   *  de la section Satellites. NASA GIBS lag ~24h donc cap à J-1. Pour le
   *  globe on garde simple : toujours J-1 (le scrub time-bar par sat sera
   *  ajouté plus tard). Format `mer. 20 mai 2026`. */
  currentSatDate(): string {
    try {
      return new Date(Date.now() - 24 * 3_600_000).toLocaleDateString('fr-FR', {
        weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
      });
    } catch {
      return gibsDailyDate();
    }
  }

  /** G15 (2026-05-22) — sections accordéon du menu gauche, calquées sur /map.
   *  6 sections regroupant les 22+ layers globe. Default = Maritime+Sources
   *  ouvertes, autres fermées (UX scan rapide). */
  readonly catalogSections = signal<{
    maritime: boolean;
    observation: boolean;
    satellites: boolean;
    radar: boolean;
    forecast: boolean;
    dynamics: boolean;
    hydrology: boolean;
    sources: boolean;
  }>({
    maritime: true,
    observation: false,
    satellites: false,
    radar: false,
    forecast: false,
    dynamics: false,
    hydrology: false,
    sources: false,
  });

  toggleCatalogSection(key: keyof ReturnType<typeof this.catalogSections>): void {
    // G22 (2026-05-22) — mutex single section open (parité /map ligne 4115).
    // Évite que le menu gauche devienne trop long quand plusieurs sont ouvertes.
    this.catalogSections.update((s) => {
      const wasOpen = s[key];
      const next: typeof s = {
        maritime: false, observation: false, satellites: false, radar: false,
        forecast: false, dynamics: false, hydrology: false, sources: false,
      };
      next[key] = !wasOpen;
      return next;
    });
  }

  /** G19 — Compteur "X actives / Y totales" par section, calqué identique
   *  /legacy-map (cf map.component.ts line 4123) pour parité visuelle. */
  catalogSectionCount(key: keyof ReturnType<typeof this.catalogSections>): { active: number; total: number } {
    switch (key) {
      case 'maritime': {
        // 7 layers : vessels, tracks, alerts, buoys, SST, waves, waveArrows
        const flags = [this.showVessels(), this.showTracks(), this.showAlerts(), this.showBuoys(),
                       this.showSst(), this.showWavesForecast(), this.showWaveArrows()];
        return { active: flags.filter(Boolean).length, total: flags.length };
      }
      case 'observation': {
        // 4 layers : lightning, metar, quakes, firms (rain déplacé Radar)
        const flags = [this.showLightning(), this.showMetar(), this.showQuakes(), this.showFirms()];
        return { active: flags.filter(Boolean).length, total: flags.length };
      }
      case 'hydrology': {
        // G68 (2026-05-28) — EFAS overlay statique remplacé par GloFAS raster.
        const flags = [this.showHubeau(), this.showPiezo(), this.showGlofas()];
        return { active: flags.filter(Boolean).length, total: flags.length };
      }
      case 'satellites': {
        // 11 layers : 7 GIBS + 4 cascade/RainViewer (matchant /map)
        const gibsKeys = ['satTrueColor','satTrueColorVIIRS','satIR','satWaterVapor','satCloudTop','satAerosol','satDayNight'];
        const cascadeKeys = ['satRainviewer','satEuIrRss','satGlobalIrMtg','satEuHrvRgb'];
        const all = [...gibsKeys, ...cascadeKeys];
        const active = all.filter((k) => this.satShowSignals()[k]?.()).length;
        return { active, total: all.length };
      }
      case 'radar': {
        // 3 layers : rain (RainViewer global), radarDwd, radarKnmi
        const flags = [this.showRain(), this.showRadarDwd(), this.showRadarKnmi()];
        return { active: flags.filter(Boolean).length, total: flags.length };
      }
      case 'forecast': {
        // 3 layers : wind (raster forecast), windArrows, windParticles (WebGL)
        const flags = [this.showWindForecast(), this.showWindArrows(), this.showWind()];
        return { active: flags.filter(Boolean).length, total: flags.length };
      }
      case 'dynamics': {
        // Garde compat — section inutilisée par le template /map mais signal type encore défini.
        return { active: 0, total: 0 };
      }
      case 'sources': {
        // 1 fixe (basemap toujours actif) + 3 WMS sources (bathy/eez/mpa)
        const flags = [this.showBathy(), this.showEez(), this.showMpa()];
        return { active: 1 + flags.filter(Boolean).length, total: 1 + flags.length };
      }
    }
  }

  /** G11c (2026-05-22) — playback animation temporelle (+6h/s).
   *  Toggle via bouton ▶︎ du TimeSliderComponent. */
  readonly playing = signal<boolean>(false);
  private animTimer?: ReturnType<typeof setInterval>;

  /** G21 (2026-05-22) — Animation player parité /legacy-map.
   *  Injecte AnimationPlayerService (singleton @Injectable root). Cf
   *  spec sub-agent A5d87 pour wiring détaillé. Public pour template binding. */
  readonly animPlayer = inject(AnimationPlayerService);
  readonly animPanelOpen = signal<boolean>(false);

  /** G64 (2026-05-24) — true pendant playback/pause d'animation. Drive :
   *  - hide left drawer (.legend--anim-hidden)
   *  - disable nav links + brand-icon button (pointer-events:none + opacity)
   *  Inclut phase loading overlay (animLoadingState != null) pour bloquer
   *  TOUT pendant le pré-chargement aussi. */
  readonly isAnimating = computed(() =>
    this.animPlayer.state() !== 'idle' || this.animLoadingState() !== null
  );
  /** G53 (2026-05-24) — état overlay "Préparation animation". `null` = caché.
   *  phase=capabilities : GetCapabilities en cours (récup validités master).
   *  phase=tiles : pre-load tuiles WMS (master en N raster sources pour swap
   *  instantané + sub rasters via setTiles rotation pour warm GWC). done/total
   *  incrémenté event-driven via MapLibre `data` events sur source loaded. */
  readonly animLoadingState = signal<{
    phase: 'capabilities' | 'tiles';
    done: number;
    total: number;
    label: string;
  } | null>(null);
  /** G53e (2026-05-24) — AbortController du preload courant. Permet à
   *  l'utilisateur d'annuler via le bouton "Annuler" de l'overlay sans
   *  attendre que GetCapabilities timeout ou que le preload se termine. */
  private animPreloadAbort?: AbortController;

  /** G53e — handler du bouton "Annuler" sur l'overlay loading. Abort le
   *  preload courant + clear l'overlay. L'animation ne démarrera PAS. */
  cancelAnimLoading(): void {
    this.animPreloadAbort?.abort();
    this.animPreloadAbort = undefined;
    this.animLoadingState.set(null);
  }

  isForecastActive(): boolean {
    return this.showWindForecast() || this.showWavesForecast() || this.showWindArrows() || this.showWaveArrows();
  }

  openAnimationPanel(): void {
    if (this.animPlayer.state() !== 'idle') return;
    this.animPanelOpen.set(true);
  }
  closeAnimationPanel(): void { this.animPanelOpen.set(false); }

  /** Catalogue animatable pour le animation player. Mapping key → master
   *  GS layer name pour fetchTimestamps. */
  private readonly animatableLayersGlobe: Array<{ key: string; label: string; type: 'wms' | 'vector'; gsLayerName?: string }> = [
    { key: 'sst',           label: 'SST',             type: 'wms', gsLayerName: 'aetherwx:sst-daily' },
    { key: 'windForecast',  label: 'Vent forecast',   type: 'wms', gsLayerName: 'aetherwx:wind-speed' },
    { key: 'wavesForecast', label: 'Vagues forecast', type: 'wms', gsLayerName: 'aetherwx:wave-hs' },
    // G66 (2026-05-27) — 4 GFS forecast layers (coverages backend à venir)
    { key: 'temp2m',        label: 'Température 2m',  type: 'wms', gsLayerName: 'aetherwx:temp-2m' },
    { key: 'pressureMsl',   label: 'Pression MSL',    type: 'wms', gsLayerName: 'aetherwx:pressure-msl' },
    { key: 'humidity',      label: 'Humidité 2m',     type: 'wms', gsLayerName: 'aetherwx:humidity-2m' },
    { key: 'precipitation', label: 'Précipitations',  type: 'wms', gsLayerName: 'aetherwx:precipitation-6h' },
    // G68 (2026-05-28) — GloFAS river discharge forecast (Copernicus EWDS).
    // Raster GS time-enabled (7 validités daily, default=MAXIMUM). Remplace
    // l'ancien toggle EFAS overlay statique (archive proxy) par un vrai layer
    // raster animable, pattern identique aux forecasts GFS.
    { key: 'glofas',        label: 'GloFAS crues',    type: 'wms', gsLayerName: 'aetherwx:glofas-discharge' },
    ...SAT_PRODUCTS.map((p) => ({ key: p.key, label: p.label, type: 'wms' as const, gsLayerName: `${p.workspace}:${p.gsName}` })),
    { key: 'lightning',     label: 'Foudre',          type: 'vector' as const },
    { key: 'alerts',        label: 'Alertes',         type: 'vector' as const },
    { key: 'vessels',       label: 'Navires',         type: 'vector' as const },
  ];

  readonly masterLayerLabel = computed<string | null>(() => {
    const key = this.effectiveMasterLayerKey();
    if (!key) return null;
    return this.animatableLayersGlobe.find((l) => l.key === key)?.label ?? null;
  });

  async onAnimationLaunch(opts: AnimationOptions): Promise<void> {
    this.closeAnimationPanel();
    // G53e — abort tout preload courant orphelin (si user clique Lancer
    // deux fois sans attendre, ou si une animation tourne déjà).
    this.animPreloadAbort?.abort();
    this.animPreloadAbort = new AbortController();
    const abortSignal = this.animPreloadAbort.signal;
    const masterKey = this.effectiveMasterLayerKey();
    const master = masterKey ? this.animatableLayersGlobe.find((l) => l.key === masterKey) : undefined;
    // G53 (2026-05-24) — Phase 1 overlay : GetCapabilities en cours.
    // Affiche le blur + spinner indéterminé avant qu'on connaisse les validités.
    this.animLoadingState.set({
      phase: 'capabilities',
      done: 0,
      total: 1,
      label: master?.label ?? 'Animation',
    });
    let timestamps: Date[] = [];
    let effectiveOpts = opts;
    if (master) {
      try {
        // G39 (2026-05-23) — fetch ALL validities (range très large), puis
        // ré-ancrer la fenêtre d'animation sur la LATEST validité du master.
        // Sinon : SST observation J-13→J-4 vs anchor=now → window [now-24h,now]
        // sans data → fallback legacy 1h step (8 validités attendues, 24
        // frames inutiles obtenues). User-perçu : "cursor évolue à l'heure".
        const allTs = await this.fetchTimestamps(master, new Date(0), new Date(Date.now() + 7 * 86_400_000));
        if (allTs.length > 0) {
          const latest = allTs[allTs.length - 1];
          // Pour direction past, anchor sur latest pour que la fenêtre
          // capture la data réelle.
          const resolved = opts.direction === 'auto'
            ? (opts.forecastActive ? 'future' : 'past')
            : opts.direction;
          if (resolved === 'past') {
            effectiveOpts = { ...opts, anchor: latest };
          }
        }
        const { start, end } = this.computeAnimationWindow(effectiveOpts);
        timestamps = allTs.filter((t) => t.getTime() >= start.getTime() && t.getTime() <= end.getTime());
      } catch { /* fail-loud G49 ci-dessous */ }
    }
    // G53e — user a cliqué Annuler pendant GetCapabilities : bail out silencieux.
    if (abortSignal.aborted) { this.animLoadingState.set(null); return; }
    // G49 (2026-05-24) — Fail loud si pas de validité (au lieu du fallback
    // step 1h legacy qui masquait les bugs en amont). User feedback explicite :
    // animation DOIT itérer validity-by-validity, sinon afficher message UI.
    if (timestamps.length === 0) {
      this.animLoadingState.set(null);
      console.error('[globe-anim] No validities found for master', master?.label, 'in window');
      alert(
        `Aucune validité trouvée pour ${master?.label ?? 'le layer master'}.\n\n`
        + `Causes possibles :\n`
        + `• GS GetCapabilities trop lent (timeout 10s)\n`
        + `• Fenêtre d'animation hors plage des données disponibles\n`
        + `• Pas de master layer animatable actif\n\n`
        + `Essaie une durée plus large (7 jours).`,
      );
      return;
    }
    // G53 (2026-05-24) — Phase 2 overlay : pre-load tuiles WMS pour
    // master (N raster sources, swap instantané pendant playback) + sub
    // rasters actifs (rotate setTiles pour warm GWC). Barre progression
    // event-driven via map.on('data', ...). Quand tous loaded → close
    // overlay + start playback. Tradeoff : 2-5s d'attente initial pour
    // 100% smooth playback ensuite (GWC HIT garanti, cf invariant I-4).
    if (masterKey && timestamps.length > 1) {
      await this.preloadAllRasterFrames(masterKey, timestamps, abortSignal);
    }
    // G53e — user a cliqué Annuler pendant le preload : bail out silencieux.
    if (abortSignal.aborted) { this.animLoadingState.set(null); return; }
    this.animLoadingState.set(null);
    this.animPreloadAbort = undefined;
    try {
      this.animPlayer.start({ ...effectiveOpts, timestamps, masterLayerLabel: master?.label ?? undefined });
    } catch (err) {
      console.error('[globe-anim] animPlayer.start failed:', err);
      alert(`Animation impossible : ${(err as Error).message}`);
    }
  }

  /** G41/G53 — frames pré-chargées : map<masterKey, { timestamps, layerIds }>
   *  layerIds = sources créées pour le MASTER uniquement (swap instantané
   *  pendant playback). Les sub rasters sont pré-warmés via setTiles rotation
   *  (warm GWC) puis pilotés par refreshWmsTimeForActiveLayers pendant les
   *  ticks animation (HIT GWC). */
  private preloadedFrames?: { masterKey: string; timestamps: Date[]; layerIds: string[]; mainLayerId: string };

  /** G53 (2026-05-24) — descriptor d'un raster animable. dateFormatter applique
   *  le bon format au TIME selon le type (daily YYYY-MM-DD vs ISO hourly). */
  private readonly rasterTargets: Record<string, {
    layerId: string;
    gsName: string;
    style?: string;
    interpolations?: string;
    daily: boolean;
    visible: () => boolean;
  } | undefined> = {};

  /** G53 — construit la liste des descriptors raster à pre-loader. Appelé
   *  à la volée car les show* signals changent. Inclut master + tous sub
   *  rasters actifs (contours, multi-sat stack, etc.). */
  private buildRasterTargets(): Array<NonNullable<typeof this.rasterTargets[string]> & { key: string }> {
    const out: Array<NonNullable<typeof this.rasterTargets[string]> & { key: string }> = [];
    if (this.showSst()) out.push({ key: 'sst', layerId: 'sst-wms', gsName: 'aetherwx:sst-daily', style: 'sst-direct', interpolations: 'bicubic', daily: true, visible: () => this.showSst() });
    if (this.showSstContours()) out.push({ key: 'sstContours', layerId: 'sst-contours-wms', gsName: 'aetherwx:sst-daily', style: 'aetherwx:sst-contours-only', interpolations: 'bicubic', daily: true, visible: () => this.showSstContours() });
    if (this.showWindForecast()) out.push({ key: 'windForecast', layerId: 'wind-forecast-wms', gsName: 'aetherwx:wind-speed', interpolations: 'bicubic', daily: false, visible: () => this.showWindForecast() });
    if (this.showWindContours()) out.push({ key: 'windContours', layerId: 'wind-contours-wms', gsName: 'aetherwx:wind-speed', style: 'aetherwx:wind-speed-contours-only', interpolations: 'bicubic', daily: false, visible: () => this.showWindContours() });
    if (this.showWavesForecast()) out.push({ key: 'wavesForecast', layerId: 'waves-forecast-wms', gsName: 'aetherwx:wave-hs', interpolations: 'bicubic', daily: false, visible: () => this.showWavesForecast() });
    if (this.showWaveContours()) out.push({ key: 'waveContours', layerId: 'wave-contours-wms', gsName: 'aetherwx:wave-hs', style: 'aetherwx:wave-hs-contours-only', interpolations: 'bicubic', daily: false, visible: () => this.showWaveContours() });
    // G68 (2026-05-28) — GloFAS forecast raster (non-daily, ISO TIME, style GS
    // glofas-discharge). Preload des frames d'animation comme SST/wind/waves.
    if (this.showGlofas()) out.push({ key: 'glofas', layerId: 'glofas-wms', gsName: 'aetherwx:glofas-discharge', style: 'glofas-discharge', daily: false, visible: () => this.showGlofas() });
    for (const [satKey, sig] of Object.entries(this.satShowSignals())) {
      if (!sig()) continue;
      const product = SAT_PRODUCTS.find((p) => p.key === satKey);
      if (!product) continue;
      out.push({
        key: satKey,
        layerId: `sat-${satKey}`,
        gsName: `${product.workspace}:${product.gsName}`,
        daily: product.kind === 'gibs-daily',
        visible: () => !!this.satShowSignals()[satKey]?.(),
      });
    }
    return out;
  }

  private formatWmsTime(ts: Date, daily: boolean): string {
    if (daily) {
      return `${ts.getUTCFullYear()}-${String(ts.getUTCMonth() + 1).padStart(2, '0')}-${String(ts.getUTCDate()).padStart(2, '0')}`;
    }
    return ts.toISOString().split('.')[0] + 'Z';
  }

  private buildAnimFrameUrl(t: { gsName: string; style?: string; interpolations?: string; daily: boolean }, ts: Date): string {
    const time = this.formatWmsTime(ts, t.daily);
    // G56 — workspace dérivé du préfixe du gsName (aetherwx-sat: → /geoserver/aetherwx-sat/wms)
    const ws = t.gsName.split(':')[0];
    return `/geoserver/${ws}/wms?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap` +
      `&LAYERS=${encodeURIComponent(t.gsName)}` +
      `&STYLES=${t.style ? encodeURIComponent(t.style) : ''}` +
      `&FORMAT=image/png&TRANSPARENT=true&tiled=true` +
      (t.interpolations ? `&INTERPOLATIONS=${t.interpolations}` : '') +
      `&TIME=${encodeURIComponent(time)}` +
      `&SRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256`;
  }

  /** G53d (2026-05-24) — fix v3 : abandon des MapLibre events (target
   *  overwritten au bubble Evented → sourceId perdu). Approche bulletproof :
   *  monkey-patch window.fetch pendant le preload. On filtre les URL
   *  GeoServer WMS qui matchent les gsName de nos targets actives. Chaque
   *  fetch dispatched = totalDispatched++. Chaque promise résolue (ok ou
   *  ko) = totalCompleted++. Immune aux abstractions MapLibre. Restore
   *  window.fetch après le preload. */
  private async preloadAllRasterFrames(masterKey: string, timestamps: Date[], abortSignal?: AbortSignal): Promise<void> {
    const map = this.map;
    if (!map) return;
    this.cleanupAnimationFrames();

    const targets = this.buildRasterTargets();
    if (targets.length === 0) return;

    // Build regex matchant les gsName watched. Encoded form : `aetherwx%3A`.
    const watchedGsNames = targets.map((t) => t.gsName.replace(/:/g, '%3A'));
    const isWatchedUrl = (url: string | undefined): boolean => {
      if (!url || !/\/geoserver\/.*wms/i.test(url)) return false;
      if (!/REQUEST=GetMap/i.test(url)) return false;
      return watchedGsNames.some((gsName) => url.includes(gsName));
    };

    let totalDispatched = 0;
    let totalCompleted = 0;
    const updateState = () => {
      const st = this.animLoadingState();
      if (st) this.animLoadingState.set({ ...st, done: totalCompleted, total: totalDispatched });
    };

    const origFetch = window.fetch.bind(window);
    const patchedFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (isWatchedUrl(url)) {
        totalDispatched++;
        updateState();
        return origFetch(input, init).finally(() => {
          totalCompleted++;
          updateState();
        });
      }
      return origFetch(input, init);
    };
    window.fetch = patchedFetch;

    this.animLoadingState.set({ phase: 'tiles', done: 0, total: 0, label: this.masterLayerLabel() ?? 'Animation' });

    const masterTarget = targets.find((t) => t.key === masterKey);
    const subTargets = targets.filter((t) => t.key !== masterKey);
    const layerIds: string[] = [];
    let mainLayerId = '';

    try {
      // ── G55 (2026-05-24) — N-source pattern pour le master layer ──
      // Crée N raster sources (1 par TS), visibility:visible + opacity:0
      // pour forcer le fetch sans visuel. Pendant playback, swap atomic
      // opacity entre sources → zéro re-fetch, zéro bottom-up draw.
      if (masterTarget && timestamps.length > 1) {
        mainLayerId = masterTarget.layerId;
        // Masque le layer original pendant l'animation
        if (map.getLayer(mainLayerId)) map.setLayoutProperty(mainLayerId, 'visibility', 'none');
        for (let i = 0; i < timestamps.length; i++) {
          if (abortSignal?.aborted) return;
          const sourceId = `anim-${masterKey}-${i}`;
          const url = this.buildAnimFrameUrl(masterTarget, timestamps[i]);
          map.addSource(sourceId, { type: 'raster', tiles: [url], tileSize: 256 });
          map.addLayer({
            id: sourceId, type: 'raster', source: sourceId,
            // visible mais opacity 0 pendant le preload → MapLibre fetch
            // les tuiles mais rien n'est rendu à l'écran.
            layout: { visibility: 'visible' },
            paint: { 'raster-opacity': 0, 'raster-fade-duration': 0 },
          });
          layerIds.push(sourceId);
        }
        // Attend que toutes les tuiles master soient chargées
        await this.waitForAllTilesLoaded(map, 30_000, abortSignal);
        if (abortSignal?.aborted) return;
        // Stocke les frames preloadées
        this.preloadedFrames = { masterKey, timestamps, layerIds, mainLayerId };
        // Affiche frame 0
        this.switchAnimationFrame(0);
      }

      // ── Sub rasters : warm GWC via setTiles rotation (tick playback HIT) ──
      for (const sub of subTargets) {
        if (abortSignal?.aborted) return;
        const src = map.getSource(sub.layerId) as maplibregl.RasterTileSource | undefined;
        if (!src || typeof src.setTiles !== 'function') continue;
        for (const ts of timestamps) {
          if (abortSignal?.aborted) return;
          src.setTiles([this.buildAnimFrameUrl(sub, ts)]);
          map.triggerRepaint();
          await this.waitForAllTilesLoaded(map, 10_000, abortSignal);
        }
      }

      // Restore TIME courant du cursor sur les sub rasters (master est géré par swap).
      this.refreshWmsTimeForActiveLayers();
      await this.waitForAllTilesLoaded(map, 5_000, abortSignal);
    } finally {
      // Restore le fetch original (sinon les fetches d'API post-preload
      // continueraient d'incrémenter notre compteur orphelin).
      window.fetch = origFetch;
    }
  }

  /** G53c — attend que `map.areTilesLoaded()` retourne true (TOUTES les
   *  tiles de TOUTES les sources visibles sont chargées) OU timeout. Plus
   *  fiable que `source.loaded()` pour raster sources : ce dernier mesure
   *  le tileJSON loading state, pas les tiles individuelles.
   *  Initial delay 100ms pour laisser MapLibre dispatcher les fetches. */
  private waitForAllTilesLoaded(map: maplibregl.Map, timeoutMs: number, abortSignal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const start = Date.now();
      const check = () => {
        if (abortSignal?.aborted) { resolve(); return; }
        try {
          if (map.areTilesLoaded()) { resolve(); return; }
        } catch { resolve(); return; }
        if (Date.now() - start > timeoutMs) { resolve(); return; }
        setTimeout(check, 80);
      };
      setTimeout(check, 100);
    });
  }

  /** G55 (2026-05-24) — swap raster-opacity entre N sources pré-chargées.
   *  Toutes les sources restent visibility:visible (sinon MapLibre purge
   *  leurs tuiles) ; on alterne opacity 0/0.7 entre celles-ci. Atomic
   *  côté GPU, aucun re-fetch, zéro bottom-up draw. */
  private switchAnimationFrame(idx: number): void {
    const map = this.map;
    if (!map || !this.preloadedFrames) return;
    const { layerIds } = this.preloadedFrames;
    for (let i = 0; i < layerIds.length; i++) {
      if (map.getLayer(layerIds[i])) {
        map.setPaintProperty(layerIds[i], 'raster-opacity', i === idx ? 0.7 : 0);
      }
    }
  }

  /** G41 — nettoyage des frames pré-chargées à la fin de l'animation. */
  private cleanupAnimationFrames(): void {
    const map = this.map;
    if (!map || !this.preloadedFrames) return;
    for (const id of this.preloadedFrames.layerIds) {
      if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(id)) map.removeSource(id);
    }
    // Re-affiche le layer principal.
    if (map.getLayer(this.preloadedFrames.mainLayerId)) {
      map.setLayoutProperty(this.preloadedFrames.mainLayerId, 'visibility', 'visible');
    }
    this.preloadedFrames = undefined;
  }

  private computeAnimationWindow(opts: AnimationOptions): { start: Date; end: Date } {
    const hours = { '6h': 6, '24h': 24, '3d': 72, '7d': 168 }[opts.duration];
    const ms = hours * 3_600_000;
    const resolved = opts.direction === 'auto'
      ? (opts.forecastActive ? 'future' : 'past')
      : opts.direction;
    const anchor = new Date(opts.anchor.getTime());
    anchor.setUTCMinutes(0, 0, 0);
    if (resolved === 'past') {
      return { start: new Date(anchor.getTime() - ms), end: anchor };
    }
    return { start: anchor, end: new Date(anchor.getTime() + ms) };
  }

  private async fetchTimestamps(
    master: { type: 'wms' | 'vector'; gsLayerName?: string },
    start: Date,
    end: Date,
  ): Promise<Date[]> {
    if (master.type === 'vector') {
      const STEP = 30 * 60_000;
      const out: Date[] = [];
      for (let t = start.getTime(); t <= end.getTime(); t += STEP) out.push(new Date(t));
      return out;
    }
    if (!master.gsLayerName) return [];
    // G54 (2026-05-24) — cascade-realtime bypass GS GetCapabilities :
    // GS skip silencieusement les WMSLayerInfo cascade dans GetCap à cause
    // d'un bug `JDBCResourceStore.file()` ("Directory not a file") sur le
    // SLD lookup proxy LocalWorkspaceCatalog. GetMap fonctionne quand même,
    // donc on synthétise les TIMEs client-side à partir du kind du produit
    // (5min RSS, 10min MTG, 15min HRV, 5min radar) ancrés sur now - 15min
    // (buffer pour le lag d'ingestion upstream EUMETSAT/DWD/KNMI).
    // G56 — supprime n'importe quel préfixe workspace (aetherwx:, aetherwx-sat:)
    const shortName = master.gsLayerName.replace(/^[^:]+:/, '');
    const product = SAT_PRODUCTS.find((p) => p.gsName === shortName);
    if (product?.kind === 'cascade-realtime') {
      const stepMs = this.cascadeStepMs(product.key);
      // G61 (2026-05-24) — buffer par produit cascade selon lag upstream
      // observé (EUMETSAT View Service GetCap default time vs now) :
      //   RSS 5min  → lag ~13min → buffer 30min
      //   MTG 10min → lag ~23min → buffer 45min
      //   HRV 15min → lag ~38min → buffer 75min (HRV processing pipeline long)
      //   radar    → lag ~10min → buffer 20min
      // Bug user "HRV même image en boucle" = mon ancien buffer 15min était
      // AHEAD du lag réel HRV → upstream renvoyait placeholder default.
      const bufferMs = this.cascadeBufferMs(product.key);
      const buffered = Math.floor((Date.now() - bufferMs) / stepMs) * stepMs;
      const out: Date[] = [];
      for (let t = start.getTime(); t <= end.getTime(); t += stepMs) {
        if (t > buffered) break;
        out.push(new Date(t));
      }
      // Si la window dépasse buffered, on synthétise quand même les N
      // derniers timestamps avant buffered pour donner du contenu animable.
      if (out.length === 0) {
        const n = Math.min(24, Math.max(1, Math.floor((end.getTime() - start.getTime()) / stepMs)));
        for (let i = n - 1; i >= 0; i--) out.push(new Date(buffered - i * stepMs));
      }
      return out;
    }
    try {
      // G56 — workspace dépend du layer prefix (aetherwx-sat: → /geoserver/aetherwx-sat/wms).
      // GetCap workspace-scoped est plus rapide (moins de layers à agréger côté serveur).
      const ws = master.gsLayerName.split(':')[0];
      const url = `/geoserver/${ws}/wms?service=WMS&version=1.3.0&request=GetCapabilities`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!resp.ok) throw new Error(`GetCapabilities HTTP ${resp.status}`);
      const xml = await resp.text();
      return this.parseTimeDimension(xml, master.gsLayerName)
        .filter((t) => t.getTime() >= start.getTime() && t.getTime() <= end.getTime());
    } catch (err) {
      console.warn('[globe-anim] GetCapabilities échec :', err);
      return [];
    }
  }

  /** G54 — step natif des cascade WMS upstream, dérivé du label.
   *  EUMETSAT MSG RSS = 5min, MTG FCI = 10min, HRV = 15min.
   *  DWD/KNMI radar = 5min. */
  private cascadeStepMs(productKey: string): number {
    if (productKey === 'satEuIrRss' || productKey === 'radarDwd' || productKey === 'radarKnmi') return 5 * 60_000;
    if (productKey === 'satGlobalIrMtg') return 10 * 60_000;
    if (productKey === 'satEuHrvRgb') return 15 * 60_000;
    return 15 * 60_000;
  }

  /** G61 (2026-05-24) — buffer par produit cascade, mesuré contre
   *  EUMETSAT View Service GetCap default time vs now (2026-05-24) :
   *    RSS lag 13min, MTG lag 23min, HRV lag 38min, radar lag ~10min.
   *  On prend ~2× le lag observé pour marge variable.
   *  Si le user voit "image en boucle" sur un produit, augmenter ici. */
  private cascadeBufferMs(productKey: string): number {
    if (productKey === 'satEuIrRss') return 30 * 60_000;
    if (productKey === 'satGlobalIrMtg') return 45 * 60_000;
    if (productKey === 'satEuHrvRgb') return 75 * 60_000;
    if (productKey === 'radarDwd' || productKey === 'radarKnmi') return 20 * 60_000;
    return 30 * 60_000;
  }

  private parseTimeDimension(xml: string, layerName: string): Date[] {
    // G56 — supprime le préfixe workspace quel qu'il soit (aetherwx: ou aetherwx-sat:)
    const shortName = layerName.replace(/^[^:]+:/, '');
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.querySelector('parsererror')) return [];
    const layers = Array.from(doc.querySelectorAll('Layer'));
    const targetLayer = layers.find((l) => {
      const nameEl = Array.from(l.children).find((c) => c.tagName === 'Name');
      return nameEl?.textContent?.trim() === shortName;
    });
    if (!targetLayer) return [];
    let timeDim: Element | null = null;
    let current: Element | null = targetLayer;
    while (current && !timeDim) {
      const local = Array.from(current.children).find(
        (c) => c.tagName === 'Dimension' && c.getAttribute('name') === 'time',
      );
      if (local) { timeDim = local; break; }
      current = current.parentElement?.closest('Layer') ?? null;
    }
    if (!timeDim) return [];
    const raw = timeDim.textContent?.trim() ?? '';
    const out: Date[] = [];
    for (const token of raw.split(',')) {
      const trimmed = token.trim();
      if (!trimmed) continue;
      if (trimmed.includes('/')) {
        const parts = trimmed.split('/');
        if (parts.length !== 3) continue;
        const s = new Date(parts[0]);
        const e = new Date(parts[1]);
        if (isNaN(s.getTime()) || isNaN(e.getTime())) continue;
        const periodMs = this.parseIsoPeriodMs(parts[2]);
        if (periodMs <= 0) continue;
        const now = Date.now();
        const windowStart = Math.max(s.getTime(), now - 168 * 3_600_000);
        const windowEnd = Math.min(e.getTime(), now + 168 * 3_600_000);
        if (windowStart > windowEnd) continue;
        const MAX_TS = 500;
        const stepMsEff = Math.max(periodMs, (windowEnd - windowStart) / MAX_TS);
        const firstSnap = Math.ceil(windowStart / periodMs) * periodMs;
        for (let t = firstSnap; t <= windowEnd; t += stepMsEff) out.push(new Date(t));
        continue;
      }
      const d = new Date(trimmed);
      if (!isNaN(d.getTime())) out.push(d);
    }
    return out;
  }

  private parseIsoPeriodMs(period: string): number {
    const m = period.match(/^P(?:T)?(\d+)([MHD])$/);
    if (!m) return 0;
    const n = parseInt(m[1], 10);
    const unit = m[2];
    if (unit === 'M') return n * 60_000;
    if (unit === 'H') return n * 3_600_000;
    if (unit === 'D') return n * 86_400_000;
    return 0;
  }

  /** G11d (2026-05-22) — opacité par layer key. Défauts cohérents /map :
   *  raster forecast/sst = 0.7 (blend lisible), sat = 0.85, sources stat
   *  = 0.6, vector = 1, animations = 0.9. Persisté localStorage.
   *  Slider 0-1 step 0.05 dans la sidebar. */
  private readonly LAYER_OPACITY_DEFAULTS: Record<string, number> = {
    sst: 0.7, windForecast: 0.7, wavesForecast: 0.7,
    windArrows: 0.9, waveArrows: 0.9,
    bathy: 0.7, eez: 0.6, mpa: 0.6,
    glofas: 0.75,
    rain: 0.75,
  };
  readonly layerOpacities = signal<Record<string, number>>({ ...this.LAYER_OPACITY_DEFAULTS });

  /** G7 (2026-05-22) — porté depuis /map Sprint Z. Rank sémantique pour
   *  l'ordre Z auto : sat (0, fond images larges) → raster sst (1) → radar
   *  (2) → WFS (4, points/lignes) → animations (5, particules au sommet). */
  private readonly LAYER_CATEGORY: Record<string, number> = {
    satTrueColor: 0, satTrueColorVIIRS: 0, satIR: 0, satWaterVapor: 0,
    satCloudTop: 0, satAerosol: 0, satDayNight: 0,
    satEuIrRss: 0, satGlobalIrMtg: 0, satEuHrvRgb: 0,
    sst: 1, windForecast: 1, wavesForecast: 1, glofas: 1,
    bathy: 0, eez: 0, mpa: 0,
    radarDwd: 2, radarKnmi: 2,
    lightning: 4, alerts: 4, vessels: 4,
    metar: 4, hubeau: 4, piezo: 4, quakes: 4, firms: 4, buoys: 4,
    tracks: 4,
    rain: 2,
    windArrows: 5, waveArrows: 5, windParticles: 5,
  };
  private readonly DEFAULT_LAYER_RANK = 3;

  /** G7 — mode Z-index auto. Quand ON, recompute layerZIndexOrder à chaque
   *  changement d'activation. Quand l'user drag, bascule à OFF. */
  readonly autoZIndexEnabled = signal<boolean>(true);
  readonly layerZIndexOrder = signal<string[]>([]);

  /** G7 — master du temps. Drive masterValidityList. null = auto-pick
   *  (premier WMS time-enabled actif). */
  readonly masterLayerKey = signal<string | null>(null);

  /** G6b — bornes alignées sur la fenêtre des validités master.
   *  Sat/SST = past 168h, futur 0 (cf masterValidityList).
   *  Pas de WMS time-enabled actif = fallback ±6h. */
  readonly sliderMinTime = computed<Date>(() => {
    const list = this.masterValidityList();
    if (list.length > 0) return list[0];
    return new Date(this.currentTime().getTime() - 6 * 3_600_000);
  });
  readonly sliderMaxTime = computed<Date>(() => {
    const list = this.masterValidityList();
    if (list.length > 0) return list[list.length - 1];
    return new Date(this.currentTime().getTime() + 6 * 3_600_000);
  });

  /** G6/G7/G9 — couverture des layers actifs sur la time-bar. 1 rangée par layer
   *  actif. canBeMaster = WMS time-enabled (sat/sst/forecast). isMaster = la
   *  layer active maître du temps. Ordre dérivé de layerZIndexOrder. */
  readonly sliderLayerCoverage = computed<TimeSliderLayerCoverage[]>(() => {
    const out: TimeSliderLayerCoverage[] = [];
    const isWmsTime = (k: string) => k === 'sst' || k.startsWith('sat') ||
      k === 'windForecast' || k === 'wavesForecast' || k === 'windArrows' || k === 'waveArrows' ||
      // G66 (2026-05-27) — 4 GFS forecast eligible master
      k === 'temp2m' || k === 'pressureMsl' || k === 'humidity' || k === 'precipitation' ||
      // G68 (2026-05-28) — GloFAS forecast eligible master
      k === 'glofas';
    const master = this.effectiveMasterLayerKey();
    const push = (active: boolean, key: string, name: string, color: string, pastH: number, futureH: number) => {
      if (active) out.push({
        key, name, color, pastH, futureH,
        isMaster: master === key,
        canBeMaster: isWmsTime(key),
      });
    };
    push(this.showSst(),       'sst',       'sst',       '#3b82f6', 168, 0);
    push(this.showWind(),      'windParticles', 'wind-particles', '#10b981', 0, 168);
    push(this.showLightning(), 'lightning', 'lightning', '#facc15', 1, 0);
    push(this.showAlerts(),    'alerts',    'alerts',    '#ef4444', 1, 0);
    // G66c (2026-05-27) — SIGMET valid 2h sliding window, TAF 12h future window.
    push(this.showSigmet(),    'sigmet',    'sigmet',    '#dc2626', 2, 0);
    push(this.showTaf(),       'taf',       'taf',       '#3b82f6', 0, 12);
    push(this.showVessels(),   'vessels',   'vessels',   '#06b6d4', 24, 0);
    push(this.showMetar(),     'metar',     'metar',     '#fbbf24', 6, 0);
    push(this.showHubeau(),    'hubeau',    'hubeau',    '#06b6d4', 24, 0);
    push(this.showPiezo(),     'piezo',     'piezo',     '#8b5cf6', 24, 0);
    push(this.showQuakes(),    'quakes',    'quakes',    '#ef4444', 24, 0);
    push(this.showFirms(),     'firms',     'firms',     '#f97316', 24, 0);
    push(this.showBuoys(),     'buoys',     'buoys',     '#10b981', 24, 0);
    push(this.showTracks(),    'tracks',    'tracks',    '#22c55e', 24, 0);
    push(this.showRain(),      'rain',      'rain',      '#22d3ee', 2, 0);
    push(this.showWindForecast(),  'windForecast',  'wind',         '#22c55e', 168, 168);
    push(this.showWavesForecast(), 'wavesForecast', 'waves',        '#3b82f6', 168, 168);
    push(this.showWindArrows(),    'windArrows',    'wind-arrows',  '#22c55e', 168, 168);
    push(this.showWaveArrows(),    'waveArrows',    'wave-arrows',  '#3b82f6', 168, 168);
    // G66 (2026-05-27) — 4 GFS forecast layers (±7j conformes data_layer_policy)
    push(this.showTemp2m(),        'temp2m',        'temp-2m',      '#ef4444', 168, 168);
    push(this.showPressureMsl(),   'pressureMsl',   'pressure-msl', '#a855f7', 168, 168);
    push(this.showHumidity(),      'humidity',      'humidity-2m',  '#0ea5e9', 168, 168);
    push(this.showPrecipitation(), 'precipitation', 'precip-6h',    '#22d3ee', 168, 168);
    // G68 (2026-05-28) — GloFAS river discharge forecast (±7j conforme data_layer_policy).
    push(this.showGlofas(),        'glofas',        'glofas',       '#0ea5e9', 168, 168);
    // G16 — push une rangée par produit sat ACTIVÉ (stacking multi-sat).
    for (const [key, sig] of Object.entries(this.satShowSignals())) {
      if (sig()) {
        const sat = SAT_PRODUCTS.find((p) => p.key === key);
        if (sat) push(true, sat.key, sat.gsName, '#a855f7', 168, 0);
      }
    }
    // G7 — réordonne selon layerZIndexOrder. Layers non listées (= ordre user
    // n'a pas encore tagué cette layer) gardent l'ordre déclaratif ci-dessus.
    const zOrder = this.layerZIndexOrder();
    if (zOrder.length > 0) {
      out.sort((a, b) => {
        const ia = zOrder.indexOf(a.key);
        const ib = zOrder.indexOf(b.key);
        if (ia === -1 && ib === -1) return 0;
        if (ia === -1) return 1;
        if (ib === -1) return -1;
        return ia - ib;
      });
    }
    return out;
  });

  /** G7/G9 — masterLayerKey effectif. Si user a pick explicite → c'est lui.
   *  Sinon fallback : 1er WMS time-enabled actif (sat > sst > forecast). */
  private readonly effectiveMasterLayerKey = computed<string | null>(() => {
    const explicit = this.masterLayerKey();
    if (explicit) {
      if (explicit === 'sst' && this.showSst()) return explicit;
      if (explicit.startsWith('sat') && this.isSatActive(explicit)) return explicit;
      if (explicit === 'windForecast'  && this.showWindForecast())  return explicit;
      if (explicit === 'wavesForecast' && this.showWavesForecast()) return explicit;
      if (explicit === 'windArrows'    && this.showWindArrows())    return explicit;
      if (explicit === 'waveArrows'    && this.showWaveArrows())    return explicit;
      // G68 (2026-05-28) — GloFAS master explicite
      if (explicit === 'glofas'        && this.showGlofas())        return explicit;
    }
    // G16 fallback : 1er sat actif (ordre déclaratif SAT_PRODUCTS) sinon sst > forecast.
    for (const [key, sig] of Object.entries(this.satShowSignals())) {
      if (sig()) return key;
    }
    if (this.showSst()) return 'sst';
    if (this.showWindForecast()) return 'windForecast';
    if (this.showWavesForecast()) return 'wavesForecast';
    // G66 (2026-05-27) — 4 GFS forecast après wind/waves dans le fallback master.
    if (this.showTemp2m()) return 'temp2m';
    if (this.showPressureMsl()) return 'pressureMsl';
    if (this.showHumidity()) return 'humidity';
    if (this.showPrecipitation()) return 'precipitation';
    // G68 (2026-05-28) — GloFAS forecast après GFS dans le fallback master.
    if (this.showGlofas()) return 'glofas';
    if (this.showWindArrows()) return 'windArrows';
    if (this.showWaveArrows()) return 'waveArrows';
    return null;
  });

  /** G6 — handler timeChange du slider. Set le signal + refresh les WMS
   *  sources actives (sst, sat) avec la nouvelle date. */
  onSliderTimeChange(t: Date): void {
    this.currentTime.set(t);
    this.refreshWmsTimeForActiveLayers();
  }

  /** G7 — handler ★ click du slider. Set le master du temps explicite. */
  setMasterLayer(key: string): void {
    this.masterLayerKey.set(key);
  }

  /** G11d — opacité courante d'une layer (avec fallback default). */
  getLayerOpacity(key: string): number {
    return this.layerOpacities()[key] ?? this.LAYER_OPACITY_DEFAULTS[key] ?? 1;
  }

  /** G11d / G72 (2026-06-16) — handler slider opacité unifié.
   *  Update signal + délègue au helper applyOpacityToMapLayer (1 implémentation,
   *  tous les types MapLibre + le custom WebGL wind-particles). Persiste
   *  localStorage. */
  setLayerOpacity(key: string, value: number): void {
    const v = Math.max(0, Math.min(1, value));
    this.layerOpacities.update((o) => ({ ...o, [key]: v }));
    const map = this.map;
    if (!map) return;
    for (const id of this.mapLibreLayerIds(key)) {
      this.applyOpacityToMapLayer(id, v);
    }
    this.persistLayerOpacities();
  }

  /** G72 (2026-06-16) — central helper opacité, équivalent du
   *  `layer.setOpacity(v)` d'OpenLayers mais pour MapLibre.
   *
   *  MapLibre n'a pas d'API unifiée — l'opacité est une paint property
   *  qui dépend du type de layer (`raster-opacity` / `symbol` a
   *  `icon-opacity`+`text-opacity` / `circle-opacity` / etc.). Les
   *  custom layers (WebGL particules) exposent un setter custom.
   *  Cette fonction centralise les 8 cas pour qu'un slider opacity
   *  soit codé UNE fois et marche pour toute layer.
   *
   *  Si la layer n'existe pas encore (toggle off), no-op silencieux ;
   *  l'opacité sera baked dans le paint à la prochaine `addLayer`. */
  private applyOpacityToMapLayer(layerId: string, v: number): void {
    const map = this.map;
    if (!map) return;
    // Cas custom WebGL : wind particules (CustomLayerInterface). Pas
    // de paint property, c'est WindWebGL.opacity qui pilote le uniform
    // u_opacity dans le fragment shader (G72).
    if (layerId === 'wind-webgl') {
      if (this.windEngine) this.windEngine.opacity = v;
      return;
    }
    const layer = map.getLayer(layerId);
    if (!layer) return;
    switch (layer.type) {
      case 'raster':
        map.setPaintProperty(layerId, 'raster-opacity', v);
        break;
      case 'fill':
        map.setPaintProperty(layerId, 'fill-opacity', v);
        break;
      case 'line':
        map.setPaintProperty(layerId, 'line-opacity', v);
        break;
      case 'circle':
        map.setPaintProperty(layerId, 'circle-opacity', v);
        map.setPaintProperty(layerId, 'circle-stroke-opacity', v);
        break;
      case 'symbol':
        // icon-opacity ET text-opacity — un symbole peut avoir l'un, l'autre,
        // ou les deux (ex. wind-arrows = icon seul, alerts = icon + text).
        map.setPaintProperty(layerId, 'icon-opacity', v);
        map.setPaintProperty(layerId, 'text-opacity', v);
        break;
      case 'heatmap':
        map.setPaintProperty(layerId, 'heatmap-opacity', v);
        break;
      case 'hillshade':
        map.setPaintProperty(layerId, 'hillshade-opacity', v);
        break;
      case 'background':
        map.setPaintProperty(layerId, 'background-opacity', v);
        break;
      // 'custom' déjà géré via wind-webgl plus haut.
    }
  }

  private persistLayerOpacities(): void {
    try {
      localStorage.setItem('globe.layer-opacities-v1', JSON.stringify(this.layerOpacities()));
    } catch { /* quota dépassé — ignore */ }
  }

  private restoreLayerOpacities(): void {
    try {
      const raw = localStorage.getItem('globe.layer-opacities-v1');
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, number>;
      this.layerOpacities.set({ ...this.LAYER_OPACITY_DEFAULTS, ...parsed });
    } catch { /* JSON malformed — ignore */ }
  }

  /** G11e (2026-05-22) — persist le state /globe (show* + autoZIndex +
   *  masterLayerKey). À chaque toggle de layer ou changement, le caller
   *  appelle `persistGlobePrefs()`. Le DB sync cross-device viendra plus
   *  tard (refacto prefsSync pour englober les keys /globe). */
  /** G11f (2026-05-22) — collecte le batch des prefs globe (visible+opacity)
   *  pour push DB cross-device via PreferencesSyncService. Keys identiques à
   *  /map (sst, lightning, alerts, vessels, metar, hubeau, piezo, quakes,
   *  firms, buoys, tracks, rain, wind, waves, windArrows, waveArrows, bathy,
   *  eez, mpa, glofas) → sync transparent /map ↔ /globe.
   *
   *  Skip : `wind` (= particules WebGL sur globe vs raster sur /map, sémantique
   *  différente), `activeSat` (radio select, pas un booléen). */
  private collectGlobeBatch(): Array<{ layerKind: string; visible: boolean; opacity: number }> {
    const batch: Array<{ layerKind: string; visible: boolean; opacity: number }> = [];
    const add = (key: string, visible: boolean) => {
      batch.push({ layerKind: key, visible, opacity: this.getLayerOpacity(key) });
    };
    add('sst',       this.showSst());
    add('lightning', this.showLightning());
    add('alerts',    this.showAlerts());
    add('vessels',   this.showVessels());
    add('metar',     this.showMetar());
    add('hubeau',    this.showHubeau());
    add('piezo',     this.showPiezo());
    add('quakes',    this.showQuakes());
    add('firms',     this.showFirms());
    add('buoys',     this.showBuoys());
    add('tracks',    this.showTracks());
    add('rain',      this.showRain());
    add('windArrows', this.showWindArrows());
    add('waveArrows', this.showWaveArrows());
    add('bathy',     this.showBathy());
    add('eez',       this.showEez());
    add('mpa',       this.showMpa());
    add('glofas',    this.showGlofas());
    // wind/waves raster match /map keys 'wind'/'waves' (sémantique identique).
    add('wind',  this.showWindForecast());
    add('waves', this.showWavesForecast());
    return batch;
  }

  private persistGlobePrefs(): void {
    // Push debounced DB sync (cross-device) si user auth — silent fail si offline.
    if (this.auth.isAuthenticated()) {
      this.prefsSync.schedulePushBatch(this.collectGlobeBatch());
    }
    try {
      // G16 — collecte les 13 sat signals en un sub-object
      const satState: Record<string, boolean> = {};
      for (const [key, sig] of Object.entries(this.satShowSignals())) {
        satState[key] = sig();
      }
      const state = {
        showSst: this.showSst(),
        showWind: this.showWind(),
        activeSat: this.activeSat(),   // legacy compat
        sat: satState,                 // G16 multi-toggles
        showLightning: this.showLightning(),
        showAlerts: this.showAlerts(),
        showVessels: this.showVessels(),
        showMetar: this.showMetar(),
        showHubeau: this.showHubeau(),
        showPiezo: this.showPiezo(),
        showQuakes: this.showQuakes(),
        showFirms: this.showFirms(),
        showBuoys: this.showBuoys(),
        showTracks: this.showTracks(),
        showRain: this.showRain(),
        showWindForecast: this.showWindForecast(),
        showWavesForecast: this.showWavesForecast(),
        showWindArrows: this.showWindArrows(),
        showWaveArrows: this.showWaveArrows(),
        showSstContours: this.showSstContours(),
        showWindContours: this.showWindContours(),
        showWaveContours: this.showWaveContours(),
        showBathy: this.showBathy(),
        showEez: this.showEez(),
        showMpa: this.showMpa(),
        showGlofas: this.showGlofas(),
        autoZIndexEnabled: this.autoZIndexEnabled(),
        masterLayerKey: this.masterLayerKey(),
        projection: this.projection(),
      };
      localStorage.setItem('globe.prefs-v1', JSON.stringify(state));
    } catch { /* localStorage full or disabled — silence */ }
  }

  private restoreGlobePrefs(): void {
    try {
      const raw = localStorage.getItem('globe.prefs-v1');
      if (!raw) return;
      const data = JSON.parse(raw);
      if (typeof data?.autoZIndexEnabled === 'boolean') this.autoZIndexEnabled.set(data.autoZIndexEnabled);
      if (typeof data?.masterLayerKey === 'string' || data?.masterLayerKey === null) this.masterLayerKey.set(data.masterLayerKey);
      if (data?.projection === 'globe' || data?.projection === 'mercator') this.projection.set(data.projection);
      // show* signals : restore mais ne pas relancer toggleX (les sources/layers ne sont pas init)
      // → on stocke les show signals en pending, qui seront relayés par un effect APRÈS _initMap.
      this._pendingRestore = {
        showSst: !!data?.showSst, showWind: !!data?.showWind, activeSat: data?.activeSat ?? 'none',
        showLightning: !!data?.showLightning, showAlerts: !!data?.showAlerts, showVessels: !!data?.showVessels,
        showMetar: !!data?.showMetar, showHubeau: !!data?.showHubeau, showPiezo: !!data?.showPiezo,
        showQuakes: !!data?.showQuakes, showFirms: !!data?.showFirms, showBuoys: !!data?.showBuoys,
        showTracks: !!data?.showTracks, showRain: !!data?.showRain,
        showWindForecast: !!data?.showWindForecast, showWavesForecast: !!data?.showWavesForecast,
        showWindArrows: !!data?.showWindArrows, showWaveArrows: !!data?.showWaveArrows,
        showSstContours: !!data?.showSstContours, showWindContours: !!data?.showWindContours, showWaveContours: !!data?.showWaveContours,
        showBathy: !!data?.showBathy, showEez: !!data?.showEez, showMpa: !!data?.showMpa, showGlofas: !!data?.showGlofas,
      };
      // G16 — restore les 13 sat signals multi-toggle. Compat ascendante avec
      // l'ancien `activeSat` legacy : si data.sat absent mais activeSat='satXyz',
      // on active uniquement ce produit.
      if (data?.sat && typeof data.sat === 'object') {
        for (const [key, val] of Object.entries(data.sat as Record<string, boolean>)) {
          this._pendingRestore[`sat:${key}`] = !!val;
        }
      } else if (typeof data?.activeSat === 'string' && data.activeSat !== 'none') {
        this._pendingRestore[`sat:${data.activeSat}`] = true;
      }
    } catch { /* JSON malformed — silence */ }
  }
  private _pendingRestore?: Record<string, boolean | string>;

  /** G11f — fetch les prefs DB user et merge avec le state /globe.
   *  Appelé après auth dans ngAfterViewInit. Si DB a une opacité ou visibility
   *  différente du localStorage, DB gagne (cohérent /map). */
  private async mergeGlobePrefsFromDb(): Promise<void> {
    if (!this.auth.isAuthenticated()) return;
    const dbPrefs = await this.prefsSync.fetchMyPrefs();
    if (dbPrefs.length === 0) return;
    // Init pendingRestore si pas déjà rempli par localStorage (DB-only user).
    if (!this._pendingRestore) this._pendingRestore = {};
    for (const p of dbPrefs) {
      if (typeof p.opacity === 'number') {
        this.layerOpacities.update((o) => ({ ...o, [p.layerKind]: p.opacity! }));
      }
      if (typeof p.visible === 'boolean') {
        // Map layerKind DB → key show* /globe (inverse de collectGlobeBatch).
        const restoreKey = p.layerKind === 'wind' ? 'showWindForecast'
          : p.layerKind === 'waves' ? 'showWavesForecast'
          : `show${p.layerKind.charAt(0).toUpperCase()}${p.layerKind.slice(1)}`;
        this._pendingRestore[restoreKey] = p.visible;
      }
    }
  }

  /** G11e — appelé après _initMap pour appliquer les toggles persistés. */
  private applyPendingRestore(): void {
    const p = this._pendingRestore;
    if (!p) return;
    this._pendingRestore = undefined;
    if (p['showSst']) this.toggleSst(true);
    if (p['showWind']) this.toggleWind(true);
    // G16 — restore TOUS les sat layers persistés (clé `sat:<key>`)
    for (const [k, v] of Object.entries(p)) {
      if (k.startsWith('sat:') && v) {
        this.toggleSatLayer(k.slice(4), true);
      }
    }
    // Compat legacy : activeSat unique → toggleSat (déjà couvert par sat:* si data.sat existait)
    if (p['activeSat'] && p['activeSat'] !== 'none' && typeof p['activeSat'] === 'string') {
      // Si déjà traité par sat:*, on évite la double activation (toggleSatLayer check sig() === on)
      this.toggleSatLayer(p['activeSat'], true);
    }
    if (p['showLightning']) this.toggleVector('lightning');
    if (p['showAlerts'])    this.toggleVector('alerts');
    if (p['showVessels'])   this.toggleVector('vessels');
    if (p['showMetar'])     this.toggleVector('metar');
    if (p['showHubeau'])    this.toggleVector('hubeau');
    if (p['showPiezo'])     this.toggleVector('piezo');
    if (p['showQuakes'])    this.toggleVector('quakes');
    if (p['showFirms'])     this.toggleVector('firms');
    if (p['showBuoys'])     this.toggleVector('buoys');
    if (p['showTracks'])    this.toggleTracks(true);
    if (p['showRain'])      this.toggleRain(true);
    if (p['showWindForecast'])  this.toggleWindForecast(true);
    if (p['showWavesForecast']) this.toggleWavesForecast(true);
    if (p['showWindArrows'])    this.toggleWindArrows(true);
    if (p['showWaveArrows'])    this.toggleWaveArrows(true);
    if (p['showSstContours'])   this.toggleSstContours(true);
    if (p['showWindContours'])  this.toggleWindContours(true);
    if (p['showWaveContours'])  this.toggleWaveContours(true);
    if (p['showBathy']) this.toggleBathy(true);
    if (p['showEez'])   this.toggleEez(true);
    if (p['showMpa'])   this.toggleMpa(true);
    if (p['showGlofas']) this.toggleGlofas(true);
  }

  /** G11d — keys des layers actives qui ont un slider opacité utile. */
  readonly activeOpacityKeys = computed<string[]>(() => {
    const keys: string[] = [];
    if (this.showSst()) keys.push('sst');
    // G16 — opacité par produit sat actif (stacking)
    for (const [key, sig] of Object.entries(this.satShowSignals())) {
      if (sig()) keys.push(key);
    }
    if (this.showWindForecast())  keys.push('windForecast');
    if (this.showWavesForecast()) keys.push('wavesForecast');
    if (this.showWindArrows())    keys.push('windArrows');
    if (this.showWaveArrows())    keys.push('waveArrows');
    if (this.showRain())          keys.push('rain');
    if (this.showBathy()) keys.push('bathy');
    if (this.showEez())   keys.push('eez');
    if (this.showMpa())   keys.push('mpa');
    if (this.showGlofas()) keys.push('glofas');
    return keys;
  });

  /** G11d — label humain pour le slider d'opacité. */
  layerHumanLabel(key: string): string {
    if (key === 'sst') return 'SST';
    if (key === 'windForecast')  return 'Vent';
    if (key === 'wavesForecast') return 'Vagues';
    if (key === 'windArrows')    return 'Flèches vent';
    if (key === 'waveArrows')    return 'Flèches vagues';
    if (key === 'rain')   return 'Pluie';
    if (key === 'bathy')  return 'Bathy';
    if (key === 'eez')    return 'EEZ';
    if (key === 'mpa')    return 'MPA';
    if (key === 'glofas') return 'GloFAS';
    if (key.startsWith('sat')) {
      return SAT_PRODUCTS.find((p) => p.key === key)?.label ?? key;
    }
    return key;
  }

  /** G21 — handler play/pause du slider. idle → ouvre panel anim,
   *  playing → pause, paused → resume. Parité /legacy-map. */
  onSliderPlayClicked(): void {
    const state = this.animPlayer.state();
    if (state === 'idle') this.openAnimationPanel();
    else if (state === 'playing') this.animPlayer.pause();
    else if (state === 'paused') this.animPlayer.resume();
  }

  private startPlay(): void {
    this.playing.set(true);
    this.animTimer = setInterval(() => {
      const cur = this.currentTime();
      const max = this.sliderMaxTime();
      const min = this.sliderMinTime();
      const next = new Date(cur.getTime() + 6 * 3_600_000);
      if (next > max) this.currentTime.set(min);
      else this.currentTime.set(next);
      this.refreshWmsTimeForActiveLayers();
    }, 1000);
  }

  private stopPlay(): void {
    this.playing.set(false);
    if (this.animTimer) {
      clearInterval(this.animTimer);
      this.animTimer = undefined;
    }
  }

  /** G7 — handler drag-DnD du slider. Réordonne layerZIndexOrder et désactive
   *  le mode auto. Applique moveLayer() sur MapLibre. */
  reorderLayerByDrag(fromKey: string, toKey: string): void {
    if (fromKey === toKey) return;
    if (this.autoZIndexEnabled()) {
      this.autoZIndexEnabled.set(false);
    }
    const current = this.sliderLayerCoverage().map((c) => c.key);
    const fromIdx = current.indexOf(fromKey);
    const toIdx = current.indexOf(toKey);
    if (fromIdx === -1 || toIdx === -1) return;
    const reordered = [...current];
    reordered.splice(fromIdx, 1);
    reordered.splice(toIdx, 0, fromKey);
    this.layerZIndexOrder.set(reordered);
    queueMicrotask(() => this.applyMapLibreZIndex());
  }

  /** G7 — handler toggle auto/manuel du slider. */
  onAutoZIndexToggleChange(enabled: boolean): void {
    if (this.autoZIndexEnabled() === enabled) return;
    this.autoZIndexEnabled.set(enabled);
    if (enabled) {
      const auto = this.computeAutoZIndexOrder();
      if (auto.length > 0) {
        this.layerZIndexOrder.set(auto);
        queueMicrotask(() => this.applyMapLibreZIndex());
      }
    }
  }

  /** G7/G8/G16 — calcule l'ordre Z auto des layers actives selon LAYER_CATEGORY.
   *  Multi-sat supporté (G16) : on push chaque produit sat actif indépendamment. */
  private computeAutoZIndexOrder(): string[] {
    const active: string[] = [];
    for (const [key, sig] of Object.entries(this.satShowSignals())) {
      if (sig()) active.push(key);
    }
    if (this.showSst()) active.push('sst');
    if (this.showWind()) active.push('windParticles');
    if (this.showLightning()) active.push('lightning');
    if (this.showAlerts()) active.push('alerts');
    if (this.showVessels()) active.push('vessels');
    if (this.showMetar()) active.push('metar');
    if (this.showHubeau()) active.push('hubeau');
    if (this.showPiezo()) active.push('piezo');
    if (this.showQuakes()) active.push('quakes');
    if (this.showFirms()) active.push('firms');
    if (this.showBuoys()) active.push('buoys');
    if (this.showTracks()) active.push('tracks');
    if (this.showRain()) active.push('rain');
    if (this.showWindForecast()) active.push('windForecast');
    if (this.showWavesForecast()) active.push('wavesForecast');
    if (this.showWindArrows()) active.push('windArrows');
    if (this.showWaveArrows()) active.push('waveArrows');
    if (this.showBathy()) active.push('bathy');
    if (this.showEez()) active.push('eez');
    if (this.showMpa()) active.push('mpa');
    if (this.showGlofas()) active.push('glofas');
    return [...active].sort((a, b) => {
      const rA = this.LAYER_CATEGORY[a] ?? this.DEFAULT_LAYER_RANK;
      const rB = this.LAYER_CATEGORY[b] ?? this.DEFAULT_LAYER_RANK;
      if (rA !== rB) return rB - rA;
      return active.indexOf(a) - active.indexOf(b);
    });
  }

  /** G7 — mapping key sémantique → IDs de layers MapLibre concrètes. Une key
   *  peut couvrir plusieurs layers MapLibre (ex: vessels = clusters + count +
   *  points). Retourne [] si pas init ou pas dans la carte. */
  private mapLibreLayerIds(key: string): string[] {
    if (key === 'sst') return ['sst-wms'];
    if (key === 'windParticles') return ['wind-webgl'];
    if (key === 'lightning') return ['vec-lightning'];
    if (key === 'alerts') return ['vec-alerts'];
    if (key === 'vessels') return ['vec-vessels-clusters', 'vec-vessels-cluster-count', 'vec-vessels-points'];
    if (key === 'metar' || key === 'hubeau' || key === 'piezo' || key === 'quakes' || key === 'firms' || key === 'buoys') {
      return [`vec-${key}`];
    }
    if (key === 'tracks') return ['vec-tracks'];
    if (key === 'rain') return ['rain-tiles'];
    if (key === 'windForecast') return ['wind-forecast-wms'];
    if (key === 'wavesForecast') return ['waves-forecast-wms'];
    // G72 (2026-06-16) — fix bug pré-existant : addArrowsLayer crée des layers
    // ID 'wind-arrows-vec' / 'wave-arrows-vec' (cf addArrowsLayer), pas '*-wms'.
    // Le mismatch faisait que setLayerOpacity ne trouvait pas le layer → no-op
    // silencieux → slider ne changeait rien à l'écran.
    if (key === 'windArrows') return ['wind-arrows-vec'];
    if (key === 'waveArrows') return ['wave-arrows-vec'];
    if (key === 'bathy') return ['bathy-wms'];
    if (key === 'eez') return ['eez-wms'];
    if (key === 'mpa') return ['mpa-wms'];
    if (key === 'glofas') return ['glofas-wms'];
    // G72 (2026-06-16) — satRainviewer = XYZ direct (cf toggleSatRainviewer),
    // layer ID 'sat-rainviewer-tiles' (pas 'sat-satRainviewer').
    if (key === 'satRainviewer') return ['sat-rainviewer-tiles'];
    if (key.startsWith('sat')) return [`sat-${key}`];
    return [];
  }

  /** G7 — applique l'ordre layerZIndexOrder à MapLibre via moveLayer.
   *  Itère du BOTTOM (dernier) au TOP (premier) — chaque moveLayer sans
   *  beforeId place en haut de la stack MapLibre. */
  private applyMapLibreZIndex(): void {
    const map = this.map;
    if (!map) return;
    const order = this.layerZIndexOrder();
    if (order.length === 0) return;
    for (let i = order.length - 1; i >= 0; i--) {
      const ids = this.mapLibreLayerIds(order[i]);
      for (const id of ids) {
        if (map.getLayer(id)) {
          try { map.moveLayer(id); } catch { /* layer race */ }
        }
      }
    }
  }

  /** G36 (2026-05-23) — Granularité native du master layer en ms.
   *  Sert à la fois pour TimeSlider (snap step buttons) et AnimationPanel
   *  (filtre les durées < 2 × step + affiche le step humain). */
  readonly masterStepMs = computed<number>(() => {
    const master = this.effectiveMasterLayerKey();
    if (!master) return 3_600_000; // 1h default
    if (master.startsWith('sat')) {
      const product = SAT_PRODUCTS.find((p) => p.key === master);
      return product?.kind === 'gibs-daily' ? 24 * 3_600_000 : 5 * 60_000;
    }
    if (master === 'sst') return 24 * 3_600_000;
    // G52 (2026-05-24) — wind/wave forecast = 24h step (pas 6h).
    // Vérifié via GS GetCaps : wind-speed/wave-hs time-dim contient
    // 14 dates daily (J-13 → J+1 à 00:00 UTC), pas 4×/jour comme GFS
    // natif. weather-fetcher publie 1 GeoTIFF par day cycle, donc
    // granularité GS effective = 24h. Si on bascule un jour vers
    // 6h publishing → mettre à jour ici.
    if (master === 'windForecast' || master === 'wavesForecast' ||
        master === 'windArrows' || master === 'waveArrows') return 24 * 3_600_000;
    // G68 (2026-05-28) — GloFAS = 24h step (7 validités daily 00:00 UTC,
    // vérifié GS GetCaps : 2026-05-28→2026-06-03).
    if (master === 'glofas') return 24 * 3_600_000;
    return 3_600_000;
  });

  /** G6b/G7/G9 — calcule les validités client-side pour la layer "master" courante.
   *  Master dérivé de effectiveMasterLayerKey. Cap à 500 timesteps.
   *  Forecast wind/waves/arrows = step 6h, fenêtre 0 past + 168 future. */
  readonly masterValidityList = computed<Date[]>(() => {
    const now = Date.now();
    const master = this.effectiveMasterLayerKey();
    if (!master) return [];
    if (master.startsWith('sat')) {
      const product = SAT_PRODUCTS.find((p) => p.key === master);
      if (!product) return [];
      const stepMs = product.kind === 'gibs-daily' ? 24 * 3_600_000 : 5 * 60_000;
      // G65 (2026-05-27) — gibs-daily : cap pastEnd à J-2 pour aligner avec
      // gibsDailyDate() côté URL builder. Sinon cursor peut atterrir sur J-1
      // ou J (validity slider) mais URL clamp à J-2 → 2 cursors successifs
      // génèrent la MÊME TIME, donc 0 refetch. TC-2 FAIL observé satTrueColor.
      const anchorNow = product.kind === 'gibs-daily' ? now - 48 * 3_600_000 : now;
      return this.generateClientValidities(stepMs, 168, 0, anchorNow);
    }
    if (master === 'sst') {
      return this.generateClientValidities(24 * 3_600_000, 168, 0, now);
    }
    if (master === 'windForecast' || master === 'wavesForecast' ||
        master === 'windArrows'   || master === 'waveArrows' ||
        master === 'temp2m' || master === 'pressureMsl' ||
        master === 'humidity' || master === 'precipitation') {
      // G65 (2026-05-27) — forecast porte ±7j (cf data_layer_policy_2026_05_19) :
      // 7j past (analyse hindcast + dernières analyses) + 7j future. Avant ce
      // fix, pastH=0 rendait step prev no-op quand le cursor était à LIVE,
      // donc TC-2 FAIL observé pour wavesForecast/windForecast en solo master.
      // G66 (2026-05-27) — étendu aux 4 GFS forecast (temp/pressure/humidity/precip).
      return this.generateClientValidities(6 * 3_600_000, 168, 168, now);
    }
    // G68 (2026-05-28) — GloFAS = step 24h (validités daily). La liste client
    // borne le slider ; l'animation itère les validités réelles GS GetCaps
    // (fetchTimestamps), pas cette grille (cf contrat I-1).
    if (master === 'glofas') {
      return this.generateClientValidities(24 * 3_600_000, 168, 168, now);
    }
    return [];
  });

  private generateClientValidities(stepMs: number, pastH: number, futureH: number, now: number): Date[] {
    const start = now - pastH * 3_600_000;
    const end = now + futureH * 3_600_000;
    const span = Math.max(1, end - start);
    const effStep = Math.max(stepMs, span / 500);
    const firstSnap = Math.ceil(start / stepMs) * stepMs;
    const dates: Date[] = [];
    for (let t = firstSnap; t <= end; t += effStep) dates.push(new Date(t));
    return dates;
  }

  /** G6b — appelé après timeChange OU layer activation. Pour chaque WMS time-
   *  enabled actif (sst + sat), reconstruit l'URL avec &TIME=<currentTime>
   *  et appelle setTiles() sur la source MapLibre pour refresh les tiles. */
  private refreshWmsTimeForActiveLayers(): void {
    const map = this.map;
    if (!map) return;
    const t = this.currentTime();

    // SST — daily, format YYYY-MM-DD UTC
    const sstDate = `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
    if (this.showSst() && map.getSource('sst-wms')) {
      const url = this.buildWmsTileUrl('aetherwx:sst-daily', sstDate, { interpolations: 'bicubic' });
      (map.getSource('sst-wms') as maplibregl.RasterTileSource).setTiles([url]);
    }
    // G18 M4 — SST contours snap au TIME daily du SST raster
    if (this.showSstContours() && map.getSource('sst-contours-wms')) {
      const url = '/geoserver/aetherwx/wms?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap' +
        '&LAYERS=aetherwx%3Asst-daily&STYLES=aetherwx%3Asst-contours-only' +
        '&FORMAT=image/png&TRANSPARENT=true&INTERPOLATIONS=bicubic' +
        `&TIME=${encodeURIComponent(sstDate)}` +
        '&SRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256';
      (map.getSource('sst-contours-wms') as maplibregl.RasterTileSource).setTiles([url]);
    }

    // G9 — forecast wind/waves + arrows + G18 M4 contours
    // G29 (2026-05-23) — STYLES vide → laisse GS utiliser le defaultStyle
    // (wind-speed-rainbow + wave-hs-rainbow, .sld uploadés via REST 2026-05-23).
    const iso = t.toISOString().split('.')[0] + 'Z';
    const forecastLayers: Array<{ active: boolean; layerId: string; gsName: string; style?: string; interpolations?: string }> = [
      { active: this.showWindForecast(),  layerId: 'wind-forecast-wms',  gsName: 'aetherwx:wind-speed', interpolations: 'bicubic' },
      { active: this.showWavesForecast(), layerId: 'waves-forecast-wms', gsName: 'aetherwx:wave-hs',    interpolations: 'bicubic' },
      { active: this.showWindContours(),  layerId: 'wind-contours-wms',  gsName: 'aetherwx:wind-speed', style: 'aetherwx:wind-speed-contours-only', interpolations: 'bicubic' },
      { active: this.showWaveContours(),  layerId: 'wave-contours-wms',  gsName: 'aetherwx:wave-hs',    style: 'aetherwx:wave-hs-contours-only',    interpolations: 'bicubic' },
      // G66 (2026-05-27) — 4 GFS forecast scaffold
      { active: this.showTemp2m(),         layerId: 'temp2m-wms',         gsName: 'aetherwx:temp-2m',         interpolations: 'bicubic' },
      { active: this.showPressureMsl(),    layerId: 'pressure-msl-wms',   gsName: 'aetherwx:pressure-msl',    interpolations: 'bicubic' },
      { active: this.showHumidity(),       layerId: 'humidity-wms',       gsName: 'aetherwx:humidity-2m',     interpolations: 'bicubic' },
      { active: this.showPrecipitation(),  layerId: 'precipitation-wms',  gsName: 'aetherwx:precipitation-6h', interpolations: 'bicubic' },
      // G68 (2026-05-28) — GloFAS forecast crues : TIME refresh à chaque
      // mouvement du cursor / frame d'animation (style GS glofas-discharge).
      { active: this.showGlofas(),         layerId: 'glofas-wms',         gsName: 'aetherwx:glofas-discharge', style: 'glofas-discharge', interpolations: 'bicubic' },
    ];
    // G31 (2026-05-23) — wind/wave arrows : GeoJSON pré-générés (pattern legacy)
    // → MapLibre symbol layer rotation = dirTo. Plus de WMS/SLD GS.
    void this.refreshArrowsForTime(t);
    for (const fl of forecastLayers) {
      if (!fl.active) continue;
      const src = map.getSource(fl.layerId);
      if (!src) continue;
      const url = '/geoserver/aetherwx/wms' +
        '?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap' +
        `&LAYERS=${encodeURIComponent(fl.gsName)}` +
        `&STYLES=${fl.style ? encodeURIComponent(fl.style) : ''}` +
        '&FORMAT=image/png&TRANSPARENT=true' +
        (fl.interpolations ? `&INTERPOLATIONS=${fl.interpolations}` : '') +
        `&TIME=${encodeURIComponent(iso)}` +
        '&SRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256';
      (src as maplibregl.RasterTileSource).setTiles([url]);
    }

    // G16 — refresh TOUS les sat layers actifs (stacking multi-sat)
    // G22 (2026-05-22) — pour gibs-daily, snap à J-2 par sécurité (GIBS lag).
    // Cf bug user "Could not find a match for time '2026-05-21'".
    for (const [satKey, sig] of Object.entries(this.satShowSignals())) {
      if (!sig()) continue;
      const product = SAT_PRODUCTS.find((p) => p.key === satKey);
      const src = map.getSource(`sat-${satKey}`);
      if (!product || !src) continue;
      let timeParam: string;
      if (product.kind === 'cascade-realtime') {
        // G71 (2026-06-15) — skip TIME pour cascade (bug GS WMSLayerInfoImpl)
        timeParam = '';
      } else if (product.kind === 'gibs-daily') {
        // Snap au jour J-2 max depuis t (le cursor peut être maintenant
        // mais GIBS n'a souvent pas ingéré encore les ~48h les plus récentes).
        const cap = Math.min(t.getTime(), Date.now() - 48 * 3_600_000);
        const effDate = new Date(cap);
        timeParam = `${effDate.getUTCFullYear()}-${String(effDate.getUTCMonth() + 1).padStart(2, '0')}-${String(effDate.getUTCDate()).padStart(2, '0')}`;
      } else {
        timeParam = t.toISOString().split('.')[0] + 'Z';
      }
      const url = this.buildWmsTileUrl(`${product.workspace}:${product.gsName}`, timeParam);
      (src as maplibregl.RasterTileSource).setTiles([url]);
    }
  }

  private buildWmsTileUrl(layerName: string, time: string, opts?: { interpolations?: string; style?: string }): string {
    // G34 (2026-05-23) — SST → `sst-direct` SLD (rainbow pur, sans contours,
    // bicubic baked). Remplace le hack `sst-with-contours + env=50` qui
    // laissait apparaître les isolines de manière intermittente.
    const styleParam = opts?.style ?? (layerName === 'aetherwx:sst-daily' ? 'sst-direct' : '');
    // G43b (2026-05-23) — Revert : taille fixe 256 pour aligner sur la grille
    // GWC. GWC cache compense le nombre de fetches.
    const size = 256;
    // G42c (2026-05-23) — `tiled=true` route vers GWC cache.
    // G56 — workspace dérivé du préfixe layerName (aetherwx-sat: → /geoserver/aetherwx-sat/wms).
    const ws = layerName.split(':')[0];
    // G71 (2026-06-15) — TIME=='' → skip param (cascade-realtime workaround)
    const timeFragment = time ? `&TIME=${encodeURIComponent(time)}` : '';
    return `/geoserver/${ws}/wms` +
      '?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap' +
      `&LAYERS=${encodeURIComponent(layerName)}&STYLES=${encodeURIComponent(styleParam)}&FORMAT=image/png&TRANSPARENT=true&tiled=true` +
      timeFragment +
      (opts?.interpolations ? `&INTERPOLATIONS=${opts.interpolations}` : '') +
      `&SRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=${size}&HEIGHT=${size}`;
  }

  // Expose templates constants
  protected readonly WIND_BBOX = WIND_BBOX;
  protected readonly DEFAULT_WIND_PARTICLES = DEFAULT_WIND_PARTICLES;
  protected readonly GIBS_PRODUCTS = SAT_PRODUCTS.filter((p) => p.kind === 'gibs-daily');
  protected readonly CASCADE_PRODUCTS = SAT_PRODUCTS.filter((p) => p.kind === 'cascade-realtime');
  /** G16 — concat des attributions de TOUS les sat actifs. */
  protected currentSatAttribution(): string {
    const attrs: string[] = [];
    for (const [key, sig] of Object.entries(this.satShowSignals())) {
      if (!sig()) continue;
      const p = SAT_PRODUCTS.find((x) => x.key === key);
      if (p) attrs.push(p.attribution);
    }
    return attrs.join(' · ');
  }

  private map?: MapLibreMap;
  private windEngine?: WindWebGL;
  private windLayer?: CustomLayerInterface;
  private windGridCache?: WindGridPoint[];
  private rafHandle?: number;
  private lastFpsTime = performance.now();
  private frameCount = 0;
  private moveHandlers: Array<{ event: string; handler: () => void }> = [];

  ngAfterViewInit(): void {
    this.restoreLayerOpacities();
    this.restoreGlobePrefs();
    // G11f — merge DB prefs over localStorage si user auth. Fire-and-forget :
    // si DB répond après map.on('load'), pendingRestore est vide donc applyP*
    // ne touche pas l'état déjà initialisé via localStorage. C'est OK pour la
    // 1ère session — au prochain reload, localStorage aura le dernier push DB.
    void this.mergeGlobePrefsFromDb();
    this._initMap();
    this._startFpsLoop();
    // G21 — animation player wiring (parité /legacy-map). Chaque tick frameTime
    // pilote le currentTime + refresh WMS tiles. Same pipeline that the slider
    // manuel utilise via onSliderTimeChange.
    this.animPlayer.frameTime$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((t) => {
        this.currentTime.set(t);
        // G41 — si frames pré-chargées, switch visibility = 0 fetch
        if (this.preloadedFrames) {
          const idx = this.preloadedFrames.timestamps.findIndex(
            (ts) => Math.abs(ts.getTime() - t.getTime()) < 60_000,
          );
          if (idx >= 0) {
            this.switchAnimationFrame(idx);
            return;
          }
        }
        this.refreshWmsTimeForActiveLayers();
      });
    // G41 — cleanup frames quand animation revient idle.
    this.animPlayer.finished$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.cleanupAnimationFrames());
  }

  ngOnDestroy(): void {
    if (this.rafHandle !== undefined) cancelAnimationFrame(this.rafHandle);
    if (this.animTimer) clearInterval(this.animTimer);
    this.prefsSync.cancel();
    this.windEngine = undefined;
    this.windLayer = undefined;
    this.map?.remove();
  }

  setProjection(p: 'globe' | 'mercator') {
    if (this.projection() === p) return;
    this.projection.set(p);
    this.map?.setProjection({ type: p });
  }

  toggleSst(on: boolean) {
    if (this.showSst() === on) return;
    this.showSst.set(on);
    const map = this.map;
    if (!map) return;
    const layerId = 'sst-wms';
    const sourceId = 'sst-wms';
    if (on) {
      if (!map.getSource(sourceId)) {
        // G43b (2026-05-23) — Revert tileSize à 256. La grille GWC est en
        // 256×256 (EPSG:3857 / 900913 standard). Avec tileSize=1024 + WIDTH=1024
        // le BBOX ne s'aligne PAS sur la grille GWC → `Miss-Reason: request
        // does not align to grid(s)`. Maintenant GWC cache absorbe le ~120×
        // de fetches en mémoire.
        map.addSource(sourceId, {
          type: 'raster',
          tiles: [
            '/geoserver/aetherwx/wms' +
              '?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap' +
              '&LAYERS=aetherwx:sst-daily&STYLES=sst-direct&FORMAT=image/png&TRANSPARENT=true' +
              '&INTERPOLATIONS=bicubic&tiled=true' +
              '&SRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256',
          ],
          tileSize: 256,
        });
      }
      if (!map.getLayer(layerId)) {
        const before = map.getLayer('wind-webgl') ? 'wind-webgl' : undefined;
        map.addLayer(
          { id: layerId, type: 'raster', source: sourceId, paint: { 'raster-opacity': 0.7 } },
          before,
        );
      } else {
        map.setLayoutProperty(layerId, 'visibility', 'visible');
      }
    } else {
      if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', 'none');
    }
  }

  async toggleVector(kind: 'lightning' | 'alerts' | 'vessels' | 'metar' | 'hubeau' | 'piezo' | 'quakes' | 'firms' | 'buoys' | 'sigmet' | 'taf' | 'cables' | 'fir' | 'airports') {
    const sigMap = {
      lightning: this.showLightning,
      alerts: this.showAlerts,
      vessels: this.showVessels,
      metar: this.showMetar,
      hubeau: this.showHubeau,
      piezo: this.showPiezo,
      quakes: this.showQuakes,
      firms: this.showFirms,
      buoys: this.showBuoys,
      sigmet: this.showSigmet,
      taf: this.showTaf,
      cables: this.showCables,
      fir: this.showFir,
      airports: this.showAirports,
    } as const;
    const showSig = sigMap[kind];
    const turningOn = !showSig();
    showSig.set(turningOn);

    const map = this.map;
    if (!map) return;
    const sourceId = `vec-${kind}`;
    const layerIds: Record<typeof kind, string[]> = {
      lightning: ['vec-lightning'],
      alerts: ['vec-alerts'],
      // 2026-05-21 — glyphs URL ajouté au style MapLibre (cf style.glyphs)
      // → symbol text layer fonctionne maintenant. Count visible sur cluster.
      vessels: ['vec-vessels-clusters', 'vec-vessels-cluster-count', 'vec-vessels-points'],
      metar: ['vec-metar'],
      hubeau: ['vec-hubeau'],
      piezo: ['vec-piezo'],
      quakes: ['vec-quakes'],
      firms: ['vec-firms'],
      buoys: ['vec-buoys'],
      // G66 (2026-05-27) — placeholders impl
      sigmet: ['vec-sigmet-fill', 'vec-sigmet-line'],
      taf: ['vec-taf'],
      cables: ['vec-cables'],
      // G66f (2026-05-27) — FIR/UIR outline (OpenAIP)
      fir: ['vec-fir-line'],
      // G66l (2026-05-27) — airports cluster (4 layers)
      airports: ['vec-airports-clusters', 'vec-airports-count', 'vec-airports-points', 'vec-airports-dot'],
    };

    // Toggle off : retire les layers + source
    if (!turningOn) {
      for (const lid of layerIds[kind]) {
        if (map.getLayer(lid)) map.removeLayer(lid);
      }
      if (map.getSource(sourceId)) map.removeSource(sourceId);
      this.vectorCounts.update((c) => ({ ...c, [kind]: undefined }));
      return;
    }

    // Toggle on : fetch GeoJSON + addSource + addLayer(s)
    this.vectorLoading.set(kind);
    try {
      const fc = await this._fetchVectorFc(kind);
      if (map.getSource(sourceId)) map.removeSource(sourceId);
      // G66l — airports clusterisés comme vessels (≈9000 points).
      const useCluster = kind === 'vessels' || kind === 'airports';
      map.addSource(sourceId, {
        type: 'geojson',
        data: fc as any,
        cluster: useCluster,
        clusterRadius: 40,
        clusterMaxZoom: kind === 'airports' ? 6 : 12,
      } as any);

      // G8 — 4 layers stations cercles (data continue : METAR temp/vent,
      // débits, piézo, magnitude séisme).
      const SIMPLE_POINT_PAINT: Partial<Record<typeof kind, { color: string; radius: number; stroke: string }>> = {
        metar:  { color: '#fbbf24', radius: 4, stroke: '#92400e' },
        hubeau: { color: '#06b6d4', radius: 5, stroke: '#0e7490' },
        piezo:  { color: '#8b5cf6', radius: 5, stroke: '#6d28d9' },
        quakes: { color: '#ef4444', radius: 5, stroke: '#7f1d1d' },
      };
      // G18 M7+ (2026-05-22) — 2 layers événements instantanés en symbol
      // emoji (cohérent avec lightning ⚡). Halo noir pour lisibilité.
      const SYMBOL_GLYPH: Partial<Record<typeof kind, { glyph: string; color: string; size: number }>> = {
        firms: { glyph: '🔥', color: '#f97316', size: 18 },
        buoys: { glyph: '⚓', color: '#10b981', size: 16 },
      };
      if (SIMPLE_POINT_PAINT[kind]) {
        const p = SIMPLE_POINT_PAINT[kind]!;
        map.addLayer({
          id: `vec-${kind}`,
          type: 'circle',
          source: sourceId,
          paint: {
            'circle-radius': p.radius,
            'circle-color': p.color,
            'circle-stroke-width': 1,
            'circle-stroke-color': p.stroke,
            'circle-opacity': 0.85,
          },
        });
      } else if (SYMBOL_GLYPH[kind]) {
        const g = SYMBOL_GLYPH[kind]!;
        map.addLayer({
          id: `vec-${kind}`,
          type: 'symbol',
          source: sourceId,
          layout: {
            'text-field': g.glyph,
            'text-font': ['Open Sans Regular'],
            'text-size': g.size,
            'text-allow-overlap': true,
            'text-ignore-placement': true,
          },
          paint: {
            'text-color': g.color,
            'text-halo-color': 'rgba(0, 0, 0, 0.85)',
            'text-halo-width': 1.5,
            'text-opacity': 0.95,
          },
        });
      } else if (kind === 'lightning') {
        // G18 M7 (2026-05-22) — symbol emoji ⚡ pour différencier de METAR
        // (cercle jaune similaire) et boat (cluster). Halo noir pour
        // lisibilité sur tous les fonds (sat IR clair, ocean sombre).
        map.addLayer({
          id: 'vec-lightning',
          type: 'symbol',
          source: sourceId,
          layout: {
            'text-field': '⚡',
            'text-font': ['Open Sans Regular'],
            'text-size': 18,
            'text-allow-overlap': true,
            'text-ignore-placement': true,
          },
          paint: {
            'text-color': '#fde047',
            'text-halo-color': 'rgba(0, 0, 0, 0.85)',
            'text-halo-width': 1.5,
            'text-opacity': 0.95,
          },
        });
      } else if (kind === 'alerts') {
        map.addLayer({
          id: 'vec-alerts',
          type: 'circle',
          source: sourceId,
          paint: {
            'circle-radius': 7,
            'circle-color': [
              'match',
              ['get', 'severity'],
              'danger', '#dc2626',
              'warning', '#f97316',
              'info', '#38bdf8',
              '#94a3b8',
            ],
            'circle-stroke-width': 2,
            'circle-stroke-color': '#fff',
            'circle-opacity': 0.9,
          },
        });
      } else if (kind === 'sigmet') {
        // G66 (2026-05-27) — fill polygons rouge semi-transparent + outline.
        map.addLayer({
          id: 'vec-sigmet-fill',
          type: 'fill',
          source: sourceId,
          paint: {
            'fill-color': '#dc2626',
            'fill-opacity': 0.18,
          },
        });
        map.addLayer({
          id: 'vec-sigmet-line',
          type: 'line',
          source: sourceId,
          paint: {
            'line-color': '#dc2626',
            'line-width': 1.5,
            'line-opacity': 0.85,
          },
        });
      } else if (kind === 'taf') {
        // G66 — cercles bleus airports.
        map.addLayer({
          id: 'vec-taf',
          type: 'circle',
          source: sourceId,
          paint: {
            'circle-radius': 4,
            'circle-color': '#3b82f6',
            'circle-stroke-width': 1,
            'circle-stroke-color': '#1e3a8a',
            'circle-opacity': 0.85,
          },
        });
      } else if (kind === 'cables') {
        // G66 — line layer câbles, jaune orange filaire.
        map.addLayer({
          id: 'vec-cables',
          type: 'line',
          source: sourceId,
          paint: {
            'line-color': '#f59e0b',
            'line-width': 1.4,
            'line-opacity': 0.75,
          },
        });
      } else if (kind === 'fir') {
        // G66f — line layer FIR/UIR (OpenAIP), outline gris bleu info-only.
        map.addLayer({
          id: 'vec-fir-line',
          type: 'line',
          source: sourceId,
          paint: {
            'line-color': ['match', ['get', 'type'], 'UIR', '#64748b', '#94a3b8'],
            'line-width': 0.8,
            'line-opacity': 0.55,
            'line-dasharray': [2, 2],
          },
        });
      } else if (kind === 'airports') {
        // G66l — airports clusterisés (cluster bubbles + count + points IATA).
        map.addLayer({
          id: 'vec-airports-clusters',
          type: 'circle',
          source: sourceId,
          filter: ['has', 'point_count'],
          paint: {
            'circle-color': ['step', ['get', 'point_count'], '#0ea5e9', 25, '#6366f1', 100, '#a855f7'],
            'circle-radius': ['step', ['get', 'point_count'], 11, 25, 15, 100, 20],
            'circle-opacity': 0.8,
            'circle-stroke-color': '#0f172a',
            'circle-stroke-width': 1.5,
          },
        });
        map.addLayer({
          id: 'vec-airports-count',
          type: 'symbol',
          source: sourceId,
          filter: ['has', 'point_count'],
          layout: {
            'text-field': '{point_count_abbreviated}',
            'text-font': ['Open Sans Regular'],
            'text-size': 11,
            'text-allow-overlap': true,
          },
          paint: { 'text-color': '#ffffff' },
        });
        map.addLayer({
          id: 'vec-airports-points',
          type: 'symbol',
          source: sourceId,
          filter: ['!', ['has', 'point_count']],
          layout: {
            'text-field': '{iataCode}',
            'text-font': ['Open Sans Regular'],
            'text-size': 10,
            'text-offset': [0, 0.9],
            'text-anchor': 'top',
            'text-optional': true,
          },
          paint: {
            'text-color': '#7dd3fc',
            'text-halo-color': '#0f172a',
            'text-halo-width': 1.2,
          },
        });
        // Le point lui-même (cercle sous le label IATA).
        map.addLayer({
          id: 'vec-airports-dot',
          type: 'circle',
          source: sourceId,
          filter: ['!', ['has', 'point_count']],
          paint: {
            'circle-radius': 3.5,
            'circle-color': '#0ea5e9',
            'circle-stroke-color': '#e0f2fe',
            'circle-stroke-width': 1,
          },
        });
      } else {
        // Vessels : 3 layers (cluster bubbles + count + unclustered points).
        map.addLayer({
          id: 'vec-vessels-clusters',
          type: 'circle',
          source: sourceId,
          filter: ['has', 'point_count'],
          paint: {
            'circle-color': [
              'step', ['get', 'point_count'],
              '#22c55e', 25,
              '#3b82f6', 100,
              '#a855f7',
            ],
            'circle-radius': [
              'step', ['get', 'point_count'],
              12, 25,
              16, 100,
              22,
            ],
            'circle-opacity': 0.85,
            'circle-stroke-color': '#0f172a',
            'circle-stroke-width': 1.5,
          },
        });
        // 2026-05-21 — count cluster sur les bubbles (Sylvain feedback).
        map.addLayer({
          id: 'vec-vessels-cluster-count',
          type: 'symbol',
          source: sourceId,
          filter: ['has', 'point_count'],
          layout: {
            'text-field': '{point_count_abbreviated}',
            'text-font': ['Open Sans Regular'],
            'text-size': 12,
            'text-allow-overlap': true,
            'text-ignore-placement': true,
          },
          paint: {
            'text-color': '#ffffff',
            'text-halo-color': 'rgba(0,0,0,0.5)',
            'text-halo-width': 1,
          },
        });
        map.addLayer({
          id: 'vec-vessels-points',
          type: 'circle',
          source: sourceId,
          filter: ['!', ['has', 'point_count']],
          paint: {
            'circle-radius': 3,
            'circle-color': '#22c55e',
            'circle-stroke-color': '#0f172a',
            'circle-stroke-width': 1,
          },
        });
      }

      this.vectorCounts.update((c) => ({ ...c, [kind]: fc.features?.length ?? 0 }));
      this.lastRefreshAt.set(new Date());
      this.vectorLoading.set(null);
    } catch (err) {
      console.error(`[globe] ${kind} fetch failed`, err);
      this.vectorLoading.set(null);
      showSig.set(false);
    }
  }

  /** G9 — toggle générique pour les 4 layers forecast WMS time-enabled
   *  (wind/waves raster + arrows). Pattern identique à toggleSst, factorisé
   *  via config opts. */
  private toggleForecastLayer(opts: {
    key: 'windForecast' | 'wavesForecast' | 'windArrows' | 'waveArrows' | 'temp2m' | 'pressureMsl' | 'humidity' | 'precipitation' | 'glofas';
    layerId: string;
    gsName: string;
    style?: string;
    interpolations?: string;
    opacity: number;
    on: boolean;
  }): void {
    const sigMap = {
      windForecast: this.showWindForecast,
      wavesForecast: this.showWavesForecast,
      windArrows: this.showWindArrows,
      waveArrows: this.showWaveArrows,
      // G66 (2026-05-27) — 4 GFS forecast layers scaffold (coverages backend à venir)
      temp2m: this.showTemp2m,
      pressureMsl: this.showPressureMsl,
      humidity: this.showHumidity,
      precipitation: this.showPrecipitation,
      // G68 (2026-05-28) — GloFAS forecast crues (raster GS time-animé).
      glofas: this.showGlofas,
    } as const;
    const sig = sigMap[opts.key];
    if (sig() === opts.on) return;
    sig.set(opts.on);
    const map = this.map;
    if (!map) return;
    if (!opts.on) {
      if (map.getLayer(opts.layerId)) map.removeLayer(opts.layerId);
      if (map.getSource(opts.layerId)) map.removeSource(opts.layerId);
      return;
    }
    const iso = this.currentTime().toISOString().split('.')[0] + 'Z';
    const url = '/geoserver/aetherwx/wms' +
      '?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap' +
      `&LAYERS=${encodeURIComponent(opts.gsName)}` +
      `&STYLES=${opts.style ? encodeURIComponent(opts.style) : ''}` +
      '&FORMAT=image/png&TRANSPARENT=true' +
      (opts.interpolations ? `&INTERPOLATIONS=${opts.interpolations}` : '') +
      `&TIME=${encodeURIComponent(iso)}` +
      '&SRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256';
    if (map.getSource(opts.layerId)) map.removeSource(opts.layerId);
    map.addSource(opts.layerId, { type: 'raster', tiles: [url], tileSize: 256 });
    map.addLayer({
      id: opts.layerId,
      type: 'raster',
      source: opts.layerId,
      paint: { 'raster-opacity': opts.opacity },
    });
  }

  /** G18 M4 — toggle générique isolines contour WMS (SLD côté GS).
   *  Pattern identique à toggleForecastLayer mais avec STYLES dédié et
   *  INTERPOLATIONS=bicubic pour matcher le raster sous-jacent. */
  toggleSstContours(on: boolean): void {
    this.toggleContourLayer({
      key: 'sstContours',
      layerId: 'sst-contours-wms',
      gsName: 'aetherwx:sst-daily',
      style: 'aetherwx:sst-contours-only',
      kind: 'daily',
      opacity: 0.9,
      on,
    });
  }
  toggleWindContours(on: boolean): void {
    this.toggleContourLayer({
      key: 'windContours',
      layerId: 'wind-contours-wms',
      gsName: 'aetherwx:wind-speed',
      style: 'aetherwx:wind-speed-contours-only',
      kind: 'iso',
      opacity: 0.9,
      on,
    });
  }
  toggleWaveContours(on: boolean): void {
    this.toggleContourLayer({
      key: 'waveContours',
      layerId: 'wave-contours-wms',
      gsName: 'aetherwx:wave-hs',
      style: 'aetherwx:wave-hs-contours-only',
      kind: 'iso',
      opacity: 0.9,
      on,
    });
  }

  // G66 (2026-05-27) — 4 layers GFS forecast scaffold. Les coverages GS
  // aetherwx:temp-2m / pressure-msl / humidity-2m / precipitation-6h doivent
  // être publiées par weather-fetcher quand TMP_2maboveground / PRMSL /
  // RH_2maboveground / APCP_surface seront ajoutées au filter_gfs_0p25.pl.
  // En attendant, MapLibre affichera les tiles 404 (silencieux).
  toggleTemp2m(on: boolean): void {
    this.toggleForecastLayer({
      key: 'temp2m', layerId: 'temp2m-wms', gsName: 'aetherwx:temp-2m',
      interpolations: 'bicubic', opacity: 0.75, on,
    });
  }
  togglePressureMsl(on: boolean): void {
    this.toggleForecastLayer({
      key: 'pressureMsl', layerId: 'pressure-msl-wms', gsName: 'aetherwx:pressure-msl',
      interpolations: 'bicubic', opacity: 0.65, on,
    });
  }
  toggleHumidity(on: boolean): void {
    this.toggleForecastLayer({
      key: 'humidity', layerId: 'humidity-wms', gsName: 'aetherwx:humidity-2m',
      interpolations: 'bicubic', opacity: 0.7, on,
    });
  }
  togglePrecipitation(on: boolean): void {
    this.toggleForecastLayer({
      key: 'precipitation', layerId: 'precipitation-wms', gsName: 'aetherwx:precipitation-6h',
      interpolations: 'bicubic', opacity: 0.75, on,
    });
  }

  private toggleContourLayer(opts: {
    key: 'sstContours' | 'windContours' | 'waveContours';
    layerId: string;
    gsName: string;
    style: string;
    kind: 'daily' | 'iso';
    opacity: number;
    on: boolean;
  }): void {
    const sigMap = {
      sstContours: this.showSstContours,
      windContours: this.showWindContours,
      waveContours: this.showWaveContours,
    } as const;
    const sig = sigMap[opts.key];
    if (sig() === opts.on) return;
    sig.set(opts.on);
    const map = this.map;
    if (!map) return;
    if (!opts.on) {
      if (map.getLayer(opts.layerId)) map.removeLayer(opts.layerId);
      if (map.getSource(opts.layerId)) map.removeSource(opts.layerId);
      return;
    }
    const t = this.currentTime();
    const timeParam = opts.kind === 'daily'
      ? `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`
      : t.toISOString().split('.')[0] + 'Z';
    const url = '/geoserver/aetherwx/wms' +
      '?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap' +
      `&LAYERS=${encodeURIComponent(opts.gsName)}` +
      `&STYLES=${encodeURIComponent(opts.style)}` +
      '&FORMAT=image/png&TRANSPARENT=true&INTERPOLATIONS=bicubic' +
      `&TIME=${encodeURIComponent(timeParam)}` +
      '&SRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256';
    if (map.getSource(opts.layerId)) map.removeSource(opts.layerId);
    map.addSource(opts.layerId, { type: 'raster', tiles: [url], tileSize: 256 });
    map.addLayer({
      id: opts.layerId,
      type: 'raster',
      source: opts.layerId,
      paint: { 'raster-opacity': opts.opacity },
    });
  }

  /** G11b — toggle générique pour les layers WMS sources statiques
   *  (bathy/eez/mpa). Pas de TIME param, juste un proxy nginx
   *  configuré côté ingress maritime. G68 — efas retiré (→ GloFAS raster). */
  private toggleStaticWmsLayer(opts: {
    key: 'bathy' | 'eez' | 'mpa';
    layerId: string;
    proxyUrl: string;     // ex: '/wms-emodnet'
    wmsLayer: string;     // ex: 'mean_atlas_land'
    opacity: number;
    attribution: string;
    on: boolean;
  }): void {
    const sigMap = {
      bathy: this.showBathy,
      eez: this.showEez,
      mpa: this.showMpa,
    } as const;
    const sig = sigMap[opts.key];
    if (sig() === opts.on) return;
    sig.set(opts.on);
    const map = this.map;
    if (!map) return;
    if (!opts.on) {
      if (map.getLayer(opts.layerId)) map.removeLayer(opts.layerId);
      if (map.getSource(opts.layerId)) map.removeSource(opts.layerId);
      return;
    }
    const url = `${opts.proxyUrl}?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap` +
      `&LAYERS=${encodeURIComponent(opts.wmsLayer)}` +
      '&STYLES=&FORMAT=image/png&TRANSPARENT=true' +
      '&SRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256';
    if (map.getSource(opts.layerId)) map.removeSource(opts.layerId);
    map.addSource(opts.layerId, {
      type: 'raster',
      tiles: [url],
      tileSize: 256,
      attribution: opts.attribution,
    });
    map.addLayer({
      id: opts.layerId,
      type: 'raster',
      source: opts.layerId,
      paint: { 'raster-opacity': opts.opacity },
    });
  }

  toggleBathy(on: boolean): void {
    this.toggleStaticWmsLayer({
      key: 'bathy', layerId: 'bathy-wms', proxyUrl: '/wms-emodnet',
      wmsLayer: 'mean_atlas_land', opacity: 0.7,
      attribution: '© EMODnet Bathymetry', on,
    });
  }
  toggleEez(on: boolean): void {
    this.toggleStaticWmsLayer({
      key: 'eez', layerId: 'eez-wms', proxyUrl: '/wms-marineregions',
      wmsLayer: 'MarineRegions:eez', opacity: 0.6,
      attribution: '© Marine Regions (VLIZ)', on,
    });
  }
  toggleMpa(on: boolean): void {
    this.toggleStaticWmsLayer({
      key: 'mpa', layerId: 'mpa-wms', proxyUrl: '/wms-emodnet-human',
      wmsLayer: 'marineprotectedareas', opacity: 0.6,
      attribution: '© EMODnet Human Activities', on,
    });
  }
  /** G68 (2026-05-28) — GloFAS river discharge forecast (Copernicus EWDS).
   *  Remplace l'ancien overlay EFAS statique (archive proxy) par un vrai
   *  layer raster GS time-enabled : suit le pattern forecast (currentTime →
   *  &TIME, style GS glofas-discharge, INTERPOLATIONS=bicubic) donc participe
   *  pleinement à la time-bar + animation. */
  toggleGlofas(on: boolean): void {
    this.toggleForecastLayer({
      key: 'glofas', layerId: 'glofas-wms', gsName: 'aetherwx:glofas-discharge',
      style: 'glofas-discharge', interpolations: 'bicubic', opacity: 0.75, on,
    });
  }

  toggleWindForecast(on: boolean): void {
    // G29 (2026-05-23) — SLDs rainbow uploadés via REST. Laisse GS prendre
    // le defaultStyle (wind-speed-rainbow) → palette rainbow native.
    // G33 (2026-05-23) — INTERPOLATIONS=bicubic pour lisser le raster GFS
    // 0.25° au zoom élevé (sinon pixelisé visible côté user).
    this.toggleForecastLayer({ key: 'windForecast', layerId: 'wind-forecast-wms', gsName: 'aetherwx:wind-speed', interpolations: 'bicubic', opacity: 0.7, on });
  }
  toggleWavesForecast(on: boolean): void {
    this.toggleForecastLayer({ key: 'wavesForecast', layerId: 'waves-forecast-wms', gsName: 'aetherwx:wave-hs', interpolations: 'bicubic', opacity: 0.7, on });
  }
  /** G31 (2026-05-23) — Pivot pattern legacy : MapLibre symbol layer
   *  consommant les GeoJSON pré-générés par weather-fetcher (mêmes que
   *  /legacy-map OL). Rotation = dirTo (deg compass, MapLibre icon-rotate
   *  attend deg → pas de conversion). Plus de WMS, plus de SLD GS. */
  toggleWindArrows(on: boolean): void {
    if (this.showWindArrows() === on) return;
    this.showWindArrows.set(on);
    const map = this.map;
    if (!map) return;
    if (!on) { this.removeArrowsLayer('wind-arrows-vec'); return; }
    // G34 — palette dégradée selon speed (m/s) : bleu froid → rouge chaud
    this.addArrowsLayer(map, 'wind-arrows-vec', [
      'interpolate', ['linear'], ['get', 'speed'],
      0,  '#60a5fa',  // 0 kt → bleu clair
      5,  '#22c55e',  // 5 m/s ≈ 10 kt → vert
      10, '#fde047',  // 10 m/s ≈ 20 kt → jaune
      15, '#fb923c',  // 15 m/s ≈ 30 kt → orange
      20, '#dc2626',  // 20 m/s ≈ 40 kt → rouge
      30, '#7f1d1d',  // 30 m/s ≈ 60 kt → rouge sombre
    ]);
    // G72 — applique l'opacity persistée au layer fraîchement ajouté.
    this.applyOpacityToMapLayer('wind-arrows-vec', this.getLayerOpacity('windArrows'));
    void this.refreshArrowsForTime(this.currentTime());
  }
  toggleWaveArrows(on: boolean): void {
    if (this.showWaveArrows() === on) return;
    this.showWaveArrows.set(on);
    const map = this.map;
    if (!map) return;
    if (!on) { this.removeArrowsLayer('wave-arrows-vec'); return; }
    // G34 — palette dégradée selon hs (m) : bleu → violet → rouge
    this.addArrowsLayer(map, 'wave-arrows-vec', [
      'interpolate', ['linear'], ['get', 'hs'],
      0, '#bfdbfe',  // 0 m → bleu très clair
      1, '#60a5fa',  // 1 m → bleu
      2, '#3b82f6',  // 2 m → bleu vif
      4, '#8b5cf6',  // 4 m → violet (forte mer)
      6, '#dc2626',  // 6 m → rouge (très grosse mer)
      9, '#7f1d1d',  // 9 m+ → rouge sombre (exceptionnel)
    ]);
    // G72 — applique l'opacity persistée
    this.applyOpacityToMapLayer('wave-arrows-vec', this.getLayerOpacity('waveArrows'));
    void this.refreshArrowsForTime(this.currentTime());
  }

  private lastWindArrowsTs?: string;
  private lastWaveArrowsTs?: string;

  private removeArrowsLayer(layerId: string): void {
    const map = this.map; if (!map) return;
    if (map.getLayer(layerId)) map.removeLayer(layerId);
    if (map.getSource(layerId)) map.removeSource(layerId);
    if (layerId === 'wind-arrows-vec') this.lastWindArrowsTs = undefined;
    if (layerId === 'wave-arrows-vec') this.lastWaveArrowsTs = undefined;
  }

  private addArrowsLayer(map: maplibregl.Map, sourceId: string, colorExpr: any): void {
    if (map.getSource(sourceId)) map.removeSource(sourceId);
    map.addSource(sourceId, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: sourceId,
      type: 'symbol',
      source: sourceId,
      layout: {
        'icon-image': 'arrow-tip',
        'icon-rotate': ['get', 'dirTo'],
        'icon-rotation-alignment': 'map',
        'icon-size': 0.6,
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
      paint: {
        'icon-color': colorExpr,
        'icon-halo-color': '#0f172a',
        'icon-halo-width': 1.5,
      },
    });
  }

  /** Fetch le manifest, snap au cursor, charge la GeoJSON correspondante
   *  pour wind et/ou wave selon showWindArrows/showWaveArrows. */
  private async refreshArrowsForTime(t: Date): Promise<void> {
    const wantWind = this.showWindArrows();
    const wantWave = this.showWaveArrows();
    if (!wantWind && !wantWave) return;
    const map = this.map;
    if (!map) return;
    const manifest = await this.arrows.getManifest();
    if (!manifest) return;
    if (wantWind) {
      const ts = this.arrows.findNearestTs(manifest.wind, t);
      const src = map.getSource('wind-arrows-vec') as maplibregl.GeoJSONSource | undefined;
      if (!ts) { src?.setData({ type: 'FeatureCollection', features: [] } as any); this.lastWindArrowsTs = undefined; }
      else if (ts !== this.lastWindArrowsTs) {
        try {
          const fc = await this.arrows.fetchArrows('wind', ts);
          src?.setData(fc as any);
          this.lastWindArrowsTs = ts;
        } catch (err) { console.error('[globe] wind arrows fetch failed', err); }
      }
    }
    if (wantWave) {
      const ts = this.arrows.findNearestTs(manifest.wave, t);
      const src = map.getSource('wave-arrows-vec') as maplibregl.GeoJSONSource | undefined;
      if (!ts) { src?.setData({ type: 'FeatureCollection', features: [] } as any); this.lastWaveArrowsTs = undefined; }
      else if (ts !== this.lastWaveArrowsTs) {
        try {
          const fc = await this.arrows.fetchArrows('wave', ts);
          src?.setData(fc as any);
          this.lastWaveArrowsTs = ts;
        } catch (err) { console.error('[globe] wave arrows fetch failed', err); }
      }
    }
  }

  /** Génère un SDF arrow icon 32×32 et l'ajoute au sprite MapLibre.
   *  SDF=true permet de re-colorer via icon-color dans la layer. */
  private addArrowIconToMap(map: maplibregl.Map): void {
    if (map.hasImage('arrow-tip')) return;
    const size = 32;
    const cv = document.createElement('canvas');
    cv.width = size; cv.height = size;
    const ctx = cv.getContext('2d')!;
    ctx.fillStyle = 'rgba(255,255,255,1)';
    ctx.beginPath();
    // Flèche pointant vers le haut (dirTo=0 = Nord, MapLibre rotate clockwise)
    ctx.moveTo(size / 2, 2);
    ctx.lineTo(size - 6, size - 4);
    ctx.lineTo(size / 2, size - 10);
    ctx.lineTo(6, size - 4);
    ctx.closePath();
    ctx.fill();
    const data = ctx.getImageData(0, 0, size, size);
    map.addImage('arrow-tip', { width: size, height: size, data: data.data }, { sdf: true });
  }

  /** G8b — tracks vessels : LineString polylines depuis WFS aetherwx:vessel_tracks_daily.
   *  Fetch les tracks du jour courant (UTC). Cap WFS 5000 features. */
  async toggleTracks(on: boolean) {
    if (this.showTracks() === on) return;
    this.showTracks.set(on);
    const map = this.map;
    if (!map) return;
    const sourceId = 'vec-tracks';
    const layerId = 'vec-tracks';
    if (!on) {
      if (map.getLayer(layerId)) map.removeLayer(layerId);
      if (map.getSource(sourceId)) map.removeSource(sourceId);
      this.vectorCounts.update((c) => ({ ...c, tracks: undefined }));
      return;
    }
    this.vectorLoading.set('tracks');
    try {
      const day = this.currentTime().toISOString().split('T')[0];
      const fc = await firstValueFrom(this.vesselsService.fetchTracksForDay(day));
      if (map.getSource(sourceId)) map.removeSource(sourceId);
      map.addSource(sourceId, { type: 'geojson', data: fc as any });
      map.addLayer({
        id: layerId,
        type: 'line',
        source: sourceId,
        paint: {
          'line-color': '#22c55e',
          'line-width': 1.2,
          'line-opacity': 0.65,
        },
      });
      this.vectorCounts.update((c) => ({ ...c, tracks: fc.features?.length ?? 0 }));
    } catch (err) {
      console.error('[globe] tracks fetch failed', err);
      this.showTracks.set(false);
    } finally {
      this.vectorLoading.set(null);
    }
  }

  /** G71 (2026-06-15) — RainViewer satellite IR XYZ tiles. Pas via GS,
   *  pattern identique à toggleRain mais sur snapshot.satellite (10min
   *  cadence, global IR clouds). Bug fix : `satRainviewer` n'était pas
   *  dans SAT_PRODUCTS donc toggleSatLayer bail silencieux (0 request). */
  async toggleSatRainviewer(on: boolean) {
    if (this.showSatRainviewer() === on) return;
    this.showSatRainviewer.set(on);
    const map = this.map;
    if (!map) return;
    const layerId = 'sat-rainviewer-tiles';
    const sourceId = 'sat-rainviewer-tiles';
    if (!on) {
      if (map.getLayer(layerId)) map.removeLayer(layerId);
      if (map.getSource(sourceId)) map.removeSource(sourceId);
      return;
    }
    try {
      const snap = await this.rainviewerService.getSnapshot();
      if (snap.satellite.length === 0) throw new Error('Aucune frame satellite IR RainViewer disponible.');
      const nowSec = Math.floor(this.currentTime().getTime() / 1000);
      // findNearestFrame ne supporte que snapshot.all → on cherche la
      // satellite frame la plus proche manuellement (≤30 min).
      const eligible = snap.satellite.filter(f => f.time <= nowSec);
      const frame = eligible.length > 0 ? eligible[eligible.length - 1] : snap.satellite[0];
      if (Math.abs(frame.time - nowSec) > 30 * 60) throw new Error('Frame satellite IR > 30 min du cursor.');
      const url = this.rainviewerService.buildSatTileUrl(snap.host, frame.path, 0); // color 0 = Original IR gris
      if (map.getSource(sourceId)) map.removeSource(sourceId);
      map.addSource(sourceId, { type: 'raster', tiles: [url], tileSize: 256, attribution: 'RainViewer Satellite IR' });
      const before = map.getLayer('sst-wms') ? 'sst-wms'
                   : map.getLayer('wind-webgl') ? 'wind-webgl'
                   : undefined;
      map.addLayer({ id: layerId, type: 'raster', source: sourceId, paint: { 'raster-opacity': 0.85 } }, before);
    } catch (err) {
      console.error('[globe] sat-rainviewer fetch failed', err);
      this.showSatRainviewer.set(false);
    }
  }

  /** G8b — RainViewer XYZ tiles (radar pluie monde). Pas via GS — frames
   *  hostées par api.rainviewer.com. findNearestFrame snap au cursor. */
  async toggleRain(on: boolean) {
    if (this.showRain() === on) return;
    this.showRain.set(on);
    const map = this.map;
    if (!map) return;
    const layerId = 'rain-tiles';
    const sourceId = 'rain-tiles';
    if (!on) {
      if (map.getLayer(layerId)) map.removeLayer(layerId);
      if (map.getSource(sourceId)) map.removeSource(sourceId);
      this.vectorCounts.update((c) => ({ ...c, rain: undefined }));
      return;
    }
    this.vectorLoading.set('rain');
    try {
      const snap = await this.rainviewerService.getSnapshot();
      const nowSec = Math.floor(this.currentTime().getTime() / 1000);
      const frame = this.rainviewerService.findNearestFrame(snap, nowSec);
      if (!frame) throw new Error('Aucune frame RainViewer disponible (cursor hors fenêtre).');
      const url = `${snap.host}${frame.path}/256/{z}/{x}/{y}/2/1_1.png`;
      if (map.getSource(sourceId)) map.removeSource(sourceId);
      map.addSource(sourceId, { type: 'raster', tiles: [url], tileSize: 256, attribution: 'RainViewer' });
      map.addLayer({ id: layerId, type: 'raster', source: sourceId, paint: { 'raster-opacity': 0.75 } });
      this.vectorCounts.update((c) => ({ ...c, rain: 1 }));
    } catch (err) {
      console.error('[globe] rain fetch failed', err);
      this.showRain.set(false);
    } finally {
      this.vectorLoading.set(null);
    }
  }

  private async _fetchVectorFc(kind: 'lightning' | 'alerts' | 'vessels' | 'metar' | 'hubeau' | 'piezo' | 'quakes' | 'firms' | 'buoys' | 'sigmet' | 'taf' | 'cables' | 'fir' | 'airports'): Promise<{ features: any[] }> {
    // G66 (2026-05-27) — 3 vector layers placeholders impl.
    // G66c (2026-05-27) — bug CORS : aviationweather.gov + submarinecablemap.com
    // ne renvoient pas Access-Control-Allow-Origin. Routés via nginx proxy
    // (cf frontend/nginx.conf locations /aviation-airsigmet, /aviation-taf,
    // /cables-geo) qui add_header CORS et cache la réponse.
    if (kind === 'sigmet') {
      const resp = await fetch('/aviation-airsigmet?format=geojson&hours=2');
      if (!resp.ok) throw new Error(`SIGMET fetch HTTP ${resp.status}`);
      return await resp.json();
    }
    if (kind === 'taf') {
      // G66c (2026-05-27) — bbox obligatoire upstream sinon HTTP 400.
      // Globe = bbox monde entier (lat0,lon0,lat1,lon1 selon aviationweather API).
      const resp = await fetch('/aviation-taf?format=geojson&hours=12&bbox=-90,-180,90,180');
      if (!resp.ok) throw new Error(`TAF fetch HTTP ${resp.status}`);
      return await resp.json();
    }
    if (kind === 'fir') {
      // G66f (2026-05-27) — FIR/UIR depuis API NestJS qui lit PostGIS
      // (synced weekly depuis VATSpy).
      const resp = await fetch('/api/fir-airspaces');
      if (!resp.ok) throw new Error(`FIR fetch HTTP ${resp.status}`);
      return await resp.json();
    }
    if (kind === 'airports') {
      // G66l (2026-05-27) — airports IATA depuis API NestJS (PostGIS, OpenAIP).
      const resp = await fetch('/api/airports');
      if (!resp.ok) throw new Error(`Airports fetch HTTP ${resp.status}`);
      return await resp.json();
    }
    if (kind === 'cables') {
      try {
        const resp = await fetch('/cables-geo');
        if (resp.ok) return await resp.json();
      } catch { /* fallback ci-dessous */ }
      // Mini-fallback : 5 grands câbles trans-océaniques pour démo.
      return {
        features: [
          { type: 'Feature', properties: { name: 'TAT-14' }, geometry: { type: 'LineString', coordinates: [[-73.95, 40.75], [-3.0, 51.5]] } },
          { type: 'Feature', properties: { name: 'MAREA' }, geometry: { type: 'LineString', coordinates: [[-77.04, 36.85], [-9.13, 38.72]] } },
          { type: 'Feature', properties: { name: 'SEA-ME-WE 5' }, geometry: { type: 'LineString', coordinates: [[3.7, 43.5], [103.85, 1.29], [120.98, 14.59]] } },
          { type: 'Feature', properties: { name: 'TPE' }, geometry: { type: 'LineString', coordinates: [[-122.4, 37.77], [139.69, 35.69], [121.47, 25.04]] } },
          { type: 'Feature', properties: { name: 'AAE-1' }, geometry: { type: 'LineString', coordinates: [[2.35, 48.85], [30.0, 30.0], [55.27, 25.2], [88.36, 22.57], [103.85, 1.29], [114.18, 22.32]] } },
        ],
      };
    }

    if (kind === 'lightning') {
      return await firstValueFrom(this.lightningService.fetchRecent(new Date(), 1800));
    }
    if (kind === 'alerts') {
      return await this.alertsService.refresh(new Date(), 3600);
    }
    if (kind === 'vessels') {
      const fc = await firstValueFrom(this.vesselsService.fetchLiveVessels(new Date(), 900));
      // G18 M11 — peuple le cache mmsi → name pour le popup tracks
      this.vesselNameCache.clear();
      for (const feat of fc.features ?? []) {
        const p = (feat.properties ?? {}) as unknown as Record<string, unknown>;
        const mmsi = p['mmsi'] as number | undefined;
        const name = (p['vessel_name'] || p['name']) as string | undefined;
        if (mmsi != null && name) this.vesselNameCache.set(mmsi, name);
      }
      return fc;
    }
    // G8 — fetch REST direct pour layers vector. Mapping endpoint :
    //  - piezo  → /api/hubeau/piezo/recent (path nested sous hubeau)
    //  - quakes → /api/earthquakes/recent  (controller earthquakes.controller)
    //  - buoys  → WFS BuoysService.fetchReferential() (G24, pas /api endpoint)
    //  - autres → /api/<kind>/recent
    if (kind === 'buoys') {
      // G24 — fetch via WFS (pas d'endpoint /api/buoys/recent côté API)
      return await firstValueFrom(this.buoysService.fetchReferential());
    }
    const at = new Date().toISOString();
    const endpoint = kind === 'piezo'  ? '/api/hubeau/piezo/recent'
                   : kind === 'quakes' ? '/api/earthquakes/recent'
                   : `/api/${kind}/recent`;
    const resp = await fetch(`${endpoint}?at=${encodeURIComponent(at)}`);
    if (!resp.ok) {
      throw new Error(`/api/${kind}/recent → HTTP ${resp.status}`);
    }
    return await resp.json();
  }

  /** G16 (2026-05-22) — toggle un produit sat de façon indépendante. Permet
   *  le stacking (radar par-dessus sat IR par-dessus SST, etc.). Remplace
   *  l'ancien onSatChange radio-select.
   *
   *  Backward compat : onSatChange est conservé en wrapper pour le restore
   *  localStorage des prefs legacy `activeSat: 'satXyz'`. */
  toggleSatLayer(key: string, on: boolean): void {
    // G71 (2026-06-15) — satRainviewer n'est pas un produit GS, c'est un
    // XYZ direct (cf toggleSatRainviewer). Délègue pour partager le code
    // (wipe-all, persist/restore).
    if (key === 'satRainviewer') { void this.toggleSatRainviewer(on); return; }
    const sig = this.satShowSignals()[key];
    if (!sig || sig() === on) return;
    sig.set(on);
    const map = this.map;
    if (!map) return;
    const product = SAT_PRODUCTS.find((p) => p.key === key);
    if (!product) return;
    const sourceId = `sat-${product.key}`;
    const layerId = sourceId;

    if (!on) {
      if (map.getLayer(layerId)) map.removeLayer(layerId);
      if (map.getSource(sourceId)) map.removeSource(sourceId);
      return;
    }

    // Si déjà présent (race), nettoyer d'abord.
    if (map.getSource(sourceId)) {
      if (map.getLayer(layerId)) map.removeLayer(layerId);
      map.removeSource(sourceId);
    }

    // G65 (2026-05-27) — Bug TC-1 cascade : utiliser this.currentTime() pour que
    // le 1er tile au toggle ON respecte le cursor courant, en parité avec
    // refreshWmsTimeForActiveLayers (ligne ~4104). Avant ce fix, cascade fired
    // TIME=Date.now() au toggle, puis refresh corrigeait. Avec le bug GS cascade
    // qui retourne la même image quel que soit TIME, l'impact était invisible,
    // mais quand le fix GS atterrit, on aurait affiché la mauvaise validity.
    const t = this.currentTime();
    let timeParam: string;
    if (product.kind === 'gibs-daily') {
      // Snap au jour J-2 max (parité refresh : GIBS lag ~48h).
      const cap = Math.min(t.getTime(), Date.now() - 48 * 3_600_000);
      const effDate = new Date(cap);
      timeParam = `${effDate.getUTCFullYear()}-${String(effDate.getUTCMonth() + 1).padStart(2, '0')}-${String(effDate.getUTCDate()).padStart(2, '0')}`;
    } else {
      timeParam = t.toISOString().split('.')[0] + 'Z';
    }

    // G71 (2026-06-15) — cascade-realtime layers (EUMETSAT/DWD/KNMI) :
    // PAS de TIME dans l'URL. GS 2.28.3 ne propage pas TIME aux upstream
    // cascade (WMSLayerInfoImpl REST PUT metadata.entry HTTP 500 — voir
    // [[geoserver_wmslayer_rest_unsupported_pattern]]). Avec TIME, le
    // cascade GS retourne "GetMap failed" générique sans rendre la tile.
    // Sans TIME, GS forward proprement → upstream renvoie la latest
    // validity disponible. Tradeoff accepté : animation cascade-realtime
    // figée sur "now" jusqu'à fix upstream GS.
    const wmsTimePart = product.kind === 'cascade-realtime' ? '' : `&TIME=${encodeURIComponent(timeParam)}`;
    const url =
      `/geoserver/${product.workspace}/wms` +
      '?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap' +
      `&LAYERS=${product.workspace}:${product.gsName}` +
      wmsTimePart +
      '&STYLES=&FORMAT=image/png&TRANSPARENT=true' +
      '&SRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256';

    map.addSource(sourceId, { type: 'raster', tiles: [url], tileSize: 256, attribution: product.attribution });
    // Insertion en dessous des layers vector/animations pour préserver Z auto.
    const before = map.getLayer('sst-wms') ? 'sst-wms'
                 : map.getLayer('wind-webgl') ? 'wind-webgl'
                 : undefined;
    map.addLayer({ id: layerId, type: 'raster', source: sourceId, paint: { 'raster-opacity': 0.85 } }, before);
  }

  /** Wrapper legacy pour le restore localStorage activeSat='satXyz'. */
  onSatChange(key: string) {
    if (key === 'none') {
      // Désactive tous les sat layers actuellement actifs
      for (const [satKey, sig] of Object.entries(this.satShowSignals())) {
        if (sig()) this.toggleSatLayer(satKey, false);
      }
      this.activeSat.set('none');
      return;
    }
    this.toggleSatLayer(key, true);
    this.activeSat.set(key);
  }

  async toggleWind(on: boolean) {
    if (this.showWind() === on) return;
    this.showWind.set(on);
    const map = this.map;
    if (!map) return;

    if (!on) {
      if (this.windLayer && map.getLayer(this.windLayer.id)) {
        map.removeLayer(this.windLayer.id);
      }
      this.windLayer = undefined;
      this.windEngine = undefined;
      return;
    }

    this.windLoading.set(true);
    this.windError.set(null);
    try {
      const grid = await this._loadWindGrid();
      const windData = buildWindTexture(grid, WIND_BBOX, 512, 256);
      const self = this;
      const layer: CustomLayerInterface = {
        id: 'wind-webgl',
        type: 'custom',
        onAdd(_map, gl) {
          // MapLibre fournit un WebGL2RenderingContext en interne.
          self.windEngine = new WindWebGL(gl as WebGL2RenderingContext, { bounds: WIND_BBOX });
          self.windEngine.setNumParticles(DEFAULT_WIND_PARTICLES);
          self.windEngine.setWind(windData);
          // G72 — applique l'opacity persistée à l'instantiation (slider restore).
          self.windEngine.opacity = self.getLayerOpacity('windParticles');
        },
        render(_gl, args) {
          if (!self.windEngine) return;
          self.windEngine.draw(args as unknown as MapLibreCustomLayerRenderArgs);
          self.map?.triggerRepaint();
        },
        onRemove() {
          // engine refs cleared by caller in ngOnDestroy/toggleWind(false)
        },
      };
      this.windLayer = layer;
      map.addLayer(layer);
      this.windLoading.set(false);
    } catch (err) {
      console.error('[globe] wind grid load failed', err);
      this.windError.set(err instanceof Error ? err.message : 'erreur de chargement');
      this.windLoading.set(false);
      this.showWind.set(false);
    }
  }

  private async _loadWindGrid(): Promise<WindGridPoint[]> {
    if (this.windGridCache) return this.windGridCache;
    const manifest = await this.arrows.getManifest();
    if (!manifest) throw new Error('manifest indisponible');
    const tsList = manifest.wind ?? [];
    if (tsList.length === 0) throw new Error('aucun timestamp wind dans le manifest');
    const nearest = this.arrows.findNearestTs(tsList, new Date()) ?? tsList[tsList.length - 1];
    const fc = await this.arrows.fetchArrows('wind', nearest);
    const grid: WindGridPoint[] = fc.features
      .filter((f) => f.geometry?.type === 'Point')
      .map((f) => {
        const props = f.properties as { speed?: number; dirTo?: number };
        const speed = props.speed ?? 0;
        const dirTo = props.dirTo ?? 0;
        const { u, v } = speedDirToUv(speed, dirTo);
        const [lon, lat] = f.geometry.coordinates;
        return { lon, lat, u, v };
      });
    this.windGridCache = grid;
    return grid;
  }

  private _initMap(): void {
    const container = this.mapContainer().nativeElement;
    const map = new maplibregl.Map({
      container,
      // G23 — disable default AttributionControl, on gère via refreshAttribution
      // custom qui inclut OSM/CARTO + layers actives + mention Claude.
      attributionControl: false,
      style: {
        version: 8,
        glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
        sources: {
          'carto-dark': {
            type: 'raster',
            tiles: [
              'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
              'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
              'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
              'https://d.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
            ],
            tileSize: 256,
            // Pas d'attribution ici → AttributionControl::compact() en wrap.
          },
        },
        layers: [{ id: 'carto-dark', type: 'raster', source: 'carto-dark' }],
      },
      center: [2, 30],
      zoom: 1.4,
    });

    // 2026-05-20 — bug MapLibre 5.24 : la spec `projection` au constructor
    // n'active pas le globe au boot ET n'est pas dans les MapOptions typings
    // strict. Appel explicite setProjection() après load pour la sandbox JS,
    // ici on le fait au load aussi pour Angular TS.
    map.on('load', () => {
      map.setProjection({ type: this.projection() });
      // G31 (2026-05-23) — sprite arrow SDF pour wind-arrows-vec / wave-arrows-vec.
      // SDF=true → tintable via icon-color dans la layer.
      this.addArrowIconToMap(map);
      // G11e — applique le state user restauré depuis localStorage AVANT le boot
      // (toggleX peut maintenant créer les sources/layers).
      this.applyPendingRestore();
    });

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }));
    map.addControl(new maplibregl.ScaleControl({ unit: 'nautical' }));

    // G22 (2026-05-23) — Custom attribution avec mention Claude + layers actives.
    // L'attribution se re-build à chaque changement de layer via effect.
    this.refreshAttribution(map);

    const onMoveStart = () => this.windEngine?.setMoving(true);
    const onMoveEnd = () => this.windEngine?.setMoving(false);
    for (const ev of ['movestart', 'zoomstart', 'pitchstart', 'rotatestart']) {
      map.on(ev as any, onMoveStart);
      this.moveHandlers.push({ event: ev, handler: onMoveStart });
    }
    for (const ev of ['moveend', 'zoomend', 'pitchend', 'rotateend']) {
      map.on(ev as any, onMoveEnd);
      this.moveHandlers.push({ event: ev, handler: onMoveEnd });
    }
    map.on('resize', () => this.windEngine?.resize());

    // 2026-05-21 — Popups click sur vessels / lightning / alerts.
    // Pattern MapLibre standard : queryRenderedFeatures sur le pixel cliqué,
    // détecte la layer source, build HTML avec props feature, ouvre Popup.
    // Cluster vessels → zoom-in au lieu de popup (comme /map OL prod).
    map.on('click', (e) => {
      // Helpers utilisés dans les branches (fmtRelTime + row builder)
      const fmtRelTimeOuter = (isoOrTs: unknown): string => {
        if (!isoOrTs) return '';
        const d = new Date(String(isoOrTs));
        if (isNaN(d.getTime())) return String(isoOrTs);
        const diffSec = Math.round((Date.now() - d.getTime()) / 1000);
        if (diffSec < 60) return `il y a ${diffSec}s`;
        const diffMin = Math.round(diffSec / 60);
        if (diffMin < 60) return `il y a ${diffMin} min`;
        const diffH = Math.round(diffMin / 60);
        if (diffH < 24) return `il y a ${diffH}h`;
        return `il y a ${Math.round(diffH / 24)}j`;
      };
      const rowOuter = (label: string, value: string | number | undefined | null, unit = ''): string => {
        if (value === null || value === undefined || value === '') return '';
        return `<div style="display:flex;justify-content:space-between;gap:12px;margin-top:3px"><span style="color:#8a96a8;font-size:11px">${label}</span><span style="font-weight:500">${value}${unit}</span></div>`;
      };

      // G18 M11 — vessel tracks line-click avec bbox tolerance.
      // queryRenderedFeatures sur e.point sur une ligne fine échoue souvent
      // (1.2px width). On utilise une bbox 6px autour du curseur.
      if (map.getLayer('vec-tracks')) {
        const T = 6;
        const trackFeats = map.queryRenderedFeatures(
          [[e.point.x - T, e.point.y - T], [e.point.x + T, e.point.y + T]],
          { layers: ['vec-tracks'] },
        );
        if (trackFeats.length > 0) {
          const p = (trackFeats[0].properties ?? {}) as Record<string, unknown>;
          const mmsi = p['mmsi'] as number | undefined;
          const day = p['day'] as string | undefined;
          const pointsN = p['points_n'] as number | undefined;
          const vesselName = mmsi != null ? this.vesselNameLookup(mmsi) : null;
          const title = vesselName ?? (mmsi != null ? `MMSI ${mmsi}` : 'Trajet AIS');
          const html = `
            <div>
              <div style="font-size:13px;font-weight:600;color:#22c55e;border-bottom:1px solid #2a3245;padding-bottom:6px;margin-bottom:4px">🛤 ${title}</div>
              ${rowOuter('MMSI', mmsi)}
              ${rowOuter('Jour', day)}
              ${rowOuter('Points AIS', pointsN)}
            </div>`;
          this.activePopup?.remove();
          this.activePopup = new maplibregl.Popup({ closeButton: true, maxWidth: '260px', offset: 12 })
            .setLngLat(e.lngLat)
            .setHTML(html)
            .addTo(map);
          this.activePopupLayerKey = 'tracks';
          this.activePopup.on('close', () => { if (this.activePopupLayerKey === 'tracks') this.activePopupLayerKey = undefined; });
          return;
        }
      }

      const allLayers = [
        'vec-vessels-clusters', 'vec-vessels-points',
        'vec-lightning', 'vec-alerts',
        'vec-metar', 'vec-hubeau', 'vec-piezo',
        'vec-quakes', 'vec-firms', 'vec-buoys',
        // G66e (2026-05-27) — popups SIGMET (polygon fill) + TAF (circle) + Cables (line)
        'vec-sigmet-fill', 'vec-taf', 'vec-cables',
        // G66f (2026-05-27) — FIR/UIR line
        'vec-fir-line',
        // G66l (2026-05-27) — airports cluster + points
        'vec-airports-clusters', 'vec-airports-dot', 'vec-airports-points',
      ];
      const existing = allLayers.filter((id) => map.getLayer(id));
      if (existing.length === 0) return;

      const features = map.queryRenderedFeatures(e.point, { layers: existing });
      if (features.length === 0) return;  // closeOnClick MapLibre default = ferme
      const f = features[0];
      const layerId = f.layer.id;
      const p = (f.properties ?? {}) as Record<string, unknown>;

      // Cluster vessel + airports → zoom-in (pas de popup)
      if (layerId === 'vec-vessels-clusters' || layerId === 'vec-airports-clusters') {
        const clusterId = p['cluster_id'];
        const src = map.getSource(f.source) as maplibregl.GeoJSONSource & {
          getClusterExpansionZoom?: (id: number) => Promise<number>;
        };
        if (typeof clusterId === 'number' && src.getClusterExpansionZoom) {
          src.getClusterExpansionZoom(clusterId).then((zoom: number) => {
            const coords = (f.geometry as unknown as { coordinates: [number, number] }).coordinates as [number, number];
            map.easeTo({ center: coords, zoom });
          });
        }
        return;
      }

      // Helpers
      const fmtRelTime = (isoOrTs: unknown): string => {
        if (!isoOrTs) return '';
        const d = new Date(String(isoOrTs));
        if (isNaN(d.getTime())) return String(isoOrTs);
        const diffSec = Math.round((Date.now() - d.getTime()) / 1000);
        if (diffSec < 60) return `il y a ${diffSec}s`;
        const diffMin = Math.round(diffSec / 60);
        if (diffMin < 60) return `il y a ${diffMin} min`;
        const diffH = Math.round(diffMin / 60);
        if (diffH < 24) return `il y a ${diffH}h`;
        return `il y a ${Math.round(diffH / 24)}j`;
      };
      const row = (label: string, value: string | number | undefined | null, unit = ''): string => {
        if (value === null || value === undefined || value === '') return '';
        return `<div style="display:flex;justify-content:space-between;gap:12px;margin-top:3px"><span style="color:#8a96a8;font-size:11px">${label}</span><span style="font-weight:500">${value}${unit}</span></div>`;
      };

      // Build popup HTML selon le type de layer
      let html = '';
      if (layerId === 'vec-vessels-points') {
        const name = (p['vessel_name'] || p['name'] || '') as string;
        const mmsi = p['mmsi'] as number | undefined;
        const sog = p['sog'] as number | undefined;
        const cog = (p['cog'] ?? p['heading']) as number | undefined;
        const destination = p['destination'] as string | undefined;
        const shipType = p['ship_type'] as number | undefined;
        const lengthM = p['length_m'] as number | undefined;
        const flag = p['flag'] as string | undefined;
        const lastSeen = (p['last_seen'] || p['ts']) as string | undefined;
        html = `
          <div>
            <div style="font-size:13px;font-weight:600;color:#e6ecf3;border-bottom:1px solid #2a3245;padding-bottom:6px;margin-bottom:4px">🚢 ${name || `MMSI ${mmsi ?? '?'}`}</div>
            ${row('MMSI', mmsi)}
            ${row('Vitesse', sog != null ? sog.toFixed(1) : null, ' kn')}
            ${row('Cap', cog != null ? Math.round(cog) : null, '°')}
            ${row('Destination', destination)}
            ${row('Type', shipType)}
            ${row('Longueur', lengthM, ' m')}
            ${row('Pavillon', flag)}
            ${row('Dernier signal', fmtRelTime(lastSeen))}
          </div>`;
      } else if (layerId === 'vec-lightning') {
        const ts = p['ts'] as string | undefined;
        const strength = p['strength'] as number | undefined;
        html = `
          <div>
            <div style="font-size:13px;font-weight:600;color:#fde047;border-bottom:1px solid #2a3245;padding-bottom:6px;margin-bottom:4px">⚡ Éclair</div>
            ${row('Heure', fmtRelTime(ts))}
            ${row('Intensité', strength)}
          </div>`;
      } else if (layerId === 'vec-alerts') {
        const kind = p['kind'] as string | undefined;
        const severity = (p['severity'] as string | undefined) ?? 'info';
        const target = (p['vessel_name'] || (p['mmsi'] ? `MMSI ${p['mmsi']}` : '')) as string;
        const ts = p['ts'] as string | undefined;
        const colorMap: Record<string, string> = { danger: '#dc2626', warning: '#f97316', info: '#38bdf8' };
        const color = colorMap[severity] ?? '#94a3b8';
        html = `
          <div>
            <div style="font-size:13px;font-weight:600;color:${color};border-bottom:1px solid #2a3245;padding-bottom:6px;margin-bottom:4px">⚠ ${this.alertKindLabel(kind ?? 'Alerte')} <span style="font-size:10px;text-transform:uppercase;opacity:.8">(${severity})</span></div>
            ${row('Cible', target)}
            ${row('Heure', fmtRelTime(ts))}
          </div>`;
      } else if (layerId === 'vec-metar') {
        // METAR — station météo aviation (NOAA AWC).
        const name = (p['station_name'] || p['icao'] || 'Station') as string;
        const icao = p['icao'] as string | undefined;
        const ts = p['ts'] as string | undefined;
        const temp = p['temp_c'] as number | undefined;
        const dewp = p['dewp_c'] as number | undefined;
        const windKt = p['wind_speed_kt'] as number | undefined;
        const windDir = p['wind_dir_deg'] as number | undefined;
        const windGust = p['wind_gust_kt'] as number | undefined;
        const qnh = p['altimeter_hpa'] as number | undefined;
        const weather = p['weather_str'] as string | undefined;
        const windStr = windKt != null
          ? `${windDir != null ? `${Math.round(windDir).toString().padStart(3, '0')}° ` : ''}${Math.round(windKt)} kn${windGust != null ? ` (G ${Math.round(windGust)})` : ''}`
          : null;
        html = `
          <div>
            <div style="font-size:13px;font-weight:600;color:#fbbf24;border-bottom:1px solid #2a3245;padding-bottom:6px;margin-bottom:4px">🛬 ${name}${icao && icao !== name ? ` <span style="font-size:10px;opacity:.7">${icao}</span>` : ''}</div>
            ${row('Heure', fmtRelTime(ts))}
            ${row('Température', temp != null ? temp.toFixed(1) : null, ' °C')}
            ${row('Point de rosée', dewp != null ? dewp.toFixed(1) : null, ' °C')}
            ${row('Vent', windStr)}
            ${row('QNH', qnh != null ? Math.round(qnh) : null, ' hPa')}
            ${row('Conditions', weather)}
          </div>`;
      } else if (layerId === 'vec-hubeau') {
        // Hub'eau débits — stations hydrologie FR.
        const code = p['code_station'] as string | undefined;
        const ts = p['ts'] as string | undefined;
        const debit = p['debit_m3_s'] as number | undefined;
        const debitL = p['debit_l_s'] as number | undefined;
        const qualif = p['qualif'] as string | undefined;
        html = `
          <div>
            <div style="font-size:13px;font-weight:600;color:#06b6d4;border-bottom:1px solid #2a3245;padding-bottom:6px;margin-bottom:4px">💧 Station ${code ?? '?'}</div>
            ${row('Mesure', fmtRelTime(ts))}
            ${row('Débit', debit != null ? `${debit.toFixed(2)} m³/s${debitL != null ? ` (${Math.round(debitL)} L/s)` : ''}` : null)}
            ${row('Qualif', qualif)}
            ${code ? `<div style="margin-top:6px;font-size:10px"><a href="https://www.hydro.eaufrance.fr/stationhydro/${code}/synthese" target="_blank" rel="noopener" style="color:#06b6d4">hydro.eaufrance.fr ↗</a></div>` : ''}
          </div>`;
      } else if (layerId === 'vec-piezo') {
        // Piézomètres FR — Hub'eau ades.
        const bss = p['code_bss'] as string | undefined;
        const ts = p['ts'] as string | undefined;
        const profondeur = p['profondeur_nappe'] as number | undefined;
        const ngf = p['niveau_eau_ngf'] as number | undefined;
        const alt = p['altitude_station'] as number | undefined;
        html = `
          <div>
            <div style="font-size:13px;font-weight:600;color:#8b5cf6;border-bottom:1px solid #2a3245;padding-bottom:6px;margin-bottom:4px">🩸 Piézo ${bss ?? '?'}</div>
            ${row('Mesure', fmtRelTime(ts))}
            ${row('Profondeur nappe', profondeur != null ? profondeur.toFixed(2) : null, ' m')}
            ${row('Niveau NGF', ngf != null ? ngf.toFixed(2) : null, ' m')}
            ${row('Altitude station', alt != null ? alt.toFixed(0) : null, ' m')}
            ${bss ? `<div style="margin-top:6px;font-size:10px"><a href="https://ades.eaufrance.fr/Fiche/PointEau?code=${bss}" target="_blank" rel="noopener" style="color:#8b5cf6">ades.eaufrance.fr ↗</a></div>` : ''}
          </div>`;
      } else if (layerId === 'vec-quakes') {
        // Séismes USGS — magnitude + place + tsunami.
        const place = p['place'] as string | undefined;
        const time = p['time'] as string | undefined;
        const mag = p['mag'] as number | undefined;
        const depth = p['depth_km'] as number | undefined;
        const sig = p['sig'] as number | undefined;
        const tsunami = p['tsunami'] as number | boolean | undefined;
        const alert = p['alert'] as string | undefined;
        const url = p['url'] as string | undefined;
        const magColor = mag == null ? '#94a3b8' : mag >= 6 ? '#dc2626' : mag >= 5 ? '#ea580c' : mag >= 4 ? '#fbbf24' : '#84cc16';
        html = `
          <div>
            <div style="font-size:13px;font-weight:600;color:${magColor};border-bottom:1px solid #2a3245;padding-bottom:6px;margin-bottom:4px">🌋 ${place ?? 'Séisme'}<span style="font-size:11px;float:right;background:${magColor};color:#fff;padding:2px 6px;border-radius:4px">M ${mag != null ? mag.toFixed(1) : '?'}</span></div>
            ${row('Heure', fmtRelTime(time))}
            ${row('Profondeur', depth != null ? depth.toFixed(1) : null, ' km')}
            ${row('Significance', sig != null ? `${sig}/1000` : null)}
            ${tsunami ? `<div style="color:#dc2626;font-weight:600;margin-top:4px">⚠ Tsunami</div>` : ''}
            ${alert ? `<div style="text-transform:uppercase;color:${alert === 'red' ? '#dc2626' : alert === 'orange' ? '#ea580c' : alert === 'yellow' ? '#fbbf24' : '#84cc16'};margin-top:4px;font-size:11px">Alert: ${alert}</div>` : ''}
            ${url ? `<div style="margin-top:6px;font-size:10px"><a href="${url}" target="_blank" rel="noopener" style="color:#06b6d4">earthquake.usgs.gov ↗</a></div>` : ''}
          </div>`;
      } else if (layerId === 'vec-firms') {
        // FIRMS feux — NASA hotspots MODIS/VIIRS.
        const ts = p['ts'] as string | undefined;
        const frp = p['frp'] as number | undefined;
        const brightness = p['brightness'] as number | undefined;
        const confidence = p['confidence'] as number | string | undefined;
        const satellite = p['satellite'] as string | undefined;
        const daynight = p['daynight'] as string | undefined;
        const frpColor = frp == null ? '#94a3b8' : frp >= 200 ? '#b91c1c' : frp >= 50 ? '#dc2626' : frp >= 10 ? '#f97316' : '#fbbf24';
        const satName = satellite === 'T' ? 'Terra' : satellite === 'A' ? 'Aqua' : satellite ?? '?';
        const dnLabel = daynight === 'D' ? 'jour' : daynight === 'N' ? 'nuit' : '';
        html = `
          <div>
            <div style="font-size:13px;font-weight:600;color:${frpColor};border-bottom:1px solid #2a3245;padding-bottom:6px;margin-bottom:4px">🔥 Hotspot feu<span style="font-size:11px;float:right;background:${frpColor};color:#fff;padding:2px 6px;border-radius:4px">${frp != null ? frp.toFixed(1) : '?'} MW</span></div>
            ${row('Acquisition', fmtRelTime(ts))}
            ${row('Brightness', brightness != null ? brightness.toFixed(1) : null, ' K')}
            ${row('Confiance', confidence != null ? `${confidence}/100` : null)}
            ${row('Satellite', satellite ? `${satName}${dnLabel ? ` (${dnLabel})` : ''}` : null)}
          </div>`;
      } else if (layerId === 'vec-sigmet-fill') {
        // G66e (2026-05-27) — SIGMET / AIRMET popup (aviationweather.gov GeoJSON).
        // Props observées : hazard, severity, rawAirSigmet, validTimeFrom, validTimeTo,
        // altitudeLow1Type, altitudeLow1, altitudeHi1, fir, airSigmetType.
        const hazard = (p['hazard'] || p['hazardType']) as string | undefined;
        const sigmetType = p['airSigmetType'] as string | undefined;
        const severity = p['severity'] as string | undefined;
        const fir = p['fir'] as string | undefined;
        const validFrom = p['validTimeFrom'] as string | undefined;
        const validTo = p['validTimeTo'] as string | undefined;
        const altLow = p['altitudeLow1'] as number | undefined;
        const altHi = p['altitudeHi1'] as number | undefined;
        const raw = p['rawAirSigmet'] as string | undefined;
        const altStr = (altLow != null || altHi != null)
          ? `${altLow != null ? `FL${altLow}` : '?'} → ${altHi != null ? `FL${altHi}` : '?'}`
          : null;
        const fmtRange = (from?: string, to?: string) => {
          if (!from && !to) return null;
          const f = from ? new Date(from).toISOString().slice(0, 16).replace('T', ' ') : '?';
          const t = to ? new Date(to).toISOString().slice(0, 16).replace('T', ' ') : '?';
          return `${f}Z → ${t}Z`;
        };
        const title = hazard ? `${hazard}${sigmetType ? ` · ${sigmetType}` : ''}` : (sigmetType ?? 'SIGMET / AIRMET');
        html = `
          <div>
            <div style="font-size:13px;font-weight:600;color:#dc2626;border-bottom:1px solid #2a3245;padding-bottom:6px;margin-bottom:4px">⚠ ${title}</div>
            ${row('FIR', fir)}
            ${row('Sévérité', severity)}
            ${row('Altitudes', altStr)}
            ${row('Validité', fmtRange(validFrom, validTo))}
            ${raw ? `<div style="margin-top:6px;padding-top:6px;border-top:1px solid #2a3245;font-family:monospace;font-size:10px;color:#cfd6e2;white-space:pre-wrap;max-height:120px;overflow:auto">${raw}</div>` : ''}
          </div>`;
      } else if (layerId === 'vec-taf') {
        // G66e — TAF popup. Props : id (ICAO), site, issueTime, validTimeFrom, validTimeTo, rawTAF.
        const icao = (p['id'] || p['icaoId']) as string | undefined;
        const site = p['site'] as string | undefined;
        const issueTime = p['issueTime'] as string | undefined;
        const validFrom = p['validTimeFrom'] as string | undefined;
        const validTo = p['validTimeTo'] as string | undefined;
        const raw = p['rawTAF'] as string | undefined;
        const fmtRange = (from?: string, to?: string) => {
          if (!from && !to) return null;
          const f = from ? new Date(from).toISOString().slice(0, 16).replace('T', ' ') : '?';
          const t = to ? new Date(to).toISOString().slice(0, 16).replace('T', ' ') : '?';
          return `${f}Z → ${t}Z`;
        };
        html = `
          <div>
            <div style="font-size:13px;font-weight:600;color:#3b82f6;border-bottom:1px solid #2a3245;padding-bottom:6px;margin-bottom:4px">✈ ${icao ?? 'TAF'}</div>
            ${row('Aéroport', site)}
            ${row('Émis', fmtRelTime(issueTime))}
            ${row('Validité', fmtRange(validFrom, validTo))}
            ${raw ? `<div style="margin-top:6px;padding-top:6px;border-top:1px solid #2a3245;font-family:monospace;font-size:10px;color:#cfd6e2;white-space:pre-wrap;max-height:120px;overflow:auto">${raw}</div>` : ''}
          </div>`;
      } else if (layerId === 'vec-fir-line') {
        // G66f (2026-05-27) — FIR/UIR popup (OpenAIP via API).
        const name = (p['name'] || 'FIR') as string;
        const type = p['type'] as string | undefined;
        const country = p['country'] as string | undefined;
        const icaoClass = p['icaoClass'] as string | undefined;
        const upperFt = p['upperLimitFt'] as number | undefined;
        const lowerFt = p['lowerLimitFt'] as number | undefined;
        const activity = p['activity'] as string | undefined;
        const altStr = (upperFt != null || lowerFt != null)
          ? `${lowerFt != null ? `${lowerFt} ft` : 'SFC'} → ${upperFt != null ? `${upperFt} ft` : 'UNL'}`
          : null;
        html = `
          <div>
            <div style="font-size:13px;font-weight:600;color:#94a3b8;border-bottom:1px solid #2a3245;padding-bottom:6px;margin-bottom:4px">✈ ${name}</div>
            ${row('Type', type)}
            ${row('Pays', country)}
            ${row('Classe ICAO', icaoClass)}
            ${row('Altitudes', altStr)}
            ${row('Activité', activity)}
          </div>`;
      } else if (layerId === 'vec-airports-dot' || layerId === 'vec-airports-points') {
        // G66l — airport popup (OpenAIP).
        const name = (p['name'] || 'Aéroport') as string;
        const iata = p['iataCode'] as string | undefined;
        const icao = p['icaoCode'] as string | undefined;
        const country = p['country'] as string | undefined;
        const elevFt = p['elevationFt'] as number | undefined;
        html = `
          <div>
            <div style="font-size:13px;font-weight:600;color:#0ea5e9;border-bottom:1px solid #2a3245;padding-bottom:6px;margin-bottom:4px">✈ ${name}</div>
            ${row('IATA', iata)}
            ${row('ICAO', icao)}
            ${row('Pays', country)}
            ${row('Altitude', elevFt != null ? elevFt : null, ' ft')}
          </div>`;
      } else if (layerId === 'vec-cables') {
        // G66e — Câbles sous-marins. Props TeleGeography : name, slug, length, owners.
        const name = (p['name'] || 'Câble sous-marin') as string;
        const slug = p['slug'] as string | undefined;
        const length = p['length'] as string | number | undefined;
        const owners = p['owners'] as string | undefined;
        const rfs = p['rfs'] as string | undefined;
        html = `
          <div>
            <div style="font-size:13px;font-weight:600;color:#f59e0b;border-bottom:1px solid #2a3245;padding-bottom:6px;margin-bottom:4px">━ ${name}</div>
            ${row('Slug', slug)}
            ${row('Longueur', length, typeof length === 'number' ? ' km' : '')}
            ${row('RFS', rfs)}
            ${owners ? `<div style="margin-top:6px;padding-top:6px;border-top:1px solid #2a3245;font-size:11px;color:#cfd6e2;line-height:1.4">${owners}</div>` : ''}
          </div>`;
      } else if (layerId === 'vec-buoys') {
        // Bouées EMODnet — réseau in-situ.
        const name = (p['name'] || p['candhis_id'] || 'Bouée') as string;
        const candhis = p['candhis_id'] as string | undefined;
        const wmo = p['wmo'] as string | undefined;
        const platformType = p['platform_type'] as string | undefined;
        const buoyType = p['buoy_type'] as string | undefined;
        const owner = p['owner'] as string | undefined;
        const country = p['country'] as string | undefined;
        const lastObs = p['last_obs_at'] as string | undefined;
        const params = p['parameters_group'] as string | undefined;
        html = `
          <div>
            <div style="font-size:13px;font-weight:600;color:#10b981;border-bottom:1px solid #2a3245;padding-bottom:6px;margin-bottom:4px">⚓ ${name}</div>
            ${row('CANDHIS', candhis)}
            ${row('WMO', wmo)}
            ${row('Type', platformType ?? buoyType)}
            ${row('Owner', owner)}
            ${row('Pays', country)}
            ${row('Dernière obs', fmtRelTime(lastObs))}
            ${row('Paramètres', params)}
          </div>`;
      }

      if (html) {
        // Retour à maplibregl.Popup natif (Sylvain : 'MapLibre gère ça').
        // L'ancien bug 'popup en bas hors map' venait de mon CSS override
        // qui mettait position: relative sur .maplibregl-popup-content,
        // ce qui cassait le transform du wrapper .maplibregl-popup parent.
        // G22 — track activePopup + sa layer pour auto-close lors deactivation.
        // G66e (2026-05-27) — geometry peut être Point (vector classique), Polygon
        // (SIGMET) ou LineString (cables). Pour non-Point, on prend e.lngLat (point
        // cliqué) au lieu d'un centroid calculé.
        const coords: [number, number] = (f.geometry.type === 'Point')
          ? ((f.geometry as unknown as { coordinates: [number, number] }).coordinates as [number, number])
          : [e.lngLat.lng, e.lngLat.lat];
        this.activePopup?.remove();
        const popupLayerKey =
          layerId === 'vec-vessels-points' ? 'vessels' :
          layerId === 'vec-lightning' ? 'lightning' :
          layerId === 'vec-alerts' ? 'alerts' :
          layerId === 'vec-metar' ? 'metar' :
          layerId === 'vec-hubeau' ? 'hubeau' :
          layerId === 'vec-piezo' ? 'piezo' :
          layerId === 'vec-quakes' ? 'quakes' :
          layerId === 'vec-firms' ? 'firms' :
          layerId === 'vec-buoys' ? 'buoys' :
          layerId === 'vec-sigmet-fill' ? 'sigmet' :
          layerId === 'vec-taf' ? 'taf' :
          layerId === 'vec-cables' ? 'cables' :
          layerId === 'vec-fir-line' ? 'fir' :
          (layerId === 'vec-airports-dot' || layerId === 'vec-airports-points') ? 'airports' : 'other';
        this.activePopup = new maplibregl.Popup({ closeButton: true, maxWidth: '280px', offset: 12 })
          .setLngLat(coords)
          .setHTML(html)
          .addTo(map);
        this.activePopupLayerKey = popupLayerKey;
        this.activePopup.on('close', () => { if (this.activePopupLayerKey === popupLayerKey) this.activePopupLayerKey = undefined; });
      }
    });

    // Cursor pointer sur hover (UX feedback que c'est cliquable)
    const setCursor = (cursor: string) => () => {
      map.getCanvas().style.cursor = cursor;
    };
    for (const layerId of [
      'vec-vessels-clusters', 'vec-vessels-points',
      'vec-lightning', 'vec-alerts',
      'vec-metar', 'vec-hubeau', 'vec-piezo',
      'vec-quakes', 'vec-firms', 'vec-buoys',
      'vec-tracks',
      // G66e (2026-05-27) — cursor pointer sur SIGMET/TAF/Cables hover
      'vec-sigmet-fill', 'vec-taf', 'vec-cables',
      // G66f (2026-05-27) — FIR/UIR
      'vec-fir-line',
      // G66l (2026-05-27) — airports
      'vec-airports-clusters', 'vec-airports-dot', 'vec-airports-points',
    ]) {
      map.on('mouseenter', layerId, setCursor('pointer'));
      map.on('mouseleave', layerId, setCursor(''));
    }

    this.map = map;
    // 2026-05-22 — code review SEC-2 : window.globeMap leakait l'instance
    // MapLibre en global, accessible par tout script tiers. Supprimé après
    // que le debug popup soit résolu (G6 maplibre-gl.css fix).
  }

  private _startFpsLoop(): void {
    const tick = () => {
      this.frameCount++;
      const now = performance.now();
      if (now - this.lastFpsTime >= 500) {
        const f = Math.round((this.frameCount * 1000) / (now - this.lastFpsTime));
        this.fps.set(String(f));
        this.frameCount = 0;
        this.lastFpsTime = now;
      }
      this.rafHandle = requestAnimationFrame(tick);
    };
    this.rafHandle = requestAnimationFrame(tick);
  }
}
