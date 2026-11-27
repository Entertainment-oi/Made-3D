import { EventEmitter } from '../core/EventEmitter.js';
import { MP4Muxer, WebMMuxer } from './VideoMuxer.js';

const MP4_MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4;codecs=avc1',
  'video/mp4;codecs=h264',
  'video/mp4',
];

const WEBM_VP9_CANDIDATES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

const WEBM_VP8_CANDIDATES = [
  'video/webm;codecs=vp8',
  'video/webm',
];

const WEBM_FAST_CANDIDATES = [
  'video/webm;codecs=vp8',
  'video/webm;codecs=vp9',
  'video/webm',
];

// En tiempo real, H.264 (acelerado por hardware en casi todos los navegadores) y VP8
// evitan los cuellos de botella de CPU de VP9 al codificar 1080p/4K en vivo.
const DESKTOP_AUTO_CANDIDATES = [
  ...MP4_MIME_CANDIDATES,
  ...WEBM_FAST_CANDIDATES,
];

const MOBILE_AUTO_CANDIDATES = [
  ...MP4_MIME_CANDIDATES,
  ...WEBM_FAST_CANDIDATES,
];

function isMobileBrowser() {
  if (typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '') ||
    (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches);
}

export function pickVideoMimeType(preferred = 'auto') {
  if (typeof MediaRecorder === 'undefined') {
    return { mimeType: '', extension: 'webm' };
  }
  const canCheck = typeof MediaRecorder.isTypeSupported === 'function';
  let candidates = isMobileBrowser() ? MOBILE_AUTO_CANDIDATES : DESKTOP_AUTO_CANDIDATES;

  if (preferred === 'mp4' || preferred === 'video/mp4') {
    candidates = [...MP4_MIME_CANDIDATES, ...WEBM_FAST_CANDIDATES];
  } else if (preferred === 'webm' || preferred === 'video/webm') {
    candidates = WEBM_FAST_CANDIDATES;
  } else if (preferred === 'webm-vp9' || preferred === 'video/webm;codecs=vp9') {
    candidates = WEBM_VP9_CANDIDATES;
  } else if (preferred === 'webm-vp8' || preferred === 'video/webm;codecs=vp8') {
    candidates = WEBM_VP8_CANDIDATES;
  } else if (preferred && preferred !== 'auto') {
    candidates = [preferred, ...DESKTOP_AUTO_CANDIDATES];
  }

  for (const mime of candidates) {
    if (!canCheck || MediaRecorder.isTypeSupported(mime)) {
      return {
        mimeType: mime,
        extension: mime.includes('mp4') ? 'mp4' : 'webm',
      };
    }
  }
  return { mimeType: '', extension: 'webm' };
}

export async function pickWebCodecsConfig(width, height, fps, bitrate, preferred = 'auto', mode = 'realtime') {
  if (typeof VideoEncoder !== 'function' || typeof VideoFrame !== 'function' || typeof VideoEncoder.isConfigSupported !== 'function') {
    return null;
  }

  // Calcular nivel H.264 mínimo para la resolución/FPS objetivo
  const mbs = Math.ceil(width / 16) * Math.ceil(height / 16);
  const mbps = mbs * fps;
  let avcLvl = '28'; // Level 4.0 (1080p30)
  if (mbs <= 3600 && mbps <= 108000) avcLvl = '1f'; // Level 3.1 (720p30)
  else if (mbs <= 8192 && mbps <= 245760) avcLvl = '28'; // Level 4.0 (1080p30)
  else if (mbs <= 8704 && mbps <= 522240) avcLvl = '2a'; // Level 4.2 (1080p60)
  else if (mbs <= 36864 && mbps <= 983040) avcLvl = '33'; // Level 5.1 (4K30)
  else avcLvl = '34'; // Level 5.2 (4K60)

  const avcSet = (hw) => [
    { codec: `avc1.4200${avcLvl}`, ext: 'mp4', mime: 'video/mp4;codecs=avc1', mux: 'mp4', muxCodec: 'avc1', avc: { format: 'avc' }, hw },
    { codec: `avc1.4d00${avcLvl}`, ext: 'mp4', mime: 'video/mp4;codecs=avc1', mux: 'mp4', muxCodec: 'avc1', avc: { format: 'avc' }, hw },
    { codec: `avc1.6400${avcLvl}`, ext: 'mp4', mime: 'video/mp4;codecs=avc1', mux: 'mp4', muxCodec: 'avc1', avc: { format: 'avc' }, hw },
  ];
  const vp8Set = (hw) => [
    { codec: 'vp8', ext: 'webm', mime: 'video/webm;codecs=vp8', mux: 'webm', muxCodec: 'V_VP8', hw },
  ];
  const vp9Set = (hw) => [
    { codec: 'vp09.00.10.08', ext: 'webm', mime: 'video/webm;codecs=vp9', mux: 'webm', muxCodec: 'V_VP9', hw },
  ];

  let list;
  if (preferred === 'mp4' || preferred === 'video/mp4') {
    list = [...avcSet('prefer-hardware'), ...avcSet('no-preference'), ...vp8Set('prefer-hardware'), ...vp8Set('no-preference')];
  } else if (preferred === 'webm' || preferred === 'video/webm') {
    list = [...vp8Set('prefer-hardware'), ...vp8Set('no-preference'), ...vp9Set('prefer-hardware'), ...vp9Set('no-preference')];
  } else if (preferred === 'webm-vp9' || preferred === 'video/webm;codecs=vp9') {
    list = [...vp9Set('prefer-hardware'), ...vp9Set('no-preference'), ...vp8Set('no-preference')];
  } else if (preferred === 'webm-vp8' || preferred === 'video/webm;codecs=vp8') {
    list = [...vp8Set('prefer-hardware'), ...vp8Set('no-preference')];
  } else {
    list = [
      ...avcSet('prefer-hardware'),
      ...vp8Set('prefer-hardware'),
      ...vp8Set('no-preference'),
      ...avcSet('no-preference'),
      ...vp9Set('no-preference'),
    ];
  }

  for (const cand of list) {
    const base = {
      codec: cand.codec,
      width,
      height,
      bitrate,
      framerate: fps,
      hardwareAcceleration: cand.hw,
    };
    if (cand.avc) base.avc = cand.avc;

    const full = {
      ...base,
      bitrateMode: 'variable',
      latencyMode: 'realtime',
    };

    for (const cfg of [full, base]) {
      try {
        const res = await VideoEncoder.isConfigSupported(cfg);
        if (res && res.supported) {
          return {
            config: res.config || cfg,
            extension: cand.ext,
            mimeType: cand.mime,
            mux: cand.mux,
            muxCodec: cand.muxCodec,
            hardwarePreferred: cand.hw === 'prefer-hardware',
          };
        }
      } catch (_) {
        // continuar con siguiente variante
      }
    }
  }
  return null;
}

