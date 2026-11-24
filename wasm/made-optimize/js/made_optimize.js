// Puente ES Module nativo para MadeOptimize (`made_optimize.wasm`) sin Emscripten ni eval.
// Funciona tanto en navegador (fetch) como en Node.js (fs/promises).

const DEFAULT_WASM_URL = new URL('../dist/made_optimize.wasm', import.meta.url).href;
const _instanceCache = new Map();
const _resolvedExports = new Map();

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
    _resolvedExports.set(wasmUrl, instance.exports);
    return instance.exports;
  })().catch((err) => {
    _instanceCache.delete(wasmUrl);
    _resolvedExports.delete(wasmUrl);
    throw err;
  });

  _instanceCache.set(wasmUrl, p);
  return p;
}

export function getMadeOptimizeSync(wasmUrl = DEFAULT_WASM_URL) {
  return _resolvedExports.get(wasmUrl) || null;
}

export function preloadMadeOptimize(wasmUrl = DEFAULT_WASM_URL) {
  return loadMadeOptimize(wasmUrl);
}

export function getMadeOptimizeCapabilities(wasmUrl = DEFAULT_WASM_URL) {
  const w = _resolvedExports.get(wasmUrl);
  if (!w) {
    return { loaded: false, bvh: false, lod: false, meshlets: false, optimizeAttrs: false };
  }
  return {
    loaded: true,
    bvh: typeof w.mo_bvh_create === 'function',
    lod: typeof w.mo_lod_simplify === 'function',
    meshlets: typeof w.mo_meshlets_build === 'function',
    optimizeAttrs: typeof w.mo_mesh_optimize_attrs === 'function',
  };
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

// ============================================================================
// 5. BVH + FRUSTUM CULLING + SELECCIÓN DE LOD (WASM con fallback JS)
// ============================================================================

function aabbIntersectsFrustumJS(minX, minY, minZ, maxX, maxY, maxZ, planes) {
  for (let p = 0; p < 24; p += 4) {
    const nx = planes[p];
    const ny = planes[p + 1];
    const nz = planes[p + 2];
    const d = planes[p + 3];
    const px = nx >= 0 ? maxX : minX;
    const py = ny >= 0 ? maxY : minY;
    const pz = nz >= 0 ? maxZ : minZ;
    if (nx * px + ny * py + nz * pz + d < 0) return false;
  }
  return true;
}

function sphereIntersectsFrustumJS(cx, cy, cz, r, planes) {
  for (let p = 0; p < 24; p += 4) {
    if (planes[p] * cx + planes[p + 1] * cy + planes[p + 2] * cz + planes[p + 3] < -r) {
      return false;
    }
  }
  return true;
}

class JsSceneBvhFallback {
  constructor(spheres) {
    this.spheres = new Float32Array(0);
    this.itemCount = 0;
    this.order = new Uint32Array(0);
    this.nodes = [];
    this.visibleIndices = new Uint32Array(0);
    this.visibleLods = new Uint32Array(0);
    this._stack = [];
    if (spheres && spheres.length >= 4) {
      this.rebuild(spheres);
    }
  }

  rebuild(spheres) {
    const count = Math.floor((spheres?.length || 0) / 4);
    this.spheres = spheres instanceof Float32Array ? spheres.slice(0, count * 4) : Float32Array.from(spheres.slice(0, count * 4));
    this.itemCount = count;
    this.order = new Uint32Array(count);
    for (let i = 0; i < count; i++) this.order[i] = i;
    this.nodes = [];
    if (this.visibleIndices.length < count) {
      this.visibleIndices = new Uint32Array(count);
      this.visibleLods = new Uint32Array(count);
    }
    if (count > 0) {
      this.nodes.push({ minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0, left: 0, right: 0, count: 0 });
      this._subdivide(0, 0, count);
    }
  }

  updateItem(index, cx, cy, cz, radius) {
    if (index < 0 || index >= this.itemCount) return false;
    const b = index * 4;
    this.spheres[b] = cx;
    this.spheres[b + 1] = cy;
    this.spheres[b + 2] = cz;
    this.spheres[b + 3] = Math.max(0, radius);
    return true;
  }

  refit() {
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i];
      if (n.count > 0) {
        this._computeBounds(n.left, n.left + n.count, n);
      } else {
        const l = this.nodes[n.left];
        const r = this.nodes[n.right];
        n.minX = Math.min(l.minX, r.minX);
        n.minY = Math.min(l.minY, r.minY);
        n.minZ = Math.min(l.minZ, r.minZ);
        n.maxX = Math.max(l.maxX, r.maxX);
        n.maxY = Math.max(l.maxY, r.maxY);
        n.maxZ = Math.max(l.maxZ, r.maxZ);
      }
    }
  }

  _computeBounds(start, end, out) {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    const s = this.spheres;
    for (let slot = start; slot < end; slot++) {
      const b = this.order[slot] * 4;
      const cx = s[b], cy = s[b + 1], cz = s[b + 2], r = Math.max(0, s[b + 3]);
      if (cx - r < minX) minX = cx - r;
      if (cy - r < minY) minY = cy - r;
      if (cz - r < minZ) minZ = cz - r;
      if (cx + r > maxX) maxX = cx + r;
      if (cy + r > maxY) maxY = cy + r;
      if (cz + r > maxZ) maxZ = cz + r;
    }
    out.minX = Number.isFinite(minX) ? minX : 0;
    out.minY = Number.isFinite(minY) ? minY : 0;
    out.minZ = Number.isFinite(minZ) ? minZ : 0;
    out.maxX = Number.isFinite(maxX) ? maxX : 0;
    out.maxY = Number.isFinite(maxY) ? maxY : 0;
    out.maxZ = Number.isFinite(maxZ) ? maxZ : 0;
  }

  _subdivide(nodeIdx, start, end) {
    const node = this.nodes[nodeIdx];
    this._computeBounds(start, end, node);
    const count = end - start;
    if (count <= 4) {
      node.left = start;
      node.right = 0;
      node.count = count;
      return;
    }

    const s = this.spheres;
    let cMinX = Infinity, cMinY = Infinity, cMinZ = Infinity;
    let cMaxX = -Infinity, cMaxY = -Infinity, cMaxZ = -Infinity;
    for (let slot = start; slot < end; slot++) {
      const b = this.order[slot] * 4;
      const x = s[b], y = s[b + 1], z = s[b + 2];
      if (x < cMinX) cMinX = x; if (x > cMaxX) cMaxX = x;
      if (y < cMinY) cMinY = y; if (y > cMaxY) cMaxY = y;
      if (z < cMinZ) cMinZ = z; if (z > cMaxZ) cMaxZ = z;
    }
    const ex = cMaxX - cMinX, ey = cMaxY - cMinY, ez = cMaxZ - cMinZ;
    const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
    const splitVal = axis === 0 ? (cMinX + cMaxX) * 0.5 : axis === 1 ? (cMinY + cMaxY) * 0.5 : (cMinZ + cMaxZ) * 0.5;

    let mid = start;
    if (Math.max(ex, ey, ez) > 1e-7) {
      let i = start, j = end - 1;
      while (i <= j) {
        if (s[this.order[i] * 4 + axis] < splitVal) {
          i++;
        } else {
          const tmp = this.order[i];
          this.order[i] = this.order[j];
          this.order[j] = tmp;
          j--;
        }
      }
      mid = i;
    }
    if (mid === start || mid === end) mid = start + (count >> 1);

    const leftIdx = this.nodes.length;
    this.nodes.push({ minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0, left: 0, right: 0, count: 0 });
    this._subdivide(leftIdx, start, mid);

    const rightIdx = this.nodes.length;
    this.nodes.push({ minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0, left: 0, right: 0, count: 0 });
    this._subdivide(rightIdx, mid, end);

    node.left = leftIdx;
    node.right = rightIdx;
    node.count = 0;
  }

  queryFrustum(planes, camPos, lodThresholds) {
    if (!this.nodes.length) return 0;
    const stack = this._stack;
    stack.length = 0;
    stack.push(0);

    const s = this.spheres;
    const cx0 = camPos[0] || 0, cy0 = camPos[1] || 0, cz0 = camPos[2] || 0;
    const tLen = lodThresholds ? lodThresholds.length : 0;
    let outN = 0;

    while (stack.length > 0) {
      const n = this.nodes[stack.pop()];
      if (!aabbIntersectsFrustumJS(n.minX, n.minY, n.minZ, n.maxX, n.maxY, n.maxZ, planes)) continue;
      if (n.count > 0) {
        const end = n.left + n.count;
        for (let slot = n.left; slot < end; slot++) {
          const id = this.order[slot];
          const b = id * 4;
          const x = s[b], y = s[b + 1], z = s[b + 2], r = Math.max(0, s[b + 3]);
          if (!sphereIntersectsFrustumJS(x, y, z, r, planes)) continue;
          let lod = 0;
          if (tLen > 1) {
            const dist = Math.max(0, Math.hypot(x - cx0, y - cy0, z - cz0) - r);
            for (let k = tLen - 1; k > 0; k--) {
              if (dist >= lodThresholds[k]) { lod = k; break; }
            }
          }
          this.visibleIndices[outN] = id;
          this.visibleLods[outN] = lod;
          outN++;
        }
      } else {
        stack.push(n.right);
        stack.push(n.left);
      }
    }
    return outN;
  }
}

