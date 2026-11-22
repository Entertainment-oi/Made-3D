import { SurfaceMaterial } from './BuiltinMaterials.js';
import { Color } from '../math/Color.js';
import {
  TOON_VERT,
  TOON_FRAG,
  HOLOGRAM_VERT,
  HOLOGRAM_FRAG,
  MATCAP_VERT,
  MATCAP_FRAG,
  FRESNEL_VERT,
  FRESNEL_FRAG,
  DISSOLVE_VERT,
  DISSOLVE_FRAG,
} from '../shaders/GLSL/stylized.js';
import {
  TOON_WGSL,
  HOLOGRAM_WGSL,
  MATCAP_WGSL,
  FRESNEL_WGSL,
  DISSOLVE_WGSL,
} from '../shaders/WGSL/stylized.js';

// 1) Estilo Anime / Cel-Shading
export class ToonMaterial extends SurfaceMaterial {
  constructor(o = {}) {
    super({ shininess: 48, specular: 0.85, ...o });
    this.isToonMaterial = true;
    this.type = 'toon';
    this.lit = true;

    this.steps = o.steps ?? 3;
    this.smoothness = o.smoothness ?? 0.06;
    this.shadowColor = new Color(o.shadowColor ?? 0x4b4a7a);
    this.shadowTint = o.shadowTint ?? 0.45;
    this.rimColor = new Color(o.rimColor ?? 0xffffff);
    this.rimPower = o.rimPower ?? 3.5;
    this.rimStrength = o.rimStrength ?? 0.7;
    this.inkColor = new Color(o.inkColor ?? 0x111522);
    this.inkWidth = o.inkWidth ?? 0.22;

    this.uniforms.uSteps = this.steps;
    this.uniforms.uSmoothness = this.smoothness;
    this.uniforms.uShadowColor = this.shadowColor;
    this.uniforms.uShadowTint = this.shadowTint;
    this.uniforms.uRimColor = this.rimColor;
    this.uniforms.uRimPower = this.rimPower;
    this.uniforms.uRimStrength = this.rimStrength;
    this.uniforms.uInkColor = this.inkColor;
    this.uniforms.uInkWidth = this.inkWidth;

    this.vertexShader = TOON_VERT;
    this.fragmentShader = TOON_FRAG;
    this.wgslShader = TOON_WGSL;
  }

  clone(overrides = {}) {
    const cloned = new ToonMaterial(this._cloneSurfaceOptions({
      steps: this.steps,
      smoothness: this.smoothness,
      shadowColor: this.shadowColor ? this.shadowColor.getHex() : 0x4b4a7a,
      shadowTint: this.shadowTint,
      rimColor: this.rimColor ? this.rimColor.getHex() : 0xffffff,
      rimPower: this.rimPower,
      rimStrength: this.rimStrength,
      inkColor: this.inkColor ? this.inkColor.getHex() : 0x111522,
      inkWidth: this.inkWidth,
      ...overrides,
    }));
    cloned._transparent = overrides.transparent !== undefined ? Boolean(overrides.transparent) : this._transparent;
    return cloned;
  }

  updateUniforms() {
    super.updateUniforms();
    const u = this.uniforms;
    u.uSteps = this.steps;
    u.uSmoothness = this.smoothness;
    u.uShadowColor = this.shadowColor;
    u.uShadowTint = this.shadowTint;
    u.uRimColor = this.rimColor;
    u.uRimPower = this.rimPower;
    u.uRimStrength = this.rimStrength;
    u.uInkColor = this.inkColor;
    u.uInkWidth = this.inkWidth;
  }
}

