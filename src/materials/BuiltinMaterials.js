import { Material } from './Material.js';
import { Color } from '../math/Color.js';
import { Vec2 } from '../math/Vec2.js';
import { BASIC_VERT, BASIC_FRAG, STANDARD_VERT, STANDARD_FRAG } from '../shaders/GLSL/builtin.js';
import { BASIC_WGSL, STANDARD_WGSL } from '../shaders/WGSL/builtin.js';

const IDENTITY_UV_MAT = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

export class SurfaceMaterial extends Material {
  constructor(o = {}) {
    super(o);
    this.color = new Color(o.color ?? 0xffffff);
    this._vertexColors = false;
    this.vertexColors = o.vertexColors ?? false;   // multiplica por el atributo 'color' de la geometría
    this._map = null;
    this._uvMat = new Float32Array(IDENTITY_UV_MAT);
    this._alphaTest = 0;
    this.alphaTest = o.alphaTest ?? 0;             // > 0: descarta los píxeles con alfa menor que este valor (hojas, pelo...)
    this.uniforms = {
      uColor: this.color,
      uOpacity: 1,
      uMap: null,
      uUvMatrix: this._uvMat,
      uShininess: 0,
      uSpecular: 1,
      uAlphaCutoff: 0,
    };
    this.map = o.map ?? null;
  }
  // Al activarlo o desactivarlo hay que recompilar el programa (cambia el shader).
  get vertexColors() { return this._vertexColors; }
  set vertexColors(v) {
    const b = !!v;
    if (b !== this._vertexColors) { this._vertexColors = b; this.invalidate(); }
  }
  get alphaTest() { return this._alphaTest; }
  set alphaTest(v) {
    const n = +v || 0;
    if ((n > 0) !== (this._alphaTest > 0)) this.invalidate();   // activarlo o no cambia el shader
    this._alphaTest = n;
  }
  get map() { return this._map; }
  set map(t) {
    const had = !!this._map;
    const prevUv1 = !!(this._map && this._map.texCoord === 1);
    const nextUv1 = !!(t && t.texCoord === 1);
    this._map = t;
    if (had !== !!t || prevUv1 !== nextUv1) this.invalidate();
  }
  getDefines() {
    const d = {};
    if (this._map) {
      d.USE_MAP = 1;
      if (this._map.texCoord === 1) d.USE_MAP_UV1 = 1;
    }
    if (this.vertexColors) d.USE_COLOR = 1;
    if (this._alphaTest > 0) d.USE_ALPHATEST = 1;
    return d;
  }
  _computeKey() {
    return (
      this.type +
      (this._map ? (this._map.texCoord === 1 ? ':map1' : ':map') : '') +
      (this.vertexColors ? ':color' : '') +
      (this._alphaTest > 0 ? ':at' : '')
    );
  }
  _cloneSurfaceOptions(overrides = {}) {
    return this._cloneBaseOptions({
      color: this.color ? this.color.getHex() : 0xffffff,
      vertexColors: this.vertexColors,
      alphaTest: this.alphaTest,
      map: this._map,
      ...overrides,
    });
  }
  clone(overrides = {}) {
    const cloned = new SurfaceMaterial(this._cloneSurfaceOptions(overrides));
    cloned._transparent = overrides.transparent !== undefined ? Boolean(overrides.transparent) : this._transparent;
    return cloned;
  }
  updateUniforms() {
    const u = this.uniforms, t = this._map;
    u.uOpacity = this.opacity;
    u.uMap = t;
    u.uShininess = this.shininess;
    u.uSpecular = this.specular;
    u.uAlphaCutoff = this._alphaTest;
    if (t && t.getUvMatrix) t.getUvMatrix(this._uvMat);
    else this._uvMat.set(IDENTITY_UV_MAT);
  }
}

// Color plano (+ textura). No recibe luces.
export class BasicMaterial extends SurfaceMaterial {
  constructor(o) {
    super(o);
    this.type = 'basic';
    this.vertexShader = BASIC_VERT;
    this.fragmentShader = BASIC_FRAG;
    this.wgslShader = BASIC_WGSL;
  }
  clone(overrides = {}) {
    const cloned = new BasicMaterial(this._cloneSurfaceOptions(overrides));
    cloned._transparent = overrides.transparent !== undefined ? Boolean(overrides.transparent) : this._transparent;
    return cloned;
  }
}

