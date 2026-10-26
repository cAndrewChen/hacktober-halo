// Data fetchers for NOAA SWPC, GFZ Potsdam, Open-Meteo and NASA DONKI.
// Everything is cached in memory so repeated requests during a demo are instant.

import { readFileSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';

const cache = new Map();

export async function fetchJSON(url, { ttl = 10 * 60e3, timeout = 12e3, headers } = {}) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  const data = await res.json();
  cache.set(url, { at: Date.now(), data });
  return data;
}

const HOUR = 3600e3;

/** NOAA OVATION: aurora probability on a 1°×1° grid, ~30–90 min ahead. */
export async function ovation() {
  const raw = await fetchJSON('https://services.swpc.noaa.gov/json/ovation_aurora_latest.json', { ttl: 5 * 60e3 });
  const grid = new Map();
  const points = [];
  for (const [lon, lat, p] of raw.coordinates) {
    if (p <= 0) continue;
    grid.set(`${lon},${lat}`, p);
    if (p >= 5) points.push([lat, lon > 180 ? lon - 360 : lon, p]);
  }
  return { grid, points, observed: raw['Observation Time'], forecast: raw['Forecast Time'] };
}

/** NOAA 3-hourly Kp: observed, estimated and predicted (3 days ahead). */
export async function kpLive() {
  const raw = await fetchJSON('https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json', { ttl: 15 * 60e3 });
  return raw.map((r) => ({ start: Date.parse(r.time_tag + 'Z'), kp: Number(r.kp), kind: r.observed }));
}

/** GFZ Potsdam definitive Kp history (used for replaying past storms). */
export async function kpHistory(startIso, endIso) {
  const raw = await fetchJSON(`https://kp.gfz.de/app/json/?start=${startIso}&end=${endIso}&index=Kp`, { ttl: 24 * HOUR });
  return raw.datetime.map((t, i) => ({ start: Date.parse(t), kp: raw.Kp[i], kind: 'observed' }));
}

export function kpAt(series, ms) {
  let best = null;
  for (const s of series) if (s.start <= ms && ms < s.start + 3 * HOUR) best = s;
  return best ?? series.reduce((a, b) => (Math.abs(b.start - ms) < Math.abs(a.start - ms) ? b : a));
}

// ---- Clouds (Open-Meteo) ----------------------------------------------------------------
// Open-Meteo's free tier counts every location in a multi-location request as one call
// (≈600/min, 5,000/hour, 10,000/day). So cloud data is cached per point, persisted to disk
// (cache/clouds.json) so restarts don't refetch: forecasts for 1 hour, archive data forever.
// When Open-Meteo refuses, stale data is used; failing that, clouds are marked as unknown.

const CLOUD_FILE = new URL('../cache/clouds.json', import.meta.url);
const FORECAST_TTL = HOUR;
const cloudCache = new Map(); // key -> { at, elevation, offset, times: [ms], cover: [%] }
try {
  for (const [k, v] of Object.entries(JSON.parse(readFileSync(CLOUD_FILE, 'utf8')))) cloudCache.set(k, v);
} catch {}
let saveTimer;
function saveClouds() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    // Drop expired forecast entries; keep archive entries forever.
    for (const [k, v] of cloudCache) if (k.startsWith('f:') && Date.now() - v.at > 6 * HOUR) cloudCache.delete(k);
    mkdirSync(new URL('../cache/', import.meta.url), { recursive: true });
    writeFile(CLOUD_FILE, JSON.stringify(Object.fromEntries(cloudCache))).catch(() => {});
  }, 2000);
}

const cloudKey = (p, replay, startDate, endDate) => `${replay ? `a:${startDate}:${endDate}` : 'f'}:${p.lat.toFixed(2)},${p.lon.toFixed(2)}`;
const fromEntry = (e, estimated = false) => ({
  elevation: e.elevation, offset: e.offset, estimated,
  clouds: new Map(e.times.map((t, i) => [t, e.cover[i]])),
});

/**
 * Hourly cloud cover for many points. Returns [{ elevation, offset (sec), clouds: Map(ms -> %), estimated }]
 * in the same order as points. Only points missing from the cache are fetched (in chunks of 50).
 */
