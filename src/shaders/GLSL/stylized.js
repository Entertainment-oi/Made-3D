// Shaders estilizados integrados en Made3D (GLSL ES 3.00).
// Todos aprovechan src/shaders/GLSL/prelude.js (instancing, GPU skinning, morphs, sRGB).

const SHADOW_HELPER = `
#ifdef USE_SHADOW
uniform sampler2DShadow uShadowMap;
uniform mat4 uShadowMatrix;
uniform float uShadowBias;
uniform float uShadowRadius;
uniform float uShadowStrength;
uniform int uShadowLight;
float m3dShadowAt(vec3 wp, float ndl) {
  vec4 sc = uShadowMatrix * vec4(wp, 1.0);
  vec3 p = sc.xyz / sc.w;
  p = p * 0.5 + 0.5;
  if (p.z > 1.0 || p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) return 1.0;
  vec2 texel = 1.0 / max(vec2(textureSize(uShadowMap, 0)), vec2(1.0));
  float texScale = clamp(1024.0 * texel.x, 0.35, 3.0);
  float r = max(0.0, uShadowRadius);
  float bias = uShadowBias * (0.45 + (1.0 - ndl) * 3.55) * texScale * (1.0 + r * 0.35);
  float refZ = p.z - bias;
  if (r <= 0.001) {
    return texture(uShadowMap, vec3(p.xy, refZ));
  }
  vec2 stepUv = texel * r;
  float sum = 0.0;
  sum += texture(uShadowMap, vec3(p.xy + vec2(-stepUv.x, -stepUv.y), refZ)) * 1.0;
  sum += texture(uShadowMap, vec3(p.xy + vec2(      0.0, -stepUv.y), refZ)) * 2.0;
  sum += texture(uShadowMap, vec3(p.xy + vec2( stepUv.x, -stepUv.y), refZ)) * 1.0;
  sum += texture(uShadowMap, vec3(p.xy + vec2(-stepUv.x,       0.0), refZ)) * 2.0;
  sum += texture(uShadowMap, vec3(p.xy,                              refZ)) * 4.0;
  sum += texture(uShadowMap, vec3(p.xy + vec2( stepUv.x,       0.0), refZ)) * 2.0;
  sum += texture(uShadowMap, vec3(p.xy + vec2(-stepUv.x,  stepUv.y), refZ)) * 1.0;
  sum += texture(uShadowMap, vec3(p.xy + vec2(      0.0,  stepUv.y), refZ)) * 2.0;
  sum += texture(uShadowMap, vec3(p.xy + vec2( stepUv.x,  stepUv.y), refZ)) * 1.0;
  return sum / 16.0;
}
#endif`;

const FOG_HELPER = `
#ifdef USE_FOG
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform float uFogDensity;
vec3 m3dApplyFog(vec3 col, vec3 wp) {
  float d = length(uCameraPos - wp);
  float fd = d * uFogDensity;
  float f = uFogDensity > 0.0 ? 1.0 - exp(-(fd * fd)) : smoothstep(uFogNear, max(uFogNear + 1e-4, uFogFar), d);
  return mix(col, m3dInput(uFogColor), f);
}
#endif`;

// 1) TOON / ANIME (Cel-shading con bandas, sombra tintada, rim light y contorno tinta)
export const TOON_VERT = `
out vec2 vUv;
out vec3 vNormal;
out vec4 vColor;
out vec3 vWorldPos;
uniform mat3 uUvMatrix;
void main() {
  #ifdef USE_MAP_UV1
  vec2 rawUv = aUv1;
  #else
  vec2 rawUv = aUv;
  #endif
  vUv = (uUvMatrix * vec3(rawUv, 1.0)).xy;
  vNormal = NORMAL_MATRIX * m3dNormal;
  vColor = aColor;
  vec4 wp = MODEL_MATRIX * vec4(m3dPos, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = uProjection * uView * wp;
}`;

