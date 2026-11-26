import { EventEmitter } from './EventEmitter.js';
import { Vec3 } from '../math/Vec3.js';
import { Quat } from '../math/Quat.js';
import { Euler } from '../math/Euler.js';
import { Mat4 } from '../math/Mat4.js';
import { computeBounds, autoScaleObject, resetAutoScale } from './autoScale.js';

let _id = 0;
let _activeCloneMap = null;
const _m = new Mat4();
const _up = new Vec3(0, 1, 0);
const _zero = new Vec3(0, 0, 0);
const _t = new Vec3(), _p = new Vec3(), _pp = new Vec3(), _ps = new Vec3();
const _w = new Mat4(), _pq = new Quat(), _mQuatScratch = new Quat();

function cloneUserDataValue(v, seen = new WeakMap()) {
  if (v === null || typeof v !== 'object') return v;
  if (v.isObject3D || v.isMaterial || v.isGeometry || v.isTexture || v.isCamera || v.isLight || v.isSkeleton || v.isBone) return v;
  if (ArrayBuffer.isView(v)) return typeof v.slice === 'function' ? v.slice() : v;
  if (seen.has(v)) return seen.get(v);
  if (Array.isArray(v)) {
    const out = new Array(v.length);
    seen.set(v, out);
    for (let i = 0; i < v.length; i++) out[i] = cloneUserDataValue(v[i], seen);
    return out;
  }
  const proto = Object.getPrototypeOf(v);
  if (proto === Object.prototype || proto === null) {
    const out = {};
    seen.set(v, out);
    const keys = Object.keys(v);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      out[k] = cloneUserDataValue(v[k], seen);
    }
    return out;
  }
  if (typeof v.clone === 'function') return v.clone();
  return v;
}

export class Object3D extends EventEmitter {
  constructor() {
    super();
    this.isObject3D = true;
    this.id = ++_id;
    this.name = '';
    this.parent = null;
    this.children = [];
    this.visible = true;
    this.pickable = true;
    this.exportable = true;
    this.outline = true;
    this.pickTarget = null;
    this.castShadow = false;    // proyecta sombra (mallas y objetos con geometría)
    this.receiveShadow = true;   // recibe la sombra que le echen
    this.userData = {};
    this.position = new Vec3();
    this.pivot = new Vec3();
    this.rotation = new Euler();
    this.quaternion = new Quat();
    this.scale = new Vec3(1, 1, 1);
    // rotation y quaternion se mantienen sincronizados
    this.rotation._onChange = () => this.quaternion.setFromEuler(this.rotation, false);
    this.quaternion._onChange = () => this.rotation.setFromQuat(this.quaternion, false);
    this.matrix = new Mat4();
    this.matrixWorld = new Mat4();
    // false = no recalcula la matriz local (objetos estáticos → más rendimiento)
    this.matrixAutoUpdate = true;
  }

  _isAncestor(obj) {
    let p = this.parent;
    let slow = p;
    let step = false;
    while (p) {
      if (p === obj) return true;
      p = p.parent;
      if (step && slow) {
        slow = slow.parent;
        if (p === slow) return true;
      }
      step = !step;
    }
    return false;
  }

  add(...objs) {
    for (let i = 0; i < objs.length; i++) {
      const o = objs[i];
      if (!o) continue;
      if (o === this || this._isAncestor(o)) {
        console.warn('Made3D Object3D.add: se omitió el objeto para evitar un ciclo en la jerarquía.');
        continue;
      }
      if (o.parent) o.parent.remove(o);
      o.parent = this;
      this.children.push(o);
    }
    return this;
  }
  remove(...objs) {
    for (let j = 0; j < objs.length; j++) {
      const o = objs[j];
      const i = this.children.indexOf(o);
      if (i >= 0) { this.children.splice(i, 1); o.parent = null; }
    }
    return this;
  }
  removeFromParent() { if (this.parent) this.parent.remove(this); return this; }

