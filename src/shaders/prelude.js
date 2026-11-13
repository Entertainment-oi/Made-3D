// Lo que Made3D antepone automáticamente a TODOS los shaders (GLSL ES 3.00).
// No hace falta escribir #version ni redeclarar estas variables.
const VERT = `
layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUv;
layout(location = 7) in vec4 aColor;
// matriz de normales correcta (inversa transpuesta) también con escala no uniforme
mat3 m3dNormalMatrix(mat3 m) {
  vec3 a = m[0], b = m[1], c = m[2];
  vec3 bc = cross(b, c);
  float det = dot(a, bc);
  mat3 adj = mat3(bc, cross(c, a), cross(a, b));
  return abs(det) > 1e-20 ? adj / det : adj;
}
#ifdef INSTANCED
layout(location = 3) in mat4 aInstance;
#define MODEL_MATRIX (uModel * aInstance)
#define NORMAL_MATRIX m3dNormalMatrix(mat3(uModel * aInstance))
#elif defined(USE_SKINNING)
// Skinning en la GPU: la posición ya sale en el mundo (hueso × pose de unión), igual que en la CPU.
layout(location = 8) in vec4 aSkinIndex;
layout(location = 9) in vec4 aSkinWeight;
uniform highp sampler2D uBoneTexture;   // 4 texels por hueso (las 4 columnas de su matriz), una fila por hueso
uniform mat4 uBindMatrix;
mat4 m3dBone(float i) {
  int id = int(i + 0.5);
  return mat4(texelFetch(uBoneTexture, ivec2(0, id), 0), texelFetch(uBoneTexture, ivec2(1, id), 0),
              texelFetch(uBoneTexture, ivec2(2, id), 0), texelFetch(uBoneTexture, ivec2(3, id), 0));
}
mat4 m3dSkinMat;   // se calcula una sola vez por vértice (ver m3dComputeSkin)
void m3dComputeSkin() {
  float ws = aSkinWeight.x + aSkinWeight.y + aSkinWeight.z + aSkinWeight.w;
  if (ws < 1e-4) { m3dSkinMat = uBindMatrix; return; }
  m3dSkinMat = (aSkinWeight.x * m3dBone(aSkinIndex.x) + aSkinWeight.y * m3dBone(aSkinIndex.y)
              + aSkinWeight.z * m3dBone(aSkinIndex.z) + aSkinWeight.w * m3dBone(aSkinIndex.w)) * uBindMatrix;
}
#define MODEL_MATRIX m3dSkinMat
#define NORMAL_MATRIX m3dNormalMatrix(mat3(m3dSkinMat))
#else
#define MODEL_MATRIX uModel
#define NORMAL_MATRIX uNormalMatrix
#endif
uniform mat4 uModel;
uniform mat4 uView;
uniform mat4 uProjection;
uniform mat3 uNormalMatrix;
uniform vec3 uCameraPos;
uniform float uTime;
`;

// Colores: m3dInput() pasa un color sRGB a lineal y m3dOutput() deja el resultado listo para la pantalla
// (solo actúan con renderer.colorSpace = 'srgb'; con 'linear' no hacen nada).
const FRAG = `
out vec4 fragColor;
precision highp sampler2DShadow;   // los samplers con comparación no tienen precisión por defecto
uniform vec3 uCameraPos;
uniform float uTime;
vec3 srgbToLinear(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
vec3 linearToSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(max(c, vec3(1e-5)), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
vec3 m3dInput(vec3 c) {
#ifdef OUTPUT_SRGB
  return srgbToLinear(c);
#else
  return c;
#endif
}
vec3 m3dOutput(vec3 c) {
#ifdef OUTPUT_SRGB
  return linearToSrgb(c);
#else
  return c;
#endif
}
`;

export function buildSource(stage, src, defines, instanced, srgb) {
  src = src.replace(/^\s*#version.*$/m, '');
  let s = '#version 300 es\nprecision highp float;\nprecision highp int;\n';
  for (const k in defines) { const v = defines[k]; s += `#define ${k} ${v === true ? 1 : v}\n`; }
  if (instanced) s += '#define INSTANCED\n';
  if (srgb) s += '#define OUTPUT_SRGB\n';
  // Con skinning, el main() del shader se renombra y se envuelve para calcular la matriz de piel una sola vez
  if (stage === 'vertex' && defines.USE_SKINNING && !instanced) {
    return s + VERT + '\n#define main m3dMain\n' + src + '\n#undef main\nvoid main() { m3dComputeSkin(); m3dMain(); }\n';
  }
  return s + (stage === 'vertex' ? VERT : FRAG) + '\n' + src;
}
