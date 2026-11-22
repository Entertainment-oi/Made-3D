import { Program } from './GL2Program.js';
import { buildSource } from '../../shaders/GLSL/prelude.js';

const _gpu = new WeakMap();

const SILHOUETTE_VERT = `
void main() {
  gl_Position = uProjection * uView * MODEL_MATRIX * vec4(m3dPos, 1.0);
}
`;

const SILHOUETTE_FRAG = `
uniform vec4 uOutlineColor;
void main() {
  fragColor = uOutlineColor;
}
`;

const FULLSCREEN_VERT = `#version 300 es
precision highp float;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

const HORIZ_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uMask;
uniform ivec2 uMinCoord;
uniform ivec2 uMaxCoord;
uniform int uIntRadius;
uniform float uRadius;
out vec4 fragColor;

void main() {
  ivec2 coord = ivec2(gl_FragCoord.xy);
  vec4 center = texelFetch(uMask, coord, 0);
  if (center.a > 0.5) {
    fragColor = vec4(center.rgb, 1.0);
    return;
  }

  int bestDx = 9999;
  vec3 bestCol = vec3(0.0);
  for (int d = 1; d <= 10; d++) {
    if (d > uIntRadius) break;
    int rx = min(coord.x + d, uMaxCoord.x);
    vec4 tR = texelFetch(uMask, ivec2(rx, coord.y), 0);
    if (tR.a > 0.5) {
      bestDx = d;
      bestCol = tR.rgb;
      break;
    }
    int lx = max(coord.x - d, uMinCoord.x);
    vec4 tL = texelFetch(uMask, ivec2(lx, coord.y), 0);
    if (tL.a > 0.5) {
      bestDx = d;
      bestCol = tL.rgb;
      break;
    }
  }

  if (bestDx > uIntRadius) {
    fragColor = vec4(0.0);
    return;
  }

  float dxNorm = float(bestDx) / max(1.0, uRadius);
  float encoded = clamp(0.98 - (dxNorm * 0.6666667) * 0.96, 0.02, 0.98);
  fragColor = vec4(bestCol, encoded);
}
`;

const VERT_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uMask;
uniform sampler2D uHoriz;
uniform vec2 uMaskScale;
uniform vec2 uInvScreen;
uniform ivec2 uMinCoord;
uniform ivec2 uMaxCoord;
uniform int uIntRadius;
uniform float uRadius;
uniform int uCheckLinearMask;
out vec4 fragColor;

