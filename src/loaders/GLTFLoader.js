import { Object3D } from '../core/Object3D.js';
import { Mesh } from '../objects/Mesh.js';
import { InstancedMesh } from '../objects/InstancedMesh.js';
import { Geometry } from '../geometry/Geometry.js';
import { StandardMaterial, BasicMaterial } from '../materials/BuiltinMaterials.js';
import { Texture } from '../textures/Texture.js';
import { Mat4 } from '../math/Mat4.js';
import { Vec3 } from '../math/Vec3.js';
import { Quat } from '../math/Quat.js';
import { Bone } from '../objects/Bone.js';
import { Skeleton } from '../objects/Skeleton.js';
import { SkinnedMesh } from '../objects/SkinnedMesh.js';
import { BufferAttribute } from '../geometry/BufferAttribute.js';
import {
  AnimationClip,
  VectorKeyframeTrack,
  QuaternionKeyframeTrack,
  NumberArrayKeyframeTrack,
} from '../animation/AnimationClip.js';
import { computeBounds as computeExactBounds, autoScaleObject } from '../core/autoScale.js';

const GLB_MAGIC = 0x46546c67, CHUNK_JSON = 0x4e4f534a, CHUNK_BIN = 0x004e4942;
const COMPONENT = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const NUM = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const WRAP = { 33071: 'clamp', 33648: 'mirror', 10497: 'repeat' };
const SUPPORTED = [
  'KHR_materials_emissive_strength',
  'KHR_materials_unlit',
  'EXT_texture_webp',
  'KHR_texture_transform',
  'KHR_texture_basisu',
  'KHR_draco_mesh_compression',
  'EXT_meshopt_compression',
  'EXT_mesh_gpu_instancing',
];
const PROP = { translation: 'position', rotation: 'quaternion', scale: 'scale' };

// Los colores de glTF son lineales; el motor guarda los colores en sRGB (y los pasa a lineal al dibujar).
const srgb = (c) => { c = Math.min(1, Math.max(0, c)); return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; };

function normalizePath(p) {
  const parts = String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').split('/');
  const out = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') { if (out.length) out.pop(); }
    else out.push(part);
  }
  return out.join('/');
}

function buildResourceIndex(files, mainFile = null) {
  const byPath = {};
  const byName = {};
  for (const f of files) {
    const rp = normalizePath(f.relativePath || f.webkitRelativePath || '');
    if (rp) byPath[rp] = f;
    if (f.name && !byName[f.name]) byName[f.name] = f;
  }
  const mainRel = mainFile ? normalizePath(mainFile.relativePath || mainFile.webkitRelativePath || '') : '';
  const slash = mainRel.lastIndexOf('/');
  const baseDir = slash >= 0 ? mainRel.slice(0, slash + 1) : '';
  return { byPath, byName, baseDir };
}

/**
 * Importador de glTF 2.0 / GLB completo para Made3D.
 * Soporta: jerarquía de nodos, mallas, instanciación GPU (`EXT_mesh_gpu_instancing`),
 * compresión Draco (`KHR_draco_mesh_compression`) y Meshopt (`EXT_meshopt_compression`),
 * texturas KTX2 (`KHR_texture_basisu`) y WebP (`EXT_texture_webp`),
 * mapas PBR (albedo, normalMap, emissiveMap, aoMap, metallicRoughnessMap),
 * transformaciones UV completas (`KHR_texture_transform` con rotación) y `TEXCOORD_1`,
 * esqueletos con GPU skinning, Morph Targets y animaciones (`translation`, `rotation`, `scale`, `weights`).
 */
export class GLTFLoader {
  constructor(opts = {}) {
    this.ktx2Loader = opts.ktx2Loader || null;
    this.dracoLoader = opts.dracoLoader || null;
    this.renderer = opts.renderer || null;
    this.autoScale = typeof opts.autoScale === 'object' ? opts.autoScale.enabled !== false : !!opts.autoScale;
    this.autoScaleOptions = {
      ...(typeof opts.autoScale === 'object' && opts.autoScale ? opts.autoScale : {}),
      ...(opts.autoScaleOptions || {}),
      ...(opts.scene ? { scene: opts.scene } : {}),
      ...(opts.targetSize !== undefined ? { targetSize: opts.targetSize } : {}),
    };
  }

  setKTX2Loader(loader) {
    this.ktx2Loader = loader || null;
    return this;
  }

  setDRACOLoader(loader) {
    this.dracoLoader = loader || null;
    return this;
  }

