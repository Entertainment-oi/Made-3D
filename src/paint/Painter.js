import { Vec3 } from '../math/Vec3.js';
import { Mat4 } from '../math/Mat4.js';
import { Raycaster } from '../core/Raycaster.js';
import { clientToLocalPoint } from '../core/viewportCoords.js';
import { BufferAttribute } from '../geometry/BufferAttribute.js';
import { Texture } from '../textures/Texture.js';

export const PAINT_TOOLS = ['brush', 'airbrush', 'blur', 'smudge', 'fill', 'eraser', 'picker'];
export const PAINT_BRUSH_PRESETS = ['round', 'hard', 'soft', 'chisel', 'stipple', 'splatter', 'pixel', 'rake'];
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
const _tmpNormal = new Vec3();
const _vTanRef = new Vec3();
const _tan = new Vec3();
const _bitan = new Vec3();
const _proj = new Vec3();
const _triCache = new WeakMap();
const _uvWireCache = new WeakMap();
const _uvCheckerCache = new Map();

function isMobileDevice() {
  if (typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '') ||
    (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches);
}

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

export function rgbToHsv(r, g, b) {
  const rn = Math.max(0, Math.min(1, r / 255));
  const gn = Math.max(0, Math.min(1, g / 255));
  const bn = Math.max(0, Math.min(1, b / 255));
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d > 1e-6) {
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
    else if (max === gn) h = ((bn - rn) / d + 2) * 60;
    else h = ((rn - gn) / d + 4) * 60;
  }
  const s = max <= 1e-6 ? 0 : d / max;
  return { h: (h % 360 + 360) % 360, s, v: max };
}

export function hsvToRgb(h, s, v) {
  const hue = ((Number(h) || 0) % 360 + 360) % 360;
  const sat = Math.max(0, Math.min(1, Number(s) || 0));
  const val = Math.max(0, Math.min(1, Number(v) || 0));
  const c = val * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = val - c;
  let rp = 0, gp = 0, bp = 0;
  if (hue < 60) { rp = c; gp = x; }
  else if (hue < 120) { rp = x; gp = c; }
  else if (hue < 180) { gp = c; bp = x; }
  else if (hue < 240) { gp = x; bp = c; }
  else if (hue < 300) { rp = x; bp = c; }
  else { rp = c; bp = x; }
  return [
    Math.max(0, Math.min(255, Math.round((rp + m) * 255))),
    Math.max(0, Math.min(255, Math.round((gp + m) * 255))),
    Math.max(0, Math.min(255, Math.round((bp + m) * 255))),
  ];
}

export function hexToHsv(hex) {
  const [r, g, b] = parseHexColor(hex);
  return rgbToHsv(r, g, b);
}

export function hsvToHex(h, s, v) {
  const [r, g, b] = hsvToRgb(h, s, v);
  return rgbToHex(r, g, b);
}

function hash2Seed(ix, iy, seed) {
  let n = (Math.imul(ix | 0, 374761393) + Math.imul(iy | 0, 668265263) + Math.imul(seed | 0, 1442695041)) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177) | 0;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

