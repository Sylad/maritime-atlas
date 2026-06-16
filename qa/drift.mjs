import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const GS = process.env.GS_URL ?? 'https://aetherwx.sladoire.dev/geoserver';

const committed = JSON.parse(readFileSync(join(here, 'layers.manifest.json'), 'utf8'));
execFileSync('node', [join(here, 'gen-manifest.mjs')], { stdio: 'ignore' });
const fresh = JSON.parse(readFileSync(join(here, 'layers.manifest.json'), 'utf8'));

const keyset = (m) => new Set(m.layers.map((l) => l.key));
const a = keyset(committed), b = keyset(fresh);
const added = [...b].filter((k) => !a.has(k));
const removed = [...a].filter((k) => !b.has(k));

let drift = false;
if (added.length)   { console.error(`DRIFT: layers FE non couverts (régénère le manifest): ${added}`); drift = true; }
if (removed.length) { console.error(`DRIFT: layers du manifest absents du FE: ${removed}`); drift = true; }

if (!process.env.SKIP_GETCAPS) {
  try {
    const caps = execFileSync('curl', ['-s', '--max-time', '20',
      `${GS}/aetherwx/wms?service=WMS&version=1.3.0&request=GetCapabilities`], { encoding: 'utf8' });
    const gsNames = [...caps.matchAll(/<Name>([a-z0-9-]+)<\/Name>/g)].map((m) => m[1]);
    const manifestLocal = new Set(fresh.layers.map((l) => (l.gsLayerName ?? '').split(':')[1]));
    const orphan = gsNames.filter((n) => !manifestLocal.has(n) && !n.startsWith('v_') && !n.includes('vessel'));
    if (orphan.length) console.error(`WARN: coverages GS hors manifest (vérifier si layer ou style): ${orphan}`);
  } catch (e) {
    console.error(`WARN: GetCapabilities injoignable, skip (${e.message})`);
  }
}

if (drift) process.exit(1);
console.log('drift: OK');
