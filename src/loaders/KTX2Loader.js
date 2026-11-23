import { Texture } from '../textures/Texture.js';

const DEFAULT_JS_URL = new URL('../libs/basis/basis_transcoder.js', import.meta.url).href;
const DEFAULT_WASM_URL = new URL('../libs/basis/basis_transcoder.wasm', import.meta.url).href;

const _moduleCache = new Map();
const _assetsCache = new Map();
let _cachedCaps = null;

async function readResourceBytes(url) {
  if (typeof fetch === 'function') {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`KTX2Loader: no se pudo cargar ${url} (${res.status})`);
    return res.arrayBuffer();
  }
  throw new Error('KTX2Loader: fetch no disponible en este entorno.');
}

async function readResourceText(url) {
  if (typeof fetch === 'function') {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`KTX2Loader: no se pudo cargar ${url} (${res.status})`);
    return res.text();
  }
  throw new Error('KTX2Loader: fetch no disponible en este entorno.');
}

function loadBasisAssets(jsUrl, wasmUrl) {
  const key = `${jsUrl}|${wasmUrl}`;
  if (_assetsCache.has(key)) return _assetsCache.get(key);
  const p = Promise.all([readResourceText(jsUrl), readResourceBytes(wasmUrl)]).then(([jsCode, wasmBinary]) => ({
    jsCode,
    wasmBinary,
  }));
  _assetsCache.set(key, p);
  return p;
}

