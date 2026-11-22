import { Mat4 } from '../math/Mat4.js';
import { Frustum } from './Frustum.js';
import { Vec3 } from '../math/Vec3.js';
import { Texture } from '../textures/Texture.js';
import { GL2Backend } from './WebGL2/GL2Backend.js';

const MAX_DIR = 4;
const MAX_POINT = 4;

const _lv = new Mat4(), _lview = new Mat4(), _lproj = new Mat4(), _lvp = new Mat4();
const _eye = new Vec3(), _up = new Vec3(0, 1, 0);
const cmpOpaque = (a, b) => a.order - b.order || a.material.id - b.material.id || a.depth - b.depth;
const cmpTransparent = (a, b) => a.order - b.order || b.depth - a.depth;
const s2l = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));

function detectMobile() {
  if (typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '') ||
    (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches);
}

export class Renderer {
  /**
   * opts: { canvas, backend: 'webgl2'|'webgpu'|'auto', quality: 'auto'|'high'|'medium'|'low',
   *         colorSpace: 'srgb'|'linear', antialias, alpha, pixelRatio, targetFps, shadowScale }
   *
   * - `new Renderer(opts)` inicializa de forma síncrona con WebGL2 (compatible con código existente).
   * - `await Renderer.create(opts)` permite usar WebGPU (`backend: 'auto'` o `'webgpu'`) con respaldo automático a WebGL2.
   */
  constructor(opts = {}) {
    this.domElement = opts.canvas || document.createElement('canvas');
    this.isMobile = detectMobile();
    this.targetFps = opts.targetFps || 60;
    this.clearColor = [0.05, 0.05, 0.07];
    this.contextLost = false;
    this.onContextLost = null;
    this.onContextRestored = null;
    this._colorSpace = opts.colorSpace || 'srgb';
    this.info = {
      backend: 'webgl2',
      calls: 0,
      triangles: 0,
      lines: 0,
      drawn: 0,
      culled: 0,
      instances: 0,
      pixelRatio: 1,
      fps: 0,
      shadowMapSize: 0,
      memory: { geometries: 0, textures: 0, programs: 0, instanceBuffers: 0 },
    };

    this._quality = opts.quality || 'auto';
    this._ratioOverride = opts.pixelRatio;
    this._shadowScaleOverride = opts.shadowScale;
    this.shadowScale = 1;

    this._frustum = new Frustum();
    this._viewProj = new Mat4();
    this._pool = [];
    this._poolN = 0;
    this._opaque = [];
    this._transparent = [];
    this._casters = [];
    this._afterRender = [];
    this._frame = 0;
    this._epoch = 0;
    this._cam = null;
    this._ve = null;
    this._t0 = performance.now();
    this._last = 0;
    this._ema = 0;
    this._cool = 0;
    this._ceil = Infinity;
    this._n = 0;
    this._target = 1000 / this.targetFps;

    const el = this.domElement;
    this._w = el.clientWidth || el.width || 300;
    this._h = el.clientHeight || el.height || 150;
    this._style = !opts.canvas;
    this._styled = false;
    this._rt = null;

    this._globals = {
      uView: null,
      uProjection: null,
      uTime: 0,
      uCameraPos: new Float32Array(3),
      uAmbient: new Float32Array(3),
      uDirColor: new Float32Array(MAX_DIR * 3),
      uDirDir: new Float32Array(MAX_DIR * 3),
      uDirCount: 0,
      uPointPos: new Float32Array(MAX_POINT * 3),
      uPointColor: new Float32Array(MAX_POINT * 3),
      uPointDist: new Float32Array(MAX_POINT),
      uPointDecay: new Float32Array(MAX_POINT),
      uPointCount: 0,
      uFogColor: new Float32Array(3),
      uFogNear: 0,
      uFogFar: 0,
      uFogDensity: 0,
      uShadowMap: null,
      uShadowMatrix: new Mat4(),
      uShadowBias: 0,
      uShadowRadius: 1.25,
      uShadowStrength: 1,
      uShadowLight: -1,
      uEnvMap: null,
      uEnvIntensity: 1,
      uEnvHasMap: 0,
      uEnvMaxMip: 0,
      uEnvGain: 1,
      uEnvSH: new Float32Array(27),
    };
    this._envShVec4 = new Float32Array(36);
    this._dummyBlackTex = new Texture({
      mipmaps: [{ data: new Uint8Array([0, 0, 0, 255]), width: 1, height: 1 }],
      width: 1,
      height: 1,
      colorSpace: 'linear',
      flipY: false,
      wrapS: 'repeat',
      wrapT: 'clamp',
      minFilter: 'linear',
      magFilter: 'linear',
    });
    this._globals.uEnvMap = this._dummyBlackTex;
    this._nDir = 0;
    this._nPoint = 0;
    this._fogOn = false;
    this._shadowOn = false;
    this._shadowLightIndex = -1;
    this._shadowLight = null;
    this._lastShadowInfo = null;
    this._lastRenderToCanvasRenderedViewport = false;
    this._lockedCaptureSize = null;
    this.backend = null;

    if (!opts._deferBackend) {
      const req = (opts.backend || 'webgl2').toLowerCase();
      if (req === 'webgpu') {
        throw new Error('Made3D: WebGPU se inicializa de forma asíncrona. Usa `await Renderer.create({ ...opts, backend: "webgpu" })`.');
      }
      this.backend = new GL2Backend(this, opts);
      this.info.backend = this.backend.type;
      this.setQuality(this._quality);
    }
  }

