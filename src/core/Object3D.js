import { Vec3 } from '../math/Vec3.js';
import { Quat } from '../math/Quat.js';
import { Euler } from '../math/Euler.js';
import { Mat4 } from '../math/Mat4.js';
import { computeBounds, autoScaleObject, resetAutoScale } from './autoScale.js';

let _id = 0;
const _m = new Mat4();
const _up = new Vec3(0, 1, 0);
const _t = new Vec3(), _p = new Vec3(), _pp = new Vec3(), _ps = new Vec3();
const _w = new Mat4(), _pq = new Quat();

export class Object3D {
  constructor() {
    this.id = ++_id;
    this.name = '';
    this.parent = null;
    this.children = [];
    this.visible = true;
    this.castShadow = false;    // proyecta sombra (mallas y objetos con geometría)
    this.receiveShadow = true;   // recibe la sombra que le echen
    this.userData = {};
    this.position = new Vec3();
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

  add(...objs) {
    for (const o of objs) {
      if (o === this || !o) continue;
      if (o.parent) o.parent.remove(o);
      o.parent = this;
      this.children.push(o);
    }
    return this;
  }
  remove(...objs) {
    for (const o of objs) {
      const i = this.children.indexOf(o);
      if (i >= 0) { this.children.splice(i, 1); o.parent = null; }
    }
    return this;
  }
  removeFromParent() { if (this.parent) this.parent.remove(this); return this; }

  // Eventos (addEventListener / dispatchEvent({ type, ...datos }))
  addEventListener(type, fn) { ((this._listeners ??= {})[type] ??= []).push(fn); return this; }
  removeEventListener(type, fn) {
    const a = this._listeners && this._listeners[type];
    if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
    return this;
  }
  dispatchEvent(evt) {
    const a = this._listeners && this._listeners[evt.type];
    if (a) { evt.target = this; for (const f of a.slice()) f.call(this, evt); }
    return this;
  }

  traverse(fn) {
    fn(this);
    for (const c of this.children) c.traverse(fn);
  }
  getObjectByName(name) {
    let found = null;
    this.traverse((o) => { if (!found && o.name === name) found = o; });
    return found;
  }

  // Apunta el eje -Z hacia el objetivo (válido para objetos sin padre rotado).
  // `x, y, z` (o un Vec3) están en coordenadas del mundo; funciona aunque el objeto tenga padre.
  lookAt(x, y, z) {
    if (typeof x === 'object') _t.copy(x); else _t.set(x, y, z);
    if (this.parent) {
      this.parent.updateWorldMatrix(true, false);
      this.updateMatrix();
      _w.multiplyMatrices(this.parent.matrixWorld, this.matrix);
      _p.setFromMatrixPosition(_w);
    } else _p.copy(this.position);
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
    if (updateChildren) for (const c of this.children) c.updateWorldMatrix(false, true);
  }
  getWorldPosition(target = new Vec3()) {
    return target.setFromMatrixPosition(this.matrixWorld);
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
