// Shaders auxiliares y Compute Shaders WGSL para WebGPU:
// - Blit / generación de mipmaps
// - Silueta y Compute H-pass / Composición V-pass para SelectionOutline
// - Compute shader para deformación de pinceles de esculpido en GPU

export const MIPMAP_BLIT_WGSL = `
@group(0) @binding(0) var uTex: texture_2d<f32>;
@group(0) @binding(1) var uSamp: sampler;

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vid: u32) -> VsOut {
  var p = vec2<f32>(f32((vid << 1u) & 2u), f32(vid & 2u));
  var out: VsOut;
  out.pos = vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
  out.uv = vec2<f32>(p.x, 1.0 - p.y);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  return textureSample(uTex, uSamp, in.uv);
}
`;

export const OUTLINE_SILHOUETTE_WGSL = `
struct OutlineUniforms {
  color: vec4<f32>,
};

@group(2) @binding(0) var<uniform> uOutline: OutlineUniforms;

@vertex
fn vs_main(vin: VertexInput) -> @builtin(position) vec4<f32> {
  let v = m3dResolveVertex(vin);
  return uGlobals.projection * uGlobals.view * v.modelMatrix * vec4<f32>(v.pos, 1.0);
}

@fragment
fn fs_main() -> @location(0) vec4<f32> {
  return uOutline.color;
}
`;

// Compute Shader 1D horizontal para SelectionOutline (escribe en textura rgba8unorm)
export const OUTLINE_HORIZ_COMPUTE_WGSL = `
struct OutlineParams {
  minCoord: vec2<i32>,
  maxCoord: vec2<i32>,
  maskScale: vec2<f32>,
  invScreen: vec2<f32>,
  intRadius: i32,
  radius: f32,
  checkLinearMask: i32,
  pad: i32,
};

@group(0) @binding(0) var uMask: texture_2d<f32>;
@group(0) @binding(1) var uHorizOut: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> uParams: OutlineParams;

@compute @workgroup_size(8, 8, 1)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let coord = vec2<i32>(gid.xy) + uParams.minCoord;
  if (coord.x > uParams.maxCoord.x || coord.y > uParams.maxCoord.y) { return; }

  let center = textureLoad(uMask, coord, 0);
  if (center.a > 0.5) {
    textureStore(uHorizOut, coord, vec4<f32>(center.rgb, 1.0));
    return;
  }

  var bestDx: i32 = 9999;
  var bestCol = vec3<f32>(0.0);
  for (var d: i32 = 1; d <= 10; d = d + 1) {
    if (d > uParams.intRadius) { break; }
    let rx = min(coord.x + d, uParams.maxCoord.x);
    let tR = textureLoad(uMask, vec2<i32>(rx, coord.y), 0);
    if (tR.a > 0.5) {
      bestDx = d;
      bestCol = tR.rgb;
      break;
    }
    let lx = max(coord.x - d, uParams.minCoord.x);
    let tL = textureLoad(uMask, vec2<i32>(lx, coord.y), 0);
    if (tL.a > 0.5) {
      bestDx = d;
      bestCol = tL.rgb;
      break;
    }
  }

  if (bestDx > uParams.intRadius) {
    textureStore(uHorizOut, coord, vec4<f32>(0.0));
    return;
  }

  let dxNorm = f32(bestDx) / max(1.0, uParams.radius);
  let encoded = clamp(0.98 - (dxNorm * 0.6666667) * 0.96, 0.02, 0.98);
  textureStore(uHorizOut, coord, vec4<f32>(bestCol, encoded));
}
`;