  /**
   * Crea un Renderer seleccionando el backend ('auto' | 'webgpu' | 'webgl2').
   * En 'auto' intenta usar WebGPU si está disponible y cae limpiamente a WebGL2 si falla.
   */
  static async create(opts = {}) {
    const pref = (opts.backend || 'auto').toLowerCase();
    const renderer = new Renderer({ ...opts, _deferBackend: true });

    const tryWebGPU = async () => {
      if (typeof navigator === 'undefined' || !navigator.gpu) {
        throw new Error('Made3D: este navegador no expone navigator.gpu (WebGPU).');
      }
      const { GPUBackend } = await import('./WebGPU/GPUBackend.js');
      return GPUBackend.create(renderer, opts);
    };

    if (pref === 'webgpu') {
      renderer.backend = await tryWebGPU();
    } else if (pref === 'webgl2') {
      renderer.backend = new GL2Backend(renderer, opts);
    } else {
      try {
        renderer.backend = await tryWebGPU();
      } catch (gpuErr) {
        try {
          renderer.backend = new GL2Backend(renderer, opts);
        } catch (glErr) {
          throw new Error(
            `Made3D: no se pudo inicializar WebGPU ni WebGL2 (${gpuErr?.message || gpuErr}; ${glErr?.message || glErr}).`
          );
        }
      }
    }

    renderer.info.backend = renderer.backend.type;
    renderer.setQuality(renderer._quality);
    return renderer;
  }

  static isWebGPUSupported() {
    return typeof navigator !== 'undefined' && Boolean(navigator.gpu);
  }

  get gl() { return this.backend && this.backend.gl ? this.backend.gl : null; }
  get device() { return this.backend && this.backend.device ? this.backend.device : null; }
  get backendType() { return this.backend ? this.backend.type : 'webgl2'; }
  get isWebGPU() { return this.backendType === 'webgpu'; }
  get isWebGL2() { return this.backendType === 'webgl2'; }
  get _frameId() { return this._frame; }

  isContextLost() {
    return this.contextLost || !this.backend || this.backend.isContextLost();
  }

  // ───────── render targets ─────────
  setRenderTarget(rt) {
    this._rt = rt || null;
    if (rt && this.backend) this.backend.prepareRenderTarget(rt);
    return this;
  }
  get renderTarget() { return this._rt; }

  // ───────── capacidades / calidad / color / tamaño ─────────
  getCapabilities() {
    if (this.backend) return this.backend.getCapabilities();
    return {
      backend: 'none',
      maxTextureSize: 4096,
      maxRenderbufferSize: 4096,
      maxViewportWidth: 4096,
      maxViewportHeight: 4096,
      maxRenderWidth: 4096,
      maxRenderHeight: 4096,
    };
  }

  clampRenderSize(width, height, opts = {}) {
    const caps = this.getCapabilities();
    const minSize = Math.max(1, Math.round(opts.minSize || 1));
    const maxOpt = opts.maxSize > 0 ? opts.maxSize : Infinity;
    const maxTex = caps.maxTextureSize > 0 ? caps.maxTextureSize : Infinity;
    const rbCap = opts.depthBuffer === false ? Infinity : (caps.maxRenderbufferSize > 0 ? caps.maxRenderbufferSize : maxTex);
    const vpW = opts.forTarget ? Infinity : (caps.maxViewportWidth > 0 ? caps.maxViewportWidth : maxTex);
    const vpH = opts.forTarget ? Infinity : (caps.maxViewportHeight > 0 ? caps.maxViewportHeight : maxTex);
    const capW = Math.max(minSize, Math.min(maxTex, rbCap, vpW, maxOpt));
    const capH = Math.max(minSize, Math.min(maxTex, rbCap, vpH, maxOpt));

    const reqW = Math.round(Number(width) || 1);
    const reqH = Math.round(Number(height) || 1);
    let w = Math.max(minSize, Math.min(capW, reqW));
    let h = Math.max(minSize, Math.min(capH, reqH));

    if (opts.preserveAspect && (reqW > capW || reqH > capH)) {
      const scale = Math.min(capW / Math.max(1, reqW), capH / Math.max(1, reqH));
      w = Math.max(minSize, Math.floor(reqW * scale));
      h = Math.max(minSize, Math.floor(reqH * scale));
    }
    if (opts.even) {
      w = Math.max(2, w - (w % 2));
      h = Math.max(2, h - (h % 2));
    }
    return {
      width: w,
      height: h,
      clamped: w !== reqW || h !== reqH,
      maxWidth: capW,
      maxHeight: capH,
      capabilities: caps,
    };
  }

