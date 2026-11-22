// Shaders estilizados en WGSL para WebGPU (Toon, Hologram, Matcap, Fresnel, Dissolve).

const GROUP2_SURFACE = `
@group(2) @binding(0) var<uniform> uMat: MaterialUniforms;
#ifdef USE_MAP
@group(2) @binding(1) var uMap: texture_2d<f32>;
@group(2) @binding(2) var uMapSampler: sampler;
#endif
`;

// 1) TOON / ANIME
export const TOON_WGSL = `
${GROUP2_SURFACE}

struct VsOut {
  @builtin(position) position: vec4<f32>,
  @location(0) vUv: vec2<f32>,
  @location(1) vNormal: vec3<f32>,
  @location(2) vColor: vec4<f32>,
  @location(3) vWorldPos: vec3<f32>,
};

@vertex
fn vs_main(vin: VertexInput) -> VsOut {
  let v = m3dResolveVertex(vin);
  var out: VsOut;
#ifdef USE_MAP_UV1
  let rawUv = v.uv1;
#else
  let rawUv = v.uv;
#endif
  out.vUv = m3dUvTransform(uMat.uvMat0, uMat.uvMat1, uMat.uvMat2, rawUv);
  out.vNormal = v.normalMatrix * v.normal;
  out.vColor = v.color;
  let wp = v.modelMatrix * vec4<f32>(v.pos, 1.0);
  out.vWorldPos = wp.xyz;
  out.position = uGlobals.projection * uGlobals.view * wp;
  return out;
}

fn m3dToonBand(raw: f32, steps: f32, sm: f32) -> f32 {
  let s = max(1.0, floor(steps + 0.5));
  let scaled = clamp(raw, 0.0, 1.0) * s;
  let idx = floor(scaled);
  let frac = scaled - idx;
  let w = clamp(sm, 0.002, 0.45);
  let stepped = (idx + smoothstep(0.5 - w, 0.5 + w, frac)) / s;
  return clamp(stepped, 0.0, 1.0);
}

@fragment
fn fs_main(in: VsOut, @builtin(front_facing) frontFacing: bool) -> @location(0) vec4<f32> {
  var base = vec4<f32>(m3dInput(uMat.color.rgb), uMat.color.a);
#ifdef USE_MAP
  base = base * textureSample(uMap, uMapSampler, in.vUv);
#endif
#ifdef USE_COLOR
  base = vec4<f32>(base.rgb * m3dInput(in.vColor.rgb), base.a * in.vColor.a);
#endif
#ifdef USE_ALPHATEST
  if (base.a < uMat.emissive.w) { discard; }
#endif

  let nl = dot(in.vNormal, in.vNormal);
  var n = select(vec3<f32>(0.0, 1.0, 0.0), in.vNormal * inverseSqrt(nl), nl > 1e-10);
  if (!frontFacing) { n = -n; }

  let vd = uGlobals.cameraPos_time.xyz - in.vWorldPos;
  let vl = dot(vd, vd);
  let viewDir = select(vec3<f32>(0.0, 0.0, 1.0), vd * inverseSqrt(vl), vl > 1e-10);

  let shininess = uMat.extraColor0.w;
  let specular = uMat.extraColor1.w;
  let steps = uMat.params0.x;
  let smoothness = uMat.params0.y;
  let shadowTint = uMat.params0.z;
  let rimPower = uMat.params0.w;
  let rimStrength = uMat.params1.x;
  let inkWidth = uMat.params1.y;

  var directLight = vec3<f32>(0.0);
  var maxBand: f32 = 0.0;
  var specLight = vec3<f32>(0.0);

  let dirCount = i32(uGlobals.ambient_dirCount.w + 0.5);
  let shadowLight = i32(round(uGlobals.fogParams.w));
  let shadowStrength = uGlobals.shadowParams.z;

  for (var i: i32 = 0; i < 4; i = i + 1) {
    if (i >= dirCount) { break; }
    let ldir = -uGlobals.dirDir[i].xyz;
    let ndl = max(dot(n, ldir), 0.0);
    var att: f32 = 1.0;
#ifdef USE_SHADOW
    if (i == shadowLight) {
      att = mix(1.0, m3dShadowAt(in.vWorldPos, ndl), shadowStrength);
    }
#endif
    let band = m3dToonBand(ndl * att, steps, smoothness);
    maxBand = max(maxBand, band);
    directLight = directLight + uGlobals.dirColor[i].xyz * band;
    if (shininess > 0.5 && ndl > 0.0) {
      let hv = ldir + viewDir;
      let hl = dot(hv, hv);
      let h = select(n, hv * inverseSqrt(hl), hl > 1e-8);
      let nh = max(dot(n, h), 0.0);
      let sp = smoothstep(0.45, 0.52, pow(nh, shininess));
      specLight = specLight + uGlobals.dirColor[i].xyz * sp * specular * att;
    }
  }

  let pointCount = i32(uGlobals.fogParams.z + 0.5);
  for (var i: i32 = 0; i < 4; i = i + 1) {
    if (i >= pointCount) { break; }
    let d = uGlobals.pointPos[i].xyz - in.vWorldPos;
    let dist = length(d);
    let ldir = d / max(dist, 1e-4);
    var att = 1.0 / max(pow(max(dist, 1e-4), uGlobals.pointColor[i].w), 0.01);
    let pDist = uGlobals.pointPos[i].w;
    if (pDist > 0.0) {
      let pr = dist / pDist;
      let pr2 = pr * pr;
      att = att * clamp(1.0 - pr2 * pr2, 0.0, 1.0);
    }
    let ndl = max(dot(n, ldir), 0.0);
    let band = m3dToonBand(ndl * clamp(att, 0.0, 1.0), steps, smoothness);
    maxBand = max(maxBand, band);
    directLight = directLight + uGlobals.pointColor[i].xyz * band * clamp(att, 0.0, 1.5);
    if (shininess > 0.5 && ndl > 0.0) {
      let hv = ldir + viewDir;
      let hl = dot(hv, hv);
      let h = select(n, hv * inverseSqrt(hl), hl > 1e-8);
      let nh = max(dot(n, h), 0.0);
      let sp = smoothstep(0.45, 0.52, pow(nh, shininess));
      specLight = specLight + uGlobals.pointColor[i].xyz * sp * specular * clamp(att, 0.0, 1.5);
    }
  }

  let litCol = base.rgb * (uGlobals.ambient_dirCount.xyz + directLight);
  let shadowCol = base.rgb * m3dInput(uMat.extraColor0.rgb);
  let inShadow = 1.0 - smoothstep(0.05, 0.55, maxBand);
  var outc = mix(litCol, mix(litCol, shadowCol, clamp(shadowTint, 0.0, 1.0)), inShadow);
  outc = outc + specLight * 0.65;

  let ndv = clamp(dot(n, viewDir), 0.0, 1.0);
  let fresnel = 1.0 - ndv;
  if (rimStrength > 0.001) {
    let rim = smoothstep(0.45, 0.62, pow(fresnel, max(0.3, rimPower))) * (0.35 + 0.65 * maxBand);
    outc = outc + m3dInput(uMat.extraColor1.rgb) * rim * rimStrength;
  }

  if (inkWidth > 0.001) {
    let edgeT = clamp(1.0 - inkWidth, 0.05, 0.98);
    let inkMask = smoothstep(edgeT - 0.03, edgeT + 0.02, fresnel);
    outc = mix(outc, m3dInput(uMat.emissive.rgb), inkMask);
  }

  outc = m3dApplyFog(outc, in.vWorldPos);
  return vec4<f32>(m3dOutput(outc), base.a);
}
`;