export const OUTLINE_VERT_COMPOSITE_WGSL = `
struct OutlineParams {
  minCoord: vec2<i32>,
  maxCoord: vec2<i32>,
  maskScale: vec2<f32>,
  invScreen: vec2<f32>,
  intRadius: i32,
  radius: f32,
  checkLinearMask: i32,
  pad: i32,
};

@group(0) @binding(0) var uMask: texture_2d<f32>;
@group(0) @binding(1) var uHoriz: texture_2d<f32>;
@group(0) @binding(2) var uMaskSampler: sampler;
@group(0) @binding(3) var<uniform> uParams: OutlineParams;

@vertex
fn vs_main(@builtin(vertex_index) vid: u32) -> @builtin(position) vec4<f32> {
  let p = vec2<f32>(f32((vid << 1u) & 2u), f32(vid & 2u));
  return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fs_main(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
  let uv = fragCoord.xy * uParams.invScreen;
  let maskSample = textureSampleLevel(uMask, uMaskSampler, uv, 0.0);
  if (uParams.checkLinearMask != 0 && maskSample.a > 0.5) {
    discard;
  }

  let coord = clamp(vec2<i32>(fragCoord.xy * uParams.maskScale), uParams.minCoord, uParams.maxCoord);
  let centerH = textureLoad(uHoriz, coord, 0);
  if (uParams.checkLinearMask == 0 && centerH.a >= 0.995) {
    discard;
  }

  var bestNormDist: f32 = 2.0;
  var bestCol = vec3<f32>(0.0);
  let invR = 1.0 / max(1.0, uParams.radius);

  if (centerH.a > 0.005) {
    let dxNorm = select(max(0.0, (0.98 - centerH.a) * 1.5625), 0.0, centerH.a >= 0.995);
    bestNormDist = dxNorm;
    bestCol = centerH.rgb;
  }

  for (var d: i32 = 1; d <= 10; d = d + 1) {
    if (d > uParams.intRadius) { break; }
    let dyNorm = f32(d) * invR;
    if (dyNorm >= bestNormDist) { break; }

    let uy = min(coord.y + d, uParams.maxCoord.y);
    let tU = textureLoad(uHoriz, vec2<i32>(coord.x, uy), 0);
    if (tU.a > 0.005) {
      let dxNorm = select(max(0.0, (0.98 - tU.a) * 1.5625), 0.0, tU.a >= 0.995);
      let dist = sqrt(dxNorm * dxNorm + dyNorm * dyNorm);
      if (dist < bestNormDist) {
        bestNormDist = dist;
        bestCol = tU.rgb;
      }
    }

    let ly = max(coord.y - d, uParams.minCoord.y);
    let tL = textureLoad(uHoriz, vec2<i32>(coord.x, ly), 0);
    if (tL.a > 0.005) {
      let dxNorm = select(max(0.0, (0.98 - tL.a) * 1.5625), 0.0, tL.a >= 0.995);
      let dist = sqrt(dxNorm * dxNorm + dyNorm * dyNorm);
      if (dist < bestNormDist) {
        bestNormDist = dist;
        bestCol = tL.rgb;
      }
    }
  }

  if (bestNormDist > 1.05) { discard; }
  let alpha = clamp(1.18 - bestNormDist * 0.42, 0.0, 1.0);
  return vec4<f32>(bestCol, alpha);
}
`;

// Compute Shader para acelerar pinceles de esculpido sobre mallas densas en WebGPU
export const SCULPT_BRUSH_COMPUTE_WGSL = `
struct SculptParams {
  center: vec4<f32>,    // xyz = centro local, w = radio
  normal: vec4<f32>,    // xyz = dirección de empuje, w = fuerza
  meta: vec4<u32>,      // x = vertexCount, y = falloff (0 smooth, 1 sphere, 2 tip), z = tool, w = flags
};

@group(0) @binding(0) var<storage, read_write> positions: array<f32>;
@group(0) @binding(1) var<storage, read> normals: array<f32>;
@group(0) @binding(2) var<uniform> uSculpt: SculptParams;

fn evalFalloff(t: f32, kind: u32) -> f32 {
  if (t >= 1.0) { return 0.0; }
  if (t <= 0.0) { return 1.0; }
  if (kind == 1u) { return sqrt(max(0.0, 1.0 - t * t)); }
  if (kind == 2u) { let u = 1.0 - t; return u * u; }
  let u = 1.0 - t * t;
  return u * u;
}

@compute @workgroup_size(64, 1, 1)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= uSculpt.meta.x) { return; }
  let o = i * 3u;
  let p = vec3<f32>(positions[o], positions[o + 1u], positions[o + 2u]);
  let n = vec3<f32>(normals[o], normals[o + 1u], normals[o + 2u]);
  let d = p - uSculpt.center.xyz;
  let dist = length(d);
  let radius = max(1e-5, uSculpt.center.w);
  if (dist >= radius) { return; }

  let w = evalFalloff(dist / radius, uSculpt.meta.y) * uSculpt.normal.w;
  let dir = select(uSculpt.normal.xyz, n, uSculpt.meta.z == 4u);
  let nextP = p + dir * w;
  positions[o] = nextP.x;
  positions[o + 1u] = nextP.y;
  positions[o + 2u] = nextP.z;
}
`;