export const TOON_FRAG = `
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
uniform vec3 uSpotPos[4];
uniform vec3 uSpotDir[4];
uniform vec3 uSpotColor[4];
uniform float uSpotDist[4];
uniform float uSpotDecay[4];
uniform float uSpotCosOuter[4];
uniform float uSpotCosInner[4];
uniform int uSpotCount;
uniform float uShininess;
uniform float uSpecular;
uniform float uSteps;
uniform float uSmoothness;
uniform vec3 uShadowColor;
uniform float uShadowTint;
uniform vec3 uRimColor;
uniform float uRimPower;
uniform float uRimStrength;
uniform vec3 uInkColor;
uniform float uInkWidth;
#ifdef USE_ALPHATEST
uniform float uAlphaCutoff;
#endif
#ifdef USE_MAP
uniform sampler2D uMap;
#endif
${SHADOW_HELPER}
${FOG_HELPER}

float m3dToonBand(float raw, float steps, float sm) {
  float s = max(1.0, floor(steps + 0.5));
  float scaled = clamp(raw, 0.0, 1.0) * s;
  float idx = floor(scaled);
  float frac = scaled - idx;
  float w = clamp(sm, 0.002, 0.45);
  float stepped = (idx + smoothstep(0.5 - w, 0.5 + w, frac)) / s;
  return clamp(stepped, 0.0, 1.0);
}

void main() {
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

  float nl = dot(vNormal, vNormal);
  vec3 n = nl > 1e-10 ? vNormal * inversesqrt(nl) : vec3(0.0, 1.0, 0.0);
  if (!gl_FrontFacing) n = -n;

  vec3 vd = uCameraPos - vWorldPos;
  float vl = dot(vd, vd);
  vec3 viewDir = vl > 1e-10 ? vd * inversesqrt(vl) : vec3(0.0, 0.0, 1.0);

  vec3 directLight = vec3(0.0);
  float maxBand = 0.0;
  vec3 specLight = vec3(0.0);

  for (int i = 0; i < 4; i++) {
    if (i >= uDirCount) break;
    float ndl = max(dot(n, -uDirDir[i]), 0.0);
    float att = 1.0;
    #ifdef USE_SHADOW
    if (i == uShadowLight) att = mix(1.0, m3dShadowAt(vWorldPos, ndl), uShadowStrength);
    #endif
    float band = m3dToonBand(ndl * att, uSteps, uSmoothness);
    maxBand = max(maxBand, band);
    directLight += uDirColor[i] * band;
    if (uShininess > 0.5 && ndl > 0.0) {
      vec3 hv = -uDirDir[i] + viewDir;
      float hl = dot(hv, hv);
      vec3 h = hl > 1e-8 ? hv * inversesqrt(hl) : n;
      float nh = max(dot(n, h), 0.0);
      float sp = smoothstep(0.45, 0.52, pow(nh, uShininess));
      specLight += uDirColor[i] * sp * uSpecular * att;
    }
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
    float band = m3dToonBand(ndl * clamp(att, 0.0, 1.0), uSteps, uSmoothness);
    maxBand = max(maxBand, band);
    directLight += uPointColor[i] * band * clamp(att, 0.0, 1.5);
    if (uShininess > 0.5 && ndl > 0.0) {
      vec3 hv = ldir + viewDir;
      float hl = dot(hv, hv);
      vec3 h = hl > 1e-8 ? hv * inversesqrt(hl) : n;
      float nh = max(dot(n, h), 0.0);
      float sp = smoothstep(0.45, 0.52, pow(nh, uShininess));
      specLight += uPointColor[i] * sp * uSpecular * clamp(att, 0.0, 1.5);
    }
  }

  for (int i = 0; i < 4; i++) {
    if (i >= uSpotCount) break;
    vec3 d = uSpotPos[i] - vWorldPos;
    float dist = length(d);
    vec3 ldir = d / max(dist, 1e-4);
    float theta = dot(-ldir, normalize(uSpotDir[i]));
    float spotFactor = smoothstep(uSpotCosOuter[i], uSpotCosInner[i], theta);
    if (spotFactor <= 0.0) continue;
    float att = 1.0 / max(pow(max(dist, 1e-4), uSpotDecay[i]), 0.01);
    if (uSpotDist[i] > 0.0) {
      float pr = dist / uSpotDist[i];
      float pr2 = pr * pr;
      att *= clamp(1.0 - pr2 * pr2, 0.0, 1.0);
    }
    att *= spotFactor;
    float ndl = max(dot(n, ldir), 0.0);
    float band = m3dToonBand(ndl * clamp(att, 0.0, 1.0), uSteps, uSmoothness);
    maxBand = max(maxBand, band);
    directLight += uSpotColor[i] * band * clamp(att, 0.0, 1.5);
    if (uShininess > 0.5 && ndl > 0.0) {
      vec3 hv = ldir + viewDir;
      float hl = dot(hv, hv);
      vec3 h = hl > 1e-8 ? hv * inversesqrt(hl) : n;
      float nh = max(dot(n, h), 0.0);
      float sp = smoothstep(0.45, 0.52, pow(nh, uShininess));
      specLight += uSpotColor[i] * sp * uSpecular * clamp(att, 0.0, 1.5);
    }
  }

  vec3 litCol = base.rgb * (uAmbient + directLight);
  vec3 shadowCol = base.rgb * m3dInput(uShadowColor);
  float inShadow = 1.0 - smoothstep(0.05, 0.55, maxBand);
  vec3 outc = mix(litCol, mix(litCol, shadowCol, clamp(uShadowTint, 0.0, 1.0)), inShadow);
  outc += specLight * 0.65;

  float ndv = clamp(dot(n, viewDir), 0.0, 1.0);
  float fresnel = 1.0 - ndv;
  if (uRimStrength > 0.001) {
    float rim = smoothstep(0.45, 0.62, pow(fresnel, max(0.3, uRimPower))) * (0.35 + 0.65 * maxBand);
    outc += m3dInput(uRimColor) * rim * uRimStrength;
  }

  if (uInkWidth > 0.001) {
    float edgeT = clamp(1.0 - uInkWidth, 0.05, 0.98);
    float inkMask = smoothstep(edgeT - 0.03, edgeT + 0.02, fresnel);
    outc = mix(outc, m3dInput(uInkColor), inkMask);
  }

  #ifdef USE_NEUTRAL
  outc = base.rgb;
  #endif

  #ifdef USE_FOG
  outc = m3dApplyFog(outc, vWorldPos);
  #endif
  fragColor = vec4(m3dOutput(outc), base.a);
}`;

