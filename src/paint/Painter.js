import { Vec3 } from '../math/Vec3.js';
import { Mat4 } from '../math/Mat4.js';
import { Raycaster } from '../core/Raycaster.js';
import { clientToLocalPoint } from '../core/viewportCoords.js';
import { BufferAttribute } from '../geometry/BufferAttribute.js';
import { Texture } from '../textures/Texture.js';

export const PAINT_TOOLS = ['brush', 'airbrush', 'blur', 'smudge', 'fill', 'eraser', 'picker'];
export const PAINT_SYMMETRIES = ['none', 'x', 'y', 'z'];
export const PAINT_MODES = ['texture', 'vertex'];
export const PAINT_RESOLUTIONS = [512, 1024, 2048];
export const PAINT_DEFAULT_PALETTE = [
  '#ef4444',
  '#f59e0b',
  '#facc15',
  '#22c55e',
  '#38bdf8',
  '#3b82f6',
  '#a855f7',
  '#ec4899',
  '#ffffff',
  '#94a3b8',
  '#475569',
  '#18181b',
];

const _invMat = new Mat4();
const _raycaster = new Raycaster();
const _tmpWorld = new Vec3();
const _tmpLocal = new Vec3();
const _vTanRef = new Vec3();
const _tan = new Vec3();
const _bitan = new Vec3();
const _proj = new Vec3();
const _triCache = new WeakMap();

