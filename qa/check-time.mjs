#!/usr/bin/env node
// D3 — time-coherence : un layer raster /globe est-il VRAIMENT piloté par la time-bar ?
//
// 3 invariants (cf docs/aetherwx-animation.md §2 + skill check-layer-time-coherence) :
//   TC-1  toggle ON puis 1 step → ≥1 GetMap WMS du layer part, et si le curseur n'est
//         pas LIVE le param TIME doit s'aligner sur le curseur (tolérance step/2).
//   TC-2  step suivant du slider → nouvelle GetMap sous ~2s avec un TIME *différent*.
//   TC-3  ~1 cycle de play → ≥3 valeurs TIME distinctes dans les GetMap du layer.
//
// Cible : layers timeEnabled + kind raster-*. Les sat/radar (upstreamDependent ou
// raster-cascade) sont data-dependent → si aucune GetMap exploitable, UPSTREAM (≠ FAIL).
//
// Fail-loud (I-1/I-2) : 0 GetMap sur un coverage non-upstream, master introuvable,
// play sans frame = FAIL explicite, jamais un PASS déguisé.
//
// Mode anti-flakiness : `--flaky[=K]` (défaut K=10). Sur UN layer master représentatif
// avec données, lance K cycles de play et exige K/K succès de TC-3 (≥3 TIME distincts).
// Transforme « l'anim marche 1 fois sur 100 » en signal reproductible (prérequis debug P5).
//
// IMPORTANT — WebGL : le globe MapLibre exige un contexte WebGL. Le chromium Playwright
// en headless pur échoue (BindToCurrentSequence failed) sur cette machine WSL2. On lance
// donc Chrome *headed* sous un X virtuel (swiftshader). Si $DISPLAY est absent, le script
// fail-loud avec la commande xvfb-run exacte à coller (pas de relance interne non fiable).
//
// Usage:
//   xvfb-run -a -s "-screen 0 1400x900x24" node qa/check-time.mjs              # tous rasters
//   xvfb-run -a -s "-screen 0 1400x900x24" node qa/check-time.mjs --flaky      # K=10
//   xvfb-run -a -s "-screen 0 1400x900x24" node qa/check-time.mjs --flaky=20   # K=20
//   xvfb-run -a -s "-screen 0 1400x900x24" node qa/check-time.mjs --layer=sst  # un layer
//   BASE_URL=http://localhost:4200 xvfb-run -a node qa/check-time.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { VERDICT, isBlocking } from './lib/verdict.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE_URL ?? 'https://aetherwx.sladoire.dev';
const manifest = JSON.parse(readFileSync(join(here, 'layers.manifest.json'), 'utf8'));

// ─── Auto-relaunch sous xvfb si pas de DISPLAY (WebGL software via swiftshader) ───────
// Le globe ne peut pas obtenir de contexte WebGL en headless pur ici. xvfb-run + Chrome
// headed = WebGL fonctionnel. On ne le fait qu'une fois (garde QA_XVFB).
if (!process.env.DISPLAY) {
  // Le globe MapLibre exige un contexte WebGL. Le chromium Playwright en headless pur
  // échoue ici (WSL2 : "BindToCurrentSequence failed"). Solution validée : Chrome headed
  // sous un X virtuel. On NE tente PAS de relancer xvfb-run en interne (le double-spawn
  // est non fiable selon l'env : Xvfb peut ne pas binder et la commande tourne sans X).
  // Fail-loud avec la commande exacte (cf docs/aetherwx-animation.md — pas de fallback masqué).
  console.error('FATAL: pas de $DISPLAY — le globe MapLibre exige WebGL (headless pur KO sur WSL2).');
  console.error('Relancer sous un X virtuel :');
  console.error('  xvfb-run -a -s "-screen 0 1400x900x24" node qa/check-time.mjs' + process.argv.slice(2).map((a) => ' ' + a).join(''));
  process.exit(1);
}

const { chromium } = await import('playwright');

const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--enable-unsafe-swiftshader',
  '--use-gl=angle',
  '--use-angle=swiftshader',
];

