import { Material } from './Material.js';
import { Color } from '../math/Color.js';
import { BASIC_VERT, BASIC_FRAG, STANDARD_VERT, STANDARD_FRAG } from '../shaders/builtin.js';

class SurfaceMaterial extends Material {
  constructor(o = {}) {
    super(o);
    this.color = new Color(o.color ?? 0xffffff);
    this._vertexColors = false;
    this.vertexColors = o.vertexColors ?? false;   // multiplica por el atributo 'color' de la geometría
    this._map = null;
    this._uv = [1, 1, 0, 0];
    this._alphaTest = 0;
    this.alphaTest = o.alphaTest ?? 0;             // > 0: descarta los píxeles con alfa menor que este valor (hojas, pelo...)
    this.uniforms = { uColor: this.color, uOpacity: 1, uMap: null, uUvTransform: this._uv, uShininess: 0, uSpecular: 1, uAlphaCutoff: 0 };
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
    this._map = t;
    if (had !== !!t) this.invalidate();
  }
  getDefines() {
    const d = {};
    if (this._map) d.USE_MAP = 1;
    if (this.vertexColors) d.USE_COLOR = 1;
    if (this._alphaTest > 0) d.USE_ALPHATEST = 1;
    return d;
  }
  _computeKey() { return this.type + (this._map ? ':map' : '') + (this.vertexColors ? ':color' : '') + (this._alphaTest > 0 ? ':at' : ''); }
  updateUniforms() {
    const u = this.uniforms, t = this._map;
    u.uOpacity = this.opacity;
    u.uMap = t;
    u.uShininess = this.shininess;
    u.uSpecular = this.specular;
    u.uAlphaCutoff = this._alphaTest;
    if (t) { this._uv[0] = t.repeat.x; this._uv[1] = t.repeat.y; this._uv[2] = t.offset.x; this._uv[3] = t.offset.y; }
  }
}

// Color plano (+ textura). No recibe luces.
export class BasicMaterial extends SurfaceMaterial {
  constructor(o) {
    super(o);
    this.type = 'basic';
    this.vertexShader = BASIC_VERT;
    this.fragmentShader = BASIC_FRAG;
  }
}

// Iluminación difusa (ambiente + hasta 4 direccionales + hasta 4 puntuales), con especular
// opcional, niebla y sombras.
export class StandardMaterial extends SurfaceMaterial {
  constructor(o) {
    super(o);
    this.type = 'standard';
    this.lit = true;
    this.emissive = new Color(o && o.emissive !== undefined ? o.emissive : 0x000000);   // luz propia (se suma a la iluminada)
    this.uniforms.uEmissive = this.emissive;
    this.vertexShader = STANDARD_VERT;
    this.fragmentShader = STANDARD_FRAG;
  }
  getDefines() {
    const d = super.getDefines();
    if (this.shininess > 0) d.USE_SPECULAR = 1;
    return d;
  }
  _computeKey() { return super._computeKey() + (this.shininess > 0 ? ':spec' : ''); }
}
