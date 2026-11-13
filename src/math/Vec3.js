import { Mat4 } from './Mat4.js';

const _vp = new Mat4();

export class Vec3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new Vec3(this.x, this.y, this.z); }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
  multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
  cross(v) {
    const ax = this.x, ay = this.y, az = this.z;
    this.x = ay * v.z - az * v.y;
    this.y = az * v.x - ax * v.z;
    this.z = ax * v.y - ay * v.x;
    return this;
  }
  subVectors(a, b) { this.x = a.x - b.x; this.y = a.y - b.y; this.z = a.z - b.z; return this; }
  crossVectors(a, b) {
    const ax = a.x, ay = a.y, az = a.z, bx = b.x, by = b.y, bz = b.z;
    this.x = ay * bz - az * by; this.y = az * bx - ax * bz; this.z = ax * by - ay * bx;
    return this;
  }
  lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
  length() { return Math.sqrt(this.lengthSq()); }
  distanceTo(v) { const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z; return Math.sqrt(dx * dx + dy * dy + dz * dz); }
  normalize() { return this.multiplyScalar(1 / (this.length() || 1)); }
  lerp(v, t) { this.x += (v.x - this.x) * t; this.y += (v.y - this.y) * t; this.z += (v.z - this.z) * t; return this; }
  applyMatrix4(m) {
    const e = m.elements, x = this.x, y = this.y, z = this.z;
    const w = 1 / ((e[3] * x + e[7] * y + e[11] * z + e[15]) || 1);
    this.x = (e[0] * x + e[4] * y + e[8] * z + e[12]) * w;
    this.y = (e[1] * x + e[5] * y + e[9] * z + e[13]) * w;
    this.z = (e[2] * x + e[6] * y + e[10] * z + e[14]) * w;
    return this;
  }
  applyQuaternion(q) {
    const x = this.x, y = this.y, z = this.z, qx = q.x, qy = q.y, qz = q.z, qw = q.w;
    const ix = qw * x + qy * z - qz * y, iy = qw * y + qz * x - qx * z, iz = qw * z + qx * y - qy * x, iw = -qx * x - qy * y - qz * z;
    this.x = ix * qw + iw * -qx + iy * -qz - iz * -qy;
    this.y = iy * qw + iw * -qy + iz * -qx - ix * -qz;
    this.z = iz * qw + iw * -qz + ix * -qy - iy * -qx;
    return this;
  }
  setFromMatrixPosition(m) { const e = m.elements; this.x = e[12]; this.y = e[13]; this.z = e[14]; return this; }
  // Mundo → coordenadas normalizadas del dispositivo (-1..1, y hacia arriba).
  project(camera) {
    const m = _vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).elements;
    const x = this.x, y = this.y, z = this.z;
    const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1;
    this.x = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
    this.y = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
    this.z = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
    return this;
  }
  // Coordenadas normalizadas (-1..1) → mundo. Inverso de project().
  unproject(camera) {
    const m = _vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).invert().elements;
    const x = this.x, y = this.y, z = this.z;
    const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1;
    this.x = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
    this.y = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
    this.z = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
    return this;
  }
  toArray(a = [], o = 0) { a[o] = this.x; a[o + 1] = this.y; a[o + 2] = this.z; return a; }
  fromArray(a, o = 0) { this.x = a[o]; this.y = a[o + 1]; this.z = a[o + 2]; return this; }
}
