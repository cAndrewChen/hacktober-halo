// Gemma, driven by Halo's skills:
//   skills/halo-guide  — tonight's plan
//   skills/halo-camera — device-specific camera settings
// Local weights run through Ollama when a Gemma model is pulled. The Gemini API is the fallback.
// Each skill's SKILL.md body (plus its schema.json) is the system instruction. Every reply is validated
// against the schema and the skill's rules; failures are retried with the validator's complaint,
// then fall back to a template with the same shape so the UI never breaks.

import { readFileSync } from 'node:fs';

const MODEL = process.env.GEMMA_MODEL || 'gemma-4-26b-a4b-it';
const OLLAMA_HOST = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');

/** Drop Agent Skills YAML frontmatter so the model sees the instructions only. */
function skillBody(markdown) {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

function loadSkill(name) {
  const raw = readFileSync(new URL(`../skills/${name}/SKILL.md`, import.meta.url), 'utf8');
  const schema = JSON.parse(readFileSync(new URL(`../skills/${name}/schema.json`, import.meta.url), 'utf8'));
  const skill = skillBody(raw);
  return { name, schema, system: `${skill}\n\n## schema.json (your output must match this exactly)\n\n${JSON.stringify(schema)}` };
}
const GUIDE = loadSkill('halo-guide');
const CAMERA = loadSkill('halo-camera');

// Camera table from the guide skill, applied in code so Gemma copies numbers instead of doing arithmetic.
const ISO = { none: 3200, camera_only: 3200, faint: 3200, visible: 1600, vivid: 800 };
const SHUTTER = { none: 15, camera_only: 15, faint: 10, visible: 6, vivid: 3 };
const cameraFor = (level, moonBright) => ({ iso: moonBright && ISO[level] > 400 ? ISO[level] / 2 : ISO[level], shutter_s: SHUTTER[level] });

// ---------- Shared validation ----------

const words = (s) => String(s ?? '').trim().split(/\s+/).filter(Boolean);
const get = (o, path) => path.split('.').reduce((v, k) => v?.[k], o);

/** True if any 3-word phrase repeats 3+ times — the signature of a generation loop. */
function loops(text) {
  const w = words(text.toLowerCase());
  const seen = new Map();
  for (let i = 0; i + 2 < w.length; i++) {
    const g = w.slice(i, i + 3).join(' ');
    seen.set(g, (seen.get(g) ?? 0) + 1);
    if (seen.get(g) >= 3) return true;
  }
  return false;
}

/** Schema walk: required keys at every level, right primitive types, no extra keys. */
function schemaErrors(schema, value) {
  const errors = [];
  const check = (s, v, path) => {
    const type = { STRING: 'string', NUMBER: 'number', INTEGER: 'number', BOOLEAN: 'boolean' }[s.type];
    if (type && (typeof v !== type || v === '')) return errors.push(`${path} must be a non-empty ${s.type.toLowerCase()}`);
    if (s.type === 'ARRAY' && !Array.isArray(v)) return errors.push(`${path} must be an array`);
    if (s.type === 'ARRAY') return v.forEach((x, i) => check(s.items, x, `${path}[${i}]`));
    if (s.type === 'OBJECT') {
      if (!v || typeof v !== 'object') return errors.push(`missing ${path}`);
      for (const k of s.required ?? []) check(s.properties[k], v[k], path ? `${path}.${k}` : k);
      const extra = Object.keys(v).filter((k) => !s.properties[k]);
      if (extra.length) errors.push(`unexpected keys: ${extra.join(', ')}`);
    }
  };
  check(schema, value, '');
  if (loops(JSON.stringify(value))) errors.push('you repeated the same phrase over and over; write each field once, concisely');
  return errors;
}

const limitErrors = (obj, limits) =>
  Object.entries(limits).filter(([path, max]) => words(get(obj, path)).length > max).map(([path, max]) => `${path} is too long (limit ${max - 10} words)`);

const colorErrors = (text, colors) =>
  ['green', 'red', 'pink', 'purple', 'blue'].filter((c) => !colors.includes(c) && new RegExp(`\\b${c}\\b`, 'i').test(text)).map((c) => `do not mention ${c}; colors must come from (${colors.join(', ')})`);

// ---------- Gemma call + retry loop ----------

const userText = (facts, feedback) =>
  `facts = ${JSON.stringify(facts)}${feedback ? `\n\nYour previous answer was rejected: ${feedback}. Fix it and return the full JSON again.` : ''}\n\nRespond with the JSON object only. Start with { — no notes, no reasoning, no markdown.`;

function parseModelJson(out) {
  const start = out.indexOf('{'), end = out.lastIndexOf('}');
  return JSON.parse(start >= 0 && end > start ? out.slice(start, end + 1) : out);
}

// Prefer a pulled Gemma model. A miss is remembered briefly so a later `ollama pull` is picked up
// without probing on every request while Ollama is down.
let ollamaModel = null;
let ollamaMissUntil = 0;

async function resolveOllama() {
  if (ollamaModel) return ollamaModel;
  if (Date.now() < ollamaMissUntil) return null;
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error(String(res.status));
    const tags = ((await res.json()).models ?? []).map((m) => m.name);
    const want = (process.env.OLLAMA_MODEL || '').trim();
    const size = (n) => Number(n.match(/(\d+(?:\.\d+)?)b/i)?.[1] ?? 99);
    const hit = want
      ? tags.find((n) => n === want || n.startsWith(`${want}:`))
      : tags.filter((n) => /gemma/i.test(n)).sort((a, b) => size(a) - size(b))[0];
    if (!hit) throw new Error(want ? `${want} is not pulled` : 'no Gemma model pulled');
    ollamaModel = hit;
    return hit;
  } catch (err) {
    ollamaMissUntil = Date.now() + 30e3;
    console.warn(`Ollama: ${err.message}`);
    return null;
  }
}

