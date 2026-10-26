// Sun and moon position (low-precision formulas, after Vladimir Agafonkin's SunCalc).
// Accurate to well under a degree, which is plenty for "is it dark?" decisions.

const rad = Math.PI / 180;
const dayMs = 86400000;
const J1970 = 2440588;
const J2000 = 2451545;
const e = rad * 23.4397; // obliquity of the Earth

const toDays = (ms) => ms / dayMs - 0.5 + J1970 - J2000;
const rightAscension = (l, b) => Math.atan2(Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(l));
const declination = (l, b) => Math.asin(Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l));
const altitude = (H, phi, dec) => Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
const siderealTime = (d, lw) => rad * (280.16 + 360.9856235 * d) - lw;

function sunCoords(d) {
  const M = rad * (357.5291 + 0.98560028 * d);
  const C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const L = M + C + rad * 102.9372 + Math.PI;
  return { dec: declination(L, 0), ra: rightAscension(L, 0) };
}

function moonCoords(d) {
  const L = rad * (218.316 + 13.176396 * d);
  const M = rad * (134.963 + 13.064993 * d);
  const F = rad * (93.272 + 13.22935 * d);
  const l = L + rad * 6.289 * Math.sin(M);
  const b = rad * 5.128 * Math.sin(F);
  return { ra: rightAscension(l, b), dec: declination(l, b), dist: 385001 - 20905 * Math.cos(M) };
}

/** Sun altitude in degrees (negative = below horizon). */
export function sunAltitude(ms, lat, lon) {
  return sunPosition(ms, lat, lon).altitude;
}

/** Sun altitude and compass bearing (degrees clockwise from north). */
export function sunPosition(ms, lat, lon) {
  const d = toDays(ms);
  const c = sunCoords(d);
  const H = siderealTime(d, rad * -lon) - c.ra;
  const phi = rad * lat;
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(c.dec) * Math.cos(phi)); // from south, westward
  return { altitude: altitude(H, phi, c.dec) / rad, bearing: (az / rad + 180 + 360) % 360 };
}

/** Plain-language sky brightness for a sun altitude. */
export function skyPhase(sunAlt) {
  if (sunAlt > 0) return 'daylight';
  if (sunAlt > -6) return 'civil twilight';
  if (sunAlt > -12) return 'nautical twilight';
  if (sunAlt > -18) return 'astronomical twilight';
  return 'dark night';
}

/** Moon altitude in degrees and illuminated fraction (0 = new, 1 = full). */
export function moon(ms, lat, lon) {
  const d = toDays(ms);
  const m = moonCoords(d);
  const s = sunCoords(d);
  const H = siderealTime(d, rad * -lon) - m.ra;
  const sdist = 149598000;
  const phi = Math.acos(Math.sin(s.dec) * Math.sin(m.dec) + Math.cos(s.dec) * Math.cos(m.dec) * Math.cos(s.ra - m.ra));
  const inc = Math.atan2(sdist * Math.sin(phi), m.dist - sdist * Math.cos(phi));
  return { altitude: altitude(H, rad * lat, m.dec) / rad, illumination: (1 + Math.cos(inc)) / 2 };
}
