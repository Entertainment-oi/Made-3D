import { Mat4 } from '../math/Mat4.js';
import { Frustum } from './Frustum.js';
import { Program, setUniform } from './Program.js';
import { buildSource } from '../shaders/prelude.js';
import { SHADOW_VERT, SHADOW_FRAG } from '../shaders/builtin.js';
import { Vec3 } from '../math/Vec3.js';

const LOC = { position: 0, normal: 1, uv: 2, color: 7, skinIndex: 8, skinWeight: 9 };
const INST = 3; // aInstance ocupa las ubicaciones 3..6
const MAX_DIR = 4;
const MAX_POINT = 4;
const MAX_LIGHTS = 32;   // variantes de programa: instanciado · sRGB · niebla · sombras · skinning

const _lv = new Mat4(), _lview = new Mat4(), _lproj = new Mat4(), _lvp = new Mat4();
const _eye = new Vec3(), _up = new Vec3(0, 1, 0);
const cmpOpaque = (a, b) => a.order - b.order || a.material.id - b.material.id || a.depth - b.depth;
const cmpTransparent = (a, b) => a.order - b.order || b.depth - a.depth;
const s2l = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));

// Envoltura de la textura del mapa de sombras: sirve como sampler en los materiales.
class ShadowTexture {
  constructor(map) {
    this.isTexture = true;
    this.isShadowTexture = true;
    this.map = map;
    this.version = 0;
    this.colorSpace = 'linear';
  }
  isReady() { return true; }
  set needsUpdate(v) { /* la sombra se redibuja cada cuadro */ }
}

function detectMobile() {
  if (typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '') ||
    (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches);
}

