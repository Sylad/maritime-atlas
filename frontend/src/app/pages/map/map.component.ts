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
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import XYZ from 'ol/source/XYZ';
import TileWMS from 'ol/source/TileWMS';
import GeoJSON from 'ol/format/GeoJSON';
import Overlay from 'ol/Overlay';
import { fromLonLat } from 'ol/proj';
import { Style, Circle as CircleStyle, Fill, Stroke, Icon } from 'ol/style';
import { defaults as defaultControls, ScaleLine, MousePosition } from 'ol/control';
import { toStringHDMS } from 'ol/coordinate';
import type { Feature } from 'ol';
import type { FeatureLike } from 'ol/Feature';
import type { Geometry, Point } from 'ol/geom';

import { Router, RouterLink } from '@angular/router';
import type { LayerKind, Palette } from '../../services/palettes.service';
import { TimeSliderComponent } from '../../components/time-slider/time-slider.component';
import { VesselsService, type VesselProperties } from '../../services/vessels.service';
import { RainviewerService, type RainViewerSnapshot } from '../../services/rainviewer.service';
import { AuthService } from '../../services/auth.service';
import { PalettesService } from '../../services/palettes.service';
import { ArrowsService, type ArrowsKind } from '../../services/arrows.service';
import { LightningService, type LightningProperties } from '../../services/lightning.service';
import { AlertsService, type AlertProperties, type AlertSeverity } from '../../services/alerts.service';
import { WindParticleEngine, speedDirToUv, type WindPoint as WindParticlePoint } from '../../components/wind-particles/wind-particles';

