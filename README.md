# Halo

**Aurora apps give you a percentage. Halo shows first-timers what tonight's sky will *actually* look like, where to stand, and how to shoot it.**

- **Halo Score (0–50):** one rating for tonight that combines how close the aurora oval gets to you, cloud cover, darkness and moonlight. It is deliberately *not* out of 100, so nobody mistakes it for a percent chance.
- **What you'll see, in 3D:** a 360° sky dome you can drag around and zoom, as seen by your eyes vs. your own camera. The view comes from the real numbers (aurora height above your horizon, colors at your latitude, brightness, and your device's exposure limits). Grok Imagine paints it when connected; otherwise Halo paints it itself.
- **Tonight's plan (Gemma 4):** when, where, which direction, how high to look, honest expectations and a checklist, always in the same format (see [the guide skill](skills/halo-guide/SKILL.md)).
- **Your camera (Gemma 4):** pick your device type and exact model, and say whether you have a tripod. Gemma gives the mode, settings and tap-by-tap steps, and marks what your device can't change (see [the camera skill](skills/halo-camera/SKILL.md)).
- **Aurora map:** a 3D globe heatmap of the aurora oval over NASA night lights (which double as a light-pollution map), plus a "Where to go" heatmap of Halo Scores within 200 km with the best spot starred.
- **Why tonight:** the solar flares and CMEs behind tonight's activity (NASA DONKI, with NOAA as fallback).
- **Replay mode:** the real May 10, 2024 G5 storm (GFZ Kp history and archived cloud cover), so the demo works on a quiet night.

## Design

Halo is meant to look like a field instrument you use outdoors at night: flat, dense, technical readouts with no decoration. Every choice ties back to the project:

- **Color comes from the aurora itself.** The accent `#9fe830` is the 557.7 nm oxygen emission (aurora green), toned down slightly for screens. The score ramp goes gray → dim 630 nm red → red → green → bright green, which mirrors what you'd actually see at each level. Neutrals are near-black and gray, not navy.
- **Type: IBM Plex Sans + IBM Plex Mono**, a family built for technical interfaces. Monospace digits keep scores, Kp and times aligned like instrument readouts.
- **Shape:** 2 px radius for controls and 4 px for panels. No pills, no glow, and outline SVG icons (`public/icons.js`) instead of emoji.
- **Kept on purpose:** the globe's green → yellow → red heat scale follows NOAA's own aurora forecast map, so it's marked `unslop-ignore`.

The unslop-ui scanner reports "Clean, no tells detected" (score 0). To rerun it on Windows:

```bash
python -X utf8 ~/.claude/skills/unslop-ui/scripts/devibe_scan.py public
```

## Run it

Requires Node 20.6 or newer. There are no dependencies to install.

```bash
npm start
```

Then open http://localhost:3000.

`npm test` runs a quick end-to-end check (San Diego live, San Diego May 2024 replay, Fairbanks live).

### `.env`

```
OLLAMA_HOST=http://127.0.0.1:11434    # local Gemma. Halo uses this when a Gemma model is pulled
OLLAMA_MODEL=gemma3:1b                # optional; otherwise the smallest pulled Gemma model
GEMINI_API_KEY=...        # the API key side of the Local / API key toggle
XAI_API_KEY=...           # optional: Grok Imagine sky images
NASA_API_KEY=...          # optional: avoids DEMO_KEY rate limits on DONKI (api.nasa.gov)
GEMMA_MODEL=gemma-4-26b-a4b-it        # cloud model, used when the toggle is on API key
XAI_IMAGE_MODEL=grok-imagine-image-2.0 # optional override
```

### Local Gemma (Ollama)

Halo runs Gemma's weights on this machine when Ollama is up. Install it from [ollama.com](https://ollama.com), then:

```bash
ollama pull gemma3:1b
```

`gemma3:1b` is about 800 MB. Restart `npm start`. The startup line should say `Gemma: local via Ollama (gemma3:1b)`. The header toggle switches plans and camera advice between that local model and the Gemini API key. Each side is requested on its own, and a missing side falls back to the template.

