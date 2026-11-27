export const BASIC_VERT = `
out vec2 vUv;
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
  vColor = aColor;
  vec4 wp = MODEL_MATRIX * vec4(m3dPos, 1.0);
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
out vec2 vUv0;
out vec2 vUv1;
out vec3 vNormal;
out vec4 vColor;
out vec3 vWorldPos;
uniform mat3 uUvMatrix;
void main() {
  vUv0 = aUv;
  vUv1 = aUv1;
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

export const STANDARD_FRAG = `
in vec2 vUv;
in vec2 vUv0;
in vec2 vUv1;
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
uniform vec3 uEmissive;
#ifdef USE_ALPHATEST
uniform float uAlphaCutoff;
#endif
#ifdef USE_MAP
uniform sampler2D uMap;
#endif
#ifdef USE_NORMALMAP
uniform sampler2D uNormalMap;
uniform vec2 uNormalScale;
uniform mat3 uNormalUvMatrix;
#endif
#ifdef USE_EMISSIVEMAP
uniform sampler2D uEmissiveMap;
uniform mat3 uEmissiveUvMatrix;
#endif
#ifdef USE_AOMAP
uniform sampler2D uAoMap;
uniform float uAoMapIntensity;
uniform mat3 uAoUvMatrix;
#endif
#ifdef USE_PBR
uniform float uRoughness;
uniform float uMetalness;
#endif
#ifdef USE_MRMAP
uniform sampler2D uMetallicRoughnessMap;
uniform mat3 uMrUvMatrix;
#endif
#ifdef USE_ROUGHNESSMAP
uniform sampler2D uRoughnessMap;
uniform mat3 uRoughnessUvMatrix;
#endif
#ifdef USE_METALNESSMAP
uniform sampler2D uMetalnessMap;
uniform mat3 uMetalnessUvMatrix;
#endif
uniform sampler2D uEnvMap;
uniform float uEnvIntensity;
uniform float uEnvHasMap;
uniform float uEnvMaxMip;
uniform float uEnvGain;
uniform vec3 uEnvSH[9];
uniform float uEnvMapIntensity;
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
uniform float uShadowRadius;
uniform float uShadowStrength;
uniform int uShadowLight;
#endif

const float M3D_PI = 3.14159265359;

vec3 m3dSampleEnv(vec3 dir, float mip) {
  vec3 d = normalize(dir);
  float u = atan(d.z, d.x) * 0.15915494309 + 0.5;
  float v = acos(clamp(d.y, -1.0, 1.0)) * 0.31830988618;
  return textureLod(uEnvMap, vec2(u, v), mip).rgb * max(uEnvGain, 1.0);
}

vec3 m3dEvalSH(vec3 n) {
  vec3 c = uEnvSH[0];
  c += uEnvSH[1] * n.y + uEnvSH[2] * n.z + uEnvSH[3] * n.x;
  c += uEnvSH[4] * (n.x * n.z)
     + uEnvSH[5] * (n.z * n.y)
     + uEnvSH[6] * (3.0 * n.y * n.y - 1.0)
     + uEnvSH[7] * (n.x * n.y)
     + uEnvSH[8] * (n.x * n.x - n.z * n.z);
  return max(c, vec3(0.0));
}

vec2 m3dEnvBRDFApprox(float rough, float ndv) {
  const vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
  const vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);
  vec4 r = rough * c0 + c1;
  float a004 = min(r.x * r.x, exp2(-9.28 * ndv)) * r.x + r.y;
  return vec2(-1.04, 1.04) * a004 + r.zw;
}

