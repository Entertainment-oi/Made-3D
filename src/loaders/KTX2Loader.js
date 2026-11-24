import { Texture } from '../textures/Texture.js';
import {
  hasMadeTextureBinary,
  loadMadeTexture,
  loadMadeTextureWasmBytes,
  transcodeKtx2WithWasm,
} from '../libs/made-texture/made_texture.js';

const DEFAULT_MADE_TEXTURE_WASM_URL = new URL('../libs/made-texture/made_texture.wasm', import.meta.url).href;

let _cachedCaps = null;

async function readResourceBytes(url) {
  if (
    url.startsWith('file://') &&
    typeof process !== 'undefined' &&
    process.versions &&
    process.versions.node
  ) {
    const fs = await import('fs/promises');
    const { fileURLToPath } = await import('url');
    const buf = await fs.readFile(fileURLToPath(url));
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }
  if (typeof fetch === 'function') {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`KTX2Loader: no se pudo cargar ${url} (${res.status})`);
    return res.arrayBuffer();
  }
  throw new Error('KTX2Loader: fetch no disponible en este entorno.');
}



function probeWebGL2Caps(gl) {
  if (!gl) {
    return {
      astc: false,
      bptc: false,
      etc: false,
      etc1: false,
      s3tc: false,
      s3tcSrgb: false,
      pvrtc: false,
      enums: {},
    };
  }
  const astc = gl.getExtension('WEBGL_compressed_texture_astc');
  const bptc = gl.getExtension('EXT_texture_compression_bptc');
  const etc = gl.getExtension('WEBGL_compressed_texture_etc');
  const etc1 = gl.getExtension('WEBGL_compressed_texture_etc1');
  const s3tc = gl.getExtension('WEBGL_compressed_texture_s3tc');
  const s3tcSrgb = gl.getExtension('WEBGL_compressed_texture_s3tc_srgb');
  const pvrtc =
    gl.getExtension('WEBGL_compressed_texture_pvrtc') ||
    gl.getExtension('WEBKIT_WEBGL_compressed_texture_pvrtc');

  return {
    astc: !!astc,
    bptc: !!bptc,
    etc: !!etc,
    etc1: !!etc1,
    s3tc: !!s3tc,
    s3tcSrgb: !!s3tcSrgb,
    pvrtc: !!pvrtc,
    enums: {
      astcRgba: astc?.COMPRESSED_RGBA_ASTC_4x4_KHR ?? null,
      astcSrgb: astc?.COMPRESSED_SRGB8_ALPHA8_ASTC_4x4_KHR ?? null,
      bptcRgba: bptc?.COMPRESSED_RGBA_BPTC_UNORM_EXT ?? null,
      bptcSrgb: bptc?.COMPRESSED_SRGB_ALPHA_BPTC_UNORM_EXT ?? null,
      etc2Rgba: etc?.COMPRESSED_RGBA8_ETC2_EAC ?? null,
      etc2SrgbRgba: etc?.COMPRESSED_SRGB8_ALPHA8_ETC2_EAC ?? null,
      etc2Rgb: etc?.COMPRESSED_RGB8_ETC2 ?? null,
      etc2SrgbRgb: etc?.COMPRESSED_SRGB8_ETC2 ?? null,
      s3tcRgba: s3tc?.COMPRESSED_RGBA_S3TC_DXT5_EXT ?? null,
      s3tcSrgbRgba: s3tcSrgb?.COMPRESSED_SRGB_ALPHA_S3TC_DXT5_EXT ?? null,
      s3tcRgb: s3tc?.COMPRESSED_RGB_S3TC_DXT1_EXT ?? null,
      s3tcSrgbRgb: s3tcSrgb?.COMPRESSED_SRGB_S3TC_DXT1_EXT ?? null,
      etc1Rgb: etc1?.COMPRESSED_RGB_ETC1_WEBGL ?? null,
      pvrtcRgba: pvrtc?.COMPRESSED_RGBA_PVRTC_4BPPV1_IMG ?? null,
      pvrtcRgb: pvrtc?.COMPRESSED_RGB_PVRTC_4BPPV1_IMG ?? null,
    },
  };
}

