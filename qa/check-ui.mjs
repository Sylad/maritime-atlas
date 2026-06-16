#!/usr/bin/env node
// D2 — câblage UI : toggle ON + opacity slider → opacité MapLibre lue via __aetherwxQA.
//
// Architecture:
//   Pour chaque section catalog (maritime, observation, satellites, radar, forecast,
//   hydrology, sources), on l'ouvre individuellement, teste les layers qu'elle contient,
//   puis on passe à la suivante. Les sections Angular utilisent @if donc les labels
//   n'existent dans le DOM que quand la section est ouverte (is-open).
//
// L'id MapLibre du layer testé est DÉRIVÉ AU RUNTIME (diff des layerIds() avant/après
// toggle ON) — pas de table en dur dupliquant mapLibreLayerIds() (sinon drift : la
// table pourrait masquer un bug de cette fonction, cf le fix opacity du 2026-06-16).
//
// Usage:
//   BASE_URL=http://localhost:4200 node qa/check-ui.mjs
//   BASE_URL=https://aetherwx.sladoire.dev node qa/check-ui.mjs  (si déployé avec QA hook)

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { VERDICT, isBlocking } from './lib/verdict.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE_URL ?? 'http://localhost:4200';
const manifest = JSON.parse(readFileSync(join(here, 'layers.manifest.json'), 'utf8'));

// Mapping manifest key → texte exact du .toggle-name dans l'UI Angular.
// Source: balises <span class="toggle-name">...</span> dans globe.component.ts.
const UI_NAME = {
  vessels:           'Navires',
  lightning:         'Foudre',
  alerts:            'Alertes',
  buoys:             'Plateformes vagues',
  sst:               'SST',
  wavesForecast:     'Vagues',
  windForecast:      'Vent',
  metar:             'METAR aéroports',
  quakes:            'Séismes USGS',
  sigmet:            'SIGMET / AIRMET',
  firms:             'Feux NASA FIRMS',
  satTrueColor:      'Vrai couleur MODIS',
  satTrueColorVIIRS: 'Vrai couleur VIIRS',
  satIR:             'Infrarouge thermique',
  satWaterVapor:     'Température air (proxy évap.)',
  satCloudTop:       'Sommet des nuages',
  satAerosol:        'Aérosols / poussières',
  satDayNight:       'VIIRS jour/nuit',
  satEuIrRss:        'IR Europe (5 min)',
  satGlobalIrMtg:    'IR global (10 min)',
  satEuHrvRgb:       'Visible HRV RGB Europe (15 min)',
  radarDwd:          'Radar Allemagne (5 min)',
  radarKnmi:         'Radar Pays-Bas (5 min)',
  temp2m:            'Température 2m',
  pressureMsl:       'Pression MSL',
  humidity:          'Humidité',
  precipitation:     'Précipitations',
  taf:               'TAF',
  hubeau:            'Débits rivières FR',
  piezo:             'Niveaux piézo FR',
  glofas:            'GloFAS forecast crues',
  bathy:             'Bathymétrie',
  eez:               'EEZ (zones éco. excl.)',
  mpa:               'MPA (aires marines)',
  cables:            'Câbles sous-marins',
  fir:               'FIR / UIR airspaces',
  airports:          'Aéroports (IATA)',
};

// Layers qui n'ont pas de <input class="layer-opacity"> dans le template
// (pas de slider opacity même si hasOpacityControl=true dans le manifest).
const NO_OPACITY_SLIDER_KEYS = new Set(['cables', 'airports']);

// Layers vector qui ne s'ajoutent à MapLibre qu'après réception de données backend.
// En local ng serve sans NestJS backend, ils restent absents → UPSTREAM (non blocking).
// En prod (avec backend), ils devraient apparaître et passer à PASS.
const VECTOR_BACKEND_DEPENDENT_KINDS = new Set([
  'vector-wfs', 'vector-api', 'vector-proxy',
]);