  // URL -> gltf (segundo argumento admite callback onProgress o un objeto de opciones)
  async load(url, onProgressOrOpts) {
    const opts = typeof onProgressOrOpts === 'object' && onProgressOrOpts ? onProgressOrOpts : {};
    const onProgress = typeof onProgressOrOpts === 'function' ? onProgressOrOpts : opts.onProgress;
    if (/\.zip(\?|#|$)/i.test(url)) {
      const { ZipLoader } = await import('./ZipLoader.js');
      const files = await new ZipLoader().load(url);
      const main = files.find((f) => /\.(glb|gltf)$/i.test(f.name));
      if (!main) throw new Error('GLTFLoader: el ZIP no contiene ningún archivo .glb o .gltf.');
      return this.loadFile(main, files.filter((f) => f !== main), opts);
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GLTFLoader: no se pudo cargar ${url} (${res.status})`);
    let buffer;
    if (onProgress && res.body && res.headers.get('content-length')) {
      const total = +res.headers.get('content-length'), reader = res.body.getReader(), chunks = []; let got = 0;
      for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); got += value.length; onProgress(got / total); }
      const all = new Uint8Array(got); let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
      buffer = all.buffer;
    } else buffer = await res.arrayBuffer();
    const base = url.includes('/') ? url.slice(0, url.lastIndexOf('/') + 1) : '';
    return this.parse(buffer, base, null, opts);
  }

  // Carga directa desde un archivo `.zip`
  async loadZip(fileOrBuffer, opts = {}) {
    const { ZipLoader } = await import('./ZipLoader.js');
    const zl = new ZipLoader();
    const files =
      fileOrBuffer instanceof ArrayBuffer || ArrayBuffer.isView(fileOrBuffer)
        ? await zl.parse(fileOrBuffer)
        : await zl.loadFile(fileOrBuffer);
    const main = files.find((f) => /\.(glb|gltf)$/i.test(f.name));
    if (!main) throw new Error('GLTFLoader: el ZIP no contiene ningún archivo .glb o .gltf.');
    return this.loadFile(main, files.filter((f) => f !== main), opts);
  }

  // File/Blob (selector de archivos). Para .gltf con archivos externos pasa los demás en `extraFiles`.
  async loadFile(file, extraFiles = [], opts = {}) {
    if (/\.zip$/i.test(file.name)) {
      return this.loadZip(file, opts);
    }
    const resources = buildResourceIndex([file, ...extraFiles], file);
    return this.parse(await file.arrayBuffer(), '', resources, opts);
  }

  // data: ArrayBuffer (glb o json en bytes) | string (json) | objeto json ya parseado
  async parse(data, basePath = '', resources = null, opts = {}) {
    let json, glbBin = null;
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      const buf = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      const dv = new DataView(buf);
      if (buf.byteLength >= 12 && dv.getUint32(0, true) === GLB_MAGIC) {
        const total = Math.min(dv.getUint32(8, true), buf.byteLength);
        let off = 12;
        while (off + 8 <= total) {
          const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true); off += 8;
          const safeLen = Math.min(len, Math.max(0, total - off));
          if (type === CHUNK_JSON) json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, off, safeLen)));
          else if (type === CHUNK_BIN && !glbBin) glbBin = buf.slice(off, off + safeLen);
          off += len + ((4 - (len % 4)) % 4);
        }
        if (!json) throw new Error('GLTFLoader: el GLB no contiene JSON.');
      } else json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf)));
    } else json = typeof data === 'string' ? JSON.parse(data) : data;

    if (!json.asset || String(json.asset.version).split('.')[0] !== '2') throw new Error('GLTFLoader: solo se admite glTF 2.0.');
    for (const e of json.extensionsRequired || []) if (!SUPPORTED.includes(e)) console.warn(`GLTFLoader: extensión requerida no soportada (${e}); el modelo puede verse mal o incompleto.`);
    const result = await new GLTFParser(
      json,
      glbBin,
      basePath,
      resources,
      opts.ktx2Loader || this.ktx2Loader,
      opts.dracoLoader || this.dracoLoader,
      opts.renderer || this.renderer
    ).build();
    const scaleOpt = opts.autoScale !== undefined ? opts.autoScale : this.autoScale;
    const scaleEnabled = typeof scaleOpt === 'object' ? scaleOpt.enabled !== false : !!scaleOpt;
    if (scaleEnabled) {
      const merged = {
        ...this.autoScaleOptions,
        ...(typeof scaleOpt === 'object' && scaleOpt ? scaleOpt : {}),
        ...opts,
      };
      result.autoScale = autoScaleObject(result.scene, merged);
      result.bounds = computeExactBounds(result.scene);
    }
    return result;
  }
}

class GLTFParser {
  constructor(json, glbBin, basePath, resources, ktx2Loader = null, dracoLoader = null, renderer = null) {
    this.json = json;
    this.glbBin = glbBin;
    this.base = basePath;
    this.resources = resources;
    this.ktx2Loader = ktx2Loader;
    this.dracoLoader = dracoLoader;
    this.renderer = renderer;
    this.cache = { buffers: {}, bufferViews: {}, images: {}, textures: {}, materials: {}, geometries: {} };
    this.warned = new Set();
  }

  async getKTX2Loader() {
    if (!this.ktx2Loader) {
      const { KTX2Loader } = await import('./KTX2Loader.js');
      const loader = new KTX2Loader();
      if (this.renderer) loader.detectSupport(this.renderer);
      this.ktx2Loader = loader;
    }
    return this.ktx2Loader;
  }

  async getDRACOLoader() {
    if (!this.dracoLoader) {
      const { DRACOLoader } = await import('./DRACOLoader.js');
      this.dracoLoader = new DRACOLoader();
    }
    return this.dracoLoader;
  }

  warn(msg) { if (!this.warned.has(msg)) { this.warned.add(msg); console.warn('GLTFLoader: ' + msg); } }

  // ---------- recursos ----------
  async fetchUri(uri) {
    if (/^data:/.test(uri)) return (await fetch(uri)).arrayBuffer();
    const decoded = decodeURIComponent(uri);
    if (this.resources) {
      const { byPath, byName, baseDir } = this.resources;
      const norm = normalizePath(decoded);
      const joined = baseDir ? normalizePath(baseDir + decoded) : norm;
      const f = byPath[joined] || byPath[norm] || byName[norm] || byName[norm.split('/').pop()];
      if (f) return f.arrayBuffer();
    }
    const res = await fetch(/^(https?:|blob:)/.test(uri) ? uri : this.base + uri);
    if (!res.ok) throw new Error(`GLTFLoader: falta el archivo "${uri}" (${res.status}). Si cargas un .gltf desde el selector, elige también sus .bin e imágenes (o comprímelo en .zip).`);
    return res.arrayBuffer();
  }

  buffer(i) {
    return (this.cache.buffers[i] ||= (async () => {
      const b = this.json.buffers[i];
      if (b.uri === undefined) { if (!this.glbBin) throw new Error('GLTFLoader: buffer sin datos.'); return this.glbBin; }
      return this.fetchUri(b.uri);
    })());
  }

  bufferViewBytes(i) {
    return (this.cache.bufferViews[i] ||= (async () => {
      const bv = this.json.bufferViews[i];
      const mc = bv.extensions && bv.extensions.EXT_meshopt_compression;
      if (mc) {
        const { MeshoptDecoder } = await import('../libs/meshopt/meshopt_decoder.module.js');
        await MeshoptDecoder.ready;
        const buf = await this.buffer(mc.buffer);
        const src = new Uint8Array(buf, mc.byteOffset || 0, mc.byteLength);
        const dst = new Uint8Array(mc.count * mc.byteStride);
        MeshoptDecoder.decodeGltfBuffer(dst, mc.count, mc.byteStride, src, mc.mode, mc.filter || 'NONE');
        return dst.buffer;
      }
      const buf = await this.buffer(bv.buffer);
      return buf.slice(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
    })());
  }

  // Lee un accessor a un TypedArray propio (resuelve stride/offset y Meshopt).
  async accessor(i) {
    const a = this.json.accessors[i], T = COMPONENT[a.componentType], n = NUM[a.type];
    const out = new T(a.count * n);
    if (a.bufferView !== undefined) {
      const bv = this.json.bufferViews[a.bufferView];
      const mc = bv.extensions && bv.extensions.EXT_meshopt_compression;
      const elem = n * T.BYTES_PER_ELEMENT;
      if (mc) {
        const decBuf = await this.bufferViewBytes(a.bufferView);
        const offset = a.byteOffset || 0;
        const stride = mc.byteStride || elem;
        if (stride === elem) {
          new Uint8Array(out.buffer).set(new Uint8Array(decBuf, offset, a.count * elem));
        } else {
          const src = new Uint8Array(decBuf), dst = new Uint8Array(out.buffer);
          for (let k = 0; k < a.count; k++) dst.set(src.subarray(offset + k * stride, offset + k * stride + elem), k * elem);
        }
      } else {
        const buf = await this.buffer(bv.buffer);
        const offset = (bv.byteOffset || 0) + (a.byteOffset || 0), stride = bv.byteStride || elem;
        if (stride === elem) new Uint8Array(out.buffer).set(new Uint8Array(buf, offset, a.count * elem));
        else {
          const src = new Uint8Array(buf), dst = new Uint8Array(out.buffer);
          for (let k = 0; k < a.count; k++) dst.set(src.subarray(offset + k * stride, offset + k * stride + elem), k * elem);
        }
      }
    }
    if (a.sparse) this.warn('accessors dispersos (sparse) no soportados; se ignoran sus cambios.');
    return { array: out, itemSize: n, count: a.count, componentType: a.componentType, normalized: !!a.normalized };
  }

  toFloat({ array, componentType, normalized }) {
    if (componentType === 5126) return array;
    const f = new Float32Array(array.length);
    const div = normalized ? { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535, 5125: 4294967295 }[componentType] : 1;
    const signed = componentType === 5120 || componentType === 5122;
    for (let k = 0; k < array.length; k++) f[k] = normalized && signed ? Math.max(array[k] / div, -1) : array[k] / div;
    return f;
  }

  // ---------- texturas ----------
  async image(i) {
    return (this.cache.images[i] ||= (async () => {
      const d = this.json.images[i];
      let blob;
      if (d.uri !== undefined) blob = new Blob([await this.fetchUri(d.uri)], { type: d.mimeType || mimeFromName(d.uri) });
      else blob = new Blob([await this.bufferViewBytes(d.bufferView)], { type: d.mimeType || 'image/png' });
      if (typeof createImageBitmap === 'function') {
        try { return await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }); }
        catch (_) { return createImageBitmap(blob); }
      }
      const url = URL.createObjectURL(blob), img = new Image();
      try {
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
      } finally {
        URL.revokeObjectURL(url);
      }
      return img;
    })());
  }

  async texture(info, colorSpace = 'srgb') {
    if (!info) return null;
    const baseTexCoord = info.texCoord ?? 0;
    const tt = info.extensions && info.extensions.KHR_texture_transform;
    const base = await this.baseTexture(info.index, colorSpace);
    if (!base) return null;
    const finalTexCoord = tt && tt.texCoord !== undefined ? tt.texCoord : baseTexCoord;
    if (!tt && finalTexCoord === base.texCoord) return base;
    if (finalTexCoord > 1) this.warn('solo se admiten TEXCOORD_0 y TEXCOORD_1.');

    const key = info.index + '|' + colorSpace + '|' + finalTexCoord + '|' + JSON.stringify(tt || null);
    return (this.cache.textures[key] ||= (() => {
      const t = base.clone();
      t.texCoord = finalTexCoord > 0 ? 1 : 0;
      if (tt) {
        if (tt.offset) t.offset.set(tt.offset[0], tt.offset[1]);
        if (tt.scale) t.repeat.set(tt.scale[0], tt.scale[1]);
        if (tt.rotation !== undefined) t.rotation = tt.rotation;
      }
      return t;
    })());
  }

  baseTexture(index, colorSpace) {
    const key = index + ':' + colorSpace;
    return (this.cache.textures[key] ||= (async () => {
      const t = this.json.textures[index];
      const ext = t.extensions || {};
      const basisu = ext.KHR_texture_basisu;
      const src = t.source ?? (ext.EXT_texture_webp && ext.EXT_texture_webp.source);
      const s = t.sampler !== undefined ? this.json.samplers[t.sampler] : {};
      const mipmapMin = s.minFilter === undefined || ![9728, 9729].includes(s.minFilter);
      const wrapS = WRAP[s.wrapS] || 'repeat';
      const wrapT = WRAP[s.wrapT] || 'repeat';
      const magFilter = s.magFilter === 9728 ? 'nearest' : 'linear';
      const minFilter = s.minFilter === 9728 ? 'nearest' : s.minFilter === 9729 ? 'linear' : mipmapMin ? 'linear-mipmap' : 'linear';

      if (src === undefined && basisu && basisu.source !== undefined) {
        const d = this.json.images[basisu.source];
        const bytes = d.uri !== undefined ? await this.fetchUri(d.uri) : await this.bufferViewBytes(d.bufferView);
        const ktx2 = await this.getKTX2Loader();
        const tex = await ktx2.parse(bytes, {
          colorSpace,
          wrapS,
          wrapT,
          magFilter,
          minFilter,
        });
        tex.name = t.name || d.name || '';
        return tex;
      }

      if (src === undefined) { this.warn('textura sin imagen soportada.'); return null; }
      const tex = new Texture(await this.image(src), {
        flipY: false,                       // glTF: el origen de la imagen es arriba-izquierda
        colorSpace,
        wrapS, wrapT, magFilter, minFilter,
      });
      tex.name = t.name || '';
      return tex;
    })());
  }

  // ---------- materiales ----------
  async material(i) {
    if (i === undefined) return (this.cache.defaultMat ||= new StandardMaterial({ color: 0xcccccc }));
    return (this.cache.materials[i] ||= (async () => {
      const d = this.json.materials[i], p = d.pbrMetallicRoughness || {}, ext = d.extensions || {};
      const unlit = !!ext.KHR_materials_unlit;
      const hasPbr = !!d.pbrMetallicRoughness;
      const m = unlit
        ? new BasicMaterial()
        : new StandardMaterial({
            roughness: p.roughnessFactor ?? 1,
            metalness: hasPbr ? (p.metallicFactor ?? 1) : 0,
          });
      m.name = d.name || '';
      const bc = p.baseColorFactor || [1, 1, 1, 1];
      m.color.set(srgb(bc[0]), srgb(bc[1]), srgb(bc[2]));
      const mode = d.alphaMode || 'OPAQUE';
      m.opacity = mode === 'OPAQUE' ? 1 : bc[3];
      m.map = await this.texture(p.baseColorTexture, 'srgb');
      if (mode === 'BLEND') m.transparent = true;                   // (no escribe profundidad)
      else if (mode === 'MASK') m.alphaTest = d.alphaCutoff ?? 0.5;
      m.side = d.doubleSided ? 'double' : 'front';

      if (!unlit) {
        const rough = p.roughnessFactor ?? 1;
        if (rough < 0.95) {
          if (!m.hasPbr) m.shininess = Math.round((1 - rough) * (1 - rough) * 90) + 4;
          m.specular = 0.6;
        }
        const e = d.emissiveFactor || [0, 0, 0], k = ext.KHR_materials_emissive_strength ? ext.KHR_materials_emissive_strength.emissiveStrength ?? 1 : 1;
        m.emissive.set(srgb(e[0] * k), srgb(e[1] * k), srgb(e[2] * k));

        if (d.normalTexture) {
          m.normalMap = await this.texture(d.normalTexture, 'linear');
          if (d.normalTexture.scale !== undefined) {
            m.normalScale.set(d.normalTexture.scale, d.normalTexture.scale);
          }
        }
        if (d.emissiveTexture) {
          m.emissiveMap = await this.texture(d.emissiveTexture, 'srgb');
        }
        if (p.metallicRoughnessTexture) {
          m.metallicRoughnessMap = await this.texture(p.metallicRoughnessTexture, 'linear');
        }
        if (d.occlusionTexture) {
          m.aoMap = await this.texture(d.occlusionTexture, 'linear');
          if (d.occlusionTexture.strength !== undefined) {
            m.aoMapIntensity = d.occlusionTexture.strength;
          }
        }
      }
      return m;
    })());
  }

  // ---------- geometría ----------
  async primitive(meshIdx, primIdx) {
    const key = meshIdx + ':' + primIdx;
    return (this.cache.geometries[key] ||= (async () => {
      const prim = this.json.meshes[meshIdx].primitives[primIdx], at = prim.attributes;
      const dracoExt = prim.extensions && prim.extensions.KHR_draco_mesh_compression;
      const mode = prim.mode ?? 4;
      if (![4, 5, 6].includes(mode)) { this.warn('solo se admiten triángulos (modo ' + mode + ' ignorado).'); return null; }

      let g;
      if (dracoExt) {
        const accessorsInfo = {};
        for (const attrName of Object.keys(dracoExt.attributes || {})) {
          if (at[attrName] !== undefined) accessorsInfo[attrName] = this.json.accessors[at[attrName]];
        }
        const rawDraco = await this.bufferViewBytes(dracoExt.bufferView);
        const draco = await this.getDRACOLoader();
        g = await draco.decodeGeometry(rawDraco, dracoExt.attributes, accessorsInfo);
        if (g.attributes.color) {
          const c = g.attributes.color;
          const f = c.array;
          for (let k = 0; k < f.length; k += c.itemSize) {
            f[k] = srgb(f[k]); f[k + 1] = srgb(f[k + 1]); f[k + 2] = srgb(f[k + 2]);
          }
          c.needsUpdate = true;
        }
      } else {
        if (at.POSITION === undefined) return null;
        g = new Geometry();
        const pos = await this.accessor(at.POSITION);
        g.setAttribute('position', this.toFloat(pos), 3);
        if (at.NORMAL !== undefined) g.setAttribute('normal', this.toFloat(await this.accessor(at.NORMAL)), 3);
        if (at.TEXCOORD_0 !== undefined) g.setAttribute('uv', this.toFloat(await this.accessor(at.TEXCOORD_0)), 2);
        if (at.TEXCOORD_1 !== undefined) g.setAttribute('uv1', this.toFloat(await this.accessor(at.TEXCOORD_1)), 2);
        if (at.COLOR_0 !== undefined) {
          const c = await this.accessor(at.COLOR_0), f = this.toFloat(c).slice();
          for (let k = 0; k < f.length; k += c.itemSize) { f[k] = srgb(f[k]); f[k + 1] = srgb(f[k + 1]); f[k + 2] = srgb(f[k + 2]); }
          g.setAttribute('color', f, c.itemSize);
        }
        if (at.JOINTS_0 !== undefined && at.WEIGHTS_0 !== undefined) {
          const j = await this.accessor(at.JOINTS_0), w = this.toFloat(await this.accessor(at.WEIGHTS_0)).slice();
          for (let k = 0; k < w.length; k += 4) {   // los pesos deben sumar 1
            const sum = w[k] + w[k + 1] + w[k + 2] + w[k + 3];
            if (sum > 0 && Math.abs(sum - 1) > 1e-4) { w[k] /= sum; w[k + 1] /= sum; w[k + 2] /= sum; w[k + 3] /= sum; }
          }
          g.setAttribute('skinIndex', Float32Array.from(j.array), 4); g.setAttribute('skinWeight', w, 4);
          if (at.JOINTS_1 !== undefined) this.warn('solo se usan 4 influencias de hueso por vértice.');
        }
        let idx = prim.indices !== undefined ? (await this.accessor(prim.indices)).array : null;
        if (mode !== 4) {
          const src = idx || Uint32Array.from({ length: pos.count }, (_, k) => k), t = [];
          if (mode === 5) for (let k = 0; k + 2 < src.length; k++) t.push(...(k % 2 ? [src[k + 1], src[k], src[k + 2]] : [src[k], src[k + 1], src[k + 2]]));
          else for (let k = 1; k + 1 < src.length; k++) t.push(src[0], src[k], src[k + 1]);
          idx = t;
        }
        if (idx) g.setIndex(idx);                    // sin índices se dibuja tal cual (3 vértices = 1 triángulo)
      }

      if (Array.isArray(prim.targets) && prim.targets.length > 0) {
        for (const t of prim.targets) {
          if (t.POSITION !== undefined) {
            const pArr = this.toFloat(await this.accessor(t.POSITION));
            g.morphAttributes.position.push(new BufferAttribute(pArr, 3));
          }
          if (t.NORMAL !== undefined) {
            const nArr = this.toFloat(await this.accessor(t.NORMAL));
            g.morphAttributes.normal.push(new BufferAttribute(nArr, 3));
          }
        }
      }

      if (!g.attributes.normal) g.computeNormals();  // glTF pide sombreado plano si no hay normales
      return g;
    })());
  }

  // ---------- nodos, esqueletos y animaciones ----------
  makeNodes() {
    const nodesDef = this.json.nodes || [], joints = new Set(), used = new Set();
    for (const sk of this.json.skins || []) for (const n of sk.joints) joints.add(n);
    const nodes = nodesDef.map((d, i) => {
      const obj = joints.has(i) ? new Bone() : new Object3D();
      const orig = d.name || 'node' + i;
      let name = orig.replace(/[./]/g, '_');          // el mixer parte los nombres de pista por '.' y '/'
      if (used.has(name)) name += '_' + i;            // nombres únicos: las animaciones se enlazan por nombre
      used.add(name); obj.name = name; obj.userData.gltfName = orig;
      if (d.matrix) { const m = new Mat4(); m.elements.set(d.matrix); m.decompose(obj.position, obj.quaternion, obj.scale); }
      else {
        if (d.translation) obj.position.set(...d.translation);
        if (d.rotation) obj.quaternion.set(...d.rotation);
        if (d.scale) obj.scale.set(...d.scale);
      }
      return obj;
    });
    nodesDef.forEach((d, i) => { for (const c of d.children || []) nodes[i].add(nodes[c]); });
    return nodes;
  }

  async animations(nodes) {
    const clips = [];
    for (const [ai, a] of (this.json.animations || []).entries()) {
      const clip = new AnimationClip(a.name || 'animacion' + ai);
      for (const ch of a.channels || []) {
        if (!ch || !ch.target || ch.target.node === undefined) continue;
        const path = ch.target.path, node = nodes[ch.target.node], s = a.samplers && a.samplers[ch.sampler];
        if (!node || !s) continue;
        if (path === 'weights') {
          const times = this.toFloat(await this.accessor(s.input));
          let values = this.toFloat(await this.accessor(s.output)), t = times, interp = 'linear';
          const nKeys = times.length || 1;
          const mult = s.interpolation === 'CUBICSPLINE' ? 3 : 1;
          const morphCount = Math.max(1, Math.round(values.length / (nKeys * mult)));
          if (s.interpolation === 'STEP') interp = 'step';
          else if (s.interpolation === 'CUBICSPLINE') ({ times: t, values } = bakeCubic(times, values, morphCount, false));

          const morphMeshes = node.children.filter((c) => c.isMesh && c.morphTargetInfluences?.length);
          if (morphMeshes.length) {
            for (const mm of morphMeshes) {
              const track = new NumberArrayKeyframeTrack(mm.name + '.morphTargetInfluences', t, values, morphCount, interp);
              track.target = mm;
              track.property = 'morphTargetInfluences';
              clip.addTrack(track);
            }
          } else {
            clip.addTrack(new NumberArrayKeyframeTrack(node.name + '.weights', t, values, morphCount, interp));
          }
          continue;
        }
        if (!PROP[path]) continue;
        const times = this.toFloat(await this.accessor(s.input));
        let values = this.toFloat(await this.accessor(s.output)), t = times, interp = 'linear';
        const size = path === 'rotation' ? 4 : 3;
        if (s.interpolation === 'STEP') interp = 'step';
        else if (s.interpolation === 'CUBICSPLINE') ({ times: t, values } = bakeCubic(times, values, size, path === 'rotation'));
        const prop = PROP[path], name = node.name + '.' + prop;
        clip.addTrack(path === 'rotation' ? new QuaternionKeyframeTrack(name, t, values, interp) : new VectorKeyframeTrack(name, t, values, interp));
      }
      clips.push(clip);
    }
    return clips;
  }

  async build() {
    const j = this.json, nodes = this.makeNodes();
    const scenes = (j.scenes || []).map((sd) => {
      const root = new Object3D(); root.name = sd.name || 'scene';
      for (const n of sd.nodes || []) root.add(nodes[n]);
      root.updateMatrixWorld();
      return root;
    });
    // esqueletos (necesitan la jerarquía ya armada)
    const skeletons = [];
    for (const sk of j.skins || []) {
      const rawJoints = sk.joints || [];
      const joints = [];
      const validIdx = [];
      for (let k = 0; k < rawJoints.length; k++) {
        const bone = nodes[rawJoints[k]];
        if (bone) {
          joints.push(bone);
          validIdx.push(k);
        }
      }
      let ibm = null;
      if (sk.inverseBindMatrices !== undefined && joints.length) {
        const arr = (await this.accessor(sk.inverseBindMatrices)).array;
        ibm = validIdx.map((k) => {
          const m = new Mat4();
          if ((k + 1) * 16 <= arr.length) m.elements.set(arr.subarray(k * 16, k * 16 + 16));
          return m;
        });
      }
      const s = new Skeleton(joints, ibm); s.name = sk.name || '';
      skeletons.push(s);
    }
    // mallas (incluye EXT_mesh_gpu_instancing y morph targets)
    for (const [i, d] of (j.nodes || []).entries()) {
      if (d.mesh === undefined) continue;
      const md = j.meshes[d.mesh];
      const instExt = d.extensions && d.extensions.EXT_mesh_gpu_instancing;
      let instData = null;
      if (instExt && instExt.attributes) {
        const ia = instExt.attributes;
        const tr = ia.TRANSLATION !== undefined ? await this.accessor(ia.TRANSLATION) : null;
        const ro = ia.ROTATION !== undefined ? await this.accessor(ia.ROTATION) : null;
        const sc = ia.SCALE !== undefined ? await this.accessor(ia.SCALE) : null;
        const count = tr ? tr.count : ro ? ro.count : sc ? sc.count : 0;
        if (count > 0) {
          instData = {
            count,
            t: tr ? this.toFloat(tr) : null,
            r: ro ? this.toFloat(ro) : null,
            s: sc ? this.toFloat(sc) : null,
          };
        }
      }

      for (let p = 0; p < md.primitives.length; p++) {
        const geo = await this.primitive(d.mesh, p);
        if (!geo) continue;
        const mat = await this.material(md.primitives[p].material);
        if (geo.attributes.color) mat.vertexColors = true;

        let mesh;
        if (instData) {
          mesh = new InstancedMesh(geo, mat, instData.count);
          const pos = new Vec3();
          const quat = new Quat();
          const scl = new Vec3(1, 1, 1);
          for (let k = 0; k < instData.count; k++) {
            if (instData.t) pos.set(instData.t[k * 3], instData.t[k * 3 + 1], instData.t[k * 3 + 2]);
            else pos.set(0, 0, 0);
            if (instData.r) quat.set(instData.r[k * 4], instData.r[k * 4 + 1], instData.r[k * 4 + 2], instData.r[k * 4 + 3]).normalize();
            else quat.set(0, 0, 0, 1);
            if (instData.s) scl.set(instData.s[k * 3], instData.s[k * 3 + 1], instData.s[k * 3 + 2]);
            else scl.set(1, 1, 1);
            mesh.setTransformAt(k, pos, quat, scl);
          }
          mesh.commit();
        } else {
          const skin = d.skin !== undefined ? skeletons[d.skin] : null;
          const skinned = !!(skin && skin.bones.length && geo.attributes.skinIndex && geo.attributes.skinWeight);
          mesh = skinned ? new SkinnedMesh(geo, mat).bind(skin) : new Mesh(geo, mat);
        }

        const morphCount = geo.morphAttributes.position ? geo.morphAttributes.position.length : 0;
        if (morphCount > 0) {
          const weights = d.weights || md.weights || [];
          mesh.morphTargetInfluences = Array.from({ length: morphCount }, (_, k) => weights[k] ?? 0);
          if (md.extras && Array.isArray(md.extras.targetNames)) {
            md.extras.targetNames.forEach((tn, k) => {
              if (k < morphCount) mesh.morphTargetDictionary[tn] = k;
            });
          }
        }

        mesh.name = (md.name || 'mesh' + d.mesh) + (md.primitives.length > 1 ? '_' + p : '');
        mesh.castShadow = true;
        nodes[i].add(mesh);
      }
    }
    const scene = scenes[j.scene ?? 0] || new Object3D();
    scene.updateMatrixWorld();
    return { scene, scenes, asset: j.asset, json: j, animations: await this.animations(nodes), skeletons, nodes, bounds: computeExactBounds(scene) };
  }
}

// CUBICSPLINE → keyframes lineales densos (el motor interpola en lineal, escalón o suave).
// Los valores vienen como [tangente de entrada, valor, tangente de salida] por keyframe.
function bakeCubic(times, values, size, quat, steps = 4) {
  const n = times.length, stride = size * 3;
  const outT = [], outV = [];
  const val = (k, part) => values.subarray(k * stride + part * size, k * stride + part * size + size);
  for (let k = 0; k < n; k++) {
    outT.push(times[k]); outV.push(...val(k, 1));
    if (k + 1 === n) break;
    const td = times[k + 1] - times[k], p0 = val(k, 1), m0 = val(k, 2), p1 = val(k + 1, 1), m1 = val(k + 1, 0);
    for (let s = 1; s < steps; s++) {
      const u = s / steps, u2 = u * u, u3 = u2 * u;
      const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
      const v = [];
      for (let c = 0; c < size; c++) v.push(h00 * p0[c] + h10 * td * m0[c] + h01 * p1[c] + h11 * td * m1[c]);
      if (quat) { const l = Math.hypot(...v) || 1; for (let c = 0; c < size; c++) v[c] /= l; }
      outT.push(times[k] + td * u); outV.push(...v);
    }
  }
  return { times: Float32Array.from(outT), values: Float32Array.from(outV) };
}

function mimeFromName(n) {
  n = n.toLowerCase();
  return n.endsWith('.jpg') || n.endsWith('.jpeg') ? 'image/jpeg' : n.endsWith('.webp') ? 'image/webp' : 'image/png';
}
