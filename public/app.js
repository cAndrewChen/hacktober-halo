import { paintPanorama, paintImage, paintOverlay } from './panorama.js';
import { Dome } from './dome.js';
import { Globe } from './globe.js';
import { icon, hydrateIcons } from './icons.js';

hydrateIcons();

const $ = (id) => document.getElementById(id);
const BAND_COLORS = ['var(--b0)', 'var(--b1)', 'var(--b2)', 'var(--b3)', 'var(--b4)'];

const state = {
  lat: 32.8801, lon: -117.234, name: 'UC San Diego, California', mode: 'live',
  view: 'eye', scene: 'home', mapTab: 'globe', forecast: null, req: 0,
  device: loadDevice(), devices: [],
  gemma: localStorage.getItem('halo.gemma') === 'api' ? 'api' : 'local',
  grok: { eye: null, camera: null }, // loaded Image objects for the current forecast
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const qs = () => `lat=${state.lat}&lon=${state.lon}&mode=${state.mode}`;
const gemmaQs = () => `backend=${state.gemma}`;
const deviceQs = () => `device=${state.device.id}&tripod=${state.device.tripod ? 1 : 0}&model=${encodeURIComponent(state.device.model)}`;

async function api(path) {
  const res = await fetch(path);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

// ---------- Device setting (remembered in this browser) ----------

function loadDevice() {
  try {
    const d = JSON.parse(localStorage.getItem('halo.device'));
    if (d?.id) return { id: d.id, model: d.model ?? '', tripod: !!d.tripod };
  } catch {}
  return { id: 'iphone', model: '', tripod: false };
}
function saveDevice() {
  try { localStorage.setItem('halo.device', JSON.stringify(state.device)); } catch {}
}
const deviceInfo = () => state.devices.find((d) => d.id === state.device.id);
const deviceGain = () => deviceInfo()?.gain[state.device.tripod ? 'tripod' : 'handheld'] ?? 0.7;
const deviceName = () => state.device.model || deviceInfo()?.label.replace(/ \(.*\)$/, '') || 'your camera';

function renderDeviceLabel() {
  $('device-label').textContent = deviceName();
  $('view-camera').textContent = state.device.model ? state.device.model : 'Your camera';
}

// ---------- Load ----------

async function load() {
  const req = ++state.req;
  $('error').hidden = true;
  $('place').textContent = `${state.name} · ${state.lat.toFixed(2)}, ${state.lon.toFixed(2)}${state.mode === 'replay' ? ' · Replaying the night of May 10, 2024' : ''}`;
  resetPlan();
  resetCamera();
  $('band').textContent = 'Reading the sky…';
  try {
    const f = await api(`/api/forecast?${qs()}`);
    if (req !== state.req) return;
    state.forecast = f;
    state.grok = {};
    state.scene = 'home';
    renderScore(f);
    renderSceneToggle(f);
    renderSky(true);
    renderTimeline(f);
    renderMaps(f);
    renderBackstory(f);
    const backend = state.gemma;
    api(`/api/plan?${qs()}&${gemmaQs()}`).then((p) => req === state.req && state.gemma === backend && renderPlan(p)).catch((e) => req === state.req && state.gemma === backend && planError(e));
    ensureSkyImage(req);
    loadDeviceViews(req);
  } catch (e) {
    $('error').textContent = `Couldn't load the forecast: ${e.message}`;
    $('error').hidden = false;
  }
}

/** Everything that depends on the user's camera: settings card and the camera sky view. */
function loadDeviceViews(req = state.req) {
  resetCamera();
  // Camera panoramas depend on the device: drop them for every scene.
  for (const k of Object.keys(state.grok)) if (k.endsWith(':camera')) delete state.grok[k];
  if (state.view === 'camera') renderSky();
  const backend = state.gemma;
  api(`/api/camera?${qs()}&${deviceQs()}&${gemmaQs()}`).then((c) => req === state.req && state.gemma === backend && renderCamera(c)).catch((e) => req === state.req && state.gemma === backend && cameraError(e));
  ensureSkyImage(req);
}

const skyKey = () => `${state.scene}:${state.view}`;

/** Fetch the Grok panorama for the current scene + view, once (each costs an image). */
function ensureSkyImage(req = state.req) {
  const key = skyKey(), [scene, view] = key.split(':');
  if (state.grok[key]) { $('dome-loading').hidden = true; return; }
  state.grok[key] = { pending: true };
  $('dome-loading').hidden = false;
  api(`/api/sky?${qs()}&scene=${scene}&view=${view}${view === 'camera' ? `&${deviceQs()}` : ''}`)
    .then((s) => {
      if (req !== state.req) return;
      if (!s.image) { state.grok[key] = { failed: s.reason }; if (skyKey() === key) renderSky(); return; }
      const img = new Image();
      img.onload = () => { if (req === state.req) { state.grok[key] = { img }; if (skyKey() === key) renderSky(); } };
      img.src = s.image;
    })
    .catch(() => { delete state.grok[key]; })
    .finally(() => { if (skyKey() === key) $('dome-loading').hidden = true; });
}

/** The forecast as seen from the current scene: 'home' (matches the big score) or the best spot. */
const sceneForecast = () => ({ ...state.forecast, ...state.forecast.scenes[state.scene] });

function renderSceneToggle(f) {
  const spot = f.scenes.spot;
  $('scene-toggle').hidden = !spot;
  if (!spot) return;
  $('scene-home').textContent = `From here · ${f.home_score}/50`;
  $('scene-spot').textContent = `From best spot · ${f.best_spot.score}/50`;
  document.querySelectorAll('[data-scene]').forEach((x) => x.setAttribute('aria-selected', x.dataset.scene === state.scene));
}

// ---------- Score ----------

function renderScore(f) {
  const bandIdx = f.bands.findIndex((b) => b.name === f.band);
  const homeBand = f.bands.find((b) => f.home_score >= b.min && f.home_score <= b.max);
  // The big number is for your location; the drive suggestion is shown below it.
  $('score').textContent = f.home_score;
  $('band').textContent = homeBand.name;
  $('band-meaning').textContent = f.no_night ? 'The sun never sets far enough tonight for a dark sky, so the night stays in twilight.' : homeBand.meaning;
  const homeIdx = f.bands.indexOf(homeBand);
  $('verdict').textContent = homeBand.verdict;
  $('verdict').className = `pill ${homeBand.verdict}`;

  const segs = f.bands.map((b, i) => `<div class="seg-band ${i === homeIdx ? 'on' : ''}" style="background:${BAND_COLORS[i]};color:${BAND_COLORS[i]}"></div>`).join('');
  const labs = f.bands.map((b) => `<div class="lab"><b>${b.min}–${b.max}</b>${b.name}</div>`).join('');
  $('scale').innerHTML = `${segs}${labs}<div class="marker" style="left:${(Math.min(f.home_score, 50) / 51) * 100}%"></div>`;

  const s = f.best_spot;
  $('compare').innerHTML = s?.worth_driving
    ? `${icon('route')}<span><strong>Better nearby:</strong> ${s.score}/50 (<em>${esc(f.bands[bandIdx].name)}</em>) about ${s.distance_mi} mi ${esc(s.direction)}. See the map.</span>`
    : '';
}

// ---------- Sky dome ----------

let dome;
function renderSky(resetView = false) {
  const f = state.forecast;
  if (!f || !window.THREE) return;
  dome ??= new Dome($('dome'), ({ heading, el }) => { $('dome-heading').textContent = `Facing ${heading} · ${Math.round(el)}° ${el >= 0 ? 'up' : 'down'}`; });
  const view = state.view;
  const grok = state.grok[skyKey()];
  const s = sceneForecast();
  const canvas = document.createElement('canvas');
  if (grok?.img) paintImage(canvas, grok.img);
  else paintPanorama(canvas, s, view, deviceGain());
  paintOverlay(canvas, s);
  dome.setPanorama(canvas, s.look.bearing_deg);
  if (resetView) faceAurora();
  captionSky(s, view, grok);
}

function captionSky(f, view, grok) {
  const from = state.scene === 'spot' ? `From the best spot (${state.forecast.best_spot.distance_mi} mi ${state.forecast.best_spot.direction}), ` : 'From here, ';
  const where = f.look.overhead ? 'overhead' : `up to ${f.look.top_elevation_deg}° above the ${f.look.direction} horizon`;
  const who = view === 'eye' ? 'your eyes' : `${deviceName()}${state.device.tripod ? ' on a tripod' : ' handheld'}`;
  const src = grok?.img ? 'Grok Imagine 360° panorama' : `Halo's own 360° render${grok?.failed ? ' (Grok Imagine unavailable)' : ''}`;
  const when = `${from}${f.view.label} (${f.view.why}): sun ${Math.abs(f.view.sun_alt)}° ${f.view.sun_alt >= 0 ? 'above' : 'below'} the horizon (${f.view.phase}), ${f.view.cloud_pct}% cloud.`;
  $('sky-caption').textContent = f.expect.level === 'none'
    ? `${when} No aurora visible${f.expect.reason ? `: ${f.expect.reason}` : ''}. ${src}.`
    : `${when} What ${who} will see: aurora ${where}, ${f.expect.colors.join('/')} tones. ${src}.`;
}

function faceAurora() {
  if (!state.forecast || !dome) return;
  const f = sceneForecast();
  dome.fov = 75;
  dome.look(f.look.bearing_deg, f.look.overhead ? 35 : Math.max(8, Math.min(25, f.look.top_elevation_deg * 0.5)));
}

// ---------- Plan (Gemma: halo-guide) ----------

function resetPlan() {
  $('plan-source').textContent = state.gemma === 'api' ? 'API key · thinking…' : 'Local · thinking…';
  $('plan-source').className = 'badge';
  $('plan-headline').className = 'plan-headline shimmer';
  $('plan-headline').innerHTML = '&nbsp;';
  for (const id of ['plan-summary', 'why']) $(id).textContent = '';
  for (const id of ['plan-when', 'plan-where', 'plan-look', 'plan-expect']) $(id).textContent = '…';
  $('plan-checklist').innerHTML = '';
}

const sourceBadge = (el, source, backend) => {
  if (source === 'template') {
    el.textContent = backend === 'api' ? 'API key · template' : 'Local · template';
    el.className = 'badge';
    return;
  }
  el.textContent = backend === 'api' ? 'API key · Gemma' : `Local · ${source}`;
  el.className = 'badge gemma';
};

function renderPlan({ plan: p, source, backend }) {
  sourceBadge($('plan-source'), source, backend);
  $('plan-headline').className = 'plan-headline';
  $('plan-headline').textContent = p.headline;
  $('plan-summary').textContent = p.summary;
  $('plan-when').textContent = p.when;
  $('plan-where').textContent = p.where;
  $('plan-look').innerHTML = `<strong>${esc(p.look.direction)}</strong><br><span class="muted">${esc(p.look.height)}</span>`;
  $('plan-expect').innerHTML = `<span class="line">${icon('eye')}<span>${esc(p.expect.naked_eye)}</span></span><span class="line muted">${icon('camera')}<span>${esc(p.expect.camera)}</span></span>`;
  $('plan-checklist').innerHTML = p.checklist.map((c) => `<li>${esc(c)}</li>`).join('');
  $('why').textContent = p.why_tonight;
}

function planError(e) {
  $('plan-source').textContent = 'Plan unavailable';
  $('plan-headline').className = 'plan-headline';
  $('plan-headline').textContent = `Couldn't write a plan: ${e.message}`;
}

// ---------- Camera (Gemma: halo-camera) ----------

function resetCamera() {
  $('cam-device').textContent = deviceName();
  $('cam-source').textContent = state.gemma === 'api' ? 'API key · thinking…' : 'Local · thinking…';
  $('cam-source').className = 'badge';
  $('cam-mode').className = 'cam-mode shimmer';
  $('cam-mode').innerHTML = '&nbsp;';
  for (const id of ['cam-settings', 'cam-steps']) $(id).innerHTML = '';
  for (const id of ['cam-cannot', 'cam-expect', 'cam-tip']) $(id).textContent = '';
}

function renderCamera({ camera: c, source, backend }) {
  sourceBadge($('cam-source'), source, backend);
  $('cam-device').textContent = c.device;
  $('cam-mode').className = 'cam-mode';
  $('cam-mode').textContent = `Use ${c.mode}`;
  $('cam-settings').innerHTML = c.settings.map((s) => `<tr><td>${esc(s.name)}</td><td>${esc(s.value)}</td>
    <td class="lock ${s.adjustable ? 'on' : ''}">${s.adjustable ? 'you set this' : `${icon('lock')} automatic`}</td></tr>`).join('');
  $('cam-steps').innerHTML = c.steps.map((s) => `<li>${esc(s)}</li>`).join('');
  $('cam-cannot').textContent = c.cannot_change.length ? `Can't change on this device: ${c.cannot_change.join(', ')}.` : '';
  $('cam-expect').innerHTML = `${icon('camera')}<span>${esc(c.expect)}</span>`;
  $('cam-tip').textContent = `Tip: ${c.tip}`;
}

function cameraError(e) {
  $('cam-source').textContent = 'Unavailable';
  $('cam-mode').className = 'cam-mode';
  $('cam-mode').textContent = `Couldn't load camera settings: ${e.message}`;
}

// ---------- Timeline ----------

function renderTimeline(f) {
  const w = f.home_window;
  if (!f.timeline.length) {
    $('timeline').innerHTML = '<p class="muted">No dark hours tonight at this location.</p>';
    $('timeline-note').textContent = '';
    return;
  }
  $('timeline').innerHTML = f.timeline.map((h) => {
    const i = f.bands.findIndex((b) => h.score >= b.min && h.score <= b.max);
    const inWin = w && h.ms >= w.startMs && h.ms < w.endMs;
    const title = `${h.label}: ${h.score}/50 · Kp ${h.kp.toFixed(1)}${h.kp_kind === 'predicted' ? ' (forecast)' : ''} · clouds ${h.cloud}% · dark ${Math.round(h.parts.dark * 100)}%`;
    return `<div class="bar ${inWin ? 'in-window' : ''}" title="${esc(title)}">
      <div class="fill" style="height:${Math.max(2, (h.score / 50) * 100)}%;background:${BAND_COLORS[i]}"><span>${h.score || ''}</span></div>
      <div class="t">${h.label.replace(' ', '')}</div></div>`;
  }).join('');
  const clouds = Math.round(f.timeline.reduce((s, h) => s + h.cloud, 0) / f.timeline.length);
  $('timeline-note').textContent = `Max Kp tonight ${f.kp_max_tonight?.toFixed(1)} (storm strength, 0–9) · ${f.clouds_estimated ? 'cloud forecast temporarily unavailable (weather service rate limit), assuming 50%' : `average cloud ${clouds}%`}. ${w ? `Best here: ${w.start}–${w.end}.` : 'No good window here tonight.'} Hover a bar for details.`;
}

// ---------- Maps: globe heatmap + nearby score heatmap ----------

let globe, map, layer;

function renderMaps(f) {
  const s = f.best_spot;
  const dir = $('directions');
  if (s?.worth_driving) {
    dir.href = `https://www.google.com/maps/dir/?api=1&origin=${f.location.lat},${f.location.lon}&destination=${s.lat},${s.lon}`;
    dir.hidden = false;
  } else dir.hidden = true;
  showMapTab(state.mapTab);
}

function showMapTab(tab) {
  state.mapTab = tab;
  document.querySelectorAll('[data-map]').forEach((x) => x.setAttribute('aria-selected', x.dataset.map === tab));
  $('globe').hidden = tab !== 'globe';
  $('map').hidden = tab !== 'nearby';
  const f = state.forecast;
  if (!f) return;
  if (tab === 'globe') renderGlobe(f); else renderNearby(f);
}

function renderGlobe(f) {
  if (!window.THREE) return;
  globe ??= new Globe($('globe'), pickLocation);
  globe.resize();
  globe.setHeat(f.heat.points, f.ovation ? 1 : 1.5);
  globe.setViewLine(f.heat.view_line);
  globe.setMarkers(f.location, f.best_spot?.worth_driving ? f.best_spot : null);
  globe.focus(f.location.lat, f.location.lon);
  loadSatelliteClouds(f);
  $('map-legend').innerHTML = `<div class="row"><span>Aurora overhead</span><span>low → high</span></div><div class="bar"></div>
    <div><span class="swatch-line"></span> view line (Kp ${f.heat.view_line.kp.toFixed(1)}): farthest from the oval aurora may be seen, low on the horizon.
    ${esc(f.heat.source)}. <span class="dot" style="background:#fff"></span> you${f.best_spot?.worth_driving ? ' · <span class="dot" style="background:var(--accent)"></span> best spot' : ''}. City lights = light pollution. Drag to spin, scroll to zoom, click to check a spot.</div>
    <div id="cloud-info"></div>`;
  updateCloudLegend();
  $('map-note').textContent = f.ovation
    ? 'The ring is NOAA\'s live aurora oval: where aurora is overhead. You can see it from farther away, low on the horizon, down to about the red view line.'
    : 'Replay: NOAA doesn\'t archive its live oval, so the ring is modeled from the storm\'s real Kp, calibrated to NOAA\'s forecast map from that night. The red line is the view line.';
}

// ----- Satellite clouds on the globe (NASA GIBS via /api/satellite) -----

let cloudsFor = null, cloudInfo = '';
const loadImage = (src) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; });

