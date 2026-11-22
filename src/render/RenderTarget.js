import { EventEmitter } from '../core/EventEmitter.js';
import { Vec2 } from '../math/Vec2.js';

/**
 * Textura que apunta a un render target: sirve como `map` de un material (por ejemplo, para
 * Pintar una escena en un target y usarla como textura en otra).
 *
 * La textura se crea como SRGB8_ALPHA8 (o RGBA8 si el target es lineal) y el renderer dibuja
 * en los targets **en lineal** (sin la conversión a sRGB del lienzo), de modo que el viaje de
 * ida y vuelta conserva los colores.
 */
export class RenderTargetTexture {
  constructor(target) {
    this.isTexture = true;
    this.isRenderTargetTexture = true;
    this.target = target;
    this.version = 0;
    this.repeat = new Vec2(1, 1);
    this.offset = new Vec2(0, 0);
    this.wrapS = 'clamp';
    this.wrapT = 'clamp';
    this.minFilter = 'linear';
    this.magFilter = 'linear';
    this.flipY = false;
    this.colorSpace = target.colorSpace;
  }
  set needsUpdate(v) { if (v) this.version++; }
  isReady() { return true; }
  dispose() { this.target.dispose(); }
}

/**
 * Destination de render: una textura con la que puedes dibujar en vez de en el lienzo.
 *
 *   const rt = new RenderTarget(512, 512);
 *   renderer.setRenderTarget(rt);
 *   renderer.render(scene, camera);
 *   renderer.setRenderTarget(null);          // de vuelta al lienzo
 *   material.map = rt.texture;               // y se usa como textura
 *
 * Opciones: { depthBuffer: true, colorSpace: 'srgb' | 'linear' }
 */
export class RenderTarget extends EventEmitter {
  constructor(width = 256, height = 256, opts = {}) {
    super();
    this.isRenderTarget = true;
    this.width = Math.max(1, width | 0);
    this.height = Math.max(1, height | 0);
    this.depthBuffer = opts.depthBuffer !== false;
    // 'linear' (RGBA8, por defecto) | 'srgb' (SRGB8_ALPHA8: más precisión en las sombras oscuras)
    this.colorSpace = opts.colorSpace || 'linear';
    this.texture = new RenderTargetTexture(this);
  }
  setSize(w, h) {
    w = Math.max(1, w | 0); h = Math.max(1, h | 0);
    if (w !== this.width || h !== this.height) {
      this.width = w; this.height = h;
      this.emit('resize', { width: w, height: h });
    }
    return this;
  }
  dispose() { this.emit('dispose'); }
}