// France métropole — centré sur l'hexagone, zoom large.
const INITIAL_CENTER: [number, number] = [3.0, 46.5];
const INITIAL_ZOOM = 6;
const REFRESH_INTERVAL_MS = 30_000;
const LIVE_THRESHOLD_MS = 5 * 60_000; // ±5min = considéré live

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
  imports: [DatePipe, DecimalPipe, TimeSliderComponent, RouterLink],
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
          <a routerLink="/palettes" class="auth-link">{{ u.email }}</a>
          <span class="auth-sep">·</span>
          <button type="button" class="auth-btn" (click)="logout()">Déconnexion</button>
        } @else {
          <a routerLink="/auth/login" class="auth-link">Connexion</a>
          <span class="auth-sep">·</span>
          <a routerLink="/auth/register" class="auth-link">Inscription</a>
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

      <div class="legend" [class.legend--closed]="!legendOpen()">
        <div class="legend-title">MARITIME ATLAS</div>
        <div class="legend-subtitle">France métropole</div>

        <div class="layer-toggles">
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
          <label class="layer-toggle" [class.dim]="!windActive()">
            <input type="checkbox" [checked]="showWind()" (change)="showWind.set($any($event.target).checked)" />
            <span class="toggle-glyph">
              <span class="glyph-wind"></span>
            </span>
            <span class="toggle-text">
              <span class="toggle-name">Vent</span>
              <span class="toggle-count">{{ windSource() === 'arome' ? 'forecast 10m (AROME 2.5km)' : 'forecast 10m (GFS 25km)' }}</span>
            </span>
            <!-- Sprint 11 : sélecteur de modèle (GFS NOAA vs AROME Météo-France).
                 Pilote à la fois le layer WMS (maritime:wind-speed-{arome|}) et les
                 arrows GeoJSON (arome_wind_arrows_ vs wind_arrows_). Affiché en
                 inline-radio pour gagner de la place dans la légende. -->
            <span class="wind-source-radios" (click)="$event.stopPropagation()">
              <label class="radio-mini">
                <input type="radio" name="windSrc" value="gfs"
                       [checked]="windSource() === 'gfs'"
                       (change)="windSource.set('gfs')" />
                GFS
              </label>
              <label class="radio-mini">
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
          <label class="layer-toggle" [class.dim]="!showWindArrows()">
            <input type="checkbox" [checked]="showWindArrows()" (change)="showWindArrows.set($any($event.target).checked)" />
            <span class="toggle-glyph">
              <span class="glyph-arrow glyph-arrow-wind">↑</span>
            </span>
            <span class="toggle-text">
              <span class="toggle-name">Vent flèches</span>
              <span class="toggle-count">{{ windSource() === 'arome' ? 'AROME · ' : 'GFS · ' }}{{ windArrowsStatus() }}</span>
            </span>
          </label>
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
            <div class="legend-error">{{ errorMsg() }}</div>
          }
        </div>
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
      </div>

      <!-- Attribution bar maison (cf. commit "drop OL Attribution"). Bouton (i)
           bottom-right qui déplie un panneau avec les sources. HTML standard,
           pas de control OL → fini les letterforms hollow/glow. -->
      <div class="attribution-bar" [class.open]="attrOpen()">
        @if (attrOpen()) {
          <div class="attribution-panel">
            <div class="attribution-title">Sources</div>
            <div class="attribution-row">
              <span class="attribution-label">Fond carto</span>
              <span>©&nbsp;<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> · ©&nbsp;<a href="https://carto.com/attribution" target="_blank" rel="noopener">CARTO</a></span>
            </div>
            <div class="attribution-row">
              <span class="attribution-label">Modèles météo</span>
              <span><a href="https://nomads.ncep.noaa.gov" target="_blank" rel="noopener">NOAA NOMADS</a> (GFS, WW3, OISST) · <a href="https://meteo.data.gouv.fr/datasets" target="_blank" rel="noopener">Météo-France AROME</a></span>
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
          </div>
        }
        <button type="button" class="attribution-trigger"
                (click)="toggleAttr()"
                [attr.aria-label]="attrOpen() ? 'Fermer les sources' : 'Voir les sources'"
                title="Sources de données">
          {{ attrOpen() ? '×' : 'i' }}
        </button>
      </div>

      <app-time-slider (timeChange)="onTimeChange($event)" />
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
    /* Sprint 11 : sélecteur de modèle (GFS vs AROME) inline dans le toggle Vent.
       Très compact (2 radios + 2 labels) pour ne pas casser la légende. */
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
    .layer-toggles {
      display: flex;
      flex-direction: column;
      gap: 0.5em;
      margin: 0.4em 0 1em;
      padding-bottom: 0.8em;
      border-bottom: 1px solid var(--border);
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
      span { color: var(--fg-muted); }
      strong { color: var(--fg); }
    }
    .mono { font-family: var(--font-mono); font-size: 0.72rem; }

    /* ── Attribution bar maison (drop OL Attribution control) ──
       Bottom-right, au-dessus de la time-slider. Bouton (i) circulaire
       toujours visible ; clic → panel s'ouvre vers le HAUT-GAUCHE pour
       ne pas dépasser de la viewport. Pas de glow exotique : juste un
       border + un box-shadow soft pour la lisibilité. */
    .attribution-bar {
      position: absolute;
      bottom: 6em;
      right: 1em;
      z-index: 25;
      display: flex;
      align-items: flex-end;
      gap: 0.5em;
      pointer-events: auto;
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
    }
    .attribution-bar.open .attribution-trigger {
      font-style: normal;
      font-family: var(--font-sans);
      font-size: 1.1rem;
    }
    .attribution-panel {
      background: rgb(15, 23, 42);
      border: 1px solid hsl(224 85% 55% / 0.5);
      border-radius: 8px;
      padding: 0.9em 1.1em;
      max-width: 420px;
      font-size: 0.78rem;
      line-height: 1.6;
      color: var(--fg);
      /* Box-shadow doux — pas de multi-layer glow, pas de filter, pas
         de backdrop-filter. Lecture nette garantie. */
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
  private readonly auth = inject(AuthService);
  private readonly palettesSvc = inject(PalettesService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  readonly currentUser = this.auth.currentUser;
  readonly isAuthenticated = this.auth.isAuthenticated;

  readonly mapEl = viewChild.required<ElementRef<HTMLDivElement>>('mapEl');
  readonly popupEl = viewChild.required<ElementRef<HTMLDivElement>>('popupEl');
  readonly particlesEl = viewChild.required<ElementRef<HTMLCanvasElement>>('particlesEl');

  readonly selectedVessel = signal<VesselProperties | null>(null);
  readonly selectedLightning = signal<LightningProperties | null>(null);
  readonly selectedAlert = signal<AlertProperties | null>(null);
  readonly attrOpen = signal(false);
  /** Legend drawer state — défaut open sur desktop, closed sur mobile (≤ 760px).
      Sur desktop le bouton n'apparaît pas (CSS @media display:none) donc la
      legend reste toujours visible — l'état du signal n'a aucun effet. */
  readonly legendOpen = signal(typeof window !== 'undefined' ? window.innerWidth > 760 : true);
  readonly hasPopup = computed(() =>
    this.selectedVessel() !== null || this.selectedLightning() !== null || this.selectedAlert() !== null,
  );
  readonly vesselsCount = signal(0);
  readonly tracksCount = signal(0);
  readonly lastRefreshAt = signal<Date | null>(null);
  readonly errorMsg = signal<string | null>(null);

  // Toggles user — par défaut tout visible (sauf rain/wind/waves : opt-in
  // pour éviter d'écraser l'image avec des tiles tant que pas demandé)
  readonly showVessels = signal(true);
  readonly showTracks = signal(true);
  readonly showSST = signal(true);
  readonly showRain = signal(false);
  readonly showWind = signal(false);
  readonly showWaves = signal(false);
  // Sprint 11 : choix du modèle météo pour le vent. 'gfs' = NOAA 25km (defaut,
  // dispo immédiatement, couverture monde). 'arome' = Météo-France 2.5km
  // (France métro uniquement, ~10× plus fin côté côtier, dispo après ~2h
  // de latence depuis le run). Le toggle pilote à la fois le layer WMS
  // (maritime:wind-speed vs maritime:wind-speed-arome) ET les arrows GeoJSON
  // (wind_arrows_*.geojson vs arome_wind_arrows_*.geojson).
  readonly windSource = signal<'gfs' | 'arome'>('gfs');
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
  private trackSource?: VectorSource;
  private vesselLayer?: VectorLayer<VectorSource>;
  private trackLayer?: VectorLayer<VectorSource>;
  private sstLayer?: TileLayer<TileWMS>;
  private sstSource?: TileWMS;
  private rainLayer?: TileLayer<XYZ>;
  private rainSource?: XYZ;
  private rainSnapshot?: RainViewerSnapshot;
  private rainSnapshotTimer?: ReturnType<typeof setInterval>;
  private currentRainPath?: string;
  private windLayer?: TileLayer<TileWMS>;
  // Renommé en sprint 11 (était `windSource`) pour libérer le nom au signal
  // user-facing `windSource: 'gfs' | 'arome'`. Cette ref pointe vers le
  // TileWMS du layer "Vent" — peu importe la source choisie, le LAYERS
  // param est mis à jour dynamiquement via updateParams().
  private windWmsSource?: TileWMS;
  private wavesLayer?: TileLayer<TileWMS>;
  private wavesSource?: TileWMS;
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
  private readonly geoJsonFmt = new GeoJSON({ featureProjection: 'EPSG:3857', dataProjection: 'EPSG:4326' });

  constructor() {
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
      // Defer pour s'exécuter après ngAfterViewInit (this.*Layer dispo)
      queueMicrotask(() => {
        this.applyLayerVisibility();
        // Si on vient d'activer un toggle arrows, déclenche un fetch
        if (this.showWindArrows() || this.showWaveArrows()) {
          this.refreshArrowsForTime(this.currentTime);
        }
      });
    });

    // Sprint 11 : effet dédié pour le switch GFS↔AROME.
    // - Met à jour le LAYERS du WMS wind (force un refresh des tiles)
    // - Reset le lastWindArrowsTs pour forcer le re-fetch du GeoJSON
    //   correspondant (arome_wind_arrows_ vs wind_arrows_) au prochain tick
    // - Re-déclenche immédiatement le fetch arrows si la couche est ON
    effect(() => {
      const src = this.windSource();
      queueMicrotask(() => {
        if (this.windWmsSource) {
          this.windWmsSource.updateParams({
            LAYERS: src === 'arome' ? 'maritime:wind-speed-arome' : 'maritime:wind-speed',
          });
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

  ngAfterViewInit(): void {
    this.initMap();
    this.initParticlesEngine();
    // Démarre en mode live
    this.applyLayerVisibility();
    this.refreshForTime(new Date());
    this.startLiveLoopIfNeeded();
    // Bootstrap snapshot RainViewer + refresh toutes les 5 min (le serveur
    // RV ajoute une frame toutes les 10min, donc 5min de poll = au pire on
    // découvre la nouvelle frame avec 5min de retard, OK).
    this.refreshRainSnapshot();
    this.rainSnapshotTimer = setInterval(() => this.refreshRainSnapshot(), 5 * 60_000);
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
    this.particlesEngine?.stop();
    this.map?.setTarget(undefined);
    this.map?.dispose();
  }

  // ─── Time slider callback ──────────────────────────────────────────
  onTimeChange(t: Date): void {
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
    // SST = past only (forecast pas dispo)
    this.sstLayer.setVisible(this.showSST() && !this.isFuture());
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
      // Sprint 11 : choisit la source manifest selon windSource().
      // AROME a sa propre liste de ts (manifest.arome). Fallback automatique
      // sur GFS si AROME pas encore alimenté (premier boot, ou volume vide).
      const src = this.windSource();
      const useArome = src === 'arome' && Array.isArray(manifest.arome) && manifest.arome.length > 0;
      const tsList = useArome ? (manifest.arome ?? []) : manifest.wind;
      const kind: ArrowsKind = useArome ? 'arome' : 'wind';
      const ts = this.arrows.findNearestTs(tsList, t);
      if (!ts) {
        this.windArrowsSource.clear();
        this.windArrowsStatus.set(useArome
          ? 'hors fenêtre AROME'
          : (src === 'arome' ? 'AROME indispo, fallback GFS vide' : 'hors fenêtre GFS'));
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
    // 'arome' partage la sémantique 'wind' (m/s + dirTo) — Beaufort palette.
    const isWindLike = kind === 'wind' || kind === 'arome';
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
    if (kind === 'wind' || kind === 'arome') {
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
      this.lightningSub = this.lightning.fetchRecent()
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
        const fc = await this.alertsSvc.refresh();
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

    // Project lon/lat → canvas pixels via the OL view. Note: OL renvoie
    // les coordinates dans la projection courante (EPSG:3857 par défaut)
    // donc on doit projeter d'abord lon/lat → 3857 puis demander à OL.
    const project = (lon: number, lat: number): [number, number] | null => {
      if (!this.map) return null;
      const px = this.map.getPixelFromCoordinate(fromLonLat([lon, lat]));
      if (!px || isNaN(px[0])) return null;
      return [px[0], px[1]];
    };

    this.particlesEngine = new WindParticleEngine(ctx, project, {
      numParticles: 1500,
      maxTtl: 200,
      advectScale: 0.0035,    // ~4× plus lent que sprint 8 v1 (feedback user)
      fadeAlpha: 0.97,        // trails légèrement plus longs pour compenser
      lineWidth: 1.2,
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
    // Sprint 11 : aligne les particules sur la source choisie (GFS ou AROME).
    // Si AROME est sélectionné mais manifest.arome est vide → fallback GFS
    // (mieux d'afficher quelque chose plutôt que rien).
    const src = this.windSource();
    const useArome = src === 'arome' && Array.isArray(manifest.arome) && manifest.arome.length > 0;
    const tsList = useArome ? (manifest.arome ?? []) : manifest.wind;
    const kind: ArrowsKind = useArome ? 'arome' : 'wind';
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
      const day = toIsoDate(t);
      if (day !== this.lastTrackDay) {
        this.lastTrackDay = day;
        this.fetchTracks(day);
      }
      this.scheduleFetchVesselsAt(t);
    } else {
      // Future : aucun fetch (forecast pas implémenté).
      this.cancelPastVesselsFetch();
      this.vesselSource?.clear();
      this.vesselsCount.set(0);
    }
    // Snap-to-latest pour les WMS time-enabled : on passe une PLAGE
    // [old, cursor] au lieu d'un instant pile. GeoServer ImageMosaic
    // matche le timestep le plus récent dispo dans la plage — donc on
    // affiche toujours la dernière donnée connue jusqu'au cursor, plutôt
    // qu'une tile vide quand l'instant exact n'est pas indexé.
    const isoTs = toIsoTimestamp(t);
    const timeRange = `1970-01-01T00:00:00Z/${isoTs}`;
    if (this.sstSource && !this.isFuture()) {
      this.sstSource.updateParams({ TIME: timeRange });
    }
    // Wind/Waves : forecast peut couvrir le passé (run analyse) ET le futur
    // jusqu'à +72h. On utilise la même plage [past..cursor] pour le past
    // mode, mais en mode futur on accepte aussi le forecast.
    if (this.windWmsSource) this.windWmsSource.updateParams({ TIME: timeRange });
    if (this.wavesSource)   this.wavesSource.updateParams({ TIME: timeRange });
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
          this.errorMsg.set(`Erreur WFS replay : ${err.message ?? err}`);
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
        switchMap(() => this.vessels.fetchLiveVessels()),
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
        error: (err) => this.errorMsg.set(`Erreur WFS live : ${err.message ?? err}`),
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
          this.vesselsCount.set(0);
          if (!this.trackSource) return;
          this.trackSource.clear();
          const features = this.geoJsonFmt.readFeatures(fc);
          this.trackSource.addFeatures(features);
        },
        error: (err) => {
          this.errorMsg.set(`Erreur WFS tracks : ${err.message ?? err}`);
          this.tracksCount.set(0);
        },
      });
  }

  closePopup(): void {
    this.selectedVessel.set(null);
    this.selectedLightning.set(null);
    this.selectedAlert.set(null);
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

  // ─── Map init ───────────────────────────────────────────────────────
  private initMap(): void {
    // Attributions exposées via le contrôle Attribution OpenLayers (icône
    // (i) bas-droite). Chaque source déclare sa propre attribution → l'icône
    // affiche la liste complète au survol.
    const ATTRIB_AIS = 'Positions navires © <a href="https://aisstream.io" target="_blank">aisstream.io</a>';
    const ATTRIB_NOAA = 'Modèles météo © <a href="https://nomads.ncep.noaa.gov" target="_blank">NOAA NOMADS</a> (GFS, WW3, OISST)';
    const ATTRIB_AROME = 'Vent côtier © <a href="https://meteo.data.gouv.fr" target="_blank">Météo-France AROME</a>';
    const ATTRIB_LIGHTNING = 'Foudre © <a href="https://www.blitzortung.org" target="_blank">Blitzortung community network</a>';
    const ATTRIB_RAIN = 'Radar pluie © <a href="https://www.rainviewer.com" target="_blank">RainViewer</a>';

    this.vesselSource = new VectorSource({ attributions: ATTRIB_AIS });
    this.trackSource = new VectorSource({ attributions: ATTRIB_AIS });

    const baseTile = new TileLayer({
      source: new XYZ({
        url: 'https://{a-d}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png',
        attributions: '© OpenStreetMap, © CARTO',
        maxZoom: 19,
      }),
    });

    const labelsTile = new TileLayer({
      source: new XYZ({
        url: 'https://{a-d}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png',
        attributions: '',
        maxZoom: 19,
      }),
      zIndex: 50,
    });

    // SST raster layer — WMS time-enabled depuis GeoServer ImageMosaic.
    // Le param TIME est mis à jour par refreshForTime() à chaque change
    // de currentTime.
    this.sstSource = new TileWMS({
      url: '/geoserver/maritime/wms',
      params: {
        LAYERS: 'maritime:sst-daily',
        TILED: true,
        TRANSPARENT: true,
      },
      serverType: 'geoserver',
      attributions: ATTRIB_NOAA,
    });
    this.sstLayer = new TileLayer({
      source: this.sstSource,
      opacity: 0.6,           // semi-transparent pour voir base layer en dessous
      zIndex: 30,             // sous les labels
      visible: false,
    });

    // Vent (force, m/s) — WMS time-enabled depuis ImageMosaic GeoServer.
    // GeoServer applique automatiquement un style "raster" arc-en-ciel par
    // défaut. Sprint 11 : le LAYERS param est dynamique (signal `windSource`)
    // entre 'maritime:wind-speed' (GFS) et 'maritime:wind-speed-arome' (AROME).
    const initialWindLayer = this.windSource() === 'arome'
      ? 'maritime:wind-speed-arome'
      : 'maritime:wind-speed';
    this.windWmsSource = new TileWMS({
      url: '/geoserver/maritime/wms',
      params: { LAYERS: initialWindLayer, TILED: true, TRANSPARENT: true },
      serverType: 'geoserver',
      attributions: [ATTRIB_NOAA, ATTRIB_AROME],
    });
    this.windLayer = new TileLayer({
      source: this.windWmsSource,
      opacity: 0.55,
      zIndex: 32,
      visible: false,
    });

    // Vagues (hauteur sig., m) — WMS time-enabled.
    this.wavesSource = new TileWMS({
      url: '/geoserver/maritime/wms',
      params: { LAYERS: 'maritime:wave-hs', TILED: true, TRANSPARENT: true },
      serverType: 'geoserver',
      attributions: ATTRIB_NOAA,
    });
    this.wavesLayer = new TileLayer({
      source: this.wavesSource,
      opacity: 0.55,
      zIndex: 33,
      visible: false,
    });

    // Sprint 10 : alertes maritimes. VectorSource peuplé toutes les 30s
    // via WFS sur v_alerts_recent. Style triangle de warning coloré selon
    // severity (warning=orange, danger=rouge).
    this.alertsSource = new VectorSource({
      attributions: 'Alertes maritime-atlas (engine RMQ croise AIS + GFS + Blitzortung)',
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
      attributions: [ATTRIB_NOAA, ATTRIB_AROME],
    });
    this.windArrowsLayer = new VectorLayer({
      source: this.windArrowsSource,
      // Le `kind` passé au style suit le signal `windSource()` — comme ça
      // un éventuel re-render à un changement de source utilise la bonne
      // palette/scale (en pratique : Beaufort wind dans les 2 cas, donc
      // visuel identique — mais on garde la sémantique propre).
      style: (feat: FeatureLike) => this.styleArrow(
        this.windSource() === 'arome' ? 'arome' : 'wind', feat,
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

    this.vesselLayer = new VectorLayer({
      source: this.vesselSource,
      style: (feature: FeatureLike) => this.styleVessel(feature),
      zIndex: 100,
      visible: true,
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
        this.sstLayer,
        this.windLayer,
        this.wavesLayer,
        this.rainLayer,
        labelsTile,
        this.waveArrowsLayer,
        this.windArrowsLayer,
        this.trackLayer,
        this.vesselLayer,
        this.lightningLayer,
        this.alertsLayer,
      ],
      overlays: [this.popupOverlay],
      // L'Attribution OL natif est désactivé — son CSS injecte un text-shadow
      // qui rend les letterforms hollow/glow sur dark bg (cf. /case-study).
      // À la place, un <div class="attribution-bar"> Angular maison (cf. template)
      // affiche les sources en clair avec liens HTML normaux.
      controls: defaultControls({ attribution: false }).extend([
        new ScaleLine({ units: 'nautical' }),
        // Affiche les coordonnées sous le curseur en HDMS (degrés / minutes /
        // secondes lat-lon WGS84). Le control est positionné bottom-left
        // au-dessus du zoom via styles.scss. Caché sur mobile (touch n'a
        // pas de cursor).
        new MousePosition({
          projection: 'EPSG:4326',
          coordinateFormat: (coord) => coord ? toStringHDMS(coord, 1) : '',
          className: 'ol-mouse-position',
          placeholder: '—',
        }),
      ]),
      view: new View({
        center: fromLonLat(INITIAL_CENTER),
        zoom: INITIAL_ZOOM,
        minZoom: 4,
        maxZoom: 14,
      }),
    });

    // Click handler — route le popup selon la layer source de la feature.
    // forEachFeatureAtPixel passe le layer en 2e arg, ce qui permet de
    // distinguer vessel / lightning / alert sans inspecter les props.
    this.map.on('singleclick', (evt) => {
      let matched: { feat: Feature<Geometry>; kind: 'vessel' | 'lightning' | 'alert' } | null = null;
      this.map!.forEachFeatureAtPixel(
        evt.pixel,
        (f, layer) => {
          if (matched) return;
          if (layer === this.vesselLayer) matched = { feat: f as Feature<Geometry>, kind: 'vessel' };
          else if (layer === this.lightningLayer) matched = { feat: f as Feature<Geometry>, kind: 'lightning' };
          else if (layer === this.alertsLayer) matched = { feat: f as Feature<Geometry>, kind: 'alert' };
        },
        { hitTolerance: 4 },
      );
      if (!matched) {
        this.closePopup();
        return;
      }
      this.closePopup();      // reset les 3 signals avant le set
      const m = matched as { feat: Feature<Geometry>; kind: 'vessel' | 'lightning' | 'alert' };
      const props = m.feat.getProperties() as any;
      delete props.geometry;
      switch (m.kind) {
        case 'vessel':    this.selectedVessel.set(props as VesselProperties); break;
        case 'lightning': this.selectedLightning.set(props as LightningProperties); break;
        case 'alert':     this.selectedAlert.set(props as AlertProperties); break;
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
    const props = feature.getProperties() as VesselProperties;
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

  private styleTrack(): Style {
    return new Style({
      stroke: new Stroke({
        color: 'rgba(45, 212, 191, 0.5)',
        width: 1.2,
      }),
    });
  }
}