export function getSupportedVideoFormats() {
  const hasMR = typeof MediaRecorder !== 'undefined';
  const hasWC = typeof VideoEncoder === 'function' && typeof VideoFrame === 'function';
  const supported = (hasMR || hasWC) && typeof HTMLCanvasElement !== 'undefined';
  if (!supported) {
    return { supported: false, formats: [], defaultMimeType: '', defaultExtension: 'webm' };
  }
  const canCheck = hasMR && typeof MediaRecorder.isTypeSupported === 'function';
  const all = [...MP4_MIME_CANDIDATES, ...WEBM_VP9_CANDIDATES];
  const unique = [...new Set(all)];
  const formats = hasMR ? unique.filter((m) => !canCheck || MediaRecorder.isTypeSupported(m)) : [];
  const def = pickVideoMimeType('auto');
  return {
    supported: true,
    webcodecs: hasWC,
    formats,
    defaultMimeType: def.mimeType,
    defaultExtension: def.extension,
  };
}

// ───────── Parcheador EBML para escribir la duración real en archivos WebM ─────────
// Chrome/Edge MediaRecorder omiten el elemento Duration (0x4489) dentro de Info (0x1549A966),
// haciendo que galerías móviles y reproductores muestren "0:00". Este parche añade o actualiza
// TimecodeScale + Duration directamente en bytes sin dependencias externas.

function readVintWidth(firstByte) {
  if (!firstByte) return 0;
  let mask = 0x80;
  let len = 1;
  while (len <= 8 && (firstByte & mask) === 0) {
    mask >>= 1;
    len++;
  }
  return len <= 8 ? len : 0;
}

function readEbmlId(u8, pos) {
  if (pos >= u8.length) return null;
  const len = readVintWidth(u8[pos]);
  if (!len || len > 4 || pos + len > u8.length) return null;
  let id = 0;
  for (let i = 0; i < len; i++) {
    id = id * 256 + u8[pos + i];
  }
  return { id, length: len };
}

function readEbmlSize(u8, pos) {
  if (pos >= u8.length) return null;
  const len = readVintWidth(u8[pos]);
  if (!len || pos + len > u8.length) return null;
  const firstMask = (1 << (8 - len)) - 1;
  let val = u8[pos] & firstMask;
  let allOnes = val === firstMask;
  for (let i = 1; i < len; i++) {
    const b = u8[pos + i];
    if (b !== 0xff) allOnes = false;
    val = val * 256 + b;
  }
  return { value: val, length: len, unknown: allOnes };
}