// 2) HOLOGRAM (Holograma Sci-Fi con scanlines animadas, Fresnel y glitch)
export const HOLOGRAM_VERT = `
out vec2 vUv;
out vec3 vNormal;
out vec4 vColor;
out vec3 vWorldPos;
out float vGlitch;
uniform mat3 uUvMatrix;
uniform float uGlitchStrength;

float m3dHash1(float p) {
  return fract(sin(p * 127.1) * 43758.5453123);
}

void main() {
  #ifdef USE_MAP_UV1
  vec2 rawUv = aUv1;
  #else
  vec2 rawUv = aUv;
  #endif
  vUv = (uUvMatrix * vec3(rawUv, 1.0)).xy;
  vNormal = NORMAL_MATRIX * m3dNormal;
  vColor = aColor;

  vec4 wp = MODEL_MATRIX * vec4(m3dPos, 1.0);
  float tBucket = floor(uTime * 14.0);
  float pulse = step(0.82, m3dHash1(tBucket));
  float band = step(0.68, sin(wp.y * 11.0 + uTime * 22.0));
  float g = pulse * band * uGlitchStrength;
  wp.x += (m3dHash1(tBucket + floor(wp.y * 8.0)) - 0.5) * 0.14 * g;
  wp.z += (m3dHash1(tBucket * 1.7 + floor(wp.y * 6.0)) - 0.5) * 0.08 * g;

  vGlitch = g;
  vWorldPos = wp.xyz;
  gl_Position = uProjection * uView * wp;
}`;

