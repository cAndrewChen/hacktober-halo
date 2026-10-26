// Builds tonight's forecast for one location: hourly Halo Scores, best window,
// a "where to drive" search over nearby points, and what you'll actually see at a specific hour.

import { sunPosition, skyPhase, moon } from './astro.js';
import { magneticLatitude, auroraBearing, bearing, compass, destination, distanceKm } from './geo.js';
import { BANDS, SCALE_MAX, bandFor, haloScore, reachFromKp, reachFromOvation, marginDeg, expectation, lookGeometry, ovalEdge, ovalProbability } from './score.js';
import * as src from './sources.js';

const HOUR = 3600e3;
const RINGS_KM = [40, 80, 130, 200];
const BEARINGS = [0, 45, 90, 135, 180, 225, 270, 315];

// Replay: the May 10, 2024 G5 storm, starting 7 PM local time.
const REPLAY = { year: 2024, month: 4, day: 10, startDate: '2024-05-09', endDate: '2024-05-12', kp: ['2024-05-09T00:00:00Z', '2024-05-12T12:00:00Z'] };

const timeLabel = (ms, offset) => {
  const h = new Date(ms + offset * 1000).getUTCHours();
  return `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;
};

const loadKp = (replay) => (replay ? src.kpHistory(...REPLAY.kp) : src.kpLive());
const cloudOpts = (replay) => (replay ? { replay, startDate: REPLAY.startDate, endDate: REPLAY.endDate } : {});

/** Scores one point for one hour (scored at the middle of the hour). */
function makeScorer({ kpSeries, ov, nowMs }) {
  return (p, cloudsForPoint, ms) => {
    const t = ms + HOUR / 2;
    const kp = src.kpAt(kpSeries, t);
    const magLat = magneticLatitude(p.lat, p.lon);
    let reach = reachFromKp(kp.kp, magLat);
    if (ov && Math.abs(t - nowMs) < 1.5 * HOUR) reach = Math.max(reach, reachFromOvation(ov.grid, p.lat, p.lon));
    const m = moon(t, p.lat, p.lon);
    const sun = sunPosition(t, p.lat, p.lon);
    const cloudPct = cloudsForPoint.clouds.get(ms) ?? 50;
    return { ms, kp: kp.kp, kpKind: kp.kind, magLat, reach, cloudPct, moon: m, sun, ...haloScore({ reach, cloudPct, sunAlt: sun.altitude, moon: m }) };
  };
}

const peak = (hrs) => hrs.reduce((a, b) => (b.score > a.score ? b : a), hrs[0] ?? null);
const darkest = (hrs) => hrs.reduce((a, b) => (b.sun.altitude < a.sun.altitude ? b : a), hrs[0] ?? null);

/**
 * Tonight's hours: the first contiguous block (within 24 h) with the sun below -6°.
 * If the sun never gets that low (e.g. Iceland in May), use the hours around the darkest moment
 * instead, so the timeline and the sky view honestly show a too-bright night.
 */
function nightHours(hours, p) {
  const alt = (ms) => sunPosition(ms + HOUR / 2, p.lat, p.lon).altitude;
  const block = (pred) => {
    const i = hours.findIndex(pred);
    const out = [];
    for (let j = i; i >= 0 && j < hours.length && pred(hours[j]); j++) out.push(hours[j]);
    return out;
  };
  const dark = block((ms) => alt(ms) < -6);
  if (dark.length) return { hours: dark, brightNight: false };
  const set = block((ms) => alt(ms) < 0);
  if (set.length) return { hours: set, brightNight: true };
  const i = hours.reduce((best, ms, k) => (alt(ms) < alt(hours[best]) ? k : best), 0);
  return { hours: hours.slice(Math.max(0, i - 2), i + 3), brightNight: true };
}

export async function buildForecast({ lat, lon, mode = 'live' }) {
  const replay = mode === 'replay';
  const home = { lat, lon };
  const spots = RINGS_KM.flatMap((d) => BEARINGS.map((b) => ({ ...destination(home, b, d), ringKm: d })));
  const points = [home, ...spots];

  const [cloudData, kpSeries, ov] = await Promise.all([
    src.clouds(points, cloudOpts(replay)),
    loadKp(replay),
    replay ? null : src.ovation().catch(() => null),
  ]);
  const offset = cloudData[0].offset;
  const nowMs = replay ? Date.UTC(REPLAY.year, REPLAY.month, REPLAY.day, 19) - offset * 1000 : Date.now();
  const story = src.backstory(nowMs, { replay });
  const scoreAt = makeScorer({ kpSeries, ov, nowMs });

  const first = Math.floor(nowMs / HOUR) * HOUR;
  const hours = Array.from({ length: 24 }, (_, i) => first + i * HOUR);
  const { hours: night, brightNight } = nightHours(hours, home);

  // Best window: contiguous hours around the peak that stay within 80% of it.
  const windowOf = (hrs) => {
    const top = peak(hrs);
    if (!top || top.score === 0) return null;
    const i = hrs.indexOf(top);
    let a = i, b = i;
    while (a > 0 && hrs[a - 1].score >= top.score * 0.8) a--;
    while (b < hrs.length - 1 && hrs[b + 1].score >= top.score * 0.8) b++;
    return { startMs: hrs[a].ms, endMs: hrs[b].ms + HOUR, start: timeLabel(hrs[a].ms, offset), end: timeLabel(hrs[b].ms + HOUR, offset), peakMs: top.ms };
  };

  const timeline = night.map((ms) => scoreAt(home, cloudData[0], ms));
  const best = peak(timeline);

  // Where to drive: score every nearby point over the same hours.
  const spotResults = spots
    .map((p, i) => ({ p, c: cloudData[i + 1] }))
    .filter(({ c }) => c.elevation > 0) // elevation 0 = open water
    .map(({ p, c }) => {
      const hrs = night.map((ms) => scoreAt(p, c, ms));
      const top = peak(hrs) ?? { score: 0 };
      const km = distanceKm(home, p);
      return {
        lat: +p.lat.toFixed(4), lon: +p.lon.toFixed(4), score: top.score, bestTime: top.ms ? timeLabel(top.ms, offset) : null,
        distance_km: Math.round(km), distance_mi: Math.round(km * 0.621371), direction: compass(bearing(home, p)), drive_minutes: Math.round(((km * 1.3) / 75) * 60),
        window: windowOf(hrs), hours: hrs,
      };
    });
  const homeScore = best?.score ?? 0;
  // Farther spots must earn their drive: +3 points, plus ~1 point per 50 km.
  const gain = (s) => s.score - homeScore - 3 - s.distance_km / 50;
  const topSpot = spotResults.reduce((a, b) => (gain(b) > gain(a) ? b : a), spotResults[0] ?? null);
  const worth = !!topSpot && gain(topSpot) >= 0 && topSpot.score >= 5;

  /**
   * What the sky looks like from one point at one specific hour: the best hour if any hour scores,
   * otherwise the darkest hour (so the view shows the real, too-bright or cloudy sky).
   */
  const sceneFor = (point, hrs) => {
    const h = (peak(hrs)?.score > 0 ? peak(hrs) : darkest(hrs)) ?? scoreAt(point, cloudData[0], first);
    const margin = marginDeg(h.kp, magneticLatitude(point.lat, point.lon));
    const bearingDeg = auroraBearing(point.lat, point.lon);
    return {
      point: { lat: point.lat, lon: point.lon },
      look: { direction: compass(bearingDeg), bearing_deg: Math.round(bearingDeg), ...lookGeometry(margin) },
      view: {
        ms: h.ms, label: timeLabel(h.ms, offset), why: h.score > 0 ? 'best hour' : 'darkest hour',
        sun_alt: +h.sun.altitude.toFixed(1), sun_bearing: Math.round(h.sun.bearing), phase: skyPhase(h.sun.altitude),
        cloud_pct: h.cloudPct, score: h.score, kp: h.kp,
      },
      expect: { ...expectation({ score: h.score, reach: h.reach, margin, parts: h.parts }), reach: +h.reach.toFixed(2), margin_deg: +margin.toFixed(1) },
      moon: { illumination_pct: Math.round(h.moon.illumination * 100), up: h.moon.altitude > 0, bright: h.moon.altitude > 0 && h.moon.illumination > 0.5 },
    };
  };
  const scenes = { home: sceneFor(home, timeline), spot: worth ? sceneFor(topSpot, topSpot.hours) : null };
  // The plan (and Gemma) follows wherever it sends you; the sky view defaults to "home".
  const plan = scenes.spot ?? scenes.home;
  const window = worth ? topSpot.window : windowOf(timeline);
  const viewHour = { kp: plan.view.kp };

  const score = worth ? topSpot.score : homeScore;
  const band = bandFor(score);
  const kpTonight = night.map((ms) => src.kpAt(kpSeries, ms + HOUR / 2).kp);
  const kpPeak = Math.max(...kpTonight, viewHour.kp);

  return {
    mode,
    generated_at: new Date().toISOString(),
    now: nowMs,
    utc_offset: offset,
    location: { lat, lon, mag_lat: +magneticLatitude(lat, lon).toFixed(1) },
    scale_max: SCALE_MAX,
    bands: BANDS,
    home_score: homeScore,
    score,
    band: band.name,
    band_meaning: band.meaning,
    verdict: band.verdict,
    best_window: window,
    home_window: windowOf(timeline),
    timeline: timeline.map((t) => ({ ms: t.ms, label: timeLabel(t.ms, offset), score: t.score, parts: t.parts, kp: t.kp, kp_kind: t.kpKind, cloud: t.cloudPct, sun_alt: +t.sun.altitude.toFixed(1) })),
    kp_max_tonight: kpTonight.length ? Math.max(...kpTonight) : null,
    oval_edge_maglat: +(66.5 - 2.05 * viewHour.kp).toFixed(1),
    spots: spotResults.map(({ window: w, hours: h, ...s }) => s),
    best_spot: topSpot ? { ...topSpot, worth_driving: worth, window: undefined, hours: undefined } : null,
    // The plan's scene (where the plan sends you): what Gemma and the camera advice describe.
    look: plan.look,
    view: plan.view,
    expect: plan.expect,
    moon: plan.moon,
    // Both scenes for the sky view: "home" (matches the big score) and the ★ spot if worth driving.
    scenes,
    no_night: brightNight,
    clouds_estimated: cloudData[0].estimated,
    backstory: await story,
    ovation: ov ? { observed: ov.observed, forecast: ov.forecast } : null,
    heat: ov
      ? { source: `NOAA OVATION aurora probability (observed ${ov.observed})`, points: ov.points, view_line: viewLine(src.kpAt(kpSeries, nowMs).kp) }
      : { source: `Modeled from Kp ${kpPeak.toFixed(1)} (the night's peak)`, points: kpHeat(kpPeak), view_line: viewLine(kpPeak) },
  };
}

