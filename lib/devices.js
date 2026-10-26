// Camera device profiles: what each kind of camera can and can't control at night.
// These are the ground truth Gemma works from (it adds model-specific details on top),
// and `gain` sets how much aurora the "phone camera" view shows relative to a full manual camera.

export const DEVICES = {
  iphone: {
    label: 'iPhone 11 or newer (Camera app)',
    can: ['Night mode on/off and its duration slider', 'Exposure compensation (brightness slider)', 'Tap-and-hold to lock focus and exposure (AE/AF Lock)', 'Lens choice (1x main lens collects the most light)', 'Flash and Live Photo off'],
    cannot: ['ISO', 'Exact shutter speed', 'Manual focus to infinity', 'White balance'],
    maxExposure: { handheld: 'a few seconds (up to ~10 s)', tripod: 'up to 30 s (only when the phone senses it is perfectly still)' },
    notes: 'Pro models (iPhone 12 Pro and newer Pro) can shoot ProRAW. Manual ISO/shutter needs a third-party camera app.',
    gain: { handheld: 0.55, tripod: 0.8 },
    iso: false,
  },
  iphone_old: {
    label: 'iPhone XS / XR or older',
    can: ['Exposure compensation', 'Tap-and-hold AE/AF Lock', 'Flash off'],
    cannot: ['Night mode (not available)', 'ISO', 'Long exposures in the Camera app', 'Manual focus'],
    maxExposure: { handheld: 'about 1/4 s', tripod: 'about 1/4 s in the Camera app; long exposures need a third-party app' },
    notes: 'The built-in camera cannot take long exposures, so aurora will barely register without a manual long-exposure app.',
    gain: { handheld: 0.2, tripod: 0.3 },
    iso: false,
  },
  pixel: {
    label: 'Google Pixel (Night Sight)',
    can: ['Night Sight mode', 'Astrophotography mode (starts automatically on a tripod, Pixel 4 and newer)', 'Brightness and shadows sliders', 'Tap to focus'],
    cannot: ['ISO in the default camera', 'Exact shutter speed in the default camera'],
    maxExposure: { handheld: 'a few seconds (Night Sight)', tripod: 'up to about 4 minutes (Astrophotography)' },
    notes: 'Newer Pro models also offer manual Pro controls (shutter, ISO, focus) in the Pixel camera.',
    gain: { handheld: 0.6, tripod: 1.0 },
    iso: false,
  },
  samsung: {
    label: 'Samsung Galaxy (Pro mode)',
    can: ['Pro mode: ISO', 'Pro mode: shutter speed up to 30 s', 'Pro mode: manual focus', 'Pro mode: white balance', 'Night mode'],
    cannot: ['Aperture (fixed on most models)'],
    maxExposure: { handheld: 'a few seconds in Night mode; Pro mode needs support beyond ~1/4 s', tripod: 'up to 30 s in Pro mode' },
    notes: 'Expert RAW (free Samsung app) adds RAW capture on supported Galaxy models.',
    gain: { handheld: 0.5, tripod: 0.9 },
    iso: true,
  },
  android: {
    label: 'Other Android phone',
    can: ['Night mode', 'Pro/Manual mode on many models (ISO, shutter, focus)', 'Exposure compensation'],
    cannot: ['Varies by model: check whether a Pro or Manual mode exists'],
    maxExposure: { handheld: 'a few seconds in Night mode', tripod: 'often up to 30 s in Pro mode, if available' },
    notes: 'Capabilities vary widely; if unsure, use Night mode.',
    gain: { handheld: 0.5, tripod: 0.75 },
    iso: null,
  },
  camera: {
    label: 'DSLR or mirrorless camera',
    can: ['ISO', 'Shutter speed', 'Aperture', 'Manual focus', 'White balance', 'RAW'],
    cannot: [],
    maxExposure: { handheld: 'about 1/15 s sharp handheld; aurora needs a tripod', tripod: '30 s or longer (Bulb)' },
    notes: 'Use the widest, fastest lens available (e.g. 14–24 mm at f/1.4–f/2.8).',
    gain: { handheld: 0.6, tripod: 1.0 },
    iso: true,
  },
};

export const DEFAULT_DEVICE = 'iphone';

export function deviceFrom(q) {
  const id = DEVICES[q.get('device')] ? q.get('device') : DEFAULT_DEVICE;
  const tripod = q.get('tripod') === '1';
  const model = (q.get('model') ?? '').trim().slice(0, 60);
  return { id, tripod, model, ...DEVICES[id], key: `${id}|${tripod ? 1 : 0}|${model.toLowerCase()}` };
}

export const deviceList = () => Object.entries(DEVICES).map(([id, d]) => ({ id, label: d.label, gain: d.gain }));