`.env` is in `.gitignore`. Never commit it.

## Connecting Grok Imagine

A Grok Premium / SuperGrok subscription is for the Grok app and doesn't come with an API key. The API is set up separately:

1. Go to **console.x.ai** and sign in with the same X/Grok account.
2. Check whether you have **API credits**. The hackathon's SpaceX AI track mentioned redeemable grants, so ask the SpaceX AI ambassador how to apply the hackathon credit to your API account. Otherwise you'll need to add a small amount of credit.
3. Open **API Keys → Create API key**, then copy it.
4. Add `XAI_API_KEY=xai-...` to `.env` and restart `npm start`. The startup line should say `Grok Imagine: on`.

Halo calls `POST https://api.x.ai/v1/images/generations` with model `grok-imagine-image-2.0` and `aspect_ratio: "2:1"`, making one panorama per location for the naked eye and one per location and device for the camera view.

### The sky dome projection

Panoramas are **equirectangular** (2:1): x = compass bearing (360°), y = elevation (zenith at the top, horizon on the center line, straight down at the bottom). Mercator can't be used because it never reaches the poles, which here means the point straight overhead. Equirectangular maps directly onto a sphere. The viewer (`public/dome.js`) puts it on the inside of a sphere mirrored in x (`geometry.scale(-1, 1, 1)`), so it reads correctly from inside. The image's center always faces the aurora's bearing. Halo blends the left/right seam and paints compass labels and elevation ticks onto the image, so they stay accurate whichever renderer made it. Grok places the aurora approximately, not to the exact degree. If the model name has changed, set `XAI_IMAGE_MODEL`. If the call fails, the app keeps showing the canvas renderer and the error reason is in `/api/sky`.

## How the Halo Score works

```
score = 50 × reach^0.75 × clear × dark × moon
```

| Part | Source | Meaning |
|---|---|---|
| `reach` 0–1 | NOAA Kp forecast (3-hourly) + your geomagnetic latitude; live NOAA OVATION for the current hour | How close the aurora oval's edge gets. Full when you're under it, fades to 0 about 14° of geomagnetic latitude equatorward. |
| `clear` 0–1 | Open-Meteo hourly cloud cover | 1 − cloud fraction |
| `dark` 0–1 | Sun altitude (computed) | `((−sunAlt − 6) / 12)^1.3`, clamped: 0 above −6° (civil twilight is too bright), 0.10 at −8°, 0.41 at −12°, 1 at −18° |
| `moon` 0.65–1 | Moon altitude and phase (computed) | Bright moon above the horizon washes out faint aurora |

| Score | Band | Meaning |
|---|---|---|
| 0–4 | Stay in | No realistic chance from here tonight. |
| 5–14 | Long shot | A camera may catch a faint glow low on the horizon. Your eyes probably won't. |
| 15–24 | Worth a look | Cameras should catch it. Eyes may see a pale glow on the horizon. |
| 25–34 | Good night | Visible to the eye. Cameras show strong color. |
| 35–50 | Go now | Strong, colorful aurora, possibly overhead. |

