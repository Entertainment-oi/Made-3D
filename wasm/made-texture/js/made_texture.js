// Puente ES Module nativo para MadeTexture (`made_texture.wasm`) sin Emscripten ni eval.
// Funciona tanto en navegador (fetch) como en Node.js (fs/promises).

const DEFAULT_WASM_URL = new URL('../dist/made_texture.wasm', import.meta.url).href;
const _bytesCache = new Map();
const _instanceCache = new Map();
const _resolvedExports = new Map();

export const TARGET_FORMAT = Object.freeze({
  ETC1_RGB: 0,
  ETC2_RGBA: 1,
  BC1_RGB: 2,
  BC3_RGBA: 3,
  BC7_RGBA: 6,
  ASTC_4x4_RGBA: 10,
  RGBA32: 13,
});

export const SOURCE_FORMAT = Object.freeze({
  ETC1S: 0,
  UASTC_4X4: 1,
  RGBA8: 2,
  RGB8: 3,
  RG8: 4,
  R8: 5,
  ASTC_4X4: 6,
  BC7: 7,
  BC1: 8,
  BC3: 9,
  ETC2_RGB: 10,
  ETC2_RGBA: 11,
});

function isValidWasmBinary(buf) {
  if (!buf || buf.byteLength < 8) return false;
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return u8[0] === 0x00 && u8[1] === 0x61 && u8[2] === 0x73 && u8[3] === 0x6d;
}

export async function loadMadeTextureWasmBytes(wasmUrl = DEFAULT_WASM_URL) {
  if (_bytesCache.has(wasmUrl)) return _bytesCache.get(wasmUrl);

  const p = (async () => {
    let raw;
    if (
      wasmUrl.startsWith('file://') &&
      typeof process !== 'undefined' &&
      process.versions &&
      process.versions.node
    ) {
      const fs = await import('fs/promises');
      const { fileURLToPath } = await import('url');
      const nodeBuf = await fs.readFile(fileURLToPath(wasmUrl));
      raw = nodeBuf.buffer.slice(nodeBuf.byteOffset, nodeBuf.byteOffset + nodeBuf.byteLength);
    } else if (typeof fetch === 'function') {
      const res = await fetch(wasmUrl);
      if (!res.ok) {
        throw new Error(`MadeTexture: no se pudo cargar ${wasmUrl} (${res.status})`);
      }
      raw = await res.arrayBuffer();
    } else {
      throw new Error('MadeTexture: fetch no disponible para cargar WASM.');
    }

    if (!isValidWasmBinary(raw)) {
      throw new Error(`MadeTexture: el recurso ${wasmUrl} no es un binario WebAssembly válido.`);
    }
    return raw;
  })().catch((err) => {
    _bytesCache.delete(wasmUrl);
    throw err;
  });

  _bytesCache.set(wasmUrl, p);
  return p;
}

export async function hasMadeTextureBinary(wasmUrl = DEFAULT_WASM_URL) {
  try {
    await loadMadeTextureWasmBytes(wasmUrl);
    return true;
  } catch (_) {
    return false;
  }
}

