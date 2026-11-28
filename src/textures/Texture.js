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
      userData: this.userData ? { ...this.userData } : {},
    });
    t.name = this.name;
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
      return new Texture(null, { width: 2, height: 2, colorSpace, userData: { presetId: 'checker' } });
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
    return new Texture(cv, { colorSpace, userData: { presetId: 'checker' } });
  }
  static createPreset(presetId = 'checker', opts = {}) {
    const id = String(presetId || 'checker');
    const colorSpace = opts.colorSpace || 'srgb';
    if (id === 'checker') return Texture.checkerboard(opts);
    if (typeof document === 'undefined') {
      return new Texture(null, { width: 2, height: 2, colorSpace, userData: { presetId: id } });
    }
    const size = Math.max(32, opts.size ?? 256);
    const cv = document.createElement('canvas');
    cv.width = size;
    cv.height = size;
    const ctx = cv.getContext('2d');

    if (id === 'grid') {
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(0, 0, size, size);
      const step = size / 8;
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
      ctx.lineWidth = 1.5;
      for (let i = 0; i <= 8; i++) {
        const p = i * step;
        ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, size); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(size, p); ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.75)';
      ctx.lineWidth = 3;
      ctx.strokeRect(1.5, 1.5, size - 3, size - 3);
    } else if (id === 'stripes') {
      ctx.fillStyle = '#f8fafc';
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = '#0f172a';
      const bands = 8;
      const bandW = size / bands;
      for (let i = -bands; i < bands * 2; i += 2) {
        ctx.beginPath();
        ctx.moveTo(i * bandW, 0);
        ctx.lineTo((i + 1) * bandW, 0);
        ctx.lineTo((i + 1 - bands) * bandW, size);
        ctx.lineTo((i - bands) * bandW, size);
        ctx.closePath();
        ctx.fill();
      }
    } else if (id === 'brick') {
      ctx.fillStyle = '#cbd5e1';
      ctx.fillRect(0, 0, size, size);
      const rows = 8;
      const cols = 4;
      const rowH = size / rows;
      const colW = size / cols;
      const gap = Math.max(2, size * 0.015);
      for (let r = 0; r < rows; r++) {
        const offset = (r % 2) * (colW * 0.5);
        for (let c = -1; c <= cols; c++) {
          const shade = ((r * 7 + c * 13) & 3) * 8;
          ctx.fillStyle = `rgb(${175 + shade}, ${76 + Math.floor(shade * 0.6)}, ${58 + Math.floor(shade * 0.4)})`;
          ctx.fillRect(c * colW + offset + gap * 0.5, r * rowH + gap * 0.5, colW - gap, rowH - gap);
        }
      }
    } else if (id === 'wood') {
      const grad = ctx.createLinearGradient(0, 0, size, 0);
      grad.addColorStop(0, '#8b5a2b');
      grad.addColorStop(0.5, '#a47148');
      grad.addColorStop(1, '#7c4d25');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, size, size);
      for (let i = 0; i < 42; i++) {
        const y = (i / 42) * size;
        ctx.strokeStyle = i % 3 === 0 ? 'rgba(62, 34, 14, 0.32)' : 'rgba(215, 175, 128, 0.18)';
        ctx.lineWidth = 1 + (i % 3);
        ctx.beginPath();
        ctx.moveTo(0, y);
        for (let x = 0; x <= size; x += 16) {
          ctx.lineTo(x, y + Math.sin(x * 0.04 + i * 0.7) * 4);
        }
        ctx.stroke();
      }
    } else if (id === 'noise') {
      const imgData = ctx.createImageData(size, size);
      let seed = 1337;
      const nextRand = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 4294967296;
      };
      const block = 4;
      for (let by = 0; by < size; by += block) {
        for (let bx = 0; bx < size; bx += block) {
          const v = Math.floor(110 + nextRand() * 110);
          for (let dy = 0; dy < block && by + dy < size; dy++) {
            for (let dx = 0; dx < block && bx + dx < size; dx++) {
              const p = ((by + dy) * size + (bx + dx)) * 4;
              imgData.data[p] = v;
              imgData.data[p + 1] = v;
              imgData.data[p + 2] = Math.min(255, v + 6);
              imgData.data[p + 3] = 255;
            }
          }
        }
      }
      ctx.putImageData(imgData, 0, 0);
    } else if (id === 'uv') {
      const gX = ctx.createLinearGradient(0, 0, size, 0);
      gX.addColorStop(0, '#0f172a');
      gX.addColorStop(1, '#ef4444');
      ctx.fillStyle = gX;
      ctx.fillRect(0, 0, size, size);
      ctx.globalCompositeOperation = 'lighter';
      const gY = ctx.createLinearGradient(0, size, 0, 0);
      gY.addColorStop(0, '#000000');
      gY.addColorStop(1, '#22c55e');
      ctx.fillStyle = gY;
      ctx.fillRect(0, 0, size, size);
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
      ctx.lineWidth = 1;
      const step = size / 8;
      for (let i = 0; i <= 8; i++) {
        const p = i * step;
        ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, size); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(size, p); ctx.stroke();
      }
      ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.font = `700 ${Math.round(size * 0.14)}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('UV', size * 0.5, size * 0.5);
    } else {
      return Texture.checkerboard(opts);
    }

    return new Texture(cv, { colorSpace, userData: { presetId: id } });
  }
}
