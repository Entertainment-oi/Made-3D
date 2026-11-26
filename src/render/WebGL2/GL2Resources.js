export const LOC = { position: 0, normal: 1, uv: 2, color: 7, skinIndex: 8, skinWeight: 9, uv1: 10 };
export const INST = 3; // aInstance ocupa las ubicaciones 3..6

export class ShadowTexture {
  constructor(map) {
    this.isTexture = true;
    this.isShadowTexture = true;
    this.map = map;
    this.version = 0;
    this.colorSpace = 'linear';
  }
  isReady() { return true; }
  set needsUpdate(_v) { /* la sombra se redibuja cada cuadro */ }
}

export class GL2Resources {
  constructor(backend) {
    this.b = backend;
    this.reset();
  }

  reset() {
    this._geo = new WeakMap();
    this._tex = new WeakMap();
    this._inst = new WeakMap();
    this._boneTex = new WeakMap();
    this._morphTex = new WeakMap();
    this._targets = new WeakMap();
    this._targetList = new Set();
    this._shadows = new Map();
    this._white = null;
    this._morphWeightsBuf = new Float32Array(32);
    this._unitTex = [];
    this._vao = null;
  }

  bindVAO(v) {
    if (this._vao !== v) {
      this.b.gl.bindVertexArray(v);
      this._vao = v;
    }
  }