/** What /api/status and the startup line report. */
export async function gemmaStatus() {
  const local = await resolveOllama();
  const cloud = !!process.env.GEMINI_API_KEY;
  return {
    gemma: !!(local || cloud),
    local: !!local,
    api: cloud,
    model: local,
    cloud_model: cloud ? MODEL : null,
    label: local ? `local via Ollama (${local})` : cloud ? `cloud (${MODEL})` : 'off (run Ollama with a Gemma model, or set GEMINI_API_KEY)',
  };
}

async function callOllama(model, skill, facts, feedback) {
  let res;
  try {
    res = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        format: 'json',
        keep_alive: '10m',
        messages: [
          { role: 'system', content: skill.system },
          { role: 'user', content: userText(facts, feedback) },
        ],
        options: { temperature: 1.0, top_p: 0.95, top_k: 64, num_predict: 700 },
      }),
      signal: AbortSignal.timeout(120e3),
    });
  } catch (err) {
    ollamaModel = null;
    throw new Error(`Ollama unreachable: ${err.message}`);
  }
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    if (res.status === 404) ollamaModel = null;
    throw new Error(`Ollama ${res.status}: ${detail}`);
  }
  const body = await res.json();
  const out = body.message?.content ?? '';
  try {
    return parseModelJson(out);
  } catch (err) {
    if (process.env.HALO_DEBUG) console.warn('raw ollama output:', out.slice(0, 1500));
    throw err;
  }
}

async function callGemma(skill, facts, feedback) {
  const text = userText(facts, feedback);
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: skill.system }] },
      contents: [{ role: 'user', parts: [{ text }] }],
      // Gemma's recommended sampling (temp 1.0, topP 0.95, topK 64). Server-side schema enforcement
      // (responseSchema) made Gemma 4 degenerate into repetition loops, so the schema is given in the
      // system prompt instead and enforced by our validators.
      generationConfig: { responseMimeType: 'application/json', temperature: 1.0, topP: 0.95, topK: 64, maxOutputTokens: 700 },
    }),
    signal: AbortSignal.timeout(25e3),
  });
  if (!res.ok) throw new Error(`Gemma ${res.status}: ${(await res.text()).slice(0, 2000)}`);
  const body = await res.json();
  const out = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  try {
    // Tolerate stray notes or code fences around the object.
    return parseModelJson(out);
  } catch (err) {
    if (process.env.HALO_DEBUG) console.warn('raw gemma output:', out.slice(0, 1500));
    throw err;
  }
}