  get quality() { return this._quality; }
  setQuality(q) {
    this._quality = q;
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    let max;
    switch (q) {
      case 'high': max = Math.min(dpr, 3); break;
      case 'medium': max = Math.min(dpr, 1.5); break;
      case 'low': max = Math.min(dpr, 1) * 0.75; break;
      default: max = this.isMobile ? Math.min(dpr, 1.5) : Math.min(dpr, 2);
    }
    if (this._shadowScaleOverride !== undefined) {
      this.shadowScale = this._shadowScaleOverride;
    } else {
      switch (q) {
        case 'high': this.shadowScale = 2; break;
        case 'medium': this.shadowScale = 1; break;
        case 'low': this.shadowScale = 0.5; break;
        default: this.shadowScale = this.isMobile ? 0.5 : 1;
      }
    }
    if (this._ratioOverride) max = this._ratioOverride;
    this.maxPixelRatio = max;
    this.minPixelRatio = Math.min(0.6, max);
    this.adaptive = q === 'auto';
    this._ceil = Infinity;
    this._target = 1000 / this.targetFps;
    this._n = 0;
    this._ema = 0;
    this._cool = 0;
    this._dropFrom = null;
    this.pixelRatio = max;
    this._resize();
  }

  get colorSpace() { return this._colorSpace; }
  set colorSpace(v) {
    if (v !== this._colorSpace) {
      this._colorSpace = v;
      this._epoch++;
    }
  }

  setSize(w, h, updateStyle = true) {
    this._w = w;
    this._h = h;
    this._style = updateStyle;
    if (!updateStyle && this._styled && this.domElement.style) {
      this.domElement.style.width = '';
      this.domElement.style.height = '';
      this._styled = false;
    }
    this._resize();
  }
  get aspect() { return this._w / this._h; }

  beginRecordingSession(width, height) {
    if (this.backend && this.backend.supportsOffscreenCapture) {
      this._lockedCaptureSize = null;
      return false;
    }
    const clamped = this.clampRenderSize(width || this._w || 1920, height || this._h || 1080, {
      minSize: 2,
      even: true,
    });
    this._lockedCaptureSize = { width: clamped.width, height: clamped.height };
    const c = this.domElement;
    if (c.width !== clamped.width) c.width = clamped.width;
    if (c.height !== clamped.height) c.height = clamped.height;
    return true;
  }

  endRecordingSession() {
    if (!this._lockedCaptureSize) return;
    this._lockedCaptureSize = null;
    this._resize();
  }

  _resize() {
    const c = this.domElement;
    if (this._lockedCaptureSize) {
      if (c.width !== this._lockedCaptureSize.width) c.width = this._lockedCaptureSize.width;
      if (c.height !== this._lockedCaptureSize.height) c.height = this._lockedCaptureSize.height;
      this.info.pixelRatio = this.pixelRatio;
      return;
    }
    const nw = Math.max(1, Math.floor(this._w * this.pixelRatio));
    const nh = Math.max(1, Math.floor(this._h * this.pixelRatio));
    if (c.width !== nw) c.width = nw;
    if (c.height !== nh) c.height = nh;
    if (this._style && c.style) {
      c.style.width = this._w + 'px';
      c.style.height = this._h + 'px';
      this._styled = true;
    }
    this.info.pixelRatio = this.pixelRatio;
  }

  _adapt() {
    const now = performance.now();
    let dt = 0;
    if (this._last) {
      dt = now - this._last;
      if (dt > 0 && dt < 2000) {
        this._ema = this._ema ? this._ema * 0.85 + dt * 0.15 : dt;
        this._n++;
        this.info.fps = Math.max(1, Math.round(1000 / this._ema));
      }
    }
    this._last = now;
    if (!this.adaptive || dt >= 250 || this._n < 60 || ++this._cool < 45) return;
    const target = this._target;
    if (this._ema > target * 1.3) {
      if (this.pixelRatio > this.minPixelRatio) {
        if (this._dropFrom === null) this._dropFrom = this.pixelRatio;
        this._ceil = this.pixelRatio - 0.01;
        this.pixelRatio = Math.max(this.minPixelRatio, this.pixelRatio - 0.15);
        this._cool = 0;
        this._resize();
      } else {
        this._target = this._ema;
        this._ceil = this.minPixelRatio;
        this._cool = 0;
        this._dropFrom = null;
      }
    } else if (this._ema < target * 1.08 && this.pixelRatio < Math.min(this.maxPixelRatio, this._ceil)) {
      this.pixelRatio = Math.min(this.maxPixelRatio, this._ceil, this.pixelRatio + 0.1);
      this._cool = 0;
      this._resize();
    }
  }

