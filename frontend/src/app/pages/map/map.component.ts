import { DatePipe, DecimalPipe } from '@angular/common';
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
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { interval, startWith, Subscription, switchMap } from 'rxjs';

import Map from 'ol/Map';
import View from 'ol/View';
import TileLayer from 'ol/layer/Tile';
import ImageLayer from 'ol/layer/Image';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import Cluster from 'ol/source/Cluster';
import XYZ from 'ol/source/XYZ';
import TileWMS from 'ol/source/TileWMS';
import ImageWMS from 'ol/source/ImageWMS';
import GeoJSON from 'ol/format/GeoJSON';
import Overlay from 'ol/Overlay';
import { fromLonLat } from 'ol/proj';
import { Style, Circle as CircleStyle, Fill, Stroke, Icon, Text as TextStyle } from 'ol/style';
import { defaults as defaultControls, ScaleLine, MousePosition, Zoom } from 'ol/control';
import { toStringHDMS } from 'ol/coordinate';
import type { Feature } from 'ol';
import type { FeatureLike } from 'ol/Feature';
import type { Geometry, Point } from 'ol/geom';

import { Router, RouterLink } from '@angular/router';
import type { LayerKind, Palette } from '../../services/palettes.service';
import { TimeSliderComponent, TimeSliderLayerCoverage } from '../../components/time-slider/time-slider.component';
import { IngestionMiniChartComponent } from '../../components/ingestion-mini-chart/ingestion-mini-chart.component';
import { AnimationPanelComponent } from '../../components/animation-panel/animation-panel.component';
import { AnimationControlsComponent } from '../../components/animation-controls/animation-controls.component';
import { AnimationPlayerService, AnimationOptions } from '../../services/animation-player.service';
import { VesselsService, type VesselProperties } from '../../services/vessels.service';
import { RainviewerService, type RainViewerSnapshot } from '../../services/rainviewer.service';
import { AuthService } from '../../services/auth.service';
import { PreferencesSyncService } from '../../services/preferences-sync.service';
import { findZone, DEFAULT_ZONE_ID } from '../../services/map-zones';
import { registerCustomProjections, findProjection, DEFAULT_PROJECTION } from '../../services/map-projections';
import { PalettesService } from '../../services/palettes.service';
import { ArrowsService, type ArrowsKind } from '../../services/arrows.service';
import { LightningService, type LightningProperties } from '../../services/lightning.service';
import { AlertsService, type AlertProperties, type AlertSeverity } from '../../services/alerts.service';
import { BuoysService, type BuoyProperties, type BuoyObservationProperties } from '../../services/buoys.service';
import { WindParticleEngine, speedDirToUv, type WindPoint as WindParticlePoint } from '../../components/wind-particles/wind-particles';

/** V2 Observation #1 (2026-05-12) — METAR feature properties. Mirrore
 *  l'output de l'endpoint GET /api/metar/recent. */
interface MetarProperties {
  icao: string;
  station_name: string | null;
  ts: string;
  age_seconds: number;
  temp_c: number | null;
  dewp_c: number | null;
  wind_dir_deg: number | null;
  wind_speed_kt: number | null;
  wind_gust_kt: number | null;
  altimeter_hpa: number | null;
  weather_str: string | null;
  raw: string | null;
}

/** V2 Hydrologie #1 (2026-05-12) — Hub'eau Eaufrance feature properties.
 *  Mirrore l'output de l'endpoint GET /api/hubeau/recent. */
interface HubeauProperties {
  code_station: string;
  ts: string;
  age_seconds: number;
  debit_l_s: number | null;
  debit_m3_s: number | null;
  qualif: string | null;
}

/** V2 Observation #3 (2026-05-12) — FIRMS NASA hotspots feature properties.
 *  Mirrore l'output de GET /api/firms/recent. */
interface FirmsProperties {
  ts: string;
  age_seconds: number;
  brightness: number | null;   // K
  bright_t31: number | null;
  frp: number | null;          // Fire Radiative Power MW
  confidence: number | null;   // 0-100
  satellite: string | null;
  daynight: string | null;
}

/** V2 Hydrologie #2 (2026-05-12) — Hub'eau piézomètres feature properties.
 *  Mirrore l'output de GET /api/hubeau/piezo/recent. */
interface PiezoProperties {
  code_bss: string;
  ts: string;
  age_seconds: number;
  niveau_eau_ngf: number | null;     // m NGF
  profondeur_nappe: number | null;   // m sous sol
  altitude_station: number | null;
}

/** V2 Observation #2 (2026-05-12) — USGS Earthquakes feature properties.
 *  Mirrore le feed USGS natif (GeoJSON). On garde les props upstream. */
interface QuakeProperties {
  mag: number | null;
  place: string | null;
  time: number;        // epoch ms
  updated: number;
  tsunami: number;     // 0|1
  alert: string | null; // 'green'|'yellow'|'orange'|'red'
  url: string;
  sig: number;          // significance score 0-1000
  type: string;         // earthquake / explosion / ...
  // Geometry inclut depth (3rd dim) — on l'extrait au render.
}

// Europe étroite (sprint Europe 2026-05-12) — centré ~Allemagne, zoom 4
// pour couvrir d'Açores à Pologne / Méditerranée à Cap Nord en une vue.
const INITIAL_CENTER: [number, number] = [10.0, 50.0];
const INITIAL_ZOOM = 4;
const REFRESH_INTERVAL_MS = 30_000;
const LIVE_THRESHOLD_MS = 5 * 60_000; // ±5min = considéré live
/** localStorage key pour les prefs layers (visibility + opacity). Phase A
    fonctionne en localStorage only ; Phase C synchronise avec backend
    pour les users connectés. */
const LAYER_PREFS_KEY = 'maritime.layer-prefs-v1';

// Couleurs par catégorie ship_type (cf v_vessels_live_categorized).
type Category = 'fishing-leisure' | 'passenger' | 'cargo' | 'tanker' | 'other';

const CATEGORY_COLOR: Record<Category, { fill: string; stroke: string; label: string }> = {
  'fishing-leisure': { fill: '#fbbf24', stroke: '#fde68a', label: 'Pêche / loisir' },
  passenger:        { fill: '#34d399', stroke: '#6ee7b7', label: 'Passagers' },
  cargo:            { fill: '#60a5fa', stroke: '#93c5fd', label: 'Cargo' },
  tanker:           { fill: '#f87171', stroke: '#fca5a5', label: 'Tanker' },
  other:            { fill: '#9ca3af', stroke: '#d1d5db', label: 'Autres' },
};