const MAX_ATTEMPTS = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const trimAll = (o) => JSON.parse(JSON.stringify(o, (_, v) => (typeof v === 'string' ? v.trim() : v)));

/**
 * Runs a skill: up to 3 sequential attempts, each retry told what failed.
 * prefer 'local' uses only Ollama. prefer 'api' uses only the Gemini key.
 * With no preference, Ollama is tried first and Gemini is the fallback.
 */
async function runSkill(skill, facts, validate, template, prefer) {
  const cloud = !!process.env.GEMINI_API_KEY;
  const local = prefer === 'api' ? null : await resolveOllama();
  let chosen = prefer === 'api' || prefer === 'local' ? prefer : (local ? 'local' : 'api');
  if (chosen === 'local' && !local) return { source: 'template', backend: 'local', reason: 'local Gemma is not running', result: template(facts) };
  if (chosen === 'api' && !cloud) return { source: 'template', backend: 'api', reason: 'GEMINI_API_KEY not set', result: template(facts) };
  let backend = chosen === 'local' ? 'ollama' : 'gemini';
  let feedback = null;
  for (let n = 1; n <= MAX_ATTEMPTS; n++) {
    try {
      const out = trimAll(backend === 'ollama' ? await callOllama(local, skill, facts, feedback) : await callGemma(skill, facts, feedback));
      const errors = [...schemaErrors(skill.schema, out), ...validate(out, facts)];
      if (!errors.length) return { source: backend === 'ollama' ? local : MODEL, backend: chosen, attempts: n, result: out };
      throw new Error(errors.join('; '));
    } catch (err) {
      if (backend === 'ollama' && prefer !== 'local' && /Ollama unreachable/.test(err.message) && cloud) {
        backend = 'gemini';
        chosen = 'api';
        feedback = null;
        n -= 1;
        continue;
      }
      if (/Gemma 429/.test(err.message)) {
        const wait = Number(err.message.match(/"retryDelay":\s*"(\d+)s"/)?.[1] ?? 10);
        if (wait > 20) return { source: 'template', backend: chosen, reason: 'Gemma rate limit reached', result: template(facts) };
        await sleep(wait * 1000);
      } else {
        feedback = /JSON/.test(err.message) ? 'your output was cut off by repetition; write each field once and keep it short' : err.message;
      }
      console.warn(`${skill.name} attempt ${n} failed: ${err.message.slice(0, 160)}`);
    }
  }
  return { source: 'template', backend: chosen, reason: feedback, result: template(facts) };
}

// ---------- Skill: halo-guide (tonight's plan) ----------

/** The compact facts object Gemma is allowed to talk about. */
export function factsFrom(f) {
  return {
    mode: f.mode === 'replay' ? 'Replay of the May 10, 2024 storm' : 'Live forecast for tonight',
    verdict: f.verdict,
    halo_score: f.score,
    halo_score_max: f.scale_max,
    band: f.band,
    band_meaning: f.band_meaning,
    home_score: f.home_score,
    best_window: f.best_window ? { start: f.best_window.start, end: f.best_window.end } : null,
    kp_max_tonight: f.kp_max_tonight,
    look: { direction: f.look.direction, top_elevation_deg: f.look.top_elevation_deg, fists: Math.max(1, Math.round(f.look.top_elevation_deg / 10)), overhead: f.look.overhead },
    camera: cameraFor(f.expect.level, f.moon.bright),
    expect: { level: f.expect.level, colors: f.expect.colors, hidden_by: f.expect.reason },
    sky_at_view: { time: f.view.label, chosen_because: f.view.why, sun_altitude_deg: f.view.sun_alt, phase: f.view.phase, cloud_pct: f.view.cloud_pct },
    never_gets_dark: f.no_night,
    moon: f.moon,
    best_spot: f.best_spot && { worth_driving: f.best_spot.worth_driving, direction: f.best_spot.direction, distance_mi: f.best_spot.distance_mi, score: f.best_spot.score },
    clouds_at_best_hour_pct: f.timeline.find((t) => t.ms === f.best_window?.startMs)?.cloud ?? null,
    backstory: f.backstory.items,
  };
}

