import { Geometry } from '../geometry/Geometry.js';

const DEFAULT_JS_URL = new URL('../libs/draco/draco_wasm_wrapper.js', import.meta.url).href;
const DEFAULT_WASM_URL = new URL('../libs/draco/draco_decoder.wasm', import.meta.url).href;

const _moduleCache = new Map();

async function readResourceBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`DRACOLoader: no se pudo cargar ${url} (${res.status})`);
  return res.arrayBuffer();
}

async function readResourceText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`DRACOLoader: no se pudo cargar ${url} (${res.status})`);
  return res.text();
}

function loadDracoModule(jsUrl, wasmUrl) {
  const key = `${jsUrl}|${wasmUrl}`;
  if (_moduleCache.has(key)) return _moduleCache.get(key);

  const p = (async () => {
    const [jsCode, wasmBinary] = await Promise.all([
      typeof globalThis.DracoDecoderModule === 'function' ? Promise.resolve(null) : readResourceText(jsUrl),
      readResourceBytes(wasmUrl),
    ]);
    let factory = typeof globalThis.DracoDecoderModule === 'function' ? globalThis.DracoDecoderModule : null;
    if (!factory) {
      factory = new Function(`${jsCode}\nreturn DracoDecoderModule;`)();
    }
    return factory({ wasmBinary });
  })();

  _moduleCache.set(key, p);
  return p;
}

const GLTF_TO_MADE3D_ATTR = {
  POSITION: 'position',
  NORMAL: 'normal',
  TEXCOORD_0: 'uv',
  TEXCOORD_1: 'uv1',
  COLOR_0: 'color',
  JOINTS_0: 'skinIndex',
  WEIGHTS_0: 'skinWeight',
};

const NORMALIZE_DIV = {
  5120: 127,
  5121: 255,
  5122: 32767,
  5123: 65535,
  5125: 4294967295,
};

/**
 * Decodificador de geometrías Draco (`KHR_draco_mesh_compression` y archivos `.drc`)
 * usando los archivos oficiales `draco_wasm_wrapper.js` y `draco_decoder.wasm`.
 */
export class DRACOLoader {
  constructor(opts = {}) {
    this.jsUrl = opts.jsUrl || DEFAULT_JS_URL;
    this.wasmUrl = opts.wasmUrl || DEFAULT_WASM_URL;
    if (opts.decoderPath) this.setDecoderPath(opts.decoderPath);
  }

  setDecoderPath(dirUrl) {
    const base = dirUrl.endsWith('/') ? dirUrl : dirUrl + '/';
    this.jsUrl = base + 'draco_wasm_wrapper.js';
    this.wasmUrl = base + 'draco_decoder.wasm';
    return this;
  }

  preload() {
    return loadDracoModule(this.jsUrl, this.wasmUrl);
  }