function probeWebGPUCaps(device) {
  const f = device && device.features;
  if (!f) {
    return {
      astc: false,
      bptc: false,
      etc: false,
      etc1: false,
      s3tc: false,
      s3tcSrgb: false,
      pvrtc: false,
      enums: {},
    };
  }
  const bc = f.has('texture-compression-bc');
  const etc2 = f.has('texture-compression-etc2');
  const astc = f.has('texture-compression-astc');
  return {
    astc,
    bptc: bc,
    etc: etc2,
    etc1: false,
    s3tc: bc,
    s3tcSrgb: bc,
    pvrtc: false,
    enums: {},
  };
}

function getDefaultCaps() {
  if (_cachedCaps) return _cachedCaps;
  if (typeof document === 'undefined') {
    _cachedCaps = probeWebGL2Caps(null);
    return _cachedCaps;
  }
  try {
    const cv = document.createElement('canvas');
    const gl = cv.getContext('webgl2') || cv.getContext('webgl');
    _cachedCaps = probeWebGL2Caps(gl);
  } catch (_) {
    _cachedCaps = probeWebGL2Caps(null);
  }
  return _cachedCaps;
}



// Worker WebAssembly puro para MadeTexture (cero eval, cero new Function, cero Emscripten y sin .toString())
const MADE_TEXTURE_WORKER_SCRIPT = `
let wasmPromise = null;
const TARGET_FORMAT = { ETC1_RGB: 0, ETC2_RGBA: 1, BC1_RGB: 2, BC3_RGBA: 3, BC7_RGBA: 6, ASTC_4x4_RGBA: 10, RGBA32: 13 };

function chooseTargetFromCaps(caps, width, height, hasAlpha, colorSpace, forceRgba) {
  if (forceRgba) return { basisFormat: TARGET_FORMAT.RGBA32, compressed: false, formatId: null, glFormat: null, glSrgbFormat: null };
  const c = caps || {};
  const mult4 = width % 4 === 0 && height % 4 === 0;
  const wantSrgb = colorSpace === 'srgb';
  const e = c.enums || {};
  if (c.astc) return { basisFormat: TARGET_FORMAT.ASTC_4x4_RGBA, compressed: true, formatId: 'astc-4x4', glFormat: e.astcRgba ?? null, glSrgbFormat: e.astcSrgb ?? null };
  if (c.bptc && mult4) return { basisFormat: TARGET_FORMAT.BC7_RGBA, compressed: true, formatId: 'bc7', glFormat: e.bptcRgba ?? null, glSrgbFormat: e.bptcSrgb ?? null };
  if (c.etc) {
    if (hasAlpha) return { basisFormat: TARGET_FORMAT.ETC2_RGBA, compressed: true, formatId: 'etc2-rgba', glFormat: e.etc2Rgba ?? null, glSrgbFormat: e.etc2SrgbRgba ?? null };
    return { basisFormat: TARGET_FORMAT.ETC1_RGB, compressed: true, formatId: 'etc2-rgb', glFormat: e.etc2Rgb ?? null, glSrgbFormat: e.etc2SrgbRgb ?? null };
  }
  if (c.s3tc && mult4 && (!wantSrgb || c.s3tcSrgb)) {
    if (hasAlpha) return { basisFormat: TARGET_FORMAT.BC3_RGBA, compressed: true, formatId: 'bc3', glFormat: e.s3tcRgba ?? null, glSrgbFormat: e.s3tcSrgbRgba ?? null };
    return { basisFormat: TARGET_FORMAT.BC1_RGB, compressed: true, formatId: 'bc1', glFormat: e.s3tcRgb ?? null, glSrgbFormat: e.s3tcSrgbRgb ?? null };
  }
  if (c.etc1 && !hasAlpha && !wantSrgb) return { basisFormat: TARGET_FORMAT.ETC1_RGB, compressed: true, formatId: null, glFormat: e.etc1Rgb ?? null, glSrgbFormat: null };
  return { basisFormat: TARGET_FORMAT.RGBA32, compressed: false, formatId: null, glFormat: null, glSrgbFormat: null };
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
        : ('status=' + status);
      throw new Error(label + ' (' + status + '): ' + msg);
    }
    const ptr = wasm.mt_bytes_ptr(handle);
    const len = wasm.mt_bytes_len(handle);
    return new Uint8Array(wasm.memory.buffer, ptr, len).slice();
  } finally {
    if (handle) wasm.mt_bytes_free(handle);
  }
}

function transcodeWithMadeTexture(wasm, bytes, caps, optColorSpace, forceRgba) {
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
    if (wasm.mt_ktx2_status(handle) !== 0) throw new Error(readKtx2Error(wasm, handle));
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
      const out = readBytesResult(wasm, bh, 'MadeTexture mip ' + level);
      mipmaps.push({ data: out, width: levelW, height: levelH });
      transfers.push(out.buffer);
    }
    return { width, height, colorSpace, target, mipmaps, transfers };
  } finally {
    if (handle) wasm.mt_ktx2_close(handle);
  }
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    wasmPromise = WebAssembly.instantiate(msg.wasmBinary, {}).then((res) => res.instance.exports);
    try {
      await wasmPromise;
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'init-error', error: err.message || String(err) });
    }
    return;
  }
  if (msg.type === 'transcode') {
    try {
      const wasm = await wasmPromise;
      const bytes = new Uint8Array(msg.buffer);
      const { width, height, colorSpace, target, mipmaps, transfers } = transcodeWithMadeTexture(
        wasm,
        bytes,
        msg.caps,
        msg.colorSpace,
        msg.forceRgba
      );
      self.postMessage({ type: 'done', id: msg.id, result: { width, height, colorSpace, target, mipmaps } }, transfers);
    } catch (err) {
      self.postMessage({ type: 'error', id: msg.id, error: err.message || String(err) });
    }
  }
};
`;

