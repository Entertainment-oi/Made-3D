import { Mat4 } from '../math/Mat4.js';
import { Euler } from '../math/Euler.js';
import { Quat } from '../math/Quat.js';

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

const COMPONENT_FLOAT = 5126;
const COMPONENT_USHORT = 5123;
const COMPONENT_UINT = 5125;

const TARGET_ARRAY_BUFFER = 34962;
const TARGET_ELEMENT_ARRAY_BUFFER = 34963;

const WRAP = {
  clamp: 33071,
  mirror: 33648,
  repeat: 10497,
};

const s2l = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

function pad4(n) {
  return (n + 3) & ~3;
}

function bytesToBase64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  if (typeof btoa === 'function') return btoa(bin);
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  throw new Error('GLTFExporter: base64 no soportado en este entorno.');
}

async function imageToPngBytes(image, flipY) {
  if (typeof document === 'undefined') return null;
  const w = image.naturalWidth || image.videoWidth || image.width || 0;
  const h = image.naturalHeight || image.videoHeight || image.height || 0;
  if (!w || !h) return null;

  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d');
  if (!ctx) return null;

  try {
    if (flipY) {
      ctx.translate(0, h);
      ctx.scale(1, -1);
    }
    ctx.drawImage(image, 0, 0, w, h);

    const blob = await new Promise((resolve) => cv.toBlob(resolve, 'image/png'));
    if (!blob) return null;
    return new Uint8Array(await blob.arrayBuffer());
  } catch (_) {
    return null;
  }
}

async function rgbaMipToPngBytes(mip, flipY = false) {
  if (typeof document === 'undefined' || !mip || !mip.data || !mip.width || !mip.height) return null;
  const { width: w, height: h, data } = mip;
  if (data.length < w * h * 4) return null;

  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d');
  if (!ctx) return null;

  try {
    const clamped = new Uint8ClampedArray(w * h * 4);
    if (flipY) {
      const rowBytes = w * 4;
      for (let y = 0; y < h; y++) {
        const srcOff = (h - 1 - y) * rowBytes;
        clamped.set(data.subarray(srcOff, srcOff + rowBytes), y * rowBytes);
      }
    } else {
      clamped.set(data.subarray(0, w * h * 4));
    }
    ctx.putImageData(new ImageData(clamped, w, h), 0, 0);

    const blob = await new Promise((resolve) => cv.toBlob(resolve, 'image/png'));
    if (!blob) return null;
    return new Uint8Array(await blob.arrayBuffer());
  } catch (_) {
    return null;
  }
}

function isExportableNode(obj, onlyVisible) {
  if (!obj) return false;
  if (onlyVisible && !obj.visible) return false;
  if (obj.isExportable) return obj.isExportable();
  if (obj.exportable === false) return false;
  if (obj.userData && obj.userData.exportable === false) return false;
  return true;
}

function isNodeChainExportable(node, rootSet, onlyVisible) {
  let cur = node;
  while (cur) {
    if (rootSet.has(cur) && cur.isScene) return true;
    if (!isExportableNode(cur, onlyVisible)) return false;
    if (rootSet.has(cur)) return true;
    cur = cur.parent;
  }
  return false;
}

function approxRoughness(shininess) {
  if (!shininess || shininess <= 4) return 0.95;
  const t = Math.max(0, Math.min(1, Math.sqrt(Math.max(0, shininess - 4) / 90)));
  return Math.max(0.05, Math.min(0.95, 1 - t));
}

function encodeGLB(jsonObj, binBytes) {
  const jsonStr = JSON.stringify(jsonObj);
  const rawJson = new TextEncoder().encode(jsonStr);
  const jsonPadLen = pad4(rawJson.length);
  const binPadLen = binBytes.length ? pad4(binBytes.length) : 0;

  const totalLen = 12 + 8 + jsonPadLen + (binPadLen ? 8 + binPadLen : 0);
  const out = new ArrayBuffer(totalLen);
  const dv = new DataView(out);
  const u8 = new Uint8Array(out);

  dv.setUint32(0, GLB_MAGIC, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, totalLen, true);

  let off = 12;
  dv.setUint32(off, jsonPadLen, true);
  dv.setUint32(off + 4, CHUNK_JSON, true);
  u8.set(rawJson, off + 8);
  for (let i = rawJson.length; i < jsonPadLen; i++) u8[off + 8 + i] = 0x20;
  off += 8 + jsonPadLen;

  if (binPadLen) {
    dv.setUint32(off, binPadLen, true);
    dv.setUint32(off + 4, CHUNK_BIN, true);
    u8.set(binBytes, off + 8);
  }

  return out;
}