  // ───────── render principal ─────────
  render(scene, camera, opts = {}) {
    if (this.isContextLost()) return;
    const info = this.info;
    if (!opts.skipAdapt) this._adapt();
    info.calls = 0;
    info.triangles = 0;
    info.lines = 0;
    info.drawn = 0;
    info.culled = 0;
    info.instances = 0;
    this._frame++;

    scene.updateMatrixWorld();
    if (!camera.parent) camera.updateMatrixWorld();
    camera.updateViewMatrix();
    this._viewProj.multiplyMatrices(camera.projectionMatrix, camera.viewMatrix);
    this._frustum.setFromMatrix(this._viewProj);
    this._ve = camera.viewMatrix.elements;

    const ce = camera.matrixWorld.elements;
    const g = this._globals;
    g.uView = camera.viewMatrix.elements;
    g.uProjection = camera.projectionMatrix.elements;
    g.uCameraPos[0] = ce[12];
    g.uCameraPos[1] = ce[13];
    g.uCameraPos[2] = ce[14];
    g.uTime = typeof opts.time === 'number' && Number.isFinite(opts.time)
      ? opts.time
      : (performance.now() - this._t0) / 1000;
    g.uAmbient[0] = g.uAmbient[1] = g.uAmbient[2] = 0;
    this._nDir = 0;

    this._cam = camera;
    this._poolN = 0;
    this._opaque.length = 0;
    this._transparent.length = 0;
    this._casters.length = 0;
    this._afterRender.length = 0;
    this._nPoint = 0;
    this._shadowLightIndex = -1;
    this._shadowLight = null;
    this._collect(scene);
    g.uDirCount = this._nDir;
    g.uPointCount = this._nPoint;

    const fog = scene.fog;
    this._fogOn = !!fog;
    if (fog) {
      g.uFogColor[0] = fog.color.r;
      g.uFogColor[1] = fog.color.g;
      g.uFogColor[2] = fog.color.b;
      g.uFogNear = fog.near || 0;
      g.uFogFar = fog.far || 0;
      g.uFogDensity = fog.density || 0;
    }

    this._shadowOn = false;
    info.shadowMapSize = 0;
    if (this._shadowLightIndex >= 0 && this._shadowLight) {
      let sm = null;
      const prevShadow = this._lastShadowInfo;
      if (
        opts.reuseShadowMap &&
        prevShadow &&
        prevShadow.scene === scene &&
        prevShadow.light === this._shadowLight &&
        prevShadow.frame === this._frame - 1 &&
        typeof this.backend.reuseShadowMap === 'function'
      ) {
        sm = this.backend.reuseShadowMap(this._shadowLight, prevShadow.lightVP);
      } else {
        const lightVP = this._lightMatrix(this._shadowLight);
        sm = this.backend.renderShadowMap(this._shadowLight, this._casters, lightVP);
        if (sm) {
          if (!this._lastShadowInfo) {
            this._lastShadowInfo = { scene, light: this._shadowLight, frame: this._frame, lightVP: new Mat4() };
          }
          this._lastShadowInfo.scene = scene;
          this._lastShadowInfo.light = this._shadowLight;
          this._lastShadowInfo.frame = this._frame;
          this._lastShadowInfo.lightVP.copy(sm.matrix);
        } else {
          this._lastShadowInfo = null;
        }
      }
      if (sm) {
        this._shadowOn = true;
        info.shadowMapSize = sm.size || 0;
        g.uShadowMap = sm.texture;
        g.uShadowMatrix.copy(sm.matrix);
        g.uShadowBias = this._shadowLight.shadow.bias;
        g.uShadowRadius = this._shadowLight.shadow.radius ?? 1.25;
        g.uShadowStrength = this._shadowLight.shadow.strength;
        g.uShadowLight = this._shadowLightIndex;
      }
    } else {
      this._lastShadowInfo = null;
      g.uShadowMap = null;
      g.uShadowLight = -1;
    }

    const envTex = scene.environment || null;
    if (envTex) {
      g.uEnvMap = envTex;
      g.uEnvHasMap = 1;
      g.uEnvIntensity = scene.environmentIntensity ?? 1.0;
      const ibl = envTex.userData && envTex.userData.ibl ? envTex.userData.ibl : null;
      g.uEnvMaxMip = ibl && typeof ibl.maxMip === 'number'
        ? ibl.maxMip
        : (Array.isArray(envTex.mipmaps) && envTex.mipmaps.length > 1 ? envTex.mipmaps.length - 1 : 6);
      g.uEnvGain = ibl && typeof ibl.gain === 'number' ? ibl.gain : 1.0;
      if (ibl && ibl.sh && ibl.sh.length >= 36) {
        this._envShVec4.set(ibl.sh.subarray(0, 36));
        for (let k = 0; k < 9; k++) {
          g.uEnvSH[k * 3 + 0] = ibl.sh[k * 4 + 0];
          g.uEnvSH[k * 3 + 1] = ibl.sh[k * 4 + 1];
          g.uEnvSH[k * 3 + 2] = ibl.sh[k * 4 + 2];
        }
      } else {
        this._envShVec4.fill(0);
        g.uEnvSH.fill(0);
        this._envShVec4[0] = this._envShVec4[1] = this._envShVec4[2] = 0.45;
        g.uEnvSH[0] = g.uEnvSH[1] = g.uEnvSH[2] = 0.45;
      }
    } else {
      g.uEnvMap = this._dummyBlackTex;
      g.uEnvHasMap = 0;
      g.uEnvIntensity = 0;
      g.uEnvMaxMip = 0;
      g.uEnvGain = 1;
      this._envShVec4.fill(0);
      g.uEnvSH.fill(0);
    }

    const bg = scene.background;
    const c = this.clearColor;
    const clearRGB = bg ? [bg.r, bg.g, bg.b] : [c[0], c[1], c[2]];

    this.backend.beginMainPass(clearRGB, this._rt);
    this._opaque.sort(cmpOpaque);
    this._transparent.sort(cmpTransparent);
    for (let i = 0; i < this._opaque.length; i++) this.backend.drawItem(this._opaque[i]);
    for (let i = 0; i < this._transparent.length; i++) this.backend.drawItem(this._transparent[i]);
    this.backend.endMainPass();

    if (!this._rt && this._afterRender.length) {
      for (let i = 0; i < this._afterRender.length; i++) {
        this._afterRender[i].onAfterRender(this, scene, camera);
      }
    }

    for (let i = 0; i < this._poolN; i++) {
      const it = this._pool[i];
      it.mesh = null;
      it.material = null;
    }
    this._opaque.length = 0;
    this._transparent.length = 0;
    this._casters.length = 0;
    this._afterRender.length = 0;
    this._cam = null;
  }