/**
 * Live: geostationary infrared (latest, every 10 min) + last night's MODIS to fill the Europe/Africa gap.
 * Replay: MODIS nighttime cloud fraction for May 11, 2024 (UTC), the night of the storm over the Americas.
 */
async function loadSatelliteClouds(f) {
  if (!cloudsOn || !f || !globe) return; // renderGlobe calls this again once the globe exists
  const key = `${f.mode}:${f.ovation?.observed ?? ''}`;
  if (cloudsFor === key) return;
  cloudsFor = key;
  cloudInfo = 'Loading satellite clouds…';
  updateCloudLegend();
  const yesterday = new Date(Date.now() - 86400e3).toISOString().slice(0, 10);
  const [ir, modis] = await Promise.all([
    f.mode === 'live' ? loadImage('/api/satellite?kind=ir') : null,
    loadImage(`/api/satellite?kind=modis&time=${f.mode === 'live' ? yesterday : '2024-05-11'}`),
  ]);
  if (cloudsFor !== key) return;
  if (!ir && !modis) { cloudInfo = 'Satellite clouds unavailable right now.'; updateCloudLegend(); return; }
  globe.setClouds({ ir, modis });
  globe.showClouds(cloudsOn);
  cloudInfo = f.mode === 'live'
    ? `Clouds: NASA GIBS, GOES-East/West + Himawari infrared (latest, 10-min)${modis ? `; Europe/Africa from MODIS (night of ${yesterday})` : ''}.`
    : 'Clouds: NASA MODIS (Terra + Aqua) nighttime cloud fraction, May 11, 2024 UTC.';
  updateCloudLegend();
}

