// Halo server: static frontend + JSON API. Zero dependencies (Node 20.6+ for --env-file).

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildForecast } from './lib/forecast.js';
import { plan, cameraAdvice, gemmaStatus } from './lib/gemma.js';
import { sky } from './lib/grok.js';
import { deviceFrom, deviceList } from './lib/devices.js';
import { geocode, satellite } from './lib/sources.js';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = fileURLToPath(new URL('./public/', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

// Forecasts are cached briefly so /api/plan and /api/sky reuse the numbers /api/forecast showed.
const forecasts = new Map();
async function forecastFor(q) {
  const lat = Number(q.get('lat')), lon = Number(q.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw Object.assign(new Error('lat/lon required'), { status: 400 });
  const mode = q.get('mode') === 'replay' ? 'replay' : 'live';
  const key = `${lat.toFixed(3)},${lon.toFixed(3)},${mode}`;
  const hit = forecasts.get(key);
  if (hit && Date.now() - hit.at < 5 * 60e3) return hit.data;
  const data = buildForecast({ lat, lon, mode });
  forecasts.set(key, { at: Date.now(), data });
  data.catch(() => forecasts.delete(key));
  return data;
}

// Plans and sky images cost API quota, so cache them per forecast (same key and lifetime).
const derived = new Map();
function cached(kind, q, make, extraKey = '') {
  const key = `${kind}:${Number(q.get('lat')).toFixed(3)},${Number(q.get('lon')).toFixed(3)},${q.get('mode')}|${extraKey}`;
  const hit = derived.get(key);
  if (hit && Date.now() - hit.at < 5 * 60e3) return hit.data;
  const data = forecastFor(q).then(make);
  derived.set(key, { at: Date.now(), data });
  // Don't keep fallbacks: the next request should try the real API again.
  data.then((r) => (r.source === 'template' || r.source === 'none') && derived.delete(key), () => derived.delete(key));
  return data;
}

const send = (res, status, body) => {
  if (Buffer.isBuffer(body)) {
    res.writeHead(status, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=600' });
    return res.end(body);
  }
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const gemmaBackend = (q) => (q.get('backend') === 'api' ? 'api' : 'local');

const routes = {
  '/api/forecast': async (q) => forecastFor(q),
  '/api/plan': async (q) => {
    const backend = gemmaBackend(q);
    return cached('plan', q, (f) => plan(f, backend), backend);
  },
  '/api/camera': async (q) => {
    const device = deviceFrom(q);
    const backend = gemmaBackend(q);
    return cached('camera', q, (f) => cameraAdvice(f, device, backend), `${device.key}|${backend}`);
  },
  // view=eye is device-independent; view=camera depends on the user's device and tripod.
  '/api/sky': async (q) => {
    const view = q.get('view') === 'camera' ? 'camera' : 'eye';
    const scene = q.get('scene') === 'spot' ? 'spot' : 'home';
    const device = deviceFrom(q);
    return cached(`sky-${scene}-${view}`, q, (f) => sky(f, view, device, scene), view === 'camera' ? device.key : '');
  },
  '/api/devices': async () => deviceList(),
  // NASA GIBS satellite cloud image (PNG): ?kind=ir|modis&time=YYYY-MM-DD (omit time for latest)
  '/api/satellite': async (q) => satellite(q.get('kind') ?? '', q.get('time') ?? ''),
  '/api/geocode': async (q) => geocode(q.get('q') ?? ''),
  '/api/status': async () => {
    const g = await gemmaStatus();
    return { gemma: g.gemma, grok: !!process.env.XAI_API_KEY, gemma_local: g.local, gemma_api: g.api, gemma_model: g.model };
  },
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const route = routes[url.pathname];
  if (route) {
    const t = Date.now();
    try {
      send(res, 200, await route(url.searchParams));
    } catch (err) {
      console.error(url.pathname, err);
      send(res, err.status ?? 502, { error: err.message });
    }
    console.log(`${url.pathname}${url.search} ${Date.now() - t}ms`);
    return;
  }
  const path = normalize(join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!path.startsWith(normalize(PUBLIC))) return send(res, 403, { error: 'forbidden' });
  try {
    const body = await readFile(path);
    // no-cache: browsers revalidate, so edits show up on a normal reload.
    res.writeHead(200, { 'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    send(res, 404, { error: 'not found' });
  }
});
const gemma = await gemmaStatus();
server.listen(PORT, () => {
  console.log(`Halo running at http://localhost:${PORT}`);
  console.log(`  Gemma: ${gemma.label}   Grok Imagine: ${process.env.XAI_API_KEY ? 'on' : 'off (set XAI_API_KEY — canvas fallback in use)'}`);
});
