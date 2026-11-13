import { clamp } from './utils.js';

// Ángulos en radianes, orden de rotación XYZ.
export class Euler {
  constructor(x = 0, y = 0, z = 0) { this._x = x; this._y = y; this._z = z; this._onChange = null; }
  get x() { return this._x; } set x(v) { this._x = v; this._onChange && this._onChange(); }
  get y() { return this._y; } set y(v) { this._y = v; this._onChange && this._onChange(); }
  get z() { return this._z; } set z(v) { this._z = v; this._onChange && this._onChange(); }
  set(x, y, z) { this._x = x; this._y = y; this._z = z; this._onChange && this._onChange(); return this; }
  copy(e) { return this.set(e._x, e._y, e._z); }
  clone() { return new Euler(this._x, this._y, this._z); }
  setFromQuat(q, notify = true) {
    const x = q._x, y = q._y, z = q._z, w = q._w;
    const m11 = 1 - 2 * (y * y + z * z), m12 = 2 * (x * y - z * w), m13 = 2 * (x * z + y * w);
    const m22 = 1 - 2 * (x * x + z * z), m23 = 2 * (y * z - x * w), m32 = 2 * (y * z + x * w);
    const m33 = 1 - 2 * (x * x + y * y);
    this._y = Math.asin(clamp(m13, -1, 1));
    if (Math.abs(m13) < 0.9999999) { this._x = Math.atan2(-m23, m33); this._z = Math.atan2(-m12, m11); }
    else { this._x = Math.atan2(m32, m22); this._z = 0; }
    if (notify && this._onChange) this._onChange();
    return this;
  }
}
