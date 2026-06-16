import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseAnimatableRaster, parseSatProducts } from './lib/parse-registry.mjs';
import { VECTOR_SOURCES } from './lib/vector-sources.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const GC = join(here, '..', 'frontend/src/app/pages/globe/globe.component.ts');

function vectorUnionKinds(src) {
  const m = src.match(/_fetchVectorFc\(kind:\s*([^)]+)\)/);
  if (!m) throw new Error('_fetchVectorFc signature not found');
  return [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]);
}

function build() {
  const src = readFileSync(GC, 'utf8');
  const entries = [];

  for (const r of parseAnimatableRaster(src)) {
    const [workspace] = r.gsLayerName.split(':');
    entries.push({
      key: r.key, label: r.label, gsLayerName: r.gsLayerName, workspace,
      kind: 'raster-coverage', timeEnabled: true, hasOpacityControl: true,
      bboxFamily: 'europe', upstreamDependent: false,
    });
  }

  for (const s of parseSatProducts(src)) {
    entries.push({
      key: s.key, label: s.key, gsLayerName: s.gsLayerName, workspace: s.workspace,
      kind: 'raster-cascade', timeEnabled: true, hasOpacityControl: true,
      bboxFamily: s.workspace === 'aetherwx-sat' ? 'sat-na' : 'europe',
      upstreamDependent: s.upstreamDependent,
    });
  }

  const unionKinds = vectorUnionKinds(src);
  const missing = unionKinds.filter((k) => !VECTOR_SOURCES[k]);
  if (missing.length) {
    throw new Error(`vector kinds sans entrée VECTOR_SOURCES (drift): ${missing.join(', ')}`);
  }
  for (const key of unionKinds) {
    const v = VECTOR_SOURCES[key];
    entries.push({
      key, label: key, gsLayerName: v.typeName ?? null, workspace: 'aetherwx',
      kind: v.kind, endpoint: v.endpoint ?? null, typeName: v.typeName ?? null,
      timeEnabled: v.timeEnabled, hasOpacityControl: true, bboxFamily: 'europe',
      fallbackCount: v.fallbackCount ?? null, upstreamDependent: false,
    });
  }

  return { generatedFrom: 'globe.component.ts', count: entries.length, layers: entries };
}

const manifest = build();
const outPath = join(here, 'layers.manifest.json');
writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`manifest: ${manifest.count} layers → ${outPath}`);