// Iluminación difusa (ambiente + hasta 4 direccionales + hasta 4 puntuales), con especular,
// PBR opcional (roughness/metalness/normalMap/emissiveMap/aoMap), niebla y sombras.
export class StandardMaterial extends SurfaceMaterial {
  constructor(o = {}) {
    super(o);
    this.type = 'standard';
    this.lit = true;
    this.emissive = new Color(o.emissive !== undefined ? o.emissive : 0x000000);   // luz propia (se suma a la iluminada)
    this._normalMap = null;
    this._emissiveMap = null;
    this._aoMap = null;
    this._metallicRoughnessMap = null;
    this._roughnessMap = null;
    this._metalnessMap = null;
    this._normalUvMat = new Float32Array(IDENTITY_UV_MAT);
    this._emissiveUvMat = new Float32Array(IDENTITY_UV_MAT);
    this._aoUvMat = new Float32Array(IDENTITY_UV_MAT);
    this._mrUvMat = new Float32Array(IDENTITY_UV_MAT);
    this._roughnessUvMat = new Float32Array(IDENTITY_UV_MAT);
    this._metalnessUvMat = new Float32Array(IDENTITY_UV_MAT);

    this.normalScale = new Vec2(
      o.normalScale?.x ?? (typeof o.normalScale === 'number' ? o.normalScale : 1),
      o.normalScale?.y ?? (typeof o.normalScale === 'number' ? o.normalScale : 1)
    );
    this.aoMapIntensity = o.aoMapIntensity ?? 1;
    this.envMapIntensity = o.envMapIntensity ?? 1;
    this._hasPbr =
      Boolean(o.hasPbr) ||
      o.roughness !== undefined ||
      o.metalness !== undefined ||
      Boolean(o.metallicRoughnessMap) ||
      Boolean(o.roughnessMap) ||
      Boolean(o.metalnessMap);
    this._roughness = 1;
    this._metalness = 0;
    if (this._hasPbr && o.roughness === undefined && o.shininess !== undefined) {
      this.shininess = o.shininess;
    } else {
      this.roughness = o.roughness ?? 1;
    }
    this.metalness = o.metalness ?? 0;

    this.uniforms.uEmissive = this.emissive;
    this.uniforms.uNormalMap = null;
    this.uniforms.uNormalScale = this.normalScale;
    this.uniforms.uNormalUvMatrix = this._normalUvMat;
    this.uniforms.uEmissiveMap = null;
    this.uniforms.uEmissiveUvMatrix = this._emissiveUvMat;
    this.uniforms.uAoMap = null;
    this.uniforms.uAoMapIntensity = this.aoMapIntensity;
    this.uniforms.uAoUvMatrix = this._aoUvMat;
    this.uniforms.uMetallicRoughnessMap = null;
    this.uniforms.uMrUvMatrix = this._mrUvMat;
    this.uniforms.uRoughnessMap = null;
    this.uniforms.uRoughnessUvMatrix = this._roughnessUvMat;
    this.uniforms.uMetalnessMap = null;
    this.uniforms.uMetalnessUvMatrix = this._metalnessUvMat;
    this.uniforms.uEnvMapIntensity = this.envMapIntensity;
    this.uniforms.uRoughness = this.roughness;
    this.uniforms.uMetalness = this.metalness;

    this.normalMap = o.normalMap ?? null;
    this.emissiveMap = o.emissiveMap ?? null;
    this.aoMap = o.aoMap ?? null;
    this.metallicRoughnessMap = o.metallicRoughnessMap ?? null;
    this.roughnessMap = o.roughnessMap ?? null;
    this.metalnessMap = o.metalnessMap ?? null;

    this.vertexShader = STANDARD_VERT;
    this.fragmentShader = STANDARD_FRAG;
    this.wgslShader = STANDARD_WGSL;
  }

  get hasPbr() { return this._hasPbr; }
  set hasPbr(v) { this.setHasPbr(v); }
  setHasPbr(v) {
    const next = Boolean(v);
    if (next !== this._hasPbr) {
      this._hasPbr = next;
      if (next) this._shininess = this.shininess;
      this.invalidate();
    }
    return this;
  }

