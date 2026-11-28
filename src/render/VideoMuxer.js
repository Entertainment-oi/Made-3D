// Muxadores binarios sin dependencias externas para WebCodecs (MP4 ISO-BMFF H.264 y WebM EBML VP8/VP9).

const ASCII = (s) => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};

function concatBytes(parts) {
  let total = 0;
  for (let i = 0; i < parts.length; i++) total += parts[i].byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (let i = 0; i < parts.length; i++) {
    out.set(parts[i], offset);
    offset += parts[i].byteLength;
  }
  return out;
}

function u16(v) {
  return new Uint8Array([(v >>> 8) & 0xff, v & 0xff]);
}

function i16(v) {
  const x = v < 0 ? 0x10000 + v : v;
  return new Uint8Array([(x >>> 8) & 0xff, x & 0xff]);
}

function u32(v) {
  return new Uint8Array([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
}

function u64(v) {
  const hi = Math.floor(v / 0x100000000);
  const lo = v >>> 0;
  return concatBytes([u32(hi), u32(lo)]);
}

function mp4Box(type, ...parts) {
  const payload = concatBytes(parts);
  const out = new Uint8Array(8 + payload.byteLength);
  const sz = out.byteLength;
  out[0] = (sz >>> 24) & 0xff;
  out[1] = (sz >>> 16) & 0xff;
  out[2] = (sz >>> 8) & 0xff;
  out[3] = sz & 0xff;
  out[4] = type.charCodeAt(0) & 0xff;
  out[5] = type.charCodeAt(1) & 0xff;
  out[6] = type.charCodeAt(2) & 0xff;
  out[7] = type.charCodeAt(3) & 0xff;
  out.set(payload, 8);
  return out;
}

function mp4FullBox(type, version, flags, ...parts) {
  const head = new Uint8Array([
    version & 0xff,
    (flags >>> 16) & 0xff,
    (flags >>> 8) & 0xff,
    flags & 0xff,
  ]);
  return mp4Box(type, head, ...parts);
}

const IDENTITY_MATRIX = concatBytes([
  u32(0x00010000), u32(0), u32(0),
  u32(0), u32(0x00010000), u32(0),
  u32(0), u32(0), u32(0x40000000),
]);

/**
 * Extrae o construye un registro `avcC` si el navegador entrega start-codes Annex-B.
 */
function buildAvcCFromAnnexB(bytes) {
  const nalus = [];
  let i = 0;
  while (i < bytes.length) {
    let start = -1;
    if (i + 3 < bytes.length && bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 0 && bytes[i + 3] === 1) {
      start = i + 4;
    } else if (i + 2 < bytes.length && bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) {
      start = i + 3;
    } else {
      i++;
      continue;
    }
    let end = start;
    while (end < bytes.length) {
      if (
        (end + 3 < bytes.length && bytes[end] === 0 && bytes[end + 1] === 0 && bytes[end + 2] === 0 && bytes[end + 3] === 1) ||
        (end + 2 < bytes.length && bytes[end] === 0 && bytes[end + 1] === 0 && bytes[end + 2] === 1)
      ) {
        break;
      }
      end++;
    }
    if (end > start) nalus.push(bytes.subarray(start, end));
    i = end;
  }
  const sps = nalus.find((n) => (n[0] & 0x1f) === 7);
  const pps = nalus.find((n) => (n[0] & 0x1f) === 8);
  if (!sps || !pps || sps.length < 4) return null;
  return concatBytes([
    new Uint8Array([1, sps[1], sps[2], sps[3], 0xff, 0xe1]),
    u16(sps.length),
    sps,
    new Uint8Array([1]),
    u16(pps.length),
    pps,
  ]);
}

function isValidAvccSample(bytes) {
  if (!bytes || bytes.length < 5) return false;
  let pos = 0;
  let count = 0;
  while (pos + 4 <= bytes.length) {
    const len = ((bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]) >>> 0;
    if (len === 0 || pos + 4 + len > bytes.length) return false;
    pos += 4 + len;
    count++;
  }
  return count > 0 && pos === bytes.length;
}

function annexBToAvccSample(bytes, stripParamSets = false) {
  // Si parece start-code Annex-B (00 00 00 01 o 00 00 01), convertir a NALUs con prefijo de 4 bytes.
  const isAnnexB =
    (bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0 && bytes[3] === 1) ||
    (bytes.length >= 3 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1);
  if (!isAnnexB) return bytes;

  const nalus = [];
  let i = 0;
  while (i < bytes.length) {
    let start = -1;
    if (i + 3 < bytes.length && bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 0 && bytes[i + 3] === 1) {
      start = i + 4;
    } else if (i + 2 < bytes.length && bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) {
      start = i + 3;
    } else {
      i++;
      continue;
    }
    let end = start;
    while (end < bytes.length) {
      if (
        (end + 3 < bytes.length && bytes[end] === 0 && bytes[end + 1] === 0 && bytes[end + 2] === 0 && bytes[end + 3] === 1) ||
        (end + 2 < bytes.length && bytes[end] === 0 && bytes[end + 1] === 0 && bytes[end + 2] === 1)
      ) {
        break;
      }
      end++;
    }
    if (end > start) {
      nalus.push(bytes.subarray(start, end));
    }
    i = end;
  }
  if (!nalus.length) return bytes;

  const filtered = stripParamSets
    ? nalus.filter((n) => {
        const t = n[0] & 0x1f;
        return t !== 7 && t !== 8;
      })
    : nalus;
  const chosen = filtered.length ? filtered : nalus;
  const outParts = [];
  for (let k = 0; k < chosen.length; k++) {
    outParts.push(u32(chosen[k].byteLength), chosen[k]);
  }
  return outParts.length ? concatBytes(outParts) : bytes;
}

function parseAvccNalus(bytes) {
  const nalus = [];
  let pos = 0;
  while (pos + 4 <= bytes.length) {
    const len = ((bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]) >>> 0;
    if (len === 0 || pos + 4 + len > bytes.length) return null;
    nalus.push(bytes.subarray(pos + 4, pos + 4 + len));
    pos += 4 + len;
  }
  return pos === bytes.length && nalus.length ? nalus : null;
}

function buildAvcCFromNalus(nalus) {
  if (!nalus || !nalus.length) return null;
  const sps = nalus.find((n) => (n[0] & 0x1f) === 7);
  const pps = nalus.find((n) => (n[0] & 0x1f) === 8);
  if (!sps || !pps || sps.length < 4) return null;
  return concatBytes([
    new Uint8Array([1, sps[1], sps[2], sps[3], 0xff, 0xe1]),
    u16(sps.length),
    sps,
    new Uint8Array([1]),
    u16(pps.length),
    pps,
  ]);
}

function stripAvccParamSets(bytes) {
  const nalus = parseAvccNalus(bytes);
  if (!nalus) return bytes;
  let hasParamSet = false;
  let hasNonParam = false;
  for (let i = 0; i < nalus.length; i++) {
    const t = nalus[i][0] & 0x1f;
    if (t === 7 || t === 8) hasParamSet = true;
    else hasNonParam = true;
  }
  if (!hasParamSet || !hasNonParam) return bytes;
  const outParts = [];
  for (let i = 0; i < nalus.length; i++) {
    const t = nalus[i][0] & 0x1f;
    if (t === 7 || t === 8) continue;
    outParts.push(u32(nalus[i].byteLength), nalus[i]);
  }
  return outParts.length ? concatBytes(outParts) : bytes;
}

/**
 * Muxador ISO-BMFF MP4 (faststart) para video H.264 proveniente de WebCodecs VideoEncoder.
 */
export class MP4Muxer {
  constructor({ width, height, fps = 30, avcFormat = 'auto' }) {
    this.width = width;
    this.height = height;
    this.fps = Math.max(1, fps || 30);
    this.timescale = 90000;
    this.avcC = null;
    this._isAvcc = avcFormat === 'avc';
    this.samples = [];
    this.totalMdatBytes = 0;
  }

  addVideoChunk(chunk, meta) {
    if (meta && meta.decoderConfig && meta.decoderConfig.description) {
      const desc = new Uint8Array(meta.decoderConfig.description);
      if (desc.length >= 7 && desc[0] === 1) {
        this._isAvcc = true;
        if (!this.avcC) this.avcC = desc.slice();
      } else if (!this.avcC) {
        this.avcC = buildAvcCFromAnnexB(desc);
      }
    }
    if (!chunk || !chunk.byteLength) return;
    const raw = new Uint8Array(chunk.byteLength);
    chunk.copyTo(raw);
    const validAvcc = isValidAvccSample(raw);
    const startsAnnexB =
      (raw.length >= 4 && raw[0] === 0 && raw[1] === 0 && raw[2] === 0 && raw[3] === 1) ||
      (raw.length >= 3 && raw[0] === 0 && raw[1] === 0 && raw[2] === 1);
    const isAvcc = validAvcc || (this._isAvcc && !startsAnnexB);
    if (!this.avcC) {
      if (isAvcc) {
        const avccNalus = parseAvccNalus(raw);
        this.avcC = buildAvcCFromNalus(avccNalus);
      } else {
        this.avcC = buildAvcCFromAnnexB(raw);
      }
    }
    const data = isAvcc
      ? (this.avcC ? stripAvccParamSets(raw) : raw)
      : annexBToAvccSample(raw, Boolean(this.avcC));
    this.samples.push({
      data,
      timestampUs: Math.max(0, Number(chunk.timestamp) || 0),
      durationUs: Math.max(0, Number(chunk.duration) || 0),
      isKey: chunk.type === 'key',
    });
    this.totalMdatBytes += data.byteLength;
  }

  finalize() {
    const n = this.samples.length;
    if (!n) return new Uint8Array(0);

    const defLvl = this.fps >= 45 ? 0x2a : 0x28;
    const avcCBytes = this.avcC || new Uint8Array([1, 0x42, 0xc0, defLvl, 0xff, 0xe1, 0, 0, 1, 0, 0]);
    const ts = this.timescale;

    // Convertir timestamps en microsegundos a ticks de 90kHz y detectar reordenamiento (B-frames)
    const rawPts = new Array(n);
    let minPts = Infinity;
    let hasReordered = false;
    for (let i = 0; i < n; i++) {
      const t = Math.round((this.samples[i].timestampUs * ts) / 1_000_000);
      rawPts[i] = t;
      if (t < minPts) minPts = t;
      if (i > 0 && t < rawPts[i - 1]) hasReordered = true;
    }
    if (minPts > 0 && Number.isFinite(minPts)) {
      for (let i = 0; i < n; i++) rawPts[i] -= minPts;
    }

    const dts = new Array(n);
    let ctts = null;
    let cttsShift = 0;
    if (!hasReordered) {
      for (let i = 0; i < n; i++) {
        let t = rawPts[i];
        if (i > 0 && t <= dts[i - 1]) t = dts[i - 1] + 1;
        dts[i] = t;
      }
    } else {
      const sortedPts = rawPts.slice().sort((a, b) => a - b);
      for (let i = 0; i < n; i++) {
        let t = sortedPts[i];
        if (i > 0 && t <= dts[i - 1]) t = dts[i - 1] + 1;
        dts[i] = t;
      }
      let minOffset = 0;
      const ctsOffsets = new Array(n);
      for (let i = 0; i < n; i++) {
        const off = rawPts[i] - dts[i];
        ctsOffsets[i] = off;
        if (off < minOffset) minOffset = off;
      }
      const shift = minOffset < 0 ? -minOffset : 0;
      cttsShift = shift;
      const cttsRuns = [];
      for (let i = 0; i < n; i++) {
        const off = ctsOffsets[i] + shift;
        if (cttsRuns.length && cttsRuns[cttsRuns.length - 1].offset === off) {
          cttsRuns[cttsRuns.length - 1].count++;
        } else {
          cttsRuns.push({ count: 1, offset: off });
        }
      }
      const cttsBuf = new Uint8Array(4 + cttsRuns.length * 8);
      const cttsDv = new DataView(cttsBuf.buffer);
      cttsDv.setUint32(0, cttsRuns.length, false);
      for (let i = 0; i < cttsRuns.length; i++) {
        cttsDv.setUint32(4 + i * 8, cttsRuns[i].count, false);
        cttsDv.setUint32(8 + i * 8, cttsRuns[i].offset, false);
      }
      ctts = mp4FullBox('ctts', 0, 0, cttsBuf);
    }

    const deltas = new Array(n);
    const defaultDelta = Math.max(1, Math.round(ts / this.fps));
    let totalDuration = 0;
    for (let i = 0; i < n - 1; i++) {
      deltas[i] = Math.max(1, dts[i + 1] - dts[i]);
      totalDuration += deltas[i];
    }
    const lastDurTicks = this.samples[n - 1].durationUs > 0
      ? Math.max(1, Math.round((this.samples[n - 1].durationUs * ts) / 1_000_000))
      : 0;
    deltas[n - 1] = lastDurTicks > 0
      ? lastDurTicks
      : (n > 1 ? Math.max(1, Math.round(totalDuration / (n - 1))) : defaultDelta);
    totalDuration += deltas[n - 1];

    // Compresión RLE para stts
    const sttsRuns = [];
    for (let i = 0; i < n; i++) {
      const d = deltas[i];
      if (sttsRuns.length && sttsRuns[sttsRuns.length - 1].delta === d) {
        sttsRuns[sttsRuns.length - 1].count++;
      } else {
        sttsRuns.push({ count: 1, delta: d });
      }
    }
    const sttsBuf = new Uint8Array(4 + sttsRuns.length * 8);
    const sttsDv = new DataView(sttsBuf.buffer);
    sttsDv.setUint32(0, sttsRuns.length, false);
    for (let i = 0; i < sttsRuns.length; i++) {
      sttsDv.setUint32(4 + i * 8, sttsRuns[i].count, false);
      sttsDv.setUint32(8 + i * 8, sttsRuns[i].delta, false);
    }

    // Keyframes para stss
    const syncIndices = [];
    for (let i = 0; i < n; i++) {
      if (this.samples[i].isKey) syncIndices.push(i + 1);
    }
    const stssBuf = new Uint8Array(4 + syncIndices.length * 4);
    const stssDv = new DataView(stssBuf.buffer);
    stssDv.setUint32(0, syncIndices.length, false);
    for (let i = 0; i < syncIndices.length; i++) {
      stssDv.setUint32(4 + i * 4, syncIndices[i], false);
    }

    // stsz
    const stszBuf = new Uint8Array(8 + n * 4);
    const stszDv = new DataView(stszBuf.buffer);
    stszDv.setUint32(0, 0, false); // sample_size variable
    stszDv.setUint32(4, n, false);
    for (let i = 0; i < n; i++) {
      stszDv.setUint32(8 + i * 4, this.samples[i].data.byteLength, false);
    }

    // stsc: 1 sample por chunk para máxima compatibilidad en reproductores móviles/escritorio
    const stscBuf = concatBytes([u32(1), u32(1), u32(1), u32(1)]);

    // avc1 visual sample entry
    const compressorName = new Uint8Array(32);
    const label = 'Made3D Video';
    compressorName[0] = label.length;
    for (let i = 0; i < label.length; i++) compressorName[1 + i] = label.charCodeAt(i);

    const avc1Box = mp4Box(
      'avc1',
      new Uint8Array(6),
      u16(1), // data_reference_index
      new Uint8Array(16),
      u16(this.width),
      u16(this.height),
      u32(0x00480000),
      u32(0x00480000),
      u32(0),
      u16(1),
      compressorName,
      u16(24),
      u16(0xffff),
      mp4Box('avcC', avcCBytes)
    );

    const stsd = mp4FullBox('stsd', 0, 0, u32(1), avc1Box);
    const stts = mp4FullBox('stts', 0, 0, sttsBuf);
    const stss = syncIndices.length ? mp4FullBox('stss', 0, 0, stssBuf) : null;
    const stsc = mp4FullBox('stsc', 0, 0, stscBuf);
    const stsz = mp4FullBox('stsz', 0, 0, stszBuf);

    const ftyp = mp4Box(
      'ftyp',
      ASCII('isom'),
      u32(0x200),
      ASCII('isom'),
      ASCII('iso2'),
      ASCII('avc1'),
      ASCII('mp41')
    );

    const buildMoov = (chunkOffsets) => {
      const stcoBuf = new Uint8Array(4 + n * 4);
      const stcoDv = new DataView(stcoBuf.buffer);
      stcoDv.setUint32(0, n, false);
      for (let i = 0; i < n; i++) stcoDv.setUint32(4 + i * 4, chunkOffsets[i], false);
      const stco = mp4FullBox('stco', 0, 0, stcoBuf);

      const stblParts = [stsd, stts];
      if (stss) stblParts.push(stss);
      if (ctts) stblParts.push(ctts);
      stblParts.push(stsc, stsz, stco);
      const stbl = mp4Box('stbl', ...stblParts);

      const urlBox = mp4FullBox('url ', 0, 1);
      const dref = mp4FullBox('dref', 0, 0, u32(1), urlBox);
      const dinf = mp4Box('dinf', dref);
      const vmhd = mp4FullBox('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0));
      const minf = mp4Box('minf', vmhd, dinf, stbl);

      const mdhd = mp4FullBox(
        'mdhd',
        0,
        0,
        u32(0),
        u32(0),
        u32(ts),
        u32(totalDuration),
        u16(0x55c4), // 'und'
        u16(0)
      );
      const hdlr = mp4FullBox(
        'hdlr',
        0,
        0,
        u32(0),
        ASCII('vide'),
        new Uint8Array(12),
        ASCII('VideoHandler\0')
      );
      const mdia = mp4Box('mdia', mdhd, hdlr, minf);

      const tkhd = mp4FullBox(
        'tkhd',
        0,
        3, // track_enabled | track_in_movie
        u32(0),
        u32(0),
        u32(1),
        u32(0),
        u32(totalDuration),
        new Uint8Array(8),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        IDENTITY_MATRIX,
        u32((this.width << 16) >>> 0),
        u32((this.height << 16) >>> 0)
      );
      const edts = cttsShift > 0
        ? mp4Box(
            'edts',
            mp4FullBox(
              'elst',
              0,
              0,
              u32(1),
              u32(totalDuration),
              u32(cttsShift),
              u16(1),
              u16(0)
            )
          )
        : null;
      const trak = edts ? mp4Box('trak', tkhd, edts, mdia) : mp4Box('trak', tkhd, mdia);

      const mvhd = mp4FullBox(
        'mvhd',
        0,
        0,
        u32(0),
        u32(0),
        u32(ts),
        u32(totalDuration),
        u32(0x00010000),
        u16(0x0100),
        new Uint8Array(10),
        IDENTITY_MATRIX,
        new Uint8Array(24),
        u32(2)
      );

      return mp4Box('moov', mvhd, trak);
    };

    // Calcular tamaño fijo de moov para emitir MP4 faststart (ftyp -> moov -> mdat)
    const dummyOffsets = new Array(n).fill(0);
    const probeMoov = buildMoov(dummyOffsets);
    const mdatDataStart = ftyp.byteLength + probeMoov.byteLength + 8;

    const realOffsets = new Array(n);
    let cur = mdatDataStart;
    for (let i = 0; i < n; i++) {
      realOffsets[i] = cur;
      cur += this.samples[i].data.byteLength;
    }
    const moov = buildMoov(realOffsets);

    const mdat = new Uint8Array(8 + this.totalMdatBytes);
    const mdatSz = mdat.byteLength;
    mdat[0] = (mdatSz >>> 24) & 0xff;
    mdat[1] = (mdatSz >>> 16) & 0xff;
    mdat[2] = (mdatSz >>> 8) & 0xff;
    mdat[3] = mdatSz & 0xff;
    mdat[4] = 0x6d; // 'm'
    mdat[5] = 0x64; // 'd'
    mdat[6] = 0x61; // 'a'
    mdat[7] = 0x74; // 't'
    let mOff = 8;
    for (let i = 0; i < n; i++) {
      const s = this.samples[i].data;
      mdat.set(s, mOff);
      mOff += s.byteLength;
    }

    return concatBytes([ftyp, moov, mdat]);
  }
}

// ───────── WebM EBML Muxer (VP8 / VP9) ─────────

function ebmlVint(val) {
  let len = 1;
  while (len <= 8) {
    const maxVal = Math.pow(2, 7 * len) - 2;
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

function ebmlElem(idBytes, dataBytes) {
  const size = ebmlVint(dataBytes.byteLength);
  return concatBytes([new Uint8Array(idBytes), size, dataBytes]);
}

function ebmlUint(idBytes, val) {
  const bytes = [];
  let v = Math.max(0, Math.floor(val));
  do {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  } while (v > 0);
  return ebmlElem(idBytes, new Uint8Array(bytes));
}

function ebmlFloat64(idBytes, val) {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setFloat64(0, val, false);
  return ebmlElem(idBytes, buf);
}

function ebmlStr(idBytes, str) {
  return ebmlElem(idBytes, ASCII(str));
}

/**
 * Muxador EBML WebM para video VP8/VP9 proveniente de WebCodecs VideoEncoder.
 */
export class WebMMuxer {
  constructor({ width, height, fps = 30, codec = 'V_VP8' }) {
    this.width = width;
    this.height = height;
    this.fps = Math.max(1, fps || 30);
    this.codec = codec;
    this.chunks = [];
    this._firstTsUs = null;
  }

  addVideoChunk(chunk) {
    if (!chunk || !chunk.byteLength) return;
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    const rawTsUs = Math.max(0, Number(chunk.timestamp) || 0);
    if (this._firstTsUs === null) this._firstTsUs = rawTsUs;
    const normTsUs = Math.max(0, rawTsUs - this._firstTsUs);
    const rawTsMs = Math.max(0, Math.round(normTsUs / 1000));
    const prev = this.chunks.length ? this.chunks[this.chunks.length - 1] : null;
    const tsUs = prev ? Math.max(prev.tsUs, normTsUs) : normTsUs;
    const tsMs = prev ? Math.max(prev.tsMs, rawTsMs) : rawTsMs;
    this.chunks.push({
      data,
      tsUs,
      tsMs,
      durationUs: Math.max(0, Number(chunk.duration) || 0),
      isKey: chunk.type === 'key',
    });
  }

  finalize() {
    const n = this.chunks.length;
    if (!n) return new Uint8Array(0);

    const last = this.chunks[n - 1];
    const lastDurUs = last.durationUs > 0
      ? last.durationUs
      : (n > 1
          ? Math.max(1_000_000 / this.fps, last.tsUs / (n - 1))
          : 1_000_000 / this.fps);
    const durationMs = Math.max(1, Math.round((last.tsUs + lastDurUs) / 1000));
    const defaultDurationNs = Math.max(1, Math.round(1_000_000_000 / this.fps));

    const ebmlHeader = ebmlElem(
      [0x1a, 0x45, 0xdf, 0xa3],
      concatBytes([
        ebmlUint([0x42, 0x86], 1),
        ebmlUint([0x42, 0xf7], 1),
        ebmlUint([0x42, 0xf2], 4),
        ebmlUint([0x42, 0xf3], 8),
        ebmlStr([0x42, 0x82], 'webm'),
        ebmlUint([0x42, 0x87], 4),
        ebmlUint([0x42, 0x85], 2),
      ])
    );

    const info = ebmlElem(
      [0x15, 0x49, 0xa9, 0x66],
      concatBytes([
        ebmlUint([0x2a, 0xd7, 0xb1], 1_000_000),
        ebmlStr([0x4d, 0x80], 'Made3D'),
        ebmlStr([0x57, 0x41], 'Made3D WebMMuxer'),
        ebmlFloat64([0x44, 0x89], durationMs),
      ])
    );

    const videoElem = ebmlElem(
      [0xe0],
      concatBytes([
        ebmlUint([0xb0], this.width),
        ebmlUint([0xba], this.height),
      ])
    );

    const trackEntry = ebmlElem(
      [0xae],
      concatBytes([
        ebmlUint([0xd7], 1),
        ebmlUint([0x73, 0xc5], 1),
        ebmlUint([0x83], 1),
        ebmlUint([0x9c], 0),
        ebmlUint([0x23, 0xe3, 0x83], defaultDurationNs),
        ebmlStr([0x86], this.codec),
        videoElem,
      ])
    );

    const tracks = ebmlElem([0x16, 0x54, 0xae, 0x6b], trackEntry);

    // Agrupar en Clusters (nuevo cluster en keyframes o cada 4000 ms)
    const clusterElems = [];
    let clusterStartMs = 0;
    let clusterParts = [];

    const flushCluster = () => {
      if (!clusterParts.length) return;
      clusterElems.push(ebmlElem([0x1f, 0x43, 0xb6, 0x75], concatBytes(clusterParts)));
      clusterParts = [];
    };

    for (let i = 0; i < n; i++) {
      const c = this.chunks[i];
      const rel = c.tsMs - clusterStartMs;
      if (!clusterParts.length || (c.isKey && rel >= 500) || rel > 4000 || rel < 0) {
        flushCluster();
        clusterStartMs = c.tsMs;
        clusterParts.push(ebmlUint([0xe7], clusterStartMs));
      }
      const relTime = Math.max(-32768, Math.min(32767, c.tsMs - clusterStartMs));
      const blockHeader = concatBytes([
        new Uint8Array([0x81]), // track 1 VINT
        i16(relTime),
        new Uint8Array([c.isKey ? 0x80 : 0x00]),
      ]);
      clusterParts.push(ebmlElem([0xa3], concatBytes([blockHeader, c.data])));
    }
    flushCluster();

    const segmentPayload = concatBytes([info, tracks, ...clusterElems]);
    const segment = ebmlElem([0x18, 0x53, 0x80, 0x67], segmentPayload);

    return concatBytes([ebmlHeader, segment]);
  }
}

export { concatBytes, u64 };