export async function clouds(points, { replay = false, startDate, endDate } = {}) {
  const keys = points.map((p) => cloudKey(p, replay, startDate, endDate));
  const fresh = (k) => { const e = cloudCache.get(k); return e && (replay || Date.now() - e.at < FORECAST_TTL); };
  const missing = [...new Set(keys.filter((k) => !fresh(k)))];
  const byKey = new Map(points.map((p, i) => [keys[i], p]));
  let limited = false;
  for (let i = 0; i < missing.length && !limited; i += 50) {
    const batch = missing.slice(i, i + 50).map((k) => byKey.get(k));
    const lat = batch.map((p) => p.lat.toFixed(2)).join(','), lon = batch.map((p) => p.lon.toFixed(2)).join(',');
    const url = replay
      ? `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&hourly=cloud_cover&timezone=auto&start_date=${startDate}&end_date=${endDate}`
      : `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=cloud_cover&timezone=auto&forecast_days=2`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20e3) });
      if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}: ${(await res.text()).slice(0, 120)}`);
      let raw = await res.json();
      if (!Array.isArray(raw)) raw = [raw];
      raw.forEach((r, j) => cloudCache.set(cloudKey(batch[j], replay, startDate, endDate), {
        at: Date.now(), elevation: r.elevation, offset: r.utc_offset_seconds,
        times: r.hourly.time.map((t) => Date.parse(t + 'Z') - r.utc_offset_seconds * 1000), cover: r.hourly.cloud_cover,
      }));
      saveClouds();
    } catch (err) {
      console.warn(`clouds: ${err.message}`);
      limited = true; // stop hammering; fall back below
    }
  }
  return points.map((p, i) => {
    const e = cloudCache.get(keys[i]);
    if (e) return fromEntry(e, !fresh(keys[i]));
    // Nothing cached: unknown clouds (scorer assumes 50%), land assumed, time zone from longitude.
    return { elevation: 1, offset: Math.round(p.lon / 15) * 3600, clouds: new Map(), estimated: true };
  });
}

// ---- Satellite clouds (NASA GIBS) -------------------------------------------------------
// Global equirectangular PNGs from NASA's Global Imagery Browse Services (WMS, EPSG:4326).
//   ir:    GOES-East + GOES-West + Himawari "clean infrared" (Band 13), every 10 min, day and night.
//          GIBS keeps ~90 days and has no Meteosat, so Europe/Africa/Middle East (~0–65°E) is empty.
//   modis: Terra + Aqua MODIS nighttime cloud fraction (daily, archived for years): fills the IR gap
//          live, and is the only source for replays.
// Live images are cached 10 min; dated images (replays) are cached on disk forever.

const GIBS = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.1.1&SRS=EPSG:4326&BBOX=-180,-90,180,90&WIDTH=2048&HEIGHT=1024&FORMAT=image/png&TRANSPARENT=true';
const SAT_LAYERS = {
  ir: 'GOES-West_ABI_Band13_Clean_Infrared,GOES-East_ABI_Band13_Clean_Infrared,Himawari_AHI_Band13_Clean_Infrared',
  modis: 'MODIS_Terra_Cloud_Fraction_Night,MODIS_Aqua_Cloud_Fraction_Night',
};
const satCache = new Map();

/** kind: 'ir' | 'modis'; time: ISO date/time or '' for the latest. Returns a PNG Buffer. */
export async function satellite(kind, time = '') {
  if (!SAT_LAYERS[kind] || (time && !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}Z)?$/.test(time))) throw Object.assign(new Error('bad satellite request'), { status: 400 });
  const key = `${kind}-${time || 'latest'}`;
  const file = new URL(`../cache/sat-${key.replace(/:/g, '')}.png`, import.meta.url);
  const hit = satCache.get(key);
  if (hit && (time || Date.now() - hit.at < 10 * 60e3)) return hit.data;
  if (time) {
    try { const data = readFileSync(file); satCache.set(key, { at: Date.now(), data }); return data; } catch {}
  }
  const res = await fetch(`${GIBS}&LAYERS=${SAT_LAYERS[kind]}${time ? `&TIME=${time}` : ''}`, { signal: AbortSignal.timeout(60e3) });
  if (!res.ok || !(res.headers.get('content-type') ?? '').includes('png')) throw new Error(`NASA GIBS ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());
  satCache.set(key, { at: Date.now(), data });
  if (time) { mkdirSync(new URL('../cache/', import.meta.url), { recursive: true }); writeFile(file, data).catch(() => {}); }
  return data;
}

