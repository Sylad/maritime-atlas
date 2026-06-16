import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isUniformPng } from './lib/png-uniform.mjs';
import { VERDICT, isBlocking } from './lib/verdict.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const GS = process.env.GS_URL ?? 'https://aetherwx.sladoire.dev/geoserver';
const BASE = process.env.BASE_URL ?? 'https://aetherwx.sladoire.dev';
const manifest = JSON.parse(readFileSync(join(here, 'layers.manifest.json'), 'utf8'));

const BBOX = {
  europe: '-1000000,4000000,2500000,7500000',
  'sat-na': '-5009377,6261721,-3757032,7514065',
};
const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

async function checkRaster(layer) {
  const [ws, name] = layer.gsLayerName.split(':');
  const bbox = BBOX[layer.bboxFamily] ?? BBOX.europe;
  const cb = Math.floor(performance.now());
  const url = `${GS}/${ws}/wms?service=WMS&version=1.3.0&request=GetMap&layers=${layer.gsLayerName}`
    + `&styles=&crs=EPSG:3857&bbox=${bbox}&width=256&height=256&format=image/png`
    + `&transparent=true&time=${nowIso()}&CACHEBUST=${cb}`;
  let resp;
  try {
    resp = await fetch(url, { signal: AbortSignal.timeout(25000) });
  } catch (e) {
    return { verdict: VERDICT.FAIL, detail: `fetch error: ${e.message}` };
  }
  const ct = resp.headers.get('content-type') ?? '';
  if (!resp.ok || !ct.startsWith('image/')) {
    const body = (await resp.text()).slice(0, 160);
    const v = layer.upstreamDependent ? VERDICT.UPSTREAM : VERDICT.FAIL;
    return { verdict: v, detail: `HTTP ${resp.status} ${ct} ${body.replace(/\s+/g, ' ')}` };
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  if (ct.startsWith('image/png') && isUniformPng(buf)) {
    return { verdict: VERDICT.BLANK, detail: `placeholder uniforme (${buf.length}o)` };
  }
  return { verdict: VERDICT.PASS, detail: `${ct} ${buf.length}o` };
}

async function checkVector(layer) {
  let url;
  if (layer.kind === 'vector-wfs') {
    url = `${GS}/aetherwx/ows?service=WFS&version=2.0.0&request=GetFeature`
        + `&typeNames=${layer.typeName}&outputFormat=application/json&count=5`;
  } else {
    url = BASE + layer.endpoint.replace('{AT}', encodeURIComponent(nowIso()));
  }
  let resp;
  try {
    resp = await fetch(url, { signal: AbortSignal.timeout(25000) });
  } catch (e) {
    return { verdict: VERDICT.FAIL, detail: `fetch error: ${e.message}` };
  }
  const ct = resp.headers.get('content-type') ?? '';
  if (!resp.ok || ct.includes('xml')) {
    const body = (await resp.text()).slice(0, 160);
    return { verdict: VERDICT.FAIL, detail: `HTTP ${resp.status} ${ct} ${body.replace(/\s+/g, ' ')}` };
  }
  let json;
  try { json = await resp.json(); } catch (e) { return { verdict: VERDICT.FAIL, detail: `bad json: ${e.message}` }; }
  const n = Array.isArray(json.features) ? json.features.length : 0;
  if (n === 0) return { verdict: VERDICT.BLANK, detail: 'features: []' };
  if (layer.kind === 'vector-proxy' && layer.fallbackCount && n === layer.fallbackCount) {
    return { verdict: VERDICT.BLANK, detail: `fallback hardcodé probable (${n} features)` };
  }
  return { verdict: VERDICT.PASS, detail: `${n} features` };
}

async function main() {
  const results = [];
  for (const layer of manifest.layers) {
    const isRaster = layer.kind.startsWith('raster');
    const r = isRaster ? await checkRaster(layer) : await checkVector(layer);
    results.push({ key: layer.key, kind: layer.kind, ...r });
    console.log(`${r.verdict.padEnd(8)} ${layer.key.padEnd(20)} ${r.detail}`);
  }
  const fails = results.filter((r) => isBlocking(r.verdict));
  const blanks = results.filter((r) => r.verdict === VERDICT.BLANK);
  const up = results.filter((r) => r.verdict === VERDICT.UPSTREAM);
  console.log(`\nPASS=${results.length - fails.length - blanks.length - up.length} BLANK=${blanks.length} UPSTREAM=${up.length} FAIL=${fails.length} TOTAL=${results.length}`);
  if (fails.length) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