// 2) HOLOGRAM
export const HOLOGRAM_WGSL = `
${GROUP2_SURFACE}

struct VsOut {
  @builtin(position) position: vec4<f32>,
  @location(0) vUv: vec2<f32>,
  @location(1) vNormal: vec3<f32>,
  @location(2) vColor: vec4<f32>,
  @location(3) vWorldPos: vec3<f32>,
  @location(4) vGlitch: f32,
};

fn m3dHash1(p: f32) -> f32 {
  return fract(sin(p * 127.1) * 43758.5453123);
}

@vertex
fn vs_main(vin: VertexInput) -> VsOut {
  let v = m3dResolveVertex(vin);
  var out: VsOut;
#ifdef USE_MAP_UV1
  let rawUv = v.uv1;
#else
  let rawUv = v.uv;
#endif
  out.vUv = m3dUvTransform(uMat.uvMat0, uMat.uvMat1, uMat.uvMat2, rawUv);
  out.vNormal = v.normalMatrix * v.normal;
  out.vColor = v.color;

  var wp = v.modelMatrix * vec4<f32>(v.pos, 1.0);
  let t = uGlobals.cameraPos_time.w;
  let tBucket = floor(t * 14.0);
  let pulse = step(0.82, m3dHash1(tBucket));
  let band = step(0.68, sin(wp.y * 11.0 + t * 22.0));
  let g = pulse * band * uMat.params0.w;
  wp.x = wp.x + (m3dHash1(tBucket + floor(wp.y * 8.0)) - 0.5) * 0.14 * g;
  wp.z = wp.z + (m3dHash1(tBucket * 1.7 + floor(wp.y * 6.0)) - 0.5) * 0.08 * g;

  out.vGlitch = g;
  out.vWorldPos = wp.xyz;
  out.position = uGlobals.projection * uGlobals.view * wp;
  return out;
}

@fragment
fn fs_main(in: VsOut, @builtin(front_facing) frontFacing: bool) -> @location(0) vec4<f32> {
  var base = vec4<f32>(m3dInput(uMat.color.rgb), uMat.color.a);
#ifdef USE_MAP
  base = base * textureSample(uMap, uMapSampler, in.vUv);
#endif
#ifdef USE_COLOR
  base = vec4<f32>(base.rgb * m3dInput(in.vColor.rgb), base.a * in.vColor.a);
#endif
#ifdef USE_ALPHATEST
  if (base.a < uMat.emissive.w) { discard; }
#endif

  let nl = dot(in.vNormal, in.vNormal);
  var n = select(vec3<f32>(0.0, 1.0, 0.0), in.vNormal * inverseSqrt(nl), nl > 1e-10);
  if (!frontFacing) { n = -n; }

  let vd = uGlobals.cameraPos_time.xyz - in.vWorldPos;
  let vl = dot(vd, vd);
  let viewDir = select(vec3<f32>(0.0, 0.0, 1.0), vd * inverseSqrt(vl), vl > 1e-10);

  let ndv = clamp(abs(dot(n, viewDir)), 0.0, 1.0);
  let fresnel = pow(1.0 - ndv, max(0.3, uMat.params0.x));

  let t = uGlobals.cameraPos_time.w;
  var scan = 0.5 + 0.5 * sin(in.vWorldPos.y * uMat.params0.y - t * uMat.params0.z * 6.2831853);
  scan = pow(scan, 2.2);
  let sweep = smoothstep(0.65, 1.0, sin(in.vWorldPos.y * 2.2 - t * 2.1));
  let flicker = 0.92 + 0.08 * sin(t * 37.0 + in.vWorldPos.y * 5.0);

  let stripe = m3dInput(uMat.extraColor0.rgb);
  let holoCol = mix(base.rgb, stripe, clamp(fresnel * 0.75 + sweep * 0.5 + in.vGlitch * 0.6, 0.0, 1.0));
  let energy = (0.28 + 0.72 * fresnel) * (0.45 + 0.55 * scan + 0.45 * sweep) * flicker;
  var outc = holoCol * (0.75 + energy * 1.15);
  let holoAlpha = clamp(0.22 + 0.78 * fresnel + 0.3 * scan + 0.25 * sweep, 0.04, 1.0);
  let alpha = clamp(base.a * holoAlpha, 0.0, 1.0);

  outc = m3dApplyFog(outc, in.vWorldPos);
  return vec4<f32>(m3dOutput(outc), alpha);
}
`;