export function parseHexColor(input) {
  if (Array.isArray(input)) {
    return [
      Math.max(0, Math.min(255, Math.round(input[0] ?? 255))),
      Math.max(0, Math.min(255, Math.round(input[1] ?? 255))),
      Math.max(0, Math.min(255, Math.round(input[2] ?? 255))),
    ];
  }
  const str = String(input || '#ef4444').trim();
  const m6 = /^#([0-9a-f]{6})$/i.exec(str);
  if (m6) {
    const n = parseInt(m6[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m3 = /^#([0-9a-f]{3})$/i.exec(str);
  if (m3) {
    const s = m3[1];
    return [
      parseInt(s[0] + s[0], 16),
      parseInt(s[1] + s[1], 16),
      parseInt(s[2] + s[2], 16),
    ];
  }
  return [239, 68, 68];
}

export function rgbToHex(r, g, b) {
  const clampByte = (v) => Math.max(0, Math.min(255, Math.round(v)));
  const hex = (v) => clampByte(v).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

function evalBrushFalloff(t, hardness = 0.35) {
  if (t >= 1) return 0;
  if (t <= 0) return 1;
  const h = Math.max(0, Math.min(0.98, Number(hardness) || 0));
  const inner = h * 0.9;
  if (t <= inner) return 1;
  const u = Math.max(0, Math.min(1, (1 - t) / Math.max(1e-4, 1 - inner)));
  return u * u * u * (u * (u * 6 - 15) + 10);
}

function wrapUnit(v) {
  const f = v - Math.floor(v);
  return f < 0 ? f + 1 : f;
}

/**
 * Detecta si la geometría carece de UVs válidas o tiene solapamientos fuertes (p. ej. BoxGeometry o CylinderGeometry).
 */
export function hasOverlappingOrMissingUVs(geo) {
  if (!geo || !geo.attributes || !geo.attributes.position) return false;
  const uvAttr = geo.attributes.uv;
  if (!uvAttr || uvAttr.count < 3) return true;

  const pos = geo.attributes.position;
  const idx = geo.index ? geo.index.array : null;
  const tris = idx ? (idx.length / 3) | 0 : (pos.count / 3) | 0;
  if (!tris) return true;

  const uv = uvAttr.array;
  let totalArea = 0;
  for (let t = 0; t < tris; t++) {
    const t3 = t * 3;
    const ia = idx ? idx[t3] : t3;
    const ib = idx ? idx[t3 + 1] : t3 + 1;
    const ic = idx ? idx[t3 + 2] : t3 + 2;
    const ua = uv[ia * 2], va = uv[ia * 2 + 1];
    const ub = uv[ib * 2], vb = uv[ib * 2 + 1];
    const uc = uv[ic * 2], vc = uv[ic * 2 + 1];
    totalArea += Math.abs((ub - ua) * (vc - va) - (uc - ua) * (vb - va)) * 0.5;
  }

  if (totalArea < 1e-5) return true;
  if (totalArea > 1.08) return true;
  return false;
}

/**
 * Desenvuelve una geometría con un atlas triplanar de 6 caras sin solapamientos ni sangrado entre islas.
 */
export function unwrapBoxAtlas(geo) {
  if (!geo || !geo.attributes || !geo.attributes.position) return false;
  const posAttr = geo.attributes.position;
  const pos = posAttr.array;
  const vCount = posAttr.count;
  const idxAttr = geo.index || null;
  const idx = idxAttr ? idxAttr.array : null;
  const tris = idx ? (idx.length / 3) | 0 : (vCount / 3) | 0;
  if (!tris) return false;

  const bb = geo.getBoundingBox();
  const minX = bb ? bb.min.x : -0.5;
  const minY = bb ? bb.min.y : -0.5;
  const minZ = bb ? bb.min.z : -0.5;
  const sx = bb ? Math.max(1e-4, bb.max.x - bb.min.x) : 1;
  const sy = bb ? Math.max(1e-4, bb.max.y - bb.min.y) : 1;
  const sz = bb ? Math.max(1e-4, bb.max.z - bb.min.z) : 1;

  const triChart = new Uint8Array(tris);
  const usedChartsMask = new Uint8Array(6);

  for (let t = 0; t < tris; t++) {
    const t3 = t * 3;
    const ia = (idx ? idx[t3] : t3) * 3;
    const ib = (idx ? idx[t3 + 1] : t3 + 1) * 3;
    const ic = (idx ? idx[t3 + 2] : t3 + 2) * 3;
    const e1x = pos[ib] - pos[ia], e1y = pos[ib + 1] - pos[ia + 1], e1z = pos[ib + 2] - pos[ia + 2];
    const e2x = pos[ic] - pos[ia], e2y = pos[ic + 1] - pos[ia + 1], e2z = pos[ic + 2] - pos[ia + 2];
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    let chart;
    if (ax >= ay && ax >= az) chart = nx >= 0 ? 0 : 1;
    else if (ay >= ax && ay >= az) chart = ny >= 0 ? 2 : 3;
    else chart = nz >= 0 ? 4 : 5;
    triChart[t] = chart;
    usedChartsMask[chart] = 1;
  }

  const activeCharts = [];
  const chartSlot = new Int8Array(6).fill(-1);
  for (let c = 0; c < 6; c++) {
    if (usedChartsMask[c]) {
      chartSlot[c] = activeCharts.length;
      activeCharts.push(c);
    }
  }

  const count = activeCharts.length;
  const cols = count <= 1 ? 1 : count <= 4 ? 2 : 3;
  const rows = Math.max(1, Math.ceil(count / cols));
  const pad = 0.03;
  const cellW = 1 / cols;
  const cellH = 1 / rows;

  const projectVertexToChart = (vi, chart) => {
    const o = vi * 3;
    const nx = (pos[o] - minX) / sx;
    const ny = (pos[o + 1] - minY) / sy;
    const nz = (pos[o + 2] - minZ) / sz;
    let lu = 0.5;
    let lv = 0.5;
    switch (chart) {
      case 0: lu = 1 - nz; lv = ny; break;      // +X
      case 1: lu = nz; lv = ny; break;          // -X
      case 2: lu = nx; lv = 1 - nz; break;      // +Y
      case 3: lu = nx; lv = nz; break;          // -Y
      case 4: lu = nx; lv = ny; break;          // +Z
      default: lu = 1 - nx; lv = ny; break;     // -Z
    }
    const slot = chartSlot[chart];
    const cx = slot % cols;
    const cy = Math.floor(slot / cols);
    const u = (cx + pad + lu * (1 - 2 * pad)) * cellW;
    const v = (cy + pad + lv * (1 - 2 * pad)) * cellH;
    return [u, v];
  };

  // Comprobar si algún vértice pertenece a más de un chart; si es así, duplicar solo los vértices divididos.
  const vertFirstChart = new Int8Array(vCount).fill(-1);
  let needsSplit = false;
  for (let t = 0; t < tris; t++) {
    const c = triChart[t];
    const t3 = t * 3;
    for (let k = 0; k < 3; k++) {
      const vi = idx ? idx[t3 + k] : t3 + k;
      if (vertFirstChart[vi] === -1) vertFirstChart[vi] = c;
      else if (vertFirstChart[vi] !== c) { needsSplit = true; break; }
    }
    if (needsSplit) break;
  }

  if (!needsSplit) {
    const uvArr = new Float32Array(vCount * 2);
    for (let t = 0; t < tris; t++) {
      const c = triChart[t];
      const t3 = t * 3;
      for (let k = 0; k < 3; k++) {
        const vi = idx ? idx[t3 + k] : t3 + k;
        const [u, v] = projectVertexToChart(vi, c);
        uvArr[vi * 2] = u;
        uvArr[vi * 2 + 1] = v;
      }
    }
    geo.setAttribute('uv', uvArr, 2);
    _triCache.delete(geo);
    return true;
  }

  // Reconstruir vértices separando (origVert, chart) cuando un vértice cruza frontera de chart
  const pairToNewVert = new Map();
  const newIndices = new Uint32Array(tris * 3);
  const srcOrigList = [];
  const newUvList = [];

  for (let t = 0; t < tris; t++) {
    const c = triChart[t];
    const t3 = t * 3;
    for (let k = 0; k < 3; k++) {
      const vi = idx ? idx[t3 + k] : t3 + k;
      const key = vi * 8 + c;
      let nvi = pairToNewVert.get(key);
      if (nvi === undefined) {
        nvi = srcOrigList.length;
        pairToNewVert.set(key, nvi);
        srcOrigList.push(vi);
        const [u, v] = projectVertexToChart(vi, c);
        newUvList.push(u, v);
      }
      newIndices[t3 + k] = nvi;
    }
  }

  const newVCount = srcOrigList.length;
  const copyAttr = (attr) => {
    if (!attr || !attr.array) return null;
    const s = attr.itemSize || 3;
    const src = attr.array;
    const dst = new Float32Array(newVCount * s);
    for (let i = 0; i < newVCount; i++) {
      const si = srcOrigList[i] * s;
      const di = i * s;
      for (let j = 0; j < s; j++) dst[di + j] = src[si + j];
    }
    return dst;
  };

  const posNew = copyAttr(geo.attributes.position);
  const norNew = copyAttr(geo.attributes.normal);
  const colNew = copyAttr(geo.attributes.color);
  const uv1New = copyAttr(geo.attributes.uv1);
  const skinIdxNew = copyAttr(geo.attributes.skinIndex);
  const skinWtNew = copyAttr(geo.attributes.skinWeight);

  if (posNew) geo.setAttribute('position', posNew, 3);
  if (norNew) geo.setAttribute('normal', norNew, 3);
  geo.setAttribute('uv', new Float32Array(newUvList), 2);
  if (uv1New) geo.setAttribute('uv1', uv1New, 2);
  if (colNew) geo.setAttribute('color', colNew, geo.attributes.color.itemSize);
  if (skinIdxNew) geo.setAttribute('skinIndex', skinIdxNew, 4);
  if (skinWtNew) geo.setAttribute('skinWeight', skinWtNew, 4);
  geo.setIndex(newVCount <= 65535 ? new Uint16Array(newIndices) : newIndices);
  geo.boundingBox = null;
  geo.boundingSphere = null;
  _triCache.delete(geo);
  return true;
}

/**
 * Construye o reutiliza el mapa de caché geométrico/UV de triángulos y propiedad de píxeles.
 */
function getPaintTriData(mesh, texW, texH) {
  const geo = mesh?.geometry;
  if (!geo || !geo.attributes || !geo.attributes.position) return null;
  const posAttr = geo.attributes.position;
  const norAttr = geo.attributes.normal || null;
  const uvAttr = geo.attributes.uv || null;
  const idxAttr = geo.index || null;

  const posVer = posAttr.version ?? 0;
  const uvVer = uvAttr ? (uvAttr.version ?? 0) : -1;
  const idxVer = idxAttr ? (idxAttr.version ?? 0) : -1;

  // Para mallas con esqueleto deformables, calculamos posiciones locales deformadas al vuelo
  const isDynamicSkin = Boolean(mesh.isSkinnedMesh && mesh.skeleton);
  let entry = !isDynamicSkin ? _triCache.get(geo) : null;

  if (
    entry &&
    entry.posVer === posVer &&
    entry.uvVer === uvVer &&
    entry.idxVer === idxVer &&
    entry.texW === texW &&
    entry.texH === texH
  ) {
    return entry;
  }

  const posCount = posAttr.count;
  let posArr = posAttr.array;
  let norArr = norAttr ? norAttr.array : null;

  if (isDynamicSkin) {
    const deformedWorld = new Float32Array(posCount * 3);
    mesh.computeSkinnedWorld(deformedWorld, posCount);
    _invMat.copyInverse(mesh.matrixWorld);
    const inv = _invMat.elements;
    const localDef = new Float32Array(posCount * 3);
    for (let i = 0; i < posCount; i++) {
      const o = i * 3;
      const wx = deformedWorld[o], wy = deformedWorld[o + 1], wz = deformedWorld[o + 2];
      localDef[o] = inv[0] * wx + inv[4] * wy + inv[8] * wz + inv[12];
      localDef[o + 1] = inv[1] * wx + inv[5] * wy + inv[9] * wz + inv[13];
      localDef[o + 2] = inv[2] * wx + inv[6] * wy + inv[10] * wz + inv[14];
    }
    posArr = localDef;
  }

  const idx = idxAttr ? idxAttr.array : null;
  const tris = idx ? (idx.length / 3) | 0 : (posCount / 3) | 0;
  const uvArr = uvAttr ? uvAttr.array : null;

  const triAabb = new Float32Array(tris * 6);
  const triFaceNormal = new Float32Array(tris * 3);

  for (let t = 0; t < tris; t++) {
    const t3 = t * 3;
    const ia = (idx ? idx[t3] : t3) * 3;
    const ib = (idx ? idx[t3 + 1] : t3 + 1) * 3;
    const ic = (idx ? idx[t3 + 2] : t3 + 2) * 3;
    const ax = posArr[ia], ay = posArr[ia + 1], az = posArr[ia + 2];
    const bx = posArr[ib], by = posArr[ib + 1], bz = posArr[ib + 2];
    const cx = posArr[ic], cy = posArr[ic + 1], cz = posArr[ic + 2];

    const b6 = t * 6;
    triAabb[b6] = ax < bx ? (ax < cx ? ax : cx) : (bx < cx ? bx : cx);
    triAabb[b6 + 1] = ay < by ? (ay < cy ? ay : cy) : (by < cy ? by : cy);
    triAabb[b6 + 2] = az < bz ? (az < cz ? az : cz) : (bz < cz ? bz : cz);
    triAabb[b6 + 3] = ax > bx ? (ax > cx ? ax : cx) : (bx > cx ? bx : cx);
    triAabb[b6 + 4] = ay > by ? (ay > cy ? ay : cy) : (by > cy ? by : cy);
    triAabb[b6 + 5] = az > bz ? (az > cz ? az : cz) : (bz > cz ? bz : cz);

    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    let fnx = e1y * e2z - e1z * e2y;
    let fny = e1z * e2x - e1x * e2z;
    let fnz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(fnx, fny, fnz) || 1;
    fnx /= len; fny /= len; fnz /= len;
    triFaceNormal[t3] = fnx;
    triFaceNormal[t3 + 1] = fny;
    triFaceNormal[t3 + 2] = fnz;
  }

  // Construir mapa de propiedad de píxeles para Flood Fill acotado a islas UV (solo cuando texW > 0)
  let pixelTriOwner = null;
  if (uvArr && texW > 0 && texH > 0) {
    pixelTriOwner = new Int32Array(texW * texH).fill(-1);
    for (let t = 0; t < tris; t++) {
      const t3 = t * 3;
      const ia = (idx ? idx[t3] : t3) * 2;
      const ib = (idx ? idx[t3 + 1] : t3 + 1) * 2;
      const ic = (idx ? idx[t3 + 2] : t3 + 2) * 2;
      const ua = uvArr[ia], va = uvArr[ia + 1];
      const ub = uvArr[ib], vb = uvArr[ib + 1];
      const uc = uvArr[ic], vc = uvArr[ic + 1];
      const u0x = ub - ua, u0y = vb - va;
      const u1x = uc - ua, u1y = vc - va;
      const det = u0x * u1y - u1x * u0y;
      if (Math.abs(det) < 1e-10) continue;
      const invDet = 1 / det;

      const minU = Math.min(ua, ub, uc);
      const maxU = Math.max(ua, ub, uc);
      const minV = Math.min(va, vb, vc);
      const maxV = Math.max(va, vb, vc);

      const x0 = Math.max(0, Math.floor(minU * texW) - 1);
      const x1 = Math.min(texW - 1, Math.ceil(maxU * texW) + 1);
      const y0 = Math.max(0, Math.floor(minV * texH) - 1);
      const y1 = Math.min(texH - 1, Math.ceil(maxV * texH) + 1);

      for (let py = y0; py <= y1; py++) {
        const pv = (py + 0.5) / texH;
        const rowOff = py * texW;
        for (let px = x0; px <= x1; px++) {
          const pu = (px + 0.5) / texW;
          const dx = pu - ua, dy = pv - va;
          const w1 = (dx * u1y - u1x * dy) * invDet;
          const w2 = (u0x * dy - dx * u0y) * invDet;
          const w0 = 1 - w1 - w2;
          if (w0 >= -0.02 && w1 >= -0.02 && w2 >= -0.02) {
            pixelTriOwner[rowOff + px] = t;
          }
        }
      }
    }
  }

  entry = {
    posVer,
    uvVer,
    idxVer,
    texW,
    texH,
    tris,
    idx,
    posArr,
    norArr,
    uvArr,
    triAabb,
    triFaceNormal,
    pixelTriOwner,
  };
  if (!isDynamicSkin) _triCache.set(geo, entry);
  return entry;
}

function readTextureRgbaBytes(tex) {
  if (!tex) return null;
  if (!tex.compressed && Array.isArray(tex.mipmaps) && tex.mipmaps[0]?.data) {
    const m = tex.mipmaps[0];
    return { width: m.width, height: m.height, data: new Uint8Array(m.data) };
  }
  const img = tex.image;
  if (!img || typeof document === 'undefined') return null;
  const w = img.naturalWidth || img.videoWidth || img.width || 0;
  const h = img.naturalHeight || img.videoHeight || img.height || 0;
  if (!w || !h) return null;
  try {
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext('2d');
    if (!ctx) return null;
    if (tex.flipY !== false) {
      ctx.translate(0, h);
      ctx.scale(1, -1);
    }
    ctx.drawImage(img, 0, 0, w, h);
    const id = ctx.getImageData(0, 0, w, h);
    return { width: w, height: h, data: new Uint8Array(id.data.buffer.slice(0)) };
  } catch (_) {
    return null;
  }
}

export class Painter {
  constructor(opts = {}) {
    this.tool = opts.tool || 'brush';
    this.color = opts.color || '#ef4444';
    this.radius = opts.radius ?? 0.32;
    this.strength = opts.strength ?? 0.85;
    this.hardness = opts.hardness ?? 0.45;
    this.symmetry = opts.symmetry || 'none';
    this.frontFacesOnly = opts.frontFacesOnly ?? true;
    this.paintMode = opts.paintMode || 'texture'; // 'texture' | 'vertex'
    this.resolution = opts.resolution ?? 1024;
    this.enabled = opts.enabled ?? false;
    this.hover = null;
    this.palette = Array.isArray(opts.palette) ? opts.palette.slice() : PAINT_DEFAULT_PALETTE.slice();
    this._stroke = null;
    this._attached = null;
    this._cleanup = null;
    this._activePointerId = null;
    this._captureEl = null;
    this._pointers = new Set();
    this._alphaMask = null;
  }

  get isStroking() {
    return Boolean(this._stroke);
  }

  get activeMesh() {
    return this._stroke ? this._stroke.mesh : null;
  }

  setEnabled(enabled) {
    const next = Boolean(enabled);
    if (!next && this.isStroking) {
      this.commitStroke();
    }
    this.enabled = next;
    if (!next) {
      this.hover = null;
      this._pointers.clear();
      this._releasePointerCapture();
      this._activePointerId = null;
    }
    return this;
  }

  setColor(hex) {
    const [r, g, b] = parseHexColor(hex);
    this.color = rgbToHex(r, g, b);
    return this.color;
  }

  static isPaintable(obj) {
    return Boolean(
      obj &&
        obj.isMesh &&
        !obj.isFloor &&
        !obj.isGizmo &&
        !obj.isInstancedMesh &&
        obj.geometry &&
        obj.geometry.attributes &&
        obj.geometry.attributes.position
    );
  }

  static collectTargets(source) {
    if (!source) return [];
    const seen = new Set();
    const out = [];
    const visit = (node) => {
      if (!node) return;
      if (Painter.isPaintable(node) && !seen.has(node)) {
        seen.add(node);
        out.push(node);
      }
      if (Array.isArray(node.children)) {
        for (const ch of node.children) visit(ch);
      }
    };
    if (Array.isArray(source)) {
      for (const item of source) visit(item);
    } else {
      visit(source);
    }
    return out;
  }

  /**
   * Asegura que la geometría y el material de `mesh` no sean compartidos con otro objeto de la escena.
   */
  static ensureUniqueResources(mesh, scene = null) {
    if (!mesh || !mesh.geometry) return mesh;
    if (scene && typeof scene.traverse === 'function') {
      let geoShared = false;
      let matShared = false;
      scene.traverse((n) => {
        if (n === mesh) return;
        if (n.geometry === mesh.geometry) geoShared = true;
        if (mesh.material && n.material === mesh.material) matShared = true;
      });
      if (geoShared) {
        const cloned = mesh.geometry.clone();
        if (typeof mesh.setGeometry === 'function') mesh.setGeometry(cloned);
        else mesh.geometry = cloned;
      }
      if (matShared && mesh.material && typeof mesh.material.clone === 'function') {
        mesh.material = mesh.material.clone();
      }
    }
    return mesh;
  }

  /**
   * Prepara la textura RGBA editable (`material.map`) y UVs sin solapamiento si faltaban o solapaban.
   */
  static ensurePaintTexture(mesh, opts = {}) {
    if (!Painter.isPaintable(mesh) || !mesh.material) return null;
    Painter.ensureUniqueResources(mesh, opts.scene || null);
    const mat = mesh.material;
    const desiredRes = Math.max(128, Math.min(2048, Number(opts.resolution) || 1024));

    // Reutilizar textura de pintura ya inicializada
    if (mat.map && mat.map.userData?.isPaintTexture && Array.isArray(mat.map.mipmaps) && mat.map.mipmaps[0]?.data) {
      return mat.map;
    }

    const baseColor = mat.color ? { r: mat.color.r, g: mat.color.g, b: mat.color.b } : { r: 1, g: 1, b: 1 };
    const existingBytes = mat.map ? readTextureRgbaBytes(mat.map) : null;

    if (existingBytes) {
      const { width: w, height: h, data } = existingBytes;
      // Hornear tinte del material en los píxeles iniciales y limpiar uColor a blanco puro
      if (baseColor.r < 0.996 || baseColor.g < 0.996 || baseColor.b < 0.996) {
        for (let i = 0; i < data.length; i += 4) {
          data[i] = Math.round(data[i] * baseColor.r);
          data[i + 1] = Math.round(data[i + 1] * baseColor.g);
          data[i + 2] = Math.round(data[i + 2] * baseColor.b);
        }
        if (mat.color && typeof mat.color.setHex === 'function') mat.color.setHex(0xffffff);
      }
      const tex = new Texture(null, {
        mipmaps: [{ data, width: w, height: h }],
        width: w,
        height: h,
        wrapS: mat.map.wrapS || 'clamp',
        wrapT: mat.map.wrapT || 'clamp',
        minFilter: 'linear-mipmap',
        magFilter: 'linear',
        flipY: false,
        colorSpace: 'srgb',
        userData: {
          isPaintTexture: true,
          basePixels: new Uint8Array(data),
          hadExternalMap: true,
        },
      });
      tex.needsUpdate = true;
      mat.map = tex;
      if (typeof mat.invalidate === 'function') mat.invalidate();
      return tex;
    }

    // Sin mapa previo: comprobar si necesita desenrollado automático de UVs sin solapes
    if (hasOverlappingOrMissingUVs(mesh.geometry)) {
      unwrapBoxAtlas(mesh.geometry);
    }

    const size = desiredRes;
    const totalPixels = size * size;
    const data = new Uint8Array(totalPixels * 4);
    const br = Math.max(0, Math.min(255, Math.round(baseColor.r * 255)));
    const bg = Math.max(0, Math.min(255, Math.round(baseColor.g * 255)));
    const bb = Math.max(0, Math.min(255, Math.round(baseColor.b * 255)));

    for (let i = 0; i < totalPixels; i++) {
      const o = i * 4;
      data[o] = br;
      data[o + 1] = bg;
      data[o + 2] = bb;
      data[o + 3] = 255;
    }

    if (mat.color && typeof mat.color.setHex === 'function') {
      mat.color.setHex(0xffffff);
    }

    const tex = new Texture(null, {
      mipmaps: [{ data, width: size, height: size }],
      width: size,
      height: size,
      wrapS: 'clamp',
      wrapT: 'clamp',
      minFilter: 'linear-mipmap',
      magFilter: 'linear',
      flipY: false,
      colorSpace: 'srgb',
      userData: {
        isPaintTexture: true,
        basePixels: new Uint8Array(data),
        hadExternalMap: false,
      },
    });
    tex.needsUpdate = true;
    mat.map = tex;
    if (typeof mat.invalidate === 'function') mat.invalidate();
    return tex;
  }

  /**
   * Prepara atributo RGBA de color por vértice (`geometry.attributes.color`).
   */
  static ensureVertexColors(mesh, opts = {}) {
    if (!Painter.isPaintable(mesh) || !mesh.material) return null;
    Painter.ensureUniqueResources(mesh, opts.scene || null);
    const geo = mesh.geometry;
    const mat = mesh.material;
    const pos = geo.attributes.position;
    if (!pos) return null;
    const vCount = pos.count;

    let colAttr = geo.attributes.color;
    if (!colAttr || colAttr.count !== vCount) {
      const baseColor = mat.color ? { r: mat.color.r, g: mat.color.g, b: mat.color.b } : { r: 1, g: 1, b: 1 };
      const arr = new Float32Array(vCount * 4);
      for (let i = 0; i < vCount; i++) {
        const o = i * 4;
        arr[o] = baseColor.r;
        arr[o + 1] = baseColor.g;
        arr[o + 2] = baseColor.b;
        arr[o + 3] = 1;
      }
      colAttr = new BufferAttribute(arr, 4);
      geo.attributes.color = colAttr;
      geo._paintBaseColors = new Float32Array(arr);
      if (mat.color && typeof mat.color.setHex === 'function') {
        mat.color.setHex(0xffffff);
      }
    } else if (!geo._paintBaseColors || geo._paintBaseColors.length !== colAttr.array.length) {
      geo._paintBaseColors = new Float32Array(colAttr.array);
    }

    if (!mat.vertexColors) {
      mat.vertexColors = true;
      if (typeof mat.invalidate === 'function') mat.invalidate();
    }
    return colAttr;
  }

  /**
   * Cambia la resolución de la textura de pintura manteniendo lo ya pintado (muestreo bilineal).
   */
  static resizePaintTexture(mesh, nextResolution, scene = null) {
    const tex = Painter.ensurePaintTexture(mesh, { resolution: nextResolution, scene });
    if (!tex || !tex.mipmaps?.[0]?.data) return null;
    const oldW = tex.mipmaps[0].width;
    const oldH = tex.mipmaps[0].height;
    const target = Math.max(128, Math.min(2048, Number(nextResolution) || 1024));
    if (oldW === target && oldH === target) return tex;

    const oldData = tex.mipmaps[0].data;
    const oldBase = tex.userData?.basePixels || oldData;
    const newData = new Uint8Array(target * target * 4);
    const newBase = new Uint8Array(target * target * 4);

    const resample = (src, dst) => {
      for (let y = 0; y < target; y++) {
        const sy = Math.min(oldH - 1, Math.floor((y / target) * oldH));
        for (let x = 0; x < target; x++) {
          const sx = Math.min(oldW - 1, Math.floor((x / target) * oldW));
          const si = (sy * oldW + sx) * 4;
          const di = (y * target + x) * 4;
          dst[di] = src[si];
          dst[di + 1] = src[si + 1];
          dst[di + 2] = src[si + 2];
          dst[di + 3] = src[si + 3];
        }
      }
    };

    resample(oldData, newData);
    resample(oldBase, newBase);

    tex.mipmaps = [{ data: newData, width: target, height: target }];
    tex.width = target;
    tex.height = target;
    tex.userData.basePixels = newBase;
    tex.needsUpdate = true;
    _triCache.delete(mesh.geometry);
    return tex;
  }

  /**
   * Aplica un diff de pintura (deshacer o rehacer).
   */
  static applyDiff(cmd, useAfter = false) {
    if (!cmd || !cmd.diff) return false;
    const { diff } = cmd;
    if (diff.mode === 'texture' && cmd.texture?.mipmaps?.[0]?.data) {
      const data = cmd.texture.mipmaps[0].data;
      const src = useAfter ? diff.after : diff.before;
      const indices = diff.indices;
      if (!indices || !src) return false;
      for (let i = 0; i < indices.length; i++) {
        const po = indices[i] * 4;
        const so = i * 4;
        if (po + 3 >= data.length) continue;
        data[po] = src[so];
        data[po + 1] = src[so + 1];
        data[po + 2] = src[so + 2];
        data[po + 3] = src[so + 3];
      }
      cmd.texture.needsUpdate = true;
      return true;
    }

    if (diff.mode === 'vertex' && cmd.geometry?.attributes?.color) {
      const colAttr = cmd.geometry.attributes.color;
      const arr = colAttr.array;
      const stride = colAttr.itemSize || 4;
      const src = useAfter ? diff.after : diff.before;
      const indices = diff.indices;
      if (!indices || !src) return false;
      for (let i = 0; i < indices.length; i++) {
        const vo = indices[i] * stride;
        const so = i * stride;
        for (let k = 0; k < stride; k++) {
          arr[vo + k] = src[so + k];
        }
      }
      colAttr.needsUpdate = true;
      return true;
    }
    return false;
  }

  /**
   * Renderiza una vista previa 2D de la textura activa y las islas UV de `mesh` sobre un canvas.
   */
  static renderUvPreview(canvas, mesh, opts = {}) {
    if (!canvas || typeof canvas.getContext !== 'function') return false;
    const w = Math.max(1, Number(opts.width) || canvas.width || 256);
    const h = Math.max(1, Number(opts.height) || canvas.height || 256);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;

    ctx.clearRect(0, 0, w, h);

    // Fondo de tablero sutil
    const tile = Math.max(8, Math.round(w / 16));
    ctx.fillStyle = '#181a20';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#20232b';
    for (let y = 0; y < h; y += tile) {
      for (let x = ((y / tile) & 1) ? tile : 0; x < w; x += tile * 2) {
        ctx.fillRect(x, y, tile, tile);
      }
    }

    if (!mesh) return true;

    const mat = mesh.material;
    const tex = mat?.map || null;
    const hasMip = Boolean(tex && !tex.compressed && Array.isArray(tex.mipmaps) && tex.mipmaps[0]?.data);

    if (hasMip) {
      const mip = tex.mipmaps[0];
      const mw = mip.width;
      const mh = mip.height;
      const data = mip.data;
      if (mw > 0 && mh > 0 && data && data.length >= mw * mh * 4) {
        let scratch = Painter._uvScratchCanvas;
        if (!scratch && typeof document !== 'undefined') {
          scratch = document.createElement('canvas');
          Painter._uvScratchCanvas = scratch;
        }
        if (scratch) {
          scratch.width = mw;
          scratch.height = mh;
          const sctx = scratch.getContext('2d');
          if (sctx) {
            const imgData = sctx.createImageData(mw, mh);
            const dst = imgData.data;
            const rowBytes = mw * 4;
            if (tex.flipY === false) {
              for (let row = 0; row < mh; row++) {
                const srcOff = (mh - 1 - row) * rowBytes;
                dst.set(data.subarray(srcOff, srcOff + rowBytes), row * rowBytes);
              }
            } else {
              dst.set(data.subarray(0, mw * mh * 4));
            }
            sctx.putImageData(imgData, 0, 0);
            ctx.save();
            ctx.imageSmoothingEnabled = opts.smooth !== false;
            ctx.drawImage(scratch, 0, 0, w, h);
            ctx.restore();
          }
        }
      }
    } else if (tex?.image) {
      const img = tex.image;
      const iw = img.naturalWidth || img.videoWidth || img.width || 0;
      const ih = img.naturalHeight || img.videoHeight || img.height || 0;
      if (iw > 0 && ih > 0) {
        ctx.save();
        if (tex.flipY === false) {
          ctx.translate(0, h);
          ctx.scale(1, -1);
        }
        ctx.drawImage(img, 0, 0, w, h);
        ctx.restore();
      }
    } else if (mat?.color) {
      ctx.fillStyle = rgbToHex(mat.color.r * 255, mat.color.g * 255, mat.color.b * 255);
      ctx.fillRect(0, 0, w, h);
    }

    const geo = mesh.geometry;
    const uvAttr = geo?.attributes?.uv;
    if (!uvAttr || !uvAttr.array) return true;

    const uv = uvAttr.array;
    const idx = geo.index ? geo.index.array : null;
    const tris = idx ? (idx.length / 3) | 0 : ((uvAttr.count / 3) | 0);
    if (!tris) return true;

    // En modo color por vértice sin textura de pintura, mostrar relleno por triángulo en espacio UV
    const colAttr = geo.attributes?.color || null;
    if (!hasMip && !tex?.image && colAttr && colAttr.array && mat?.vertexColors) {
      const ca = colAttr.array;
      const cs = colAttr.itemSize || 4;
      for (let t = 0; t < tris; t++) {
        const t3 = t * 3;
        const ia = idx ? idx[t3] : t3;
        const ib = idx ? idx[t3 + 1] : t3 + 1;
        const ic = idx ? idx[t3 + 2] : t3 + 2;
        const r = Math.round(((ca[ia * cs] + ca[ib * cs] + ca[ic * cs]) / 3) * 255);
        const g = Math.round(((ca[ia * cs + 1] + ca[ib * cs + 1] + ca[ic * cs + 1]) / 3) * 255);
        const b = Math.round(((ca[ia * cs + 2] + ca[ib * cs + 2] + ca[ic * cs + 2]) / 3) * 255);
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.beginPath();
        ctx.moveTo(uv[ia * 2] * w, (1 - uv[ia * 2 + 1]) * h);
        ctx.lineTo(uv[ib * 2] * w, (1 - uv[ib * 2 + 1]) * h);
        ctx.lineTo(uv[ic * 2] * w, (1 - uv[ic * 2 + 1]) * h);
        ctx.closePath();
        ctx.fill();
      }
    }

    if (opts.showWireframe !== false) {
      const seenEdges = new Set();
      ctx.save();
      ctx.strokeStyle = opts.wireColor || 'rgba(255, 255, 255, 0.42)';
      ctx.lineWidth = Math.max(0.75, opts.lineWidth || (w >= 400 ? 1.15 : 0.8));
      ctx.beginPath();
      for (let t = 0; t < tris; t++) {
        const t3 = t * 3;
        const ia = idx ? idx[t3] : t3;
        const ib = idx ? idx[t3 + 1] : t3 + 1;
        const ic = idx ? idx[t3 + 2] : t3 + 2;
        const pairs = [[ia, ib], [ib, ic], [ic, ia]];
        for (let p = 0; p < 3; p++) {
          const e0 = pairs[p][0];
          const e1 = pairs[p][1];
          const key = e0 < e1 ? `${e0}_${e1}` : `${e1}_${e0}`;
          if (seenEdges.has(key)) continue;
          seenEdges.add(key);
          const u0 = uv[e0 * 2], v0 = uv[e0 * 2 + 1];
          const u1 = uv[e1 * 2], v1 = uv[e1 * 2 + 1];
          if (!Number.isFinite(u0) || !Number.isFinite(v0) || !Number.isFinite(u1) || !Number.isFinite(v1)) continue;
          ctx.moveTo(u0 * w, (1 - v0) * h);
          ctx.lineTo(u1 * w, (1 - v1) * h);
        }
      }
      ctx.stroke();
      ctx.restore();
    }

    return true;
  }

  /**
   * Genera un PNG Blob de la textura pintada o del canvas de mapa UV del modelo activo.
   */
  static async exportUvTextureBlob(mesh, opts = {}) {
    if (typeof document === 'undefined' || !mesh) return null;
    const tex = mesh.material?.map;
    const size = Math.max(256, tex?.mipmaps?.[0]?.width || tex?.image?.width || opts.size || 1024);
    const cv = document.createElement('canvas');
    cv.width = size;
    cv.height = size;
    Painter.renderUvPreview(cv, mesh, {
      width: size,
      height: size,
      showWireframe: Boolean(opts.includeWireframe),
      wireColor: opts.wireColor,
    });
    return await new Promise((resolve) => cv.toBlob(resolve, 'image/png'));
  }

  pickSurface(camera, ndcX, ndcY, targets) {
    if (!camera || !targets || !targets.length) return null;
    const list = Array.isArray(targets) ? targets : [targets];
    _raycaster.setFromCamera({ x: ndcX, y: ndcY }, camera);
    const hits = _raycaster.intersectObjects(list, false);
    for (let i = 0; i < hits.length; i++) {
      const hit = hits[i];
      if (!Painter.isPaintable(hit.object)) continue;
      const mesh = hit.object;
      mesh.updateWorldMatrix(true, false);
      _invMat.copyInverse(mesh.matrixWorld);
      const localPt = hit.point.clone().applyMatrix4(_invMat);
      const me = mesh.matrixWorld.elements;
      const n0 = hit.normal || { x: 0, y: 1, z: 0 };
      const localNormal = new Vec3(
        me[0] * n0.x + me[1] * n0.y + me[2] * n0.z,
        me[4] * n0.x + me[5] * n0.y + me[6] * n0.z,
        me[8] * n0.x + me[9] * n0.y + me[10] * n0.z
      ).normalize();
      return {
        mesh,
        point: hit.point.clone(),
        normal: hit.normal ? hit.normal.clone() : new Vec3(0, 1, 0),
        localPoint: localPt,
        localNormal,
        uv: hit.uv ? hit.uv.clone() : null,
        face: hit.face || null,
        faceIndex: hit.faceIndex ?? -1,
        distance: hit.distance,
      };
    }
    return null;
  }

  _buildSymmetryDabs(localPoint, localNormal) {
    const list = [{ cx: localPoint.x, cy: localPoint.y, cz: localPoint.z, nx: localNormal.x, ny: localNormal.y, nz: localNormal.z }];
    if (this.symmetry === 'x' && Math.abs(localPoint.x) > 1e-4) {
      list.push({ cx: -localPoint.x, cy: localPoint.y, cz: localPoint.z, nx: -localNormal.x, ny: localNormal.y, nz: localNormal.z });
    } else if (this.symmetry === 'y' && Math.abs(localPoint.y) > 1e-4) {
      list.push({ cx: localPoint.x, cy: -localPoint.y, cz: localPoint.z, nx: localNormal.x, ny: -localNormal.y, nz: localNormal.z });
    } else if (this.symmetry === 'z' && Math.abs(localPoint.z) > 1e-4) {
      list.push({ cx: localPoint.x, cy: localPoint.y, cz: -localPoint.z, nx: localNormal.x, ny: localNormal.y, nz: -localNormal.z });
    }
    return list;
  }

  _computeLocalRadius(mesh) {
    const e = mesh.matrixWorld.elements;
    const sx = Math.hypot(e[0], e[1], e[2]);
    const sy = Math.hypot(e[4], e[5], e[6]);
    const sz = Math.hypot(e[8], e[9], e[10]);
    const maxS = Math.max(1e-4, sx, sy, sz);
    return Math.max(0.01, this.radius / maxS);
  }

  _sampleColorAtHit(mesh, hit, scene = null) {
    const mode = this.paintMode === 'vertex' ? 'vertex' : 'texture';
    if (mode === 'vertex') {
      const colAttr = mesh.geometry?.attributes?.color;
      if (colAttr && hit.face) {
        const stride = colAttr.itemSize || 4;
        const ia = hit.face.a * stride;
        const arr = colAttr.array;
        return rgbToHex(arr[ia] * 255, arr[ia + 1] * 255, arr[ia + 2] * 255);
      }
      if (mesh.material?.color) {
        return rgbToHex(mesh.material.color.r * 255, mesh.material.color.g * 255, mesh.material.color.b * 255);
      }
      return this.color;
    }

    const tex = Painter.ensurePaintTexture(mesh, { resolution: this.resolution, scene });
    if (tex && tex.mipmaps?.[0]?.data && hit.uv) {
      const mip = tex.mipmaps[0];
      const u = wrapUnit(hit.uv.x);
      const v = wrapUnit(hit.uv.y);
      const px = Math.max(0, Math.min(mip.width - 1, Math.floor(u * mip.width)));
      const py = Math.max(0, Math.min(mip.height - 1, Math.floor(v * mip.height)));
      const o = (py * mip.width + px) * 4;
      return rgbToHex(mip.data[o], mip.data[o + 1], mip.data[o + 2]);
    }
    if (mesh.material?.color) {
      return rgbToHex(mesh.material.color.r * 255, mesh.material.color.g * 255, mesh.material.color.b * 255);
    }
    return this.color;
  }

  beginStroke(mesh, hit, camera, opts = {}) {
    if (!Painter.isPaintable(mesh) || !hit) return false;
    if (this._stroke) this.commitStroke();

    const scene = opts.scene || null;
    if (this.tool === 'picker') {
      const picked = this._sampleColorAtHit(mesh, hit, scene);
      this.setColor(picked);
      opts.onColorPick?.(this.color, mesh, hit);
      return false;
    }

    const mode = this.paintMode === 'vertex' ? 'vertex' : 'texture';
    Painter.ensureUniqueResources(mesh, scene);

    if (mode === 'vertex') {
      const colAttr = Painter.ensureVertexColors(mesh, { scene });
      if (!colAttr) return false;
      const vCount = colAttr.count;
      const startSnap = new Float32Array(colAttr.array);
      const mask = new Float32Array(vCount);
      const touchedFlag = new Uint8Array(vCount);
      const touched = [];

      this._stroke = {
        mode: 'vertex',
        tool: this.tool,
        mesh,
        geometry: mesh.geometry,
        colAttr,
        startSnap,
        baseSnap: mesh.geometry._paintBaseColors || startSnap,
        mask,
        touchedFlag,
        touched,
        rgb: parseHexColor(this.color),
        smudgeColor: null,
        lastLocal: hit.localPoint.clone(),
        lastNormal: hit.localNormal.clone(),
        camera,
      };
    } else {
      const tex = Painter.ensurePaintTexture(mesh, { resolution: this.resolution, scene });
      if (!tex || !tex.mipmaps?.[0]?.data) return false;
      const mip = tex.mipmaps[0];
      const totalPx = mip.width * mip.height;
      const startSnap = new Uint8Array(mip.data);
      const baseSnap = tex.userData?.basePixels || startSnap;

      if (!this._alphaMask || this._alphaMask.length !== totalPx || !(this._alphaMask instanceof Float32Array)) {
        this._alphaMask = new Float32Array(totalPx);
      } else {
        this._alphaMask.fill(0);
      }
      const accumData = (this.tool === 'airbrush' || this.tool === 'blur' || this.tool === 'smudge')
        ? new Float32Array(mip.data)
        : null;
      const touchedFlag = new Uint8Array(totalPx);
      const touched = [];

      this._stroke = {
        mode: 'texture',
        tool: this.tool,
        mesh,
        geometry: mesh.geometry,
        texture: tex,
        width: mip.width,
        height: mip.height,
        data: mip.data,
        accumData,
        startSnap,
        baseSnap,
        alphaMask: this._alphaMask,
        touchedFlag,
        touched,
        rgb: parseHexColor(this.color),
        smudgeColor: null,
        lastLocal: hit.localPoint.clone(),
        lastNormal: hit.localNormal.clone(),
        camera,
      };
    }

    if (this.tool === 'fill') {
      this._applyBucketFill(hit);
    } else {
      this._applyDab(hit.localPoint, hit.localNormal);
    }
    (opts.onStrokeStep || this._attached?.onStrokeStep)?.(this._stroke);
    return true;
  }

  stepStroke(camera, ndcX, ndcY, opts = {}) {
    if (!this._stroke) return null;
    if (this._stroke.tool === 'fill') return this.hover;

    const hit = this.pickSurface(camera, ndcX, ndcY, [this._stroke.mesh]);
    if (!hit) return null;

    const prev = this._stroke.lastLocal;
    const curr = hit.localPoint;
    const dist = prev.distanceTo(curr);
    const localR = this._computeLocalRadius(this._stroke.mesh);
    const stepSize = Math.max(0.002, localR * 0.08);

    if (dist > stepSize) {
      const steps = Math.min(64, Math.ceil(dist / stepSize));
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        _tmpLocal.set(
          prev.x + (curr.x - prev.x) * t,
          prev.y + (curr.y - prev.y) * t,
          prev.z + (curr.z - prev.z) * t
        );
        const n = this._stroke.lastNormal.clone().lerp(hit.localNormal, t).normalize();
        this._applyDab(_tmpLocal, n);
      }
    } else {
      this._applyDab(curr, hit.localNormal);
    }

    this._stroke.lastLocal.copy(curr);
    this._stroke.lastNormal.copy(hit.localNormal);
    (opts.onStrokeStep || this._attached?.onStrokeStep)?.(this._stroke);
    return hit;
  }

  _recordPixel(st, pxIdx) {
    if (!st.touchedFlag[pxIdx]) {
      st.touchedFlag[pxIdx] = 1;
      st.touched.push(pxIdx);
    }
  }

  _applyBucketFill(hit) {
    const st = this._stroke;
    if (!st) return;
    const [tr, tg, tb] = st.rgb;
    const alpha = Math.max(0.05, Math.min(1, Number(this.strength) || 1));

    if (st.mode === 'vertex') {
      const posAttr = st.geometry.attributes.position;
      const arr = st.colAttr.array;
      const stride = st.colAttr.itemSize || 4;
      const rF = tr / 255, gF = tg / 255, bF = tb / 255;

      // Rellenar vértices del mismo color similar o componente conectado
      const seedIdx = hit.face ? hit.face.a : 0;
      const so = seedIdx * stride;
      const sr = arr[so], sg = arr[so + 1], sb = arr[so + 2];
      const tolSq = 0.08;
      for (let i = 0; i < posAttr.count; i++) {
        const vo = i * stride;
        const dr = arr[vo] - sr, dg = arr[vo + 1] - sg, db = arr[vo + 2] - sb;
        if (dr * dr + dg * dg + db * db <= tolSq) {
          this._recordPixel(st, i);
          arr[vo] = arr[vo] + (rF - arr[vo]) * alpha;
          arr[vo + 1] = arr[vo + 1] + (gF - arr[vo + 1]) * alpha;
          arr[vo + 2] = arr[vo + 2] + (bF - arr[vo + 2]) * alpha;
          if (stride === 4) arr[vo + 3] = 1;
        }
      }
      st.colAttr.needsUpdate = true;
      return;
    }

    // Modo textura: flood fill BFS en el espacio de píxeles acotado a triángulos de la malla
    const w = st.width;
    const h = st.height;
    const data = st.data;
    const startSnap = st.startSnap;
    const triData = getPaintTriData(st.mesh, w, h);
    const owner = triData?.pixelTriOwner || null;

    const uv = hit.uv || { x: 0.5, y: 0.5 };
    const sx = Math.max(0, Math.min(w - 1, Math.floor(wrapUnit(uv.x) * w)));
    const sy = Math.max(0, Math.min(h - 1, Math.floor(wrapUnit(uv.y) * h)));
    const seed = sy * w + sx;
    const seedOff = seed * 4;
    const sr = startSnap[seedOff], sg = startSnap[seedOff + 1], sb = startSnap[seedOff + 2];
    const tol = Math.round(14 + (1 - Math.max(0, Math.min(1, this.hardness))) * 46);
    const tolSq = tol * tol * 3;

    const visited = new Uint8Array(w * h);
    const queue = [seed];
    visited[seed] = 1;
    let qHead = 0;

    while (qHead < queue.length) {
      const cur = queue[qHead++];
      const co = cur * 4;
      const cr = startSnap[co], cg = startSnap[co + 1], cb = startSnap[co + 2];
      const dr = cr - sr, dg = cg - sg, db = cb - sb;
      if (dr * dr + dg * dg + db * db > tolSq) continue;

      this._recordPixel(st, cur);
      data[co] = Math.round(cr + (tr - cr) * alpha);
      data[co + 1] = Math.round(cg + (tg - cg) * alpha);
      data[co + 2] = Math.round(cb + (tb - cb) * alpha);
      data[co + 3] = 255;

      const x = cur % w;
      const y = (cur - x) / w;
      if (x > 0) {
        const nb = cur - 1;
        if (!visited[nb] && (!owner || owner[nb] !== -1)) { visited[nb] = 1; queue.push(nb); }
      }
      if (x + 1 < w) {
        const nb = cur + 1;
        if (!visited[nb] && (!owner || owner[nb] !== -1)) { visited[nb] = 1; queue.push(nb); }
      }
      if (y > 0) {
        const nb = cur - w;
        if (!visited[nb] && (!owner || owner[nb] !== -1)) { visited[nb] = 1; queue.push(nb); }
      }
      if (y + 1 < h) {
        const nb = cur + w;
        if (!visited[nb] && (!owner || owner[nb] !== -1)) { visited[nb] = 1; queue.push(nb); }
      }
    }

    st.texture.needsUpdate = true;
  }

  _applyDab(localPoint, localNormal) {
    const st = this._stroke;
    if (!st) return;

    const localR = this._computeLocalRadius(st.mesh);
    const r2 = localR * localR;
    const symDabs = this._buildSymmetryDabs(localPoint, localNormal);
    const strength = Math.max(0.02, Math.min(1, Number(this.strength) || 0.5));
    const hardness = Math.max(0, Math.min(1, Number(this.hardness) ?? 0.45));

    if (st.mode === 'vertex') {
      this._applyVertexDab(st, symDabs, localR, r2, strength, hardness);
      return;
    }
    this._applyTextureDab(st, symDabs, localR, r2, strength, hardness);
  }

  _applyVertexDab(st, symDabs, localR, r2, strength, hardness) {
    const triData = getPaintTriData(st.mesh, 0, 0);
    if (!triData) return;
    const posArr = triData.posArr;
    const norArr = triData.norArr;
    const vCount = (posArr.length / 3) | 0;
    const arr = st.colAttr.array;
    const stride = st.colAttr.itemSize || 4;
    const startSnap = st.startSnap;
    const baseSnap = st.baseSnap;
    const mask = st.mask;
    const tool = st.tool;
    const [tr, tg, tb] = st.rgb;
    const targetR = tr / 255, targetG = tg / 255, targetB = tb / 255;

    if (tool === 'smudge' && !st.smudgeColor) {
      let bestI = 0;
      let bestD2 = Infinity;
      const d0 = symDabs[0];
      for (let i = 0; i < vCount; i++) {
        const o = i * 3;
        const dx = posArr[o] - d0.cx, dy = posArr[o + 1] - d0.cy, dz = posArr[o + 2] - d0.cz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bestD2) { bestD2 = d2; bestI = i; }
      }
      const bo = bestI * stride;
      st.smudgeColor = [arr[bo], arr[bo + 1], arr[bo + 2]];
    }

    let avgR = 0, avgG = 0, avgB = 0, avgW = 0;
    if (tool === 'blur') {
      for (let i = 0; i < vCount; i++) {
        const o = i * 3;
        const vx = posArr[o], vy = posArr[o + 1], vz = posArr[o + 2];
        let bestF = 0;
        for (let s = 0; s < symDabs.length; s++) {
          const d = symDabs[s];
          const dx = vx - d.cx, dy = vy - d.cy, dz = vz - d.cz;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < r2) {
            const f = evalBrushFalloff(Math.sqrt(d2) / localR, hardness);
            if (f > bestF) bestF = f;
          }
        }
        if (bestF > 0) {
          const co = i * stride;
          avgR += arr[co] * bestF;
          avgG += arr[co + 1] * bestF;
          avgB += arr[co + 2] * bestF;
          avgW += bestF;
        }
      }
      if (avgW > 0) { avgR /= avgW; avgG /= avgW; avgB /= avgW; }
    }

    let changed = false;
    for (let i = 0; i < vCount; i++) {
      const o = i * 3;
      const vx = posArr[o], vy = posArr[o + 1], vz = posArr[o + 2];
      let bestF = 0;
      for (let s = 0; s < symDabs.length; s++) {
        const d = symDabs[s];
        const dx = vx - d.cx, dy = vy - d.cy, dz = vz - d.cz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= r2) continue;
        if (this.frontFacesOnly && norArr) {
          const dot = norArr[o] * d.nx + norArr[o + 1] * d.ny + norArr[o + 2] * d.nz;
          if (dot < -0.15) continue;
        }
        const f = evalBrushFalloff(Math.sqrt(d2) / localR, hardness);
        if (f > bestF) bestF = f;
      }
      if (bestF <= 0) continue;

      this._recordPixel(st, i);
      const co = i * stride;
      if (tool === 'airbrush') {
        const a = Math.min(1, bestF * strength * 0.35);
        arr[co] += (targetR - arr[co]) * a;
        arr[co + 1] += (targetG - arr[co + 1]) * a;
        arr[co + 2] += (targetB - arr[co + 2]) * a;
      } else if (tool === 'blur' && avgW > 0) {
        const a = Math.min(1, bestF * strength * 0.45);
        arr[co] += (avgR - arr[co]) * a;
        arr[co + 1] += (avgG - arr[co + 1]) * a;
        arr[co + 2] += (avgB - arr[co + 2]) * a;
      } else if (tool === 'smudge' && st.smudgeColor) {
        const a = Math.min(1, bestF * strength * 0.55);
        const or = arr[co], og = arr[co + 1], ob = arr[co + 2];
        arr[co] = or + (st.smudgeColor[0] - or) * a;
        arr[co + 1] = og + (st.smudgeColor[1] - og) * a;
        arr[co + 2] = ob + (st.smudgeColor[2] - ob) * a;
        st.smudgeColor[0] += (or - st.smudgeColor[0]) * 0.08 * bestF;
        st.smudgeColor[1] += (og - st.smudgeColor[1]) * 0.08 * bestF;
        st.smudgeColor[2] += (ob - st.smudgeColor[2]) * 0.08 * bestF;
      } else if (tool === 'eraser') {
        const nextA = Math.min(1, bestF * strength);
        if (nextA > mask[i]) mask[i] = nextA;
        const a = mask[i];
        arr[co] = startSnap[co] + (baseSnap[co] - startSnap[co]) * a;
        arr[co + 1] = startSnap[co + 1] + (baseSnap[co + 1] - startSnap[co + 1]) * a;
        arr[co + 2] = startSnap[co + 2] + (baseSnap[co + 2] - startSnap[co + 2]) * a;
      } else {
        const nextA = Math.min(1, bestF * strength);
        if (nextA > mask[i]) mask[i] = nextA;
        const a = mask[i];
        arr[co] = startSnap[co] + (targetR - startSnap[co]) * a;
        arr[co + 1] = startSnap[co + 1] + (targetG - startSnap[co + 1]) * a;
        arr[co + 2] = startSnap[co + 2] + (targetB - startSnap[co + 2]) * a;
      }
      if (stride === 4) arr[co + 3] = 1;
      changed = true;
    }

    if (changed) st.colAttr.needsUpdate = true;
  }

  _applyTextureDab(st, symDabs, localR, r2, strength, hardness) {
    const w = st.width;
    const h = st.height;
    const triData = getPaintTriData(st.mesh, w, h);
    if (!triData || !triData.uvArr) return;

    const { tris, idx, posArr, uvArr, triAabb, triFaceNormal } = triData;
    const data = st.data;
    const startSnap = st.startSnap;
    const baseSnap = st.baseSnap;
    const alphaMask = st.alphaMask;
    const tool = st.tool;
    const [tr, tg, tb] = st.rgb;

    // Para smudge, inicializar color arrastrado desde el primer punto del trazo
    if (tool === 'smudge' && !st.smudgeColor) {
      const d0 = symDabs[0];
      let sampleX = 0, sampleY = 0;
      let bestDist2 = Infinity;
      for (let t = 0; t < tris; t++) {
        const b6 = t * 6;
        const cx = Math.max(triAabb[b6], Math.min(d0.cx, triAabb[b6 + 3]));
        const cy = Math.max(triAabb[b6 + 1], Math.min(d0.cy, triAabb[b6 + 4]));
        const cz = Math.max(triAabb[b6 + 2], Math.min(d0.cz, triAabb[b6 + 5]));
        const d2 = (cx - d0.cx) ** 2 + (cy - d0.cy) ** 2 + (cz - d0.cz) ** 2;
        if (d2 < bestDist2) {
          bestDist2 = d2;
          const t3 = t * 3;
          const ia = (idx ? idx[t3] : t3) * 2;
          sampleX = Math.max(0, Math.min(w - 1, Math.floor(wrapUnit(uvArr[ia]) * w)));
          sampleY = Math.max(0, Math.min(h - 1, Math.floor(wrapUnit(uvArr[ia + 1]) * h)));
        }
      }
      const so = (sampleY * w + sampleX) * 4;
      st.smudgeColor = [data[so], data[so + 1], data[so + 2]];
    }

    const dabWritten = new Set();
    let anyChanged = false;

    for (let t = 0; t < tris; t++) {
      const b6 = t * 6;
      const minX = triAabb[b6], minY = triAabb[b6 + 1], minZ = triAabb[b6 + 2];
      const maxX = triAabb[b6 + 3], maxY = triAabb[b6 + 4], maxZ = triAabb[b6 + 5];

      // Descarte AABB contra esferas de simetría
      const t3 = t * 3;
      const fnx = triFaceNormal[t3], fny = triFaceNormal[t3 + 1], fnz = triFaceNormal[t3 + 2];
      let triNear = false;
      for (let s = 0; s < symDabs.length; s++) {
        const d = symDabs[s];
        const cx = d.cx < minX ? minX : d.cx > maxX ? maxX : d.cx;
        const cy = d.cy < minY ? minY : d.cy > maxY ? maxY : d.cy;
        const cz = d.cz < minZ ? minZ : d.cz > maxZ ? maxZ : d.cz;
        const dx = cx - d.cx, dy = cy - d.cy, dz = cz - d.cz;
        if (dx * dx + dy * dy + dz * dz <= r2) {
          if (!this.frontFacesOnly || (fnx * d.nx + fny * d.ny + fnz * d.nz) >= -0.15) {
            triNear = true;
            break;
          }
        }
      }
      if (!triNear) continue;

      const ia = idx ? idx[t3] : t3;
      const ib = idx ? idx[t3 + 1] : t3 + 1;
      const ic = idx ? idx[t3 + 2] : t3 + 2;

      const pa = ia * 3, pb = ib * 3, pc = ic * 3;
      const ax = posArr[pa], ay = posArr[pa + 1], az = posArr[pa + 2];
      const bx = posArr[pb], by = posArr[pb + 1], bz = posArr[pb + 2];
      const cx = posArr[pc], cy = posArr[pc + 1], cz = posArr[pc + 2];

      const uva = ia * 2, uvb = ib * 2, uvc = ic * 2;
      const ua = uvArr[uva], va = uvArr[uva + 1];
      const ub = uvArr[uvb], vb = uvArr[uvb + 1];
      const uc = uvArr[uvc], vc = uvArr[uvc + 1];

      const u0x = ub - ua, u0y = vb - va;
      const u1x = uc - ua, u1y = vc - va;
      const det = u0x * u1y - u1x * u0y;
      if (Math.abs(det) < 1e-10) continue;
      const invDet = 1 / det;

      const minU = Math.min(ua, ub, uc);
      const maxU = Math.max(ua, ub, uc);
      const minV = Math.min(va, vb, vc);
      const maxV = Math.max(va, vb, vc);

      const x0 = Math.max(0, Math.floor(minU * w) - 1);
      const x1 = Math.min(w - 1, Math.ceil(maxU * w) + 1);
      const y0 = Math.max(0, Math.floor(minV * h) - 1);
      const y1 = Math.min(h - 1, Math.ceil(maxV * h) + 1);

      // Tolerancia de 1.25 px para rellenar costuras sin provocar grietas entre islas UV
      const triUvSpan = Math.max(1e-4, Math.max((maxU - minU) * w, (maxV - minV) * h));
      const baryPad = -Math.min(0.08, 1.35 / triUvSpan);

      for (let py = y0; py <= y1; py++) {
        const pv = (py + 0.5) / h;
        const rowOff = py * w;
        for (let px = x0; px <= x1; px++) {
          const pxIdx = rowOff + px;
          const pu = (px + 0.5) / w;
          const du = pu - ua, dv = pv - va;
          let w1 = (du * u1y - u1x * dv) * invDet;
          let w2 = (u0x * dv - du * u0y) * invDet;
          let w0 = 1 - w1 - w2;
          const strictlyInside = w0 >= 0 && w1 >= 0 && w2 >= 0;
          if (!strictlyInside) {
            if (w0 < baryPad || w1 < baryPad || w2 < baryPad) continue;
            if (dabWritten.has(pxIdx)) continue;
            // Clamping barycéntrico para proyectar limpiamente bordes de costura
            w0 = Math.max(0, w0);
            w1 = Math.max(0, w1);
            w2 = Math.max(0, w2);
            const ws = w0 + w1 + w2 || 1;
            w0 /= ws; w1 /= ws; w2 /= ws;
          }

          const wx = ax * w0 + bx * w1 + cx * w2;
          const wy = ay * w0 + by * w1 + cy * w2;
          const wz = az * w0 + bz * w1 + cz * w2;

          let bestF = 0;
          for (let s = 0; s < symDabs.length; s++) {
            const d = symDabs[s];
            const ddx = wx - d.cx, ddy = wy - d.cy, ddz = wz - d.cz;
            const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
            if (d2 >= r2) continue;
            if (this.frontFacesOnly && (fnx * d.nx + fny * d.ny + fnz * d.nz) < -0.15) continue;
            const f = evalBrushFalloff(Math.sqrt(d2) / localR, hardness);
            if (f > bestF) bestF = f;
          }
          if (bestF <= 0) continue;
          if (!strictlyInside && dabWritten.has(pxIdx)) continue;
          if (strictlyInside) dabWritten.add(pxIdx);

          this._recordPixel(st, pxIdx);
          const po = pxIdx * 4;
          const acc = st.accumData;

          if (tool === 'airbrush') {
            const a = Math.min(1, bestF * strength * 0.24);
            const baseBuf = acc || data;
            const nr = baseBuf[po] + (tr - baseBuf[po]) * a;
            const ng = baseBuf[po + 1] + (tg - baseBuf[po + 1]) * a;
            const nb = baseBuf[po + 2] + (tb - baseBuf[po + 2]) * a;
            if (acc) { acc[po] = nr; acc[po + 1] = ng; acc[po + 2] = nb; acc[po + 3] = 255; }
            data[po] = Math.round(nr);
            data[po + 1] = Math.round(ng);
            data[po + 2] = Math.round(nb);
            data[po + 3] = 255;
          } else if (tool === 'blur') {
            const a = Math.min(1, bestF * strength * 0.35);
            const srcBuf = acc || data;
            let sr = 0, sg = 0, sb = 0, sw = 0;
            for (let oy = -1; oy <= 1; oy++) {
              const ny = py + oy;
              if (ny < 0 || ny >= h) continue;
              const wy = oy === 0 ? 2 : 1;
              for (let ox = -1; ox <= 1; ox++) {
                const nx = px + ox;
                if (nx < 0 || nx >= w) continue;
                const kw = wy * (ox === 0 ? 2 : 1);
                const no = (ny * w + nx) * 4;
                sr += srcBuf[no] * kw;
                sg += srcBuf[no + 1] * kw;
                sb += srcBuf[no + 2] * kw;
                sw += kw;
              }
            }
            if (sw > 0) {
              const nr = srcBuf[po] + (sr / sw - srcBuf[po]) * a;
              const ng = srcBuf[po + 1] + (sg / sw - srcBuf[po + 1]) * a;
              const nb = srcBuf[po + 2] + (sb / sw - srcBuf[po + 2]) * a;
              if (acc) { acc[po] = nr; acc[po + 1] = ng; acc[po + 2] = nb; acc[po + 3] = 255; }
              data[po] = Math.round(nr);
              data[po + 1] = Math.round(ng);
              data[po + 2] = Math.round(nb);
              data[po + 3] = 255;
            }
          } else if (tool === 'smudge' && st.smudgeColor) {
            const a = Math.min(1, bestF * strength * 0.42);
            const srcBuf = acc || data;
            const or = srcBuf[po], og = srcBuf[po + 1], ob = srcBuf[po + 2];
            const nr = or + (st.smudgeColor[0] - or) * a;
            const ng = og + (st.smudgeColor[1] - og) * a;
            const nb = ob + (st.smudgeColor[2] - ob) * a;
            if (acc) { acc[po] = nr; acc[po + 1] = ng; acc[po + 2] = nb; acc[po + 3] = 255; }
            data[po] = Math.round(nr);
            data[po + 1] = Math.round(ng);
            data[po + 2] = Math.round(nb);
            data[po + 3] = 255;
            const mix = 0.03 * bestF;
            st.smudgeColor[0] += (or - st.smudgeColor[0]) * mix;
            st.smudgeColor[1] += (og - st.smudgeColor[1]) * mix;
            st.smudgeColor[2] += (ob - st.smudgeColor[2]) * mix;
          } else if (tool === 'eraser') {
            const nextA = Math.min(1, bestF * strength);
            if (nextA > alphaMask[pxIdx]) alphaMask[pxIdx] = nextA;
            const a = alphaMask[pxIdx];
            data[po] = Math.round(startSnap[po] + (baseSnap[po] - startSnap[po]) * a);
            data[po + 1] = Math.round(startSnap[po + 1] + (baseSnap[po + 1] - startSnap[po + 1]) * a);
            data[po + 2] = Math.round(startSnap[po + 2] + (baseSnap[po + 2] - startSnap[po + 2]) * a);
            data[po + 3] = 255;
          } else {
            const nextA = Math.min(1, bestF * strength);
            if (nextA > alphaMask[pxIdx]) alphaMask[pxIdx] = nextA;
            const a = alphaMask[pxIdx];
            data[po] = Math.round(startSnap[po] + (tr - startSnap[po]) * a);
            data[po + 1] = Math.round(startSnap[po + 1] + (tg - startSnap[po + 1]) * a);
            data[po + 2] = Math.round(startSnap[po + 2] + (tb - startSnap[po + 2]) * a);
            data[po + 3] = 255;
          }
          anyChanged = true;
        }
      }
    }

    if (anyChanged) {
      st.texture.needsUpdate = true;
    }
  }

  commitStroke() {
    const st = this._stroke;
    if (!st) return null;
    this._stroke = null;

    if (!st.touched.length) return null;
    const indices = new Uint32Array(st.touched);

    if (st.mode === 'vertex') {
      const stride = st.colAttr.itemSize || 4;
      const before = new Float32Array(indices.length * stride);
      const after = new Float32Array(indices.length * stride);
      const cur = st.colAttr.array;
      let dirty = false;
      for (let i = 0; i < indices.length; i++) {
        const vo = indices[i] * stride;
        const doff = i * stride;
        for (let k = 0; k < stride; k++) {
          before[doff + k] = st.startSnap[vo + k];
          after[doff + k] = cur[vo + k];
          if (Math.abs(before[doff + k] - after[doff + k]) > 1e-5) dirty = true;
        }
      }
      if (!dirty) return null;
      return {
        mesh: st.mesh,
        geometry: st.geometry,
        diff: { mode: 'vertex', indices, before, after },
      };
    }

    const before = new Uint8Array(indices.length * 4);
    const after = new Uint8Array(indices.length * 4);
    const cur = st.data;
    let dirty = false;
    for (let i = 0; i < indices.length; i++) {
      const po = indices[i] * 4;
      const doff = i * 4;
      for (let k = 0; k < 4; k++) {
        before[doff + k] = st.startSnap[po + k];
        after[doff + k] = cur[po + k];
        if (before[doff + k] !== after[doff + k]) dirty = true;
      }
    }
    if (!dirty) return null;
    return {
      mesh: st.mesh,
      geometry: st.geometry,
      texture: st.texture,
      diff: { mode: 'texture', indices, before, after },
    };
  }

  cancelStroke() {
    const st = this._stroke;
    if (!st) return false;
    this._stroke = null;
    if (st.mode === 'vertex') {
      st.colAttr.array.set(st.startSnap);
      st.colAttr.needsUpdate = true;
    } else if (st.texture && st.data) {
      st.data.set(st.startSnap);
      st.texture.needsUpdate = true;
    }
    return true;
  }

  /**
   * Rellena toda la malla activa con el color indicado (o actual) y devuelve descriptor de historial.
   */
  fillAll(mesh, colorHex = this.color, scene = null) {
    if (!Painter.isPaintable(mesh)) return null;
    Painter.ensureUniqueResources(mesh, scene);
    const [tr, tg, tb] = parseHexColor(colorHex);
    const mode = this.paintMode === 'vertex' ? 'vertex' : 'texture';

    if (mode === 'vertex') {
      const colAttr = Painter.ensureVertexColors(mesh, { scene });
      if (!colAttr) return null;
      const count = colAttr.count;
      const stride = colAttr.itemSize || 4;
      const arr = colAttr.array;
      const before = new Float32Array(arr);
      const rF = tr / 255, gF = tg / 255, bF = tb / 255;
      for (let i = 0; i < count; i++) {
        const o = i * stride;
        arr[o] = rF; arr[o + 1] = gF; arr[o + 2] = bF;
        if (stride === 4) arr[o + 3] = 1;
      }
      colAttr.needsUpdate = true;
      const indices = new Uint32Array(count);
      for (let i = 0; i < count; i++) indices[i] = i;
      return {
        mesh,
        geometry: mesh.geometry,
        diff: { mode: 'vertex', indices, before, after: new Float32Array(arr) },
      };
    }

    const tex = Painter.ensurePaintTexture(mesh, { resolution: this.resolution, scene });
    if (!tex || !tex.mipmaps?.[0]?.data) return null;
    const data = tex.mipmaps[0].data;
    const before = new Uint8Array(data);
    const total = (data.length / 4) | 0;
    const indices = new Uint32Array(total);
    for (let i = 0; i < total; i++) {
      indices[i] = i;
      const o = i * 4;
      data[o] = tr; data[o + 1] = tg; data[o + 2] = tb; data[o + 3] = 255;
    }
    tex.needsUpdate = true;
    return {
      mesh,
      geometry: mesh.geometry,
      texture: tex,
      diff: { mode: 'texture', indices, before, after: new Uint8Array(data) },
    };
  }

  /**
   * Restaura la pintura al estado base inicial y devuelve descriptor de historial.
   */
  clearPaint(mesh, scene = null) {
    if (!Painter.isPaintable(mesh)) return null;
    const mode = this.paintMode === 'vertex' ? 'vertex' : 'texture';

    if (mode === 'vertex') {
      const colAttr = mesh.geometry?.attributes?.color;
      if (!colAttr) return null;
      const base = mesh.geometry._paintBaseColors;
      const before = new Float32Array(colAttr.array);
      const count = colAttr.count;
      const indices = new Uint32Array(count);
      if (base && base.length === colAttr.array.length) {
        colAttr.array.set(base);
      } else {
        colAttr.array.fill(1);
      }
      for (let i = 0; i < count; i++) indices[i] = i;
      colAttr.needsUpdate = true;
      return {
        mesh,
        geometry: mesh.geometry,
        diff: { mode: 'vertex', indices, before, after: new Float32Array(colAttr.array) },
      };
    }

    const tex = mesh.material?.map;
    if (!tex || !tex.userData?.isPaintTexture || !tex.mipmaps?.[0]?.data) {
      Painter.ensurePaintTexture(mesh, { resolution: this.resolution, scene });
      return null;
    }
    const data = tex.mipmaps[0].data;
    const base = tex.userData.basePixels;
    if (!base || base.length !== data.length) return null;
    const before = new Uint8Array(data);
    data.set(base);
    tex.needsUpdate = true;
    const total = (data.length / 4) | 0;
    const indices = new Uint32Array(total);
    for (let i = 0; i < total; i++) indices[i] = i;
    return {
      mesh,
      geometry: mesh.geometry,
      texture: tex,
      diff: { mode: 'texture', indices, before, after: new Uint8Array(data) },
    };
  }

  drawCursor(ctx, camera, width, height) {
    const hit = this.hover;
    if (!ctx || !camera || !hit || !hit.point) return;

    const toolColor = this.tool === 'eraser' ? '#f8fafc' : this.color;
    const isSpecial = this.tool === 'picker' || this.tool === 'fill';

    const drawRing3D = (center, normal, rWorld, dashed = false, alpha = 1) => {
      const n = normal || new Vec3(0, 1, 0);
      const ref = Math.abs(n.y) < 0.9 ? _vTanRef.set(0, 1, 0) : _vTanRef.set(1, 0, 0);
      _tan.crossVectors(ref, n).normalize();
      _bitan.crossVectors(n, _tan).normalize();

      const steps = 40;
      const strokeLoop = (lw, color, globalAlpha, dashArr = null) => {
        ctx.save();
        ctx.globalAlpha = globalAlpha;
        ctx.strokeStyle = color;
        ctx.lineWidth = lw;
        if (dashArr) ctx.setLineDash(dashArr);
        ctx.beginPath();
        let started = false;
        for (let i = 0; i <= steps; i++) {
          const a = (i / steps) * Math.PI * 2;
          const ca = Math.cos(a) * rWorld;
          const sa = Math.sin(a) * rWorld;
          _proj.set(
            center.x + _tan.x * ca + _bitan.x * sa,
            center.y + _tan.y * ca + _bitan.y * sa,
            center.z + _tan.z * ca + _bitan.z * sa
          ).project(camera);
          if (!Number.isFinite(_proj.x) || !Number.isFinite(_proj.y) || _proj.z < -1 || _proj.z > 1) {
            started = false;
            continue;
          }
          const sx = (_proj.x * 0.5 + 0.5) * width;
          const sy = (-_proj.y * 0.5 + 0.5) * height;
          if (!started) { ctx.moveTo(sx, sy); started = true; }
          else ctx.lineTo(sx, sy);
        }
        ctx.stroke();
        ctx.restore();
      };

      const dash = dashed || this.tool === 'eraser' || this.tool === 'fill' ? [5, 4] : null;
      strokeLoop(dashed ? 2.6 : 3.6, 'rgba(0, 0, 0, 0.72)', alpha * 0.85, dash);
      strokeLoop(dashed ? 1.5 : 2.1, toolColor, alpha, dash);

      if (!dashed && !isSpecial) {
        const ir = rWorld * Math.max(0.14, Math.min(0.92, this.strength));
        ctx.save();
        ctx.globalAlpha = 0.48;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        let started = false;
        for (let i = 0; i <= 28; i++) {
          const a = (i / 28) * Math.PI * 2;
          const ca = Math.cos(a) * ir;
          const sa = Math.sin(a) * ir;
          _proj.set(
            center.x + _tan.x * ca + _bitan.x * sa,
            center.y + _tan.y * ca + _bitan.y * sa,
            center.z + _tan.z * ca + _bitan.z * sa
          ).project(camera);
          if (!Number.isFinite(_proj.x) || !Number.isFinite(_proj.y) || _proj.z < -1 || _proj.z > 1) {
            started = false;
            continue;
          }
          const sx = (_proj.x * 0.5 + 0.5) * width;
          const sy = (-_proj.y * 0.5 + 0.5) * height;
          if (!started) { ctx.moveTo(sx, sy); started = true; }
          else ctx.lineTo(sx, sy);
        }
        ctx.stroke();
        ctx.restore();
      }

      if (!dashed) {
        _proj.copy(center).project(camera);
        if (Number.isFinite(_proj.x) && Number.isFinite(_proj.y) && _proj.z >= -1 && _proj.z <= 1) {
          const cx2 = (_proj.x * 0.5 + 0.5) * width;
          const cy2 = (-_proj.y * 0.5 + 0.5) * height;
          ctx.save();
          ctx.fillStyle = 'rgba(0,0,0,0.65)';
          ctx.beginPath();
          ctx.arc(cx2, cy2, isSpecial ? 4.4 : 3.6, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = toolColor;
          ctx.beginPath();
          ctx.arc(cx2, cy2, isSpecial ? 3.2 : 2.4, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      }
    };

    const rWorld = isSpecial ? Math.max(0.06, Math.min(0.14, this.radius * 0.3)) : this.radius;
    drawRing3D(hit.point, hit.normal, rWorld, false, 0.96);

    if (this.symmetry !== 'none' && !isSpecial && hit.localPoint && hit.mesh) {
      const symLocal = hit.localPoint.clone();
      const symN = (hit.localNormal || new Vec3(0, 1, 0)).clone();
      if (this.symmetry === 'x') { symLocal.x = -symLocal.x; symN.x = -symN.x; }
      else if (this.symmetry === 'y') { symLocal.y = -symLocal.y; symN.y = -symN.y; }
      else if (this.symmetry === 'z') { symLocal.z = -symLocal.z; symN.z = -symN.z; }
      if (symLocal.distanceTo(hit.localPoint) > 1e-3) {
        const symWorld = symLocal.applyMatrix4(hit.mesh.matrixWorld);
        const me = hit.mesh.matrixWorld.elements;
        const symWorldN = new Vec3(
          me[0] * symN.x + me[4] * symN.y + me[8] * symN.z,
          me[1] * symN.x + me[5] * symN.y + me[9] * symN.z,
          me[2] * symN.x + me[6] * symN.y + me[10] * symN.z
        ).normalize();
        drawRing3D(symWorld, symWorldN, rWorld, true, 0.65);
      }
    }
  }

  renderOverlay(canvas, camera, opts = {}) {
    if (!canvas || canvas.hidden || !camera) return false;
    const refEl = opts.referenceElement || canvas;
    const cssW = Math.max(1, opts.width || refEl.clientWidth || canvas.clientWidth || canvas.width || 1);
    const cssH = Math.max(1, opts.height || refEl.clientHeight || canvas.clientHeight || canvas.height || 1);
    const dpr = Math.min((typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1, opts.maxDpr ?? 2);
    const bw = Math.round(cssW * dpr);
    const bh = Math.round(cssH * dpr);
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    if (this.hover) {
      this.drawCursor(ctx, camera, cssW, cssH);
    }
    return true;
  }

  drawAttachedOverlay(camera) {
    const cfg = this._attached;
    if (!this.enabled || !cfg || !cfg.overlay || cfg.overlay.hidden || !camera) return false;
    const targetEl = typeof cfg.pointerDownTarget === 'function'
      ? cfg.pointerDownTarget()
      : (cfg.pointerDownTarget || cfg.domElement);
    return this.renderOverlay(cfg.overlay, camera, {
      referenceElement: cfg.referenceElement || targetEl,
    });
  }

  _releasePointerCapture(pointerId = this._activePointerId) {
    if (this._captureEl && pointerId !== null && pointerId !== undefined) {
      try {
        if (this._captureEl.hasPointerCapture?.(pointerId)) {
          this._captureEl.releasePointerCapture(pointerId);
        }
      } catch (_) {}
    }
    this._captureEl = null;
  }

  attach(opts = {}) {
    this.detach();
    const domElement = opts.domElement;
    if (!domElement) return this;
    this._attached = opts;

    const resolveTarget = () =>
      (typeof opts.pointerDownTarget === 'function' ? opts.pointerDownTarget() : opts.pointerDownTarget) || domElement;
    const resolveCamera = () => (typeof opts.getCamera === 'function' ? opts.getCamera() : opts.camera);
    const resolveControls = () => (typeof opts.getControls === 'function' ? opts.getControls() : opts.controls);
    const resolveScene = () => (typeof opts.getScene === 'function' ? opts.getScene() : opts.scene);
    const resolveControlsEnabled = () =>
      typeof opts.getControlsEnabled === 'function' ? Boolean(opts.getControlsEnabled()) : true;

    const toNdc = (e) => {
      const targetEl = resolveTarget() || domElement;
      const [nx, ny] = clientToLocalPoint(targetEl, e, 1, 1);
      return { x: nx * 2 - 1, y: -ny * 2 + 1 };
    };

    const emitStrokeEnd = (res) => {
      if (res && typeof opts.onStrokeEnd === 'function') opts.onStrokeEnd(res);
    };

    const onPointerDown = (e) => {
      const targetEl = resolveTarget();
      if (targetEl && e.target !== targetEl) return;
      this._pointers.add(e.pointerId);
      if (!this.enabled) return;

      const ctrl = resolveControls();
      if (this._pointers.size > 1) {
        if (this.isStroking) {
          const res = this.commitStroke();
          emitStrokeEnd(res);
          this._releasePointerCapture();
          this._activePointerId = null;
        }
        if (ctrl) ctrl.enabled = true;
        return;
      }

      if (e.pointerType === 'mouse' && e.button !== 0) {
        if (ctrl) ctrl.enabled = true;
        return;
      }

      const targets = typeof opts.getTargets === 'function' ? opts.getTargets() : (opts.targets || []);
      const cam = resolveCamera();
      if (!targets.length || !cam) {
        if (ctrl) ctrl.enabled = true;
        return;
      }

      const { x: ndcX, y: ndcY } = toNdc(e);
      const hit = this.pickSurface(cam, ndcX, ndcY, targets);
      if (!hit) {
        if (ctrl) ctrl.enabled = true;
        return;
      }

      e.preventDefault();
      if (ctrl) ctrl.enabled = false;
      this.hover = hit;
      opts.onSelect?.(hit.mesh, hit);

      const scene = resolveScene();
      const started = this.beginStroke(hit.mesh, hit, cam, {
        scene,
        onColorPick: opts.onColorPick,
        onStrokeStep: opts.onStrokeStep,
      });

      if (started) {
        this._activePointerId = e.pointerId;
        this._captureEl = targetEl || domElement;
        try {
          this._captureEl.setPointerCapture(e.pointerId);
        } catch (_) {}
      } else if (ctrl) {
        ctrl.enabled = resolveControlsEnabled();
      }
    };

    const onPointerMove = (e) => {
      if (!this.enabled) return;
      const cam = resolveCamera();
      if (!cam) return;
      const { x: ndcX, y: ndcY } = toNdc(e);

      if (this.isStroking && e.pointerId === this._activePointerId) {
        const hit = this.stepStroke(cam, ndcX, ndcY, { onStrokeStep: opts.onStrokeStep });
        if (hit) this.hover = hit;
        return;
      }

      if (!this.isStroking && e.pointerType !== 'touch') {
        const targets = typeof opts.getTargets === 'function' ? opts.getTargets() : (opts.targets || []);
        this.hover = targets.length ? this.pickSurface(cam, ndcX, ndcY, targets) : null;
      }
    };

    const finishPointer = (e) => {
      this._pointers.delete(e.pointerId);
      if (!this.enabled) return;
      if (e.pointerId === this._activePointerId) {
        this._activePointerId = null;
        const res = this.commitStroke();
        emitStrokeEnd(res);
        const ctrl = resolveControls();
        if (ctrl) ctrl.enabled = resolveControlsEnabled();
        this._releasePointerCapture(e.pointerId);
        if (e.pointerType === 'touch') this.hover = null;
      }
    };

    const onPointerLeave = () => {
      if (!this.isStroking) this.hover = null;
    };

    const onKeyDown = (e) => {
      if (!this.enabled) return;
      if (e.key === 'Escape' && !e.defaultPrevented && opts.exitOnEscape !== false) {
        e.preventDefault();
        if (this.isStroking) {
          this.cancelStroke();
          this._releasePointerCapture(this._activePointerId);
          this._activePointerId = null;
          const ctrl = resolveControls();
          if (ctrl) ctrl.enabled = resolveControlsEnabled();
          opts.onStrokeCancel?.();
        } else {
          opts.onExit?.();
        }
        return;
      }

      if (opts.handleHotkeys !== false && (e.key === '[' || e.key === ']')) {
        const tag = typeof document !== 'undefined' ? document.activeElement?.tagName : '';
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
        e.preventDefault();
        const nextR = e.key === '[' ? Math.max(0.05, this.radius * 0.85) : Math.min(2.5, this.radius * 1.18);
        this.radius = Number(nextR.toFixed(2));
        opts.onRadiusChange?.(this.radius);
      }
    };

    const onBlur = () => {
      this._pointers.clear();
    };

    domElement.addEventListener('pointerdown', onPointerDown, { capture: true });
    domElement.addEventListener('pointermove', onPointerMove);
    domElement.addEventListener('pointerup', finishPointer);
    domElement.addEventListener('pointercancel', finishPointer);
    domElement.addEventListener('pointerleave', onPointerLeave);
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('blur', onBlur);
    }

    this._cleanup = () => {
      domElement.removeEventListener('pointerdown', onPointerDown, { capture: true });
      domElement.removeEventListener('pointermove', onPointerMove);
      domElement.removeEventListener('pointerup', finishPointer);
      domElement.removeEventListener('pointercancel', finishPointer);
      domElement.removeEventListener('pointerleave', onPointerLeave);
      if (typeof window !== 'undefined') {
        window.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('blur', onBlur);
      }
    };
    return this;
  }

  detach() {
    if (this._cleanup) {
      this._cleanup();
      this._cleanup = null;
    }
    this._releasePointerCapture();
    this._activePointerId = null;
    this._pointers.clear();
    this._attached = null;
    return this;
  }
}