async function run() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  console.log(`Base URL: ${BASE}`);
  await page.goto(`${BASE}/?qa=1`, { waitUntil: 'networkidle', timeout: 30000 });

  // Attendre que la map soit prête et le hook QA exposé.
  try {
    await page.waitForFunction(() => !!window.__aetherwxQA, { timeout: 20000 });
    console.log('QA hook ready.\n');
  } catch (e) {
    console.error('FATAL: window.__aetherwxQA non disponible après 20s.');
    console.error("Vérifier que ng serve tourne avec le code QA et que ?qa=1 est dans l'URL.");
    await browser.close();
    process.exit(1);
  }

  const layerByKey = Object.fromEntries(manifest.layers.map((l) => [l.key, l]));
  const results = [];

  // Récupérer la liste des sections dans le DOM
  const sectionCount = await page.evaluate(() => document.querySelectorAll('.catalog-section').length);
  console.log(`Found ${sectionCount} catalog sections.`);

  for (let si = 0; si < sectionCount; si++) {
    // Ouvrir la section si elle est fermée
    await page.evaluate((idx) => {
      const heads = document.querySelectorAll('.catalog-section-head');
      const head = heads[idx];
      if (!head) return;
      const section = head.closest('.catalog-section');
      if (section && !section.classList.contains('is-open')) head.click();
    }, si);
    await page.waitForTimeout(300);

    // Lister les toggle-names dans cette section
    const namesInSection = await page.evaluate((idx) => {
      const sections = document.querySelectorAll('.catalog-section');
      const section = sections[idx];
      if (!section) return [];
      const body = section.querySelector('.catalog-section-body');
      if (!body) return [];
      return [...body.querySelectorAll('.toggle-name')].map((el) => el.textContent?.trim() || '');
    }, si);

    console.log(`Section ${si}: ${namesInSection.join(', ').substring(0, 90)}`);

    // Tester chaque layer dont le toggle-name est dans cette section
    for (const [key, uiName] of Object.entries(UI_NAME)) {
      if (!namesInSection.includes(uiName)) continue;
      const layer = layerByKey[key];
      if (!layer) continue;

      if (!layer.hasOpacityControl) {
        results.push({ key, verdict: VERDICT.SKIP, detail: 'hasOpacityControl=false in manifest' });
        continue;
      }
      if (NO_OPACITY_SLIDER_KEYS.has(key)) {
        results.push({ key, verdict: VERDICT.SKIP, detail: 'no .layer-opacity slider in template (known)' });
        continue;
      }
      try {
        const r = await checkOneLayer(page, key, uiName, si, layer);
        results.push({ key, ...r });
      } catch (e) {
        results.push({ key, verdict: VERDICT.FAIL, detail: `ui error: ${e.message}` });
      }
    }

    // Fermer la section
    await page.evaluate((idx) => {
      const heads = document.querySelectorAll('.catalog-section-head');
      const head = heads[idx];
      if (!head) return;
      const section = head.closest('.catalog-section');
      if (section && section.classList.contains('is-open')) head.click();
    }, si);
    await page.waitForTimeout(200);
  }

  // Ajouter les layers du manifest non encore testés
  const testedKeys = new Set(results.map((r) => r.key));
  for (const layer of manifest.layers) {
    if (testedKeys.has(layer.key)) continue;
    results.push({
      key: layer.key,
      verdict: VERDICT.SKIP,
      detail: layer.hasOpacityControl
        ? 'toggle-name introuvable dans le DOM (mapping manquant ou section absente)'
        : 'hasOpacityControl=false in manifest',
    });
  }

  // Affichage du rapport
  const PAD_VERDICT = 8;
  const PAD_KEY = 22;
  console.log('\n' + '─'.repeat(70));
  for (const r of results) {
    console.log(`${r.verdict.padEnd(PAD_VERDICT)} ${r.key.padEnd(PAD_KEY)} ${r.detail}`);
  }
  console.log('─'.repeat(70));

  const passes   = results.filter((r) => r.verdict === VERDICT.PASS);
  const fails    = results.filter((r) => isBlocking(r.verdict));
  const skips    = results.filter((r) => r.verdict === VERDICT.SKIP);
  const upstream = results.filter((r) => r.verdict === VERDICT.UPSTREAM);
  console.log(`PASS=${passes.length}  FAIL=${fails.length}  UPSTREAM=${upstream.length}  SKIP=${skips.length}  TOTAL=${results.length}`);

  if (fails.length > 0) {
    console.log('\nFailing layers:');
    for (const r of fails) console.log(`  FAIL ${r.key}: ${r.detail}`);
  }

  await browser.close();
  if (fails.length) process.exit(1);
}

/** Teste un seul layer dans une section déjà ouverte (sectionIdx).
 *  layerMeta = entrée du manifest pour ce layer (kind, etc.).
 */
