// Preludio WGSL y preprocesador ligero para Made3D (WebGPU).
// Define los BindGroups estándar:
//   @group(0): uGlobals + uShadowMap + uShadowSampler
//   @group(1): uObject + uBoneMatrices (storage) + uMorphData (storage)
//   @group(2): uMat + texturas/samplers del material

export function preprocessWgsl(source, defines = {}) {
  const lines = source.split('\n');
  const out = [];
  const stack = []; // [{ parentActive, branchTaken, active }]

  const evalCond = (expr) => {
    const clean = expr.trim();
    const orParts = clean.split('||');
    for (let i = 0; i < orParts.length; i++) {
      const andParts = orParts[i].trim().split('&&');
      let allTrue = true;
      for (let j = 0; j < andParts.length; j++) {
        let tok = andParts[j].trim();
        let neg = false;
        if (tok.startsWith('!')) { neg = true; tok = tok.slice(1).trim(); }
        const m = tok.match(/^defined\(\s*([A-Za-z0-9_]+)\s*\)$/);
        const name = m ? m[1] : tok;
        const val = Boolean(defines[name]);
        if (neg ? val : !val) { allTrue = false; break; }
      }
      if (allTrue) return true;
    }
    return false;
  };

  const isActive = () => stack.length === 0 || stack[stack.length - 1].active;

  const stripDirectiveComment = (s) => {
    const idx = s.indexOf('//');
    return (idx >= 0 ? s.slice(0, idx) : s).trim();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) {
      const clean = stripDirectiveComment(trimmed);
      if (/^#ifdef\s+/.test(clean)) {
        const name = clean.slice(6).trim();
        const parent = isActive();
        const cond = Boolean(defines[name]);
        stack.push({ parentActive: parent, branchTaken: cond, active: parent && cond });
        continue;
      } else if (/^#ifndef\s+/.test(clean)) {
        const name = clean.slice(7).trim();
        const parent = isActive();
        const cond = !defines[name];
        stack.push({ parentActive: parent, branchTaken: cond, active: parent && cond });
        continue;
      } else if (/^#if\s+/.test(clean)) {
        const parent = isActive();
        const cond = evalCond(clean.slice(3));
        stack.push({ parentActive: parent, branchTaken: cond, active: parent && cond });
        continue;
      } else if (/^#elif\s+/.test(clean)) {
        const top = stack[stack.length - 1];
        if (top) {
          const cond = !top.branchTaken && evalCond(clean.slice(5));
          top.active = top.parentActive && cond;
          if (cond) top.branchTaken = true;
        }
        continue;
      } else if (clean === '#else') {
        const top = stack[stack.length - 1];
        if (top) {
          top.active = top.parentActive && !top.branchTaken;
          top.branchTaken = true;
        }
        continue;
      } else if (clean === '#endif') {
        stack.pop();
        continue;
      }
    }
    if (isActive()) {
      out.push(line);
    }
  }
  return out.join('\n');
}

