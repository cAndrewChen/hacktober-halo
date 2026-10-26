// Equirectangular sky panoramas (2:1). x = azimuth, centered on the aurora's bearing;
// y = elevation, +90° (zenith) at the top, horizon at the middle, -90° at the bottom.
// Used both to paint Halo's own sky and to prepare Grok's panoramas for the 3D dome.

export const PANO_W = 2048, PANO_H = 1024;

const COLORS = { red: [255, 70, 95], pink: [255, 110, 175], green: [70, 255, 150], purple: [170, 110, 255] };
// Aurora brightness per view and expectation level (camera is further scaled by the device's gain).
const CAMERA_GAIN = { none: 0, camera_only: 0.35, faint: 0.6, visible: 0.85, vivid: 1 };
const EYE_GAIN = { none: 0, camera_only: 0.03, faint: 0.14, visible: 0.4, vivid: 0.85 };
// How much color survives to the eye (rods don't see color in dim light).
const EYE_SAT = { none: 0, camera_only: 0, faint: 0.1, visible: 0.45, vivid: 0.85 };

const rad = Math.PI / 180;
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

/** Pixel x for an azimuth, given the panorama's center bearing. */
export const xForAz = (az, center) => ((wrap180(az - center) / 360 + 0.5) * PANO_W + PANO_W) % PANO_W;
export const yForEl = (el) => ((90 - el) / 180) * PANO_H;

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

// Smooth periodic noise over azimuth (seamless at 0/360).
function rayNoise(seed) {
  const r = rng(seed);
  const waves = Array.from({ length: 7 }, (_, i) => ({ k: 3 + i * 5 + Math.floor(r() * 4), p: r() * Math.PI * 2, a: 1 / (i + 1.5) }));
  const norm = waves.reduce((s, w) => s + w.a, 0);
  return (az) => 0.5 + 0.5 * waves.reduce((s, w) => s + w.a * Math.sin(w.k * az * rad + w.p), 0) / norm;
}