/**
 * BVH de escena / chunks con Frustum Culling + selección de LOD.
 * Usa `made_optimize.wasm` (`mo_bvh_*`) de forma síncrona cuando está disponible y cae limpiamente a JS en v0.2.0.
 */
export class SceneBvh {
  constructor(spheres = null, wasmUrl = DEFAULT_WASM_URL) {
    this.wasmUrl = wasmUrl;
    this._wasm = null;
    this._handle = 0;
    this._planesPtr = 0;
    this._threshPtr = 0;
    this._threshCap = 0;
    this._fallback = new JsSceneBvhFallback(spheres);
    this._itemCount = this._fallback.itemCount;
    this._lastSpheres = spheres ? (spheres instanceof Float32Array ? spheres.slice() : Float32Array.from(spheres)) : null;

    const syncWasm = getMadeOptimizeSync(wasmUrl);
    if (syncWasm && typeof syncWasm.mo_bvh_create === 'function') {
      this._initWasm(syncWasm, spheres);
    } else {
      loadMadeOptimize(wasmUrl)
        .then((w) => {
          if (!this._disposed && typeof w.mo_bvh_create === 'function' && !this._wasm) {
            this._initWasm(w, this._lastSpheres);
          }
        })
        .catch(() => {});
    }
  }

  static async create(spheres = null, wasmUrl = DEFAULT_WASM_URL) {
    await loadMadeOptimize(wasmUrl).catch(() => null);
    return new SceneBvh(spheres, wasmUrl);
  }