// 2) Holograma Sci-Fi animado
export class HologramMaterial extends SurfaceMaterial {
  constructor(o = {}) {
    super({
      color: 0x22d3ee,
      transparent: true,
      depthWrite: false,
      twoPass: false,
      side: 'double',
      blending: 'additive',
      ...o,
    });
    this.isHologramMaterial = true;
    this.type = 'hologram';
    this.lit = false;

    this.stripeColor = new Color(o.stripeColor ?? 0x7dd3fc);
    this.fresnelPower = o.fresnelPower ?? 2.2;
    this.scanlineDensity = o.scanlineDensity ?? 18.0;
    this.scanlineSpeed = o.scanlineSpeed ?? 2.4;
    this.glitchStrength = o.glitchStrength ?? 0.35;

    this.uniforms.uStripeColor = this.stripeColor;
    this.uniforms.uFresnelPower = this.fresnelPower;
    this.uniforms.uScanlineDensity = this.scanlineDensity;
    this.uniforms.uScanlineSpeed = this.scanlineSpeed;
    this.uniforms.uGlitchStrength = this.glitchStrength;

    this.vertexShader = HOLOGRAM_VERT;
    this.fragmentShader = HOLOGRAM_FRAG;
    this.wgslShader = HOLOGRAM_WGSL;
  }

  clone(overrides = {}) {
    const cloned = new HologramMaterial(this._cloneSurfaceOptions({
      stripeColor: this.stripeColor ? this.stripeColor.getHex() : 0x7dd3fc,
      fresnelPower: this.fresnelPower,
      scanlineDensity: this.scanlineDensity,
      scanlineSpeed: this.scanlineSpeed,
      glitchStrength: this.glitchStrength,
      ...overrides,
    }));
    cloned._transparent = overrides.transparent !== undefined ? Boolean(overrides.transparent) : this._transparent;
    return cloned;
  }

  updateUniforms() {
    super.updateUniforms();
    const u = this.uniforms;
    u.uStripeColor = this.stripeColor;
    u.uFresnelPower = this.fresnelPower;
    u.uScanlineDensity = this.scanlineDensity;
    u.uScanlineSpeed = this.scanlineSpeed;
    u.uGlitchStrength = this.glitchStrength;
  }
}

// 3) MatCap (con textura opcional o estudio procedural en GLSL)
export class MatcapMaterial extends SurfaceMaterial {
  constructor(o = {}) {
    super(o);
    this.isMatcapMaterial = true;
    this.type = 'matcap';
    this.lit = false;

    this._matcap = null;
    this.rimColor = new Color(o.rimColor ?? 0xdbeafe);
    this.glossiness = o.glossiness ?? 0.55;
    this.metalness = o.metalness ?? 0.25;

    this.uniforms.uMatcap = null;
    this.uniforms.uRimColor = this.rimColor;
    this.uniforms.uGlossiness = this.glossiness;
    this.uniforms.uMetalness = this.metalness;

    this.matcap = o.matcap ?? null;
    this.vertexShader = MATCAP_VERT;
    this.fragmentShader = MATCAP_FRAG;
    this.wgslShader = MATCAP_WGSL;
  }

  get matcap() { return this._matcap; }
  set matcap(t) {
    const had = Boolean(this._matcap);
    this._matcap = t || null;
    if (had !== Boolean(this._matcap)) this.invalidate();
  }

  getDefines() {
    const d = super.getDefines();
    if (this._matcap) d.USE_MATCAP = 1;
    return d;
  }

  _computeKey() {
    return super._computeKey() + (this._matcap ? ':mc' : '');
  }

  clone(overrides = {}) {
    const cloned = new MatcapMaterial(this._cloneSurfaceOptions({
      matcap: this._matcap,
      rimColor: this.rimColor ? this.rimColor.getHex() : 0xdbeafe,
      glossiness: this.glossiness,
      metalness: this.metalness,
      ...overrides,
    }));
    cloned._transparent = overrides.transparent !== undefined ? Boolean(overrides.transparent) : this._transparent;
    return cloned;
  }

  updateUniforms() {
    super.updateUniforms();
    const u = this.uniforms;
    u.uMatcap = this._matcap;
    u.uRimColor = this.rimColor;
    u.uGlossiness = this.glossiness;
    u.uMetalness = this.metalness;
  }
}