/** Open-Meteo place search for the location box. */
export async function geocode(q) {
  const raw = await fetchJSON(`https://geocoding-api.open-meteo.com/v1/search?count=5&name=${encodeURIComponent(q)}`, { ttl: 24 * HOUR });
  return (raw.results ?? []).map((r) => ({ name: [r.name, r.admin1, r.country].filter(Boolean).join(', '), lat: r.latitude, lon: r.longitude }));
}

// ---- Why tonight: solar events --------------------------------------------------------

const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const shortDate = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const flareRank = (c = '') => ({ X: 4, M: 3, C: 2, B: 1 }[c[0]] ?? 0) * 100 + parseFloat(c.slice(1) || 0);

// Fallback when DONKI is unreachable during a replay of the May 2024 storm (NOAA SWPC event reports).
const MAY_2024 = [
  'Sunspot region AR 13664 fired a string of X-class flares on May 8–11, 2024, including an X5.8 on May 11',
  'Several CMEs (solar storm clouds) launched toward Earth',
  'They hit Earth on May 10, reaching G5 (extreme) storm level for the first time since 2003',
];

async function donki(kind, startMs, endMs) {
  const key = process.env.NASA_API_KEY || 'DEMO_KEY';
  return fetchJSON(`https://api.nasa.gov/DONKI/${kind}?startDate=${day(startMs)}&endDate=${day(endMs)}&api_key=${key}`, { ttl: HOUR, timeout: 7e3 });
}

export async function backstory(nowMs, { replay = false } = {}) {
  const start = nowMs - 4 * 86400e3;
  try {
    const [flr, cme, gst] = await Promise.all([donki('FLR', start, nowMs), donki('CME', start, nowMs), donki('GST', start, nowMs)]);
    const items = [];
    const flares = (flr ?? []).filter((f) => /^[MX]/.test(f.classType)).sort((a, b) => flareRank(b.classType) - flareRank(a.classType));
    if (flares.length) {
      const top = flares[0];
      items.push(`${flares.length} strong (M/X-class) flare${flares.length > 1 ? 's' : ''} in the last 4 days; biggest: ${top.classType} on ${shortDate(top.peakTime)}${top.activeRegionNum ? ` from sunspot AR ${top.activeRegionNum}` : ''}`);
    }
    const earthCmes = (cme ?? []).filter((c) => (c.cmeAnalyses ?? []).some((a) => (a.enlilList ?? []).some((e) => e.isEarthGB || e.estimatedShockArrivalTime)));
    if (earthCmes.length) items.push(`${earthCmes.length} CME${earthCmes.length > 1 ? 's' : ''} (solar storm clouds) modeled to reach Earth`);
    for (const g of gst ?? []) {
      const maxKp = Math.max(...(g.allKpIndex ?? []).map((k) => k.kpIndex));
      if (maxKp > 0) items.push(`Geomagnetic storm starting ${shortDate(g.startTime)}, Kp up to ${maxKp}`);
    }
    if (!items.length) items.push('No strong flares or Earth-bound CMEs in the last 4 days — the Sun is quiet');
    return { source: 'NASA DONKI', items };
  } catch {
    if (replay) return { source: 'NOAA SWPC event reports (cached; NASA DONKI unreachable)', items: MAY_2024 };
    try {
      const raw = await fetchJSON('https://services.swpc.noaa.gov/json/goes/primary/xray-flares-7-day.json', { ttl: 15 * 60e3 });
      const flares = raw.filter((f) => /^[MX]/.test(f.max_class ?? '')).sort((a, b) => flareRank(b.max_class) - flareRank(a.max_class));
      const items = flares.length
        ? [`${flares.length} strong (M/X-class) flare${flares.length > 1 ? 's' : ''} in the last 7 days; biggest: ${flares[0].max_class} on ${shortDate(flares[0].max_time)}`]
        : ['No M- or X-class flares in the last 7 days — the Sun is quiet'];
      return { source: 'NOAA GOES X-ray flares (NASA DONKI unreachable)', items };
    } catch {
      return { source: 'unavailable', items: [] };
    }
  }
}