/** Paint Halo's own panorama from the forecast numbers. */
export function paintPanorama(canvas, f, view, deviceGain = 1) {
  canvas.width = PANO_W; canvas.height = PANO_H;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(PANO_W, PANO_H);
  const d = img.data;
  const eye = view === 'eye';
  const level = f.expect.level;
  const center = f.look.bearing_deg;
  const gain = eye ? EYE_GAIN[level] : CAMERA_GAIN[level] * deviceGain;
  const sat = eye ? EYE_SAT[level] : 1;
  const hasGreen = f.expect.colors.includes('green');
  const gray = [200, 205, 215];
  const low = mix(gray, COLORS[hasGreen ? 'green' : f.expect.colors[0]] ?? COLORS.red, sat);
  const high = mix(gray, COLORS[hasGreen ? 'red' : f.expect.colors[1] ?? f.expect.colors[0]] ?? COLORS.pink, sat);
  const rays = level === 'visible' || level === 'vivid';
  const noise = rayNoise(7), topNoise = rayNoise(11);
  const top = f.look.overhead ? 90 : Math.max(4, f.look.top_elevation_deg);
  const spread = f.look.overhead ? 140 : 45 + top * 1.5; // wider when it climbs higher
  const moon = f.moon.bright ? 1.7 : 1;
  const sky = skyAt(f.view.sun_alt, eye, moon);
  const sunOff = wrap180(f.view.sun_bearing - center);
  // Seamless hills: periodic in x.
  const hill = (x) => 1.2 + 0.9 * Math.sin((x / PANO_W) * 2 * Math.PI * 3 + 1) + 0.6 * Math.sin((x / PANO_W) * 2 * Math.PI * 11 + 2) + 0.3 * Math.sin((x / PANO_W) * 2 * Math.PI * 29);

  for (let x = 0; x < PANO_W; x++) {
    const az = center + (x / PANO_W - 0.5) * 360;
    const dAz = wrap180(az - center);
    const azF = f.look.overhead ? 0.55 + 0.45 * Math.exp(-((dAz / spread) ** 2)) : Math.exp(-((dAz / spread) ** 2));
    const r = rays ? 0.35 + 0.65 * noise(az) ** 1.5 : 1;
    const topHere = top * (0.75 + 0.35 * topNoise(az));
    const hillTop = hill(x);
    // Twilight/sun glow is strongest toward the sun's bearing.
    const sunAz = Math.exp(-((wrap180(dAz - sunOff) / 55) ** 2));
    for (let y = 0; y < PANO_H; y++) {
      const el = 90 - (y / PANO_H) * 180;
      const i = (y * PANO_W + x) * 4;
      let c;
      if (el < hillTop) {
        const g = (el < 0 ? Math.max(0, 1 + el / 40) : 1) * (1 + sky.groundLight);
        c = [3 * g + 1, 4 * g + 1, 6 * g + 2].map((v) => v + sky.groundLight * 40);
      } else {
        c = mix(sky.horizon, sky.zenith, Math.min(1, (el / 90) ** 0.45));
        if (sky.glow > 0) c = c.map((v, k) => v + sky.glowColor[k] * sky.glow * sunAz * Math.exp(-el / 14));
        if (gain > 0 && el < topHere * 1.25) {
          const t = el / topHere;
          // Brightest just above the horizon, fading upward; overhead aurora peaks mid-sky.
          const prof = f.look.overhead ? Math.exp(-(((el - 55) / 30) ** 2)) : Math.max(0, 1 - t) ** 0.7 * Math.min(1, el / 2 + 0.3);
          const a = gain * azF * r * prof;
          if (a > 0.002) c = c.map((v, k) => v + mix(low, high, Math.min(1, t))[k] * a);
        }
      }
      d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // Sun disk in daylight.
  if (f.view.sun_alt > -0.5) {
    const sx = xForAz(f.view.sun_bearing, center), sy = yForEl(Math.max(0.5, f.view.sun_alt));
    const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, 60);
    g.addColorStop(0, 'rgba(255,250,230,1)'); g.addColorStop(0.15, 'rgba(255,240,200,0.9)'); g.addColorStop(1, 'rgba(255,220,160,0)');
    ctx.fillStyle = g;
    ctx.fillRect(sx - 60, sy - 60, 120, 120);
  }

  // Stars, uniform over the upper hemisphere, fading out as the sky brightens; widened by 1/cos(el) to look round on the dome.
  const rand = rng(42);
  const n = Math.round((eye ? 900 : 2200) * sky.stars * (1 - f.view.cloud_pct / 100));
  for (let s = 0; s < n; s++) {
    const el = Math.asin(rand()) / rad, az = rand() * 360;
    const x = (az / 360) * PANO_W, y = yForEl(el);
    if (el < hill(x) + 0.5) continue;
    const size = (rand() ** 4) * (eye ? 2.2 : 2.8) + 0.7;
    ctx.fillStyle = `rgba(255,255,255,${((eye ? 0.4 : 0.55) + rand() * 0.45) * Math.min(1, sky.stars + 0.2)})`;
    ctx.fillRect(x, y, Math.min(24, size / Math.max(0.05, Math.cos(el * rad))), size);
  }

  paintClouds(ctx, f.view.cloud_pct, sky, center, hill);
}

/**
 * Sky colors for a sun altitude: daylight blue → civil twilight → nautical → night.
 * Returns zenith/horizon colors, twilight glow strength and color, star visibility, ground light.
 */
function skyAt(sunAlt, eye, moon) {
  const night = { zenith: (eye ? [2, 3, 8] : [4, 7, 18]).map((v) => v * moon), horizon: (eye ? [12, 14, 22] : [24, 32, 56]).map((v) => v * moon) };
  const stops = [
    { alt: 10, zenith: [70, 125, 210], horizon: [170, 200, 235], glow: 0.35, stars: 0, ground: 1 },
    { alt: 0, zenith: [45, 80, 150], horizon: [150, 150, 175], glow: 1, stars: 0, ground: 0.6 },
    { alt: -6, zenith: [18, 32, 75], horizon: [70, 60, 85], glow: 0.75, stars: 0.12, ground: 0.25 },
    { alt: -12, zenith: [6, 10, 28], horizon: [28, 30, 52], glow: 0.25, stars: 0.5, ground: 0.05 },
    { alt: -18, ...night, glow: 0, stars: 1, ground: 0 },
  ];
  if (sunAlt >= stops[0].alt) return { ...stops[0], glowColor: [255, 170, 90], groundLight: 1 };
  if (sunAlt <= -18) return { ...stops[4], glowColor: [255, 140, 70], groundLight: 0 };
  const i = stops.findIndex((s, k) => sunAlt <= s.alt && sunAlt > stops[k + 1].alt);
  const a = stops[i], b = stops[i + 1], t = (a.alt - sunAlt) / (a.alt - b.alt);
  return {
    zenith: mix(a.zenith, b.zenith, t), horizon: mix(a.horizon, b.horizon, t), glow: a.glow + (b.glow - a.glow) * t,
    stars: a.stars + (b.stars - a.stars) * t, groundLight: a.ground + (b.ground - a.ground) * t, glowColor: [255, 140, 70],
  };
}

/** Soft cloud cover: blurred blobs, lit by twilight or dark against the night sky. */
function paintClouds(ctx, pct, sky, center, hill) {
  if (pct < 15) return;
  const lit = Math.min(1, sky.groundLight + sky.glow * 0.4);
  const col = mix([22, 24, 30], [205, 208, 215], lit).map(Math.round);
  const rand = rng(99);
  ctx.save();
  ctx.filter = 'blur(18px)';
  if (pct >= 85) {
    ctx.fillStyle = `rgba(${col},0.88)`;
    ctx.fillRect(0, 0, PANO_W, yForEl(0) - 4);
  }
  const blobs = Math.round(pct * 1.4);
  for (let i = 0; i < blobs; i++) {
    const el = 3 + rand() ** 1.6 * 60, x = rand() * PANO_W;
    if (el < hill(x)) continue;
    const w = (60 + rand() * 160) / Math.max(0.3, Math.cos(el * rad)), h = 25 + rand() * 40;
    ctx.fillStyle = `rgba(${col.map((v) => v + (rand() - 0.5) * 20)},${0.35 + rand() * 0.45})`;
    ctx.beginPath();
    ctx.ellipse(x, yForEl(el), w, h, 0, 0, Math.PI * 2);
    ctx.fill();
    if (x + w > PANO_W) { ctx.beginPath(); ctx.ellipse(x - PANO_W, yForEl(el), w, h, 0, 0, Math.PI * 2); ctx.fill(); }
  }
  ctx.restore();
}

/** Draw a Grok panorama into the canvas and hide its left/right seam. */
export function paintImage(canvas, image) {
  canvas.width = PANO_W; canvas.height = PANO_H;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0, PANO_W, PANO_H);
  const w = 40;
  const right = ctx.getImageData(PANO_W - w, 0, w, PANO_H);
  const left = ctx.getImageData(0, 0, 1, PANO_H);
  for (let x = 0; x < w; x++) {
    const t = (x + 1) / w; // 0 → keep, 1 → match column 0
    for (let y = 0; y < PANO_H; y++) {
      const i = (y * w + x) * 4, j = y * 4;
      for (let k = 0; k < 3; k++) right.data[i + k] = right.data[i + k] * (1 - t) + left.data[j + k] * t;
    }
  }
  ctx.putImageData(right, PANO_W - w, 0);
}