export class Renderer {
  /**
   * opts: { canvas, quality: 'auto'|'high'|'medium'|'low', colorSpace: 'srgb'|'linear',
   *         antialias, alpha, pixelRatio, targetFps }
   * 'auto' adapta la resolución al dispositivo (teléfono/tablet/PC) y baja/sube según los FPS.
   */
  constructor(opts = {}) {
    this.domElement = opts.canvas || document.createElement('canvas');
    this.isMobile = detectMobile();
    this.targetFps = opts.targetFps || 60;
    this.clearColor = [0.05, 0.05, 0.07];
    this.contextLost = false;
    this.onContextLost = null; this.onContextRestored = null;
    this._colorSpace = opts.colorSpace || 'srgb';
    this.info = { calls: 0, triangles: 0, lines: 0, drawn: 0, culled: 0, instances: 0, pixelRatio: 1, fps: 0,
      memory: { geometries: 0, textures: 0, programs: 0, instanceBuffers: 0 } };

    this._quality = opts.quality || 'auto';
    this._ratioOverride = opts.pixelRatio;
    const aa = opts.antialias ?? (this._quality === 'high' || (this._quality === 'auto' && !this.isMobile));
    const gl = this.domElement.getContext('webgl2', { antialias: aa, alpha: opts.alpha ?? false, powerPreference: 'high-performance', stencil: false });
    if (!gl) throw new Error('Made3D: este navegador no soporta WebGL2');
    this.gl = gl;

    this._frustum = new Frustum();
    this._viewProj = new Mat4();
    this._nm = new Float32Array(9);
    this._scratch = new Float32Array(16 * 256);
    this._pool = []; this._poolN = 0;
    this._opaque = []; this._transparent = [];
    this._frame = 0; this._epoch = 0; this._cam = null; this._ve = null;
    this._t0 = performance.now();
    this._last = 0; this._ema = 0; this._cool = 0; this._ceil = Infinity; this._n = 0; this._target = 1000 / this.targetFps;
    this._w = 300; this._h = 150; this._style = true;
    this._targets = new WeakMap();   // render target → recursos de GPU
    this._rt = null;                 // render target activo (null = el lienzo)

    this._globals = {
      uView: null, uProjection: null, uTime: 0,
      uCameraPos: new Float32Array(3), uAmbient: new Float32Array(3),
      uDirColor: new Float32Array(MAX_DIR * 3), uDirDir: new Float32Array(MAX_DIR * 3), uDirCount: 0,
      uPointPos: new Float32Array(MAX_POINT * 3), uPointColor: new Float32Array(MAX_POINT * 3),
      uPointDist: new Float32Array(MAX_POINT), uPointDecay: new Float32Array(MAX_POINT), uPointCount: 0,
      uFogColor: new Float32Array(3), uFogNear: 0, uFogFar: 0, uFogDensity: 0,
      uShadowMap: null, uShadowMatrix: new Mat4(), uShadowBias: 0, uShadowStrength: 1, uShadowLight: -1,
    };
    this._nDir = 0;
    this._nPoint = 0;
    this._fogOn = false;
    this._shadowOn = false;
    this._shadowLightIndex = -1;
    this._shadowLight = null;

    this._initGL();

    // Pérdida del contexto WebGL (p. ej. el sistema lo quita al ir a segundo plano): se recupera solo.
    const cv = this.domElement;
    if (cv.addEventListener) {
      cv.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        this.contextLost = true;
        if (this.onContextLost) this.onContextLost();
      });
      cv.addEventListener('webglcontextrestored', () => {
        this._initGL();
        this.contextLost = false;
        this._n = 0; this._ema = 0; this._cool = 0;
        if (this.onContextRestored) this.onContextRestored();
      });
    }

    this.setQuality(this._quality);
  }

  // (Re)crea todo el estado de GPU. Se llama al inicio y al recuperar el contexto.
  _initGL() {
    const gl = this.gl;
    this._programs = new Map();
    this._geo = new WeakMap();
    this._tex = new WeakMap();
    this._inst = new WeakMap();
    this._boneTex = new WeakMap();   // esqueleto → textura de huesos (skinning en GPU)
    // lo que depende del contexto también se recrea al recuperarlo
    this._targets = new WeakMap();   // render target → recursos de GPU
    this._shadows = new Map();       // luz → mapa de sombras
    this._shadowProgs = new Map();   // programa de profundidad
    this._white = null;
    this._aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    this._epoch++;
    this._cur = null; this._vao = null; this._lastMat = null; this._lastMatProg = null;
    const m = this.info.memory; m.geometries = m.textures = m.programs = m.instanceBuffers = 0;
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true);
    gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK);
    gl.disable(gl.BLEND);
    gl.vertexAttrib4f(LOC.normal, 0, 0, 1, 0);
    gl.vertexAttrib4f(LOC.uv, 0, 0, 0, 1);
    gl.vertexAttrib4f(LOC.color, 1, 1, 1, 1);
    this._st = { blend: 'none', depthTest: true, depthWrite: true, side: 'front' };
  }

  // ───────── render targets ─────────
  // Dibuja a partir de ahora en un target (o en el lienzo si es null).
  setRenderTarget(rt) {
    this._rt = rt || null;
    if (rt) this._getTarget(rt);
    return this;
  }
  get renderTarget() { return this._rt; }

  _applyTargetSampler(rt, t) {
    const gl = this.gl, tex = rt.texture;
    const key = `${tex.version}|${tex.wrapS}|${tex.wrapT}|${tex.minFilter}|${tex.magFilter}`;
    if (t.samplerKey === key) return;
    const wrap = { repeat: gl.REPEAT, clamp: gl.CLAMP_TO_EDGE, mirror: gl.MIRRORED_REPEAT };
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap[tex.wrapS] || gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap[tex.wrapT] || gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, tex.magFilter === 'nearest' ? gl.NEAREST : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, tex.minFilter === 'nearest' ? gl.NEAREST : gl.LINEAR);
    t.samplerKey = key;
  }

  // Recursos de GPU de un target (framebuffer, textura y profundidad). Se crean al vuelo.
  _getTarget(rt) {
    const gl = this.gl;
    let t = this._targets.get(rt), created = false;
    if (!t) {
      const onDispose = () => {
        rt.off('dispose', onDispose);
        if (this._targets.get(rt) === t) this._disposeTarget(rt);
      };
      t = { fbo: gl.createFramebuffer(), tex: gl.createTexture(), depth: null, w: 0, h: 0, samplerKey: '', onDispose };
      this._targets.set(rt, t);
      created = true;
      rt.on('dispose', onDispose);
    }
    if (t.w !== rt.width || t.h !== rt.height) {
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      const srgb = rt.colorSpace !== 'linear';
      gl.texImage2D(gl.TEXTURE_2D, 0, srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8, rt.width, rt.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      t.samplerKey = '';
      this._applyTargetSampler(rt, t);
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
      if (rt.depthBuffer) {
        if (!t.depth) t.depth = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, t.depth);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, rt.width, rt.height);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, t.depth);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      t.w = rt.width; t.h = rt.height;
      if (created) this.info.memory.textures++;
    }
    return t;
  }

  _disposeTarget(rt) {
    const gl = this.gl, t = this._targets.get(rt);
    if (!t) return;
    if (t.onDispose) rt.off('dispose', t.onDispose);
    gl.deleteFramebuffer(t.fbo);
    gl.deleteTexture(t.tex);
    if (t.depth) gl.deleteRenderbuffer(t.depth);
    this._targets.delete(rt);
    this.info.memory.textures--;
    if (this._rt === rt) this._rt = null;
  }

  // ───────── calidad / color / tamaño ─────────
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
    if (this._ratioOverride) max = this._ratioOverride;
    this.maxPixelRatio = max;
    this.minPixelRatio = Math.min(0.6, max);
    this.adaptive = q === 'auto';
    this._ceil = Infinity; this._target = 1000 / this.targetFps; this._n = 0; this._ema = 0; this._cool = 0; this._dropFrom = null;
    this.pixelRatio = max;
    this._resize();
  }
  // 'srgb' (por defecto): colores y texturas en sRGB, iluminación en lineal, salida corregida.
  // 'linear': sin conversión (aspecto más oscuro/plano en materiales con luz).
  get colorSpace() { return this._colorSpace; }
  set colorSpace(v) { if (v !== this._colorSpace) { this._colorSpace = v; this._epoch++; } }

  setSize(w, h, updateStyle = true) { this._w = w; this._h = h; this._style = updateStyle; this._resize(); }
  get aspect() { return this._w / this._h; }
  _resize() {
    const c = this.domElement;
    c.width = Math.max(1, Math.floor(this._w * this.pixelRatio));
    c.height = Math.max(1, Math.floor(this._h * this.pixelRatio));
    if (this._style && c.style) { c.style.width = this._w + 'px'; c.style.height = this._h + 'px'; }
    this.info.pixelRatio = this.pixelRatio;
  }
  _adapt() {
    const now = performance.now();
    if (this._last) {
      const dt = now - this._last;
      if (dt < 100) { this._ema = this._ema ? this._ema * 0.9 + dt * 0.1 : dt; this._n++; this.info.fps = Math.round(1000 / this._ema); }
    }
    this._last = now;
    if (!this.adaptive || this._n < 60 || ++this._cool < 45) return;
    const target = this._target;
    if (this._ema > target * 1.3) {
      if (this.pixelRatio > this.minPixelRatio) {
        if (this._dropFrom === null) this._dropFrom = this.pixelRatio;
        this._ceil = this.pixelRatio - 0.01;
        this.pixelRatio = Math.max(this.minPixelRatio, this.pixelRatio - 0.15);
        this._cool = 0; this._resize();
      } else {
        // Ya está en el mínimo y no llega al objetivo: la pantalla o el ahorro de energía limitan los FPS.
        // Ese ritmo pasa a ser el nuevo objetivo y se vuelve a subir la resolución.
        this._target = this._ema; this._ceil = Infinity; this._cool = 0;
        if (this._dropFrom !== null) { this.pixelRatio = Math.min(this.maxPixelRatio, this._dropFrom); this._resize(); }
        this._dropFrom = null;
      }
    } else if (this._ema < target * 1.08 && this.pixelRatio < Math.min(this.maxPixelRatio, this._ceil)) {
      this.pixelRatio = Math.min(this.maxPixelRatio, this._ceil, this.pixelRatio + 0.1);
      this._cool = 0; this._resize();
    }
  }

  // ───────── render principal ─────────
  render(scene, camera) {
    if (this.contextLost || this.gl.isContextLost()) return;
    const gl = this.gl, info = this.info;
    this._adapt();
    info.calls = 0; info.triangles = 0; info.lines = 0; info.drawn = 0; info.culled = 0; info.instances = 0;
    this._frame++;
    this._lastMat = null; this._lastMatProg = null;

    scene.updateMatrixWorld();
    if (!camera.parent) camera.updateMatrixWorld();
    camera.updateViewMatrix();
    this._viewProj.multiplyMatrices(camera.projectionMatrix, camera.viewMatrix);
    this._frustum.setFromMatrix(this._viewProj);
    this._ve = camera.viewMatrix.elements;

    const ce = camera.matrixWorld.elements;
    const g = this._globals;
    g.uView = camera.viewMatrix.elements; g.uProjection = camera.projectionMatrix.elements;
    g.uCameraPos[0] = ce[12]; g.uCameraPos[1] = ce[13]; g.uCameraPos[2] = ce[14];
    g.uTime = (performance.now() - this._t0) / 1000;
    g.uAmbient[0] = g.uAmbient[1] = g.uAmbient[2] = 0;
    this._nDir = 0;

    this._cam = camera;
    this._poolN = 0; this._opaque.length = 0; this._transparent.length = 0;
    this._nPoint = 0;
    this._shadowLightIndex = -1;
    this._shadowLight = null;
    this._collect(scene);
    g.uDirCount = this._nDir;
    g.uPointCount = this._nPoint;

    // niebla de la escena
    const fog = scene.fog;
    this._fogOn = !!fog;
    if (fog) {
      g.uFogColor[0] = fog.color.r; g.uFogColor[1] = fog.color.g; g.uFogColor[2] = fog.color.b;
      g.uFogNear = fog.near || 0; g.uFogFar = fog.far || 0; g.uFogDensity = fog.density || 0;
    }

    // sombras: primero se dibuja el mapa de profundidad de la luz que las proyecta
    this._shadowOn = false;
    if (this._shadowLightIndex >= 0 && this._shadowLight) {
      const sm = this._renderShadowMap(scene, this._shadowLight);
      if (sm) {
        this._shadowOn = true;
        g.uShadowMap = sm.texture;
        g.uShadowMatrix.copy(sm.matrix);
        g.uShadowBias = this._shadowLight.shadow.bias;
        g.uShadowStrength = this._shadowLight.shadow.strength;
        g.uShadowLight = this._shadowLightIndex;
      }
    } else {
      g.uShadowMap = null;
      g.uShadowLight = -1;
    }

    // En los render targets se dibuja en lineal (la textura guarda el sRGB por su cuenta),
    // así que el color de limpieza también va en lineal.
    const bg = scene.background, lin = !!this._rt;
    if (bg) {
      const r = lin ? s2l(bg.r) : bg.r, gg = lin ? s2l(bg.g) : bg.g, b = lin ? s2l(bg.b) : bg.b;
      gl.clearColor(r, gg, b, 1);
    } else {
      const c = this.clearColor;
      gl.clearColor(lin ? s2l(c[0]) : c[0], lin ? s2l(c[1]) : c[1], lin ? s2l(c[2]) : c[2], 1);
    }
    // dibujar en el render target activo o en el lienzo
    if (this._rt) {
      const t = this._getTarget(this._rt);
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
      gl.viewport(0, 0, this._rt.width, this._rt.height);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.domElement.width, this.domElement.height);
    }
    if (!this._st.depthWrite) { gl.depthMask(true); this._st.depthWrite = true; }
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    this._opaque.sort(cmpOpaque);
    this._transparent.sort(cmpTransparent);
    for (let i = 0; i < this._opaque.length; i++) this._draw(this._opaque[i]);
    for (let i = 0; i < this._transparent.length; i++) this._draw(this._transparent[i]);

    // no retener referencias a objetos que luego se quiten de la escena
    for (let i = 0; i < this._poolN; i++) { const it = this._pool[i]; it.mesh = null; it.material = null; }
    this._opaque.length = 0; this._transparent.length = 0;
    this._cam = null; this._lastMat = null; this._lastMatProg = null;
  }

  get _frameId() { return this._frame; }

  _collect(obj) {
    if (!obj.visible) return;
    if (obj.onBeforeRender) obj.onBeforeRender(this, this._cam);
    if (obj.isMesh) this._addMesh(obj);
    else if (obj.isLight) this._addLight(obj);
    const ch = obj.children;
    for (let i = 0; i < ch.length; i++) this._collect(ch[i]);
  }

  _addMesh(mesh) {
    const geo = mesh.geometry, mat = mesh.material;
    if (!geo || !mat || mat.visible === false || !geo.attributes.position) return;
    const instanced = !!mesh.isInstancedMesh, e = mesh.matrixWorld.elements;
    let x = e[12], y = e[13], z = e[14];
    // esfera envolvente: la de la geometría, o la propia del mesh (p. ej. cada chunk)
    const bs = mesh.boundingSphere || (instanced ? null : geo.getBoundingSphere());
    if (this._isGpuSkin(mesh)) {
      // con skinning en la GPU los vértices están donde los lleven los huesos, no donde diga la geometría
      const sk = mesh.skeleton;
      sk.updateOnce(this._frame);
      x = sk.center.x; y = sk.center.y; z = sk.center.z;
      if (mesh.frustumCulled && mat.frustumCulled !== false &&
          !this._frustum.intersectsSphere(x, y, z, sk.radius + mesh.skinPad * sk.maxScale)) { this.info.culled++; return; }
    } else if (bs) {
      const c = bs.center;
      x = e[0] * c.x + e[4] * c.y + e[8] * c.z + e[12];
      y = e[1] * c.x + e[5] * c.y + e[9] * c.z + e[13];
      z = e[2] * c.x + e[6] * c.y + e[10] * c.z + e[14];
      if (mesh.frustumCulled && mat.frustumCulled !== false &&
          !this._frustum.intersectsSphere(x, y, z, bs.radius * mesh.matrixWorld.getMaxScale())) { this.info.culled++; return; }
    }
    const v = this._ve;
    let it = this._pool[this._poolN];
    if (!it) { it = { mesh: null, material: null, depth: 0, order: 0 }; this._pool.push(it); }
    this._poolN++;
    it.mesh = mesh; it.material = mat; it.order = mesh.renderOrder;
    it.depth = -(v[2] * x + v[6] * y + v[10] * z + v[14]); // profundidad en el espacio de la cámara
    (mat.transparent ? this._transparent : this._opaque).push(it);
  }

  _addLight(l) {
    const g = this._globals, k = l.intensity, c = l.color, srgb = this._colorSpace === 'srgb';
    const r = srgb ? s2l(c.r) : c.r, gg = srgb ? s2l(c.g) : c.g, b = srgb ? s2l(c.b) : c.b;
    if (l.type === 'ambient') {
      g.uAmbient[0] += r * k; g.uAmbient[1] += gg * k; g.uAmbient[2] += b * k;
    } else if (l.type === 'directional' && this._nDir < MAX_DIR) {
      const e = l.matrixWorld.elements, t = l.target;
      const dx = t.x - e[12], dy = t.y - e[13], dz = t.z - e[14];
      const len = Math.hypot(dx, dy, dz) || 1;
      const o = this._nDir * 3;
      g.uDirDir[o] = dx / len; g.uDirDir[o + 1] = dy / len; g.uDirDir[o + 2] = dz / len;
      g.uDirColor[o] = r * k; g.uDirColor[o + 1] = gg * k; g.uDirColor[o + 2] = b * k;
      if (l.castShadow && this._shadowLightIndex < 0) { this._shadowLightIndex = this._nDir; this._shadowLight = l; }
      this._nDir++;
    } else if (l.type === 'point' && this._nPoint < MAX_POINT) {
      const e = l.matrixWorld.elements, o = this._nPoint * 3;
      g.uPointPos[o] = e[12]; g.uPointPos[o + 1] = e[13]; g.uPointPos[o + 2] = e[14];
      g.uPointColor[o] = r * k; g.uPointColor[o + 1] = gg * k; g.uPointColor[o + 2] = b * k;
      g.uPointDist[this._nPoint] = l.distance || 0;
      g.uPointDecay[this._nPoint] = l.decay === undefined ? 2 : l.decay;
      this._nPoint++;
    }
  }

  // ───────── sombras ─────────
  // Mapa de profundidad de la luz: textura con comparación (el hardware suaviza el borde).
  _getShadowMap(light) {
    const gl = this.gl;
    const size = Math.max(64, light.shadow.mapSize | 0);
    let sm = this._shadows.get(light);
    if (sm && sm.size !== size) { this._disposeShadowMap(light); sm = null; }
    if (sm) return sm;
    sm = { size, fbo: gl.createFramebuffer(), tex: gl.createTexture(), color: null, texture: null };
    gl.bindTexture(gl.TEXTURE_2D, sm.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, size, size, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    gl.bindFramebuffer(gl.FRAMEBUFFER, sm.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, sm.tex, 0);
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      // si el navegador no acepta un framebuffer sin color, se le añade una textura de color
      sm.color = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, sm.color);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, sm.color, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    sm.texture = new ShadowTexture(sm);
    this._shadows.set(light, sm);
    return sm;
  }

  _disposeShadowMap(light) {
    const gl = this.gl, sm = this._shadows.get(light);
    if (!sm) return;
    gl.deleteFramebuffer(sm.fbo);
    gl.deleteTexture(sm.tex);
    if (sm.color) gl.deleteTexture(sm.color);
    this._shadows.delete(light);
  }

  // Matriz de la luz: cámara ortográfica que mira desde la luz hacia su objetivo.
  _lightMatrix(light) {
    const e = light.matrixWorld.elements;
    const ex = e[12], ey = e[13], ez = e[14];
    const t = light.target;
    _lv.lookAt(_eye.set(ex, ey, ez), t, _up);
    const ve = _lv.elements, we = _lview.elements;
    // Mat4.lookAt da la rotación local→mundo (los ejes van en las columnas): la vista es su
    // transpuesta (los ejes en las filas) más la traslación que lleva la luz al origen.
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

  // Programa de profundidad (solo posiciones).
  _getShadowProgram(instanced, skinned = false) {
    const key = (instanced ? 'shadow|I' : 'shadow|N') + (skinned ? '|G' : '');
    let p = this._shadowProgs.get(key);
    if (p) return p;
    const defs = skinned ? { USE_SKINNING: 1 } : {};
    p = new Program(this.gl,
      buildSource('vertex', SHADOW_VERT, defs, instanced, false),
      buildSource('fragment', SHADOW_FRAG, defs, instanced, false));
    p.uLightMatrix = p.byName.uLightMatrix ? p.byName.uLightMatrix.loc : null;
    this._shadowProgs.set(key, p);
    this.info.memory.programs++;
    return p;
  }

  // Dibuja la profundidad de los objetos que proyectan sombra.
  _renderShadowMap(scene, light) {
    const gl = this.gl;
    const sm = this._getShadowMap(light);
    const vp = this._lightMatrix(light);
    const casters = [];
    const walkCasters = (o) => {
      if (!o.visible) return;
      if (o.castShadow && o.isMesh && o.geometry && o.geometry.attributes.position &&
          (!o.material || o.material.visible !== false) && (!o.drawMode || o.drawMode === 'triangles')) {
        casters.push(o);
      }
      const ch = o.children;
      for (let i = 0; i < ch.length; i++) walkCasters(ch[i]);
    };
    walkCasters(scene);

    gl.bindFramebuffer(gl.FRAMEBUFFER, sm.fbo);
    gl.viewport(0, 0, sm.size, sm.size);
    gl.colorMask(false, false, false, false);
    if (!this._st.depthWrite) { gl.depthMask(true); this._st.depthWrite = true; }
    if (!this._st.depthTest) { gl.enable(gl.DEPTH_TEST); this._st.depthTest = true; }
    if (this._st.side !== 'front') { gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK); this._st.side = 'front'; }
    gl.clear(gl.DEPTH_BUFFER_BIT);

    let p = null;
    for (const mesh of casters) {
      const inst = !!mesh.isInstancedMesh;
      const skin = this._isGpuSkin(mesh);
      if (skin) mesh.skeleton.updateOnce(this._frame);
      else if (mesh.isSkinnedMesh && mesh.autoUpdateSkin) {   // skinning en CPU
        if (mesh.skeleton) mesh.skeleton.update();
        mesh.updateSkinnedVertices();
      }
      const want = this._getShadowProgram(inst, skin);
      if (want !== p) {
        p = want;
        gl.useProgram(p.program);
        gl.uniformMatrix4fv(p.uLightMatrix, false, vp.elements);
      }
      const gg = this._getGeometry(mesh.geometry);
      if (skin) this._setSkinUniforms(p, mesh);
      else if (p.uModel !== null) gl.uniformMatrix4fv(p.uModel, false, mesh.matrixWorld.elements);
      if (inst) {
        const attr = mesh.instanceMatrix, a = attr.array, total = Math.min(mesh.count, (a.length / 16) | 0);
        if (total > 0) {
          const ig = this._ensureInstanced(mesh, gg, attr);
          if (ig.version !== attr.version || ig.attr !== attr || !ig.full) {
            gl.bindBuffer(gl.ARRAY_BUFFER, ig.buf);
            if (a.byteLength > ig.byteLength) {
              gl.bufferData(gl.ARRAY_BUFFER, a.byteLength, gl.DYNAMIC_DRAW);
              ig.byteLength = a.byteLength;
            }
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, a, 0, total * 16);
            ig.attr = attr; ig.version = attr.version; ig.full = true;
          }
          this._bindVAO(ig.vao);
          if (gg.indexed) gl.drawElementsInstanced(gl.TRIANGLES, gg.count, gg.indexType, 0, total);
          else gl.drawArraysInstanced(gl.TRIANGLES, 0, gg.count, total);
        }
      } else {
        this._bindVAO(gg.vao);
        if (gg.indexed) gl.drawElements(gl.TRIANGLES, gg.count, gg.indexType, 0);
        else gl.drawArrays(gl.TRIANGLES, 0, gg.count);
      }
    }
    gl.colorMask(true, true, true, true);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this._cur = null;   // el programa activo en GL ahora es el de profundidad: el pase principal debe volver a elegir el suyo
    return { texture: sm.texture, matrix: vp };
  }

  // ───────── dibujo ─────────
  _draw(item) {
    const gl = this.gl, mesh = item.mesh, m = item.material;
    const instanced = !!mesh.isInstancedMesh;
    // Malla con esqueleto: en la GPU (por defecto) o, si se pide, deformando los vértices en la CPU.
    const skin = this._isGpuSkin(mesh);
    if (!skin && mesh.isSkinnedMesh && mesh.autoUpdateSkin) {
      if (mesh.skeleton) mesh.skeleton.update();
      mesh.updateSkinnedVertices();
    }
    const gg = this._getGeometry(mesh.geometry);
    const p = this._getProgram(m, instanced, mesh.receiveShadow === false, skin);
    if (this._cur !== p) { gl.useProgram(p.program); this._cur = p; }
    if (p.frame !== this._frame) { this._upload(p, this._globals); p.frame = this._frame; this._lastMat = null; }
    if (this._lastMat !== m || this._lastMatProg !== p) {
      m.updateUniforms();
      this._upload(p, m.uniforms);
      this._lastMat = m; this._lastMatProg = p;
    }
    if (skin) this._setSkinUniforms(p, mesh);
    else {
      if (p.uModel !== null) gl.uniformMatrix4fv(p.uModel, false, mesh.matrixWorld.elements);
      if (p.uNormalMatrix !== null && !instanced) gl.uniformMatrix3fv(p.uNormalMatrix, false, mesh.matrixWorld.normalMatrix(this._nm));
    }

    // Cómo se dibuja: líneas (grid), wireframe (aristas) o triángulos.
    const mode = mesh.drawMode || (m.wireframe ? 'wireframe' : 'triangles');
    if (mode !== 'triangles') {
      this._setState(m, 'front');
      this._issue(mesh, gg, instanced, mode);
      return;
    }
    if (m.transparent && m.side === 'double' && m.twoPass !== false) {
      // caras traseras primero y luego delanteras: evita artefactos en transparencias de doble cara
      this._setState(m, 'back'); this._issue(mesh, gg, instanced, mode);
      this._setState(m, 'front'); this._issue(mesh, gg, instanced, mode);
    } else {
      this._setState(m, m.side); this._issue(mesh, gg, instanced, mode);
    }
  }

  _issue(mesh, gg, instanced, mode) {
    const gl = this.gl;
    if (instanced) { this._drawInstanced(mesh, gg, mode); return; }
    if (mode === 'wireframe') {
      const w = this._getWire(gg, mesh.geometry);
      this._bindVAO(w.vao);
      gl.drawElements(gl.LINES, w.count, gl.UNSIGNED_INT, 0);
      this.info.calls++; this.info.drawn++; this.info.lines += w.count / 2;
      return;
    }
    this._bindVAO(gg.vao);
    if (mode === 'triangles') {
      if (gg.indexed) gl.drawElements(gl.TRIANGLES, gg.count, gg.indexType, 0);
      else gl.drawArrays(gl.TRIANGLES, 0, gg.count);
      this.info.triangles += gg.count / 3;
    } else {
      const modes = { lines: gl.LINES, lineStrip: gl.LINE_STRIP, line_strip: gl.LINE_STRIP, lineLoop: gl.LINE_LOOP, line_loop: gl.LINE_LOOP, points: gl.POINTS };
      const lm = modes[mode] || gl[mode.toUpperCase()] || gl.LINES;
      if (gg.indexed) gl.drawElements(lm, gg.count, gg.indexType, 0);
      else gl.drawArrays(lm, 0, gg.count);
      if (lm === gl.LINE_STRIP) this.info.lines += Math.max(0, gg.count - 1);
      else if (lm === gl.LINE_LOOP) this.info.lines += gg.count;
      else if (lm === gl.LINES) this.info.lines += gg.count / 2;
    }
    this.info.calls++; this.info.drawn++;
  }

  _setState(m, side) {
    const gl = this.gl, s = this._st;
    const blend = m.transparent ? m.blending : 'none';
    if (s.blend !== blend) {
      if (blend === 'none') gl.disable(gl.BLEND);
      else {
        gl.enable(gl.BLEND);
        if (blend === 'additive') gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
        else gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      }
      s.blend = blend;
    }
    if (s.depthTest !== m.depthTest) { m.depthTest ? gl.enable(gl.DEPTH_TEST) : gl.disable(gl.DEPTH_TEST); s.depthTest = m.depthTest; }
    const dw = m.depthWrite;
    if (s.depthWrite !== dw) { gl.depthMask(dw); s.depthWrite = dw; }
    if (s.side !== side) {
      if (side === 'double') gl.disable(gl.CULL_FACE);
      else { gl.enable(gl.CULL_FACE); gl.cullFace(side === 'back' ? gl.FRONT : gl.BACK); }
      s.side = side;
    }
  }

  _bindVAO(v) { if (this._vao !== v) { this.gl.bindVertexArray(v); this._vao = v; } }

  _getProgram(material, instanced, noShadow, skinned = false) {
    // En los render targets se dibuja siempre en lineal (la textura guarda el sRGB por su cuenta).
    const srgb = this._colorSpace === 'srgb' && !this._rt;
    const fog = this._fogOn && material.fog !== false;
    const shadow = this._shadowOn && material.lit && material.receiveShadow !== false && !noShadow;
    let progs = material._progs;
    if (!progs || material._progsOwner !== this || material._progsEpoch !== this._epoch) {
      progs = material._progs = new Array(MAX_LIGHTS).fill(null); material._progsOwner = this; material._progsEpoch = this._epoch;
    }
    const slot = (instanced ? 1 : 0) | (srgb ? 2 : 0) | (fog ? 4 : 0) | (shadow ? 8 : 0) | (skinned ? 16 : 0);
    let p = progs[slot];
    if (p) return p;
    const key = material.programKey + (instanced ? '|I' : '|N') + (srgb ? '|S' : '|L')
      + (fog ? '|F' : '|f') + (shadow ? '|K' : '|k') + (skinned ? '|G' : '');
    p = this._programs.get(key);
    if (!p) {
      const defs = Object.assign({}, material.getDefines());   // copia: no se tocan los defines del material
      if (fog) defs.USE_FOG = 1;
      if (shadow) defs.USE_SHADOW = 1;
      if (skinned) defs.USE_SKINNING = 1;
      p = new Program(this.gl,
        buildSource('vertex', material.vertexShader, defs, instanced, srgb),
        buildSource('fragment', material.fragmentShader, defs, instanced, srgb));
      this._programs.set(key, p);
      this.info.memory.programs++;
      this._cur = null; // Program dejó otro programa activo
    }
    progs[slot] = p;
    return p;
  }

  // ¿Esta malla se deforma en la GPU? (necesita esqueleto y los atributos de pesos)
  _isGpuSkin(mesh) {
    if (!mesh.isSkinnedMesh || !mesh.gpuSkinning || mesh.isInstancedMesh) return false;
    const sk = mesh.skeleton, a = mesh.geometry && mesh.geometry.attributes;
    return !!(sk && sk.bones.length && a && a.skinIndex && a.skinWeight);
  }

  // Sube lo que el shader necesita para deformar esta malla: la textura de huesos y su matriz de unión.
  _setSkinUniforms(p, mesh) {
    const gl = this.gl, ub = p.byName.uBoneTexture, um = p.byName.uBindMatrix;
    if (ub) this._bindBoneTexture(mesh.skeleton, ub.unit);
    if (um) gl.uniformMatrix4fv(um.loc, false, mesh.bindMatrix.elements);
  }

  // Matrices de los huesos como textura RGBA32F de 4 × n (una fila por hueso, una columna de la matriz por texel).
  _bindBoneTexture(sk, unit) {
    const gl = this.gl, T = gl.TEXTURE_2D, n = sk.bones.length;
    gl.activeTexture(gl.TEXTURE0 + unit);
    let b = this._boneTex.get(sk);
    if (!b) {
      const onDispose = () => {
        sk.off('dispose', onDispose);
        if (this._boneTex.get(sk) !== b) return;
        gl.deleteTexture(b.tex); this._boneTex.delete(sk); this.info.memory.textures--;
      };
      b = { tex: gl.createTexture(), version: -1, n: 0, onDispose };
      this._boneTex.set(sk, b);
      this.info.memory.textures++;
      sk.on('dispose', onDispose);
    }
    gl.bindTexture(T, b.tex);
    if (b.n !== n) {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);   // los datos van tal cual (la textura de color de antes pudo dejarlo activo)
      gl.texImage2D(T, 0, gl.RGBA32F, 4, n, 0, gl.RGBA, gl.FLOAT, sk.boneMatrices);
      gl.texParameteri(T, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(T, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(T, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(T, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      b.n = n; b.version = sk.version;
    } else if (b.version !== sk.version) {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texSubImage2D(T, 0, 0, 0, 4, n, gl.RGBA, gl.FLOAT, sk.boneMatrices);
      b.version = sk.version;
    }
  }

  _upload(p, obj) {
    const gl = this.gl, us = p.uniforms;
    for (let i = 0; i < us.length; i++) {
      const u = us[i], v = obj[u.name];
      if (v === undefined) continue;
      if (u.unit >= 0) { this._bindTexture(v, u.unit); continue; }
      if (v === null) continue;
      setUniform(gl, u, v);
    }
  }

  // ───────── geometría ─────────
  _getGeometry(g) {
    const gl = this.gl;
    let gg = this._geo.get(g);
    if (!gg) {
      const onDispose = () => {
        g.off('dispose', onDispose);
        if (this._geo.get(g) === gg) this._disposeGeometry(g);
      };
      gg = { geo: g, vao: gl.createVertexArray(), buffers: {}, indexBuf: null, indexAttr: null, indexed: false, indexType: 0, indexVersion: -1, count: 0, frame: -1, attrSig: '', onDispose };
      this._geo.set(g, gg);
      this.info.memory.geometries++;
      g.on('dispose', onDispose);
    }
    if (gg.frame === this._frame) return gg;
    gg.frame = this._frame;
    this._bindVAO(gg.vao);
    let sig = '';
    for (const name in g.attributes) {
      const loc = LOC[name];
      if (loc === undefined) continue;
      const a = g.attributes[name];
      sig += name + ':' + a.itemSize + ';';
      let b = gg.buffers[name];
      if (!b) {
        b = gg.buffers[name] = { buf: gl.createBuffer(), attr: null, version: -1, itemSize: a.itemSize, loc };
        gl.bindBuffer(gl.ARRAY_BUFFER, b.buf);
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, a.itemSize, gl.FLOAT, false, 0, 0);
      } else if (b.itemSize !== a.itemSize) {
        gl.bindBuffer(gl.ARRAY_BUFFER, b.buf);
        gl.vertexAttribPointer(loc, a.itemSize, gl.FLOAT, false, 0, 0);
        b.itemSize = a.itemSize;
      }
      if (b.attr !== a || b.version !== a.version) {
        gl.bindBuffer(gl.ARRAY_BUFFER, b.buf);
        gl.bufferData(gl.ARRAY_BUFFER, a.array, gl.STATIC_DRAW);
        b.attr = a;
        b.version = a.version;
      }
    }
    const ia = g.index;
    if (ia) {
      if (!gg.indexBuf) {
        gg.indexBuf = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gg.indexBuf);
      } else if (gg.indexAttr !== ia || gg.indexVersion !== ia.version) {
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gg.indexBuf);
      }
      if (gg.indexAttr !== ia || gg.indexVersion !== ia.version) {
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, ia.array, gl.STATIC_DRAW);
        gg.indexAttr = ia;
        gg.indexVersion = ia.version;
        gg.indexType = ia.array instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
      }
      gg.indexed = true; gg.count = ia.array.length;
    } else { gg.indexed = false; gg.count = g.vertexCount; }
    gg.attrSig = sig + '|' + (gg.indexed ? '1' : '0');
    return gg;
  }

  // Aristas de la geometría para dibujarla en wireframe. Cada triángulo aporta 3 parejas de
  // índices (cada arista se dibuja dos veces, como en el wireframe de cualquier editor).
  // Necesita su propio VAO: el de los triángulos ya tiene su buffer de índices.
  _getWire(gg, g) {
    const gl = this.gl;
    let w = gg.wire;
    if (!w) {
      w = gg.wire = { vao: gl.createVertexArray(), buf: gl.createBuffer(), count: 0, version: -1, indexAttr: null, posAttr: null, attrs: '' };
    }
    const idx = g.index ? g.index.array : null;
    const pos = g.attributes.position;
    const version = g.index ? g.index.version : pos.version;
    const attrs = gg.attrSig;
    if (w.version !== version || w.indexAttr !== g.index || w.posAttr !== pos || w.attrs !== attrs) {
      const tris = Math.floor((idx ? idx.length : pos.count) / 3);
      const lines = new Uint32Array(tris * 6);
      if (idx) {
        for (let t = 0; t < tris; t++) {
          const i = t * 3, o = t * 6;
          lines[o] = idx[i]; lines[o + 1] = idx[i + 1];
          lines[o + 2] = idx[i + 1]; lines[o + 3] = idx[i + 2];
          lines[o + 4] = idx[i + 2]; lines[o + 5] = idx[i];
        }
      } else {
        for (let t = 0; t < tris; t++) {
          const i = t * 3, o = t * 6;
          lines[o] = i; lines[o + 1] = i + 1;
          lines[o + 2] = i + 1; lines[o + 3] = i + 2;
          lines[o + 4] = i + 2; lines[o + 5] = i;
        }
      }
      // el VAO del wireframe comparte los buffers de atributos del de los triángulos
      this._bindVAO(w.vao);
      for (const k in gg.buffers) {
        const b = gg.buffers[k];
        gl.bindBuffer(gl.ARRAY_BUFFER, b.buf);
        gl.enableVertexAttribArray(b.loc);
        gl.vertexAttribPointer(b.loc, b.itemSize, gl.FLOAT, false, 0, 0);
      }
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, w.buf);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, lines, gl.STATIC_DRAW);
      w.count = lines.length;
      w.version = version;
      w.indexAttr = g.index;
      w.posAttr = pos;
      w.attrs = attrs;
    }
    return w;
  }

  _disposeGeometry(g) {
    const gl = this.gl, gg = this._geo.get(g);
    if (!gg) return;
    if (gg.onDispose) g.off('dispose', gg.onDispose);
    for (const k in gg.buffers) gl.deleteBuffer(gg.buffers[k].buf);
    if (gg.indexBuf) gl.deleteBuffer(gg.indexBuf);
    gl.deleteVertexArray(gg.vao);
    if (gg.wire) { gl.deleteBuffer(gg.wire.buf); gl.deleteVertexArray(gg.wire.vao); }
    if (this._vao === gg.vao) this._vao = null;
    if (gg.wire && this._vao === gg.wire.vao) this._vao = null;
    this._geo.delete(g);
    this.info.memory.geometries--;
  }

  _bindInstancedVAO(vao, gg, buf, indexBuf) {
    const gl = this.gl;
    this._bindVAO(vao);
    for (const k in gg.buffers) {
      const b = gg.buffers[k];
      gl.bindBuffer(gl.ARRAY_BUFFER, b.buf);
      gl.enableVertexAttribArray(b.loc);
      gl.vertexAttribPointer(b.loc, b.itemSize, gl.FLOAT, false, 0, 0);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuf || null);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    for (let i = 0; i < 4; i++) {
      gl.enableVertexAttribArray(INST + i);
      gl.vertexAttribPointer(INST + i, 4, gl.FLOAT, false, 64, i * 16);
      gl.vertexAttribDivisor(INST + i, 1);
    }
  }

  _createInstanced(mesh, gg, attr) {
    const gl = this.gl;
    const ig = {
      vao: gl.createVertexArray(), wireVao: null, wireSig: '', buf: gl.createBuffer(),
      attr: null, version: -1, full: false, byteLength: attr.array.byteLength, attrSig: gg.attrSig, dead: false,
    };
    gl.bindBuffer(gl.ARRAY_BUFFER, ig.buf);
    gl.bufferData(gl.ARRAY_BUFFER, ig.byteLength, gl.DYNAMIC_DRAW);
    this._bindInstancedVAO(ig.vao, gg, ig.buf, gg.indexed ? gg.indexBuf : null);
    this._inst.set(mesh, ig);
    this.info.memory.instanceBuffers++;
    const geo = mesh.geometry;
    const free = () => {
      if (ig.dead) return; ig.dead = true;
      mesh.removeEventListener('dispose', free);
      geo.off('dispose', free);
      gl.deleteBuffer(ig.buf); gl.deleteVertexArray(ig.vao);
      if (ig.wireVao) gl.deleteVertexArray(ig.wireVao);
      if (this._vao === ig.vao || (ig.wireVao && this._vao === ig.wireVao)) this._vao = null;
      if (this._inst.get(mesh) === ig) this._inst.delete(mesh);
      this.info.memory.instanceBuffers--;
    };
    ig.free = free;
    mesh.addEventListener('dispose', free);        // mesh.dispose()
    geo.on('dispose', free);                       // geometry.dispose()
    return ig;
  }

  _ensureInstanced(mesh, gg, attr) {
    let ig = this._inst.get(mesh);
    if (!ig) return this._createInstanced(mesh, gg, attr);
    if (ig.attrSig !== gg.attrSig) {
      this._bindInstancedVAO(ig.vao, gg, ig.buf, gg.indexed ? gg.indexBuf : null);
      ig.attrSig = gg.attrSig;
      ig.wireSig = '';
    }
    return ig;
  }

  _drawInstanced(mesh, gg, mode = 'triangles') {
    const gl = this.gl, attr = mesh.instanceMatrix, a = attr.array;
    const total = Math.min(mesh.count, (a.length / 16) | 0);
    const ig = this._ensureInstanced(mesh, gg, attr);
    let n = total, full = true;

    if (mesh.cullInstances && mesh.frustumCulled && mesh.material.frustumCulled !== false) {
      if (this._scratch.length < total * 16) this._scratch = new Float32Array(total * 16);
      const s = this._scratch, f = this._frustum;
      const mw = mesh.matrixWorld, me = mw.elements, ms = mw.getMaxScale();
      const bs = mesh.geometry.getBoundingSphere(), cx = bs.center.x, cy = bs.center.y, cz = bs.center.z, rad = bs.radius * ms;
      n = 0;
      for (let i = 0; i < total; i++) {
        const o = i * 16;
        const ix = a[o] * cx + a[o + 4] * cy + a[o + 8] * cz + a[o + 12];
        const iy = a[o + 1] * cx + a[o + 5] * cy + a[o + 9] * cz + a[o + 13];
        const iz = a[o + 2] * cx + a[o + 6] * cy + a[o + 10] * cz + a[o + 14];
        const wx = me[0] * ix + me[4] * iy + me[8] * iz + me[12];
        const wy = me[1] * ix + me[5] * iy + me[9] * iz + me[13];
        const wz = me[2] * ix + me[6] * iy + me[10] * iz + me[14];
        const s0 = a[o] * a[o] + a[o + 1] * a[o + 1] + a[o + 2] * a[o + 2];
        const s1 = a[o + 4] * a[o + 4] + a[o + 5] * a[o + 5] + a[o + 6] * a[o + 6];
        const s2 = a[o + 8] * a[o + 8] + a[o + 9] * a[o + 9] + a[o + 10] * a[o + 10];
        if (f.intersectsSphere(wx, wy, wz, rad * Math.sqrt(Math.max(s0, s1, s2)))) {
          const w = n * 16;
          for (let k = 0; k < 16; k++) s[w + k] = a[o + k];
          n++;
        }
      }
      full = n === total;
      this.info.culled += total - n;
    }
    if (n === 0) return;

    gl.bindBuffer(gl.ARRAY_BUFFER, ig.buf);
    if (full) {
      if (ig.version !== attr.version || ig.attr !== attr || !ig.full) {
        if (a.byteLength > ig.byteLength) {
          gl.bufferData(gl.ARRAY_BUFFER, a.byteLength, gl.DYNAMIC_DRAW);
          ig.byteLength = a.byteLength;
        }
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, a, 0, total * 16);
        ig.attr = attr; ig.version = attr.version; ig.full = true;
      }
    } else {
      const needBytes = n * 16 * 4;
      if (needBytes > ig.byteLength) {
        gl.bufferData(gl.ARRAY_BUFFER, a.byteLength, gl.DYNAMIC_DRAW);
        ig.byteLength = a.byteLength;
      }
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this._scratch, 0, n * 16);
      ig.full = false;
    }
    if (mode === 'wireframe') {
      const w = this._getWire(gg, mesh.geometry);
      if (!ig.wireVao) ig.wireVao = gl.createVertexArray();
      const ws = `${w.version}|${gg.attrSig}`;
      if (ig.wireSig !== ws) {
        this._bindInstancedVAO(ig.wireVao, gg, ig.buf, w.buf);
        ig.wireSig = ws;
      } else {
        this._bindVAO(ig.wireVao);
      }
      gl.drawElementsInstanced(gl.LINES, w.count, gl.UNSIGNED_INT, 0, n);
      this.info.calls++; this.info.drawn++; this.info.instances += n; this.info.lines += (w.count / 2) * n;
      return;
    }
    this._bindVAO(ig.vao);
    if (gg.indexed) gl.drawElementsInstanced(gl.TRIANGLES, gg.count, gg.indexType, 0, n);
    else gl.drawArraysInstanced(gl.TRIANGLES, 0, gg.count, n);
    this.info.calls++; this.info.drawn++; this.info.instances += n; this.info.triangles += (gg.count / 3) * n;
  }

  // ───────── texturas ─────────
  _bindTexture(tex, unit) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    if (!tex) {
      if (!this._white) {
        this._white = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this._white);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      }
      gl.bindTexture(gl.TEXTURE_2D, this._white);
      return;
    }
    // textura del mapa de sombras
    if (tex.isShadowTexture) {
      gl.bindTexture(gl.TEXTURE_2D, tex.map.tex);
      return;
    }
    // textura de un render target: se enlaza la textura que tiene el target
    if (tex.isRenderTargetTexture) {
      const t = this._getTarget(tex.target);
      this._applyTargetSampler(tex.target, t);
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      return;
    }
    let t = this._tex.get(tex);
    if (!t) {
      const onDispose = () => {
        tex.off('dispose', onDispose);
        if (this._tex.get(tex) !== t) return;
        gl.deleteTexture(t.tex); this._tex.delete(tex); this.info.memory.textures--;
      };
      t = { tex: gl.createTexture(), version: -1, loaded: false, srgb: null, onDispose };
      this._tex.set(tex, t);
      this.info.memory.textures++;
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      tex.on('dispose', onDispose);
    } else gl.bindTexture(gl.TEXTURE_2D, t.tex);
    const srgb = this._colorSpace === 'srgb' && tex.colorSpace === 'srgb';
    if ((t.version !== tex.version || !t.loaded || t.srgb !== srgb) && tex.isReady()) this._uploadTexture(tex, t, srgb);
  }

  _uploadTexture(tex, t, srgb) {
    const gl = this.gl, T = gl.TEXTURE_2D;
    const wrap = { repeat: gl.REPEAT, clamp: gl.CLAMP_TO_EDGE, mirror: gl.MIRRORED_REPEAT };
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, tex.flipY);
    // sRGB: el hardware convierte a lineal al muestrear (y filtra/mipmapea en lineal)
    gl.texImage2D(T, 0, srgb ? gl.SRGB8_ALPHA8 : gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, tex.image);
    gl.texParameteri(T, gl.TEXTURE_WRAP_S, wrap[tex.wrapS] || gl.REPEAT);
    gl.texParameteri(T, gl.TEXTURE_WRAP_T, wrap[tex.wrapT] || gl.REPEAT);
    gl.texParameteri(T, gl.TEXTURE_MAG_FILTER, tex.magFilter === 'nearest' ? gl.NEAREST : gl.LINEAR);
    let min = gl.LINEAR;
    if (tex.minFilter === 'nearest') min = gl.NEAREST;
    else if (tex.minFilter === 'linear-mipmap') { gl.generateMipmap(T); min = gl.LINEAR_MIPMAP_LINEAR; }
    gl.texParameteri(T, gl.TEXTURE_MIN_FILTER, min);
    if (this._aniso && min === gl.LINEAR_MIPMAP_LINEAR) {
      gl.texParameterf(T, this._aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(4, gl.getParameter(this._aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
    }
    t.version = tex.version; t.loaded = true; t.srgb = srgb;
  }

  // Libera de la GPU todo lo de un objeto y sus hijos (geometrías, texturas `map`, buffers de instancias).
  // Lo que sigas usando se vuelve a subir solo en el siguiente render().
  disposeObject(root) {
    root.traverse((o) => {
      if (o.isMesh) {
        if (o.geometry) o.geometry.dispose();
        const m = o.material;
        if (m) { if (m.dispose) m.dispose(); if (m.map) m.map.dispose(); }
        if (o.isInstancedMesh) o.dispose();
        if (o.isSkinnedMesh && o.skeleton) o.skeleton.dispose();
      }
    });
  }

  // Destruye el renderer y su contexto WebGL.
  dispose() {
    const gl = this.gl;
    for (const p of this._programs.values()) gl.deleteProgram(p.program);
    this._programs.clear();
    for (const p of this._shadowProgs.values()) gl.deleteProgram(p.program);
    this._shadowProgs.clear();
    if (this._white) { gl.deleteTexture(this._white); this._white = null; }
    for (const rt of [...this._targets.keys()]) this._disposeTarget(rt);
    for (const l of [...this._shadows.keys()]) this._disposeShadowMap(l);
    this._rt = null;
    const ext = gl.getExtension('WEBGL_lose_context');
    if (ext) ext.loseContext();
  }
}