  _collect(obj) {
    if (!obj.visible) return;
    if (obj.onBeforeRender) obj.onBeforeRender(this, this._cam);
    if (obj.onAfterRender) this._afterRender.push(obj);
    if (obj.isMesh) {
      this._addMesh(obj);
      if (
        obj.castShadow &&
        obj.geometry &&
        obj.geometry.attributes.position &&
        (!obj.material || obj.material.visible !== false) &&
        (!obj.drawMode || obj.drawMode === 'triangles')
      ) {
        this._casters.push(obj);
      }
    } else if (obj.isLight) {
      this._addLight(obj);
    }
    const ch = obj.children;
    for (let i = 0; i < ch.length; i++) this._collect(ch[i]);
  }

  _addMesh(mesh) {
    const geo = mesh.geometry, mat = mesh.material;
    if (!geo || !mat || mat.visible === false || !geo.attributes.position) return;
    const instanced = !!mesh.isInstancedMesh, e = mesh.matrixWorld.elements;
    let x = e[12], y = e[13], z = e[14];
    const bs = mesh.boundingSphere || (instanced ? null : geo.getBoundingSphere());
    if (this._isGpuSkin(mesh)) {
      const sk = mesh.skeleton;
      sk.updateOnce(this._frame);
      x = sk.center.x; y = sk.center.y; z = sk.center.z;
      if (
        mesh.frustumCulled &&
        mat.frustumCulled !== false &&
        !this._frustum.intersectsSphere(x, y, z, sk.radius + mesh.skinPad * sk.maxScale)
      ) {
        this.info.culled++;
        return;
      }
    } else if (bs) {
      const c = bs.center;
      x = e[0] * c.x + e[4] * c.y + e[8] * c.z + e[12];
      y = e[1] * c.x + e[5] * c.y + e[9] * c.z + e[13];
      z = e[2] * c.x + e[6] * c.y + e[10] * c.z + e[14];
      const morphPad = this._hasMorph(mesh) ? 1.5 : 1;
      if (
        mesh.frustumCulled &&
        mat.frustumCulled !== false &&
        !this._frustum.intersectsSphere(x, y, z, bs.radius * mesh.matrixWorld.getMaxScale() * morphPad)
      ) {
        this.info.culled++;
        return;
      }
    }
    const v = this._ve;
    let it = this._pool[this._poolN];
    if (!it) {
      it = { mesh: null, material: null, depth: 0, order: 0 };
      this._pool.push(it);
    }
    this._poolN++;
    it.mesh = mesh;
    it.material = mat;
    it.order = mesh.renderOrder;
    it.depth = -(v[2] * x + v[6] * y + v[10] * z + v[14]);
    (mat.transparent ? this._transparent : this._opaque).push(it);
  }

