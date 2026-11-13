import { EventEmitter } from '../core/EventEmitter.js';
import { Vec2 } from '../math/Vec2.js';

export class Texture extends EventEmitter {
  // image: HTMLImageElement | HTMLCanvasElement | ImageBitmap
  constructor(image = null, opts = {}) {
    super();
    this.isTexture = true;
    this.image = image;
    this.repeat = new Vec2(1, 1);
    this.offset = new Vec2(0, 0);
    this.wrapS = opts.wrapS || 'repeat';           // 'repeat' | 'clamp' | 'mirror'
    this.wrapT = opts.wrapT || 'repeat';
    this.minFilter = opts.minFilter || 'linear-mipmap'; // 'nearest' | 'linear' | 'linear-mipmap'
    this.magFilter = opts.magFilter || 'linear';        // 'nearest' | 'linear'
    this.flipY = opts.flipY ?? true;
    this.colorSpace = opts.colorSpace || 'srgb';        // 'srgb' (colores) | 'linear' (normales, datos)
    this.version = 0;
  }
  // Marcar al cambiar la imagen o los filtros/wrap.
  set needsUpdate(v) { if (v) this.version++; }
  isReady() {
    const i = this.image;
    return !!i && i.complete !== false && ((i.naturalWidth || i.videoWidth || i.width) > 0);
  }
  dispose() { this.emit('dispose'); }
  // Copia con los mismos parámetros (comparte la imagen; sube su propia textura a la GPU).
  clone() {
    const t = new Texture(this.image, { wrapS: this.wrapS, wrapT: this.wrapT, minFilter: this.minFilter, magFilter: this.magFilter, flipY: this.flipY, colorSpace: this.colorSpace });
    t.repeat.copy(this.repeat); t.offset.copy(this.offset);
    return t;
  }
  static load(url, opts) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const t = new Texture(img, opts);
    img.onload = () => { t.needsUpdate = true; };
    img.src = url;
    return t;
  }
}