/** Global aurora-oval grid (1.5°) from Kp, in OVATION's [lat, lon, 0–100] format, for replays. */
function kpHeat(kp) {
  const points = [];
  for (let lat = -88.5; lat <= 88.5; lat += 1.5) {
    for (let lon = -180; lon < 180; lon += 1.5) {
      const v = ovalProbability(kp, magneticLatitude(lat, lon));
      if (v >= 5) points.push([lat, lon, v]);
    }
  }
  return points;
}

/**
 * NOAA-style view line for a Kp, as geographic [lat, lon] points in both hemispheres:
 * along each meridian, the latitude where geomagnetic latitude equals the view-line value.
 */
function viewLine(kp) {
  const target = ovalEdge(kp);
  const solve = (lon, sign) => {
    let lo = sign > 0 ? -10 : -89, hi = sign > 0 ? 89 : 10;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if ((magneticLatitude(mid, lon) - sign * target) * sign < 0) { if (sign > 0) lo = mid; else hi = mid; } else if (sign > 0) hi = mid; else lo = mid;
    }
    return +((lo + hi) / 2).toFixed(2);
  };
  const lons = Array.from({ length: 181 }, (_, i) => -180 + i * 2);
  return { kp, maglat: +target.toFixed(1), north: lons.map((lon) => [solve(lon, 1), lon]), south: lons.map((lon) => [solve(lon, -1), lon]) };
}
