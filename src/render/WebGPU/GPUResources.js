import {
  OBJECT_UNIFORM_BYTES,
  MATERIAL_UNIFORM_BYTES,
  alignUp,
} from './GPUDevice.js';
import { MIPMAP_BLIT_WGSL } from '../../shaders/WGSL/compute.js';

const SLAB_CAPACITY = 256;
const IDENTITY_UV_MAT = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

function padFloatBytes(src) {
  const bytes = src.byteLength;
  const aligned = (bytes + 3) & ~3;
  if (aligned === bytes) return src;
  const out = new Uint8Array(aligned);
  out.set(new Uint8Array(src.buffer, src.byteOffset, bytes));
  return out;
}

function flipRowsRgba(src, w, h) {
  const rowBytes = w * 4;
  const out = new Uint8Array(src.length);
  for (let y = 0; y < h; y++) {
    const sy = h - 1 - y;
    out.set(src.subarray(sy * rowBytes, (sy + 1) * rowBytes), y * rowBytes);
  }
  return out;
}

export class DynamicUniformArena {
  constructor(device, structBytes, minAlign) {
    this.device = device;
    this.stride = alignUp(structBytes, Math.max(256, minAlign || 256));
    this.strideFloats = this.stride >> 2;
    this.slabs = [];
    this.cursor = 0;
  }

  reset() {
    this.cursor = 0;
    for (let i = 0; i < this.slabs.length; i++) {
      this.slabs[i].usedFloats = 0;
      this.slabs[i].flushedFloats = 0;
    }
  }

  alloc() {
    const slabIdx = Math.floor(this.cursor / SLAB_CAPACITY);
    const localIdx = this.cursor % SLAB_CAPACITY;
    let slab = this.slabs[slabIdx];
    if (!slab) {
      const byteSize = this.stride * SLAB_CAPACITY;
      slab = {
        buffer: this.device.createBuffer({
          size: byteSize,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }),
        cpu: new Float32Array(byteSize >> 2),
        cpuU32: null,
        usedFloats: 0,
        flushedFloats: 0,
      };
      slab.cpuU32 = new Uint32Array(slab.cpu.buffer);
      this.slabs.push(slab);
    }
    this.cursor++;
    const floatOffset = localIdx * this.strideFloats;
    slab.usedFloats = Math.max(slab.usedFloats, floatOffset + this.strideFloats);
    return {
      slabIdx,
      slab,
      buffer: slab.buffer,
      dynamicOffset: localIdx * this.stride,
      floatOffset,
    };
  }

  flush() {
    for (let i = 0; i < this.slabs.length; i++) {
      const s = this.slabs[i];
      if (s.usedFloats > s.flushedFloats) {
        const start = s.flushedFloats;
        this.device.queue.writeBuffer(s.buffer, start * 4, s.cpu, start, s.usedFloats - start);
        s.flushedFloats = s.usedFloats;
      }
    }
  }

  dispose() {
    for (let i = 0; i < this.slabs.length; i++) this.slabs[i].buffer.destroy();
    this.slabs.length = 0;
  }
}

export class ShadowTextureGPU {
  constructor(map) {
    this.isTexture = true;
    this.isShadowTexture = true;
    this.map = map;
    this.version = 0;
    this.colorSpace = 'linear';
  }
  isReady() { return true; }
  set needsUpdate(_v) {}
}