function fillSplatterDrops(seed, out) {
  // 7 organic droplets stored in out[0..20]: [uOffset, vOffset, dropRadius]
  for (let i = 0; i < 7; i++) {
    const a = hash2Seed(i * 13 + 1, seed, seed + 7) * Math.PI * 2;
    const dist = i === 0 ? 0.08 * hash2Seed(3, i, seed) : 0.18 + 0.66 * Math.sqrt(hash2Seed(i * 7 + 5, seed + 19, i));
    const r = i === 0
      ? 0.24 + 0.1 * hash2Seed(11, i, seed)
      : 0.08 + 0.14 * hash2Seed(i * 23 + 3, seed + 31, i + 2);
    const o = i * 3;
    out[o] = Math.cos(a) * dist;
    out[o + 1] = Math.sin(a) * dist;
    out[o + 2] = r;
  }
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

function evalPresetFalloff(preset, d, ddx, ddy, ddz, d2, invLocalR, hardness, splatterDrops, dabSeed) {
  if (preset === 'round') {
    return evalBrushFalloff(Math.sqrt(d2) * invLocalR, hardness);
  }
  if (preset === 'hard') {
    return evalBrushFalloff(Math.sqrt(d2) * invLocalR, Math.max(0.88, hardness));
  }
  if (preset === 'soft') {
    const f = evalBrushFalloff(Math.sqrt(d2) * invLocalR, Math.min(0.18, hardness * 0.3));
    return f * f * 0.72;
  }

  const u = (ddx * d.tx + ddy * d.ty + ddz * d.tz) * invLocalR;
  const v = (ddx * d.bx + ddy * d.by + ddz * d.bz) * invLocalR;
  const n = (ddx * d.nx + ddy * d.ny + ddz * d.nz) * invLocalR;

  if (preset === 'pixel') {
    const dBox = Math.max(Math.abs(u), Math.abs(v), Math.abs(n) * 1.15);
    if (dBox >= 0.94) return 0;
    if (dBox <= 0.80) return 1;
    return (0.94 - dBox) / 0.14;
  }

  if (preset === 'chisel') {
    // 35° calligraphic nib angle
    const ur = u * 0.819152 - v * 0.573576;
    const vr = u * 0.573576 + v * 0.819152;
    const ed = Math.hypot(ur, vr * 2.9, n * 1.15);
    return evalBrushFalloff(ed, Math.max(0.72, hardness));
  }

  if (preset === 'stipple') {
    const env = evalBrushFalloff(Math.sqrt(d2) * invLocalR, Math.min(0.65, hardness));
    if (env <= 0) return 0;
    const gx = Math.floor((u + 1.5) * 8.5 + (dabSeed % 5) * 0.31);
    const gy = Math.floor((v + 1.5) * 8.5 + (dabSeed % 7) * 0.27);
    const rnd = hash2Seed(gx, gy, dabSeed);
    if (rnd > 0.24 + env * 0.58) return 0;
    const grain = 0.52 + 0.48 * hash2Seed(gx + 19, gy - 11, dabSeed + 3);
    return env * grain;
  }

  if (preset === 'splatter') {
    if (Math.abs(n) > 0.75) return 0;
    let best = 0;
    const dropHard = Math.max(0.72, hardness);
    for (let k = 0; k < 21; k += 3) {
      const du = u - splatterDrops[k];
      const dv = v - splatterDrops[k + 1];
      const dr = splatterDrops[k + 2];
      const distSq = du * du + dv * dv;
      if (distSq < dr * dr) {
        const f = evalBrushFalloff(Math.sqrt(distSq) / dr, dropHard);
        if (f > best) best = f;
      }
    }
    return best;
  }

  if (preset === 'rake') {
    const env = evalBrushFalloff(Math.sqrt(d2) * invLocalR, Math.max(0.55, hardness));
    if (env <= 0) return 0;
    const wave = Math.abs(Math.sin(v * Math.PI * 5.0));
    if (wave <= 0.22) return 0;
    const strand = Math.pow((wave - 0.22) / 0.78, 0.85);
    return env * strand;
  }

  return evalBrushFalloff(Math.sqrt(d2) * invLocalR, hardness);
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
function ensurePixelTriOwner(entry, texW, texH) {
  if (!entry || !entry.uvArr || texW <= 0 || texH <= 0) return null;
  if (entry.pixelTriOwner && entry.ownerW === texW && entry.ownerH === texH) {
    return entry.pixelTriOwner;
  }
  const { tris, idx, uvArr } = entry;
  const pixelTriOwner = new Int32Array(texW * texH).fill(-1);
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
  entry.pixelTriOwner = pixelTriOwner;
  entry.ownerW = texW;
  entry.ownerH = texH;
  return pixelTriOwner;
}

function buildSpatialGrid(tris, triAabb, minX, minY, minZ, maxX, maxY, maxZ) {
  if (tris <= 24) return null;
  const g = tris >= 2000 ? 16 : tris >= 64 ? 10 : 4;
  const pad = 1e-4;
  const gx0 = minX - pad, gy0 = minY - pad, gz0 = minZ - pad;
  const sx = Math.max(1e-4, (maxX + pad) - gx0);
  const sy = Math.max(1e-4, (maxY + pad) - gy0);
  const sz = Math.max(1e-4, (maxZ + pad) - gz0);
  const invX = g / sx, invY = g / sy, invZ = g / sz;
  const g2 = g * g;
  const totalCells = g * g2;
  const counts = new Int32Array(totalCells);
  let totalRefs = 0;

  for (let t = 0; t < tris; t++) {
    const b6 = t * 6;
    let cx0 = Math.floor((triAabb[b6] - gx0) * invX);
    let cy0 = Math.floor((triAabb[b6 + 1] - gy0) * invY);
    let cz0 = Math.floor((triAabb[b6 + 2] - gz0) * invZ);
    let cx1 = Math.floor((triAabb[b6 + 3] - gx0) * invX);
    let cy1 = Math.floor((triAabb[b6 + 4] - gy0) * invY);
    let cz1 = Math.floor((triAabb[b6 + 5] - gz0) * invZ);
    if (cx0 < 0) cx0 = 0; else if (cx0 >= g) cx0 = g - 1;
    if (cy0 < 0) cy0 = 0; else if (cy0 >= g) cy0 = g - 1;
    if (cz0 < 0) cz0 = 0; else if (cz0 >= g) cz0 = g - 1;
    if (cx1 < 0) cx1 = 0; else if (cx1 >= g) cx1 = g - 1;
    if (cy1 < 0) cy1 = 0; else if (cy1 >= g) cy1 = g - 1;
    if (cz1 < 0) cz1 = 0; else if (cz1 >= g) cz1 = g - 1;

    for (let z = cz0; z <= cz1; z++) {
      const zOff = z * g2;
      for (let y = cy0; y <= cy1; y++) {
        const yOff = zOff + y * g;
        for (let x = cx0; x <= cx1; x++) {
          counts[yOff + x]++;
          totalRefs++;
        }
      }
    }
  }

  const cellStarts = new Int32Array(totalCells + 1);
  for (let i = 0; i < totalCells; i++) {
    cellStarts[i + 1] = cellStarts[i] + counts[i];
  }
  const writeCursor = cellStarts.slice(0, totalCells);
  const cellTris = new Int32Array(totalRefs);

  for (let t = 0; t < tris; t++) {
    const b6 = t * 6;
    let cx0 = Math.floor((triAabb[b6] - gx0) * invX);
    let cy0 = Math.floor((triAabb[b6 + 1] - gy0) * invY);
    let cz0 = Math.floor((triAabb[b6 + 2] - gz0) * invZ);
    let cx1 = Math.floor((triAabb[b6 + 3] - gx0) * invX);
    let cy1 = Math.floor((triAabb[b6 + 4] - gy0) * invY);
    let cz1 = Math.floor((triAabb[b6 + 5] - gz0) * invZ);
    if (cx0 < 0) cx0 = 0; else if (cx0 >= g) cx0 = g - 1;
    if (cy0 < 0) cy0 = 0; else if (cy0 >= g) cy0 = g - 1;
    if (cz0 < 0) cz0 = 0; else if (cz0 >= g) cz0 = g - 1;
    if (cx1 < 0) cx1 = 0; else if (cx1 >= g) cx1 = g - 1;
    if (cy1 < 0) cy1 = 0; else if (cy1 >= g) cy1 = g - 1;
    if (cz1 < 0) cz1 = 0; else if (cz1 >= g) cz1 = g - 1;

    for (let z = cz0; z <= cz1; z++) {
      const zOff = z * g2;
      for (let y = cy0; y <= cy1; y++) {
        const yOff = zOff + y * g;
        for (let x = cx0; x <= cx1; x++) {
          const ci = yOff + x;
          cellTris[writeCursor[ci]++] = t;
        }
      }
    }
  }

  return {
    g,
    g2,
    minX: gx0,
    minY: gy0,
    minZ: gz0,
    maxX: gx0 + sx,
    maxY: gy0 + sy,
    maxZ: gz0 + sz,
    cellX: sx / g,
    cellY: sy / g,
    cellZ: sz / g,
    invX,
    invY,
    invZ,
    cellStarts,
    cellTris,
  };
}

/**
 * Construye o reutiliza el mapa de caché geométrico/UV de triángulos y cuadrícula espacial 3D.
 */
function getPaintTriData(mesh, texW = 0, texH = 0, needOwner = false) {
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
    entry.idxVer === idxVer
  ) {
    if (needOwner && texW > 0 && texH > 0) {
      ensurePixelTriOwner(entry, texW, texH);
    }
    return entry;
  }

  const posCount = posAttr.count;
  let posArr = posAttr.array;
  const norArr = norAttr ? norAttr.array : null;

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
  const triUvData = uvArr ? new Float32Array(tris * 11) : null;
  const triUvValid = uvArr ? new Uint8Array(tris) : null;

  let gMinX = Infinity, gMinY = Infinity, gMinZ = Infinity;
  let gMaxX = -Infinity, gMaxY = -Infinity, gMaxZ = -Infinity;

  for (let t = 0; t < tris; t++) {
    const t3 = t * 3;
    const ia = idx ? idx[t3] : t3;
    const ib = idx ? idx[t3 + 1] : t3 + 1;
    const ic = idx ? idx[t3 + 2] : t3 + 2;
    const pa = ia * 3, pb = ib * 3, pc = ic * 3;
    const ax = posArr[pa], ay = posArr[pa + 1], az = posArr[pa + 2];
    const bx = posArr[pb], by = posArr[pb + 1], bz = posArr[pb + 2];
    const cx = posArr[pc], cy = posArr[pc + 1], cz = posArr[pc + 2];

    const tMinX = ax < bx ? (ax < cx ? ax : cx) : (bx < cx ? bx : cx);
    const tMinY = ay < by ? (ay < cy ? ay : cy) : (by < cy ? by : cy);
    const tMinZ = az < bz ? (az < cz ? az : cz) : (bz < cz ? bz : cz);
    const tMaxX = ax > bx ? (ax > cx ? ax : cx) : (bx > cx ? bx : cx);
    const tMaxY = ay > by ? (ay > cy ? ay : cy) : (by > cy ? by : cy);
    const tMaxZ = az > bz ? (az > cz ? az : cz) : (bz > cz ? bz : cz);

    const b6 = t * 6;
    triAabb[b6] = tMinX;
    triAabb[b6 + 1] = tMinY;
    triAabb[b6 + 2] = tMinZ;
    triAabb[b6 + 3] = tMaxX;
    triAabb[b6 + 4] = tMaxY;
    triAabb[b6 + 5] = tMaxZ;

    if (tMinX < gMinX) gMinX = tMinX;
    if (tMinY < gMinY) gMinY = tMinY;
    if (tMinZ < gMinZ) gMinZ = tMinZ;
    if (tMaxX > gMaxX) gMaxX = tMaxX;
    if (tMaxY > gMaxY) gMaxY = tMaxY;
    if (tMaxZ > gMaxZ) gMaxZ = tMaxZ;

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

    if (uvArr) {
      const uva = ia * 2, uvb = ib * 2, uvc = ic * 2;
      const ua = uvArr[uva], va = uvArr[uva + 1];
      const ub = uvArr[uvb], vb = uvArr[uvb + 1];
      const uc = uvArr[uvc], vc = uvArr[uvc + 1];
      const u0x = ub - ua, u0y = vb - va;
      const u1x = uc - ua, u1y = vc - va;
      const det = u0x * u1y - u1x * u0y;
      if (Math.abs(det) >= 1e-10) {
        triUvValid[t] = 1;
        const uo = t * 11;
        triUvData[uo] = ua;
        triUvData[uo + 1] = va;
        triUvData[uo + 2] = u0x;
        triUvData[uo + 3] = u0y;
        triUvData[uo + 4] = u1x;
        triUvData[uo + 5] = u1y;
        triUvData[uo + 6] = 1 / det;
        triUvData[uo + 7] = ua < ub ? (ua < uc ? ua : uc) : (ub < uc ? ub : uc);
        triUvData[uo + 8] = ua > ub ? (ua > uc ? ua : uc) : (ub > uc ? ub : uc);
        triUvData[uo + 9] = va < vb ? (va < vc ? va : vc) : (vb < vc ? vb : vc);
        triUvData[uo + 10] = va > vb ? (va > vc ? va : vc) : (vb > vc ? vb : vc);
      }
    }
  }

  const grid = tris > 0 && Number.isFinite(gMinX)
    ? buildSpatialGrid(tris, triAabb, gMinX, gMinY, gMinZ, gMaxX, gMaxY, gMaxZ)
    : null;

  entry = {
    posVer,
    uvVer,
    idxVer,
    tris,
    idx,
    posArr,
    norArr,
    uvArr,
    triAabb,
    triFaceNormal,
    triUvData,
    triUvValid,
    grid,
    pixelTriOwner: null,
    ownerW: 0,
    ownerH: 0,
  };
  if (needOwner && uvArr && texW > 0 && texH > 0) {
    ensurePixelTriOwner(entry, texW, texH);
  }
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
    this._isMobile = opts.isMobile ?? isMobileDevice();
    this.tool = opts.tool || 'brush';
    this.brushPreset = PAINT_BRUSH_PRESETS.includes(opts.brushPreset) ? opts.brushPreset : 'round';
    this.color = opts.color || '#ef4444';
    this.radius = opts.radius ?? 0.32;
    this.strength = opts.strength ?? 0.85;
    this.hardness = opts.hardness ?? 0.45;
    this.symmetry = opts.symmetry || 'none';
    this.frontFacesOnly = opts.frontFacesOnly ?? true;
    this.paintMode = opts.paintMode || 'texture'; // 'texture' | 'vertex'
    this.resolution = opts.resolution ?? (this._isMobile ? 512 : 1024);
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
    this._startSnapTex = null;
    this._accumTex = null;
    this._touchedStamp = null;
    this._touchedStampId = 1;
    this._dabStamp = null;
    this._dabStampId = 1;
    this._triStamp = null;
    this._triStampId = 1;
    this._symDabs = [
      { cx: 0, cy: 0, cz: 0, nx: 0, ny: 1, nz: 0, tx: 1, ty: 0, tz: 0, bx: 0, by: 0, bz: 1 },
      { cx: 0, cy: 0, cz: 0, nx: 0, ny: 1, nz: 0, tx: 1, ty: 0, tz: 0, bx: 0, by: 0, bz: 1 },
    ];
    this._symCount = 1;
    this._segPool = Array.from({ length: 16 }, () => ({
      ax: 0, ay: 0, az: 0,
      bx: 0, by: 0, bz: 0,
      abx: 0, aby: 0, abz: 0,
      lenSq: 0, invLenSq: 0,
      nx: 0, ny: 1, nz: 0,
      tx: 1, ty: 0, tz: 0,
      bxv: 0, byv: 0, bzv: 1,
      minX: 0, minY: 0, minZ: 0,
      maxX: 0, maxY: 0, maxZ: 0,
    }));
    this._splatterDrops = new Float32Array(21);
    this._pointerScreen = null;
    this._smoothFilter = null;
    this._pendingMoves = [];
    this._moveRaf = 0;
    this._overlaySig = '';
    this._overlayWasDrawn = false;
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
      this._cancelPendingMove();
      this._smoothFilter = null;
      this.hover = null;
      this._pointerScreen = null;
      this._pointers.clear();
      this._releasePointerCapture();
      this._activePointerId = null;
      this._overlaySig = '';
    }
    return this;
  }

  setBrushPreset(preset) {
    this.brushPreset = PAINT_BRUSH_PRESETS.includes(preset) ? preset : 'round';
    return this.brushPreset;
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
      const scaleX = oldW / target;
      const scaleY = oldH / target;
      for (let y = 0; y < target; y++) {
        const fy = (y + 0.5) * scaleY - 0.5;
        const y0 = Math.max(0, Math.min(oldH - 1, Math.floor(fy)));
        const y1 = Math.max(0, Math.min(oldH - 1, y0 + 1));
        const wy = Math.max(0, Math.min(1, fy - y0));
        const wy0 = 1 - wy;
        for (let x = 0; x < target; x++) {
          const fx = (x + 0.5) * scaleX - 0.5;
          const x0 = Math.max(0, Math.min(oldW - 1, Math.floor(fx)));
          const x1 = Math.max(0, Math.min(oldW - 1, x0 + 1));
          const wx = Math.max(0, Math.min(1, fx - x0));
          const wx0 = 1 - wx;

          const i00 = (y0 * oldW + x0) * 4;
          const i10 = (y0 * oldW + x1) * 4;
          const i01 = (y1 * oldW + x0) * 4;
          const i11 = (y1 * oldW + x1) * 4;

          const w00 = wx0 * wy0;
          const w10 = wx * wy0;
          const w01 = wx0 * wy;
          const w11 = wx * wy;

          const di = (y * target + x) * 4;
          dst[di] = Math.round(src[i00] * w00 + src[i10] * w10 + src[i01] * w01 + src[i11] * w11);
          dst[di + 1] = Math.round(src[i00 + 1] * w00 + src[i10 + 1] * w10 + src[i01 + 1] * w01 + src[i11 + 1] * w11);
          dst[di + 2] = Math.round(src[i00 + 2] * w00 + src[i10 + 2] * w10 + src[i01 + 2] * w01 + src[i11 + 2] * w11);
          dst[di + 3] = Math.round(src[i00 + 3] * w00 + src[i10 + 3] * w10 + src[i01 + 3] * w01 + src[i11 + 3] * w11);
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

    // Fondo de tablero sutil cacheado por tamaño
    const checkerKey = `${w}x${h}`;
    let checker = _uvCheckerCache.get(checkerKey);
    if (!checker && typeof document !== 'undefined') {
      checker = document.createElement('canvas');
      checker.width = w;
      checker.height = h;
      const cctx = checker.getContext('2d');
      if (cctx) {
        const tile = Math.max(8, Math.round(w / 16));
        cctx.fillStyle = '#181a20';
        cctx.fillRect(0, 0, w, h);
        cctx.fillStyle = '#20232b';
        for (let y = 0; y < h; y += tile) {
          for (let x = ((y / tile) & 1) ? tile : 0; x < w; x += tile * 2) {
            cctx.fillRect(x, y, tile, tile);
          }
        }
      }
      if (_uvCheckerCache.size > 6) _uvCheckerCache.clear();
      _uvCheckerCache.set(checkerKey, checker);
    }
    if (checker) {
      ctx.drawImage(checker, 0, 0);
    } else {
      const tile = Math.max(8, Math.round(w / 16));
      ctx.fillStyle = '#181a20';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#20232b';
      for (let y = 0; y < h; y += tile) {
        for (let x = ((y / tile) & 1) ? tile : 0; x < w; x += tile * 2) {
          ctx.fillRect(x, y, tile, tile);
        }
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
        const dw = Math.min(w, mw);
        const dh = Math.min(h, mh);
        let scratch = Painter._uvScratchCanvas;
        if (!scratch && typeof document !== 'undefined') {
          scratch = document.createElement('canvas');
          Painter._uvScratchCanvas = scratch;
        }
        if (scratch) {
          if (scratch.width !== dw) scratch.width = dw;
          if (scratch.height !== dh) scratch.height = dh;
          const sctx = scratch.getContext('2d');
          if (sctx) {
            let imgData = Painter._uvScratchImgData;
            if (!imgData || imgData.width !== dw || imgData.height !== dh) {
              imgData = sctx.createImageData(dw, dh);
              Painter._uvScratchImgData = imgData;
            }
            const dst = imgData.data;
            const flip = tex.flipY === false;
            if (dw === mw && dh === mh) {
              const rowBytes = mw * 4;
              if (flip) {
                for (let row = 0; row < mh; row++) {
                  const srcOff = (mh - 1 - row) * rowBytes;
                  dst.set(data.subarray(srcOff, srcOff + rowBytes), row * rowBytes);
                }
              } else {
                dst.set(data.subarray(0, mw * mh * 4));
              }
            } else {
              // Muestreo directo a la resolución del preview (evita copiar megabytes en móviles)
              const scaleX = mw / dw;
              const scaleY = mh / dh;
              for (let y = 0; y < dh; y++) {
                const sy = flip
                  ? Math.max(0, Math.min(mh - 1, mh - 1 - Math.floor((y + 0.5) * scaleY)))
                  : Math.max(0, Math.min(mh - 1, Math.floor((y + 0.5) * scaleY)));
                const srcRow = sy * mw;
                const dstRow = y * dw;
                for (let x = 0; x < dw; x++) {
                  const sx = Math.max(0, Math.min(mw - 1, Math.floor((x + 0.5) * scaleX)));
                  const so = (srcRow + sx) * 4;
                  const doff = (dstRow + x) * 4;
                  dst[doff] = data[so];
                  dst[doff + 1] = data[so + 1];
                  dst[doff + 2] = data[so + 2];
                  dst[doff + 3] = data[so + 3];
                }
              }
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
      const wireColor = opts.wireColor || 'rgba(255, 255, 255, 0.42)';
      const lineWidth = Math.max(0.75, opts.lineWidth || (w >= 400 ? 1.15 : 0.8));
      const uvVer = uvAttr.version ?? 0;
      const idxVer = geo.index ? (geo.index.version ?? 0) : -1;
      const wireKey = `${uvVer}|${idxVer}|${w}|${h}|${wireColor}|${lineWidth}`;

      let geoMap = _uvWireCache.get(geo);
      let wireCanvas = geoMap?.get(wireKey);
      if (!wireCanvas && typeof document !== 'undefined') {
        wireCanvas = document.createElement('canvas');
        wireCanvas.width = w;
        wireCanvas.height = h;
        const wctx = wireCanvas.getContext('2d');
        if (wctx) {
          const seenEdges = new Set();
          wctx.strokeStyle = wireColor;
          wctx.lineWidth = lineWidth;
          wctx.beginPath();
          for (let t = 0; t < tris; t++) {
            const t3 = t * 3;
            const ia = idx ? idx[t3] : t3;
            const ib = idx ? idx[t3 + 1] : t3 + 1;
            const ic = idx ? idx[t3 + 2] : t3 + 2;
            const pairs = [[ia, ib], [ib, ic], [ic, ia]];
            for (let p = 0; p < 3; p++) {
              const e0 = pairs[p][0];
              const e1 = pairs[p][1];
              const key = e0 < e1 ? (e0 * 1048576 + e1) : (e1 * 1048576 + e0);
              if (seenEdges.has(key)) continue;
              seenEdges.add(key);
              const u0 = uv[e0 * 2], v0 = uv[e0 * 2 + 1];
              const u1 = uv[e1 * 2], v1 = uv[e1 * 2 + 1];
              if (!Number.isFinite(u0) || !Number.isFinite(v0) || !Number.isFinite(u1) || !Number.isFinite(v1)) continue;
              wctx.moveTo(u0 * w, (1 - v0) * h);
              wctx.lineTo(u1 * w, (1 - v1) * h);
            }
          }
          wctx.stroke();
        }
        if (!geoMap) {
          geoMap = new Map();
          _uvWireCache.set(geo, geoMap);
        } else if (geoMap.size >= 6) {
          geoMap.clear();
        }
        geoMap.set(wireKey, wireCanvas);
      }

      if (wireCanvas) {
        ctx.drawImage(wireCanvas, 0, 0);
      } else {
        const seenEdges = new Set();
        ctx.save();
        ctx.strokeStyle = wireColor;
        ctx.lineWidth = lineWidth;
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
            const key = e0 < e1 ? (e0 * 1048576 + e1) : (e1 * 1048576 + e0);
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

  _nextTriStamp(tris) {
    if (!this._triStamp || this._triStamp.length < tris) {
      this._triStamp = new Uint32Array(tris);
      this._triStampId = 1;
    } else if (++this._triStampId >= 0x7ffffff0) {
      this._triStamp.fill(0);
      this._triStampId = 1;
    }
    return this._triStampId;
  }

  _nextDabStamp(totalPx) {
    if (!this._dabStamp || this._dabStamp.length < totalPx) {
      this._dabStamp = new Uint32Array(totalPx);
      this._dabStampId = 1;
    } else if (++this._dabStampId >= 0x7ffffff0) {
      this._dabStamp.fill(0);
      this._dabStampId = 1;
    }
    return this._dabStampId;
  }

  _pickSingleMeshFast(camera, ndcX, ndcY, mesh) {
    if (!Painter.isPaintable(mesh) || (mesh.isSkinnedMesh && mesh.skeleton)) return null;
    const triData = getPaintTriData(mesh, 0, 0, false);
    if (!triData || !triData.grid) return null;

    const grid = triData.grid;
    _raycaster.setFromCamera({ x: ndcX, y: ndcY }, camera);
    const r = _raycaster.ray;
    const rox = r.origin.x, roy = r.origin.y, roz = r.origin.z;
    const rdx = r.direction.x, rdy = r.direction.y, rdz = r.direction.z;
    const near = _raycaster.near, far = _raycaster.far;

    mesh.updateWorldMatrix(true, false);
    const wm = mesh.matrixWorld;
    const we = wm.elements;
    _invMat.copyInverse(wm);
    const ie = _invMat.elements;

    const ox = ie[0] * rox + ie[4] * roy + ie[8] * roz + ie[12];
    const oy = ie[1] * rox + ie[5] * roy + ie[9] * roz + ie[13];
    const oz = ie[2] * rox + ie[6] * roy + ie[10] * roz + ie[14];
    const dx = ie[0] * rdx + ie[4] * rdy + ie[8] * rdz;
    const dy = ie[1] * rdx + ie[5] * rdy + ie[9] * rdz;
    const dz = ie[2] * rdx + ie[6] * rdy + ie[10] * rdz;

    // Slab ray-box intersection returning entry tmin and exit tmax
    let tmin = 0, tmax = Infinity;
    if (Math.abs(dx) > 1e-20) {
      const inv = 1 / dx;
      const t1 = (grid.minX - ox) * inv;
      const t2 = (grid.maxX - ox) * inv;
      tmin = Math.max(tmin, Math.min(t1, t2));
      tmax = Math.min(tmax, Math.max(t1, t2));
    } else if (ox < grid.minX || ox > grid.maxX) {
      return null;
    }
    if (Math.abs(dy) > 1e-20) {
      const inv = 1 / dy;
      const t1 = (grid.minY - oy) * inv;
      const t2 = (grid.maxY - oy) * inv;
      tmin = Math.max(tmin, Math.min(t1, t2));
      tmax = Math.min(tmax, Math.max(t1, t2));
    } else if (oy < grid.minY || oy > grid.maxY) {
      return null;
    }
    if (Math.abs(dz) > 1e-20) {
      const inv = 1 / dz;
      const t1 = (grid.minZ - oz) * inv;
      const t2 = (grid.maxZ - oz) * inv;
      tmin = Math.max(tmin, Math.min(t1, t2));
      tmax = Math.min(tmax, Math.max(t1, t2));
    } else if (oz < grid.minZ || oz > grid.maxZ) {
      return null;
    }
    if (tmax < tmin || tmax < 0) return null;

    const side = mesh.material ? mesh.material.side : 'front';
    let cull = side === 'double' ? 0 : side === 'back' ? 2 : 1; // 0: double, 1: front, 2: back
    if (cull !== 0) {
      const det3 = we[0] * (we[5] * we[10] - we[9] * we[6]) - we[4] * (we[1] * we[10] - we[9] * we[2]) + we[8] * (we[1] * we[6] - we[5] * we[2]);
      if (det3 < 0) cull = cull === 1 ? 2 : 1;
    }

    const g = grid.g;
    const g2 = grid.g2;
    const tEnter = Math.max(0, tmin);
    const sx = ox + dx * tEnter;
    const sy = oy + dy * tEnter;
    const sz = oz + dz * tEnter;
    let ix = Math.floor((sx - grid.minX) * grid.invX);
    let iy = Math.floor((sy - grid.minY) * grid.invY);
    let iz = Math.floor((sz - grid.minZ) * grid.invZ);
    if (ix < 0) ix = 0; else if (ix >= g) ix = g - 1;
    if (iy < 0) iy = 0; else if (iy >= g) iy = g - 1;
    if (iz < 0) iz = 0; else if (iz >= g) iz = g - 1;

    const stepX = dx > 1e-20 ? 1 : dx < -1e-20 ? -1 : 0;
    const stepY = dy > 1e-20 ? 1 : dy < -1e-20 ? -1 : 0;
    const stepZ = dz > 1e-20 ? 1 : dz < -1e-20 ? -1 : 0;
    const tDeltaX = stepX !== 0 ? Math.abs(grid.cellX / dx) : Infinity;
    const tDeltaY = stepY !== 0 ? Math.abs(grid.cellY / dy) : Infinity;
    const tDeltaZ = stepZ !== 0 ? Math.abs(grid.cellZ / dz) : Infinity;
    let tMaxX = stepX > 0 ? ((grid.minX + (ix + 1) * grid.cellX - ox) / dx) : stepX < 0 ? ((grid.minX + ix * grid.cellX - ox) / dx) : Infinity;
    let tMaxY = stepY > 0 ? ((grid.minY + (iy + 1) * grid.cellY - oy) / dy) : stepY < 0 ? ((grid.minY + iy * grid.cellY - oy) / dy) : Infinity;
    let tMaxZ = stepZ > 0 ? ((grid.minZ + (iz + 1) * grid.cellZ - oz) / dz) : stepZ < 0 ? ((grid.minZ + iz * grid.cellZ - oz) / dz) : Infinity;
    if (tMaxX < tEnter) tMaxX = tEnter;
    if (tMaxY < tEnter) tMaxY = tEnter;
    if (tMaxZ < tEnter) tMaxZ = tEnter;

    const { tris, idx, posArr, uvArr, triFaceNormal } = triData;
    const { cellStarts, cellTris } = grid;
    const stampId = this._nextTriStamp(tris);
    const triStamp = this._triStamp;

    let bestDist = Infinity;
    let bestTri = -1;
    let bestU = 0, bestV = 0, bestLocalT = Infinity;
    let bestIa = 0, bestIb = 0, bestIc = 0;
    let bestLx = 0, bestLy = 0, bestLz = 0;
    let bestWx = 0, bestWy = 0, bestWz = 0;

    let guard = g * 4 + 8;
    while (guard-- > 0) {
      const ci = iz * g2 + iy * g + ix;
      const start = cellStarts[ci];
      const end = cellStarts[ci + 1];
      for (let k = start; k < end; k++) {
        const t = cellTris[k];
        if (triStamp[t] === stampId) continue;
        triStamp[t] = stampId;

        const t3 = t * 3;
        const ia = idx ? idx[t3] : t3;
        const ib = idx ? idx[t3 + 1] : t3 + 1;
        const ic = idx ? idx[t3 + 2] : t3 + 2;
        const a3 = ia * 3, b3 = ib * 3, c3 = ic * 3;
        const lax = posArr[a3], lay = posArr[a3 + 1], laz = posArr[a3 + 2];
        const lbx = posArr[b3], lby = posArr[b3 + 1], lbz = posArr[b3 + 2];
        const lcx = posArr[c3], lcy = posArr[c3 + 1], lcz = posArr[c3 + 2];

        const e1x = lbx - lax, e1y = lby - lay, e1z = lbz - laz;
        const e2x = lcx - lax, e2y = lcy - lay, e2z = lcz - laz;
        const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (det > -1e-12 && det < 1e-12) continue;
        if (cull === 1 && det < 0) continue;
        if (cull === 2 && det > 0) continue;
        const inv = 1 / det;
        const tx = ox - lax, ty = oy - lay, tz = oz - laz;
        const u = (tx * px + ty * py + tz * pz) * inv;
        if (u < -1e-6 || u > 1 + 1e-6) continue;
        const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * inv;
        if (v < -1e-6 || u + v > 1 + 1e-6) continue;
        const hitT = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (hitT < 0) continue;

        const w = 1 - u - v;
        const lx = lax * w + lbx * u + lcx * v;
        const ly = lay * w + lby * u + lcy * v;
        const lz = laz * w + lbz * u + lcz * v;
        const wx = we[0] * lx + we[4] * ly + we[8] * lz + we[12];
        const wy = we[1] * lx + we[5] * ly + we[9] * lz + we[13];
        const wz = we[2] * lx + we[6] * ly + we[10] * lz + we[14];
        const dist = (wx - rox) * rdx + (wy - roy) * rdy + (wz - roz) * rdz;
        if (dist < near || dist > far || dist >= bestDist) continue;

        bestDist = dist;
        bestLocalT = hitT;
        bestTri = t;
        bestU = u;
        bestV = v;
        bestIa = ia;
        bestIb = ib;
        bestIc = ic;
        bestLx = lx; bestLy = ly; bestLz = lz;
        bestWx = wx; bestWy = wy; bestWz = wz;
      }

      const nextBoundaryT = tMaxX < tMaxY ? (tMaxX < tMaxZ ? tMaxX : tMaxZ) : (tMaxY < tMaxZ ? tMaxY : tMaxZ);
      if (bestTri >= 0 && bestLocalT <= nextBoundaryT + 1e-5) break;
      if (nextBoundaryT > tmax) break;

      if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
        ix += stepX;
        tMaxX += tDeltaX;
        if (ix < 0 || ix >= g) break;
      } else if (tMaxY <= tMaxZ) {
        iy += stepY;
        tMaxY += tDeltaY;
        if (iy < 0 || iy >= g) break;
      } else {
        iz += stepZ;
        tMaxZ += tDeltaZ;
        if (iz < 0 || iz >= g) break;
      }
    }

    if (bestTri < 0) return null;

    const fnOff = bestTri * 3;
    const fnx = triFaceNormal[fnOff], fny = triFaceNormal[fnOff + 1], fnz = triFaceNormal[fnOff + 2];
    const localNormal = new Vec3(fnx, fny, fnz);
    let wnx = ie[0] * fnx + ie[1] * fny + ie[2] * fnz;
    let wny = ie[4] * fnx + ie[5] * fny + ie[6] * fnz;
    let wnz = ie[8] * fnx + ie[9] * fny + ie[10] * fnz;
    const wnl = Math.hypot(wnx, wny, wnz) || 1;
    wnx /= wnl; wny /= wnl; wnz /= wnl;

    let uv = null;
    if (uvArr) {
      const bw = 1 - bestU - bestV;
      uv = {
        x: uvArr[bestIa * 2] * bw + uvArr[bestIb * 2] * bestU + uvArr[bestIc * 2] * bestV,
        y: uvArr[bestIa * 2 + 1] * bw + uvArr[bestIb * 2 + 1] * bestU + uvArr[bestIc * 2 + 1] * bestV,
        clone() { return { x: this.x, y: this.y, clone: this.clone }; },
      };
    }

    return {
      mesh,
      point: new Vec3(bestWx, bestWy, bestWz),
      normal: new Vec3(wnx, wny, wnz),
      localPoint: new Vec3(bestLx, bestLy, bestLz),
      localNormal,
      uv,
      face: { a: bestIa, b: bestIb, c: bestIc, normal: localNormal, materialIndex: 0 },
      faceIndex: bestTri,
      distance: bestDist,
    };
  }

  pickSurface(camera, ndcX, ndcY, targets) {
    if (!camera || !targets || !targets.length) return null;
    const list = Array.isArray(targets) ? targets : [targets];
    if (list.length === 1 && Painter.isPaintable(list[0]) && !(list[0].isSkinnedMesh && list[0].skeleton)) {
      const triData = getPaintTriData(list[0], 0, 0, false);
      if (triData && triData.grid) {
        return this._pickSingleMeshFast(camera, ndcX, ndcY, list[0]);
      }
    }
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

  /**
   * Coloca una vista previa inicial del pincel sobre el centro del modelo objetivo
   * para que el usuario vea el pincel inmediatamente al entrar en modo Pintar.
   */
  previewHoverAtCenter(camera, targets) {
    if (!camera || !targets || !targets.length) return null;
    const list = Array.isArray(targets) ? targets : [targets];
    for (let i = 0; i < list.length; i++) {
      const obj = list[i];
      if (!Painter.isPaintable(obj)) continue;
      obj.updateWorldMatrix(true, false);
      const geo = obj.geometry;
      const bs = geo.getBoundingSphere ? geo.getBoundingSphere() : null;
      const localC = bs ? bs.center : new Vec3(0, 0, 0);
      const worldC = localC.clone().applyMatrix4(obj.matrixWorld);
      _proj.copy(worldC).project(camera);
      if (Number.isFinite(_proj.x) && Number.isFinite(_proj.y)) {
        const hit = this.pickSurface(camera, _proj.x, _proj.y, list);
        if (hit) {
          this.hover = hit;
          return hit;
        }
      }
    }
    const fallback = this.pickSurface(camera, 0, 0, list);
    if (fallback) this.hover = fallback;
    return fallback;
  }

  _fillTangentBasis(d, tangentVec) {
    const nx = d.nx, ny = d.ny, nz = d.nz;
    let tx = 0, ty = 0, tz = 0;
    if (tangentVec) {
      const dot = tangentVec.x * nx + tangentVec.y * ny + tangentVec.z * nz;
      tx = tangentVec.x - nx * dot;
      ty = tangentVec.y - ny * dot;
      tz = tangentVec.z - nz * dot;
    }
    let tLen = Math.hypot(tx, ty, tz);
    if (tLen < 1e-4) {
      const rx = Math.abs(ny) < 0.9 ? 0 : 1;
      const ry = Math.abs(ny) < 0.9 ? 1 : 0;
      const rz = 0;
      tx = ry * nz - rz * ny;
      ty = rz * nx - rx * nz;
      tz = rx * ny - ry * nx;
      tLen = Math.hypot(tx, ty, tz) || 1;
    }
    tx /= tLen; ty /= tLen; tz /= tLen;
    let bx = ny * tz - nz * ty;
    let by = nz * tx - nx * tz;
    let bz = nx * ty - ny * tx;
    const bLen = Math.hypot(bx, by, bz) || 1;
    d.tx = tx; d.ty = ty; d.tz = tz;
    d.bx = bx / bLen; d.by = by / bLen; d.bz = bz / bLen;
  }

  _fillSymmetryDabs(localPoint, localNormal, tangentVec = null) {
    const d0 = this._symDabs[0];
    d0.cx = localPoint.x; d0.cy = localPoint.y; d0.cz = localPoint.z;
    d0.nx = localNormal.x; d0.ny = localNormal.y; d0.nz = localNormal.z;
    this._fillTangentBasis(d0, tangentVec);
    let count = 1;
    const d1 = this._symDabs[1];
    if (this.symmetry === 'x' && Math.abs(localPoint.x) > 1e-4) {
      d1.cx = -localPoint.x; d1.cy = localPoint.y; d1.cz = localPoint.z;
      d1.nx = -localNormal.x; d1.ny = localNormal.y; d1.nz = localNormal.z;
      d1.tx = -d0.tx; d1.ty = d0.ty; d1.tz = d0.tz;
      d1.bx = -d0.bx; d1.by = d0.by; d1.bz = d0.bz;
      count = 2;
    } else if (this.symmetry === 'y' && Math.abs(localPoint.y) > 1e-4) {
      d1.cx = localPoint.x; d1.cy = -localPoint.y; d1.cz = localPoint.z;
      d1.nx = localNormal.x; d1.ny = -localNormal.y; d1.nz = localNormal.z;
      d1.tx = d0.tx; d1.ty = -d0.ty; d1.tz = d0.tz;
      d1.bx = d0.bx; d1.by = -d0.by; d1.bz = d0.bz;
      count = 2;
    } else if (this.symmetry === 'z' && Math.abs(localPoint.z) > 1e-4) {
      d1.cx = localPoint.x; d1.cy = localPoint.y; d1.cz = -localPoint.z;
      d1.nx = localNormal.x; d1.ny = localNormal.y; d1.nz = -localNormal.z;
      d1.tx = d0.tx; d1.ty = d0.ty; d1.tz = -d0.tz;
      d1.bx = d0.bx; d1.by = d0.by; d1.bz = -d0.bz;
      count = 2;
    }
    this._symCount = count;
    return count;
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

  _nextTouchedStamp(totalPx) {
    if (!this._touchedStamp || this._touchedStamp.length < totalPx) {
      this._touchedStamp = new Uint32Array(totalPx);
      this._touchedStampId = 1;
    } else if (++this._touchedStampId >= 0x7ffffff0) {
      this._touchedStamp.fill(0);
      this._touchedStampId = 1;
    }
    return this._touchedStampId;
  }

  _cancelPendingMove() {
    if (this._moveRaf && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this._moveRaf);
    }
    this._moveRaf = 0;
    this._pendingMoves.length = 0;
  }

  _filterStrokePoint(ndcX, ndcY, nowMs) {
    const f = this._smoothFilter;
    if (!f) {
      this._smoothFilter = { x: ndcX, y: ndcY, t: nowMs };
      return { x: ndcX, y: ndcY };
    }
    const dtSec = Math.max(1 / 240, Math.min(0.1, (nowMs - f.t) * 0.001));
    const dist = Math.hypot(ndcX - f.x, ndcY - f.y);
    const speed = dist / dtSec;
    // Baja velocidad: suaviza temblor del dedo/ratón; alta velocidad: respuesta inmediata sin retardo elástico
    const tFast = Math.max(0, Math.min(1, (speed - 0.1) / 1.65));
    const alpha = this._isMobile
      ? (0.34 + 0.58 * tFast)
      : (0.44 + 0.5 * tFast);
    f.x += (ndcX - f.x) * alpha;
    f.y += (ndcY - f.y) * alpha;
    f.t = nowMs;
    return { x: f.x, y: f.y };
  }

  _isSegmentCapableTool(tool, preset) {
    if (tool === 'eraser' || tool === 'airbrush') return true;
    if (tool === 'brush') {
      return preset === 'round' || preset === 'hard' || preset === 'soft' ||
        preset === 'pixel' || preset === 'chisel' || preset === 'rake';
    }
    return false;
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
        brushPreset: this.tool === 'brush' ? this.brushPreset : 'round',
        dabSeed: 1,
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
        lastTangent: new Vec3(0, 0, 0),
        hasTangent: false,
        hitUv: hit.uv ? hit.uv.clone() : null,
        camera,
      };
    } else {
      const tex = Painter.ensurePaintTexture(mesh, { resolution: this.resolution, scene });
      if (!tex || !tex.mipmaps?.[0]?.data) return false;
      const mip = tex.mipmaps[0];
      const totalPx = mip.width * mip.height;
      const needBytes = totalPx * 4;

      if (!this._alphaMask || this._alphaMask.length < totalPx || !(this._alphaMask instanceof Float32Array)) {
        this._alphaMask = new Float32Array(totalPx);
      }
      if (!this._startSnapTex || this._startSnapTex.length < needBytes) {
        this._startSnapTex = new Uint8Array(needBytes);
      }
      const needAccum = this.tool === 'airbrush' || this.tool === 'blur' || this.tool === 'smudge';
      if (needAccum && (!this._accumTex || this._accumTex.length < needBytes)) {
        this._accumTex = new Float32Array(needBytes);
      }
      const stampId = this._nextTouchedStamp(totalPx);
      const baseSnap = tex.userData?.basePixels || null;

      this._stroke = {
        mode: 'texture',
        tool: this.tool,
        brushPreset: this.tool === 'brush' ? this.brushPreset : 'round',
        dabSeed: 1,
        mesh,
        geometry: mesh.geometry,
        texture: tex,
        width: mip.width,
        height: mip.height,
        data: mip.data,
        accumData: needAccum ? this._accumTex : null,
        startSnap: this._startSnapTex,
        baseSnap,
        alphaMask: this._alphaMask,
        touchedStamp: this._touchedStamp,
        stampId,
        touched: [],
        rgb: parseHexColor(this.color),
        smudgeColor: null,
        lastLocal: hit.localPoint.clone(),
        lastNormal: hit.localNormal.clone(),
        lastTangent: new Vec3(0, 0, 0),
        hasTangent: false,
        hitUv: hit.uv ? hit.uv.clone() : null,
        camera,
      };
    }

    if (this.tool === 'fill') {
      this._applyBucketFill(hit);
    } else {
      this._applyDab(hit.localPoint, hit.localNormal, 1);
    }
    (opts.onStrokeStep || this._attached?.onStrokeStep)?.(this._stroke);
    return true;
  }

  stepStroke(camera, ndcX, ndcY, opts = {}) {
    if (!this._stroke) return null;
    if (this._stroke.tool === 'fill') return this.hover;

    const st = this._stroke;
    const hit = this.pickSurface(camera, ndcX, ndcY, [st.mesh]);
    if (!hit) return null;

    const prev = st.lastLocal;
    const curr = hit.localPoint;
    const dx = curr.x - prev.x;
    const dy = curr.y - prev.y;
    const dz = curr.z - prev.z;
    const dist = Math.hypot(dx, dy, dz);
    const localR = this._computeLocalRadius(st.mesh);
    const isMobile = this._isMobile;
    const preset = st.tool === 'brush' ? (st.brushPreset || 'round') : 'round';

    let dirX = 0, dirY = 0, dirZ = 0;
    if (dist > 1e-5) {
      const invD = 1 / dist;
      dirX = dx * invD;
      dirY = dy * invD;
      dirZ = dz * invD;
    }

    if (this._isSegmentCapableTool(st.tool, preset)) {
      if (dist <= 1e-5) {
        this._applyDab(curr, hit.localNormal, 0.35);
      } else {
        const subSegs = dist <= localR * 0.35
          ? 1
          : Math.min(isMobile ? 4 : 6, Math.max(2, Math.ceil(dist / Math.max(0.03, localR * 0.6))));

        const prevTan = st.hasTangent ? st.lastTangent : null;
        const m0x = prevTan ? prevTan.x * dist * 0.5 : dx * 0.5;
        const m0y = prevTan ? prevTan.y * dist * 0.5 : dy * 0.5;
        const m0z = prevTan ? prevTan.z * dist * 0.5 : dz * 0.5;
        const endTanX = prevTan ? (prevTan.x * 0.25 + dirX * 0.75) : dirX;
        const endTanY = prevTan ? (prevTan.y * 0.25 + dirY * 0.75) : dirY;
        const endTanZ = prevTan ? (prevTan.z * 0.25 + dirZ * 0.75) : dirZ;
        const endTanLen = Math.hypot(endTanX, endTanY, endTanZ) || 1;
        const m1x = (endTanX / endTanLen) * dist * 0.5;
        const m1y = (endTanY / endTanLen) * dist * 0.5;
        const m1z = (endTanZ / endTanLen) * dist * 0.5;

        const prevN = st.lastNormal;
        const currN = hit.localNormal;
        let lx0 = prev.x, ly0 = prev.y, lz0 = prev.z;
        for (let s = 1; s <= subSegs; s++) {
          const t = s / subSegs;
          let lx1, ly1, lz1;
          if (subSegs === 1) {
            lx1 = curr.x; ly1 = curr.y; lz1 = curr.z;
          } else {
            const t2 = t * t, t3 = t2 * t;
            const h00 = 2 * t3 - 3 * t2 + 1;
            const h10 = t3 - 2 * t2 + t;
            const h01 = -2 * t3 + 3 * t2;
            const h11 = t3 - t2;
            lx1 = h00 * prev.x + h10 * m0x + h01 * curr.x + h11 * m1x;
            ly1 = h00 * prev.y + h10 * m0y + h01 * curr.y + h11 * m1y;
            lz1 = h00 * prev.z + h10 * m0z + h01 * curr.z + h11 * m1z;
          }
          const tMid = (s - 0.5) / subSegs;
          let nx = prevN.x + (currN.x - prevN.x) * tMid;
          let ny = prevN.y + (currN.y - prevN.y) * tMid;
          let nz = prevN.z + (currN.z - prevN.z) * tMid;
          const nLen = Math.hypot(nx, ny, nz) || 1;
          nx /= nLen; ny /= nLen; nz /= nLen;

          const seg = this._segPool[s - 1];
          this._initSegment(seg, lx0, ly0, lz0, lx1, ly1, lz1, nx, ny, nz, localR);
          lx0 = lx1; ly0 = ly1; lz0 = lz1;
        }
        const airFlow = st.tool === 'airbrush'
          ? Math.max(0.35, Math.min(1.6, dist / Math.max(0.002, localR * 0.28)))
          : 1;
        this._applySegments(subSegs, localR, airFlow);
      }
      if (dist > 1e-5) {
        if (st.hasTangent) {
          const lt = st.lastTangent;
          lt.set(lt.x * 0.42 + dirX * 0.58, lt.y * 0.42 + dirY * 0.58, lt.z * 0.42 + dirZ * 0.58).normalize();
        } else {
          st.lastTangent.set(dirX, dirY, dirZ);
          st.hasTangent = true;
        }
      }
    } else {
      const isScatter = preset === 'stipple' || preset === 'splatter';
      const refStep = Math.max(0.002, localR * (isMobile ? 0.16 : 0.12));
      const stepSize = isScatter
        ? Math.max(0.003, localR * (isMobile ? 0.34 : 0.22))
        : Math.max(0.002, localR * (isMobile ? 0.24 : 0.13));
      const maxSteps = isMobile ? (isScatter ? 12 : 16) : (isScatter ? 28 : 40);

      if (dist > 1e-5) {
        if (st.hasTangent) {
          const lt = st.lastTangent;
          lt.set(lt.x * 0.45 + dirX * 0.55, lt.y * 0.45 + dirY * 0.55, lt.z * 0.45 + dirZ * 0.55).normalize();
        } else {
          st.lastTangent.set(dirX, dirY, dirZ);
          st.hasTangent = true;
        }
      }

      if (dist > stepSize) {
        const steps = Math.min(maxSteps, Math.ceil(dist / stepSize));
        const actualStepDist = dist / steps;
        const flowScale = Math.max(0.3, Math.min(1, actualStepDist / refStep));
        const prevTan = st.hasTangent ? st.lastTangent : null;
        const m0x = prevTan ? prevTan.x * dist * 0.5 : dx * 0.5;
        const m0y = prevTan ? prevTan.y * dist * 0.5 : dy * 0.5;
        const m0z = prevTan ? prevTan.z * dist * 0.5 : dz * 0.5;
        const m1x = dirX * dist * 0.5;
        const m1y = dirY * dist * 0.5;
        const m1z = dirZ * dist * 0.5;

        for (let s = 1; s <= steps; s++) {
          const t = s / steps;
          const t2 = t * t, t3 = t2 * t;
          const h00 = 2 * t3 - 3 * t2 + 1;
          const h10 = t3 - 2 * t2 + t;
          const h01 = -2 * t3 + 3 * t2;
          const h11 = t3 - t2;

          _tmpLocal.set(
            h00 * prev.x + h10 * m0x + h01 * curr.x + h11 * m1x,
            h00 * prev.y + h10 * m0y + h01 * curr.y + h11 * m1y,
            h00 * prev.z + h10 * m0z + h01 * curr.z + h11 * m1z
          );
          _tmpNormal.copy(st.lastNormal).lerp(hit.localNormal, t).normalize();
          this._applyDab(_tmpLocal, _tmpNormal, flowScale);
        }
        st.lastTangent.set(dirX, dirY, dirZ);
        st.hasTangent = true;
      } else {
        const flowScale = Math.max(0.35, Math.min(1, dist > 1e-5 ? dist / refStep : 1));
        this._applyDab(curr, hit.localNormal, flowScale);
      }
    }

    st.lastLocal.copy(curr);
    st.lastNormal.copy(hit.localNormal);
    if (hit.uv && st.hitUv) {
      st.hitUv.x = hit.uv.x;
      st.hitUv.y = hit.uv.y;
    }
    (opts.onStrokeStep || this._attached?.onStrokeStep)?.(st);
    return hit;
  }

  _initSegment(seg, ax, ay, az, bx, by, bz, nx, ny, nz, pad) {
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const lenSq = abx * abx + aby * aby + abz * abz;
    seg.ax = ax; seg.ay = ay; seg.az = az;
    seg.bx = bx; seg.by = by; seg.bz = bz;
    seg.abx = abx; seg.aby = aby; seg.abz = abz;
    seg.lenSq = lenSq;
    seg.invLenSq = lenSq > 1e-12 ? 1 / lenSq : 0;
    seg.nx = nx; seg.ny = ny; seg.nz = nz;

    let tx = 0, ty = 0, tz = 0;
    if (lenSq > 1e-12) {
      const dot = abx * nx + aby * ny + abz * nz;
      tx = abx - nx * dot;
      ty = aby - ny * dot;
      tz = abz - nz * dot;
    }
    let tLen = Math.hypot(tx, ty, tz);
    if (tLen < 1e-4) {
      const rx = Math.abs(ny) < 0.9 ? 0 : 1;
      const ry = Math.abs(ny) < 0.9 ? 1 : 0;
      tx = ry * nz;
      ty = -rx * nz;
      tz = rx * ny - ry * nx;
      tLen = Math.hypot(tx, ty, tz) || 1;
    }
    tx /= tLen; ty /= tLen; tz /= tLen;
    let bxv = ny * tz - nz * ty;
    let byv = nz * tx - nx * tz;
    let bzv = nx * ty - ny * tx;
    const bLen = Math.hypot(bxv, byv, bzv) || 1;
    seg.tx = tx; seg.ty = ty; seg.tz = tz;
    seg.bxv = bxv / bLen; seg.byv = byv / bLen; seg.bzv = bzv / bLen;
    seg.minX = (ax < bx ? ax : bx) - pad;
    seg.minY = (ay < by ? ay : by) - pad;
    seg.minZ = (az < bz ? az : bz) - pad;
    seg.maxX = (ax > bx ? ax : bx) + pad;
    seg.maxY = (ay > by ? ay : by) + pad;
    seg.maxZ = (az > bz ? az : bz) + pad;
  }

  _cloneMirroredSegment(src, dst, sym, pad) {
    let ax = src.ax, ay = src.ay, az = src.az;
    let bx = src.bx, by = src.by, bz = src.bz;
    let nx = src.nx, ny = src.ny, nz = src.nz;
    let tx = src.tx, ty = src.ty, tz = src.tz;
    let bxv = src.bxv, byv = src.byv, bzv = src.bzv;
    if (sym === 'x') {
      ax = -ax; bx = -bx; nx = -nx; tx = -tx; bxv = -bxv;
    } else if (sym === 'y') {
      ay = -ay; by = -by; ny = -ny; ty = -ty; byv = -byv;
    } else if (sym === 'z') {
      az = -az; bz = -bz; nz = -nz; tz = -tz; bzv = -bzv;
    }
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    dst.ax = ax; dst.ay = ay; dst.az = az;
    dst.bx = bx; dst.by = by; dst.bz = bz;
    dst.abx = abx; dst.aby = aby; dst.abz = abz;
    dst.lenSq = src.lenSq; dst.invLenSq = src.invLenSq;
    dst.nx = nx; dst.ny = ny; dst.nz = nz;
    dst.tx = tx; dst.ty = ty; dst.tz = tz;
    dst.bxv = bxv; dst.byv = byv; dst.bzv = bzv;
    dst.minX = (ax < bx ? ax : bx) - pad;
    dst.minY = (ay < by ? ay : by) - pad;
    dst.minZ = (az < bz ? az : bz) - pad;
    dst.maxX = (ax > bx ? ax : bx) + pad;
    dst.maxY = (ay > by ? ay : by) + pad;
    dst.maxZ = (az > bz ? az : bz) + pad;
  }

  _recordVertex(st, vIdx) {
    if (!st.touchedFlag[vIdx]) {
      st.touchedFlag[vIdx] = 1;
      st.touched.push(vIdx);
    }
  }

  _touchTexel(st, pxIdx) {
    if (st.touchedStamp[pxIdx] !== st.stampId) {
      st.touchedStamp[pxIdx] = st.stampId;
      st.touched.push(pxIdx);
      st.alphaMask[pxIdx] = 0;
      const po = pxIdx * 4;
      const data = st.data;
      const snap = st.startSnap;
      snap[po] = data[po];
      snap[po + 1] = data[po + 1];
      snap[po + 2] = data[po + 2];
      snap[po + 3] = data[po + 3];
      if (st.accumData) {
        const acc = st.accumData;
        acc[po] = data[po];
        acc[po + 1] = data[po + 1];
        acc[po + 2] = data[po + 2];
        acc[po + 3] = data[po + 3];
      }
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

      const seedIdx = hit.face ? hit.face.a : 0;
      const so = seedIdx * stride;
      const sr = arr[so], sg = arr[so + 1], sb = arr[so + 2];
      const tolSq = 0.08;
      for (let i = 0; i < posAttr.count; i++) {
        const vo = i * stride;
        const dr = arr[vo] - sr, dg = arr[vo + 1] - sg, db = arr[vo + 2] - sb;
        if (dr * dr + dg * dg + db * db <= tolSq) {
          this._recordVertex(st, i);
          arr[vo] = arr[vo] + (rF - arr[vo]) * alpha;
          arr[vo + 1] = arr[vo + 1] + (gF - arr[vo + 1]) * alpha;
          arr[vo + 2] = arr[vo + 2] + (bF - arr[vo + 2]) * alpha;
          if (stride === 4) arr[vo + 3] = 1;
        }
      }
      st.colAttr.needsUpdate = true;
      return;
    }

    const w = st.width;
    const h = st.height;
    const data = st.data;
    const triData = getPaintTriData(st.mesh, w, h, true);
    const owner = triData?.pixelTriOwner || null;

    const uv = hit.uv || { x: 0.5, y: 0.5 };
    const sx = Math.max(0, Math.min(w - 1, Math.floor(wrapUnit(uv.x) * w)));
    const sy = Math.max(0, Math.min(h - 1, Math.floor(wrapUnit(uv.y) * h)));
    const seed = sy * w + sx;
    const seedOff = seed * 4;
    const sr = data[seedOff], sg = data[seedOff + 1], sb = data[seedOff + 2];
    const tol = Math.round(14 + (1 - Math.max(0, Math.min(1, this.hardness))) * 46);
    const tolSq = tol * tol * 3;

    const visited = new Uint8Array(w * h);
    const queue = [seed];
    visited[seed] = 1;
    let qHead = 0;

    while (qHead < queue.length) {
      const cur = queue[qHead++];
      const co = cur * 4;
      const cr = data[co], cg = data[co + 1], cb = data[co + 2];
      const dr = cr - sr, dg = cg - sg, db = cb - sb;
      if (dr * dr + dg * dg + db * db > tolSq) continue;

      this._touchTexel(st, cur);
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

  _applySegments(segCount, localR, flowScale = 1) {
    const st = this._stroke;
    if (!st || segCount <= 0) return;

    let totalSegs = segCount;
    const sym = this.symmetry;
    if (sym === 'x' || sym === 'y' || sym === 'z') {
      let mirrorAxisSign = false;
      for (let i = 0; i < segCount; i++) {
        const s = this._segPool[i];
        const v0 = sym === 'x' ? s.ax : sym === 'y' ? s.ay : s.az;
        const v1 = sym === 'x' ? s.bx : sym === 'y' ? s.by : s.bz;
        if (Math.abs(v0) > 1e-4 || Math.abs(v1) > 1e-4) { mirrorAxisSign = true; break; }
      }
      if (mirrorAxisSign) {
        for (let i = 0; i < segCount; i++) {
          this._cloneMirroredSegment(this._segPool[i], this._segPool[segCount + i], sym, localR);
        }
        totalSegs = segCount * 2;
      }
    }

    const r2 = localR * localR;
    const strength = Math.max(0.02, Math.min(1, Number(this.strength) || 0.5));
    const hardness = Math.max(0, Math.min(1, Number(this.hardness) ?? 0.45));

    if (st.mode === 'vertex') {
      this._applyVertexSegments(st, this._segPool, totalSegs, localR, r2, strength, hardness, flowScale);
      return;
    }
    this._applyTextureSegments(st, this._segPool, totalSegs, localR, r2, strength, hardness, flowScale);
  }

  _applyVertexSegments(st, segs, segCount, localR, r2, strength, hardness, flowScale = 1) {
    const triData = getPaintTriData(st.mesh, 0, 0, false);
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
    const preset = tool === 'brush' ? (st.brushPreset || 'round') : 'round';
    const invLocalR = 1 / localR;
    const [tr, tg, tb] = st.rgb;
    const targetR = tr / 255, targetG = tg / 255, targetB = tb / 255;
    const frontOnly = this.frontFacesOnly;

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let s = 0; s < segCount; s++) {
      const seg = segs[s];
      if (seg.minX < minX) minX = seg.minX;
      if (seg.minY < minY) minY = seg.minY;
      if (seg.minZ < minZ) minZ = seg.minZ;
      if (seg.maxX > maxX) maxX = seg.maxX;
      if (seg.maxY > maxY) maxY = seg.maxY;
      if (seg.maxZ > maxZ) maxZ = seg.maxZ;
    }

    let changed = false;
    for (let i = 0; i < vCount; i++) {
      const o = i * 3;
      const vx = posArr[o], vy = posArr[o + 1], vz = posArr[o + 2];
      if (vx < minX || vx > maxX || vy < minY || vy > maxY || vz < minZ || vz > maxZ) continue;

      let bestD2 = r2;
      let bestSeg = null;
      let bestDdx = 0, bestDdy = 0, bestDdz = 0;
      for (let s = 0; s < segCount; s++) {
        const seg = segs[s];
        if (vx < seg.minX || vx > seg.maxX || vy < seg.minY || vy > seg.maxY || vz < seg.minZ || vz > seg.maxZ) continue;
        if (frontOnly && norArr) {
          const dot = norArr[o] * seg.nx + norArr[o + 1] * seg.ny + norArr[o + 2] * seg.nz;
          if (dot < -0.15) continue;
        }
        const px0 = vx - seg.ax, py0 = vy - seg.ay, pz0 = vz - seg.az;
        let t = seg.invLenSq > 0 ? (px0 * seg.abx + py0 * seg.aby + pz0 * seg.abz) * seg.invLenSq : 0;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        const ddx = vx - (seg.ax + seg.abx * t);
        const ddy = vy - (seg.ay + seg.aby * t);
        const ddz = vz - (seg.az + seg.abz * t);
        const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
        if (d2 < bestD2) {
          bestD2 = d2;
          bestSeg = seg;
          bestDdx = ddx; bestDdy = ddy; bestDdz = ddz;
        }
      }
      if (!bestSeg) continue;

      const f = evalPresetFalloff(
        preset,
        { nx: bestSeg.nx, ny: bestSeg.ny, nz: bestSeg.nz, tx: bestSeg.tx, ty: bestSeg.ty, tz: bestSeg.tz, bx: bestSeg.bxv, by: bestSeg.byv, bz: bestSeg.bzv },
        bestDdx, bestDdy, bestDdz, bestD2, invLocalR, hardness, this._splatterDrops, st.dabSeed || 1
      );
      if (f <= 0) continue;

      this._recordVertex(st, i);
      const co = i * stride;
      if (tool === 'airbrush') {
        const a = Math.min(1, f * strength * 0.32 * flowScale);
        arr[co] += (targetR - arr[co]) * a;
        arr[co + 1] += (targetG - arr[co + 1]) * a;
        arr[co + 2] += (targetB - arr[co + 2]) * a;
      } else if (tool === 'eraser') {
        const nextA = Math.min(1, f * strength);
        if (nextA > mask[i]) mask[i] = nextA;
        const a = mask[i];
        arr[co] = startSnap[co] + (baseSnap[co] - startSnap[co]) * a;
        arr[co + 1] = startSnap[co + 1] + (baseSnap[co + 1] - startSnap[co + 1]) * a;
        arr[co + 2] = startSnap[co + 2] + (baseSnap[co + 2] - startSnap[co + 2]) * a;
      } else {
        const nextA = Math.min(1, f * strength);
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

  _applyTextureSegments(st, segs, segCount, localR, r2, strength, hardness, flowScale = 1) {
    const w = st.width;
    const h = st.height;
    const triData = getPaintTriData(st.mesh, 0, 0, false);
    if (!triData || !triData.uvArr) return;

    const { tris, idx, posArr, triAabb, triFaceNormal, triUvData, triUvValid, grid } = triData;
    const data = st.data;
    const startSnap = st.startSnap;
    const baseSnap = st.baseSnap;
    const alphaMask = st.alphaMask;
    const touchedStamp = st.touchedStamp;
    const stampId = st.stampId;
    const touched = st.touched;
    const acc = st.accumData;
    const tool = st.tool;
    const preset = tool === 'brush' ? (st.brushPreset || 'round') : 'round';
    const [tr, tg, tb] = st.rgb;
    const frontOnly = this.frontFacesOnly;
    const invLocalR = 1 / localR;
    const isSimpleCapsule = preset === 'round' || preset === 'hard' || preset === 'soft';
    const capHardness = preset === 'hard' ? Math.max(0.88, hardness) : preset === 'soft' ? Math.min(0.18, hardness * 0.3) : hardness;
    const isSoftPreset = preset === 'soft';
    const isAirbrush = tool === 'airbrush';
    const isEraser = tool === 'eraser';
    const airFactor = strength * 0.24 * flowScale;
    const dabStampId = this._nextDabStamp(w * h);
    const dabStamp = this._dabStamp;
    const invW = 1 / w;
    const invH = 1 / h;

    let dirtyMinX = w, dirtyMinY = h, dirtyMaxX = -1, dirtyMaxY = -1;
    const nearSegIdx = new Int32Array(segCount);

    const processTri = (t) => {
      if (!triUvValid[t]) return;
      const b6 = t * 6;
      const minX = triAabb[b6], minY = triAabb[b6 + 1], minZ = triAabb[b6 + 2];
      const maxX = triAabb[b6 + 3], maxY = triAabb[b6 + 4], maxZ = triAabb[b6 + 5];
      const t3 = t * 3;
      const fnx = triFaceNormal[t3], fny = triFaceNormal[t3 + 1], fnz = triFaceNormal[t3 + 2];

      let nearCount = 0;
      for (let s = 0; s < segCount; s++) {
        const seg = segs[s];
        if (maxX < seg.minX || minX > seg.maxX || maxY < seg.minY || minY > seg.maxY || maxZ < seg.minZ || minZ > seg.maxZ) {
          continue;
        }
        if (frontOnly && (fnx * seg.nx + fny * seg.ny + fnz * seg.nz) < -0.15) continue;
        nearSegIdx[nearCount++] = s;
      }
      if (nearCount === 0) return;

      const ia = idx ? idx[t3] : t3;
      const ib = idx ? idx[t3 + 1] : t3 + 1;
      const ic = idx ? idx[t3 + 2] : t3 + 2;

      const pa = ia * 3, pb = ib * 3, pc = ic * 3;
      const ax = posArr[pa], ay = posArr[pa + 1], az = posArr[pa + 2];
      const bx = posArr[pb], by = posArr[pb + 1], bz = posArr[pb + 2];
      const cx = posArr[pc], cy = posArr[pc + 1], cz = posArr[pc + 2];

      const uo = t * 11;
      const ua = triUvData[uo], va = triUvData[uo + 1];
      const u0x = triUvData[uo + 2], u0y = triUvData[uo + 3];
      const u1x = triUvData[uo + 4], u1y = triUvData[uo + 5];
      const invDet = triUvData[uo + 6];
      const minU = triUvData[uo + 7], maxU = triUvData[uo + 8];
      const minV = triUvData[uo + 9], maxV = triUvData[uo + 10];

      let x0 = Math.max(0, Math.floor(minU * w) - 1);
      let x1 = Math.min(w - 1, Math.ceil(maxU * w) + 1);
      let y0 = Math.max(0, Math.floor(minV * h) - 1);
      let y1 = Math.min(h - 1, Math.ceil(maxV * h) + 1);

      // Recorte exacto UV por gradiente en plano del triángulo (evita recorrer triángulos grandes completos)
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > 196) {
        const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
        const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
        const E11 = e1x * e1x + e1y * e1y + e1z * e1z;
        const E12 = e1x * e2x + e1y * e2y + e1z * e2z;
        const E22 = e2x * e2x + e2y * e2y + e2z * e2z;
        const detE = E11 * E22 - E12 * E12;
        if (detE > 1e-12) {
          const invDetE = 1 / detE;
          const g1x = (E22 * e1x - E12 * e2x) * invDetE;
          const g1y = (E22 * e1y - E12 * e2y) * invDetE;
          const g1z = (E22 * e1z - E12 * e2z) * invDetE;
          const g2x = (E11 * e2x - E12 * e1x) * invDetE;
          const g2y = (E11 * e2y - E12 * e1y) * invDetE;
          const g2z = (E11 * e2z - E12 * e1z) * invDetE;

          const gradUx = u0x * g1x + u1x * g2x;
          const gradUy = u0x * g1y + u1x * g2y;
          const gradUz = u0x * g1z + u1x * g2z;
          const gradVx = u0y * g1x + u1y * g2x;
          const gradVy = u0y * g1y + u1y * g2y;
          const gradVz = u0y * g1z + u1y * g2z;

          const padU = Math.hypot(gradUx, gradUy, gradUz) * localR + 3 * invW;
          const padV = Math.hypot(gradVx, gradVy, gradVz) * localR + 3 * invH;
          let cMinU = Infinity, cMaxU = -Infinity, cMinV = Infinity, cMaxV = -Infinity;
          for (let ni = 0; ni < nearCount; ni++) {
            const seg = segs[nearSegIdx[ni]];
            let dxP = seg.ax - ax, dyP = seg.ay - ay, dzP = seg.az - az;
            let uP = ua + dxP * gradUx + dyP * gradUy + dzP * gradUz;
            let vP = va + dxP * gradVx + dyP * gradVy + dzP * gradVz;
            if (uP < cMinU) cMinU = uP; if (uP > cMaxU) cMaxU = uP;
            if (vP < cMinV) cMinV = vP; if (vP > cMaxV) cMaxV = vP;
            if (seg.lenSq > 1e-12) {
              dxP = seg.bx - ax; dyP = seg.by - ay; dzP = seg.bz - az;
              uP = ua + dxP * gradUx + dyP * gradUy + dzP * gradUz;
              vP = va + dxP * gradVx + dyP * gradVy + dzP * gradVz;
              if (uP < cMinU) cMinU = uP; if (uP > cMaxU) cMaxU = uP;
              if (vP < cMinV) cMinV = vP; if (vP > cMaxV) cMaxV = vP;
            }
          }
          const cx0 = Math.floor((cMinU - padU) * w);
          const cx1 = Math.ceil((cMaxU + padU) * w);
          const cy0 = Math.floor((cMinV - padV) * h);
          const cy1 = Math.ceil((cMaxV + padV) * h);
          if (cx0 > x0) x0 = cx0;
          if (cx1 < x1) x1 = cx1;
          if (cy0 > y0) y0 = cy0;
          if (cy1 < y1) y1 = cy1;
          if (x0 > x1 || y0 > y1) return;
        }
      }

      const triUvSpan = Math.max(1e-4, Math.max((maxU - minU) * w, (maxV - minV) * h));
      const baryPad = -Math.min(0.09, 1.55 / triUvSpan);

      for (let py = y0; py <= y1; py++) {
        const pv = (py + 0.5) * invH;
        const dv = pv - va;
        const rowOff = py * w;
        for (let px = x0; px <= x1; px++) {
          const pxIdx = rowOff + px;
          const pu = (px + 0.5) * invW;
          const du = pu - ua;
          let w1 = (du * u1y - u1x * dv) * invDet;
          let w2 = (u0x * dv - du * u0y) * invDet;
          let w0 = 1 - w1 - w2;
          const strictlyInside = w0 >= 0 && w1 >= 0 && w2 >= 0;
          if (!strictlyInside) {
            if (w0 < baryPad || w1 < baryPad || w2 < baryPad) continue;
            if (dabStamp[pxIdx] === dabStampId) continue;
            w0 = w0 < 0 ? 0 : w0;
            w1 = w1 < 0 ? 0 : w1;
            w2 = w2 < 0 ? 0 : w2;
            const ws = w0 + w1 + w2 || 1;
            w0 /= ws; w1 /= ws; w2 /= ws;
          }

          const wx = ax * w0 + bx * w1 + cx * w2;
          const wy = ay * w0 + by * w1 + cy * w2;
          const wz = az * w0 + bz * w1 + cz * w2;

          let bestD2 = r2;
          let bestSeg = null;
          let bestDdx = 0, bestDdy = 0, bestDdz = 0;

          for (let ni = 0; ni < nearCount; ni++) {
            const seg = segs[nearSegIdx[ni]];
            const px0 = wx - seg.ax, py0 = wy - seg.ay, pz0 = wz - seg.az;
            let stParam = seg.invLenSq > 0 ? (px0 * seg.abx + py0 * seg.aby + pz0 * seg.abz) * seg.invLenSq : 0;
            if (stParam < 0) stParam = 0; else if (stParam > 1) stParam = 1;
            const ddx = wx - (seg.ax + seg.abx * stParam);
            const ddy = wy - (seg.ay + seg.aby * stParam);
            const ddz = wz - (seg.az + seg.abz * stParam);
            const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
            if (d2 < bestD2) {
              bestD2 = d2;
              bestSeg = seg;
              bestDdx = ddx; bestDdy = ddy; bestDdz = ddz;
            }
          }
          if (!bestSeg) continue;

          let bestF;
          if (isSimpleCapsule) {
            bestF = evalBrushFalloff(Math.sqrt(bestD2) * invLocalR, capHardness);
            if (isSoftPreset) bestF = bestF * bestF * 0.72;
          } else {
            bestF = evalPresetFalloff(
              preset,
              { nx: bestSeg.nx, ny: bestSeg.ny, nz: bestSeg.nz, tx: bestSeg.tx, ty: bestSeg.ty, tz: bestSeg.tz, bx: bestSeg.bxv, by: bestSeg.byv, bz: bestSeg.bzv },
              bestDdx, bestDdy, bestDdz, bestD2, invLocalR, hardness, this._splatterDrops, st.dabSeed || 1
            );
          }
          if (bestF <= 0) continue;
          if (!strictlyInside && dabStamp[pxIdx] === dabStampId) continue;
          if (strictlyInside) dabStamp[pxIdx] = dabStampId;

          const po = pxIdx * 4;
          if (touchedStamp[pxIdx] !== stampId) {
            touchedStamp[pxIdx] = stampId;
            touched.push(pxIdx);
            alphaMask[pxIdx] = 0;
            startSnap[po] = data[po];
            startSnap[po + 1] = data[po + 1];
            startSnap[po + 2] = data[po + 2];
            startSnap[po + 3] = data[po + 3];
            if (acc) {
              acc[po] = data[po];
              acc[po + 1] = data[po + 1];
              acc[po + 2] = data[po + 2];
              acc[po + 3] = data[po + 3];
            }
          }

          if (isAirbrush) {
            const a = Math.min(1, bestF * airFactor);
            const nr = acc[po] + (tr - acc[po]) * a;
            const ng = acc[po + 1] + (tg - acc[po + 1]) * a;
            const nb = acc[po + 2] + (tb - acc[po + 2]) * a;
            acc[po] = nr; acc[po + 1] = ng; acc[po + 2] = nb; acc[po + 3] = 255;
            data[po] = (nr + 0.5) | 0;
            data[po + 1] = (ng + 0.5) | 0;
            data[po + 2] = (nb + 0.5) | 0;
            data[po + 3] = 255;
          } else if (isEraser) {
            const nextA = Math.min(1, bestF * strength);
            if (nextA > alphaMask[pxIdx]) alphaMask[pxIdx] = nextA;
            if (baseSnap) {
              const a = alphaMask[pxIdx];
              data[po] = (startSnap[po] + (baseSnap[po] - startSnap[po]) * a + 0.5) | 0;
              data[po + 1] = (startSnap[po + 1] + (baseSnap[po + 1] - startSnap[po + 1]) * a + 0.5) | 0;
              data[po + 2] = (startSnap[po + 2] + (baseSnap[po + 2] - startSnap[po + 2]) * a + 0.5) | 0;
              data[po + 3] = 255;
            }
          } else {
            const nextA = Math.min(1, bestF * strength);
            if (nextA > alphaMask[pxIdx]) alphaMask[pxIdx] = nextA;
            const a = alphaMask[pxIdx];
            data[po] = (startSnap[po] + (tr - startSnap[po]) * a + 0.5) | 0;
            data[po + 1] = (startSnap[po + 1] + (tg - startSnap[po + 1]) * a + 0.5) | 0;
            data[po + 2] = (startSnap[po + 2] + (tb - startSnap[po + 2]) * a + 0.5) | 0;
            data[po + 3] = 255;
          }
          if (px < dirtyMinX) dirtyMinX = px;
          if (px > dirtyMaxX) dirtyMaxX = px;
          if (py < dirtyMinY) dirtyMinY = py;
          if (py > dirtyMaxY) dirtyMaxY = py;
        }
      }
    };

    if (grid) {
      const triStampId = this._nextTriStamp(tris);
      const triStamp = this._triStamp;
      const g = grid.g;
      const g2 = grid.g2;
      const { cellStarts, cellTris } = grid;
      for (let s = 0; s < segCount; s++) {
        const seg = segs[s];
        let cx0 = Math.floor((seg.minX - grid.minX) * grid.invX);
        let cy0 = Math.floor((seg.minY - grid.minY) * grid.invY);
        let cz0 = Math.floor((seg.minZ - grid.minZ) * grid.invZ);
        let cx1 = Math.floor((seg.maxX - grid.minX) * grid.invX);
        let cy1 = Math.floor((seg.maxY - grid.minY) * grid.invY);
        let cz1 = Math.floor((seg.maxZ - grid.minZ) * grid.invZ);
        if (cx1 < 0 || cx0 >= g || cy1 < 0 || cy0 >= g || cz1 < 0 || cz0 >= g) continue;
        if (cx0 < 0) cx0 = 0; if (cx1 >= g) cx1 = g - 1;
        if (cy0 < 0) cy0 = 0; if (cy1 >= g) cy1 = g - 1;
        if (cz0 < 0) cz0 = 0; if (cz1 >= g) cz1 = g - 1;
        for (let z = cz0; z <= cz1; z++) {
          const zOff = z * g2;
          for (let y = cy0; y <= cy1; y++) {
            const yOff = zOff + y * g;
            for (let x = cx0; x <= cx1; x++) {
              const ci = yOff + x;
              const start = cellStarts[ci];
              const end = cellStarts[ci + 1];
              for (let k = start; k < end; k++) {
                const t = cellTris[k];
                if (triStamp[t] === triStampId) continue;
                triStamp[t] = triStampId;
                processTri(t);
              }
            }
          }
        }
      }
    } else {
      for (let t = 0; t < tris; t++) processTri(t);
    }

    if (dirtyMaxX >= dirtyMinX) {
      st.texture.markRegionDirty(dirtyMinX, dirtyMinY, dirtyMaxX, dirtyMaxY, true);
    }
  }

  _applyDab(localPoint, localNormal, flowScale = 1) {
    const st = this._stroke;
    if (!st) return;

    const localR = this._computeLocalRadius(st.mesh);
    const r2 = localR * localR;
    const symCount = this._fillSymmetryDabs(
      localPoint,
      localNormal,
      st.hasTangent ? st.lastTangent : null
    );
    st.dabSeed = ((st.dabSeed || 0) + 1) | 0;
    if (st.brushPreset === 'splatter') {
      fillSplatterDrops(st.dabSeed, this._splatterDrops);
    }
    const strength = Math.max(0.02, Math.min(1, Number(this.strength) || 0.5));
    const hardness = Math.max(0, Math.min(1, Number(this.hardness) ?? 0.45));

    if (st.mode === 'vertex') {
      this._applyVertexDab(st, this._symDabs, symCount, localR, r2, strength, hardness, flowScale);
      return;
    }
    this._applyTextureDab(st, this._symDabs, symCount, localR, r2, strength, hardness, flowScale);
  }

  _applyVertexDab(st, symDabs, symCount, localR, r2, strength, hardness, flowScale = 1) {
    const triData = getPaintTriData(st.mesh, 0, 0, false);
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
    const preset = tool === 'brush' ? (st.brushPreset || 'round') : 'round';
    const invLocalR = 1 / localR;
    const splatterDrops = this._splatterDrops;
    const dabSeed = st.dabSeed || 1;
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
        for (let s = 0; s < symCount; s++) {
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
      for (let s = 0; s < symCount; s++) {
        const d = symDabs[s];
        const dx = vx - d.cx, dy = vy - d.cy, dz = vz - d.cz;
        if (Math.abs(dx) > localR || Math.abs(dy) > localR || Math.abs(dz) > localR) continue;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= r2) continue;
        if (this.frontFacesOnly && norArr) {
          const dot = norArr[o] * d.nx + norArr[o + 1] * d.ny + norArr[o + 2] * d.nz;
          if (dot < -0.15) continue;
        }
        const f = evalPresetFalloff(preset, d, dx, dy, dz, d2, invLocalR, hardness, splatterDrops, dabSeed);
        if (f > bestF) bestF = f;
      }
      if (bestF <= 0) continue;

      this._recordVertex(st, i);
      const co = i * stride;
      if (tool === 'airbrush') {
        const a = Math.min(1, bestF * strength * 0.35 * flowScale);
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

  _applyTextureDab(st, symDabs, symCount, localR, r2, strength, hardness, flowScale = 1) {
    const w = st.width;
    const h = st.height;
    const triData = getPaintTriData(st.mesh, 0, 0, false);
    if (!triData || !triData.uvArr) return;

    const { tris, idx, posArr, uvArr, triAabb, triFaceNormal, triUvData, triUvValid, grid } = triData;
    const data = st.data;
    const startSnap = st.startSnap;
    const baseSnap = st.baseSnap;
    const alphaMask = st.alphaMask;
    const touchedStamp = st.touchedStamp;
    const stampId = st.stampId;
    const touched = st.touched;
    const acc = st.accumData;
    const tool = st.tool;
    const preset = tool === 'brush' ? (st.brushPreset || 'round') : 'round';
    const splatterDrops = this._splatterDrops;
    const dabSeed = st.dabSeed || 1;
    const [tr, tg, tb] = st.rgb;
    const frontOnly = this.frontFacesOnly;
    const invLocalR = 1 / localR;
    const invW = 1 / w;
    const invH = 1 / h;

    if (tool === 'smudge' && !st.smudgeColor) {
      let sampleX = 0, sampleY = 0;
      if (st.hitUv) {
        sampleX = Math.max(0, Math.min(w - 1, Math.floor(wrapUnit(st.hitUv.x) * w)));
        sampleY = Math.max(0, Math.min(h - 1, Math.floor(wrapUnit(st.hitUv.y) * h)));
      } else {
        const d0 = symDabs[0];
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
      }
      const so = (sampleY * w + sampleX) * 4;
      st.smudgeColor = [data[so], data[so + 1], data[so + 2]];
    }

    const dabStampId = this._nextDabStamp(w * h);
    const dabStamp = this._dabStamp;
    let dirtyMinX = w, dirtyMinY = h, dirtyMaxX = -1, dirtyMaxY = -1;
    const nearDabs = [0, 0];

    const processTri = (t) => {
      if (!triUvValid[t]) return;
      const b6 = t * 6;
      const minX = triAabb[b6], minY = triAabb[b6 + 1], minZ = triAabb[b6 + 2];
      const maxX = triAabb[b6 + 3], maxY = triAabb[b6 + 4], maxZ = triAabb[b6 + 5];

      const t3 = t * 3;
      const fnx = triFaceNormal[t3], fny = triFaceNormal[t3 + 1], fnz = triFaceNormal[t3 + 2];
      let nearCount = 0;
      for (let s = 0; s < symCount; s++) {
        const d = symDabs[s];
        const cx = d.cx < minX ? minX : d.cx > maxX ? maxX : d.cx;
        const cy = d.cy < minY ? minY : d.cy > maxY ? maxY : d.cy;
        const cz = d.cz < minZ ? minZ : d.cz > maxZ ? maxZ : d.cz;
        const dx = cx - d.cx, dy = cy - d.cy, dz = cz - d.cz;
        if (dx * dx + dy * dy + dz * dz <= r2) {
          if (!frontOnly || (fnx * d.nx + fny * d.ny + fnz * d.nz) >= -0.15) {
            nearDabs[nearCount++] = s;
          }
        }
      }
      if (nearCount === 0) return;

      const ia = idx ? idx[t3] : t3;
      const ib = idx ? idx[t3 + 1] : t3 + 1;
      const ic = idx ? idx[t3 + 2] : t3 + 2;

      const pa = ia * 3, pb = ib * 3, pc = ic * 3;
      const ax = posArr[pa], ay = posArr[pa + 1], az = posArr[pa + 2];
      const bx = posArr[pb], by = posArr[pb + 1], bz = posArr[pb + 2];
      const cx = posArr[pc], cy = posArr[pc + 1], cz = posArr[pc + 2];

      const uo = t * 11;
      const ua = triUvData[uo], va = triUvData[uo + 1];
      const u0x = triUvData[uo + 2], u0y = triUvData[uo + 3];
      const u1x = triUvData[uo + 4], u1y = triUvData[uo + 5];
      const invDet = triUvData[uo + 6];
      const minU = triUvData[uo + 7], maxU = triUvData[uo + 8];
      const minV = triUvData[uo + 9], maxV = triUvData[uo + 10];

      let x0 = Math.max(0, Math.floor(minU * w) - 1);
      let x1 = Math.min(w - 1, Math.ceil(maxU * w) + 1);
      let y0 = Math.max(0, Math.floor(minV * h) - 1);
      let y1 = Math.min(h - 1, Math.ceil(maxV * h) + 1);

      if ((x1 - x0 + 1) * (y1 - y0 + 1) > 196) {
        const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
        const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
        const E11 = e1x * e1x + e1y * e1y + e1z * e1z;
        const E12 = e1x * e2x + e1y * e2y + e1z * e2z;
        const E22 = e2x * e2x + e2y * e2y + e2z * e2z;
        const detE = E11 * E22 - E12 * E12;
        if (detE > 1e-12) {
          const invDetE = 1 / detE;
          const g1x = (E22 * e1x - E12 * e2x) * invDetE;
          const g1y = (E22 * e1y - E12 * e2y) * invDetE;
          const g1z = (E22 * e1z - E12 * e2z) * invDetE;
          const g2x = (E11 * e2x - E12 * e1x) * invDetE;
          const g2y = (E11 * e2y - E12 * e1y) * invDetE;
          const g2z = (E11 * e2z - E12 * e1z) * invDetE;
          const gradUx = u0x * g1x + u1x * g2x, gradUy = u0x * g1y + u1x * g2y, gradUz = u0x * g1z + u1x * g2z;
          const gradVx = u0y * g1x + u1y * g2x, gradVy = u0y * g1y + u1y * g2y, gradVz = u0y * g1z + u1y * g2z;
          const padU = Math.hypot(gradUx, gradUy, gradUz) * localR + 3 * invW;
          const padV = Math.hypot(gradVx, gradVy, gradVz) * localR + 3 * invH;
          let cMinU = Infinity, cMaxU = -Infinity, cMinV = Infinity, cMaxV = -Infinity;
          for (let ni = 0; ni < nearCount; ni++) {
            const d = symDabs[nearDabs[ni]];
            const dxP = d.cx - ax, dyP = d.cy - ay, dzP = d.cz - az;
            const uP = ua + dxP * gradUx + dyP * gradUy + dzP * gradUz;
            const vP = va + dxP * gradVx + dyP * gradVy + dzP * gradVz;
            if (uP < cMinU) cMinU = uP; if (uP > cMaxU) cMaxU = uP;
            if (vP < cMinV) cMinV = vP; if (vP > cMaxV) cMaxV = vP;
          }
          const cx0 = Math.floor((cMinU - padU) * w);
          const cx1 = Math.ceil((cMaxU + padU) * w);
          const cy0 = Math.floor((cMinV - padV) * h);
          const cy1 = Math.ceil((cMaxV + padV) * h);
          if (cx0 > x0) x0 = cx0;
          if (cx1 < x1) x1 = cx1;
          if (cy0 > y0) y0 = cy0;
          if (cy1 < y1) y1 = cy1;
          if (x0 > x1 || y0 > y1) return;
        }
      }

      const triUvSpan = Math.max(1e-4, Math.max((maxU - minU) * w, (maxV - minV) * h));
      const baryPad = -Math.min(0.09, 1.55 / triUvSpan);

      for (let py = y0; py <= y1; py++) {
        const pv = (py + 0.5) * invH;
        const dv = pv - va;
        const rowOff = py * w;
        for (let px = x0; px <= x1; px++) {
          const pxIdx = rowOff + px;
          const pu = (px + 0.5) * invW;
          const du = pu - ua;
          let w1 = (du * u1y - u1x * dv) * invDet;
          let w2 = (u0x * dv - du * u0y) * invDet;
          let w0 = 1 - w1 - w2;
          const strictlyInside = w0 >= 0 && w1 >= 0 && w2 >= 0;
          if (!strictlyInside) {
            if (w0 < baryPad || w1 < baryPad || w2 < baryPad) continue;
            if (dabStamp[pxIdx] === dabStampId) continue;
            w0 = w0 < 0 ? 0 : w0;
            w1 = w1 < 0 ? 0 : w1;
            w2 = w2 < 0 ? 0 : w2;
            const ws = w0 + w1 + w2 || 1;
            w0 /= ws; w1 /= ws; w2 /= ws;
          }

          const wx = ax * w0 + bx * w1 + cx * w2;
          const wy = ay * w0 + by * w1 + cy * w2;
          const wz = az * w0 + bz * w1 + cz * w2;

          let bestF = 0;
          for (let ni = 0; ni < nearCount; ni++) {
            const d = symDabs[nearDabs[ni]];
            const ddx = wx - d.cx, ddy = wy - d.cy, ddz = wz - d.cz;
            const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
            if (d2 >= r2) continue;
            const f = evalPresetFalloff(preset, d, ddx, ddy, ddz, d2, invLocalR, hardness, splatterDrops, dabSeed);
            if (f > bestF) bestF = f;
          }
          if (bestF <= 0) continue;
          if (!strictlyInside && dabStamp[pxIdx] === dabStampId) continue;
          if (strictlyInside) dabStamp[pxIdx] = dabStampId;

          const po = pxIdx * 4;
          if (touchedStamp[pxIdx] !== stampId) {
            touchedStamp[pxIdx] = stampId;
            touched.push(pxIdx);
            alphaMask[pxIdx] = 0;
            startSnap[po] = data[po];
            startSnap[po + 1] = data[po + 1];
            startSnap[po + 2] = data[po + 2];
            startSnap[po + 3] = data[po + 3];
            if (acc) {
              acc[po] = data[po];
              acc[po + 1] = data[po + 1];
              acc[po + 2] = data[po + 2];
              acc[po + 3] = data[po + 3];
            }
          }

          if (tool === 'airbrush') {
            const a = Math.min(1, bestF * strength * 0.24 * flowScale);
            const nr = acc[po] + (tr - acc[po]) * a;
            const ng = acc[po + 1] + (tg - acc[po + 1]) * a;
            const nb = acc[po + 2] + (tb - acc[po + 2]) * a;
            acc[po] = nr; acc[po + 1] = ng; acc[po + 2] = nb; acc[po + 3] = 255;
            data[po] = (nr + 0.5) | 0;
            data[po + 1] = (ng + 0.5) | 0;
            data[po + 2] = (nb + 0.5) | 0;
            data[po + 3] = 255;
          } else if (tool === 'blur') {
            const a = Math.min(1, bestF * strength * 0.35 * flowScale);
            let sr = 0, sg = 0, sb = 0, sw = 0;
            for (let oy = -1; oy <= 1; oy++) {
              const ny = py + oy;
              if (ny < 0 || ny >= h) continue;
              const wy2 = oy === 0 ? 2 : 1;
              const nRow = ny * w;
              for (let ox = -1; ox <= 1; ox++) {
                const nx = px + ox;
                if (nx < 0 || nx >= w) continue;
                const kw = wy2 * (ox === 0 ? 2 : 1);
                const nIdx = nRow + nx;
                const no = nIdx * 4;
                const srcBuf = touchedStamp[nIdx] === stampId ? acc : data;
                sr += srcBuf[no] * kw;
                sg += srcBuf[no + 1] * kw;
                sb += srcBuf[no + 2] * kw;
                sw += kw;
              }
            }
            if (sw > 0) {
              const nr = acc[po] + (sr / sw - acc[po]) * a;
              const ng = acc[po + 1] + (sg / sw - acc[po + 1]) * a;
              const nb = acc[po + 2] + (sb / sw - acc[po + 2]) * a;
              acc[po] = nr; acc[po + 1] = ng; acc[po + 2] = nb; acc[po + 3] = 255;
              data[po] = (nr + 0.5) | 0;
              data[po + 1] = (ng + 0.5) | 0;
              data[po + 2] = (nb + 0.5) | 0;
              data[po + 3] = 255;
            }
          } else if (tool === 'smudge' && st.smudgeColor) {
            const a = Math.min(1, bestF * strength * 0.42 * flowScale);
            const or = acc[po], og = acc[po + 1], ob = acc[po + 2];
            const nr = or + (st.smudgeColor[0] - or) * a;
            const ng = og + (st.smudgeColor[1] - og) * a;
            const nb = ob + (st.smudgeColor[2] - ob) * a;
            acc[po] = nr; acc[po + 1] = ng; acc[po + 2] = nb; acc[po + 3] = 255;
            data[po] = (nr + 0.5) | 0;
            data[po + 1] = (ng + 0.5) | 0;
            data[po + 2] = (nb + 0.5) | 0;
            data[po + 3] = 255;
            const mix = 0.03 * bestF * flowScale;
            st.smudgeColor[0] += (or - st.smudgeColor[0]) * mix;
            st.smudgeColor[1] += (og - st.smudgeColor[1]) * mix;
            st.smudgeColor[2] += (ob - st.smudgeColor[2]) * mix;
          } else if (tool === 'eraser') {
            const nextA = Math.min(1, bestF * strength);
            if (nextA > alphaMask[pxIdx]) alphaMask[pxIdx] = nextA;
            if (baseSnap) {
              const a = alphaMask[pxIdx];
              data[po] = (startSnap[po] + (baseSnap[po] - startSnap[po]) * a + 0.5) | 0;
              data[po + 1] = (startSnap[po + 1] + (baseSnap[po + 1] - startSnap[po + 1]) * a + 0.5) | 0;
              data[po + 2] = (startSnap[po + 2] + (baseSnap[po + 2] - startSnap[po + 2]) * a + 0.5) | 0;
              data[po + 3] = 255;
            }
          } else {
            const nextA = Math.min(1, bestF * strength);
            if (nextA > alphaMask[pxIdx]) alphaMask[pxIdx] = nextA;
            const a = alphaMask[pxIdx];
            data[po] = (startSnap[po] + (tr - startSnap[po]) * a + 0.5) | 0;
            data[po + 1] = (startSnap[po + 1] + (tg - startSnap[po + 1]) * a + 0.5) | 0;
            data[po + 2] = (startSnap[po + 2] + (tb - startSnap[po + 2]) * a + 0.5) | 0;
            data[po + 3] = 255;
          }
          if (px < dirtyMinX) dirtyMinX = px;
          if (px > dirtyMaxX) dirtyMaxX = px;
          if (py < dirtyMinY) dirtyMinY = py;
          if (py > dirtyMaxY) dirtyMaxY = py;
        }
      }
    };

    if (grid) {
      const triStampId = this._nextTriStamp(tris);
      const triStamp = this._triStamp;
      const g = grid.g;
      const g2 = grid.g2;
      const { cellStarts, cellTris } = grid;
      for (let s = 0; s < symCount; s++) {
        const d = symDabs[s];
        let cx0 = Math.floor((d.cx - localR - grid.minX) * grid.invX);
        let cy0 = Math.floor((d.cy - localR - grid.minY) * grid.invY);
        let cz0 = Math.floor((d.cz - localR - grid.minZ) * grid.invZ);
        let cx1 = Math.floor((d.cx + localR - grid.minX) * grid.invX);
        let cy1 = Math.floor((d.cy + localR - grid.minY) * grid.invY);
        let cz1 = Math.floor((d.cz + localR - grid.minZ) * grid.invZ);
        if (cx1 < 0 || cx0 >= g || cy1 < 0 || cy0 >= g || cz1 < 0 || cz0 >= g) continue;
        if (cx0 < 0) cx0 = 0; if (cx1 >= g) cx1 = g - 1;
        if (cy0 < 0) cy0 = 0; if (cy1 >= g) cy1 = g - 1;
        if (cz0 < 0) cz0 = 0; if (cz1 >= g) cz1 = g - 1;
        for (let z = cz0; z <= cz1; z++) {
          const zOff = z * g2;
          for (let y = cy0; y <= cy1; y++) {
            const yOff = zOff + y * g;
            for (let x = cx0; x <= cx1; x++) {
              const ci = yOff + x;
              const start = cellStarts[ci];
              const end = cellStarts[ci + 1];
              for (let k = start; k < end; k++) {
                const t = cellTris[k];
                if (triStamp[t] === triStampId) continue;
                triStamp[t] = triStampId;
                processTri(t);
              }
            }
          }
        }
      }
    } else {
      for (let t = 0; t < tris; t++) processTri(t);
    }

    if (dirtyMaxX >= dirtyMinX) {
      st.texture.markRegionDirty(dirtyMinX, dirtyMinY, dirtyMaxX, dirtyMaxY, true);
    }
  }

  commitStroke() {
    this._cancelPendingMove();
    this._smoothFilter = null;
    const st = this._stroke;
    if (!st) return null;
    this._stroke = null;

    if (st.mode === 'texture' && st.texture?._deferMipmaps) {
      st.texture.needsUpdate = true;
    }

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
    const snap = st.startSnap;
    let dirty = false;
    for (let i = 0; i < indices.length; i++) {
      const po = indices[i] * 4;
      const doff = i * 4;
      const r0 = snap[po], g0 = snap[po + 1], b0 = snap[po + 2], a0 = snap[po + 3];
      const r1 = cur[po], g1 = cur[po + 1], b1 = cur[po + 2], a1 = cur[po + 3];
      before[doff] = r0; before[doff + 1] = g0; before[doff + 2] = b0; before[doff + 3] = a0;
      after[doff] = r1; after[doff + 1] = g1; after[doff + 2] = b1; after[doff + 3] = a1;
      if (r0 !== r1 || g0 !== g1 || b0 !== b1 || a0 !== a1) dirty = true;
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
    this._cancelPendingMove();
    this._smoothFilter = null;
    const st = this._stroke;
    if (!st) return false;
    this._stroke = null;
    if (st.mode === 'vertex') {
      st.colAttr.array.set(st.startSnap);
      st.colAttr.needsUpdate = true;
    } else if (st.texture && st.data) {
      const data = st.data;
      const snap = st.startSnap;
      const touched = st.touched;
      for (let i = 0; i < touched.length; i++) {
        const po = touched[i] * 4;
        data[po] = snap[po];
        data[po + 1] = snap[po + 1];
        data[po + 2] = snap[po + 2];
        data[po + 3] = snap[po + 3];
      }
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

      const preset = this.tool === 'brush' ? this.brushPreset : 'round';
      const steps = preset === 'pixel' ? 4 : 40;
      const strokeLoop = (lw, color, globalAlpha, dashArr = null) => {
        ctx.save();
        ctx.globalAlpha = globalAlpha;
        ctx.strokeStyle = color;
        ctx.lineWidth = lw;
        if (dashArr) ctx.setLineDash(dashArr);
        ctx.beginPath();
        let started = false;
        for (let i = 0; i <= steps; i++) {
          let ca = 0, sa = 0;
          if (preset === 'pixel') {
            const corner = i % 4;
            ca = (corner === 0 || corner === 3 ? 1 : -1) * rWorld;
            sa = (corner === 0 || corner === 1 ? 1 : -1) * rWorld;
          } else if (preset === 'chisel') {
            const a = (i / steps) * Math.PI * 2;
            const lx = Math.cos(a) * rWorld;
            const ly = Math.sin(a) * rWorld * 0.36;
            ca = lx * 0.819152 + ly * 0.573576;
            sa = -lx * 0.573576 + ly * 0.819152;
          } else {
            const a = (i / steps) * Math.PI * 2;
            ca = Math.cos(a) * rWorld;
            sa = Math.sin(a) * rWorld;
          }
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

      const dash = dashed || this.tool === 'eraser' || this.tool === 'fill'
        ? [5, 4]
        : (preset === 'stipple' || preset === 'splatter' ? [2, 4] : null);
      strokeLoop(dashed ? 2.6 : 3.6, 'rgba(0, 0, 0, 0.72)', alpha * 0.85, dash);
      strokeLoop(dashed ? 1.5 : 2.1, toolColor, alpha, dash);

      if (!dashed && !isSpecial && preset !== 'pixel' && preset !== 'chisel') {
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

  drawScreenFallbackCursor(ctx, width, height) {
    const pt = this._pointerScreen;
    if (!ctx || !pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return;
    if (pt.x < 0 || pt.y < 0 || pt.x > width || pt.y > height) return;

    const toolColor = this.tool === 'eraser' ? '#f8fafc' : this.color;
    const isSpecial = this.tool === 'picker' || this.tool === 'fill';
    const rPx = isSpecial
      ? 10
      : Math.max(8, Math.min(64, this.radius * Math.min(width, height) * 0.09));

    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.72)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, rPx, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = toolColor;
    ctx.lineWidth = 1.75;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, rPx, 0, Math.PI * 2);
    ctx.stroke();

    ctx.setLineDash([]);
    ctx.fillStyle = toolColor;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 2.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  renderOverlay(canvas, camera, opts = {}) {
    if (!canvas || canvas.hidden || !camera) return false;
    // En móviles mientras el dedo pinta activamente, evitar el repintado 2D de 68 proyecciones por frame
    if (this._isMobile && this.isStroking) {
      if (this._overlayWasDrawn) {
        const ctx = canvas.getContext('2d');
        if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
        this._overlayWasDrawn = false;
        this._overlaySig = '';
      }
      return false;
    }

    const refEl = opts.referenceElement || canvas;
    const cssW = Math.max(1, opts.width || refEl.clientWidth || canvas.clientWidth || canvas.width || 1);
    const cssH = Math.max(1, opts.height || refEl.clientHeight || canvas.clientHeight || canvas.height || 1);
    const maxDpr = opts.maxDpr ?? (this._isMobile ? 1.5 : 2);
    const dpr = Math.min((typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1, maxDpr);
    const bw = Math.round(cssW * dpr);
    const bh = Math.round(cssH * dpr);

    const hv = this.hover;
    const ps = this._pointerScreen;
    const cm = camera.matrixWorld?.elements;
    const camSig = cm ? `${cm[0].toFixed(3)},${cm[5].toFixed(3)},${cm[10].toFixed(3)},${cm[12].toFixed(3)},${cm[13].toFixed(3)},${cm[14].toFixed(3)}` : '';
    const hvSig = hv?.point ? `${hv.point.x.toFixed(4)},${hv.point.y.toFixed(4)},${hv.point.z.toFixed(4)}` : 'n';
    const psSig = ps ? `${ps.x.toFixed(1)},${ps.y.toFixed(1)}` : 'n';
    const sig = `${bw}x${bh}|${camSig}|${hvSig}|${psSig}|${this.tool}|${this.brushPreset}|${this.color}|${this.radius}|${this.strength}|${this.symmetry}`;
    if (sig === this._overlaySig && canvas.width === bw && canvas.height === bh) {
      return false;
    }
    this._overlaySig = sig;

    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    if (hv) {
      this.drawCursor(ctx, camera, cssW, cssH);
      this._overlayWasDrawn = true;
    } else if (ps) {
      this.drawScreenFallbackCursor(ctx, cssW, cssH);
      this._overlayWasDrawn = true;
    } else {
      this._overlayWasDrawn = false;
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

    const flushPendingMoves = () => {
      this._moveRaf = 0;
      if (!this.enabled || !this.isStroking || !this._pendingMoves.length) return;
      const cam = resolveCamera();
      if (!cam) {
        this._pendingMoves.length = 0;
        return;
      }
      const pts = this._pendingMoves;
      let lastHit = null;
      for (let i = 0; i < pts.length; i++) {
        const pt = pts[i];
        const hit = this.stepStroke(cam, pt.x, pt.y, { onStrokeStep: opts.onStrokeStep });
        if (hit) lastHit = hit;
      }
      pts.length = 0;
      if (lastHit) this.hover = lastHit;
    };

    const scheduleStrokeFlush = () => {
      if (this._moveRaf) return;
      if (typeof requestAnimationFrame === 'function') {
        this._moveRaf = requestAnimationFrame(flushPendingMoves);
      } else {
        flushPendingMoves();
      }
    };

    const onPointerDown = (e) => {
      const targetEl = resolveTarget();
      if (targetEl && e.target !== targetEl) return;
      this._pointers.add(e.pointerId);
      if (!this.enabled) return;

      const ctrl = resolveControls();
      if (this._pointers.size > 1) {
        if (this.isStroking) {
          flushPendingMoves();
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
      const targetElRect = resolveTarget() || domElement;
      const [sx, sy] = clientToLocalPoint(targetElRect, e);
      this._pointerScreen = { x: sx, y: sy };

      const hit = this.pickSurface(cam, ndcX, ndcY, targets);
      if (!hit) {
        if (e.pointerType === 'touch') this.hover = null;
        if (ctrl) ctrl.enabled = true;
        return;
      }

      e.preventDefault();
      if (ctrl) ctrl.enabled = false;
      this.hover = hit;
      this._cancelPendingMove();
      const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
      this._smoothFilter = { x: ndcX, y: ndcY, t: nowMs };
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
      const targetElRect = resolveTarget() || domElement;

      if (this.isStroking && e.pointerId === this._activePointerId) {
        const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
        const list = events && events.length ? events : [e];
        const nowBase = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const evLast = list[list.length - 1];
        const [sx, sy] = clientToLocalPoint(targetElRect, evLast);
        this._pointerScreen = { x: sx, y: sy };

        if (list.length >= 2) {
          const midEv = list[list.length >> 1];
          const midNdc = toNdc(midEv);
          const midSm = this._filterStrokePoint(midNdc.x, midNdc.y, nowBase - 4);
          const endNdc = toNdc(evLast);
          const endSm = this._filterStrokePoint(endNdc.x, endNdc.y, nowBase);
          this._pendingMoves[0] = midSm;
          this._pendingMoves[1] = endSm;
          this._pendingMoves.length = 2;
        } else {
          const endNdc = toNdc(evLast);
          const endSm = this._filterStrokePoint(endNdc.x, endNdc.y, nowBase);
          this._pendingMoves[0] = endSm;
          this._pendingMoves.length = 1;
        }
        scheduleStrokeFlush();
        return;
      }

      const [sx, sy] = clientToLocalPoint(targetElRect, e);
      this._pointerScreen = { x: sx, y: sy };
      if (!this.isStroking && e.pointerType !== 'touch') {
        const { x: ndcX, y: ndcY } = toNdc(e);
        const targets = typeof opts.getTargets === 'function' ? opts.getTargets() : (opts.targets || []);
        this.hover = targets.length ? this.pickSurface(cam, ndcX, ndcY, targets) : null;
      }
    };

    const finishPointer = (e) => {
      this._pointers.delete(e.pointerId);
      if (!this.enabled) return;
      if (e.pointerId === this._activePointerId) {
        if (this.isStroking) {
          const endNdc = toNdc(e);
          const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
          const f = this._smoothFilter;
          const tail = f
            ? { x: f.x + (endNdc.x - f.x) * 0.72, y: f.y + (endNdc.y - f.y) * 0.72 }
            : this._filterStrokePoint(endNdc.x, endNdc.y, nowMs);
          if (!this._pendingMoves.length) {
            this._pendingMoves.push(tail);
          } else {
            this._pendingMoves[this._pendingMoves.length - 1] = tail;
          }
          flushPendingMoves();
        }
        this._activePointerId = null;
        const res = this.commitStroke();
        emitStrokeEnd(res);
        const ctrl = resolveControls();
        if (ctrl) ctrl.enabled = resolveControlsEnabled();
        this._releasePointerCapture(e.pointerId);
        if (e.pointerType === 'touch') this._pointerScreen = null;
      }
    };

    const onPointerLeave = () => {
      this._pointerScreen = null;
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
      this._cancelPendingMove();
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
    this._cancelPendingMove();
    this._smoothFilter = null;
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