  get shininess() {
    if (!this._hasPbr) return this._shininess;
    const rough = Math.max(0.04, Math.min(1, Number.isFinite(this._roughness) ? this._roughness : 1));
    return Math.round(Math.pow(1 - rough, 2) * 120 + 4);
  }
  set shininess(v) {
    const n = +v || 0;
    if (this._hasPbr) {
      const clamped = Math.max(4, Math.min(124, n));
      const t = Math.sqrt((clamped - 4) / 120);
      this._roughness = Math.max(0.04, Math.min(1, Number((1 - t).toFixed(3))));
      this._shininess = this.shininess;
    } else if (n !== this._shininess) {
      this._shininess = n;
      this.invalidate();
    }
  }

  get normalMap() { return this._normalMap; }
  set normalMap(t) {
    const prev = this._normalMap;
    this._normalMap = t;
    if (Boolean(prev) !== Boolean(t) || (prev?.texCoord === 1) !== (t?.texCoord === 1)) this.invalidate();
  }

  get emissiveMap() { return this._emissiveMap; }
  set emissiveMap(t) {
    const prev = this._emissiveMap;
    this._emissiveMap = t;
    if (Boolean(prev) !== Boolean(t) || (prev?.texCoord === 1) !== (t?.texCoord === 1)) this.invalidate();
  }

  get aoMap() { return this._aoMap; }
  set aoMap(t) {
    const prev = this._aoMap;
    this._aoMap = t;
    if (Boolean(prev) !== Boolean(t) || (prev?.texCoord === 1) !== (t?.texCoord === 1)) this.invalidate();
  }

  get metallicRoughnessMap() { return this._metallicRoughnessMap; }
  set metallicRoughnessMap(t) {
    const prev = this._metallicRoughnessMap;
    this._metallicRoughnessMap = t;
    if (t && !this._hasPbr) { this._hasPbr = true; this.invalidate(); }
    if (Boolean(prev) !== Boolean(t) || (prev?.texCoord === 1) !== (t?.texCoord === 1)) this.invalidate();
  }

  get roughnessMap() { return this._roughnessMap; }
  set roughnessMap(t) {
    const prev = this._roughnessMap;
    this._roughnessMap = t;
    if (t && !this._hasPbr) { this._hasPbr = true; this.invalidate(); }
    if (Boolean(prev) !== Boolean(t) || (prev?.texCoord === 1) !== (t?.texCoord === 1)) this.invalidate();
  }

  get metalnessMap() { return this._metalnessMap; }
  set metalnessMap(t) {
    const prev = this._metalnessMap;
    this._metalnessMap = t;
    if (t && !this._hasPbr) { this._hasPbr = true; this.invalidate(); }
    if (Boolean(prev) !== Boolean(t) || (prev?.texCoord === 1) !== (t?.texCoord === 1)) this.invalidate();
  }

  get roughness() { return this._roughness; }
  set roughness(v) {
    const n = +v;
    this._roughness = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1;
    if (this._hasPbr) this._shininess = this.shininess;
  }

  get metalness() { return this._metalness; }
  set metalness(v) {
    const n = +v;
    this._metalness = Number.isFinite(n) ? n : 0;
  }

  clone(overrides = {}) {
    const opts = this._cloneSurfaceOptions({
      emissive: this.emissive ? this.emissive.getHex() : 0x000000,
      normalScale: this.normalScale ? { x: this.normalScale.x, y: this.normalScale.y } : { x: 1, y: 1 },
      aoMapIntensity: this.aoMapIntensity,
      envMapIntensity: this.envMapIntensity,
      normalMap: this._normalMap,
      emissiveMap: this._emissiveMap,
      aoMap: this._aoMap,
      metallicRoughnessMap: this._metallicRoughnessMap,
      roughnessMap: this._roughnessMap,
      metalnessMap: this._metalnessMap,
    });
    if (this._hasPbr) {
      opts.hasPbr = true;
      opts.roughness = this._roughness;
      opts.metalness = this._metalness;
      delete opts.shininess;
    }
    const merged = { ...opts, ...overrides };
    if (overrides.shininess !== undefined && overrides.roughness === undefined) {
      delete merged.roughness;
    }
    const cloned = new StandardMaterial(merged);
    cloned._transparent = overrides.transparent !== undefined ? Boolean(overrides.transparent) : this._transparent;
    return cloned;
  }

