// 3D sky dome: an equirectangular panorama on the inside of a sphere, drag to look, scroll to zoom.
// Azimuth/elevation are tracked in compass terms; the texture's center faces `centerBearing`.

/* global THREE */
const rad = Math.PI / 180;
const POINTS = ['north', 'north-northeast', 'northeast', 'east-northeast', 'east', 'east-southeast', 'southeast', 'south-southeast',
  'south', 'south-southwest', 'southwest', 'west-southwest', 'west', 'west-northwest', 'northwest', 'north-northwest'];

export class Dome {
  constructor(container, onView) {
    this.container = container;
    this.onView = onView;
    this.center = 0; // bearing at the panorama's center
    this.az = 0; this.el = 10; this.fov = 75;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    container.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(this.fov, 16 / 9, 1, 1100);
    // Flip x so the texture reads correctly from inside (standard equirectangular panorama setup).
    const geo = new THREE.SphereGeometry(500, 96, 48);
    geo.scale(-1, 1, 1);
    this.texture = null;
    this.mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x000000 }));
    this.scene.add(this.mesh);
    this.#bindControls();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  setPanorama(canvas, centerBearing) {
    this.center = centerBearing;
    this.texture?.dispose();
    this.texture = new THREE.CanvasTexture(canvas);
    this.texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    this.mesh.material.dispose();
    this.mesh.material = new THREE.MeshBasicMaterial({ map: this.texture });
    this.render();
  }

  /** Point the view at a compass bearing and elevation. */
  look(az, el = this.el) {
    this.az = ((az % 360) + 360) % 360;
    this.el = Math.max(-35, Math.min(89, el));
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
    // Texture center (bearing `center`) sits at three.js longitude 180°; longitude grows with azimuth.
    const lon = (180 + this.az - this.center) * rad, lat = this.el * rad;
    this.camera.fov = this.fov;
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon));
    this.renderer.render(this.scene, this.camera);
    this.onView?.({ az: this.az, el: this.el, heading: POINTS[Math.round(this.az / 22.5) % 16] });
  }

  #bindControls() {
    const el = this.renderer.domElement;
    el.style.touchAction = 'none';
    el.style.cursor = 'grab';
    const pointers = new Map();
    let pinch = null;
    el.addEventListener('pointerdown', (e) => { el.setPointerCapture(e.pointerId); pointers.set(e.pointerId, e); el.style.cursor = 'grabbing'; });
    el.addEventListener('pointermove', (e) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
      pointers.set(e.pointerId, e);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        if (pinch) this.#zoom((pinch - dist) * 0.15);
        pinch = dist;
        return;
      }
      // Degrees per pixel follows the field of view, so dragging feels the same at any zoom.
      const k = this.fov / this.container.clientHeight;
      this.look(this.az - (e.clientX - prev.clientX) * k, this.el + (e.clientY - prev.clientY) * k);
    });
    const end = (e) => { pointers.delete(e.pointerId); pinch = null; el.style.cursor = 'grab'; };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('wheel', (e) => { e.preventDefault(); this.#zoom(e.deltaY * 0.05); }, { passive: false });
  }

  #zoom(delta) {
    this.fov = Math.max(25, Math.min(100, this.fov + delta));
    this.render();
  }
}