async function checkOneLayer(page, key, uiName, sectionIdx, layerMeta) {
  const isVectorBackendDep = layerMeta && VECTOR_BACKEND_DEPENDENT_KINDS.has(layerMeta.kind);

  // 1) Snapshot des layer ids AVANT le toggle → sert à dériver le nouvel id au runtime
  //    (pas de table en dur dupliquant mapLibreLayerIds()).
  const idsBefore = await page.evaluate(() => {
    const qa = window.__aetherwxQA;
    return qa ? [...qa.layerIds()] : [];
  });

  // 2) Cliquer le toggle si pas activé
  const toggled = await page.evaluate(({ sectionIdx, uiName }) => {
    const sections = document.querySelectorAll('.catalog-section');
    const section = sections[sectionIdx];
    if (!section) return 'no-section';
    for (const label of section.querySelectorAll('label.layer-toggle')) {
      const nameEl = label.querySelector('.toggle-name');
      if (nameEl && nameEl.textContent && nameEl.textContent.trim() === uiName) {
        const cb = label.querySelector('input[type="checkbox"]');
        if (!cb) return 'no-checkbox';
        if (cb.disabled) return 'disabled';
        if (!cb.checked) { cb.click(); return 'clicked'; }
        return 'already-on';
      }
    }
    return 'not-found';
  }, { sectionIdx, uiName });

  if (toggled === 'not-found' || toggled === 'no-section') {
    return { verdict: VERDICT.SKIP, detail: `toggle introuvable en section ${sectionIdx} (toggle-name "${uiName}")` };
  }
  if (toggled === 'disabled') {
    return { verdict: VERDICT.SKIP, detail: 'toggle désactivé (layer à venir?)' };
  }

  // 3) Attendre que Angular ajoute le layer à MapLibre
  await page.waitForTimeout(1800);

  // 4) Dériver l'id du layer = le(s) nouvel(s) id(s) apparu(s), avec une opacité lisible.
  const before = await page.evaluate((before) => {
    const qa = window.__aetherwxQA;
    if (!qa) return null;
    const known = new Set(before);
    for (const id of qa.layerIds()) {
      if (known.has(id)) continue;            // pas un nouvel id
      const o = qa.opacityOf(id);
      if (typeof o === 'number') return { id, o };
    }
    return null;
  }, idsBefore);

  if (!before) {
    // Aucun nouveau layer MapLibre avec opacité après toggle ON.
    await toggleOff(page, uiName, sectionIdx);
    if (isVectorBackendDep) {
      return {
        verdict: VERDICT.UPSTREAM,
        detail: 'aucun nouveau layer (données backend requises — ok en local sans NestJS)',
      };
    }
    return { verdict: VERDICT.FAIL, detail: `aucun nouveau layer MapLibre avec opacité après toggle ON (${toggled})` };
  }

  // 5) Tester que bouger le slider d'opacité change bien un layer MapLibre.
  return await testSliderOpacity(page, uiName, sectionIdx, toggled);
}

/** Déplace le slider d'opacité du layer et vérifie qu'AU MOINS un layer MapLibre
 *  change d'opacité. On ne présuppose PAS quel id (robuste au mispick quand des
 *  layers apparaissent de façon asynchrone) : on snapshot toutes les opacités
 *  avant/après et on détecte lequel a bougé. Aucun changement = slider no-op =
 *  opacity non câblée (le bug qu'on traque). */
async function testSliderOpacity(page, uiName, sectionIdx, toggled) {
  const snapshot = () => {
    const qa = window.__aetherwxQA;
    const m = {};
    if (qa) for (const id of qa.layerIds()) { const o = qa.opacityOf(id); if (typeof o === 'number') m[id] = o; }
    return m;
  };
  const opacBefore = await page.evaluate(snapshot);

  // Déplace le slider du layer (scopé à sa .layer-row) vers une valeur franchement
  // différente de sa valeur courante → garantit un delta visible si câblé.
  const sliderSet = await page.evaluate(({ sectionIdx, uiName }) => {
    const sections = document.querySelectorAll('.catalog-section');
    const section = sections[sectionIdx];
    if (!section) return 'no-section';
    for (const label of section.querySelectorAll('label.layer-toggle')) {
      const nameEl = label.querySelector('.toggle-name');
      if (nameEl && nameEl.textContent && nameEl.textContent.trim() === uiName) {
        const row = label.closest('.layer-row');
        if (!row) return 'no-row';
        const slider = row.querySelector('input.layer-opacity:not(.layer-opacity-contour)');
        if (!slider) return 'no-slider';
        const cur = parseFloat(slider.value);
        slider.value = cur < 0.5 ? '0.9' : '0.2';
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        return 'set';
      }
    }
    return 'label-not-found';
  }, { sectionIdx, uiName });

  if (sliderSet !== 'set') {
    await toggleOff(page, uiName, sectionIdx);
    return { verdict: VERDICT.FAIL, detail: `slider opacity introuvable pour "${uiName}" (${sliderSet})` };
  }

  await page.waitForTimeout(500);
  const opacAfter = await page.evaluate(snapshot);
  await toggleOff(page, uiName, sectionIdx);

  const changed = Object.keys(opacAfter).filter((id) => {
    const b = opacBefore[id];
    return typeof b === 'number' && Math.abs(opacAfter[id] - b) >= 0.01;
  });

  if (changed.length === 0) {
    return {
      verdict: VERDICT.FAIL,
      detail: `opacity non câblée : bouger le slider de "${uiName}" ne change l'opacité d'aucun layer MapLibre`,
    };
  }
  const id = changed[0];
  return {
    verdict: VERDICT.PASS,
    detail: `slider câblé → ${id} ${opacBefore[id].toFixed(2)} → ${opacAfter[id].toFixed(2)} (toggle=${toggled})`,
  };
}

async function toggleOff(page, uiName, sectionIdx) {
  await page.evaluate(({ sectionIdx, uiName }) => {
    const sections = document.querySelectorAll('.catalog-section');
    const section = sections[sectionIdx];
    if (!section) return;
    for (const label of section.querySelectorAll('label.layer-toggle')) {
      const nameEl = label.querySelector('.toggle-name');
      if (nameEl && nameEl.textContent && nameEl.textContent.trim() === uiName) {
        const cb = label.querySelector('input[type="checkbox"]');
        if (cb && cb.checked) cb.click();
        return;
      }
    }
  }, { sectionIdx, uiName });
  await page.waitForTimeout(400);
}

run();
