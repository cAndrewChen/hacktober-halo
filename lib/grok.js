// Grok Imagine (xAI API): renders tonight's sky as a 360° equirectangular panorama.
//
// Projection: equirectangular (plate carrée), 2:1. x = azimuth (0–360°), y = elevation
// (+90° zenith at the top edge, horizon on the center line, -90° at the bottom). It is the
// standard 360° panorama format and maps directly onto the inside of a sphere. The image's
// horizontal center faces the aurora (forecast.look.bearing_deg), so the frontend knows exactly
// where every pixel sits in the sky.
//
// Only scripts/sky-library.js calls xAI (needs XAI_API_KEY); the app serves the pre-rendered library.

import { existsSync } from 'node:fs';
import { compass } from './geo.js';

const MODEL = process.env.XAI_IMAGE_MODEL || 'grok-imagine-image-2.0';

const LOOK = {
  none: 'no aurora at all, just stars',
  camera_only: 'an extremely faint glow hugging the horizon, barely distinguishable from light pollution',
  faint: 'a faint, soft glow low on the horizon',
  visible: 'a clear aurora band with soft vertical rays',
  vivid: 'bright, dynamic aurora curtains with sharp rays',
};

const PANORAMA = 'Seamless equirectangular 360-degree panorama in 2:1 format, as used for VR skyboxes. '
  + 'The horizon is a perfectly straight, level line exactly across the vertical middle of the image. '
  + 'The top edge is the point straight overhead, the bottom edge the ground straight below. '
  + 'The left and right edges must join seamlessly. Photorealistic, no text, no people, no borders.';

/** Where the aurora sits, in panorama terms (so the model places it correctly). */
function placement(f) {
  if (f.look.overhead) return 'The aurora fills much of the sky, arching high overhead across the center of the panorama and down toward the horizon.';
  const top = f.look.top_elevation_deg;
  const pct = Math.round((top / 180) * 100);
  return `The aurora is centered horizontally in the panorama, spanning roughly the middle third of the image width along the horizon. `
    + `Its top reaches only about ${top} degrees above the horizon, which is about ${pct}% of the image height above the center line. The rest of the sky has no aurora.`;
}

const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

/** The sky itself at the view hour: sunlight/twilight (with where its glow sits) and clouds. */
function skyDescription(f) {
  const v = f.view;
  const sunDir = compass(v.sun_bearing);
  const pct = Math.round((0.5 + wrap180(v.sun_bearing - f.look.bearing_deg) / 360) * 100);
  const where = `toward the ${sunDir}, about ${pct}% of the way across the image from the left edge`;
  const sky = {
    daylight: `Daytime: bright blue sky, the sun ${Math.round(v.sun_alt)} degrees above the horizon ${where}. No stars. No aurora is visible in daylight.`,
    'civil twilight': `Bright twilight: deep blue sky with a glowing orange and yellow band along the horizon ${where}. Only a few bright stars. The sky is far too bright to see any aurora.`,
    'nautical twilight': `Twilight that never gets fully dark: dark blue sky with a pale glow along the horizon ${where}; only the brightest stars are visible.`,
    'astronomical twilight': `Nearly dark sky with a faint residual glow on the horizon ${where}; stars visible.`,
    'dark night': 'Fully dark night sky.',
  }[v.phase];
  const night = ['dark night', 'astronomical twilight'].includes(v.phase);
  // Image models default to daytime brightness for "cloudy" or "moonlit" scenes, so spell out the darkness.
  const darkness = night ? ' It is the middle of the night: the whole image must be dark, like a real night photo, never daytime or twilight brightness.' : '';
  const m = f.moon;
  let moon = '';
  if (night && m.up && v.cloud_pct >= 85) moon = ` The ${m.illumination_pct}%-lit moon is hidden behind the clouds, giving them only a faint, dim gray glow.`;
  else if (night && m.up && m.illumination_pct >= 30) {
    const at = Math.round((0.5 + wrap180(m.bearing - f.look.bearing_deg) / 360) * 100);
    moon = ` A small, bright ${m.illumination_pct}%-lit moon hangs ${m.alt} degrees above the horizon toward the ${compass(m.bearing)}, about ${at}% of the way across the image from the left edge, with a soft halo around it. `
      + 'It gives the land faint, silvery light and fades the nearby stars (moonlight is hundreds of thousands of times dimmer than sunlight).';
  }
  else if (night) moon = ' No moon in the sky.';
  const clouds = v.cloud_pct >= 85
    ? night ? ' Overcast: a thick, dark cloud layer covers the entire sky and hides every star; the clouds are barely distinguishable from the black sky.' : ' Overcast: thick clouds cover the entire sky, hiding the stars.'
    : v.cloud_pct >= 50 ? ' Mostly cloudy, with a few gaps showing stars.'
      : v.cloud_pct >= 20 ? ' Scattered clouds.' : night ? ' Stars across the whole sky.' : '';
  return `${sky}${clouds}${moon}${darkness}`;
}

