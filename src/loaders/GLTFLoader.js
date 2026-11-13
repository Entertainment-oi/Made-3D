import { Object3D } from '../core/Object3D.js';
import { Mesh } from '../objects/Mesh.js';
import { Geometry } from '../geometry/Geometry.js';
import { StandardMaterial, BasicMaterial } from '../materials/BuiltinMaterials.js';
import { Texture } from '../textures/Texture.js';
import { Mat4 } from '../math/Mat4.js';
import { Vec3 } from '../math/Vec3.js';
import { Bone } from '../objects/Bone.js';
import { Skeleton } from '../objects/Skeleton.js';
import { SkinnedMesh } from '../objects/SkinnedMesh.js';
import { AnimationClip, VectorKeyframeTrack, QuaternionKeyframeTrack } from '../animation/AnimationClip.js';
import { computeBounds as computeExactBounds, autoScaleObject } from '../core/autoScale.js';

const GLB_MAGIC = 0x46546c67, CHUNK_JSON = 0x4e4f534a, CHUNK_BIN = 0x004e4942;
const COMPONENT = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const NUM = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const WRAP = { 33071: 'clamp', 33648: 'mirror', 10497: 'repeat' };
const SUPPORTED = ['KHR_materials_emissive_strength', 'KHR_materials_unlit', 'EXT_texture_webp', 'KHR_texture_transform'];
const PROP = { translation: 'position', rotation: 'quaternion', scale: 'scale' };

// Los colores de glTF son lineales; el motor guarda los colores en sRGB (y los pasa a lineal al dibujar).
const srgb = (c) => { c = Math.min(1, Math.max(0, c)); return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; };

/**
 * Importador de glTF 2.0 / GLB.
 *   const gltf = await new GLTFLoader().load('modelo.glb');
 *   scene.add(gltf.scene);
 *   const mixer = new AnimationMixer(gltf.scene);
 *   mixer.clipAction(gltf.animations[0]).play();
 *
 * Soporta: jerarquía de nodos, mallas (triángulos, strips y fans), materiales (color, textura de color,
 * emisivo, alphaMode OPAQUE/MASK/BLEND, doubleSided, KHR_materials_unlit, KHR_materials_emissive_strength,
 * KHR_texture_transform sin rotación), colores por vértice, esqueletos (hasta 4 influencias por vértice,
 * deformados en la GPU) y animaciones de nodos (traslación, rotación y escala; LINEAR, STEP y CUBICSPLINE).
 * Buffers e imágenes embebidos (data URI), externos o dentro del .glb.
 *
 * Los materiales PBR se aproximan con `StandardMaterial` (luz difusa + brillo según la rugosidad).
 * Todavía sin: mapas de normales/rugosidad/oclusión/emisivo, morph targets, cámaras y luces,
 * compresión Draco/Meshopt/KTX2 y accessors dispersos (sparse). Lo que falte se avisa por consola.
 *
 * Los nodos se renombran con nombres únicos y sin '.' ni '/' (el nombre original queda en
 * `userData.gltfName`): así los clips se pueden usar también en copias del modelo (cloneSkinned).
 */
export class GLTFLoader {
  constructor(opts = {}) {
    this.autoScale = typeof opts.autoScale === 'object' ? opts.autoScale.enabled !== false : !!opts.autoScale;
    this.autoScaleOptions = {
      ...(typeof opts.autoScale === 'object' && opts.autoScale ? opts.autoScale : {}),
      ...(opts.autoScaleOptions || {}),
      ...(opts.scene ? { scene: opts.scene } : {}),
      ...(opts.targetSize !== undefined ? { targetSize: opts.targetSize } : {}),
    };
  }