  isPickable() {
    return this.pickable !== false && !(this.userData && (this.userData.pickable === false || this.userData.noPick === true));
  }
  isExportable() {
    return this.exportable !== false && !(this.userData && this.userData.exportable === false);
  }
  isOutlineEnabled() {
    return this.outline !== false && !(this.userData && this.userData.noOutline === true);
  }
  getPickTarget() {
    return this.pickTarget || (this.userData && this.userData.pickTarget) || this;
  }
  isHelper() {
    return Boolean(
      this.isGizmo ||
      this.isTransformGizmo ||
      this.isGridHelper ||
      this.isSkeletonHelper ||
      this.isCameraHelper
    );
  }
  collectMeshes({ includeHelpers = false, onlyPickable = true, recursive = true, includeSelf = false } = {}) {
    const out = [];
    const accept = (n) => {
      if (!n || (!includeHelpers && n.isHelper())) return false;
      if (!n.isMesh) return false;
      if (onlyPickable && n.isPickable && !n.isPickable()) return false;
      return true;
    };
    if (includeSelf && accept(this)) out.push(this);
    const walk = (n) => {
      for (let i = 0; i < n.children.length; i++) {
        const c = n.children[i];
        if (!includeHelpers && c.isHelper()) continue;
        if (accept(c)) out.push(c);
        if (recursive) walk(c);
      }
    };
    walk(this);
    return out;
  }
  hasMeshDescendant({ includeSelf = true, includeHelpers = false, onlyPickable = true } = {}) {
    let found = false;
    const walk = (n, isSelf) => {
      if (found || !n) return;
      if (!includeHelpers && n.isHelper()) return;
      if ((isSelf ? includeSelf : true) && n.isMesh && (!onlyPickable || !n.isPickable || n.isPickable())) {
        found = true;
        return;
      }
      for (let i = 0; i < n.children.length; i++) {
        walk(n.children[i], false);
      }
    };
    walk(this, true);
    return found;
  }
  getPrimaryMaterial() {
    if (this.isHelper()) return null;
    if (this.material) return this.material;
    for (let i = 0; i < this.children.length; i++) {
      const c = this.children[i];
      if (c.isHelper && c.isHelper()) continue;
      const m = c.getPrimaryMaterial ? c.getPrimaryMaterial() : c.material;
      if (m) return m;
    }
    return null;
  }
  collectMaterials({ deduplicate = true, includeHelpers = false } = {}) {
    const out = [];
    const seen = deduplicate ? new Set() : null;
    const walk = (n) => {
      if (!n || (!includeHelpers && n.isHelper && n.isHelper())) return;
      if (n.material) {
        const mats = Array.isArray(n.material) ? n.material : [n.material];
        for (let i = 0; i < mats.length; i++) {
          const m = mats[i];
          if (!m) continue;
          if (!seen || !seen.has(m)) {
            if (seen) seen.add(m);
            out.push(m);
          }
        }
      }
      for (let i = 0; i < n.children.length; i++) walk(n.children[i]);
    };
    walk(this);
    return out;
  }

  traverse(fn) {
    fn(this);
    const c = this.children;
    for (let i = 0; i < c.length; i++) c[i].traverse(fn);
  }
  getObjectByName(name) {
    if (this.name === name) return this;
    const c = this.children;
    for (let i = 0; i < c.length; i++) {
      const found = c[i].getObjectByName(name);
      if (found) return found;
    }
    return null;
  }

  // Apunta el eje -Z hacia el objetivo (válido para objetos sin padre rotado).
  // `x, y, z` (o un Vec3) están en coordenadas del mundo; funciona aunque el objeto tenga padre y/o pivote.
  lookAt(x, y, z) {
    if (typeof x === 'object') _t.copy(x); else _t.set(x, y, z);
    this.updateWorldMatrix(true, false);
    this.getPivotWorldPosition(_p);
    _m.lookAt(_p, _t, _up);
    this.quaternion.setFromRotationMatrix(_m);
    if (this.parent) {
      this.parent.matrixWorld.decompose(_pp, _pq, _ps);
      this.quaternion.premultiply(_pq.invert());
    }
    return this;
  }

