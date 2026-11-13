export class Quat {
  constructor(x = 0, y = 0, z = 0, w = 1) { this._x = x; this._y = y; this._z = z; this._w = w; this._onChange = null; }
  get x() { return this._x; } set x(v) { this._x = v; this._onChange && this._onChange(); }
  get y() { return this._y; } set y(v) { this._y = v; this._onChange && this._onChange(); }
  get z() { return this._z; } set z(v) { this._z = v; this._onChange && this._onChange(); }
  get w() { return this._w; } set w(v) { this._w = v; this._onChange && this._onChange(); }
  set(x, y, z, w) { this._x = x; this._y = y; this._z = z; this._w = w; this._onChange && this._onChange(); return this; }
  copy(q) { return this.set(q._x, q._y, q._z, q._w); }
  clone() { return new Quat(this._x, this._y, this._z, this._w); }
  identity() { return this.set(0, 0, 0, 1); }

  setFromEuler(e, notify = true) {
    const c1 = Math.cos(e._x / 2), c2 = Math.cos(e._y / 2), c3 = Math.cos(e._z / 2);
    const s1 = Math.sin(e._x / 2), s2 = Math.sin(e._y / 2), s3 = Math.sin(e._z / 2);
    this._x = s1 * c2 * c3 + c1 * s2 * s3;
    this._y = c1 * s2 * c3 - s1 * c2 * s3;
    this._z = c1 * c2 * s3 + s1 * s2 * c3;
    this._w = c1 * c2 * c3 - s1 * s2 * s3;
    if (notify && this._onChange) this._onChange();
    return this;
  }
  setFromAxisAngle(axis, angle) {
    const s = Math.sin(angle / 2);
    return this.set(axis.x * s, axis.y * s, axis.z * s, Math.cos(angle / 2));
  }
  setFromRotationMatrix(m) {
    const e = m.elements, m11 = e[0], m12 = e[4], m13 = e[8], m21 = e[1], m22 = e[5], m23 = e[9], m31 = e[2], m32 = e[6], m33 = e[10];
    const tr = m11 + m22 + m33;
    let x, y, z, w, s;
    if (tr > 0) { s = 0.5 / Math.sqrt(tr + 1); w = 0.25 / s; x = (m32 - m23) * s; y = (m13 - m31) * s; z = (m21 - m12) * s; }
    else if (m11 > m22 && m11 > m33) { s = 2 * Math.sqrt(1 + m11 - m22 - m33); w = (m32 - m23) / s; x = 0.25 * s; y = (m12 + m21) / s; z = (m13 + m31) / s; }
    else if (m22 > m33) { s = 2 * Math.sqrt(1 + m22 - m11 - m33); w = (m13 - m31) / s; x = (m12 + m21) / s; y = 0.25 * s; z = (m23 + m32) / s; }
    else { s = 2 * Math.sqrt(1 + m33 - m11 - m22); w = (m21 - m12) / s; x = (m13 + m31) / s; y = (m23 + m32) / s; z = 0.25 * s; }
    return this.set(x, y, z, w);
  }
  // this = this * q
  multiply(q) {
    const ax = this._x, ay = this._y, az = this._z, aw = this._w, bx = q._x, by = q._y, bz = q._z, bw = q._w;
    return this.set(
      ax * bw + aw * bx + ay * bz - az * by,
      ay * bw + aw * by + az * bx - ax * bz,
      az * bw + aw * bz + ax * by - ay * bx,
      aw * bw - ax * bx - ay * by - az * bz);
  }
  // this = q * this
  premultiply(q) {
    const ax = q._x, ay = q._y, az = q._z, aw = q._w, bx = this._x, by = this._y, bz = this._z, bw = this._w;
    return this.set(
      ax * bw + aw * bx + ay * bz - az * by,
      ay * bw + aw * by + az * bx - ax * bz,
      az * bw + aw * bz + ax * by - ay * bx,
      aw * bw - ax * bx - ay * by - az * bz);
  }
  invert() { return this.set(-this._x, -this._y, -this._z, this._w); }
  normalize() {
    const l = Math.hypot(this._x, this._y, this._z, this._w) || 1;
    return this.set(this._x / l, this._y / l, this._z / l, this._w / l);
  }
  slerp(q, t) {
    const x = this._x, y = this._y, z = this._z, w = this._w;
    let qx = q._x, qy = q._y, qz = q._z, qw = q._w;
    let cos = x * qx + y * qy + z * qz + w * qw;
    if (cos < 0) { cos = -cos; qx = -qx; qy = -qy; qz = -qz; qw = -qw; }
    let s0, s1;
    if (cos > 0.9995) { s0 = 1 - t; s1 = t; }
    else { const th = Math.acos(cos), sn = Math.sin(th); s0 = Math.sin((1 - t) * th) / sn; s1 = Math.sin(t * th) / sn; }
    return this.set(s0 * x + s1 * qx, s0 * y + s1 * qy, s0 * z + s1 * qz, s0 * w + s1 * qw).normalize();
  }
}
