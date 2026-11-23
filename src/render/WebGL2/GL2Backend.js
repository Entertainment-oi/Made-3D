import { Program, setUniform } from './GL2Program.js';
import { LOC, GL2Resources } from './GL2Resources.js';
import { GL2Outline } from './GL2Outline.js';
import { buildSource } from '../../shaders/GLSL/prelude.js';
import { SHADOW_VERT, SHADOW_FRAG } from '../../shaders/GLSL/builtin.js';

const MAX_LIGHTS = 64;
const s2l = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));

export class GL2Backend {
  constructor(renderer, opts = {}) {
    this.type = 'webgl2';
    this.renderer = renderer;
    const aa = opts.antialias ?? (renderer._quality === 'high' || (renderer._quality === 'auto' && !renderer.isMobile));
    this._alpha = Boolean(opts.alpha);
    const gl = renderer.domElement.getContext('webgl2', {
      antialias: aa,
      alpha: this._alpha,
      powerPreference: 'high-performance',
      stencil: false,
    });
    if (!gl) throw new Error('Made3D: este navegador no soporta WebGL2');
    this.gl = gl;
    this.res = new GL2Resources(this);
    this.outline = new GL2Outline();
    this._programs = new Map();
    this._shadowProgs = new Map();
    this._nm = new Float32Array(9);
    this._scratch = new Float32Array(16 * 256);

    this._initGL();

    const cv = renderer.domElement;
    if (cv && cv.addEventListener) {
      this._onLost = (e) => {
        e.preventDefault();
        renderer.contextLost = true;
        if (renderer.onContextLost) renderer.onContextLost();
      };
      this._onRestored = () => {
        this._initGL();
        renderer.contextLost = false;
        renderer._n = 0; renderer._ema = 0; renderer._cool = 0;
        if (renderer.onContextRestored) renderer.onContextRestored();
      };
      cv.addEventListener('webglcontextlost', this._onLost);
      cv.addEventListener('webglcontextrestored', this._onRestored);
    }
  }