  get backend() {
    return this._wasm && this._handle ? 'wasm' : 'js';
  }

  get itemCount() {
    return this._itemCount;
  }

  _initWasm(wasm, spheres) {
    this._wasm = wasm;
    this._planesPtr = wasm.mo_alloc(24 * 4);
    const count = Math.floor((spheres?.length || 0) / 4);
    if (count > 0) {
      const f32 = spheres instanceof Float32Array ? spheres : Float32Array.from(spheres);
      const ptr = wasm.mo_alloc(count * 16);
      try {
        new Float32Array(wasm.memory.buffer, ptr, count * 4).set(f32.subarray(0, count * 4));
        this._handle = wasm.mo_bvh_create(ptr, count);
      } finally {
        wasm.mo_free(ptr, count * 16);
      }
    } else {
      this._handle = wasm.mo_bvh_create(0, 0);
    }
    this._itemCount = count;
  }

  rebuild(spheres) {
    const count = Math.floor((spheres?.length || 0) / 4);
    this._itemCount = count;
    const f32 = spheres instanceof Float32Array ? spheres : Float32Array.from(spheres || []);
    this._lastSpheres = f32.slice(0, count * 4);
    this._fallback.rebuild(this._lastSpheres);

    if (this._wasm && this._handle) {
      const ptr = count > 0 ? this._wasm.mo_alloc(count * 16) : 0;
      try {
        if (ptr) new Float32Array(this._wasm.memory.buffer, ptr, count * 4).set(this._lastSpheres);
        this._wasm.mo_bvh_rebuild(this._handle, ptr, count);
      } finally {
        if (ptr) this._wasm.mo_free(ptr, count * 16);
      }
    }
    return this;
  }