  _addLight(l) {
    const g = this._globals, k = l.intensity, c = l.color, srgb = this._colorSpace === 'srgb';
    const r = srgb ? s2l(c.r) : c.r, gg = srgb ? s2l(c.g) : c.g, b = srgb ? s2l(c.b) : c.b;
    if (l.type === 'ambient') {
      g.uAmbient[0] += r * k;
      g.uAmbient[1] += gg * k;
      g.uAmbient[2] += b * k;
    } else if (l.type === 'directional' && this._nDir < MAX_DIR) {
      const e = l.matrixWorld.elements, t = l.target;
      const dx = t.x - e[12], dy = t.y - e[13], dz = t.z - e[14];
      const len = Math.hypot(dx, dy, dz) || 1;
      const o = this._nDir * 3;
      g.uDirDir[o] = dx / len;
      g.uDirDir[o + 1] = dy / len;
      g.uDirDir[o + 2] = dz / len;
      g.uDirColor[o] = r * k;
      g.uDirColor[o + 1] = gg * k;
      g.uDirColor[o + 2] = b * k;
      if (l.castShadow && this._shadowLightIndex < 0) {
        this._shadowLightIndex = this._nDir;
        this._shadowLight = l;
      }
      this._nDir++;
    } else if (l.type === 'point' && this._nPoint < MAX_POINT) {
      const e = l.matrixWorld.elements, o = this._nPoint * 3;
      g.uPointPos[o] = e[12];
      g.uPointPos[o + 1] = e[13];
      g.uPointPos[o + 2] = e[14];
      g.uPointColor[o] = r * k;
      g.uPointColor[o + 1] = gg * k;
      g.uPointColor[o + 2] = b * k;
      g.uPointDist[this._nPoint] = l.distance || 0;
      g.uPointDecay[this._nPoint] = l.decay === undefined ? 2 : l.decay;
      this._nPoint++;
    }
  }

  // ───────── sombras y helpers de deformación ─────────
  getShadowMapSize(light) {
    return this.backend ? this.backend.getShadowMapSize(light) : 0;
  }

  _lightMatrix(light) {
    const e = light.matrixWorld.elements;
    const ex = e[12], ey = e[13], ez = e[14];
    const t = light.target;
    _lv.lookAt(_eye.set(ex, ey, ez), t, _up);
    const ve = _lv.elements, we = _lview.elements;
    we[0] = ve[0]; we[1] = ve[4]; we[2] = ve[8]; we[3] = 0;
    we[4] = ve[1]; we[5] = ve[5]; we[6] = ve[9]; we[7] = 0;
    we[8] = ve[2]; we[9] = ve[6]; we[10] = ve[10]; we[11] = 0;
    we[12] = -(ve[0] * ex + ve[1] * ey + ve[2] * ez);
    we[13] = -(ve[4] * ex + ve[5] * ey + ve[6] * ez);
    we[14] = -(ve[8] * ex + ve[9] * ey + ve[10] * ez);
    we[15] = 1;
    const d = Math.hypot(t.x - ex, t.y - ey, t.z - ez) || 1;
    const c = light.shadow.camera;
    const half = c ? (c.right - c.left) / 2 : Math.max(2, d);
    const near = c ? c.near : Math.max(0.1, d * 0.05);
    const far = c ? c.far : d * 3 + 10;
    _lproj.orthographic(c ? c.left : -half, c ? c.right : half, c ? c.top : half, c ? c.bottom : -half, near, far);
    return _lvp.multiplyMatrices(_lproj, _lview);
  }

  _hasMorph(mesh) {
    const inf = mesh.morphTargetInfluences;
    const ma = mesh.geometry && mesh.geometry.morphAttributes;
    return !!(inf && inf.length > 0 && ma && ma.position && ma.position.length > 0);
  }

  _isGpuSkin(mesh) {
    if (!mesh.isSkinnedMesh || !mesh.gpuSkinning || mesh.isInstancedMesh) return false;
    const sk = mesh.skeleton, a = mesh.geometry && mesh.geometry.attributes;
    return !!(sk && sk.bones.length && a && a.skinIndex && a.skinWeight);
  }

  renderOutline(params) {
    if (!this.isContextLost() && this.backend && typeof this.backend.renderOutline === 'function') {
      this.backend.renderOutline(params);
    }
  }

  async runComputeSculptBrush(positionsArray, normalsArray, params) {
    if (!this.isWebGPU || !this.backend || typeof this.backend.runComputeSculptBrush !== 'function') {
      return null;
    }
    return this.backend.runComputeSculptBrush(positionsArray, normalsArray, params);
  }