function loadBasisModule(jsUrl, wasmUrl) {
  const key = `${jsUrl}|${wasmUrl}`;
  if (_moduleCache.has(key)) return _moduleCache.get(key);

  const p = (async () => {
    const { jsCode, wasmBinary } = await loadBasisAssets(jsUrl, wasmUrl);
    let factory = typeof globalThis.BASIS === 'function' ? globalThis.BASIS : null;
    if (!factory) {
      factory = new Function(`${jsCode}\nreturn BASIS;`)();
    }
    const mod = await factory({ wasmBinary: wasmBinary.slice(0) });
    if (mod.initializeBasis) mod.initializeBasis();
    return mod;
  })();

  _moduleCache.set(key, p);
  return p;
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

function isPOT(n) {
  return n > 0 && (n & (n - 1)) === 0;
}

function chooseTargetFromInfo(tf, caps, w, h, hasAlpha, colorSpace) {
  const mult4 = w % 4 === 0 && h % 4 === 0;
  const potSquare = isPOT(w) && isPOT(h) && w === h;
  const wantSrgb = colorSpace === 'srgb';
  const e = caps.enums || {};

  if (caps.astc) {
    return {
      basisFormat: tf.cTFASTC_4x4_RGBA.value,
      compressed: true,
      formatId: 'astc-4x4',
      glFormat: e.astcRgba,
      glSrgbFormat: e.astcSrgb,
    };
  }
  if (caps.bptc && mult4) {
    return {
      basisFormat: tf.cTFBC7_RGBA.value,
      compressed: true,
      formatId: 'bc7',
      glFormat: e.bptcRgba,
      glSrgbFormat: e.bptcSrgb,
    };
  }
  if (caps.etc) {
    if (hasAlpha) {
      return {
        basisFormat: tf.cTFETC2_RGBA.value,
        compressed: true,
        formatId: 'etc2-rgba',
        glFormat: e.etc2Rgba,
        glSrgbFormat: e.etc2SrgbRgba,
      };
    }
    return {
      basisFormat: tf.cTFETC1_RGB.value,
      compressed: true,
      formatId: 'etc2-rgb',
      glFormat: e.etc2Rgb,
      glSrgbFormat: e.etc2SrgbRgb,
    };
  }
  if (caps.s3tc && mult4 && (!wantSrgb || caps.s3tcSrgb)) {
    if (hasAlpha) {
      return {
        basisFormat: tf.cTFBC3_RGBA.value,
        compressed: true,
        formatId: 'bc3',
        glFormat: e.s3tcRgba,
        glSrgbFormat: e.s3tcSrgbRgba,
      };
    }
    return {
      basisFormat: tf.cTFBC1_RGB.value,
      compressed: true,
      formatId: 'bc1',
      glFormat: e.s3tcRgb,
      glSrgbFormat: e.s3tcSrgbRgb,
    };
  }
  if (caps.etc1 && !hasAlpha && !wantSrgb) {
    return {
      basisFormat: tf.cTFETC1_RGB.value,
      compressed: true,
      formatId: null,
      glFormat: e.etc1Rgb,
      glSrgbFormat: null,
    };
  }
  if (caps.pvrtc && potSquare && !wantSrgb) {
    return {
      basisFormat: (hasAlpha ? tf.cTFPVRTC1_4_RGBA : tf.cTFPVRTC1_4_RGB).value,
      compressed: true,
      formatId: null,
      glFormat: hasAlpha ? e.pvrtcRgba : e.pvrtcRgb,
      glSrgbFormat: null,
    };
  }
  return {
    basisFormat: tf.cTFRGBA32.value,
    compressed: false,
    formatId: null,
    glFormat: null,
    glSrgbFormat: null,
  };
}

// Código autocontenido del Web Worker (recibe jsCode + wasmBinary de Basis una sola vez)
const WORKER_SCRIPT = `
let basisPromise = null;
const isPOT = (n) => n > 0 && (n & (n - 1)) === 0;
const chooseTarget = ${chooseTargetFromInfo.toString()};

function transcodeWithBasis(basis, bytes, caps, optColorSpace, forceRgba) {
  const ktx2 = new basis.KTX2File(bytes);
  try {
    if (!ktx2.isValid()) throw new Error('KTX2Loader: archivo KTX2 inválido o corrupto.');
    const width = ktx2.getWidth();
    const height = ktx2.getHeight();
    const levels = Math.max(1, ktx2.getLevels());
    const hasAlpha = ktx2.getHasAlpha();
    const dfdColorSpace = ktx2.getDFDTransferFunc() === basis.KTX2_KHR_DF_TRANSFER_SRGB ? 'srgb' : 'linear';
    const colorSpace = optColorSpace || dfdColorSpace;

    const target = forceRgba
      ? { basisFormat: basis.transcoder_texture_format.cTFRGBA32.value, compressed: false, glFormat: null, glSrgbFormat: null }
      : chooseTarget(basis.transcoder_texture_format, caps, width, height, hasAlpha, colorSpace);

    if (!ktx2.startTranscoding()) throw new Error('KTX2Loader: no se pudo iniciar la transcodificación Basis.');

    const mipmaps = [];
    const transfers = [];
    for (let level = 0; level < levels; level++) {
      const info = ktx2.getImageLevelInfo(level, 0, 0);
      const levelW = Math.max(1, info.origWidth || (width >> level));
      const levelH = Math.max(1, info.origHeight || (height >> level));
      const size = ktx2.getImageTranscodedSizeInBytes(level, 0, 0, target.basisFormat);
      const dst = new Uint8Array(size);
      if (!ktx2.transcodeImage(dst, level, 0, 0, target.basisFormat, 0, -1, -1)) {
        throw new Error('KTX2Loader: falló la transcodificación del nivel mip ' + level);
      }
      mipmaps.push({ data: dst, width: levelW, height: levelH });
      transfers.push(dst.buffer);
    }
    return { result: { width, height, colorSpace, target, mipmaps }, transfers };
  } finally {
    ktx2.close();
    ktx2.delete();
  }
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    basisPromise = (async () => {
      const factory = new Function(msg.jsCode + '\\nreturn BASIS;')();
      const mod = await factory({ wasmBinary: msg.wasmBinary });
      if (mod.initializeBasis) mod.initializeBasis();
      return mod;
    })();
    try {
      await basisPromise;
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'init-error', error: err.message || String(err) });
    }
    return;
  }
  if (msg.type === 'transcode') {
    try {
      const basis = await basisPromise;
      const bytes = new Uint8Array(msg.buffer);
      const { result, transfers } = transcodeWithBasis(basis, bytes, msg.caps, msg.colorSpace, msg.forceRgba);
      self.postMessage({ type: 'done', id: msg.id, result }, transfers);
    } catch (err) {
      self.postMessage({ type: 'error', id: msg.id, error: err.message || String(err) });
    }
  }
};
`;

/**
 * Cargador de texturas KTX2 (Basis Universal: ETC1S y UASTC) usando los archivos oficiales de Three.js
 * (`basis_transcoder.js` y `basis_transcoder.wasm`) y un pool de Web Workers para no bloquear la UI.
 */
export class KTX2Loader {
  constructor(opts = {}) {
    this.jsUrl = opts.jsUrl || DEFAULT_JS_URL;
    this.wasmUrl = opts.wasmUrl || DEFAULT_WASM_URL;
    if (opts.transcoderPath) this.setTranscoderPath(opts.transcoderPath);
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
    this._workers = [];
    this._queue = [];
    this._pending = new Map();
    this._nextTaskId = 1;
    this._workersBroken = false;
    this._creatingWorkers = 0;
    this._disposeEpoch = 0;
  }

  setTranscoderPath(dirUrl) {
    const base = dirUrl.endsWith('/') ? dirUrl : dirUrl + '/';
    this.jsUrl = base + 'basis_transcoder.js';
    this.wasmUrl = base + 'basis_transcoder.wasm';
    return this;
  }

  setWorkerLimit(limit) {
    this.workerLimit = Math.max(1, limit | 0);
    return this;
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

  _transcodeMainThread(basis, bytes, caps, optColorSpace, forceRgba = false) {
    const ktx2 = new basis.KTX2File(bytes);
    try {
      if (!ktx2.isValid()) throw new Error('KTX2Loader: archivo KTX2 inválido o corrupto.');
      const levels = Math.max(1, ktx2.getLevels());
      const width = ktx2.getWidth();
      const height = ktx2.getHeight();
      const hasAlpha = ktx2.getHasAlpha();
      const dfdColorSpace =
        ktx2.getDFDTransferFunc() === basis.KTX2_KHR_DF_TRANSFER_SRGB ? 'srgb' : 'linear';
      const colorSpace = optColorSpace || dfdColorSpace;

      const target = forceRgba
        ? { basisFormat: basis.transcoder_texture_format.cTFRGBA32.value, compressed: false, glFormat: null, glSrgbFormat: null }
        : chooseTargetFromInfo(basis.transcoder_texture_format, caps, width, height, hasAlpha, colorSpace);

      if (!ktx2.startTranscoding()) {
        throw new Error('KTX2Loader: no se pudo iniciar la transcodificación Basis.');
      }

      const mipmaps = [];
      for (let level = 0; level < levels; level++) {
        const info = ktx2.getImageLevelInfo(level, 0, 0);
        const levelW = Math.max(1, info.origWidth || (width >> level));
        const levelH = Math.max(1, info.origHeight || (height >> level));
        const size = ktx2.getImageTranscodedSizeInBytes(level, 0, 0, target.basisFormat);
        const dst = new Uint8Array(size);
        if (!ktx2.transcodeImage(dst, level, 0, 0, target.basisFormat, 0, -1, -1)) {
          throw new Error(`KTX2Loader: falló la transcodificación del nivel mip ${level}.`);
        }
        mipmaps.push({ data: dst, width: levelW, height: levelH });
      }
      return { width, height, colorSpace, target, mipmaps };
    } finally {
      ktx2.close();
      ktx2.delete();
    }
  }

  async _createWorker(epoch = this._disposeEpoch) {
    const { jsCode, wasmBinary } = await loadBasisAssets(this.jsUrl, this.wasmUrl);
    if (epoch !== this._disposeEpoch) throw new Error('KTX2Loader: liberado');
    if (!this._workerUrl) {
      this._workerUrl = URL.createObjectURL(new Blob([WORKER_SCRIPT], { type: 'text/javascript' }));
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
          reject(new Error(d.error || 'Error iniciando worker Basis'));
        }
      };
      const onInitErr = (err) => {
        w.removeEventListener('message', onInitMsg);
        w.removeEventListener('error', onInitErr);
        reject(new Error(err.message || 'Error en worker Basis'));
      };
      w.addEventListener('message', onInitMsg);
      w.addEventListener('error', onInitErr);
      const copyWasm = wasmBinary.slice(0);
      w.postMessage({ type: 'init', jsCode, wasmBinary: copyWasm }, [copyWasm]);
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
          entry.reject(new Error(err.message || 'Error en worker Basis'));
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
              // Fallback silencioso al hilo principal si el navegador bloquea Blob Workers
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
      const basis = await loadBasisModule(this.jsUrl, this.wasmUrl);
      if (epoch !== this._disposeEpoch) {
        task.reject(new Error('KTX2Loader: liberado'));
        return;
      }
      const res = this._transcodeMainThread(basis, task.bytes, task.caps, task.colorSpace, task.forceRgba);
      task.resolve(res);
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
    if (this._workerUrl) {
      URL.revokeObjectURL(this._workerUrl);
      this._workerUrl = null;
    }
  }
}