export const HOLOGRAM_FRAG = `
in vec2 vUv;
in vec3 vNormal;
in vec4 vColor;
in vec3 vWorldPos;
in float vGlitch;
uniform vec3 uColor;
uniform vec3 uStripeColor;
uniform float uOpacity;
uniform float uFresnelPower;
uniform float uScanlineDensity;
uniform float uScanlineSpeed;
uniform float uGlitchStrength;
#ifdef USE_ALPHATEST
uniform float uAlphaCutoff;
#endif
#ifdef USE_MAP
uniform sampler2D uMap;
#endif
${FOG_HELPER}

void main() {
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

  float nl = dot(vNormal, vNormal);
  vec3 n = nl > 1e-10 ? vNormal * inversesqrt(nl) : vec3(0.0, 1.0, 0.0);
  if (!gl_FrontFacing) n = -n;

  vec3 vd = uCameraPos - vWorldPos;
  float vl = dot(vd, vd);
  vec3 viewDir = vl > 1e-10 ? vd * inversesqrt(vl) : vec3(0.0, 0.0, 1.0);

  float ndv = clamp(abs(dot(n, viewDir)), 0.0, 1.0);
  float fresnel = pow(1.0 - ndv, max(0.3, uFresnelPower));

  float scan = 0.5 + 0.5 * sin(vWorldPos.y * uScanlineDensity - uTime * uScanlineSpeed * 6.2831853);
  scan = pow(scan, 2.2);
  float sweep = smoothstep(0.65, 1.0, sin(vWorldPos.y * 2.2 - uTime * 2.1));
  float flicker = 0.92 + 0.08 * sin(uTime * 37.0 + vWorldPos.y * 5.0);

  vec3 stripe = m3dInput(uStripeColor);
  vec3 holoCol = mix(base.rgb, stripe, clamp(fresnel * 0.75 + sweep * 0.5 + vGlitch * 0.6, 0.0, 1.0));
  float energy = (0.28 + 0.72 * fresnel) * (0.45 + 0.55 * scan + 0.45 * sweep) * flicker;
  vec3 outc = holoCol * (0.75 + energy * 1.15);
  float holoAlpha = clamp(0.22 + 0.78 * fresnel + 0.3 * scan + 0.25 * sweep, 0.04, 1.0);
  float alpha = clamp(base.a * holoAlpha, 0.0, 1.0);

  #ifdef USE_FOG
  outc = m3dApplyFog(outc, vWorldPos);
  #endif
  fragColor = vec4(m3dOutput(outc), alpha);
}`;

// 3) MATCAP (Material Capture: soporta textura o estudio procedural en GLSL)
export const MATCAP_VERT = `
out vec2 vUv;
out vec3 vViewNormal;
out vec4 vColor;
out vec3 vWorldPos;
uniform mat3 uUvMatrix;
void main() {
  #ifdef USE_MAP_UV1
  vec2 rawUv = aUv1;
  #else
  vec2 rawUv = aUv;
  #endif
  vUv = (uUvMatrix * vec3(rawUv, 1.0)).xy;
  vec3 worldNormal = NORMAL_MATRIX * m3dNormal;
  vViewNormal = mat3(uView) * worldNormal;
  vColor = aColor;
  vec4 wp = MODEL_MATRIX * vec4(m3dPos, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = uProjection * uView * wp;
}`;