export const WGSL_PRELUDE = `
struct GlobalUniforms {
  view: mat4x4<f32>,
  projection: mat4x4<f32>,
  shadowMatrix: mat4x4<f32>,
  cameraPos_time: vec4<f32>,
  ambient_dirCount: vec4<f32>,
  fogColor_near: vec4<f32>,
  fogParams: vec4<f32>,
  shadowParams: vec4<f32>,
  dirColor: array<vec4<f32>, 4>,
  dirDir: array<vec4<f32>, 4>,
  pointPos: array<vec4<f32>, 4>,
  pointColor: array<vec4<f32>, 4>,
  envParams: vec4<f32>,
  envSH: array<vec4<f32>, 9>,
  spotMeta: vec4<f32>,
  spotPos: array<vec4<f32>, 4>,
  spotDir: array<vec4<f32>, 4>,
  spotColor: array<vec4<f32>, 4>,
  spotCone: array<vec4<f32>, 4>,
};

struct ObjectUniforms {
  model: mat4x4<f32>,
  normalMat0: vec4<f32>,
  normalMat1: vec4<f32>,
  normalMat2: vec4<f32>,
  bindMatrix: mat4x4<f32>,
  morphInfo: vec4<u32>,
  morphWeights: array<vec4<f32>, 8>,
};

struct MaterialUniforms {
  color: vec4<f32>,
  emissive: vec4<f32>,
  extraColor0: vec4<f32>,
  extraColor1: vec4<f32>,
  pbr: vec4<f32>,
  params0: vec4<f32>,
  params1: vec4<f32>,
  uvMat0: vec4<f32>,
  uvMat1: vec4<f32>,
  uvMat2: vec4<f32>,
  normalUvMat0: vec4<f32>,
  normalUvMat1: vec4<f32>,
  normalUvMat2: vec4<f32>,
  emissiveUvMat0: vec4<f32>,
  emissiveUvMat1: vec4<f32>,
  emissiveUvMat2: vec4<f32>,
  aoUvMat0: vec4<f32>,
  aoUvMat1: vec4<f32>,
  aoUvMat2: vec4<f32>,
  mrUvMat0: vec4<f32>,
  mrUvMat1: vec4<f32>,
  mrUvMat2: vec4<f32>,
  roughnessUvMat0: vec4<f32>,
  roughnessUvMat1: vec4<f32>,
  roughnessUvMat2: vec4<f32>,
  metalnessUvMat0: vec4<f32>,
  metalnessUvMat1: vec4<f32>,
  metalnessUvMat2: vec4<f32>,
};

@group(0) @binding(0) var<uniform> uGlobals: GlobalUniforms;
@group(0) @binding(1) var uShadowMap: texture_depth_2d;
@group(0) @binding(2) var uShadowSampler: sampler_comparison;
@group(0) @binding(3) var uEnvMap: texture_2d<f32>;
@group(0) @binding(4) var uEnvSampler: sampler;

@group(1) @binding(0) var<uniform> uObject: ObjectUniforms;
@group(1) @binding(1) var<storage, read> uBoneMatrices: array<mat4x4<f32>>;
@group(1) @binding(2) var<storage, read> uMorphData: array<vec4<f32>>;

struct VertexInput {
  @location(0) position: vec3<f32>,
#ifdef HAS_NORMAL
  @location(1) normal: vec3<f32>,
#endif
#ifdef HAS_UV
  @location(2) uv: vec2<f32>,
#endif
#ifdef HAS_COLOR
  @location(7) color: vec4<f32>,
#endif
#ifdef HAS_UV1
  @location(10) uv1: vec2<f32>,
#endif
#ifdef INSTANCED
  @location(3) inst0: vec4<f32>,
  @location(4) inst1: vec4<f32>,
  @location(5) inst2: vec4<f32>,
  @location(6) inst3: vec4<f32>,
#elif defined(USE_SKINNING)
  @location(8) skinIndex: vec4<f32>,
  @location(9) skinWeight: vec4<f32>,
#endif
#ifdef USE_MORPH
  @builtin(vertex_index) vertexIndex: u32,
#endif
};

struct M3dVertex {
  pos: vec3<f32>,
  normal: vec3<f32>,
  uv: vec2<f32>,
  uv1: vec2<f32>,
  color: vec4<f32>,
  modelMatrix: mat4x4<f32>,
  normalMatrix: mat3x3<f32>,
};

fn m3dNormalMatrix(m: mat3x3<f32>) -> mat3x3<f32> {
  let a = m[0];
  let b = m[1];
  let c = m[2];
  let bc = cross(b, c);
  let det = dot(a, bc);
  let adj = mat3x3<f32>(bc, cross(c, a), cross(a, b));
  if (abs(det) > 1e-20) {
    return adj * (1.0 / det);
  }
  return adj;
}

fn m3dUvTransform(c0: vec4<f32>, c1: vec4<f32>, c2: vec4<f32>, uv: vec2<f32>) -> vec2<f32> {
  let m = mat3x3<f32>(c0.xyz, c1.xyz, c2.xyz);
  return (m * vec3<f32>(uv, 1.0)).xy;
}

fn m3dResolveVertex(vin: VertexInput) -> M3dVertex {
  var outv: M3dVertex;
  var pos = vin.position;
#ifdef HAS_NORMAL
  var nor = vin.normal;
#else
  var nor = vec3<f32>(0.0, 0.0, 1.0);
#endif
#ifdef HAS_UV
  outv.uv = vin.uv;
#else
  outv.uv = vec2<f32>(0.0, 0.0);
#endif
#ifdef HAS_UV1
  outv.uv1 = vin.uv1;
#else
  outv.uv1 = vec2<f32>(0.0, 0.0);
#endif
#ifdef HAS_COLOR
  outv.color = vin.color;
#else
  outv.color = vec4<f32>(1.0, 1.0, 1.0, 1.0);
#endif

#ifdef USE_MORPH
  let mCount = min(uObject.morphInfo.x, 32u);
  let vCount = uObject.morphInfo.y;
  let hasNor = uObject.morphInfo.z != 0u;
  let relMorph = uObject.morphInfo.w != 0u;
  let baseNor = nor;
  let stride = select(1u, 2u, hasNor);
  for (var i: u32 = 0u; i < mCount; i = i + 1u) {
    let w = uObject.morphWeights[i >> 2u][i & 3u];
    if (abs(w) < 1e-5) { continue; }
    let idx = (i * vCount + vin.vertexIndex) * stride;
    let tPos = uMorphData[idx].xyz;
    pos = pos + select(tPos - vin.position, tPos, relMorph) * w;
    if (hasNor) {
      let tNor = uMorphData[idx + 1u].xyz;
      nor = nor + select(tNor - baseNor, tNor, relMorph) * w;
    }
  }
#endif

  outv.pos = pos;
  outv.normal = nor;

#ifdef INSTANCED
  let instMat = mat4x4<f32>(vin.inst0, vin.inst1, vin.inst2, vin.inst3);
  let mm = uObject.model * instMat;
  outv.modelMatrix = mm;
  outv.normalMatrix = m3dNormalMatrix(mat3x3<f32>(mm[0].xyz, mm[1].xyz, mm[2].xyz));
#elif defined(USE_SKINNING)
  let ws = vin.skinWeight.x + vin.skinWeight.y + vin.skinWeight.z + vin.skinWeight.w;
  var skinMat = uObject.bindMatrix;
  if (ws >= 1e-4) {
    let b0 = uBoneMatrices[u32(vin.skinIndex.x + 0.5)];
    let b1 = uBoneMatrices[u32(vin.skinIndex.y + 0.5)];
    let b2 = uBoneMatrices[u32(vin.skinIndex.z + 0.5)];
    let b3 = uBoneMatrices[u32(vin.skinIndex.w + 0.5)];
    skinMat = (
      b0 * vin.skinWeight.x +
      b1 * vin.skinWeight.y +
      b2 * vin.skinWeight.z +
      b3 * vin.skinWeight.w
    ) * uObject.bindMatrix;
  }
  outv.modelMatrix = skinMat;
  outv.normalMatrix = m3dNormalMatrix(mat3x3<f32>(skinMat[0].xyz, skinMat[1].xyz, skinMat[2].xyz));
#else
  outv.modelMatrix = uObject.model;
  outv.normalMatrix = mat3x3<f32>(uObject.normalMat0.xyz, uObject.normalMat1.xyz, uObject.normalMat2.xyz);
#endif
  return outv;
}

fn srgbToLinear(c: vec3<f32>) -> vec3<f32> {
  let cl = clamp(c, vec3<f32>(0.0), vec3<f32>(1.0));
  return mix(cl / 12.92, pow((cl + 0.055) / 1.055, vec3<f32>(2.4)), step(vec3<f32>(0.04045), cl));
}

fn linearToSrgb(c: vec3<f32>) -> vec3<f32> {
  let cl = clamp(c, vec3<f32>(0.0), vec3<f32>(1.0));
  return mix(cl * 12.92, 1.055 * pow(max(cl, vec3<f32>(1e-5)), vec3<f32>(1.0 / 2.4)) - 0.055, step(vec3<f32>(0.0031308), cl));
}

fn m3dInput(c: vec3<f32>) -> vec3<f32> {
#if defined(INPUT_SRGB) || defined(OUTPUT_SRGB)
  return srgbToLinear(c);
#else
  return c;
#endif
}

fn m3dOutput(c: vec3<f32>) -> vec3<f32> {
#ifdef OUTPUT_SRGB
  return linearToSrgb(c);
#else
  return c;
#endif
}

fn m3dApplyFog(col: vec3<f32>, wp: vec3<f32>) -> vec3<f32> {
#ifdef USE_FOG
  let d = length(uGlobals.cameraPos_time.xyz - wp);
  let density = uGlobals.fogParams.y;
  let nearF = uGlobals.fogColor_near.w;
  let farF = uGlobals.fogParams.x;
  let fd = d * density;
  let f = select(
    smoothstep(nearF, max(nearF + 1e-4, farF), d),
    1.0 - exp(-(fd * fd)),
    density > 0.0
  );
  return mix(col, m3dInput(uGlobals.fogColor_near.xyz), f);
#else
  return col;
#endif
}

fn m3dShadowAt(wp: vec3<f32>, ndl: f32) -> f32 {
  let sc = uGlobals.shadowMatrix * vec4<f32>(wp, 1.0);
  let p = sc.xyz / sc.w;
  let uv = vec2<f32>(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  let z = p.z;
  let texSize = max(1.0, uGlobals.shadowParams.w);
  let texel = vec2<f32>(1.0 / texSize, 1.0 / texSize);
  let texScale = clamp(1024.0 * texel.x, 0.35, 3.0);
  let r = max(0.0, uGlobals.shadowParams.y);
  let bias = uGlobals.shadowParams.x * (0.45 + (1.0 - ndl) * 3.55) * texScale * (1.0 + r * 0.35);
  let refZ = clamp(z - bias, 0.0, 1.0);
  let inBounds = (z >= 0.0 && z <= 1.0 && uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0);
  if (r <= 0.001) {
    let single = textureSampleCompareLevel(uShadowMap, uShadowSampler, uv, refZ);
    return select(1.0, single, inBounds);
  }

  let stepUv = texel * r;
  var sum: f32 = 0.0;
  sum += textureSampleCompareLevel(uShadowMap, uShadowSampler, uv + vec2<f32>(-stepUv.x, -stepUv.y), refZ) * 1.0;
  sum += textureSampleCompareLevel(uShadowMap, uShadowSampler, uv + vec2<f32>(      0.0, -stepUv.y), refZ) * 2.0;
  sum += textureSampleCompareLevel(uShadowMap, uShadowSampler, uv + vec2<f32>( stepUv.x, -stepUv.y), refZ) * 1.0;
  sum += textureSampleCompareLevel(uShadowMap, uShadowSampler, uv + vec2<f32>(-stepUv.x,       0.0), refZ) * 2.0;
  sum += textureSampleCompareLevel(uShadowMap, uShadowSampler, uv,                                   refZ) * 4.0;
  sum += textureSampleCompareLevel(uShadowMap, uShadowSampler, uv + vec2<f32>( stepUv.x,       0.0), refZ) * 2.0;
  sum += textureSampleCompareLevel(uShadowMap, uShadowSampler, uv + vec2<f32>(-stepUv.x,  stepUv.y), refZ) * 1.0;
  sum += textureSampleCompareLevel(uShadowMap, uShadowSampler, uv + vec2<f32>(      0.0,  stepUv.y), refZ) * 2.0;
  sum += textureSampleCompareLevel(uShadowMap, uShadowSampler, uv + vec2<f32>( stepUv.x,  stepUv.y), refZ) * 1.0;
  return select(1.0, sum / 16.0, inBounds);
}

fn m3dSampleEnv(dir: vec3<f32>, mip: f32) -> vec3<f32> {
  let d = normalize(dir);
  let u = atan2(d.z, d.x) * 0.15915494309 + 0.5;
  let v = acos(clamp(d.y, -1.0, 1.0)) * 0.31830988618;
  let gain = max(uGlobals.envParams.w, 1.0);
  return textureSampleLevel(uEnvMap, uEnvSampler, vec2<f32>(u, v), mip).rgb * gain;
}

fn m3dEvalSH(n: vec3<f32>) -> vec3<f32> {
  var c = uGlobals.envSH[0].rgb;
  c = c + uGlobals.envSH[1].rgb * n.y + uGlobals.envSH[2].rgb * n.z + uGlobals.envSH[3].rgb * n.x;
  c = c + uGlobals.envSH[4].rgb * (n.x * n.z)
        + uGlobals.envSH[5].rgb * (n.z * n.y)
        + uGlobals.envSH[6].rgb * (3.0 * n.y * n.y - 1.0)
        + uGlobals.envSH[7].rgb * (n.x * n.y)
        + uGlobals.envSH[8].rgb * (n.x * n.x - n.z * n.z);
  return max(c, vec3<f32>(0.0));
}

fn m3dEnvBRDFApprox(rough: f32, ndv: f32) -> vec2<f32> {
  let c0 = vec4<f32>(-1.0, -0.0275, -0.572, 0.022);
  let c1 = vec4<f32>(1.0, 0.0425, 1.04, -0.04);
  let r = rough * c0 + c1;
  let a004 = min(r.x * r.x, exp2(-9.28 * ndv)) * r.x + r.y;
  return vec2<f32>(-1.04, 1.04) * a004 + r.zw;
}
`;

export function buildWgslSource(src, defines = {}, instanced = false, srgb = false, custom = false) {
  const merged = { ...defines };
  if (instanced) merged.INSTANCED = 1;
  if (srgb) merged.OUTPUT_SRGB = 1;
  const full = custom && src.includes('GlobalUniforms')
    ? src
    : (WGSL_PRELUDE + '\n' + src);
  return preprocessWgsl(full, merged);
}
