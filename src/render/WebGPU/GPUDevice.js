import { buildWgslSource } from '../../shaders/WGSL/prelude.js';

export const GLOBAL_UNIFORM_BYTES = 688;
export const OBJECT_UNIFORM_BYTES = 320;
export const MATERIAL_UNIFORM_BYTES = 448;

export function alignUp(val, align) {
  return Math.ceil(val / align) * align;
}

export async function createGPUContext(canvas, opts = {}) {
  if (typeof navigator === 'undefined' || !navigator.gpu) {
    throw new Error('Made3D: WebGPU no está disponible en este navegador.');
  }
  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: opts.powerPreference || 'high-performance',
  });
  if (!adapter) {
    throw new Error('Made3D: no se encontró un adaptador WebGPU compatible.');
  }

  const optionalFeatures = [
    'texture-compression-bc',
    'texture-compression-etc2',
    'texture-compression-astc',
  ];
  const requiredFeatures = optionalFeatures.filter((f) => adapter.features.has(f));

  const device = await adapter.requestDevice({ requiredFeatures });
  const context = canvas.getContext('webgpu');
  if (!context) {
    throw new Error('Made3D: no se pudo obtener el contexto WebGPU del canvas.');
  }

  const presentationFormat = navigator.gpu.getPreferredCanvasFormat
    ? navigator.gpu.getPreferredCanvasFormat()
    : 'bgra8unorm';

  const alphaMode = opts.alpha ? 'premultiplied' : 'opaque';
  context.configure({
    device,
    format: presentationFormat,
    alphaMode,
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });

  return { adapter, device, context, presentationFormat, alphaMode };
}

export class GPUPipelineCache {
  constructor(device, presentationFormat) {
    this.device = device;
    this.presentationFormat = presentationFormat;
    this._shaderModules = new Map();
    this._pipelines = new Map();
    this._group2Layouts = new Map();
    this._pipelineLayouts = new Map();

    // Group 0: Frame globals + shadow depth map + comparison sampler + environment map & sampler
    this.group0Layout = device.createBindGroupLayout({
      label: 'M3D_Group0_Globals',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });

    // Group 1: Per-object dynamic uniform + skinning storage + morph storage
    this.group1Layout = device.createBindGroupLayout({
      label: 'M3D_Group1_Object',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: OBJECT_UNIFORM_BYTES } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });

