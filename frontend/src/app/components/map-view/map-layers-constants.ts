/**
 * Constantes de layers WMS partagées (2026-06-17) — extraites pour être
 * réutilisées par le MapViewComponent embarquable (widgets dashboard) SANS
 * dupliquer la connaissance des layers.
 *
 * ⚠️ Le GlobeComponent prod garde pour l'instant ses propres copies de ces
 * descripteurs (SAT_PRODUCTS, gsName/style par toggle*). À terme il devrait
 * importer ce fichier pour une source de vérité unique — migration laissée à
 * une passe ultérieure pour ne pas toucher le globe prod maintenant.
 * En attendant, garder CE fichier en phase avec globe.component.ts.
 */

export interface SatProduct {
  key: string;
  label: string;
  gsName: string;
  workspace: 'aetherwx' | 'aetherwx-sat';
  /** gibs-daily → TIME=YYYY-MM-DD (J-2). cascade-realtime → pas de TIME. */
  kind: 'gibs-daily' | 'cascade-realtime';
  attribution: string;
}

/** Miroir de globe.component.ts SAT_PRODUCTS (lignes ~85-98). */
export const SAT_PRODUCTS: SatProduct[] = [
  { key: 'satTrueColor',      label: 'Vrai couleur MODIS',         gsName: 'sat-modis-true-color',  workspace: 'aetherwx-sat', kind: 'gibs-daily',       attribution: 'NASA GIBS MODIS Terra' },
  { key: 'satTrueColorVIIRS', label: 'Vrai couleur VIIRS',         gsName: 'sat-viirs-true-color',  workspace: 'aetherwx-sat', kind: 'gibs-daily',       attribution: 'NASA GIBS VIIRS SNPP' },
  { key: 'satIR',             label: 'Infrarouge thermique',       gsName: 'sat-modis-ir',          workspace: 'aetherwx-sat', kind: 'gibs-daily',       attribution: 'NASA GIBS MODIS Band 31' },
  { key: 'satWaterVapor',     label: 'Température air',             gsName: 'sat-airs-air-temp',     workspace: 'aetherwx-sat', kind: 'gibs-daily',       attribution: 'NASA GIBS AIRS' },
  { key: 'satCloudTop',       label: 'Sommet des nuages',          gsName: 'sat-modis-cloud-top',   workspace: 'aetherwx-sat', kind: 'gibs-daily',       attribution: 'NASA GIBS MODIS' },
  { key: 'satAerosol',        label: 'Aérosols / poussières',      gsName: 'sat-modis-aerosol',     workspace: 'aetherwx-sat', kind: 'gibs-daily',       attribution: 'NASA GIBS MODIS AOD' },
  { key: 'satDayNight',       label: 'VIIRS jour/nuit',            gsName: 'sat-viirs-day-night',   workspace: 'aetherwx-sat', kind: 'gibs-daily',       attribution: 'NASA GIBS VIIRS DayNight' },
  { key: 'satEuIrRss',        label: 'EUMETSAT IR Europe (5 min)', gsName: 'sat-eu-ir-rss',         workspace: 'aetherwx',     kind: 'cascade-realtime', attribution: 'EUMETSAT MSG SEVIRI Rapid Scan' },
  { key: 'satGlobalIrMtg',    label: 'EUMETSAT MTG IR global',     gsName: 'sat-global-ir-mtg',     workspace: 'aetherwx',     kind: 'cascade-realtime', attribution: 'EUMETSAT MTG FCI' },
  { key: 'satEuHrvRgb',       label: 'EUMETSAT HRV RGB Europe',    gsName: 'sat-eu-hrv-rgb',        workspace: 'aetherwx',     kind: 'cascade-realtime', attribution: 'EUMETSAT MSG SEVIRI HRV' },
  { key: 'radarDwd',          label: 'Radar Allemagne (DWD)',      gsName: 'radar-dwd-de',          workspace: 'aetherwx',     kind: 'cascade-realtime', attribution: 'DWD Open Data Radar' },
  { key: 'radarKnmi',         label: 'Radar Pays-Bas (KNMI)',      gsName: 'radar-knmi-nl',         workspace: 'aetherwx',     kind: 'cascade-realtime', attribution: 'KNMI Open Geo Radar' },
];

export const SAT_PRODUCT_KEYS = new Set(SAT_PRODUCTS.map((p) => p.key));

/** Comment formater le paramètre TIME pour un layer raster WMS. */
export type WmsTimeKind = 'daily' | 'iso' | 'none';

/**
 * Descripteur d'un layer raster WMS rendu dans une widget. Couvre les rasters
 * GeoServer (sst/forecast/contours) et les overlays statiques proxifiés
 * (bathy/eez/mpa). Les satellites sont gérés à part via SAT_PRODUCTS.
 */