void main() {
  if (uCheckLinearMask != 0) {
    vec2 uv = gl_FragCoord.xy * uInvScreen;
    if (texture(uMask, uv).a > 0.5) discard;
  }

  ivec2 coord = clamp(ivec2(gl_FragCoord.xy * uMaskScale), uMinCoord, uMaxCoord);
  vec4 centerH = texelFetch(uHoriz, coord, 0);
  if (uCheckLinearMask == 0 && centerH.a >= 0.995) discard;

  float bestNormDist = 2.0;
  vec3 bestCol = vec3(0.0);
  float invR = 1.0 / max(1.0, uRadius);

  if (centerH.a > 0.005) {
    float dxNorm = centerH.a >= 0.995 ? 0.0 : max(0.0, (0.98 - centerH.a) * 1.5625);
    bestNormDist = dxNorm;
    bestCol = centerH.rgb;
  }

  for (int d = 1; d <= 10; d++) {
    if (d > uIntRadius) break;
    float dyNorm = float(d) * invR;
    if (dyNorm >= bestNormDist) break;

    int uy = min(coord.y + d, uMaxCoord.y);
    vec4 tU = texelFetch(uHoriz, ivec2(coord.x, uy), 0);
    if (tU.a > 0.005) {
      float dxNorm = tU.a >= 0.995 ? 0.0 : max(0.0, (0.98 - tU.a) * 1.5625);
      float dist = sqrt(dxNorm * dxNorm + dyNorm * dyNorm);
      if (dist < bestNormDist) {
        bestNormDist = dist;
        bestCol = tU.rgb;
      }
    }

    int ly = max(coord.y - d, uMinCoord.y);
    vec4 tL = texelFetch(uHoriz, ivec2(coord.x, ly), 0);
    if (tL.a > 0.005) {
      float dxNorm = tL.a >= 0.995 ? 0.0 : max(0.0, (0.98 - tL.a) * 1.5625);
      float dist = sqrt(dxNorm * dxNorm + dyNorm * dyNorm);
      if (dist < bestNormDist) {
        bestNormDist = dist;
        bestCol = tL.rgb;
      }
    }
  }

  if (bestNormDist > 1.05) discard;
  float alpha = clamp(1.18 - bestNormDist * 0.42, 0.0, 1.0);
  fragColor = vec4(bestCol, alpha);
}
`;

function createTargetTex(gl, filter) {
  const fbo = gl.createFramebuffer();
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fbo, tex };
}

export class GL2Outline {
  _getState(backend, mw, mh) {
    const gl = backend.gl;
    let st = _gpu.get(backend);
    if (st && st.epoch !== backend.renderer._epoch) st = null;
    if (!st) {
      const maskTarget = createTargetTex(gl, gl.LINEAR);
      const horizTarget = createTargetTex(gl, gl.NEAREST);
      st = {
        epoch: backend.renderer._epoch,
        fboMask: maskTarget.fbo,
        texMask: maskTarget.tex,
        fboHoriz: horizTarget.fbo,
        texHoriz: horizTarget.tex,
        mw: 0,
        mh: 0,
        quadVao: gl.createVertexArray(),
        horizProg: new Program(gl, FULLSCREEN_VERT, HORIZ_FRAG),
        vertProg: new Program(gl, FULLSCREEN_VERT, VERT_FRAG),
        maskProgs: new Map(),
      };
      _gpu.set(backend, st);
    }
    if (st.mw !== mw || st.mh !== mh) {
      gl.bindTexture(gl.TEXTURE_2D, st.texMask);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, mw, mh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindTexture(gl.TEXTURE_2D, st.texHoriz);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, mw, mh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      st.mw = mw;
      st.mh = mh;
    }
    return st;
  }

  _getMaskProgram(backend, st, instanced, skinned, morphed) {
    const key = (instanced ? 1 : 0) | (skinned ? 2 : 0) | (morphed ? 4 : 0);
    let p = st.maskProgs.get(key);
    if (p) return p;
    const defs = {};
    if (skinned) defs.USE_SKINNING = 1;
    if (morphed) defs.USE_MORPH = 1;
    p = new Program(
      backend.gl,
      buildSource('vertex', SILHOUETTE_VERT, defs, instanced, false),
      buildSource('fragment', SILHOUETTE_FRAG, defs, instanced, false)
    );
    st.maskProgs.set(key, p);
    return p;
  }

  _drawMeshBatch(backend, st, camera, meshes, col, state) {
    const gl = backend.gl, res = backend.res, r = backend.renderer;
    let activeProg = null;
    for (let mi = 0; mi < meshes.length; mi++) {
      const mesh = meshes[mi];
      const instanced = !!mesh.isInstancedMesh;
      const skin = r._isGpuSkin(mesh);
      const morph = r._hasMorph(mesh);

      const p = this._getMaskProgram(backend, st, instanced, skin, morph);
      if (p !== activeProg) {
        activeProg = p;
        gl.useProgram(p.program);
        if (p.byName.uView) gl.uniformMatrix4fv(p.byName.uView.loc, false, camera.viewMatrix.elements);
        if (p.byName.uProjection) gl.uniformMatrix4fv(p.byName.uProjection.loc, false, camera.projectionMatrix.elements);
        if (p.byName.uOutlineColor) gl.uniform4fv(p.byName.uOutlineColor.loc, col);
      }

      const gg = res.getGeometry(mesh.geometry);
      if (morph) res.setMorphUniforms(p, mesh);
      if (skin) res.setSkinUniforms(p, mesh);
      else if (p.uModel !== null) gl.uniformMatrix4fv(p.uModel, false, mesh.matrixWorld.elements);

      const mode = mesh.drawMode || (mesh.material && mesh.material.wireframe ? 'wireframe' : 'triangles');
      const desiredCull = mode !== 'triangles'
        ? 'double'
        : (mesh.material && mesh.material.side === 'double'
          ? 'double'
          : (mesh.material && mesh.material.side === 'back' ? 'back' : 'front'));
      if (desiredCull !== state.cull) {
        state.cull = desiredCull;
        if (desiredCull === 'double') gl.disable(gl.CULL_FACE);
        else { gl.enable(gl.CULL_FACE); gl.cullFace(desiredCull === 'back' ? gl.FRONT : gl.BACK); }
      }

      if (instanced) {
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
          if (mode === 'wireframe') {
            const w = res.getWire(gg, mesh.geometry);
            if (!ig.wireVao) ig.wireVao = gl.createVertexArray();
            const ws = `${w.version}|${gg.attrSig}`;
            if (ig.wireSig !== ws) { res.bindInstancedVAO(ig.wireVao, gg, ig.buf, w.buf); ig.wireSig = ws; }
            else res.bindVAO(ig.wireVao);
            gl.drawElementsInstanced(gl.LINES, w.count, gl.UNSIGNED_INT, 0, total);
          } else {
            res.bindVAO(ig.vao);
            if (gg.indexed) gl.drawElementsInstanced(gl.TRIANGLES, gg.count, gg.indexType, 0, total);
            else gl.drawArraysInstanced(gl.TRIANGLES, 0, gg.count, total);
          }
        }
      } else if (mode === 'wireframe') {
        const w = res.getWire(gg, mesh.geometry);
        res.bindVAO(w.vao);
        gl.drawElements(gl.LINES, w.count, gl.UNSIGNED_INT, 0);
      } else {
        res.bindVAO(gg.vao);
        if (mode === 'triangles') {
          if (gg.indexed) gl.drawElements(gl.TRIANGLES, gg.count, gg.indexType, 0);
          else gl.drawArrays(gl.TRIANGLES, 0, gg.count);
        } else {
          const modes = { lines: gl.LINES, lineStrip: gl.LINE_STRIP, line_strip: gl.LINE_STRIP, lineLoop: gl.LINE_LOOP, line_loop: gl.LINE_LOOP, points: gl.POINTS };
          const lm = modes[mode] || gl[mode.toUpperCase()] || gl.LINES;
          if (gg.indexed) gl.drawElements(lm, gg.count, gg.indexType, 0);
          else gl.drawArrays(lm, 0, gg.count);
        }
      }
    }
  }

  render(backend, params) {
    const {
      camera, secMeshes, actMeshes, activeColor, secondaryColor,
      W, H, mw, mh, scaleX, scaleY, radiusMask, intRadius,
      msx0, msy0, msx1, msy1, msw, msh, sx0, sy0, sw, sh,
    } = params;
    const gl = backend.gl, res = backend.res;
    const st = this._getState(backend, mw, mh);

    gl.bindFramebuffer(gl.FRAMEBUFFER, st.fboMask);
    gl.viewport(0, 0, mw, mh);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(msx0, msy0, msw, msh);
    gl.colorMask(true, true, true, true);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const drawState = { cull: null };
    if (secMeshes.length) this._drawMeshBatch(backend, st, camera, secMeshes, secondaryColor, drawState);
    if (actMeshes.length) this._drawMeshBatch(backend, st, camera, actMeshes, activeColor, drawState);

    if (drawState.cull !== 'double') gl.disable(gl.CULL_FACE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, st.fboHoriz);
    gl.viewport(0, 0, mw, mh);
    gl.scissor(msx0, msy0, msw, msh);

    const hp = st.horizProg;
    gl.useProgram(hp.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, st.texMask);
    if (hp.byName.uMask) gl.uniform1i(hp.byName.uMask.loc, 0);
    if (hp.byName.uMinCoord) gl.uniform2i(hp.byName.uMinCoord.loc, msx0, msy0);
    if (hp.byName.uMaxCoord) gl.uniform2i(hp.byName.uMaxCoord.loc, msx1 - 1, msy1 - 1);
    if (hp.byName.uIntRadius) gl.uniform1i(hp.byName.uIntRadius.loc, intRadius);
    if (hp.byName.uRadius) gl.uniform1f(hp.byName.uRadius.loc, radiusMask);

    res.bindVAO(st.quadVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    gl.scissor(sx0, sy0, sw, sh);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_ALPHA);

    const vp = st.vertProg;
    gl.useProgram(vp.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, st.texMask);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, st.texHoriz);
    if (vp.byName.uMask) gl.uniform1i(vp.byName.uMask.loc, 0);
    if (vp.byName.uHoriz) gl.uniform1i(vp.byName.uHoriz.loc, 1);
    if (vp.byName.uMaskScale) gl.uniform2f(vp.byName.uMaskScale.loc, scaleX, scaleY);
    if (vp.byName.uInvScreen) gl.uniform2f(vp.byName.uInvScreen.loc, 1 / W, 1 / H);
    if (vp.byName.uMinCoord) gl.uniform2i(vp.byName.uMinCoord.loc, msx0, msy0);
    if (vp.byName.uMaxCoord) gl.uniform2i(vp.byName.uMaxCoord.loc, msx1 - 1, msy1 - 1);
    if (vp.byName.uIntRadius) gl.uniform1i(vp.byName.uIntRadius.loc, intRadius);
    if (vp.byName.uRadius) gl.uniform1f(vp.byName.uRadius.loc, radiusMask);
    if (vp.byName.uCheckLinearMask) gl.uniform1i(vp.byName.uCheckLinearMask.loc, (mw !== W || mh !== H) ? 1 : 0);

    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.activeTexture(gl.TEXTURE0);
    backend.resetState();
  }
}
