import { EventEmitter } from '../core/EventEmitter.js';
import { BufferAttribute } from './BufferAttribute.js';
import { Vec3 } from '../math/Vec3.js';

let _id = 0;

// Atributos reconocidos: position(3), normal(3), uv(2), color(3|4)
export class Geometry extends EventEmitter {
  constructor() {
    super();
    this.isGeometry = true;
    this.isBufferGeometry = true;
    this.id = ++_id;
    this.attributes = {};
    this.morphAttributes = { position: [], normal: [] };
    this.morphTargetsRelative = true;
    this.index = null;
    this.boundingSphere = null;
    this.boundingBox = null;
    this._bsVersion = -1;
    this._bbVersion = -1;
  }
  setAttribute(name, array, itemSize) {
    if (array instanceof BufferAttribute) this.attributes[name] = array;
    else {
      if (!(array instanceof Float32Array)) array = new Float32Array(array);
      this.attributes[name] = new BufferAttribute(array, itemSize);
    }
    return this;
  }
  setIndex(array) {
    if (!array) {
      this.index = null;
      return this;
    }
    if (array instanceof BufferAttribute) this.index = array;
    else {
      if (!(array instanceof Uint16Array || array instanceof Uint32Array)) {
        let max = 0;
        for (let i = 0; i < array.length; i++) if (array[i] > max) max = array[i];
        array = max > 65535 ? new Uint32Array(array) : new Uint16Array(array);
      }
      this.index = new BufferAttribute(array, 1);
    }
    return this;
  }
  // Cambia cuando se modifican posiciones o índices (para cachés).
  get version() { return (this.attributes.position ? this.attributes.position.version : 0) + (this.index ? this.index.version * 1009 : 0); }
  get vertexCount() { return this.attributes.position ? this.attributes.position.count : 0; }
  get triangleCount() { return this.index ? (this.index.count / 3) | 0 : (this.vertexCount / 3) | 0; }
  getStats() {
    return {
      vertices: this.vertexCount,
      triangles: this.triangleCount,
      indexed: Boolean(this.index),
    };
  }

  getBoundingBox() {
    const p = this.attributes.position;
    if (!p) return null;
    if (!this.boundingBox || this._bbVersion !== p.version) this.computeBoundingBox();
    return this.boundingBox;
  }
  computeBoundingBox() {
    const p = this.attributes.position, a = p.array, n = p.count;
    if (!n) {
      this.boundingBox = { min: new Vec3(0, 0, 0), max: new Vec3(0, 0, 0) };
      this._bbVersion = p.version;
      return this.boundingBox;
    }
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      const x = a[o], y = a[o + 1], z = a[o + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    if (!this.boundingBox) this.boundingBox = { min: new Vec3(minX, minY, minZ), max: new Vec3(maxX, maxY, maxZ) };
    else { this.boundingBox.min.set(minX, minY, minZ); this.boundingBox.max.set(maxX, maxY, maxZ); }
    this._bbVersion = p.version;
    return this.boundingBox;
  }
  getBoundingSphere() {
    const p = this.attributes.position;
    if (!p) return null;
    if (!this.boundingSphere || this._bsVersion !== p.version) this.computeBoundingSphere();
    return this.boundingSphere;
  }
  computeBoundingSphere() {
    const p = this.attributes.position, a = p.array, n = p.count;
    if (!n) {
      this.boundingSphere = { center: new Vec3(0, 0, 0), radius: 0 };
      this._bsVersion = p.version;
      return this.boundingSphere;
    }
    const bb = this.getBoundingBox();
    const cx = (bb.min.x + bb.max.x) * 0.5, cy = (bb.min.y + bb.max.y) * 0.5, cz = (bb.min.z + bb.max.z) * 0.5;
    let r2 = 0;
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      const dx = a[o] - cx, dy = a[o + 1] - cy, dz = a[o + 2] - cz;
      const d = dx * dx + dy * dy + dz * dz;
      if (d > r2) r2 = d;
    }
    if (!this.boundingSphere) this.boundingSphere = { center: new Vec3(cx, cy, cz), radius: Math.sqrt(r2) };
    else { this.boundingSphere.center.set(cx, cy, cz); this.boundingSphere.radius = Math.sqrt(r2); }
    this._bsVersion = p.version;
    return this.boundingSphere;
  }
  computeNormals() {
    if (!this.attributes.position) return this;
    const p = this.attributes.position.array, n = new Float32Array(p.length);
    const idx = this.index ? this.index.array : null;
    const tris = idx ? (idx.length / 3) | 0 : (p.length / 9) | 0;
    for (let t = 0; t < tris; t++) {
      const a = idx ? idx[t * 3] : t * 3, b = idx ? idx[t * 3 + 1] : t * 3 + 1, c = idx ? idx[t * 3 + 2] : t * 3 + 2;
      const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2];
      const e1x = p[b * 3] - ax, e1y = p[b * 3 + 1] - ay, e1z = p[b * 3 + 2] - az;
      const e2x = p[c * 3] - ax, e2y = p[c * 3 + 1] - ay, e2z = p[c * 3 + 2] - az;
      const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      for (const v of [a, b, c]) { n[v * 3] += nx; n[v * 3 + 1] += ny; n[v * 3 + 2] += nz; }
    }
    for (let i = 0; i < n.length; i += 3) {
      const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
      n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
    }
    return this.setAttribute('normal', n, 3);
  }
  // Copia independiente (atributos e índices propios).
  clone() {
    const g = new Geometry();
    for (const k in this.attributes) { const a = this.attributes[k]; g.setAttribute(k, a.array.slice(), a.itemSize); }
    for (const k in this.morphAttributes) {
      g.morphAttributes[k] = (this.morphAttributes[k] || []).map((a) => new BufferAttribute(a.array.slice(), a.itemSize));
    }
    g.morphTargetsRelative = this.morphTargetsRelative;
    if (this.index) g.setIndex(this.index.array.slice());
    return g;
  }
  dispose() { this.emit('dispose'); }
}