export function prompt(f, view, device) {
  const scene = `Landscape at a dark site, open view of the horizon with low hills. ${skyDescription(f)} The center of the image faces ${f.look.direction}.`;
  if (f.expect.level === 'none') {
    return `${PANORAMA} ${scene} No aurora is visible${f.expect.reason ? ` because ${f.expect.reason}` : ''}. ${view === 'eye' ? 'As seen by the naked eye after 20 minutes in the dark: dim and low-contrast.' : `Photographed with ${device.model || device.label}${device.tripod ? ' on a tripod' : ' handheld'}.`} True to life.`;
  }
  if (view === 'eye') {
    return `${PANORAMA} ${scene} Seen by the naked human eye with no camera enhancement, after 20 minutes of dark adaptation: ${LOOK[f.expect.level]}. `
      + `Human night vision is nearly colorless, so the aurora looks pale gray-white${['visible', 'vivid'].includes(f.expect.level) ? ` with a hint of ${f.expect.colors[0]}` : ''}. Dim, subtle, true to life. ${f.expect.level === 'none' ? '' : placement(f)}`;
  }
  const exposure = device.tripod ? device.maxExposure.tripod : device.maxExposure.handheld;
  const strength = device.gain[device.tripod ? 'tripod' : 'handheld'];
  const quality = strength >= 0.9 ? 'clean, detailed long exposure' : strength >= 0.6 ? 'decent night-mode photo with some noise' : 'noisy, soft, underexposed handheld phone photo';
  return `${PANORAMA} ${scene} Photographed with ${device.model || device.label}${device.tripod ? ' on a tripod' : ' handheld'} (exposure: ${exposure}): a ${quality}. `
    + `A ${f.expect.colors.join(' and ')} aurora glow that the camera reveals more strongly than the eye can see, ${LOOK[f.expect.level]}. ${placement(f)} Realistic, not oversaturated.`;
}