function validatePlan(plan, facts) {
  const errors = [];
  if (plan.verdict !== facts.verdict) errors.push(`verdict must be ${facts.verdict}`);
  if (!Array.isArray(plan.checklist) || plan.checklist.length < 3 || plan.checklist.length > 5) errors.push('checklist must have 3-5 items');
  else if (plan.checklist.some((c) => words(c).length > 12)) errors.push('checklist items must be 8 words or fewer');
  if (typeof plan.headline === 'string' && plan.headline.length > 90) errors.push('headline must be 70 characters or fewer');
  errors.push(...limitErrors(plan, { summary: 55, 'expect.naked_eye': 40, 'expect.camera': 40, 'camera.tip': 35, why_tonight: 55 }));
  if (/%|percent/i.test(`${plan.summary} ${plan.headline}`)) errors.push('never describe the Halo Score as a percent');
  if (plan.camera?.iso !== facts.camera.iso || plan.camera?.shutter_s !== facts.camera.shutter_s) errors.push(`camera.iso and camera.shutter_s must be copied from facts.camera (${facts.camera.iso}, ${facts.camera.shutter_s})`);
  errors.push(...colorErrors(`${plan.expect?.naked_eye} ${plan.expect?.camera}`, facts.expect.colors));
  // When something hides the aurora, the plan must say what (sunlight, twilight, clouds, moon).
  const hidden = facts.expect.hidden_by;
  if (hidden && facts.expect.level === 'none') {
    const keys = ['bright', 'twilight', 'sun', 'cloud', 'moon', 'reach', 'far'].filter((k) => hidden.includes(k));
    if (!keys.some((k) => new RegExp(k, 'i').test(`${plan.summary} ${plan.expect?.naked_eye}`))) errors.push(`summary or expect.naked_eye must say why nothing is visible: ${hidden}`);
  }
  return errors;
}

/** Deterministic plan with the same shape, used if Gemma is unreachable or keeps failing validation. */
function templatePlan(facts) {
  const lvl = facts.expect.level;
  const drive = facts.best_spot?.worth_driving;
  return {
    headline: facts.verdict === 'SKIP' ? 'Not tonight: stay in and check again tomorrow' : `Look ${facts.look.direction} ${facts.best_window ? `from ${facts.best_window.start}` : 'tonight'}`,
    verdict: facts.verdict,
    summary: `Tonight rates "${facts.band}" (${facts.halo_score}/50): ${facts.band_meaning}`,
    when: facts.best_window ? `${facts.best_window.start} – ${facts.best_window.end}` : 'No good window tonight',
    where: drive ? `Drive about ${facts.best_spot.distance_mi} mi ${facts.best_spot.direction} to the marked spot` : `Somewhere dark near you with a clear view ${facts.look.direction}`,
    look: {
      direction: facts.look.direction,
      height: facts.expect.level === 'none'
        ? 'No aurora expected tonight'
        : facts.look.overhead
          ? 'High in the sky, possibly overhead'
          : `Low — up to about ${facts.look.top_elevation_deg}° above the horizon (about ${facts.look.fists} fists at arm's length)`,
    },
    expect: {
      naked_eye: { none: facts.expect.hidden_by ? `Nothing visible: ${facts.expect.hidden_by}.` : 'Nothing visible tonight.', camera_only: 'Probably nothing to the eye.', faint: 'A pale gray-white glow low on the horizon.', visible: `A clear glow, maybe faintly ${facts.expect.colors[0]}.`, vivid: 'Bright, moving, colorful curtains.' }[lvl],
      camera: lvl === 'none' ? 'Nothing, even on long exposures.' : `A ${facts.expect.colors.join(' and ')} glow on a ${facts.camera.shutter_s}-second exposure.`,
    },
    camera: { ...facts.camera, aperture: 'f/2.8 or widest', focus: 'Manual, infinity (focus on a bright star)', tip: 'Use Night mode and keep the phone perfectly still.' },
    why_tonight: facts.backstory[0] ?? 'Solar activity data unavailable.',
    checklist: ['Charge your phone', `Find a dark view ${facts.look.direction}`, 'Let your eyes adjust for 20 minutes', 'Bring a warm layer'],
  };
}