export interface RasterLayerDescriptor {
  /** Clé de visibilité dans MapConfigSnapshot.layers.visibility / .contours. */
  key: string;
  /** ID de source/layer MapLibre dans la widget (suffixe -wms pour parité globe). */
  layerId: string;
  source: 'geoserver' | 'proxy';
  /** GeoServer : nom complet `workspace:layer`. */
  layerName?: string;
  /** GeoServer : STYLES (vide = defaultStyle GS). */
  style?: string;
  /** GeoServer : INTERPOLATIONS (ex 'bicubic'). */
  interpolations?: string;
  /** Proxy nginx : URL de base (ex '/wms-emodnet'). */
  proxyUrl?: string;
  /** Proxy : nom de layer WMS upstream. */
  wmsLayer?: string;
  timeKind: WmsTimeKind;
  defaultOpacity: number;
  attribution?: string;
}

/**
 * Descripteurs rasters — miroir des toggle* du GlobeComponent
 * (toggleSst / toggleForecastLayer / toggleContourLayer / toggleStaticWmsLayer).
 */
export const RASTER_LAYERS: Record<string, RasterLayerDescriptor> = {
  // ─── GeoServer time-enabled ───
  sst:           { key: 'sst',           layerId: 'sst-wms',            source: 'geoserver', layerName: 'aetherwx:sst-daily',         style: 'sst-direct', interpolations: 'bicubic', timeKind: 'daily', defaultOpacity: 0.7 },
  windForecast:  { key: 'windForecast',  layerId: 'wind-forecast-wms',  source: 'geoserver', layerName: 'aetherwx:wind-speed',        interpolations: 'bicubic', timeKind: 'iso', defaultOpacity: 0.7 },
  wavesForecast: { key: 'wavesForecast', layerId: 'waves-forecast-wms', source: 'geoserver', layerName: 'aetherwx:wave-hs',           interpolations: 'bicubic', timeKind: 'iso', defaultOpacity: 0.7 },
  glofas:        { key: 'glofas',        layerId: 'glofas-wms',         source: 'geoserver', layerName: 'aetherwx:glofas-discharge',  style: 'glofas-discharge', interpolations: 'bicubic', timeKind: 'iso', defaultOpacity: 0.75 },
  temp2m:        { key: 'temp2m',        layerId: 'temp2m-wms',         source: 'geoserver', layerName: 'aetherwx:temp-2m',           interpolations: 'bicubic', timeKind: 'iso', defaultOpacity: 0.75 },
  pressureMsl:   { key: 'pressureMsl',   layerId: 'pressure-msl-wms',   source: 'geoserver', layerName: 'aetherwx:pressure-msl',      interpolations: 'bicubic', timeKind: 'iso', defaultOpacity: 0.65 },
  humidity:      { key: 'humidity',      layerId: 'humidity-wms',       source: 'geoserver', layerName: 'aetherwx:humidity-2m',       interpolations: 'bicubic', timeKind: 'iso', defaultOpacity: 0.7 },
  precipitation: { key: 'precipitation', layerId: 'precipitation-wms',  source: 'geoserver', layerName: 'aetherwx:precipitation-6h',  interpolations: 'bicubic', timeKind: 'iso', defaultOpacity: 0.75 },
  // ─── Contours (overlay isolignes, time-enabled) ───
  sstContours:   { key: 'sstContours',   layerId: 'sst-contours-wms',   source: 'geoserver', layerName: 'aetherwx:sst-daily',   style: 'aetherwx:sst-contours-only',         interpolations: 'bicubic', timeKind: 'daily', defaultOpacity: 0.9 },
  windContours:  { key: 'windContours',  layerId: 'wind-contours-wms',  source: 'geoserver', layerName: 'aetherwx:wind-speed',  style: 'aetherwx:wind-speed-contours-only',  interpolations: 'bicubic', timeKind: 'iso', defaultOpacity: 0.9 },
  waveContours:  { key: 'waveContours',  layerId: 'wave-contours-wms',  source: 'geoserver', layerName: 'aetherwx:wave-hs',     style: 'aetherwx:wave-hs-contours-only',     interpolations: 'bicubic', timeKind: 'iso', defaultOpacity: 0.9 },
  // ─── Overlays statiques proxifiés (pas de TIME) ───
  bathy:         { key: 'bathy',         layerId: 'bathy-wms',          source: 'proxy', proxyUrl: '/wms-emodnet',       wmsLayer: 'mean_atlas_land',          timeKind: 'none', defaultOpacity: 0.7, attribution: '© EMODnet Bathymetry' },
  eez:           { key: 'eez',           layerId: 'eez-wms',            source: 'proxy', proxyUrl: '/wms-marineregions',  wmsLayer: 'MarineRegions:eez',        timeKind: 'none', defaultOpacity: 0.6, attribution: '© Marine Regions (VLIZ)' },
  mpa:           { key: 'mpa',           layerId: 'mpa-wms',            source: 'proxy', proxyUrl: '/wms-emodnet-human',  wmsLayer: 'marineprotectedareas',     timeKind: 'none', defaultOpacity: 0.6, attribution: '© EMODnet Human Activities' },
};

export const SAT_DEFAULT_OPACITY = 0.85;
export const WMS_TILE_SIZE = 256;

/** Basemap fond de carte (parité globe). */
export const CARTO_DARK_TILES = [
  'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
  'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
  'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
  'https://d.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
];
export const MAPLIBRE_GLYPHS = 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf';
