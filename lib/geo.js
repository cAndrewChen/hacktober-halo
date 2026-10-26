// Geography helpers: geomagnetic latitude, bearings, distances.

const rad = Math.PI / 180;
const EARTH_KM = 6371;

// Geomagnetic north pole, centered-dipole approximation (IGRF-14, epoch 2025).
const POLE = { lat: 80.8, lon: -72.7 };

/** Geomagnetic latitude (degrees) using a centered dipole. Negative in the south. */
export function magneticLatitude(lat, lon) {
  const p = lat * rad, pp = POLE.lat * rad, dl = (lon - POLE.lon) * rad;
  return Math.asin(Math.sin(p) * Math.sin(pp) + Math.cos(p) * Math.cos(pp) * Math.cos(dl)) / rad;
}

/** Initial great-circle bearing from a to b, degrees clockwise from true north. */
export function bearing(a, b) {
  const p1 = a.lat * rad, p2 = b.lat * rad, dl = (b.lon - a.lon) * rad;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

/** Bearing toward where the aurora oval sits: the geomagnetic pole of your hemisphere. */
export function auroraBearing(lat, lon) {
  const south = magneticLatitude(lat, lon) < 0;
  return bearing({ lat, lon }, south ? { lat: -POLE.lat, lon: POLE.lon + 180 } : POLE);
}

export function distanceKm(a, b) {
  const p1 = a.lat * rad, p2 = b.lat * rad;
  const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(((b.lon - a.lon) * rad) / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(h));
}

/** Point reached by travelling distKm from a along bearingDeg. */
export function destination(a, bearingDeg, distKm) {
  const d = distKm / EARTH_KM, br = bearingDeg * rad, p1 = a.lat * rad, l1 = a.lon * rad;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(br));
  const l2 = l1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: p2 / rad, lon: ((l2 / rad + 540) % 360) - 180 };
}

const POINTS = ['north', 'north-northeast', 'northeast', 'east-northeast', 'east', 'east-southeast', 'southeast', 'south-southeast',
  'south', 'south-southwest', 'southwest', 'west-southwest', 'west', 'west-northwest', 'northwest', 'north-northwest'];

export function compass(deg) {
  return POINTS[Math.round(deg / 22.5) % 16];
}

export const EARTH_RADIUS_KM = EARTH_KM;