  /**
   * Decodifica un buffer Draco asociado a una primitiva glTF (`KHR_draco_mesh_compression`).
   * `attributeMap`: `{ POSITION: uniqueId, NORMAL: uniqueId, ... }`
   * `accessorsInfo`: `{ POSITION: accessorDef, ... }` (opcional, para normalización exacta).
   */
  async decodeGeometry(data, attributeMap = null, accessorsInfo = {}) {
    const draco = await loadDracoModule(this.jsUrl, this.wasmUrl);
    const bytes =
      data instanceof Uint8Array
        ? data
        : data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

    const buffer = new draco.DecoderBuffer();
    const decoder = new draco.Decoder();
    let dracoGeometry = null;

    try {
      const int8 = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      buffer.Init(int8, bytes.byteLength);

      const geometryType = decoder.GetEncodedGeometryType(buffer);
      let status;
      if (geometryType === draco.TRIANGULAR_MESH) {
        dracoGeometry = new draco.Mesh();
        status = decoder.DecodeBufferToMesh(buffer, dracoGeometry);
      } else if (geometryType === draco.POINT_CLOUD) {
        dracoGeometry = new draco.PointCloud();
        status = decoder.DecodeBufferToPointCloud(buffer, dracoGeometry);
      } else {
        throw new Error('DRACOLoader: tipo de geometría Draco desconocido.');
      }

      if (!status.ok() || dracoGeometry.ptr === 0) {
        throw new Error(`DRACOLoader: error de decodificación (${status.error_msg()}).`);
      }

      const geo = new Geometry();
      const numPoints = dracoGeometry.num_points();

      // Índices de triángulos
      if (geometryType === draco.TRIANGULAR_MESH) {
        const numFaces = dracoGeometry.num_faces();
        const numIndices = numFaces * 3;
        if (numIndices > 0) {
          if (numPoints > 65535) {
            const byteLen = numIndices * 4;
            const ptr = draco._malloc(byteLen);
            try {
              decoder.GetTrianglesUInt32Array(dracoGeometry, byteLen, ptr);
              const idx = new Uint32Array(draco.HEAPU32.buffer, ptr, numIndices).slice();
              geo.setIndex(idx);
            } finally {
              draco._free(ptr);
            }
          } else {
            const byteLen = numIndices * 2;
            const ptr = draco._malloc(byteLen);
            try {
              decoder.GetTrianglesUInt16Array(dracoGeometry, byteLen, ptr);
              const idx = new Uint16Array(draco.HEAPU16.buffer, ptr, numIndices).slice();
              geo.setIndex(idx);
            } finally {
              draco._free(ptr);
            }
          }
        }
      }

      const entries = attributeMap
        ? Object.entries(attributeMap)
        : [
            ['POSITION', decoder.GetAttributeId(dracoGeometry, draco.POSITION)],
            ['NORMAL', decoder.GetAttributeId(dracoGeometry, draco.NORMAL)],
            ['TEXCOORD_0', decoder.GetAttributeId(dracoGeometry, draco.TEX_COORD)],
            ['COLOR_0', decoder.GetAttributeId(dracoGeometry, draco.COLOR)],
          ].filter(([, id]) => id >= 0);

      for (const [gltfName, idOrUnique] of entries) {
        const targetName = GLTF_TO_MADE3D_ATTR[gltfName];
        if (!targetName) continue;

        const attr = attributeMap
          ? decoder.GetAttributeByUniqueId(dracoGeometry, idOrUnique)
          : decoder.GetAttribute(dracoGeometry, idOrUnique);
        if (!attr || attr.ptr === 0) continue;

        const numComponents = attr.num_components();
        const numValues = numPoints * numComponents;
        const acc = accessorsInfo[gltfName];
        const isJoints = gltfName === 'JOINTS_0';

        if (isJoints) {
          const byteLen = numValues * 2;
          const ptr = draco._malloc(byteLen);
          try {
            decoder.GetAttributeDataArrayForAllPoints(dracoGeometry, attr, draco.DT_UINT16, byteLen, ptr);
            const raw = new Uint16Array(draco.HEAPU16.buffer, ptr, numValues);
            const out = new Float32Array(numValues);
            for (let k = 0; k < numValues; k++) out[k] = raw[k];
            geo.setAttribute(targetName, out, numComponents);
          } finally {
            draco._free(ptr);
          }
          continue;
        }

        const byteLen = numValues * 4;
        const ptr = draco._malloc(byteLen);
        try {
          decoder.GetAttributeDataArrayForAllPoints(dracoGeometry, attr, draco.DT_FLOAT32, byteLen, ptr);
          const out = new Float32Array(draco.HEAPF32.buffer, ptr, numValues).slice();

          if (acc && acc.normalized && NORMALIZE_DIV[acc.componentType]) {
            let maxAbs = 0;
            for (let k = 0; k < out.length; k++) {
              const a = Math.abs(out[k]);
              if (a > maxAbs) maxAbs = a;
            }
            // Si Draco guardó enteros sin cuantización, normalizar al rango glTF
            if (maxAbs > 1.001) {
              const div = NORMALIZE_DIV[acc.componentType];
              const signed = acc.componentType === 5120 || acc.componentType === 5122;
              for (let k = 0; k < out.length; k++) {
                out[k] = signed ? Math.max(-1, out[k] / div) : out[k] / div;
              }
            }
          }

          if (gltfName === 'WEIGHTS_0') {
            for (let k = 0; k < out.length; k += 4) {
              const sum = out[k] + out[k + 1] + out[k + 2] + out[k + 3];
              if (sum > 0 && Math.abs(sum - 1) > 1e-4) {
                out[k] /= sum;
                out[k + 1] /= sum;
                out[k + 2] /= sum;
                out[k + 3] /= sum;
              }
            }
          }

          geo.setAttribute(targetName, out, numComponents);
        } finally {
          draco._free(ptr);
        }
      }

      return geo;
    } finally {
      if (dracoGeometry) draco.destroy(dracoGeometry);
      draco.destroy(decoder);
      draco.destroy(buffer);
    }
  }
}