  updateItem(index, cx, cy, cz, radius) {
    if (this._lastSpheres && index >= 0 && index * 4 + 3 < this._lastSpheres.length) {
      const b = index * 4;
      this._lastSpheres[b] = cx;
      this._lastSpheres[b + 1] = cy;
      this._lastSpheres[b + 2] = cz;
      this._lastSpheres[b + 3] = Math.max(0, radius);
    }
    if (this._wasm && this._handle) {
      return this._wasm.mo_bvh_update_item(this._handle, index, cx, cy, cz, radius) !== 0;
    }
    return this._fallback.updateItem(index, cx, cy, cz, radius);
  }

  refit() {
    if (this._wasm && this._handle) {
      this._wasm.mo_bvh_refit(this._handle);
    } else {
      this._fallback.refit();
    }
    return this;
  }

  queryFrustum(planes24, camPos3 = [0, 0, 0], lodThresholds = null) {
    if (this._wasm && this._handle) {
      const w = this._wasm;
      const pView = new Float32Array(w.memory.buffer, this._planesPtr, 24);
      for (let i = 0; i < 24; i++) pView[i] = planes24[i];

      const tLen = lodThresholds ? lodThresholds.length : 0;
      if (tLen > this._threshCap) {
        if (this._threshPtr) w.mo_free(this._threshPtr, this._threshCap * 4);
        this._threshCap = Math.max(8, tLen);
        this._threshPtr = w.mo_alloc(this._threshCap * 4);
      }
      if (tLen > 0) {
        const tView = new Float32Array(w.memory.buffer, this._threshPtr, tLen);
        for (let i = 0; i < tLen; i++) tView[i] = lodThresholds[i];
      }

      const count = w.mo_bvh_query_frustum(
        this._handle,
        this._planesPtr,
        camPos3[0] || 0,
        camPos3[1] || 0,
        camPos3[2] || 0,
        tLen > 0 ? this._threshPtr : 0,
        tLen
      );
      const idxPtr = w.mo_bvh_visible_indices_ptr(this._handle);
      const lodPtr = w.mo_bvh_visible_lods_ptr(this._handle);
      const indices = count > 0 ? new Uint32Array(w.memory.buffer, idxPtr, count) : new Uint32Array(0);
      const lods = count > 0 ? new Uint32Array(w.memory.buffer, lodPtr, count) : new Uint32Array(0);
      return { count, indices, lods, backend: 'wasm' };
    }

    const count = this._fallback.queryFrustum(planes24, camPos3, lodThresholds);
    return {
      count,
      indices: this._fallback.visibleIndices.subarray(0, count),
      lods: this._fallback.visibleLods.subarray(0, count),
      backend: 'js',
    };
  }

  dispose() {
    this._disposed = true;
    if (this._wasm) {
      if (this._handle) { this._wasm.mo_bvh_free(this._handle); this._handle = 0; }
      if (this._planesPtr) { this._wasm.mo_free(this._planesPtr, 24 * 4); this._planesPtr = 0; }
      if (this._threshPtr) { this._wasm.mo_free(this._threshPtr, this._threshCap * 4); this._threshPtr = 0; }
      this._wasm = null;
    }
  }
}

export async function createSceneBvh(spheres = null, wasmUrl = DEFAULT_WASM_URL) {
  return SceneBvh.create(spheres, wasmUrl);
}

