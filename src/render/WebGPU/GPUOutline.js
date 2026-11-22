import { alignUp } from './GPUDevice.js';
import {
  OUTLINE_SILHOUETTE_WGSL,
  OUTLINE_HORIZ_COMPUTE_WGSL,
  OUTLINE_VERT_COMPOSITE_WGSL,
} from '../../shaders/WGSL/compute.js';

const _gpu = new WeakMap();
const _viewDepth = new Float32Array(16);

export class GPUOutline {
  _getState(backend, mw, mh) {
    const device = backend.device;
    let st = _gpu.get(backend);
    if (!st) {
      const horizMod = backend.pipes.getShaderModule(OUTLINE_HORIZ_COMPUTE_WGSL);
      const horizPipe = device.createComputePipeline({
        layout: 'auto',
        compute: { module: horizMod, entryPoint: 'cs_main' },
      });

      const compMod = backend.pipes.getShaderModule(OUTLINE_VERT_COMPOSITE_WGSL);
      const compPipe = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: compMod, entryPoint: 'vs_main' },
        fragment: {
          module: compMod,
          entryPoint: 'fs_main',
          targets: [{
            format: backend.presentationFormat,
            blend: {
              color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
          }],
        },
        primitive: { topology: 'triangle-list' },
      });

      const paramsBuf = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const stride = alignUp(16, device.limits?.minUniformBufferOffsetAlignment || 256);
      const colorBuf = device.createBuffer({ size: stride * 2, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const colorBg = device.createBindGroup({
        layout: backend.pipes.outlineGroup2Layout,
        entries: [{ binding: 0, resource: { buffer: colorBuf, offset: 0, size: 16 } }],
      });

      const maskSampler = device.createSampler({
        magFilter: 'linear',
        minFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      });

      st = {
        texMask: null, viewMask: null,
        texHoriz: null, viewHoriz: null,
        mw: 0, mh: 0,
        horizPipe, compPipe,
        paramsBuf, colorBuf, colorBg, colorStride: stride,
        maskSampler,
        horizBg: null, compBg: null,
        paramsData: new ArrayBuffer(48),
      };
      _gpu.set(backend, st);
    }

    if (st.mw !== mw || st.mh !== mh) {
      if (st.texMask) st.texMask.destroy();
      if (st.texHoriz) st.texHoriz.destroy();
      st.texMask = device.createTexture({
        size: [mw, mh, 1],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      st.viewMask = st.texMask.createView();
      st.texHoriz = device.createTexture({
        size: [mw, mh, 1],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      });
      st.viewHoriz = st.texHoriz.createView();
      st.mw = mw;
      st.mh = mh;

      st.horizBg = device.createBindGroup({
        layout: st.horizPipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: st.viewMask },
          { binding: 1, resource: st.viewHoriz },
          { binding: 2, resource: { buffer: st.paramsBuf } },
        ],
      });
      st.compBg = device.createBindGroup({
        layout: st.compPipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: st.viewMask },
          { binding: 1, resource: st.viewHoriz },
          { binding: 2, resource: st.maskSampler },
          { binding: 3, resource: { buffer: st.paramsBuf } },
        ],
      });
    }
    return st;
  }

  render(backend, params) {
    const {
      camera, secMeshes, actMeshes, activeColor, secondaryColor,
      W, H, mw, mh, scaleX, scaleY, radiusMask, intRadius,
      msx0, msy0, msx1, msy1, msw, msh, sx0, sy0, sw, sh,
    } = params;

    const device = backend.device, res = backend.res, r = backend.renderer;
    const st = this._getState(backend, mw, mh);

    // Convertir scissor rect de coords WebGL (origen abajo-izquierda) a WebGPU (origen arriba-izquierda)
    const gmsy0 = mh - msy1;
    const gmsy1 = mh - msy0;
    const gsy0 = H - (sy0 + sh);

    // Actualizar globals con proyección de la cámara activa en rango Z [0, 1]
    const gBuf = backend._globalCpu;
    gBuf.set(camera.viewMatrix.elements, 0);
    backend._remapProjZeroToOne(camera.projectionMatrix.elements, _viewDepth);
    gBuf.set(_viewDepth, 16);
    device.queue.writeBuffer(backend.globalUniformBuf, 0, gBuf, 0, 32);

    device.queue.writeBuffer(st.colorBuf, 0, secondaryColor);
    device.queue.writeBuffer(st.colorBuf, st.colorStride, activeColor);

    const pViewI = new Int32Array(st.paramsData);
    const pViewF = new Float32Array(st.paramsData);
    pViewI[0] = msx0;
    pViewI[1] = gmsy0;
    pViewI[2] = msx1 - 1;
    pViewI[3] = gmsy1 - 1;
    pViewF[4] = scaleX;
    pViewF[5] = scaleY;
    pViewF[6] = 1 / W;
    pViewF[7] = 1 / H;
    pViewI[8] = intRadius;
    pViewF[9] = radiusMask;
    pViewI[10] = (mw !== W || mh !== H) ? 1 : 0;
    pViewI[11] = 0;
    device.queue.writeBuffer(st.paramsBuf, 0, st.paramsData);

    const drawList = [];
    const prepBatch = (meshes, colorOffset) => {
      for (let i = 0; i < meshes.length; i++) {
        const mesh = meshes[i];
        const instanced = !!mesh.isInstancedMesh;
        const skin = r._isGpuSkin(mesh);
        const morph = r._hasMorph(mesh);
        const gg = res.getGeometry(mesh.geometry);
        const objSlot = res.objArena.alloc();
        backend._writeObjectUniforms(mesh, objSlot, skin, morph, gg);
        const boneBuf = skin ? res.getBoneBuffer(mesh.skeleton) : res.dummyBoneBuf;
        const morphBuf = morph ? res.getMorphData(mesh.geometry).buf : res.dummyMorphBuf;
        const bg1 = res.getGroup1BindGroup(objSlot.slabIdx, objSlot.buffer, boneBuf, morphBuf);

        let instBuf = null, instCount = 1;
        if (instanced) {
          const attr = mesh.instanceMatrix;
          instCount = Math.min(mesh.count, (attr.array.length / 16) | 0);
          if (instCount <= 0) continue;
          const ig = res.ensureInstanced(mesh, attr);
          if (ig.version !== attr.version || ig.attr !== attr) {
            if (ig.byteLength < attr.array.byteLength) {
              ig.buf.destroy();
              ig.buf = device.createBuffer({ size: attr.array.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
              ig.byteLength = attr.array.byteLength;
            }
            device.queue.writeBuffer(ig.buf, 0, attr.array, 0, instCount * 16);
            ig.attr = attr; ig.version = attr.version;
          }
          instBuf = ig.buf;
        }
        drawList.push({ mesh, gg, instanced, skin, morph, objOffset: objSlot.dynamicOffset, bg1, colorOffset, instBuf, instCount });
      }
    };

    prepBatch(secMeshes, 0);
    prepBatch(actMeshes, st.colorStride);
    res.flushArenas();

    const enc = device.createCommandEncoder({ label: 'M3D_SelectionOutline' });

    // Pase 1: silueta en rgba8unorm
    const pass1 = enc.beginRenderPass({
      colorAttachments: [{
        view: st.viewMask,
        loadOp: 'clear',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        storeOp: 'store',
      }],
    });
    pass1.setViewport(0, 0, mw, mh, 0, 1);
    pass1.setScissorRect(msx0, gmsy0, msw, msh);
    pass1.setBindGroup(0, backend.group0BindGroup);

    for (let i = 0; i < drawList.length; i++) {
      const d = drawList[i];
      const mode = d.mesh.drawMode || (d.mesh.material && d.mesh.material.wireframe ? 'wireframe' : 'triangles');
      const topology = backend._mapTopology(mode);
      const side = mode !== 'triangles' ? 'double' : (d.mesh.material?.side || 'front');
      const cullMode = side === 'double' ? 'none' : (side === 'back' ? 'front' : 'back');

      const defs = {};
      if (d.skin) defs.USE_SKINNING = 1;
      if (d.morph) defs.USE_MORPH = 1;
      const ai = d.gg.attrInfo;
      const cacheKey = `outline|${d.instanced ? 1 : 0}|${d.skin ? 1 : 0}|${d.morph ? 1 : 0}|${ai.hasNormal ? 1 : 0}|${ai.hasUv ? 1 : 0}|${ai.colorSize}|${ai.hasUv1 ? 1 : 0}|${topology}|${cullMode}`;

      const pipeEntry = backend.pipes.getRenderPipeline({
        cacheKey,
        wgslTemplate: OUTLINE_SILHOUETTE_WGSL,
        defines: defs,
        instanced: d.instanced,
        srgb: false,
        custom: false,
        texMask: 0,
        attrInfo: ai,
        topology,
        cullMode,
        blendMode: 'none',
        depthTest: false,
        depthWrite: false,
        colorFormat: 'rgba8unorm',
        depthFormat: null,
        hasFragment: true,
        layoutOverride: backend.pipes.outlinePipelineLayout,
      });

      pass1.setPipeline(pipeEntry.pipeline);
      pass1.setBindGroup(1, d.bg1, [d.objOffset]);
      pass1.setBindGroup(2, st.colorBg, [d.colorOffset]);
      backend._bindVertexAndDraw(pass1, pipeEntry.slotNames, d.gg, d.mesh.geometry, mode, d.instBuf, d.instCount, false);
    }
    pass1.end();

    // Pase 2A: Compute Shader 1D horizontal
    const cpass = enc.beginComputePass();
    cpass.setPipeline(st.horizPipe);
    cpass.setBindGroup(0, st.horizBg);
    cpass.dispatchWorkgroups(Math.ceil(msw / 8), Math.ceil(msh / 8), 1);
    cpass.end();

    // Pase 2B: Composición vertical sobre el lienzo actual
    const swapView = backend.currentSwapView || backend.context.getCurrentTexture().createView();
    const pass2 = enc.beginRenderPass({
      colorAttachments: [{
        view: swapView,
        loadOp: 'load',
        storeOp: 'store',
      }],
    });
    pass2.setViewport(0, 0, W, H, 0, 1);
    pass2.setScissorRect(sx0, gsy0, sw, sh);
    pass2.setPipeline(st.compPipe);
    pass2.setBindGroup(0, st.compBg);
    pass2.draw(3);
    pass2.end();

    device.queue.submit([enc.finish()]);
  }
}
