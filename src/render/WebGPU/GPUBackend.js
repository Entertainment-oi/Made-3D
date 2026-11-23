import {
  createGPUContext,
  GPUPipelineCache,
  GLOBAL_UNIFORM_BYTES,
} from './GPUDevice.js';
import { GPUResources } from './GPUResources.js';
import { GPUOutline } from './GPUOutline.js';
import { BASIC_WGSL, STANDARD_WGSL, SHADOW_WGSL } from '../../shaders/WGSL/builtin.js';
import {
  TOON_WGSL,
  HOLOGRAM_WGSL,
  MATCAP_WGSL,
  FRESNEL_WGSL,
  DISSOLVE_WGSL,
} from '../../shaders/WGSL/stylized.js';
import { SCULPT_BRUSH_COMPUTE_WGSL } from '../../shaders/WGSL/compute.js';

const s2l = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));

const BUILTIN_WGSL = {
  basic: BASIC_WGSL,
  standard: STANDARD_WGSL,
  toon: TOON_WGSL,
  hologram: HOLOGRAM_WGSL,
  matcap: MATCAP_WGSL,
  fresnel: FRESNEL_WGSL,
  dissolve: DISSOLVE_WGSL,
};

export class GPUBackend {
  constructor(renderer, gpuCtx) {
    this.type = 'webgpu';
    this.renderer = renderer;
    this.adapter = gpuCtx.adapter;
    this.device = gpuCtx.device;
    this.context = gpuCtx.context;
    this.presentationFormat = gpuCtx.presentationFormat;
    this.alphaMode = gpuCtx.alphaMode;
    this._lost = false;

    this.pipes = new GPUPipelineCache(this.device, this.presentationFormat);
    this.res = new GPUResources(this);
    this.outline = new GPUOutline();

    this.globalUniformBuf = this.device.createBuffer({
      size: GLOBAL_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this._globalCpu = new Float32Array(GLOBAL_UNIFORM_BYTES >> 2);
    this._nm = new Float32Array(9);
    this._scratch = new Float32Array(16 * 256);
    this._projRemap = new Float32Array(16);
    this._shadowRemap = new Float32Array(16);

    // Dummy shadow texture for Group 0 when shadows are inactive
    this._dummyShadowTex = this.device.createTexture({
      size: [1, 1, 1],
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this._dummyShadowView = this._dummyShadowTex.createView();
    this._dummyShadowSamp = this.device.createSampler({ compare: 'less-equal' });

    // Dummy black 1x1 environment texture for Group 0 when scene.environment is null
    this._dummyEnvTex = this.device.createTexture({
      size: [1, 1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.device.queue.writeTexture(
      { texture: this._dummyEnvTex },
      new Uint8Array([0, 0, 0, 255]),
      { bytesPerRow: 4 },
      [1, 1, 1]
    );
    this._dummyEnvView = this._dummyEnvTex.createView();
    this._dummyEnvSamp = this.device.createSampler({
      addressModeU: 'repeat',
      addressModeV: 'clamp-to-edge',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
    });

    this._group0Cache = new Map();
    this.group0BindGroup = this._createGroup0(
      this._dummyShadowView,
      this._dummyShadowSamp,
      this._dummyEnvView,
      this._dummyEnvSamp
    );

    this._pendingDraws = [];
    this._shadowDraws = [];
    this._activeShadow = null;
    this._skipShadowPass = false;
    this._clearRGB = [0.05, 0.05, 0.07];
    this._activeRt = null;
    this.currentSwapView = null;
    this.supportsOffscreenCapture = typeof document !== 'undefined';
    this._recCanvas = null;
    this._recContext = null;
    this._offscreenCapture = null;

    if (this.device.lost) {
      this.device.lost.then((info) => {
        if (info && info.reason === 'destroyed') return;
        this._lost = true;
        renderer.contextLost = true;
        if (renderer.onContextLost) renderer.onContextLost();
      });
    }
  }

  static async create(renderer, opts = {}) {
    const gpuCtx = await createGPUContext(renderer.domElement, opts);
    return new GPUBackend(renderer, gpuCtx);
  }

  _createGroup0(shadowView, shadowSamp, envView, envSamp) {
    if (!shadowView._m3dId) shadowView._m3dId = ++GPUBackend._nextId;
    if (!shadowSamp._m3dId) shadowSamp._m3dId = ++GPUBackend._nextId;
    if (!envView._m3dId) envView._m3dId = ++GPUBackend._nextId;
    if (!envSamp._m3dId) envSamp._m3dId = ++GPUBackend._nextId;
    const key = `${shadowView._m3dId}|${shadowSamp._m3dId}|${envView._m3dId}|${envSamp._m3dId}`;
    let bg = this._group0Cache.get(key);
    if (bg) return bg;
    bg = this.device.createBindGroup({
      layout: this.pipes.group0Layout,
      entries: [
        { binding: 0, resource: { buffer: this.globalUniformBuf } },
        { binding: 1, resource: shadowView },
        { binding: 2, resource: shadowSamp },
        { binding: 3, resource: envView },
        { binding: 4, resource: envSamp },
      ],
    });
    if (this._group0Cache.size >= 64) this._group0Cache.clear();
    this._group0Cache.set(key, bg);
    return bg;
  }

  isContextLost() {
    return this._lost;
  }

  beginOffscreenCapture(w, h) {
    if (typeof document === 'undefined' || this._lost) return false;
    try {
      if (!this._recCanvas) {
        this._recCanvas = document.createElement('canvas');
        this._recContext = this._recCanvas.getContext('webgpu');
        if (!this._recContext) {
          this._recCanvas = null;
          return false;
        }
        this._recContext.configure({
          device: this.device,
          format: this.presentationFormat,
          alphaMode: this.alphaMode,
          usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
      }
      if (this._recCanvas.width !== w) this._recCanvas.width = w;
      if (this._recCanvas.height !== h) this._recCanvas.height = h;
      this._offscreenCapture = { w, h };
      return true;
    } catch (_) {
      this._offscreenCapture = null;
      return false;
    }
  }

  endOffscreenCapture() {
    this._offscreenCapture = null;
  }

  getCaptureCanvas() {
    return this._offscreenCapture && this._recCanvas ? this._recCanvas : this.renderer.domElement;
  }

  getCapabilities() {
    const lim = this.device.limits || {};
    const maxTextureSize = lim.maxTextureDimension2D || 8192;
    const maxRenderbufferSize = maxTextureSize;
    return {
      backend: 'webgpu',
      maxTextureSize,
      maxRenderbufferSize,
      maxViewportWidth: maxTextureSize,
      maxViewportHeight: maxTextureSize,
      maxRenderWidth: maxTextureSize,
      maxRenderHeight: maxTextureSize,
    };
  }

  getShadowMapSize(light) {
    if (!light || !light.shadow) return 0;
    const caps = this.getCapabilities();
    const cap = Math.min(caps.maxTextureSize, 4096);
    const base = light.shadow.mapSize || 1024;
    const scale = light.shadow.autoQuality === false ? 1 : (this.renderer.shadowScale || 1);
    return Math.max(64, Math.min(cap, Math.round(base * scale)));
  }

  prepareRenderTarget(rt) {
    this.res.getTarget(rt);
  }

  // Convierte una matriz de proyección OpenGL (NDC Z in [-1, 1]) a WebGPU (NDC Z in [0, 1])
  _remapProjZeroToOne(m, out) {
    out.set(m);
    out[2] = 0.5 * m[2] + 0.5 * m[3];
    out[6] = 0.5 * m[6] + 0.5 * m[7];
    out[10] = 0.5 * m[10] + 0.5 * m[11];
    out[14] = 0.5 * m[14] + 0.5 * m[15];
    return out;
  }

  _writeObjectUniforms(mesh, slot, skin, morph, gg) {
    const buf = slot.slab.cpu;
    const u32 = slot.slab.cpuU32;
    const o = slot.floatOffset;

    buf.set(mesh.matrixWorld.elements, o + 0);

    const nm = mesh.matrixWorld.normalMatrix(this._nm);
    buf[o + 16] = nm[0]; buf[o + 17] = nm[1]; buf[o + 18] = nm[2]; buf[o + 19] = 0;
    buf[o + 20] = nm[3]; buf[o + 21] = nm[4]; buf[o + 22] = nm[5]; buf[o + 23] = 0;
    buf[o + 24] = nm[6]; buf[o + 25] = nm[7]; buf[o + 26] = nm[8]; buf[o + 27] = 0;

    if (skin && mesh.bindMatrix) {
      buf.set(mesh.bindMatrix.elements, o + 28);
    } else {
      buf.fill(0, o + 28, o + 44);
      buf[o + 28] = buf[o + 33] = buf[o + 38] = buf[o + 43] = 1;
    }

    if (morph) {
      const mt = this.res.getMorphData(mesh.geometry);
      u32[o + 44] = mt.count;
      u32[o + 45] = mt.vCount;
      u32[o + 46] = mt.hasNormals;
      u32[o + 47] = mesh.geometry.morphTargetsRelative === false ? 0 : 1;
      buf.fill(0, o + 48, o + 80);
      const inf = mesh.morphTargetInfluences;
      const n = Math.min(mt.count, inf.length);
      for (let i = 0; i < n; i++) buf[o + 48 + i] = inf[i] || 0;
    } else {
      u32[o + 44] = 0; u32[o + 45] = 0; u32[o + 46] = 0; u32[o + 47] = 0;
    }
  }

  _mapTopology(mode) {
    switch (mode) {
      case 'wireframe':
      case 'lines':
      case 'lineLoop':
      case 'line_loop':
        return 'line-list';
      case 'lineStrip':
      case 'line_strip':
        return 'line-strip';
      case 'points':
        return 'point-list';
      default:
        return 'triangle-list';
    }
  }

  _bindVertexAndDraw(pass, slotNames, gg, geo, mode, instBuf, instCount, trackStats = true) {
    const r = this.renderer;
    for (let s = 0; s < slotNames.length; s++) {
      const name = slotNames[s];
      if (name === 'instance') {
        pass.setVertexBuffer(s, instBuf);
      } else {
        pass.setVertexBuffer(s, gg.buffers[name].buf);
      }
    }

    if (mode === 'wireframe') {
      const w = this.res.getWire(gg, geo);
      if (w.count > 0) {
        pass.setIndexBuffer(w.buf, 'uint32');
        pass.drawIndexed(w.count, instCount);
        if (trackStats) {
          r.info.calls++; r.info.drawn++;
          if (instBuf) r.info.instances += instCount;
          r.info.lines += (w.count / 2) * instCount;
        }
      }
      return;
    }

    if (mode === 'lineLoop' || mode === 'line_loop') {
      const lw = this.res.getLineLoop(gg, geo);
      if (lw.count > 0) {
        pass.setIndexBuffer(lw.buf, 'uint32');
        pass.drawIndexed(lw.count, instCount);
        if (trackStats) {
          r.info.calls++; r.info.drawn++;
          if (instBuf) r.info.instances += instCount;
          r.info.lines += (lw.count / 2) * instCount;
        }
      }
      return;
    }

    if (gg.indexed) {
      pass.setIndexBuffer(gg.indexBuf, gg.indexFormat);
      pass.drawIndexed(gg.count, instCount);
    } else {
      pass.draw(gg.count, instCount);
    }

    if (trackStats) {
      r.info.calls++; r.info.drawn++;
      if (instBuf) r.info.instances += instCount;
      if (mode === 'triangles') r.info.triangles += (gg.count / 3) * instCount;
      else if (mode === 'lines') r.info.lines += (gg.count / 2) * instCount;
      else if (mode === 'lineStrip' || mode === 'line_strip') r.info.lines += Math.max(0, gg.count - 1) * instCount;
    }
  }

  _prepareInstancedMain(mesh, gg) {
    const r = this.renderer, res = this.res, device = this.device;
    const attr = mesh.instanceMatrix, a = attr.array;
    const total = Math.min(mesh.count, (a.length / 16) | 0);
    const ig = res.ensureInstanced(mesh, attr);
    let n = total, full = true;

    if (mesh.cullInstances && mesh.frustumCulled && mesh.material.frustumCulled !== false) {
      if (this._scratch.length < total * 16) this._scratch = new Float32Array(total * 16);
      const s = this._scratch, f = r._frustum;
      const mw = mesh.matrixWorld, me = mw.elements, ms = mw.getMaxScale();
      const bs = mesh.geometry.getBoundingSphere(), cx = bs.center.x, cy = bs.center.y, cz = bs.center.z, rad = bs.radius * ms;
      n = 0;
      for (let i = 0; i < total; i++) {
        const o = i * 16;
        const ix = a[o] * cx + a[o + 4] * cy + a[o + 8] * cz + a[o + 12];
        const iy = a[o + 1] * cx + a[o + 5] * cy + a[o + 9] * cz + a[o + 13];
        const iz = a[o + 2] * cx + a[o + 6] * cy + a[o + 10] * cz + a[o + 14];
        const wx = me[0] * ix + me[4] * iy + me[8] * iz + me[12];
        const wy = me[1] * ix + me[5] * iy + me[9] * iz + me[13];
        const wz = me[2] * ix + me[6] * iy + me[10] * iz + me[14];
        const s0 = a[o] * a[o] + a[o + 1] * a[o + 1] + a[o + 2] * a[o + 2];
        const s1 = a[o + 4] * a[o + 4] + a[o + 5] * a[o + 5] + a[o + 6] * a[o + 6];
        const s2 = a[o + 8] * a[o + 8] + a[o + 9] * a[o + 9] + a[o + 10] * a[o + 10];
        if (f.intersectsSphere(wx, wy, wz, rad * Math.sqrt(Math.max(s0, s1, s2)))) {
          const w = n * 16;
          for (let k = 0; k < 16; k++) s[w + k] = a[o + k];
          n++;
        }
      }
      full = n === total;
      r.info.culled += total - n;
    }
    if (n === 0) return null;

    if (full) {
      if (ig.version !== attr.version || ig.attr !== attr) {
        if (ig.byteLength < a.byteLength) {
          ig.buf.destroy();
          ig.buf = device.createBuffer({ size: a.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
          ig.byteLength = a.byteLength;
        }
        device.queue.writeBuffer(ig.buf, 0, a, 0, total * 16);
        ig.attr = attr; ig.version = attr.version;
      }
      return { buf: ig.buf, count: total };
    }

    const needBytes = n * 16 * 4;
    if (!ig.culledBuf || ig.culledByteLength < needBytes) {
      if (ig.culledBuf) ig.culledBuf.destroy();
      ig.culledBuf = device.createBuffer({
        size: Math.max(needBytes, a.byteLength),
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      ig.culledByteLength = Math.max(needBytes, a.byteLength);
    }
    device.queue.writeBuffer(ig.culledBuf, 0, this._scratch, 0, n * 16);
    return { buf: ig.culledBuf, count: n };
  }

  renderShadowMap(light, casters, lightVP) {
    const r = this.renderer, res = this.res, device = this.device;
    const sm = res.getShadowMap(light);
    this._remapProjZeroToOne(lightVP.elements, this._shadowRemap);

    this._shadowDraws.length = 0;
    for (let ci = 0; ci < casters.length; ci++) {
      const mesh = casters[ci];
      const inst = !!mesh.isInstancedMesh;
      const skin = r._isGpuSkin(mesh);
      const morph = r._hasMorph(mesh);
      if (skin) mesh.skeleton.updateOnce(r._frame);
      else if (mesh.isSkinnedMesh && mesh.autoUpdateSkin) {
        if (mesh.skeleton) mesh.skeleton.update();
        mesh.updateSkinnedVertices();
      }
      const gg = res.getGeometry(mesh.geometry);
      let instBuf = null, instCount = 1;
      if (inst) {
        const attr = mesh.instanceMatrix, a = attr.array;
        const total = Math.min(mesh.count, (a.length / 16) | 0);
        if (total <= 0) continue;
        const ig = res.ensureInstanced(mesh, attr);
        if (ig.version !== attr.version || ig.attr !== attr) {
          if (ig.byteLength < a.byteLength) {
            ig.buf.destroy();
            ig.buf = device.createBuffer({ size: a.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
            ig.byteLength = a.byteLength;
          }
          device.queue.writeBuffer(ig.buf, 0, a, 0, total * 16);
          ig.attr = attr; ig.version = attr.version;
        }
        instBuf = ig.buf;
        instCount = total;
      }
      this._shadowDraws.push({ mesh, gg, inst, skin, morph, instBuf, instCount });
    }

    this._activeShadow = sm;
    this._skipShadowPass = false;
    return { texture: sm.texture, matrix: lightVP, size: sm.size };
  }

  reuseShadowMap(light, lightVP) {
    const sm = this.res.getShadowMap(light);
    this._remapProjZeroToOne(lightVP.elements, this._shadowRemap);
    this._shadowDraws.length = 0;
    this._activeShadow = sm;
    this._skipShadowPass = true;
    return { texture: sm.texture, matrix: lightVP, size: sm.size };
  }

  beginMainPass(clearRGB, rt) {
    this._clearRGB = clearRGB;
    this._activeRt = rt || null;
    this._pendingDraws.length = 0;
    this.res.beginFrame();
    if (!this._activeShadow && this._shadowDraws.length) this._shadowDraws.length = 0;
  }

  _resolveWgslTemplate(material) {
    if (material.wgslShader) return { template: material.wgslShader, custom: Boolean(material.isShaderMaterial) };
    const builtin = BUILTIN_WGSL[material.type];
    if (builtin) return { template: builtin, custom: false };
    throw new Error(`Made3D WebGPU: el material '${material.type}' no tiene shader WGSL definido (asigna 'wgslShader' al ShaderMaterial o usa el backend WebGL2).`);
  }

  _getTexMask(material, defs) {
    let mask = 0;
    if (defs.USE_MAP) mask |= 1;
    if (defs.USE_NORMALMAP) mask |= 2;
    if (defs.USE_EMISSIVEMAP) mask |= 4;
    if (defs.USE_AOMAP) mask |= 8;
    if (defs.USE_MRMAP) mask |= 16;
    if (defs.USE_MATCAP) mask |= 32;
    if (defs.USE_ROUGHNESSMAP) mask |= 64;
    if (defs.USE_METALNESSMAP) mask |= 128;
    return mask;
  }

  drawItem(item) {
    const r = this.renderer, res = this.res;
    const mesh = item.mesh, m = item.material;
    const instanced = !!mesh.isInstancedMesh;
    const skin = r._isGpuSkin(mesh);
    const morph = r._hasMorph(mesh);

    if (!skin && mesh.isSkinnedMesh && mesh.autoUpdateSkin && mesh._cpuSkinFrame !== r._frame) {
      if (mesh.skeleton) mesh.skeleton.update();
      mesh.updateSkinnedVertices();
      mesh._cpuSkinFrame = r._frame;
    }

    const gg = res.getGeometry(mesh.geometry);
    let instBuf = null, instCount = 1;
    if (instanced) {
      const prep = this._prepareInstancedMain(mesh, gg);
      if (!prep) return;
      instBuf = prep.buf;
      instCount = prep.count;
    }

    const objSlot = res.objArena.alloc();
    this._writeObjectUniforms(mesh, objSlot, skin, morph, gg);
    const boneBuf = skin ? res.getBoneBuffer(mesh.skeleton) : res.dummyBoneBuf;
    const morphBuf = morph ? res.getMorphData(mesh.geometry).buf : res.dummyMorphBuf;
    const bg1 = res.getGroup1BindGroup(objSlot.slabIdx, objSlot.buffer, boneBuf, morphBuf);

    m.updateUniforms();
    const matSlot = res.matArena.alloc();
    res.writeMaterialUniforms(m, matSlot);

    const baseDefs = m.getDefines();
    const fog = r._fogOn && m.fog !== false;
    const shadow = r._shadowOn && m.lit && m.receiveShadow !== false && mesh.receiveShadow !== false;
    const defs = Object.assign({}, baseDefs);
    if (fog) defs.USE_FOG = 1;
    if (shadow) defs.USE_SHADOW = 1;
    if (skin) defs.USE_SKINNING = 1;
    if (morph) defs.USE_MORPH = 1;

    const texMask = this._getTexMask(m, defs);
    const bg2 = res.getGroup2BindGroup(m, texMask, matSlot);

    this._pendingDraws.push({
      mesh, material: m, gg, instanced, skin, morph, defs, texMask,
      objOffset: objSlot.dynamicOffset, bg1,
      matOffset: matSlot.dynamicOffset, bg2,
      instBuf, instCount,
    });
  }

  _uploadGlobals() {
    const r = this.renderer, g = r._globals, buf = this._globalCpu;
    buf.set(g.uView, 0);
    this._remapProjZeroToOne(g.uProjection, this._projRemap);
    buf.set(this._projRemap, 16);
    if (r._shadowOn) {
      buf.set(this._shadowRemap, 32);
    } else {
      buf.fill(0, 32, 48);
    }

    buf[48] = g.uCameraPos[0]; buf[49] = g.uCameraPos[1]; buf[50] = g.uCameraPos[2]; buf[51] = g.uTime;
    buf[52] = g.uAmbient[0]; buf[53] = g.uAmbient[1]; buf[54] = g.uAmbient[2]; buf[55] = g.uDirCount;
    buf[56] = g.uFogColor[0]; buf[57] = g.uFogColor[1]; buf[58] = g.uFogColor[2]; buf[59] = g.uFogNear;
    buf[60] = g.uFogFar; buf[61] = g.uFogDensity; buf[62] = g.uPointCount; buf[63] = g.uShadowLight;
    buf[64] = g.uShadowBias; buf[65] = g.uShadowRadius; buf[66] = g.uShadowStrength;
    buf[67] = this._activeShadow ? this._activeShadow.size : 1;

    for (let i = 0; i < 4; i++) {
      const s = i * 3, d = 68 + i * 4;
      buf[d + 0] = g.uDirColor[s]; buf[d + 1] = g.uDirColor[s + 1]; buf[d + 2] = g.uDirColor[s + 2]; buf[d + 3] = 0;
      const d2 = 84 + i * 4;
      buf[d2 + 0] = g.uDirDir[s]; buf[d2 + 1] = g.uDirDir[s + 1]; buf[d2 + 2] = g.uDirDir[s + 2]; buf[d2 + 3] = 0;
      const d3 = 100 + i * 4;
      buf[d3 + 0] = g.uPointPos[s]; buf[d3 + 1] = g.uPointPos[s + 1]; buf[d3 + 2] = g.uPointPos[s + 2]; buf[d3 + 3] = g.uPointDist[i];
      const d4 = 116 + i * 4;
      buf[d4 + 0] = g.uPointColor[s]; buf[d4 + 1] = g.uPointColor[s + 1]; buf[d4 + 2] = g.uPointColor[s + 2]; buf[d4 + 3] = g.uPointDecay[i];
    }

    buf[132] = g.uEnvIntensity ?? 0;
    buf[133] = g.uEnvHasMap ?? 0;
    buf[134] = g.uEnvMaxMip ?? 0;
    buf[135] = g.uEnvGain ?? 1;
    buf.set(r._envShVec4, 136);

    this.device.queue.writeBuffer(this.globalUniformBuf, 0, buf);
  }

  endMainPass() {
    const r = this.renderer, res = this.res, device = this.device;

    // Alocar slots de ObjectUniforms para sombras dentro del mismo arena de este frame
    const shadowPrepared = [];
    if (this._activeShadow && !this._skipShadowPass && this._shadowDraws.length) {
      for (let i = 0; i < this._shadowDraws.length; i++) {
        const sd = this._shadowDraws[i];
        const objSlot = res.objArena.alloc();
        this._writeObjectUniforms(sd.mesh, objSlot, sd.skin, sd.morph, sd.gg);
        const boneBuf = sd.skin ? res.getBoneBuffer(sd.mesh.skeleton) : res.dummyBoneBuf;
        const morphBuf = sd.morph ? res.getMorphData(sd.mesh.geometry).buf : res.dummyMorphBuf;
        const bg1 = res.getGroup1BindGroup(objSlot.slabIdx, objSlot.buffer, boneBuf, morphBuf);
        shadowPrepared.push({ ...sd, objOffset: objSlot.dynamicOffset, bg1 });
      }
    }

    this._uploadGlobals();
    res.flushArenas();

    const enc = device.createCommandEncoder({ label: 'M3D_Frame' });

    // Pase de sombras (si está activo y no se reutilizó del mismo cuadro)
    if (this._activeShadow && !this._skipShadowPass) {
      const sm = this._activeShadow;
      const sPass = enc.beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: {
          view: sm.view,
          depthClearValue: 1.0,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
      });
      sPass.setBindGroup(0, this.group0BindGroup);
      for (let i = 0; i < shadowPrepared.length; i++) {
        const sd = shadowPrepared[i];
        const defs = {};
        if (sd.skin) defs.USE_SKINNING = 1;
        if (sd.morph) defs.USE_MORPH = 1;
        const ai = sd.gg.attrInfo;
        const cacheKey = `shadow|${sd.inst ? 1 : 0}|${sd.skin ? 1 : 0}|${sd.morph ? 1 : 0}|${ai.hasNormal ? 1 : 0}|${ai.hasUv ? 1 : 0}|${ai.colorSize}|${ai.hasUv1 ? 1 : 0}`;
        const pipeEntry = this.pipes.getRenderPipeline({
          cacheKey,
          wgslTemplate: SHADOW_WGSL,
          defines: defs,
          instanced: sd.inst,
          srgb: false,
          custom: false,
          texMask: 0,
          attrInfo: ai,
          topology: 'triangle-list',
          cullMode: 'back',
          blendMode: 'none',
          depthTest: true,
          depthWrite: true,
          colorFormat: null,
          depthFormat: 'depth24plus',
          hasFragment: false,
          layoutOverride: this.pipes.shadowPipelineLayout,
        });
        sPass.setPipeline(pipeEntry.pipeline);
        sPass.setBindGroup(1, sd.bg1, [sd.objOffset]);
        this._bindVertexAndDraw(sPass, pipeEntry.slotNames, sd.gg, sd.mesh.geometry, 'triangles', sd.instBuf, sd.instCount, false);
      }
      sPass.end();
    }

    // Group 0 con el shadow map y el mapa de entorno activos para el pase principal
    const sView = this._activeShadow ? this._activeShadow.view : this._dummyShadowView;
    const sSamp = this._activeShadow ? this._activeShadow.sampler : this._dummyShadowSamp;
    let eView = this._dummyEnvView;
    let eSamp = this._dummyEnvSamp;
    if (r._globals.uEnvHasMap > 0.5 && r._globals.uEnvMap) {
      const envRes = res.getTextureResource(r._globals.uEnvMap);
      eView = envRes.view || this._dummyEnvView;
      eSamp = envRes.sampler || this._dummyEnvSamp;
    }
    const g0 = this._createGroup0(sView, sSamp, eView, eSamp);

    const rt = this._activeRt;
    let colorView, depthView, colorFormat, depthFormat, w, h;
    if (rt) {
      const t = res.getTarget(rt);
      colorView = t.view;
      depthView = t.depthView;
      colorFormat = t.format;
      depthFormat = rt.depthBuffer ? 'depth24plus' : null;
      w = t.w; h = t.h;
    } else {
      const off = this._offscreenCapture;
      const targetCtx = off && this._recContext ? this._recContext : this.context;
      const swapTex = targetCtx.getCurrentTexture();
      this.currentSwapView = swapTex.createView();
      colorView = this.currentSwapView;
      w = Math.max(1, swapTex.width || (off ? off.w : r.domElement.width));
      h = Math.max(1, swapTex.height || (off ? off.h : r.domElement.height));
      depthView = off ? res.getRecDepthView(w, h) : res.getMainDepthView(w, h);
      colorFormat = this.presentationFormat;
      depthFormat = 'depth24plus';
    }

    // Solo convertir clearColor a lineal si el target/swapchain es -srgb o es un RenderTarget en modo sRGB
    const isSrgbFormat = typeof colorFormat === 'string' && colorFormat.endsWith('-srgb');
    const clearLin = (isSrgbFormat || !!rt) && r._colorSpace === 'srgb';
    const c = this._clearRGB;
    const clearValue = clearLin
      ? { r: s2l(c[0]), g: s2l(c[1]), b: s2l(c[2]), a: 1.0 }
      : { r: c[0], g: c[1], b: c[2], a: 1.0 };

    const passDesc = {
      colorAttachments: [{
        view: colorView,
        loadOp: 'clear',
        clearValue,
        storeOp: 'store',
      }],
    };
    if (depthFormat) {
      passDesc.depthStencilAttachment = {
        view: depthView,
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      };
    }

    const pass = enc.beginRenderPass(passDesc);
    pass.setViewport(0, 0, w, h, 0, 1);
    pass.setBindGroup(0, g0);

    const srgb = r._colorSpace === 'srgb' && !rt && !isSrgbFormat;
    const inputSrgb = r._colorSpace === 'srgb' && !rt;
    let lastPipe = null;

    const issueDraw = (d, side, mode, topology, blendMode) => {
      const m = d.material;
      const ai = d.gg.attrInfo;
      const cullMode = side === 'double' ? 'none' : (side === 'back' ? 'front' : 'back');
      const cacheKey = `${m.programKey}|${d.instanced ? 1 : 0}|${srgb ? 1 : 0}|${inputSrgb ? 1 : 0}|${d.defs.USE_FOG ? 1 : 0}|${d.defs.USE_SHADOW ? 1 : 0}|${d.skin ? 1 : 0}|${d.morph ? 1 : 0}|${d.texMask}|${ai.hasNormal ? 1 : 0}|${ai.hasUv ? 1 : 0}|${ai.colorSize}|${ai.hasUv1 ? 1 : 0}|${topology}|${cullMode}|${blendMode}|${m.depthTest ? 1 : 0}|${m.depthWrite ? 1 : 0}|${colorFormat}|${depthFormat || 'none'}`;
      const { template, custom } = this._resolveWgslTemplate(m);
      const pipeDefs = inputSrgb && !srgb ? { ...d.defs, INPUT_SRGB: 1 } : d.defs;

      const pipeEntry = this.pipes.getRenderPipeline({
        cacheKey,
        wgslTemplate: template,
        defines: pipeDefs,
        instanced: d.instanced,
        srgb,
        custom,
        texMask: d.texMask,
        attrInfo: ai,
        topology,
        cullMode,
        blendMode,
        depthTest: m.depthTest,
        depthWrite: m.depthWrite,
        colorFormat,
        depthFormat,
      });

      if (lastPipe !== pipeEntry.pipeline) {
        pass.setPipeline(pipeEntry.pipeline);
        lastPipe = pipeEntry.pipeline;
      }
      pass.setBindGroup(1, d.bg1, [d.objOffset]);
      pass.setBindGroup(2, d.bg2, [d.matOffset]);
      this._bindVertexAndDraw(pass, pipeEntry.slotNames, d.gg, d.mesh.geometry, mode, d.instBuf, d.instCount, true);
    };

    for (let i = 0; i < this._pendingDraws.length; i++) {
      const d = this._pendingDraws[i];
      const m = d.material, mesh = d.mesh;
      const mode = mesh.drawMode || (m.wireframe ? 'wireframe' : 'triangles');
      const topology = this._mapTopology(mode);
      const blendMode = m.transparent ? m.blending : 'none';

      if (mode !== 'triangles') {
        issueDraw(d, 'front', mode, topology, blendMode);
      } else if (m.transparent && m.side === 'double' && m.twoPass !== false) {
        issueDraw(d, 'back', mode, topology, blendMode);
        issueDraw(d, 'front', mode, topology, blendMode);
      } else {
        issueDraw(d, m.side, mode, topology, blendMode);
      }
    }

    pass.end();
    device.queue.submit([enc.finish()]);
    this._activeShadow = null;
    this._skipShadowPass = false;
    this._shadowDraws.length = 0;
    this._pendingDraws.length = 0;
  }

  renderOutline(params) {
    this.outline.render(this, params);
  }

  // Utilidad Compute Shader en WebGPU para deformar posiciones con un pincel de esculpido directamente en GPU
  async runComputeSculptBrush(positionsArray, normalsArray, params) {
    if (!positionsArray || !normalsArray) return null;
    if (!this._sculptPipe) {
      const mod = this.pipes.getShaderModule(SCULPT_BRUSH_COMPUTE_WGSL);
      this._sculptPipe = this.device.createComputePipeline({
        layout: 'auto',
        compute: { module: mod, entryPoint: 'cs_main' },
      });
    }
    const vCount = (positionsArray.length / 3) | 0;
    if (!vCount) return null;
    const device = this.device;
    const posBuf = device.createBuffer({
      size: positionsArray.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    const norBuf = device.createBuffer({
      size: normalsArray.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const uniBuf = device.createBuffer({
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const readBuf = device.createBuffer({
      size: positionsArray.byteLength,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    try {
      device.queue.writeBuffer(posBuf, 0, positionsArray);
      device.queue.writeBuffer(norBuf, 0, normalsArray);

      const ab = new ArrayBuffer(48);
      const f32 = new Float32Array(ab);
      const u32 = new Uint32Array(ab);
      const dirSign = (params.tool === 'carve' || params.tool === 'deflate') ? -1 : 1;
      f32[0] = params.center?.x || 0; f32[1] = params.center?.y || 0; f32[2] = params.center?.z || 0; f32[3] = params.radius || 0.45;
      f32[4] = params.dir?.x || 0; f32[5] = params.dir?.y || 0; f32[6] = params.dir?.z || 0; f32[7] = (params.strength || 0.5) * dirSign;
      u32[8] = vCount;
      u32[9] = params.falloff === 'sphere' ? 1 : params.falloff === 'tip' ? 2 : 0;
      u32[10] = (params.tool === 'inflate' || params.tool === 'deflate') ? 4 : 0;
      u32[11] = 0;
      device.queue.writeBuffer(uniBuf, 0, ab);

      const bg = device.createBindGroup({
        layout: this._sculptPipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: posBuf } },
          { binding: 1, resource: { buffer: norBuf } },
          { binding: 2, resource: { buffer: uniBuf } },
        ],
      });
      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(this._sculptPipe);
      pass.setBindGroup(0, bg);
      pass.dispatchWorkgroups(Math.ceil(vCount / 64), 1, 1);
      pass.end();
      enc.copyBufferToBuffer(posBuf, 0, readBuf, 0, positionsArray.byteLength);
      device.queue.submit([enc.finish()]);

      await readBuf.mapAsync(GPUMapMode.READ);
      positionsArray.set(new Float32Array(readBuf.getMappedRange()));
      return positionsArray;
    } finally {
      try { if (readBuf.mapState === 'mapped') readBuf.unmap(); } catch (_) {}
      posBuf.destroy();
      norBuf.destroy();
      uniBuf.destroy();
      readBuf.destroy();
    }
  }

  copyCanvasTo2D(outCanvas, w, h, opts = {}) {
    const src = this._offscreenCapture && this._recCanvas ? this._recCanvas : this.renderer.domElement;
    const dw = src.width || w;
    const dh = src.height || h;
    if (outCanvas.width !== w) outCanvas.width = w;
    if (outCanvas.height !== h) outCanvas.height = h;
    const opaque = opts.opaque !== false && this.alphaMode === 'opaque';
    const ctx = outCanvas._m3dCtx2d || (outCanvas._m3dCtx2d = (
      outCanvas.getContext('2d', opaque ? { alpha: false, desynchronized: true } : undefined) ||
      outCanvas.getContext('2d')
    ));
    if (ctx) {
      if (!opaque) ctx.clearRect(0, 0, w, h);
      ctx.drawImage(src, 0, 0, dw, dh, 0, 0, w, h);
    }
  }

  dispose() {
    this._offscreenCapture = null;
    this._recContext = null;
    this._recCanvas = null;
    this.globalUniformBuf.destroy();
    this._dummyShadowTex.destroy();
    if (this._dummyEnvTex) this._dummyEnvTex.destroy();
    this._group0Cache.clear();
    if (this.outline && typeof this.outline.dispose === 'function') this.outline.dispose(this);
    this.pipes.clear();
    this.res.disposeAll();
    try { this.device.destroy(); } catch (_) {}
    this._lost = true;
  }
}

GPUBackend._nextId = 0;