// ============================================================================
// 6. SIMPLIFICACIÓN QEM PARA LODs (WASM con fallback JS para v0.2.0)
// ============================================================================

function simplifyMeshFallbackJS(positions, indices, targetIndexCount) {
  const pos = positions instanceof Float32Array ? positions : Float32Array.from(positions);
  const vCount = Math.floor(pos.length / 3);
  const srcIdx = indices ? (indices instanceof Uint32Array ? indices : Uint32Array.from(indices)) : Uint32Array.from({ length: vCount }, (_, i) => i);
  const triCount = Math.floor(srcIdx.length / 3);
  const targetTris = Math.max(1, Math.floor(targetIndexCount / 3));
  if (triCount <= targetTris || vCount <= 3) {
    return {
      numPoints: vCount,
      positions: pos.slice(),
      indices: srcIdx.slice(),
      vertexRemap: Uint32Array.from({ length: vCount }, (_, i) => i),
      maxErrorReached: 0,
      backend: 'js',
    };
  }

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < vCount; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const extent = Math.max(1e-5, maxX - minX, maxY - minY, maxZ - minZ);
  const gridRes = Math.max(2, Math.round(Math.cbrt(Math.max(8, targetTris * 0.6))));
  const invCell = gridRes / extent;

  const cellMap = new Map();
  const vToCluster = new Uint32Array(vCount);
  const remap = [];
  const sumPos = [];
  const counts = [];

  for (let i = 0; i < vCount; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    const cx = Math.floor((x - minX) * invCell);
    const cy = Math.floor((y - minY) * invCell);
    const cz = Math.floor((z - minZ) * invCell);
    const key = `${cx}|${cy}|${cz}`;
    let id = cellMap.get(key);
    if (id === undefined) {
      id = remap.length;
      cellMap.set(key, id);
      remap.push(i);
      sumPos.push(x, y, z);
      counts.push(1);
    } else {
      sumPos[id * 3] += x;
      sumPos[id * 3 + 1] += y;
      sumPos[id * 3 + 2] += z;
      counts[id]++;
    }
    vToCluster[i] = id;
  }

  const outPos = new Float32Array(remap.length * 3);
  for (let i = 0; i < remap.length; i++) {
    const inv = 1 / counts[i];
    outPos[i * 3] = sumPos[i * 3] * inv;
    outPos[i * 3 + 1] = sumPos[i * 3 + 1] * inv;
    outPos[i * 3 + 2] = sumPos[i * 3 + 2] * inv;
  }

  const outIdx = [];
  for (let t = 0; t < triCount; t++) {
    const a = vToCluster[srcIdx[t * 3]];
    const b = vToCluster[srcIdx[t * 3 + 1]];
    const c = vToCluster[srcIdx[t * 3 + 2]];
    if (a !== b && b !== c && a !== c) {
      outIdx.push(a, b, c);
    }
  }

  return {
    numPoints: remap.length,
    positions: outPos,
    indices: Uint32Array.from(outIdx),
    vertexRemap: Uint32Array.from(remap),
    maxErrorReached: extent / gridRes,
    backend: 'js',
  };
}

/**
 * Simplifica buffers de malla usando QEM en `made_optimize.wasm` (`mo_lod_simplify`).
 */
