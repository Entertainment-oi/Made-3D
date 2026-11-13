let _id = 0;

export class Material {
  constructor(o = {}) {
    this.id = ++_id;
    this.type = 'material';
    this.visible = true;
    this._transparent = o.transparent ?? false;
    this._depthWrite = o.depthWrite;          // undefined = automático (no escribe profundidad si es transparente)
    this.opacity = o.opacity ?? 1;
    this.side = o.side ?? 'front';            // 'front' | 'back' | 'double'
    this.depthTest = o.depthTest ?? true;
    this.blending = o.blending ?? 'normal';   // 'normal' | 'additive' (si transparent)
    this.twoPass = o.twoPass ?? true;         // transparente + doble cara: dibuja traseras y luego delanteras
    this.frustumCulled = o.frustumCulled ?? true; // false: sus objetos nunca se descartan por la cámara
    this.wireframe = o.wireframe ?? false;     // dibuja la malla con sus aristas en vez de con triángulos
    this.fog = o.fog ?? true;                  // esta niebla le afecta
    this.receiveShadow = o.receiveShadow ?? true; // recibe las sombras
    this._shininess = 0;
    this.shininess = o.shininess ?? 0;         // 0 = sin especular; >0 = brillo (Blinn-Phong)
    this.specular = o.specular ?? 1;           // intensidad del especular
    this.lit = false;                          // los materiales con luz admiten sombras y especular
    this.vertexShader = '';
    this.fragmentShader = '';
    this.uniforms = {};
    this._key = null; this._progs = null;
  }
  // El brillo cambia el shader: hay que recompilar el programa.
  get shininess() { return this._shininess; }
  set shininess(v) {
    const n = +v || 0;
    if (n !== this._shininess) { this._shininess = n; this.invalidate(); }
  }
  get transparent() { return this._transparent; }
  set transparent(v) { this._transparent = v; }
  get depthWrite() { return this._depthWrite ?? !this._transparent; }
  set depthWrite(v) { this._depthWrite = v; }
  getDefines() { return {}; }
  get programKey() { return this._key ??= this._computeKey(); }
  _computeKey() { return this.type; }
  // Forzar recompilación (p. ej. si cambia el código del shader).
  invalidate() { this._key = null; this._progs = null; }
  updateUniforms() {}
  // Suelta la caché de programas de este material (los programas se comparten y se reconstruyen si hace falta).
  dispose() { this.invalidate(); }
}

// Material con tus propios shaders GLSL. Ver shaders/prelude.js para lo que ya viene declarado.
// Como un shader puede mover los vértices, por defecto sus mallas NO se descartan por frustum culling:
// si tu shader no deforma la geometría, pasa `frustumCulled: true` para ahorrar trabajo.
// uniforms: { uNombre: valor } — número, Vec2/Vec3/Color, array, Mat4 o Texture.
export class ShaderMaterial extends Material {
  constructor(o = {}) {
    super(o);
    this.type = 'shader';
    this.vertexShader = o.vertexShader;
    this.fragmentShader = o.fragmentShader;
    this.uniforms = o.uniforms || {};
    this.defines = o.defines || {};
    if (o.frustumCulled === undefined) this.frustumCulled = false;
  }
  getDefines() { return this.defines; }
  _computeKey() { return 'S' + this.vertexShader + '\u0001' + this.fragmentShader + JSON.stringify(this.defines); }
}