function encodeEbmlSize(val) {
  let len = 1;
  while (len <= 8) {
    const maxVal = Math.pow(2, 7 * len) - 2; // reservar todo-unos para "desconocido"
    if (val <= maxVal) break;
    len++;
  }
  if (len > 8) len = 8;
  const out = new Uint8Array(len);
  let v = Math.floor(val);
  for (let i = len - 1; i >= 0; i--) {
    out[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  out[0] |= 1 << (8 - len);
  return out;
}

function readUintBE(u8, pos, len) {
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + u8[pos + i];
  return v;
}

export function patchWebmBufferDuration(buffer, durationMs) {
  const src = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const safeDurationMs = Math.max(1, Number(durationMs) || 0);
  if (src.length < 32) return src;

  const ebmlId = readEbmlId(src, 0);
  if (!ebmlId || ebmlId.id !== 0x1a45dfa3) return src;
  const ebmlSize = readEbmlSize(src, ebmlId.length);
  if (!ebmlSize || ebmlSize.unknown) return src;

  let pos = ebmlId.length + ebmlSize.length + ebmlSize.value;
  if (pos >= src.length) return src;

  const segId = readEbmlId(src, pos);
  if (!segId || segId.id !== 0x18538067) return src;
  const segSizePos = pos + segId.length;
  const segSize = readEbmlSize(src, segSizePos);
  if (!segSize) return src;

  const segDataStart = segSizePos + segSize.length;
  const segEnd = segSize.unknown ? src.length : Math.min(src.length, segDataStart + segSize.value);

  // Recorrer hijos directos de Segment hasta encontrar Info (0x1549A966)
  let cur = segDataStart;
  let info = null;
  const seekHeads = [];
  while (cur < segEnd) {
    const childId = readEbmlId(src, cur);
    if (!childId) break;
    const childSizePos = cur + childId.length;
    const childSize = readEbmlSize(src, childSizePos);
    if (!childSize) break;
    const dataStart = childSizePos + childSize.length;
    if (childSize.unknown) break;
    const dataEnd = Math.min(segEnd, dataStart + childSize.value);

    if (childId.id === 0x114d9b74) {
      seekHeads.push({ dataStart, dataEnd });
    } else if (childId.id === 0x1549a966) {
      info = {
        pos: cur,
        sizePos: childSizePos,
        sizeLen: childSize.length,
        sizeVal: childSize.value,
        dataStart,
        dataEnd,
      };
      break;
    } else if (childId.id === 0x1f43b675) {
      // Cluster antes de Info: poco común, parar
      break;
    }
    cur = dataEnd;
  }

  if (!info) return src;

  // Buscar TimecodeScale (0x2AD7B1) y Duration (0x4489) dentro de Info
  let timecodeScale = 1000000;
  let hasTimecodeScale = false;
  let durElem = null;

  let ic = info.dataStart;
  while (ic < info.dataEnd) {
    const id = readEbmlId(src, ic);
    if (!id) break;
    const szPos = ic + id.length;
    const sz = readEbmlSize(src, szPos);
    if (!sz || sz.unknown) break;
    const dStart = szPos + sz.length;
    const dEnd = Math.min(info.dataEnd, dStart + sz.value);

    if (id.id === 0x2ad7b1 && sz.value >= 1 && sz.value <= 8) {
      timecodeScale = readUintBE(src, dStart, sz.value) || 1000000;
      hasTimecodeScale = true;
    } else if (id.id === 0x4489 && (sz.value === 4 || sz.value === 8)) {
      durElem = { dataStart: dStart, size: sz.value };
    }
    ic = dEnd;
  }

  const durationTicks = (safeDurationMs * 1000000) / timecodeScale;

  // Caso 1: Duration ya existe dentro de Info -> sobrescribir in-place
  if (durElem) {
    const out = new Uint8Array(src);
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    if (durElem.size === 4) dv.setFloat32(durElem.dataStart, durationTicks, false);
    else dv.setFloat64(durElem.dataStart, durationTicks, false);
    return out;
  }

  // Caso 2: Insertar Duration (y TimecodeScale si faltaba) al final de Info
  const extraParts = [];
  if (!hasTimecodeScale) {
    extraParts.push(0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40); // 1_000_000 ns
  }
  const durBytes = new Uint8Array(11);
  durBytes[0] = 0x44;
  durBytes[1] = 0x89;
  durBytes[2] = 0x88;
  new DataView(durBytes.buffer).setFloat64(3, durationTicks, false);
  for (let i = 0; i < durBytes.length; i++) extraParts.push(durBytes[i]);

  const extra = new Uint8Array(extraParts);
  const newInfoPayloadLen = info.sizeVal + extra.length;
  const newInfoSizeVint = encodeEbmlSize(newInfoPayloadLen);
  const delta = (newInfoSizeVint.length - info.sizeLen) + extra.length;

  const out = new Uint8Array(src.length + delta);
  // Copiar hasta el tamaño de Info
  out.set(src.subarray(0, info.sizePos), 0);
  // Nuevo tamaño VINT de Info
  out.set(newInfoSizeVint, info.sizePos);
  // Hijos existentes de Info
  const infoChildrenDest = info.sizePos + newInfoSizeVint.length;
  out.set(src.subarray(info.dataStart, info.dataEnd), infoChildrenDest);
  // Nuevos elementos TimecodeScale / Duration
  out.set(extra, infoChildrenDest + info.sizeVal);
  // Resto del Segment (Tracks, Clusters, etc.)
  out.set(src.subarray(info.dataEnd), infoChildrenDest + info.sizeVal + extra.length);

  // Si Segment tenía tamaño fijo (no desconocido) y cabe en los mismos bytes de VINT, actualizarlo
  if (!segSize.unknown) {
    const newSegVint = encodeEbmlSize(segSize.value + delta);
    if (newSegVint.length === segSize.length) {
      out.set(newSegVint, segSizePos);
    }
  }

  // Ajustar offsets de SeekHead anteriores a Info que apunten después de Info
  const infoRelEnd = info.dataEnd - segDataStart;
  for (const sh of seekHeads) {
    let sc = sh.dataStart;
    while (sc < sh.dataEnd) {
      const sId = readEbmlId(out, sc);
      if (!sId) break;
      const sSzPos = sc + sId.length;
      const sSz = readEbmlSize(out, sSzPos);
      if (!sSz || sSz.unknown) break;
      const sStart = sSzPos + sSz.length;
      const sEnd = Math.min(sh.dataEnd, sStart + sSz.value);
      if (sId.id === 0x4dbb) {
        let kc = sStart;
        while (kc < sEnd) {
          const kId = readEbmlId(out, kc);
          if (!kId) break;
          const kSzPos = kc + kId.length;
          const kSz = readEbmlSize(out, kSzPos);
          if (!kSz || kSz.unknown) break;
          const kStart = kSzPos + kSz.length;
          const kEnd = Math.min(sEnd, kStart + kSz.value);
          if (kId.id === 0x53ac && kSz.value >= 1 && kSz.value <= 6) {
            const oldOffset = readUintBE(out, kStart, kSz.value);
            if (oldOffset >= infoRelEnd) {
              const nextOffset = oldOffset + delta;
              if (nextOffset < Math.pow(2, kSz.value * 8)) {
                let tmp = nextOffset;
                for (let b = kSz.value - 1; b >= 0; b--) {
                  out[kStart + b] = tmp & 0xff;
                  tmp = Math.floor(tmp / 256);
                }
              }
            }
          }
          kc = kEnd;
        }
      }
      sc = sEnd;
    }
  }

  return out;
}

export async function patchWebmDuration(blob, durationMs) {
  if (!blob || !(durationMs > 0)) return blob;
  try {
    const ab = await blob.arrayBuffer();
    const patched = patchWebmBufferDuration(ab, durationMs);
    if (patched.buffer === ab) return blob;
    return new Blob([patched], { type: blob.type || 'video/webm' });
  } catch (_) {
    return blob;
  }
}

/**
 * Grabador de video de alta resolución para Renderer + Camera en Made3D.
 * Usa WebCodecs (VideoEncoder + muxer MP4/WebM sin dependencias) cuando está disponible
 * para evitar caídas silenciosas de FPS de MediaRecorder y copias 2D redundantes,
 * con respaldo automático a MediaRecorder.
 */
export class VideoRecorder extends EventEmitter {
  constructor(renderer, scene, camera, width = 1920, height = 1080, opts = {}) {
    super();
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.fps = Math.max(1, Math.min(120, Math.round(opts.fps || 30)));
    this.mode = opts.mode === 'fixed' ? 'fixed' : 'realtime';
    this.preferredFormat = opts.format || opts.mimeType || 'auto';
    this.includeGrid = opts.includeGrid === true;
    this.hideHelpers = opts.hideHelpers !== false;
    this.viewportCamera = opts.viewportCamera || null;
    this._lastViewportCamera = this.viewportCamera;
    this.maxSize = opts.maxSize || 4096;

    if (renderer && typeof renderer.clampRenderSize === 'function') {
      const clamped = renderer.clampRenderSize(width || 1920, height || 1080, {
        maxSize: this.maxSize,
        minSize: 2,
        even: true,
      });
      this.width = clamped.width;
      this.height = clamped.height;
    } else {
      const caps = renderer && typeof renderer.getCapabilities === 'function' ? renderer.getCapabilities() : null;
      const maxW = Math.max(2, Math.min(caps?.maxViewportWidth || 4096, caps?.maxTextureSize || 4096, caps?.maxRenderbufferSize || 4096, this.maxSize));
      const maxH = Math.max(2, Math.min(caps?.maxViewportHeight || 4096, caps?.maxTextureSize || 4096, caps?.maxRenderbufferSize || 4096, this.maxSize));

      // Los códecs de video (H.264/VP8/VP9) requieren dimensiones pares.
      const rawW = Math.max(2, Math.min(maxW, Math.round(width || 1920)));
      const rawH = Math.max(2, Math.min(maxH, Math.round(height || 1080)));
      this.width = Math.max(2, rawW - (rawW % 2));
      this.height = Math.max(2, rawH - (rawH % 2));
    }

    const picked = pickVideoMimeType(this.preferredFormat);
    this.mimeType = picked.mimeType;
    this.extension = picked.extension;
    const mobile = isMobileBrowser();
    const maxBitrate = mobile ? 14_000_000 : 24_000_000;
    const bpp = mobile ? 0.11 : 0.13;
    this.bitrate = opts.bitrate || Math.round(Math.max(2_000_000, Math.min(maxBitrate, this.width * this.height * this.fps * bpp)));

    this.canvas = opts.targetCanvas || (typeof document !== 'undefined' ? document.createElement('canvas') : null);
    this._ctx2d = this.canvas
      ? (this.canvas.getContext('2d', { alpha: false, desynchronized: true }) || this.canvas.getContext('2d'))
      : null;
    if (this.canvas && this._ctx2d) this.canvas._m3dCtx2d = this._ctx2d;

    this.recording = false;
    this.frames = 0;
    this.encodedFrames = 0;
    this.elapsed = 0;
    this.didRenderViewport = false;
    this.encoderType = 'mediarecorder';
    this.codecUsed = this.mimeType;

    this._wcChoice = null;
    this._useWebCodecs = false;
    this._encoder = null;
    this._muxer = null;
    this._encError = null;
    this._onEncoderDequeue = null;
    this._lastTsUs = -1000;
    this._prepared = false;

    this._stream = null;
    this._videoTrack = null;
    this._recorder = null;
    this._chunks = [];
    this._startTime = 0;
    this._lastCapTime = 0;
    this._nextCapTime = 0;
    this._frameInterval = 1000 / this.fps;
    this._stopPromise = null;
  }

  async prepare() {
    if (this._prepared) return this;
    this._prepared = true;
    const wc = await pickWebCodecsConfig(
      this.width,
      this.height,
      this.fps,
      this.bitrate,
      this.preferredFormat,
      this.mode
    );
    if (wc) {
      this._wcChoice = wc;
      this._useWebCodecs = true;
      this.encoderType = 'webcodecs';
      this.mimeType = wc.mimeType;
      this.extension = wc.extension;
      this.codecUsed = wc.config.codec;
    } else {
      this._useWebCodecs = false;
      this.encoderType = 'mediarecorder';
    }
    return this;
  }

  _encodeCanvasFrame(srcCanvas, tsUs, keyFrame = false) {
    if (!this._encoder || this._encoder.state === 'closed') return false;
    const frameDurUs = Math.max(1, Math.round(1_000_000 / this.fps));
    let vf = null;
    try {
      vf = new VideoFrame(srcCanvas, { timestamp: tsUs, duration: frameDurUs });
    } catch (_) {
      // Si el canvas fuente aún no admite VideoFrame directo en este navegador/WebView, copiar al canvas 2D
      if (this.canvas && this.renderer && this.renderer.backend) {
        this.renderer.backend.copyCanvasTo2D(this.canvas, this.width, this.height, { opaque: true });
        vf = new VideoFrame(this.canvas, { timestamp: tsUs, duration: frameDurUs });
      }
    }
    if (!vf) return false;
    try {
      this._encoder.encode(vf, { keyFrame });
      return true;
    } finally {
      vf.close();
    }
  }

  start() {
    if (this.recording) return this;
    const lost = !this.renderer || (typeof this.renderer.isContextLost === 'function' ? this.renderer.isContextLost() : this.renderer.contextLost);
    if (lost) {
      throw new Error('No hay contexto gráfico activo para grabar video.');
    }

    if (typeof this.renderer.beginRecordingSession === 'function') {
      this.renderer.beginRecordingSession(this.width, this.height);
    }

    if (this._useWebCodecs && this._wcChoice) {
      this._encError = null;
      this.encodedFrames = 0;
      this._lastTsUs = -1000;

      this._muxer = this._wcChoice.mux === 'mp4'
        ? new MP4Muxer({ width: this.width, height: this.height, fps: this.fps })
        : new WebMMuxer({ width: this.width, height: this.height, fps: this.fps, codec: this._wcChoice.muxCodec });

      this._onEncoderDequeue = null;
      this._encoder = new VideoEncoder({
        output: (chunk, meta) => {
          if (this._muxer) this._muxer.addVideoChunk(chunk, meta);
          this.encodedFrames++;
        },
        error: (err) => {
          this._encError = err instanceof Error ? err : new Error(String(err || 'Error en VideoEncoder'));
          if (this._onEncoderDequeue) {
            const fn = this._onEncoderDequeue;
            this._onEncoderDequeue = null;
            fn();
          }
          this.emit('error', this._encError);
        },
      });
      this._encoder.ondequeue = () => {
        if (this._onEncoderDequeue) {
          const fn = this._onEncoderDequeue;
          this._onEncoderDequeue = null;
          fn();
        }
      };
      try {
        this._encoder.configure(this._wcChoice.config);
      } catch (err) {
        if (typeof this.renderer.endRecordingSession === 'function') {
          this.renderer.endRecordingSession();
        }
        throw err;
      }

      const now = performance.now();
      this._startTime = now;
      this._lastCapTime = now;
      this._nextCapTime = now + this._frameInterval;
      this.frames = 0;
      this.elapsed = 0;
      this.recording = true;
      this._stopPromise = null;

      if (this.mode === 'realtime') {
        this._lastViewportCamera = this.viewportCamera;
        let encodedFirst = false;
        const ok = this.renderer.renderToCanvas(this.scene, this.camera, this.width, this.height, {
          targetCanvas: this.canvas,
          includeGrid: this.includeGrid,
          hideHelpers: this.hideHelpers,
          viewportCamera: this.viewportCamera,
          maxSize: this.maxSize,
          opaque: true,
          onFrameReady: (srcCanvas) => {
            encodedFirst = this._encodeCanvasFrame(srcCanvas, 0, true);
          },
        });
        if (!ok || !encodedFirst) {
          this.recording = false;
          try { this._encoder.close(); } catch (_) { /* ignore */ }
          this._encoder = null;
          this._muxer = null;
          if (typeof this.renderer.endRecordingSession === 'function') {
            this.renderer.endRecordingSession();
          }
          throw new Error('No se pudo codificar el cuadro inicial con WebCodecs.');
        }
        this._lastTsUs = 0;
        this.frames = 1;
        this.didRenderViewport = Boolean(this.renderer._lastRenderToCanvasRenderedViewport);
      }

      this.emit('start', {
        width: this.width,
        height: this.height,
        fps: this.fps,
        mimeType: this.mimeType,
        encoder: 'webcodecs',
        mode: this.mode,
      });
      return this;
    }

    // ───────── Respaldo MediaRecorder ─────────
    if (!this.canvas || typeof this.canvas.captureStream !== 'function' || typeof MediaRecorder === 'undefined') {
      throw new Error('Este navegador no soporta grabación de video desde canvas (WebCodecs / MediaRecorder).');
    }

    this._lastViewportCamera = this.viewportCamera;
    const ok = this.renderer.renderToCanvas(this.scene, this.camera, this.width, this.height, {
      targetCanvas: this.canvas,
      includeGrid: this.includeGrid,
      hideHelpers: this.hideHelpers,
      viewportCamera: this.viewportCamera,
      maxSize: this.maxSize,
      opaque: true,
    });
    if (!ok) {
      if (typeof this.renderer.endRecordingSession === 'function') {
        this.renderer.endRecordingSession();
      }
      throw new Error('No se pudo renderizar el cuadro inicial del video.');
    }
    this.didRenderViewport = Boolean(this.renderer._lastRenderToCanvasRenderedViewport);

    const probeStream = this.canvas.captureStream(0);
    const probeTrack = probeStream.getVideoTracks()[0];
    if (probeTrack && typeof probeTrack.requestFrame === 'function') {
      this._stream = probeStream;
      this._videoTrack = probeTrack;
    } else {
      for (const t of probeStream.getTracks()) t.stop();
      this._stream = this.canvas.captureStream(this.fps);
      this._videoTrack = this._stream.getVideoTracks()[0] || null;
    }

    this._chunks = [];
    const recOpts = { videoBitsPerSecond: this.bitrate };
    if (this.mimeType) recOpts.mimeType = this.mimeType;

    try {
      this._recorder = new MediaRecorder(this._stream, recOpts);
    } catch (_) {
      this._recorder = new MediaRecorder(this._stream);
      this.mimeType = this._recorder.mimeType || 'video/webm';
      this.extension = this.mimeType.includes('mp4') ? 'mp4' : 'webm';
    }

    if (this._recorder.mimeType) {
      this.mimeType = this._recorder.mimeType;
      this.extension = this.mimeType.includes('mp4') ? 'mp4' : 'webm';
    }
    this.codecUsed = this.mimeType;

    this._recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this._chunks.push(e.data);
    };

    const now = performance.now();
    this._startTime = now;
    this._lastCapTime = now;
    this._nextCapTime = now + this._frameInterval;
    this.frames = 1;
    this.encodedFrames = 1;
    this.elapsed = 0;
    this.recording = true;
    this._stopPromise = null;

    this._recorder.start(1000);
    if (this._videoTrack && typeof this._videoTrack.requestFrame === 'function') {
      try { this._videoTrack.requestFrame(); } catch (_) { /* ignore */ }
    }
    this.emit('start', {
      width: this.width,
      height: this.height,
      fps: this.fps,
      mimeType: this.mimeType,
      encoder: 'mediarecorder',
      mode: this.mode,
    });
    return this;
  }

  captureFrame(force = false, opts = {}) {
    if (!this.recording) return false;

    if (this._useWebCodecs) {
      if (!this._encoder || this._encoder.state === 'closed') return false;
      if (this._encError) throw this._encError;

      const now = performance.now();
      const tol = Math.min(8, this._frameInterval * 0.25);
      if (!force && now + tol < this._nextCapTime) {
        this.elapsed = (now - this._startTime) / 1000;
        this.didRenderViewport = false;
        return false;
      }
      // Contrapresión real: permitir pipeline fluido a 60fps sin atascar por colas cortas
      const rtMaxQueue = this.fps >= 45 ? 8 : 4;
      if (!force && this._encoder.encodeQueueSize >= rtMaxQueue) {
        this.elapsed = (now - this._startTime) / 1000;
        this.didRenderViewport = false;
        return false;
      }

      const rawTsUs = Math.max(0, Math.round((now - this._startTime) * 1000));
      const tsUs = Math.max(this._lastTsUs + 1000, rawTsUs);
      const isKey = (this.frames % Math.max(1, this.fps * 2)) === 0;
      const vpCam = opts.viewportCamera !== undefined ? opts.viewportCamera : this.viewportCamera;
      this._lastViewportCamera = vpCam;

      let encoded = false;
      const ok = this.renderer.renderToCanvas(this.scene, this.camera, this.width, this.height, {
        targetCanvas: this.canvas,
        includeGrid: this.includeGrid,
        hideHelpers: this.hideHelpers,
        viewportCamera: vpCam,
        maxSize: this.maxSize,
        deferViewportRender: Boolean(opts.deferViewportRender),
        time: opts.time,
        opaque: true,
        onFrameReady: (srcCanvas) => {
          encoded = this._encodeCanvasFrame(srcCanvas, tsUs, isKey);
        },
      });
      if (!ok || !encoded) {
        this.didRenderViewport = false;
        return false;
      }

      this._lastTsUs = tsUs;
      this.didRenderViewport = Boolean(this.renderer._lastRenderToCanvasRenderedViewport);
      this.frames++;
      this._nextCapTime += this._frameInterval;
      if (this._nextCapTime <= now - tol) {
        this._nextCapTime = now + this._frameInterval;
      }
      const doneNow = performance.now();
      this._lastCapTime = doneNow;
      this.elapsed = (doneNow - this._startTime) / 1000;
      this.emit('frame', { frames: this.frames, encodedFrames: this.encodedFrames, elapsed: this.elapsed });
      return true;
    }

    if (!this._recorder) return false;
    const now = performance.now();
    const tol = Math.min(8, this._frameInterval * 0.25);
    if (!force && now + tol < this._nextCapTime) {
      this.elapsed = (now - this._startTime) / 1000;
      this.didRenderViewport = false;
      return false;
    }

    const vpCam = opts.viewportCamera !== undefined ? opts.viewportCamera : this.viewportCamera;
    this._lastViewportCamera = vpCam;
    const ok = this.renderer.renderToCanvas(this.scene, this.camera, this.width, this.height, {
      targetCanvas: this.canvas,
      includeGrid: this.includeGrid,
      hideHelpers: this.hideHelpers,
      viewportCamera: vpCam,
      maxSize: this.maxSize,
      deferViewportRender: Boolean(opts.deferViewportRender),
      time: opts.time,
      opaque: true,
    });
    if (!ok) {
      this.didRenderViewport = false;
      return false;
    }
    this.didRenderViewport = Boolean(this.renderer._lastRenderToCanvasRenderedViewport);

    if (this._videoTrack && typeof this._videoTrack.requestFrame === 'function') {
      try { this._videoTrack.requestFrame(); } catch (_) { /* ignore */ }
    }

    this.frames++;
    this.encodedFrames = this.frames;
    this._nextCapTime += this._frameInterval;
    if (this._nextCapTime <= now - tol) {
      this._nextCapTime = now + this._frameInterval;
    }
    const doneNow = performance.now();
    this._lastCapTime = doneNow;
    this.elapsed = (doneNow - this._startTime) / 1000;
    this.emit('frame', { frames: this.frames, encodedFrames: this.encodedFrames, elapsed: this.elapsed });
    return true;
  }

  async _waitForEncoderSlot(maxQueue = 8, lowWater = 4) {
    if (!this.recording || !this._encoder || this._encoder.state === 'closed') return false;
    if (this._encoder.encodeQueueSize < maxQueue) return true;

    let lastProgressAt = performance.now();
    let prevEncoded = this.encodedFrames;
    let prevQueue = this._encoder.encodeQueueSize;

    while (
      this.recording &&
      this._encoder &&
      this._encoder.state !== 'closed' &&
      this._encoder.encodeQueueSize > lowWater
    ) {
      if (this._encError) throw this._encError;
      await new Promise((resolve) => {
        let done = false;
        let timer = 0;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (this._onEncoderDequeue === finish) this._onEncoderDequeue = null;
          resolve();
        };
        this._onEncoderDequeue = finish;
        timer = setTimeout(finish, 20);
      });
      if (this._encError) throw this._encError;
      if (!this.recording || !this._encoder || this._encoder.state === 'closed') return false;

      const curQueue = this._encoder.encodeQueueSize;
      if (this.encodedFrames !== prevEncoded || curQueue < prevQueue) {
        prevEncoded = this.encodedFrames;
        prevQueue = curQueue;
        lastProgressAt = performance.now();
      } else if (performance.now() - lastProgressAt >= 4000) {
        if (curQueue < 24) return true;
        throw new Error('El codificador de video dejó de responder durante la grabación.');
      }
    }
    return this.recording && Boolean(this._encoder) && this._encoder.state !== 'closed';
  }

  /**
   * Captura un cuadro con paso temporal exacto (`frameIndex / fps`), esperando contrapresión
   * del codificador para producir videos a 30/60 FPS constantes sin pérdida de cuadros.
   */
  async captureFixedFrame(frameIndex, opts = {}) {
    if (!this.recording) return false;
    if (!this._useWebCodecs || !this._encoder) {
      return this.captureFrame(true, opts);
    }
    if (this._encError) throw this._encError;

    const maxQueue = this.fps >= 45 ? 10 : 6;
    const lowWater = this.fps >= 45 ? 4 : 3;
    const ready = await this._waitForEncoderSlot(maxQueue, lowWater);
    if (!ready) return false;

    const tsUs = Math.round((frameIndex * 1_000_000) / this.fps);
    const isKey = (frameIndex % Math.max(1, this.fps * 2)) === 0;
    const vpCam = opts.viewportCamera !== undefined ? opts.viewportCamera : this.viewportCamera;
    this._lastViewportCamera = vpCam;

    let encoded = false;
    const ok = this.renderer.renderToCanvas(this.scene, this.camera, this.width, this.height, {
      targetCanvas: this.canvas,
      includeGrid: this.includeGrid,
      hideHelpers: this.hideHelpers,
      viewportCamera: vpCam,
      maxSize: this.maxSize,
      deferViewportRender: Boolean(opts.deferViewportRender),
      time: opts.time,
      opaque: true,
      onFrameReady: (srcCanvas) => {
        encoded = this._encodeCanvasFrame(srcCanvas, tsUs, isKey);
      },
    });
    if (!ok || !encoded) {
      this.didRenderViewport = false;
      return false;
    }

    this._lastTsUs = tsUs;
    this.didRenderViewport = Boolean(this.renderer._lastRenderToCanvasRenderedViewport);
    this.frames = frameIndex + 1;
    this.elapsed = this.frames / this.fps;
    this._lastCapTime = performance.now();
    this.emit('frame', { frames: this.frames, encodedFrames: this.encodedFrames, elapsed: this.elapsed });
    return true;
  }

  /**
   * Ejecuta el bucle completo de grabación a FPS fijos (`mode === 'fixed'`), avanzando el reloj
   * simulado de manera uniforme, esperando contrapresión de WebCodecs y actualizando el viewport
   * de vista previa sin bloquear el renderizado.
   */
  async runFixedLoop(opts = {}) {
    const duration = Math.max(0, Number(opts.duration || 0));
    const targetFrames = duration > 0 ? Math.max(1, Math.round(duration * this.fps)) : 0;
    const fixedDt = 1 / this.fps;
    const previewIntervalMs = opts.previewIntervalMs ?? 50;
    const deferViewportRender = opts.deferViewportRender !== false;
    const autoStop = opts.autoStop === true;
    const signal = opts.signal || null;

    let aborted = Boolean(signal && signal.aborted);
    const onAbort = () => {
      aborted = true;
      this.cancel();
    };
    if (signal) {
      if (aborted) {
        this.cancel();
        throw new Error('Grabación de video cancelada.');
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    let simElapsed = Number.isFinite(opts.startTime) ? opts.startTime : 0;
    let frameIdx = 0;
    let lastPreviewAt = 0;
    let completed = false;

    try {
      while (this.recording && !aborted && !(opts.isCancelled && opts.isCancelled())) {
        simElapsed += fixedDt;
        let vpCam = opts.viewportCamera !== undefined ? opts.viewportCamera : this.viewportCamera;
        if (typeof opts.onStep === 'function') {
          const stepRes = opts.onStep(fixedDt, simElapsed, frameIdx);
          if (stepRes && stepRes.isCamera) vpCam = stepRes;
          else if (stepRes && stepRes.viewportCamera) vpCam = stepRes.viewportCamera;
        }

        const captured = await this.captureFixedFrame(frameIdx, {
          viewportCamera: vpCam,
          deferViewportRender,
          time: simElapsed,
        });
        if (!captured || !this.recording || aborted || (opts.isCancelled && opts.isCancelled())) {
          break;
        }

        const now = performance.now();
        const shouldRenderPreview =
          frameIdx === 0 || now - lastPreviewAt >= previewIntervalMs;
        let didRenderPreview = Boolean(this.didRenderViewport);

        if (
          deferViewportRender &&
          shouldRenderPreview &&
          this.renderer &&
          this.scene &&
          vpCam &&
          !this.didRenderViewport
        ) {
          this.renderer.render(this.scene, vpCam, {
            skipAdapt: true,
            reuseShadowMap: true,
            time: simElapsed,
          });
          lastPreviewAt = now;
          didRenderPreview = true;
        }

        frameIdx++;

        if (typeof opts.onFrame === 'function') {
          opts.onFrame({
            frameIdx,
            frames: this.frames,
            encodedFrames: this.encodedFrames,
            elapsed: this.elapsed,
            fps: this.fps,
            simElapsed,
            targetFrames,
            progress: targetFrames > 0 ? Math.min(1, this.frames / targetFrames) : 0,
          });
        }

        if (targetFrames > 0 && this.frames >= targetFrames) {
          completed = true;
          break;
        }

        await new Promise((resolve) => {
          const hidden = typeof document !== 'undefined' && document.hidden;
          if (didRenderPreview && !hidden && typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(resolve);
          } else {
            setTimeout(resolve, 0);
          }
        });
      }

      if (aborted) {
        throw new Error('Grabación de video cancelada.');
      }
      if (autoStop) {
        return await this.stop();
      }
      return { completed, frames: this.frames, elapsed: this.elapsed };
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  stop() {
    if (this._stopPromise) return this._stopPromise;

    if (this._useWebCodecs) {
      if (!this._encoder) {
        this.recording = false;
        return Promise.resolve(null);
      }
      this.recording = false;
      if (this._onEncoderDequeue) {
        const fn = this._onEncoderDequeue;
        this._onEncoderDequeue = null;
        fn();
      }
      const enc = this._encoder;
      const mux = this._muxer;
      this._encoder = null;
      this._muxer = null;

      const finalElapsed = this.mode === 'fixed'
        ? Math.max(1 / this.fps, this.frames / this.fps)
        : Math.max(0.05, (performance.now() - this._startTime) / 1000);
      this.elapsed = finalElapsed;

      this._stopPromise = (async () => {
        try {
          if (enc.state !== 'closed') {
            await enc.flush();
            enc.close();
          }
          if (this._encError) throw this._encError;
          const bytes = mux ? mux.finalize() : new Uint8Array(0);
          const type = this.mimeType || (this.extension === 'mp4' ? 'video/mp4' : 'video/webm');
          const blob = new Blob([bytes], { type });
          const result = {
            blob,
            mimeType: type,
            extension: this.extension,
            width: this.width,
            height: this.height,
            fps: this.fps,
            duration: finalElapsed,
            frames: this.frames,
            encodedFrames: this.encodedFrames || this.frames,
            encoder: 'webcodecs',
            mode: this.mode,
          };
          this.emit('stop', result);
          return result;
        } catch (err) {
          this.emit('error', err);
          throw err;
        } finally {
          if (this.renderer && typeof this.renderer.endRecordingSession === 'function') {
            this.renderer.endRecordingSession();
          }
        }
      })();
      return this._stopPromise;
    }

    if (!this._recorder) {
      this.recording = false;
      this._cleanupStream();
      if (this.renderer && typeof this.renderer.endRecordingSession === 'function') {
        this.renderer.endRecordingSession();
      }
      return Promise.resolve(null);
    }

    // Asegurar al menos un cuadro final reciente antes de cerrar el MediaRecorder
    if (this.frames < 2 || performance.now() - this._lastCapTime > 30) {
      this.captureFrame(true, { viewportCamera: this._lastViewportCamera });
    }

    this.recording = false;
    const rec = this._recorder;
    const finalElapsed = Math.max(0.05, (performance.now() - this._startTime) / 1000);
    this.elapsed = finalElapsed;

    this._stopPromise = new Promise((resolve, reject) => {
      const finish = async () => {
        const type = this.mimeType || rec.mimeType || 'video/webm';
        const ext = type.includes('mp4') ? 'mp4' : 'webm';
        let blob = new Blob(this._chunks, { type });
        this._cleanupStream();
        this._recorder = null;
        this._chunks = [];

        if (ext === 'webm' && blob.size > 0) {
          blob = await patchWebmDuration(blob, finalElapsed * 1000);
        }

        const result = {
          blob,
          mimeType: type,
          extension: ext,
          width: this.width,
          height: this.height,
          fps: this.fps,
          duration: finalElapsed,
          frames: this.frames,
          encodedFrames: this.frames,
          encoder: 'mediarecorder',
          mode: this.mode,
        };
        this.emit('stop', result);
        resolve(result);
      };

      if (rec.state === 'inactive') {
        finish();
        return;
      }

      rec.onstop = finish;
      rec.onerror = (e) => {
        this._cleanupStream();
        this._recorder = null;
        this._chunks = [];
        const err = (e && e.error) || new Error('Error al codificar el video.');
        this.emit('error', err);
        reject(err);
      };

      try {
        if (rec.state === 'recording' && typeof rec.requestData === 'function') {
          try { rec.requestData(); } catch (_) { /* ignore */ }
        }
        rec.stop();
      } catch (err) {
        this._cleanupStream();
        this._recorder = null;
        reject(err);
      }
    });

    return this._stopPromise;
  }

  cancel() {
    this.recording = false;
    if (this._onEncoderDequeue) {
      const fn = this._onEncoderDequeue;
      this._onEncoderDequeue = null;
      fn();
    }
    if (this._encoder) {
      try { if (this._encoder.state !== 'closed') this._encoder.close(); } catch (_) { /* ignore */ }
      this._encoder = null;
      this._muxer = null;
    }
    const rec = this._recorder;
    this._recorder = null;
    if (rec && rec.state !== 'inactive') {
      rec.ondataavailable = null;
      rec.onstop = null;
      rec.onerror = null;
      try { rec.stop(); } catch (_) { /* ignore */ }
    }
    this._chunks = [];
    this._cleanupStream();
    this.emit('cancel');
  }

  _cleanupStream() {
    if (this._stream) {
      for (const track of this._stream.getTracks()) {
        try { track.stop(); } catch (_) { /* ignore */ }
      }
      this._stream = null;
    }
    this._videoTrack = null;
    if (this.renderer && typeof this.renderer.endRecordingSession === 'function') {
      this.renderer.endRecordingSession();
    }
  }
}
