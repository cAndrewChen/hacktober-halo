// Renders the sky library once with Grok Imagine: public/sky/<key>.jpg for every scene in libraryScenes().
// Resumable: existing images are skipped. Run: npm run sky-library [key-substring ...]
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { generate, libraryKey, libraryScenes, LIBRARY_DEVICE, prompt } from '../lib/grok.js';

// Self-check: the runtime lookup must find each image from the forecast it was rendered for.
for (const s of libraryScenes()) assert.equal(libraryKey(s.f, s.view).key, s.key);
if (process.argv[2] === '--check') { console.log(`${libraryScenes().length} scenes, lookup ok`); process.exit(0); }

if (!process.env.XAI_API_KEY) throw new Error('XAI_API_KEY not set');
const dir = new URL('../public/sky/', import.meta.url);
mkdirSync(dir, { recursive: true });
const only = process.argv.slice(2);
const todo = libraryScenes().filter((s) => (!only.length || only.some((o) => s.key.includes(o))) && !existsSync(new URL(`${s.key}.jpg`, dir)));
console.log(`${todo.length} to render`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let next = 0, done = 0;
const failed = [];
async function worker() {
  while (next < todo.length) {
    const s = todo[next++];
    for (let attempt = 1; ; attempt++) {
      try {
        const url = await generate(prompt(s.f, s.view, LIBRARY_DEVICE));
        if (!url?.startsWith('data:image/')) throw new Error('no image bytes returned');
        writeFileSync(new URL(`${s.key}.jpg`, dir), Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
        console.log(`[${++done}/${todo.length}] ${s.key}`);
        break;
      } catch (err) {
        console.warn(`${s.key} attempt ${attempt}: ${err.message}`);
        if (attempt === 4) { failed.push(s.key); break; }
        await sleep(attempt * 15e3);
      }
    }
  }
}
await Promise.all([1, 2, 3].map(worker));
console.log(failed.length ? `failed: ${failed.join(' ')}` : 'all done');