/**
 * Exportador de glTF 2.0 y GLB para Made3D.
 *
 *   const exporter = new GLTFExporter();
 *   const glb = await exporter.parse(scene, { binary: true });
 *   const gltf = await exporter.parse(scene, { binary: false });
 */
export class GLTFExporter {
  async parse(input, opts = {}) {
    const binary = opts.binary !== undefined ? !!opts.binary : true;
    const onlyVisible = opts.onlyVisible !== undefined ? !!opts.onlyVisible : true;
    const useDraco = Boolean(opts.draco);
    const dracoOpts = typeof opts.draco === 'object' && opts.draco ? opts.draco : {};
    const useOptimize = Boolean(opts.optimize);
    const optimizeOpts = typeof opts.optimize === 'object' && opts.optimize ? opts.optimize : {};
    const roots = Array.isArray(input) ? input : [input];
    const rootSet = new Set(roots.filter(Boolean));

    for (const r of roots) {
      if (r && r.updateWorldMatrix) r.updateWorldMatrix(true, true);
    }

    const json = {
      asset: { version: '2.0', generator: 'Made3D GLTFExporter' },
      scene: 0,
      scenes: [{ nodes: [] }],
      nodes: [],
      meshes: [],
      materials: [],
      textures: [],
      images: [],
      samplers: [],
      skins: [],
      animations: [],
      buffers: [],
      bufferViews: [],
      accessors: [],
    };

    const extensionsUsed = new Set();
    const extensionsRequired = new Set();
    const chunks = [];
    let byteLength = 0;

    const pushBytes = (typedOrU8) => {
      const u8 =
        typedOrU8 instanceof Uint8Array
          ? typedOrU8
          : new Uint8Array(typedOrU8.buffer, typedOrU8.byteOffset, typedOrU8.byteLength);
      const offset = pad4(byteLength);
      const pad = offset - byteLength;
      if (pad > 0) chunks.push(new Uint8Array(pad));
      chunks.push(u8);
      byteLength = offset + u8.byteLength;
      return { offset, length: u8.byteLength };
    };

    const addBufferView = (typedOrU8, target = null) => {
      const { offset, length } = pushBytes(typedOrU8);
      const bv = { buffer: 0, byteOffset: offset, byteLength: length };
      if (target) bv.target = target;
      const idx = json.bufferViews.length;
      json.bufferViews.push(bv);
      return idx;
    };

    const computeAccessorMinMax = (typed, itemSize, count) => {
      const min = new Array(itemSize).fill(Infinity);
      const max = new Array(itemSize).fill(-Infinity);
      for (let i = 0; i < count; i++) {
        for (let k = 0; k < itemSize; k++) {
          const v = typed[i * itemSize + k];
          if (v < min[k]) min[k] = v;
          if (v > max[k]) max[k] = v;
        }
      }
      return { min, max };
    };

    const addAccessor = (typed, type, componentType, target = null, computeMinMax = false) => {
      const bvIdx = addBufferView(typed, target);
      const itemSize = type === 'SCALAR' ? 1 : type === 'VEC2' ? 2 : type === 'VEC3' ? 3 : type === 'VEC4' ? 4 : 16;
      const count = typed.length / itemSize;
      const acc = {
        bufferView: bvIdx,
        componentType,
        count,
        type,
      };
      if (computeMinMax && count > 0) {
        const { min, max } = computeAccessorMinMax(typed, itemSize, count);
        acc.min = min;
        acc.max = max;
      }
      const idx = json.accessors.length;
      json.accessors.push(acc);
      return idx;
    };

    const addVirtualAccessor = (count, type, componentType, typedForMinMax = null) => {
      const itemSize = type === 'SCALAR' ? 1 : type === 'VEC2' ? 2 : type === 'VEC3' ? 3 : type === 'VEC4' ? 4 : 16;
      const acc = { componentType, count, type };
      if (typedForMinMax && count > 0) {
        const { min, max } = computeAccessorMinMax(typedForMinMax, itemSize, count);
        acc.min = min;
        acc.max = max;
      }
      const idx = json.accessors.length;
      json.accessors.push(acc);
      return idx;
    };

    const matCache = new Map();
    const texCache = new Map();
    const samplerCache = new Map();
    const meshCache = new Map();
    const nodeMap = new Map();

    const exportSampler = (tex) => {
      const wrapS = WRAP[tex.wrapS] || 10497;
      const wrapT = WRAP[tex.wrapT] || 10497;
      const magFilter = tex.magFilter === 'nearest' ? 9728 : 9729;
      const minFilter =
        tex.minFilter === 'nearest'
          ? 9728
          : tex.minFilter === 'linear'
          ? 9729
          : 9987;
      const key = `${wrapS}|${wrapT}|${magFilter}|${minFilter}`;
      if (samplerCache.has(key)) return samplerCache.get(key);
      const idx = json.samplers.length;
      json.samplers.push({ wrapS, wrapT, magFilter, minFilter });
      samplerCache.set(key, idx);
      return idx;
    };

    const exportTexture = async (tex) => {
      if (!tex) return null;
      if (texCache.has(tex)) return texCache.get(tex);

      let pngBytes = null;
      if (tex.image) {
        pngBytes = await imageToPngBytes(tex.image, tex.flipY !== false);
      } else if (typeof tex._decodeRgbaLevel0 === 'function') {
        const mip0 = await tex._decodeRgbaLevel0();
        pngBytes = await rgbaMipToPngBytes(mip0, tex.flipY === true);
      } else if (!tex.compressed && Array.isArray(tex.mipmaps) && tex.mipmaps[0]) {
        pngBytes = await rgbaMipToPngBytes(tex.mipmaps[0], tex.flipY === true);
      }
      if (!pngBytes) return null;

      let imgIdx;
      if (binary) {
        const bvIdx = addBufferView(pngBytes);
        imgIdx = json.images.length;
        json.images.push({ bufferView: bvIdx, mimeType: 'image/png' });
      } else {
        imgIdx = json.images.length;
        json.images.push({ uri: `data:image/png;base64,${bytesToBase64(pngBytes)}` });
      }

      const texIdx = json.textures.length;
      json.textures.push({
        sampler: exportSampler(tex),
        source: imgIdx,
      });
      texCache.set(tex, texIdx);
      return texIdx;
    };

    const exportMaterial = async (mat) => {
      if (!mat) return undefined;
      if (matCache.has(mat)) return matCache.get(mat);

      const c = mat.color || { r: 1, g: 1, b: 1 };
      const opacity = mat.opacity !== undefined ? mat.opacity : 1;
      const metallicFactor = mat.metalness !== undefined ? mat.metalness : 0;
      const roughnessFactor = mat.roughness !== undefined && (mat.hasPbr ?? mat._hasPbr) ? mat.roughness : approxRoughness(mat.shininess);
      const out = {
        pbrMetallicRoughness: {
          baseColorFactor: [s2l(c.r), s2l(c.g), s2l(c.b), opacity],
          metallicFactor,
          roughnessFactor,
        },
      };

      if (mat.name) out.name = mat.name;
      if (mat.side === 'double') out.doubleSided = true;
      if (mat.transparent) out.alphaMode = 'BLEND';
      else if (mat.alphaTest > 0) {
        out.alphaMode = 'MASK';
        out.alphaCutoff = mat.alphaTest;
      }

      const makeTexInfo = async (tex, extra = null) => {
        if (!tex) return null;
        const texIdx = await exportTexture(tex);
        if (texIdx === null) return null;
        const info = { index: texIdx, ...(extra || {}) };
        if (tex.texCoord === 1) info.texCoord = 1;
        const rx = tex.repeat ? tex.repeat.x : 1;
        const ry = tex.repeat ? tex.repeat.y : 1;
        const ox = tex.offset ? tex.offset.x : 0;
        const oy = tex.offset ? tex.offset.y : 0;
        const rot = tex.rotation || 0;
        if (rx !== 1 || ry !== 1 || ox !== 0 || oy !== 0 || rot !== 0) {
          extensionsUsed.add('KHR_texture_transform');
          const tt = { offset: [ox, oy], scale: [rx, ry] };
          if (rot !== 0) tt.rotation = rot;
          info.extensions = { KHR_texture_transform: tt };
        }
        return info;
      };

      if (mat.map) {
        const info = await makeTexInfo(mat.map);
        if (info) out.pbrMetallicRoughness.baseColorTexture = info;
      }
      const mrTex = mat.metallicRoughnessMap || mat.roughnessMap || mat.metalnessMap;
      if (mrTex) {
        const info = await makeTexInfo(mrTex);
        if (info) out.pbrMetallicRoughness.metallicRoughnessTexture = info;
      }
      if (mat.normalMap) {
        const extra = mat.normalScale && mat.normalScale.x !== 1 ? { scale: mat.normalScale.x } : null;
        const info = await makeTexInfo(mat.normalMap, extra);
        if (info) out.normalTexture = info;
      }
      if (mat.aoMap) {
        const extra = mat.aoMapIntensity !== undefined && mat.aoMapIntensity !== 1 ? { strength: mat.aoMapIntensity } : null;
        const info = await makeTexInfo(mat.aoMap, extra);
        if (info) out.occlusionTexture = info;
      }

      if (mat.type === 'basic' || mat.lit === false) {
        extensionsUsed.add('KHR_materials_unlit');
        out.extensions = { ...(out.extensions || {}), KHR_materials_unlit: {} };
      }
      if (mat.type !== 'basic') {
        if (mat.emissiveMap) {
          const info = await makeTexInfo(mat.emissiveMap);
          if (info) out.emissiveTexture = info;
        }
        if (mat.emissive) {
          const er = s2l(mat.emissive.r);
          const eg = s2l(mat.emissive.g);
          const eb = s2l(mat.emissive.b);
          if (er > 0 || eg > 0 || eb > 0) {
            const maxE = Math.max(er, eg, eb, 1);
            out.emissiveFactor = [er / maxE, eg / maxE, eb / maxE];
            if (maxE > 1) {
              extensionsUsed.add('KHR_materials_emissive_strength');
              out.extensions = {
                ...(out.extensions || {}),
                KHR_materials_emissive_strength: { emissiveStrength: maxE },
              };
            }
          }
        }
      }

      const idx = json.materials.length;
      json.materials.push(out);
      matCache.set(mat, idx);
      return idx;
    };

    const exportGeometryMesh = async (geo, mat, drawMode = 'triangles', name = '', includeSkinAttrs = true, maxJointIndex = -1, morphDict = null) => {
      let targetNames = null;
      const morphCount = geo.morphAttributes && Array.isArray(geo.morphAttributes.position) ? geo.morphAttributes.position.length : 0;
      if (morphCount > 0 && morphDict && typeof morphDict === 'object') {
        const names = new Array(morphCount);
        let foundAny = false;
        for (const [k, idx] of Object.entries(morphDict)) {
          if (idx >= 0 && idx < morphCount) {
            names[idx] = k;
            foundAny = true;
          }
        }
        if (foundAny) {
          for (let i = 0; i < morphCount; i++) if (names[i] === undefined) names[i] = `target_${i}`;
          targetNames = names;
        }
      }
      const sourceGeoId = geo.id;
      const key = `${sourceGeoId || ''}|${mat ? mat.id : ''}|${drawMode}|${includeSkinAttrs ? maxJointIndex : -2}|${targetNames ? targetNames.join(',') : ''}`;
      if (sourceGeoId && meshCache.has(key)) return meshCache.get(key);

      if (useOptimize && drawMode === 'triangles' && morphCount === 0) {
        const { optimizeGeometry } = await import('../libs/made-optimize/made_optimize.js');
        geo = await optimizeGeometry(geo, {
          dedupStep: optimizeOpts.dedupStep || 0,
          weldPositionsOnly: !!optimizeOpts.weldPositionsOnly,
          inPlace: false,
          wasmUrl: optimizeOpts.wasmUrl,
        });
      }

      const attrs = {};
      const pos = geo.attributes.position;
      if (!pos) return undefined;

      const posArr = pos.array instanceof Float32Array ? pos.array : Float32Array.from(pos.array);
      const nArr = geo.attributes.normal
        ? geo.attributes.normal.array instanceof Float32Array
          ? geo.attributes.normal.array
          : Float32Array.from(geo.attributes.normal.array)
        : null;
      const uArr = geo.attributes.uv
        ? geo.attributes.uv.array instanceof Float32Array
          ? geo.attributes.uv.array
          : Float32Array.from(geo.attributes.uv.array)
        : null;
      const u1Arr = geo.attributes.uv1
        ? geo.attributes.uv1.array instanceof Float32Array
          ? geo.attributes.uv1.array
          : Float32Array.from(geo.attributes.uv1.array)
        : null;

      let cArr = null;
      let cItemSize = 3;
      if (geo.attributes.color) {
        const col = geo.attributes.color;
        cItemSize = col.itemSize === 4 ? 4 : 3;
        cArr = Float32Array.from(col.array);
        for (let i = 0; i < cArr.length; i += col.itemSize) {
          cArr[i] = s2l(cArr[i]);
          cArr[i + 1] = s2l(cArr[i + 1]);
          cArr[i + 2] = s2l(cArr[i + 2]);
        }
      }

      let jArr = null;
      let wArr = null;
      if (includeSkinAttrs && geo.attributes.skinIndex && geo.attributes.skinWeight) {
        const si = geo.attributes.skinIndex;
        const sw = geo.attributes.skinWeight;
        const count4 = Math.min(si.array.length, sw.array.length);
        jArr = new Uint16Array(count4);
        wArr = new Float32Array(count4);
        for (let i = 0; i + 3 < count4; i += 4) {
          let sum = 0;
          for (let k = 0; k < 4; k++) {
            const rawW = sw.array[i + k];
            const w = Number.isFinite(rawW) && rawW > 0 ? rawW : 0;
            wArr[i + k] = w;
            sum += w;
            if (w > 0) {
              const rawJ = Math.round(si.array[i + k]) || 0;
              jArr[i + k] =
                maxJointIndex >= 0 ? Math.max(0, Math.min(maxJointIndex, rawJ)) : Math.max(0, rawJ);
            } else {
              jArr[i + k] = 0;
            }
          }
          if (sum > 0 && Math.abs(sum - 1) > 1e-4) {
            const inv = 1 / sum;
            wArr[i] *= inv;
            wArr[i + 1] *= inv;
            wArr[i + 2] *= inv;
            wArr[i + 3] *= inv;
          }
        }
      }

      const rawIdx = geo.index && geo.index.array && geo.index.array.length ? geo.index.array : null;
      const dracoIndicesU32 =
        rawIdx
          ? rawIdx instanceof Uint32Array
            ? rawIdx
            : Uint32Array.from(rawIdx)
          : pos.count >= 3 && pos.count % 3 === 0
          ? Uint32Array.from({ length: pos.count }, (_, k) => k)
          : null;

      const canDraco =
        useDraco &&
        drawMode === 'triangles' &&
        morphCount === 0 &&
        pos.count > 0 &&
        dracoIndicesU32 &&
        dracoIndicesU32.length >= 3 &&
        dracoIndicesU32.length % 3 === 0;

      const prim = {
        attributes: attrs,
        mode: drawMode === 'lines' ? 1 : drawMode === 'points' ? 0 : 4,
      };

      if (canDraco) {
        const { encodeDraco } = await import('../libs/made-optimize/made_optimize.js');
        const q = dracoOpts.quantization || {};
        const dracoInputs = [];
        const dracoAttrIds = {};
        let nextUid = 0;

        attrs.POSITION = addVirtualAccessor(pos.count, 'VEC3', COMPONENT_FLOAT, posArr);
        dracoAttrIds.POSITION = nextUid;
        dracoInputs.push({
          attributeType: 0,
          numComponents: 3,
          uniqueId: nextUid++,
          quantizationBits: q.POSITION ?? dracoOpts.positionQuantization ?? 14,
          values: posArr,
        });

        if (nArr) {
          attrs.NORMAL = addVirtualAccessor(pos.count, 'VEC3', COMPONENT_FLOAT);
          dracoAttrIds.NORMAL = nextUid;
          dracoInputs.push({
            attributeType: 1,
            numComponents: 3,
            uniqueId: nextUid++,
            quantizationBits: q.NORMAL ?? dracoOpts.normalQuantization ?? 10,
            values: nArr,
          });
        }
        if (uArr) {
          attrs.TEXCOORD_0 = addVirtualAccessor(pos.count, 'VEC2', COMPONENT_FLOAT);
          dracoAttrIds.TEXCOORD_0 = nextUid;
          dracoInputs.push({
            attributeType: 3,
            numComponents: 2,
            uniqueId: nextUid++,
            quantizationBits: q.TEXCOORD_0 ?? dracoOpts.uvQuantization ?? 12,
            values: uArr,
          });
        }
        if (u1Arr) {
          attrs.TEXCOORD_1 = addVirtualAccessor(pos.count, 'VEC2', COMPONENT_FLOAT);
          dracoAttrIds.TEXCOORD_1 = nextUid;
          dracoInputs.push({
            attributeType: 3,
            numComponents: 2,
            uniqueId: nextUid++,
            quantizationBits: q.TEXCOORD_1 ?? dracoOpts.uvQuantization ?? 12,
            values: u1Arr,
          });
        }
        if (cArr) {
          attrs.COLOR_0 = addVirtualAccessor(pos.count, cItemSize === 4 ? 'VEC4' : 'VEC3', COMPONENT_FLOAT);
          dracoAttrIds.COLOR_0 = nextUid;
          dracoInputs.push({
            attributeType: 2,
            numComponents: cItemSize,
            uniqueId: nextUid++,
            quantizationBits: q.COLOR_0 ?? dracoOpts.colorQuantization ?? 8,
            values: cArr,
          });
        }
        if (jArr && wArr) {
          attrs.JOINTS_0 = addVirtualAccessor(pos.count, 'VEC4', COMPONENT_USHORT);
          dracoAttrIds.JOINTS_0 = nextUid;
          dracoInputs.push({
            attributeType: 4,
            numComponents: 4,
            uniqueId: nextUid++,
            quantizationBits: 0,
            values: Float32Array.from(jArr),
          });

          attrs.WEIGHTS_0 = addVirtualAccessor(pos.count, 'VEC4', COMPONENT_FLOAT);
          dracoAttrIds.WEIGHTS_0 = nextUid;
          dracoInputs.push({
            attributeType: 4,
            numComponents: 4,
            uniqueId: nextUid++,
            quantizationBits: q.WEIGHTS_0 ?? 8,
            values: wArr,
          });
        }

        const dracoBytes = await encodeDraco(
          {
            numPoints: pos.count,
            indices: dracoIndicesU32,
            attributes: dracoInputs,
          },
          dracoOpts.wasmUrl
        );
        const dracoBvIdx = addBufferView(dracoBytes);

        let maxIdx = 0;
        for (let i = 0; i < dracoIndicesU32.length; i++) if (dracoIndicesU32[i] > maxIdx) maxIdx = dracoIndicesU32[i];
        prim.indices = addVirtualAccessor(
          dracoIndicesU32.length,
          'SCALAR',
          maxIdx > 65535 ? COMPONENT_UINT : COMPONENT_USHORT
        );
        prim.extensions = {
          KHR_draco_mesh_compression: {
            bufferView: dracoBvIdx,
            attributes: dracoAttrIds,
          },
        };
        extensionsUsed.add('KHR_draco_mesh_compression');
        extensionsRequired.add('KHR_draco_mesh_compression');
      } else {
        attrs.POSITION = addAccessor(posArr, 'VEC3', COMPONENT_FLOAT, TARGET_ARRAY_BUFFER, true);
        if (nArr) attrs.NORMAL = addAccessor(nArr, 'VEC3', COMPONENT_FLOAT, TARGET_ARRAY_BUFFER);
        if (uArr) attrs.TEXCOORD_0 = addAccessor(uArr, 'VEC2', COMPONENT_FLOAT, TARGET_ARRAY_BUFFER);
        if (u1Arr) attrs.TEXCOORD_1 = addAccessor(u1Arr, 'VEC2', COMPONENT_FLOAT, TARGET_ARRAY_BUFFER);
        if (cArr) {
          attrs.COLOR_0 = addAccessor(cArr, cItemSize === 4 ? 'VEC4' : 'VEC3', COMPONENT_FLOAT, TARGET_ARRAY_BUFFER);
        }
        if (jArr && wArr) {
          attrs.JOINTS_0 = addAccessor(jArr, 'VEC4', COMPONENT_USHORT, TARGET_ARRAY_BUFFER);
          attrs.WEIGHTS_0 = addAccessor(wArr, 'VEC4', COMPONENT_FLOAT, TARGET_ARRAY_BUFFER);
        }

        const morphPos = geo.morphAttributes && geo.morphAttributes.position;
        const morphNor = geo.morphAttributes && geo.morphAttributes.normal;
        if (Array.isArray(morphPos) && morphPos.length > 0) {
          prim.targets = [];
          for (let t = 0; t < morphPos.length; t++) {
            const tgt = {};
            const mp = morphPos[t];
            const mpArr = mp.array instanceof Float32Array ? mp.array : Float32Array.from(mp.array);
            tgt.POSITION = addAccessor(mpArr, 'VEC3', COMPONENT_FLOAT, TARGET_ARRAY_BUFFER, true);
            if (morphNor && morphNor[t]) {
              const mn = morphNor[t];
              const mnArr = mn.array instanceof Float32Array ? mn.array : Float32Array.from(mn.array);
              tgt.NORMAL = addAccessor(mnArr, 'VEC3', COMPONENT_FLOAT, TARGET_ARRAY_BUFFER);
            }
            prim.targets.push(tgt);
          }
        }

        if (rawIdx) {
          let maxIdx = 0;
          for (let i = 0; i < rawIdx.length; i++) if (rawIdx[i] > maxIdx) maxIdx = rawIdx[i];
          const useUint = maxIdx > 65535;
          const iArr = useUint
            ? rawIdx instanceof Uint32Array
              ? rawIdx
              : Uint32Array.from(rawIdx)
            : rawIdx instanceof Uint16Array
            ? rawIdx
            : Uint16Array.from(rawIdx);
          prim.indices = addAccessor(
            iArr,
            'SCALAR',
            useUint ? COMPONENT_UINT : COMPONENT_USHORT,
            TARGET_ELEMENT_ARRAY_BUFFER
          );
        }
      }

      const matIdx = await exportMaterial(mat);
      if (matIdx !== undefined) prim.material = matIdx;

      const meshIdx = json.meshes.length;
      const meshDef = { primitives: [prim] };
      if (name) meshDef.name = name;
      if (targetNames && targetNames.length) {
        meshDef.extras = { targetNames };
      }
      json.meshes.push(meshDef);
      if (sourceGeoId) meshCache.set(key, meshIdx);
      return meshIdx;
    };

    const skinnedPending = [];

    const visitNode = async (obj) => {
      if (!isExportableNode(obj, onlyVisible)) return null;

      const node = {};
      if (obj.name) node.name = obj.name;

      const p = obj.position;
      const q = obj.quaternion;
      const s = obj.scale;
      const pv = obj.pivot;
      if (pv && (pv.x !== 0 || pv.y !== 0 || pv.z !== 0)) {
        obj.updateMatrix();
        const me = obj.matrix.elements;
        if (me[12] !== 0 || me[13] !== 0 || me[14] !== 0) {
          node.translation = [me[12], me[13], me[14]];
        }
      } else if (p && (p.x !== 0 || p.y !== 0 || p.z !== 0)) {
        node.translation = [p.x, p.y, p.z];
      }
      if (q && (q.x !== 0 || q.y !== 0 || q.z !== 0 || q.w !== 1)) node.rotation = [q.x, q.y, q.z, q.w];
      if (s && (s.x !== 1 || s.y !== 1 || s.z !== 1)) node.scale = [s.x, s.y, s.z];

      const nodeIdx = json.nodes.length;
      json.nodes.push(node);
      nodeMap.set(obj, nodeIdx);

      if (obj.isInstancedMesh && obj.geometry && obj.instanceMatrix) {
        const meshIdx = await exportGeometryMesh(obj.geometry, obj.material, obj.drawMode, obj.name, false);
        if (meshIdx !== undefined) {
          const arr = obj.instanceMatrix.array;
          const total = Math.min(obj.count || 0, Math.floor(arr.length / 16));
          node.children = node.children || [];
          const m = new Mat4();
          for (let i = 0; i < total; i++) {
            m.elements.set(arr.subarray(i * 16, i * 16 + 16));
            const instNode = {
              name: `${obj.name || 'instancia'}_${i}`,
              mesh: meshIdx,
              matrix: Array.from(m.elements),
            };
            const instIdx = json.nodes.length;
            json.nodes.push(instNode);
            node.children.push(instIdx);
          }
        }
      } else if (obj.isMesh && obj.geometry) {
        const hasSkinBones = Boolean(
          obj.isSkinnedMesh &&
          obj.skeleton &&
          obj.skeleton.bones?.length &&
          obj.skeleton.bones.every((b) => isNodeChainExportable(b, rootSet, onlyVisible))
        );
        const maxJoint = hasSkinBones ? obj.skeleton.bones.length - 1 : -1;
        const meshIdx = await exportGeometryMesh(
          obj.geometry,
          obj.material,
          obj.drawMode,
          obj.name,
          hasSkinBones,
          maxJoint,
          obj.morphTargetDictionary
        );
        if (meshIdx !== undefined) node.mesh = meshIdx;
        if (Array.isArray(obj.morphTargetInfluences) && obj.morphTargetInfluences.length) {
          node.weights = Array.from(obj.morphTargetInfluences);
        }
        if (hasSkinBones) {
          skinnedPending.push({ node, obj });
        }
      }

      if (obj.children && obj.children.length) {
        const childIndices = [];
        for (const ch of obj.children) {
          const cIdx = await visitNode(ch);
          if (cIdx !== null) childIndices.push(cIdx);
        }
        if (childIndices.length) {
          node.children = node.children ? [...node.children, ...childIndices] : childIndices;
        }
      }

      return nodeIdx;
    };

    for (const root of roots) {
      if (!root) continue;
      if (root.isScene) {
        for (const ch of root.children) {
          const idx = await visitNode(ch);
          if (idx !== null) json.scenes[0].nodes.push(idx);
        }
      } else {
        const idx = await visitNode(root);
        if (idx !== null) json.scenes[0].nodes.push(idx);
      }
    }

    // Exportar skins después de construir el mapa de nodos
    for (const { node, obj } of skinnedPending) {
      const sk = obj.skeleton;
      const jointIndices = [];
      let valid = true;
      for (const bone of sk.bones) {
        const idx = nodeMap.get(bone);
        if (idx === undefined) {
          valid = false;
          break;
        }
        jointIndices.push(idx);
      }
      if (!valid || !jointIndices.length) continue;

      const ibm = new Float32Array(jointIndices.length * 16);
      for (let i = 0; i < jointIndices.length; i++) {
        const inv = sk.boneInverses[i];
        if (inv && inv.elements) ibm.set(inv.elements, i * 16);
        else ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], i * 16);
      }
      const ibmAcc = addAccessor(ibm, 'MAT4', COMPONENT_FLOAT);
      const skinIdx = json.skins.length;
      json.skins.push({ joints: jointIndices, inverseBindMatrices: ibmAcc });
      node.skin = skinIdx;
    }

    // Exportar clips de animación opcionales
    if (Array.isArray(opts.animations)) {
      const byName = new Map();
      for (const [obj, idx] of nodeMap.entries()) {
        if (obj.name) byName.set(obj.name, idx);
      }
      for (const clip of opts.animations) {
        if (!clip || !clip.tracks?.length) continue;
        const samplers = [];
        const channels = [];
        for (const tr of clip.tracks) {
          let targetIdx = tr.target ? nodeMap.get(tr.target) : undefined;
          let prop = tr.property;
          if ((targetIdx === undefined || !prop) && tr.name) {
            const dot = tr.name.lastIndexOf('.');
            if (dot > 0) {
              if (targetIdx === undefined) targetIdx = byName.get(tr.name.slice(0, dot));
              prop = prop || tr.name.slice(dot + 1);
            }
          }
          if (targetIdx === undefined || !['position', 'quaternion', 'rotation', 'scale', 'weights', 'morphTargetInfluences'].includes(prop)) continue;
          const path =
            prop === 'position'
              ? 'translation'
              : prop === 'quaternion' || prop === 'rotation'
              ? 'rotation'
              : prop === 'scale'
              ? 'scale'
              : 'weights';
          const tAcc = addAccessor(
            tr.times instanceof Float32Array ? tr.times : Float32Array.from(tr.times),
            'SCALAR',
            COMPONENT_FLOAT,
            null,
            true
          );
          let outValues;
          if (prop === 'rotation') {
            const count = Math.floor(tr.values.length / 3);
            outValues = new Float32Array(count * 4);
            const euler = new Euler();
            const quat = new Quat();
            for (let i = 0; i < count; i++) {
              euler.set(tr.values[i * 3], tr.values[i * 3 + 1], tr.values[i * 3 + 2]);
              quat.setFromEuler(euler, false);
              outValues[i * 4] = quat.x;
              outValues[i * 4 + 1] = quat.y;
              outValues[i * 4 + 2] = quat.z;
              outValues[i * 4 + 3] = quat.w;
            }
          } else {
            outValues = tr.values instanceof Float32Array ? tr.values : Float32Array.from(tr.values);
          }
          const vAcc = addAccessor(
            outValues,
            path === 'rotation' ? 'VEC4' : path === 'weights' ? 'SCALAR' : 'VEC3',
            COMPONENT_FLOAT
          );
          const sIdx = samplers.length;
          samplers.push({
            input: tAcc,
            output: vAcc,
            interpolation: tr.interpolation === 'step' ? 'STEP' : 'LINEAR',
          });
          channels.push({ sampler: sIdx, target: { node: targetIdx, path } });
        }
        if (channels.length) {
          json.animations.push({ name: clip.name || 'Animation', samplers, channels });
        }
      }
    }

    // Limpiar arreglos vacíos según especificación glTF 2.0
    for (const k of ['meshes', 'materials', 'textures', 'images', 'samplers', 'skins', 'animations', 'bufferViews', 'accessors']) {
      if (!json[k].length) delete json[k];
    }
    if (extensionsUsed.size) json.extensionsUsed = Array.from(extensionsUsed);
    if (extensionsRequired.size) json.extensionsRequired = Array.from(extensionsRequired);

    const binBytes = new Uint8Array(byteLength);
    let cursor = 0;
    for (const c of chunks) {
      binBytes.set(c, cursor);
      cursor += c.byteLength;
    }

    if (byteLength > 0) {
      if (binary) {
        json.buffers = [{ byteLength }];
      } else {
        json.buffers = [
          {
            byteLength,
            uri: `data:application/octet-stream;base64,${bytesToBase64(binBytes)}`,
          },
        ];
      }
    } else {
      delete json.buffers;
    }

    return binary ? encodeGLB(json, binBytes) : json;
  }

  async parseGLB(input, opts = {}) {
    return this.parse(input, { ...opts, binary: true });
  }

  async parseGLTF(input, opts = {}) {
    return this.parse(input, { ...opts, binary: false });
  }
}