export async function loadMadeTexture(wasmUrl = DEFAULT_WASM_URL) {
  if (_instanceCache.has(wasmUrl)) return _instanceCache.get(wasmUrl);

  const p = (async () => {
    const bytes = await loadMadeTextureWasmBytes(wasmUrl);
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

export function preloadMadeTexture(wasmUrl = DEFAULT_WASM_URL) {
  return loadMadeTexture(wasmUrl);
}

export function getMadeTextureSync(wasmUrl = DEFAULT_WASM_URL) {
  return _resolvedExports.get(wasmUrl) || null;
}

export function getMadeTextureCapabilities(wasmUrl = DEFAULT_WASM_URL) {
  const w = _resolvedExports.get(wasmUrl);
  if (!w) {
    return {
      loaded: false,
      version: 0,
      uastc: false,
      etc1s: false,
      astc: false,
      bc7: false,
      etc2: false,
    };
  }
  return {
    loaded: true,
    version: typeof w.mt_version === 'function' ? w.mt_version() : 0,
    uastc: typeof w.mt_transcode_uastc === 'function',
    etc1s: typeof w.mt_ktx2_open === 'function',
    astc: true,
    bc7: true,
    etc2: true,
  };
}

export function chooseTargetFromCaps(caps = {}, width, height, hasAlpha, colorSpace, forceRgba = false) {
  if (forceRgba) {
    return {
      basisFormat: TARGET_FORMAT.RGBA32,
      compressed: false,
      formatId: null,
      glFormat: null,
      glSrgbFormat: null,
    };
  }
  const mult4 = width % 4 === 0 && height % 4 === 0;
  const wantSrgb = colorSpace === 'srgb';
  const e = caps.enums || {};

  if (caps.astc) {
    return {
      basisFormat: TARGET_FORMAT.ASTC_4x4_RGBA,
      compressed: true,
      formatId: 'astc-4x4',
      glFormat: e.astcRgba ?? null,
      glSrgbFormat: e.astcSrgb ?? null,
    };
  }
  if (caps.bptc && mult4) {
    return {
      basisFormat: TARGET_FORMAT.BC7_RGBA,
      compressed: true,
      formatId: 'bc7',
      glFormat: e.bptcRgba ?? null,
      glSrgbFormat: e.bptcSrgb ?? null,
    };
  }
  if (caps.etc) {
    if (hasAlpha) {
      return {
        basisFormat: TARGET_FORMAT.ETC2_RGBA,
        compressed: true,
        formatId: 'etc2-rgba',
        glFormat: e.etc2Rgba ?? null,
        glSrgbFormat: e.etc2SrgbRgba ?? null,
      };
    }
    return {
      basisFormat: TARGET_FORMAT.ETC1_RGB,
      compressed: true,
      formatId: 'etc2-rgb',
      glFormat: e.etc2Rgb ?? null,
      glSrgbFormat: e.etc2SrgbRgb ?? null,
    };
  }
  if (caps.s3tc && mult4 && (!wantSrgb || caps.s3tcSrgb)) {
    if (hasAlpha) {
      return {
        basisFormat: TARGET_FORMAT.BC3_RGBA,
        compressed: true,
        formatId: 'bc3',
        glFormat: e.s3tcRgba ?? null,
        glSrgbFormat: e.s3tcSrgbRgba ?? null,
      };
    }
    return {
      basisFormat: TARGET_FORMAT.BC1_RGB,
      compressed: true,
      formatId: 'bc1',
      glFormat: e.s3tcRgb ?? null,
      glSrgbFormat: e.s3tcSrgbRgb ?? null,
    };
  }
  if (caps.etc1 && !hasAlpha && !wantSrgb) {
    return {
      basisFormat: TARGET_FORMAT.ETC1_RGB,
      compressed: true,
      formatId: null,
      glFormat: e.etc1Rgb ?? null,
      glSrgbFormat: null,
    };
  }
  return {
    basisFormat: TARGET_FORMAT.RGBA32,
    compressed: false,
    formatId: null,
    glFormat: null,
    glSrgbFormat: null,
  };
}

function readKtx2Error(wasm, handle) {
  const ptr = wasm.mt_ktx2_error_ptr(handle);
  const len = wasm.mt_ktx2_error_len(handle);
  if (!ptr || !len) return 'Error desconocido en MadeTexture';
  return new TextDecoder().decode(new Uint8Array(wasm.memory.buffer, ptr, len));
}

function readBytesResult(wasm, handle, label) {
  try {
    const status = wasm.mt_bytes_status(handle);
    if (status !== 0) {
      const ptr = wasm.mt_bytes_error_ptr(handle);
      const len = wasm.mt_bytes_error_len(handle);
      const msg = ptr && len
        ? new TextDecoder().decode(new Uint8Array(wasm.memory.buffer, ptr, len))
        : `status=${status}`;
      throw new Error(`${label} (${status}): ${msg}`);
    }
    const ptr = wasm.mt_bytes_ptr(handle);
    const len = wasm.mt_bytes_len(handle);
    return new Uint8Array(wasm.memory.buffer, ptr, len).slice();
  } finally {
    if (handle) wasm.mt_bytes_free(handle);
  }
}

/**
 * Transcodifica un archivo KTX2 completo usando una instancia cargada de `made_texture.wasm`.
 */
export function transcodeKtx2WithWasm(wasm, data, { caps = {}, colorSpace: optColorSpace = null, forceRgba = false } = {}) {
  const bytes =
    data instanceof Uint8Array
      ? data
      : data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

  const inPtr = wasm.mt_alloc(bytes.byteLength);
  if (!inPtr) throw new Error('MadeTexture: fallo al asignar memoria.');

  let handle = 0;
  try {
    new Uint8Array(wasm.memory.buffer, inPtr, bytes.byteLength).set(bytes);
    handle = wasm.mt_ktx2_open(inPtr, bytes.byteLength);
  } finally {
    wasm.mt_free(inPtr, bytes.byteLength);
  }

  try {
    const status = wasm.mt_ktx2_status(handle);
    if (status !== 0) {
      throw new Error(readKtx2Error(wasm, handle));
    }

    const width = wasm.mt_ktx2_width(handle);
    const height = wasm.mt_ktx2_height(handle);
    const levels = Math.max(1, wasm.mt_ktx2_levels(handle));
    const hasAlpha = wasm.mt_ktx2_has_alpha(handle) !== 0;
    const isSrgb = wasm.mt_ktx2_is_srgb(handle) !== 0;
    const colorSpace = optColorSpace || (isSrgb ? 'srgb' : 'linear');
    const target = chooseTargetFromCaps(caps, width, height, hasAlpha, colorSpace, forceRgba);

    const mipmaps = [];
    const transfers = [];
    for (let level = 0; level < levels; level++) {
      const levelW = Math.max(1, wasm.mt_ktx2_level_width(handle, level));
      const levelH = Math.max(1, wasm.mt_ktx2_level_height(handle, level));
      const bh = wasm.mt_ktx2_transcode_level(handle, level, 0, 0, target.basisFormat);
      const out = readBytesResult(wasm, bh, `MadeTexture mip ${level}`);
      mipmaps.push({ data: out, width: levelW, height: levelH });
      transfers.push(out.buffer);
    }

    return { width, height, hasAlpha, colorSpace, target, mipmaps, transfers };
  } finally {
    if (handle) wasm.mt_ktx2_close(handle);
  }
}

export async function transcodeKtx2(data, opts = {}) {
  const wasm = await loadMadeTexture(opts.wasmUrl);
  return transcodeKtx2WithWasm(wasm, data, opts);
}