export const MATCAP_FRAG = `
in vec2 vUv;
in vec3 vViewNormal;
in vec4 vColor;
in vec3 vWorldPos;
uniform vec3 uColor;
uniform float uOpacity;
uniform vec3 uRimColor;
uniform float uGlossiness;
uniform float uMetalness;
#ifdef USE_ALPHATEST
uniform float uAlphaCutoff;
#endif
#ifdef USE_MAP
uniform sampler2D uMap;
#endif
#ifdef USE_MATCAP
uniform sampler2D uMatcap;
#endif
${FOG_HELPER}

void main() {
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

  float vl = dot(vViewNormal, vViewNormal);
  vec3 vn = vl > 1e-10 ? vViewNormal * inversesqrt(vl) : vec3(0.0, 0.0, 1.0);
  if (!gl_FrontFacing) vn = -vn;

  vec3 mc;
  #ifdef USE_MATCAP
  vec2 muv = clamp(vn.xy * 0.49 + 0.5, 0.01, 0.99);
  mc = texture(uMatcap, muv).rgb;
  #else
  // MatCap de estudio procedural: luz principal cálida + rebote inferior + fresnel + especular
  vec3 keyDir = normalize(vec3(0.42, 0.68, 0.60));
  vec3 fillDir = normalize(vec3(-0.65, -0.35, 0.45));
  float key = clamp(dot(vn, keyDir), 0.0, 1.0);
  float fill = clamp(dot(vn, fillDir), 0.0, 1.0);
  float hemi = vn.y * 0.5 + 0.5;
  float fresnel = pow(1.0 - clamp(abs(vn.z), 0.0, 1.0), 2.4);

  vec3 studio = mix(vec3(0.16, 0.17, 0.24), vec3(0.95, 0.93, 0.90), 0.28 + 0.72 * pow(key, 0.85));
  studio += vec3(0.20, 0.26, 0.38) * fill * 0.55;
  studio *= mix(0.75, 1.08, hemi);

  vec3 h = normalize(keyDir + vec3(0.0, 0.0, 1.0));
  float specPow = mix(10.0, 140.0, clamp(uGlossiness, 0.0, 1.0));
  float spec = pow(max(dot(vn, h), 0.0), specPow) * mix(0.25, 1.25, clamp(uGlossiness, 0.0, 1.0));

  float metalCurve = smoothstep(-0.3, 0.85, vn.y + sin(vn.x * 3.1) * 0.15);
  vec3 metalLook = mix(vec3(0.12, 0.14, 0.18), vec3(1.05, 1.04, 1.02), metalCurve);

  mc = mix(studio, metalLook, clamp(uMetalness, 0.0, 1.0));
  mc += vec3(1.0, 0.98, 0.94) * spec;
  mc += m3dInput(uRimColor) * fresnel * 0.45;
  #endif

  vec3 outc = base.rgb * mc;
  #ifdef USE_NEUTRAL
  outc = base.rgb;
  #endif
  #ifdef USE_FOG
  outc = m3dApplyFog(outc, vWorldPos);
  #endif
  fragColor = vec4(m3dOutput(outc), base.a);
}`;

// 4) FRESNEL / IRIDESCENCE (Campo de energía / cristal iridiscente animado)
export const FRESNEL_VERT = `
out vec2 vUv;
out vec3 vNormal;
out vec4 vColor;
out vec3 vWorldPos;
uniform mat3 uUvMatrix;
void main() {
  #ifdef USE_MAP_UV1
  vec2 rawUv = aUv1;
  #else
  vec2 rawUv = aUv;
  #endif
  vUv = (uUvMatrix * vec3(rawUv, 1.0)).xy;
  vNormal = NORMAL_MATRIX * m3dNormal;
  vColor = aColor;
  vec4 wp = MODEL_MATRIX * vec4(m3dPos, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = uProjection * uView * wp;
}`;