  // Libera de la GPU todo lo de un objeto y sus hijos.
  disposeObject(root) {
    root.traverse((o) => {
      if (o.isMesh) {
        if (o.geometry) o.geometry.dispose();
        const m = o.material;
        if (m) {
          if (m.dispose) m.dispose();
          if (m.map) m.map.dispose();
          if (m.normalMap) m.normalMap.dispose();
          if (m.emissiveMap) m.emissiveMap.dispose();
          if (m.aoMap) m.aoMap.dispose();
          if (m.metallicRoughnessMap) m.metallicRoughnessMap.dispose();
          if (m.roughnessMap) m.roughnessMap.dispose();
          if (m.metalnessMap) m.metalnessMap.dispose();
          if (m.matcap) m.matcap.dispose();
        }
        if (o.isInstancedMesh) o.dispose();
        if (o.isSkinnedMesh && o.skeleton) o.skeleton.dispose();
      }
    });
  }

  renderToCanvas(scene, camera, width = 1920, height = 1080, opts = {}) {
    if (!scene || !camera || this.isContextLost()) return null;
    const clamped = this.clampRenderSize(
      width || this._w || 1920,
      height || this._h || 1080,
      { maxSize: opts.maxSize || 8192, minSize: 1 }
    );
    const w = clamped.width;
    const h = clamped.height;

    const prevW = this._w, prevH = this._h;
    const prevStyle = this._style, prevStyled = this._styled;
    const prevPR = this.pixelRatio, prevAdaptive = this.adaptive, prevRt = this._rt;
    const prevLast = this._last;
    const prevAspect = camera.aspect;
    const prevLeft = camera.left, prevRight = camera.right, prevTop = camera.top, prevBottom = camera.bottom;

    const hideHelpers = opts.hideHelpers !== false;
    const includeGrid = opts.includeGrid === true;
    const hidden = [];
    if (hideHelpers && scene.traverse) {
      scene.traverse((o) => {
        if (!o) return;
        if (o.isGizmo || o.isTransformGizmo) {
          hidden.push([o, o._vis, true]);
          o._vis = false;
        } else if (o.isSkeletonHelper || o.isCameraHelper || (o.isGridHelper && !includeGrid)) {
          hidden.push([o, o.visible, false]);
          o.visible = false;
        }
      });
    }

    const out = opts.targetCanvas || (typeof document !== 'undefined' ? document.createElement('canvas') : null);
    if (!out) return null;

    let usedOffscreen = false;
    this._lastRenderToCanvasRenderedViewport = false;
    try {
      this._rt = null;
      this.adaptive = false;
      this.pixelRatio = 1;
      this._style = false;
      this._w = w;
      this._h = h;

      if (
        this.backend &&
        this.backend.supportsOffscreenCapture &&
        typeof this.backend.beginOffscreenCapture === 'function'
      ) {
        usedOffscreen = this.backend.beginOffscreenCapture(w, h);
      }
      if (!usedOffscreen) {
        if (this.domElement.width !== w) this.domElement.width = w;
        if (this.domElement.height !== h) this.domElement.height = h;
      }

      if (camera.fov !== undefined) {
        camera.aspect = w / h;
        if (camera.updateProjection) camera.updateProjection();
      } else if (camera.left !== undefined) {
        const cx = (prevLeft + prevRight) * 0.5;
        const hh = Math.abs(prevTop - prevBottom) * 0.5 || 1;
        const hw = hh * (w / h);
        camera.left = cx - hw;
        camera.right = cx + hw;
        if (camera.updateProjection) camera.updateProjection();
      }

      this.render(scene, camera, { skipAdapt: true, time: opts.time });
      if (typeof opts.onFrameReady === 'function') {
        const capSrc = usedOffscreen && typeof this.backend.getCaptureCanvas === 'function'
          ? this.backend.getCaptureCanvas()
          : this.domElement;
        opts.onFrameReady(capSrc, w, h);
      } else {
        this.backend.copyCanvasTo2D(out, w, h, { opaque: opts.opaque });
      }
      return out;
    } finally {
      if (usedOffscreen && typeof this.backend.endOffscreenCapture === 'function') {
        this.backend.endOffscreenCapture();
      }
      for (let i = 0; i < hidden.length; i++) {
        const [o, vis, isGizmo] = hidden[i];
        if (isGizmo) o._vis = vis;
        else o.visible = vis;
      }
      if (camera.fov !== undefined) {
        camera.aspect = prevAspect;
        if (camera.updateProjection) camera.updateProjection();
      } else if (camera.left !== undefined) {
        camera.left = prevLeft;
        camera.right = prevRight;
        camera.top = prevTop;
        camera.bottom = prevBottom;
        if (camera.updateProjection) camera.updateProjection();
      }
      this._rt = prevRt;
      this.adaptive = prevAdaptive;
      this.pixelRatio = prevPR;
      this._style = prevStyle;
      this._styled = prevStyled;
      this._w = prevW;
      this._h = prevH;
      this._last = prevLast;
      if (!usedOffscreen && !this._lockedCaptureSize) {
        this._resize();
      }
      if (opts.viewportCamera && !opts.deferViewportRender) {
        this.render(scene, opts.viewportCamera, { skipAdapt: true, reuseShadowMap: true, time: opts.time });
        this._lastRenderToCanvasRenderedViewport = true;
      }
    }
  }

