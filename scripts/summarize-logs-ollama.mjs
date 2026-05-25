#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logPath = process.argv[2];
if (!logPath) {
  console.error('Usage: node scripts/summarize-logs-ollama.mjs <log-file>');
  process.exit(1);
}

const ollamaBaseUrl = process.env.OLLAMA_BASE_URL ?? 'http://192.168.1.26:11434';
const ollamaModel = process.env.OLLAMA_MODEL ?? 'qwen2.5:7b';
const outputPath = path.resolve(root, '..', 'tmp', `maritime-log-summary-${Date.now()}.md`);

const raw = await readFile(path.resolve(root, logPath), 'utf8');
const redacted = raw
  .replace(/(api[_-]?key|token|password|secret)=\S+/gi, '$1=[redacted]')
  .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [redacted]')
  .slice(-24000);

const prompt = `Tu analyses des logs AetherWX/Maritime Atlas en mode read-only.
Ne propose aucune commande destructive et ne suppose pas d'acces prod.
Retourne un diagnostic concis en markdown avec:
- symptome principal
- erreurs probables
- services/layers concernes
- prochaines verifications read-only

Logs:
${redacted}`;

const response = await fetch(`${ollamaBaseUrl.replace(/\/$/, '')}/api/generate`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: ollamaModel, stream: false, prompt }),
});

if (!response.ok) {
  throw new Error(`Ollama HTTP ${response.status}`);
}

const payload = await response.json();
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, payload.response ?? '');
console.log(outputPath);
