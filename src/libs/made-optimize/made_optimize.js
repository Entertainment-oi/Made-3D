// Puente ES Module nativo para MadeOptimize (`made_optimize.wasm`) sin Emscripten ni eval.
// Funciona tanto en navegador (fetch) como en Node.js (fs/promises).

const DEFAULT_WASM_URL = new URL('./made_optimize.wasm', import.meta.url).href;
const _instanceCache = new Map();

async function loadWasmBytes(wasmUrl) {
  if (
    wasmUrl.startsWith('file://') &&
    typeof process !== 'undefined' &&
    process.versions &&
    process.versions.node
  ) {
    const fs = await import('fs/promises');
    const { fileURLToPath } = await import('url');
    return fs.readFile(fileURLToPath(wasmUrl));
  }
  const res = await fetch(wasmUrl);
  if (!res.ok) {
    throw new Error(`MadeOptimize: no se pudo cargar ${wasmUrl} (${res.status})`);
  }
  return res.arrayBuffer();
}

export async function loadMadeOptimize(wasmUrl = DEFAULT_WASM_URL) {
  if (_instanceCache.has(wasmUrl)) return _instanceCache.get(wasmUrl);

  const p = (async () => {
    const bytes = await loadWasmBytes(wasmUrl);
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return instance.exports;
  })().catch((err) => {
    _instanceCache.delete(wasmUrl);
    throw err;
  });

  _instanceCache.set(wasmUrl, p);
  return p;
}

function readBytesHandle(wasm, handle, label) {
  try {
    const status = wasm.mo_bytes_status(handle);
    if (status !== 0) {
      const ptr = wasm.mo_bytes_error_ptr(handle);
      const len = wasm.mo_bytes_error_len(handle);
      const msg = new TextDecoder().decode(new Uint8Array(wasm.memory.buffer, ptr, len));
      throw new Error(`${label} (${status}): ${msg}`);
    }
    const ptr = wasm.mo_bytes_ptr(handle);
    const len = wasm.mo_bytes_len(handle);
    return new Uint8Array(wasm.memory.buffer, ptr, len).slice();
  } finally {
    if (handle) wasm.mo_bytes_free(handle);
  }
}

/**
 * Decodifica un buffer Draco (.drc / KHR_draco_mesh_compression) usando made_optimize.wasm.
 */
export async function decodeDraco(data, attributeMap = null, accessorsInfo = {}, wasmUrl) {
  const wasm = await loadMadeOptimize(wasmUrl);
  const bytes =
    data instanceof Uint8Array
      ? data
      : data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

  const inPtr = wasm.mo_alloc(bytes.byteLength);
  if (!inPtr) throw new Error('MadeOptimize: fallo al asignar memoria.');

  let handle = 0;
  try {
    new Uint8Array(wasm.memory.buffer, inPtr, bytes.byteLength).set(bytes);
    handle = wasm.mo_draco_decode(inPtr, bytes.byteLength);
  } finally {
    wasm.mo_free(inPtr, bytes.byteLength);
  }

  try {
    const status = wasm.mo_result_status(handle);
    if (status !== 0) {
      const errPtr = wasm.mo_result_error_ptr(handle);
      const errLen = wasm.mo_result_error_len(handle);
      const msg = new TextDecoder().decode(new Uint8Array(wasm.memory.buffer, errPtr, errLen));
      throw new Error(`MadeOptimize Draco (${status}): ${msg}`);
    }

    const geometryType = wasm.mo_result_geometry_type(handle);
    const numPoints = wasm.mo_result_num_points(handle);
    const numFaces = wasm.mo_result_num_faces(handle);

    let indices = null;
    const idxLen = wasm.mo_result_indices_len(handle);
    if (geometryType === 1 && idxLen > 0) {
      if (wasm.mo_result_indices_is_u16(handle)) {
        indices = new Uint16Array(wasm.memory.buffer, wasm.mo_result_indices_u16_ptr(handle), idxLen).slice();
      } else {
        indices = new Uint32Array(wasm.memory.buffer, wasm.mo_result_indices_u32_ptr(handle), idxLen).slice();
      }
    }

    if (attributeMap) {
      for (const [gltfName, uniqueId] of Object.entries(attributeMap)) {
        const acc = accessorsInfo[gltfName];
        wasm.mo_result_postprocess_gltf(
          handle,
          uniqueId,
          acc ? acc.componentType || 0 : 0,
          acc && acc.normalized ? 1 : 0,
          gltfName === 'WEIGHTS_0' ? 1 : 0
        );
      }
    }

    const attrCount = wasm.mo_result_attr_count(handle);
    const attributes = [];
    for (let i = 0; i < attrCount; i++) {
      const uniqueId = wasm.mo_result_attr_unique_id(handle, i);
      const attrType = wasm.mo_result_attr_type(handle, i);
      const itemSize = wasm.mo_result_attr_components(handle, i);
      const len = wasm.mo_result_attr_f32_len(handle, i);
      const ptr = wasm.mo_result_attr_f32_ptr(handle, i);
      const array = new Float32Array(wasm.memory.buffer, ptr, len).slice();
      attributes.push({ uniqueId, attrType, itemSize, array });
    }

    return { geometryType, numPoints, numFaces, indices, attributes };
  } finally {
    if (handle) wasm.mo_result_free(handle);
  }
}

