// Shaders integrados WGSL para WebGPU (Basic, Standard PBR/Blinn-Phong, Shadow Depth).

const GROUP2_SURFACE_BINDINGS = `
@group(2) @binding(0) var<uniform> uMat: MaterialUniforms;
#ifdef USE_MAP
@group(2) @binding(1) var uMap: texture_2d<f32>;
@group(2) @binding(2) var uMapSampler: sampler;
#endif
`;

export const BASIC_WGSL = `
${GROUP2_SURFACE_BINDINGS}

struct VsOut {
  @builtin(position) position: vec4<f32>,
  @location(0) vUv: vec2<f32>,
  @location(1) vColor: vec4<f32>,
  @location(2) vWorldPos: vec3<f32>,
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
  out.vColor = v.color;
  let wp = v.modelMatrix * vec4<f32>(v.pos, 1.0);
  out.vWorldPos = wp.xyz;
  out.position = uGlobals.projection * uGlobals.view * wp;
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  var c = vec4<f32>(m3dInput(uMat.color.rgb), uMat.color.a);
#ifdef USE_MAP
  c = c * textureSample(uMap, uMapSampler, in.vUv);
#endif
#ifdef USE_COLOR
  c = vec4<f32>(c.rgb * m3dInput(in.vColor.rgb), c.a * in.vColor.a);
#endif
#ifdef USE_ALPHATEST
  if (c.a < uMat.emissive.w) { discard; }
#endif
  let outc = m3dApplyFog(c.rgb, in.vWorldPos);
  return vec4<f32>(m3dOutput(outc), c.a);
}
`;