const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** Compass labels on the horizon and elevation ticks above the aurora. */
export function paintOverlay(canvas, f) {
  const ctx = canvas.getContext('2d');
  const center = f.look.bearing_deg;
  const hy = yForEl(0);
  ctx.save();
  ctx.textAlign = 'center';
  POINTS.forEach((p, i) => {
    const x = xForAz(i * 22.5, center);
    const major = p.length === 1;
    ctx.font = `${major ? 600 : 500} ${major ? 28 : 16}px "IBM Plex Mono", monospace`;
    ctx.fillStyle = major ? 'rgba(232,238,249,0.9)' : 'rgba(232,238,249,0.5)';
    ctx.fillText(p, x, hy + (major ? 46 : 36));
    ctx.fillRect(x - 1, hy + 4, 2, major ? 12 : 7);
  });
  // Elevation ticks at the aurora's bearing.
  const x0 = xForAz(center, center) + 70;
  ctx.font = '500 15px "IBM Plex Mono", monospace';
  ctx.textAlign = 'left';
  for (const el of [10, 20, 30, 45, 60]) {
    const y = yForEl(el);
    ctx.fillStyle = 'rgba(232,238,249,0.35)';
    ctx.fillRect(x0, y - 1, 18, 2);
    ctx.fillStyle = 'rgba(232,238,249,0.55)';
    ctx.fillText(`${el}°`, x0 + 24, y + 5);
  }
  ctx.restore();
}