// ─── Mapping DOM ↔ key (repris du skill check-layer-time-coherence, confirmé prod) ────
// section : texte qui apparaît dans .catalog-section-head (regex).
// toggle  : regex sur .toggle-name (texte exact du label dans le menu Angular).
// Source labels : check-ui.mjs UI_NAME + skill §"Mapping DOM ↔ key".
const DOM = {
  sst:               { section: /Maritime/,    toggle: /^SST/i },
  wavesForecast:     { section: /Maritime/,    toggle: /^Vagues/i },
  windForecast:      { section: /Forecast/,    toggle: /^Vent/i },
  temp2m:            { section: /Forecast/,    toggle: /Température 2m/i },
  pressureMsl:       { section: /Forecast/,    toggle: /Pression MSL/i },
  humidity:          { section: /Forecast/,    toggle: /Humidité/i },
  precipitation:     { section: /Forecast/,    toggle: /Précipitations/i },
  glofas:            { section: /Hydrologie/,  toggle: /GloFAS/i },
  satTrueColor:      { section: /Satellites/,  toggle: /Vrai couleur MODIS/i },
  satTrueColorVIIRS: { section: /Satellites/,  toggle: /Vrai couleur VIIRS/i },
  satIR:             { section: /Satellites/,  toggle: /Infrarouge thermique/i },
  satWaterVapor:     { section: /Satellites/,  toggle: /Température air/i },
  satCloudTop:       { section: /Satellites/,  toggle: /Sommet des nuages/i },
  satAerosol:        { section: /Satellites/,  toggle: /Aérosols/i },
  satDayNight:       { section: /Satellites/,  toggle: /jour.{0,3}nuit/i },
  satEuIrRss:        { section: /Satellites/,  toggle: /IR Europe.*5\s*min/i },
  satGlobalIrMtg:    { section: /Satellites/,  toggle: /IR global.*10\s*min/i },
  satEuHrvRgb:       { section: /Satellites/,  toggle: /Visible HRV RGB/i },
  radarDwd:          { section: /Radar/,       toggle: /Radar Allemagne/i },
  radarKnmi:         { section: /Radar/,       toggle: /Radar Pays-Bas/i },
};

// Step natif par layer (ms) — tolérance TC-1 = step/2. Repris du skill (STEP_MS).
const STEP_MS = {
  sst: 86_400_000, glofas: 86_400_000,
  windForecast: 3_600_000, wavesForecast: 3_600_000,
  temp2m: 3_600_000, pressureMsl: 3_600_000, humidity: 3_600_000, precipitation: 21_600_000,
  satTrueColor: 86_400_000, satTrueColorVIIRS: 86_400_000, satIR: 86_400_000,
  satWaterVapor: 86_400_000, satCloudTop: 86_400_000, satAerosol: 86_400_000, satDayNight: 86_400_000,
  satEuIrRss: 300_000, satGlobalIrMtg: 600_000, satEuHrvRgb: 900_000,
  radarDwd: 300_000, radarKnmi: 300_000,
};
const stepMs = (k) => STEP_MS[k] ?? 3_600_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Helpers DOM (exécutés dans la page) ──────────────────────────────────────────────
async function openSection(page, sectionRe) {
  await page.evaluate((reSrc) => {
    const re = new RegExp(reSrc);
    const h = [...document.querySelectorAll('.catalog-section-head')].find((x) => re.test(x.textContent || ''));
    if (h) {
      const s = h.closest('.catalog-section');
      if (s && !s.classList.contains('is-open')) h.click();
    }
  }, sectionRe.source);
  await sleep(700);
}

// Renvoie 'clicked' | 'already-on' | 'disabled' | 'no-checkbox' | 'not-found'.
async function toggleOn(page, toggleRe) {
  return page.evaluate((reSrc) => {
    const re = new RegExp(reSrc, 'i');
    const labels = [...document.querySelectorAll('label.layer-toggle')];
    const lab = labels.find((l) => re.test(l.querySelector('.toggle-name')?.textContent?.trim() || ''));
    if (!lab) return 'not-found';
    const cb = lab.querySelector('input[type=checkbox]');
    if (!cb) return 'no-checkbox';
    if (cb.disabled) return 'disabled';
    if (cb.checked) return 'already-on';
    cb.click();
    return 'clicked';
  }, toggleRe.source);
}

async function clickSlider(page, titleRe) {
  return page.evaluate((reSrc) => {
    const re = new RegExp(reSrc, 'i');
    const btn = [...document.querySelectorAll('.ts-controls .ts-btn')].find((b) => re.test(b.title || ''));
    if (!btn) return false;
    btn.click();
    return true;
  }, titleRe.source);
}

async function cursorLabel(page) {
  return page.evaluate(() => document.querySelector('.ts-label-full')?.textContent?.trim() ?? null);
}

