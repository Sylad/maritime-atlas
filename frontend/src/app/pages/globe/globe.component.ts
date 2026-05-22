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
  kind: 'gibs-daily' | 'cascade-realtime';
  attribution: string;
};
const SAT_PRODUCTS: SatProduct[] = [
  { key: 'satTrueColor',      label: 'Vrai couleur MODIS',         gsName: 'sat-modis-true-color',  kind: 'gibs-daily',       attribution: 'NASA GIBS MODIS Terra' },
  { key: 'satTrueColorVIIRS', label: 'Vrai couleur VIIRS',         gsName: 'sat-viirs-true-color',  kind: 'gibs-daily',       attribution: 'NASA GIBS VIIRS SNPP' },
  { key: 'satIR',             label: 'Infrarouge thermique',       gsName: 'sat-modis-ir',          kind: 'gibs-daily',       attribution: 'NASA GIBS MODIS Band 31' },
  { key: 'satWaterVapor',     label: 'Température air',            gsName: 'sat-airs-air-temp',     kind: 'gibs-daily',       attribution: 'NASA GIBS AIRS' },
  { key: 'satCloudTop',       label: 'Sommet des nuages',          gsName: 'sat-modis-cloud-top',   kind: 'gibs-daily',       attribution: 'NASA GIBS MODIS' },
  { key: 'satAerosol',        label: 'Aérosols / poussières',      gsName: 'sat-modis-aerosol',     kind: 'gibs-daily',       attribution: 'NASA GIBS MODIS AOD' },
  { key: 'satDayNight',       label: 'VIIRS jour/nuit',            gsName: 'sat-viirs-day-night',   kind: 'gibs-daily',       attribution: 'NASA GIBS VIIRS DayNight' },
  { key: 'satEuIrRss',        label: 'EUMETSAT IR Europe (5 min)', gsName: 'sat-eu-ir-rss',         kind: 'cascade-realtime', attribution: 'EUMETSAT MSG SEVIRI Rapid Scan' },
  { key: 'satGlobalIrMtg',    label: 'EUMETSAT MTG IR global',     gsName: 'sat-global-ir-mtg',     kind: 'cascade-realtime', attribution: 'EUMETSAT MTG FCI' },
  { key: 'satEuHrvRgb',       label: 'EUMETSAT HRV RGB Europe',    gsName: 'sat-eu-hrv-rgb',        kind: 'cascade-realtime', attribution: 'EUMETSAT MSG SEVIRI HRV' },
  { key: 'radarDwd',          label: 'Radar Allemagne (DWD)',      gsName: 'radar-dwd-de',          kind: 'cascade-realtime', attribution: 'DWD Open Data Radar' },
  { key: 'radarKnmi',         label: 'Radar Pays-Bas (KNMI)',      gsName: 'radar-knmi-nl',         kind: 'cascade-realtime', attribution: 'KNMI Open Geo Radar' },
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
    <div class="globe-root">
      <header class="globe-header">
        <div class="brand">
          <span class="brand-icon">🌍</span>
          <span class="brand-title">AetherWX</span>
          <span class="brand-mode">— Globe 3D <span class="brand-mode-pill">spike</span></span>
        </div>
        <nav class="nav-links">
          <a routerLink="/legacy-map" class="nav-link">Carte 2D (legacy)</a>
          <span class="nav-sep">·</span>
          <a routerLink="/about" class="nav-link">À propos</a>
          <!-- G18 M15 (audit G-7) — auth corner parité /legacy-map -->
          <span class="nav-sep">·</span>
          @if (currentUser(); as u) {
            <a routerLink="/palettes" class="nav-link">{{ '@' + u.username }}</a>
            @if (u.role === 'admin') {
              <span class="nav-sep">·</span>
              <a routerLink="/admin/users" class="nav-link nav-admin-pill" title="Espace admin">ADMIN</a>
            }
            <span class="nav-sep">·</span>
            <button type="button" class="nav-btn" (click)="logout()">Déconnexion</button>
          } @else {
            <a routerLink="/auth/login" class="nav-link">Connexion</a>
            <span class="nav-sep">·</span>
            <a routerLink="/auth/register" class="nav-link">Inscription</a>
          }
        </nav>
      </header>

      <div #mapContainer class="map-container"></div>

      <!-- G19 (2026-05-22) — Bouton hamburger pour ré-ouvrir le panneau quand
           collapsed. En mode mobile, il prend le relais du logo. -->
      @if (!legendOpen()) {
        <button type="button" class="legend-toggle is-collapsed"
                (click)="toggleLegend()"
                [attr.aria-expanded]="legendOpen()"
                aria-label="Afficher le panneau">
          <span aria-hidden="true">☰</span>
        </button>
      }

      <!-- G19 (2026-05-22) — Template panneau gauche porté à l'identique de
           /legacy-map (template + CSS) pour parité visuelle 100%. Bindings
           adaptés au modèle globe (showSst au lieu de showSST, etc.). -->
      <div class="legend data-catalog" [class.legend--closed]="!legendOpen()">
        <!-- 2026-05-18 APEX 11 — click sur le logo collapse le panneau gauche.
             En mode collapsed, le bouton .legend-toggle prend le relais (☰). -->
        <button type="button" class="catalog-header"
                role="img"
                aria-label="AetherWX — see the atmosphere (cliquer pour réduire le panneau)"
                title="Réduire le panneau"
                (click)="toggleLegend()"></button>
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
              <div class="layer-row layer-soon">
                <label class="layer-toggle dim">
                  <input type="checkbox" disabled />
                  <span class="toggle-glyph"><span class="glyph-icon">⚠</span></span>
                  <span class="toggle-text">
                    <span class="toggle-name">SIGMET / AIRMET <span class="soon-tag">à venir</span></span>
                    <span class="toggle-count">avertissements aéro</span>
                  </span>
                </label>
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
                  <input type="checkbox" [checked]="showSatRainviewer()" (change)="toggleSatLayer('satRainviewer', !showSatRainviewer())" />
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
              <!-- Placeholders V2 — paramètres météo classiques -->
              <div class="layer-row layer-soon">
                <label class="layer-toggle dim">
                  <input type="checkbox" disabled />
                  <span class="toggle-glyph"><span class="glyph-icon">🌡</span></span>
                  <span class="toggle-text">
                    <span class="toggle-name">Température 2m <span class="soon-tag">à venir</span></span>
                    <span class="toggle-count">GFS / ARPEGE</span>
                  </span>
                </label>
              </div>
              <div class="layer-row layer-soon">
                <label class="layer-toggle dim">
                  <input type="checkbox" disabled />
                  <span class="toggle-glyph"><span class="glyph-icon">⊙</span></span>
                  <span class="toggle-text">
                    <span class="toggle-name">Pression MSL <span class="soon-tag">à venir</span></span>
                    <span class="toggle-count">isobares + dépressions</span>
                  </span>
                </label>
              </div>
              <div class="layer-row layer-soon">
                <label class="layer-toggle dim">
                  <input type="checkbox" disabled />
                  <span class="toggle-glyph"><span class="glyph-icon">💧</span></span>
                  <span class="toggle-text">
                    <span class="toggle-name">Humidité <span class="soon-tag">à venir</span></span>
                    <span class="toggle-count">relative 2m</span>
                  </span>
                </label>
              </div>
              <div class="layer-row layer-soon">
                <label class="layer-toggle dim">
                  <input type="checkbox" disabled />
                  <span class="toggle-glyph"><span class="glyph-icon">🌧</span></span>
                  <span class="toggle-text">
                    <span class="toggle-name">Précipitations <span class="soon-tag">à venir</span></span>
                    <span class="toggle-count">forecast cumul 6h</span>
                  </span>
                </label>
              </div>
              <div class="layer-row layer-soon">
                <label class="layer-toggle dim">
                  <input type="checkbox" disabled />
                  <span class="toggle-glyph"><span class="glyph-icon">✈</span></span>
                  <span class="toggle-text">
                    <span class="toggle-name">TAF <span class="soon-tag">à venir</span></span>
                    <span class="toggle-count">prévisions aéroports</span>
                  </span>
                </label>
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
              <div class="layer-row layer-soon">
                <label class="layer-toggle dim">
                  <input type="checkbox" disabled />
                  <span class="toggle-glyph"><span class="glyph-icon">⚠</span></span>
                  <span class="toggle-text">
                    <span class="toggle-name">Prévisions crues <span class="soon-tag">accès limité</span></span>
                    <span class="toggle-count">EFAS Copernicus (compte EMS requis)</span>
                  </span>
                </label>
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
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!showEfas()">
                  <input type="checkbox" [checked]="showEfas()" (change)="toggleEfas(!showEfas())" />
                  <span class="toggle-glyph"><span class="glyph-icon">🌊</span></span>
                  <span class="toggle-text">
                    <span class="toggle-name">EFAS forecast crues</span>
                    <span class="toggle-count">Copernicus EMS</span>
                  </span>
                </label>
                @if (showEfas()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getLayerOpacity('efas')"
                         (input)="setLayerOpacity('efas', +$any($event.target).value)" />
                }
              </div>
              <div class="layer-row layer-soon">
                <label class="layer-toggle dim">
                  <input type="checkbox" disabled />
                  <span class="toggle-glyph"><span class="glyph-icon">━</span></span>
                  <span class="toggle-text">
                    <span class="toggle-name">Câbles sous-marins <span class="soon-tag">à venir</span></span>
                    <span class="toggle-count">TeleGeography</span>
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
          (launch)="onAnimationLaunch($event)"
          (cancel)="closeAnimationPanel()" />
      }
      <!-- G21 — controls floattants (play/pause/stop/speed) au-dessus du slider.
           Visibilité gérée en interne par le composant via animPlayer.state(). -->
      <app-animation-controls />
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
      padding: 8px 14px;
      background: rgba(10, 14, 26, 0.78);
      border-bottom: 1px solid #1c2333;
      backdrop-filter: blur(6px);
    }
    .brand { display: flex; align-items: baseline; gap: 8px; font-size: 14px; }
    .brand-icon { font-size: 18px; }
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
    .nav-links { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .nav-link {
      color: #c9d6e8;
      text-decoration: none;
      font-size: 13px;
      padding: 4px 10px;
      border: 1px solid #2a3245;
      border-radius: 6px;
      background: rgba(20, 24, 38, 0.6);
      transition: background .15s;
    }
    .nav-link:hover { background: #2a3448; }
    /* G18 M15 — auth corner (parité /legacy-map) */
    .nav-sep { color: #4a5566; font-size: 11px; }
    .nav-btn {
      background: rgba(80, 30, 30, 0.5);
      color: #fecaca;
      border: 1px solid #6b3a3a;
      padding: 4px 10px;
      border-radius: 6px;
      font-size: 12px;
      cursor: pointer;
    }
    .nav-btn:hover { background: rgba(120, 40, 40, 0.7); color: #fff; }
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
      top: 1em;
      left: 1em;
      background: rgb(15, 23, 42);
      border: 1px solid hsl(224 85% 55% / 0.5);
      border-radius: 8px;
      padding: 1em 1.2em;
      z-index: 10;
      min-width: 200px;
      width: 320px;
      max-height: calc(100vh - 2em);
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
      top: 1em;
      left: 1em;
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

    /* G22 (2026-05-22) — Hero logo header réduit : utilise le logo "tap"
       déjà cropé (wordmark AETHERWX). User feedback : "logo ridiculement
       grand, utiliser juste la partie supérieure". */
    .data-catalog .catalog-header {
      display: block;
      width: calc(100% + 2.4em);
      padding: 0;
      border: 0;
      cursor: pointer;
      background-color: transparent;
      background-image: url(/AetherWX_logo_tap.png);
      background-size: contain;
      background-position: center;
      background-repeat: no-repeat;
      height: 56px;
      margin: -0.6em -1.2em 0.8em -1.2em;
      border-bottom: 1px solid var(--border);
      border-radius: 8px 8px 0 0;
      transition: filter 150ms;
      &:hover, &:focus-visible {
        filter: brightness(1.1);
        outline: none;
      }
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
    /* G22 — Attribution : fond dark + couleurs cohérentes */
    ::ng-deep .maplibregl-ctrl-attrib {
      background: rgba(20, 24, 38, 0.85) !important;
      color: #8a96a8 !important;
      border: 1px solid #2a3245 !important;
      border-radius: 6px 0 0 0 !important;
      font-family: ui-monospace, monospace;
      font-size: 10px;
      padding: 3px 8px !important;
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

    /* G18 M5 — alerts feed panel (parité /legacy-map). Position top-right
       sous le FPS, scroll si > 10 items, severity-aware borders. */
    .alerts-panel {
      position: absolute;
      top: 100px;
      right: 14px;
      z-index: 10;
      width: 260px;
      max-height: 50vh;
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
  `,
})
export class GlobeComponent implements AfterViewInit, OnDestroy {
  private readonly arrows = inject(ArrowsService);
  private readonly alertsService = inject(AlertsService);
  private readonly lightningService = inject(LightningService);
  private readonly vesselsService = inject(VesselsService);
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
      void this.showEfas();
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
      void this.showBathy(); void this.showEez(); void this.showMpa(); void this.showEfas();
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
  /** G11b (2026-05-22) — 4 layers statiques sources sciencé (EMODnet/Marine
   *  Regions/EFAS) via proxy nginx maritime. */
  readonly showBathy = signal(false);
  readonly showEez = signal(false);
  readonly showMpa = signal(false);
  readonly showEfas = signal(false);
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
    if (this.showBathy() || this.showEez() || this.showMpa() || this.showEfas()) n++;
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
    // Sat keys : préfixe 'aetherwx:' + gsName du catalogue
    if (key.startsWith('sat')) {
      const product = SAT_PRODUCTS.find((p) => p.key === key);
      return product ? `aetherwx:${product.gsName}` : null;
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
    if (this.showEfas())  this.toggleEfas(false);
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
        const flags = [this.showHubeau(), this.showPiezo()];
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
    ...SAT_PRODUCTS.map((p) => ({ key: p.key, label: p.label, type: 'wms' as const, gsLayerName: `aetherwx:${p.gsName}` })),
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
    const masterKey = this.effectiveMasterLayerKey();
    const master = masterKey ? this.animatableLayersGlobe.find((l) => l.key === masterKey) : undefined;
    const { start, end } = this.computeAnimationWindow(opts);
    let timestamps: Date[] = [];
    if (master) {
      try { timestamps = await this.fetchTimestamps(master, start, end); } catch { /* fallback step 1h */ }
    }
    this.animPlayer.start({ ...opts, timestamps, masterLayerLabel: master?.label ?? undefined });
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
    try {
      const url = '/geoserver/aetherwx/wms?service=WMS&version=1.3.0&request=GetCapabilities';
      const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!resp.ok) throw new Error(`GetCapabilities HTTP ${resp.status}`);
      const xml = await resp.text();
      return this.parseTimeDimension(xml, master.gsLayerName)
        .filter((t) => t.getTime() >= start.getTime() && t.getTime() <= end.getTime());
    } catch (err) {
      console.warn('[globe-anim] GetCapabilities échec :', err);
      return [];
    }
  }

  private parseTimeDimension(xml: string, layerName: string): Date[] {
    const shortName = layerName.replace(/^aetherwx:/, '');
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
    bathy: 0.7, eez: 0.6, mpa: 0.6, efas: 0.7,
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
    sst: 1, windForecast: 1, wavesForecast: 1, efas: 1,
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
      k === 'windForecast' || k === 'wavesForecast' || k === 'windArrows' || k === 'waveArrows';
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
    push(this.showVessels(),   'vessels',   'vessels',   '#06b6d4', 24, 0);
    push(this.showMetar(),     'metar',     'metar',     '#fbbf24', 6, 0);
    push(this.showHubeau(),    'hubeau',    'hubeau',    '#06b6d4', 24, 0);
    push(this.showPiezo(),     'piezo',     'piezo',     '#8b5cf6', 24, 0);
    push(this.showQuakes(),    'quakes',    'quakes',    '#ef4444', 24, 0);
    push(this.showFirms(),     'firms',     'firms',     '#f97316', 24, 0);
    push(this.showBuoys(),     'buoys',     'buoys',     '#10b981', 24, 0);
    push(this.showTracks(),    'tracks',    'tracks',    '#22c55e', 24, 0);
    push(this.showRain(),      'rain',      'rain',      '#22d3ee', 2, 0);
    push(this.showWindForecast(),  'windForecast',  'wind',         '#22c55e', 0, 168);
    push(this.showWavesForecast(), 'wavesForecast', 'waves',        '#3b82f6', 0, 168);
    push(this.showWindArrows(),    'windArrows',    'wind-arrows',  '#22c55e', 0, 168);
    push(this.showWaveArrows(),    'waveArrows',    'wave-arrows',  '#3b82f6', 0, 168);
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
    }
    // G16 fallback : 1er sat actif (ordre déclaratif SAT_PRODUCTS) sinon sst > forecast.
    for (const [key, sig] of Object.entries(this.satShowSignals())) {
      if (sig()) return key;
    }
    if (this.showSst()) return 'sst';
    if (this.showWindForecast()) return 'windForecast';
    if (this.showWavesForecast()) return 'wavesForecast';
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

  /** G11d — handler slider opacité. Update signal + applique au layer
   *  MapLibre via setPaintProperty (raster-opacity ou line-opacity selon type).
   *  Persiste localStorage. */
  setLayerOpacity(key: string, value: number): void {
    const v = Math.max(0, Math.min(1, value));
    this.layerOpacities.update((o) => ({ ...o, [key]: v }));
    const map = this.map;
    if (!map) return;
    for (const id of this.mapLibreLayerIds(key)) {
      if (!map.getLayer(id)) continue;
      // Détecte le type pour choisir la bonne paint-property.
      const layerType = map.getLayer(id)!.type;
      if (layerType === 'raster') {
        map.setPaintProperty(id, 'raster-opacity', v);
      } else if (layerType === 'line') {
        map.setPaintProperty(id, 'line-opacity', v);
      } else if (layerType === 'circle') {
        map.setPaintProperty(id, 'circle-opacity', v);
      } else if (layerType === 'symbol') {
        map.setPaintProperty(id, 'text-opacity', v);
      }
    }
    this.persistLayerOpacities();
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
   *  eez, mpa, efas) → sync transparent /map ↔ /globe.
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
    add('efas',      this.showEfas());
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
        showEfas: this.showEfas(),
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
        showBathy: !!data?.showBathy, showEez: !!data?.showEez, showMpa: !!data?.showMpa, showEfas: !!data?.showEfas,
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
    if (p['showEfas'])  this.toggleEfas(true);
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
    if (this.showEfas())  keys.push('efas');
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
    if (key === 'efas')   return 'EFAS';
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
    if (this.showEfas()) active.push('efas');
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
    if (key === 'windArrows') return ['wind-arrows-wms'];
    if (key === 'waveArrows') return ['wave-arrows-wms'];
    if (key === 'bathy') return ['bathy-wms'];
    if (key === 'eez') return ['eez-wms'];
    if (key === 'mpa') return ['mpa-wms'];
    if (key === 'efas') return ['efas-wms'];
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
      return this.generateClientValidities(stepMs, 168, 0, now);
    }
    if (master === 'sst') {
      return this.generateClientValidities(24 * 3_600_000, 168, 0, now);
    }
    if (master === 'windForecast' || master === 'wavesForecast' ||
        master === 'windArrows'   || master === 'waveArrows') {
      return this.generateClientValidities(6 * 3_600_000, 0, 168, now);
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
    const iso = t.toISOString().split('.')[0] + 'Z';
    const forecastLayers: Array<{ active: boolean; layerId: string; gsName: string; style?: string; interpolations?: string }> = [
      { active: this.showWindForecast(),  layerId: 'wind-forecast-wms',  gsName: 'aetherwx:wind-speed' },
      { active: this.showWavesForecast(), layerId: 'waves-forecast-wms', gsName: 'aetherwx:wave-hs' },
      { active: this.showWindArrows(),    layerId: 'wind-arrows-wms',    gsName: 'aetherwx:wind-speed', style: 'aetherwx:wind-arrows' },
      { active: this.showWaveArrows(),    layerId: 'wave-arrows-wms',    gsName: 'aetherwx:wave-dir',   style: 'aetherwx:wave-arrows' },
      { active: this.showWindContours(),  layerId: 'wind-contours-wms',  gsName: 'aetherwx:wind-speed', style: 'aetherwx:wind-speed-contours-only', interpolations: 'bicubic' },
      { active: this.showWaveContours(),  layerId: 'wave-contours-wms',  gsName: 'aetherwx:wave-hs',    style: 'aetherwx:wave-hs-contours-only',    interpolations: 'bicubic' },
    ];
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
      if (product.kind === 'gibs-daily') {
        // Snap au jour J-2 max depuis t (le cursor peut être maintenant
        // mais GIBS n'a souvent pas ingéré encore les ~48h les plus récentes).
        const cap = Math.min(t.getTime(), Date.now() - 48 * 3_600_000);
        const effDate = new Date(cap);
        timeParam = `${effDate.getUTCFullYear()}-${String(effDate.getUTCMonth() + 1).padStart(2, '0')}-${String(effDate.getUTCDate()).padStart(2, '0')}`;
      } else {
        timeParam = t.toISOString().split('.')[0] + 'Z';
      }
      const url = this.buildWmsTileUrl(`aetherwx:${product.gsName}`, timeParam);
      (src as maplibregl.RasterTileSource).setTiles([url]);
    }
  }

  private buildWmsTileUrl(layerName: string, time: string, opts?: { interpolations?: string }): string {
    return '/geoserver/aetherwx/wms' +
      '?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap' +
      `&LAYERS=${encodeURIComponent(layerName)}&STYLES=&FORMAT=image/png&TRANSPARENT=true` +
      `&TIME=${encodeURIComponent(time)}` +
      (opts?.interpolations ? `&INTERPOLATIONS=${opts.interpolations}` : '') +
      '&SRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256';
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
        this.refreshWmsTimeForActiveLayers();
      });
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
        map.addSource(sourceId, {
          type: 'raster',
          tiles: [
            '/geoserver/aetherwx/wms' +
              '?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap' +
              '&LAYERS=aetherwx:sst-daily&STYLES=&FORMAT=image/png&TRANSPARENT=true' +
              // 2026-05-21 — INTERPOLATIONS=bicubic param GS vendor pour
              // interpolation raster côté serveur (anti-pixellisation). Match
              // ce que la /map prod fait. Cf [[geoserver_wms_interpolations_param]].
              '&INTERPOLATIONS=bicubic' +
              '&SRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256',
          ],
          tileSize: 256,
        });
      }
      if (!map.getLayer(layerId)) {
        // Insert SST under wind particles for proper z-ordering.
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

  async toggleVector(kind: 'lightning' | 'alerts' | 'vessels' | 'metar' | 'hubeau' | 'piezo' | 'quakes' | 'firms' | 'buoys') {
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
      const useCluster = kind === 'vessels';
      map.addSource(sourceId, {
        type: 'geojson',
        data: fc as any,
        cluster: useCluster,
        clusterRadius: 40,
        clusterMaxZoom: 12,
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
    key: 'windForecast' | 'wavesForecast' | 'windArrows' | 'waveArrows';
    layerId: string;
    gsName: string;
    style?: string;
    opacity: number;
    on: boolean;
  }): void {
    const sigMap = {
      windForecast: this.showWindForecast,
      wavesForecast: this.showWavesForecast,
      windArrows: this.showWindArrows,
      waveArrows: this.showWaveArrows,
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

  /** G11b — toggle générique pour les 4 layers WMS sources statiques
   *  (bathy/eez/mpa/efas). Pas de TIME param, juste un proxy nginx
   *  configuré côté ingress maritime. */
  private toggleStaticWmsLayer(opts: {
    key: 'bathy' | 'eez' | 'mpa' | 'efas';
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
      efas: this.showEfas,
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
  toggleEfas(on: boolean): void {
    this.toggleStaticWmsLayer({
      key: 'efas', layerId: 'efas-wms', proxyUrl: '/wms-efas',
      wmsLayer: 'efas_forecast_flood_probability', opacity: 0.7,
      attribution: '© EFAS Copernicus', on,
    });
  }

  toggleWindForecast(on: boolean): void {
    this.toggleForecastLayer({ key: 'windForecast', layerId: 'wind-forecast-wms', gsName: 'aetherwx:wind-speed', opacity: 0.7, on });
  }
  toggleWavesForecast(on: boolean): void {
    this.toggleForecastLayer({ key: 'wavesForecast', layerId: 'waves-forecast-wms', gsName: 'aetherwx:wave-hs', opacity: 0.7, on });
  }
  toggleWindArrows(on: boolean): void {
    this.toggleForecastLayer({ key: 'windArrows', layerId: 'wind-arrows-wms', gsName: 'aetherwx:wind-speed', style: 'aetherwx:wind-arrows', opacity: 0.9, on });
  }
  toggleWaveArrows(on: boolean): void {
    this.toggleForecastLayer({ key: 'waveArrows', layerId: 'wave-arrows-wms', gsName: 'aetherwx:wave-dir', style: 'aetherwx:wave-arrows', opacity: 0.9, on });
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

  private async _fetchVectorFc(kind: 'lightning' | 'alerts' | 'vessels' | 'metar' | 'hubeau' | 'piezo' | 'quakes' | 'firms' | 'buoys'): Promise<{ features: any[] }> {
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
    // G8 — fetch REST direct pour 6 layers vector. Mapping endpoint :
    //  - piezo  → /api/hubeau/piezo/recent (path nested sous hubeau)
    //  - quakes → /api/earthquakes/recent  (controller earthquakes.controller)
    //  - buoys  → WFS (BuoysService), pas /recent — TODO endpoint /api/buoys
    //  - autres → /api/<kind>/recent
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

    const timeParam =
      product.kind === 'gibs-daily'
        ? gibsDailyDate()
        : new Date(Date.now() - 5 * 60_000).toISOString().split('.')[0] + 'Z';

    const url =
      '/geoserver/aetherwx/wms' +
      '?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap' +
      `&LAYERS=aetherwx:${product.gsName}` +
      `&TIME=${encodeURIComponent(timeParam)}` +
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
      style: {
        version: 8,
        // Glyphs URL nécessaire pour les symbol text layers (count cluster
        // vessels). Source publique OpenMapTiles fonts. Sans ça, ajouter
        // une layer type=symbol crash MapLibre.
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
            attribution: '© OpenStreetMap contributors, © CARTO',
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
      ];
      const existing = allLayers.filter((id) => map.getLayer(id));
      if (existing.length === 0) return;

      const features = map.queryRenderedFeatures(e.point, { layers: existing });
      if (features.length === 0) return;  // closeOnClick MapLibre default = ferme
      const f = features[0];
      const layerId = f.layer.id;
      const p = (f.properties ?? {}) as Record<string, unknown>;

      // Cluster vessel → zoom-in (pas de popup)
      if (layerId === 'vec-vessels-clusters') {
        const clusterId = p['cluster_id'];
        const src = map.getSource(f.source) as maplibregl.GeoJSONSource & {
          getClusterExpansionZoom?: (id: number) => Promise<number>;
        };
        if (typeof clusterId === 'number' && src.getClusterExpansionZoom) {
          src.getClusterExpansionZoom(clusterId).then((zoom: number) => {
            const coords = (f.geometry as GeoJSON.Point).coordinates as [number, number];
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
        const coords = (f.geometry as GeoJSON.Point).coordinates as [number, number];
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
          layerId === 'vec-buoys' ? 'buoys' : 'other';
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