export async function simplifyMesh(
  positions,
  indices = null,
  { ratio = 0.5, targetTriangles = null, maxError = 0, preserveBorders = true, wasmUrl } = {}
) {
  const posF32 = positions instanceof Float32Array ? positions : Float32Array.from(positions);
  const origIdxCount = indices ? indices.length : Math.floor(posF32.length / 3);
  const origTris = Math.max(1, Math.floor(origIdxCount / 3));
  const goalTris = targetTriangles != null
    ? Math.max(1, Math.floor(targetTriangles))
    : Math.max(1, Math.round(origTris * Math.max(0.01, Math.min(1, ratio))));
  const targetIndexCount = goalTris * 3;

  const wasm = await loadMadeOptimize(wasmUrl);
  if (typeof wasm.mo_lod_simplify !== 'function') {
    return simplifyMeshFallbackJS(posF32, indices, targetIndexCount);
  }

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
    handle = wasm.mo_lod_simplify(
      posPtr,
      posF32.length,
      idxPtr,
      idxLen,
      targetIndexCount,
      maxError,
      preserveBorders ? 1 : 0
    );
  } finally {
    wasm.mo_free(posPtr, posF32.byteLength);
    if (idxPtr) wasm.mo_free(idxPtr, idxLen * 4);
  }

  try {
    const numPoints = wasm.mo_lod_num_points(handle);
    const outIdxLen = wasm.mo_lod_indices_len(handle);
    const outPositions = numPoints > 0
      ? new Float32Array(wasm.memory.buffer, wasm.mo_lod_positions_ptr(handle), numPoints * 3).slice()
      : new Float32Array(0);
    const outIndices = outIdxLen > 0
      ? new Uint32Array(wasm.memory.buffer, wasm.mo_lod_indices_ptr(handle), outIdxLen).slice()
      : new Uint32Array(0);
    const vertexRemap = numPoints > 0
      ? new Uint32Array(wasm.memory.buffer, wasm.mo_lod_remap_ptr(handle), numPoints).slice()
      : new Uint32Array(0);
    const maxErrorReached = wasm.mo_lod_error(handle);
    return { numPoints, positions: outPositions, indices: outIndices, vertexRemap, maxErrorReached, backend: 'wasm' };
  } finally {
    if (handle) wasm.mo_lod_free(handle);
  }
}

/**
 * Genera una versión LOD simplificada de una instancia `Geometry` de Made3D remapeando atributos.
 */
export async function simplifyGeometry(
  geometry,
  { ratio = 0.5, targetTriangles = null, maxError = 0, preserveBorders = true, inPlace = false, wasmUrl } = {}
) {
  const posAttr = geometry?.attributes?.position;
  if (!posAttr) return geometry;

  const target = inPlace ? geometry : geometry.clone();
  const res = await simplifyMesh(posAttr.array, geometry.index?.array || null, {
    ratio,
    targetTriangles,
    maxError,
    preserveBorders,
    wasmUrl,
  });

  const remap = res.vertexRemap;
  const otherEntries = Object.entries(geometry.attributes).filter(
    ([name, attr]) => name !== 'position' && attr && attr.array
  );

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

// ============================================================================
// 7. MESHLETS / CLUSTERS PARA WEBGPU / STREAMING
// ============================================================================

function buildMeshletsFallbackJS(positions, indices, maxVertices, maxTriangles) {
  const pos = positions instanceof Float32Array ? positions : Float32Array.from(positions);
  const vCount = Math.floor(pos.length / 3);
  const srcIdx = indices ? (indices instanceof Uint32Array ? indices : Uint32Array.from(indices)) : Uint32Array.from({ length: vCount }, (_, i) => i);
  const triCount = Math.floor(srcIdx.length / 3);
  if (!vCount || !triCount) {
    return {
      count: 0,
      bounds: new Float32Array(0),
      cones: new Float32Array(0),
      ranges: new Uint32Array(0),
      indices: new Uint32Array(0),
      backend: 'js',
    };
  }

  const maxT = Math.max(1, Math.min(256, maxTriangles));
  const maxV = Math.max(3, Math.min(256, maxVertices));
  const bounds = [];
  const cones = [];
  const ranges = [];
  const outIdx = [];

  let t = 0;
  while (t < triCount) {
    const firstIndex = outIdx.length;
    const vertSet = new Set();
    let countT = 0;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    while (t < triCount && countT < maxT) {
      const a = srcIdx[t * 3], b = srcIdx[t * 3 + 1], c = srcIdx[t * 3 + 2];
      let added = 0;
      if (!vertSet.has(a)) added++;
      if (!vertSet.has(b) && b !== a) added++;
      if (!vertSet.has(c) && c !== a && c !== b) added++;
      if (countT > 0 && vertSet.size + added > maxV) break;

      vertSet.add(a); vertSet.add(b); vertSet.add(c);
      outIdx.push(a, b, c);
      for (const vid of [a, b, c]) {
        const px = pos[vid * 3], py = pos[vid * 3 + 1], pz = pos[vid * 3 + 2];
        if (px < minX) minX = px; if (px > maxX) maxX = px;
        if (py < minY) minY = py; if (py > maxY) maxY = py;
        if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;
      }
      countT++;
      t++;
    }

    const cx = 0.5 * (minX + maxX), cy = 0.5 * (minY + maxY), cz = 0.5 * (minZ + maxZ);
    let r2 = 0;
    for (const vid of vertSet) {
      const dx = pos[vid * 3] - cx, dy = pos[vid * 3 + 1] - cy, dz = pos[vid * 3 + 2] - cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2) r2 = d2;
    }
    bounds.push(cx, cy, cz, Math.sqrt(r2));
    cones.push(0, 1, 0, -1);
    ranges.push(firstIndex, countT * 3, 0, vertSet.size);
  }

  return {
    count: ranges.length / 4,
    bounds: Float32Array.from(bounds),
    cones: Float32Array.from(cones),
    ranges: Uint32Array.from(ranges),
    indices: Uint32Array.from(outIdx),
    backend: 'js',
  };
}