  captureBlob(scene, camera, width = 1920, height = 1080, opts = {}) {
    const cv = this.renderToCanvas(scene, camera, width, height, opts);
    if (!cv) return Promise.resolve(null);
    const mime = opts.mimeType || 'image/png';
    const quality = opts.quality ?? 0.95;
    return new Promise((resolve) => {
      if (cv.toBlob) cv.toBlob((blob) => resolve(blob), mime, quality);
      else resolve(null);
    });
  }

  async createVideoRecorderAsync(scene, camera, width = 1920, height = 1080, opts = {}) {
    if (!Renderer._VideoRecorderClass) {
      const mod = await import('./VideoRecorder.js');
      Renderer._VideoRecorderClass = mod.VideoRecorder;
    }
    return new Renderer._VideoRecorderClass(this, scene, camera, width, height, opts);
  }

  createVideoRecorder(scene, camera, width = 1920, height = 1080, opts = {}) {
    const RecorderCtor = opts.VideoRecorder || Renderer._VideoRecorderClass;
    if (!RecorderCtor) {
      throw new Error('Made3D: VideoRecorder se carga bajo demanda. Usa `await renderer.createVideoRecorderAsync(...)` o `await loadVideoRecorder()`.');
    }
    return new RecorderCtor(this, scene, camera, width, height, opts);
  }

  async recordVideo(scene, camera, width = 1920, height = 1080, opts = {}) {
    const duration = Math.max(0.2, Number(opts.duration ?? 5));
    const recOpts = opts.mode ? opts : { ...opts, mode: 'fixed' };
    const recorder = await this.createVideoRecorderAsync(scene, camera, width, height, recOpts);
    if (typeof recorder.prepare === 'function') {
      await recorder.prepare();
    }
    if (recorder.mode === 'fixed' && !recorder._useWebCodecs) {
      recorder.mode = 'realtime';
    }
    recorder.start();

    if (recorder.mode === 'fixed' && recorder._useWebCodecs) {
      try {
        return await recorder.runFixedLoop({
          duration,
          viewportCamera: opts.viewportCamera,
          previewIntervalMs: opts.previewIntervalMs ?? 80,
          deferViewportRender: Boolean(opts.viewportCamera),
          signal: opts.signal,
          autoStop: true,
          onStep: typeof opts.onBeforeFrame === 'function'
            ? (fixedDt, simElapsed, frameIdx) => opts.onBeforeFrame(fixedDt, simElapsed, frameIdx)
            : null,
          onFrame: typeof opts.onProgress === 'function'
            ? (info) => opts.onProgress(info.progress, info.elapsed, info.frames)
            : null,
        });
      } catch (err) {
        recorder.cancel();
        throw err;
      }
    }

    return new Promise((resolve, reject) => {
      let lastT = performance.now();
      let stopped = false;

      const finish = () => {
        if (stopped) return;
        stopped = true;
        if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
        recorder.stop().then(resolve, reject);
      };

      const onAbort = () => {
        if (stopped) return;
        stopped = true;
        recorder.cancel();
        reject(new Error('Grabación de video cancelada.'));
      };
      if (opts.signal) {
        if (opts.signal.aborted) {
          onAbort();
          return;
        }
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }

      const step = () => {
        if (stopped || !recorder.recording) return;
        const now = performance.now();
        const dt = Math.min(0.1, (now - lastT) / 1000);
        lastT = now;
        const elapsed = (now - recorder._startTime) / 1000;

        if (typeof opts.onBeforeFrame === 'function') {
          try {
            opts.onBeforeFrame(dt, elapsed, recorder.frames);
          } catch (err) {
            stopped = true;
            recorder.cancel();
            reject(err);
            return;
          }
        }

        recorder.captureFrame(false, { viewportCamera: opts.viewportCamera, time: elapsed });

        if (typeof opts.onProgress === 'function') {
          opts.onProgress(Math.min(1, recorder.elapsed / duration), recorder.elapsed, recorder.frames);
        }

        if (recorder.elapsed >= duration) {
          finish();
          return;
        }
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(step);
        else setTimeout(step, Math.max(8, Math.round(1000 / recorder.fps)));
      };

      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(step);
      else setTimeout(step, Math.max(8, Math.round(1000 / recorder.fps)));
    });
  }

  dispose() {
    this._rt = null;
    if (this.backend) {
      this.backend.dispose();
      this.backend = null;
    }
  }
}

export class WebGPURenderer {
  constructor() {
    throw new Error('Made3D: usa `await WebGPURenderer.create(opts)` o `await Renderer.create({ ...opts, backend: "webgpu" })`.');
  }
  static create(opts = {}) {
    return Renderer.create({ ...opts, backend: 'webgpu' });
  }
  static isSupported() {
    return Renderer.isWebGPUSupported();
  }
}