export class GPUResources {
  constructor(backend) {
    this.b = backend;
    this.device = backend.device;
    const minAlign = this.device.limits?.minUniformBufferOffsetAlignment || 256;

    this.objArena = new DynamicUniformArena(this.device, OBJECT_UNIFORM_BYTES, minAlign);
    this.matArena = new DynamicUniformArena(this.device, MATERIAL_UNIFORM_BYTES, minAlign);

    this.dummyBoneBuf = this.device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.dummyBoneBuf, 0, new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]));

    this.dummyMorphBuf = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this._geo = new WeakMap();
    this._tex = new WeakMap();
    this._inst = new WeakMap();
    this._boneBufs = new WeakMap();
    this._morphBufs = new WeakMap();
    this._targets = new WeakMap();
    this._targetList = new Set();
    this._shadows = new Map();
    this._group1Cache = new Map();
    this._group2Cache = new Map();
    this._matBg2Fast = new WeakMap();
    this._samplers = new Map();
    this._whiteTex = null;
    this._whiteView = null;
    this._defaultSampler = null;
    this._mipPipe = null;
    this._mipSamp = null;
    this._depthTex = null;
    this._depthView = null;
    this._depthW = 0;
    this._depthH = 0;
    this._recDepthTex = null;
    this._recDepthView = null;
    this._recDepthW = 0;
    this._recDepthH = 0;
  }

  beginFrame() {
    this.objArena.reset();
    this.matArena.reset();
  }

  flushArenas() {
    this.objArena.flush();
    this.matArena.flush();
  }

  getMainDepthView(w, h) {
    if (!this._depthTex || this._depthW !== w || this._depthH !== h) {
      if (this._depthTex) this._depthTex.destroy();
      this._depthTex = this.device.createTexture({
        size: [w, h, 1],
        format: 'depth24plus',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this._depthView = this._depthTex.createView();
      this._depthW = w;
      this._depthH = h;
    }
    return this._depthView;
  }

  getRecDepthView(w, h) {
    if (!this._recDepthTex || this._recDepthW !== w || this._recDepthH !== h) {
      if (this._recDepthTex) this._recDepthTex.destroy();
      this._recDepthTex = this.device.createTexture({
        size: [w, h, 1],
        format: 'depth24plus',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this._recDepthView = this._recDepthTex.createView();
      this._recDepthW = w;
      this._recDepthH = h;
    }
    return this._recDepthView;
  }

  getSampler(tex) {
    const wrapS = tex?.wrapS || 'repeat';
    const wrapT = tex?.wrapT || 'repeat';
    const deferMips = Boolean(tex?._deferMipmaps);
    const minF = deferMips && (tex?.minFilter || 'linear-mipmap') === 'linear-mipmap'
      ? 'linear'
      : (tex?.minFilter || 'linear-mipmap');
    const magF = tex?.magFilter || 'linear';
    const aniso = (minF === 'linear-mipmap' && !this.b.renderer.isMobile) ? 4 : 1;
    const key = `${wrapS}|${wrapT}|${minF}|${magF}|${aniso}|${deferMips ? 1 : 0}`;
    let s = this._samplers.get(key);
    if (s) return s;

    const mapAddr = (w) => (w === 'clamp' ? 'clamp-to-edge' : w === 'mirror' ? 'mirror-repeat' : 'repeat');
    const magFilter = magF === 'nearest' ? 'nearest' : 'linear';
    const minFilter = minF === 'nearest' ? 'nearest' : 'linear';
    const mipmapFilter = minF === 'linear-mipmap' ? 'linear' : 'nearest';
    const maxAnisotropy = (magFilter === 'linear' && minFilter === 'linear' && mipmapFilter === 'linear') ? aniso : 1;

    const desc = {
      addressModeU: mapAddr(wrapS),
      addressModeV: mapAddr(wrapT),
      magFilter,
      minFilter,
      mipmapFilter,
      maxAnisotropy,
    };
    if (deferMips) desc.lodMaxClamp = 0.0;
    s = this.device.createSampler(desc);
    this._samplers.set(key, s);
    return s;
  }

  getWhiteTexture() {
    if (!this._whiteTex) {
      this._whiteTex = this.device.createTexture({
        size: [1, 1, 1],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      this.device.queue.writeTexture(
        { texture: this._whiteTex },
        new Uint8Array([255, 255, 255, 255]),
        { bytesPerRow: 4 },
        [1, 1, 1]
      );
      this._whiteView = this._whiteTex.createView();
      this._defaultSampler = this.getSampler(null);
    }
    return { view: this._whiteView, sampler: this._defaultSampler };
  }

  // ───────── render targets ─────────
  getTarget(rt) {
    const r = this.b.renderer;
    let t = this._targets.get(rt), created = false;
    if (!t) {
      const onDispose = () => {
        rt.off('dispose', onDispose);
        if (this._targets.get(rt) === t) this.disposeTarget(rt);
      };
      t = { tex: null, view: null, depthTex: null, depthView: null, w: 0, h: 0, format: null, onDispose };
      this._targets.set(rt, t);
      this._targetList.add(rt);
      created = true;
      rt.on('dispose', onDispose);
    }
    const size = r.clampRenderSize(rt.width, rt.height, { depthBuffer: rt.depthBuffer !== false, forTarget: true });
    const tw = size.width, th = size.height;
    const format = rt.colorSpace !== 'linear' ? 'rgba8unorm-srgb' : 'rgba8unorm';
    if (t.w !== tw || t.h !== th || t.format !== format) {
      if (t.tex) t.tex.destroy();
      if (t.depthTex) t.depthTex.destroy();
      t.tex = this.device.createTexture({
        size: [tw, th, 1],
        format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
      });
      t.view = t.tex.createView();
      if (rt.depthBuffer) {
        t.depthTex = this.device.createTexture({
          size: [tw, th, 1],
          format: 'depth24plus',
          usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        t.depthView = t.depthTex.createView();
      } else {
        t.depthTex = null;
        t.depthView = null;
      }
      t.w = tw; t.h = th; t.format = format;
      if (created) r.info.memory.textures++;
    }
    return t;
  }

  disposeTarget(rt) {
    const t = this._targets.get(rt);
    if (!t) return;
    if (t.onDispose) rt.off('dispose', t.onDispose);
    if (t.tex) t.tex.destroy();
    if (t.depthTex) t.depthTex.destroy();
    this._targets.delete(rt);
    this._targetList.delete(rt);
    this._group2Cache.clear();
    this.b._group0Cache?.clear();
    this.b.renderer.info.memory.textures--;
    if (this.b.renderer._rt === rt) this.b.renderer._rt = null;
  }

  // ───────── shadow map ─────────
  getShadowMap(light) {
    const size = this.b.getShadowMapSize(light);
    let sm = this._shadows.get(light);
    if (sm && sm.size !== size) { this.disposeShadowMap(light); sm = null; }
    if (sm) return sm;

    const tex = this.device.createTexture({
      size: [size, size, 1],
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    const view = tex.createView();
    const sampler = this.device.createSampler({
      compare: 'less-equal',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    sm = { size, tex, view, sampler, texture: null };
    sm.texture = new ShadowTextureGPU(sm);
    this._shadows.set(light, sm);
    return sm;
  }

  disposeShadowMap(light) {
    const sm = this._shadows.get(light);
    if (!sm) return;
    sm.tex.destroy();
    this._shadows.delete(light);
    this.b._group0Cache?.clear();
  }

  // ───────── skinning & morph storage buffers ─────────
  getBoneBuffer(sk) {
    const r = this.b.renderer;
    let b = this._boneBufs.get(sk);
    const needBytes = Math.max(64, sk.bones.length * 64);
    if (!b) {
      const onDispose = () => {
        sk.off('dispose', onDispose);
        if (this._boneBufs.get(sk) !== b) return;
        b.buf.destroy();
        this._boneBufs.delete(sk);
        this._group1Cache.clear();
        r.info.memory.textures--;
      };
      b = {
        buf: this.device.createBuffer({ size: needBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }),
        byteSize: needBytes,
        version: -1,
        onDispose,
      };
      this._boneBufs.set(sk, b);
      r.info.memory.textures++;
      sk.on('dispose', onDispose);
    } else if (b.byteSize < needBytes) {
      b.buf.destroy();
      b.buf = this.device.createBuffer({ size: needBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      b.byteSize = needBytes;
      b.version = -1;
      this._group1Cache.clear();
    }
    if (b.version !== sk.version) {
      this.device.queue.writeBuffer(b.buf, 0, sk.boneMatrices);
      b.version = sk.version;
    }
    return b.buf;
  }

  getMorphData(g) {
    const r = this.b.renderer;
    const posTargets = g.morphAttributes.position || [];
    const norTargets = g.morphAttributes.normal || [];
    const count = Math.min(32, posTargets.length);
    const vCount = g.vertexCount || 1;
    const hasNormals = norTargets.length >= count && count > 0 ? 1 : 0;
    let verSig = `${count}|${vCount}|${hasNormals}`;
    for (let t = 0; t < count; t++) {
      verSig += `|${posTargets[t]?.version ?? 0}`;
      if (hasNormals) verSig += `:${norTargets[t]?.version ?? 0}`;
    }

    let mt = this._morphBufs.get(g);
    if (mt && mt.verSig === verSig) return mt;
    if (mt) {
      if (mt.onDispose) g.off('dispose', mt.onDispose);
      mt.buf.destroy();
      this._morphBufs.delete(g);
      this._group1Cache.clear();
      r.info.memory.textures--;
    }

    const stride = hasNormals ? 2 : 1;
    const totalVec4 = Math.max(1, count * vCount * stride);
    const data = new Float32Array(totalVec4 * 4);

    for (let t = 0; t < count; t++) {
      const pArr = posTargets[t].array;
      const nArr = hasNormals ? norTargets[t].array : null;
      for (let v = 0; v < vCount; v++) {
        const idx = (t * vCount + v) * stride;
        const pOff = idx * 4;
        data[pOff] = pArr[v * 3] || 0;
        data[pOff + 1] = pArr[v * 3 + 1] || 0;
        data[pOff + 2] = pArr[v * 3 + 2] || 0;
        if (hasNormals) {
          const nOff = (idx + 1) * 4;
          data[nOff] = nArr[v * 3] || 0;
          data[nOff + 1] = nArr[v * 3 + 1] || 0;
          data[nOff + 2] = nArr[v * 3 + 2] || 0;
        }
      }
    }

    const buf = this.device.createBuffer({
      size: data.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(buf, 0, data);

    const onDispose = () => {
      g.off('dispose', onDispose);
      if (this._morphBufs.get(g) !== mt) return;
      mt.buf.destroy();
      this._morphBufs.delete(g);
      this._group1Cache.clear();
      r.info.memory.textures--;
    };
    mt = { buf, count, vCount, hasNormals, verSig, onDispose };
    this._morphBufs.set(g, mt);
    r.info.memory.textures++;
    g.on('dispose', onDispose);
    return mt;
  }

  getGroup1BindGroup(slabIdx, slabBuf, boneBuf, morphBuf) {
    const bId = this._bufId(boneBuf);
    const mId = this._bufId(morphBuf);
    const key = `${slabIdx}|${bId}|${mId}`;
    let bg = this._group1Cache.get(key);
    if (bg) return bg;

    bg = this.device.createBindGroup({
      layout: this.b.pipes.group1Layout,
      entries: [
        { binding: 0, resource: { buffer: slabBuf, offset: 0, size: OBJECT_UNIFORM_BYTES } },
        { binding: 1, resource: { buffer: boneBuf } },
        { binding: 2, resource: { buffer: morphBuf } },
      ],
    });
    this._group1Cache.set(key, bg);
    return bg;
  }

  _bufId(buf) {
    if (!buf._m3dId) buf._m3dId = ++GPUResources._nextId;
    return buf._m3dId;
  }

  // ───────── geometría e instancias ─────────
  getGeometry(g) {
    const r = this.b.renderer;
    let gg = this._geo.get(g);
    if (!gg) {
      const onDispose = () => {
        g.off('dispose', onDispose);
        if (this._geo.get(g) === gg) this.disposeGeometry(g);
      };
      gg = {
        geo: g,
        buffers: {},
        indexBuf: null,
        indexAttr: null,
        indexed: false,
        indexFormat: 'uint16',
        indexVersion: -1,
        indexByteSize: 0,
        count: 0,
        frame: -1,
        attrInfo: { hasNormal: false, hasUv: false, colorSize: 0, hasUv1: false },
        attrSig: '',
        wire: null,
        loopWire: null,
        onDispose,
      };
      this._geo.set(g, gg);
      r.info.memory.geometries++;
      g.on('dispose', onDispose);
    }
    if (gg.frame === r._frame) return gg;
    gg.frame = r._frame;

    const names = ['position', 'normal', 'uv', 'color', 'uv1', 'skinIndex', 'skinWeight'];
    let sig = '';
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const a = g.attributes[name];
      if (!a) {
        if (gg.buffers[name]) {
          gg.buffers[name].buf.destroy();
          delete gg.buffers[name];
        }
        continue;
      }
      sig += name + ':' + a.itemSize + ';';
      let b = gg.buffers[name];
      if (b && b.attr === a && b.version === a.version && b.itemSize === a.itemSize) {
        continue;
      }
      const padded = padFloatBytes(a.array);
      if (!b || b.byteSize < padded.byteLength) {
        if (b) b.buf.destroy();
        b = gg.buffers[name] = {
          buf: this.device.createBuffer({
            size: Math.max(16, padded.byteLength),
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
          }),
          byteSize: Math.max(16, padded.byteLength),
          attr: null,
          version: -1,
          itemSize: a.itemSize,
        };
      }
      this.device.queue.writeBuffer(b.buf, 0, padded);
      b.attr = a;
      b.version = a.version;
      b.itemSize = a.itemSize;
    }

    gg.attrInfo.hasNormal = !!g.attributes.normal;
    gg.attrInfo.hasUv = !!g.attributes.uv;
    gg.attrInfo.colorSize = g.attributes.color ? (g.attributes.color.itemSize === 3 ? 3 : 4) : 0;
    gg.attrInfo.hasUv1 = !!g.attributes.uv1;

    const ia = g.index;
    if (ia) {
      const paddedIdx = padFloatBytes(ia.array);
      if (!gg.indexBuf || gg.indexByteSize < paddedIdx.byteLength) {
        if (gg.indexBuf) gg.indexBuf.destroy();
        gg.indexBuf = this.device.createBuffer({
          size: Math.max(4, paddedIdx.byteLength),
          usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        });
        gg.indexByteSize = Math.max(4, paddedIdx.byteLength);
        gg.indexVersion = -1;
      }
      if (gg.indexAttr !== ia || gg.indexVersion !== ia.version) {
        this.device.queue.writeBuffer(gg.indexBuf, 0, paddedIdx);
        gg.indexAttr = ia;
        gg.indexVersion = ia.version;
        gg.indexFormat = ia.array instanceof Uint32Array ? 'uint32' : 'uint16';
      }
      gg.indexed = true;
      gg.count = ia.array.length;
    } else {
      if (gg.indexBuf) {
        gg.indexBuf.destroy();
        gg.indexBuf = null;
      }
      gg.indexAttr = null;
      gg.indexVersion = -1;
      gg.indexByteSize = 0;
      gg.indexed = false;
      gg.count = g.vertexCount;
    }
    gg.attrSig = sig + '|' + (gg.indexed ? '1' : '0');
    return gg;
  }

  getWire(gg, g) {
    let w = gg.wire;
    if (!w) {
      w = gg.wire = { buf: null, byteSize: 0, count: 0, version: -1, indexAttr: null, posAttr: null };
    }
    const idx = g.index ? g.index.array : null;
    const pos = g.attributes.position;
    const version = g.index ? g.index.version : pos.version;
    if (w.version !== version || w.indexAttr !== g.index || w.posAttr !== pos) {
      const tris = Math.floor((idx ? idx.length : pos.count) / 3);
      const lines = new Uint32Array(Math.max(2, tris * 6));
      if (idx) {
        for (let t = 0; t < tris; t++) {
          const i = t * 3, o = t * 6;
          lines[o] = idx[i]; lines[o + 1] = idx[i + 1];
          lines[o + 2] = idx[i + 1]; lines[o + 3] = idx[i + 2];
          lines[o + 4] = idx[i + 2]; lines[o + 5] = idx[i];
        }
      } else {
        for (let t = 0; t < tris; t++) {
          const i = t * 3, o = t * 6;
          lines[o] = i; lines[o + 1] = i + 1;
          lines[o + 2] = i + 1; lines[o + 3] = i + 2;
          lines[o + 4] = i + 2; lines[o + 5] = i;
        }
      }
      if (!w.buf || w.byteSize < lines.byteLength) {
        if (w.buf) w.buf.destroy();
        w.buf = this.device.createBuffer({
          size: Math.max(8, lines.byteLength),
          usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        });
        w.byteSize = Math.max(8, lines.byteLength);
      }
      this.device.queue.writeBuffer(w.buf, 0, lines);
      w.count = tris * 6;
      w.version = version;
      w.indexAttr = g.index;
      w.posAttr = pos;
    }
    return w;
  }

  getLineLoop(gg, g) {
    let lw = gg.loopWire;
    if (!lw) lw = gg.loopWire = { buf: null, byteSize: 0, count: 0, version: -1 };
    const idx = g.index ? g.index.array : null;
    const pos = g.attributes.position;
    const version = g.index ? g.index.version : pos.version;
    if (lw.version !== version) {
      const n = idx ? idx.length : pos.count;
      const out = new Uint32Array(Math.max(2, n * 2));
      for (let i = 0; i < n; i++) {
        const a = idx ? idx[i] : i;
        const b = idx ? idx[(i + 1) % n] : (i + 1) % n;
        out[i * 2] = a;
        out[i * 2 + 1] = b;
      }
      if (!lw.buf || lw.byteSize < out.byteLength) {
        if (lw.buf) lw.buf.destroy();
        lw.buf = this.device.createBuffer({ size: out.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
        lw.byteSize = out.byteLength;
      }
      this.device.queue.writeBuffer(lw.buf, 0, out);
      lw.count = n * 2;
      lw.version = version;
    }
    return lw;
  }

  disposeGeometry(g) {
    const gg = this._geo.get(g);
    if (!gg) return;
    if (gg.onDispose) g.off('dispose', gg.onDispose);
    for (const k in gg.buffers) gg.buffers[k].buf.destroy();
    if (gg.indexBuf) gg.indexBuf.destroy();
    if (gg.wire && gg.wire.buf) gg.wire.buf.destroy();
    if (gg.loopWire && gg.loopWire.buf) gg.loopWire.buf.destroy();
    this._geo.delete(g);
    this.b.renderer.info.memory.geometries--;
  }

  ensureInstanced(mesh, attr) {
    const r = this.b.renderer;
    let ig = this._inst.get(mesh);
    if (!ig) {
      const byteLength = Math.max(64, attr.array.byteLength);
      ig = {
        buf: this.device.createBuffer({ size: byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST }),
        culledBuf: null,
        culledByteLength: 0,
        byteLength,
        attr: null,
        version: -1,
        dead: false,
      };
      this._inst.set(mesh, ig);
      r.info.memory.instanceBuffers++;
      const geo = mesh.geometry;
      const free = () => {
        if (ig.dead) return; ig.dead = true;
        mesh.removeEventListener('dispose', free);
        geo.off('dispose', free);
        ig.buf.destroy();
        if (ig.culledBuf) ig.culledBuf.destroy();
        if (this._inst.get(mesh) === ig) this._inst.delete(mesh);
        r.info.memory.instanceBuffers--;
      };
      ig.free = free;
      mesh.addEventListener('dispose', free);
      geo.on('dispose', free);
    }
    return ig;
  }

  // ───────── texturas + mipmap generator ─────────
  _resolveKtx2Format(formatId, srgb) {
    const f = this.device.features;
    switch (formatId) {
      case 'astc-4x4': return f.has('texture-compression-astc') ? (srgb ? 'astc-4x4-unorm-srgb' : 'astc-4x4-unorm') : null;
      case 'bc7': return f.has('texture-compression-bc') ? (srgb ? 'bc7-rgba-unorm-srgb' : 'bc7-rgba-unorm') : null;
      case 'etc2-rgba': return f.has('texture-compression-etc2') ? (srgb ? 'etc2-rgba8unorm-srgb' : 'etc2-rgba8unorm') : null;
      case 'etc2-rgb': return f.has('texture-compression-etc2') ? (srgb ? 'etc2-rgb8unorm-srgb' : 'etc2-rgb8unorm') : null;
      case 'bc3': return f.has('texture-compression-bc') ? (srgb ? 'bc3-rgba-unorm-srgb' : 'bc3-rgba-unorm') : null;
      case 'bc1': return f.has('texture-compression-bc') ? (srgb ? 'bc1-rgba-unorm-srgb' : 'bc1-rgba-unorm') : null;
      default: return null;
    }
  }

  _generateMipmaps(gpuTex, format, w, h, mipCount) {
    if (mipCount <= 1) return;
    if (!this._mipSamp) {
      this._mipSamp = this.device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
    }
    if (!this._mipPipes) this._mipPipes = new Map();
    let pipe = this._mipPipes.get(format);
    if (!pipe) {
      const mod = this.b.pipes.getShaderModule(MIPMAP_BLIT_WGSL);
      pipe = this.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: mod, entryPoint: 'vs_main' },
        fragment: { module: mod, entryPoint: 'fs_main', targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      });
      this._mipPipes.set(format, pipe);
    }

    const enc = this.device.createCommandEncoder();
    for (let level = 1; level < mipCount; level++) {
      const srcView = gpuTex.createView({ baseMipLevel: level - 1, mipLevelCount: 1 });
      const dstView = gpuTex.createView({ baseMipLevel: level, mipLevelCount: 1 });
      const bg = this.device.createBindGroup({
        layout: pipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: srcView },
          { binding: 1, resource: this._mipSamp },
        ],
      });
      const pass = enc.beginRenderPass({
        colorAttachments: [{
          view: dstView,
          loadOp: 'clear',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          storeOp: 'store',
        }],
      });
      pass.setPipeline(pipe);
      pass.setBindGroup(0, bg);
      pass.draw(3);
      pass.end();
    }
    this.device.queue.submit([enc.finish()]);
  }

  getTextureResource(tex) {
    const r = this.b.renderer;
    if (!tex) return this.getWhiteTexture();
    if (tex.isRenderTargetTexture) {
      const rt = this.getTarget(tex.target);
      return { view: rt.view, sampler: this.getSampler(tex) };
    }

    let t = this._tex.get(tex);
    if (!t) {
      const onDispose = () => {
        tex.off('dispose', onDispose);
        if (this._tex.get(tex) !== t) return;
        if (t.gpuTex) t.gpuTex.destroy();
        this._tex.delete(tex);
        this._group2Cache.clear();
        this.b._group0Cache?.clear();
        r.info.memory.textures--;
      };
      t = { gpuTex: null, view: null, version: -1, loaded: false, srgb: null, uploading: false, _fallbackMip0: null, _fallbackVersion: -1, _fallbackDirty: false, onDispose };
      this._tex.set(tex, t);
      r.info.memory.textures++;
      tex.on('dispose', onDispose);
    }

    const srgb = r._colorSpace === 'srgb' && tex.colorSpace === 'srgb';
    if ((t.version !== tex.version || !t.loaded || t.srgb !== srgb || t._fallbackDirty) && tex.isReady() && !t.uploading) {
      this._uploadTexture(tex, t, srgb);
    }
    if (!t.view) return this.getWhiteTexture();
    return { view: t.view, sampler: this.getSampler(tex) };
  }

  _uploadTexture(tex, t, srgb) {
    const defaultFmt = srgb ? 'rgba8unorm-srgb' : 'rgba8unorm';
    if (tex.mipmaps && tex.mipmaps.length > 0) {
      if (t._fallbackVersion !== tex.version) {
        t._fallbackMip0 = null;
        t._fallbackRequested = false;
      }
      const w = tex.mipmaps[0].width || tex.width || 1;
      const h = tex.mipmaps[0].height || tex.height || 1;
      let fmt = defaultFmt;
      let isCompressed = false;
      if (tex.compressed && tex.formatId && !t._fallbackMip0) {
        const mapped = this._resolveKtx2Format(tex.formatId, srgb);
        if (mapped) { fmt = mapped; isCompressed = true; }
      }
      if (!isCompressed && tex.compressed && !t._fallbackMip0 && tex._decodeRgbaLevel0 && !t._fallbackRequested) {
        t._fallbackRequested = true;
        tex._decodeRgbaLevel0().then((mip0) => {
          if (!mip0) return;
          t._fallbackMip0 = mip0;
          t._fallbackVersion = tex.version;
          t._fallbackDirty = true;
          this._group2Cache.clear();
        }).catch(() => {
          t._fallbackRequested = false;
        });
        return;
      }

      const activeMipmaps = t._fallbackMip0 ? [t._fallbackMip0] : tex.mipmaps;
      const wantMips = !isCompressed && activeMipmaps.length === 1 && tex.minFilter === 'linear-mipmap'
        ? (Math.floor(Math.log2(Math.max(w, h))) + 1)
        : activeMipmaps.length;

      const dirty = tex._dirtyRect;
      if (
        dirty &&
        !isCompressed &&
        !tex.flipY &&
        activeMipmaps.length === 1 &&
        !t._fallbackMip0 &&
        t.gpuTex &&
        t.loaded &&
        t.srgb === srgb &&
        t.w === w &&
        t.h === h &&
        t.fmt === fmt &&
        t.wantMips === wantMips
      ) {
        const mip = activeMipmaps[0];
        const rx = Math.max(0, Math.min(w - 1, dirty.minX | 0));
        const ry = Math.max(0, Math.min(h - 1, dirty.minY | 0));
        const rx1 = Math.max(rx, Math.min(w - 1, dirty.maxX | 0));
        const ry1 = Math.max(ry, Math.min(h - 1, dirty.maxY | 0));
        const rw = rx1 - rx + 1;
        const rh = ry1 - ry + 1;

        this.device.queue.writeTexture(
          { texture: t.gpuTex, mipLevel: 0, origin: [rx, ry, 0] },
          mip.data,
          { offset: (ry * w + rx) * 4, bytesPerRow: w * 4, rowsPerImage: rh },
          [rw, rh, 1]
        );
        if (!tex._deferMipmaps && wantMips > 1) {
          this._generateMipmaps(t.gpuTex, fmt, w, h, wantMips);
        }
        t.version = tex.version;
        t._fallbackDirty = false;
        tex._dirtyRect = null;
        return;
      }

      if (t.gpuTex) t.gpuTex.destroy();
      const usage = isCompressed
        ? (GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST)
        : (GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT);

      t.gpuTex = this.device.createTexture({ size: [w, h, 1], mipLevelCount: wantMips, format: fmt, usage });

      const blockBytes = (fmt.startsWith('bc1') || fmt.startsWith('etc2-rgb')) ? 8 : 16;
      for (let level = 0; level < activeMipmaps.length; level++) {
        const mip = activeMipmaps[level];
        if (isCompressed) {
          const bw = Math.max(1, Math.ceil(mip.width / 4));
          const bh = Math.max(1, Math.ceil(mip.height / 4));
          this.device.queue.writeTexture(
            { texture: t.gpuTex, mipLevel: level },
            mip.data,
            { bytesPerRow: bw * blockBytes, rowsPerImage: bh },
            [Math.max(4, bw * 4), Math.max(4, bh * 4), 1]
          );
        } else {
          const srcData = tex.flipY ? flipRowsRgba(mip.data, mip.width, mip.height) : mip.data;
          this.device.queue.writeTexture(
            { texture: t.gpuTex, mipLevel: level },
            srcData,
            { bytesPerRow: mip.width * 4, rowsPerImage: mip.height },
            [mip.width, mip.height, 1]
          );
        }
      }
      if (wantMips > activeMipmaps.length && !isCompressed && !tex._deferMipmaps) {
        this._generateMipmaps(t.gpuTex, fmt, w, h, wantMips);
      }
      t.view = t.gpuTex.createView();
      t.w = w; t.h = h; t.fmt = fmt; t.wantMips = wantMips;
      t.version = tex.version; t.loaded = true; t.srgb = srgb; t._fallbackDirty = false;
      tex._dirtyRect = null;
      this._group2Cache.clear();
      return;
    }

    const img = tex.image;
    if (!img) return;
    const w = img.naturalWidth || img.videoWidth || img.width || 1;
    const h = img.naturalHeight || img.videoHeight || img.height || 1;
    const wantMips = tex.minFilter === 'linear-mipmap' ? (Math.floor(Math.log2(Math.max(w, h))) + 1) : 1;

    const uploadSource = (src, ownedBitmap) => {
      if (t.gpuTex) t.gpuTex.destroy();
      t.gpuTex = this.device.createTexture({
        size: [w, h, 1],
        mipLevelCount: wantMips,
        format: defaultFmt,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.device.queue.copyExternalImageToTexture(
        { source: src, flipY: ownedBitmap ? false : Boolean(tex.flipY) },
        { texture: t.gpuTex },
        [w, h, 1]
      );
      if (ownedBitmap && ownedBitmap.close) ownedBitmap.close();
      if (wantMips > 1) this._generateMipmaps(t.gpuTex, defaultFmt, w, h, wantMips);
      t.view = t.gpuTex.createView();
      t.version = tex.version; t.loaded = true; t.srgb = srgb;
      t.uploading = false;
      this._group2Cache.clear();
    };

    if (typeof HTMLCanvasElement !== 'undefined' && img instanceof HTMLCanvasElement
        || typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap) {
      uploadSource(img, null);
    } else if (typeof createImageBitmap === 'function') {
      t.uploading = true;
      const targetVer = tex.version;
      createImageBitmap(img, { imageOrientation: tex.flipY ? 'flipY' : 'from-image' })
        .then((bmp) => {
          if (tex.version !== targetVer) { bmp.close(); t.uploading = false; return; }
          uploadSource(bmp, bmp);
        })
        .catch(() => {
          t.uploading = false;
          if (typeof document !== 'undefined') {
            const cv = document.createElement('canvas');
            cv.width = w; cv.height = h;
            const cx = cv.getContext('2d');
            if (cx) { cx.drawImage(img, 0, 0, w, h); uploadSource(cv, null); }
          }
        });
    } else if (typeof document !== 'undefined') {
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const cx = cv.getContext('2d');
      if (cx) { cx.drawImage(img, 0, 0, w, h); uploadSource(cv, null); }
    }
  }

  getGroup2BindGroup(material, texMask, matSlot) {
    if (texMask === 0) {
      let fast = this._matBg2Fast.get(material);
      if (!fast) {
        fast = [];
        this._matBg2Fast.set(material, fast);
      }
      if (fast[matSlot.slabIdx]) return fast[matSlot.slabIdx];
    }

    const ids = [matSlot.slabIdx];
    const entries = [
      { binding: 0, resource: { buffer: matSlot.buffer, offset: 0, size: MATERIAL_UNIFORM_BYTES } },
    ];
    const slots = [
      [1, 'map', 1, 2],
      [2, 'normalMap', 3, 4],
      [4, 'emissiveMap', 5, 6],
      [8, 'aoMap', 7, 8],
      [16, 'metallicRoughnessMap', 9, 10],
      [32, 'matcap', 11, 12],
      [64, 'roughnessMap', 13, 14],
      [128, 'metalnessMap', 15, 16],
    ];
    for (let i = 0; i < slots.length; i++) {
      const [bit, prop, tb, sb] = slots[i];
      if (texMask & bit) {
        const texObj = material[prop] || material.uniforms['u' + prop[0].toUpperCase() + prop.slice(1)] || null;
        const tr = this.getTextureResource(texObj);
        if (!tr.view._m3dId) tr.view._m3dId = ++GPUResources._nextId;
        if (!tr.sampler._m3dId) tr.sampler._m3dId = ++GPUResources._nextId;
        ids.push(tr.view._m3dId, tr.sampler._m3dId);
        entries.push({ binding: tb, resource: tr.view });
        entries.push({ binding: sb, resource: tr.sampler });
      }
    }

    const key = `${texMask}|${ids.join(',')}`;
    let bg = this._group2Cache.get(key);
    if (bg) {
      if (texMask === 0) this._matBg2Fast.get(material)[matSlot.slabIdx] = bg;
      return bg;
    }

    bg = this.device.createBindGroup({
      layout: this.b.pipes.getGroup2Layout(texMask),
      entries,
    });
    this._group2Cache.set(key, bg);
    if (texMask === 0) this._matBg2Fast.get(material)[matSlot.slabIdx] = bg;
    return bg;
  }

  writeMaterialUniforms(material, slot) {
    const buf = slot.slab.cpu;
    const o = slot.floatOffset;
    const u = material.uniforms || {};

    const col = material.color || u.uColor;
    buf[o + 0] = col ? (col.r ?? 1) : 1;
    buf[o + 1] = col ? (col.g ?? 1) : 1;
    buf[o + 2] = col ? (col.b ?? 1) : 1;
    buf[o + 3] = material.opacity ?? u.uOpacity ?? 1;

    const em = material.emissive || material.inkColor || u.uEmissive || u.uInkColor;
    buf[o + 4] = em ? (em.r ?? 0) : 0;
    buf[o + 5] = em ? (em.g ?? 0) : 0;
    buf[o + 6] = em ? (em.b ?? 0) : 0;
    buf[o + 7] = material.alphaTest ?? u.uAlphaCutoff ?? 0;

    const ex0 = material.shadowColor || material.stripeColor || material.edgeColor || u.uShadowColor || u.uStripeColor || u.uEdgeColor;
    buf[o + 8] = ex0 ? (ex0.r ?? 0) : 0;
    buf[o + 9] = ex0 ? (ex0.g ?? 0) : 0;
    buf[o + 10] = ex0 ? (ex0.b ?? 0) : 0;
    buf[o + 11] = material.shininess ?? u.uShininess ?? 0;

    const ex1 = material.rimColor || u.uRimColor;
    buf[o + 12] = ex1 ? (ex1.r ?? 1) : 1;
    buf[o + 13] = ex1 ? (ex1.g ?? 1) : 1;
    buf[o + 14] = ex1 ? (ex1.b ?? 1) : 1;
    buf[o + 15] = material.specular ?? u.uSpecular ?? 1;

    buf[o + 16] = material.roughness ?? u.uRoughness ?? 1;
    buf[o + 17] = material.metalness ?? u.uMetalness ?? 0;
    buf[o + 18] = material.normalScale ? material.normalScale.x : 1;
    buf[o + 19] = material.normalScale ? material.normalScale.y : 1;

    // params0 & params1 según tipo de material
    const t = material.type;
    if (t === 'toon') {
      buf[o + 20] = material.steps ?? 3;
      buf[o + 21] = material.smoothness ?? 0.06;
      buf[o + 22] = material.shadowTint ?? 0.45;
      buf[o + 23] = material.rimPower ?? 3.5;
      buf[o + 24] = material.rimStrength ?? 0.7;
      buf[o + 25] = material.inkWidth ?? 0.22;
    } else if (t === 'hologram') {
      buf[o + 20] = material.fresnelPower ?? 2.2;
      buf[o + 21] = material.scanlineDensity ?? 18;
      buf[o + 22] = material.scanlineSpeed ?? 2.4;
      buf[o + 23] = material.glitchStrength ?? 0.35;
    } else if (t === 'fresnel') {
      buf[o + 20] = material.fresnelPower ?? 2.6;
      buf[o + 21] = material.fresnelIntensity ?? 1.6;
      buf[o + 22] = material.iridescence ?? 0.55;
      buf[o + 23] = material.pulseSpeed ?? 1.8;
    } else if (t === 'dissolve') {
      buf[o + 20] = material.progress ?? 0.35;
      buf[o + 21] = material.autoAnimate ? 1 : 0;
      buf[o + 22] = material.speed ?? 0.45;
      buf[o + 23] = material.edgeWidth ?? 0.09;
      buf[o + 24] = material.noiseScale ?? 3.8;
    } else if (t === 'matcap') {
      buf[o + 24] = material.glossiness ?? 0.55;
      buf[o + 25] = material.metalness ?? 0.25;
    } else {
      buf[o + 20] = material.aoMapIntensity ?? 1;
      buf[o + 21] = material.envMapIntensity ?? u.uEnvMapIntensity ?? 1;
    }

    const writeMat3 = (dstOffset, m3, flipRtV) => {
      const m = m3 || IDENTITY_UV_MAT;
      buf[dstOffset + 0] = m[0];
      buf[dstOffset + 1] = flipRtV ? -m[1] : m[1];
      buf[dstOffset + 2] = m[2];
      buf[dstOffset + 3] = 0;
      buf[dstOffset + 4] = m[3];
      buf[dstOffset + 5] = flipRtV ? -m[4] : m[4];
      buf[dstOffset + 6] = m[5];
      buf[dstOffset + 7] = 0;
      buf[dstOffset + 8] = m[6];
      buf[dstOffset + 9] = flipRtV ? 1 - m[7] : m[7];
      buf[dstOffset + 10] = m[8];
      buf[dstOffset + 11] = 0;
    };

    writeMat3(o + 28, u.uUvMatrix, Boolean((material.map || u.uMap)?.isRenderTargetTexture));
    writeMat3(o + 40, u.uNormalUvMatrix, Boolean((material.normalMap || u.uNormalMap)?.isRenderTargetTexture));
    writeMat3(o + 52, u.uEmissiveUvMatrix, Boolean((material.emissiveMap || u.uEmissiveMap)?.isRenderTargetTexture));
    writeMat3(o + 64, u.uAoUvMatrix, Boolean((material.aoMap || u.uAoMap)?.isRenderTargetTexture));
    writeMat3(o + 76, u.uMrUvMatrix, Boolean((material.metallicRoughnessMap || u.uMetallicRoughnessMap)?.isRenderTargetTexture));
    writeMat3(o + 88, u.uRoughnessUvMatrix, Boolean((material.roughnessMap || u.uRoughnessMap)?.isRenderTargetTexture));
    writeMat3(o + 100, u.uMetalnessUvMatrix, Boolean((material.metalnessMap || u.uMetalnessMap)?.isRenderTargetTexture));
  }

  disposeAll() {
    this.objArena.dispose();
    this.matArena.dispose();
    this.dummyBoneBuf.destroy();
    this.dummyMorphBuf.destroy();
    if (this._whiteTex) { this._whiteTex.destroy(); this._whiteTex = null; }
    if (this._depthTex) { this._depthTex.destroy(); this._depthTex = null; }
    if (this._recDepthTex) { this._recDepthTex.destroy(); this._recDepthTex = null; }
    for (const rt of [...this._targetList]) this.disposeTarget(rt);
    for (const l of [...this._shadows.keys()]) this.disposeShadowMap(l);
  }
}

GPUResources._nextId = 0;
