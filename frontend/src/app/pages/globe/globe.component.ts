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

/** Date du jour J-1 capped pour NASA GIBS (lag ~24h). Format YYYY-MM-DD UTC. */
function gibsDailyDate(): string {
  const eff = new Date(Date.now() - 24 * 3_600_000);
  return `${eff.getUTCFullYear()}-${String(eff.getUTCMonth() + 1).padStart(2, '0')}-${String(eff.getUTCDate()).padStart(2, '0')}`;
}

@Component({
  selector: 'app-globe',
  standalone: true,
  imports: [CommonModule, RouterLink, TimeSliderComponent],
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
        </nav>
      </header>

      <div #mapContainer class="map-container"></div>

      <aside class="controls">
        <h2>Couches</h2>

        <div class="row">
          <button
            type="button"
            class="btn"
            [class.active]="projection() === 'globe'"
            (click)="setProjection('globe')"
          >🌍 Globe</button>
          <button
            type="button"
            class="btn"
            [class.active]="projection() === 'mercator'"
            (click)="setProjection('mercator')"
          >🗺 Mercator</button>
        </div>

        <div class="row">
          <button
            type="button"
            class="btn"
            [class.active]="!showSst()"
            (click)="toggleSst(false)"
          >SST off</button>
          <button
            type="button"
            class="btn"
            [class.active]="showSst()"
            (click)="toggleSst(true)"
          >SST live</button>
        </div>

        <div class="row">
          <button
            type="button"
            class="btn"
            [class.active]="!showWind()"
            (click)="toggleWind(false)"
          >Vent off</button>
          <button
            type="button"
            class="btn"
            [class.active]="showWind()"
            (click)="toggleWind(true)"
            [disabled]="windLoading()"
          >🌬 Particules WebGL</button>
        </div>

        @if (windLoading()) {
          <div class="info">Chargement grid vent…</div>
        }
        @if (windError()) {
          <div class="info error">{{ windError() }}</div>
        }
        @if (showWind() && !windLoading() && !windError()) {
          <div class="info">Wind GFS — {{ DEFAULT_WIND_PARTICLES }} particules</div>
        }

        <label class="sat-label">
          <span class="sat-title">📡 Imagerie satellite / radar</span>
          <select class="sat-select" [value]="activeSat()" (change)="onSatChange($any($event.target).value)">
            <option value="none">— Aucune</option>
            <optgroup label="NASA GIBS (journalier J-1)">
              @for (p of GIBS_PRODUCTS; track p.key) {
                <option [value]="p.key">{{ p.label }}</option>
              }
            </optgroup>
            <optgroup label="EUMETSAT / Radar (NRT)">
              @for (p of CASCADE_PRODUCTS; track p.key) {
                <option [value]="p.key">{{ p.label }}</option>
              }
            </optgroup>
          </select>
        </label>
        @if (activeSat() !== 'none') {
          <div class="info">{{ currentSatAttribution() }}</div>
        }

        <div class="row">
          <button
            type="button"
            class="btn"
            [class.active]="showLightning()"
            (click)="toggleVector('lightning')"
            [disabled]="vectorLoading() === 'lightning'"
          >⚡ Foudre</button>
          <button
            type="button"
            class="btn"
            [class.active]="showAlerts()"
            (click)="toggleVector('alerts')"
            [disabled]="vectorLoading() === 'alerts'"
          >⚠ Alertes</button>
        </div>
        <div class="row">
          <button
            type="button"
            class="btn full"
            [class.active]="showVessels()"
            (click)="toggleVector('vessels')"
            [disabled]="vectorLoading() === 'vessels'"
          >🚢 Navires AIS (cluster)</button>
        </div>
        @if (vectorCounts()['lightning'] != null && showLightning()) {
          <div class="info">Foudre 30 min — {{ vectorCounts()['lightning'] }} strikes</div>
        }
        @if (vectorCounts()['alerts'] != null && showAlerts()) {
          <div class="info">Alertes 1h — {{ vectorCounts()['alerts'] }} actives</div>
        }
        @if (vectorCounts()['vessels'] != null && showVessels()) {
          <div class="info">Navires live — {{ vectorCounts()['vessels'] }} positions</div>
        }

        <!-- G8 (2026-05-22) — 6 layers vector portées depuis /map. -->
        <div class="row">
          <button type="button" class="btn full" [class.active]="showMetar()"
                  (click)="toggleVector('metar')" [disabled]="vectorLoading() === 'metar'">🌡 METAR</button>
        </div>
        <div class="row">
          <button type="button" class="btn full" [class.active]="showHubeau()"
                  (click)="toggleVector('hubeau')" [disabled]="vectorLoading() === 'hubeau'">💧 Hub'eau débits</button>
        </div>
        <div class="row">
          <button type="button" class="btn full" [class.active]="showPiezo()"
                  (click)="toggleVector('piezo')" [disabled]="vectorLoading() === 'piezo'">🩸 Piezo nappes</button>
        </div>
        <div class="row">
          <button type="button" class="btn full" [class.active]="showQuakes()"
                  (click)="toggleVector('quakes')" [disabled]="vectorLoading() === 'quakes'">🌐 Séismes</button>
        </div>
        <div class="row">
          <button type="button" class="btn full" [class.active]="showFirms()"
                  (click)="toggleVector('firms')" [disabled]="vectorLoading() === 'firms'">🔥 FIRMS feux</button>
        </div>
        <div class="row">
          <button type="button" class="btn full" [class.active]="showBuoys()"
                  (click)="toggleVector('buoys')" [disabled]="vectorLoading() === 'buoys'">⚓ Bouées</button>
        </div>
        <!-- G8b — tracks (vessel polylines) + rain (RainViewer XYZ). -->
        <div class="row">
          <button type="button" class="btn full" [class.active]="showTracks()"
                  (click)="toggleTracks(!showTracks())" [disabled]="vectorLoading() === 'tracks'">🚢 Trajets AIS</button>
        </div>
        <div class="row">
          <button type="button" class="btn full" [class.active]="showRain()"
                  (click)="toggleRain(!showRain())" [disabled]="vectorLoading() === 'rain'">🌧 Pluie RainViewer</button>
        </div>

        <!-- G9 (2026-05-22) — forecast wind/waves + arrows (WMS GS time-enabled). -->
        <div class="row">
          <button type="button" class="btn full" [class.active]="showWindForecast()"
                  (click)="toggleWindForecast(!showWindForecast())">🌬 Vent (raster)</button>
        </div>
        <div class="row">
          <button type="button" class="btn full" [class.active]="showWindArrows()"
                  (click)="toggleWindArrows(!showWindArrows())">↗ Flèches vent</button>
        </div>
        <div class="row">
          <button type="button" class="btn full" [class.active]="showWavesForecast()"
                  (click)="toggleWavesForecast(!showWavesForecast())">🌊 Vagues (raster)</button>
        </div>
        <div class="row">
          <button type="button" class="btn full" [class.active]="showWaveArrows()"
                  (click)="toggleWaveArrows(!showWaveArrows())">↗ Flèches vagues</button>
        </div>

        <!-- G11b (2026-05-22) — 4 layers sources scientifiques statiques. -->
        <div class="row">
          <button type="button" class="btn full" [class.active]="showBathy()"
                  (click)="toggleBathy(!showBathy())">🏔 Bathymétrie EMODnet</button>
        </div>
        <div class="row">
          <button type="button" class="btn full" [class.active]="showEez()"
                  (click)="toggleEez(!showEez())">🌐 EEZ Marine Regions</button>
        </div>
        <div class="row">
          <button type="button" class="btn full" [class.active]="showMpa()"
                  (click)="toggleMpa(!showMpa())">🛡 MPA EMODnet</button>
        </div>
        <div class="row">
          <button type="button" class="btn full" [class.active]="showEfas()"
                  (click)="toggleEfas(!showEfas())">🌊 EFAS forecast crues</button>
        </div>

        <!-- G11d (2026-05-22) — sliders opacité par layer active. -->
        @if (activeOpacityKeys().length > 0) {
          <div class="opacity-panel">
            <div class="opacity-title">Opacités</div>
            @for (k of activeOpacityKeys(); track k) {
              <div class="opacity-row">
                <span class="opacity-label">{{ layerHumanLabel(k) }}</span>
                <input type="range" min="0" max="1" step="0.05"
                       [value]="getLayerOpacity(k)"
                       (input)="setLayerOpacity(k, +$any($event.target).value)" />
                <span class="opacity-value">{{ (getLayerOpacity(k) * 100).toFixed(0) }}%</span>
              </div>
            }
          </div>
        }
        @if (vectorCounts()['metar'] != null && showMetar()) {
          <div class="info">METAR — {{ vectorCounts()['metar'] }} stations</div>
        }
        @if (vectorCounts()['hubeau'] != null && showHubeau()) {
          <div class="info">Hub'eau — {{ vectorCounts()['hubeau'] }} stations</div>
        }
        @if (vectorCounts()['piezo'] != null && showPiezo()) {
          <div class="info">Piezo — {{ vectorCounts()['piezo'] }} stations</div>
        }
        @if (vectorCounts()['quakes'] != null && showQuakes()) {
          <div class="info">Séismes — {{ vectorCounts()['quakes'] }} events</div>
        }
        @if (vectorCounts()['firms'] != null && showFirms()) {
          <div class="info">FIRMS — {{ vectorCounts()['firms'] }} hotspots</div>
        }
        @if (vectorCounts()['buoys'] != null && showBuoys()) {
          <div class="info">Bouées — {{ vectorCounts()['buoys'] }} stations</div>
        }
        @if (vectorCounts()['tracks'] != null && showTracks()) {
          <div class="info">Trajets — {{ vectorCounts()['tracks'] }} polylines</div>
        }
        @if (vectorCounts()['rain'] != null && showRain()) {
          <div class="info">Pluie radar RainViewer (snap au cursor)</div>
        }

        <div class="info subtle">
          MapLibre 5.24 + WebGL2 GPGPU. Bbox Europe [{{ WIND_BBOX.join(', ') }}].
        </div>
      </aside>

      <div class="fps" aria-label="frames per second">FPS {{ fps() }}</div>

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
          [externalAnimationActive]="playing()"
          [autoZIndexEnabled]="autoZIndexEnabled()"
          (timeChange)="onSliderTimeChange($event)"
          (playClicked)="onSliderPlayClicked()"
          (masterChange)="setMasterLayer($event)"
          (reorderRequest)="reorderLayerByDrag($event.fromKey, $event.toKey)"
          (autoZIndexEnabledChange)="onAutoZIndexToggleChange($event)" />
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
    .nav-links { display: flex; gap: 12px; }
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

    .map-container {
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
    }

    .controls {
      position: absolute;
      top: 56px;
      left: 14px;
      z-index: 10;
      width: 260px;
      padding: 10px 12px;
      background: rgba(20, 24, 38, 0.92);
      border: 1px solid #2a3245;
      border-radius: 8px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
    }
    .controls h2 {
      margin: 0 0 8px;
      font-size: 12px;
      color: #c9d6e8;
      letter-spacing: .07em;
      text-transform: uppercase;
    }
    .controls .row {
      display: flex;
      gap: 6px;
      margin-bottom: 8px;
      flex-wrap: wrap;
    }
    .controls .btn {
      flex: 1;
      background: #1c2333;
      color: #e6ecf3;
      border: 1px solid #3a4458;
      padding: 6px 10px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      transition: background .15s, border-color .15s;
    }
    .controls .btn:hover:not(:disabled) { background: #2a3448; }
    .controls .btn.active { background: #3b5bff; border-color: #5878ff; }
    .controls .btn:disabled { opacity: .5; cursor: progress; }
    .controls .btn.full { flex: 1 1 100%; }
    .controls .info {
      font-size: 11px;
      color: #8a96a8;
      margin-top: 6px;
      line-height: 1.4;
    }
    .controls .info.subtle { opacity: .7; margin-top: 10px; }
    .controls .info.error { color: #f87171; }

    /* G11d (2026-05-22) — panneau sliders opacité par layer active. */
    .opacity-panel {
      margin-top: 10px;
      padding: 8px 10px;
      background: rgba(20, 28, 44, 0.6);
      border: 1px solid #1c2333;
      border-radius: 6px;
    }
    .opacity-title {
      font-size: 11px;
      font-weight: 600;
      color: #8a96a8;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      margin-bottom: 6px;
    }
    .opacity-row {
      display: grid;
      grid-template-columns: 6em 1fr 2.2em;
      align-items: center;
      gap: 6px;
      padding: 2px 0;
      font-size: 11px;
    }
    .opacity-label { color: #c9d6e8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .opacity-row input[type="range"] { width: 100%; accent-color: hsl(160 70% 50%); }
    .opacity-value { color: #6b7895; text-align: right; font-variant-numeric: tabular-nums; }

    .sat-label {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-top: 10px;
      margin-bottom: 4px;
    }
    .sat-title {
      font-size: 11px;
      color: #c9d6e8;
      letter-spacing: .03em;
    }
    .sat-select {
      background: #1c2333;
      color: #e6ecf3;
      border: 1px solid #3a4458;
      padding: 6px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
    }
    .sat-select:hover { background: #2a3448; }
    .sat-select:focus-visible {
      outline: 2px solid #5878ff;
      outline-offset: 1px;
    }

    .fps {
      position: absolute;
      top: 56px;
      right: 14px;
      z-index: 10;
      padding: 6px 10px;
      background: rgba(20, 24, 38, 0.92);
      border: 1px solid #2a3245;
      border-radius: 8px;
      font-family: ui-monospace, monospace;
      font-size: 12px;
    }

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
    /* PAS d'override sur .maplibregl-popup-close-button — le default MapLibre
       le positionne correctement via son propre CSS. Mes overrides
       (position: absolute) sans parent relative coupable peuvent perturber. */
  `,
})
export class GlobeComponent implements AfterViewInit, OnDestroy {
  private readonly arrows = inject(ArrowsService);
  private readonly alertsService = inject(AlertsService);
  private readonly lightningService = inject(LightningService);
  private readonly vesselsService = inject(VesselsService);
  private readonly rainviewerService = inject(RainviewerService);
  private readonly auth = inject(AuthService);
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
      void this.showLightning(); void this.showAlerts(); void this.showVessels();
      void this.showMetar(); void this.showHubeau(); void this.showPiezo();
      void this.showQuakes(); void this.showFirms(); void this.showBuoys();
      void this.showTracks(); void this.showRain();
      void this.showWindForecast(); void this.showWavesForecast();
      void this.showWindArrows(); void this.showWaveArrows();
      void this.showBathy(); void this.showEez(); void this.showMpa(); void this.showEfas();
      void this.autoZIndexEnabled(); void this.masterLayerKey(); void this.projection();
      this.persistGlobePrefs();
    });
  }

  readonly projection = signal<'globe' | 'mercator'>('globe');
  readonly showSst = signal(false);
  readonly showWind = signal(false);
  readonly windLoading = signal(false);
  readonly windError = signal<string | null>(null);
  readonly fps = signal('—');
  /** Sélecteur radio mutuellement exclusif. 'none' = pas de sat actif. */
  readonly activeSat = signal<string>('none');
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

  /** G11c (2026-05-22) — playback animation temporelle (+6h/s).
   *  Toggle via bouton ▶︎ du TimeSliderComponent. */
  readonly playing = signal<boolean>(false);
  private animTimer?: ReturnType<typeof setInterval>;

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
    if (this.activeSat() !== 'none') {
      const sat = SAT_PRODUCTS.find((p) => p.key === this.activeSat());
      if (sat) push(true, sat.key, sat.gsName, '#a855f7', 168, 0);
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
      if (explicit.startsWith('sat') && this.activeSat() === explicit) return explicit;
      if (explicit === 'windForecast'  && this.showWindForecast())  return explicit;
      if (explicit === 'wavesForecast' && this.showWavesForecast()) return explicit;
      if (explicit === 'windArrows'    && this.showWindArrows())    return explicit;
      if (explicit === 'waveArrows'    && this.showWaveArrows())    return explicit;
    }
    if (this.activeSat() !== 'none') return this.activeSat();
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
      const state = {
        showSst: this.showSst(),
        showWind: this.showWind(),
        activeSat: this.activeSat(),
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
        showBathy: !!data?.showBathy, showEez: !!data?.showEez, showMpa: !!data?.showMpa, showEfas: !!data?.showEfas,
      };
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
    if (p['activeSat'] && p['activeSat'] !== 'none') this.onSatChange(p['activeSat'] as string);
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
    if (p['showBathy']) this.toggleBathy(true);
    if (p['showEez'])   this.toggleEez(true);
    if (p['showMpa'])   this.toggleMpa(true);
    if (p['showEfas'])  this.toggleEfas(true);
  }

  /** G11d — keys des layers actives qui ont un slider opacité utile. */
  readonly activeOpacityKeys = computed<string[]>(() => {
    const keys: string[] = [];
    if (this.showSst()) keys.push('sst');
    if (this.activeSat() !== 'none') keys.push(this.activeSat());
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

  /** G11c — handler play/pause du slider. Toggle l'animation +6h/s. */
  onSliderPlayClicked(): void {
    if (this.playing()) this.stopPlay();
    else this.startPlay();
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

  /** G7/G8 — calcule l'ordre Z auto des layers actives selon LAYER_CATEGORY. */
  private computeAutoZIndexOrder(): string[] {
    const active: string[] = [];
    if (this.activeSat() !== 'none') active.push(this.activeSat());
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
    if (this.showSst() && map.getSource('sst-wms')) {
      const date = `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
      const url = this.buildWmsTileUrl('aetherwx:sst-daily', date, { interpolations: 'bicubic' });
      (map.getSource('sst-wms') as maplibregl.RasterTileSource).setTiles([url]);
    }

    // G9 — forecast wind/waves + arrows
    const iso = t.toISOString().split('.')[0] + 'Z';
    const forecastLayers: Array<{ active: boolean; layerId: string; gsName: string; style?: string }> = [
      { active: this.showWindForecast(),  layerId: 'wind-forecast-wms',  gsName: 'aetherwx:wind-speed' },
      { active: this.showWavesForecast(), layerId: 'waves-forecast-wms', gsName: 'aetherwx:wave-hs' },
      { active: this.showWindArrows(),    layerId: 'wind-arrows-wms',    gsName: 'aetherwx:wind-speed', style: 'aetherwx:wind-arrows' },
      { active: this.showWaveArrows(),    layerId: 'wave-arrows-wms',    gsName: 'aetherwx:wave-dir',   style: 'aetherwx:wave-arrows' },
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
        `&TIME=${encodeURIComponent(iso)}` +
        '&SRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256';
      (src as maplibregl.RasterTileSource).setTiles([url]);
    }

    // Sat actif
    const satKey = this.activeSat();
    if (satKey !== 'none') {
      const product = SAT_PRODUCTS.find((p) => p.key === satKey);
      const src = map.getSource(`sat-${satKey}`);
      if (product && src) {
        const timeParam = product.kind === 'gibs-daily'
          ? `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`
          : t.toISOString().split('.')[0] + 'Z';
        const url = this.buildWmsTileUrl(`aetherwx:${product.gsName}`, timeParam);
        (src as maplibregl.RasterTileSource).setTiles([url]);
      }
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
  protected currentSatAttribution(): string {
    const k = this.activeSat();
    const p = SAT_PRODUCTS.find((x) => x.key === k);
    return p?.attribution ?? '';
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

      // G8 — 6 layers points simples : circle paint factorisé via config.
      const SIMPLE_POINT_PAINT: Partial<Record<typeof kind, { color: string; radius: number; stroke: string }>> = {
        metar:  { color: '#fbbf24', radius: 4, stroke: '#92400e' },
        hubeau: { color: '#06b6d4', radius: 5, stroke: '#0e7490' },
        piezo:  { color: '#8b5cf6', radius: 5, stroke: '#6d28d9' },
        quakes: { color: '#ef4444', radius: 5, stroke: '#7f1d1d' },
        firms:  { color: '#f97316', radius: 4, stroke: '#7c2d12' },
        buoys:  { color: '#10b981', radius: 5, stroke: '#064e3b' },
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
      } else if (kind === 'lightning') {
        map.addLayer({
          id: 'vec-lightning',
          type: 'circle',
          source: sourceId,
          paint: {
            'circle-radius': 4,
            'circle-color': '#fde047',
            'circle-stroke-width': 1,
            'circle-stroke-color': '#fbbf24',
            'circle-opacity': 0.85,
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
      return await firstValueFrom(this.vesselsService.fetchLiveVessels(new Date(), 900));
    }
    // G8 — fetch REST direct pour 6 layers vector (metar/hubeau/piezo/quakes/firms/buoys).
    // Endpoints standardisés sur /api/<kind>/recent côté NestJS api.
    const at = new Date().toISOString();
    const resp = await fetch(`/api/${kind}/recent?at=${encodeURIComponent(at)}`);
    if (!resp.ok) {
      throw new Error(`/api/${kind}/recent → HTTP ${resp.status}`);
    }
    return await resp.json();
  }

  onSatChange(key: string) {
    if (this.activeSat() === key) return;
    const prev = this.activeSat();
    this.activeSat.set(key);
    const map = this.map;
    if (!map) return;

    // Retire la source/layer précédente (s'il y en avait une).
    if (prev !== 'none') {
      const prevLayerId = `sat-${prev}`;
      if (map.getLayer(prevLayerId)) map.removeLayer(prevLayerId);
      if (map.getSource(prevLayerId)) map.removeSource(prevLayerId);
    }
    if (key === 'none') return;

    const product = SAT_PRODUCTS.find((p) => p.key === key);
    if (!product) return;
    const sourceId = `sat-${product.key}`;
    const layerId = sourceId;

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

    // z-order : sat sous SST (si présent) et sous wind ; sat-cascade
    // (EUMETSAT/radar) au-dessus du basemap mais sous tout le reste.
    const before = map.getLayer('sst-wms')
      ? 'sst-wms'
      : map.getLayer('wind-webgl')
        ? 'wind-webgl'
        : undefined;
    map.addLayer({ id: layerId, type: 'raster', source: sourceId, paint: { 'raster-opacity': 0.85 } }, before);
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
      const allLayers = ['vec-vessels-clusters', 'vec-vessels-points', 'vec-lightning', 'vec-alerts'];
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
            <div style="font-size:13px;font-weight:600;color:${color};border-bottom:1px solid #2a3245;padding-bottom:6px;margin-bottom:4px">⚠ ${kind ?? 'Alerte'} <span style="font-size:10px;text-transform:uppercase;opacity:.8">(${severity})</span></div>
            ${row('Cible', target)}
            ${row('Heure', fmtRelTime(ts))}
          </div>`;
      }

      if (html) {
        // Retour à maplibregl.Popup natif (Sylvain : 'MapLibre gère ça').
        // L'ancien bug 'popup en bas hors map' venait de mon CSS override
        // qui mettait position: relative sur .maplibregl-popup-content,
        // ce qui cassait le transform du wrapper .maplibregl-popup parent.
        const coords = (f.geometry as GeoJSON.Point).coordinates as [number, number];
        new maplibregl.Popup({ closeButton: true, maxWidth: '280px', offset: 12 })
          .setLngLat(coords)
          .setHTML(html)
          .addTo(map);
      }
    });

    // Cursor pointer sur hover (UX feedback que c'est cliquable)
    const setCursor = (cursor: string) => () => {
      map.getCanvas().style.cursor = cursor;
    };
    for (const layerId of ['vec-vessels-clusters', 'vec-vessels-points', 'vec-lightning', 'vec-alerts']) {
      map.on('mouseenter', layerId, setCursor('pointer'));
      map.on('mouseleave', layerId, setCursor(''));
    }

    this.map = map;
    // 2026-05-21 — Expose en window pour debug DOM popup positioning
    (window as unknown as { globeMap: MapLibreMap }).globeMap = map;
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