export const STANDARD_WGSL = `
@group(2) @binding(0) var<uniform> uMat: MaterialUniforms;
#ifdef USE_MAP
@group(2) @binding(1) var uMap: texture_2d<f32>;
@group(2) @binding(2) var uMapSampler: sampler;
#endif
#ifdef USE_NORMALMAP
@group(2) @binding(3) var uNormalMap: texture_2d<f32>;
@group(2) @binding(4) var uNormalSampler: sampler;
#endif
#ifdef USE_EMISSIVEMAP
@group(2) @binding(5) var uEmissiveMap: texture_2d<f32>;
@group(2) @binding(6) var uEmissiveSampler: sampler;
#endif
#ifdef USE_AOMAP
@group(2) @binding(7) var uAoMap: texture_2d<f32>;
@group(2) @binding(8) var uAoSampler: sampler;
#endif
#ifdef USE_MRMAP
@group(2) @binding(9) var uMetallicRoughnessMap: texture_2d<f32>;
@group(2) @binding(10) var uMrSampler: sampler;
#endif
#ifdef USE_ROUGHNESSMAP
@group(2) @binding(13) var uRoughnessMap: texture_2d<f32>;
@group(2) @binding(14) var uRoughnessSampler: sampler;
#endif
#ifdef USE_METALNESSMAP
@group(2) @binding(15) var uMetalnessMap: texture_2d<f32>;
@group(2) @binding(16) var uMetalnessSampler: sampler;
#endif

struct VsOut {
  @builtin(position) position: vec4<f32>,
  @location(0) vUv: vec2<f32>,
  @location(1) vUv0: vec2<f32>,
  @location(2) vUv1: vec2<f32>,
  @location(3) vNormal: vec3<f32>,
  @location(4) vColor: vec4<f32>,
  @location(5) vWorldPos: vec3<f32>,
};

@vertex
fn vs_main(vin: VertexInput) -> VsOut {
  let v = m3dResolveVertex(vin);
  var out: VsOut;
  out.vUv0 = v.uv;
  out.vUv1 = v.uv1;
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

@fragment
fn fs_main(in: VsOut, @builtin(front_facing) frontFacing: bool) -> @location(0) vec4<f32> {
#ifdef USE_NORMALMAP
  let dp1 = dpdx(in.vWorldPos);
  let dp2 = -dpdy(in.vWorldPos);
#ifdef USE_NORMALMAP_UV1
  let nUv = m3dUvTransform(uMat.normalUvMat0, uMat.normalUvMat1, uMat.normalUvMat2, in.vUv1);
#else
  let nUv = m3dUvTransform(uMat.normalUvMat0, uMat.normalUvMat1, uMat.normalUvMat2, in.vUv0);
#endif
  let duv1 = dpdx(nUv);
  let duv2 = -dpdy(nUv);
  var mapN = textureSample(uNormalMap, uNormalSampler, nUv).xyz * 2.0 - 1.0;
#endif

  var base = vec4<f32>(m3dInput(uMat.color.rgb), uMat.color.a);
#ifdef USE_MAP
  base = base * textureSample(uMap, uMapSampler, in.vUv);
#endif
#ifdef USE_COLOR
  base = vec4<f32>(base.rgb * m3dInput(in.vColor.rgb), base.a * in.vColor.a);
#endif

#if defined(USE_PBR) && defined(USE_MRMAP)
#ifdef USE_MRMAP_UV1
  let mrUv = m3dUvTransform(uMat.mrUvMat0, uMat.mrUvMat1, uMat.mrUvMat2, in.vUv1);
#else
  let mrUv = m3dUvTransform(uMat.mrUvMat0, uMat.mrUvMat1, uMat.mrUvMat2, in.vUv0);
#endif
  let mrSample = textureSample(uMetallicRoughnessMap, uMrSampler, mrUv);
#endif

#if defined(USE_PBR) && defined(USE_ROUGHNESSMAP)
#ifdef USE_ROUGHNESSMAP_UV1
  let rmUv = m3dUvTransform(uMat.roughnessUvMat0, uMat.roughnessUvMat1, uMat.roughnessUvMat2, in.vUv1);
#else
  let rmUv = m3dUvTransform(uMat.roughnessUvMat0, uMat.roughnessUvMat1, uMat.roughnessUvMat2, in.vUv0);
#endif
  let rmSample = textureSample(uRoughnessMap, uRoughnessSampler, rmUv).g;
#endif

#if defined(USE_PBR) && defined(USE_METALNESSMAP)
#ifdef USE_METALNESSMAP_UV1
  let mmUv = m3dUvTransform(uMat.metalnessUvMat0, uMat.metalnessUvMat1, uMat.metalnessUvMat2, in.vUv1);
#else
  let mmUv = m3dUvTransform(uMat.metalnessUvMat0, uMat.metalnessUvMat1, uMat.metalnessUvMat2, in.vUv0);
#endif
  let mmSample = textureSample(uMetalnessMap, uMetalnessSampler, mmUv).b;
#endif

#ifdef USE_AOMAP
#ifdef USE_AOMAP_UV1
  let aoUv = m3dUvTransform(uMat.aoUvMat0, uMat.aoUvMat1, uMat.aoUvMat2, in.vUv1);
#else
  let aoUv = m3dUvTransform(uMat.aoUvMat0, uMat.aoUvMat1, uMat.aoUvMat2, in.vUv0);
#endif
  let aoSample = textureSample(uAoMap, uAoSampler, aoUv).r;
#endif

#ifdef USE_EMISSIVEMAP
#ifdef USE_EMISSIVEMAP_UV1
  let emUv = m3dUvTransform(uMat.emissiveUvMat0, uMat.emissiveUvMat1, uMat.emissiveUvMat2, in.vUv1);
#else
  let emUv = m3dUvTransform(uMat.emissiveUvMat0, uMat.emissiveUvMat1, uMat.emissiveUvMat2, in.vUv0);
#endif
  let emSample = textureSample(uEmissiveMap, uEmissiveSampler, emUv).rgb;
#endif

#ifdef USE_ALPHATEST
  if (base.a < uMat.emissive.w) { discard; }
#endif

  let nl = dot(in.vNormal, in.vNormal);
  var n = select(vec3<f32>(0.0, 1.0, 0.0), in.vNormal * inverseSqrt(nl), nl > 1e-10);
  if (!frontFacing) { n = -n; }

#ifdef USE_NORMALMAP
  mapN = vec3<f32>(mapN.xy * uMat.pbr.zw, mapN.z);
  let dp2perp = cross(dp2, n);
  let dp1perp = cross(n, dp1);
  let T = dp2perp * duv1.x + dp1perp * duv2.x;
  let B = dp2perp * duv1.y + dp1perp * duv2.y;
  let maxTB = max(dot(T, T), dot(B, B));
  if (maxTB > 1e-12) {
    let invmax = inverseSqrt(maxTB);
    let TBN = mat3x3<f32>(T * invmax, B * invmax, n);
    n = normalize(TBN * mapN);
  }
#endif

  let vd = uGlobals.cameraPos_time.xyz - in.vWorldPos;
  let vl = dot(vd, vd);
  let viewDir = select(vec3<f32>(0.0, 0.0, 1.0), vd * inverseSqrt(vl), vl > 1e-10);

  var ao: f32 = 1.0;
#ifdef USE_AOMAP
  ao = mix(1.0, aoSample, uMat.params0.x);
#endif

  var emissiveTerm = m3dInput(uMat.emissive.rgb);
#ifdef USE_EMISSIVEMAP
  emissiveTerm = emissiveTerm * emSample;
#endif

  let ambient = uGlobals.ambient_dirCount.xyz;
  let dirCount = i32(uGlobals.ambient_dirCount.w + 0.5);
  let pointCount = i32(uGlobals.fogParams.z + 0.5);
  let spotCount = i32(uGlobals.spotMeta.x + 0.5);
  let shadowLight = i32(round(uGlobals.fogParams.w));
  let shadowStrength = uGlobals.shadowParams.z;
  let envInt = uGlobals.envParams.x;
  let envHas = uGlobals.envParams.y;
  let envMaxMip = uGlobals.envParams.z;
  let matEnvInt = uMat.params0.y;
  let PI: f32 = 3.14159265359;

  var outc = vec3<f32>(0.0);

#ifdef USE_NEUTRAL
  outc = base.rgb;
#else
#ifdef USE_PBR
  var rough: f32 = uMat.pbr.x;
  var metal: f32 = uMat.pbr.y;
#ifdef USE_MRMAP
  rough = rough * mrSample.g;
  metal = metal * mrSample.b;
#endif
#ifdef USE_ROUGHNESSMAP
  rough = rough * rmSample;
#endif
#ifdef USE_METALNESSMAP
  metal = metal * mmSample;
#endif
  rough = clamp(rough, 0.04, 1.0);
  metal = clamp(metal, 0.0, 1.0);

  let F0 = mix(vec3<f32>(0.04), base.rgb, metal);
  let ndv = max(dot(n, viewDir), 1e-4);
  let a = rough * rough;
  let a2 = a * a;
  let kDirect = (rough + 1.0) * (rough + 1.0) * 0.125;
  let g1V = ndv / (ndv * (1.0 - kDirect) + kDirect);

  var directLo = vec3<f32>(0.0);
  for (var i: i32 = 0; i < 4; i = i + 1) {
    if (i >= dirCount) { break; }
    let ldir = -uGlobals.dirDir[i].xyz;
    let ndl = max(dot(n, ldir), 0.0);
    if (ndl <= 0.0) { continue; }
    var att: f32 = 1.0;
#ifdef USE_SHADOW
    if (i == shadowLight) {
      att = mix(1.0, m3dShadowAt(in.vWorldPos, ndl), shadowStrength);
    }
#endif
    let hv = ldir + viewDir;
    let hl = dot(hv, hv);
    let h = select(n, hv * inverseSqrt(hl), hl > 1e-8);
    let ndh = max(dot(n, h), 0.0);
    let vdh = max(dot(viewDir, h), 0.0);
    let denom = ndh * ndh * (a2 - 1.0) + 1.0;
    let D = a2 / max(PI * denom * denom, 1e-6);
    let g1L = ndl / (ndl * (1.0 - kDirect) + kDirect);
    let G = g1V * g1L;
    let F = F0 + (1.0 - F0) * pow(clamp(1.0 - vdh, 0.0, 1.0), 5.0);
    let spec = (D * G * F) / max(4.0 * ndv * ndl, 1e-4);
    let kD = (vec3<f32>(1.0) - F) * (1.0 - metal);
    let radiance = uGlobals.dirColor[i].xyz * PI * att;
    directLo = directLo + (kD * base.rgb / PI + spec) * radiance * ndl;
  }

  for (var i: i32 = 0; i < 4; i = i + 1) {
    if (i >= pointCount) { break; }
    let d = uGlobals.pointPos[i].xyz - in.vWorldPos;
    let dist = length(d);
    let ldir = d / max(dist, 1e-4);
    let ndl = max(dot(n, ldir), 0.0);
    if (ndl <= 0.0) { continue; }
    var att = 1.0 / max(pow(max(dist, 1e-4), uGlobals.pointColor[i].w), 0.01);
    let pDist = uGlobals.pointPos[i].w;
    if (pDist > 0.0) {
      let pr = dist / pDist;
      let pr2 = pr * pr;
      att = att * clamp(1.0 - pr2 * pr2, 0.0, 1.0);
    }
    let hv = ldir + viewDir;
    let hl = dot(hv, hv);
    let h = select(n, hv * inverseSqrt(hl), hl > 1e-8);
    let ndh = max(dot(n, h), 0.0);
    let vdh = max(dot(viewDir, h), 0.0);
    let denom = ndh * ndh * (a2 - 1.0) + 1.0;
    let D = a2 / max(PI * denom * denom, 1e-6);
    let g1L = ndl / (ndl * (1.0 - kDirect) + kDirect);
    let G = g1V * g1L;
    let F = F0 + (1.0 - F0) * pow(clamp(1.0 - vdh, 0.0, 1.0), 5.0);
    let spec = (D * G * F) / max(4.0 * ndv * ndl, 1e-4);
    let kD = (vec3<f32>(1.0) - F) * (1.0 - metal);
    let radiance = uGlobals.pointColor[i].xyz * PI * att;
    directLo = directLo + (kD * base.rgb / PI + spec) * radiance * ndl;
  }

  for (var i: i32 = 0; i < 4; i = i + 1) {
    if (i >= spotCount) { break; }
    let d = uGlobals.spotPos[i].xyz - in.vWorldPos;
    let dist = length(d);
    let ldir = d / max(dist, 1e-4);
    let ndl = max(dot(n, ldir), 0.0);
    if (ndl <= 0.0) { continue; }
    let theta = dot(-ldir, normalize(uGlobals.spotDir[i].xyz));
    let spotFactor = smoothstep(uGlobals.spotColor[i].w, uGlobals.spotCone[i].x, theta);
    if (spotFactor <= 0.0) { continue; }
    var att = 1.0 / max(pow(max(dist, 1e-4), uGlobals.spotDir[i].w), 0.01);
    let sDist = uGlobals.spotPos[i].w;
    if (sDist > 0.0) {
      let pr = dist / sDist;
      let pr2 = pr * pr;
      att = att * clamp(1.0 - pr2 * pr2, 0.0, 1.0);
    }
    att = att * spotFactor;
    let hv = ldir + viewDir;
    let hl = dot(hv, hv);
    let h = select(n, hv * inverseSqrt(hl), hl > 1e-8);
    let ndh = max(dot(n, h), 0.0);
    let vdh = max(dot(viewDir, h), 0.0);
    let denom = ndh * ndh * (a2 - 1.0) + 1.0;
    let D = a2 / max(PI * denom * denom, 1e-6);
    let g1L = ndl / (ndl * (1.0 - kDirect) + kDirect);
    let G = g1V * g1L;
    let F = F0 + (1.0 - F0) * pow(clamp(1.0 - vdh, 0.0, 1.0), 5.0);
    let spec = (D * G * F) / max(4.0 * ndv * ndl, 1e-4);
    let kD = (vec3<f32>(1.0) - F) * (1.0 - metal);
    let radiance = uGlobals.spotColor[i].xyz * PI * att;
    directLo = directLo + (kD * base.rgb / PI + spec) * radiance * ndl;
  }

  let ambientTerm = base.rgb * (1.0 - metal * 0.65) * ambient * ao;
  let reflDir = reflect(-viewDir, n);
  let prefEnv = m3dSampleEnv(reflDir, rough * max(envMaxMip, 0.0));
  let irrEnv = m3dEvalSH(n);
  var iblTerm = vec3<f32>(0.0);
  if (envHas > 0.5 && envInt > 0.0 && matEnvInt > 0.0) {
    let F_ibl = F0 + (max(vec3<f32>(1.0 - rough), F0) - F0) * pow(clamp(1.0 - ndv, 0.0, 1.0), 5.0);
    let kD_ibl = (vec3<f32>(1.0) - F_ibl) * (1.0 - metal);
    let brdf = m3dEnvBRDFApprox(rough, ndv);
    let specOcc = clamp(ao + (1.0 - rough) * 0.25, 0.0, 1.0);
    let diffIBL = kD_ibl * base.rgb * irrEnv * ao;
    let specIBL = prefEnv * max(F_ibl * brdf.x + brdf.y, vec3<f32>(0.0)) * specOcc;
    iblTerm = (diffIBL + specIBL) * envInt * matEnvInt;
  }
  outc = directLo + ambientTerm + iblTerm + emissiveTerm;
#else
  let shininessPx: f32 = uMat.extraColor0.w;
  let specStr: f32 = uMat.extraColor1.w;
  var diffLight = ambient * ao;
  var specLight = vec3<f32>(0.0);

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
#ifdef USE_SPECULAR
    if (ndl > 0.0) {
      let hv = ldir + viewDir;
      let hl = dot(hv, hv);
      let h = select(n, hv * inverseSqrt(hl), hl > 1e-8);
      let nh = max(dot(n, h), 0.0);
      if (nh > 0.0) {
        specLight = specLight + uGlobals.dirColor[i].xyz * pow(nh, shininessPx) * specStr * att;
      }
    }
#endif
  }

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
#ifdef USE_SPECULAR
    if (ndl > 0.0) {
      let hv = ldir + viewDir;
      let hl = dot(hv, hv);
      let h = select(n, hv * inverseSqrt(hl), hl > 1e-8);
      let nh = max(dot(n, h), 0.0);
      if (nh > 0.0) {
        specLight = specLight + uGlobals.pointColor[i].xyz * pow(nh, shininessPx) * specStr * att;
      }
    }
#endif
  }

  for (var i: i32 = 0; i < 4; i = i + 1) {
    if (i >= spotCount) { break; }
    let d = uGlobals.spotPos[i].xyz - in.vWorldPos;
    let dist = length(d);
    let ldir = d / max(dist, 1e-4);
    let theta = dot(-ldir, normalize(uGlobals.spotDir[i].xyz));
    let spotFactor = smoothstep(uGlobals.spotColor[i].w, uGlobals.spotCone[i].x, theta);
    if (spotFactor <= 0.0) { continue; }
    var att = 1.0 / max(pow(max(dist, 1e-4), uGlobals.spotDir[i].w), 0.01);
    let sDist = uGlobals.spotPos[i].w;
    if (sDist > 0.0) {
      let pr = dist / sDist;
      let pr2 = pr * pr;
      att = att * clamp(1.0 - pr2 * pr2, 0.0, 1.0);
    }
    att = att * spotFactor;
    let ndl = max(dot(n, ldir), 0.0);
    diffLight = diffLight + uGlobals.spotColor[i].xyz * ndl * att;
#ifdef USE_SPECULAR
    if (ndl > 0.0) {
      let hv = ldir + viewDir;
      let hl = dot(hv, hv);
      let h = select(n, hv * inverseSqrt(hl), hl > 1e-8);
      let nh = max(dot(n, h), 0.0);
      if (nh > 0.0) {
        specLight = specLight + uGlobals.spotColor[i].xyz * pow(nh, shininessPx) * specStr * att;
      }
    }
#endif
  }

  let reflC = reflect(-viewDir, n);
  let prefC = m3dSampleEnv(reflC, max(envMaxMip * 0.35, 0.0));
  let irrC = m3dEvalSH(n);
  var envFill = vec3<f32>(0.0);
  if (envHas > 0.5 && envInt > 0.0 && matEnvInt > 0.0) {
    let ndvC = max(dot(n, viewDir), 0.0);
    let fresC = pow(1.0 - ndvC, 4.0) * 0.25 + 0.04;
    envFill = (base.rgb * irrC * 0.35 + prefC * fresC * specStr) * ao * envInt * matEnvInt;
  }

  outc = base.rgb * diffLight + specLight + envFill + emissiveTerm;
#endif
#endif

  outc = m3dApplyFog(outc, in.vWorldPos);
  return vec4<f32>(m3dOutput(outc), base.a);
}
`;

export const SHADOW_WGSL = `
@vertex
fn vs_main(vin: VertexInput) -> @builtin(position) vec4<f32> {
  let v = m3dResolveVertex(vin);
  return uGlobals.shadowMatrix * v.modelMatrix * vec4<f32>(v.pos, 1.0);
}
`;