    // Group 2 outline-only layout (1 uniform vec4 color)
    this.outlineGroup2Layout = device.createBindGroupLayout({
      label: 'M3D_Outline_Group2',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 16 } },
      ],
    });

    this.shadowPipelineLayout = device.createPipelineLayout({
      label: 'M3D_ShadowLayout',
      bindGroupLayouts: [this.group0Layout, this.group1Layout],
    });

    this.outlinePipelineLayout = device.createPipelineLayout({
      label: 'M3D_OutlineLayout',
      bindGroupLayouts: [this.group0Layout, this.group1Layout, this.outlineGroup2Layout],
    });
  }

  getGroup2Layout(texMask) {
    let layout = this._group2Layouts.get(texMask);
    if (layout) return layout;

    const entries = [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: MATERIAL_UNIFORM_BYTES } },
    ];
    // Bits: 1=map(1,2), 2=normal(3,4), 4=emissive(5,6), 8=ao(7,8), 16=mr(9,10), 32=matcap(11,12), 64=roughness(13,14), 128=metalness(15,16)
    const slots = [
      [1, 1, 2],
      [2, 3, 4],
      [4, 5, 6],
      [8, 7, 8],
      [16, 9, 10],
      [32, 11, 12],
      [64, 13, 14],
      [128, 15, 16],
    ];
    for (let i = 0; i < slots.length; i++) {
      const [bit, texB, sampB] = slots[i];
      if (texMask & bit) {
        entries.push({ binding: texB, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } });
        entries.push({ binding: sampB, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } });
      }
    }

    layout = this.device.createBindGroupLayout({
      label: `M3D_Group2_Mat_${texMask}`,
      entries,
    });
    this._group2Layouts.set(texMask, layout);
    return layout;
  }

  getPipelineLayout(texMask) {
    let pl = this._pipelineLayouts.get(texMask);
    if (pl) return pl;
    pl = this.device.createPipelineLayout({
      label: `M3D_PipeLayout_${texMask}`,
      bindGroupLayouts: [this.group0Layout, this.group1Layout, this.getGroup2Layout(texMask)],
    });
    this._pipelineLayouts.set(texMask, pl);
    return pl;
  }

  getShaderModule(wgslCode) {
    let mod = this._shaderModules.get(wgslCode);
    if (!mod) {
      mod = this.device.createShaderModule({ code: wgslCode });
      this._shaderModules.set(wgslCode, mod);
    }
    return mod;
  }

  buildVertexBuffers(attrInfo, instanced, skinned) {
    const buffers = [];
    const slotNames = [];

    // slot 0: position (siempre presente)
    buffers.push({
      arrayStride: 12,
      stepMode: 'vertex',
      attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
    });
    slotNames.push('position');

    if (attrInfo.hasNormal) {
      buffers.push({
        arrayStride: 12,
        stepMode: 'vertex',
        attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }],
      });
      slotNames.push('normal');
    }
    if (attrInfo.hasUv) {
      buffers.push({
        arrayStride: 8,
        stepMode: 'vertex',
        attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x2' }],
      });
      slotNames.push('uv');
    }
    if (attrInfo.colorSize > 0) {
      const sz = attrInfo.colorSize === 3 ? 3 : 4;
      buffers.push({
        arrayStride: sz * 4,
        stepMode: 'vertex',
        attributes: [{ shaderLocation: 7, offset: 0, format: sz === 3 ? 'float32x3' : 'float32x4' }],
      });
      slotNames.push('color');
    }
    if (attrInfo.hasUv1) {
      buffers.push({
        arrayStride: 8,
        stepMode: 'vertex',
        attributes: [{ shaderLocation: 10, offset: 0, format: 'float32x2' }],
      });
      slotNames.push('uv1');
    }
    if (instanced) {
      buffers.push({
        arrayStride: 64,
        stepMode: 'instance',
        attributes: [
          { shaderLocation: 3, offset: 0, format: 'float32x4' },
          { shaderLocation: 4, offset: 16, format: 'float32x4' },
          { shaderLocation: 5, offset: 32, format: 'float32x4' },
          { shaderLocation: 6, offset: 48, format: 'float32x4' },
        ],
      });
      slotNames.push('instance');
    } else if (skinned) {
      buffers.push({
        arrayStride: 16,
        stepMode: 'vertex',
        attributes: [{ shaderLocation: 8, offset: 0, format: 'float32x4' }],
      });
      slotNames.push('skinIndex');
      buffers.push({
        arrayStride: 16,
        stepMode: 'vertex',
        attributes: [{ shaderLocation: 9, offset: 0, format: 'float32x4' }],
      });
      slotNames.push('skinWeight');
    }

    return { buffers, slotNames };
  }

  getRenderPipeline(desc) {
    const {
      cacheKey,
      wgslTemplate,
      defines,
      instanced,
      srgb,
      custom,
      texMask,
      attrInfo,
      topology,
      cullMode,
      blendMode,
      depthTest,
      depthWrite,
      colorFormat,
      depthFormat,
      hasFragment = true,
      layoutOverride = null,
    } = desc;

    let entry = this._pipelines.get(cacheKey);
    if (entry) return entry;

    const fullDefs = Object.assign({}, defines);
    if (attrInfo.hasNormal) fullDefs.HAS_NORMAL = 1;
    if (attrInfo.hasUv) fullDefs.HAS_UV = 1;
    if (attrInfo.colorSize > 0) fullDefs.HAS_COLOR = 1;
    if (attrInfo.hasUv1) fullDefs.HAS_UV1 = 1;

    const wgslCode = buildWgslSource(wgslTemplate, fullDefs, instanced, srgb, custom);
    const mod = this.getShaderModule(wgslCode);
    const { buffers, slotNames } = this.buildVertexBuffers(attrInfo, instanced, !!fullDefs.USE_SKINNING);

    const layout = layoutOverride || this.getPipelineLayout(texMask);

    let blend = undefined;
    if (blendMode === 'normal') {
      blend = {
        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      };
    } else if (blendMode === 'additive') {
      blend = {
        color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
      };
    }

    const pipeDesc = {
      layout,
      vertex: {
        module: mod,
        entryPoint: 'vs_main',
        buffers,
      },
      primitive: {
        topology,
        cullMode,
        frontFace: 'ccw',
      },
    };

    if (hasFragment) {
      pipeDesc.fragment = {
        module: mod,
        entryPoint: 'fs_main',
        targets: [{ format: colorFormat, blend }],
      };
    }

    if (depthFormat) {
      pipeDesc.depthStencil = {
        format: depthFormat,
        depthWriteEnabled: depthWrite,
        depthCompare: depthTest ? 'less-equal' : 'always',
      };
    }

    const pipeline = this.device.createRenderPipeline(pipeDesc);
    entry = { pipeline, slotNames };
    this._pipelines.set(cacheKey, entry);
    return entry;
  }

  clear() {
    this._shaderModules.clear();
    this._pipelines.clear();
    this._group2Layouts.clear();
    this._pipelineLayouts.clear();
  }
}
