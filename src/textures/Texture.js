import { EventEmitter } from '../core/EventEmitter.js';
import { Vec2 } from '../math/Vec2.js';

export class Texture extends EventEmitter {
  // image: HTMLImageElement | HTMLCanvasElement | ImageBitmap (o mipmaps para texturas comprimidas KTX2)
  constructor(image = null, opts = {}) {
    super();
    this.isTexture = true;
    this.image = image;
    this.mipmaps = opts.mipmaps || null;             // [{ data: Uint8Array, width, height }]
    this.format = opts.format ?? null;               // formato interno WebGL (comprimido o RGBA)
    this.srgbFormat = opts.srgbFormat ?? null;       // variante sRGB WebGL si existe
    this.formatId = opts.formatId ?? null;           // identificador portátil WebGPU ('astc-4x4', 'bc7', etc.)
    this.compressed = Boolean(opts.compressed);
    this.isCompressedTexture = Boolean(opts.isCompressedTexture || this.compressed);
    this.width = opts.width ?? (image ? (image.naturalWidth || image.videoWidth || image.width || 0) : (opts.mipmaps?.[0]?.width || 0));
    this.height = opts.height ?? (image ? (image.naturalHeight || image.videoHeight || image.height || 0) : (opts.mipmaps?.[0]?.height || 0));
    this.repeat = new Vec2(opts.repeat?.x ?? 1, opts.repeat?.y ?? 1);
    this.offset = new Vec2(opts.offset?.x ?? 0, opts.offset?.y ?? 0);
    this.center = new Vec2(opts.center?.x ?? 0, opts.center?.y ?? 0);
    this.rotation = opts.rotation ?? 0;
    this.texCoord = opts.texCoord ?? 0;
    this.wrapS = opts.wrapS || 'repeat';             // 'repeat' | 'clamp' | 'mirror'
    this.wrapT = opts.wrapT || 'repeat';
    this.minFilter = opts.minFilter || 'linear-mipmap'; // 'nearest' | 'linear' | 'linear-mipmap'
    this.magFilter = opts.magFilter || 'linear';        // 'nearest' | 'linear'
    this.flipY = opts.flipY ?? true;
    this.colorSpace = opts.colorSpace || 'srgb';        // 'srgb' (colores) | 'linear' (normales, datos)
    this.userData = opts.userData ? { ...opts.userData } : {};
    this.version = 0;
    this._dirtyRect = null;
    this._deferMipmaps = false;
  }
  // Marcar al cambiar la imagen o los filtros/wrap.
  set needsUpdate(v) {
    if (v) {
      this._dirtyRect = null;
      this._deferMipmaps = false;
      this.version++;
    }
  }
  markRegionDirty(x0, y0, x1, y1, deferMipmaps = false) {
    const minX = Math.max(0, x0 | 0);
    const minY = Math.max(0, y0 | 0);
    const maxX = Math.max(minX, x1 | 0);
    const maxY = Math.max(minY, y1 | 0);
    if (!this._dirtyRect) {
      this._dirtyRect = { minX, minY, maxX, maxY };
    } else {
      if (minX < this._dirtyRect.minX) this._dirtyRect.minX = minX;
      if (minY < this._dirtyRect.minY) this._dirtyRect.minY = minY;
      if (maxX > this._dirtyRect.maxX) this._dirtyRect.maxX = maxX;
      if (maxY > this._dirtyRect.maxY) this._dirtyRect.maxY = maxY;
    }
    this._deferMipmaps = Boolean(deferMipmaps);
    this.version++;
  }
  isReady() {
    if (this.mipmaps && this.mipmaps.length > 0) return true;
    const i = this.image;
    return !!i && i.complete !== false && ((i.naturalWidth || i.videoWidth || i.width) > 0);
  }
  getUvMatrix(out = new Float32Array(9)) {
    const sx = this.repeat.x, sy = this.repeat.y;
    const ox = this.offset.x, oy = this.offset.y;
    const cx = this.center.x, cy = this.center.y;
    const r = this.rotation || 0;
    const c = Math.cos(r), s = Math.sin(r);
    // Matriz glTF KHR_texture_transform (column-major): T(offset) * T(center) * R(rotation) * S(scale) * T(-center)
    out[0] = sx * c;
    out[1] = -sx * s;
    out[2] = 0;
    out[3] = sy * s;
    out[4] = sy * c;
    out[5] = 0;
    out[6] = -cx * (sx * c) - cy * (sy * s) + cx + ox;
    out[7] = -cx * (-sx * s) - cy * (sy * c) + cy + oy;
    out[8] = 1;
    return out;
  }
  dispose() { this.emit('dispose'); }
  // Copia con los mismos parámetros (comparte la imagen/mipmaps; sube su propia textura a la GPU).
  clone() {
    const t = new Texture(this.image, {
      mipmaps: this.mipmaps,
      format: this.format,
      srgbFormat: this.srgbFormat,
      formatId: this.formatId,
      compressed: this.compressed,
      isCompressedTexture: this.isCompressedTexture,
      texCoord: this.texCoord,
      rotation: this.rotation,
      wrapS: this.wrapS,
      wrapT: this.wrapT,
      minFilter: this.minFilter,
      magFilter: this.magFilter,
      flipY: this.flipY,
      colorSpace: this.colorSpace,
    });
    t.repeat.copy(this.repeat); t.offset.copy(this.offset); t.center.copy(this.center);
    return t;
  }
  static load(url, opts) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const t = new Texture(img, opts);
    img.onload = () => {
      t.width = img.naturalWidth || img.width || 0;
      t.height = img.naturalHeight || img.height || 0;
      t.needsUpdate = true;
    };
    img.src = url;
    return t;
  }
  static checkerboard(opts = {}) {
    const colorSpace = opts.colorSpace || 'srgb';
    if (typeof document === 'undefined') {
      return new Texture(null, { width: 2, height: 2, colorSpace });
    }
    const size = Math.max(16, opts.size ?? 256);
    const cells = Math.max(2, opts.cells ?? 8);
    const cv = document.createElement('canvas');
    cv.width = size;
    cv.height = size;
    const ctx = cv.getContext('2d');
    const cellSize = size / cells;
    const light = opts.lightColor || '#e2e8f0';
    const dark = opts.darkColor || '#475569';
    for (let y = 0; y < cells; y++) {
      for (let x = 0; x < cells; x++) {
        ctx.fillStyle = (x + y) % 2 === 0 ? light : dark;
        ctx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);
      }
    }
    const borderColor = opts.borderColor !== undefined ? opts.borderColor : 'rgba(229, 149, 68, 0.55)';
    if (borderColor) {
      const lw = opts.borderWidth ?? 4;
      ctx.strokeStyle = borderColor;
      ctx.lineWidth = lw;
      ctx.strokeRect(lw * 0.5, lw * 0.5, size - lw, size - lw);
    }
    return new Texture(cv, { colorSpace });
  }
}