// 3) MATCAP
export const MATCAP_WGSL = `
@group(2) @binding(0) var<uniform> uMat: MaterialUniforms;
#ifdef USE_MAP
@group(2) @binding(1) var uMap: texture_2d<f32>;
@group(2) @binding(2) var uMapSampler: sampler;
#endif
#ifdef USE_MATCAP
@group(2) @binding(11) var uMatcap: texture_2d<f32>;
@group(2) @binding(12) var uMatcapSampler: sampler;
#endif

struct VsOut {
  @builtin(position) position: vec4<f32>,
  @location(0) vUv: vec2<f32>,
  @location(1) vViewNormal: vec3<f32>,
  @location(2) vColor: vec4<f32>,
  @location(3) vWorldPos: vec3<f32>,
};

@vertex
fn vs_main(vin: VertexInput) -> VsOut {
  let v = m3dResolveVertex(vin);
  var out: VsOut;
#ifdef USE_MAP_UV1
  let rawUv = v.uv1;
#else
  let rawUv = v.uv;
#endif
  out.vUv = m3dUvTransform(uMat.uvMat0, uMat.uvMat1, uMat.uvMat2, rawUv);
  let worldNormal = v.normalMatrix * v.normal;
  let vm = uGlobals.view;
  out.vViewNormal = mat3x3<f32>(vm[0].xyz, vm[1].xyz, vm[2].xyz) * worldNormal;
  out.vColor = v.color;
  let wp = v.modelMatrix * vec4<f32>(v.pos, 1.0);
  out.vWorldPos = wp.xyz;
  out.position = uGlobals.projection * uGlobals.view * wp;
  return out;
}

@fragment
fn fs_main(in: VsOut, @builtin(front_facing) frontFacing: bool) -> @location(0) vec4<f32> {
  var base = vec4<f32>(m3dInput(uMat.color.rgb), uMat.color.a);
#ifdef USE_MAP
  base = base * textureSample(uMap, uMapSampler, in.vUv);
#endif
#ifdef USE_COLOR
  base = vec4<f32>(base.rgb * m3dInput(in.vColor.rgb), base.a * in.vColor.a);
#endif
#ifdef USE_ALPHATEST
  if (base.a < uMat.emissive.w) { discard; }
#endif

  let vl = dot(in.vViewNormal, in.vViewNormal);
  var vn = select(vec3<f32>(0.0, 0.0, 1.0), in.vViewNormal * inverseSqrt(vl), vl > 1e-10);
  if (!frontFacing) { vn = -vn; }

#ifdef USE_MATCAP
  let muv = clamp(vn.xy * 0.49 + 0.5, vec2<f32>(0.01), vec2<f32>(0.99));
  let mc = textureSample(uMatcap, uMatcapSampler, muv).rgb;
#else
  let keyDir = normalize(vec3<f32>(0.42, 0.68, 0.60));
  let fillDir = normalize(vec3<f32>(-0.65, -0.35, 0.45));
  let key = clamp(dot(vn, keyDir), 0.0, 1.0);
  let fill = clamp(dot(vn, fillDir), 0.0, 1.0);
  let hemi = vn.y * 0.5 + 0.5;
  let fresnel = pow(1.0 - clamp(abs(vn.z), 0.0, 1.0), 2.4);

  var studio = mix(vec3<f32>(0.16, 0.17, 0.24), vec3<f32>(0.95, 0.93, 0.90), 0.28 + 0.72 * pow(key, 0.85));
  studio = studio + vec3<f32>(0.20, 0.26, 0.38) * fill * 0.55;
  studio = studio * mix(0.75, 1.08, hemi);

  let h = normalize(keyDir + vec3<f32>(0.0, 0.0, 1.0));
  let gloss = clamp(uMat.params1.x, 0.0, 1.0);
  let specPow = mix(10.0, 140.0, gloss);
  let spec = pow(max(dot(vn, h), 0.0), specPow) * mix(0.25, 1.25, gloss);

  let metalCurve = smoothstep(-0.3, 0.85, vn.y + sin(vn.x * 3.1) * 0.15);
  let metalLook = mix(vec3<f32>(0.12, 0.14, 0.18), vec3<f32>(1.05, 1.04, 1.02), metalCurve);

  var mc = mix(studio, metalLook, clamp(uMat.params1.y, 0.0, 1.0));
  mc = mc + vec3<f32>(1.0, 0.98, 0.94) * spec;
  mc = mc + m3dInput(uMat.extraColor1.rgb) * fresnel * 0.45;
#endif

  let outc = m3dApplyFog(base.rgb * mc, in.vWorldPos);
  return vec4<f32>(m3dOutput(outc), base.a);
}
`;

