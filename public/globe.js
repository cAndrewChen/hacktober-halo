// 3D globe with an aurora heatmap (NOAA OVATION live, or Kp-modeled for replays).
// Earth uses NASA's night-lights texture, which doubles as a light-pollution map.

/* global THREE */
const rad = Math.PI / 180;
const EARTH = 'https://unpkg.com/three-globe@2.31.0/example/img/earth-night.jpg';

/** Unit vector for lat/lon matching three.js's default sphere UVs (lon 0 at +X, east toward -Z). */
export function latLonToVec(lat, lon, r = 1) {
  const phi = ((lon + 180) / 360) * 2 * Math.PI, theta = (90 - lat) * rad;
  return new THREE.Vector3(-Math.cos(phi) * Math.sin(theta) * r, Math.cos(theta) * r, Math.sin(phi) * Math.sin(theta) * r);
}

// green → yellow → red, like a weather heatmap.
function heatColor(v) {
  const stops = [[0, [40, 220, 120]], [0.5, [230, 240, 70]], [1, [255, 70, 70]]];
  const t = Math.min(1, v);
  const i = t < 0.5 ? 0 : 1;
  const k = (t - stops[i][0]) / (stops[i + 1][0] - stops[i][0]);
  return stops[i][1].map((c, j) => Math.round(c + (stops[i + 1][1][j] - c) * k));
}

/** Cloud opacity (0–CLOUD_MAX) from a GIBS clean-infrared pixel: gray brightness = cold, colors = very cold tops. */
function irCloud(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if ((max - min) / 255 > 0.2) return CLOUD_MAX; // enhanced colors only appear on cold cloud tops
  const lum = (r + g + b) / 765;
  return Math.max(0, Math.min(1, (lum - IR_CLEAR) / (IR_OPAQUE - IR_CLEAR))) * CLOUD_MAX;
}
// Gray levels for clear ground/ocean vs. thick cloud in the GIBS Band 13 palette, from sampling a live
// image: clear Arizona 0.29, clear E. Pacific 0.40, Australian desert at night 0.46; grays top out ~0.78
// before the cold-cloud colors begin. (Very cold polar ground can still read as thin cloud: an IR limit.)
const IR_CLEAR = 0.48, IR_OPAQUE = 0.75;
// Maximum cloud opacity: kept low so the night lights and aurora oval stay readable underneath.
const CLOUD_MAX = 0.35;

/** Cloud opacity (0–0.85·CLOUD_MAX) from a GIBS MODIS cloud-fraction pixel (purple 0 → red 1, by hue). */
function modisCloud(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max - min < 20) return null; // gray/white: no data
  let h;
  if (max === r) h = ((g - b) / (max - min) + 6) % 6;
  else if (max === g) h = (b - r) / (max - min) + 2;
  else h = (r - g) / (max - min) + 4;
  h *= 60;
  if (h >= 330) h = 0; // deep red wraps around the hue circle
  if (h > 250) return 0; // purple = clear
  // Capped lower than infrared: MODIS marks every fully cloudy 5 km cell solid, which buries the map.
  return (1 - h / 250) ** 1.3 * CLOUD_MAX * 0.85;
}

