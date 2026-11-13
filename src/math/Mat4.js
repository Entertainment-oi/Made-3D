const _t = new Float64Array(16);
let _dm = null;
let _warnedSingular = false;

// Matriz 4x4 en orden de columnas (igual que WebGL).
export class Mat4 {
  constructor() { this.elements = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); }
  identity() { this.elements.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); return this; }
  copy(m) { this.elements.set(m.elements); return this; }
  clone() { return new Mat4().copy(this); }

  multiplyMatrices(a, b) {
    const A = a.elements, B = b.elements;
    for (let c = 0; c < 4; c++) {
      const k = c * 4, b0 = B[k], b1 = B[k + 1], b2 = B[k + 2], b3 = B[k + 3];
      _t[k] = A[0] * b0 + A[4] * b1 + A[8] * b2 + A[12] * b3;
      _t[k + 1] = A[1] * b0 + A[5] * b1 + A[9] * b2 + A[13] * b3;
      _t[k + 2] = A[2] * b0 + A[6] * b1 + A[10] * b2 + A[14] * b3;
      _t[k + 3] = A[3] * b0 + A[7] * b1 + A[11] * b2 + A[15] * b3;
    }
    this.elements.set(_t);
    return this;
  }
  multiply(m) { return this.multiplyMatrices(this, m); }

  compose(p, q, s) {
    const te = this.elements, x = q.x, y = q.y, z = q.z, w = q.w;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
    const sx = s.x, sy = s.y, sz = s.z;
    te[0] = (1 - (yy + zz)) * sx; te[1] = (xy + wz) * sx; te[2] = (xz - wy) * sx; te[3] = 0;
    te[4] = (xy - wz) * sy; te[5] = (1 - (xx + zz)) * sy; te[6] = (yz + wx) * sy; te[7] = 0;
    te[8] = (xz + wy) * sz; te[9] = (yz - wx) * sz; te[10] = (1 - (xx + yy)) * sz; te[11] = 0;
    te[12] = p.x; te[13] = p.y; te[14] = p.z; te[15] = 1;
    return this;
  }

  // Separa la matriz en posición, rotación (Quat) y escala (Vec3).
  decompose(pos, quat, scale) {
    const e = this.elements;
    let sx = Math.hypot(e[0], e[1], e[2]);
    const sy = Math.hypot(e[4], e[5], e[6]), sz = Math.hypot(e[8], e[9], e[10]);
    const det = e[0] * (e[5] * e[10] - e[9] * e[6]) - e[4] * (e[1] * e[10] - e[9] * e[2]) + e[8] * (e[1] * e[6] - e[5] * e[2]);
    if (det < 0) sx = -sx;
    pos.set(e[12], e[13], e[14]);
    const m = _dm.elements, ix = 1 / (sx || 1), iy = 1 / (sy || 1), iz = 1 / (sz || 1);
    m.set(e);
    m[0] *= ix; m[1] *= ix; m[2] *= ix; m[4] *= iy; m[5] *= iy; m[6] *= iy; m[8] *= iz; m[9] *= iz; m[10] *= iz;
    quat.setFromRotationMatrix(_dm);
    scale.set(sx, sy, sz);
    return this;
  }

  invert() {
    const a = this.elements;
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3], a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11], a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
    const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det) {
      if (!_warnedSingular) { _warnedSingular = true; console.warn('Made3D: Mat4.invert() con matriz singular (escala 0 o NaN); se devuelve la identidad.'); }
      return this.identity();
    }
    det = 1 / det;
    a[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
    a[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    a[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
    a[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    a[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
    a[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    a[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
    a[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    a[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
    a[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    a[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
    a[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    a[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
    a[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
    a[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
    a[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
    return this;
  }
  copyInverse(m) { return this.copy(m).invert(); }

  // Solo rota: el eje -Z apunta de `eye` hacia `target`.
  lookAt(eye, target, up) {
    const te = this.elements;
    let zx = eye.x - target.x, zy = eye.y - target.y, zz = eye.z - target.z;
    let l = Math.hypot(zx, zy, zz);
    if (l === 0) { zz = 1; l = 1; }
    zx /= l; zy /= l; zz /= l;
    let xx = up.y * zz - up.z * zy, xy = up.z * zx - up.x * zz, xz = up.x * zy - up.y * zx;
    l = Math.hypot(xx, xy, xz);
    if (l === 0) { // up paralelo a la vista
      if (Math.abs(up.z) === 1) zx += 0.0001; else zz += 0.0001;
      l = Math.hypot(zx, zy, zz); zx /= l; zy /= l; zz /= l;
      xx = up.y * zz - up.z * zy; xy = up.z * zx - up.x * zz; xz = up.x * zy - up.y * zx;
      l = Math.hypot(xx, xy, xz);
    }
    xx /= l; xy /= l; xz /= l;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    te[0] = xx; te[4] = yx; te[8] = zx;
    te[1] = xy; te[5] = yy; te[9] = zy;
    te[2] = xz; te[6] = yz; te[10] = zz;
    return this;
  }

  perspective(fovRad, aspect, near, far) {
    const te = this.elements, f = 1 / Math.tan(fovRad / 2), nf = 1 / (near - far);
    te.fill(0);
    te[0] = f / aspect; te[5] = f; te[10] = (far + near) * nf; te[11] = -1; te[14] = 2 * far * near * nf;
    return this;
  }
  orthographic(l, r, t, b, n, f) {
    const te = this.elements, w = 1 / (r - l), h = 1 / (t - b), p = 1 / (f - n);
    te.fill(0);
    te[0] = 2 * w; te[5] = 2 * h; te[10] = -2 * p; te[12] = -(r + l) * w; te[13] = -(t + b) * h; te[14] = -(f + n) * p; te[15] = 1;
    return this;
  }

  getMaxScale() {
    const e = this.elements;
    const x = e[0] * e[0] + e[1] * e[1] + e[2] * e[2], y = e[4] * e[4] + e[5] * e[5] + e[6] * e[6], z = e[8] * e[8] + e[9] * e[9] + e[10] * e[10];
    return Math.sqrt(Math.max(x, y, z));
  }

  // Inversa transpuesta de la parte 3x3 → `out` (Float32Array de 9).
  normalMatrix(out) {
    const e = this.elements;
    const a = e[0], b = e[1], c = e[2], d = e[4], f = e[5], g = e[6], h = e[8], i = e[9], j = e[10];
    const c00 = f * j - i * g, c01 = -(b * j - i * c), c02 = b * g - f * c;
    const c10 = -(d * j - h * g), c11 = a * j - h * c, c12 = -(a * g - d * c);
    const c20 = d * i - h * f, c21 = -(a * i - h * b), c22 = a * f - d * b;
    let det = a * c00 + d * c01 + h * c02;
    det = det ? 1 / det : 0;
    out[0] = c00 * det; out[1] = c10 * det; out[2] = c20 * det;
    out[3] = c01 * det; out[4] = c11 * det; out[5] = c21 * det;
    out[6] = c02 * det; out[7] = c12 * det; out[8] = c22 * det;
    return out;
  }
}

_dm = new Mat4();