  _initGL() {
    const gl = this.gl;
    this._programs = new Map();
    this._shadowProgs = new Map();
    this.res.reset();
    this._aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    this.renderer._epoch++;
    this._cur = null;
    this._lastMat = null;
    this._lastMatProg = null;
    const m = this.renderer.info.memory;
    m.geometries = m.textures = m.programs = m.instanceBuffers = 0;
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true);
    gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK);
    gl.disable(gl.BLEND);
    gl.vertexAttrib4f(LOC.normal, 0, 0, 1, 0);
    gl.vertexAttrib4f(LOC.uv, 0, 0, 0, 1);
    gl.vertexAttrib4f(LOC.color, 1, 1, 1, 1);
    this._st = { blend: 'none', depthTest: true, depthWrite: true, side: 'front' };
  }

  resetState() {
    this._cur = null;
    this.res._vao = null;
    this._lastMat = null;
    this._lastMatProg = null;
    this.res._unitTex.length = 0;
    this._st.blend = null;
    this._st.depthTest = null;
    this._st.depthWrite = null;
    this._st.side = null;
  }

  isContextLost() {
    return !this.gl || this.gl.isContextLost();
  }

  getCapabilities() {
    const gl = this.gl;
    const rawTex = gl && gl.getParameter ? gl.getParameter(gl.MAX_TEXTURE_SIZE) : 0;
    const rawRB = gl && gl.getParameter ? gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) : 0;
    const rawDims = gl && gl.getParameter ? gl.getParameter(gl.MAX_VIEWPORT_DIMS) : null;
    const maxTextureSize = rawTex > 0 ? rawTex : 4096;
    const maxRenderbufferSize = rawRB > 0 ? rawRB : maxTextureSize;
    const maxViewportWidth = rawDims && rawDims[0] > 0 ? rawDims[0] : maxTextureSize;
    const maxViewportHeight = rawDims && rawDims[1] > 0 ? rawDims[1] : maxTextureSize;
    const maxRenderWidth = Math.max(1, Math.min(maxTextureSize, maxRenderbufferSize, maxViewportWidth));
    const maxRenderHeight = Math.max(1, Math.min(maxTextureSize, maxRenderbufferSize, maxViewportHeight));
    return {
      backend: 'webgl2',
      maxTextureSize,
      maxRenderbufferSize,
      maxViewportWidth,
      maxViewportHeight,
      maxRenderWidth,
      maxRenderHeight,
    };
  }

  getShadowMapSize(light) {
    if (!light || !light.shadow) return 0;
    const caps = this.getCapabilities();
    const cap = Math.min(caps.maxTextureSize, caps.maxRenderbufferSize, 4096);
    const base = light.shadow.mapSize || 1024;
    const scale = light.shadow.autoQuality === false ? 1 : (this.renderer.shadowScale || 1);
    return Math.max(64, Math.min(cap, Math.round(base * scale)));
  }

  prepareRenderTarget(rt) {
    this.res.getTarget(rt);
  }

  _getShadowProgram(instanced, skinned = false, morphed = false) {
    const key = (instanced ? 'shadow|I' : 'shadow|N') + (skinned ? '|G' : '') + (morphed ? '|M' : '');
    let p = this._shadowProgs.get(key);
    if (p) return p;
    const defs = {};
    if (skinned) defs.USE_SKINNING = 1;
    if (morphed) defs.USE_MORPH = 1;
    p = new Program(
      this.gl,
      buildSource('vertex', SHADOW_VERT, defs, instanced, false),
      buildSource('fragment', SHADOW_FRAG, defs, instanced, false)
    );
    p.uLightMatrix = p.byName.uLightMatrix ? p.byName.uLightMatrix.loc : null;
    this._shadowProgs.set(key, p);
    this.renderer.info.memory.programs++;
    return p;
  }

  renderShadowMap(light, casters, lightVP) {
    const gl = this.gl, r = this.renderer, res = this.res;
    const sm = res.getShadowMap(light);

    gl.bindFramebuffer(gl.FRAMEBUFFER, sm.fbo);
    gl.viewport(0, 0, sm.size, sm.size);
    gl.colorMask(false, false, false, false);
    if (!this._st.depthWrite) { gl.depthMask(true); this._st.depthWrite = true; }
    if (!this._st.depthTest) { gl.enable(gl.DEPTH_TEST); this._st.depthTest = true; }
    if (this._st.side !== 'front') { gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK); this._st.side = 'front'; }
    gl.clear(gl.DEPTH_BUFFER_BIT);

    let p = null;
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
      const want = this._getShadowProgram(inst, skin, morph);
      if (want !== p) {
        p = want;
        gl.useProgram(p.program);
        gl.uniformMatrix4fv(p.uLightMatrix, false, lightVP.elements);
      }
      const gg = res.getGeometry(mesh.geometry);
      if (morph) res.setMorphUniforms(p, mesh);
      if (skin) res.setSkinUniforms(p, mesh);
      else if (p.uModel !== null) gl.uniformMatrix4fv(p.uModel, false, mesh.matrixWorld.elements);

      if (inst) {
        const attr = mesh.instanceMatrix, a = attr.array, total = Math.min(mesh.count, (a.length / 16) | 0);
        if (total > 0) {
          const ig = res.ensureInstanced(mesh, gg, attr);
          if (ig.version !== attr.version || ig.attr !== attr || !ig.full) {
            gl.bindBuffer(gl.ARRAY_BUFFER, ig.buf);
            if (a.byteLength > ig.byteLength) {
              gl.bufferData(gl.ARRAY_BUFFER, a.byteLength, gl.DYNAMIC_DRAW);
              ig.byteLength = a.byteLength;
            }
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, a, 0, total * 16);
            ig.attr = attr; ig.version = attr.version; ig.full = true;
          }
          res.bindVAO(ig.vao);
          if (gg.indexed) gl.drawElementsInstanced(gl.TRIANGLES, gg.count, gg.indexType, 0, total);
          else gl.drawArraysInstanced(gl.TRIANGLES, 0, gg.count, total);
        }
      } else {
        res.bindVAO(gg.vao);
        if (gg.indexed) gl.drawElements(gl.TRIANGLES, gg.count, gg.indexType, 0);
        else gl.drawArrays(gl.TRIANGLES, 0, gg.count);
      }
    }
    gl.colorMask(true, true, true, true);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this._cur = null;
    res._unitTex.length = 0;
    return { texture: sm.texture, matrix: lightVP, size: sm.size };
  }

  reuseShadowMap(light, lightVP) {
    const sm = this.res.getShadowMap(light);
    return { texture: sm.texture, matrix: lightVP, size: sm.size };
  }

  beginMainPass(clearRGB, rt) {
    const gl = this.gl, r = this.renderer;
    this._lastMat = null;
    this._lastMatProg = null;
    const lin = !!rt && r._colorSpace === 'srgb';
    gl.clearColor(
      lin ? s2l(clearRGB[0]) : clearRGB[0],
      lin ? s2l(clearRGB[1]) : clearRGB[1],
      lin ? s2l(clearRGB[2]) : clearRGB[2],
      1
    );
    if (rt) {
      const t = this.res.getTarget(rt);
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
      gl.viewport(0, 0, rt.width, rt.height);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, gl.drawingBufferWidth || r.domElement.width, gl.drawingBufferHeight || r.domElement.height);
    }
    if (!this._st.depthWrite) { gl.depthMask(true); this._st.depthWrite = true; }
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  }

  endMainPass() {
    this._lastMat = null;
    this._lastMatProg = null;
  }

  _uploadSamplers(p, obj) {
    const ss = p.samplers, res = this.res;
    for (let i = 0; i < ss.length; i++) {
      const u = ss[i], v = obj[u.name];
      if (v === undefined) continue;
      res.bindTexture(v, u.unit);
    }
  }

  _upload(p, obj) {
    const gl = this.gl, us = p.uniforms, res = this.res;
    for (let i = 0; i < us.length; i++) {
      const u = us[i], v = obj[u.name];
      if (v === undefined) continue;
      if (u.unit >= 0) { res.bindTexture(v, u.unit); continue; }
      if (v === null) continue;
      setUniform(gl, u, v);
    }
  }

  _getProgram(material, instanced, noShadow, skinned = false, morphed = false) {
    const r = this.renderer;
    const srgb = r._colorSpace === 'srgb' && !r._rt;
    const fog = r._fogOn && material.fog !== false;
    const shadow = r._shadowOn && material.lit && material.receiveShadow !== false && !noShadow;
    let progs = material._progs;
    if (!progs || material._progsOwner !== r || material._progsEpoch !== r._epoch) {
      progs = material._progs = new Array(MAX_LIGHTS).fill(null);
      material._progsOwner = r;
      material._progsEpoch = r._epoch;
    }
    const slot = (instanced ? 1 : 0) | (srgb ? 2 : 0) | (fog ? 4 : 0) | (shadow ? 8 : 0) | (skinned ? 16 : 0) | (morphed ? 32 : 0);
    let p = progs[slot];
    if (p) return p;
    const key = material.programKey + (instanced ? '|I' : '|N') + (srgb ? '|S' : '|L')
      + (fog ? '|F' : '|f') + (shadow ? '|K' : '|k') + (skinned ? '|G' : '') + (morphed ? '|M' : '');
    p = this._programs.get(key);
    if (!p) {
      const defs = Object.assign({}, material.getDefines());
      if (fog) defs.USE_FOG = 1;
      if (shadow) defs.USE_SHADOW = 1;
      if (skinned) defs.USE_SKINNING = 1;
      if (morphed) defs.USE_MORPH = 1;
      p = new Program(
        this.gl,
        buildSource('vertex', material.vertexShader, defs, instanced, srgb),
        buildSource('fragment', material.fragmentShader, defs, instanced, srgb)
      );
      this._programs.set(key, p);
      r.info.memory.programs++;
      this._cur = null;
    }
    progs[slot] = p;
    return p;
  }

  _setState(m, side) {
    const gl = this.gl, s = this._st;
    const blend = m.transparent ? m.blending : 'none';
    if (s.blend !== blend) {
      if (blend === 'none') gl.disable(gl.BLEND);
      else {
        gl.enable(gl.BLEND);
        if (blend === 'additive') gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
        else gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      }
      s.blend = blend;
    }
    if (s.depthTest !== m.depthTest) { m.depthTest ? gl.enable(gl.DEPTH_TEST) : gl.disable(gl.DEPTH_TEST); s.depthTest = m.depthTest; }
    const dw = m.depthWrite;
    if (s.depthWrite !== dw) { gl.depthMask(dw); s.depthWrite = dw; }
    if (s.side !== side) {
      if (side === 'double') gl.disable(gl.CULL_FACE);
      else { gl.enable(gl.CULL_FACE); gl.cullFace(side === 'back' ? gl.FRONT : gl.BACK); }
      s.side = side;
    }
  }

  _drawInstanced(mesh, gg, mode = 'triangles') {
    const gl = this.gl, r = this.renderer, res = this.res;
    const attr = mesh.instanceMatrix, a = attr.array;
    const total = Math.min(mesh.count, (a.length / 16) | 0);
    const ig = res.ensureInstanced(mesh, gg, attr);
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
    if (n === 0) return;

    gl.bindBuffer(gl.ARRAY_BUFFER, ig.buf);
    if (full) {
      if (ig.version !== attr.version || ig.attr !== attr || !ig.full) {
        if (a.byteLength > ig.byteLength) {
          gl.bufferData(gl.ARRAY_BUFFER, a.byteLength, gl.DYNAMIC_DRAW);
          ig.byteLength = a.byteLength;
        }
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, a, 0, total * 16);
        ig.attr = attr; ig.version = attr.version; ig.full = true;
      }
    } else {
      const needBytes = n * 16 * 4;
      if (needBytes > ig.byteLength) {
        gl.bufferData(gl.ARRAY_BUFFER, a.byteLength, gl.DYNAMIC_DRAW);
        ig.byteLength = a.byteLength;
      }
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this._scratch, 0, n * 16);
      ig.full = false;
    }
    if (mode === 'wireframe') {
      const w = res.getWire(gg, mesh.geometry);
      if (!ig.wireVao) ig.wireVao = gl.createVertexArray();
      const ws = `${w.version}|${gg.attrSig}`;
      if (ig.wireSig !== ws) { res.bindInstancedVAO(ig.wireVao, gg, ig.buf, w.buf); ig.wireSig = ws; }
      else res.bindVAO(ig.wireVao);
      gl.drawElementsInstanced(gl.LINES, w.count, gl.UNSIGNED_INT, 0, n);
      r.info.calls++; r.info.drawn++; r.info.instances += n; r.info.lines += (w.count / 2) * n;
      return;
    }
    res.bindVAO(ig.vao);
    if (mode === 'triangles') {
      if (gg.indexed) gl.drawElementsInstanced(gl.TRIANGLES, gg.count, gg.indexType, 0, n);
      else gl.drawArraysInstanced(gl.TRIANGLES, 0, gg.count, n);
      r.info.triangles += (gg.count / 3) * n;
    } else {
      const modes = { lines: gl.LINES, lineStrip: gl.LINE_STRIP, line_strip: gl.LINE_STRIP, lineLoop: gl.LINE_LOOP, line_loop: gl.LINE_LOOP, points: gl.POINTS };
      const lm = modes[mode] || gl[mode.toUpperCase()] || gl.LINES;
      if (gg.indexed) gl.drawElementsInstanced(lm, gg.count, gg.indexType, 0, n);
      else gl.drawArraysInstanced(lm, 0, gg.count, n);
      if (lm === gl.LINE_STRIP) r.info.lines += Math.max(0, gg.count - 1) * n;
      else if (lm === gl.LINE_LOOP) r.info.lines += gg.count * n;
      else if (lm === gl.LINES) r.info.lines += (gg.count / 2) * n;
    }
    r.info.calls++; r.info.drawn++; r.info.instances += n;
  }

  _issue(mesh, gg, instanced, mode) {
    const gl = this.gl, r = this.renderer, res = this.res;
    if (instanced) { this._drawInstanced(mesh, gg, mode); return; }
    if (mode === 'wireframe') {
      const w = res.getWire(gg, mesh.geometry);
      res.bindVAO(w.vao);
      gl.drawElements(gl.LINES, w.count, gl.UNSIGNED_INT, 0);
      r.info.calls++; r.info.drawn++; r.info.lines += w.count / 2;
      return;
    }
    res.bindVAO(gg.vao);
    if (mode === 'triangles') {
      if (gg.indexed) gl.drawElements(gl.TRIANGLES, gg.count, gg.indexType, 0);
      else gl.drawArrays(gl.TRIANGLES, 0, gg.count);
      r.info.triangles += gg.count / 3;
    } else {
      const modes = { lines: gl.LINES, lineStrip: gl.LINE_STRIP, line_strip: gl.LINE_STRIP, lineLoop: gl.LINE_LOOP, line_loop: gl.LINE_LOOP, points: gl.POINTS };
      const lm = modes[mode] || gl[mode.toUpperCase()] || gl.LINES;
      if (gg.indexed) gl.drawElements(lm, gg.count, gg.indexType, 0);
      else gl.drawArrays(lm, 0, gg.count);
      if (lm === gl.LINE_STRIP) r.info.lines += Math.max(0, gg.count - 1);
      else if (lm === gl.LINE_LOOP) r.info.lines += gg.count;
      else if (lm === gl.LINES) r.info.lines += gg.count / 2;
    }
    r.info.calls++; r.info.drawn++;
  }

  drawItem(item) {
    const gl = this.gl, r = this.renderer, res = this.res;
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
    const p = this._getProgram(m, instanced, mesh.receiveShadow === false, skin, morph);
    const progChanged = this._cur !== p;
    if (progChanged) { gl.useProgram(p.program); this._cur = p; }
    if (p.frame !== r._frame) {
      this._upload(p, r._globals);
      p.frame = r._frame;
      this._lastMat = null;
    } else if (progChanged) {
      this._uploadSamplers(p, r._globals);
    }
    if (this._lastMat !== m || this._lastMatProg !== p) {
      m.updateUniforms();
      this._upload(p, m.uniforms);
      this._lastMat = m; this._lastMatProg = p;
    } else if (progChanged) {
      this._uploadSamplers(p, m.uniforms);
    }
    if (morph) res.setMorphUniforms(p, mesh);
    if (skin) res.setSkinUniforms(p, mesh);
    else {
      if (p.uModel !== null) gl.uniformMatrix4fv(p.uModel, false, mesh.matrixWorld.elements);
      if (p.uNormalMatrix !== null && !instanced) gl.uniformMatrix3fv(p.uNormalMatrix, false, mesh.matrixWorld.normalMatrix(this._nm));
    }

    const mode = mesh.drawMode || (m.wireframe ? 'wireframe' : 'triangles');
    if (mode !== 'triangles') {
      this._setState(m, 'front');
      this._issue(mesh, gg, instanced, mode);
      return;
    }
    if (m.transparent && m.side === 'double' && m.twoPass !== false) {
      this._setState(m, 'back'); this._issue(mesh, gg, instanced, mode);
      this._setState(m, 'front'); this._issue(mesh, gg, instanced, mode);
    } else {
      this._setState(m, m.side); this._issue(mesh, gg, instanced, mode);
    }
  }

  renderOutline(params) {
    this.outline.render(this, params);
  }

  copyCanvasTo2D(outCanvas, w, h, opts = {}) {
    const dw = this.gl.drawingBufferWidth || this.renderer.domElement.width || w;
    const dh = this.gl.drawingBufferHeight || this.renderer.domElement.height || h;
    if (outCanvas.width !== w) outCanvas.width = w;
    if (outCanvas.height !== h) outCanvas.height = h;
    const opaque = opts.opaque !== false && !this._alpha;
    const ctx = outCanvas._m3dCtx2d || (outCanvas._m3dCtx2d = (
      outCanvas.getContext('2d', opaque ? { alpha: false, desynchronized: true } : undefined) ||
      outCanvas.getContext('2d')
    ));
    if (ctx) {
      if (!opaque) ctx.clearRect(0, 0, w, h);
      ctx.drawImage(this.renderer.domElement, 0, 0, dw, dh, 0, 0, w, h);
    }
  }

  dispose() {
    const gl = this.gl, cv = this.renderer.domElement;
    if (cv && cv.removeEventListener) {
      if (this._onLost) cv.removeEventListener('webglcontextlost', this._onLost);
      if (this._onRestored) cv.removeEventListener('webglcontextrestored', this._onRestored);
    }
    for (const p of this._programs.values()) gl.deleteProgram(p.program);
    this._programs.clear();
    for (const p of this._shadowProgs.values()) gl.deleteProgram(p.program);
    this._shadowProgs.clear();
    this.res.disposeAll();
    const ext = gl.getExtension('WEBGL_lose_context');
    if (ext) ext.loseContext();
  }
}