export class Globe {
  constructor(container, onPick) {
    this.container = container;
    this.onPick = onPick;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    container.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
    this.camera.position.set(0, 0, 4.2);
    this.group = new THREE.Group();
    this.scene.add(this.group);

    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');
    const earthMap = loader.load(EARTH, () => this.render());
    earthMap.generateMipmaps = false; // same antimeridian-seam fix as the heat layer below
    earthMap.minFilter = THREE.LinearFilter;
    this.earth = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64), new THREE.MeshBasicMaterial({ map: earthMap }));
    this.group.add(this.earth);

    // Satellite clouds sit just above the ground, under the aurora (which is ~100+ km up).
    this.cloudCanvas = document.createElement('canvas');
    this.cloudTexture = new THREE.CanvasTexture(this.cloudCanvas);
    this.cloudTexture.generateMipmaps = false;
    this.cloudTexture.minFilter = THREE.LinearFilter;
    this.clouds = new THREE.Mesh(new THREE.SphereGeometry(1.003, 96, 64), new THREE.MeshBasicMaterial({ map: this.cloudTexture, transparent: true, depthWrite: false }));
    this.clouds.visible = false;
    this.group.add(this.clouds);

    this.heatCanvas = document.createElement('canvas');
    this.heatTexture = new THREE.CanvasTexture(this.heatCanvas);
    // No mipmaps: at the sphere's UV seam (±180°) the GPU would sample a tiny, mostly transparent
    // mip level and draw a dark streak along the antimeridian.
    this.heatTexture.generateMipmaps = false;
    this.heatTexture.minFilter = THREE.LinearFilter;
    this.heat = new THREE.Mesh(new THREE.SphereGeometry(1.006, 96, 64), new THREE.MeshBasicMaterial({ map: this.heatTexture, transparent: true, depthWrite: false }));
    this.group.add(this.heat);

    // Thin atmosphere rim.
    this.scene.add(new THREE.Mesh(new THREE.SphereGeometry(1.06, 64, 48), new THREE.MeshBasicMaterial({ color: 0x3fb8c9, transparent: true, opacity: 0.08, side: THREE.BackSide })));

    this.markers = new THREE.Group();
    this.group.add(this.markers);
    this.#bindControls();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  /** points: [[lat, lon, value 0–100]], cell: grid spacing in degrees. */
  setHeat(points, cell) {
    const W = 720, H = 360, sx = W / 360, sy = H / 180;
    const small = document.createElement('canvas');
    small.width = W; small.height = H;
    const ctx = small.getContext('2d');
    for (const [lat, lon, v] of points) {
      const t = Math.min(1, v / 60);
      const [r, g, b] = heatColor(t);
      ctx.fillStyle = `rgba(${r},${g},${b},${0.12 + t * 0.5})`;
      // Wrap cells that straddle the ±180° edge so there's no seam on the antimeridian.
      const x = (lon + 180 - cell / 2) * sx, y = (90 - lat - cell / 2) * sy, w = cell * sx + 1, h = cell * sy + 1;
      ctx.fillRect(x, y, w, h);
      if (x < 0) ctx.fillRect(x + W, y, w, h);
      if (x + w > W) ctx.fillRect(x - W, y, w, h);
    }
    // Upscale with blur for a smooth heatmap.
    this.heatCanvas.width = 2048; this.heatCanvas.height = 1024;
    const big = this.heatCanvas.getContext('2d');
    big.clearRect(0, 0, 2048, 1024);
    // Pad with wrapped columns and blur once, so the blur flows across ±180° without a seam.
    // (Blurring separate copies side by side leaves a faded strip where they meet.)
    const pad = 40;
    const padded = document.createElement('canvas');
    padded.width = W + 2 * pad; padded.height = H;
    const pctx = padded.getContext('2d');
    for (const dx of [pad - W, pad, pad + W]) pctx.drawImage(small, dx, 0);
    const k = 2048 / W;
    big.filter = `blur(${Math.round(cell * 5)}px)`;
    big.drawImage(padded, -pad * k, 0, padded.width * k, 1024);
    big.filter = 'none';
    this.heatTexture.needsUpdate = true;
    this.render();
  }

  /**
   * Satellite cloud layer from NASA GIBS images (2:1 equirectangular, same projection as the globe).
   * ir: geostationary clean-infrared (brighter gray = colder = higher cloud; colors = very cold tops).
   * modis: MODIS cloud fraction (purple = clear → blue → green → yellow → red = overcast).
   * Infrared is used where it has data; MODIS fills the rest. Either may be null.
   */
  setClouds({ ir, modis }) {
    const W = 2048, H = 1024;
    const read = (img) => {
      if (!img) return null;
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, W, H);
      return ctx.getImageData(0, 0, W, H).data;
    };
    const a = read(ir), b = read(modis);
    this.cloudCanvas.width = W; this.cloudCanvas.height = H;
    const ctx = this.cloudCanvas.getContext('2d');
    const out = ctx.createImageData(W, H);
    for (let i = 0; i < W * H * 4; i += 4) {
      let alpha = null;
      if (a && a[i + 3] > 128) alpha = irCloud(a[i], a[i + 1], a[i + 2]);
      else if (b && b[i + 3] > 128) alpha = modisCloud(b[i], b[i + 1], b[i + 2]);
      if (!alpha) continue;
      out.data[i] = 238; out.data[i + 1] = 242; out.data[i + 2] = 250; out.data[i + 3] = Math.round(alpha * 255);
    }
    ctx.putImageData(out, 0, 0);
    this.cloudTexture.needsUpdate = true;
    this.clouds.visible = this.cloudsOn ?? true;
    this.render();
  }

  showClouds(on) {
    this.cloudsOn = on;
    this.clouds.visible = on && this.cloudCanvas.width > 0;
    this.render();
  }

  /** NOAA-style view line: [[lat, lon], …] per hemisphere, drawn as red lines just above the surface. */
  setViewLine(vl) {
    for (const l of this.viewLines ?? []) { this.group.remove(l); l.geometry.dispose(); }
    this.viewLines = [vl.north, vl.south].map((pts) => {
      const geo = new THREE.BufferGeometry().setFromPoints(pts.map(([lat, lon]) => latLonToVec(lat, lon, 1.009)));
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xff3b3b, transparent: true, opacity: 0.9 }));
      this.group.add(line);
      return line;
    });
    this.render();
  }

  setMarkers(home, spot) {
    this.markers.clear();
    const add = (p, color, size) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(size, 16, 12), new THREE.MeshBasicMaterial({ color }));
      m.position.copy(latLonToVec(p.lat, p.lon, 1.01));
      this.markers.add(m);
      const ring = new THREE.Mesh(new THREE.RingGeometry(size * 1.8, size * 2.4, 32), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6, side: THREE.DoubleSide }));
      ring.position.copy(latLonToVec(p.lat, p.lon, 1.011));
      ring.lookAt(latLonToVec(p.lat, p.lon, 2));
      this.markers.add(ring);
    };
    add(home, 0xffffff, 0.012);
    if (spot) add(spot, 0x4fe39b, 0.01);
    this.render();
  }

  /** Rotate so lat/lon faces the camera, tilted a little so the polar aurora oval is in view. */
  focus(lat, lon) {
    const v = latLonToVec(lat, lon);
    this.group.rotation.set(Math.max(-60, Math.min(60, lat + (lat >= 0 ? 12 : -12))) * rad, -Math.atan2(v.x, v.z), 0);
    this.render();
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  render() {
    // Keep markers about the same size on screen at any zoom (sized for the default distance 3.2).
    const s = Math.max(0.06, (this.camera.position.z - 1) / 3.2);
    for (const m of this.markers.children) m.scale.setScalar(s);
    this.renderer.render(this.scene, this.camera);
  }

  #pick(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hit = ray.intersectObject(this.earth)[0];
    // Sphere UVs: u runs with longitude from -180°, v from the south pole (0) to the north pole (1).
    if (hit?.uv) this.onPick?.(hit.uv.y * 180 - 90, hit.uv.x * 360 - 180);
  }

  #bindControls() {
    const el = this.renderer.domElement;
    el.style.touchAction = 'none';
    el.style.cursor = 'grab';
    let last = null, start = null;
    el.addEventListener('pointerdown', (e) => { el.setPointerCapture(e.pointerId); last = start = e; el.style.cursor = 'grabbing'; });
    // A click (no real drag) picks the point under the cursor.
    el.addEventListener('pointerup', (e) => {
      if (start && Math.hypot(e.clientX - start.clientX, e.clientY - start.clientY) < 5) this.#pick(e);
      start = null;
    });
    el.addEventListener('pointermove', (e) => {
      if (!last) return;
      const k = 0.005 * (this.camera.position.z - 1);
      this.group.rotation.y += (e.clientX - last.clientX) * k;
      this.group.rotation.x = Math.max(-1.4, Math.min(1.4, this.group.rotation.x + (e.clientY - last.clientY) * k));
      last = e;
      this.render();
    });
    const end = () => { last = null; el.style.cursor = 'grab'; };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      // Zoom is proportional to the distance from the surface, so it stays smooth up close.
      const z = this.camera.position.z;
      this.camera.position.z = Math.max(1.12, Math.min(6, z + (z - 1) * e.deltaY * 0.0015));
      this.render();
    }, { passive: false });
  }
}
