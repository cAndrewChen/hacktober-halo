// Grok Imagine (xAI API): renders tonight's sky as a 360° equirectangular panorama.
//
// Projection: equirectangular (plate carrée), 2:1. x = azimuth (0–360°), y = elevation
// (+90° zenith at the top edge, horizon on the center line, -90° at the bottom). It is the
// standard 360° panorama format and maps directly onto the inside of a sphere. The image's
// horizontal center faces the aurora (forecast.look.bearing_deg), so the frontend knows exactly
// where every pixel sits in the sky.
//
// Needs XAI_API_KEY from console.x.ai. Without it the frontend paints the same panorama itself.

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
  else if (night && m.up && m.illumination_pct >= 30) moon = ` A ${m.illumination_pct}%-lit moon gives the land faint, silvery light (moonlight is hundreds of thousands of times dimmer than sunlight).`;
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

async function generate(text) {
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

/** scene: 'home' (where you are) or 'spot' (the ★ spot, if worth driving). */
export async function sky(forecast, view, device, scene = 'home') {
  const f = { ...forecast, ...(forecast.scenes?.[scene] ?? forecast.scenes?.home) };
  const text = prompt(f, view, device);
  const meta = { view, scene, projection: 'equirectangular', center_bearing_deg: f.look.bearing_deg, prompt: text };
  if (!process.env.XAI_API_KEY) return { source: 'none', reason: 'XAI_API_KEY not set', ...meta };
  try {
    return { source: MODEL, image: await generate(text), ...meta };
  } catch (err) {
    return { source: 'none', reason: err.message, ...meta };
  }
}
