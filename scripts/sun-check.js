// Checks the sunlight handling: Reykjavik vs San Diego during the May 10, 2024 storm replay.
import { buildForecast } from '../lib/forecast.js';
for (const [name, lat, lon] of [['Reykjavik', 64.15, -21.94], ['San Diego', 32.88, -117.23], ['Fairbanks', 64.84, -147.72]]) {
  const f = await buildForecast({ lat, lon, mode: 'replay' });
  console.log(`\n${name}: home ${f.home_score}/50 "${f.band}" brightNight=${f.no_night} | view ${f.view.label} (${f.view.why}) sun ${f.view.sun_alt}° ${f.view.phase}, clouds ${f.view.cloud_pct}%`);
  console.log(`  expect ${f.expect.level} ${f.expect.colors} reason=${f.expect.reason} | spot`, f.best_spot && `${f.best_spot.score} worth=${f.best_spot.worth_driving}`);
  console.log('  timeline', f.timeline.map((h) => `${h.label}:${h.score}(sun${h.sun_alt},c${h.cloud})`).join(' '));
}