  getDefines() {
    const d = super.getDefines();
    if (this.shininess > 0) d.USE_SPECULAR = 1;
    if (this._hasPbr) d.USE_PBR = 1;
    if (this._normalMap) {
      d.USE_NORMALMAP = 1;
      if (this._normalMap.texCoord === 1) d.USE_NORMALMAP_UV1 = 1;
    }
    if (this._emissiveMap) {
      d.USE_EMISSIVEMAP = 1;
      if (this._emissiveMap.texCoord === 1) d.USE_EMISSIVEMAP_UV1 = 1;
    }
    if (this._aoMap) {
      d.USE_AOMAP = 1;
      if (this._aoMap.texCoord === 1) d.USE_AOMAP_UV1 = 1;
    }
    if (this._metallicRoughnessMap) {
      d.USE_MRMAP = 1;
      if (this._metallicRoughnessMap.texCoord === 1) d.USE_MRMAP_UV1 = 1;
    }
    if (this._roughnessMap) {
      d.USE_ROUGHNESSMAP = 1;
      if (this._roughnessMap.texCoord === 1) d.USE_ROUGHNESSMAP_UV1 = 1;
    }
    if (this._metalnessMap) {
      d.USE_METALNESSMAP = 1;
      if (this._metalnessMap.texCoord === 1) d.USE_METALNESSMAP_UV1 = 1;
    }
    return d;
  }

  _computeKey() {
    return (
      super._computeKey() +
      (this.shininess > 0 ? ':spec' : '') +
      (this._hasPbr ? ':pbr' : '') +
      (this._normalMap ? (this._normalMap.texCoord === 1 ? ':nm1' : ':nm') : '') +
      (this._emissiveMap ? (this._emissiveMap.texCoord === 1 ? ':em1' : ':em') : '') +
      (this._aoMap ? (this._aoMap.texCoord === 1 ? ':ao1' : ':ao') : '') +
      (this._metallicRoughnessMap ? (this._metallicRoughnessMap.texCoord === 1 ? ':mr1' : ':mr') : '') +
      (this._roughnessMap ? (this._roughnessMap.texCoord === 1 ? ':rm1' : ':rm') : '') +
      (this._metalnessMap ? (this._metalnessMap.texCoord === 1 ? ':mm1' : ':mm') : '')
    );
  }

  updateUniforms() {
    super.updateUniforms();
    const u = this.uniforms;
    u.uNormalMap = this._normalMap;
    u.uNormalScale = this.normalScale;
    if (this._normalMap && this._normalMap.getUvMatrix) this._normalMap.getUvMatrix(this._normalUvMat);
    else this._normalUvMat.set(IDENTITY_UV_MAT);

    u.uEmissiveMap = this._emissiveMap;
    if (this._emissiveMap && this._emissiveMap.getUvMatrix) this._emissiveMap.getUvMatrix(this._emissiveUvMat);
    else this._emissiveUvMat.set(IDENTITY_UV_MAT);

    u.uAoMap = this._aoMap;
    u.uAoMapIntensity = this.aoMapIntensity;
    if (this._aoMap && this._aoMap.getUvMatrix) this._aoMap.getUvMatrix(this._aoUvMat);
    else this._aoUvMat.set(IDENTITY_UV_MAT);

    u.uMetallicRoughnessMap = this._metallicRoughnessMap;
    if (this._metallicRoughnessMap && this._metallicRoughnessMap.getUvMatrix) {
      this._metallicRoughnessMap.getUvMatrix(this._mrUvMat);
    } else {
      this._mrUvMat.set(IDENTITY_UV_MAT);
    }

    u.uRoughnessMap = this._roughnessMap;
    if (this._roughnessMap && this._roughnessMap.getUvMatrix) {
      this._roughnessMap.getUvMatrix(this._roughnessUvMat);
    } else {
      this._roughnessUvMat.set(IDENTITY_UV_MAT);
    }

    u.uMetalnessMap = this._metalnessMap;
    if (this._metalnessMap && this._metalnessMap.getUvMatrix) {
      this._metalnessMap.getUvMatrix(this._metalnessUvMat);
    } else {
      this._metalnessUvMat.set(IDENTITY_UV_MAT);
    }

    u.uEnvMapIntensity = this.envMapIntensity ?? 1;
    u.uRoughness = this._roughness;
    u.uMetalness = this._metalness;
  }
}