/**
 * Comprime una malla a formato Draco v2.2 usando made_optimize.wasm (`Uint8Array`).
 */
export async function encodeDraco({ numPoints, indices, attributes }, wasmUrl) {
  const wasm = await loadMadeOptimize(wasmUrl);
  let idxPtr = 0;
  let idxLen = 0;
  if (indices && indices.length > 0) {
    const idxU32 = indices instanceof Uint32Array ? indices : Uint32Array.from(indices);
    idxLen = idxU32.length;
    idxPtr = wasm.mo_alloc(idxU32.byteLength);
    new Uint32Array(wasm.memory.buffer, idxPtr, idxLen).set(idxU32);
  }

  let builder = 0;
  try {
    builder = wasm.mo_draco_encode_begin(numPoints, idxPtr, idxLen);
  } finally {
    if (idxPtr) wasm.mo_free(idxPtr, idxLen * 4);
  }

  for (const attr of attributes) {
    const arr = attr.values instanceof Float32Array ? attr.values : Float32Array.from(attr.values);
    const ptr = wasm.mo_alloc(arr.byteLength);
    try {
      new Float32Array(wasm.memory.buffer, ptr, arr.length).set(arr);
      wasm.mo_draco_encode_add_attr(
        builder,
        attr.attributeType ?? 4,
        attr.numComponents,
        attr.uniqueId,
        attr.quantizationBits ?? 14,
        ptr,
        arr.length
      );
    } finally {
      wasm.mo_free(ptr, arr.byteLength);
    }
  }

  const handle = wasm.mo_draco_encode_finish(builder);
  return readBytesHandle(wasm, handle, 'MadeOptimize Encode');
}

/**
 * Decodifica un buffer Meshopt (`EXT_meshopt_compression`).
 */
export async function decodeMeshopt(src, count, stride, mode = 'ATTRIBUTES', filter = 'NONE', wasmUrl) {
  const wasm = await loadMadeOptimize(wasmUrl);
  const bytes = src instanceof Uint8Array ? src : new Uint8Array(src);
  const modeId = mode === 'ATTRIBUTES' ? 0 : mode === 'TRIANGLES' ? 1 : 2;
  const filterId =
    filter === 'OCTAHEDRAL' ? 1 : filter === 'QUATERNION' ? 2 : filter === 'EXPONENTIAL' ? 3 : 0;

  const ptr = wasm.mo_alloc(bytes.byteLength);
  let handle = 0;
  try {
    new Uint8Array(wasm.memory.buffer, ptr, bytes.byteLength).set(bytes);
    handle = wasm.mo_meshopt_decode(ptr, bytes.byteLength, count, stride, modeId, filterId);
  } finally {
    wasm.mo_free(ptr, bytes.byteLength);
  }
  return readBytesHandle(wasm, handle, 'MadeOptimize Meshopt');
}