/**
 * Cargador de texturas KTX2 (UASTC y ETC1S/BasisLZ) usando MadeTexture (`made_texture.wasm`, Rust puro)
 * con pool de Web Workers nativos WebAssembly.
 */
export class KTX2Loader {
  constructor(opts = {}) {
    this.madeTextureWasmUrl = opts.madeTextureWasmUrl || DEFAULT_MADE_TEXTURE_WASM_URL;
    this.useMadeTexture = opts.useMadeTexture !== undefined ? !!opts.useMadeTexture : true;
    this._caps = null;
    this.workerLimit = Math.max(
      1,
      opts.workerLimit ?? Math.min(4, (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2)
    );
    this.useWorker =
      opts.useWorker !== undefined
        ? !!opts.useWorker
        : typeof Worker !== 'undefined' && typeof Blob !== 'undefined' && typeof URL?.createObjectURL === 'function';
    this._workerUrl = null;
    this._workerBackend = null;
    this._workers = [];
    this._queue = [];
    this._pending = new Map();
    this._nextTaskId = 1;
    this._workersBroken = false;
    this._creatingWorkers = 0;
    this._disposeEpoch = 0;
  }

  setMadeTextureWasmUrl(url) {
    if (this.madeTextureWasmUrl !== url) {
      this.madeTextureWasmUrl = url;
      this._workerBackend = null;
    }
    return this;
  }

  setTranscoderPath() {
    return this;
  }

  setWorkerLimit(limit) {
    this.workerLimit = Math.max(1, limit | 0);
    return this;
  }

  async getActiveBackend() {
    if (this.useMadeTexture && (await hasMadeTextureBinary(this.madeTextureWasmUrl))) {
      return 'made-texture';
    }
    return 'none';
  }

  detectSupport(rendererOrGl) {
    if (rendererOrGl && rendererOrGl.isWebGPU && rendererOrGl.device) {
      this._caps = probeWebGPUCaps(rendererOrGl.device);
      return this;
    }
    if (rendererOrGl && typeof GPUDevice !== 'undefined' && rendererOrGl instanceof GPUDevice) {
      this._caps = probeWebGPUCaps(rendererOrGl);
      return this;
    }
    const gl = rendererOrGl && rendererOrGl.gl ? rendererOrGl.gl : rendererOrGl;
    this._caps = probeWebGL2Caps(gl);
    return this;
  }

  async load(url, opts = {}) {
    const buffer = await readResourceBytes(url);
    return this.parse(buffer, opts);
  }

  async loadFile(file, opts = {}) {
    const buffer = await file.arrayBuffer();
    return this.parse(buffer, opts);
  }

  async _createWorker(epoch = this._disposeEpoch) {
    const useMt = this.useMadeTexture && (await hasMadeTextureBinary(this.madeTextureWasmUrl));
    if (!useMt) {
      throw new Error('MadeTexture: made_texture.wasm no encontrado.');
    }

    const wasmBinary = await loadMadeTextureWasmBytes(this.madeTextureWasmUrl);
    const backend = 'made-texture';

    if (epoch !== this._disposeEpoch) throw new Error('KTX2Loader: liberado');
    if (!this._workerUrl || this._workerBackend !== backend) {
      if (this._workerUrl) URL.revokeObjectURL(this._workerUrl);
      this._workerUrl = URL.createObjectURL(new Blob([MADE_TEXTURE_WORKER_SCRIPT], { type: 'text/javascript' }));
      this._workerBackend = backend;
    }

    const w = new Worker(this._workerUrl);
    const slot = { worker: w, busy: true };

    await new Promise((resolve, reject) => {
      const onInitMsg = (ev) => {
        const d = ev.data;
        if (d.type === 'ready') {
          w.removeEventListener('message', onInitMsg);
          w.removeEventListener('error', onInitErr);
          resolve();
        } else if (d.type === 'init-error') {
          w.removeEventListener('message', onInitMsg);
          w.removeEventListener('error', onInitErr);
          reject(new Error(d.error || 'Error iniciando worker KTX2'));
        }
      };
      const onInitErr = (err) => {
        w.removeEventListener('message', onInitMsg);
        w.removeEventListener('error', onInitErr);
        reject(new Error(err.message || 'Error en worker KTX2'));
      };
      w.addEventListener('message', onInitMsg);
      w.addEventListener('error', onInitErr);
      const copyWasm = wasmBinary.slice(0);
      w.postMessage({ type: 'init', wasmBinary: copyWasm }, [copyWasm]);
    });

    w.addEventListener('message', (ev) => {
      const d = ev.data;
      if (d.type !== 'done' && d.type !== 'error') return;
      const entry = this._pending.get(d.id);
      this._pending.delete(d.id);
      slot.busy = false;
      this._pumpQueue();
      if (!entry) return;
      if (d.type === 'done') entry.resolve(d.result);
      else entry.reject(new Error(d.error));
    });

    w.addEventListener('error', (err) => {
      slot.dead = true;
      for (const [id, entry] of this._pending.entries()) {
        if (entry.slot === slot) {
          this._pending.delete(id);
          entry.reject(new Error(err.message || 'Error en worker KTX2'));
        }
      }
      this._pumpQueue();
    });

    if (epoch !== this._disposeEpoch) {
      try { w.terminate(); } catch (_) {}
      throw new Error('KTX2Loader: liberado');
    }

    slot.busy = false;
    this._workers.push(slot);
    return slot;
  }

  _pumpQueue() {
    if (this._workersBroken) {
      while (this._queue.length) this._runTaskOnMain(this._queue.shift());
      return;
    }
    while (this._queue.length > 0) {
      const idle = this._workers.find((s) => !s.busy && !s.dead);
      if (!idle) {
        const activeCount = this._workers.filter((s) => !s.dead).length + this._creatingWorkers;
        if (activeCount < this.workerLimit) {
          const task = this._queue.shift();
          const epoch = this._disposeEpoch;
          this._creatingWorkers++;
          this._createWorker(epoch)
            .then((slot) => {
              this._creatingWorkers = Math.max(0, this._creatingWorkers - 1);
              if (epoch !== this._disposeEpoch) {
                try { slot.worker.terminate(); } catch (_) {}
                this._workers = this._workers.filter((s) => s !== slot);
                task.reject(new Error('KTX2Loader: liberado'));
                return;
              }
              if (this._workersBroken) this._runTaskOnMain(task);
              else this._dispatchToSlot(slot, task);
              this._pumpQueue();
            })
            .catch((err) => {
              this._creatingWorkers = Math.max(0, this._creatingWorkers - 1);
              if (epoch !== this._disposeEpoch) {
                task.reject(err instanceof Error ? err : new Error('KTX2Loader: liberado'));
                return;
              }
              this._workersBroken = true;
              this._runTaskOnMain(task);
              while (this._queue.length) this._runTaskOnMain(this._queue.shift());
            });
          continue;
        }
        return;
      }
      const task = this._queue.shift();
      this._dispatchToSlot(idle, task);
    }
  }

  _dispatchToSlot(slot, task) {
    slot.busy = true;
    const id = this._nextTaskId++;
    this._pending.set(id, { resolve: task.resolve, reject: task.reject, slot });
    const copyBuf = task.bytes.slice().buffer;
    slot.worker.postMessage(
      {
        type: 'transcode',
        id,
        buffer: copyBuf,
        caps: task.caps,
        colorSpace: task.colorSpace,
        forceRgba: task.forceRgba,
      },
      [copyBuf]
    );
  }

  async _runTaskOnMain(task) {
    const epoch = this._disposeEpoch;
    try {
      if (this.useMadeTexture && (await hasMadeTextureBinary(this.madeTextureWasmUrl))) {
        const wasm = await loadMadeTexture(this.madeTextureWasmUrl);
        if (epoch !== this._disposeEpoch) {
          task.reject(new Error('KTX2Loader: liberado'));
          return;
        }
        const res = transcodeKtx2WithWasm(wasm, task.bytes, {
          caps: task.caps,
          colorSpace: task.colorSpace,
          forceRgba: task.forceRgba,
        });
        task.resolve(res);
        return;
      }

      throw new Error('MadeTexture: made_texture.wasm no disponible.');
    } catch (err) {
      task.reject(err);
    }
  }

  _runTranscode(bytes, caps, colorSpace, forceRgba = false) {
    if (!this.useWorker || this._workersBroken) {
      return new Promise((resolve, reject) => {
        this._runTaskOnMain({ bytes, caps, colorSpace, forceRgba, resolve, reject });
      });
    }
    return new Promise((resolve, reject) => {
      this._queue.push({ bytes, caps, colorSpace, forceRgba, resolve, reject });
      this._pumpQueue();
    });
  }

  async parse(data, opts = {}) {
    const bytes =
      data instanceof Uint8Array
        ? data
        : data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

    const caps = this._caps || getDefaultCaps();
    const { width, height, colorSpace, target, mipmaps } = await this._runTranscode(
      bytes,
      caps,
      opts.colorSpace || null,
      false
    );

    const tex = new Texture(null, {
      mipmaps,
      format: target.glFormat,
      srgbFormat: target.glSrgbFormat,
      formatId: target.formatId || null,
      compressed: target.compressed,
      isCompressedTexture: true,
      flipY: false,
      colorSpace,
      texCoord: opts.texCoord ?? 0,
      wrapS: opts.wrapS || 'repeat',
      wrapT: opts.wrapT || 'repeat',
      minFilter: opts.minFilter || (mipmaps.length > 1 ? 'linear-mipmap' : 'linear'),
      magFilter: opts.magFilter || 'linear',
    });

    const bytesCopy = target.compressed ? bytes.slice() : null;
    tex._decodeRgbaLevel0 = async () => {
      if (!target.compressed && mipmaps[0]) return mipmaps[0];
      const res = await this._runTranscode(bytesCopy, caps, colorSpace, true);
      return res.mipmaps[0];
    };
    tex.width = width;
    tex.height = height;
    tex.needsUpdate = true;
    return tex;
  }

  dispose() {
    this._disposeEpoch++;
    const err = new Error('KTX2Loader: liberado');
    while (this._queue.length) {
      const task = this._queue.shift();
      try { task?.reject?.(err); } catch (_) {}
    }
    for (const entry of this._pending.values()) {
      try { entry?.reject?.(err); } catch (_) {}
    }
    this._pending.clear();
    for (const s of this._workers) {
      try { s.worker.terminate(); } catch (_) {}
    }
    this._workers = [];
    this._creatingWorkers = 0;
    this._workerBackend = null;
    if (this._workerUrl) {
      URL.revokeObjectURL(this._workerUrl);
      this._workerUrl = null;
    }
  }
}