  updateMatrix() {
    this.matrix.compose(this.position, this.quaternion, this.scale);
    const pv = this.pivot;
    if (pv && (pv.x !== 0 || pv.y !== 0 || pv.z !== 0)) {
      const e = this.matrix.elements;
      e[12] += pv.x - (e[0] * pv.x + e[4] * pv.y + e[8] * pv.z);
      e[13] += pv.y - (e[1] * pv.x + e[5] * pv.y + e[9] * pv.z);
      e[14] += pv.z - (e[2] * pv.x + e[6] * pv.y + e[10] * pv.z);
    }
  }
  updateMatrixWorld() {
    if (this.matrixAutoUpdate) this.updateMatrix();
    if (this.parent) this.matrixWorld.multiplyMatrices(this.parent.matrixWorld, this.matrix);
    else this.matrixWorld.copy(this.matrix);
    const c = this.children;
    for (let i = 0; i < c.length; i++) c[i].updateMatrixWorld();
  }
  // Actualiza la matriz mundial de este objeto (y opcionalmente de sus padres / hijos).
  updateWorldMatrix(updateParents = false, updateChildren = false) {
    if (updateParents && this.parent) this.parent.updateWorldMatrix(true, false);
    if (this.matrixAutoUpdate) this.updateMatrix();
    if (this.parent) this.matrixWorld.multiplyMatrices(this.parent.matrixWorld, this.matrix);
    else this.matrixWorld.copy(this.matrix);
    if (updateChildren) {
      const c = this.children;
      for (let i = 0; i < c.length; i++) c[i].updateWorldMatrix(false, true);
    }
  }
  getWorldPosition(target = new Vec3()) {
    return target.setFromMatrixPosition(this.matrixWorld);
  }
  getPivotWorldPosition(target = new Vec3()) {
    const pv = this.pivot;
    if (!pv || (pv.x === 0 && pv.y === 0 && pv.z === 0)) {
      return target.setFromMatrixPosition(this.matrixWorld);
    }
    return target.copy(pv).applyMatrix4(this.matrixWorld);
  }
  setPivot(x, y = 0, z = 0, keepWorld = true) {
    let nx, ny, nz, kw;
    if (x && typeof x === 'object') {
      nx = x.x || 0;
      ny = x.y || 0;
      nz = x.z || 0;
      kw = y === undefined ? true : Boolean(y);
    } else {
      nx = x || 0;
      ny = y || 0;
      nz = z || 0;
      kw = Boolean(keepWorld);
    }
    if (kw) {
      const dx = this.pivot.x - nx;
      const dy = this.pivot.y - ny;
      const dz = this.pivot.z - nz;
      if (dx !== 0 || dy !== 0 || dz !== 0) {
        _m.compose(_zero, this.quaternion, this.scale);
        const e = _m.elements;
        this.position.x += dx - (e[0] * dx + e[4] * dy + e[8] * dz);
        this.position.y += dy - (e[1] * dx + e[5] * dy + e[9] * dz);
        this.position.z += dz - (e[2] * dx + e[6] * dy + e[10] * dz);
      }
    }
    this.pivot.set(nx, ny, nz);
    this.updateWorldMatrix(true, true);
    return this;
  }
  setPivotWorld(worldPos, keepWorld = true) {
    if (!worldPos) return this;
    this.updateWorldMatrix(true, false);
    const e = this.matrixWorld.elements;
    const det =
      e[0] * (e[5] * e[10] - e[9] * e[6]) -
      e[4] * (e[1] * e[10] - e[9] * e[2]) +
      e[8] * (e[1] * e[6] - e[5] * e[2]);
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return this;
    _w.copyInverse(this.matrixWorld);
    _t.copy(worldPos).applyMatrix4(_w);
    return this.setPivot(_t.x, _t.y, _t.z, keepWorld);
  }
  centerPivot({ yAlign = 'center', keepWorld = true } = {}) {
    const bounds = computeBounds(this, { includeInvisible: true });
    if (!bounds || bounds.empty) return this;
    const tx = (bounds.min.x + bounds.max.x) * 0.5;
    const tz = (bounds.min.z + bounds.max.z) * 0.5;
    let ty = (bounds.min.y + bounds.max.y) * 0.5;
    if (yAlign === 'bottom' || yAlign === 'min' || yAlign === 'base') ty = bounds.min.y;
    else if (yAlign === 'top' || yAlign === 'max') ty = bounds.max.y;
    return this.setPivotWorld(_t.set(tx, ty, tz), keepWorld);
  }
  resetPivot(keepWorld = true) {
    return this.setPivot(0, 0, 0, keepWorld);
  }
  getWorldQuaternion(target = new Quat()) {
    this.matrixWorld.decompose(_pp, target, _ps);
    return target;
  }
  getWorldScale(target = new Vec3()) {
    this.matrixWorld.decompose(_pp, _pq, target);
    return target;
  }
  copyWorldTransformFrom(source) {
    if (!source) return this;
    source.updateWorldMatrix(true, false);
    const worldPos = source.getWorldPosition(_pp);
    const worldQuat = source.getWorldQuaternion(_pq);
    if (this.parent) {
      this.parent.updateWorldMatrix(true, false);
      _w.copyInverse(this.parent.matrixWorld);
      this.position.copy(worldPos).applyMatrix4(_w);
      this.parent.matrixWorld.decompose(_p, _mQuatScratch, _ps);
      _mQuatScratch.conjugate();
      this.quaternion.copy(_mQuatScratch).multiply(worldQuat).normalize();
    } else {
      this.position.copy(worldPos);
      this.quaternion.copy(worldQuat);
    }
    this.updateWorldMatrix(true, true);
    return this;
  }
  hasShadowCaster() {
    if (this.castShadow) return true;
    let found = false;
    this.traverse((node) => {
      if (node.isMesh && node.castShadow) found = true;
    });
    return found;
  }
  setCastShadowRecursive(enabled) {
    const val = Boolean(enabled);
    this.castShadow = val;
    this.traverse((node) => {
      if (node.isMesh) node.castShadow = val;
    });
    return this;
  }
  copy(source, recursive = true) {
    const startedHere = recursive && !_activeCloneMap;
    const cloneMap = _activeCloneMap || (recursive ? new Map() : null);
    if (startedHere) _activeCloneMap = cloneMap;
    try {
      if (cloneMap) cloneMap.set(source, this);
      this.name = source.name;
      this.visible = source.visible;
      this.pickable = source.pickable !== false;
      this.exportable = source.exportable !== false;
      this.outline = source.outline !== false;
      this.pickTarget = source.pickTarget === source ? this : (source.pickTarget || null);
      this.castShadow = source.castShadow;
      this.receiveShadow = source.receiveShadow;
      this.matrixAutoUpdate = source.matrixAutoUpdate;
      this.userData = cloneUserDataValue(source.userData || {});
      if (this.userData && this.userData.pickTarget === source) this.userData.pickTarget = this;
      this.position.copy(source.position);
      if (source.pivot) this.pivot.copy(source.pivot); else this.pivot.set(0, 0, 0);
      this.quaternion.copy(source.quaternion);
      this.scale.copy(source.scale);
      if (recursive) {
        for (let i = 0; i < source.children.length; i++) {
          this.add(source.children[i].clone(true));
        }
      }
      if (startedHere && cloneMap) {
        this.traverse((node) => {
          if (node && node.isCameraHelper && node.camera && cloneMap.has(node.camera)) {
            node.setCamera(cloneMap.get(node.camera));
            if (typeof node.update === 'function') node.update();
          }
        });
      }
      return this;
    } finally {
      if (startedHere) _activeCloneMap = null;
    }
  }
  clone(recursive = true) {
    return new this.constructor().copy(this, recursive);
  }
  getBounds(opts = {}) {
    return computeBounds(this, opts);
  }
  fitTo(targetOrOpts = {}, extraOpts = {}) {
    if (typeof targetOrOpts === 'number') return autoScaleObject(this, { ...extraOpts, targetSize: targetOrOpts });
    if (targetOrOpts && targetOrOpts.isObject3D) return autoScaleObject(this, { ...extraOpts, scene: targetOrOpts });
    return autoScaleObject(this, targetOrOpts || {});
  }
  resetAutoScale() {
    return resetAutoScale(this);
  }
}
