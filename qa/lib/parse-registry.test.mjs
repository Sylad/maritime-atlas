import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAnimatableRaster, parseSatProducts } from './parse-registry.mjs';

const SRC = `
  private readonly animatableLayersGlobe = [
    { key: 'sst',          label: 'SST',           type: 'wms', gsLayerName: 'aetherwx:sst-daily' },
    { key: 'glofas',       label: 'GloFAS crues',  type: 'wms', gsLayerName: 'aetherwx:glofas-discharge' },
    ...SAT_PRODUCTS.map((p) => ({ key: p.key, label: p.label, type: 'wms' as const, gsLayerName: \`\${p.workspace}:\${p.gsName}\` })),
    { key: 'lightning',    label: 'Foudre',        type: 'vector' as const },
  ];
  const SAT_PRODUCTS = [
    { key: 'satTrueColor', label: 'X', gsName: 'sat-modis-true-color', workspace: 'aetherwx-sat', kind: 'gibs-daily', attribution: 'NASA' },
    { key: 'satEuIrRss',   label: 'Y', gsName: 'sat-eu-ir-rss',        workspace: 'aetherwx',     kind: 'cascade-realtime', attribution: 'EUMETSAT' },
  ];
`;

test('parseAnimatableRaster extracts wms layers with gsLayerName, skips vector and spread', () => {
  const got = parseAnimatableRaster(SRC);
  assert.deepEqual(got, [
    { key: 'sst', label: 'SST', gsLayerName: 'aetherwx:sst-daily' },
    { key: 'glofas', label: 'GloFAS crues', gsLayerName: 'aetherwx:glofas-discharge' },
  ]);
});

test('parseSatProducts builds gsLayerName and flags cascade as upstream', () => {
  const got = parseSatProducts(SRC);
  assert.deepEqual(got, [
    { key: 'satTrueColor', gsLayerName: 'aetherwx-sat:sat-modis-true-color', workspace: 'aetherwx-sat', upstreamDependent: false },
    { key: 'satEuIrRss',   gsLayerName: 'aetherwx:sat-eu-ir-rss',            workspace: 'aetherwx',     upstreamDependent: true },
  ]);
});