  // URL -> gltf (segundo argumento admite callback onProgress o un objeto de opciones)
  async load(url, onProgressOrOpts) {
    const opts = typeof onProgressOrOpts === 'object' && onProgressOrOpts ? onProgressOrOpts : {};
    const onProgress = typeof onProgressOrOpts === 'function' ? onProgressOrOpts : opts.onProgress;
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

  // File/Blob (selector de archivos). Para .gltf con archivos externos pasa los demás en `extraFiles`.
  async loadFile(file, extraFiles = [], opts = {}) {
    const resources = {};
    for (const f of [file, ...extraFiles]) resources[f.name] = f;
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
    const result = await new GLTFParser(json, glbBin, basePath, resources).build();
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
  constructor(json, glbBin, basePath, resources) {
    this.json = json; this.glbBin = glbBin; this.base = basePath; this.resources = resources;
    this.cache = { buffers: {}, images: {}, textures: {}, materials: {}, geometries: {} };
    this.warned = new Set();
  }
  warn(msg) { if (!this.warned.has(msg)) { this.warned.add(msg); console.warn('GLTFLoader: ' + msg); } }

  // ---------- recursos ----------
  async fetchUri(uri) {
    if (/^data:/.test(uri)) return (await fetch(uri)).arrayBuffer();
    const name = decodeURIComponent(uri);
    if (this.resources) {
      const f = this.resources[name] || this.resources[name.split('/').pop()];
      if (f) return f.arrayBuffer();
    }
    const res = await fetch(/^(https?:|blob:)/.test(uri) ? uri : this.base + uri);
    if (!res.ok) throw new Error(`GLTFLoader: falta el archivo "${uri}" (${res.status}). Si cargas un .gltf desde el selector, elige también sus .bin e imágenes.`);
    return res.arrayBuffer();
  }
  buffer(i) {
    return (this.cache.buffers[i] ||= (async () => {
      const b = this.json.buffers[i];
      if (b.uri === undefined) { if (!this.glbBin) throw new Error('GLTFLoader: buffer sin datos.'); return this.glbBin; }
      return this.fetchUri(b.uri);
    })());
  }
  async bufferViewBytes(i) {
    const bv = this.json.bufferViews[i], buf = await this.buffer(bv.buffer);
    return buf.slice(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
  }

  // Lee un accessor a un TypedArray propio (resuelve stride/offset). { array, itemSize, count, componentType, normalized }
  async accessor(i) {
    const a = this.json.accessors[i], T = COMPONENT[a.componentType], n = NUM[a.type];
    const out = new T(a.count * n);
    if (a.bufferView !== undefined) {
      const bv = this.json.bufferViews[a.bufferView], buf = await this.buffer(bv.buffer);
      const offset = (bv.byteOffset || 0) + (a.byteOffset || 0), elem = n * T.BYTES_PER_ELEMENT, stride = bv.byteStride || elem;
      if (stride === elem) new Uint8Array(out.buffer).set(new Uint8Array(buf, offset, a.count * elem));
      else {
        const src = new Uint8Array(buf), dst = new Uint8Array(out.buffer);
        for (let k = 0; k < a.count; k++) dst.set(src.subarray(offset + k * stride, offset + k * stride + elem), k * elem);
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
    if (info.texCoord) this.warn('solo se usa el juego de UV 0 (TEXCOORD_0).');
    const tt = info.extensions && info.extensions.KHR_texture_transform;
    const base = await this.baseTexture(info.index, colorSpace);
    if (!base || !tt) return base;
    if (tt.rotation) this.warn('KHR_texture_transform: la rotación no está soportada (se usa solo desplazamiento y escala).');
    const key = info.index + '|' + colorSpace + '|' + JSON.stringify(tt);   // misma imagen con otra transformación = copia ligera
    return (this.cache.textures[key] ||= (() => {
      const t = base.clone();
      if (tt.offset) t.offset.set(tt.offset[0], tt.offset[1]);
      if (tt.scale) t.repeat.set(tt.scale[0], tt.scale[1]);
      return t;
    })());
  }
  baseTexture(index, colorSpace) {
    const key = index + ':' + colorSpace;
    return (this.cache.textures[key] ||= (async () => {
      const t = this.json.textures[index];
      const ext = t.extensions || {};
      const src = t.source ?? (ext.EXT_texture_webp && ext.EXT_texture_webp.source);
      if (src === undefined) { this.warn(ext.KHR_texture_basisu ? 'texturas KTX2 (KHR_texture_basisu) no soportadas todavía.' : 'textura sin imagen soportada.'); return null; }
      const s = t.sampler !== undefined ? this.json.samplers[t.sampler] : {};
      const mipmapMin = s.minFilter === undefined || ![9728, 9729].includes(s.minFilter);
      const tex = new Texture(await this.image(src), {
        flipY: false,                       // glTF: el origen de la imagen es arriba-izquierda
        colorSpace,
        wrapS: WRAP[s.wrapS] || 'repeat', wrapT: WRAP[s.wrapT] || 'repeat',
        magFilter: s.magFilter === 9728 ? 'nearest' : 'linear',
        minFilter: s.minFilter === 9728 ? 'nearest' : s.minFilter === 9729 ? 'linear' : mipmapMin ? 'linear-mipmap' : 'linear',
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
      const m = unlit ? new BasicMaterial() : new StandardMaterial();
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
        // PBR → Blinn-Phong: sin entorno, lo que se nota de la rugosidad es el brillo de las luces
        const rough = p.roughnessFactor ?? 1;
        if (rough < 0.95) { m.shininess = Math.round((1 - rough) * (1 - rough) * 90) + 4; m.specular = 0.6; }
        const e = d.emissiveFactor || [0, 0, 0], k = ext.KHR_materials_emissive_strength ? ext.KHR_materials_emissive_strength.emissiveStrength ?? 1 : 1;
        m.emissive.set(srgb(e[0] * k), srgb(e[1] * k), srgb(e[2] * k));
        if (d.emissiveTexture) this.warn('emissiveTexture no soportada todavía (se usa solo emissiveFactor).');
      }
      if (d.normalTexture) this.warn('normalTexture (mapas de normales) no soportada todavía.');
      if (p.metallicRoughnessTexture) this.warn('metallicRoughnessTexture no soportada todavía.');
      if (d.occlusionTexture) this.warn('occlusionTexture no soportada todavía.');
      return m;
    })());
  }

  // ---------- geometría ----------
  async primitive(meshIdx, primIdx) {
    const key = meshIdx + ':' + primIdx;
    return (this.cache.geometries[key] ||= (async () => {
      const prim = this.json.meshes[meshIdx].primitives[primIdx], at = prim.attributes;
      if (prim.extensions && (prim.extensions.KHR_draco_mesh_compression || prim.extensions.EXT_meshopt_compression)) { this.warn('malla comprimida (Draco/Meshopt) no soportada todavía.'); return null; }
      const mode = prim.mode ?? 4;
      if (![4, 5, 6].includes(mode)) { this.warn('solo se admiten triángulos (modo ' + mode + ' ignorado).'); return null; }
      if (at.POSITION === undefined) return null;
      const g = new Geometry();
      const pos = await this.accessor(at.POSITION);
      g.setAttribute('position', this.toFloat(pos), 3);
      if (at.NORMAL !== undefined) g.setAttribute('normal', this.toFloat(await this.accessor(at.NORMAL)), 3);
      if (at.TEXCOORD_0 !== undefined) g.setAttribute('uv', this.toFloat(await this.accessor(at.TEXCOORD_0)), 2);
      if (at.TEXCOORD_1 !== undefined) this.warn('solo se usa el juego de UV 0 (TEXCOORD_0).');
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
      for (const ch of a.channels) {
        const path = ch.target.path, node = nodes[ch.target.node], s = a.samplers[ch.sampler];
        if (!node || !PROP[path]) { if (path === 'weights') this.warn('animaciones de morph targets no soportadas.'); continue; }
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
      let ibm = null;
      if (sk.inverseBindMatrices !== undefined) {
        const arr = (await this.accessor(sk.inverseBindMatrices)).array;
        ibm = sk.joints.map((_, k) => { const m = new Mat4(); m.elements.set(arr.subarray(k * 16, k * 16 + 16)); return m; });
      }
      const s = new Skeleton(sk.joints.map((n) => nodes[n]), ibm); s.name = sk.name || '';
      skeletons.push(s);
    }
    // mallas
    for (const [i, d] of (j.nodes || []).entries()) {
      if (d.mesh === undefined) continue;
      const md = j.meshes[d.mesh];
      for (let p = 0; p < md.primitives.length; p++) {
        const geo = await this.primitive(d.mesh, p);
        if (!geo) continue;
        const mat = await this.material(md.primitives[p].material);
        if (geo.attributes.color) mat.vertexColors = true;
        const skinned = d.skin !== undefined && geo.attributes.skinIndex;
        const mesh = skinned ? new SkinnedMesh(geo, mat).bind(skeletons[d.skin]) : new Mesh(geo, mat);
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
