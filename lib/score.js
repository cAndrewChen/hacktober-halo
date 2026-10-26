// The Halo Score: a 0–50 rating of how good tonight is for seeing aurora from one spot.
// Deliberately NOT out of 100, so nobody reads it as a percent chance.
//
//   score = 50 × reach^0.75 × clear × dark × moon
//
//   reach — how close the aurora oval gets to you (Kp + geomagnetic latitude, or live OVATION)
//   clear — fraction of sky without cloud (Open-Meteo)
//   dark  — how dark the sky is (sun altitude)
//   moon  — penalty for a bright moon above the horizon

import { EARTH_RADIUS_KM } from './geo.js';

export const SCALE_MAX = 50;

export const BANDS = [
  { min: 0, max: 4, name: 'Stay in', verdict: 'SKIP', meaning: 'No realistic chance from here tonight.' },
  { min: 5, max: 14, name: 'Long shot', verdict: 'MAYBE', meaning: 'A camera may catch a faint glow low on the horizon. Your eyes probably won\'t.' },
  { min: 15, max: 24, name: 'Worth a look', verdict: 'GO', meaning: 'Cameras should catch it. Eyes may see a pale glow on the horizon.' },
  { min: 25, max: 34, name: 'Good night', verdict: 'GO', meaning: 'Visible to the eye. Cameras show strong color.' },
  { min: 35, max: 50, name: 'Go now', verdict: 'GO', meaning: 'Strong, colorful aurora, possibly overhead.' },
];

export const bandFor = (score) => BANDS.find((b) => score >= b.min && score <= b.max) ?? BANDS[0];

const clamp01 = (x) => Math.max(0, Math.min(1, x));

/**
 * NOAA's "view line": the farthest-equatorward geomagnetic latitude where aurora might be seen low
 * on the poleward horizon. Matches NOAA's line for May 10, 2024 (Kp 8 → ~50°, i.e. ~41°N across the US).
 */
export const ovalEdge = (kp) => 66.5 - 2.05 * kp;

/**
 * Aurora *overhead* likelihood (0–100) at a geomagnetic latitude: the oval itself, as on NOAA's
 * OVATION map, not the wider area it can be seen from. A band between an equatorward edge
 * (Kp 8 → 56°, the US–Canada border, as in NOAA's May 10, 2024 forecast) and a poleward edge,
 * with a quiet polar cap inside. Ignores time-of-day (MLT) distortion of the real oval.
 */
export function ovalProbability(kp, magLat) {
  const m = Math.abs(magLat);
  const eq = 66 - 1.25 * kp, pole = 80 - 0.5 * kp;
  const rise = clamp01((m - (eq - 1)) / 4); // 0 at eq-1°, full by eq+3°
  const fall = clamp01((pole + 1 - m) / 4); // full until pole-3°, 0 by pole+1°
  return Math.round(100 * clamp01(kp / 6 + 0.15) * Math.min(rise, fall));
}

/**
 * How far you are from the oval's edge, in degrees of geomagnetic latitude.
 * Positive = under or inside the oval; negative = that many degrees equatorward of it.
 */
export const marginDeg = (kp, magLat) => Math.abs(magLat) - ovalEdge(kp);

/** 0–1. Full reach once you're under the oval; fades to zero ~14° equatorward of it. */
export const reachFromKp = (kp, magLat) => clamp01((marginDeg(kp, magLat) + 14) / 16);

/**
 * 0–1 reach from NOAA's live OVATION grid: the strongest aurora within view (~1100 km),
 * discounted by distance because distant aurora sits low on the horizon.
 */
export function reachFromOvation(grid, lat, lon) {
  if (!grid) return 0;
  let best = 0;
  const dLat = 10, dLon = Math.min(180, 10 / Math.max(0.15, Math.cos((lat * Math.PI) / 180)));
  for (let la = Math.round(lat - dLat); la <= Math.round(lat + dLat); la++) {
    for (let lo = Math.round(lon - dLon); lo <= Math.round(lon + dLon); lo++) {
      const p = grid.get(`${((lo % 360) + 360) % 360},${la}`);
      if (!p) continue;
      const dKm = Math.hypot(la - lat, (lo - lon) * Math.cos((lat * Math.PI) / 180)) * 111;
      if (dKm > 1100) continue;
      best = Math.max(best, (p / 50) * (1 - dKm / 1100));
    }
  }
  return clamp01(best);
}

/**
 * 0–1 sky darkness. Nothing until the sun is 6° below the horizon (civil twilight is far too bright),
 * then a steep curve: 0.10 at -8° (Iceland's darkest in mid-May), 0.41 at -12°, 0.69 at -15°, 1 at -18°.
 */
export const darkness = (sunAlt) => clamp01((-sunAlt - 6) / 12) ** 1.3;

export const moonFactor = (m) => (m.altitude > 0 ? 1 - 0.35 * m.illumination : 1);

export function haloScore({ reach, cloudPct, sunAlt, moon }) {
  const clear = clamp01(1 - cloudPct / 100);
  const dark = darkness(sunAlt);
  const moonF = moonFactor(moon);
  const score = Math.round(SCALE_MAX * Math.pow(reach, 0.75) * clear * dark * moonF);
  return { score, parts: { reach: +reach.toFixed(2), clear: +clear.toFixed(2), dark, moon: +moonF.toFixed(2) } };
}

/**
 * What a person will actually see at one hour. Brightness comes from the Halo Score itself, so
 * sunlight, moonlight and clouds dim it exactly as they dim the score. `reason` says what is
 * hiding the aurora when it isn't visible.
 */
export function expectation({ score, reach, margin, parts }) {
  const level = score <= 0 ? 'none' : score < 8 ? 'camera_only' : score < 18 ? 'faint' : score < 31 ? 'visible' : 'vivid';
  // Far from the oval you only see the high, red oxygen glow; closer in, the green band dominates.
  const colors = margin < -6 ? ['red', 'pink'] : margin < 0 ? ['green', 'red'] : ['green', 'red', 'purple'];
  const reasons = [];
  if (reach <= 0.02) reasons.push('no aurora reaches this far');
  if (parts.dark === 0) reasons.push('the sky is too bright (the sun is not far enough below the horizon)');
  else if (parts.dark < 0.3 && level !== 'vivid') reasons.push('twilight washes out the aurora');
  if (parts.clear < 0.15) reasons.push('clouds cover the sky');
  if (parts.moon < 0.75 && ['none', 'camera_only'].includes(level)) reasons.push('bright moonlight washes out the aurora');
  return { level, colors, reason: reasons.length ? reasons.join(', and ') : null };
}

/** How high above the horizon the top of the aurora appears. */
export function lookGeometry(margin) {
  if (margin >= 0) return { overhead: true, top_elevation_deg: 90 };
  const d = -margin * 111; // km to the oval edge
  const h = margin < -5 ? 350 : 250; // km altitude of the visible top (red glow sits higher)
  const elev = Math.atan((h - (d * d) / (2 * EARTH_RADIUS_KM)) / d) * (180 / Math.PI);
  return { overhead: false, top_elevation_deg: Math.max(0, Math.round(elev)) };
}