function readOptimizeHandle(wasm, handle) {
  try {
    const numPoints = wasm.mo_opt_num_points(handle);
    const outIdxLen = wasm.mo_opt_indices_len(handle);
    const outIndices = new Uint32Array(wasm.memory.buffer, wasm.mo_opt_indices_ptr(handle), outIdxLen).slice();
    const vertexRemap = new Uint32Array(wasm.memory.buffer, wasm.mo_opt_remap_ptr(handle), numPoints).slice();
    const outPositions = new Float32Array(
      wasm.memory.buffer,
      wasm.mo_opt_positions_ptr(handle),
      numPoints * 3
    ).slice();

    return { numPoints, indices: outIndices, vertexRemap, positions: outPositions };
  } finally {
    if (handle) wasm.mo_opt_free(handle);
  }
}

/**
 * Optimiza vértices e índices para caché GPU (deduplicación + Forsyth + Vertex Fetch).
 */
export async function optimizeMesh(positions, indices = null, dedupStep = 0, wasmUrl) {
  const wasm = await loadMadeOptimize(wasmUrl);
  const posF32 = positions instanceof Float32Array ? positions : Float32Array.from(positions);
  const posPtr = wasm.mo_alloc(posF32.byteLength);
  new Float32Array(wasm.memory.buffer, posPtr, posF32.length).set(posF32);

  let idxPtr = 0;
  let idxLen = 0;
  if (indices && indices.length > 0) {
    const idxU32 = indices instanceof Uint32Array ? indices : Uint32Array.from(indices);
    idxLen = idxU32.length;
    idxPtr = wasm.mo_alloc(idxU32.byteLength);
    new Uint32Array(wasm.memory.buffer, idxPtr, idxLen).set(idxU32);
  }

  let handle = 0;
  try {
    handle = wasm.mo_mesh_optimize(posPtr, posF32.length, idxPtr, idxLen, dedupStep);
  } finally {
    wasm.mo_free(posPtr, posF32.byteLength);
    if (idxPtr) wasm.mo_free(idxPtr, idxLen * 4);
  }

  return readOptimizeHandle(wasm, handle);
}

/**
 * Optimiza vértices e índices preservando costuras cuando coinciden posiciones pero difieren atributos extra.
 */
export async function optimizeMeshWithAttrs(
  positions,
  extraAttrs = null,
  extraStride = 0,
  indices = null,
  dedupStep = 0,
  wasmUrl
) {
  const wasm = await loadMadeOptimize(wasmUrl);
  if (typeof wasm.mo_mesh_optimize_attrs !== 'function' || !extraAttrs || extraStride <= 0) {
    return optimizeMesh(positions, indices, dedupStep, wasmUrl);
  }

  const posF32 = positions instanceof Float32Array ? positions : Float32Array.from(positions);
  const posPtr = wasm.mo_alloc(posF32.byteLength);
  new Float32Array(wasm.memory.buffer, posPtr, posF32.length).set(posF32);

  const extraF32 = extraAttrs instanceof Float32Array ? extraAttrs : Float32Array.from(extraAttrs);
  const extraPtr = extraF32.byteLength > 0 ? wasm.mo_alloc(extraF32.byteLength) : 0;
  if (extraPtr) {
    new Float32Array(wasm.memory.buffer, extraPtr, extraF32.length).set(extraF32);
  }

  let idxPtr = 0;
  let idxLen = 0;
  if (indices && indices.length > 0) {
    const idxU32 = indices instanceof Uint32Array ? indices : Uint32Array.from(indices);
    idxLen = idxU32.length;
    idxPtr = wasm.mo_alloc(idxU32.byteLength);
    new Uint32Array(wasm.memory.buffer, idxPtr, idxLen).set(idxU32);
  }

  let handle = 0;
  try {
    handle = wasm.mo_mesh_optimize_attrs(
      posPtr,
      posF32.length,
      extraPtr,
      extraF32.length,
      extraStride,
      idxPtr,
      idxLen,
      dedupStep
    );
  } finally {
    wasm.mo_free(posPtr, posF32.byteLength);
    if (extraPtr) wasm.mo_free(extraPtr, extraF32.byteLength);
    if (idxPtr) wasm.mo_free(idxPtr, idxLen * 4);
  }

  return readOptimizeHandle(wasm, handle);
}