let cloudsOn = false; // off by default; images are only fetched once turned on
function updateCloudLegend() {
  const el = document.getElementById('cloud-info');
  if (el) el.textContent = cloudsOn ? cloudInfo : '';
}

/** Halo Score color from the band ramp (CSS vars --b0..--b4). */
function scoreColor(score) {
  const css = getComputedStyle(document.documentElement);
  const ramp = [0, 1, 2, 3, 4].map((i) => css.getPropertyValue(`--b${i}`).trim().match(/\w\w/g).map((h) => parseInt(h, 16)));
  const v = (Math.min(50, score) / 50) * 4, i0 = Math.min(3, Math.floor(v)), t = v - i0;
  return ramp[i0].map((c, k) => Math.round(c + (ramp[i0 + 1][k] - c) * t));
}

function pickLocation(lat, lon) {
  Object.assign(state, { lat: +lat.toFixed(4), lon: +(((lon + 540) % 360) - 180).toFixed(4), name: 'Picked on the map' });
  map?.closePopup();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  load();
}

function renderNearby(f) {
  if (!window.L) return;
  if (!map) {
    map = L.map('map', { preferCanvas: true, minZoom: 2, worldCopyJump: true });
    // Standard OSM tiles, darkened with a CSS filter (see .map .leaflet-tile-pane).
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>', maxZoom: 18,
    }).addTo(map);
    map.on('click', (e) => {
      const div = L.DomUtil.create('div', 'pick');
      div.innerHTML = `<b>${e.latlng.lat.toFixed(3)}, ${e.latlng.lng.toFixed(3)}</b><br>`;
      const btn = L.DomUtil.create('button', 'btn small', div);
      btn.type = 'button';
      btn.textContent = 'Check the aurora here';
      L.DomEvent.on(btn, 'click', () => pickLocation(e.latlng.lat, e.latlng.lng));
      L.popup().setLatLng(e.latlng).setContent(div).openOn(map);
    });
  }
  map.invalidateSize();
  layer?.remove();
  layer = L.layerGroup().addTo(map);
  map.fitBounds(L.latLngBounds(f.spots.map((p) => [p.lat, p.lon]).concat([[f.location.lat, f.location.lon]])).pad(0.08));

  for (const s of f.spots) {
    L.circleMarker([s.lat, s.lon], { radius: 7, color: '#0b1220', weight: 1, fillColor: `rgb(${scoreColor(s.score)})`, fillOpacity: 0.9 })
      .bindPopup(`<b>${s.score}/50</b> at ${esc(s.bestTime ?? '–')}<br>${s.distance_mi} mi ${esc(s.direction)}`)
      .addTo(layer);
  }
  L.circleMarker([f.location.lat, f.location.lon], { radius: 9, color: '#fff', weight: 2, fillColor: '#fff', fillOpacity: 1 })
    .bindPopup(`<b>You</b> · ${f.home_score}/50`).addTo(layer);
  const s = f.best_spot;
  if (s?.worth_driving) {
    L.marker([s.lat, s.lon], { icon: L.divIcon({ className: '', html: `<div class="best-marker" style="font-size:24px;line-height:0">${icon('starFilled')}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] }) })
      .bindPopup(`<b>Best spot: ${s.score}/50</b><br>${s.distance_mi} mi ${esc(s.direction)}`).addTo(layer);
  }
  $('map-legend').innerHTML = `<div class="row"><span>Halo Score</span><span>0 → 50</span></div><div class="bar score"></div><div>Dots = best score tonight at spots within 125 mi. <span class="dot" style="background:#fff"></span> you${s?.worth_driving ? ` · <span class="best-marker">${icon('starFilled')}</span> best spot` : ''}. Click a dot for details, or anywhere to check that spot.</div>`;
  $('map-note').textContent = s?.worth_driving
    ? `Starred: the best spot within 125 mi, ${s.score}/50 vs. ${f.home_score}/50 at home. Distances are straight-line, not road miles. Halo checks clouds, darkness and aurora reach, not light pollution, so pick a dark spot nearby.`
    : `${s && s.score > 0 ? 'Nowhere nearby is clearly better than where you are.' : 'Nowhere nearby scores above zero tonight.'}`;
}

// ---------- Backstory ----------

function renderBackstory(f) {
  $('backstory').innerHTML = f.backstory.items.map((i) => `<li>${esc(i)}</li>`).join('');
  $('backstory-source').textContent = `Source: ${f.backstory.source}`;
}

// ---------- Controls ----------

function applyGemmaToggle() {
  document.querySelectorAll('[data-gemma]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.gemma === state.gemma)));
}

document.querySelectorAll('[data-gemma]').forEach((b) => b.addEventListener('click', () => {
  if (b.disabled || b.dataset.gemma === state.gemma) return;
  state.gemma = b.dataset.gemma;
  try { localStorage.setItem('halo.gemma', state.gemma); } catch {}
  applyGemmaToggle();
  if (!state.forecast) return;
  resetPlan();
  resetCamera();
  const req = state.req;
  const backend = state.gemma;
  api(`/api/plan?${qs()}&${gemmaQs()}`).then((p) => req === state.req && state.gemma === backend && renderPlan(p)).catch((e) => req === state.req && state.gemma === backend && planError(e));
  api(`/api/camera?${qs()}&${deviceQs()}&${gemmaQs()}`).then((c) => req === state.req && state.gemma === backend && renderCamera(c)).catch((e) => req === state.req && state.gemma === backend && cameraError(e));
}));

document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
  state.mode = b.dataset.mode;
  document.querySelectorAll('[data-mode]').forEach((x) => x.setAttribute('aria-selected', x === b));
  load();
}));

document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
  state.view = b.dataset.view;
  document.querySelectorAll('[data-view]').forEach((x) => x.setAttribute('aria-selected', x === b));
  if (!state.forecast) return;
  renderSky();
  ensureSkyImage();
}));

document.querySelectorAll('[data-scene]').forEach((b) => b.addEventListener('click', () => {
  if (!state.forecast?.scenes.spot) return;
  state.scene = b.dataset.scene;
  renderSceneToggle(state.forecast);
  renderSky(true);
  ensureSkyImage();
}));

document.querySelectorAll('[data-map]').forEach((b) => b.addEventListener('click', () => showMapTab(b.dataset.map)));
$('cloud-toggle').addEventListener('click', () => {
  cloudsOn = !cloudsOn;
  $('cloud-label').textContent = `Satellite clouds: ${cloudsOn ? 'on' : 'off'}`;
  $('cloud-toggle').setAttribute('aria-pressed', cloudsOn);
  globe?.showClouds(cloudsOn);
  loadSatelliteClouds(state.forecast);
  updateCloudLegend();
});
$('face-aurora').addEventListener('click', faceAurora);

// Device panel
const panel = $('device-panel');
const togglePanel = (open) => {
  panel.hidden = !open;
  $('device-btn').setAttribute('aria-expanded', open);
  if (open) {
    $('device-type').value = state.device.id;
    $('device-model').value = state.device.model;
    $('device-tripod').checked = state.device.tripod;
    $('device-type').focus();
  }
};
$('device-btn').addEventListener('click', () => togglePanel(panel.hidden));
$('cam-change').addEventListener('click', () => { togglePanel(true); window.scrollTo({ top: 0, behavior: 'smooth' }); });
panel.addEventListener('submit', (e) => {
  e.preventDefault();
  state.device = { id: $('device-type').value, model: $('device-model').value.trim(), tripod: $('device-tripod').checked };
  saveDevice();
  renderDeviceLabel();
  togglePanel(false);
  if (state.forecast) loadDeviceViews();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) togglePanel(false); });
document.addEventListener('click', (e) => { if (!panel.hidden && !e.target.closest('.device-wrap') && e.target.id !== 'cam-change') togglePanel(false); });

$('locate').addEventListener('click', () => {
  if (!navigator.geolocation) return;
  $('locate-label').textContent = 'Locating…';
  navigator.geolocation.getCurrentPosition((pos) => {
    Object.assign(state, { lat: +pos.coords.latitude.toFixed(4), lon: +pos.coords.longitude.toFixed(4), name: 'Your location' });
    $('locate-label').textContent = 'My location';
    load();
  }, () => { $('locate-label').textContent = 'My location'; });
});

let searchTimer;
$('q').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (q.length < 2) { $('results').hidden = true; return; }
  searchTimer = setTimeout(async () => {
    const results = await api(`/api/geocode?q=${encodeURIComponent(q)}`).catch(() => []);
    $('results').innerHTML = results.map((r, i) => `<li tabindex="0" data-i="${i}">${esc(r.name)}</li>`).join('') || '<li class="muted">No matches</li>';
    $('results').hidden = false;
    $('results').querySelectorAll('[data-i]').forEach((li) => {
      const pick = () => {
        const r = results[li.dataset.i];
        Object.assign(state, { lat: r.lat, lon: r.lon, name: r.name });
        $('results').hidden = true;
        $('q').value = '';
        load();
      };
      li.addEventListener('click', pick);
      li.addEventListener('keydown', (ev) => ev.key === 'Enter' && pick());
    });
  }, 250);
});
$('search').addEventListener('submit', (e) => { e.preventDefault(); $('results').querySelector('[data-i]')?.click(); });
document.addEventListener('click', (e) => { if (!$('search').contains(e.target)) $('results').hidden = true; });

// ---------- Start ----------

Promise.all([
  api('/api/devices').then((list) => {
    state.devices = list;
    if (!list.some((d) => d.id === state.device.id)) state.device.id = list[0].id;
    $('device-type').innerHTML = list.map((d) => `<option value="${d.id}">${esc(d.label)}</option>`).join('');
    renderDeviceLabel();
  }),
  api('/api/status').then((s) => {
    const localBtn = document.querySelector('[data-gemma="local"]');
    const apiBtn = document.querySelector('[data-gemma="api"]');
    localBtn.disabled = !s.gemma_local;
    apiBtn.disabled = !s.gemma_api;
    localBtn.title = s.gemma_local ? `This machine · ${s.gemma_model}` : 'Local Gemma is not running';
    apiBtn.title = s.gemma_api ? 'Gemini API key' : 'No API key set';
    if (state.gemma === 'local' && !s.gemma_local && s.gemma_api) state.gemma = 'api';
    if (state.gemma === 'api' && !s.gemma_api && s.gemma_local) state.gemma = 'local';
    applyGemmaToggle();
  }).catch(() => applyGemmaToggle()),
]).finally(load);