**Sunlight is part of what you see, not just the score.** The sky view, the eyes vs. camera brightness level and Gemma's text all describe one specific hour: the best-scoring hour, or the darkest hour if nothing scores. The sun's position at that hour sets the sky (daylight, twilight glow at the sun's real bearing, or night), and that hour's cloud cover is drawn too. If the sun never gets 6° below the horizon (e.g. Iceland in May), the timeline shows the darkest hours anyway, and everything explains that the night stays in twilight. Check it with `node --env-file=.env scripts/sun-check.js` (Reykjavik during the May 2024 storm: the sun only reaches −8° and it's overcast, so the score is 0 and the view shows no aurora).

**Globe:** the heatmap shows where aurora is *overhead* (NOAA OVATION live). Replays use a modeled oval: a band from `66 − 1.25·Kp` to `80 − 0.5·Kp` degrees of geomagnetic latitude, calibrated to NOAA's forecast map from May 10, 2024 (Kp 8: southern edge at the US–Canada border). The red line is NOAA's "view line" (`66.5 − 2.05·Kp`), the farthest point from which aurora may be seen low on the horizon. The Halo Score's reach uses this same line. Halo uses a simplified (dipole) magnetic field, so the line runs about 2° north of NOAA's on the US West Coast, and the model ignores the oval's day/night lopsidedness.

**Satellite clouds on the globe** (toggle: "☁ Satellite clouds", off by default) come from NASA GIBS through `/api/satellite`:
- **Live:** GOES-East, GOES-West and Himawari clean-infrared (Band 13), updated every 10 min, day and night. Brighter gray means colder, higher cloud; colors mark very cold tops. GIBS has no Meteosat, so Europe, Africa and the Middle East are filled from the previous night's MODIS cloud fraction.
- **Replay:** MODIS (Terra + Aqua) nighttime cloud fraction for May 11, 2024 UTC. GIBS keeps only about 90 days of geostationary imagery.
- **Caching:** images are cached for 10 min, and dated images are kept in `cache/` permanently.
- **Limitations:** infrared can miss warm, low cloud and may show very cold polar ground as thin cloud. The Halo Score itself still uses Open-Meteo's cloud forecast, since you need *tonight's* clouds, not the current picture.

**Map:** "Where to go" shows the 32 scored spots within 200 km as colored dots, with the best spot starred. Click the map or the globe to check any spot.

Sanity checks: San Diego on a normal night (Kp 2–3) scores 0. San Diego on May 10, 2024 (Kp 9, clear) scores about 16 at home, and a high-desert spot 200 km north scores 27. Fairbanks under the oval with clear sky scores in the 20s–40s.

## The Gemma skill

`skills/halo-guide/SKILL.md` and `skills/halo-camera/SKILL.md` are Agent Skills (YAML `name` and `description`, then the instructions). `schema.json` beside each one is the output schema. `lib/gemma.js` strips the frontmatter and sends the instructions as the system prompt:

1. Sends only a compact `facts` object computed by the engine, so Gemma never invents numbers.
2. Validates every reply: required fields, verdict must match the score band, word limits, no "percent" language, colors only from the facts, and loop detection.
3. Retries with the validator's exact complaint, up to 3 attempts, and waits when rate-limited.
4. Falls back to a template plan with the same shape, so the UI never breaks. The badge shows which one you got.

The free Gemini API tier allows about 16k input tokens per minute for Gemma (roughly 6 plans). Plans are cached for 5 minutes per location.

## Limitations (be upfront with judges)

- The Kp to oval-edge mapping and the "reach" fade are simplified models, not NOAA's full product.
- No light-pollution data. The best spot is chosen by clouds, darkness and aurora reach only.
- Drive times are straight-line estimates (×1.3 at 75 km/h).
- Open water is filtered out using Open-Meteo elevation, which is approximate along coasts.
- NASA DONKI was unreachable while this was built, so the app falls back to NOAA GOES flare data (live) or a cached May 2024 summary (replay).

## Project layout

```
server.js              HTTP server and API routes (/api/forecast, /api/plan, /api/sky, /api/geocode)
lib/forecast.js        Builds tonight: hourly scores, best window, where-to-drive search
lib/score.js           Halo Score, bands, expectations, aurora height geometry
lib/astro.js           Sun and moon position
lib/geo.js             Geomagnetic latitude, bearings, distances
lib/sources.js         NOAA, GFZ, Open-Meteo and DONKI fetchers (cached)
lib/gemma.js           Gemma 4 client: skill, validation, retries, fallback
lib/grok.js            Grok Imagine client and panorama prompts
lib/devices.js         Camera/phone profiles: what each can and can't control
skills/halo-guide/     Gemma skill: tonight's plan (SKILL.md + schema.json)
skills/halo-camera/    Gemma skill: settings for your exact device
public/                Frontend (no build step): app.js, panorama.js (equirectangular painter),
                       dome.js (3D sky viewer), globe.js (3D heatmap globe), styles.css
```
