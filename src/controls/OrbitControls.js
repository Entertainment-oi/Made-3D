import { Vec3 } from '../math/Vec3.js';
import { clamp } from '../math/utils.js';

const _v = new Vec3();
const _r = new Vec3();
const _u = new Vec3();

// Órbita alrededor de `target`. Táctil: 1 dedo gira, 2 dedos zoom + desplazar.
// Ratón: izquierdo gira, derecho (o Shift) desplaza, rueda = zoom.
export class OrbitControls {
  constructor(camera, dom) {
    this.camera = camera; this.dom = dom;
    this.enabled = true;
    this.target = new Vec3();
    this.minDistance = 0.1; this.maxDistance = Infinity;
    this.rotateSpeed = 1; this.zoomSpeed = 1; this.panSpeed = 1;
    this.enableDamping = true; this.dampingFactor = 0.12;
    this._ptrs = new Map();
    this._pinch = 0; this._mid = [0, 0];
    this._dTheta = 0; this._dPhi = 0;
    this.syncFromCamera();

    dom.style.touchAction = 'none';
    this._down = (e) => this._onDown(e);
    this._move = (e) => this._onMove(e);
    this._up = (e) => this._onUp(e);
    this._wheel = (e) => this._onWheel(e);
    this._ctx = (e) => e.preventDefault();
    dom.addEventListener('pointerdown', this._down);
    dom.addEventListener('pointermove', this._move);
    dom.addEventListener('pointerup', this._up);
    dom.addEventListener('pointercancel', this._up);
    dom.addEventListener('wheel', this._wheel, { passive: false });
    dom.addEventListener('contextmenu', this._ctx);
  }

  // Llamar si moviste la cámara a mano (resincronización pública).
  syncFromCamera() {
    _v.copy(this.camera.position).sub(this.target);
    this.radius = _v.length() || 1e-6;
    this.theta = Math.atan2(_v.x, _v.z);
    this.phi = Math.acos(clamp(_v.y / this.radius, -1, 1));
  }

  update() {
    if (this.enableDamping) {
      this.theta += this._dTheta; this.phi += this._dPhi;
      const k = 1 - this.dampingFactor;
      this._dTheta *= k; this._dPhi *= k;
      if (Math.abs(this._dTheta) < 1e-5) this._dTheta = 0;
      if (Math.abs(this._dPhi) < 1e-5) this._dPhi = 0;
    }
    this.phi = clamp(this.phi, 0.01, Math.PI - 0.01);
    this.radius = clamp(this.radius, this.minDistance, this.maxDistance);
    const sp = Math.sin(this.phi) * this.radius, t = this.target;
    this.camera.position.set(t.x + sp * Math.sin(this.theta), t.y + this.radius * Math.cos(this.phi), t.z + sp * Math.cos(this.theta));
    this.camera.lookAt(t);
  }

  _rotate(dx, dy) {
    const h = this.dom.clientHeight || 1, f = (2 * Math.PI * this.rotateSpeed) / h;
    if (this.enableDamping) { this._dTheta -= dx * f * this.dampingFactor; this._dPhi -= dy * f * this.dampingFactor; }
    else { this.theta -= dx * f; this.phi -= dy * f; }
  }
  _pan(dx, dy) {
    const cam = this.camera, h = this.dom.clientHeight || 1;
    const k = cam.fov ? (2 * this.radius * Math.tan((cam.fov * Math.PI) / 360)) / h : (cam.top - cam.bottom) / h;
    _r.set(1, 0, 0).applyQuaternion(cam.quaternion); _u.set(0, 1, 0).applyQuaternion(cam.quaternion);
    this.target.addScaledVector(_r, -dx * k * this.panSpeed).addScaledVector(_u, dy * k * this.panSpeed);
  }
  _zoom(factor) { this.radius *= factor; }

  _onDown(e) {
    if (!this.enabled) return;
    try { this.dom.setPointerCapture(e.pointerId); } catch (_) { /* sin captura */ }
    this._ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, button: e.button });
    if (this._ptrs.size === 2) { const [a, b] = [...this._ptrs.values()]; this._pinch = Math.hypot(a.x - b.x, a.y - b.y); this._mid = [(a.x + b.x) / 2, (a.y + b.y) / 2]; }
  }
  _onMove(e) {
    const p = this._ptrs.get(e.pointerId);
    if (!p || !this.enabled) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    if (this._ptrs.size === 1) {
      if (p.button === 2 || e.shiftKey) this._pan(dx, dy); else this._rotate(dx, dy);
    }
    p.x = e.clientX; p.y = e.clientY;
    if (this._ptrs.size === 2) {
      const [a, b] = [...this._ptrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      if (this._pinch > 0 && d > 0) this._zoom(this._pinch / d);
      this._pan(mx - this._mid[0], my - this._mid[1]);
      this._pinch = d; this._mid = [mx, my];
    }
  }
  _onUp(e) {
    this._ptrs.delete(e.pointerId);
    if (this.dom.hasPointerCapture && this.dom.hasPointerCapture(e.pointerId)) this.dom.releasePointerCapture(e.pointerId);
    if (this._ptrs.size === 1) this._pinch = 0;
  }
  _onWheel(e) {
    if (!this.enabled) return;
    e.preventDefault();
    this._zoom(Math.pow(1.0015, e.deltaY * this.zoomSpeed));
  }
  dispose() {
    const d = this.dom;
    d.removeEventListener('pointerdown', this._down); d.removeEventListener('pointermove', this._move);
    d.removeEventListener('pointerup', this._up); d.removeEventListener('pointercancel', this._up);
    d.removeEventListener('wheel', this._wheel); d.removeEventListener('contextmenu', this._ctx);
  }
}
