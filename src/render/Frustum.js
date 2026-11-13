export class Frustum {
  constructor() { this.p = new Float64Array(24); }
  // m = proyección × vista
  setFromMatrix(m) {
    const e = m.elements, p = this.p;
    const set = (i, a, b, c, d) => {
      const l = Math.hypot(a, b, c) || 1;
      p[i] = a / l; p[i + 1] = b / l; p[i + 2] = c / l; p[i + 3] = d / l;
    };
    set(0, e[3] + e[0], e[7] + e[4], e[11] + e[8], e[15] + e[12]);   // izquierda
    set(4, e[3] - e[0], e[7] - e[4], e[11] - e[8], e[15] - e[12]);   // derecha
    set(8, e[3] + e[1], e[7] + e[5], e[11] + e[9], e[15] + e[13]);   // abajo
    set(12, e[3] - e[1], e[7] - e[5], e[11] - e[9], e[15] - e[13]);  // arriba
    set(16, e[3] + e[2], e[7] + e[6], e[11] + e[10], e[15] + e[14]); // cerca
    set(20, e[3] - e[2], e[7] - e[6], e[11] - e[10], e[15] - e[14]); // lejos
    return this;
  }
  intersectsSphere(x, y, z, r) {
    const p = this.p;
    for (let i = 0; i < 24; i += 4) {
      if (p[i] * x + p[i + 1] * y + p[i + 2] * z + p[i + 3] < -r) return false;
    }
    return true;
  }
}