/**
 * Divide una geometría o buffers en meshlets/clusters con esferas envolventes y conos de normales.
 */
export async function buildMeshlets(
  geometryOrPositions,
  indicesOrOptions = null,
  maybeOptions = {}
) {
  let positions;
  let indices;
  let opts;
  if (geometryOrPositions && geometryOrPositions.attributes && geometryOrPositions.attributes.position) {
    positions = geometryOrPositions.attributes.position.array;
    indices = geometryOrPositions.index ? geometryOrPositions.index.array : null;
    opts = indicesOrOptions || {};
  } else {
    positions = geometryOrPositions;
    if (indicesOrOptions && !ArrayBuffer.isView(indicesOrOptions) && !Array.isArray(indicesOrOptions)) {
      indices = null;
      opts = indicesOrOptions;
    } else {
      indices = indicesOrOptions;
      opts = maybeOptions || {};
    }
  }

  const maxVertices = opts.maxVertices ?? 64;
  const maxTriangles = opts.maxTriangles ?? 64;
  const wasmUrl = opts.wasmUrl;

  const posF32 = positions instanceof Float32Array ? positions : Float32Array.from(positions);
  const wasm = await loadMadeOptimize(wasmUrl);
  if (typeof wasm.mo_meshlets_build !== 'function') {
    return buildMeshletsFallbackJS(posF32, indices, maxVertices, maxTriangles);
  }

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
    handle = wasm.mo_meshlets_build(posPtr, posF32.length, idxPtr, idxLen, maxVertices, maxTriangles);
  } finally {
    wasm.mo_free(posPtr, posF32.byteLength);
    if (idxPtr) wasm.mo_free(idxPtr, idxLen * 4);
  }

  try {
    const count = wasm.mo_meshlets_count(handle);
    const outIdxLen = wasm.mo_meshlets_indices_len(handle);
    const bounds = count > 0
      ? new Float32Array(wasm.memory.buffer, wasm.mo_meshlets_bounds_ptr(handle), count * 4).slice()
      : new Float32Array(0);
    const cones = count > 0
      ? new Float32Array(wasm.memory.buffer, wasm.mo_meshlets_cones_ptr(handle), count * 4).slice()
      : new Float32Array(0);
    const ranges = count > 0
      ? new Uint32Array(wasm.memory.buffer, wasm.mo_meshlets_ranges_ptr(handle), count * 4).slice()
      : new Uint32Array(0);
    const outIndices = outIdxLen > 0
      ? new Uint32Array(wasm.memory.buffer, wasm.mo_meshlets_indices_ptr(handle), outIdxLen).slice()
      : new Uint32Array(0);
    return { count, bounds, cones, ranges, indices: outIndices, backend: 'wasm' };
  } finally {
    if (handle) wasm.mo_meshlets_free(handle);
  }
}
