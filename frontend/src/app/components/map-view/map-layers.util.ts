/**
 * Helpers PURS de construction d'URL WMS (2026-06-17) — miroir de
 * globe.component.ts buildWmsTileUrl + formats TIME. Réutilisés par
 * MapViewComponent. Aucune dépendance Angular / état.
 */
import {
  RasterLayerDescriptor, SatProduct, WMS_TILE_SIZE, WmsTimeKind,
} from './map-layers-constants';

/** YYYY-MM-DD UTC pour un instant donné. */
export function formatDailyDate(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** ISO 8601 sans millisecondes, suffixe Z (format attendu par GS forecast). */
export function formatIsoTime(d: Date): string {
  return d.toISOString().split('.')[0] + 'Z';
}

/** Jour J-2 capped pour NASA GIBS (lag ~24-48h). Miroir gibsDailyDate(). */
export function gibsDailyDate(now: Date = new Date()): string {
  return formatDailyDate(new Date(now.getTime() - 48 * 3_600_000));
}

/** Formate le paramètre TIME selon le type de layer. '' = pas de TIME. */
export function formatWmsTime(kind: WmsTimeKind, when: Date): string {
  if (kind === 'none') return '';
  if (kind === 'daily') return formatDailyDate(when);
  return formatIsoTime(when);
}

/**
 * URL de tuile WMS GeoServer (parité globe.buildWmsTileUrl). Le workspace est
 * dérivé du préfixe de `layerName` (aetherwx-sat:foo → /geoserver/aetherwx-sat/wms).
 * `time` vide → pas de paramètre TIME (cascade-realtime).
 */
export function buildGeoserverWmsUrl(
  layerName: string,
  time: string,
  opts?: { interpolations?: string; style?: string },
): string {
  const styleParam = opts?.style ?? (layerName === 'aetherwx:sst-daily' ? 'sst-direct' : '');
  const ws = layerName.split(':')[0];
  const timeFragment = time ? `&TIME=${encodeURIComponent(time)}` : '';
  return `/geoserver/${ws}/wms` +
    '?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap' +
    `&LAYERS=${encodeURIComponent(layerName)}&STYLES=${encodeURIComponent(styleParam)}&FORMAT=image/png&TRANSPARENT=true&tiled=true` +
    timeFragment +
    (opts?.interpolations ? `&INTERPOLATIONS=${opts.interpolations}` : '') +
    `&SRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=${WMS_TILE_SIZE}&HEIGHT=${WMS_TILE_SIZE}`;
}

/** URL d'un overlay statique proxifié nginx (bathy/eez/mpa, pas de TIME). */
export function buildProxyWmsUrl(proxyUrl: string, wmsLayer: string): string {
  return `${proxyUrl}?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap` +
    `&LAYERS=${encodeURIComponent(wmsLayer)}` +
    '&STYLES=&FORMAT=image/png&TRANSPARENT=true' +
    `&SRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=${WMS_TILE_SIZE}&HEIGHT=${WMS_TILE_SIZE}`;
}

/** URL d'un produit satellite (GIBS daily J-2 ou cascade sans TIME). */
export function buildSatWmsUrl(product: SatProduct, when: Date = new Date()): string {
  const layerName = `${product.workspace}:${product.gsName}`;
  const time = product.kind === 'gibs-daily' ? gibsDailyDate(when) : '';
  return buildGeoserverWmsUrl(layerName, time);
}

/** URL d'un raster décrit par un RasterLayerDescriptor à l'instant `when`. */
export function buildRasterUrl(desc: RasterLayerDescriptor, when: Date = new Date()): string {
  if (desc.source === 'proxy') {
    return buildProxyWmsUrl(desc.proxyUrl!, desc.wmsLayer!);
  }
  const time = formatWmsTime(desc.timeKind, when);
  return buildGeoserverWmsUrl(desc.layerName!, time, { style: desc.style, interpolations: desc.interpolations });
}