#ifdef USE_SHADOW
// 1 = iluminado, 0 = en sombra (PCF 3×3 ponderado + hardware 2×2 para evitar bordes pixelados)
float shadowAt(vec3 wp, float ndl) {
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
#endif

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

  #ifdef USE_NORMALMAP
  #ifdef USE_NORMALMAP_UV1
  vec2 nUv = (uNormalUvMatrix * vec3(vUv1, 1.0)).xy;
  #else
  vec2 nUv = (uNormalUvMatrix * vec3(vUv0, 1.0)).xy;
  #endif
  vec3 mapN = texture(uNormalMap, nUv).xyz * 2.0 - 1.0;
  mapN.xy *= uNormalScale;
  vec3 dp1 = dFdx(vWorldPos);
  vec3 dp2 = dFdy(vWorldPos);
  vec2 duv1 = dFdx(nUv);
  vec2 duv2 = dFdy(nUv);
  vec3 dp2perp = cross(dp2, n);
  vec3 dp1perp = cross(n, dp1);
  vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
  vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
  float maxTB = max(dot(T, T), dot(B, B));
  if (maxTB > 1e-12) {
    float invmax = inversesqrt(maxTB);
    mat3 TBN = mat3(T * invmax, B * invmax, n);
    n = normalize(TBN * mapN);
  }
  #endif

  vec3 vd = uCameraPos - vWorldPos;
  float vl = dot(vd, vd);
  vec3 viewDir = vl > 1e-10 ? vd * inversesqrt(vl) : vec3(0.0, 0.0, 1.0);

  float ao = 1.0;
  #ifdef USE_AOMAP
  #ifdef USE_AOMAP_UV1
  vec2 aoUv = (uAoUvMatrix * vec3(vUv1, 1.0)).xy;
  #else
  vec2 aoUv = (uAoUvMatrix * vec3(vUv0, 1.0)).xy;
  #endif
  ao = mix(1.0, texture(uAoMap, aoUv).r, uAoMapIntensity);
  #endif

  vec3 emissiveTerm = m3dInput(uEmissive);
  #ifdef USE_EMISSIVEMAP
  #ifdef USE_EMISSIVEMAP_UV1
  vec2 emUv = (uEmissiveUvMatrix * vec3(vUv1, 1.0)).xy;
  #else
  vec2 emUv = (uEmissiveUvMatrix * vec3(vUv0, 1.0)).xy;
  #endif
  emissiveTerm *= texture(uEmissiveMap, emUv).rgb;
  #endif

  vec3 outc = vec3(0.0);

  #ifdef USE_NEUTRAL
  outc = base.rgb;
  #else
  #ifdef USE_PBR
  float rough = uRoughness;
  float metal = uMetalness;
  #ifdef USE_MRMAP
  #ifdef USE_MRMAP_UV1
  vec2 mrUv = (uMrUvMatrix * vec3(vUv1, 1.0)).xy;
  #else
  vec2 mrUv = (uMrUvMatrix * vec3(vUv0, 1.0)).xy;
  #endif
  vec4 mrSample = texture(uMetallicRoughnessMap, mrUv);
  rough *= mrSample.g;
  metal *= mrSample.b;
  #endif
  #ifdef USE_ROUGHNESSMAP
  #ifdef USE_ROUGHNESSMAP_UV1
  vec2 rmUv = (uRoughnessUvMatrix * vec3(vUv1, 1.0)).xy;
  #else
  vec2 rmUv = (uRoughnessUvMatrix * vec3(vUv0, 1.0)).xy;
  #endif
  rough *= texture(uRoughnessMap, rmUv).g;
  #endif
  #ifdef USE_METALNESSMAP
  #ifdef USE_METALNESSMAP_UV1
  vec2 mmUv = (uMetalnessUvMatrix * vec3(vUv1, 1.0)).xy;
  #else
  vec2 mmUv = (uMetalnessUvMatrix * vec3(vUv0, 1.0)).xy;
  #endif
  metal *= texture(uMetalnessMap, mmUv).b;
  #endif
  rough = clamp(rough, 0.04, 1.0);
  metal = clamp(metal, 0.0, 1.0);

  vec3 F0 = mix(vec3(0.04), base.rgb, metal);
  float ndv = max(dot(n, viewDir), 1e-4);
  float a = rough * rough;
  float a2 = a * a;
  float kDirect = (rough + 1.0) * (rough + 1.0) * 0.125;
  float g1V = ndv / (ndv * (1.0 - kDirect) + kDirect);

  vec3 directLo = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    if (i >= uDirCount) break;
    vec3 ldir = -uDirDir[i];
    float ndl = max(dot(n, ldir), 0.0);
    if (ndl <= 0.0) continue;
    float att = 1.0;
    #ifdef USE_SHADOW
    if (i == uShadowLight) att = mix(1.0, shadowAt(vWorldPos, ndl), uShadowStrength);
    #endif
    vec3 hv = ldir + viewDir;
    float hl = dot(hv, hv);
    vec3 h = hl > 1e-8 ? hv * inversesqrt(hl) : n;
    float ndh = max(dot(n, h), 0.0);
    float vdh = max(dot(viewDir, h), 0.0);
    float denom = ndh * ndh * (a2 - 1.0) + 1.0;
    float D = a2 / max(M3D_PI * denom * denom, 1e-6);
    float g1L = ndl / (ndl * (1.0 - kDirect) + kDirect);
    float G = g1V * g1L;
    vec3 F = F0 + (1.0 - F0) * pow(clamp(1.0 - vdh, 0.0, 1.0), 5.0);
    vec3 spec = (D * G * F) / max(4.0 * ndv * ndl, 1e-4);
    vec3 kD = (vec3(1.0) - F) * (1.0 - metal);
    vec3 radiance = uDirColor[i] * M3D_PI * att;
    directLo += (kD * base.rgb / M3D_PI + spec) * radiance * ndl;
  }

  for (int i = 0; i < 4; i++) {
    if (i >= uPointCount) break;
    vec3 d = uPointPos[i] - vWorldPos;
    float dist = length(d);
    vec3 ldir = d / max(dist, 1e-4);
    float ndl = max(dot(n, ldir), 0.0);
    if (ndl <= 0.0) continue;
    float att = 1.0 / max(pow(max(dist, 1e-4), uPointDecay[i]), 0.01);
    if (uPointDist[i] > 0.0) {
      float pr = dist / uPointDist[i];
      float pr2 = pr * pr;
      att *= clamp(1.0 - pr2 * pr2, 0.0, 1.0);
    }
    vec3 hv = ldir + viewDir;
    float hl = dot(hv, hv);
    vec3 h = hl > 1e-8 ? hv * inversesqrt(hl) : n;
    float ndh = max(dot(n, h), 0.0);
    float vdh = max(dot(viewDir, h), 0.0);
    float denom = ndh * ndh * (a2 - 1.0) + 1.0;
    float D = a2 / max(M3D_PI * denom * denom, 1e-6);
    float g1L = ndl / (ndl * (1.0 - kDirect) + kDirect);
    float G = g1V * g1L;
    vec3 F = F0 + (1.0 - F0) * pow(clamp(1.0 - vdh, 0.0, 1.0), 5.0);
    vec3 spec = (D * G * F) / max(4.0 * ndv * ndl, 1e-4);
    vec3 kD = (vec3(1.0) - F) * (1.0 - metal);
    vec3 radiance = uPointColor[i] * M3D_PI * att;
    directLo += (kD * base.rgb / M3D_PI + spec) * radiance * ndl;
  }

  for (int i = 0; i < 4; i++) {
    if (i >= uSpotCount) break;
    vec3 d = uSpotPos[i] - vWorldPos;
    float dist = length(d);
    vec3 ldir = d / max(dist, 1e-4);
    float ndl = max(dot(n, ldir), 0.0);
    if (ndl <= 0.0) continue;
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
    vec3 hv = ldir + viewDir;
    float hl = dot(hv, hv);
    vec3 h = hl > 1e-8 ? hv * inversesqrt(hl) : n;
    float ndh = max(dot(n, h), 0.0);
    float vdh = max(dot(viewDir, h), 0.0);
    float denom = ndh * ndh * (a2 - 1.0) + 1.0;
    float D = a2 / max(M3D_PI * denom * denom, 1e-6);
    float g1L = ndl / (ndl * (1.0 - kDirect) + kDirect);
    float G = g1V * g1L;
    vec3 F = F0 + (1.0 - F0) * pow(clamp(1.0 - vdh, 0.0, 1.0), 5.0);
    vec3 spec = (D * G * F) / max(4.0 * ndv * ndl, 1e-4);
    vec3 kD = (vec3(1.0) - F) * (1.0 - metal);
    vec3 radiance = uSpotColor[i] * M3D_PI * att;
    directLo += (kD * base.rgb / M3D_PI + spec) * radiance * ndl;
  }

  vec3 ambientTerm = base.rgb * (1.0 - metal * 0.65) * uAmbient * ao;
  vec3 iblTerm = vec3(0.0);
  if (uEnvHasMap > 0.5 && uEnvIntensity > 0.0 && uEnvMapIntensity > 0.0) {
    vec3 F_ibl = F0 + (max(vec3(1.0 - rough), F0) - F0) * pow(clamp(1.0 - ndv, 0.0, 1.0), 5.0);
    vec3 kD_ibl = (vec3(1.0) - F_ibl) * (1.0 - metal);
    vec3 irr = m3dEvalSH(n);
    vec3 refl = reflect(-viewDir, n);
    vec3 pref = m3dSampleEnv(refl, rough * max(uEnvMaxMip, 0.0));
    vec2 brdf = m3dEnvBRDFApprox(rough, ndv);
    float specOcc = clamp(ao + (1.0 - rough) * 0.25, 0.0, 1.0);
    vec3 diffIBL = kD_ibl * base.rgb * irr * ao;
    vec3 specIBL = pref * max(F_ibl * brdf.x + brdf.y, vec3(0.0)) * specOcc;
    iblTerm = (diffIBL + specIBL) * uEnvIntensity * uEnvMapIntensity;
  }
  outc = directLo + ambientTerm + iblTerm + emissiveTerm;
  #else
  vec3 diffLight = uAmbient * ao;
  vec3 specLight = vec3(0.0);

  for (int i = 0; i < 4; i++) {
    if (i >= uDirCount) break;
    float ndl = max(dot(n, -uDirDir[i]), 0.0);
    float att = 1.0;
    #ifdef USE_SHADOW
    if (i == uShadowLight) att = mix(1.0, shadowAt(vWorldPos, ndl), uShadowStrength);
    #endif
    diffLight += uDirColor[i] * ndl * att;
    #ifdef USE_SPECULAR
    if (ndl > 0.0) {
      vec3 hv = -uDirDir[i] + viewDir;
      float hl = dot(hv, hv);
      vec3 h = hl > 1e-8 ? hv * inversesqrt(hl) : n;
      float nh = max(dot(n, h), 0.0);
      if (nh > 0.0) specLight += uDirColor[i] * pow(nh, uShininess) * uSpecular * att;
    }
    #endif
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
    #ifdef USE_SPECULAR
    if (ndl > 0.0) {
      vec3 hv = ldir + viewDir;
      float hl = dot(hv, hv);
      vec3 h = hl > 1e-8 ? hv * inversesqrt(hl) : n;
      float nh = max(dot(n, h), 0.0);
      if (nh > 0.0) specLight += uPointColor[i] * pow(nh, uShininess) * uSpecular * att;
    }
    #endif
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
    #ifdef USE_SPECULAR
    if (ndl > 0.0) {
      vec3 hv = ldir + viewDir;
      float hl = dot(hv, hv);
      vec3 h = hl > 1e-8 ? hv * inversesqrt(hl) : n;
      float nh = max(dot(n, h), 0.0);
      if (nh > 0.0) specLight += uSpotColor[i] * pow(nh, uShininess) * uSpecular * att;
    }
    #endif
  }

  vec3 envFill = vec3(0.0);
  if (uEnvHasMap > 0.5 && uEnvIntensity > 0.0 && uEnvMapIntensity > 0.0) {
    float ndvC = max(dot(n, viewDir), 0.0);
    float fresC = pow(1.0 - ndvC, 4.0) * 0.25 + 0.04;
    vec3 reflC = reflect(-viewDir, n);
    envFill = (base.rgb * m3dEvalSH(n) * 0.35 + m3dSampleEnv(reflC, max(uEnvMaxMip * 0.35, 0.0)) * fresC * uSpecular) * ao * uEnvIntensity * uEnvMapIntensity;
  }

  outc = base.rgb * diffLight + specLight + envFill + emissiveTerm;
  #endif
  #endif

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
  gl_Position = uLightMatrix * MODEL_MATRIX * vec4(m3dPos, 1.0);
}`;

export const SHADOW_FRAG = `
void main() { }`;