export const FRESNEL_FRAG = `
in vec2 vUv;
in vec3 vNormal;
in vec4 vColor;
in vec3 vWorldPos;
uniform vec3 uColor;
uniform vec3 uRimColor;
uniform float uOpacity;
uniform float uFresnelPower;
uniform float uFresnelIntensity;
uniform float uIridescence;
uniform float uPulseSpeed;
#ifdef USE_ALPHATEST
uniform float uAlphaCutoff;
#endif
#ifdef USE_MAP
uniform sampler2D uMap;
#endif
${FOG_HELPER}

vec3 m3dRainbow(float t) {
  return 0.5 + 0.5 * cos(6.2831853 * (t + vec3(0.0, 0.33, 0.67)));
}

void main() {
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

  float nl = dot(vNormal, vNormal);
  vec3 n = nl > 1e-10 ? vNormal * inversesqrt(nl) : vec3(0.0, 1.0, 0.0);
  if (!gl_FrontFacing) n = -n;

  vec3 vd = uCameraPos - vWorldPos;
  float vl = dot(vd, vd);
  vec3 viewDir = vl > 1e-10 ? vd * inversesqrt(vl) : vec3(0.0, 0.0, 1.0);

  float ndv = clamp(dot(n, viewDir), 0.0, 1.0);
  float fresnel = pow(1.0 - ndv, max(0.25, uFresnelPower));
  float pulse = 0.86 + 0.14 * sin(uTime * uPulseSpeed * 3.0 + vWorldPos.y * 3.5);

  vec3 rimBase = m3dInput(uRimColor);
  vec3 irid = m3dRainbow(fresnel * 1.1 + uTime * 0.12 + dot(n, vec3(0.3, 0.6, 0.2)) * 0.35);
  vec3 rimCol = mix(rimBase, irid, clamp(uIridescence, 0.0, 1.0));

  float coreShade = 0.35 + 0.65 * ndv;
  vec3 outc = base.rgb * coreShade + rimCol * fresnel * uFresnelIntensity * pulse;
  float alpha = base.a < 0.999 ? clamp(base.a * mix(0.28, 1.35, fresnel), 0.0, 1.0) : base.a;

  #ifdef USE_NEUTRAL
  outc = base.rgb;
  alpha = base.a;
  #endif

  #ifdef USE_FOG
  outc = m3dApplyFog(outc, vWorldPos);
  #endif
  fragColor = vec4(m3dOutput(outc), alpha);
}`;

// 5) DISSOLVE (Desintegración procedural 3D con borde incandescente + iluminación/sombras)
export const DISSOLVE_VERT = `
out vec2 vUv;
out vec3 vNormal;
out vec4 vColor;
out vec3 vWorldPos;
out vec3 vLocalPos;
uniform mat3 uUvMatrix;
void main() {
  #ifdef USE_MAP_UV1
  vec2 rawUv = aUv1;
  #else
  vec2 rawUv = aUv;
  #endif
  vUv = (uUvMatrix * vec3(rawUv, 1.0)).xy;
  vNormal = NORMAL_MATRIX * m3dNormal;
  vColor = aColor;
  vLocalPos = m3dPos;
  vec4 wp = MODEL_MATRIX * vec4(m3dPos, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = uProjection * uView * wp;
}`;

