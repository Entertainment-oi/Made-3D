// Lector ZIP puro en JavaScript para descomprimir paquetes de modelos (.gltf/.bin/.obj/.mtl/texturas/.ktx2).

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

function decodeUtf8(bytes) {
  return new TextDecoder('utf-8').decode(bytes);
}

async function inflateRawBytes(compressedBytes) {
  if (typeof DecompressionStream === 'function') {
    const ds = new DecompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    const copy = compressedBytes.slice();
    writer.write(copy).catch(() => {});
    writer.close().catch(() => {});
    const res = new Response(ds.readable);
    return new Uint8Array(await res.arrayBuffer());
  }
  throw new Error('ZipLoader: este navegador no soporta DecompressionStream("deflate-raw").');
}

function findEOCD(dv, len) {
  const minOffset = Math.max(0, len - 65557);
  for (let off = len - 22; off >= minOffset; off--) {
    if (dv.getUint32(off, true) === SIG_EOCD) return off;
  }
  return -1;
}

function normalizeZipPath(p) {
  return p.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
}

function stripCommonRootFolder(entries) {
  const dirs = entries
    .map((e) => {
      const parts = e.path.split('/');
      return parts.length > 1 ? parts[0] : '';
    });
  if (!dirs.length || dirs.some((d) => !d)) return entries;
  const first = dirs[0];
  if (!dirs.every((d) => d === first)) return entries;
  const prefix = first + '/';
  return entries.map((e) => ({
    ...e,
    path: e.path.startsWith(prefix) ? e.path.slice(prefix.length) : e.path,
  }));
}

function makeVirtualFile(bytes, relPath) {
  const baseName = relPath.split('/').pop() || 'archivo';
  if (typeof File === 'function') {
    const f = new File([bytes], baseName);
    try {
      Object.defineProperty(f, 'relativePath', { value: relPath, configurable: true });
    } catch (_) {
      f.relativePath = relPath;
    }
    return f;
  }
  return {
    name: baseName,
    relativePath: relPath,
    size: bytes.byteLength,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
    async text() {
      return decodeUtf8(bytes);
    },
  };
}

function attachRelativePath(file, relPath) {
  if (!relPath) return file;
  try {
    Object.defineProperty(file, 'relativePath', { value: relPath, configurable: true });
  } catch (_) {
    file.relativePath = relPath;
  }
  return file;
}

function stripCommonDropRoot(files) {
  const dirs = files.map((f) => {
    const rp = String(f.relativePath || f.webkitRelativePath || '').replace(/^\/+/, '');
    const parts = rp.split('/');
    return parts.length > 1 ? parts[0] : '';
  });
  if (!dirs.length || dirs.some((d) => !d)) return files;
  const first = dirs[0];
  if (!dirs.every((d) => d === first)) return files;
  const prefix = first + '/';
  return files.map((f) => {
    const rp = String(f.relativePath || f.webkitRelativePath || '').replace(/^\/+/, '');
    return attachRelativePath(f, rp.startsWith(prefix) ? rp.slice(prefix.length) : rp);
  });
}

async function readEntryFiles(entry, out) {
  if (!entry) return;
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    const rel = String(entry.fullPath || file.name).replace(/^\/+/, '');
    if (!rel.startsWith('__MACOSX/') && !file.name.startsWith('.DS_Store')) {
      attachRelativePath(file, rel);
      out.push(file);
    }
    return;
  }
  if (entry.isDirectory) {
    const reader = entry.createReader();
    const readBatch = () => new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    for (;;) {
      const entries = await readBatch();
      if (!entries || !entries.length) break;
      for (const child of entries) {
        await readEntryFiles(child, out);
      }
    }
  }
}

export async function extractFilesFromDataTransfer(dataTransfer) {
  const items = dataTransfer && dataTransfer.items;
  if (items && items.length && typeof items[0].webkitGetAsEntry === 'function') {
    const collected = [];
    for (const item of items) {
      if (item.kind !== 'file') continue;
      const entry = item.webkitGetAsEntry();
      if (entry) await readEntryFiles(entry, collected);
    }
    if (collected.length) return stripCommonDropRoot(collected);
  }
  return Array.from((dataTransfer && dataTransfer.files) || []);
}

/**
 * Extrae todos los archivos de un `.zip` (ArrayBuffer, Uint8Array o File/Blob)
 * devolviendo un arreglo de `File` con `relativePath` normalizada.
 */
export class ZipLoader {
  static fromDataTransfer(dataTransfer) {
    return extractFilesFromDataTransfer(dataTransfer);
  }

  async load(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`ZipLoader: no se pudo cargar ${url} (${res.status})`);
    return this.parse(await res.arrayBuffer());
  }

  async loadFile(file) {
    return this.parse(await file.arrayBuffer());
  }

  async parse(data) {
    const bytes =
      data instanceof Uint8Array
        ? data
        : data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    const eocdOff = findEOCD(dv, bytes.byteLength);
    if (eocdOff < 0) throw new Error('ZipLoader: el archivo no es un ZIP válido.');

    const totalEntries = dv.getUint16(eocdOff + 10, true);
    const cdOffset = dv.getUint32(eocdOff + 16, true);
    if (cdOffset + 4 > bytes.byteLength) throw new Error('ZipLoader: directorio central ZIP corrupto.');

    const rawEntries = [];
    let ptr = cdOffset;
    for (let i = 0; i < totalEntries && ptr + 46 <= bytes.byteLength; i++) {
      if (dv.getUint32(ptr, true) !== SIG_CENTRAL) break;
      const flags = dv.getUint16(ptr + 8, true);
      const method = dv.getUint16(ptr + 10, true);
      const compSize = dv.getUint32(ptr + 20, true);
      const nameLen = dv.getUint16(ptr + 28, true);
      const extraLen = dv.getUint16(ptr + 30, true);
      const commentLen = dv.getUint16(ptr + 32, true);
      const localOff = dv.getUint32(ptr + 42, true);

      const nameBytes = bytes.subarray(ptr + 46, ptr + 46 + nameLen);
      const rawPath = normalizeZipPath(decodeUtf8(nameBytes));
      ptr += 46 + nameLen + extraLen + commentLen;

      if (!rawPath || rawPath.endsWith('/') || rawPath.startsWith('__MACOSX/')) continue;
      if (flags & 1) throw new Error(`ZipLoader: archivo cifrado no soportado (${rawPath}).`);

      if (localOff + 30 > bytes.byteLength || dv.getUint32(localOff, true) !== SIG_LOCAL) {
        throw new Error(`ZipLoader: cabecera local inválida en ${rawPath}.`);
      }
      const lNameLen = dv.getUint16(localOff + 26, true);
      const lExtraLen = dv.getUint16(localOff + 28, true);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      if (dataStart + compSize > bytes.byteLength) {
        throw new Error(`ZipLoader: datos truncados en ${rawPath}.`);
      }
      const compSlice = bytes.subarray(dataStart, dataStart + compSize);

      let outBytes;
      if (method === 0) {
        outBytes = compSlice.slice();
      } else if (method === 8) {
        outBytes = await inflateRawBytes(compSlice);
      } else {
        throw new Error(`ZipLoader: método de compresión ${method} no soportado (${rawPath}).`);
      }

      rawEntries.push({ path: rawPath, bytes: outBytes });
    }

    const normalized = stripCommonRootFolder(rawEntries);
    return normalized.map((e) => makeVirtualFile(e.bytes, e.path));
  }
}