// Parse le label FR "mer. 17 juin 2026 · 22:16" → ms epoch (heure locale du runner).
// Utilisé seulement pour l'alignement TC-1 indicatif quand TIME est présent.
const FR_MONTHS = ['janv','févr','mars','avril','mai','juin','juil','août','sept','oct','nov','déc'];
function parseCursorMs(label) {
  if (!label) return null;
  const m = label.match(/(\d{1,2})\s+([^\s.]+)\.?\s+(\d{4})\s*[·.]?\s*(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const day = +m[1];
  const mon = FR_MONTHS.findIndex((x) => m[2].toLowerCase().startsWith(x));
  if (mon < 0) return null;
  return Date.UTC(+m[3], mon, day, +m[4], +m[5]);
}

// Extrait le TIME (TIME ou time) d'une URL GetMap. null si absent.
function timeOf(url) {
  try {
    const sp = new URL(url).searchParams;
    return sp.get('TIME') ?? sp.get('time') ?? null;
  } catch { return null; }
}
function isGetMapOf(url, gsLayerName) {
  if (!/\/wms/i.test(url) || !/request=getmap/i.test(url)) return false;
  const enc = encodeURIComponent(gsLayerName).toLowerCase();
  const u = url.toLowerCase();
  return u.includes(gsLayerName.toLowerCase()) || u.includes(enc);
}

// ─── Cœur : teste TC-1/TC-2/TC-3 pour un layer (page déjà reset/reload) ───────────────
async function checkLayer(page, reqs, layer) {
  const dom = DOM[layer.key];
  if (!dom) return { verdict: VERDICT.SKIP, detail: 'pas de mapping DOM (key absente de DOM{})' };
  const cascade = layer.kind === 'raster-cascade' || layer.upstreamDependent;
  const tol = stepMs(layer.key) / 2;
  const tc = { tc1: '-', tc2: '-', tc3: '-' };

  await openSection(page, dom.section);
  const tg = await toggleOn(page, dom.toggle);
  if (tg === 'not-found') return { verdict: VERDICT.SKIP, detail: `toggle introuvable (${dom.toggle})`, tc };
  if (tg === 'disabled')  return { verdict: VERDICT.SKIP, detail: 'toggle désactivé (layer à venir ?)', tc };
  await sleep(4000);

  // ── TC-1 — un step (goPrev) garantit l'émission d'un TIME (à LIVE le front l'omet).
  let mark = Date.now();
  if (!(await clickSlider(page, /précédente/))) {
    return { verdict: VERDICT.FAIL, detail: 'TC-1: bouton "validité précédente" introuvable', tc };
  }
  await sleep(2800);
  let got = reqs.filter((x) => x.t >= mark && isGetMapOf(x.u, layer.gsLayerName));
  if (got.length === 0) {
    const v = cascade ? VERDICT.UPSTREAM : VERDICT.FAIL;
    tc.tc1 = '✗';
    return { verdict: v, detail: `TC-1: 0 GetMap WMS sur ${layer.gsLayerName} après toggle+step`
      + (cascade ? ' (cascade/upstream — probablement no-data)' : ' (coverage attendu → wiring KO)'), tc };
  }
  const t1 = timeOf(got[0].u);
  const curMs = parseCursorMs(await cursorLabel(page));
  if (t1 && curMs != null) {
    const reqMs = Date.parse(t1.length <= 10 ? `${t1}T00:00:00Z` : t1);
    // SST/glofas = date-only : on compare au jour (tol = 1 step).
    const effTol = t1.length <= 10 ? Math.max(tol, 43_200_000) : tol;
    const d = Math.abs(reqMs - curMs);
    if (d > effTol + 12 * 3_600_000) { // marge label local↔UTC
      tc.tc1 = '✗';
      return { verdict: VERDICT.FAIL, detail: `TC-1: TIME=${t1} désaligné du curseur (Δ≈${Math.round(d/3.6e6)}h > tol)`, tc };
    }
  }
  tc.tc1 = '✓';
  const tc1Time = t1;

  // ── TC-2 — step suivant → nouvelle GetMap avec TIME différent.
  mark = Date.now();
  if (!(await clickSlider(page, /précédente/))) {
    return { verdict: VERDICT.FAIL, detail: 'TC-2: bouton step introuvable', tc };
  }
  await sleep(2500);
  got = reqs.filter((x) => x.t >= mark && isGetMapOf(x.u, layer.gsLayerName));
  if (got.length === 0) {
    tc.tc2 = '✗';
    return { verdict: cascade ? VERDICT.UPSTREAM : VERDICT.FAIL,
      detail: `TC-2: 0 nouvelle GetMap après step (TIME figé = layer pas refetché)`, tc };
  }
  const t2 = timeOf(got[got.length - 1].u);
  if (t2 && tc1Time && t2 === tc1Time) {
    tc.tc2 = '✗';
    return { verdict: VERDICT.FAIL, detail: `TC-2: TIME identique avant/après step (${t2})`, tc };
  }
  tc.tc2 = '✓';

  // ── TC-3 — 1 cycle de play → ≥3 TIME distincts.
  const r3 = await playCycle(page, reqs, layer);
  if (r3.distinct.size < 3) {
    tc.tc3 = '✗';
    return { verdict: cascade ? VERDICT.UPSTREAM : VERDICT.FAIL,
      detail: `TC-3: ${r3.distinct.size} TIME distincts en play (attendu ≥3) ${[...r3.distinct].join('|')}`, tc };
  }
  tc.tc3 = '✓';
  return { verdict: VERDICT.PASS,
    detail: `TC-1 align ✓ · TC-2 ${tc1Time}→${t2} ✓ · TC-3 ${r3.distinct.size} TIME ✓`, tc };
}

// Ouvre l'AnimationPanel, choisit la plus longue durée activée, lance, attend la fin du
// preload (.ac-stop apparaît), capture ~4s de play, stoppe. Renvoie {distinct:Set, started}.
async function playCycle(page, reqs, layer) {
  await page.evaluate(() => document.querySelector('.ts-btn-play')?.click());
  await sleep(800);
  const panelOpen = await page.evaluate(() => !!document.querySelector('app-animation-panel .ap-launch'));
  if (!panelOpen) return { distinct: new Set(), started: false, err: 'AnimationPanel pas ouvert' };
  // Choisir la durée la plus longue NON désactivée (max de frames sous le cap 150).
  await page.evaluate(() => {
    const ds = [...document.querySelectorAll('app-animation-panel .ap-grid-2 .ap-btn')].filter((b) => !b.disabled);
    if (ds.length) ds[ds.length - 1].click();
  });
  await sleep(300);
  const mark = Date.now();
  const launch = await page.$('app-animation-panel .ap-launch');
  if (!launch) return { distinct: new Set(), started: false, err: 'bouton Lancer introuvable' };
  await launch.click({ force: true });
  // Le lancement préchargre les frames (~plusieurs s) AVANT que .ac-stop apparaisse.
  let started = false;
  try { await page.waitForSelector('.ac-stop', { timeout: 20000 }); started = true; } catch { /* no-op */ }
  await sleep(4000);
  await page.evaluate(() => document.querySelector('.ac-stop')?.click());
  await sleep(500);
  const distinct = new Set(
    reqs.filter((x) => x.t >= mark && isGetMapOf(x.u, layer.gsLayerName))
        .map((x) => timeOf(x.u)).filter(Boolean),
  );
  return { distinct, started };
}

// Reload propre entre layers (RÈGLE skill : sinon curseur cumulé → faux positifs).
async function freshPage(browser) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const reqs = [];
  page.on('request', (r) => reqs.push({ t: Date.now(), u: r.url() }));
  await page.goto(`${BASE}/?qa=1`, { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForFunction(() => !!window.__aetherwxQA, { timeout: 20000 }).catch(() => {});
  await sleep(3000);
  return { page, reqs };
}

// ─── Mode standard : tous les rasters timeEnabled (ou --layer=key) ────────────────────
async function runStandard(onlyKey) {
  const targets = manifest.layers.filter((l) =>
    l.timeEnabled && l.kind.startsWith('raster') && (!onlyKey || l.key === onlyKey));
  if (onlyKey && targets.length === 0) {
    console.error(`FATAL: layer "${onlyKey}" introuvable parmi les rasters timeEnabled.`);
    process.exit(1);
  }
  console.log(`Base URL: ${BASE}`);
  console.log(`D3 time-coherence — ${targets.length} layer(s) raster timeEnabled\n`);

  const browser = await chromium.launch({ headless: false, args: LAUNCH_ARGS });
  const results = [];
  for (const layer of targets) {
    const { page, reqs } = await freshPage(browser); // reload entre chaque layer
    let r;
    try { r = await checkLayer(page, reqs, layer); }
    catch (e) { r = { verdict: VERDICT.FAIL, detail: `erreur: ${e.message}`, tc: { tc1: '?', tc2: '?', tc3: '?' } }; }
    await page.close();
    results.push({ key: layer.key, kind: layer.kind, ...r });
    const tcs = r.tc ? `TC1 ${r.tc.tc1}  TC2 ${r.tc.tc2}  TC3 ${r.tc.tc3}` : '';
    console.log(`${r.verdict.padEnd(8)} ${layer.key.padEnd(20)} ${tcs.padEnd(28)} ${r.detail}`);
  }
  await browser.close();

  const fails = results.filter((r) => isBlocking(r.verdict));
  const up = results.filter((r) => r.verdict === VERDICT.UPSTREAM);
  const skip = results.filter((r) => r.verdict === VERDICT.SKIP);
  const pass = results.filter((r) => r.verdict === VERDICT.PASS);
  console.log('\n' + '─'.repeat(72));
  console.log(`PASS=${pass.length}  FAIL=${fails.length}  UPSTREAM=${up.length}  SKIP=${skip.length}  TOTAL=${results.length}`);
  if (fails.length) {
    console.log('\nFailing layers:');
    for (const r of fails) console.log(`  FAIL ${r.key}: ${r.detail}`);
    process.exit(1);
  }
}

// ─── Mode --flaky[=K] : K cycles de play sur UN master, exige K/K succès TC-3 ──────────
async function runFlaky(K, key) {
  const layer = manifest.layers.find((l) => l.key === key);
  if (!layer) { console.error(`FATAL: master "${key}" introuvable.`); process.exit(1); }
  console.log(`Base URL: ${BASE}`);
  console.log(`Anti-flakiness — ${K} runs de TC-3 (play) sur master "${key}" (${layer.gsLayerName})`);
  console.log('Critère par run : ≥3 valeurs TIME distinctes itérées.\n');

  const browser = await chromium.launch({ headless: false, args: LAUNCH_ARGS });
  const runs = [];
  for (let i = 0; i < K; i++) {
    const { page, reqs } = await freshPage(browser); // reload entre chaque run (pas de curseur cumulé)
    const dom = DOM[layer.key];
    await openSection(page, dom.section);
    const tg = await toggleOn(page, dom.toggle);
    if (tg === 'not-found' || tg === 'disabled') {
      runs.push({ ok: false, n: 0, note: `toggle ${tg}` });
      await page.close();
      console.log(`run ${String(i + 1).padStart(2)}/${K}  KO  toggle ${tg}`);
      continue;
    }
    await sleep(4000);
    let r3;
    try { r3 = await playCycle(page, reqs, layer); }
    catch (e) { r3 = { distinct: new Set(), started: false, err: e.message }; }
    await page.close();
    const n = r3.distinct.size;
    const ok = n >= 3;
    runs.push({ ok, n, started: r3.started, err: r3.err });
    console.log(`run ${String(i + 1).padStart(2)}/${K}  ${ok ? 'OK ' : 'KO '} ${n} TIME distincts`
      + (r3.started ? '' : ' [play jamais démarré]') + (r3.err ? ` [${r3.err}]` : ''));
  }
  await browser.close();

  const okN = runs.filter((r) => r.ok).length;
  const rate = `${okN}/${K}`;
  console.log('\n' + '─'.repeat(72));
  if (okN === K) {
    console.log(`FLAKY CHECK: ${rate} OK — STABLE. L'animation itère les validités de façon reproductible.`);
  } else {
    console.log(`FLAKY CHECK: ${rate} OK — FLAKY. Runs KO :`);
    runs.forEach((r, i) => { if (!r.ok) console.log(`  run ${i + 1}: ${r.n} TIME distincts ${r.started ? '' : '(play jamais démarré) '}${r.err ?? ''}`); });
    process.exit(1);
  }
}

// ─── CLI ──────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flakyArg = argv.find((a) => a.startsWith('--flaky'));
const layerArg = argv.find((a) => a.startsWith('--layer='))?.split('=')[1];
const DEFAULT_FLAKY_MASTER = 'sst'; // master avec données, daily → TC-3 net

if (flakyArg) {
  const K = flakyArg.includes('=') ? Math.max(1, parseInt(flakyArg.split('=')[1], 10) || 10) : 10;
  await runFlaky(K, layerArg ?? DEFAULT_FLAKY_MASTER);
} else {
  await runStandard(layerArg);
}