// 4) Energía Fresnel / Cristal iridiscente
export class FresnelMaterial extends SurfaceMaterial {
  constructor(o = {}) {
    super({ color: 0x1e293b, ...o });
    this.isFresnelMaterial = true;
    this.type = 'fresnel';
    this.lit = false;

    this.rimColor = new Color(o.rimColor ?? 0x38bdf8);
    this.fresnelPower = o.fresnelPower ?? 2.6;
    this.fresnelIntensity = o.fresnelIntensity ?? 1.6;
    this.iridescence = o.iridescence ?? 0.55;
    this.pulseSpeed = o.pulseSpeed ?? 1.8;

    this.uniforms.uRimColor = this.rimColor;
    this.uniforms.uFresnelPower = this.fresnelPower;
    this.uniforms.uFresnelIntensity = this.fresnelIntensity;
    this.uniforms.uIridescence = this.iridescence;
    this.uniforms.uPulseSpeed = this.pulseSpeed;

    this.vertexShader = FRESNEL_VERT;
    this.fragmentShader = FRESNEL_FRAG;
    this.wgslShader = FRESNEL_WGSL;
  }

  clone(overrides = {}) {
    const cloned = new FresnelMaterial(this._cloneSurfaceOptions({
      rimColor: this.rimColor ? this.rimColor.getHex() : 0x38bdf8,
      fresnelPower: this.fresnelPower,
      fresnelIntensity: this.fresnelIntensity,
      iridescence: this.iridescence,
      pulseSpeed: this.pulseSpeed,
      ...overrides,
    }));
    cloned._transparent = overrides.transparent !== undefined ? Boolean(overrides.transparent) : this._transparent;
    return cloned;
  }

  updateUniforms() {
    super.updateUniforms();
    const u = this.uniforms;
    u.uRimColor = this.rimColor;
    u.uFresnelPower = this.fresnelPower;
    u.uFresnelIntensity = this.fresnelIntensity;
    u.uIridescence = this.iridescence;
    u.uPulseSpeed = this.pulseSpeed;
  }
}

// 5) Desintegración procedural 3D con borde incandescente
export class DissolveMaterial extends SurfaceMaterial {
  constructor(o = {}) {
    super({ side: 'double', shininess: 32, ...o });
    this.isDissolveMaterial = true;
    this.type = 'dissolve';
    this.lit = true;

    this.progress = o.progress ?? 0.35;
    this.autoAnimate = o.autoAnimate ?? true;
    this.speed = o.speed ?? 0.45;
    this.edgeColor = new Color(o.edgeColor ?? 0xff5a1f);
    this.edgeWidth = o.edgeWidth ?? 0.09;
    this.noiseScale = o.noiseScale ?? 3.8;

    this.uniforms.uProgress = this.progress;
    this.uniforms.uAutoAnimate = this.autoAnimate ? 1 : 0;
    this.uniforms.uSpeed = this.speed;
    this.uniforms.uEdgeColor = this.edgeColor;
    this.uniforms.uEdgeWidth = this.edgeWidth;
    this.uniforms.uNoiseScale = this.noiseScale;

    this.vertexShader = DISSOLVE_VERT;
    this.fragmentShader = DISSOLVE_FRAG;
    this.wgslShader = DISSOLVE_WGSL;
  }

  clone(overrides = {}) {
    const cloned = new DissolveMaterial(this._cloneSurfaceOptions({
      progress: this.progress,
      autoAnimate: this.autoAnimate,
      speed: this.speed,
      edgeColor: this.edgeColor ? this.edgeColor.getHex() : 0xff5a1f,
      edgeWidth: this.edgeWidth,
      noiseScale: this.noiseScale,
      ...overrides,
    }));
    cloned._transparent = overrides.transparent !== undefined ? Boolean(overrides.transparent) : this._transparent;
    return cloned;
  }

  updateUniforms() {
    super.updateUniforms();
    const u = this.uniforms;
    u.uProgress = this.progress;
    u.uAutoAnimate = this.autoAnimate ? 1 : 0;
    u.uSpeed = this.speed;
    u.uEdgeColor = this.edgeColor;
    u.uEdgeWidth = this.edgeWidth;
    u.uNoiseScale = this.noiseScale;
  }
}