// 4) FRESNEL / IRIDESCENCE
export const FRESNEL_WGSL = `
${GROUP2_SURFACE}

struct VsOut {
  @builtin(position) position: vec4<f32>,
  @location(0) vUv: vec2<f32>,
  @location(1) vNormal: vec3<f32>,
  @location(2) vColor: vec4<f32>,
  @location(3) vWorldPos: vec3<f32>,
};

@vertex
fn vs_main(vin: VertexInput) -> VsOut {
  let v = m3dResolveVertex(vin);
  var out: VsOut;
#ifdef USE_MAP_UV1
  let rawUv = v.uv1;
#else
  let rawUv = v.uv;
#endif
  out.vUv = m3dUvTransform(uMat.uvMat0, uMat.uvMat1, uMat.uvMat2, rawUv);
  out.vNormal = v.normalMatrix * v.normal;
  out.vColor = v.color;
  let wp = v.modelMatrix * vec4<f32>(v.pos, 1.0);
  out.vWorldPos = wp.xyz;
  out.position = uGlobals.projection * uGlobals.view * wp;
  return out;
}

fn m3dRainbow(t: f32) -> vec3<f32> {
  return 0.5 + 0.5 * cos(6.2831853 * (t + vec3<f32>(0.0, 0.33, 0.67)));
}

@fragment
fn fs_main(in: VsOut, @builtin(front_facing) frontFacing: bool) -> @location(0) vec4<f32> {
  var base = vec4<f32>(m3dInput(uMat.color.rgb), uMat.color.a);
#ifdef USE_MAP
  base = base * textureSample(uMap, uMapSampler, in.vUv);
#endif
#ifdef USE_COLOR
  base = vec4<f32>(base.rgb * m3dInput(in.vColor.rgb), base.a * in.vColor.a);
#endif
#ifdef USE_ALPHATEST
  if (base.a < uMat.emissive.w) { discard; }
#endif

  let nl = dot(in.vNormal, in.vNormal);
  var n = select(vec3<f32>(0.0, 1.0, 0.0), in.vNormal * inverseSqrt(nl), nl > 1e-10);
  if (!frontFacing) { n = -n; }

  let vd = uGlobals.cameraPos_time.xyz - in.vWorldPos;
  let vl = dot(vd, vd);
  let viewDir = select(vec3<f32>(0.0, 0.0, 1.0), vd * inverseSqrt(vl), vl > 1e-10);

  let ndv = clamp(dot(n, viewDir), 0.0, 1.0);
  let fresnel = pow(1.0 - ndv, max(0.25, uMat.params0.x));
  let t = uGlobals.cameraPos_time.w;
  let pulse = 0.86 + 0.14 * sin(t * uMat.params0.w * 3.0 + in.vWorldPos.y * 3.5);

  let rimBase = m3dInput(uMat.extraColor1.rgb);
  let irid = m3dRainbow(fresnel * 1.1 + t * 0.12 + dot(n, vec3<f32>(0.3, 0.6, 0.2)) * 0.35);
  let rimCol = mix(rimBase, irid, clamp(uMat.params0.z, 0.0, 1.0));

  let coreShade = 0.35 + 0.65 * ndv;
  var outc = base.rgb * coreShade + rimCol * fresnel * uMat.params0.y * pulse;
  let alpha = select(base.a, clamp(base.a * mix(0.28, 1.35, fresnel), 0.0, 1.0), base.a < 0.999);

  outc = m3dApplyFog(outc, in.vWorldPos);
  return vec4<f32>(m3dOutput(outc), alpha);
}
`;

