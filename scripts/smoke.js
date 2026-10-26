// Quick end-to-end check of the forecast engine and Gemma skill. Run: npm test
import { buildForecast } from '../lib/forecast.js';
import { plan } from '../lib/gemma.js';

const cases = [
  { name: 'San Diego, live', lat: 32.88, lon: -117.23, mode: 'live' },
  { name: 'San Diego, May 2024 replay', lat: 32.88, lon: -117.23, mode: 'replay' },
  { name: 'Fairbanks, live', lat: 64.84, lon: -147.72, mode: 'live' },
];

for (const c of cases) {
  const t = Date.now();
  const f = await buildForecast(c);
  console.log(`\n== ${c.name} (${Date.now() - t} ms)`);
  console.log(`score ${f.score}/50 "${f.band}" ${f.verdict} | home ${f.home_score} | magLat ${f.location.mag_lat} | Kp max ${f.kp_max_tonight}`);
  console.log(`window ${f.best_window ? `${f.best_window.start}–${f.best_window.end}` : 'none'} | look ${f.look.direction} ≤${f.look.top_elevation_deg}° | expect ${f.expect.level} ${f.expect.colors} (reach ${f.expect.reach}, margin ${f.expect.margin_deg})`);
  console.log(`best spot`, f.best_spot, `| spots on land ${f.spots.length}`);
  console.log('timeline', f.timeline.map((h) => `${h.label}:${h.score}(kp${h.kp},c${h.cloud})`).join(' '));
  console.log('backstory', f.backstory);
  if (c.mode === 'replay') {
    const t2 = Date.now();
    const p = await plan(f);
    console.log(`plan via ${p.source} (${Date.now() - t2} ms, attempts ${p.attempts ?? '-'})${p.reason ? ` reason: ${p.reason}` : ''}`);
    console.log(JSON.stringify(p.plan, null, 2));
  }
}
