// Colores en 0..1. Acepta 0xRRGGBB, '#rgb', '#rrggbb', (r,g,b) u otro Color.
export class Color {
  constructor(...a) { this.r = 1; this.g = 1; this.b = 1; if (a.length) this.set(...a); }
  set(a, g, b) {
    if (a && a.r !== undefined) return this.copy(a);
    if (typeof a === 'number') {
      if (g === undefined) return this.setHex(a);
      this.r = a; this.g = g; this.b = b ?? 0; return this;
    }
    if (typeof a === 'string') return this.setStyle(a);
    return this;
  }
  setHex(h) { this.r = ((h >> 16) & 255) / 255; this.g = ((h >> 8) & 255) / 255; this.b = (h & 255) / 255; return this; }
  setStyle(s) {
    let m = /^#?([0-9a-f]{6})$/i.exec(s.trim());
    if (m) return this.setHex(parseInt(m[1], 16));
    m = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(s.trim());
    if (m) return this.setHex(parseInt(m[1] + m[1] + m[2] + m[2] + m[3] + m[3], 16));
    return this;
  }
  getHex() {
    const r = Math.min(255, Math.max(0, Math.round(this.r * 255)));
    const g = Math.min(255, Math.max(0, Math.round(this.g * 255)));
    const b = Math.min(255, Math.max(0, Math.round(this.b * 255)));
    return (r << 16) | (g << 8) | b;
  }
  copy(c) { this.r = c.r; this.g = c.g; this.b = c.b; return this; }
  clone() { return new Color(this.r, this.g, this.b); }
  multiplyScalar(s) { this.r *= s; this.g *= s; this.b *= s; return this; }
  lerp(c, t) { this.r += (c.r - this.r) * t; this.g += (c.g - this.g) * t; this.b += (c.b - this.b) * t; return this; }
  toArray(a = [], o = 0) { a[o] = this.r; a[o + 1] = this.g; a[o + 2] = this.b; return a; }
}
