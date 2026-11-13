export const BASIC_VERT = `
out vec2 vUv;
out vec4 vColor;
out vec3 vWorldPos;
uniform vec4 uUvTransform;
void main() {
  vUv = aUv * uUvTransform.xy + uUvTransform.zw;
  vColor = aColor;
  vec4 wp = MODEL_MATRIX * vec4(aPosition, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = uProjection * uView * wp;
}`;

export const BASIC_FRAG = `
in vec2 vUv;
in vec4 vColor;
in vec3 vWorldPos;
uniform vec3 uColor;
uniform float uOpacity;
#ifdef USE_ALPHATEST
uniform float uAlphaCutoff;
#endif
#ifdef USE_MAP
uniform sampler2D uMap;
#endif
#ifdef USE_FOG
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform float uFogDensity;
#endif
void main() {
  vec4 c = vec4(m3dInput(uColor), uOpacity);
  #ifdef USE_MAP
  c *= texture(uMap, vUv);
  #endif
  #ifdef USE_COLOR
  c.rgb *= m3dInput(vColor.rgb);
  c.a *= vColor.a;
  #endif
  #ifdef USE_ALPHATEST
  if (c.a < uAlphaCutoff) discard;
  #endif
  vec3 outc = c.rgb;
  #ifdef USE_FOG
  float d = length(uCameraPos - vWorldPos);
  float fd = d * uFogDensity;
  float f = uFogDensity > 0.0 ? 1.0 - exp(-(fd * fd)) : smoothstep(uFogNear, max(uFogNear + 1e-4, uFogFar), d);
  outc = mix(outc, m3dInput(uFogColor), f);
  #endif
  fragColor = vec4(m3dOutput(outc), c.a);
}`;

export const STANDARD_VERT = `
out vec2 vUv;
out vec3 vNormal;
out vec4 vColor;
out vec3 vWorldPos;
uniform vec4 uUvTransform;
void main() {
  vUv = aUv * uUvTransform.xy + uUvTransform.zw;
  vNormal = NORMAL_MATRIX * aNormal;
  vColor = aColor;
  vec4 wp = MODEL_MATRIX * vec4(aPosition, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = uProjection * uView * wp;
}`;

export const STANDARD_FRAG = `
in vec2 vUv;
in vec3 vNormal;
in vec4 vColor;
in vec3 vWorldPos;
uniform vec3 uColor;
uniform float uOpacity;
uniform vec3 uAmbient;
uniform vec3 uDirColor[4];
uniform vec3 uDirDir[4];
uniform int uDirCount;
uniform vec3 uPointPos[4];
uniform vec3 uPointColor[4];
uniform float uPointDist[4];
uniform float uPointDecay[4];
uniform int uPointCount;
uniform float uShininess;
uniform float uSpecular;
uniform vec3 uEmissive;
#ifdef USE_ALPHATEST
uniform float uAlphaCutoff;
#endif
#ifdef USE_MAP
uniform sampler2D uMap;
#endif
#ifdef USE_FOG
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform float uFogDensity;
#endif
#ifdef USE_SHADOW
uniform sampler2DShadow uShadowMap;
uniform mat4 uShadowMatrix;
uniform float uShadowBias;
uniform float uShadowStrength;
uniform int uShadowLight;
#endif

#ifdef USE_SHADOW
// 1 = iluminado, 0 = en sombra (el filtro de la textura hace 2×2 de suavizado)
float shadowAt(vec3 wp, float ndl) {
  vec4 sc = uShadowMatrix * vec4(wp, 1.0);
  vec3 p = sc.xyz / sc.w;
  p = p * 0.5 + 0.5;
  if (p.z > 1.0 || p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) return 1.0;
  float bias = uShadowBias * (1.0 + (1.0 - ndl) * 4.0);
  return texture(uShadowMap, vec3(p.xy, p.z - bias));
}
#endif

void main() {
  float nl = dot(vNormal, vNormal);
  vec3 n = nl > 1e-10 ? vNormal * inversesqrt(nl) : vec3(0.0, 1.0, 0.0);
  if (!gl_FrontFacing) n = -n;
  vec3 vd = uCameraPos - vWorldPos;
  float vl = dot(vd, vd);
  vec3 viewDir = vl > 1e-10 ? vd * inversesqrt(vl) : vec3(0.0, 0.0, 1.0);
  vec3 light = uAmbient;

  for (int i = 0; i < 4; i++) {
    if (i >= uDirCount) break;
    float ndl = max(dot(n, -uDirDir[i]), 0.0);
    float att = 1.0;
    #ifdef USE_SHADOW
    if (i == uShadowLight) att = mix(1.0, shadowAt(vWorldPos, ndl), uShadowStrength);
    #endif
    vec3 c = uDirColor[i] * ndl * att;
    #ifdef USE_SPECULAR
    vec3 hv = -uDirDir[i] + viewDir;
    float hl = dot(hv, hv);
    vec3 h = hl > 1e-8 ? hv * inversesqrt(hl) : n;
    float nh = max(dot(n, h), 0.0);
    if (nh > 0.0) c += uDirColor[i] * pow(nh, uShininess) * uSpecular * att;
    #endif
    light += c;
  }

  for (int i = 0; i < 4; i++) {
    if (i >= uPointCount) break;
    vec3 d = uPointPos[i] - vWorldPos;
    float dist = length(d);
    vec3 ldir = d / max(dist, 1e-4);
    float att = 1.0 / max(pow(max(dist, 1e-4), uPointDecay[i]), 0.01);
    if (uPointDist[i] > 0.0) {
      float pr = dist / uPointDist[i];
      float pr2 = pr * pr;
      att *= clamp(1.0 - pr2 * pr2, 0.0, 1.0);
    }
    float ndl = max(dot(n, ldir), 0.0);
    vec3 c = uPointColor[i] * ndl * att;
    #ifdef USE_SPECULAR
    vec3 hv = ldir + viewDir;
    float hl = dot(hv, hv);
    vec3 h = hl > 1e-8 ? hv * inversesqrt(hl) : n;
    float nh = max(dot(n, h), 0.0);
    if (nh > 0.0) c += uPointColor[i] * pow(nh, uShininess) * uSpecular * att;
    #endif
    light += c;
  }

  vec4 base = vec4(m3dInput(uColor), uOpacity);
  #ifdef USE_MAP
  base *= texture(uMap, vUv);
  #endif
  #ifdef USE_COLOR
  base.rgb *= m3dInput(vColor.rgb);
  base.a *= vColor.a;
  #endif
  #ifdef USE_ALPHATEST
  if (base.a < uAlphaCutoff) discard;
  #endif
  vec3 outc = base.rgb * light + m3dInput(uEmissive);
  #ifdef USE_FOG
  float d = length(uCameraPos - vWorldPos);
  float fd = d * uFogDensity;
  float f = uFogDensity > 0.0 ? 1.0 - exp(-(fd * fd)) : smoothstep(uFogNear, max(uFogNear + 1e-4, uFogFar), d);
  outc = mix(outc, m3dInput(uFogColor), f);
  #endif
  fragColor = vec4(m3dOutput(outc), base.a);
}`;

// Programa de profundidad del paso de sombras: solo escribe la profundidad.
export const SHADOW_VERT = `
uniform mat4 uLightMatrix;
void main() {
  gl_Position = uLightMatrix * MODEL_MATRIX * vec4(aPosition, 1.0);
}`;

export const SHADOW_FRAG = `
void main() { }`;