export async function plan(forecast, prefer) {
  const facts = factsFrom(forecast);
  const { result, ...meta } = await runSkill(GUIDE, facts, validatePlan, templatePlan, prefer);
  return { ...meta, plan: result, facts };
}

// ---------- Skill: halo-camera (settings for the user's own device) ----------

export function cameraFacts(f, device) {
  return {
    device: { label: device.label, can: device.can, cannot: device.cannot, maxExposure: device.maxExposure, notes: device.notes },
    model: device.model,
    tripod: device.tripod,
    tonight: {
      level: f.expect.level, colors: f.expect.colors, hidden_by: f.expect.reason, direction: f.look.direction, top_elevation_deg: f.look.top_elevation_deg,
      overhead: f.look.overhead, moon_bright: f.moon.bright, time: f.view.label, sky_phase: f.view.phase, cloud_pct: f.view.cloud_pct,
    },
    manual_baseline: cameraFor(f.expect.level, f.moon.bright),
  };
}

function validateCamera(c, facts) {
  const errors = [];
  if (c.settings?.length < 3 || c.settings?.length > 7) errors.push('settings must have 3-6 rows');
  if (c.steps?.length < 3 || c.steps?.length > 6) errors.push('steps must have 3-6 items');
  else if (c.steps.some((s) => words(s).length > 22)) errors.push('each step must be 16 words or fewer');
  if (c.cannot_change?.length > 5) errors.push('cannot_change must have 0-4 items');
  errors.push(...limitErrors(c, { expect: 40, tip: 35 }));
  // Ground truth check: nothing the device profile says it can't do may be marked adjustable.
  for (const s of c.settings ?? []) {
    if (!s.adjustable) continue;
    const name = String(s.name).toLowerCase();
    // Focus is only "blocked" when they claim manual/infinity focus (tap-to-lock is allowed on phones).
    const key = ['iso', 'shutter', 'white balance', 'aperture', 'night mode'].find((k) => name.includes(k))
      ?? (name.includes('focus') && /manual|infinity/i.test(s.value) ? 'manual focus' : null);
    const blocked = key && facts.device.cannot.find((x) => x.toLowerCase().includes(key));
    if (blocked) errors.push(`"${s.name}" cannot be changed on this device (profile says: ${blocked}); set adjustable to false and value "Auto"`);
  }
  errors.push(...colorErrors(`${c.expect}`, facts.tonight.colors));
  return errors;
}

function templateCamera(facts) {
  const manual = facts.device.can.some((x) => /^(Pro mode: )?ISO$/i.test(x)) || facts.device.can.includes('ISO');
  const b = facts.manual_baseline;
  return {
    device: facts.model || facts.device.label,
    mode: manual ? 'Pro / Manual mode' : 'Night mode',
    settings: manual
      ? [{ name: 'ISO', value: String(b.iso), adjustable: true }, { name: 'Shutter', value: `${b.shutter_s} s`, adjustable: true }, { name: 'Focus', value: 'Manual, infinity', adjustable: true }]
      : [{ name: 'Night mode', value: facts.tripod ? 'Max' : 'Auto', adjustable: true }, { name: 'ISO', value: 'Auto', adjustable: false }, { name: 'Shutter', value: 'Auto', adjustable: false }],
    steps: [`Face ${facts.tonight.direction} with a clear view`, 'Turn the flash off', facts.tripod ? 'Mount the camera on the tripod' : 'Brace the camera against something solid', 'Take the shot and hold still until it finishes'],
    cannot_change: facts.device.cannot.slice(0, 4),
    expect: facts.tonight.level === 'none' ? 'Nothing to capture tonight.' : `A ${facts.tonight.colors.join(' and ')} glow toward the ${facts.tonight.direction}.`,
    tip: 'Use a self-timer so pressing the shutter does not shake the camera.',
  };
}

export async function cameraAdvice(forecast, device, prefer) {
  const facts = cameraFacts(forecast, device);
  const { result, ...meta } = await runSkill(CAMERA, facts, validateCamera, templateCamera, prefer);
  return { ...meta, camera: result, facts };
}