// 5) DISSOLVE
export const DISSOLVE_WGSL = `
${GROUP2_SURFACE}

struct VsOut {
  @builtin(position) position: vec4<f32>,
  @location(0) vUv: vec2<f32>,
  @location(1) vNormal: vec3<f32>,
  @location(2) vColor: vec4<f32>,
  @location(3) vWorldPos: vec3<f32>,
  @location(4) vLocalPos: vec3<f32>,
};

@vertex
fn vs_main(vin: VertexInput) -> VsOut {
  let v = m3dResolveVertex(vin);
  var out: VsOut;
#ifdef USE_MAP_UV1
  let rawUv = v.uv1;
#else
  let rawUv = v.uv;
#endif
  out.vUv = m3dUvTransform(uMat.uvMat0, uMat.uvMat1, uMat.uvMat2, rawUv);
  out.vNormal = v.normalMatrix * v.normal;
  out.vColor = v.color;
  out.vLocalPos = v.pos;
  let wp = v.modelMatrix * vec4<f32>(v.pos, 1.0);
  out.vWorldPos = wp.xyz;
  out.position = uGlobals.projection * uGlobals.view * wp;
  return out;
}

fn m3dHash3(pin: vec3<f32>) -> f32 {
  var p = fract(pin * 0.3183099 + 0.1);
  p = p * 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

fn m3dNoise3(x: vec3<f32>) -> f32 {
  let i = floor(x);
  var f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(
      mix(m3dHash3(i + vec3<f32>(0.0, 0.0, 0.0)), m3dHash3(i + vec3<f32>(1.0, 0.0, 0.0)), f.x),
      mix(m3dHash3(i + vec3<f32>(0.0, 1.0, 0.0)), m3dHash3(i + vec3<f32>(1.0, 1.0, 0.0)), f.x),
      f.y
    ),
    mix(
      mix(m3dHash3(i + vec3<f32>(0.0, 0.0, 1.0)), m3dHash3(i + vec3<f32>(1.0, 0.0, 1.0)), f.x),
      mix(m3dHash3(i + vec3<f32>(0.0, 1.0, 1.0)), m3dHash3(i + vec3<f32>(1.0, 1.0, 1.0)), f.x),
      f.y
    ),
    f.z
  );
}

@fragment
fn fs_main(in: VsOut, @builtin(front_facing) frontFacing: bool) -> @location(0) vec4<f32> {
  var base = vec4<f32>(m3dInput(uMat.color.rgb), uMat.color.a);
#ifdef USE_MAP
  base = base * textureSample(uMap, uMapSampler, in.vUv);
#endif
#ifdef USE_COLOR
  base = vec4<f32>(base.rgb * m3dInput(in.vColor.rgb), base.a * in.vColor.a);
#endif

  let p = in.vLocalPos * max(0.1, uMat.params1.x);
  let nVal = 0.68 * m3dNoise3(p) + 0.32 * m3dNoise3(p * 2.13 + vec3<f32>(4.2, 1.7, 8.9));
  let t = uGlobals.cameraPos_time.w;
  let thresh = select(
    clamp(uMat.params0.x, 0.0, 1.0) * 1.04,
    (0.5 - 0.5 * cos(t * uMat.params0.z * 2.2)) * 1.04,
    uMat.params0.y > 0.5
  );
  if (nVal < thresh) { discard; }
#ifdef USE_ALPHATEST
  if (base.a < uMat.emissive.w) { discard; }
#endif

  let nl = dot(in.vNormal, in.vNormal);
  var n = select(vec3<f32>(0.0, 1.0, 0.0), in.vNormal * inverseSqrt(nl), nl > 1e-10);
  if (!frontFacing) { n = -n; }

  let vd = uGlobals.cameraPos_time.xyz - in.vWorldPos;
  let vl = dot(vd, vd);
  let viewDir = select(vec3<f32>(0.0, 0.0, 1.0), vd * inverseSqrt(vl), vl > 1e-10);

  var diffLight = uGlobals.ambient_dirCount.xyz;
  var specLight = vec3<f32>(0.0);

  let shininess = uMat.extraColor0.w;
  let specular = uMat.extraColor1.w;
  let dirCount = i32(uGlobals.ambient_dirCount.w + 0.5);
  let shadowLight = i32(round(uGlobals.fogParams.w));
  let shadowStrength = uGlobals.shadowParams.z;

  for (var i: i32 = 0; i < 4; i = i + 1) {
    if (i >= dirCount) { break; }
    let ldir = -uGlobals.dirDir[i].xyz;
    let ndl = max(dot(n, ldir), 0.0);
    var att: f32 = 1.0;
#ifdef USE_SHADOW
    if (i == shadowLight) {
      att = mix(1.0, m3dShadowAt(in.vWorldPos, ndl), shadowStrength);
    }
#endif
    diffLight = diffLight + uGlobals.dirColor[i].xyz * ndl * att;
    if (shininess > 0.5 && ndl > 0.0) {
      let hv = ldir + viewDir;
      let hl = dot(hv, hv);
      let h = select(n, hv * inverseSqrt(hl), hl > 1e-8);
      specLight = specLight + uGlobals.dirColor[i].xyz * pow(max(dot(n, h), 0.0), shininess) * specular * att;
    }
  }

  let pointCount = i32(uGlobals.fogParams.z + 0.5);
  for (var i: i32 = 0; i < 4; i = i + 1) {
    if (i >= pointCount) { break; }
    let d = uGlobals.pointPos[i].xyz - in.vWorldPos;
    let dist = length(d);
    let ldir = d / max(dist, 1e-4);
    var att = 1.0 / max(pow(max(dist, 1e-4), uGlobals.pointColor[i].w), 0.01);
    let pDist = uGlobals.pointPos[i].w;
    if (pDist > 0.0) {
      let pr = dist / pDist;
      let pr2 = pr * pr;
      att = att * clamp(1.0 - pr2 * pr2, 0.0, 1.0);
    }
    let ndl = max(dot(n, ldir), 0.0);
    diffLight = diffLight + uGlobals.pointColor[i].xyz * ndl * att;
    if (shininess > 0.5 && ndl > 0.0) {
      let hv = ldir + viewDir;
      let hl = dot(hv, hv);
      let h = select(n, hv * inverseSqrt(hl), hl > 1e-8);
      specLight = specLight + uGlobals.pointColor[i].xyz * pow(max(dot(n, h), 0.0), shininess) * specular * att;
    }
  }

  var outc = base.rgb * diffLight + specLight;
  let edgeBand = 1.0 - smoothstep(thresh, thresh + max(0.005, uMat.params0.w), nVal);
  if (thresh > 0.001) {
    outc = mix(outc, m3dInput(uMat.extraColor0.rgb) * 2.4, edgeBand);
  }

  outc = m3dApplyFog(outc, in.vWorldPos);
  return vec4<f32>(m3dOutput(outc), base.a);
}
`;