export async function generate(text) {
  const res = await fetch('https://api.x.ai/v1/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.XAI_API_KEY}` },
    body: JSON.stringify({ model: MODEL, prompt: text, aspect_ratio: '2:1' }),
    signal: AbortSignal.timeout(90e3),
  });
  if (!res.ok) throw new Error(`xAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  const d = body.data?.[0] ?? {};
  if (d.b64_json) return `data:image/jpeg;base64,${d.b64_json}`;
  if (!d.url) return null;
  // xAI image URLs are temporary, so inline the bytes; they then live as long as our cache.
  const img = await fetch(d.url, { signal: AbortSignal.timeout(30e3) });
  if (!img.ok) return d.url;
  return `data:${img.headers.get('content-type') ?? 'image/jpeg'};base64,${Buffer.from(await img.arrayBuffer()).toString('base64')}`;
}

// ---------- Pre-rendered library (public/sky/*.jpg, made once by scripts/sky-library.js) ----------
// Visitors never call xAI: each sky is the closest of ~150 panoramas rendered ahead of time.
// shortcut: moon variants only for dark night and astronomical twilight, one phase (≥30% lit) and one height; 3–4 cloud buckets. Render more keys if a gap shows.

const PHASES = { day: 'daylight', civil: 'civil twilight', nautical: 'nautical twilight', astro: 'astronomical twilight', dark: 'dark night' };
const SUN_ALT = { day: 25, civil: -3, nautical: -9, astro: -15, dark: -30 };
const CLOUD = { clear: 10, scattered: 35, mostly: 70, overcast: 95 };
const AURORA = ['none', 'camera_only', 'faint', 'visible-far', 'visible-near', 'visible-overhead', 'vivid-far', 'vivid-near', 'vivid-overhead'];
// Aurora images put the twilight glow left of the aurora; the frontend mirrors them when it sits to the right.
const GLOW_LEFT = -70;
// Same trick for the moon in moonlit aurora images: rendered behind-left, mirrored when it is to the right.
const MOON_LEFT = -135;
const LIBRARY_DIR = new URL('../public/sky/', import.meta.url);
/** A mid-range phone on a tripod: the camera view every library image is rendered for. */
export const LIBRARY_DEVICE = { label: 'a phone camera in night mode', tripod: true, maxExposure: { tripod: 'about 10 s' }, gain: { tripod: 0.8 } };

const cloudBucket = (pct) => (pct >= 85 ? 'overcast' : pct >= 50 ? 'mostly' : pct >= 20 ? 'scattered' : 'clear');

/** Which library image fits this forecast, and how to turn it so the sun's glow lands on its real bearing. */
export function libraryKey(f, view) {
  const phase = Object.keys(PHASES).find((k) => PHASES[k] === f.view.phase);
  let cloud = cloudBucket(f.view.cloud_pct);
  const moonlit = (phase === 'dark' || phase === 'astro') && f.moon?.up && f.moon.illumination_pct >= 30;
  // A lit moon decides how the image is turned; the faint twilight glow was rendered opposite it, so it may land off its real bearing.
  const off = wrap180((moonlit ? f.moon.bearing : f.view.sun_bearing) - f.look.bearing_deg);
  const moon = moonlit ? '-moon' : '';
  // Images without aurora were rendered with the sun (or moon) dead center, so they can be rotated freely.
  if (phase === 'day' || phase === 'civil') return { key: `${phase}-${cloud}`, shift_deg: off, flip: false };
  if (cloud === 'overcast') return { key: `${phase}-overcast${moon}-${view}`, shift_deg: off, flip: false };
  if (phase === 'nautical' && cloud !== 'clear') cloud = 'scattered';
  const { level, colors } = f.expect;
  // Moonlight washes out a camera-only glow, as score.js's expectation() says.
  const aurora = level === 'none' || (level === 'camera_only' && (view === 'eye' || moonlit)) ? 'none'
    : level === 'camera_only' || level === 'faint' ? level
      : `${level}-${f.look.overhead ? 'overhead' : colors[0] === 'red' ? 'far' : 'near'}`;
  const key = `${phase}-${cloud}-${aurora}-${view}${moon}`;
  return aurora === 'none' ? { key, shift_deg: off, flip: false } : { key, shift_deg: 0, flip: off > 0 };
}

/** A minimal forecast that makes prompt() describe one library image. */
function libraryForecast(phase, cloud, aurora, off, moonlit) {
  const [level, where] = aurora.split('-');
  const bearing = (off + 360) % 360;
  return {
    look: { direction: 'N', bearing_deg: 0, overhead: where === 'overhead', top_elevation_deg: { overhead: 90, near: 30, far: 12 }[where] ?? 10 },
    view: { phase: PHASES[phase], sun_alt: SUN_ALT[phase], sun_bearing: moonlit ? (bearing + 180) % 360 : bearing, cloud_pct: CLOUD[cloud] },
    expect: { level, colors: { far: ['red', 'pink'], overhead: ['green', 'red', 'purple'] }[where] ?? ['green', 'red'], reason: null },
    moon: moonlit ? { up: true, illumination_pct: 70, alt: 25, bearing } : { up: false, illumination_pct: 0 },
  };
}

/** Every image in the library: { key, view, f }. */
export function libraryScenes() {
  const out = [];
  const add = (key, view, phase, cloud, aurora, moonlit = false) => out.push({ key, view, f: libraryForecast(phase, cloud, aurora, aurora === 'none' ? 0 : moonlit ? MOON_LEFT : GLOW_LEFT, moonlit) });
  // Daylight looks the same to eyes and cameras; the camera wording avoids the "dark-adapted eye" text.
  for (const phase of ['day', 'civil']) for (const cloud of Object.keys(CLOUD)) add(`${phase}-${cloud}`, 'camera', phase, cloud, 'none');
  for (const phase of ['nautical', 'astro', 'dark']) {
    for (const view of ['eye', 'camera']) {
      add(`${phase}-overcast-${view}`, view, phase, 'overcast', 'none');
      for (const cloud of phase === 'nautical' ? ['clear', 'scattered'] : ['clear', 'scattered', 'mostly']) {
        for (const aurora of AURORA) if (!(view === 'eye' && aurora === 'camera_only')) add(`${phase}-${cloud}-${aurora}-${view}`, view, phase, cloud, aurora);
      }
    }
  }
  for (const phase of ['astro', 'dark']) {
    for (const view of ['eye', 'camera']) {
      add(`${phase}-overcast-moon-${view}`, view, phase, 'overcast', 'none', true);
      for (const cloud of ['clear', 'scattered', 'mostly']) {
        for (const aurora of AURORA) if (aurora !== 'camera_only') add(`${phase}-${cloud}-${aurora}-${view}-moon`, view, phase, cloud, aurora, true);
      }
    }
  }
  return out;
}

/** scene: 'home' (where you are) or 'spot' (the ★ spot, if worth driving). */
export async function sky(forecast, view, device, scene = 'home') {
  const f = { ...forecast, ...(forecast.scenes?.[scene] ?? forecast.scenes?.home) };
  const lib = libraryKey(f, view);
  const meta = { view, scene, projection: 'equirectangular', center_bearing_deg: f.look.bearing_deg, key: lib.key };
  if (!existsSync(new URL(`${lib.key}.jpg`, LIBRARY_DIR))) return { source: 'none', reason: `no pre-rendered sky "${lib.key}"`, ...meta };
  return { source: 'library', image: `/sky/${lib.key}.jpg`, shift_deg: lib.shift_deg, flip: lib.flip, ...meta };
}