function hasAttributeSeams(geometry, dedupStep = 0) {
  const posAttr = geometry.attributes.position;
  const otherEntries = Object.entries(geometry.attributes).filter(
    ([name, attr]) => name !== 'position' && attr && attr.array
  );
  if (otherEntries.length === 0) return false;

  const count = posAttr.count;
  const pos = posAttr.array;
  const invStep = dedupStep > 0 ? 1 / dedupStep : 0;
  const firstAtPos = new Map();

  for (let i = 0; i < count; i++) {
    const pOff = i * 3;
    const key =
      invStep > 0
        ? `${Math.round(pos[pOff] * invStep)}|${Math.round(pos[pOff + 1] * invStep)}|${Math.round(pos[pOff + 2] * invStep)}`
        : `${pos[pOff]}|${pos[pOff + 1]}|${pos[pOff + 2]}`;
    const prev = firstAtPos.get(key);
    if (prev === undefined) {
      firstAtPos.set(key, i);
      continue;
    }
    for (const [, attr] of otherEntries) {
      const itemSize = attr.itemSize || 3;
      const arr = attr.array;
      const aOff = prev * itemSize;
      const bOff = i * itemSize;
      for (let c = 0; c < itemSize; c++) {
        if (Math.abs((arr[aOff + c] ?? 0) - (arr[bOff + c] ?? 0)) > 1e-5) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Optimiza una instancia `Geometry` de Made3D in-place (o devolviendo una copia optimizada)
 * aplicando deduplicación de vértices + Forsyth Vertex Cache + Vertex Fetch.
 */
export async function optimizeGeometry(
  geometry,
  { dedupStep = 0, inPlace = true, weldPositionsOnly = false, wasmUrl } = {}
) {
  const posAttr = geometry?.attributes?.position;
  if (!posAttr) return geometry;

  const target = inPlace ? geometry : geometry.clone();
  const wasm = await loadMadeOptimize(wasmUrl);
  const otherEntries = Object.entries(geometry.attributes).filter(
    ([name, attr]) => name !== 'position' && attr && attr.array
  );

  let res;
  if (weldPositionsOnly || otherEntries.length === 0) {
    res = await optimizeMesh(posAttr.array, geometry.index?.array || null, dedupStep, wasmUrl);
  } else if (typeof wasm.mo_mesh_optimize_attrs === 'function') {
    const count = posAttr.count;
    let extraStride = 0;
    for (const [, attr] of otherEntries) {
      extraStride += attr.itemSize || 3;
    }
    const extraAttrs = new Float32Array(count * extraStride);
    for (let i = 0; i < count; i++) {
      let col = 0;
      const rowBase = i * extraStride;
      for (const [, attr] of otherEntries) {
        const itemSize = attr.itemSize || 3;
        const arr = attr.array;
        const srcOff = i * itemSize;
        for (let c = 0; c < itemSize; c++) {
          extraAttrs[rowBase + col++] = arr[srcOff + c] ?? 0;
        }
      }
    }
    res = await optimizeMeshWithAttrs(
      posAttr.array,
      extraAttrs,
      extraStride,
      geometry.index?.array || null,
      dedupStep,
      wasmUrl
    );
  } else {
    // Fallback compatible con made_optimize.wasm v0.1.0 sin mo_mesh_optimize_attrs:
    // conservamos costuras sin soldar posiciones agresivamente.
    if (hasAttributeSeams(geometry, dedupStep)) {
      return target;
    }
    res = await optimizeMesh(posAttr.array, geometry.index?.array || null, dedupStep, wasmUrl);
  }

  const remap = res.vertexRemap;

  target.setAttribute('position', res.positions, 3);
  for (const [name, attr] of otherEntries) {
    const itemSize = attr.itemSize || 3;
    const src = attr.array;
    const dst = new Float32Array(res.numPoints * itemSize);
    for (let i = 0; i < res.numPoints; i++) {
      const oldIdx = remap[i];
      const srcOff = oldIdx * itemSize;
      const dstOff = i * itemSize;
      for (let c = 0; c < itemSize; c++) {
        dst[dstOff + c] = src[srcOff + c] ?? 0;
      }
    }
    target.setAttribute(name, dst, itemSize);
  }

  const finalIdx = res.numPoints <= 65535 ? Uint16Array.from(res.indices) : res.indices;
  target.setIndex(finalIdx);
  return target;
}