function categoryOf(shipType: number | null): Category {
  if (shipType == null) return 'other';
  if (shipType >= 30 && shipType <= 37) return 'fishing-leisure';
  if (shipType >= 60 && shipType <= 69) return 'passenger';
  if (shipType >= 70 && shipType <= 79) return 'cargo';
  if (shipType >= 80 && shipType <= 89) return 'tanker';
  return 'other';
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function toIsoTimestamp(d: Date): string {
  return d.toISOString();
}

@Component({
  selector: 'app-map',
  imports: [DatePipe, DecimalPipe, TimeSliderComponent, IngestionMiniChartComponent, RouterLink, AnimationPanelComponent, AnimationControlsComponent],
  template: `
    <div class="map-container">
      <div class="map" #mapEl></div>
      <!-- Sprint 8 : canvas overlay pour les particules de vent. Positionné
           absolute au-dessus de la carte (z-index entre labels et vessels). -->
      <canvas #particlesEl class="wind-particles-canvas" [class.active]="showWindParticles()"></canvas>

      <div class="auth-corner">
        <a routerLink="/about" class="auth-link" title="À propos du projet">À propos</a>
        <span class="auth-sep">·</span>
        @if (currentUser(); as u) {
          <a routerLink="/palettes" class="auth-link">{{ '@' + u.username }}</a>
          @if (u.role === 'admin') {
            <span class="auth-sep">·</span>
            <a routerLink="/admin/users" class="auth-link auth-admin-pill" title="Espace admin">ADMIN</a>
          }
          <span class="auth-sep">·</span>
          <button type="button" class="auth-btn" (click)="logout()">Déconnexion</button>
        } @else {
          <a routerLink="/auth/login" class="auth-link">Connexion</a>
          <span class="auth-sep">·</span>
          <a routerLink="/auth/register" class="auth-link">Inscription</a>
        }
      </div>

      <!-- Dock controls TOP-RIGHT (sous auth-corner) : zoom +/- + recentrer.
           OL injecte .ol-zoom dans ce div via le target option.
           Phase C.3 bonus : bouton ⊙ pour revenir à la zone par défaut
           (utile après un gros pan/zoom-out, plus rapide qu'un refresh). -->
      <div class="controls-dock controls-dock-top-right" #zoomDockEl>
        <button type="button" class="recenter-btn"
                (click)="recenterDefaultZone()"
                [title]="recenterTooltip()">⊙</button>
      </div>

      <!-- Animation : panel modal config + overlay contrôles lecture.
           Le déclenchement passe par le bouton ▶︎ du time-slider, pas
           par un bouton séparé (cf onSliderPlayClicked). -->
      @if (animPanelOpen()) {
        <app-animation-panel
          [anchor]="currentTimeSig()"
          [forecastActive]="isForecastActive()"
          [masterLayerLabel]="masterLayerLabel()"
          (launch)="onAnimationLaunch($event)"
          (cancel)="closeAnimationPanel()" />
      }
      <app-animation-controls />


      <!-- Dock controls BOTTOM-RIGHT (au-dessus de la time-slider) :
           HDMS coords (top), scale 100 NM, attribution (i) bottom.
           OL inject les 2 premiers via target ; le dernier (attribution)
           reste un button Angular maison. -->
      <div class="controls-dock controls-dock-bottom-right">
        <div class="controls-dock-info" #infoDockEl></div>
        <button type="button" class="attribution-trigger"
                [class.is-open]="attrOpen()"
                (click)="toggleAttr()"
                [attr.aria-label]="attrOpen() ? 'Fermer les sources' : 'Voir les sources'"
                title="Sources de données">
          {{ attrOpen() ? '×' : 'i' }}
        </button>
        @if (attrOpen()) {
          <div class="attribution-panel">
            <div class="attribution-title">Sources</div>
            <div class="attribution-row">
              <span class="attribution-label">Fond carto</span>
              <span>©&nbsp;<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> · ©&nbsp;<a href="https://carto.com/attribution" target="_blank" rel="noopener">CARTO</a></span>
            </div>
            <div class="attribution-row">
              <span class="attribution-label">Modèles météo</span>
              <span><a href="https://nomads.ncep.noaa.gov" target="_blank" rel="noopener">NOAA NOMADS</a> · <a href="https://meteo.data.gouv.fr/datasets" target="_blank" rel="noopener">Météo-France ARPEGE</a></span>
            </div>
            <div class="attribution-row">
              <span class="attribution-label">Positions navires</span>
              <span>©&nbsp;<a href="https://aisstream.io" target="_blank" rel="noopener">aisstream.io</a></span>
            </div>
            <div class="attribution-row">
              <span class="attribution-label">Radar pluie</span>
              <span><a href="https://www.rainviewer.com" target="_blank" rel="noopener">RainViewer</a></span>
            </div>
            <div class="attribution-row">
              <span class="attribution-label">Foudre</span>
              <span><a href="https://www.blitzortung.org" target="_blank" rel="noopener">Blitzortung</a> (community)</span>
            </div>
            <div class="attribution-row">
              <span class="attribution-label">Plateformes vagues</span>
              <span><a href="https://emodnet.ec.europa.eu/en/physics" target="_blank" rel="noopener">EMODnet Physics</a> (CC-BY)</span>
            </div>
            <div class="attribution-row attribution-build">
              <span class="attribution-label">Bâti avec</span>
              <span><a href="https://claude.com/claude-code" target="_blank" rel="noopener">Claude Code</a> (Anthropic) · <a href="/about" rel="noopener">À propos</a></span>
            </div>
          </div>
        }
      </div>

      <!-- Bouton hamburger pour toggle legend sur mobile. Sur desktop
           il est caché via @media. Sur mobile le legend défaut closed. -->
      <button type="button" class="legend-toggle"
              [class.is-open]="legendOpen()"
              (click)="toggleLegend()"
              [attr.aria-expanded]="legendOpen()"
              aria-label="Toggle légende">
        @if (legendOpen()) {
          <span aria-hidden="true">×</span>
        } @else {
          <span aria-hidden="true">☰</span>
        }
      </button>

      <div class="legend data-catalog" [class.legend--closed]="!legendOpen()" (click)="onLegendClick($event)">
        @if (cap5Warning(); as msg) {
          <div class="cap5-toast" role="status">{{ msg }}</div>
        }
        <div class="catalog-header" role="img" aria-label="AetherWX — see the atmosphere"></div>


        <div class="layer-toggles">
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
                <label class="layer-toggle" [class.dim]="!vesselsActive()">
                  <input type="checkbox" [checked]="showVessels()" (change)="showVessels.set($any($event.target).checked)" />
                  <span class="toggle-glyph">
                    <span class="glyph-dot" style="background:#34d399;border-color:#6ee7b7"></span>
                    <span class="glyph-dot" style="background:#60a5fa;border-color:#93c5fd"></span>
                    <span class="glyph-dot" style="background:#f87171;border-color:#fca5a5"></span>
                  </span>
                  <span class="toggle-text">
                    <span class="toggle-name">Navires</span>
                    <span class="toggle-count">{{ vesselsCount() }} positions</span>
                  </span>
                </label>
                @if (showVessels()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getOpacity('vessels')"
                         (input)="setOpacity('vessels', +$any($event.target).value)" />
                }
              </div>
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!tracksActive()">
                  <input type="checkbox" [checked]="showTracks()" (change)="showTracks.set($any($event.target).checked)" />
                  <span class="toggle-glyph">
                    <svg viewBox="0 0 24 12" width="24" height="12" aria-hidden="true">
                      <path d="M0,8 C5,2 10,11 14,5 S22,3 24,7" fill="none" stroke="rgba(45, 212, 191, 0.7)" stroke-width="1.5" />
                    </svg>
                  </span>
                  <span class="toggle-text">
                    <span class="toggle-name">Trajets</span>
                    <span class="toggle-count">{{ tracksCount() }} agrégés/jour</span>
                  </span>
                </label>
                @if (showTracks()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getOpacity('tracks')"
                         (input)="setOpacity('tracks', +$any($event.target).value)" />
                }
              </div>
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!showAlerts()">
                  <input type="checkbox" [checked]="showAlerts()" (change)="showAlerts.set($any($event.target).checked)" />
                  <span class="toggle-glyph">
                    <span class="glyph-alert">⚠</span>
                  </span>
                  <span class="toggle-text">
                    <span class="toggle-name">Alertes</span>
                    <span class="toggle-count">{{ alertsStatus() }}</span>
                  </span>
                </label>
                @if (showAlerts()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getOpacity('alerts')"
                         (input)="setOpacity('alerts', +$any($event.target).value)" />
                }
              </div>
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!showBuoys()">
                  <input type="checkbox" [checked]="showBuoys()" (change)="showBuoys.set($any($event.target).checked)" />
                  <span class="toggle-glyph">
                    <span class="glyph-buoy">⚓</span>
                  </span>
                  <span class="toggle-text">
                    <span class="toggle-name">Plateformes vagues</span>
                    <span class="toggle-count">{{ buoysStatus() }}</span>
                  </span>
                </label>
                @if (showBuoys()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getOpacity('buoys')"
                         (input)="setOpacity('buoys', +$any($event.target).value)" />
                }
              </div>
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!sstActive()">
                  <input type="checkbox" [checked]="showSST()" (change)="showSST.set($any($event.target).checked)" />
                  <span class="toggle-glyph">
                    <span class="glyph-gradient"></span>
                  </span>
                  <span class="toggle-text">
                    <span class="toggle-name">SST</span>
                    <span class="toggle-count">température mer (NOAA)</span>
                  </span>
                  @if (isAuthenticated() && palettesFor('sst').length > 0) {
                    <select class="palette-select" [value]="prefFor('sst')" (change)="setPalettePref('sst', $any($event.target).value)" (click)="$event.stopPropagation()">
                      <option value="">Style par défaut</option>
                      @for (p of palettesFor('sst'); track p.id) { <option [value]="p.id">{{ p.name }}</option> }
                    </select>
                  }
                </label>
                @if (showSST()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getOpacity('sst')"
                         (input)="setOpacity('sst', +$any($event.target).value)" />
                  <div class="contour-control">
                    <label class="contour-toggle">
                      <input type="checkbox" [checked]="showSstContours()" (change)="showSstContours.set($any($event.target).checked)" />
                      <span>Isolignes</span>
                    </label>
                    @if (showSstContours()) {
                      <input type="range" min="0.5" max="5" step="0.5"
                             [value]="sstContourInterval()"
                             (input)="sstContourInterval.set(+$any($event.target).value)"
                             title="Intervalle isolignes" />
                      <span class="contour-value">{{ sstContourInterval() }}°C</span>
                    }
                  </div>
                }
              </div>
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!wavesActive()">
                  <input type="checkbox" [checked]="showWaves()" (change)="showWaves.set($any($event.target).checked)" />
                  <span class="toggle-glyph">
                    <span class="glyph-waves"></span>
                  </span>
                  <span class="toggle-text">
                    <span class="toggle-name">Vagues</span>
                    <span class="toggle-count">hauteur sig. (WW3)</span>
                  </span>
                  @if (isAuthenticated() && palettesFor('waves').length > 0) {
                    <select class="palette-select" [value]="prefFor('waves')" (change)="setPalettePref('waves', $any($event.target).value)" (click)="$event.stopPropagation()">
                      <option value="">Style par défaut</option>
                      @for (p of palettesFor('waves'); track p.id) { <option [value]="p.id">{{ p.name }}</option> }
                    </select>
                  }
                </label>
                @if (showWaves()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getOpacity('waves')"
                         (input)="setOpacity('waves', +$any($event.target).value)" />
                  <div class="contour-control">
                    <label class="contour-toggle">
                      <input type="checkbox" [checked]="showWaveContours()" (change)="showWaveContours.set($any($event.target).checked)" />
                      <span>Isolignes</span>
                    </label>
                    @if (showWaveContours()) {
                      <input type="range" min="0.25" max="2" step="0.25"
                             [value]="waveContourInterval()"
                             (input)="waveContourInterval.set(+$any($event.target).value)"
                             title="Intervalle isolignes" />
                      <span class="contour-value">{{ waveContourInterval() }} m</span>
                    }
                  </div>
                }
              </div>
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!showWaveArrows()">
                  <input type="checkbox" [checked]="showWaveArrows()" (change)="showWaveArrows.set($any($event.target).checked)" />
                  <span class="toggle-glyph">
                    <span class="glyph-arrow glyph-arrow-wave">↑</span>
                  </span>
                  <span class="toggle-text">
                    <span class="toggle-name">Vagues flèches</span>
                    <span class="toggle-count">{{ waveArrowsStatus() }}</span>
                  </span>
                </label>
                @if (showWaveArrows()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getOpacity('waveArrows')"
                         (input)="setOpacity('waveArrows', +$any($event.target).value)" />
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
                <label class="layer-toggle" [class.dim]="!showLightning()">
                  <input type="checkbox" [checked]="showLightning()" (change)="showLightning.set($any($event.target).checked)" />
                  <span class="toggle-glyph">
                    <span class="glyph-zap">⚡</span>
                  </span>
                  <span class="toggle-text">
                    <span class="toggle-name">Foudre</span>
                    <span class="toggle-count">{{ lightningStatus() }}</span>
                  </span>
                </label>
                @if (showLightning()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getOpacity('lightning')"
                         (input)="setOpacity('lightning', +$any($event.target).value)" />
                }
              </div>
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!rainActive()">
                  <input type="checkbox" [checked]="showRain()" (change)="showRain.set($any($event.target).checked)" />
                  <span class="toggle-glyph">
                    <span class="glyph-rain"></span>
                  </span>
                  <span class="toggle-text">
                    <span class="toggle-name">Radar pluie</span>
                    <span class="toggle-count">{{ rainStatus() }}</span>
                  </span>
                </label>
                @if (showRain()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getOpacity('rain')"
                         (input)="setOpacity('rain', +$any($event.target).value)" />
                }
              </div>
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!showMetar()">
                  <input type="checkbox" [checked]="showMetar()" (change)="showMetar.set($any($event.target).checked)" />
                  <span class="toggle-glyph"><span class="glyph-icon">🛬</span></span>
                  <span class="toggle-text">
                    <span class="toggle-name">METAR aéroports</span>
                    <span class="toggle-count">{{ metarStatus() }}</span>
                  </span>
                </label>
                @if (showMetar()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getOpacity('metar')"
                         (input)="setOpacity('metar', +$any($event.target).value)" />
                }
              </div>
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!showQuakes()">
                  <input type="checkbox" [checked]="showQuakes()" (change)="showQuakes.set($any($event.target).checked)" />
                  <span class="toggle-glyph"><span class="glyph-icon">🌋</span></span>
                  <span class="toggle-text">
                    <span class="toggle-name">Séismes USGS</span>
                    <span class="toggle-count">{{ quakesStatus() }}</span>
                  </span>
                </label>
                @if (showQuakes()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getOpacity('quakes')"
                         (input)="setOpacity('quakes', +$any($event.target).value)" />
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
              <div class="layer-row layer-soon">
                <label class="layer-toggle dim">
                  <input type="checkbox" disabled />
                  <span class="toggle-glyph"><span class="glyph-icon">🛰</span></span>
                  <span class="toggle-text">
                    <span class="toggle-name">Satellite nuages <span class="soon-tag">à venir</span></span>
                    <span class="toggle-count">EUMETSAT MTG ~15 min</span>
                  </span>
                </label>
              </div>
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!showFirms()">
                  <input type="checkbox" [checked]="showFirms()" (change)="showFirms.set($any($event.target).checked)" />
                  <span class="toggle-glyph"><span class="glyph-icon">🔥</span></span>
                  <span class="toggle-text">
                    <span class="toggle-name">Feux NASA FIRMS</span>
                    <span class="toggle-count">{{ firmsStatus() }}</span>
                  </span>
                </label>
                @if (showFirms()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getOpacity('firms')"
                         (input)="setOpacity('firms', +$any($event.target).value)" />
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
                  <input type="checkbox" [checked]="showWind()" (change)="showWind.set($any($event.target).checked)" />
                  <span class="toggle-glyph">
                    <span class="glyph-wind"></span>
                  </span>
                  <span class="toggle-text">
                    <span class="toggle-name">Vent</span>
                    <span class="toggle-count">{{ windSourceLabel() }}</span>
                  </span>
                  <span class="wind-source-radios" (click)="$event.stopPropagation()">
                    <label class="radio-mini" title="NOAA GFS 25km, couverture monde">
                      <input type="radio" name="windSrc" value="gfs"
                             [checked]="windSource() === 'gfs'"
                             (change)="windSource.set('gfs')" />
                      GFS
                    </label>
                    <label class="radio-mini" title="Météo-France ARPEGE 11km, Europe étroite">
                      <input type="radio" name="windSrc" value="arpege"
                             [checked]="windSource() === 'arpege'"
                             (change)="windSource.set('arpege')" />
                      ARPEGE
                    </label>
                    <label class="radio-mini" title="Météo-France AROME 2.5km, FR métropole uniquement">
                      <input type="radio" name="windSrc" value="arome"
                             [checked]="windSource() === 'arome'"
                             (change)="windSource.set('arome')" />
                      AROME
                    </label>
                  </span>
                  @if (isAuthenticated() && palettesFor('wind').length > 0) {
                    <select class="palette-select" [value]="prefFor('wind')" (change)="setPalettePref('wind', $any($event.target).value)" (click)="$event.stopPropagation()">
                      <option value="">Style par défaut</option>
                      @for (p of palettesFor('wind'); track p.id) { <option [value]="p.id">{{ p.name }}</option> }
                    </select>
                  }
                </label>
                @if (showWind()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getOpacity('wind')"
                         (input)="setOpacity('wind', +$any($event.target).value)" />
                  <div class="contour-control">
                    <label class="contour-toggle">
                      <input type="checkbox" [checked]="showWindContours()" (change)="showWindContours.set($any($event.target).checked)" />
                      <span>Isolignes</span>
                    </label>
                    @if (showWindContours()) {
                      <input type="range" min="1" max="10" step="1"
                             [value]="windContourInterval()"
                             (input)="windContourInterval.set(+$any($event.target).value)"
                             title="Intervalle isolignes" />
                      <span class="contour-value">{{ windContourInterval() }} m/s</span>
                    }
                  </div>
                }
              </div>
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!showWindArrows()">
                  <input type="checkbox" [checked]="showWindArrows()" (change)="showWindArrows.set($any($event.target).checked)" />
                  <span class="toggle-glyph">
                    <span class="glyph-arrow glyph-arrow-wind">↑</span>
                  </span>
                  <span class="toggle-text">
                    <span class="toggle-name">Vent flèches</span>
                    <span class="toggle-count">{{ windSourceShortLabel() }} · {{ windArrowsStatus() }}</span>
                  </span>
                </label>
                @if (showWindArrows()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getOpacity('windArrows')"
                         (input)="setOpacity('windArrows', +$any($event.target).value)" />
                }
              </div>
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!showWindParticles()">
                  <input type="checkbox" [checked]="showWindParticles()" (change)="showWindParticles.set($any($event.target).checked)" />
                  <span class="toggle-glyph">
                    <span class="glyph-particles">∿∿∿</span>
                  </span>
                  <span class="toggle-text">
                    <span class="toggle-name">Vent particules</span>
                    <span class="toggle-count">{{ windParticlesStatus() }}</span>
                  </span>
                </label>
                @if (showWindParticles()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getOpacity('windParticles')"
                         (input)="setOpacity('windParticles', +$any($event.target).value)" />
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
                <label class="layer-toggle" [class.dim]="!showHubeau()">
                  <input type="checkbox" [checked]="showHubeau()" (change)="showHubeau.set($any($event.target).checked)" />
                  <span class="toggle-glyph"><span class="glyph-icon">≈</span></span>
                  <span class="toggle-text">
                    <span class="toggle-name">Débits rivières FR</span>
                    <span class="toggle-count">{{ hubeauStatus() }}</span>
                  </span>
                </label>
                @if (showHubeau()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getOpacity('hubeau')"
                         (input)="setOpacity('hubeau', +$any($event.target).value)" />
                }
              </div>
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!showPiezo()">
                  <input type="checkbox" [checked]="showPiezo()" (change)="showPiezo.set($any($event.target).checked)" />
                  <span class="toggle-glyph"><span class="glyph-icon">🪣</span></span>
                  <span class="toggle-text">
                    <span class="toggle-name">Niveaux piézo FR</span>
                    <span class="toggle-count">{{ piezoStatus() }}</span>
                  </span>
                </label>
                @if (showPiezo()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getOpacity('piezo')"
                         (input)="setOpacity('piezo', +$any($event.target).value)" />
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
              <!-- Fond de carte : switcher 5 styles -->
              <div class="layer-row">
                <label class="layer-toggle">
                  <span class="toggle-glyph"><span class="glyph-icon">🗺</span></span>
                  <span class="toggle-text">
                    <span class="toggle-name">Fond de carte</span>
                    <span class="toggle-count">{{ basemapLabel() }}</span>
                  </span>
                  <select class="palette-select" [value]="basemap()" (change)="setBasemap($any($event.target).value)" (click)="$event.stopPropagation()">
                    <option value="dark">Sombre</option>
                    <option value="voyager">Voyager</option>
                    <option value="light">Clair</option>
                    <option value="satellite">Satellite</option>
                    <option value="osm">OpenStreetMap</option>
                  </select>
                </label>
              </div>
              <!-- Bathymétrie EMODnet WMS -->
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!showBathy()">
                  <input type="checkbox" [checked]="showBathy()" (change)="showBathy.set($any($event.target).checked)" />
                  <span class="toggle-glyph"><span class="glyph-icon">≋</span></span>
                  <span class="toggle-text">
                    <span class="toggle-name">Bathymétrie</span>
                    <span class="toggle-count">EMODnet mean atlas</span>
                  </span>
                </label>
              </div>
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!showEez()">
                  <input type="checkbox" [checked]="showEez()" (change)="showEez.set($any($event.target).checked)" />
                  <span class="toggle-glyph"><span class="glyph-icon">⛓</span></span>
                  <span class="toggle-text">
                    <span class="toggle-name">EEZ (zones éco. excl.)</span>
                    <span class="toggle-count">Marine Regions VLIZ</span>
                  </span>
                </label>
                @if (showEez()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getOpacity('eez')"
                         (input)="setOpacity('eez', +$any($event.target).value)" />
                }
              </div>
              <div class="layer-row">
                <label class="layer-toggle" [class.dim]="!showMpa()">
                  <input type="checkbox" [checked]="showMpa()" (change)="showMpa.set($any($event.target).checked)" />
                  <span class="toggle-glyph"><span class="glyph-icon">🦑</span></span>
                  <span class="toggle-text">
                    <span class="toggle-name">MPA (aires marines)</span>
                    <span class="toggle-count">EMODnet Human Activities</span>
                  </span>
                </label>
                @if (showMpa()) {
                  <input class="layer-opacity" type="range" min="0" max="1" step="0.05" title="Opacité"
                         [value]="getOpacity('mpa')"
                         (input)="setOpacity('mpa', +$any($event.target).value)" />
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

        @if (showAlerts() && alertsList().length > 0) {
          <div class="alerts-panel">
            <div class="legend-section-title">Alertes actives ({{ alertsList().length }})</div>
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
          </div>
        }

        <div class="legend-section-title">Catégories navires</div>
        @for (cat of categories; track cat.key) {
          <div class="legend-item">
            <span class="legend-dot" [style.background]="cat.color.fill" [style.border-color]="cat.color.stroke"></span>
            <span>{{ cat.color.label }}</span>
          </div>
        }

        <div class="legend-stats">
          <div class="legend-mode" [class.live]="modeIsLive()" [class.future]="modeIsFuture()">
            @if (modeIsLive()) { ● LIVE }
            @else if (modeIsFuture()) { ◷ FORECAST }
            @else { ◷ REPLAY }
          </div>
          @if (lastRefreshAt()) {
            <div class="legend-refresh">refresh {{ lastRefreshAt() | date:'HH:mm:ss' }}</div>
          }
          @if (errorMsg()) {
            <button
              type="button"
              class="legend-error-compact"
              [title]="(errorCopied() ? '✓ copié dans le presse-papier' : (errorMsg() + ' — click pour copier'))"
              (click)="copyErrorToClipboard()">
              <span class="legend-error-icon">⚠</span>
              <span class="legend-error-label">{{ errorCopied() ? 'copié' : 'erreur' }}</span>
            </button>
          }
        </div>

        <!-- Mini-graph ingestion 24h — info secondaire, en bas. -->
        <div class="legend-section-title legend-ingestion-title">Ingestion 24h</div>
        <app-ingestion-mini-chart />
      </div>

      <!-- Popup overlay (positionné par OL via Overlay). Templates par
           type de feature : vessel · lightning · alert. -->
      <div class="popup" #popupEl [class.visible]="hasPopup()">
        @if (selectedVessel(); as v) {
          <button class="popup-close" type="button" (click)="closePopup()">×</button>
          <div class="popup-name">{{ v.name || ('MMSI ' + v.mmsi) }}</div>
          <div class="popup-meta">
            <span class="badge" [style.background]="categoryColor(v.ship_type)">
              {{ categoryLabel(v.ship_type) }}
            </span>
            @if (v.flag) { <span class="popup-flag">{{ v.flag }}</span> }
          </div>
          <div class="popup-row"><span>MMSI</span><strong class="mono">{{ v.mmsi }}</strong></div>
          @if (v.callsign) {
            <div class="popup-row"><span>Indicatif</span><strong class="mono">{{ v.callsign }}</strong></div>
          }
          @if (v.length_m) {
            <div class="popup-row"><span>Dimensions</span><strong>{{ v.length_m }} × {{ v.width_m || '?' }} m</strong></div>
          }
          @if (v.destination) {
            <div class="popup-row"><span>Destination</span><strong>{{ v.destination }}</strong></div>
          }
          <div class="popup-row"><span>Vu</span><strong>{{ v.last_seen | date:'HH:mm:ss' }}</strong></div>
        }
        @if (selectedLightning(); as l) {
          <button class="popup-close" type="button" (click)="closePopup()">×</button>
          <div class="popup-name">⚡ Éclair détecté</div>
          <div class="popup-meta">
            <span class="badge" style="background:#fde047;color:#0a0e1a">Blitzortung</span>
            <span class="popup-flag">il y a {{ formatAge(l.age_seconds) }}</span>
          </div>
          <div class="popup-row"><span>Heure</span><strong class="mono">{{ l.ts | date:'HH:mm:ss' }}</strong></div>
          @if (l.alt != null) {
            <div class="popup-row"><span>Altitude</span><strong>{{ l.alt | number:'1.0-0' }} m</strong></div>
          }
          @if (l.mcg != null) {
            <div class="popup-row"><span>Détecteurs</span><strong class="mono">{{ l.mcg }}</strong></div>
          }
          @if (l.pol != null) {
            <div class="popup-row"><span>Polarité</span><strong>{{ l.pol > 0 ? '+ positif' : '− négatif' }}</strong></div>
          }
        }
        @if (selectedAlert(); as a) {
          <button class="popup-close" type="button" (click)="closePopup()">×</button>
          <div class="popup-name">⚠ {{ alertKindLabel(a.kind) }}</div>
          <div class="popup-meta">
            <span
              class="badge"
              [style.background]="a.severity === 'danger' ? '#dc2626' : a.severity === 'warning' ? '#fb923c' : '#fde047'"
              [style.color]="a.severity === 'info' ? '#0a0e1a' : '#fff'">
              {{ a.severity }}
            </span>
            <span class="popup-flag">il y a {{ formatAge(a.age_seconds) }}</span>
          </div>
          <div class="popup-row"><span>Navire</span><strong>{{ a.vessel_name || ('MMSI ' + a.mmsi) }}</strong></div>
          @if (a.mmsi) {
            <div class="popup-row"><span>MMSI</span><strong class="mono">{{ a.mmsi }}</strong></div>
          }
          @if (a.detail?.windSpeed != null) {
            <div class="popup-row"><span>Vent</span><strong>{{ a.detail.windSpeed | number:'1.0-1' }} m/s</strong></div>
          }
          @if (a.detail?.distanceM != null) {
            <div class="popup-row"><span>Distance strike</span><strong>{{ a.detail.distanceM | number:'1.0-0' }} m</strong></div>
          }
        }
        @if (selectedFirms(); as fi) {
          <button class="popup-close" type="button" (click)="closePopup()">×</button>
          <div class="popup-name">🔥 Hotspot feu</div>
          <div class="popup-meta">
            <span class="badge" [style.background]="(fi.frp ?? 0) >= 200 ? '#b91c1c' : (fi.frp ?? 0) >= 50 ? '#dc2626' : (fi.frp ?? 0) >= 10 ? '#f97316' : '#fbbf24'" [style.color]="(fi.frp ?? 0) >= 10 ? '#fff' : '#0a0e1a'">
              {{ fi.frp != null ? (fi.frp | number:'1.0-1') : '?' }} MW
            </span>
            <span class="popup-flag">NASA FIRMS</span>
            <span class="popup-flag">il y a {{ formatAge(fi.age_seconds) }}</span>
          </div>
          <div class="popup-row"><span>Acquisition</span><strong class="mono">{{ fi.ts | date:'dd/MM HH:mm':'+0000' }}Z</strong></div>
          @if (fi.brightness != null) {
            <div class="popup-row"><span>Brightness</span><strong>{{ fi.brightness | number:'1.1-1' }} K</strong></div>
          }
          @if (fi.confidence != null) {
            <div class="popup-row"><span>Confiance</span><strong>{{ fi.confidence }}/100</strong></div>
          }
          @if (fi.satellite) {
            <div class="popup-row"><span>Satellite</span><strong>{{ fi.satellite === 'T' ? 'Terra' : fi.satellite === 'A' ? 'Aqua' : fi.satellite }} ({{ fi.daynight === 'D' ? 'jour' : 'nuit' }})</strong></div>
          }
        }
        @if (selectedQuake(); as q) {
          <button class="popup-close" type="button" (click)="closePopup()">×</button>
          <div class="popup-name">🌋 {{ q.place || 'Séisme' }}</div>
          <div class="popup-meta">
            <span class="badge" [style.background]="q.mag != null && q.mag >= 6 ? '#dc2626' : q.mag != null && q.mag >= 5 ? '#ea580c' : q.mag != null && q.mag >= 4 ? '#fbbf24' : '#84cc16'" [style.color]="(q.mag ?? 0) >= 5 ? '#fff' : '#0a0e1a'">
              M {{ q.mag != null ? (q.mag | number:'1.1-1') : '?' }}
            </span>
            <span class="popup-flag">USGS</span>
            @if (q.tsunami) { <span class="popup-flag" style="color:#dc2626">⚠ Tsunami</span> }
            @if (q.alert) { <span class="popup-flag" style="text-transform:uppercase" [style.color]="q.alert === 'red' ? '#dc2626' : q.alert === 'orange' ? '#ea580c' : q.alert === 'yellow' ? '#fbbf24' : '#84cc16'">{{ q.alert }}</span> }
          </div>
          <div class="popup-row"><span>Heure</span><strong class="mono">{{ q.time | date:'dd/MM HH:mm:ss' }}</strong></div>
          @if (q.depth_km != null) {
            <div class="popup-row"><span>Profondeur</span><strong>{{ q.depth_km | number:'1.0-1' }} km</strong></div>
          }
          @if (q.sig != null) {
            <div class="popup-row"><span>Significance</span><strong>{{ q.sig }}/1000</strong></div>
          }
          @if (q.url) {
            <div class="popup-row" style="flex-direction:column;align-items:flex-start;gap:0.2em">
              <span>Détails</span>
              <a [href]="q.url" target="_blank" rel="noopener" class="mono" style="font-size:0.7rem;color:var(--accent-bright)">earthquake.usgs.gov ↗</a>
            </div>
          }
        }
        @if (selectedPiezo(); as pz) {
          <button class="popup-close" type="button" (click)="closePopup()">×</button>
          <div class="popup-name">🪣 Piézomètre {{ pz.code_bss }}</div>
          <div class="popup-meta">
            <span class="badge" style="background:#6366f1;color:#fff">Hub'eau</span>
            <span class="popup-flag">il y a {{ formatAge(pz.age_seconds) }}</span>
          </div>
          @if (pz.profondeur_nappe != null) {
            <div class="popup-row"><span>Profondeur nappe</span><strong>{{ pz.profondeur_nappe | number:'1.2-2' }} m</strong></div>
          }
          @if (pz.niveau_eau_ngf != null) {
            <div class="popup-row"><span>Niveau (NGF)</span><strong>{{ pz.niveau_eau_ngf | number:'1.2-2' }} m</strong></div>
          }
          @if (pz.altitude_station != null) {
            <div class="popup-row"><span>Altitude station</span><strong>{{ pz.altitude_station | number:'1.0-2' }} m</strong></div>
          }
          <div class="popup-row"><span>Mesure</span><strong class="mono">{{ pz.ts | date:'dd/MM HH:mm':'+0000' }}Z</strong></div>
          <div class="popup-row" style="flex-direction:column;align-items:flex-start;gap:0.2em">
            <span>Détails BSS</span>
            <a [href]="'https://ades.eaufrance.fr/Fiche/PointEau?code=' + pz.code_bss" target="_blank" rel="noopener" class="mono" style="font-size:0.7rem;color:var(--accent-bright)">ades.eaufrance.fr ↗</a>
          </div>
        }
        @if (selectedHubeau(); as h) {
          <button class="popup-close" type="button" (click)="closePopup()">×</button>
          <div class="popup-name">💧 Station {{ h.code_station }}</div>
          <div class="popup-meta">
            <span class="badge" style="background:#22d3ee;color:#0a0e1a">Hub'eau</span>
            <span class="popup-flag">il y a {{ formatAge(h.age_seconds) }}</span>
            @if (h.qualif) { <span class="popup-flag">{{ h.qualif }}</span> }
          </div>
          @if (h.debit_m3_s != null) {
            <div class="popup-row">
              <span>Débit</span>
              <strong>
                {{ h.debit_m3_s | number:'1.2-2' }} m³/s
                @if (h.debit_l_s != null) {
                  <span style="color:var(--fg-muted);font-weight:400;font-size:0.7rem"> ({{ h.debit_l_s | number:'1.0-0' }} L/s)</span>
                }
              </strong>
            </div>
          }
          <div class="popup-row"><span>Mesure</span><strong class="mono">{{ h.ts | date:'HH:mm':'+0000' }}Z</strong></div>
          <div class="popup-row" style="flex-direction:column;align-items:flex-start;gap:0.2em">
            <span>Détails station</span>
            <a [href]="'https://www.hydro.eaufrance.fr/stationhydro/' + h.code_station + '/synthese'" target="_blank" rel="noopener" class="mono" style="font-size:0.7rem;color:var(--accent-bright)">hydro.eaufrance.fr/{{ h.code_station }} ↗</a>
          </div>
        }
        @if (selectedMetar(); as m) {
          <button class="popup-close" type="button" (click)="closePopup()">×</button>
          <div class="popup-name">🛬 {{ m.station_name || m.icao }}</div>
          <div class="popup-meta">
            <span class="badge" style="background:#a78bfa;color:#0a0e1a">{{ m.icao }}</span>
            <span class="popup-flag">NOAA AWC</span>
            <span class="popup-flag">il y a {{ formatAge(m.age_seconds) }}</span>
          </div>
          <div class="popup-row"><span>Observation</span><strong class="mono">{{ m.ts | date:'HH:mm':'+0000' }}Z</strong></div>
          @if (m.temp_c != null) {
            <div class="popup-row"><span>Température</span><strong>{{ m.temp_c | number:'1.0-1' }}°C</strong></div>
          }
          @if (m.dewp_c != null) {
            <div class="popup-row"><span>Point de rosée</span><strong>{{ m.dewp_c | number:'1.0-1' }}°C</strong></div>
          }
          @if (m.wind_speed_kt != null) {
            <div class="popup-row">
              <span>Vent</span>
              <strong>
                @if (m.wind_dir_deg != null) { {{ m.wind_dir_deg | number:'3.0-0' }}° }
                {{ m.wind_speed_kt | number:'1.0-0' }} kt
                @if (m.wind_gust_kt != null) { (G {{ m.wind_gust_kt | number:'1.0-0' }}) }
              </strong>
            </div>
          }
          @if (m.altimeter_hpa != null) {
            <div class="popup-row"><span>QNH</span><strong>{{ m.altimeter_hpa | number:'1.0-0' }} hPa</strong></div>
          }
          @if (m.weather_str) {
            <div class="popup-row"><span>Temps présent</span><strong>{{ m.weather_str }}</strong></div>
          }
          @if (m.raw) {
            <div class="popup-row" style="flex-direction:column;align-items:flex-start;gap:0.2em">
              <span>METAR brut</span>
              <code class="mono" style="font-size:0.65rem;white-space:pre-wrap;word-break:break-all">{{ m.raw }}</code>
            </div>
          }
        }
        @if (selectedBuoy(); as b) {
          <button class="popup-close" type="button" (click)="closePopup()">×</button>
          <div class="popup-name">⚓ {{ b.name }}</div>
          <div class="popup-meta">
            <span class="badge" style="background:#1e88e5;color:#fff">EMODnet</span>
            <span class="popup-flag">{{ b.candhis_id }}</span>
            @if (b.wmo) {
              <span class="popup-flag mono">WMO {{ b.wmo }}</span>
            }
          </div>
          @if (b.platform_type || b.buoy_type) {
            <div class="popup-row"><span>Type</span><strong>{{ b.platform_type ?? b.buoy_type }}</strong></div>
          }
          @if (b.owner) {
            <div class="popup-row"><span>Owner</span><strong>{{ b.owner }}</strong></div>
          }
          @if (b.country) {
            <div class="popup-row"><span>Pays</span><strong>{{ b.country }}</strong></div>
          }
          @if (b.last_obs_at) {
            <div class="popup-row">
              <span>Dernière obs</span>
              <strong class="mono">
                {{ b.last_obs_at | date:'dd/MM/yy HH:mm' }}
                <span class="freshness-badge" [class]="'fresh-' + freshnessFor(b.last_obs_at)"
                      [title]="freshnessLabel(b.last_obs_at)">●</span>
              </strong>
            </div>
          }
          @if (b.parameters_group) {
            <div class="popup-row"><span>Params</span><strong class="params-tight">{{ b.parameters_group }}</strong></div>
          }
          @if (selectedBuoyObs(); as o) {
            @if (o.ts) {
              <div class="popup-row"><span>Mesure</span><strong class="mono">{{ o.ts | date:'dd/MM HH:mm' }}</strong></div>
            }
            @if (o.hm0 != null) {
              <div class="popup-row"><span>Hm0 (Hs)</span><strong>{{ o.hm0 | number:'1.1-2' }} m</strong></div>
            } @else if (o.h13 != null) {
              <div class="popup-row"><span>H1/3</span><strong>{{ o.h13 | number:'1.1-2' }} m</strong></div>
            }
            @if (o.hmax != null) {
              <div class="popup-row"><span>Hmax</span><strong>{{ o.hmax | number:'1.1-2' }} m</strong></div>
            }
            @if (o.tp != null) {
              <div class="popup-row"><span>T au pic</span><strong>{{ o.tp | number:'1.1-1' }} s</strong></div>
            } @else if (o.th13 != null) {
              <div class="popup-row"><span>TH1/3</span><strong>{{ o.th13 | number:'1.1-1' }} s</strong></div>
            }
            @if (o.peak_dir != null) {
              <div class="popup-row"><span>Dir. pic</span><strong>{{ o.peak_dir | number:'1.0-0' }}°</strong></div>
            }
          }
          @if (b.data_link) {
            <div class="popup-row">
              <span>Source</span>
              <a class="mono" [href]="b.data_link" target="_blank" rel="noopener">NetCDF ⤤</a>
            </div>
          }
          <div class="popup-row popup-row-link">
            <a class="emodnet-link mono"
               [href]="'https://emodnet.ec.europa.eu/geoviewer/?platforms=' + b.candhis_id"
               target="_blank" rel="noopener"
               title="Fiche plateforme + données détaillées EMODnet">
              📊 Fiche EMODnet ⤤
            </a>
          </div>
        }
      </div>

      <!-- Attribution panel relocated into controls-dock-bottom-right -->

      <app-time-slider
        [minTime]="sliderConfig().minTime"
        [maxTime]="sliderConfig().maxTime"
        [stepMs]="sliderConfig().stepMs"
        [statusLabel]="sliderConfig().label"
        [validityList]="masterValidityList()"
        [layerCoverage]="sliderLayerCoverage()"
        [externalAnimationActive]="animPlayer.state() !== 'idle'"
        [externalCurrentTime]="animPlayer.state() !== 'idle' ? currentTimeSig() : null"
        (timeChange)="onSliderTimeChange($event)"
        (playClicked)="onSliderPlayClicked()" />
    </div>
  `,
  styles: `
    :host {
      display: block;
      height: 100%;
      width: 100%;
    }
    .map-container {
      position: relative;
      height: 100%;
      width: 100%;
    }
    .map {
      height: 100%;
      width: 100%;
      background: var(--bg-2);
    }
    /* OL controls overrides → vivent dans styles.scss global pour ne pas
       être bloqués par l'encapsulation Angular (les controls OL sont
       injectés dans le DOM imperativement). */
    .wind-particles-canvas {
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      width: 100%; height: 100%;
      pointer-events: none;
      z-index: 5;          /* sous le legend (z=10) mais au-dessus des tiles */
      display: none;
      &.active { display: block; }
    }
    .auth-corner {
      position: absolute;
      top: 1em; right: 1em;
      z-index: 10;
      display: flex; align-items: center; gap: 0.5em;
      background: rgb(15, 23, 42);
      border: 1px solid hsl(224 85% 55% / 0.5);
      border-radius: 8px;
      padding: 0.5em 0.9em;
      font-size: 0.78rem;
      color: var(--fg-muted);
      box-shadow:
        0 0 0 1px hsl(224 95% 60% / 0.2),
        0 0 16px 1px hsl(224 95% 60% / 0.22),
        0 0 36px 4px hsl(224 90% 55% / 0.1);
    }
    .auth-link {
      color: var(--accent-bright);
      text-decoration: none;
      &:hover { color: var(--fg); }
    }
    .auth-admin-pill {
      display: inline-block;
      padding: 1px 6px;
      border: 1px solid var(--accent-bright);
      border-radius: 3px;
      font-family: var(--font-mono);
      font-size: 0.6rem;
      letter-spacing: 0.15em;
    }
    .auth-sep { color: var(--fg-dim); }
    .auth-btn {
      background: transparent;
      border: 0;
      color: var(--fg-muted);
      cursor: pointer;
      font: inherit;
      padding: 0;
      &:hover { color: var(--negative); }
    }
    .palette-select {
      background: var(--bg-3);
      border: 1px solid var(--border);
      color: var(--fg);
      font-size: 0.7rem;
      padding: 0.15em 0.3em;
      border-radius: 4px;
      margin-left: auto;
      max-width: 110px;
    }
    /* Sprint 11 + Europe Chantier #2 : sélecteur de modèle (GFS vs ARPEGE) inline
       dans le toggle Vent. Très compact (2 radios + 2 labels) pour ne pas casser
       la légende. */
    .wind-source-radios {
      display: inline-flex;
      gap: 0.4em;
      margin-left: 0.5em;
      align-items: center;
      font-size: 0.65rem;
      color: var(--fg-muted);
      font-family: var(--font-mono);
      letter-spacing: 0.05em;
    }
    .wind-source-radios .radio-mini {
      display: inline-flex;
      align-items: center;
      gap: 0.15em;
      cursor: pointer;
      padding: 0.05em 0.3em;
      border-radius: 3px;
      transition: background 0.15s, color 0.15s;
    }
    .wind-source-radios .radio-mini:has(input:checked) {
      background: var(--bg-3);
      color: var(--accent);
    }
    .wind-source-radios .radio-mini input {
      margin: 0;
      width: 9px;
      height: 9px;
      accent-color: var(--accent);
    }
    .cap5-toast {
      position: absolute;
      top: -2.5em;
      left: 0;
      right: 0;
      background: rgba(220, 38, 38, 0.92);
      color: #fff;
      font-family: var(--font-mono);
      font-size: 0.7rem;
      padding: 0.5em 0.8em;
      border-radius: 6px;
      letter-spacing: 0.03em;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
      animation: cap5-toast-in 200ms ease-out;
      z-index: 11;
    }
    @keyframes cap5-toast-in {
      from { opacity: 0; transform: translateY(8px); }
      to   { opacity: 1; transform: translateY(0); }
    }
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
      /* Glow neon cyan, inspiré OL Companion sidebar */
      box-shadow:
        0 0 0 1px hsl(224 95% 60% / 0.2),
        0 0 16px 1px hsl(224 95% 60% / 0.26),
        0 0 40px 4px hsl(224 90% 55% / 0.13),
        0 10px 30px -6px rgba(0, 0, 0, 0.7);
    }
    .legend-title {
      font-family: var(--font-mono);
      font-size: 0.7rem;
      letter-spacing: 0.2em;
      color: var(--accent);
      font-weight: 700;
    }
    .legend-subtitle {
      font-size: 0.75rem;
      color: var(--fg-muted);
      margin-bottom: 0.8em;
    }
    /* ═══ V2 Phase 1 — Data catalog accordion ═══════════════════════ */
    /* Hero logo en background-image, breaks out du padding parent pour
       coller aux 4 coins arrondis du panneau. Pattern validé Sylvain. */
    .data-catalog .catalog-header {
      background-image: url(/AetherWX_logo_menu.png);
      background-size: 100% 100%;     /* exact-fill : pas de crop, pas de vide */
      background-repeat: no-repeat;
      /* Suit le ratio natif de AetherWX_logo_menu.png (1176×709 = 1.66:1)
         → la hauteur s'auto-ajuste à la largeur courante du panel.
         À largeur ~257px on retombe sur ≈155px de haut comme demandé. */
      aspect-ratio: 1176 / 709;
      margin: -1em -1.2em 1em -1.2em;
      border-bottom: 1px solid var(--border);
      border-radius: 8px 8px 0 0;
    }
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
    .catalog-section-head.section-forecast    { color: #fb923c; }
    .catalog-section-head.section-hydrology   { color: #22d3ee; }
    .catalog-section-head.section-sources     { color: #94a3b8; }
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
    /* V2 isolignes sous-toggle — sous l'opacity slider du raster */
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
    .contour-value {
      font-family: var(--font-mono);
      font-size: 0.65rem;
      color: var(--fg);
      min-width: 30px;
    }
    /* Placeholder rows = "à venir" — désactivées visuellement */
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
    /* Sprint Layer UX V2 — Phase A : groupes par catégorie de data */
    .layer-group {
      display: flex;
      flex-direction: column;
      gap: 0.35em;
    }
    .layer-group-title {
      font-family: var(--font-mono);
      font-size: 0.6rem;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--fg-dim);
      padding: 0.2em 0 0.05em;
      border-top: 1px dashed rgba(255,255,255,0.06);
      &:first-child { border-top: 0; padding-top: 0; }
    }
    .layer-group:first-of-type .layer-group-title {
      border-top: 0;
      padding-top: 0;
    }
    .layer-group-soon {
      opacity: 0.4;
      .soon-tag {
        font-size: 0.55rem;
        letter-spacing: 0.15em;
        margin-left: 0.6em;
        color: var(--fg-dim);
      }
    }
    /* Row qui wrap le toggle + son slider d'opacité (visible si layer actif) */
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
      margin-left: 1.6em;   /* aligné sur le toggle text (skip checkbox+glyph) */
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
      /* Dim only the visual preview + label, NOT the checkbox itself —
         so on/off state is always crystal clear. */
      &.dim {
        .toggle-glyph, .toggle-text { opacity: 0.4; transition: opacity 200ms; }
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
      /* gradient pluie : transparent → bleu clair → vert → jaune → rouge (intensité radar) */
      background: linear-gradient(to right, rgba(255,255,255,0.05) 0%, #38bdf8 25%, #4ade80 50%, #fbbf24 75%, #ef4444 100%);
      border: 1px solid rgba(255,255,255,0.15);
    }
    .glyph-wind {
      display: inline-block;
      width: 36px;
      height: 8px;
      border-radius: 2px;
      /* gradient force vent (Beaufort) : calme → frais → fort → tempête */
      background: linear-gradient(to right, #cbd5e1 0%, #38bdf8 35%, #fbbf24 70%, #dc2626 100%);
      border: 1px solid rgba(255,255,255,0.15);
    }
    .glyph-waves {
      display: inline-block;
      width: 36px;
      height: 8px;
      border-radius: 2px;
      /* gradient hauteur vagues : plat → houle → forte → grosse mer */
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
    .alerts-panel {
      margin-top: 0.5em;
      padding-top: 0.6em;
      border-top: 1px solid var(--border);
      max-height: 280px;
      overflow-y: auto;
    }
    .alerts-feed {
      display: flex;
      flex-direction: column;
      gap: 0.3em;
    }
    .alert-item {
      padding: 0.4em 0.5em;
      border-left: 2px solid var(--accent);
      background: rgba(255,255,255,0.03);
      font-size: 0.75rem;
      border-radius: 0 4px 4px 0;
      &.warning { border-left-color: var(--warning); }
      &.danger  { border-left-color: var(--negative); background: rgba(239,68,68,0.08); }
    }
    .alert-head {
      display: flex;
      justify-content: space-between;
      gap: 0.5em;
      font-family: var(--font-mono);
      font-size: 0.7rem;
    }
    .alert-kind { color: var(--fg); letter-spacing: 0.05em; }
    .alert-age  { color: var(--fg-dim); }
    .alert-meta {
      color: var(--fg-muted);
      font-size: 0.72rem;
      margin-top: 0.15em;
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
    /* Bloc ingestion en bas : marqué visuellement comme info secondaire,
       séparé des stats LIVE/REPLAY par une marge dédiée. */
    .legend-ingestion-title {
      margin-top: 1em;
      border-top: 1px solid var(--border);
      padding-top: 0.6em;
    }
    .legend-item {
      display: flex;
      align-items: center;
      gap: 0.5em;
      font-size: 0.8rem;
      color: var(--fg);
      padding: 0.15em 0;
    }
    .legend-dot {
      display: inline-block;
      width: 12px; height: 12px;
      border-radius: 50%;
      border: 1px solid;
    }
    .legend-stats {
      margin-top: 0.8em;
      padding-top: 0.8em;
      border-top: 1px solid var(--border);
      font-size: 0.75rem;
      color: var(--fg-muted);
      strong { color: var(--accent-bright); }
    }
    .legend-mode {
      font-family: var(--font-mono);
      font-size: 0.7rem;
      letter-spacing: 0.15em;
      color: var(--fg-muted);
      &.live { color: var(--accent-bright); }
      &.future { color: var(--warning); }
    }
    .legend-refresh {
      font-family: var(--font-mono);
      font-size: 0.65rem;
      color: var(--fg-dim);
      margin-top: 0.2em;
    }
    .legend-error {
      color: var(--negative);
      font-size: 0.7rem;
      margin-top: 0.4em;
    }
    /* Compact error indicator : icône + texte "erreur" rouge sans élargir
       le panneau gauche. Le message complet est en tooltip native (title). */
    .legend-error-compact {
      display: inline-flex;
      align-items: center;
      gap: 0.3em;
      margin-top: 0.4em;
      padding: 0.15em 0.5em;
      border: 1px solid var(--negative);
      border-radius: 3px;
      background: color-mix(in srgb, var(--negative) 12%, transparent);
      color: var(--negative);
      font-family: var(--font-mono);
      font-size: 0.65rem;
      letter-spacing: 0.05em;
      cursor: help;
      max-width: max-content;
    }
    .legend-error-icon {
      font-size: 0.8rem;
      line-height: 1;
    }
    .legend-error-label {
      text-transform: uppercase;
    }

    .popup {
      position: absolute;
      pointer-events: auto;
      background: rgb(15, 23, 42);
      border: 1px solid hsl(224 85% 55% / 0.5);
      border-radius: 8px;
      padding: 0.85em 1.05em;
      min-width: 260px;
      transform: translate(-50%, calc(-100% - 12px));
      visibility: hidden;
      box-shadow:
        0 0 0 1px hsl(224 95% 60% / 0.2),
        0 0 18px 1px hsl(224 95% 60% / 0.3),
        0 0 40px 4px hsl(224 90% 55% / 0.13),
        0 12px 32px -6px rgba(0, 0, 0, 0.8);
      &.visible { visibility: visible; }

      &::after {
        content: '';
        position: absolute;
        bottom: -7px;
        left: 50%;
        transform: translateX(-50%) rotate(45deg);
        width: 12px; height: 12px;
        background: rgb(15, 23, 42);
        border-right: 1px solid hsl(224 85% 55% / 0.5);
        border-bottom: 1px solid hsl(224 85% 55% / 0.5);
      }
    }
    .popup-close {
      position: absolute;
      top: 0.3em; right: 0.3em;
      background: none;
      border: none;
      color: var(--fg-dim);
      font-size: 1.4em;
      line-height: 1;
      cursor: pointer;
      padding: 0.2em 0.4em;
      &:hover { color: var(--fg); }
    }
    .popup-name {
      font-weight: 700;
      color: var(--fg);
      margin-bottom: 0.4em;
      padding-right: 1.5em;
    }
    .popup-meta {
      display: flex;
      gap: 0.5em;
      align-items: center;
      margin-bottom: 0.6em;
    }
    .badge {
      font-size: 0.7rem;
      padding: 0.15em 0.5em;
      border-radius: 4px;
      color: var(--bg);
      font-weight: 600;
    }
    .popup-flag {
      font-family: var(--font-mono);
      font-size: 0.7rem;
      color: var(--fg-muted);
    }
    .popup-row {
      display: flex;
      justify-content: space-between;
      padding: 0.2em 0;
      font-size: 0.78rem;
      gap: 0.6em;
      span { color: var(--fg-muted); }
      strong { color: var(--fg); }
    }
    .popup-row-link {
      justify-content: center;
      padding: 0.5em 0 0.2em;
      border-top: 1px dashed rgba(255,255,255,0.08);
      margin-top: 0.4em;
    }
    .mono { font-family: var(--font-mono); font-size: 0.72rem; }
    .params-tight { font-size: 0.72rem; max-width: 200px; text-align: right; }
    /* Badge de fraîcheur (Phase obs EMODnet pivot 2026-05-12) :
       pastille colorée à droite de last_obs_at, donne en un coup d'œil
       l'utilité de la plateforme. */
    .freshness-badge {
      display: inline-block;
      margin-left: 0.4em;
      font-size: 0.7rem;
      line-height: 1;
      cursor: help;
    }
    .freshness-badge.fresh-fresh  { color: #22c55e; }   /* <6h vert */
    .freshness-badge.fresh-recent { color: #f59e0b; }   /* <24h orange */
    .freshness-badge.fresh-stale  { color: #94a3b8; }   /* <7j gris */
    .freshness-badge.fresh-cold   { color: #64748b; opacity: 0.6; }  /* >7j cold */
    .emodnet-link {
      color: var(--accent-bright);
      text-decoration: none;
      font-size: 0.78rem;
      padding: 0.25em 0.7em;
      border: 1px solid var(--accent);
      border-radius: 3px;
      transition: all 150ms;
      &:hover {
        background: var(--accent-bright);
        color: var(--bg);
      }
    }

    /* ── Attribution bar maison (drop OL Attribution control) ──
       Bottom-right, au-dessus de la time-slider. Bouton (i) circulaire
       toujours visible ; clic → panel s'ouvre vers le HAUT-GAUCHE pour
       ne pas dépasser de la viewport. Pas de glow exotique : juste un
       border + un box-shadow soft pour la lisibilité. */
    /* ── Phase Layer UX V2.1 : controls docks organisés ──
       Top-right (sous auth-corner) : zoom +/-.
       Bottom-right (au-dessus de time-slider) : HDMS + scale + attribution.
       Plus d'amas anarchique. Cohérent visuellement avec auth-corner. */
    .controls-dock {
      position: absolute;
      right: 1em;
      z-index: 12;
      display: flex;
      flex-direction: column;
      gap: 0.4em;
      pointer-events: auto;
    }
    .controls-dock-top-right {
      top: 4em;                /* sous auth-corner qui est à top:1em + ~2.5em haut */
      align-items: flex-end;
    }
    /* Phase C.3 bonus : bouton "Recentrer sur ma zone par défaut".
       Aligné visuellement avec les boutons .ol-zoom (mêmes dimensions
       et style brut OL). Placé sous les boutons +/- via flex direction
       column du parent. */
    .recenter-btn {
      width: 1.375em;     /* matche .ol-zoom button width OL default */
      height: 1.375em;
      margin: 0 0 4px 0;  /* small gap au-dessus du zoom OL */
      padding: 0;
      background: rgba(0, 60, 136, 0.5);
      border: 1px solid transparent;
      border-radius: 2px;
      color: #fff;
      font-size: 1.14em;
      line-height: 1;
      cursor: pointer;
      transition: background 150ms;
    }
    .recenter-btn:hover {
      background: rgba(0, 60, 136, 0.7);
    }
    .recenter-btn:focus-visible {
      outline: 2px solid var(--accent-bright);
      outline-offset: 2px;
    }
    .controls-dock-bottom-right {
      bottom: 6em;             /* au-dessus de la time-slider (~5em haut) */
      align-items: flex-end;
    }
    .controls-dock-info {
      display: flex;
      flex-direction: column;
      gap: 0.4em;
      align-items: flex-end;
    }
    .attribution-trigger {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: rgb(15, 23, 42);
      border: 1px solid hsl(224 85% 55% / 0.5);
      color: var(--accent-bright);
      font-family: 'Times New Roman', Georgia, serif;
      font-style: italic;
      font-size: 0.95rem;
      font-weight: 700;
      cursor: pointer;
      transition: color 150ms, border-color 150ms, transform 150ms;
      display: flex;
      align-items: center;
      justify-content: center;
      &:hover {
        color: var(--fg);
        border-color: var(--accent-bright);
        transform: translateY(-1px);
      }
      &.is-open {
        font-style: normal;
        font-family: var(--font-sans);
        font-size: 1.1rem;
      }
    }
    .attribution-panel {
      /* Le panel ouvre VERS LE HAUT depuis le trigger qui est en bas
         du dock. position absolute + bottom: 100% pour qu'il flotte
         au-dessus du bouton sans pousser le dock. */
      position: absolute;
      bottom: calc(100% + 8px);
      right: 0;
      background: rgb(15, 23, 42);
      border: 1px solid hsl(224 85% 55% / 0.5);
      border-radius: 8px;
      padding: 0.9em 1.1em;
      max-width: 420px;
      width: max-content;
      font-size: 0.78rem;
      line-height: 1.6;
      color: var(--fg);
      box-shadow: 0 8px 24px -4px rgba(0, 0, 0, 0.7);
      animation: attr-fade-in 150ms ease-out;
    }
    @keyframes attr-fade-in {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .attribution-title {
      font-family: var(--font-mono);
      font-size: 0.68rem;
      letter-spacing: 0.18em;
      color: var(--accent-bright);
      margin-bottom: 0.5em;
      text-transform: uppercase;
    }
    .attribution-row {
      display: grid;
      grid-template-columns: 90px 1fr;
      gap: 0.5em;
      padding: 0.18em 0;
    }
    .attribution-label {
      color: var(--fg-muted);
      font-size: 0.72rem;
      font-family: var(--font-mono);
    }
    .attribution-panel a {
      color: var(--accent-bright);
      text-decoration: none;
      font-weight: 500;
      &:hover {
        text-decoration: underline;
        color: var(--fg);
      }
    }

    /* ── Legend toggle (hamburger) — affiché uniquement sur mobile ──
       Sur desktop : display:none → la legend reste toujours visible.
       Sur mobile : pille fixe top-left, taille touch-friendly (44x44). */
    .legend-toggle {
      display: none;
      position: absolute;
      top: 1em;
      left: 1em;
      z-index: 11;            /* > legend (10), pour rester cliquable même
                                  quand la legend déployée recouvre la zone */
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

    /* ── Responsive mobile (≤ 760px) ──
       Legend = drawer collapsé par défaut (signal legendOpen false).
       Au open : occupe presque toute la zone visible (90vw × 80vh max).
       Auth-corner = pill compact top-right.
       Time slider et attribution-bar repositionnés au-dessus.
       Popups feature : max-width = 90vw pour ne pas déborder. */
    @media (max-width: 760px) {
      .legend-toggle {
        display: flex;
      }
      .legend {
        top: 0.7em;
        left: 0.7em;
        right: 0.7em;
        max-width: none;
        max-height: 78vh;
        overflow-y: auto;
        /* Padding plus serré pour laisser passer le bouton hamburger
           qui se superpose au coin haut-gauche de la legend. */
        padding: 1em 1em 1em 3.6em;
        z-index: 10;
        &.legend--closed {
          display: none;
        }
      }
      .auth-corner {
        top: 0.7em;
        right: 0.7em;
        padding: 0.4em 0.7em;
        font-size: 0.7rem;
        max-width: calc(100vw - 70px);  /* clear le hamburger */
        flex-wrap: wrap;
        gap: 0.35em;
        z-index: 11;
      }
      .palette-select {
        max-width: 90px;
        font-size: 0.65rem;
      }
      .attribution-bar {
        bottom: 8.5em;          /* clear la time-slider stacked (~7em haut) */
        right: 0.7em;
      }
      .attribution-panel {
        max-width: calc(100vw - 1.4em);
      }
      .popup {
        max-width: calc(100vw - 1.4em);
        min-width: 0;
      }
      .wind-source-radios {
        font-size: 0.6rem;
        gap: 0.25em;
      }
      /* Particles canvas et controls OL — pas de fix nécessaire
         (les controls OL ScaleLine et Zoom sont déjà dans styles.scss
         global et positionnés bottom-left, hors collision slider). */
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MapComponent implements AfterViewInit, OnDestroy {
  private readonly vessels = inject(VesselsService);
  private readonly rainviewer = inject(RainviewerService);
  private readonly arrows = inject(ArrowsService);
  private readonly lightning = inject(LightningService);
  private readonly alertsSvc = inject(AlertsService);
  private readonly buoys = inject(BuoysService);
  private readonly auth = inject(AuthService);
  private readonly palettesSvc = inject(PalettesService);
  private readonly prefsSync = inject(PreferencesSyncService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  readonly animPlayer = inject(AnimationPlayerService);

  readonly currentUser = this.auth.currentUser;
  readonly isAuthenticated = this.auth.isAuthenticated;

  readonly mapEl = viewChild.required<ElementRef<HTMLDivElement>>('mapEl');
  readonly popupEl = viewChild.required<ElementRef<HTMLDivElement>>('popupEl');
  readonly particlesEl = viewChild.required<ElementRef<HTMLCanvasElement>>('particlesEl');
  /** Phase Layer UX V2.1 — controls dock organisé : zoom en top-right
      sous auth-corner, HDMS+scale+attribution en bottom-right. Plus
      d'amas anarchique bottom-left. */
  readonly zoomDockEl = viewChild.required<ElementRef<HTMLDivElement>>('zoomDockEl');
  readonly infoDockEl = viewChild.required<ElementRef<HTMLDivElement>>('infoDockEl');

  readonly selectedVessel = signal<VesselProperties | null>(null);
  readonly selectedLightning = signal<LightningProperties | null>(null);
  readonly selectedAlert = signal<AlertProperties | null>(null);
  readonly selectedBuoy = signal<BuoyProperties | null>(null);
  readonly selectedBuoyObs = signal<BuoyObservationProperties | null>(null);
  readonly attrOpen = signal(false);
  /** Legend drawer state — défaut open sur desktop, closed sur mobile (≤ 760px).
      Sur desktop le bouton n'apparaît pas (CSS @media display:none) donc la
      legend reste toujours visible — l'état du signal n'a aucun effet. */
  readonly legendOpen = signal(typeof window !== 'undefined' ? window.innerWidth > 760 : true);
  // ─── V2 Phase 1 (2026-05-12) — Data catalog accordion sections ─────
  // 4 sections pliables avec icône colorée et compteur de layers actifs.
  // Persistance localStorage indépendante des layer prefs. Défaut :
  // Maritime ouvert, Observation/Forecast/Sources fermés (économie scroll
  // au boot, tout reste accessible en 1 click).
  readonly catalogSections = signal<Record<'maritime' | 'observation' | 'forecast' | 'hydrology' | 'sources', boolean>>(this.loadCatalogSections());
  readonly hasPopup = computed(() =>
    this.selectedVessel() !== null
    || this.selectedLightning() !== null
    || this.selectedAlert() !== null
    || this.selectedBuoy() !== null
    || this.selectedMetar() !== null
    || this.selectedHubeau() !== null
    || this.selectedQuake() !== null
    || this.selectedPiezo() !== null
    || this.selectedFirms() !== null,
  );
  readonly vesselsCount = signal(0);
  readonly tracksCount = signal(0);
  readonly lastRefreshAt = signal<Date | null>(null);
  readonly errorMsg = signal<string | null>(null);
  // Flash "copié" sur le badge erreur 2s après le click clipboard.
  readonly errorCopied = signal(false);

  /** Set errorMsg + log dans console.error pour debug DevTools. */
  private setError(msg: string, original?: unknown): void {
    this.errorMsg.set(msg);
    // eslint-disable-next-line no-console
    console.error('[map]', msg, original ?? '');
  }

  /** Copie le message d'erreur courant au clipboard, flash 'copié' 2s. */
  copyErrorToClipboard(): void {
    const msg = this.errorMsg();
    if (!msg) return;
    void navigator.clipboard.writeText(msg).then(() => {
      this.errorCopied.set(true);
      setTimeout(() => this.errorCopied.set(false), 2000);
    });
  }

  // ─── Animation v2 phase 1 — registry des layers animables ────────
  // Catalogue déclaratif des layers qui ont une dimension temporelle
  // utile pour l'animation. Pour chaque entry :
  //   - active() : signal getter — true si layer allumé par l'user
  //   - type : 'wms' (utilise GetCapabilities) ou 'vector' (scan 30min)
  //   - gsLayerName : nom GeoServer pour les capabilities WMS
  // L'ordre de cette liste sert de tiebreaker quand 2 layers s'allument
  // simultanément (rare). Le master réel = premier dans activationOrder.
  private readonly animatableLayers: ReadonlyArray<{
    key: string;
    label: string;
    type: 'wms' | 'vector';
    gsLayerName?: string;
    active: () => boolean;
  }> = [
    { key: 'wind',      label: 'Vent',     type: 'wms',    gsLayerName: 'maritime:wind-speed',     active: () => this.showWind() },
    { key: 'waves',     label: 'Vagues',   type: 'wms',    gsLayerName: 'maritime:wave-hs',        active: () => this.showWaves() },
    { key: 'sst',       label: 'SST',      type: 'wms',    gsLayerName: 'maritime:sst-daily',      active: () => this.showSST() },
    { key: 'vessels',   label: 'Navires AIS', type: 'vector',                                       active: () => this.showVessels() },
    { key: 'lightning', label: 'Foudre',   type: 'vector',                                          active: () => this.showLightning() },
    { key: 'metar',     label: 'METAR',    type: 'vector',                                          active: () => this.showMetar() },
    { key: 'firms',     label: 'FIRMS',    type: 'vector',                                          active: () => this.showFirms() },
    { key: 'quakes',    label: 'Séismes',  type: 'vector',                                          active: () => this.showQuakes() },
  ];

  /** Stack ordonné des layers allumés (ordre d'activation user). Maintenu
   *  par effect() depuis les show* signals. La tête = master du temps. */
  readonly activationOrder = signal<string[]>([]);
  readonly masterLayerKey = computed<string | null>(() => this.activationOrder()[0] ?? null);
  readonly masterLayerLabel = computed<string | null>(() => {
    const key = this.masterLayerKey();
    return key ? this.animatableLayers.find((l) => l.key === key)?.label ?? null : null;
  });

  // 2026-05-17 (Sylvain refacto navigation time-bar par validité) : liste
  // des timestamps publiés par le master du temps. Drive les boutons
  // ⏪︎/⏩︎ (validité précédente/suivante) et ⏮︎/⏭︎ (extrême passé/futur).
  // Mise à jour via effect quand master ou sliderConfig change (cf
  // refreshMasterValidityList in constructor effect block).
  readonly masterValidityList = signal<Date[]>([]);

  // Toggles user — par défaut tout visible (sauf rain/wind/waves : opt-in
  // pour éviter d'écraser l'image avec des tiles tant que pas demandé)
  readonly showVessels = signal(true);
  readonly showTracks = signal(true);
  readonly showSST = signal(true);
  readonly showRain = signal(false);
  readonly showWind = signal(false);
  readonly showWaves = signal(false);
  // Sprint 11 + Europe Chantier #2 : choix du modèle météo pour le vent.
  // 'gfs' = NOAA 25km (défaut, dispo immédiatement, couverture monde).
  // 'arpege' = Météo-France 0.1° ≈ 11km (Europe étroite, 2.5× plus fin que
  // GFS, dispo ~3h après chaque run). ARPEGE remplace l'ex-AROME 0.025° FR
  // qui était trop restreint pour la bbox Europe.
  // Le toggle pilote à la fois le layer WMS (maritime:wind-speed vs
  // maritime:wind-speed-arpege) ET les arrows GeoJSON (wind_arrows_*.geojson
  // vs arpege_wind_arrows_*.geojson).
  readonly windSource = signal<'gfs' | 'arpege' | 'arome'>('gfs');
  /** Label long affiché dans la légende sous "Vent". */
  readonly windSourceLabel = computed(() => {
    switch (this.windSource()) {
      case 'arpege': return 'forecast 10m (ARPEGE 11km)';
      case 'arome':  return 'forecast 10m (AROME 2.5km, FR)';
      default:       return 'forecast 10m (GFS 25km)';
    }
  });
  /** Label court affiché dans la cellule "Vent flèches". */
  readonly windSourceShortLabel = computed(() => {
    switch (this.windSource()) {
      case 'arpege': return 'ARPEGE';
      case 'arome':  return 'AROME';
      default:       return 'GFS';
    }
  });
  readonly showWindArrows = signal(false);
  readonly showWaveArrows = signal(false);
  readonly windArrowsStatus = signal('forecast vent');
  readonly waveArrowsStatus = signal('vagues primaires (WW3)');
  readonly showLightning = signal(false);
  readonly lightningStatus = signal('strikes 30min (Blitzortung)');
  readonly showAlerts = signal(false);
  readonly alertsStatus = signal('alertes maritimes 1h');
  readonly alertsList = this.alertsSvc.latestAlerts;
  readonly showWindParticles = signal(false);
  readonly windParticlesStatus = signal('animation flux vent');
  // Plateformes vagues EMODnet Physics (Chantier Europe #3) — référentiel
  // WFS Europe-wide (~28 plateformes bbox étroite, agrégées via les data
  // owners nationaux). Pas d'obs temps réel dans le MVP — popup expose les
  // métadonnées + lien NetCDF source.
  readonly showBuoys = signal(false);
  readonly buoysStatus = signal('plateformes vagues (EMODnet)');
  // ─── V2 Isolignes (2026-05-12) — sous-toggle par raster ───────────
  // Pattern : GeoServer expose des styles `<layer>-with-contours` qui font
  // raster + ras:Contour avec interval depuis env var. Le frontend swap
  // STYLES + env=contourInterval:N à la volée.
  readonly showSstContours = signal(false);
  readonly sstContourInterval = signal(2);   // °C
  readonly showWaveContours = signal(false);
  readonly waveContourInterval = signal(0.5); // m
  readonly showWindContours = signal(false);
  readonly windContourInterval = signal(5);   // m/s
  // ─── V2 Observation #1 (2026-05-12) — METAR ────────────────────────
  // ~35 aéroports européens, refresh 60s côté front, données ingérées
  // par orchestrator (source `metar-fetcher-eu`, NOAA AWC, cron 30min).
  readonly showMetar = signal(false);
  readonly metarStatus = signal('observations aéroports (NOAA)');
  // ─── V2 Hydrologie #1 (2026-05-12) — Hub'eau débits FR ─────────────
  // ~500 stations France actives par cycle (sur ~1500 total). Orchestrator
  // cron 15min, refresh frontend 60s.
  readonly showHubeau = signal(false);
  readonly hubeauStatus = signal('débits rivières (Hub\'eau FR)');
  // ─── V2 Observation #2 (2026-05-12) — Séismes USGS ─────────────────
  // Feed all_day USGS, proxy NestJS cache 5min, refresh frontend 5min.
  // Pas d'ingestion DB (data ephemeral 24h, déjà GeoJSON natif).
  readonly showQuakes = signal(false);
  readonly quakesStatus = signal('séismes 24h (USGS)');
  // ─── V2 Hydrologie #2 — Hub'eau piézomètres (nappes) ───────────────
  readonly showPiezo = signal(false);
  readonly piezoStatus = signal('niveaux piézo (Hub\'eau)');
  // ─── V2 Observation #3 (2026-05-12) — Feux NASA FIRMS ──────────────
  readonly showFirms = signal(false);
  readonly firmsStatus = signal('feux MODIS 24h (FIRMS)');
  // ─── V2 Sources #1 — Basemap switcher ───────────────────────────
  readonly basemap = signal<'dark' | 'voyager' | 'light' | 'satellite' | 'osm'>(this.loadBasemap());
  readonly basemapLabel = computed(() => {
    switch (this.basemap()) {
      case 'voyager':   return 'Voyager (clair)';
      case 'light':     return 'Clair';
      case 'satellite': return 'Satellite (ESRI)';
      case 'osm':       return 'OpenStreetMap';
      default:          return 'Sombre (CARTO)';
    }
  });
  // ─── V2 Sources #2 — Bathymétrie EMODnet WMS ────────────────────
  readonly showBathy = signal(false);
  // ─── V2 Sources #3 — EEZ Marine Regions ─────────────────────────
  readonly showEez = signal(false);
  // ─── V2 Sources #4 — MPA EMODnet Human Activities ───────────────
  readonly showMpa = signal(false);
  // ─── V2 Hydrologie #3 — Prévisions crues EFAS Copernicus ────────
  readonly showEfas = signal(false);

  // ─── Smart time slider — Phase 1 (2026-05-14) ───────────────────────
  //
  // Chaque layer déclare son profil temporel : granularité native +
  // fenêtre passé/futur pertinente. Le slider drive `stepMs` et
  // `[minTime, maxTime]` en fonction des layers actifs (max futurH +
  // max pastH + min stepH). Affiche un statusLabel "Δ 6h • -24h → +72h".
  //
  // - kind 'live' : data temps réel (pas de slider utile)
  // - kind 'obs' : observations rolling N heures dans le passé
  // - kind 'forecast' : modèle prévisionnel future + parfois passé
  private readonly LAYER_PROFILES: Record<string, { kind: 'live' | 'obs' | 'forecast'; stepH: number; pastH: number; futureH: number }> = {
    // vessels/lightning/alerts/buoys : live AIS/Blitzortung. Retention DB
    // 1j depuis 2026-05-15 → scrub utile sur les dernières 24h pour replay.
    vessels:       { kind: 'live',     stepH: 0,  pastH: 24,  futureH: 0 },
    tracks:        { kind: 'obs',      stepH: 1,  pastH: 24,  futureH: 0 },
    alerts:        { kind: 'live',     stepH: 0,  pastH: 24,  futureH: 0 },
    buoys:         { kind: 'live',     stepH: 0,  pastH: 24,  futureH: 0 },
    lightning:     { kind: 'live',     stepH: 0,  pastH: 24,  futureH: 0 },
    metar:         { kind: 'obs',      stepH: 1,  pastH: 6,   futureH: 0 },
    hubeau:        { kind: 'obs',      stepH: 1,  pastH: 24,  futureH: 0 },
    piezo:         { kind: 'obs',      stepH: 1,  pastH: 24,  futureH: 0 },
    quakes:        { kind: 'obs',      stepH: 1,  pastH: 24,  futureH: 0 },
    firms:         { kind: 'obs',      stepH: 1,  pastH: 24,  futureH: 0 },
    rain:          { kind: 'live',     stepH: 0,  pastH: 2,   futureH: 0 },
    // SST : observation NOAA OISST quotidienne, lag publication 14-21j (cf
    // sst-fetcher v2-prelim). Retention 7j → fenêtre scrub -7j. kind 'obs'
    // (et pas 'forecast' qui était une erreur 2026-05-15) → l'effect
    // cursor-snap V2.1 recule d'1 tick (24h) pour pointer la donnée la
    // plus récente factuellement disponible, pas un timestep futur vide.
    sst:           { kind: 'obs',      stepH: 24, pastH: 168, futureH: 0 },
    // Wind/Wave : forecast GFS/ARPEGE/AROME/WW3 jusqu'à 7j (weather-fetcher*
    // WEATHER_RETENTION_DAYS=7). futureH 72→168 pour aligner sur cette
    // couverture réelle (2026-05-16).
    wind:          { kind: 'forecast', stepH: 6,  pastH: 0,   futureH: 168 },
    waves:         { kind: 'forecast', stepH: 6,  pastH: 0,   futureH: 168 },
    windArrows:    { kind: 'forecast', stepH: 6,  pastH: 0,   futureH: 168 },
    waveArrows:    { kind: 'forecast', stepH: 6,  pastH: 0,   futureH: 168 },
    windParticles: { kind: 'forecast', stepH: 6,  pastH: 0,   futureH: 168 },
  };

  /** Computed : drive l'input du time-slider selon les layers actifs.
   *  - minTime/maxTime : bornes du slider (now - maxPastH ... now + maxFutureH)
   *  - stepMs : granularité min (drive snap + step buttons)
   *  - label : monospace status "Δ 6h • -24h → +72h" ou "LIVE" */
  readonly sliderConfig = computed(() => {
    const active: string[] = [];
    if (this.showVessels())       active.push('vessels');
    if (this.showTracks())        active.push('tracks');
    if (this.showAlerts())        active.push('alerts');
    if (this.showBuoys())         active.push('buoys');
    if (this.showLightning())     active.push('lightning');
    if (this.showMetar())         active.push('metar');
    if (this.showHubeau())        active.push('hubeau');
    if (this.showPiezo())         active.push('piezo');
    if (this.showQuakes())        active.push('quakes');
    if (this.showFirms())         active.push('firms');
    if (this.showRain())          active.push('rain');
    if (this.showSST())           active.push('sst');
    if (this.showWind())          active.push('wind');
    if (this.showWaves())         active.push('waves');
    if (this.showWindArrows())    active.push('windArrows');
    if (this.showWaveArrows())    active.push('waveArrows');
    if (this.showWindParticles()) active.push('windParticles');

    // Pattern adaptive (cf mémoire adaptive_time_slider_pattern.md) :
    // la plage min/max + step + label sont dérivés des layers actifs.
    // Chaque LAYER_PROFILES définit pastH/futureH/stepH ; on agrège en
    // UNION (max des windows) + min des steps (granularité fine).
    //
    // Le hardcodage -1j/+7j (Sylvain 2026-05-15 phase 1) cassait ce
    // pattern — reverted 2026-05-16. La plage doit refléter ce que les
    // layers actifs peuvent réellement servir, pas une fenêtre arbitraire.
    const profiles = active.map((k) => this.LAYER_PROFILES[k]).filter(Boolean);
    const now = Date.now();
    if (profiles.length === 0) {
      // Aucun layer actif → plage de courtoisie ±6h pour ne pas collapser le slider.
      // Step = 30min en fallback (Sylvain 2026-05-17 : "arrondi à la demi heure près").
      return {
        minTime: new Date(now - 6 * 3_600_000),
        maxTime: new Date(now + 6 * 3_600_000),
        stepMs: 30 * 60_000,
        label: '',
      };
    }
    const maxPastH = Math.max(0, ...profiles.map((p) => p.pastH));
    const maxFutureH = Math.max(0, ...profiles.map((p) => p.futureH));
    const stepHs = profiles.filter((p) => p.stepH > 0).map((p) => p.stepH);
    const stepH = stepHs.length === 0 ? 1 : Math.min(...stepHs);
    const allLive = profiles.every((p) => p.kind === 'live');

    // Garantit au moins ±6h de range pour éviter slider quasi-collapsé.
    const padH = 6;
    return {
      minTime: new Date(now - Math.max(maxPastH, padH) * 3_600_000),
      maxTime: new Date(now + Math.max(maxFutureH, padH) * 3_600_000),
      stepMs: stepH * 3_600_000,
      label: allLive
        ? 'LIVE — pas de scrub utile'
        : `Δ ${stepH}h${maxPastH > 0 ? ` • -${maxPastH}h` : ''}${maxFutureH > 0 ? ` → +${maxFutureH}h` : ''}`,
    };
  });

  /** Cap UX 5 layers actifs simultanément (Sylvain 2026-05-16). Au-delà,
   *  l'activation est refusée + toast 3s. Le user doit décocher un layer
   *  avant d'en activer un autre. NB : le concept de "maître du temps"
   *  est déjà géré via activationOrder + masterLayerKey ligne ~2335 (avec
   *  l'effect réconciliateur sur animatableLayers). */
  private readonly MAX_ACTIVE_LAYERS = 5;
  readonly cap5Warning = signal<string | null>(null);

  readonly activeLayersCount = computed(() => {
    let n = 0;
    if (this.showVessels())       n++;
    if (this.showTracks())        n++;
    if (this.showAlerts())        n++;
    if (this.showBuoys())         n++;
    if (this.showLightning())     n++;
    if (this.showMetar())         n++;
    if (this.showHubeau())        n++;
    if (this.showPiezo())         n++;
    if (this.showQuakes())        n++;
    if (this.showFirms())         n++;
    if (this.showRain())          n++;
    if (this.showSST())           n++;
    if (this.showWind())          n++;
    if (this.showWaves())         n++;
    if (this.showWindArrows())    n++;
    if (this.showWaveArrows())    n++;
    if (this.showWindParticles()) n++;
    return n;
  });

  /** Intercepte les clicks sur les checkboxes du panneau legend. Si on
   *  tente d'activer un (N+1)e layer alors qu'on est déjà au cap, on
   *  revert target.checked AVANT que le (change) handler ne tourne
   *  (l'ordre DOM est click → input → change → user code). */
  onLegendClick(e: Event): void {
    const target = e.target;
    if (!(target instanceof HTMLInputElement) || target.type !== 'checkbox') return;
    // target.checked = nouvel état après le toggle natif. On bloque
    // uniquement si l'utilisateur essaie d'ACTIVER (true) au-dessus du cap.
    if (target.checked && this.activeLayersCount() >= this.MAX_ACTIVE_LAYERS) {
      target.checked = false;
      this.cap5Warning.set(`Maximum ${this.MAX_ACTIVE_LAYERS} layers actifs simultanément — désactive-en un d'abord.`);
      setTimeout(() => this.cap5Warning.set(null), 3000);
    }
  }

  /** Palette des sous-barres coverage (Sylvain 2026-05-16, time-bar expandable
   *  V1). Couleurs cohérentes avec les pictos legend (cyan vessels, ambre
   *  lightning, etc.). V1 = rectangle continu pastH→futureH ; V2 ajoutera
   *  les timesteps réels via WMS GetCapabilities / WFS DISTINCT. */
  private readonly LAYER_COLORS: Record<string, string> = {
    vessels:       '#0ea5e9', // cyan
    tracks:        '#06b6d4',
    alerts:        '#dc2626', // rouge
    buoys:         '#f59e0b', // ambre
    lightning:     '#fde047', // jaune électrique
    metar:         '#a78bfa', // violet
    hubeau:        '#3b82f6', // bleu
    piezo:         '#22d3ee',
    quakes:        '#ef4444',
    firms:         '#f97316',
    rain:          '#60a5fa',
    sst:           '#fb923c', // orange chaud
    wind:          '#10b981', // vert
    waves:         '#06b6d4', // cyan
    windArrows:    '#34d399',
    waveArrows:    '#67e8f9',
    windParticles: '#86efac',
  };

  readonly sliderLayerCoverage = computed((): TimeSliderLayerCoverage[] => {
    const out: TimeSliderLayerCoverage[] = [];
    const push = (active: boolean, key: keyof typeof this.LAYER_PROFILES, label: string) => {
      if (!active) return;
      const p = this.LAYER_PROFILES[key];
      if (!p || (p.pastH === 0 && p.futureH === 0)) return;
      out.push({ name: label, color: this.LAYER_COLORS[key] ?? '#94a3b8', pastH: p.pastH, futureH: p.futureH });
    };
    push(this.showVessels(),       'vessels',       'vessels');
    push(this.showTracks(),        'tracks',        'tracks');
    push(this.showAlerts(),        'alerts',        'alerts');
    push(this.showBuoys(),         'buoys',         'buoys');
    push(this.showLightning(),     'lightning',     'lightning');
    push(this.showMetar(),         'metar',         'metar');
    push(this.showHubeau(),        'hubeau',        'hubeau');
    push(this.showPiezo(),         'piezo',         'piezo');
    push(this.showQuakes(),        'quakes',        'quakes');
    push(this.showFirms(),         'firms',         'firms');
    push(this.showRain(),          'rain',          'rain');
    push(this.showSST(),           'sst',           'sst');
    push(this.showWind(),          'wind',          'wind');
    push(this.showWaves(),         'waves',         'waves');
    push(this.showWindArrows(),    'windArrows',    'wind-arrows');
    push(this.showWaveArrows(),    'waveArrows',    'wave-arrows');
    push(this.showWindParticles(), 'windParticles', 'wind-particles');
    return out;
  });

  // ─── Sprint Layer UX V2 — Phase A : opacity per layer + persist ──────
  //
  // Clé `LayerKey` = identifiant interne unique par couche pour stocker
  // l'opacité + (Phase C) la visibilité + (Phase D) la palette en DB user.
  // Defaults : 1.0 pour vector layers (lisibilité), 0.7 pour rasters
  // (SST/vent/vagues — meilleur blend visuel avec le fond carto).
  readonly layerOpacities = signal<Record<string, number>>({
    vessels: 1, tracks: 1, alerts: 1, buoys: 1, metar: 1, hubeau: 1, quakes: 1, piezo: 1, firms: 1, eez: 0.6, mpa: 0.6,
    sst: 0.7, waves: 0.7, waveArrows: 0.9,
    wind: 0.7, windArrows: 0.9, windParticles: 0.9,
    rain: 0.8, lightning: 0.9,
  });

  /** Defaults visibility — utilisés par resetLayerPrefs() pour restaurer. */
  private readonly DEFAULT_VISIBILITY: Record<string, boolean> = {
    vessels: true, tracks: true, sst: true,
    rain: false, wind: false, waves: false,
    windArrows: false, waveArrows: false,
    lightning: false, alerts: false,
    windParticles: false, buoys: false, metar: false, hubeau: false, quakes: false, piezo: false, firms: false,
    bathy: false, eez: false, mpa: false, efas: false,
  };
  private readonly DEFAULT_OPACITIES = { ...this.layerOpacities() };

  /** Read opacity for a given layer key (template helper). */
  getOpacity(key: string): number {
    return this.layerOpacities()[key] ?? 1;
  }

  /** Set opacity for a given layer + apply to OL layer + persist localStorage. */
  setOpacity(key: string, value: number): void {
    const clamped = Math.max(0, Math.min(1, value));
    this.layerOpacities.update((m) => ({ ...m, [key]: clamped }));
    this.applyLayerOpacity(key, clamped);
    this.persistLayerPrefs();
  }

  /** Apply opacity to the corresponding OL layer instance. Called after
      signal update + at boot once layers are initialized. */
  private applyLayerOpacity(key: string, value: number): void {
    const layer = ({
      vessels: this.vesselLayer,
      tracks: this.trackLayer,
      sst: this.sstLayer,
      rain: this.rainLayer,
      wind: this.windLayer,
      waves: this.wavesLayer,
      windArrows: this.windArrowsLayer,
      waveArrows: this.waveArrowsLayer,
      lightning: this.lightningLayer,
      alerts: this.alertsLayer,
      buoys: this.buoysLayer,
      metar: this.metarLayer,
      hubeau: this.hubeauLayer,
      quakes: this.quakesLayer,
      piezo: this.piezoLayer,
      firms: this.firmsLayer,
      eez: this.eezLayer,
      mpa: this.mpaLayer,
    } as Record<string, { setOpacity: (n: number) => void } | undefined>)[key];
    layer?.setOpacity(value);
    // Wind particles = canvas overlay, opacity réglée via CSS sur le
    // canvas element (signal séparé pour ne pas casser le rendering loop).
    if (key === 'windParticles') {
      const c = this.particlesEl()?.nativeElement;
      if (c) c.style.opacity = String(value);
    }
  }

  /** Apply all opacities to OL layers (boot time + layer recreations). */
  applyAllLayerOpacities(): void {
    const m = this.layerOpacities();
    for (const k of Object.keys(m)) this.applyLayerOpacity(k, m[k]);
  }

  // ─── V2 Phase 1 (2026-05-12) — Data catalog accordion helpers ─────
  /** Restore l'état pli/déplié des sections du data catalog. Stocké
   *  séparément des layer prefs pour pouvoir resetter l'un sans l'autre. */
  private loadCatalogSections(): Record<'maritime' | 'observation' | 'forecast' | 'hydrology' | 'sources', boolean> {
    const defaults = { maritime: true, observation: false, forecast: false, hydrology: false, sources: false };
    try {
      const raw = localStorage.getItem('maritime.catalog-sections-v1');
      if (!raw) return defaults;
      const parsed = JSON.parse(raw) as Partial<typeof defaults>;
      // V2 (2026-05-12) strict accordion : force 1 tiroir max ouvert.
      // Si le localStorage a plusieurs `true` (legacy state), on garde le
      // 1er trouvé selon l'ordre canonique et on ferme tous les autres.
      const order: Array<keyof typeof defaults> = ['maritime', 'observation', 'forecast', 'hydrology', 'sources'];
      const merged = { ...defaults, ...parsed };
      const firstOpen = order.find((k) => merged[k]);
      const next = { maritime: false, observation: false, forecast: false, hydrology: false, sources: false };
      if (firstOpen) next[firstOpen] = true;
      else next.maritime = true;
      return next;
    } catch {
      return defaults;
    }
  }

  /** V2 (2026-05-12) : accordion strict — un seul tiroir ouvert à la fois.
   *  Si on clique sur une section déjà ouverte → on la ferme. Si on clique
   *  une fermée → on l'ouvre et on ferme toutes les autres. */
  toggleCatalogSection(key: 'maritime' | 'observation' | 'forecast' | 'hydrology' | 'sources'): void {
    this.catalogSections.update((m) => {
      const wasOpen = m[key];
      const next: typeof m = { maritime: false, observation: false, forecast: false, hydrology: false, sources: false };
      next[key] = !wasOpen;
      try { localStorage.setItem('maritime.catalog-sections-v1', JSON.stringify(next)); } catch {}
      return next;
    });
  }

  /** Compte les layers actifs par section. Affiché en badge dans le head. */
  catalogSectionCount(key: 'maritime' | 'observation' | 'forecast' | 'hydrology' | 'sources'): { active: number; total: number } {
    if (key === 'maritime') {
      const flags = [this.showVessels(), this.showTracks(), this.showAlerts(), this.showBuoys(),
                     this.showSST(), this.showWaves(), this.showWaveArrows()];
      return { active: flags.filter(Boolean).length, total: flags.length };
    }
    if (key === 'observation') {
      const flags = [this.showLightning(), this.showRain(), this.showMetar(), this.showQuakes(), this.showFirms()];
      return { active: flags.filter(Boolean).length, total: flags.length };
    }
    if (key === 'forecast') {
      const flags = [this.showWind(), this.showWindArrows(), this.showWindParticles()];
      return { active: flags.filter(Boolean).length, total: flags.length };
    }
    if (key === 'hydrology') {
      const flags = [this.showHubeau(), this.showPiezo()];
      return { active: flags.filter(Boolean).length, total: flags.length };
    }
    if (key === 'sources') {
      // Le basemap est tjs "actif" (toujours un fond), donc on compte 1 fixe
      // + les WMS sources optionnels.
      const flags = [this.showBathy(), this.showEez(), this.showMpa()];
      return { active: 1 + flags.filter(Boolean).length, total: 1 + flags.length };
    }
    return { active: 0, total: 0 };
  }

  /** Persist + reload basemap config. Stored separately from layer prefs. */
  private loadBasemap(): 'dark' | 'voyager' | 'light' | 'satellite' | 'osm' {
    try {
      const v = localStorage.getItem('maritime.basemap');
      if (v && ['dark', 'voyager', 'light', 'satellite', 'osm'].includes(v)) {
        return v as 'dark' | 'voyager' | 'light' | 'satellite' | 'osm';
      }
    } catch {}
    return 'dark';
  }

  setBasemap(key: 'dark' | 'voyager' | 'light' | 'satellite' | 'osm'): void {
    this.basemap.set(key);
    try { localStorage.setItem('maritime.basemap', key); } catch {}
    this.applyBasemap();
  }

  /** Reconstruit les sources XYZ de baseTile + labelsTile selon basemap(). */
  private applyBasemap(): void {
    if (!this.baseTile) return;
    const key = this.basemap();
    const ATTRIB_CARTO = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, © <a href="https://carto.com/attributions">CARTO</a>';
    const ATTRIB_ESRI = 'Tiles © <a href="https://www.esri.com/">Esri</a>, Maxar, GeoEye, Earthstar Geographics';
    const ATTRIB_OSM = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
    const cfg: Record<typeof key, { url: string; attr: string; labelStyle?: string }> = {
      dark:      { url: '/carto-tiles/dark_nolabels/{z}/{x}/{y}.png',     attr: ATTRIB_CARTO, labelStyle: 'dark_only_labels' },
      voyager:   { url: '/carto-tiles/voyager_nolabels/{z}/{x}/{y}.png',  attr: ATTRIB_CARTO, labelStyle: 'voyager_only_labels' },
      light:     { url: '/carto-tiles/light_nolabels/{z}/{x}/{y}.png',    attr: ATTRIB_CARTO, labelStyle: 'light_only_labels' },
      satellite: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', attr: ATTRIB_ESRI },
      osm:       { url: 'https://{a-c}.tile.openstreetmap.org/{z}/{x}/{y}.png', attr: ATTRIB_OSM },
    };
    const c = cfg[key];
    this.baseTile.setSource(new XYZ({ url: c.url, attributions: c.attr, maxZoom: 19 }));
    if (this.labelsTile) {
      if (c.labelStyle) {
        this.labelsTile.setSource(new XYZ({
          url: `/carto-tiles/${c.labelStyle}/{z}/{x}/{y}.png`,
          attributions: '', maxZoom: 19,
        }));
        this.labelsTile.setVisible(true);
      } else {
        // Satellite / OSM ont déjà leurs labels embedded
        this.labelsTile.setVisible(false);
      }
    }
  }

  /** Reset all layer prefs to app defaults (visibility + opacity + clear
      localStorage). Triggered by the legend "Reset" button. */
  resetLayerPrefs(): void {
    this.showVessels.set(this.DEFAULT_VISIBILITY['vessels']);
    this.showTracks.set(this.DEFAULT_VISIBILITY['tracks']);
    this.showSST.set(this.DEFAULT_VISIBILITY['sst']);
    this.showRain.set(this.DEFAULT_VISIBILITY['rain']);
    this.showWind.set(this.DEFAULT_VISIBILITY['wind']);
    this.showWaves.set(this.DEFAULT_VISIBILITY['waves']);
    this.showWindArrows.set(this.DEFAULT_VISIBILITY['windArrows']);
    this.showWaveArrows.set(this.DEFAULT_VISIBILITY['waveArrows']);
    this.showLightning.set(this.DEFAULT_VISIBILITY['lightning']);
    this.showAlerts.set(this.DEFAULT_VISIBILITY['alerts']);
    this.showWindParticles.set(this.DEFAULT_VISIBILITY['windParticles']);
    this.showBuoys.set(this.DEFAULT_VISIBILITY['buoys']);
    this.showMetar.set(this.DEFAULT_VISIBILITY['metar']);
    this.showHubeau.set(this.DEFAULT_VISIBILITY['hubeau']);
    this.showQuakes.set(this.DEFAULT_VISIBILITY['quakes']);
    this.showPiezo.set(this.DEFAULT_VISIBILITY['piezo']);
    this.showFirms.set(this.DEFAULT_VISIBILITY['firms']);
    this.showBathy.set(this.DEFAULT_VISIBILITY['bathy']);
    this.showEez.set(this.DEFAULT_VISIBILITY['eez']);
    this.showMpa.set(this.DEFAULT_VISIBILITY['mpa']);
    this.showEfas.set(this.DEFAULT_VISIBILITY['efas']);
    this.layerOpacities.set({ ...this.DEFAULT_OPACITIES });
    this.applyAllLayerOpacities();
    this.applyLayerVisibility();
    try { localStorage.removeItem(LAYER_PREFS_KEY); } catch {}
  }

  /** Persist current layer prefs to localStorage. Phase C.2 (2026-05-12) :
      si user connecté, push aussi vers DB (debounced 500ms). LocalStorage
      reste la source canonique pour les anonymes + le boot. */
  private persistLayerPrefs(): void {
    const visibility = {
      vessels: this.showVessels(),
      tracks: this.showTracks(),
      sst: this.showSST(),
      rain: this.showRain(),
      wind: this.showWind(),
      waves: this.showWaves(),
      windArrows: this.showWindArrows(),
      waveArrows: this.showWaveArrows(),
      lightning: this.showLightning(),
      alerts: this.showAlerts(),
      windParticles: this.showWindParticles(),
      buoys: this.showBuoys(),
      metar: this.showMetar(),
      hubeau: this.showHubeau(),
      quakes: this.showQuakes(),
      piezo: this.showPiezo(),
      firms: this.showFirms(),
      bathy: this.showBathy(),
      eez: this.showEez(),
      mpa: this.showMpa(),
      efas: this.showEfas(),
    };
    const opacity = this.layerOpacities();
    try {
      localStorage.setItem(LAYER_PREFS_KEY, JSON.stringify({ visibility, opacity }));
    } catch {
      // localStorage full / disabled — ignore, user reverra son default au reload
    }
    // Phase C.2 : sync DB debounced si connecté + fini de bootstrap.
    if (this.auth.isAuthenticated() && this.prefsBootstrapped) {
      const batch: Array<{ layerKind: string; visible: boolean; opacity: number }> = [];
      for (const [k, v] of Object.entries(visibility)) {
        batch.push({ layerKind: k, visible: v, opacity: opacity[k] ?? 1 });
      }
      this.prefsSync.schedulePushBatch(batch);
    }
  }

  /** Phase C.2 : merge DB prefs avec localStorage au boot/login. DB wins
   *  pour les layers où elle a une valeur ; localStorage en fallback. */
  private async mergePrefsFromDb(): Promise<void> {
    if (!this.auth.isAuthenticated()) return;
    const dbPrefs = await this.prefsSync.fetchMyPrefs();
    if (dbPrefs.length === 0) {
      // User connecté mais aucune pref DB → upload localStorage maintenant
      // pour qu'il retrouve son setup sur un autre device.
      this.prefsBootstrapped = true;
      this.persistLayerPrefs();
      return;
    }
    for (const p of dbPrefs) {
      if (p.visible !== null) {
        const setter = this.visibilitySetterFor(p.layerKind);
        if (setter) setter(p.visible);
      }
      if (p.opacity !== null) {
        this.layerOpacities.update((m) => ({ ...m, [p.layerKind]: p.opacity! }));
        // Apply à la layer OL (sinon le state signal change mais le layer reste).
        this.applyLayerOpacity(p.layerKind, p.opacity);
      }
    }
    this.prefsBootstrapped = true;
  }

  /** Flag : true après mergePrefsFromDb() ou si pas connecté. Évite de
   *  push vers DB pendant le restore initial (sinon on overwrite la DB
   *  avec les defaults pendant qu'on était en train de la lire). */
  private prefsBootstrapped = false;
  /** Flag : true après le 1er tick de l'effect auth (le 1er tick fire au
   *  boot du component, on doit le skipper pour pas re-déclencher
   *  mergePrefsFromDb() qui est déjà appelé par ngAfterViewInit). */
  private prefsAuthInitialized = false;

  /** Map layerKind → fonction setter de visibility signal. */
  private visibilitySetterFor(key: string): ((v: boolean) => void) | null {
    const map: Record<string, (v: boolean) => void> = {
      vessels: (v) => this.showVessels.set(v),
      tracks: (v) => this.showTracks.set(v),
      sst: (v) => this.showSST.set(v),
      rain: (v) => this.showRain.set(v),
      wind: (v) => this.showWind.set(v),
      waves: (v) => this.showWaves.set(v),
      windArrows: (v) => this.showWindArrows.set(v),
      waveArrows: (v) => this.showWaveArrows.set(v),
      lightning: (v) => this.showLightning.set(v),
      alerts: (v) => this.showAlerts.set(v),
      windParticles: (v) => this.showWindParticles.set(v),
      buoys: (v) => this.showBuoys.set(v),
      metar: (v) => this.showMetar.set(v),
      hubeau: (v) => this.showHubeau.set(v),
      quakes: (v) => this.showQuakes.set(v),
      piezo: (v) => this.showPiezo.set(v),
      firms: (v) => this.showFirms.set(v),
      bathy: (v) => this.showBathy.set(v),
      eez: (v) => this.showEez.set(v),
      efas: (v) => this.showEfas.set(v),
    };
    return map[key] ?? null;
  }

  /** Restore layer prefs from localStorage. Called at component init. */
  private restoreLayerPrefs(): void {
    try {
      const raw = localStorage.getItem(LAYER_PREFS_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      const vis = data?.visibility ?? {};
      if (typeof vis.vessels === 'boolean') this.showVessels.set(vis.vessels);
      if (typeof vis.tracks === 'boolean') this.showTracks.set(vis.tracks);
      if (typeof vis.sst === 'boolean') this.showSST.set(vis.sst);
      if (typeof vis.rain === 'boolean') this.showRain.set(vis.rain);
      if (typeof vis.wind === 'boolean') this.showWind.set(vis.wind);
      if (typeof vis.waves === 'boolean') this.showWaves.set(vis.waves);
      if (typeof vis.windArrows === 'boolean') this.showWindArrows.set(vis.windArrows);
      if (typeof vis.waveArrows === 'boolean') this.showWaveArrows.set(vis.waveArrows);
      if (typeof vis.lightning === 'boolean') this.showLightning.set(vis.lightning);
      if (typeof vis.alerts === 'boolean') this.showAlerts.set(vis.alerts);
      if (typeof vis.windParticles === 'boolean') this.showWindParticles.set(vis.windParticles);
      if (typeof vis.buoys === 'boolean') this.showBuoys.set(vis.buoys);
      if (typeof vis.metar === 'boolean') this.showMetar.set(vis.metar);
      if (typeof vis.hubeau === 'boolean') this.showHubeau.set(vis.hubeau);
      if (typeof vis.quakes === 'boolean') this.showQuakes.set(vis.quakes);
      if (typeof vis.piezo === 'boolean') this.showPiezo.set(vis.piezo);
      if (typeof vis.firms === 'boolean') this.showFirms.set(vis.firms);
      if (typeof vis.bathy === 'boolean') this.showBathy.set(vis.bathy);
      if (typeof vis.eez === 'boolean') this.showEez.set(vis.eez);
      if (typeof vis.efas === 'boolean') this.showEfas.set(vis.efas);
      const op = data?.opacity ?? {};
      this.layerOpacities.update((m) => ({ ...m, ...op }));
    } catch {
      // JSON corrupt → ignore, fall back to defaults
    }
  }

  // Mode courant (signal-driven, recalculé à chaque tick du time slider).
  // Sert à colorer les badges + griser les toggles dont la layer ne peut
  // PAS s'afficher dans le mode courant (ex: navires en futur, SST en futur).
  readonly currentTimeSig = signal<Date>(new Date());
  readonly modeIsLive = computed(() => Math.abs(Date.now() - this.currentTimeSig().getTime()) < LIVE_THRESHOLD_MS);
  readonly modeIsFuture = computed(() => this.currentTimeSig().getTime() > Date.now() + LIVE_THRESHOLD_MS);
  // "Active" = la couche a effectivement de quoi s'afficher dans le mode courant.
  readonly vesselsActive = computed(() => this.showVessels() && !this.modeIsFuture());
  readonly tracksActive  = computed(() => this.showTracks() && !this.modeIsLive() && !this.modeIsFuture());
  readonly sstActive     = computed(() => this.showSST() && !this.modeIsFuture());
  // Rain : RainViewer ne couvre que [-2h, +30min]. Hors fenêtre = inutile.
  readonly rainStatus    = signal('précipitations 10min');
  readonly rainActive    = computed(() => this.showRain() && this.rainHasFrameForCurrent());
  // Wind/Waves : forecast NOAA jusqu'à +72h. Pas de back-history (on garde
  // que les forecasts les plus récents). Donc visible si le cursor est
  // dans [run-1h, run+forecast_hours].
  readonly windActive    = computed(() => this.showWind());
  readonly wavesActive   = computed(() => this.showWaves());
  // Helper : true si une frame RainViewer est dispo pour le cursor courant.
  // Mis à jour à chaque tick via updateRainLayer().
  private rainHasFrame = signal(false);
  private rainHasFrameForCurrent(): boolean {
    return this.rainHasFrame();
  }

  // Catégories pour la légende
  readonly categories = (Object.keys(CATEGORY_COLOR) as Category[]).map((key) => ({
    key,
    color: CATEGORY_COLOR[key],
  }));

  private map?: Map;
  private vesselSource?: VectorSource;
  // Sprint Europe #4 : layer Vessels pointe sur `vesselClusterSource` (wrap
  // OL Cluster autour de vesselSource). vesselSource reste la source de
  // vérité alimentée par les services AIS, le Cluster source écoute ses
  // events et agrège automatiquement.
  private vesselClusterSource?: Cluster;
  private trackSource?: VectorSource;
  private vesselLayer?: VectorLayer<Cluster>;
  private trackLayer?: VectorLayer<VectorSource>;
  // Switched TileLayer/TileWMS → ImageLayer/ImageWMS pour rasters meteo
  // (2026-05-14). ImageWMS = 1 fetch par viewport au lieu de tiling →
  // marche nativement dans n'importe quelle projection (EPSG:3035 Lambert
  // notamment, où TileWMS gardait son TileGrid 3857 même avec `projection`
  // explicite → tiles mal positionnées). Tradeoff : pas de cache tile mais
  // pour 7 rasters maritime c'est marginal.
  private sstLayer?: ImageLayer<ImageWMS>;
  private sstSource?: ImageWMS;
  // 2026-05-17 perf : layer OL séparée pour les contours SST. Le SLD
  // sst-with-contours côté GS faisait 2× IDW factor=8 (raster + contours)
  // = 26s/req qui saturait le control-flow GS et faisait disparaître les
  // autres layers par timeout en cascade. Le nouveau SLD sst-contours-only
  // contient UNIQUEMENT le 2ème FeatureTypeStyle (IDWContour factor=4
  // + LineSymbolizer + labels). Mesuré : 6.6s → 1.1s (-83%).
  // La layer raster sstLayer reste affichée sous, sans swap STYLES.
  private sstContoursLayer?: ImageLayer<ImageWMS>;
  private sstContoursSource?: ImageWMS;
  private rainLayer?: TileLayer<XYZ>;
  private rainSource?: XYZ;
  private rainSnapshot?: RainViewerSnapshot;
  private rainSnapshotTimer?: ReturnType<typeof setInterval>;
  private currentRainPath?: string;
  private windLayer?: ImageLayer<ImageWMS>;
  // Renommé en sprint 11 (était `windSource`) pour libérer le nom au signal
  // user-facing `windSource: 'gfs' | 'arpege'`. Cette ref pointe vers le
  // ImageWMS du layer "Vent" — peu importe la source choisie, le LAYERS
  // param est mis à jour dynamiquement via updateParams().
  private windWmsSource?: ImageWMS;
  private wavesLayer?: ImageLayer<ImageWMS>;
  private wavesSource?: ImageWMS;
  private windArrowsLayer?: VectorLayer<VectorSource>;
  private windArrowsSource?: VectorSource;
  private waveArrowsLayer?: VectorLayer<VectorSource>;
  private waveArrowsSource?: VectorSource;
  private lastWindArrowsTs?: string;
  private lastWaveArrowsTs?: string;
  private arrowsFetchDebounce?: ReturnType<typeof setTimeout>;
  private lightningLayer?: VectorLayer<VectorSource>;
  private lightningSource?: VectorSource;
  private lightningTimer?: ReturnType<typeof setInterval>;
  private lightningSub?: Subscription;
  private alertsLayer?: VectorLayer<VectorSource>;
  private alertsSource?: VectorSource;
  private alertsTimer?: ReturnType<typeof setInterval>;
  private buoysLayer?: VectorLayer<VectorSource>;
  private buoysSource?: VectorSource;
  /** Cache des dernières observations indexées par candhis_id (popup lookup).
   * On utilise globalThis.Map car `Map` est shadowed par l'import OpenLayers. */
  private buoyObsByCandhisId: globalThis.Map<string, BuoyObservationProperties> =
    new (globalThis as any).Map();
  // ─── V2 Observation #1 (2026-05-12) — METAR aéroports ────────────
  private metarLayer?: VectorLayer<VectorSource>;
  private metarSource?: VectorSource;
  private metarTimer?: ReturnType<typeof setInterval>;
  readonly selectedMetar = signal<MetarProperties | null>(null);
  // ─── V2 Hydrologie #1 — Hub'eau débits FR ────────────────────────
  private hubeauLayer?: VectorLayer<VectorSource>;
  private hubeauSource?: VectorSource;
  private hubeauTimer?: ReturnType<typeof setInterval>;
  readonly selectedHubeau = signal<HubeauProperties | null>(null);
  // ─── V2 Observation #2 — Séismes USGS ────────────────────────────
  private quakesLayer?: VectorLayer<VectorSource>;
  private quakesSource?: VectorSource;
  private quakesTimer?: ReturnType<typeof setInterval>;
  readonly selectedQuake = signal<(QuakeProperties & { depth_km: number | null }) | null>(null);
  // ─── V2 Hydrologie #2 — Hub'eau piézomètres FR ────────────────────
  private piezoLayer?: VectorLayer<VectorSource>;
  private piezoSource?: VectorSource;
  private piezoTimer?: ReturnType<typeof setInterval>;
  readonly selectedPiezo = signal<PiezoProperties | null>(null);
  // ─── V2 Observation #3 — Feux NASA FIRMS ────────────────────────
  private firmsLayer?: VectorLayer<VectorSource>;
  private firmsSource?: VectorSource;
  private firmsTimer?: ReturnType<typeof setInterval>;
  readonly selectedFirms = signal<FirmsProperties | null>(null);
  // ─── V2 Sources / Hydro — Basemap + Bathy + EFAS (WMS direct) ───
  private baseTile?: TileLayer<XYZ>;
  private labelsTile?: TileLayer<XYZ>;
  private bathyLayer?: TileLayer<TileWMS>;
  private eezLayer?: TileLayer<TileWMS>;
  private mpaLayer?: TileLayer<TileWMS>;
  private efasLayer?: TileLayer<TileWMS>;
  private buoysRefTimer?: ReturnType<typeof setInterval>;
  private buoysObsTimer?: ReturnType<typeof setInterval>;
  private buoysRefSub?: Subscription;
  private buoysObsSub?: Subscription;
  private particlesEngine?: WindParticleEngine;
  private particlesCanvas?: HTMLCanvasElement;
  private popupOverlay?: Overlay;
  private liveSub?: Subscription;
  private trackSub?: Subscription;
  private pastVesselsSub?: Subscription;
  private currentTime: Date = new Date();
  private lastTrackDay: string | null = null;
  // Coalesce past-mode vessel fetches : si l'utilisateur drag rapidement
  // le slider, on n'envoie qu'une requête après ~150ms d'inactivité.
  private pastFetchDebounce?: ReturnType<typeof setTimeout>;
  // featureProjection DOIT matcher la View projection courante (sinon
  // features décodées en EPSG:3857 alors que View en EPSG:3035 → bug
  // wind-arrows mal placés en Lambert). On lazy-instancie via getter
  // pour récupérer la projection actuelle à chaque parse.
  private get geoJsonFmt(): GeoJSON {
    return new GeoJSON({
      featureProjection: this.map?.getView().getProjection() ?? 'EPSG:3857',
      dataProjection: 'EPSG:4326',
    });
  }

  constructor() {
    // Effect : maintient activationOrder à jour. À chaque changement de
    // toggle on diff l'ancien set vs nouveau ; push les nouveaux activés
    // en queue, retire les désactivés. Tête = master du temps.
    //
    // Note : `internalOrder` est local (pas de read du signal qu'on
    // écrit dans le même effect → évite dépendance circulaire) +
    // `allowSignalWrites: true` car Angular 18+ interdit set() depuis
    // effect par défaut (NG0600). Sans cette option, l'effect throw
    // silencieusement et activationOrder reste vide → masterLayerLabel
    // null → bloc « Maître du temps » absent de la modal (bug observé
    // Sylvain 2026-05-14).
    let prevActive = new Set<string>();
    let internalOrder: string[] = [];
    effect(() => {
      const currentActive = new Set<string>(
        this.animatableLayers.filter((l) => l.active()).map((l) => l.key),
      );
      let changed = false;
      // Désactivations : remove
      for (const key of prevActive) {
        if (!currentActive.has(key)) {
          const i = internalOrder.indexOf(key);
          if (i >= 0) {
            internalOrder.splice(i, 1);
            changed = true;
          }
        }
      }
      // Activations : append (tiebreaker = ordre du registry)
      for (const layer of this.animatableLayers) {
        if (currentActive.has(layer.key) && !prevActive.has(layer.key) && !internalOrder.includes(layer.key)) {
          internalOrder.push(layer.key);
          changed = true;
        }
      }
      if (changed) {
        this.activationOrder.set([...internalOrder]);
      }
      prevActive = currentActive;
    }, { allowSignalWrites: true });

    // V2.1 cursor snap selon maître du temps (Sylvain 2026-05-16). Quand
    // le master change (premier layer activé), on snap le cursor au timestep
    // le plus pertinent. Garde-fous :
    //  1. Pas pendant animation (animPlayer != idle)
    //  2. Pas si user a drag loin de now (>1h) — on respecte son intention
    //  3. Tracking prevMaster pour ne snap qu'au CHANGEMENT (pas à chaque tick)
    //  4. queueMicrotask pour respecter Angular signal-write rules
    let prevMaster: string | null = null;
    effect(() => {
      const masterKey = this.masterLayerKey();
      if (masterKey === prevMaster) return;
      prevMaster = masterKey;
      if (!masterKey) return;
      if (this.animPlayer.state() !== 'idle') return;

      const now = Date.now();
      const curT = this.currentTime?.getTime() ?? now;
      if (Math.abs(now - curT) > 3_600_000) return;  // user away from live → respect

      const profile = this.LAYER_PROFILES[masterKey];
      if (!profile) return;

      let target: Date;
      if (profile.kind === 'live') {
        target = new Date(now);
      } else if (profile.kind === 'obs' && profile.stepH > 0) {
        // Observation : recule d'un tick pour pointer la dernière data factuelle
        target = new Date(now - profile.stepH * 3_600_000);
      } else if (profile.stepH > 0) {
        // Forecast : snap au multiple stepMs ≤ now (frontière passé/futur)
        const stepMs = profile.stepH * 3_600_000;
        target = new Date(Math.floor(now / stepMs) * stepMs);
      } else {
        target = new Date(now);
      }
      queueMicrotask(() => this.onTimeChange(target));
    });

    // Effect réactif : à chaque changement de signal toggle, on ré-applique
    // la visibility des layers OL. Sans ça, cocher/décocher un toggle ne
    // déclenche aucune mise à jour côté Map (les layers OL ne sont pas
    // bound aux signals — ils sont créés impérativement dans initMap).
    effect(() => {
      // Read pour s'abonner — le get suffit avec signals
      this.showVessels(); this.showTracks(); this.showSST();
      this.showRain();    this.showWind();   this.showWaves();
      this.showWindArrows(); this.showWaveArrows();
      this.showLightning(); this.showAlerts(); this.showWindParticles();
      this.showBuoys(); this.showMetar(); this.showHubeau(); this.showQuakes(); this.showPiezo(); this.showFirms();
      this.showBathy(); this.showEez(); this.showMpa(); this.showEfas();
      // 2026-05-17 : showSstContours doit déclencher applyLayerVisibility()
      // pour activer sstContoursLayer.setVisible(true). Sans ce read ici,
      // l'effect ne se re-fire pas quand on toggle isolignes SST et la
      // layer contours dédiée reste invisible. (wave/wind contours toggles
      // STYLES sur la même source raster, donc visibility OL ne change pas
      // — pas besoin d'inclure leurs signals ici. À refactor demain.)
      this.showSstContours();
      // Defer pour s'exécuter après ngAfterViewInit (this.*Layer dispo)
      queueMicrotask(() => {
        this.applyLayerVisibility();
        // Si on vient d'activer un toggle arrows, déclenche un fetch
        if (this.showWindArrows() || this.showWaveArrows()) {
          this.refreshArrowsForTime(this.currentTime);
        }
        // Phase A : persiste les toggles à chaque changement (debounce
        // implicite via microtask). Au boot, ngAfterViewInit appelle
        // restoreLayerPrefs() AVANT cet effect, donc pas de race.
        // Phase C.2 : si user connecté, push aussi vers DB (debounced).
        this.persistLayerPrefs();
      });
    });

    // Phase C.2 (2026-05-12) : watch auth state pour login/logout in-session.
    // - Login → fetch DB prefs et merge (override les defaults localStorage)
    // - Logout → cancel les push DB pending, mode anonyme reprend.
    effect(() => {
      const authed = this.auth.isAuthenticated();
      // 1er tick : skip (boot initial déjà géré par ngAfterViewInit).
      if (!this.prefsAuthInitialized) {
        this.prefsAuthInitialized = true;
        return;
      }
      if (authed) {
        this.mergePrefsFromDb().catch(() => {/* network — silence */});
      } else {
        this.prefsSync.cancel();
      }
    });

    // Sprint 11 + Europe Chantier #2 + Phase C.6 (AROME réintroduit
    // 2026-05-12) : effet dédié pour le switch GFS ↔ ARPEGE ↔ AROME.
    // - Met à jour le LAYERS du WMS wind (force un refresh des tiles)
    // - Reset le lastWindArrowsTs pour forcer le re-fetch du GeoJSON
    //   correspondant (wind_arrows_ vs arpege_wind_arrows_ vs
    //   arome_wind_arrows_) au prochain tick
    // - Re-déclenche immédiatement le fetch arrows si la couche est ON
    effect(() => {
      const src = this.windSource();
      queueMicrotask(() => {
        if (this.windWmsSource) {
          const layer = src === 'arpege' ? 'maritime:wind-speed-arpege'
                      : src === 'arome'  ? 'maritime:wind-speed-arome'
                                         : 'maritime:wind-speed';
          this.windWmsSource.updateParams({ LAYERS: layer });
        }
        this.lastWindArrowsTs = undefined;
        if (this.showWindArrows()) {
          this.refreshArrowsForTime(this.currentTime);
        }
      });
    });

    // Effect réactif : applique le style user préféré sur chaque layer WMS.
    // Quand le user choisit/clear un palette pour une layer, on update le
    // STYLES param du TileWMS source — GeoServer applique alors le style
    // user_<id>_<slug> au lieu du defaultStyle.
    effect(() => {
      const prefs = this.palettesSvc.myPreferences();
      queueMicrotask(() => this.applyUserStyles(prefs));
    });

    // V2 Isolignes (2026-05-12) : effect qui swap STYLES + env vars
    // selon les signaux showSstContours / sstContourInterval.
    effect(() => {
      // Lecture des 6 signaux contours pour s'abonner
      this.showSstContours(); this.sstContourInterval();
      this.showWaveContours(); this.waveContourInterval();
      this.showWindContours(); this.windContourInterval();
      queueMicrotask(() => this.applyContours());
    });

    // 2026-05-17 Sylvain — refresh validityList master quand master change
    // ou quand la plage time-bar évolue. Drive les boutons de navigation
    // ⏪︎/⏩︎/⏮︎/⏭︎ par validité réelle (cf time-slider component).
    effect(() => {
      const masterKey = this.masterLayerKey();
      const cfg = this.sliderConfig();  // s'abonne à la plage min/max
      if (!masterKey) {
        this.masterValidityList.set([]);
        return;
      }
      const master = this.animatableLayers.find((l) => l.key === masterKey);
      if (!master) {
        this.masterValidityList.set([]);
        return;
      }
      // Fetch async (GetCapabilities GS) — le résultat trie/filter déjà
      // dans la plage [cfg.minTime, cfg.maxTime]. Si erreur réseau, on
      // garde la liste précédente (pas de set vide qui casserait la nav).
      this.fetchTimestamps(master, cfg.minTime, cfg.maxTime)
        .then((list) => {
          if (list.length > 0) {
            list.sort((a, b) => a.getTime() - b.getTime());
            this.masterValidityList.set(list);
          }
        })
        .catch(() => { /* silence : keep prev list */ });
    });
  }

  /** Mémoize la liste des palettes par layer kind. */
  palettesFor(kind: LayerKind): Palette[] {
    return this.palettesSvc.myPalettes().filter((p) => p.layerKind === kind);
  }

  /** Préférence courante (string id ou '') pour le <select>. */
  prefFor(kind: LayerKind): string {
    const styleName = this.palettesSvc.myPreferences()[kind];
    if (!styleName) return '';
    // Look up the palette id matching this style
    const found = this.palettesSvc.myPalettes().find(
      (p) => `user_${p.userId}_${p.slug}` === styleName.replace(/^maritime:/, ''),
    );
    return found ? String(found.id) : '';
  }

  async setPalettePref(kind: LayerKind, value: string): Promise<void> {
    const id = value === '' ? null : Number(value);
    try {
      await this.palettesSvc.setPreference(kind, id);
    } catch (err) {
      console.error('setPalettePref failed', err);
    }
  }

  logout(): void {
    this.auth.logout();
    this.palettesSvc.clear();
    // Force WMS layers to drop their custom STYLES (back to default)
    this.applyUserStyles({});
    this.router.navigate(['/auth/login']);
  }

  /**
   * Applique le STYLES param sur les sources WMS selon les préférences user.
   * `prefs` keys = layerKind, values = "user_<id>_<slug>" (ou null/absent).
   * Quand absent → on reset le STYLES à '' (= defaultStyle côté GeoServer).
   */
  private applyUserStyles(prefs: Record<string, string | null>): void {
    const styleParam = (kind: string): string => {
      const sn = prefs[kind];
      return sn ? `maritime:${sn}` : '';
    };
    if (this.sstSource)     this.sstSource.updateParams({ STYLES: styleParam('sst') });
    if (this.windWmsSource) this.windWmsSource.updateParams({ STYLES: styleParam('wind') });
    if (this.wavesSource)   this.wavesSource.updateParams({ STYLES: styleParam('waves') });
  }

  /** V2 Isolignes (2026-05-12) : swap STYLES vers le SLD with-contours +
   *  set env=contourInterval:N quand le toggle isolignes est ON. Sinon
   *  reset au style user-pref ou default. Appelé via un effect réactif. */
  private applyContours(): void {
    // 2026-05-17 refonte : avant on swappait STYLES de sstSource vers
    // sst-with-contours, qui re-renderait le raster + contours en 26s/req
    // (double IDW factor=8 dans le SLD). Résultat = saturation control-flow
    // GS, timeouts en cascade sur wind/wave, layers disparaissent.
    //
    // Maintenant : layer dédiée sstContoursLayer (SLD sst-contours-only,
    // contours seuls, factor=4) au-dessus du raster. On NE touche PLUS
    // sstSource pour les contours — juste env contourInterval sur la
    // sstContoursSource. Visibility gérée par applyLayerVisibility.
    //
    // wave/wind contours : ancien comportement conservé (refonte à venir).
    if (this.sstContoursSource && this.showSstContours()) {
      this.sstContoursSource.updateParams({
        env: `contourInterval:${this.sstContourInterval()}`,
      });
    }
    const restore = (source: ImageWMS | undefined, kind: string) => {
      const userPref = this.palettesSvc.myPreferences()[kind] ?? null;
      source?.updateParams({
        STYLES: userPref ? `maritime:${userPref}` : '',
        env: undefined,
        INTERPOLATIONS: 'bicubic',
      });
    };
    if (this.wavesSource) {
      if (this.showWaveContours()) {
        this.wavesSource.updateParams({
          STYLES: 'maritime:wave-hs-with-contours',
          env: `contourInterval:${this.waveContourInterval()}`,
          INTERPOLATIONS: 'nearest neighbor',
        });
      } else restore(this.wavesSource, 'waves');
    }
    if (this.windWmsSource) {
      if (this.showWindContours()) {
        this.windWmsSource.updateParams({
          STYLES: 'maritime:wind-speed-with-contours',
          env: `contourInterval:${this.windContourInterval()}`,
          INTERPOLATIONS: 'nearest neighbor',
        });
      } else restore(this.windWmsSource, 'wind');
    }
  }

  ngAfterViewInit(): void {
    this.initMap();
    this.initParticlesEngine();
    // V2 Sources : applique le basemap stocké (sinon baseTile reste sur 'dark'
    // par défaut). Doit être appelé APRÈS initMap (this.baseTile existe alors).
    this.applyBasemap();
    // Phase A : restore layer prefs (visibility + opacity) depuis localStorage
    // AVANT applyLayerVisibility pour éviter un flash defaults → restored.
    this.restoreLayerPrefs();
    // Phase C.2 (2026-05-12) : si user connecté, merge avec les prefs DB.
    // DB wins ; localStorage en fallback. La méthode est async mais on
    // ne block pas le boot — l'apply visuelle suit au prochain effect tick.
    if (this.auth.isAuthenticated()) {
      this.mergePrefsFromDb().catch(() => {/* network error — localStorage source */});
    } else {
      // Pas connecté → on est déjà "bootstrapped" (rien à attendre de la DB).
      this.prefsBootstrapped = true;
    }
    this.applyAllLayerOpacities();
    // Démarre en mode live
    this.applyLayerVisibility();
    // 2026-05-17 Sylvain : au boot, currentTime snap à la 30min en dessous
    // (Math.floor) pour avoir une valeur "ronde" + ≤ now (garantit !isFuture).
    // Le snap-master peut ensuite re-positionner sur un tick master spécifique.
    const STEP_30M = 30 * 60_000;
    const bootTime = new Date(Math.floor(Date.now() / STEP_30M) * STEP_30M);
    this.refreshForTime(bootTime);
    this.startLiveLoopIfNeeded();
    // Bootstrap snapshot RainViewer + refresh toutes les 5 min (le serveur
    // RV ajoute une frame toutes les 10min, donc 5min de poll = au pire on
    // découvre la nouvelle frame avec 5min de retard, OK).
    this.refreshRainSnapshot();
    this.rainSnapshotTimer = setInterval(() => this.refreshRainSnapshot(), 5 * 60_000);

    // ─── Animation player wiring ──────────────────────────────────────
    // À chaque frame émise par le player, on déclenche le pipeline normal
    // d'update (refreshForTime + slider). Le slider visuel suit donc
    // automatiquement, et tous les fetches (vessels, WMS TIME) se mettent
    // à jour comme si l'user avait drag le slider.
    this.animPlayer.frameTime$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((t) => this.onTimeChange(t));

    // Provider sliding-window : appelé au début de chaque loop si
    // followRealTime est ON. Re-fetch la liste de timestamps du master
    // pour intégrer les granules ingérés pendant la lecture (extension
    // vers le futur uniquement — on ne recule pas dans le passé).
    this.animPlayer.setSlidingWindowProvider(async () => {
      const cfg = this.animPlayer.config();
      if (!cfg) return null;
      const masterKey = this.masterLayerKey();
      if (!masterKey) return { anchor: new Date() };
      const master = this.animatableLayers.find((l) => l.key === masterKey);
      if (!master) return { anchor: new Date() };
      const now = new Date();
      now.setUTCMinutes(0, 0, 0);
      const window = this.computeAnimationWindow({ ...cfg, anchor: now });
      const timestamps = await this.fetchTimestamps(master, window.start, window.end);
      return { anchor: now, timestamps };
    });

    // Provider return-to-now : appelé au stop / fin d'animation. Pour
    // le master courant, trouve la date la plus proche de maintenant
    // dans la liste GS capabilities. Permet de retomber sur la donnée
    // la plus fraîche disponible (spec Sylvain).
    this.animPlayer.setNearestNowProvider(async () => {
      const masterKey = this.masterLayerKey();
      if (!masterKey) return new Date();
      const master = this.animatableLayers.find((l) => l.key === masterKey);
      if (!master) return new Date();
      const now = Date.now();
      // On scanne large : -7j / +7j autour de now pour avoir un choix
      // pour le master, quel que soit son horizon (passé ou forecast).
      const start = new Date(now - 7 * 86400_000);
      const end = new Date(now + 7 * 86400_000);
      const list = await this.fetchTimestamps(master, start, end);
      if (list.length === 0) return new Date();
      // Date dont |t - now| est minimal
      return list.reduce((best, cur) =>
        Math.abs(cur.getTime() - now) < Math.abs(best.getTime() - now) ? cur : best,
      );
    });
    // Bootstrap palette preferences si déjà connecté (le token est en
    // localStorage et restaure currentUser via signal au chargement).
    if (this.isAuthenticated()) {
      this.palettesSvc.loadMyContext().catch(() => {/* token expiré ou api down — silence */});
    }
  }

  ngOnDestroy(): void {
    this.liveSub?.unsubscribe();
    this.trackSub?.unsubscribe();
    this.pastVesselsSub?.unsubscribe();
    if (this.pastFetchDebounce) clearTimeout(this.pastFetchDebounce);
    if (this.rainSnapshotTimer) clearInterval(this.rainSnapshotTimer);
    if (this.arrowsFetchDebounce) clearTimeout(this.arrowsFetchDebounce);
    this.stopLightningLoop();
    this.stopAlertsLoop();
    this.stopBuoysLoop();
    this.stopMetarLoop();
    this.stopHubeauLoop();
    this.stopQuakesLoop();
    this.stopPiezoLoop();
    this.stopFirmsLoop();
    this.particlesEngine?.stop();
    this.map?.setTarget(undefined);
    this.map?.dispose();
  }

  // ─── Time slider callback ──────────────────────────────────────────
  /** Appelé par l'utilisateur via le slider. Si une animation tourne,
   *  on l'arrête (l'user reprend le contrôle manuel). */
  onSliderTimeChange(t: Date): void {
    if (this.animPlayer.state() !== 'idle') {
      this.animPlayer.stop();
    }
    this.onTimeChange(t);
  }

  /** Pipeline d'update du temps courant. Appelé soit par le slider
   *  (via onSliderTimeChange), soit par chaque frame de l'animation
   *  (via animPlayer.frameTime$ subscribe). */
  onTimeChange(t: Date): void {
    // Idempotency guard — si le timestamp est identique au courant (cas
    // snap-cursor d'un effect qui re-fire avec le même tick, ou tick
    // d'animation très court), on évite la cascade refreshForTime →
    // re-updateParams 3 WMS + refetch tracks/vessels/arrows. Mesuré
    // 2026-05-17 via Playwright : 1 toggle layer = 4 fetches dont 3
    // redondants. Ce guard règle ~60% des fetches parasites.
    if (this.currentTime && t.getTime() === this.currentTime.getTime()) return;
    this.currentTime = t;
    this.currentTimeSig.set(t);
    this.refreshForTime(t);
    this.startLiveLoopIfNeeded();
    this.updateRainLayer(t);
    this.refreshArrowsForTime(t);
    if (this.showWindParticles() && this.particlesEngine) {
      this.loadParticlesGrid(t);
    }
    this.applyLayerVisibility();
  }

  // ─── RainViewer ───────────────────────────────────────────────────
  private async refreshRainSnapshot(): Promise<void> {
    try {
      this.rainSnapshot = await this.rainviewer.getSnapshot();
      // Re-eval du cursor courant avec le nouveau snapshot
      this.updateRainLayer(this.currentTime);
      this.applyLayerVisibility();
    } catch (err) {
      // Silencieux : RainViewer indispo n'empêche rien d'autre
      this.rainStatus.set('indisponible');
    }
  }

  /**
   * Sélectionne la frame RainViewer la plus proche du cursor courant et
   * met à jour l'URL XYZ de la layer. Si aucune frame ≤ 15min, cache la
   * layer et signale "hors fenêtre" dans le toggle.
   */
  private updateRainLayer(t: Date): void {
    if (!this.rainSource || !this.rainSnapshot) return;
    const atSec = Math.floor(t.getTime() / 1000);
    const frame = this.rainviewer.findNearestFrame(this.rainSnapshot, atSec);
    if (!frame) {
      this.rainHasFrame.set(false);
      this.rainStatus.set('hors fenêtre (-2h, +30min)');
      return;
    }
    // Évite de re-set le source.url si on est déjà sur la même frame —
    // sinon OL refait tous les fetchs tile à chaque tick du slider.
    if (this.currentRainPath !== frame.path) {
      this.currentRainPath = frame.path;
      const url = this.rainviewer.buildTileUrl(this.rainSnapshot.host, frame.path);
      this.rainSource.setUrl(url);
    }
    this.rainHasFrame.set(true);
    const deltaMin = Math.round((atSec - frame.time) / 60);
    const sign = deltaMin === 0 ? '=' : (deltaMin > 0 ? `+${deltaMin}min` : `${deltaMin}min`);
    this.rainStatus.set(`frame ${sign} du cursor`);
  }

  // ─── Layer visibility logic (combine user toggles + currentTime mode) ─
  private isLive(): boolean {
    return Math.abs(Date.now() - this.currentTime.getTime()) < LIVE_THRESHOLD_MS;
  }
  private isFuture(): boolean {
    return this.currentTime.getTime() > Date.now() + LIVE_THRESHOLD_MS;
  }

  private applyLayerVisibility(): void {
    if (!this.vesselLayer || !this.trackLayer || !this.sstLayer) return;
    // Vessels = visible en live ET en past (replay via SQL view paramétrable
    // vessels_at_time). Pas en futur (pas de forecast trajectoire).
    this.vesselLayer.setVisible(this.showVessels() && !this.isFuture());
    // Tracks = past only — résumé daily (LineStrings agrégés)
    this.trackLayer.setVisible(this.showTracks() && !this.isLive() && !this.isFuture());
    // SST + contours : on RETIRE le guard !isFuture() car un effet auto
    // (anim player / snap-master / autre) déplace parfois currentTime dans
    // le futur (cf bug 2026-05-17 soir : Sylvain voit time-bar "LIVE 18 mai
    // 02:00" alors qu'on est le 17 mai 20h45). isFuture() devenait true →
    // setVisible(false) → layer disparait silencieusement, sans fetch ni
    // log console. Retour : laisser la layer visible même si futur. Si GS
    // n'a pas de granule pour le TIME demandé, il renvoie image transparente
    // — bien moins pire que layer qui disparait sans raison apparente.
    // (Le drift de currentTime reste à investiguer demain à froid.)
    this.sstLayer.setVisible(this.showSST());
    if (this.sstContoursLayer) {
      this.sstContoursLayer.setVisible(
        this.showSST() && this.showSstContours(),
      );
    }
    // Rain : visible si toggle ON + frame disponible pour le cursor courant
    if (this.rainLayer) {
      this.rainLayer.setVisible(this.showRain() && this.rainHasFrame());
    }
    // Wind/Waves : visibles à n'importe quel moment où il y a un forecast
    // (NOAA accepte TIME=NEAREST → matche le timestep le plus proche).
    if (this.windLayer)  this.windLayer.setVisible(this.showWind());
    if (this.wavesLayer) this.wavesLayer.setVisible(this.showWaves());
    // Arrows : visibles si toggle ON. Le contenu est rafraîchi par
    // refreshArrowsForTime() à chaque cursor change.
    if (this.windArrowsLayer) this.windArrowsLayer.setVisible(this.showWindArrows());
    if (this.waveArrowsLayer) this.waveArrowsLayer.setVisible(this.showWaveArrows());
    // Lightning : visible si toggle ON ET mode live (les strikes sont temps réel,
    // pas archivés au-delà de 30 min — replay/forecast pas pertinent).
    if (this.lightningLayer) {
      const wanted = this.showLightning() && this.isLive();
      this.lightningLayer.setVisible(wanted);
      if (wanted) this.startLightningLoop();
      else this.stopLightningLoop();
    }
    // Alerts : visible si toggle ON ET mode live
    if (this.alertsLayer) {
      const wanted = this.showAlerts() && this.isLive();
      this.alertsLayer.setVisible(wanted);
      if (wanted) this.startAlertsLoop();
      else this.stopAlertsLoop();
    }
    // Bouées CANDHIS : visible en mode live (les obs TR ne s'archivent pas
    // dans cette stack — seul le référentiel reste pertinent ailleurs, mais
    // on garde la couche entière sur live pour la cohérence UX).
    if (this.buoysLayer) {
      const wanted = this.showBuoys() && this.isLive();
      this.buoysLayer.setVisible(wanted);
      if (wanted) this.startBuoysLoop();
      else this.stopBuoysLoop();
    }
    // METAR : visible en mode live (les obs aéroports sont temps réel,
    // refreshées par l'orchestrator toutes les 30min).
    if (this.metarLayer) {
      const wanted = this.showMetar() && this.isLive();
      this.metarLayer.setVisible(wanted);
      if (wanted) this.startMetarLoop();
      else this.stopMetarLoop();
    }
    // Hub'eau débits FR : visible en mode live, refresh 60s.
    if (this.hubeauLayer) {
      const wanted = this.showHubeau() && this.isLive();
      this.hubeauLayer.setVisible(wanted);
      if (wanted) this.startHubeauLoop();
      else this.stopHubeauLoop();
    }
    // Séismes USGS : visible en mode live, refresh 5min (TTL cache proxy).
    if (this.quakesLayer) {
      const wanted = this.showQuakes() && this.isLive();
      this.quakesLayer.setVisible(wanted);
      if (wanted) this.startQuakesLoop();
      else this.stopQuakesLoop();
    }
    // Piezo Hub'eau : visible en mode live, refresh 5min (piezo refresh
    // upstream ~1h, on est large).
    if (this.piezoLayer) {
      const wanted = this.showPiezo() && this.isLive();
      this.piezoLayer.setVisible(wanted);
      if (wanted) this.startPiezoLoop();
      else this.stopPiezoLoop();
    }
    // FIRMS NASA feux : visible en mode live, refresh 5min (data NRT ~3h).
    if (this.firmsLayer) {
      const wanted = this.showFirms() && this.isLive();
      this.firmsLayer.setVisible(wanted);
      if (wanted) this.startFirmsLoop();
      else this.stopFirmsLoop();
    }
    // V2 Sources : Bathy + EEZ + EFAS WMS — pas de mode live nécessaire
    // (raster server-side, le toggle suffit).
    if (this.bathyLayer) this.bathyLayer.setVisible(this.showBathy());
    if (this.eezLayer)   this.eezLayer.setVisible(this.showEez());
    if (this.mpaLayer)   this.mpaLayer.setVisible(this.showMpa());
    if (this.efasLayer)  this.efasLayer.setVisible(this.showEfas());
    // Wind particles : engine est démarré au boot, on contrôle juste la
    // visibilité du canvas + la grille. Quand OFF, on stop le rAF pour
    // économiser CPU.
    if (this.particlesEngine) {
      if (this.showWindParticles()) {
        this.particlesEngine.start();
        this.loadParticlesGrid(this.currentTime);
      } else {
        this.particlesEngine.stop();
        this.clearParticlesCanvas();
      }
    }
  }

  /**
   * Fetch arrows GeoJSON pour vent + vagues au cursor courant. Debounce
   * 200ms pendant les drags du slider pour éviter le spam réseau.
   * "Gaffe au sens" : convention adoptée = la flèche pointe vers OÙ va le vent
   * (et la houle). dirTo (compass deg) → rotation OL en radians.
   */
  private refreshArrowsForTime(t: Date): void {
    if (this.arrowsFetchDebounce) clearTimeout(this.arrowsFetchDebounce);
    this.arrowsFetchDebounce = setTimeout(() => this.doRefreshArrows(t), 200);
  }

  private async doRefreshArrows(t: Date): Promise<void> {
    const wantWind = this.showWindArrows();
    const wantWave = this.showWaveArrows();
    if (!wantWind && !wantWave) return;
    const manifest = await this.arrows.getManifest();
    if (!manifest) return;
    if (wantWind && this.windArrowsSource) {
      // Sprint 11 + Europe Chantier #2 + Phase C.6 (AROME réintro) :
      // choisit la source manifest selon windSource(). ARPEGE et AROME
      // ont chacun leur liste de ts (manifest.arpege / manifest.arome).
      // Fallback automatique sur GFS si la source choisie pas alimentée.
      const src = this.windSource();
      const manifestList = src === 'arpege' ? manifest.arpege
                         : src === 'arome'  ? manifest.arome
                                            : null;
      const hasSpecific = Array.isArray(manifestList) && manifestList.length > 0;
      const tsList = hasSpecific ? manifestList! : manifest.wind;
      const kind: ArrowsKind = hasSpecific
        ? (src as ArrowsKind)
        : 'wind';
      const srcUpper = src.toUpperCase();
      const ts = this.arrows.findNearestTs(tsList, t);
      if (!ts) {
        this.windArrowsSource.clear();
        this.windArrowsStatus.set(hasSpecific
          ? `hors fenêtre ${srcUpper}`
          : (src !== 'gfs' ? `${srcUpper} indispo, fallback GFS vide` : 'hors fenêtre GFS'));
      } else if (ts !== this.lastWindArrowsTs) {
        try {
          const fc = await this.arrows.fetchArrows(kind, ts);
          this.windArrowsSource.clear();
          const features = this.geoJsonFmt.readFeatures(fc);
          this.windArrowsSource.addFeatures(features);
          this.lastWindArrowsTs = ts;
          this.windArrowsStatus.set(this.formatTsLabel(ts, t));
        } catch (err: any) {
          this.windArrowsStatus.set(`erreur: ${err?.message ?? err}`);
        }
      }
    }
    if (wantWave && this.waveArrowsSource) {
      const ts = this.arrows.findNearestTs(manifest.wave, t);
      if (!ts) {
        this.waveArrowsSource.clear();
        this.waveArrowsStatus.set('hors fenêtre forecast');
      } else if (ts !== this.lastWaveArrowsTs) {
        try {
          const fc = await this.arrows.fetchArrows('wave', ts);
          this.waveArrowsSource.clear();
          const features = this.geoJsonFmt.readFeatures(fc);
          this.waveArrowsSource.addFeatures(features);
          this.lastWaveArrowsTs = ts;
          this.waveArrowsStatus.set(this.formatTsLabel(ts, t));
        } catch (err: any) {
          this.waveArrowsStatus.set(`erreur: ${err?.message ?? err}`);
        }
      }
    }
  }

  private formatTsLabel(ts: string, cursor: Date): string {
    // 20260510T120000Z → "10/05 12:00 (±Nh du cursor)"
    const date = new Date(
      `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T${ts.slice(9, 11)}:${ts.slice(11, 13)}:${ts.slice(13, 15)}Z`,
    );
    const deltaMin = Math.round((date.getTime() - cursor.getTime()) / 60_000);
    const deltaStr = Math.abs(deltaMin) < 60
      ? `${deltaMin > 0 ? '+' : ''}${deltaMin}min`
      : `${deltaMin > 0 ? '+' : ''}${Math.round(deltaMin / 60)}h`;
    return `${date.getUTCDate().toString().padStart(2, '0')}/${(date.getUTCMonth() + 1).toString().padStart(2, '0')} ${date.getUTCHours().toString().padStart(2, '0')}h · ${deltaStr}`;
  }

  /**
   * SVG inline data-URL arrow pointant vers le haut (NORD). Rotated par OL
   * via `Icon.rotation` (radians) pour matcher `dirTo` compass.
   * Le shaft est plus long pour rendre visible la direction même à petit zoom.
   */
  private arrowDataUrl(color: string): string {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
      <path d="M12 2 L17 12 L13 11 L13 22 L11 22 L11 11 L7 12 Z" fill="${color}" stroke="#0a0e1a" stroke-width="0.6"/>
    </svg>`;
    return 'data:image/svg+xml;base64,' + btoa(svg);
  }

  private styleArrow(kind: ArrowsKind, feat: FeatureLike): Style {
    const props = feat.getProperties() as { speed?: number; hs?: number; dirTo: number };
    // 'arpege' partage la sémantique 'wind' (m/s + dirTo) — Beaufort palette.
    const isWindLike = kind === 'wind' || kind === 'arpege' || kind === 'arome';
    const value = isWindLike ? (props.speed ?? 0) : (props.hs ?? 0);
    const color = this.colorForArrow(kind, value);
    const scale = isWindLike ? this.scaleForWind(value) : this.scaleForWaves(value);
    return new Style({
      image: new Icon({
        src: this.arrowDataUrl(color),
        rotation: ((props.dirTo ?? 0) * Math.PI) / 180,
        rotateWithView: true,
        scale,
        anchor: [0.5, 0.5],
      }),
    });
  }

  private colorForArrow(kind: ArrowsKind, v: number): string {
    if (kind === 'wind' || kind === 'arpege' || kind === 'arome') {
      // Beaufort-like : ≤3 bleu, ≤6 cyan, ≤10 vert, ≤14 jaune, ≤18 orange, >18 rouge
      if (v <= 3)  return '#38bdf8';
      if (v <= 6)  return '#06b6d4';
      if (v <= 10) return '#22c55e';
      if (v <= 14) return '#fde047';
      if (v <= 18) return '#fb923c';
      return '#dc2626';
    } else {
      if (v <= 0.5) return '#1e40af';
      if (v <= 1.5) return '#0ea5e9';
      if (v <= 2.5) return '#06b6d4';
      if (v <= 4)   return '#22c55e';
      if (v <= 6)   return '#fbbf24';
      return '#dc2626';
    }
  }

  private scaleForWind(v: number): number {
    return Math.min(1.0, 0.55 + v * 0.025);   // 0.55 (calm) → 1.0 (storm)
  }
  private scaleForWaves(v: number): number {
    return Math.min(1.0, 0.6 + v * 0.07);     // 0.6 (flat) → 1.0 (rough)
  }

  /**
   * Style "bolt" SVG ⚡ pour les éclairs — forme distincte des navires
   * (losange) pour ne pas confondre les 2 types de features.
   * - <60s : blanc-jaune brillant + halo large (flash récent)
   * - 60s-5min : jaune saturé
   * - 5-30min : ambre fading
   */
  private lightningIconCache: Record<string, string> = {};
  private lightningIconDataUrl(fill: string, stroke: string): string {
    const key = `${fill}|${stroke}`;
    if (this.lightningIconCache[key]) return this.lightningIconCache[key];
    // SVG éclair classique (bolt vertical)
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="22" viewBox="0 0 18 22">
      <path d="M11 1 L2 13 L8 13 L7 21 L16 9 L10 9 L11 1 Z"
        fill="${fill}" stroke="${stroke}" stroke-width="1" stroke-linejoin="round" />
    </svg>`;
    const url = 'data:image/svg+xml;base64,' + btoa(svg);
    this.lightningIconCache[key] = url;
    return url;
  }
  private styleLightning(feat: FeatureLike): Style {
    const age = (feat.getProperties() as LightningProperties).age_seconds ?? 0;
    let fill: string;
    let stroke: string;
    let scale: number;
    if (age < 60) {
      fill = '#ffffff';
      stroke = '#fde047';
      scale = 1.1;
    } else if (age < 300) {
      fill = '#fde047';
      stroke = '#fbbf24';
      scale = 1.0;
    } else if (age < 1800) {
      fill = '#fbbf24';
      stroke = '#a16207';
      scale = 0.85;
    } else {
      fill = '#a16207';
      stroke = '#78350f';
      scale = 0.7;
    }
    return new Style({
      image: new Icon({
        src: this.lightningIconDataUrl(fill, stroke),
        scale,
        anchor: [0.5, 0.5],
      }),
    });
  }

  /**
   * Refresh des strikes via WFS toutes les 30s. La vue v_lightning_recent
   * filtre déjà à -30min, donc on récupère un FeatureCollection compact.
   */
  private startLightningLoop(): void {
    if (this.lightningTimer || this.lightningSub) return;
    const fetchAndPaint = () => {
      this.lightningSub?.unsubscribe();
      this.lightningSub = this.lightning.fetchRecent(this.currentTimeSig())
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (fc) => {
            if (!this.lightningSource) return;
            this.lightningSource.clear();
            const features = this.geoJsonFmt.readFeatures(fc);
            this.lightningSource.addFeatures(features);
            this.lightningStatus.set(`${fc.features.length} strikes (30min)`);
          },
          error: (err) => {
            this.lightningStatus.set(`erreur : ${err?.message ?? err}`);
          },
        });
    };
    fetchAndPaint();
    this.lightningTimer = setInterval(fetchAndPaint, 30_000);
  }

  private stopLightningLoop(): void {
    if (this.lightningTimer) {
      clearInterval(this.lightningTimer);
      this.lightningTimer = undefined;
    }
    this.lightningSub?.unsubscribe();
    this.lightningSub = undefined;
    this.lightningSource?.clear();
  }

  // ─── Bouées CANDHIS (CEREMA) ───────────────────────────────────────
  /**
   * Icône bouée : cercle bleu marine avec liseré blanc + label en gras.
   * On peint plus gros quand on a une obs récente (signal visuel "la bouée
   * pousse de la donnée"), et plus pâle sinon (référentiel seulement).
   */
  private styleBuoy(feat: FeatureLike): Style {
    const props = feat.getProperties() as BuoyProperties;
    const hasObs = this.buoyObsByCandhisId.has(props.candhis_id);
    return new Style({
      image: new CircleStyle({
        radius: hasObs ? 7 : 5,
        fill: new Fill({ color: hasObs ? '#1e88e5' : 'rgba(30, 136, 229, 0.55)' }),
        stroke: new Stroke({ color: '#ffffff', width: hasObs ? 2 : 1.2 }),
      }),
    });
  }

  /**
   * Boot du fetch bouées : 1 fetch référentiel immédiat + reload toutes
   * les 6h (la liste bouge rarement), 1 fetch obs immédiat + refresh
   * toutes les 5min. Si le backend n'a pas de clé CANDHIS, les obs
   * reviendront vides et c'est OK — la couche référentiel reste affichée.
   */
  private startBuoysLoop(): void {
    if (this.buoysRefTimer || this.buoysObsTimer) return;
    const fetchRef = () => {
      this.buoysRefSub?.unsubscribe();
      this.buoysRefSub = this.buoys.fetchReferential()
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (fc) => {
            if (!this.buoysSource) return;
            this.buoysSource.clear();
            const features = this.geoJsonFmt.readFeatures(fc);
            this.buoysSource.addFeatures(features);
            const hasObsCount = this.buoyObsByCandhisId.size;
            this.buoysStatus.set(
              hasObsCount > 0
                ? `${fc.features.length} bouées (${hasObsCount} TR)`
                : `${fc.features.length} bouées (réf only)`,
            );
          },
          error: (err) => this.buoysStatus.set(`erreur : ${err?.message ?? err}`),
        });
    };
    const fetchObs = () => {
      this.buoysObsSub?.unsubscribe();
      this.buoysObsSub = this.buoys.fetchRecentObservations(this.currentTimeSig())
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (fc) => {
            this.buoyObsByCandhisId.clear();
            for (const f of fc.features) {
              if (f.properties?.candhis_id) {
                this.buoyObsByCandhisId.set(f.properties.candhis_id, f.properties);
              }
            }
            // Repaint pour styler en plus gros les bouées qui ont une obs
            this.buoysLayer?.changed();
            const refCount = this.buoysSource?.getFeatures().length ?? 0;
            if (this.buoyObsByCandhisId.size > 0) {
              this.buoysStatus.set(`${refCount} bouées (${this.buoyObsByCandhisId.size} TR)`);
            }
          },
          error: () => {
            // 404/500 silencieux — la couche obs peut être absente
            // (CANDHIS_API_KEY pas configurée → vue retourne 0 features).
          },
        });
    };
    fetchRef();
    fetchObs();
    this.buoysRefTimer = setInterval(fetchRef, 6 * 3600_000);
    this.buoysObsTimer = setInterval(fetchObs, 5 * 60_000);
  }

  private stopBuoysLoop(): void {
    if (this.buoysRefTimer) {
      clearInterval(this.buoysRefTimer);
      this.buoysRefTimer = undefined;
    }
    if (this.buoysObsTimer) {
      clearInterval(this.buoysObsTimer);
      this.buoysObsTimer = undefined;
    }
    this.buoysRefSub?.unsubscribe();
    this.buoysObsSub?.unsubscribe();
    this.buoysRefSub = undefined;
    this.buoysObsSub = undefined;
    this.buoysSource?.clear();
    this.buoyObsByCandhisId.clear();
  }

  // ─── METAR (V2 Observation #1) ─────────────────────────────────────
  /** Style d'un point METAR : cercle coloré selon température (bleu froid
   *  → rouge chaud), taille selon force vent. NaN/null → gris. */
  private styleMetar(feat: FeatureLike): Style {
    const p = feat.getProperties() as MetarProperties;
    const temp = p.temp_c;
    const wspd = p.wind_speed_kt ?? 0;
    // Couleur par température (palette 6 buckets)
    let fill = '#94a3b8'; // gris (no temp)
    if (temp != null) {
      if (temp < -5)      fill = '#3b82f6'; // bleu glacé
      else if (temp < 5)  fill = '#06b6d4'; // cyan
      else if (temp < 15) fill = '#22c55e'; // vert
      else if (temp < 25) fill = '#fbbf24'; // jaune
      else if (temp < 35) fill = '#f97316'; // orange
      else                fill = '#dc2626'; // rouge
    }
    // Rayon par force du vent (5→13px)
    const radius = Math.max(5, Math.min(13, 5 + wspd / 4));
    // Stale (> 2h) → opacity réduite
    const stale = p.age_seconds > 7200;
    return new Style({
      image: new CircleStyle({
        radius,
        fill: new Fill({ color: fill }),
        stroke: new Stroke({ color: stale ? '#475569' : '#fff', width: 1.5 }),
      }),
    });
  }

  /** Fetch /api/metar/recent → GeoJSON → features OL. Refresh 60s. */
  private startMetarLoop(): void {
    if (this.metarTimer) return;
    const fetchMetar = async () => {
      try {
        const resp = await fetch('/api/metar/recent');
        if (!resp.ok) return;
        const fc = await resp.json();
        if (!this.metarSource) return;
        this.metarSource.clear();
        const features = this.geoJsonFmt.readFeatures(fc, {
          dataProjection: 'EPSG:4326',
          featureProjection: this.map?.getView().getProjection() ?? 'EPSG:3857',
        });
        this.metarSource.addFeatures(features);
        const count = fc.features?.length ?? 0;
        const stale = (fc.features as Array<{ properties: MetarProperties }>)
          .filter((f) => f.properties.age_seconds > 3600).length;
        this.metarStatus.set(stale > 0 ? `${count} METAR (${stale} >1h)` : `${count} METAR`);
      } catch {
        this.metarStatus.set('erreur fetch METAR');
      }
    };
    fetchMetar();
    this.metarTimer = setInterval(fetchMetar, 60_000);
  }

  private stopMetarLoop(): void {
    if (this.metarTimer) {
      clearInterval(this.metarTimer);
      this.metarTimer = undefined;
    }
    this.metarSource?.clear();
  }

  // ─── Hub'eau débits FR (V2 Hydrologie #1) ──────────────────────────
  /** Style d'un point Hub'eau : cercle cyan, taille selon débit log-scale
   *  (les débits varient de 0.01 m³/s à 5000+ m³/s sur les grands fleuves,
   *  log-scale donne un rendu lisible). Stale (>1h) → gris foncé. */
  private styleHubeau(feat: FeatureLike): Style {
    const p = feat.getProperties() as HubeauProperties;
    const debit = p.debit_m3_s ?? 0;
    // log-scale : 0.1→3px, 1→5px, 10→7px, 100→9px, 1000→11px, 5000+→13px
    const radius = debit <= 0
      ? 3
      : Math.max(3, Math.min(13, 3 + Math.log10(Math.max(0.1, debit)) * 2.5));
    const stale = p.age_seconds > 3600;
    return new Style({
      image: new CircleStyle({
        radius,
        fill: new Fill({ color: stale ? '#475569' : '#22d3ee' }),
        stroke: new Stroke({ color: stale ? '#1e293b' : '#0e7490', width: 1.2 }),
      }),
    });
  }

  /** Fetch /api/hubeau/recent → GeoJSON → features OL. Refresh 60s. */
  private startHubeauLoop(): void {
    if (this.hubeauTimer) return;
    const fetchHubeau = async () => {
      try {
        const resp = await fetch('/api/hubeau/recent');
        if (!resp.ok) return;
        const fc = await resp.json();
        if (!this.hubeauSource) return;
        this.hubeauSource.clear();
        const features = this.geoJsonFmt.readFeatures(fc, {
          dataProjection: 'EPSG:4326',
          featureProjection: this.map?.getView().getProjection() ?? 'EPSG:3857',
        });
        this.hubeauSource.addFeatures(features);
        const count = fc.features?.length ?? 0;
        this.hubeauStatus.set(`${count} stations FR`);
      } catch {
        this.hubeauStatus.set('erreur fetch Hub\'eau');
      }
    };
    fetchHubeau();
    this.hubeauTimer = setInterval(fetchHubeau, 60_000);
  }

  private stopHubeauLoop(): void {
    if (this.hubeauTimer) {
      clearInterval(this.hubeauTimer);
      this.hubeauTimer = undefined;
    }
    this.hubeauSource?.clear();
  }

  // ─── Séismes USGS (V2 Observation #2) ──────────────────────────────
  /** Style d'un séisme : cercle rouge/orange/jaune selon magnitude, taille
   *  exponentielle de magnitude (les mag-5 dominent visuellement). Halo
   *  jaune si tsunami flag. Alerte rouge si alert='red'/'orange'. */
  private styleQuake(feat: FeatureLike): Style {
    const p = feat.getProperties() as QuakeProperties;
    const mag = p.mag ?? 0;
    // Magnitudes : <2.5 gris, 2.5-4 vert, 4-5 jaune, 5-6 orange, 6+ rouge
    let fill = '#94a3b8';
    if (mag >= 6)      fill = '#dc2626';
    else if (mag >= 5) fill = '#ea580c';
    else if (mag >= 4) fill = '#fbbf24';
    else if (mag >= 2.5) fill = '#84cc16';
    // Rayon exponentiel : magnitude 1 → 4px, 5 → 11px, 7 → 18px
    const radius = Math.max(3, Math.min(20, 3 + Math.pow(Math.max(0, mag), 1.5) * 1.2));
    const stroke = (p.alert === 'red' || p.alert === 'orange')
      ? new Stroke({ color: '#dc2626', width: 2.5 })
      : new Stroke({ color: '#0f172a', width: 1 });
    return new Style({
      image: new CircleStyle({
        radius,
        fill: new Fill({ color: fill }),
        stroke,
      }),
    });
  }

  /** Fetch /api/earthquakes/recent → GeoJSON. Refresh 5min côté UI
   *  (le proxy NestJS cache 5min lui aussi, donc on s'aligne). */
  private startQuakesLoop(): void {
    if (this.quakesTimer) return;
    const fetchQuakes = async () => {
      try {
        const resp = await fetch('/api/earthquakes/recent');
        if (!resp.ok) return;
        const fc = await resp.json();
        if (!this.quakesSource) return;
        this.quakesSource.clear();
        const features = this.geoJsonFmt.readFeatures(fc, {
          dataProjection: 'EPSG:4326',
          featureProjection: this.map?.getView().getProjection() ?? 'EPSG:3857',
        });
        this.quakesSource.addFeatures(features);
        const count = fc.features?.length ?? 0;
        const sig = (fc.features as Array<{ properties: QuakeProperties }>)
          .filter((f) => (f.properties.mag ?? 0) >= 4.5).length;
        this.quakesStatus.set(sig > 0 ? `${count} séismes 24h (${sig} ≥4.5)` : `${count} séismes 24h`);
      } catch {
        this.quakesStatus.set('erreur fetch USGS');
      }
    };
    fetchQuakes();
    this.quakesTimer = setInterval(fetchQuakes, 5 * 60_000);
  }

  private stopQuakesLoop(): void {
    if (this.quakesTimer) {
      clearInterval(this.quakesTimer);
      this.quakesTimer = undefined;
    }
    this.quakesSource?.clear();
  }

  // ─── Piezo Hub'eau (V2 Hydrologie #2) ──────────────────────────────
  /** Style d'un piézomètre : cercle bleu indigo, taille fixe (les niveaux
   *  varient peu en absolu). Color shift selon profondeur nappe :
   *  <2m surface, 2-10m subaffleurante, >10m profonde. Stale (>7j) → gris. */
  private stylePiezo(feat: FeatureLike): Style {
    const p = feat.getProperties() as PiezoProperties;
    const depth = p.profondeur_nappe;
    let fill = '#6366f1';  // indigo défaut
    if (depth != null) {
      if (depth < 2)        fill = '#3b82f6';   // bleu (proche surface)
      else if (depth < 10)  fill = '#6366f1';   // indigo
      else if (depth < 30)  fill = '#7c3aed';   // violet
      else                  fill = '#5b21b6';   // violet foncé
    }
    const stale = p.age_seconds > 7 * 24 * 3600;
    return new Style({
      image: new CircleStyle({
        radius: 4,
        fill: new Fill({ color: stale ? '#475569' : fill }),
        stroke: new Stroke({ color: stale ? '#1e293b' : '#1e1b4b', width: 1 }),
      }),
    });
  }

  private startPiezoLoop(): void {
    if (this.piezoTimer) return;
    const fetchPiezo = async () => {
      try {
        const resp = await fetch('/api/hubeau/piezo/recent');
        if (!resp.ok) return;
        const fc = await resp.json();
        if (!this.piezoSource) return;
        this.piezoSource.clear();
        const features = this.geoJsonFmt.readFeatures(fc, {
          dataProjection: 'EPSG:4326',
          featureProjection: this.map?.getView().getProjection() ?? 'EPSG:3857',
        });
        this.piezoSource.addFeatures(features);
        const count = fc.features?.length ?? 0;
        this.piezoStatus.set(`${count} piézomètres FR`);
      } catch {
        this.piezoStatus.set('erreur fetch Piezo');
      }
    };
    fetchPiezo();
    this.piezoTimer = setInterval(fetchPiezo, 5 * 60_000);
  }

  private stopPiezoLoop(): void {
    if (this.piezoTimer) {
      clearInterval(this.piezoTimer);
      this.piezoTimer = undefined;
    }
    this.piezoSource?.clear();
  }

  // ─── FIRMS NASA feux (V2 Observation #3) ──────────────────────────
  /** Style hotspot feu : cercle rouge/orange selon FRP (Fire Radiative
   *  Power MW), taille log-scale. Halo orange si confiance haute. */
  private styleFirms(feat: FeatureLike): Style {
    const p = feat.getProperties() as FirmsProperties;
    const frp = p.frp ?? 0;
    const conf = p.confidence ?? 0;
    // FRP : <10 jaune, 10-50 orange, 50-200 rouge, 200+ rouge vif
    let fill = '#fbbf24';
    if (frp >= 200)     fill = '#b91c1c';
    else if (frp >= 50) fill = '#dc2626';
    else if (frp >= 10) fill = '#f97316';
    // Rayon log-scale : 3px à 12px
    const radius = Math.max(3, Math.min(12, 3 + Math.log10(Math.max(1, frp)) * 2.5));
    const stale = p.age_seconds > 12 * 3600;
    return new Style({
      image: new CircleStyle({
        radius,
        fill: new Fill({ color: stale ? '#78716c' : fill }),
        stroke: new Stroke({
          color: conf >= 80 ? '#fbbf24' : '#7c2d12',
          width: conf >= 80 ? 2 : 1,
        }),
      }),
    });
  }

  private startFirmsLoop(): void {
    if (this.firmsTimer) return;
    const fetchFirms = async () => {
      try {
        const resp = await fetch('/api/firms/recent');
        if (!resp.ok) return;
        const fc = await resp.json();
        if (!this.firmsSource) return;
        this.firmsSource.clear();
        const features = this.geoJsonFmt.readFeatures(fc, {
          dataProjection: 'EPSG:4326',
          featureProjection: this.map?.getView().getProjection() ?? 'EPSG:3857',
        });
        this.firmsSource.addFeatures(features);
        const count = fc.features?.length ?? 0;
        const high = (fc.features as Array<{ properties: FirmsProperties }>)
          .filter((f) => (f.properties.frp ?? 0) >= 50).length;
        this.firmsStatus.set(high > 0 ? `${count} hotspots (${high} >50MW)` : `${count} hotspots 24h`);
      } catch {
        this.firmsStatus.set('erreur fetch FIRMS');
      }
    };
    fetchFirms();
    this.firmsTimer = setInterval(fetchFirms, 5 * 60_000);
  }

  private stopFirmsLoop(): void {
    if (this.firmsTimer) {
      clearInterval(this.firmsTimer);
      this.firmsTimer = undefined;
    }
    this.firmsSource?.clear();
  }

  // ─── Alerts (sprint 10) ───────────────────────────────────────────
  private styleAlert(feat: FeatureLike): Style {
    const props = feat.getProperties() as AlertProperties;
    const severity = props.severity ?? 'info';
    const color = severity === 'danger' ? '#dc2626' : severity === 'warning' ? '#fb923c' : '#fde047';
    const radius = severity === 'danger' ? 12 : 9;
    return new Style({
      image: new CircleStyle({
        radius,
        fill: new Fill({ color: 'rgba(0,0,0,0)' }),
        stroke: new Stroke({ color, width: 3 }),
      }),
    });
  }

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

  private startAlertsLoop(): void {
    if (this.alertsTimer) return;
    const fetchAndPaint = async () => {
      try {
        // Fenêtre 1h ancrée sur la time-bar : permet replay temporel
        // sans changer la sémantique "alertes récentes".
        const fc = await this.alertsSvc.refresh(this.currentTimeSig());
        if (!this.alertsSource) return;
        this.alertsSource.clear();
        const features = this.geoJsonFmt.readFeatures(fc);
        this.alertsSource.addFeatures(features);
        this.alertsStatus.set(`${fc.features.length} alertes 1h`);
      } catch (err: any) {
        this.alertsStatus.set(`erreur : ${err?.message ?? err}`);
      }
    };
    fetchAndPaint();
    this.alertsTimer = setInterval(fetchAndPaint, 30_000);
  }

  private stopAlertsLoop(): void {
    if (this.alertsTimer) {
      clearInterval(this.alertsTimer);
      this.alertsTimer = undefined;
    }
    this.alertsSource?.clear();
    this.alertsSvc.clear();
  }

  // ─── Wind particles overlay (sprint 8) ────────────────────────────
  private initParticlesEngine(): void {
    if (this.particlesEngine) return;
    this.particlesCanvas = this.particlesEl().nativeElement;
    const ctx = this.particlesCanvas.getContext('2d', { alpha: true });
    if (!ctx) return;
    this.resizeParticlesCanvas();

    // Project lon/lat → canvas pixels via la View OL. Le 2e arg de
    // fromLonLat() doit matcher la projection courante de la View
    // (Phase C.4 : la View peut être en EPSG:3857 / 4326 / 3035, donc
    // on ne hardcode pas 3857). Sans ça :
    //   - EPSG:4326 : fromLonLat() renvoie des coords en mètres Mercator,
    //                 alors que la View attend des degrés → particules
    //                 dessinées hors-canvas → invisibles
    //   - EPSG:3035 : fromLonLat() renvoie aussi des coords Mercator
    //                 mètres globaux, mais la View les interprète comme
    //                 LAEA Europe (origine décalée ~4M, 3M) → offset énorme
    //                 et particules placées hors Europe
    const project = (lon: number, lat: number): [number, number] | null => {
      if (!this.map) return null;
      const proj = this.map.getView().getProjection();
      const px = this.map.getPixelFromCoordinate(fromLonLat([lon, lat], proj));
      if (!px || isNaN(px[0])) return null;
      return [px[0], px[1]];
    };

    this.particlesEngine = new WindParticleEngine(ctx, project, {
      numParticles: 1500,
      maxTtl: 200,
      advectScale: 0.0035,    // ~4× plus lent que sprint 8 v1 (feedback user)
      // V2 (2026-05-12) refactor polyline-history : trail dessiné comme
      // polyline depuis N frames d'historique au lieu de fade-cumul.
      // Bénéfice : couleur consistante par particule (pas de cumul qui
      // devient blanchâtre sur fond sombre). trailLength 32 frames =
      // ~535ms à 60fps → trail bien visible mais propre.
      trailLength: 32,
      lineWidth: 1.6,
    });

    // Resize observer pour suivre les changements de taille du conteneur
    window.addEventListener('resize', () => this.resizeParticlesCanvas());
    // Re-pre-render à chaque mouvement de la map (pan/zoom) : on clear le
    // canvas (sinon les anciennes traînées sont à la mauvaise position)
    this.map?.on('movestart', () => this.clearParticlesCanvas());
  }

  private resizeParticlesCanvas(): void {
    if (!this.particlesCanvas) return;
    const rect = this.particlesCanvas.parentElement?.getBoundingClientRect();
    if (!rect) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.particlesCanvas.width = rect.width * dpr;
    this.particlesCanvas.height = rect.height * dpr;
    this.particlesCanvas.style.width = `${rect.width}px`;
    this.particlesCanvas.style.height = `${rect.height}px`;
    const ctx = this.particlesCanvas.getContext('2d');
    if (ctx) ctx.scale(dpr, dpr);
    this.particlesEngine?.resize(this.particlesCanvas.width, this.particlesCanvas.height);
  }

  private clearParticlesCanvas(): void {
    if (!this.particlesCanvas) return;
    const ctx = this.particlesCanvas.getContext('2d');
    ctx?.clearRect(0, 0, this.particlesCanvas.width, this.particlesCanvas.height);
  }

  private async loadParticlesGrid(t: Date): Promise<void> {
    if (!this.particlesEngine) return;
    const manifest = await this.arrows.getManifest();
    if (!manifest) {
      this.windParticlesStatus.set('manifest indispo');
      return;
    }
    // Sprint 11 + Europe Chantier #2 + Phase C.6 : aligne les particules
    // sur la source choisie (GFS / ARPEGE / AROME). Si la source choisie
    // est vide (manifest empty) → fallback GFS.
    const src = this.windSource();
    const specific = src === 'arpege' ? manifest.arpege
                   : src === 'arome'  ? manifest.arome
                                      : null;
    const hasSpecific = Array.isArray(specific) && specific.length > 0;
    const tsList = hasSpecific ? specific! : manifest.wind;
    const kind: ArrowsKind = hasSpecific ? (src as ArrowsKind) : 'wind';
    const ts = this.arrows.findNearestTs(tsList, t);
    if (!ts) {
      this.windParticlesStatus.set('hors fenêtre forecast');
      this.particlesEngine.setGrid([]);
      return;
    }
    try {
      const fc = await this.arrows.fetchArrows(kind, ts);
      const grid: WindParticlePoint[] = fc.features.map((f: any) => {
        const speed = f.properties.speed as number;
        const dirTo = f.properties.dirTo as number;
        const { u, v } = speedDirToUv(speed, dirTo);
        return {
          lon: f.geometry.coordinates[0],
          lat: f.geometry.coordinates[1],
          u, v, speed,
        };
      });
      this.particlesEngine.setGrid(grid);
      this.windParticlesStatus.set(`${grid.length} pts × 1500 particules`);
    } catch (err: any) {
      this.windParticlesStatus.set(`erreur : ${err?.message ?? err}`);
    }
  }

  // ─── Refresh : déclenche le bon fetch selon currentTime ─────────────
  // 2026-05-17 perf-fix : chaque section est gated par le show*() signal
  // de la layer correspondante. Si la layer est cachée, pas d'updateParams
  // WMS (= pas de re-fetch d'image quand on bascule visibility back ON
  // plus tard, c'est OL qui re-fetch tout seul) ni de fetch WFS parasite.
  // Mesure Playwright 2026-05-17 : avant le fix, 1 toggle déclenchait
  // 3 re-fetches de sources non-modifiées.
  private refreshForTime(t: Date): void {
    const isLive = Math.abs(Date.now() - t.getTime()) < LIVE_THRESHOLD_MS;
    if (isLive) {
      // En mode live, le startLiveLoopIfNeeded gère le fetch vessels.
      this.trackSource?.clear();
      this.tracksCount.set(0);
      this.lastTrackDay = null;
      this.cancelPastVesselsFetch();
      this.closePopup();
    } else if (!this.isFuture()) {
      // Past mode : tracks daily (LineStrings) + vessels positions à T (debounced).
      // Pendant une animation : on skip fetchTracks (le feature type GS
      // vessel_tracks_daily n'expose pas `day` → 400 répété à chaque
      // frame). À ré-activer après reconfig GS REST. Skip aussi
      // scheduleFetchVesselsAt pour ne pas inonder l'API à 4× / sec.
      if (this.animPlayer.state() === 'idle') {
        // Gate fetchTracks par showTracks() — si la layer est OFF, le fetch
        // est inutile (les features ne seront jamais rendues).
        if (this.showTracks()) {
          const day = toIsoDate(t);
          if (day !== this.lastTrackDay) {
            this.lastTrackDay = day;
            this.fetchTracks(day);
          }
        }
        // Gate fetchVesselsAt par showVessels()
        if (this.showVessels()) {
          this.scheduleFetchVesselsAt(t);
        }
      }
    } else {
      // Future : aucun fetch (forecast pas implémenté).
      this.cancelPastVesselsFetch();
      this.vesselSource?.clear();
      this.vesselsCount.set(0);
    }
    // Snap-to-latest pour les WMS time-enabled : on passe une PLAGE
    // étroite au GS plutôt qu'un instant pile. GeoServer ImageMosaic
    // matche le timestep le plus récent dispo dans la plage — affiche
    // toujours la donnée la plus fraîche autour du cursor, plutôt qu'une
    // tile vide si l'instant exact n'est pas indexé.
    //
    // 2026-05-14 (Sylvain) : fenêtre cadrée pour soulager Mini-Blue.
    //   - SST = observation NOAA OISST. Délai publication
    //     preliminary→final 14-21j → fenêtre passée de 30 jours.
    //   - Wind/Wave = modèles forecast (GFS/AROME/ARPEGE/WaveWatch).
    //     Couverture utile run-analyse + horizons forecast : -1j / +7j.
    // Avant : 1970-01-01 → cursor (56 ans) faisait scanner des millions
    // de granules mosaic à chaque pan/zoom → sur-load CPU GS + timeouts.
    //
    // NB updateParams n'est PAS gated par show*() : si la source est
    // invisible, OL ne re-fetch pas (gratuit). Si on gatait, une layer
    // activée plus tard prendrait le TIME default GS (= timestep le plus
    // récent) au lieu du cursor courant — bug subtil à éviter.
    const isoTs = toIsoTimestamp(t);
    // Animation mode : on envoie TIME=instant (= timestamp précis du
    // master). GeoServer fait nearest-match auto pour les non-masters
    // grâce à nearestMatchEnabled+acceptableInterval configuré côté GS.
    // Hors animation : ranges étroites par layer (SST -30j, forecast
    // -1j/+7j) pour le snap-to-latest classique.
    const animating = this.animPlayer.state() !== 'idle';
    if (animating) {
      if (this.sstSource && !this.isFuture()) this.sstSource.updateParams({ TIME: isoTs });
      if (this.sstContoursSource && !this.isFuture()) this.sstContoursSource.updateParams({ TIME: isoTs });
      if (this.windWmsSource) this.windWmsSource.updateParams({ TIME: isoTs });
      if (this.wavesSource)   this.wavesSource.updateParams({ TIME: isoTs });
    } else {
      if (this.sstSource && !this.isFuture()) {
        const sstStart = new Date(t.getTime() - 30 * 24 * 3600 * 1000);
        const sstRange = `${toIsoTimestamp(sstStart)}/${isoTs}`;
        this.sstSource.updateParams({ TIME: sstRange });
        // 2026-05-17 : sstContoursSource doit suivre le même range que
        // sstSource (elle pointe sur la même featuretype maritime:sst-daily).
        if (this.sstContoursSource) this.sstContoursSource.updateParams({ TIME: sstRange });
      }
      const fcStart = new Date(t.getTime() - 1 * 24 * 3600 * 1000);
      const fcEnd   = new Date(t.getTime() + 7 * 24 * 3600 * 1000);
      const fcRange = `${toIsoTimestamp(fcStart)}/${toIsoTimestamp(fcEnd)}`;
      if (this.windWmsSource) this.windWmsSource.updateParams({ TIME: fcRange });
      if (this.wavesSource)   this.wavesSource.updateParams({ TIME: fcRange });
    }
  }

  /**
   * Debounce les fetches WFS pendant le drag du slider — évite de spammer
   * GeoServer (la SQL view scanne vessel_positions et coûte ~50-200ms).
   * Fenêtre par défaut ±5min : compromis entre densité (assez de bateaux
   * visibles) et précision temporelle.
   */
  private scheduleFetchVesselsAt(t: Date): void {
    if (this.pastFetchDebounce) clearTimeout(this.pastFetchDebounce);
    this.pastFetchDebounce = setTimeout(() => this.fetchVesselsAt(t), 150);
  }

  private fetchVesselsAt(t: Date): void {
    this.pastVesselsSub?.unsubscribe();
    this.pastVesselsSub = this.vessels
      .fetchVesselsAtTime(t, 300)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (fc) => {
          this.errorMsg.set(null);
          this.lastRefreshAt.set(new Date());
          this.vesselsCount.set(fc.features.length);
          if (!this.vesselSource) return;
          this.vesselSource.clear();
          const features = this.geoJsonFmt.readFeatures(fc);
          this.vesselSource.addFeatures(features);
        },
        error: (err) => {
          this.setError(`Erreur WFS replay : ${err.message ?? err}`, err);
          this.vesselsCount.set(0);
        },
      });
  }

  private cancelPastVesselsFetch(): void {
    if (this.pastFetchDebounce) {
      clearTimeout(this.pastFetchDebounce);
      this.pastFetchDebounce = undefined;
    }
    this.pastVesselsSub?.unsubscribe();
    this.pastVesselsSub = undefined;
  }

  private startLiveLoopIfNeeded(): void {
    if (!this.isLive()) {
      this.liveSub?.unsubscribe();
      this.liveSub = undefined;
      return;
    }
    if (this.liveSub) return; // déjà actif
    this.liveSub = interval(REFRESH_INTERVAL_MS)
      .pipe(
        startWith(0),
        switchMap(() => this.vessels.fetchLiveVessels(this.currentTimeSig())),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (fc) => {
          this.errorMsg.set(null);
          this.lastRefreshAt.set(new Date());
          this.vesselsCount.set(fc.features.length);
          if (!this.vesselSource) return;
          this.vesselSource.clear();
          const features = this.geoJsonFmt.readFeatures(fc);
          this.vesselSource.addFeatures(features);
        },
        error: (err) => this.setError(`Erreur WFS live : ${err.message ?? err}`, err),
      });
  }

  private fetchTracks(day: string): void {
    this.trackSub?.unsubscribe();
    this.trackSub = this.vessels
      .fetchTracksForDay(day)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (fc) => {
          this.errorMsg.set(null);
          this.tracksCount.set(fc.features.length);
          // NE PAS toucher vesselsCount : tracks et vessels sont 2 couches
          // indépendantes. Le bug pré-fix réinitialisait vesselsCount à 0
          // après chaque chargement de tracks, ce qui faisait croire que
          // les bateaux ne refresh pas (alors qu'ils étaient bien rendus).
          if (!this.trackSource) return;
          this.trackSource.clear();
          const features = this.geoJsonFmt.readFeatures(fc);
          this.trackSource.addFeatures(features);
        },
        error: (err) => {
          this.setError(`Erreur WFS tracks : ${err.message ?? err}`, err);
          this.tracksCount.set(0);
        },
      });
  }

  closePopup(): void {
    this.selectedVessel.set(null);
    this.selectedLightning.set(null);
    this.selectedAlert.set(null);
    this.selectedBuoy.set(null);
    this.selectedBuoyObs.set(null);
    this.selectedMetar.set(null);
    this.selectedHubeau.set(null);
    this.selectedQuake.set(null);
    this.selectedPiezo.set(null);
    this.selectedFirms.set(null);
    this.popupOverlay?.setPosition(undefined);
  }

  toggleAttr(): void {
    this.attrOpen.set(!this.attrOpen());
  }

  toggleLegend(): void {
    this.legendOpen.set(!this.legendOpen());
  }

  categoryLabel(shipType: number | null): string {
    return CATEGORY_COLOR[categoryOf(shipType)].label;
  }
  categoryColor(shipType: number | null): string {
    return CATEGORY_COLOR[categoryOf(shipType)].fill;
  }

  /** Bucket de fraîcheur d'une obs EMODnet (cf popup buoys) :
   *  - 'fresh' : <6h (vert)
   *  - 'recent' : <24h (orange)
   *  - 'stale' : >24h ou >7j (gris/rouge selon âge)
   *  Sert au style CSS .freshness-badge.fresh-{fresh|recent|stale|cold}. */
  freshnessFor(lastObsIso: string | null | undefined): string {
    if (!lastObsIso) return 'cold';
    const ageH = (Date.now() - new Date(lastObsIso).getTime()) / 3_600_000;
    if (ageH < 6) return 'fresh';
    if (ageH < 24) return 'recent';
    if (ageH < 24 * 7) return 'stale';
    return 'cold';
  }

  /** Label tooltip pour le badge fraîcheur. */
  freshnessLabel(lastObsIso: string | null | undefined): string {
    if (!lastObsIso) return 'Aucune obs récente';
    const ageH = (Date.now() - new Date(lastObsIso).getTime()) / 3_600_000;
    if (ageH < 1) return `Dernière obs : il y a ${Math.round(ageH * 60)} min — temps réel`;
    if (ageH < 24) return `Dernière obs : il y a ${Math.round(ageH)}h — récent`;
    const ageD = Math.round(ageH / 24);
    return `Dernière obs : il y a ${ageD}j — données anciennes`;
  }

  // ─── Map init ───────────────────────────────────────────────────────

  /** Phase C.3 bonus : recentre sur la zone par défaut (avec animation
   *  OL.animate 600ms). Utile post pan/zoom-out lointain. */
  recenterDefaultZone(): void {
    if (!this.map) return;
    const u = this.currentUser();
    const zoneId = u?.defaultZone || localStorage.getItem('maritime.default-zone') || DEFAULT_ZONE_ID;
    const zone = findZone(zoneId);
    const projection = this.map.getView().getProjection().getCode();
    this.map.getView().animate({
      center: fromLonLat(zone.center, projection),
      zoom: zone.zoom,
      duration: 600,
    });
  }

  /** Tooltip dynamique sur le bouton recentrer. */
  readonly recenterTooltip = computed(() => {
    const u = this.currentUser();
    const zoneId = u?.defaultZone || DEFAULT_ZONE_ID;
    const z = findZone(zoneId);
    return `Recentrer sur ${z.label}`;
  });

  // ─── Animation player ──────────────────────────────────────────────
  readonly animPanelOpen = signal<boolean>(false);

  /** True si au moins une couche forecast est actuellement active.
   *  Sert au mode "Auto" du panel animation (past par défaut, future
   *  si forecast). */
  isForecastActive(): boolean {
    return this.showWind() || this.showWaves() || this.showWindParticles();
  }

  openAnimationPanel(): void {
    if (this.animPlayer.state() !== 'idle') return;
    this.animPanelOpen.set(true);
  }

  closeAnimationPanel(): void {
    this.animPanelOpen.set(false);
  }

  async onAnimationLaunch(opts: AnimationOptions): Promise<void> {
    this.animPanelOpen.set(false);

    // Phase 1 — pattern Eumetview : on parcourt les timestamps réels du
    // master plutôt qu'un step 1h fixe. Si aucun master (rien d'actif),
    // fallback legacy.
    const masterKey = this.masterLayerKey();
    if (!masterKey) {
      this.animPlayer.start(opts);
      return;
    }
    const master = this.animatableLayers.find((l) => l.key === masterKey);
    if (!master) {
      this.animPlayer.start(opts);
      return;
    }

    // Compute window [start, end] depuis duration + direction pour clamper
    // les timestamps fetchés (le master peut publier au-delà).
    const window = this.computeAnimationWindow(opts);
    const timestamps = await this.fetchTimestamps(master, window.start, window.end);

    this.animPlayer.start({
      ...opts,
      timestamps,
      masterLayerLabel: master.label,
    });
  }

  /** Calcule la fenêtre [start, end] selon direction + duration. */
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

  /** Récupère la liste des timestamps disponibles pour le master sur la
   *  fenêtre [start, end]. WMS → GS GetCapabilities + parse `<Dimension>`.
   *  Vector → scan 30min (pas de capabilities WFS pour le temps). */
  private async fetchTimestamps(
    master: { type: 'wms' | 'vector'; gsLayerName?: string },
    start: Date,
    end: Date,
  ): Promise<Date[]> {
    if (master.type === 'vector') {
      // Scan toutes les 30min — convention Sylvain pour les sources
      // continues (AIS, foudre, METAR).
      const STEP = 30 * 60_000;
      const out: Date[] = [];
      for (let t = start.getTime(); t <= end.getTime(); t += STEP) {
        out.push(new Date(t));
      }
      return out;
    }
    if (!master.gsLayerName) return [];
    try {
      const url = `/geoserver/maritime/wms?service=WMS&version=1.3.0&request=GetCapabilities`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!resp.ok) throw new Error(`GetCapabilities HTTP ${resp.status}`);
      const xml = await resp.text();
      return this.parseTimeDimension(xml, master.gsLayerName)
        .filter((t) => t.getTime() >= start.getTime() && t.getTime() <= end.getTime());
    } catch (err) {
      console.warn('[anim] GetCapabilities échec, fallback step 1h :', err);
      return [];
    }
  }

  /** Parse le <Dimension name="time"> d'un layer dans le doc WMS Caps.
   *  Format type : "2026-05-13T00:00:00Z,2026-05-14T00:00:00Z,...".
   *  Supporte aussi l'intervalle "start/end/PERIOD" → on enumere. */
  private parseTimeDimension(xml: string, layerName: string): Date[] {
    // Match le <Layer> avec le bon <Name>layerName</Name> + son <Dimension>
    const escaped = layerName.replace(/[/.]/g, '\\$&');
    const layerRe = new RegExp(
      `<Layer[^>]*>[\\s\\S]*?<Name>${escaped}</Name>[\\s\\S]*?<Dimension[^>]*name="time"[^>]*>([^<]*)</Dimension>[\\s\\S]*?</Layer>`,
      'i',
    );
    const m = xml.match(layerRe);
    if (!m) return [];
    const raw = m[1].trim();
    const out: Date[] = [];
    for (const token of raw.split(',')) {
      const trimmed = token.trim();
      if (!trimmed) continue;
      if (trimmed.includes('/')) {
        // Interval : start/end/PERIOD (rare en pratique pour mosaïque, on ignore)
        continue;
      }
      const d = new Date(trimmed);
      if (!isNaN(d.getTime())) out.push(d);
    }
    return out;
  }

  /** Appelé quand l'utilisateur click le bouton ▶︎ du time-slider.
   *  Logique : idle → ouvre la modal de config / playing → pause /
   *  paused → resume. C'est l'unique entry point UI pour l'animation. */
  onSliderPlayClicked(): void {
    const state = this.animPlayer.state();
    if (state === 'idle') {
      this.openAnimationPanel();
    } else if (state === 'playing') {
      this.animPlayer.pause();
    } else if (state === 'paused') {
      this.animPlayer.resume();
    }
  }

  /** Phase C.3 + C.4 (2026-05-12) : construit la View initiale avec la
   *  zone d'arrivée + projection préférée du user (DB pour connectés,
   *  localStorage sinon, fallback 'france' + EPSG:3857).
   *
   *  Les particules de vent et flèches sont stockées en lon/lat et
   *  reprojetées par OL au moment du draw → le rendu reste correct
   *  quelle que soit la projection (l'orientation visuelle change
   *  seulement parce que les méridiens convergent en Lambert vs
   *  parallèles en Mercator). */
  private buildInitialView(): View {
    // 1. Résoudre la projection. EPSG:3857 fonctionne nativement, les
    //    autres requièrent proj4 register fait par registerCustomProjections().
    const u = this.currentUser();
    const projectionCode =
      u?.preferredProjection ||
      localStorage.getItem('maritime.preferred-projection') ||
      DEFAULT_PROJECTION;
    if (projectionCode !== 'EPSG:3857' && projectionCode !== 'EPSG:4326') {
      registerCustomProjections();
    }
    // 2. Résoudre la zone (slug → bbox/center/zoom).
    const zoneId =
      u?.defaultZone ||
      localStorage.getItem('maritime.default-zone') ||
      DEFAULT_ZONE_ID;
    const zone = findZone(zoneId);
    // 3. Convertir le center lon/lat vers la projection cible.
    //    fromLonLat() supporte un 2e arg = target projection.
    const center = fromLonLat(zone.center, projectionCode);
    return new View({
      projection: projectionCode,
      center,
      zoom: zone.zoom,
      // minZoom 3 (sprint Europe) pour vue d'ensemble Atlantique + Méditerranée.
      // En projection non-Mercator, les zooms ne s'alignent pas 1:1 — on garde
      // les mêmes bornes ; OL gère le clamp.
      minZoom: 3,
      maxZoom: 14,
    });
  }

  private initMap(): void {
    // Build la View tôt + on la réutilise en bas (au lieu de re-call
    // buildInitialView() dans new Map). Pas besoin de viewProj sur les
    // ImageWMS sources : OL inherit auto la projection de la view.
    const initialView = this.buildInitialView();

    // Attributions exposées via le contrôle Attribution OpenLayers (icône
    // (i) bas-droite). Chaque source déclare sa propre attribution → l'icône
    // affiche la liste complète au survol.
    const ATTRIB_AIS = 'Positions navires © <a href="https://aisstream.io" target="_blank">aisstream.io</a>';
    const ATTRIB_NOAA = 'Modèles météo © <a href="https://nomads.ncep.noaa.gov" target="_blank">NOAA NOMADS</a> (GFS, WW3, OISST)';
    const ATTRIB_ARPEGE = 'Vent Europe © <a href="https://meteo.data.gouv.fr" target="_blank">Météo-France ARPEGE</a>';
    const ATTRIB_AROME = 'Vent FR HD © <a href="https://meteo.data.gouv.fr" target="_blank">Météo-France AROME 2.5km</a>';
    const ATTRIB_LIGHTNING = 'Foudre © <a href="https://www.blitzortung.org" target="_blank">Blitzortung community network</a>';
    const ATTRIB_RAIN = 'Radar pluie © <a href="https://www.rainviewer.com" target="_blank">RainViewer</a>';
    const ATTRIB_CANDHIS = 'Bouées houle © <a href="https://candhis.cerema.fr" target="_blank">CANDHIS / CEREMA</a> (Licence Etalab 2.0)';

    this.vesselSource = new VectorSource({ attributions: ATTRIB_AIS });
    this.trackSource = new VectorSource({ attributions: ATTRIB_AIS });

    // Phase C.5 (2026-05-12) : on passe par notre nginx proxy_cache
    // (`/carto-tiles/<style>/{z}/{x}/{y}.png`) au lieu de taper direct
    // cartocdn.com — réduit le traffic + cache local 30j + résilience
    // si CARTO down. Note : pas de `{a-d}` sharding side OL puisque le
    // cache est unifié côté serveur.
    // V2 Sources #1 : baseTile + labelsTile stockés en fields pour permettre
    // le switch dynamique (signal `basemap`). Sources initialisées dans
    // applyBasemap() ci-dessous selon la valeur restaurée du localStorage.
    this.baseTile = new TileLayer({
      source: new XYZ({
        url: '/carto-tiles/dark_nolabels/{z}/{x}/{y}.png',
        attributions: '© OpenStreetMap, © CARTO',
        maxZoom: 19,
      }),
    });
    this.labelsTile = new TileLayer({
      source: new XYZ({
        url: '/carto-tiles/dark_only_labels/{z}/{x}/{y}.png',
        attributions: '',
        maxZoom: 19,
      }),
      zIndex: 50,
    });
    // viewProj est défini en haut de la fonction (depuis initialView).
    // V2 Sources #2 : Bathymétrie EMODnet WMS (TileLayer raster).
    // mean_atlas_land = bathymétrie nuancée bleu (lecture facile).
    // zIndex 4 = juste au-dessus du baseTile, sous les rasters thématiques.
    // URL passe par nginx proxy /wms-emodnet (cache 14j) pour éviter de
    // spammer ows.emodnet-bathymetry.eu à chaque client.
    this.bathyLayer = new TileLayer({
      source: new TileWMS({
        url: '/wms-emodnet',
        projection: 'EPSG:3857',
        params: { LAYERS: 'mean_atlas_land', TILED: true, TRANSPARENT: true, FORMAT: 'image/png' },
        attributions: '© <a href="https://emodnet.ec.europa.eu/en/bathymetry">EMODnet Bathymetry</a>',
      }),
      zIndex: 4,
      visible: false,
      opacity: 0.7,
    });
    // V2 Sources #3 : EEZ (Zones Économiques Exclusives) Marine Regions WMS.
    // Layer eez = polygones EEZ monde stylés par défaut (bordures + fill
    // léger). zIndex 6 = au-dessus de Bathy (4), sous tout le reste.
    // Proxy /wms-marineregions cache 30 jours (data stable).
    this.eezLayer = new TileLayer({
      source: new TileWMS({
        url: '/wms-marineregions',
        projection: 'EPSG:3857',
        params: { LAYERS: 'MarineRegions:eez', TILED: true, TRANSPARENT: true, FORMAT: 'image/png' },
        attributions: '© <a href="https://www.marineregions.org/">Marine Regions</a> (VLIZ, CC BY-NC-SA 4.0)',
      }),
      zIndex: 6,
      visible: false,
      opacity: 0.6,
    });
    // V2 Sources #4 : MPA (Aires Marines Protégées) EMODnet Human Activities.
    // Proxy /wms-emodnet-human cache 30j (data statique).
    this.mpaLayer = new TileLayer({
      source: new TileWMS({
        url: '/wms-emodnet-human',
        projection: 'EPSG:3857',
        params: { LAYERS: 'marineprotectedareas', TILED: true, TRANSPARENT: true, FORMAT: 'image/png' },
        attributions: '© <a href="https://emodnet.ec.europa.eu/en/human-activities">EMODnet Human Activities</a>',
      }),
      zIndex: 7,  // au-dessus EEZ (6)
      visible: false,
      opacity: 0.6,
    });
    // V2 Hydrologie #3 : EFAS forecast crues Copernicus WMS.
    // Layer `efas_forecast_flood_probability` = probabilité dépassement
    // seuil de crue sur 10 jours forecast. zIndex 95 = au-dessus du wind
    // mais sous les vector layers (vessels, alerts...).
    // URL passe par nginx proxy /wms-efas (cache 4h) pour éviter le spam.
    this.efasLayer = new TileLayer({
      source: new TileWMS({
        url: '/wms-efas',
        projection: 'EPSG:3857',
        params: { LAYERS: 'efas_forecast_flood_probability', TILED: true, TRANSPARENT: true, FORMAT: 'image/png' },
        attributions: '© <a href="https://www.efas.eu/">EFAS — Copernicus Emergency Management Service</a>',
      }),
      zIndex: 95,
      visible: false,
      opacity: 0.7,
    });
    // Alias locaux pour le map.layers ci-dessous (le code existant utilise
    // baseTile/labelsTile en variable locale).
    const baseTile = this.baseTile;
    const labelsTile = this.labelsTile;

    // SST raster layer — WMS time-enabled depuis GeoServer ImageMosaic.
    // Le param TIME est mis à jour par refreshForTime() à chaque change
    // de currentTime.
    //
    // Cap zoom 8 : SST NOAA OISST a une résolution native 0.25° (~27 km
    // /pixel). Au-delà de zoom 8 (~600 m/pixel en EPSG:3857), on demande
    // à GeoServer un sur-échantillonnage ×40+ qui sature le pod et
    // produit des timeouts (Cloudflare tunnel 100s max). Bug 2026-05-14.
    this.sstSource = new ImageWMS({
      url: '/geoserver/maritime/wms',
      projection: 'EPSG:3857',
      ratio: 1.0,  // 1.2 → 1.0 (Sylvain 2026-05-14 soir) — évite OOM heap GS
      params: {
        LAYERS: 'maritime:sst-daily',
        TRANSPARENT: true,
        INTERPOLATIONS: 'bicubic',
      },
      serverType: 'geoserver',
      attributions: ATTRIB_NOAA,
    });
    this.sstLayer = new ImageLayer({
      source: this.sstSource,
      opacity: 0.6,
      zIndex: 30,
      visible: false,
      maxZoom: 8,
    });
    // 2026-05-17 : robustesse — quand GS répond 404 ponctuellement (drift
    // pod, GC pause, redémarrage), OL throw EncodingError et hide la layer
    // SANS retry. Bug "layers disparaissent sans nouvelle requête" qui a
    // pourri tout le week-end. Avec cet imageloaderror handler, on force
    // un refresh() 3s après chaque erreur → la layer revient dès que le
    // pod GS est revenu à la normale (max 3-10s sur un GC long).
    this.sstSource.on('imageloaderror', () => {
      setTimeout(() => this.sstSource?.refresh(), 3000);
    });

    // 2026-05-17 : layer SST contours dédiée (SLD sst-contours-only avec
    // ras:Contour standard, pas IDW). zIndex 31 au-dessus de sstLayer (30).
    // INTERPOLATIONS=bicubic IDENTIQUE au raster sstSource : les contours
    // sont alors calculés sur la même donnée bicubic resampée → alignement
    // visuel parfait avec les couleurs du raster (Sylvain 2026-05-17 :
    // "on utilise pas IDW sur les rasters, utilise bicubic comme le raster
    // pour les isolines").
    this.sstContoursSource = new ImageWMS({
      url: '/geoserver/maritime/wms',
      projection: 'EPSG:3857',
      ratio: 1.0,
      params: {
        LAYERS: 'maritime:sst-daily',
        STYLES: 'maritime:sst-contours-only',
        TRANSPARENT: true,
        INTERPOLATIONS: 'bicubic',
        env: `contourInterval:${this.sstContourInterval()}`,
      },
      serverType: 'geoserver',
      attributions: ATTRIB_NOAA,
    });
    this.sstContoursLayer = new ImageLayer({
      source: this.sstContoursSource,
      opacity: 0.9,
      zIndex: 31,
      visible: false,
      maxZoom: 8,
    });
    this.sstContoursSource.on('imageloaderror', () => {
      setTimeout(() => this.sstContoursSource?.refresh(), 3000);
    });

    // Vent (force, m/s) — WMS time-enabled depuis ImageMosaic GeoServer.
    // GeoServer applique automatiquement un style "raster" arc-en-ciel par
    // défaut. Sprint 11 + Europe Chantier #2 + Phase C.6 (AROME réintro) :
    // le LAYERS param est dynamique (signal `windSource`) entre
    // 'maritime:wind-speed' (GFS) / 'maritime:wind-speed-arpege' /
    // 'maritime:wind-speed-arome'.
    const wsrc = this.windSource();
    const initialWindLayer = wsrc === 'arpege' ? 'maritime:wind-speed-arpege'
                           : wsrc === 'arome'  ? 'maritime:wind-speed-arome'
                                               : 'maritime:wind-speed';
    // Cap zoom 10 : GFS=0.25° (27 km), ARPEGE=0.1° (11 km), AROME=0.025°
    // (2.5 km). Au-delà de zoom 10 (~150 m/pixel), sur-échantillonnage
    // excessif même sur AROME. Le LAYERS bascule dynamique (GFS/ARPEGE/
    // AROME), on prend la borne sécurisée pour la moins fine.
    this.windWmsSource = new ImageWMS({
      url: '/geoserver/maritime/wms',
      projection: 'EPSG:3857',
      ratio: 1.0,  // 1.2 → 1.0 (Sylvain 2026-05-14 soir) — évite OOM heap GS
      params: { LAYERS: initialWindLayer, TRANSPARENT: true, INTERPOLATIONS: 'bicubic' },
      serverType: 'geoserver',
      attributions: [ATTRIB_NOAA, ATTRIB_ARPEGE, ATTRIB_AROME],
    });
    this.windLayer = new ImageLayer({
      source: this.windWmsSource,
      opacity: 0.55,
      zIndex: 32,
      visible: false,
      maxZoom: 10,
    });
    this.windWmsSource.on('imageloaderror', () => {
      setTimeout(() => this.windWmsSource?.refresh(), 3000);
    });

    // Vagues (hauteur sig., m) — WMS time-enabled.
    // Cap zoom 7 : NOAA WaveWatch III a une résolution native 0.5°
    // (~55 km/pixel). zoom 7 = ~1.2 km/pixel, déjà ×45 sur-échantillonnage.
    this.wavesSource = new ImageWMS({
      url: '/geoserver/maritime/wms',
      projection: 'EPSG:3857',
      ratio: 1.0,  // 1.2 → 1.0 (Sylvain 2026-05-14 soir) — évite OOM heap GS
      params: { LAYERS: 'maritime:wave-hs', TRANSPARENT: true, INTERPOLATIONS: 'bicubic' },
      serverType: 'geoserver',
      attributions: ATTRIB_NOAA,
    });
    this.wavesLayer = new ImageLayer({
      source: this.wavesSource,
      opacity: 0.55,
      zIndex: 33,
      visible: false,
      maxZoom: 7,
    });
    this.wavesSource.on('imageloaderror', () => {
      setTimeout(() => this.wavesSource?.refresh(), 3000);
    });

    // Sprint 10 : alertes maritimes. VectorSource peuplé toutes les 30s
    // via WFS sur v_alerts_recent. Style triangle de warning coloré selon
    // severity (warning=orange, danger=rouge).
    this.alertsSource = new VectorSource({
      attributions: 'Alertes AetherWX (engine RMQ croise AIS + GFS + Blitzortung)',
    });
    this.alertsLayer = new VectorLayer({
      source: this.alertsSource,
      style: (feat: FeatureLike) => this.styleAlert(feat),
      zIndex: 115,
      visible: false,
      declutter: true,
    });

    // Sprint 7 : éclairs (lightning strikes) overlay. VectorSource peuplé
    // toutes les 30s via WFS sur v_lightning_recent. Style "zap" pulsé selon
    // age_seconds : flash blanc-jaune pour <60s, jaune pour <5min, ambre
    // pour <30min, fade.
    this.lightningSource = new VectorSource({ attributions: ATTRIB_LIGHTNING });
    this.lightningLayer = new VectorLayer({
      source: this.lightningSource,
      style: (feat: FeatureLike) => this.styleLightning(feat),
      zIndex: 110,
      visible: false,
    });

    // Sprint 6 : flèches vent + flèches vagues. VectorSource alimenté à
    // chaque tick du time slider via fetch GeoJSON (manifest + nearest ts).
    this.windArrowsSource = new VectorSource({
      attributions: [ATTRIB_NOAA, ATTRIB_ARPEGE, ATTRIB_AROME],
    });
    this.windArrowsLayer = new VectorLayer({
      source: this.windArrowsSource,
      // Le `kind` passé au style suit le signal `windSource()` — palette
      // Beaufort identique pour les 3 sources mais on garde la sémantique.
      style: (feat: FeatureLike) => this.styleArrow(
        this.windSource() === 'arpege' ? 'arpege'
        : this.windSource() === 'arome' ? 'arome' : 'wind',
        feat,
      ),
      zIndex: 95,
      visible: false,
      declutter: true,
    });
    this.waveArrowsSource = new VectorSource({ attributions: ATTRIB_NOAA });
    this.waveArrowsLayer = new VectorLayer({
      source: this.waveArrowsSource,
      style: (feat: FeatureLike) => this.styleArrow('wave', feat),
      zIndex: 96,
      visible: false,
      declutter: true,
    });

    // Radar pluie via RainViewer XYZ tiles. URL initiale "transparent" =
    // 1×1 png vide, on remplace via setUrl() dès qu'un snapshot est dispo.
    // Crossorigin obligatoire pour permettre canvas readback (au cas où).
    this.rainSource = new XYZ({
      url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAarVyFEAAAAASUVORK5CYII=',
      crossOrigin: 'anonymous',
      attributions: '© <a href="https://rainviewer.com" target="_blank">RainViewer</a>',
      maxZoom: 12,
    });
    this.rainLayer = new TileLayer({
      source: this.rainSource,
      opacity: 0.7,
      zIndex: 40,             // au-dessus du SST mais sous les vessels/labels
      visible: false,
    });

    // Sprint Europe Chantier #4 : clustering vessels.
    // Bbox Europe étroite → 10k-30k vessels live en pic, le rendu OL freeze
    // la carte si on peint chaque navire individuellement à grand zoom-out.
    // On wrap le `vesselSource` (qui reste la "vérité" alimentée par les
    // services AIS) dans un `Cluster` OL natif. La VectorLayer affiche le
    // cluster source ; à grand zoom, les vessels sont agrégés en disques
    // numérotés ; à zoom rapproché (pixelDistance reste constant mais
    // l'écart pixel entre navires augmente), les clusters se dissocient
    // naturellement pour révéler chaque silhouette individuelle.
    //
    // pixelDistance=55 : compromis lisibilité — assez fin pour distinguer
    // des hot-spots (Manche, Méditerranée orientale) tout en gardant un
    // count cluster utile.
    this.vesselClusterSource = new Cluster({
      source: this.vesselSource,
      distance: 55,
      minDistance: 28,
    });
    this.vesselLayer = new VectorLayer({
      source: this.vesselClusterSource,
      style: (feature: FeatureLike) => this.styleVessel(feature),
      zIndex: 100,
      visible: true,
    });

    // Bouées CANDHIS — référentiel statique des houlographes CEREMA.
    // VectorSource alimenté au boot + reload quotidien (les positions
    // bougent rarement). Si le backend a une CANDHIS_API_KEY, on fetch
    // aussi les obs TR via v_buoy_observations_recent toutes les 5min
    // pour peupler buoyObsByCandhisId (utilisé par le popup).
    this.buoysSource = new VectorSource({ attributions: ATTRIB_CANDHIS });
    this.buoysLayer = new VectorLayer({
      source: this.buoysSource,
      style: (feat: FeatureLike) => this.styleBuoy(feat),
      zIndex: 105,           // au-dessus des navires (100), sous lightning (110)
      visible: false,
      declutter: true,
    });

    // METAR (V2 Observation #1) — ~35 aéroports EU. zIndex 107 = au-dessus
    // des bouées (105), sous lightning (110).
    this.metarSource = new VectorSource({ attributions: 'NOAA Aviation Weather Center' });
    this.metarLayer = new VectorLayer({
      source: this.metarSource,
      style: (feat: FeatureLike) => this.styleMetar(feat),
      zIndex: 107,
      visible: false,
      declutter: true,
    });

    // Hub'eau débits (V2 Hydrologie #1) — ~500 stations FR. zIndex 106 =
    // sous METAR (107) car priorité visuelle moindre (couleur cyan plus
    // discrète, et debits non-time-critical vs aéro).
    this.hubeauSource = new VectorSource({ attributions: 'Hub\'eau Eaufrance' });
    this.hubeauLayer = new VectorLayer({
      source: this.hubeauSource,
      style: (feat: FeatureLike) => this.styleHubeau(feat),
      zIndex: 106,
      visible: false,
      declutter: false,  // 500 points, on accepte le chevauchement (cluster pourrait venir plus tard)
    });

    // Séismes USGS (V2 Observation #2) — feed mondial all_day. zIndex 108
    // (au-dessus de METAR, sous lightning) pour visibilité des gros mags.
    this.quakesSource = new VectorSource({ attributions: 'USGS Earthquakes' });
    this.quakesLayer = new VectorLayer({
      source: this.quakesSource,
      style: (feat: FeatureLike) => this.styleQuake(feat),
      zIndex: 108,
      visible: false,
      declutter: false,
    });

    // Hub'eau piézomètres (V2 Hydrologie #2) — ~1500 stations FR. zIndex
    // 104 sous Hub'eau débits (106) car piezo bouge slowly + couleur
    // plus foncée pour différencier visuellement.
    this.piezoSource = new VectorSource({ attributions: 'Hub\'eau Eaufrance — nappes' });
    this.piezoLayer = new VectorLayer({
      source: this.piezoSource,
      style: (feat: FeatureLike) => this.stylePiezo(feat),
      zIndex: 104,
      visible: false,
      declutter: false,
    });

    // FIRMS NASA hotspots (V2 Observation #3) — feux 24h EU. zIndex 109
    // (au-dessus de quakes, sous lightning) pour visibilité sur de gros
    // feux. Couleurs rouge-orange-jaune par FRP.
    this.firmsSource = new VectorSource({ attributions: 'NASA FIRMS MODIS C6.1' });
    this.firmsLayer = new VectorLayer({
      source: this.firmsSource,
      style: (feat: FeatureLike) => this.styleFirms(feat),
      zIndex: 109,
      visible: false,
      declutter: false,
    });

    this.trackLayer = new VectorLayer({
      source: this.trackSource,
      style: () => this.styleTrack(),
      zIndex: 90,
      visible: false,
    });

    this.popupOverlay = new Overlay({
      element: this.popupEl().nativeElement,
      positioning: 'bottom-center',
      stopEvent: true,
      offset: [0, -12],
    });

    this.map = new Map({
      target: this.mapEl().nativeElement,
      layers: [
        baseTile,
        this.bathyLayer,
        this.eezLayer,
        this.mpaLayer,
        this.sstLayer,
        this.sstContoursLayer,
        this.windLayer,
        this.wavesLayer,
        this.rainLayer,
        this.efasLayer,
        labelsTile,
        this.waveArrowsLayer,
        this.windArrowsLayer,
        this.trackLayer,
        this.vesselLayer,
        this.buoysLayer,
        this.piezoLayer,
        this.hubeauLayer,
        this.metarLayer,
        this.quakesLayer,
        this.firmsLayer,
        this.lightningLayer,
        this.alertsLayer,
      ],
      overlays: [this.popupOverlay],
      // L'Attribution OL natif est désactivé — son CSS injecte un text-shadow
      // qui rend les letterforms hollow/glow sur dark bg (cf. /case-study).
      // À la place, un <div class="attribution-bar"> Angular maison (cf. template)
      // affiche les sources en clair avec liens HTML normaux.
      //
      // Phase Layer UX V2.1 : on désactive aussi le Zoom par défaut pour le
      // recréer manuellement avec target=zoomDockEl (top-right sous auth-corner).
      // ScaleLine + MousePosition vont dans infoDockEl (bottom-right).
      controls: defaultControls({ attribution: false, zoom: false }).extend([
        new Zoom({ target: this.zoomDockEl().nativeElement }),
        new ScaleLine({ target: this.infoDockEl().nativeElement, units: 'nautical' }),
        // Affiche les coordonnées sous le curseur en HDMS (degrés / minutes /
        // secondes lat-lon WGS84). Caché sur mobile (touch n'a pas de cursor).
        new MousePosition({
          target: this.infoDockEl().nativeElement,
          projection: 'EPSG:4326',
          coordinateFormat: (coord) => coord ? toStringHDMS(coord, 1) : '',
          className: 'ol-mouse-position',
          placeholder: '—',
        }),
      ]),
      view: initialView,
    });

    // Click handler — route le popup selon la layer source de la feature.
    // forEachFeatureAtPixel passe le layer en 2e arg, ce qui permet de
    // distinguer vessel / lightning / alert sans inspecter les props.
    this.map.on('singleclick', (evt) => {
      type ClickKind = 'vessel' | 'lightning' | 'alert' | 'buoy' | 'metar' | 'hubeau' | 'quake' | 'piezo' | 'firms';
      let matched: { feat: Feature<Geometry>; kind: ClickKind } | null = null;
      this.map!.forEachFeatureAtPixel(
        evt.pixel,
        (f, layer) => {
          if (matched) return;
          if (layer === this.vesselLayer) matched = { feat: f as Feature<Geometry>, kind: 'vessel' };
          else if (layer === this.lightningLayer) matched = { feat: f as Feature<Geometry>, kind: 'lightning' };
          else if (layer === this.alertsLayer) matched = { feat: f as Feature<Geometry>, kind: 'alert' };
          else if (layer === this.buoysLayer) matched = { feat: f as Feature<Geometry>, kind: 'buoy' };
          else if (layer === this.metarLayer) matched = { feat: f as Feature<Geometry>, kind: 'metar' };
          else if (layer === this.hubeauLayer) matched = { feat: f as Feature<Geometry>, kind: 'hubeau' };
          else if (layer === this.quakesLayer) matched = { feat: f as Feature<Geometry>, kind: 'quake' };
          else if (layer === this.piezoLayer) matched = { feat: f as Feature<Geometry>, kind: 'piezo' };
          else if (layer === this.firmsLayer) matched = { feat: f as Feature<Geometry>, kind: 'firms' };
        },
        { hitTolerance: 4 },
      );
      if (!matched) {
        this.closePopup();
        return;
      }
      this.closePopup();      // reset les signals avant le set
      const m = matched as { feat: Feature<Geometry>; kind: ClickKind };
      // Sprint Europe #4 : cluster handling. Si on a cliqué un cluster
      // vessels (m.feat.get('features').length > 1), on zoom-in à la place
      // d'ouvrir une popup. Le cluster va naturellement se dissocier quand
      // pixelDistance > écart entre features.
      if (m.kind === 'vessel') {
        const clusterFeats = m.feat.get('features') as Feature[] | undefined;
        if (Array.isArray(clusterFeats) && clusterFeats.length > 1) {
          const view = this.map!.getView();
          const currentZoom = view.getZoom() ?? INITIAL_ZOOM;
          const geom = m.feat.getGeometry();
          if (geom?.getType() === 'Point') {
            view.animate({
              center: (geom as Point).getCoordinates(),
              zoom: Math.min(currentZoom + 2, 14),
              duration: 350,
            });
          }
          return;
        }
        // Cluster size = 1 : on déréférence pour récupérer la vraie feature
        // vessel (sinon les `properties` sont celles du cluster wrapper).
        if (Array.isArray(clusterFeats) && clusterFeats.length === 1) {
          m.feat = clusterFeats[0] as Feature<Geometry>;
        }
      }
      const props = m.feat.getProperties() as any;
      delete props.geometry;
      switch (m.kind) {
        case 'vessel':    this.selectedVessel.set(props as VesselProperties); break;
        case 'lightning': this.selectedLightning.set(props as LightningProperties); break;
        case 'alert':     this.selectedAlert.set(props as AlertProperties); break;
        case 'buoy': {
          const bp = props as BuoyProperties;
          this.selectedBuoy.set(bp);
          // Lookup obs récente dans le cache (peuplé par fetchBuoyObs)
          const obs = this.buoyObsByCandhisId.get(bp.candhis_id) ?? null;
          this.selectedBuoyObs.set(obs);
          break;
        }
        case 'metar':    this.selectedMetar.set(props as MetarProperties); break;
        case 'hubeau':   this.selectedHubeau.set(props as HubeauProperties); break;
        case 'piezo':    this.selectedPiezo.set(props as PiezoProperties); break;
        case 'firms':    this.selectedFirms.set(props as FirmsProperties); break;
        case 'quake': {
          // Le feed USGS encode la profondeur (km) dans la 3ème dim de la
          // geometry. On l'extrait avant de set le selectedQuake.
          const geom = m.feat.getGeometry();
          let depth_km: number | null = null;
          if (geom?.getType() === 'Point') {
            const coord = (geom as Point).getCoordinates();
            if (coord.length >= 3) depth_km = coord[2];
          }
          this.selectedQuake.set({ ...(props as QuakeProperties), depth_km });
          break;
        }
      }
      const geom = m.feat.getGeometry();
      if (geom?.getType() === 'Point') {
        this.popupOverlay?.setPosition((geom as Point).getCoordinates());
      }
    });

    this.map.on('pointermove', (evt) => {
      const target = this.map!.getTarget() as HTMLElement | null;
      if (!target) return;
      const has = this.map!.hasFeatureAtPixel(evt.pixel);
      target.style.cursor = has ? 'pointer' : '';
    });
  }

  // ─── Styles ─────────────────────────────────────────────────────────
  /**
   * Icône navire : SVG losange (boat-like silhouette) coloré selon la
   * catégorie + rotation par cog si disponible (sinon orienté nord).
   * Forme distinctive des éclairs (qui sont des bolts ⚡).
   */
  private vesselIconCache: Record<string, string> = {};
  private vesselIconDataUrl(fill: string, stroke: string): string {
    const key = `${fill}|${stroke}`;
    if (this.vesselIconCache[key]) return this.vesselIconCache[key];
    // Silhouette bateau vu du dessus, style marinetraffic / vesselfinder :
    // bow pointu en haut, stern arrondi en bas avec encoche centrale (V-tail).
    // Asymétrique avant/arrière = orientation lisible même sans rotation.
    // Inspiration : Lucide `ship` simplifié pour des petits zoom levels.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="18" viewBox="0 0 16 18">
      <path d="M8 1
               C 10.5 4, 12 7.5, 12 11
               L 12 14
               L 9 15
               L 8 13
               L 7 15
               L 4 14
               L 4 11
               C 4 7.5, 5.5 4, 8 1 Z"
        fill="${fill}" stroke="${stroke}" stroke-width="1" stroke-linejoin="round"/>
    </svg>`;
    const url = 'data:image/svg+xml;base64,' + btoa(svg);
    this.vesselIconCache[key] = url;
    return url;
  }
  private styleVessel(feature: FeatureLike): Style {
    // Sprint Europe #4 : la layer vessels pointe sur un Cluster source.
    // Chaque "feature" reçue par cette fonction est soit un cluster
    // (props.features = Feature[] de size ≥ 1) soit une feature seule
    // (back-compat — Cluster wrap toujours, mais une feature seule au
    // milieu de rien aura un cluster de size 1).
    const clusterFeats = feature.get('features') as Feature[] | undefined;
    if (Array.isArray(clusterFeats) && clusterFeats.length > 1) {
      return this.styleVesselCluster(clusterFeats.length);
    }
    const innerFeat = (Array.isArray(clusterFeats) && clusterFeats.length === 1)
      ? clusterFeats[0]
      : (feature as Feature);
    const props = innerFeat.getProperties() as VesselProperties;
    const cat = categoryOf(props.ship_type);
    const colors = CATEGORY_COLOR[cat];
    const cog = typeof (props as any).cog === 'number' ? (props as any).cog : 0;
    return new Style({
      image: new Icon({
        src: this.vesselIconDataUrl(colors.fill, colors.stroke),
        rotation: (cog * Math.PI) / 180,
        rotateWithView: true,
        scale: 1.0,
        anchor: [0.5, 0.5],
      }),
    });
  }

  /** Cache des styles cluster par "bucket" de count (1-2, 3-9, 10-99,
   *  100-999, 1000+). Évite de re-créer un Style + Circle + Text à chaque
   *  tick de rendu pour les 12000+ clusters quand on zoom-out Europe. */
  private vesselClusterStyleCache: globalThis.Map<string, Style> =
    new (globalThis as any).Map();

  private styleVesselCluster(count: number): Style {
    // Bucketing pour clamper la cardinalité du cache (~5 entrées max).
    const bucket = count < 10 ? '1' : count < 100 ? '2' : count < 1000 ? '3' : '4';
    const cached = this.vesselClusterStyleCache.get(bucket);
    if (cached) {
      // Rebadge à chaque hit (le count change même si le bucket est stable).
      // C'est cheap : on mute juste le Text du Style cached.
      cached.getText()?.setText(this.formatClusterCount(count));
      return cached;
    }
    const radius = bucket === '1' ? 12 : bucket === '2' ? 17 : bucket === '3' ? 23 : 30;
    const fill = bucket === '1' ? '#1e88e5'
              : bucket === '2' ? '#0d47a1'
              : bucket === '3' ? '#7b1fa2'
                               : '#b91c1c';
    const style = new Style({
      image: new CircleStyle({
        radius,
        fill: new Fill({ color: fill }),
        stroke: new Stroke({ color: 'rgba(255,255,255,0.85)', width: 2 }),
      }),
      text: new TextStyle({
        text: this.formatClusterCount(count),
        fill: new Fill({ color: '#ffffff' }),
        font: 'bold 11px Inter, sans-serif',
      }),
    });
    this.vesselClusterStyleCache.set(bucket, style);
    return style;
  }

  /** "1.2k" pour 1234, "12k" pour 12345, sinon "47" pour <1000. */
  private formatClusterCount(n: number): string {
    if (n < 1000) return String(n);
    if (n < 10000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return Math.round(n / 1000) + 'k';
  }

  private styleTrack(): Style {
    return new Style({
      stroke: new Stroke({
        color: 'rgba(45, 212, 191, 0.5)',
        width: 1.2,
      }),
    });
  }
}