  bindTex2D(unit, glTex) {
    if (this._unitTex[unit] === glTex) return false;
    const gl = this.b.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, glTex);
    this._unitTex[unit] = glTex;
    return true;
  }

  forgetTex(glTex) {
    for (let i = 0; i < this._unitTex.length; i++) {
      if (this._unitTex[i] === glTex) this._unitTex[i] = null;
    }
  }

  // ───────── render targets ─────────
  applyTargetSampler(rt, t, unit = 0) {
    const gl = this.b.gl, tex = rt.texture;
    const key = `${tex.version}|${tex.wrapS}|${tex.wrapT}|${tex.minFilter}|${tex.magFilter}`;
    if (t.samplerKey === key) return;
    const wrap = { repeat: gl.REPEAT, clamp: gl.CLAMP_TO_EDGE, mirror: gl.MIRRORED_REPEAT };
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    this._unitTex[unit] = t.tex;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap[tex.wrapS] || gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap[tex.wrapT] || gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, tex.magFilter === 'nearest' ? gl.NEAREST : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, tex.minFilter === 'nearest' ? gl.NEAREST : gl.LINEAR);
    t.samplerKey = key;
  }

  getTarget(rt, unit = 0) {
    const gl = this.b.gl, r = this.b.renderer;
    let t = this._targets.get(rt), created = false;
    if (!t) {
      const onDispose = () => {
        rt.off('dispose', onDispose);
        if (this._targets.get(rt) === t) this.disposeTarget(rt);
      };
      t = { fbo: gl.createFramebuffer(), tex: gl.createTexture(), depth: null, w: 0, h: 0, samplerKey: '', onDispose };
      this._targets.set(rt, t);
      this._targetList.add(rt);
      created = true;
      rt.on('dispose', onDispose);
    }
    const size = r.clampRenderSize(rt.width, rt.height, { depthBuffer: rt.depthBuffer !== false, forTarget: true });
    const tw = size.width, th = size.height;
    if (t.w !== tw || t.h !== th) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      this._unitTex[unit] = t.tex;
      const srgb = rt.colorSpace !== 'linear';
      gl.texImage2D(gl.TEXTURE_2D, 0, srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8, tw, th, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      t.samplerKey = '';
      this.applyTargetSampler(rt, t, unit);
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
      if (rt.depthBuffer) {
        if (!t.depth) t.depth = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, t.depth);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, tw, th);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, t.depth);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      t.w = tw; t.h = th;
      if (created) r.info.memory.textures++;
    }
    return t;
  }

  disposeTarget(rt) {
    const gl = this.b.gl, t = this._targets.get(rt);
    if (!t) return;
    if (t.onDispose) rt.off('dispose', t.onDispose);
    this.forgetTex(t.tex);
    gl.deleteFramebuffer(t.fbo);
    gl.deleteTexture(t.tex);
    if (t.depth) gl.deleteRenderbuffer(t.depth);
    this._targets.delete(rt);
    this._targetList.delete(rt);
    this.b.renderer.info.memory.textures--;
    if (this.b.renderer._rt === rt) this.b.renderer._rt = null;
  }

  // ───────── shadow map ─────────
  getShadowMap(light) {
    const gl = this.b.gl;
    const size = this.b.getShadowMapSize(light);
    let sm = this._shadows.get(light);
    if (sm && sm.size !== size) { this.disposeShadowMap(light); sm = null; }
    if (sm) return sm;
    sm = { size, fbo: gl.createFramebuffer(), tex: gl.createTexture(), color: null, texture: null };
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sm.tex);
    this._unitTex[0] = sm.tex;
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, size, size, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    gl.bindFramebuffer(gl.FRAMEBUFFER, sm.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, sm.tex, 0);
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      sm.color = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, sm.color);
      this._unitTex[0] = sm.color;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, sm.color, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    sm.texture = new ShadowTexture(sm);
    this._shadows.set(light, sm);
    return sm;
  }

  disposeShadowMap(light) {
    const gl = this.b.gl, sm = this._shadows.get(light);
    if (!sm) return;
    this.forgetTex(sm.tex);
    if (sm.color) this.forgetTex(sm.color);
    gl.deleteFramebuffer(sm.fbo);
    gl.deleteTexture(sm.tex);
    if (sm.color) gl.deleteTexture(sm.color);
    this._shadows.delete(light);
  }

  // ───────── morphs & skinning ─────────
  getMorphData(g, unit = 0) {
    const gl = this.b.gl, r = this.b.renderer;
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

    let mt = this._morphTex.get(g);
    if (mt && mt.verSig === verSig) return mt;
    if (mt) {
      if (mt.onDispose) g.off('dispose', mt.onDispose);
      this.forgetTex(mt.tex);
      gl.deleteTexture(mt.tex);
      this._morphTex.delete(g);
      r.info.memory.textures--;
    }

    const stride = hasNormals ? 2 : 1;
    const totalTexels = Math.max(1, count * vCount * stride);
    const texWidth = Math.min(2048, totalTexels);
    const texHeight = Math.ceil(totalTexels / texWidth);
    const data = new Float32Array(texWidth * texHeight * 4);

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

    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    this._unitTex[unit] = tex;
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, texWidth, texHeight, 0, gl.RGBA, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const onDispose = () => {
      g.off('dispose', onDispose);
      if (this._morphTex.get(g) !== mt) return;
      this.forgetTex(mt.tex);
      gl.deleteTexture(mt.tex);
      this._morphTex.delete(g);
      r.info.memory.textures--;
    };
    mt = { tex, count, vCount, texWidth, hasNormals, verSig, onDispose };
    this._morphTex.set(g, mt);
    r.info.memory.textures++;
    g.on('dispose', onDispose);
    return mt;
  }

  setMorphUniforms(p, mesh) {
    const gl = this.b.gl;
    const ut = p.byName.uMorphTexture;
    const mt = this.getMorphData(mesh.geometry, ut ? ut.unit : 0);
    if (ut) this.bindTex2D(ut.unit, mt.tex);
    if (p.byName.uMorphCount) gl.uniform1i(p.byName.uMorphCount.loc, mt.count);
    if (p.byName.uMorphVertexCount) gl.uniform1i(p.byName.uMorphVertexCount.loc, mt.vCount);
    if (p.byName.uMorphTexWidth) gl.uniform1i(p.byName.uMorphTexWidth.loc, mt.texWidth);
    if (p.byName.uMorphHasNormals) gl.uniform1i(p.byName.uMorphHasNormals.loc, mt.hasNormals);
    if (p.byName.uMorphRelative) gl.uniform1i(p.byName.uMorphRelative.loc, mesh.geometry.morphTargetsRelative === false ? 0 : 1);
    if (p.byName.uMorphWeights) {
      const wb = this._morphWeightsBuf;
      wb.fill(0);
      const inf = mesh.morphTargetInfluences;
      const n = Math.min(mt.count, inf.length);
      for (let i = 0; i < n; i++) wb[i] = inf[i] || 0;
      gl.uniform1fv(p.byName.uMorphWeights.loc, wb);
    }
  }

  setSkinUniforms(p, mesh) {
    const gl = this.b.gl, ub = p.byName.uBoneTexture, um = p.byName.uBindMatrix;
    if (ub) this.bindBoneTexture(mesh.skeleton, ub.unit);
    if (um) gl.uniformMatrix4fv(um.loc, false, mesh.bindMatrix.elements);
  }

  bindBoneTexture(sk, unit) {
    const gl = this.b.gl, T = gl.TEXTURE_2D, n = sk.bones.length;
    let b = this._boneTex.get(sk);
    if (!b) {
      const onDispose = () => {
        sk.off('dispose', onDispose);
        if (this._boneTex.get(sk) !== b) return;
        this.forgetTex(b.tex);
        gl.deleteTexture(b.tex); this._boneTex.delete(sk); this.b.renderer.info.memory.textures--;
      };
      b = { tex: gl.createTexture(), version: -1, n: 0, onDispose };
      this._boneTex.set(sk, b);
      this.b.renderer.info.memory.textures++;
      sk.on('dispose', onDispose);
    }
    if (b.n !== n) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(T, b.tex);
      this._unitTex[unit] = b.tex;
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(T, 0, gl.RGBA32F, 4, n, 0, gl.RGBA, gl.FLOAT, sk.boneMatrices);
      gl.texParameteri(T, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(T, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(T, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(T, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      b.n = n; b.version = sk.version;
    } else if (b.version !== sk.version) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(T, b.tex);
      this._unitTex[unit] = b.tex;
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texSubImage2D(T, 0, 0, 0, 4, n, gl.RGBA, gl.FLOAT, sk.boneMatrices);
      b.version = sk.version;
    } else {
      this.bindTex2D(unit, b.tex);
    }
  }

  // ───────── geometría e instancias ─────────
  getGeometry(g) {
    const gl = this.b.gl, r = this.b.renderer;
    let gg = this._geo.get(g);
    if (!gg) {
      const onDispose = () => {
        g.off('dispose', onDispose);
        if (this._geo.get(g) === gg) this.disposeGeometry(g);
      };
      gg = { geo: g, vao: gl.createVertexArray(), buffers: {}, indexBuf: null, indexAttr: null, indexed: false, indexType: 0, indexVersion: -1, count: 0, frame: -1, attrSig: '', onDispose };
      this._geo.set(g, gg);
      r.info.memory.geometries++;
      g.on('dispose', onDispose);
    }
    if (gg.frame === r._frame) return gg;
    gg.frame = r._frame;
    this.bindVAO(gg.vao);
    let sig = '';
    for (const name in g.attributes) {
      const loc = LOC[name];
      if (loc === undefined) continue;
      const a = g.attributes[name];
      sig += name + ':' + a.itemSize + ';';
      let b = gg.buffers[name];
      if (!b) {
        b = gg.buffers[name] = { buf: gl.createBuffer(), attr: null, version: -1, itemSize: a.itemSize, loc };
        gl.bindBuffer(gl.ARRAY_BUFFER, b.buf);
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, a.itemSize, gl.FLOAT, false, 0, 0);
      } else if (b.itemSize !== a.itemSize) {
        gl.bindBuffer(gl.ARRAY_BUFFER, b.buf);
        gl.vertexAttribPointer(loc, a.itemSize, gl.FLOAT, false, 0, 0);
        b.itemSize = a.itemSize;
      }
      if (b.attr !== a || b.version !== a.version) {
        gl.bindBuffer(gl.ARRAY_BUFFER, b.buf);
        gl.bufferData(gl.ARRAY_BUFFER, a.array, gl.STATIC_DRAW);
        b.attr = a;
        b.version = a.version;
      }
    }
    for (const name in gg.buffers) {
      if (!g.attributes[name]) {
        gl.disableVertexAttribArray(gg.buffers[name].loc);
        gl.deleteBuffer(gg.buffers[name].buf);
        delete gg.buffers[name];
      }
    }
    const ia = g.index;
    if (ia) {
      if (!gg.indexBuf) {
        gg.indexBuf = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gg.indexBuf);
      } else if (gg.indexAttr !== ia || gg.indexVersion !== ia.version) {
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gg.indexBuf);
      }
      if (gg.indexAttr !== ia || gg.indexVersion !== ia.version) {
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, ia.array, gl.STATIC_DRAW);
        gg.indexAttr = ia;
        gg.indexVersion = ia.version;
        gg.indexType = ia.array instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
      }
      gg.indexed = true; gg.count = ia.array.length;
    } else {
      if (gg.indexBuf) {
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
        gl.deleteBuffer(gg.indexBuf);
        gg.indexBuf = null;
        gg.indexAttr = null;
        gg.indexVersion = -1;
      }
      gg.indexed = false; gg.count = g.vertexCount;
    }
    gg.attrSig = sig + '|' + (gg.indexed ? '1' : '0');
    return gg;
  }

  getWire(gg, g) {
    const gl = this.b.gl;
    let w = gg.wire;
    if (!w) {
      w = gg.wire = { vao: gl.createVertexArray(), buf: gl.createBuffer(), count: 0, version: -1, indexAttr: null, posAttr: null, attrs: '' };
    }
    const idx = g.index ? g.index.array : null;
    const pos = g.attributes.position;
    const version = g.index ? g.index.version : pos.version;
    const attrs = gg.attrSig;
    if (w.version !== version || w.indexAttr !== g.index || w.posAttr !== pos || w.attrs !== attrs) {
      const tris = Math.floor((idx ? idx.length : pos.count) / 3);
      const lines = new Uint32Array(tris * 6);
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
      this.bindVAO(w.vao);
      for (const k in LOC) {
        const b = gg.buffers[k];
        if (!b) {
          gl.disableVertexAttribArray(LOC[k]);
          continue;
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, b.buf);
        gl.enableVertexAttribArray(b.loc);
        gl.vertexAttribPointer(b.loc, b.itemSize, gl.FLOAT, false, 0, 0);
      }
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, w.buf);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, lines, gl.STATIC_DRAW);
      w.count = lines.length;
      w.version = version;
      w.indexAttr = g.index;
      w.posAttr = pos;
      w.attrs = attrs;
    }
    return w;
  }

  disposeGeometry(g) {
    const gl = this.b.gl, gg = this._geo.get(g);
    if (!gg) return;
    if (gg.onDispose) g.off('dispose', gg.onDispose);
    for (const k in gg.buffers) gl.deleteBuffer(gg.buffers[k].buf);
    if (gg.indexBuf) gl.deleteBuffer(gg.indexBuf);
    gl.deleteVertexArray(gg.vao);
    if (gg.wire) { gl.deleteBuffer(gg.wire.buf); gl.deleteVertexArray(gg.wire.vao); }
    if (this._vao === gg.vao) this._vao = null;
    if (gg.wire && this._vao === gg.wire.vao) this._vao = null;
    this._geo.delete(g);
    this.b.renderer.info.memory.geometries--;
  }

  bindInstancedVAO(vao, gg, buf, indexBuf) {
    const gl = this.b.gl;
    this.bindVAO(vao);
    for (const k in LOC) {
      const b = gg.buffers[k];
      if (!b) {
        gl.disableVertexAttribArray(LOC[k]);
        continue;
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, b.buf);
      gl.enableVertexAttribArray(b.loc);
      gl.vertexAttribPointer(b.loc, b.itemSize, gl.FLOAT, false, 0, 0);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuf || null);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    for (let i = 0; i < 4; i++) {
      gl.enableVertexAttribArray(INST + i);
      gl.vertexAttribPointer(INST + i, 4, gl.FLOAT, false, 64, i * 16);
      gl.vertexAttribDivisor(INST + i, 1);
    }
  }

  createInstanced(mesh, gg, attr) {
    const gl = this.b.gl, r = this.b.renderer;
    const ig = {
      vao: gl.createVertexArray(), wireVao: null, wireSig: '', buf: gl.createBuffer(),
      attr: null, version: -1, full: false, byteLength: attr.array.byteLength, attrSig: gg.attrSig, dead: false,
    };
    gl.bindBuffer(gl.ARRAY_BUFFER, ig.buf);
    gl.bufferData(gl.ARRAY_BUFFER, ig.byteLength, gl.DYNAMIC_DRAW);
    this.bindInstancedVAO(ig.vao, gg, ig.buf, gg.indexed ? gg.indexBuf : null);
    this._inst.set(mesh, ig);
    r.info.memory.instanceBuffers++;
    const geo = mesh.geometry;
    const free = () => {
      if (ig.dead) return; ig.dead = true;
      mesh.removeEventListener('dispose', free);
      geo.off('dispose', free);
      gl.deleteBuffer(ig.buf); gl.deleteVertexArray(ig.vao);
      if (ig.wireVao) gl.deleteVertexArray(ig.wireVao);
      if (this._vao === ig.vao || (ig.wireVao && this._vao === ig.wireVao)) this._vao = null;
      if (this._inst.get(mesh) === ig) this._inst.delete(mesh);
      r.info.memory.instanceBuffers--;
    };
    ig.free = free;
    mesh.addEventListener('dispose', free);
    geo.on('dispose', free);
    return ig;
  }

  ensureInstanced(mesh, gg, attr) {
    let ig = this._inst.get(mesh);
    if (!ig) return this.createInstanced(mesh, gg, attr);
    if (ig.attrSig !== gg.attrSig) {
      this.bindInstancedVAO(ig.vao, gg, ig.buf, gg.indexed ? gg.indexBuf : null);
      ig.attrSig = gg.attrSig;
      ig.wireSig = '';
    }
    return ig;
  }

  // ───────── texturas ─────────
  bindTexture(tex, unit) {
    const gl = this.b.gl, r = this.b.renderer;
    if (!tex) {
      if (!this._white) {
        this._white = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, this._white);
        this._unitTex[unit] = this._white;
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      } else {
        this.bindTex2D(unit, this._white);
      }
      return;
    }
    if (tex.isShadowTexture) {
      this.bindTex2D(unit, tex.map.tex);
      return;
    }
    if (tex.isRenderTargetTexture) {
      const t = this.getTarget(tex.target, unit);
      this.applyTargetSampler(tex.target, t, unit);
      this.bindTex2D(unit, t.tex);
      return;
    }
    let t = this._tex.get(tex);
    if (!t) {
      const onDispose = () => {
        tex.off('dispose', onDispose);
        if (this._tex.get(tex) !== t) return;
        this.forgetTex(t.tex);
        gl.deleteTexture(t.tex); this._tex.delete(tex); r.info.memory.textures--;
      };
      t = { tex: gl.createTexture(), version: -1, loaded: false, srgb: null, w: 0, h: 0, compressed: false, mipLen: 0, minFilterMode: null, onDispose };
      this._tex.set(tex, t);
      r.info.memory.textures++;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      this._unitTex[unit] = t.tex;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      tex.on('dispose', onDispose);
    }
    const srgb = r._colorSpace === 'srgb' && tex.colorSpace === 'srgb';
    if ((t.version !== tex.version || !t.loaded || t.srgb !== srgb) && tex.isReady()) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      this._unitTex[unit] = t.tex;
      this.uploadTexture(tex, t, srgb);
    } else {
      this.bindTex2D(unit, t.tex);
    }
  }

  uploadTexture(tex, t, srgb) {
    const gl = this.b.gl, T = gl.TEXTURE_2D;
    const dirty = tex._dirtyRect;
    if (
      dirty &&
      t.loaded &&
      t.srgb === srgb &&
      !t.compressed &&
      !tex.compressed &&
      !tex.flipY &&
      tex.mipmaps &&
      tex.mipmaps.length === 1 &&
      t.mipLen === 1 &&
      t.w === tex.mipmaps[0].width &&
      t.h === tex.mipmaps[0].height
    ) {
      const mip = tex.mipmaps[0];
      const rx = Math.max(0, Math.min(mip.width - 1, dirty.minX | 0));
      const ry = Math.max(0, Math.min(mip.height - 1, dirty.minY | 0));
      const rx1 = Math.max(rx, Math.min(mip.width - 1, dirty.maxX | 0));
      const ry1 = Math.max(ry, Math.min(mip.height - 1, dirty.maxY | 0));
      const rw = rx1 - rx + 1;
      const rh = ry1 - ry + 1;

      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, mip.width);
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, rx);
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, ry);
      gl.texSubImage2D(T, 0, rx, ry, rw, rh, gl.RGBA, gl.UNSIGNED_BYTE, mip.data);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);

      let min;
      let nextMode;
      if (tex._deferMipmaps) {
        min = tex.minFilter === 'nearest' ? gl.NEAREST : gl.LINEAR;
        nextMode = `defer:${min}`;
        if (t.minFilterMode !== nextMode) {
          gl.texParameteri(T, gl.TEXTURE_MAX_LEVEL, 0);
          gl.texParameteri(T, gl.TEXTURE_MIN_FILTER, min);
          t.minFilterMode = nextMode;
        }
      } else if (tex.minFilter === 'linear-mipmap') {
        gl.texParameteri(T, gl.TEXTURE_MAX_LEVEL, 1000);
        gl.generateMipmap(T);
        min = gl.LINEAR_MIPMAP_LINEAR;
        gl.texParameteri(T, gl.TEXTURE_MIN_FILTER, min);
        t.minFilterMode = 'mipmap';
      } else {
        min = tex.minFilter === 'nearest' ? gl.NEAREST : gl.LINEAR;
        nextMode = `flat:${min}`;
        if (t.minFilterMode !== nextMode) {
          gl.texParameteri(T, gl.TEXTURE_MAX_LEVEL, 0);
          gl.texParameteri(T, gl.TEXTURE_MIN_FILTER, min);
          t.minFilterMode = nextMode;
        }
      }
      t.version = tex.version;
      tex._dirtyRect = null;
      return;
    }

    const wrap = { repeat: gl.REPEAT, clamp: gl.CLAMP_TO_EDGE, mirror: gl.MIRRORED_REPEAT };
    gl.texParameteri(T, gl.TEXTURE_WRAP_S, wrap[tex.wrapS] || gl.REPEAT);
    gl.texParameteri(T, gl.TEXTURE_WRAP_T, wrap[tex.wrapT] || gl.REPEAT);
    gl.texParameteri(T, gl.TEXTURE_MAG_FILTER, tex.magFilter === 'nearest' ? gl.NEAREST : gl.LINEAR);

    let min = gl.LINEAR;
    if (tex.mipmaps && tex.mipmaps.length > 0) {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, tex.compressed ? false : tex.flipY);
      if (tex.compressed) {
        const fmt = (srgb && tex.srgbFormat) ? tex.srgbFormat : tex.format;
        for (let level = 0; level < tex.mipmaps.length; level++) {
          const mip = tex.mipmaps[level];
          gl.compressedTexImage2D(T, level, fmt, mip.width, mip.height, 0, mip.data);
        }
      } else {
        const fmt = srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8;
        for (let level = 0; level < tex.mipmaps.length; level++) {
          const mip = tex.mipmaps[level];
          gl.texImage2D(T, level, fmt, mip.width, mip.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, mip.data);
        }
      }
      gl.texParameteri(T, gl.TEXTURE_BASE_LEVEL, 0);
      if (tex.mipmaps.length > 1) {
        gl.texParameteri(T, gl.TEXTURE_MAX_LEVEL, tex.mipmaps.length - 1);
        min = tex.minFilter === 'nearest' ? gl.NEAREST : tex.minFilter === 'linear' ? gl.LINEAR : gl.LINEAR_MIPMAP_LINEAR;
      } else if (!tex.compressed && !tex._deferMipmaps && tex.minFilter === 'linear-mipmap') {
        gl.texParameteri(T, gl.TEXTURE_MAX_LEVEL, 1000);
        gl.generateMipmap(T);
        min = gl.LINEAR_MIPMAP_LINEAR;
      } else {
        gl.texParameteri(T, gl.TEXTURE_MAX_LEVEL, 0);
        min = tex.minFilter === 'nearest' ? gl.NEAREST : gl.LINEAR;
      }
      t.w = tex.mipmaps[0].width;
      t.h = tex.mipmaps[0].height;
      t.compressed = Boolean(tex.compressed);
      t.mipLen = tex.mipmaps.length;
    } else {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, tex.flipY);
      gl.texImage2D(T, 0, srgb ? gl.SRGB8_ALPHA8 : gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, tex.image);
      gl.texParameteri(T, gl.TEXTURE_BASE_LEVEL, 0);
      gl.texParameteri(T, gl.TEXTURE_MAX_LEVEL, 1000);
      if (tex.minFilter === 'nearest') min = gl.NEAREST;
      else if (tex.minFilter === 'linear-mipmap') { gl.generateMipmap(T); min = gl.LINEAR_MIPMAP_LINEAR; }
      t.w = tex.image?.naturalWidth || tex.image?.videoWidth || tex.image?.width || 0;
      t.h = tex.image?.naturalHeight || tex.image?.videoHeight || tex.image?.height || 0;
      t.compressed = false;
      t.mipLen = 0;
    }

    gl.texParameteri(T, gl.TEXTURE_MIN_FILTER, min);
    t.minFilterMode = null;
    if (this.b._aniso && min === gl.LINEAR_MIPMAP_LINEAR) {
      gl.texParameterf(T, this.b._aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(4, gl.getParameter(this.b._aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
    }
    t.version = tex.version; t.loaded = true; t.srgb = srgb;
    tex._dirtyRect = null;
  }

  disposeAll() {
    const gl = this.b.gl;
    if (this._white) { gl.deleteTexture(this._white); this._white = null; }
    for (const rt of [...this._targetList]) this.disposeTarget(rt);
    for (const l of [...this._shadows.keys()]) this.disposeShadowMap(l);
  }
}
