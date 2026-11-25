import { EventEmitter } from '../core/EventEmitter.js';
import { Vec3 } from '../math/Vec3.js';
import { clamp } from '../math/utils.js';
import { clientToViewportPoint } from '../core/viewportCoords.js';

const _v = new Vec3();
const _r = new Vec3();
const _u = new Vec3();

// Órbita alrededor de `target`. Táctil: 1 dedo gira, 2 dedos zoom + desplazar.
// Ratón: izquierdo gira, derecho (o Shift) desplaza, rueda = zoom.
export class OrbitControls extends EventEmitter {
  constructor(camera, dom) {
    super();
    this.camera = camera; this.dom = dom;
    this.enabled = true;
    this.target = new Vec3();
    this.minDistance = 0.1; this.maxDistance = Infinity;
    this.rotateSpeed = 1; this.zoomSpeed = 1; this.panSpeed = 1;
    this.enableDamping = true; this.dampingFactor = 0.12;
    this._ptrs = new Map();
    this._pinch = 0; this._mid = [0, 0];
    this._dTheta = 0; this._dPhi = 0;
    this._lastState = null;
    this.syncFromCamera();

    dom.style.touchAction = 'none';
    this._down = (e) => this._onDown(e);
    this._move = (e) => this._onMove(e);
    this._up = (e) => this._onUp(e);
    this._wheel = (e) => this._onWheel(e);
    this._ctx = (e) => e.preventDefault();
    this._blur = () => { this._ptrs.clear(); this._pinch = 0; };
    dom.addEventListener('pointerdown', this._down);
    dom.addEventListener('pointermove', this._move);
    dom.addEventListener('pointerup', this._up);
    dom.addEventListener('pointercancel', this._up);
    dom.addEventListener('wheel', this._wheel, { passive: false });
    dom.addEventListener('contextmenu', this._ctx);
    if (typeof window !== 'undefined') window.addEventListener('blur', this._blur);
  }

  // Llamar si moviste la cámara a mano (resincronización pública).
  syncFromCamera() {
    _v.copy(this.camera.position).sub(this.target);
    this.radius = _v.length() || 1e-6;
    this.theta = Math.atan2(_v.x, _v.z);
    this.phi = Math.acos(clamp(_v.y / this.radius, -1, 1));
    return this;
  }

  syncTargetFromCamera(distance = null) {
    if (!this.camera) return this;
    const dist = Math.max(0.05, distance !== null && distance !== undefined ? distance : (this.radius || 6));
    _v.set(0, 0, -1).applyQuaternion(this.camera.quaternion).normalize();
    this.target.copy(this.camera.position).addScaledVector(_v, dist);
    return this.syncFromCamera();
  }

  copySettingsFrom(other) {
    if (!other) return this;
    this.target.copy(other.target);
    this.minDistance = other.minDistance;
    this.maxDistance = other.maxDistance;
    this.rotateSpeed = other.rotateSpeed;
    this.zoomSpeed = other.zoomSpeed;
    this.panSpeed = other.panSpeed;
    this.enableDamping = other.enableDamping;
    this.dampingFactor = other.dampingFactor;
    this.enabled = other.enabled;
    return this.syncFromCamera();
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

    const ls = this._lastState;
    if (!ls || Math.abs(ls[0] - this.theta) > 1e-6 || Math.abs(ls[1] - this.phi) > 1e-6 ||
        Math.abs(ls[2] - this.radius) > 1e-6 || Math.abs(ls[3] - t.x) > 1e-6 ||
        Math.abs(ls[4] - t.y) > 1e-6 || Math.abs(ls[5] - t.z) > 1e-6) {
      if (!ls) this._lastState = [this.theta, this.phi, this.radius, t.x, t.y, t.z];
      else { ls[0] = this.theta; ls[1] = this.phi; ls[2] = this.radius; ls[3] = t.x; ls[4] = t.y; ls[5] = t.z; }
      this.emit('change');
      return true;
    }
    return false;
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
  _zoom(factor) {
    const cam = this.camera;
    if (cam && cam.fov === undefined && cam.left !== undefined) {
      const cx = (cam.left + cam.right) * 0.5;
      const cy = (cam.top + cam.bottom) * 0.5;
      const hw = Math.max(0.05, Math.min(500, ((cam.right - cam.left) * 0.5) * factor));
      const hh = Math.max(0.05, Math.min(500, ((cam.top - cam.bottom) * 0.5) * factor));
      cam.left = cx - hw; cam.right = cx + hw;
      cam.bottom = cy - hh; cam.top = cy + hh;
      if (cam.updateProjection) cam.updateProjection();
      return;
    }
    this.radius = clamp(this.radius * factor, this.minDistance, this.maxDistance);
  }

  _onDown(e) {
    if (!this.enabled) return;
    try { this.dom.setPointerCapture(e.pointerId); } catch (_) { /* sin captura */ }
    const pt = clientToViewportPoint(e);
    this._ptrs.set(e.pointerId, { x: pt.x, y: pt.y, button: e.button });
    if (this._ptrs.size === 2) { const [a, b] = [...this._ptrs.values()]; this._pinch = Math.hypot(a.x - b.x, a.y - b.y); this._mid = [(a.x + b.x) / 2, (a.y + b.y) / 2]; }
  }
  _onMove(e) {
    const p = this._ptrs.get(e.pointerId);
    if (!p || !this.enabled) return;
    const pt = clientToViewportPoint(e);
    const dx = pt.x - p.x, dy = pt.y - p.y;
    if (this._ptrs.size === 1) {
      if (p.button === 2 || e.shiftKey) this._pan(dx, dy); else this._rotate(dx, dy);
    }
    p.x = pt.x; p.y = pt.y;
    if (this._ptrs.size === 2) {
      const [a, b] = [...this._ptrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      if (this._pinch > 0 && d > 0) this._zoom(Math.pow(this._pinch / d, this.zoomSpeed));
      this._pan(mx - this._mid[0], my - this._mid[1]);
      this._pinch = d; this._mid = [mx, my];
    }
  }
  _onUp(e) {
    this._ptrs.delete(e.pointerId);
    if (this.dom.hasPointerCapture && this.dom.hasPointerCapture(e.pointerId)) this.dom.releasePointerCapture(e.pointerId);
    if (this._ptrs.size === 1) this._pinch = 0;
  }
  cancelPointer(pointerId) {
    this._ptrs.delete(pointerId);
    try {
      if (this.dom.hasPointerCapture && this.dom.hasPointerCapture(pointerId)) {
        this.dom.releasePointerCapture(pointerId);
      }
    } catch (_) {}
    if (this._ptrs.size <= 1) this._pinch = 0;
  }
  _onWheel(e) {
    if (!this.enabled) return;
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 120 : e.deltaY;
    this._zoom(Math.pow(1.0018, dy * this.zoomSpeed));
  }
  dispose() {
    const d = this.dom;
    d.removeEventListener('pointerdown', this._down); d.removeEventListener('pointermove', this._move);
    d.removeEventListener('pointerup', this._up); d.removeEventListener('pointercancel', this._up);
    d.removeEventListener('wheel', this._wheel); d.removeEventListener('contextmenu', this._ctx);
    if (typeof window !== 'undefined') window.removeEventListener('blur', this._blur);
  }
}