export const DISSOLVE_FRAG = `
in vec2 vUv;
in vec3 vNormal;
in vec4 vColor;
in vec3 vWorldPos;
in vec3 vLocalPos;
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
uniform vec3 uSpotPos[4];
uniform vec3 uSpotDir[4];
uniform vec3 uSpotColor[4];
uniform float uSpotDist[4];
uniform float uSpotDecay[4];
uniform float uSpotCosOuter[4];
uniform float uSpotCosInner[4];
uniform int uSpotCount;
uniform float uShininess;
uniform float uSpecular;
uniform float uProgress;
uniform float uAutoAnimate;
uniform float uSpeed;
uniform vec3 uEdgeColor;
uniform float uEdgeWidth;
uniform float uNoiseScale;
#ifdef USE_ALPHATEST
uniform float uAlphaCutoff;
#endif
#ifdef USE_MAP
uniform sampler2D uMap;
#endif
${SHADOW_HELPER}
${FOG_HELPER}

float m3dHash3(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float m3dNoise3(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(
      mix(m3dHash3(i + vec3(0.0, 0.0, 0.0)), m3dHash3(i + vec3(1.0, 0.0, 0.0)), f.x),
      mix(m3dHash3(i + vec3(0.0, 1.0, 0.0)), m3dHash3(i + vec3(1.0, 1.0, 0.0)), f.x),
      f.y
    ),
    mix(
      mix(m3dHash3(i + vec3(0.0, 0.0, 1.0)), m3dHash3(i + vec3(1.0, 0.0, 1.0)), f.x),
      mix(m3dHash3(i + vec3(0.0, 1.0, 1.0)), m3dHash3(i + vec3(1.0, 1.0, 1.0)), f.x),
      f.y
    ),
    f.z
  );
}

void main() {
  vec3 p = vLocalPos * max(0.1, uNoiseScale);
  float nVal = 0.68 * m3dNoise3(p) + 0.32 * m3dNoise3(p * 2.13 + vec3(4.2, 1.7, 8.9));
  float thresh = uAutoAnimate > 0.5
    ? (0.5 - 0.5 * cos(uTime * uSpeed * 2.2)) * 1.04
    : clamp(uProgress, 0.0, 1.0) * 1.04;
  if (nVal < thresh) discard;

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

  float nl = dot(vNormal, vNormal);
  vec3 n = nl > 1e-10 ? vNormal * inversesqrt(nl) : vec3(0.0, 1.0, 0.0);
  if (!gl_FrontFacing) n = -n;

  vec3 vd = uCameraPos - vWorldPos;
  float vl = dot(vd, vd);
  vec3 viewDir = vl > 1e-10 ? vd * inversesqrt(vl) : vec3(0.0, 0.0, 1.0);

  vec3 diffLight = uAmbient;
  vec3 specLight = vec3(0.0);

  for (int i = 0; i < 4; i++) {
    if (i >= uDirCount) break;
    float ndl = max(dot(n, -uDirDir[i]), 0.0);
    float att = 1.0;
    #ifdef USE_SHADOW
    if (i == uShadowLight) att = mix(1.0, m3dShadowAt(vWorldPos, ndl), uShadowStrength);
    #endif
    diffLight += uDirColor[i] * ndl * att;
    if (uShininess > 0.5 && ndl > 0.0) {
      vec3 hv = -uDirDir[i] + viewDir;
      float hl = dot(hv, hv);
      vec3 h = hl > 1e-8 ? hv * inversesqrt(hl) : n;
      specLight += uDirColor[i] * pow(max(dot(n, h), 0.0), uShininess) * uSpecular * att;
    }
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
    diffLight += uPointColor[i] * ndl * att;
    if (uShininess > 0.5 && ndl > 0.0) {
      vec3 hv = ldir + viewDir;
      float hl = dot(hv, hv);
      vec3 h = hl > 1e-8 ? hv * inversesqrt(hl) : n;
      specLight += uPointColor[i] * pow(max(dot(n, h), 0.0), uShininess) * uSpecular * att;
    }
  }

  for (int i = 0; i < 4; i++) {
    if (i >= uSpotCount) break;
    vec3 d = uSpotPos[i] - vWorldPos;
    float dist = length(d);
    vec3 ldir = d / max(dist, 1e-4);
    float theta = dot(-ldir, normalize(uSpotDir[i]));
    float spotFactor = smoothstep(uSpotCosOuter[i], uSpotCosInner[i], theta);
    if (spotFactor <= 0.0) continue;
    float att = 1.0 / max(pow(max(dist, 1e-4), uSpotDecay[i]), 0.01);
    if (uSpotDist[i] > 0.0) {
      float pr = dist / uSpotDist[i];
      float pr2 = pr * pr;
      att *= clamp(1.0 - pr2 * pr2, 0.0, 1.0);
    }
    att *= spotFactor;
    float ndl = max(dot(n, ldir), 0.0);
    diffLight += uSpotColor[i] * ndl * att;
    if (uShininess > 0.5 && ndl > 0.0) {
      vec3 hv = ldir + viewDir;
      float hl = dot(hv, hv);
      vec3 h = hl > 1e-8 ? hv * inversesqrt(hl) : n;
      specLight += uSpotColor[i] * pow(max(dot(n, h), 0.0), uShininess) * uSpecular * att;
    }
  }

  vec3 outc = base.rgb * diffLight + specLight;
  float edgeBand = 1.0 - smoothstep(thresh, thresh + max(0.005, uEdgeWidth), nVal);
  if (thresh > 0.001) {
    outc = mix(outc, m3dInput(uEdgeColor) * 2.4, edgeBand);
  }

  #ifdef USE_NEUTRAL
  outc = base.rgb;
  #endif

  #ifdef USE_FOG
  outc = m3dApplyFog(outc, vWorldPos);
  #endif
  fragColor = vec4(m3dOutput(outc), base.a);
}`;
