import { Vec3 } from '../math/Vec3.js';
import { Mat4 } from '../math/Mat4.js';
import { Raycaster } from '../core/Raycaster.js';
import { Geometry } from '../geometry/Geometry.js';
import { BufferAttribute } from '../geometry/BufferAttribute.js';
import { syncEditableBaseFromGeometry } from '../modeling/SubdivisionSurface.js';

function markGeometrySculpted(mesh, geo) {
  if (geo) {
    geo._modifiedBySculpt = true;
    geo._isGeneratedSubsurf = false;
    geo.boundingBox = null;
    geo.boundingSphere = null;
  }
  if (mesh) {
    mesh._subsurfDirtyFromGeometry = true;
  }
}

export const SCULPT_TOOLS = ['draw', 'carve', 'clay', 'crease', 'grab', 'smooth', 'inflate', 'deflate', 'flatten', 'pinch'];
export const SCULPT_SYMMETRIES = ['none', 'x', 'y', 'z'];
export const SCULPT_FALLOFFS = ['smooth', 'sphere', 'tip'];

const _invMat = new Mat4();
const _raycaster = new Raycaster();
const _v0 = new Vec3();
const _v1 = new Vec3();
const _v2 = new Vec3();
const _tan = new Vec3();
const _bitan = new Vec3();
const _proj = new Vec3();

const _topoCache = new WeakMap();

function evalFalloff(t, type) {
  if (t >= 1) return 0;
  if (t <= 0) return 1;
  if (type === 'sphere') return Math.sqrt(Math.max(0, 1 - t * t));
  if (type === 'tip') {
    const u = 1 - t;
    return u * u;
  }
  const u = 1 - t * t;
  return u * u;
}

/**
 * Construye y cachea el mapa de vértices soldados (evita grietas en costuras UV o esquinas)
 * y la lista de adyacencia topológica para el pincel Suavizar y normales suaves.
 */
export function prepareSculptGeometry(geo) {
  if (!geo || !geo.attributes || !geo.attributes.position) return null;
  const posAttr = geo.attributes.position;
  const vCount = posAttr.count;
  const idxAttr = geo.index || null;
  const idxVer = idxAttr ? idxAttr.version : -1;

  let topo = _topoCache.get(geo);
  if (topo && topo.vCount === vCount && topo.idxVer === idxVer) {
    return topo;
  }

  const pos = posAttr.array;
  const bb = geo.getBoundingBox();
  const dx = bb ? bb.max.x - bb.min.x : 1;
  const dy = bb ? bb.max.y - bb.min.y : 1;
  const dz = bb ? bb.max.z - bb.min.z : 1;
  const diag = Math.hypot(dx, dy, dz) || 1;
  const eps = Math.max(1e-6, diag * 1e-5);
  const invEps = 1 / eps;

  const map = new Map();
  const weldOf = new Int32Array(vCount);
  const groupCounts = [];

  for (let i = 0; i < vCount; i++) {
    const o = i * 3;
    const kx = Math.round(pos[o] * invEps);
    const ky = Math.round(pos[o + 1] * invEps);
    const kz = Math.round(pos[o + 2] * invEps);
    const key = `${kx},${ky},${kz}`;
    let w = map.get(key);
    if (w === undefined) {
      w = groupCounts.length;
      map.set(key, w);
      groupCounts.push(0);
    }
    weldOf[i] = w;
    groupCounts[w]++;
  }

  const W = groupCounts.length;
  const weldOffsets = new Int32Array(W + 1);
  for (let w = 0; w < W; w++) weldOffsets[w + 1] = weldOffsets[w] + groupCounts[w];

  const writeCursor = new Int32Array(W);
  const weldMembers = new Int32Array(vCount);
  for (let i = 0; i < vCount; i++) {
    const w = weldOf[i];
    weldMembers[weldOffsets[w] + writeCursor[w]++] = i;
  }

  const idx = idxAttr ? idxAttr.array : null;
  const tris = idx ? (idx.length / 3) | 0 : (vCount / 3) | 0;
  const triWeld = new Int32Array(tris * 3);
  const adjSets = new Array(W);
  for (let w = 0; w < W; w++) adjSets[w] = new Set();

  for (let t = 0; t < tris; t++) {
    const t3 = t * 3;
    const ia = idx ? idx[t3] : t3;
    const ib = idx ? idx[t3 + 1] : t3 + 1;
    const ic = idx ? idx[t3 + 2] : t3 + 2;
    const wa = weldOf[ia];
    const wb = weldOf[ib];
    const wc = weldOf[ic];
    triWeld[t3] = wa;
    triWeld[t3 + 1] = wb;
    triWeld[t3 + 2] = wc;
    if (wa !== wb) { adjSets[wa].add(wb); adjSets[wb].add(wa); }
    if (wb !== wc) { adjSets[wb].add(wc); adjSets[wc].add(wb); }
    if (wc !== wa) { adjSets[wc].add(wa); adjSets[wa].add(wc); }
  }

  const adjOffsets = new Int32Array(W + 1);
  let totalAdj = 0;
  for (let w = 0; w < W; w++) {
    adjOffsets[w] = totalAdj;
    totalAdj += adjSets[w].size;
  }
  adjOffsets[W] = totalAdj;
  const adjNeighbors = new Int32Array(totalAdj);
  let ptr = 0;
  for (let w = 0; w < W; w++) {
    for (const nb of adjSets[w]) adjNeighbors[ptr++] = nb;
  }

  topo = {
    vCount,
    idxVer,
    W,
    tris,
    weldOf,
    weldOffsets,
    weldMembers,
    triWeld,
    adjOffsets,
    adjNeighbors,
    weldNormals: new Float32Array(W * 3),
    smoothBuf: new Float32Array(W * 3),
    activeWelds: new Int32Array(W),
    activeWeights: new Float32Array(W),
    activeCount: 0,
  };
  _topoCache.set(geo, topo);
  return topo;
}

/**
 * Recalcula normales suaves respetando grupos soldados (sin costuras ni aristas rotas).
 */
export function computeWeldedNormals(geo, topo = null) {
  topo = topo || prepareSculptGeometry(geo);
  if (!topo) return;
  const posAttr = geo.attributes.position;
  if (!posAttr) return;
  const pos = posAttr.array;

  let norAttr = geo.attributes.normal;
  if (!norAttr || norAttr.array.length !== pos.length) {
    norAttr = new BufferAttribute(new Float32Array(pos.length), 3);
    geo.attributes.normal = norAttr;
  }
  const nor = norAttr.array;

  const { W, tris, triWeld, weldOffsets, weldMembers, weldNormals } = topo;
  weldNormals.fill(0);

  for (let t = 0; t < tris; t++) {
    const t3 = t * 3;
    const wa = triWeld[t3];
    const wb = triWeld[t3 + 1];
    const wc = triWeld[t3 + 2];
    const ia = weldMembers[weldOffsets[wa]] * 3;
    const ib = weldMembers[weldOffsets[wb]] * 3;
    const ic = weldMembers[weldOffsets[wc]] * 3;

    const ax = pos[ia], ay = pos[ia + 1], az = pos[ia + 2];
    const e1x = pos[ib] - ax, e1y = pos[ib + 1] - ay, e1z = pos[ib + 2] - az;
    const e2x = pos[ic] - ax, e2y = pos[ic + 1] - ay, e2z = pos[ic + 2] - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;

    const wa3 = wa * 3, wb3 = wb * 3, wc3 = wc * 3;
    weldNormals[wa3] += nx; weldNormals[wa3 + 1] += ny; weldNormals[wa3 + 2] += nz;
    weldNormals[wb3] += nx; weldNormals[wb3 + 1] += ny; weldNormals[wb3 + 2] += nz;
    weldNormals[wc3] += nx; weldNormals[wc3 + 1] += ny; weldNormals[wc3 + 2] += nz;
  }

  for (let w = 0; w < W; w++) {
    const w3 = w * 3;
    let nx = weldNormals[w3], ny = weldNormals[w3 + 1], nz = weldNormals[w3 + 2];
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    const start = weldOffsets[w], end = weldOffsets[w + 1];
    for (let k = start; k < end; k++) {
      const m3 = weldMembers[k] * 3;
      nor[m3] = nx; nor[m3 + 1] = ny; nor[m3 + 2] = nz;
    }
  }
  norAttr.needsUpdate = true;
}

/**
 * Subdivide una geometría triangular por punto medio (cada triángulo -> 4 triángulos).
 * Preserva position, normal, uv, uv1 y color; suelda puntos medios de aristas compartidas.
 */
export function subdivideGeometry(geo, levels = 1, opts = {}) {
  if (!geo || !geo.attributes || !geo.attributes.position) {
    throw new Error('Geometría inválida para subdividir.');
  }
  const maxTriangles = opts.maxTriangles ?? 250000;
  let curPos = geo.attributes.position.array.slice();
  let curNor = geo.attributes.normal ? geo.attributes.normal.array.slice() : null;
  let curUv = geo.attributes.uv ? geo.attributes.uv.array.slice() : null;
  let curUv1 = geo.attributes.uv1 ? geo.attributes.uv1.array.slice() : null;
  let curCol = geo.attributes.color ? geo.attributes.color.array.slice() : null;
  let curSkinIdx = geo.attributes.skinIndex ? geo.attributes.skinIndex.array.slice() : null;
  let curSkinWt = geo.attributes.skinWeight ? geo.attributes.skinWeight.array.slice() : null;
  const colSize = geo.attributes.color ? geo.attributes.color.itemSize : 0;

  let curIdx;
  if (geo.index) {
    curIdx = Array.from(geo.index.array);
  } else {
    const n = geo.attributes.position.count;
    curIdx = new Array(n);
    for (let i = 0; i < n; i++) curIdx[i] = i;
  }

  const steps = Math.max(1, Math.min(4, levels | 0));
  for (let lv = 0; lv < steps; lv++) {
    const tris = (curIdx.length / 3) | 0;
    if (tris * 4 > maxTriangles) {
      throw new Error(`La subdivisión superaría el límite de ${maxTriangles.toLocaleString()} triángulos.`);
    }

    const pos = Array.from(curPos);
    const nor = curNor ? Array.from(curNor) : null;
    const uv = curUv ? Array.from(curUv) : null;
    const uv1 = curUv1 ? Array.from(curUv1) : null;
    const col = curCol ? Array.from(curCol) : null;
    const skinIdx = curSkinIdx ? Array.from(curSkinIdx) : null;
    const skinWt = curSkinWt ? Array.from(curSkinWt) : null;
    const nextIdx = [];
    const midCache = new Map();

    const getMid = (a, b) => {
      const lo = a < b ? a : b;
      const hi = a < b ? b : a;
      const key = `${lo}_${hi}`;
      let m = midCache.get(key);
      if (m !== undefined) return m;
      m = (pos.length / 3) | 0;
      midCache.set(key, m);

      const a3 = lo * 3, b3 = hi * 3;
      pos.push(
        (pos[a3] + pos[b3]) * 0.5,
        (pos[a3 + 1] + pos[b3 + 1]) * 0.5,
        (pos[a3 + 2] + pos[b3 + 2]) * 0.5
      );
      if (nor) {
        let nx = nor[a3] + nor[b3];
        let ny = nor[a3 + 1] + nor[b3 + 1];
        let nz = nor[a3 + 2] + nor[b3 + 2];
        const l = Math.hypot(nx, ny, nz) || 1;
        nor.push(nx / l, ny / l, nz / l);
      }
      if (uv) {
        const a2 = lo * 2, b2 = hi * 2;
        uv.push((uv[a2] + uv[b2]) * 0.5, (uv[a2 + 1] + uv[b2 + 1]) * 0.5);
      }
      if (uv1) {
        const a2 = lo * 2, b2 = hi * 2;
        uv1.push((uv1[a2] + uv1[b2]) * 0.5, (uv1[a2 + 1] + uv1[b2 + 1]) * 0.5);
      }
      if (col && colSize > 0) {
        const ac = lo * colSize, bc = hi * colSize;
        for (let k = 0; k < colSize; k++) {
          col.push((col[ac + k] + col[bc + k]) * 0.5);
        }
      }
      if (skinIdx && skinWt) {
        const influences = new Map();
        const addSide = (base) => {
          for (let k = 0; k < 4; k++) {
            const w = skinWt[base + k] * 0.5;
            if (w <= 0) continue;
            const bi = Math.round(skinIdx[base + k]) | 0;
            influences.set(bi, (influences.get(bi) || 0) + w);
          }
        };
        addSide(lo * 4);
        addSide(hi * 4);
        const top = Array.from(influences.entries()).sort((x, y) => y[1] - x[1]).slice(0, 4);
        let wSum = 0;
        for (let k = 0; k < top.length; k++) wSum += top[k][1];
        const inv = wSum > 1e-6 ? 1 / wSum : 0;
        for (let k = 0; k < 4; k++) {
          if (k < top.length && inv > 0) {
            skinIdx.push(top[k][0]);
            skinWt.push(top[k][1] * inv);
          } else {
            skinIdx.push(0);
            skinWt.push(0);
          }
        }
      }
      return m;
    };

    for (let t = 0; t < tris; t++) {
      const t3 = t * 3;
      const i0 = curIdx[t3], i1 = curIdx[t3 + 1], i2 = curIdx[t3 + 2];
      const m01 = getMid(i0, i1);
      const m12 = getMid(i1, i2);
      const m20 = getMid(i2, i0);
      nextIdx.push(
        i0, m01, m20,
        m01, i1, m12,
        m20, m12, i2,
        m01, m12, m20
      );
    }

    curPos = new Float32Array(pos);
    if (nor) curNor = new Float32Array(nor);
    if (uv) curUv = new Float32Array(uv);
    if (uv1) curUv1 = new Float32Array(uv1);
    if (col) curCol = new Float32Array(col);
    if (skinIdx) curSkinIdx = new Float32Array(skinIdx);
    if (skinWt) curSkinWt = new Float32Array(skinWt);
    curIdx = nextIdx;
  }

  const out = new Geometry();
  out.setAttribute('position', curPos, 3);
  if (curNor) out.setAttribute('normal', curNor, 3);
  if (curUv) out.setAttribute('uv', curUv, 2);
  if (curUv1) out.setAttribute('uv1', curUv1, 2);
  if (curCol && colSize > 0) out.setAttribute('color', curCol, colSize);
  if (curSkinIdx) out.setAttribute('skinIndex', curSkinIdx, 4);
  if (curSkinWt) out.setAttribute('skinWeight', curSkinWt, 4);
  out.setIndex(curIdx);
  if (!curNor || opts.smoothNormals !== false) {
    computeWeldedNormals(out);
  }
  return out;
}

const TOOL_COLORS = {
  draw: '#60a5fa',
  carve: '#f87171',
  clay: '#f59e0b',
  crease: '#fb7185',
  grab: '#fbbf24',
  smooth: '#34d399',
  inflate: '#a78bfa',
  deflate: '#c084fc',
  flatten: '#38bdf8',
  pinch: '#f472b6',
};

/**
 * Motor de esculpido / modelado orgánico con pinceles 3D para cualquier Mesh de Made3D.
 */
export class Sculptor {
  constructor(opts = {}) {
    this.tool = SCULPT_TOOLS.includes(opts.tool) ? opts.tool : 'draw';
    this.radius = Math.max(0.02, opts.radius ?? 0.45);
    this.strength = Math.max(0.01, Math.min(1, opts.strength ?? 0.55));
    this.invert = Boolean(opts.invert);
    this.symmetry = SCULPT_SYMMETRIES.includes(opts.symmetry) ? opts.symmetry : 'x';
    this.falloff = SCULPT_FALLOFFS.includes(opts.falloff) ? opts.falloff : 'smooth';
    this.frontFacesOnly = Boolean(opts.frontFacesOnly);
    this.enabled = Boolean(opts.enabled);
    this.hover = null;
    this.shift = false;
    this.alt = false;
    this._pointers = new Set();
    this._activePointerId = null;
    this._captureEl = null;
    this._attached = null;
    this._cleanup = null;
    this._stroke = null;
  }

  static isSculptable(obj) {
    return Boolean(
      obj &&
      obj.isMesh &&
      !obj.isInstancedMesh &&
      !(obj.isHelper?.() || obj.isGridHelper || obj.isCameraHelper || obj.isSkeletonHelper) &&
      (typeof obj.isPickable === 'function' ? obj.isPickable() : true)
    );
  }

  get isStroking() {
    return Boolean(this._stroke);
  }

  get activeMesh() {
    return this._stroke ? this._stroke.mesh : null;
  }

  _getSymmetryAxisIndex() {
    if (this.symmetry === 'x') return 0;
    if (this.symmetry === 'y') return 1;
    if (this.symmetry === 'z') return 2;
    return -1;
  }

  /**
   * Lanza un rayo contra una malla (o arreglo/árbol de objetos) y devuelve también el punto simétrico.
   */
  pickSurface(camera, ndcX, ndcY, target) {
    if (!camera || !target) return null;
    _raycaster.setFromCamera({ x: ndcX, y: ndcY }, camera);
    const hits = Array.isArray(target)
      ? _raycaster.intersectObjects(target, true, [])
      : _raycaster.intersectObject(target, true, []);
    if (!hits.length) return null;

    let hit = null;
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      if (Sculptor.isSculptable(h.object)) {
        hit = h;
        break;
      }
    }
    if (!hit) return null;

    const mesh = hit.object;
    mesh.updateMatrixWorld();
    const axis = this._getSymmetryAxisIndex();
    let mirrorPoint = null;
    let mirrorNormal = null;
    if (axis >= 0) {
      _invMat.copyInverse(mesh.matrixWorld);
      const lp = _v0.copy(hit.point).applyMatrix4(_invMat);
      if (axis === 0) lp.x = -lp.x;
      else if (axis === 1) lp.y = -lp.y;
      else lp.z = -lp.z;
      mirrorPoint = lp.clone().applyMatrix4(mesh.matrixWorld);

      const wn = hit.normal || new Vec3(0, 1, 0);
      const we = mesh.matrixWorld.elements;
      let lnx = we[0] * wn.x + we[1] * wn.y + we[2] * wn.z;
      let lny = we[4] * wn.x + we[5] * wn.y + we[6] * wn.z;
      let lnz = we[8] * wn.x + we[9] * wn.y + we[10] * wn.z;
      if (axis === 0) lnx = -lnx;
      else if (axis === 1) lny = -lny;
      else lnz = -lnz;
      const ie = _invMat.elements;
      const wx = ie[0] * lnx + ie[1] * lny + ie[2] * lnz;
      const wy = ie[4] * lnx + ie[5] * lny + ie[6] * lnz;
      const wz = ie[8] * lnx + ie[9] * lny + ie[10] * lnz;
      const wl = Math.hypot(wx, wy, wz) || 1;
      mirrorNormal = new Vec3(wx / wl, wy / wl, wz / wl);
    }

    return {
      mesh,
      point: hit.point.clone(),
      normal: (hit.normal || new Vec3(0, 1, 0)).clone().normalize(),
      distance: hit.distance,
      face: hit.face,
      mirrorPoint,
      mirrorNormal,
    };
  }

  _worldToLocalPointAndNormal(mesh, worldPt, worldNormal) {
    mesh.updateMatrixWorld();
    _invMat.copyInverse(mesh.matrixWorld);
    const localPt = worldPt.clone().applyMatrix4(_invMat);
    const we = mesh.matrixWorld.elements;
    let lnx = we[0] * worldNormal.x + we[1] * worldNormal.y + we[2] * worldNormal.z;
    let lny = we[4] * worldNormal.x + we[5] * worldNormal.y + we[6] * worldNormal.z;
    let lnz = we[8] * worldNormal.x + we[9] * worldNormal.y + we[10] * worldNormal.z;
    const len = Math.hypot(lnx, lny, lnz) || 1;
    const localN = new Vec3(lnx / len, lny / len, lnz / len);
    const worldScale = Math.max(1e-4, mesh.matrixWorld.getMaxScale());
    const localRadius = this.radius / worldScale;
    return { localPt, localN, localRadius };
  }

  beginStroke(mesh, hit, camera = null, opts = {}) {
    if (!mesh || !mesh.geometry || !mesh.geometry.attributes || !mesh.geometry.attributes.position || !hit) {
      return false;
    }
    const geo = mesh.geometry;
    const topo = prepareSculptGeometry(geo);
    if (!topo) return false;
    const posAttr = geo.attributes.position;
    if (!geo.attributes.normal) computeWeldedNormals(geo, topo);

    const beforePos = posAttr.array.slice();
    const { localPt, localN, localRadius } = this._worldToLocalPointAndNormal(mesh, hit.point, hit.normal);

    const stroke = {
      mesh,
      geometry: geo,
      topo,
      beforePos,
      prevDirty: Boolean(mesh._subsurfDirtyFromGeometry),
      prevModFlag: Boolean(geo._modifiedBySculpt),
      prevGenFlag: Boolean(geo._isGeneratedSubsurf),
      prevSubsurf: mesh._subsurf
        ? {
            level: mesh._subsurf.level | 0,
            smoothness: mesh._subsurf.smoothness ?? 1,
            smoothShading: Boolean(mesh._subsurf.smoothShading),
            showCage: Boolean(mesh._subsurf.showCage),
            alwaysShowCage: Boolean(mesh._subsurf.alwaysShowCage),
            baseMesh: mesh._subsurf.baseMesh ? mesh._subsurf.baseMesh.clone() : null,
          }
        : null,
      tool: this.tool,
      lastLocalPt: localPt.clone(),
      grab: null,
    };

    if (this.tool === 'grab' && camera && !opts.shift) {
      const camFwd = new Vec3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
      const entries = [];
      const symAxis = this._getSymmetryAxisIndex();
      const pos = posAttr.array;
      const nor = geo.attributes.normal.array;
      const r = localRadius;
      const r2 = r * r;
      const cx = localPt.x, cy = localPt.y, cz = localPt.z;
      const mx = symAxis === 0 ? -cx : cx;
      const my = symAxis === 1 ? -cy : cy;
      const mz = symAxis === 2 ? -cz : cz;
      const useMirror = symAxis >= 0 && Math.hypot(cx - mx, cy - my, cz - mz) > 1e-4;

      const { W, weldOffsets, weldMembers } = topo;
      for (let w = 0; w < W; w++) {
        const rep = weldMembers[weldOffsets[w]];
        const rep3 = rep * 3;
        const vx = pos[rep3], vy = pos[rep3 + 1], vz = pos[rep3 + 2];
        const dx1 = vx - cx, dy1 = vy - cy, dz1 = vz - cz;
        const d2_1 = dx1 * dx1 + dy1 * dy1 + dz1 * dz1;

        let d2_2 = Infinity;
        if (useMirror) {
          const dx2 = vx - mx, dy2 = vy - my, dz2 = vz - mz;
          d2_2 = dx2 * dx2 + dy2 * dy2 + dz2 * dz2;
        }

        const isMirror = d2_2 < d2_1;
        const bestD2 = isMirror ? d2_2 : d2_1;
        if (bestD2 >= r2) continue;

        if (this.frontFacesOnly) {
          const nx = nor[rep3], ny = nor[rep3 + 1], nz = nor[rep3 + 2];
          const refNx = isMirror && symAxis === 0 ? -localN.x : localN.x;
          const refNy = isMirror && symAxis === 1 ? -localN.y : localN.y;
          const refNz = isMirror && symAxis === 2 ? -localN.z : localN.z;
          if (nx * refNx + ny * refNy + nz * refNz <= -0.15) continue;
        }

        const weight = evalFalloff(Math.sqrt(bestD2) / r, this.falloff);
        if (weight > 0) {
          entries.push({ w, weight, isMirror, x0: vx, y0: vy, z0: vz });
        }
      }

      stroke.grab = {
        worldStart: hit.point.clone(),
        planeNormal: camFwd,
        entries,
      };
    } else {
      // Aplicar un primer toque inmediato para que clics individuales también esculpan
      const activeTool = opts.shift ? 'smooth' : this.tool;
      const invert = opts.invert !== undefined ? Boolean(opts.invert) : this.invert;
      const symAxis = this._getSymmetryAxisIndex();
      this._applyBrushAt(
        geo, topo, activeTool,
        localPt.x, localPt.y, localPt.z,
        localN.x, localN.y, localN.z,
        localRadius, invert, false
      );
      if (symAxis >= 0) {
        const sx = symAxis === 0 ? -localPt.x : localPt.x;
        const sy = symAxis === 1 ? -localPt.y : localPt.y;
        const sz = symAxis === 2 ? -localPt.z : localPt.z;
        if (Math.hypot(localPt.x - sx, localPt.y - sy, localPt.z - sz) > localRadius * 0.12) {
          const snx = symAxis === 0 ? -localN.x : localN.x;
          const sny = symAxis === 1 ? -localN.y : localN.y;
          const snz = symAxis === 2 ? -localN.z : localN.z;
          this._applyBrushAt(geo, topo, activeTool, sx, sy, sz, snx, sny, snz, localRadius, invert, true);
        }
      }
      posAttr.needsUpdate = true;
      computeWeldedNormals(geo, topo);
      markGeometrySculpted(mesh, geo);
    }

    this._stroke = stroke;
    return true;
  }

  stepStroke(camera, ndcX, ndcY, opts = {}) {
    const s = this._stroke;
    if (!s || !camera) return null;
    const { mesh, geometry: geo, topo } = s;
    const posAttr = geo.attributes.position;
    const pos = posAttr.array;

    if (s.tool === 'grab' && !opts.shift && s.grab) {
      _raycaster.setFromCamera({ x: ndcX, y: ndcY }, camera);
      const ray = _raycaster.ray;
      const n = s.grab.planeNormal;
      const denom = ray.direction.x * n.x + ray.direction.y * n.y + ray.direction.z * n.z;
      if (Math.abs(denom) < 1e-6) return null;
      const ox = s.grab.worldStart.x - ray.origin.x;
      const oy = s.grab.worldStart.y - ray.origin.y;
      const oz = s.grab.worldStart.z - ray.origin.z;
      const t = (ox * n.x + oy * n.y + oz * n.z) / denom;
      if (t <= 0) return null;

      const curWorld = _v0.copy(ray.origin).addScaledVector(ray.direction, t);
      const worldDelta = _v1.copy(curWorld).sub(s.grab.worldStart);

      mesh.updateMatrixWorld();
      _invMat.copyInverse(mesh.matrixWorld);
      const ie = _invMat.elements;
      const ldx = ie[0] * worldDelta.x + ie[4] * worldDelta.y + ie[8] * worldDelta.z;
      const ldy = ie[1] * worldDelta.x + ie[5] * worldDelta.y + ie[9] * worldDelta.z;
      const ldz = ie[2] * worldDelta.x + ie[6] * worldDelta.y + ie[10] * worldDelta.z;

      const symAxis = this._getSymmetryAxisIndex();
      const mdx = symAxis === 0 ? -ldx : ldx;
      const mdy = symAxis === 1 ? -ldy : ldy;
      const mdz = symAxis === 2 ? -ldz : ldz;

      const { weldOffsets, weldMembers } = topo;
      const str = this.strength;
      const entries = s.grab.entries;
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const f = e.weight * (0.35 + 0.65 * str);
        const dx = (e.isMirror ? mdx : ldx) * f;
        const dy = (e.isMirror ? mdy : ldy) * f;
        const dz = (e.isMirror ? mdz : ldz) * f;
        const nx = e.x0 + dx, ny = e.y0 + dy, nz = e.z0 + dz;
        const start = weldOffsets[e.w], end = weldOffsets[e.w + 1];
        for (let k = start; k < end; k++) {
          const m3 = weldMembers[k] * 3;
          pos[m3] = nx; pos[m3 + 1] = ny; pos[m3 + 2] = nz;
        }
      }

      posAttr.needsUpdate = true;
      computeWeldedNormals(geo, topo);
      markGeometrySculpted(mesh, geo);
      return { mesh, point: curWorld.clone(), normal: n.clone(), mirrorPoint: null };
    }

    const hit = this.pickSurface(camera, ndcX, ndcY, mesh);
    if (!hit) return null;

    const activeTool = opts.shift ? 'smooth' : s.tool;
    const invert = opts.invert !== undefined ? Boolean(opts.invert) : this.invert;
    const { localPt, localN, localRadius } = this._worldToLocalPointAndNormal(mesh, hit.point, hit.normal);

    const stepDist = s.lastLocalPt.distanceTo(localPt);
    const maxStep = Math.max(1e-4, localRadius * 0.28);
    const subSteps = Math.max(1, Math.min(6, Math.ceil(stepDist / maxStep)));

    const symAxis = this._getSymmetryAxisIndex();
    for (let st = 1; st <= subSteps; st++) {
      const alpha = st / subSteps;
      const px = s.lastLocalPt.x + (localPt.x - s.lastLocalPt.x) * alpha;
      const py = s.lastLocalPt.y + (localPt.y - s.lastLocalPt.y) * alpha;
      const pz = s.lastLocalPt.z + (localPt.z - s.lastLocalPt.z) * alpha;

      this._applyBrushAt(geo, topo, activeTool, px, py, pz, localN.x, localN.y, localN.z, localRadius, invert, false);

      if (symAxis >= 0) {
        const sx = symAxis === 0 ? -px : px;
        const sy = symAxis === 1 ? -py : py;
        const sz = symAxis === 2 ? -pz : pz;
        if (Math.hypot(px - sx, py - sy, pz - sz) > localRadius * 0.12) {
          const snx = symAxis === 0 ? -localN.x : localN.x;
          const sny = symAxis === 1 ? -localN.y : localN.y;
          const snz = symAxis === 2 ? -localN.z : localN.z;
          this._applyBrushAt(geo, topo, activeTool, sx, sy, sz, snx, sny, snz, localRadius, invert, true);
        }
      }
    }

    s.lastLocalPt.copy(localPt);
    posAttr.needsUpdate = true;
    computeWeldedNormals(geo, topo);
    markGeometrySculpted(mesh, geo);
    return hit;
  }

  _applyBrushAt(geo, topo, tool, cx, cy, cz, lnx, lny, lnz, r, invert, isMirrorPass) {
    const pos = geo.attributes.position.array;
    const nor = geo.attributes.normal.array;
    const {
      W, weldOffsets, weldMembers,
      adjOffsets, adjNeighbors, smoothBuf,
      activeWelds, activeWeights,
    } = topo;

    const r2 = r * r;
    const symAxis = this._getSymmetryAxisIndex();
    let activeCount = 0;

    let avgNx = 0, avgNy = 0, avgNz = 0;
    let avgPx = 0, avgPy = 0, avgPz = 0;
    let wSum = 0;

    for (let w = 0; w < W; w++) {
      const rep = weldMembers[weldOffsets[w]];
      const rep3 = rep * 3;
      const vx = pos[rep3], vy = pos[rep3 + 1], vz = pos[rep3 + 2];
      const dx = vx - cx, dy = vy - cy, dz = vz - cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= r2) continue;

      if (isMirrorPass && symAxis >= 0) {
        const px = symAxis === 0 ? -cx : cx;
        const py = symAxis === 1 ? -cy : cy;
        const pz = symAxis === 2 ? -cz : cz;
        const d2Other = (vx - px) ** 2 + (vy - py) ** 2 + (vz - pz) ** 2;
        if (d2Other < d2) continue;
      }

      const vnx = nor[rep3], vny = nor[rep3 + 1], vnz = nor[rep3 + 2];
      if (this.frontFacesOnly && (vnx * lnx + vny * lny + vnz * lnz) <= -0.15) continue;

      const weight = evalFalloff(Math.sqrt(d2) / r, this.falloff);
      if (weight <= 0) continue;

      activeWelds[activeCount] = w;
      activeWeights[activeCount] = weight;
      activeCount++;

      avgNx += vnx * weight; avgNy += vny * weight; avgNz += vnz * weight;
      avgPx += vx * weight; avgPy += vy * weight; avgPz += vz * weight;
      wSum += weight;
    }

    if (!activeCount || wSum <= 1e-8) return;

    const avgLen = Math.hypot(avgNx, avgNy, avgNz);
    if (avgLen > 1e-6) {
      avgNx /= avgLen; avgNy /= avgLen; avgNz /= avgLen;
    } else {
      avgNx = lnx; avgNy = lny; avgNz = lnz;
    }
    avgPx /= wSum; avgPy /= wSum; avgPz /= wSum;

    const str = this.strength;
    const sign = invert ? -1 : 1;

    if (tool === 'smooth') {
      const tBase = Math.min(0.88, str * 0.65);
      for (let i = 0; i < activeCount; i++) {
        const w = activeWelds[i];
        const weight = activeWeights[i];
        const aStart = adjOffsets[w], aEnd = adjOffsets[w + 1];
        const nbCount = aEnd - aStart;
        const rep3 = weldMembers[weldOffsets[w]] * 3;
        const vx = pos[rep3], vy = pos[rep3 + 1], vz = pos[rep3 + 2];
        if (!nbCount) {
          smoothBuf[w * 3] = vx; smoothBuf[w * 3 + 1] = vy; smoothBuf[w * 3 + 2] = vz;
          continue;
        }
        let sx = 0, sy = 0, sz = 0;
        for (let k = aStart; k < aEnd; k++) {
          const nb = adjNeighbors[k];
          const nb3 = weldMembers[weldOffsets[nb]] * 3;
          sx += pos[nb3]; sy += pos[nb3 + 1]; sz += pos[nb3 + 2];
        }
        const invN = 1 / nbCount;
        const blend = tBase * weight;
        smoothBuf[w * 3] = vx + (sx * invN - vx) * blend;
        smoothBuf[w * 3 + 1] = vy + (sy * invN - vy) * blend;
        smoothBuf[w * 3 + 2] = vz + (sz * invN - vz) * blend;
      }
      for (let i = 0; i < activeCount; i++) {
        const w = activeWelds[i];
        const nx = smoothBuf[w * 3], ny = smoothBuf[w * 3 + 1], nz = smoothBuf[w * 3 + 2];
        const start = weldOffsets[w], end = weldOffsets[w + 1];
        for (let k = start; k < end; k++) {
          const m3 = weldMembers[k] * 3;
          pos[m3] = nx; pos[m3 + 1] = ny; pos[m3 + 2] = nz;
        }
      }
      return;
    }

    const baseAmp = r * str * 0.14;
    for (let i = 0; i < activeCount; i++) {
      const w = activeWelds[i];
      const weight = activeWeights[i];
      const rep3 = weldMembers[weldOffsets[w]] * 3;
      let vx = pos[rep3], vy = pos[rep3 + 1], vz = pos[rep3 + 2];
      let dx = 0, dy = 0, dz = 0;

      if (tool === 'draw') {
        const amt = sign * baseAmp * weight;
        dx = avgNx * amt; dy = avgNy * amt; dz = avgNz * amt;
      } else if (tool === 'carve') {
        const amt = -sign * baseAmp * 1.1 * weight;
        dx = avgNx * amt; dy = avgNy * amt; dz = avgNz * amt;
      } else if (tool === 'clay') {
        const proj = (vx - avgPx) * avgNx + (vy - avgPy) * avgNy + (vz - avgPz) * avgNz;
        const lift = sign * baseAmp - proj * 0.35 * str;
        const amt = lift * weight;
        dx = avgNx * amt; dy = avgNy * amt; dz = avgNz * amt;
      } else if (tool === 'crease') {
        const indent = -sign * baseAmp * 0.95 * weight;
        const pull = sign * Math.min(0.45, str * 0.18) * weight;
        dx = avgNx * indent + (cx - vx) * pull;
        dy = avgNy * indent + (cy - vy) * pull;
        dz = avgNz * indent + (cz - vz) * pull;
      } else if (tool === 'inflate') {
        const vnx = nor[rep3], vny = nor[rep3 + 1], vnz = nor[rep3 + 2];
        const amt = sign * baseAmp * weight;
        dx = vnx * amt; dy = vny * amt; dz = vnz * amt;
      } else if (tool === 'deflate') {
        const vnx = nor[rep3], vny = nor[rep3 + 1], vnz = nor[rep3 + 2];
        const amt = -sign * baseAmp * weight;
        dx = vnx * amt; dy = vny * amt; dz = vnz * amt;
      } else if (tool === 'flatten') {
        const proj = (vx - avgPx) * avgNx + (vy - avgPy) * avgNy + (vz - avgPz) * avgNz;
        const amt = -proj * sign * Math.min(0.85, str * 0.55) * weight;
        dx = avgNx * amt; dy = avgNy * amt; dz = avgNz * amt;
      } else if (tool === 'pinch') {
        const pull = sign * Math.min(0.55, str * 0.22) * weight;
        dx = (cx - vx) * pull;
        dy = (cy - vy) * pull;
        dz = (cz - vz) * pull;
      }

      vx += dx; vy += dy; vz += dz;
      const start = weldOffsets[w], end = weldOffsets[w + 1];
      for (let k = start; k < end; k++) {
        const m3 = weldMembers[k] * 3;
        pos[m3] = vx; pos[m3 + 1] = vy; pos[m3 + 2] = vz;
      }
    }
  }

  endStroke() {
    const s = this._stroke;
    this._stroke = null;
    if (!s) return null;

    const afterPos = s.geometry.attributes.position.array;
    const beforePos = s.beforePos;
    const n = afterPos.length;
    const changed = [];
    for (let i = 0; i < n; i++) {
      if (Math.abs(afterPos[i] - beforePos[i]) > 1e-6) changed.push(i);
    }
    if (!changed.length) {
      s.mesh._subsurfDirtyFromGeometry = s.prevDirty;
      s.geometry._modifiedBySculpt = s.prevModFlag;
      s.geometry._isGeneratedSubsurf = s.prevGenFlag;
      return null;
    }

    const indices = new Uint32Array(changed.length);
    const before = new Float32Array(changed.length);
    const after = new Float32Array(changed.length);
    for (let k = 0; k < changed.length; k++) {
      const idx = changed[k];
      indices[k] = idx;
      before[k] = beforePos[idx];
      after[k] = afterPos[idx];
    }

    markGeometrySculpted(s.mesh, s.geometry);
    if (s.mesh._subsurf && s.geometry.attributes.position.count <= 45000) {
      syncEditableBaseFromGeometry(s.mesh);
    }

    const afterSubsurf = s.mesh._subsurf
      ? {
          level: s.mesh._subsurf.level | 0,
          smoothness: s.mesh._subsurf.smoothness ?? 1,
          smoothShading: Boolean(s.mesh._subsurf.smoothShading),
          showCage: Boolean(s.mesh._subsurf.showCage),
          alwaysShowCage: Boolean(s.mesh._subsurf.alwaysShowCage),
          baseMesh: s.mesh._subsurf.baseMesh ? s.mesh._subsurf.baseMesh.clone() : null,
        }
      : null;

    return {
      mesh: s.mesh,
      geometry: s.geometry,
      diff: { indices, before, after },
      beforeState: {
        subsurf: s.prevSubsurf,
        dirty: s.prevDirty,
        modFlag: s.prevModFlag,
        genFlag: s.prevGenFlag,
      },
      afterState: {
        subsurf: afterSubsurf,
        dirty: Boolean(s.mesh._subsurfDirtyFromGeometry),
        modFlag: Boolean(s.geometry._modifiedBySculpt),
        genFlag: Boolean(s.geometry._isGeneratedSubsurf),
      },
    };
  }

  cancelStroke() {
    const s = this._stroke;
    this._stroke = null;
    this._releasePointerCapture();
    this._activePointerId = null;
    if (!s) return false;
    const posAttr = s.geometry.attributes.position;
    posAttr.array.set(s.beforePos);
    posAttr.needsUpdate = true;
    s.geometry.boundingBox = null;
    s.geometry.boundingSphere = null;
    computeWeldedNormals(s.geometry, s.topo);
    s.mesh._subsurfDirtyFromGeometry = s.prevDirty;
    s.geometry._modifiedBySculpt = s.prevModFlag;
    s.geometry._isGeneratedSubsurf = s.prevGenFlag;
    return true;
  }

  static applyDiff(geo, diff, useAfter, mesh = null) {
    if (!geo || !geo.attributes || !geo.attributes.position || !diff) return;
    const posAttr = geo.attributes.position;
    const arr = posAttr.array;
    const src = useAfter ? diff.after : diff.before;
    const indices = diff.indices;
    for (let k = 0; k < indices.length; k++) {
      arr[indices[k]] = src[k];
    }
    posAttr.needsUpdate = true;
    markGeometrySculpted(mesh, geo);
    computeWeldedNormals(geo);
    if (mesh) {
      if (mesh.geometry !== geo) {
        if (typeof mesh.setGeometry === 'function') mesh.setGeometry(geo);
        else mesh.geometry = geo;
      }
      if (mesh._subsurf && geo.attributes.position.count <= 45000) {
        syncEditableBaseFromGeometry(mesh);
      }
    }
  }

  /**
   * Dibuja en el canvas 2D el anillo 3D proyectado del pincel sobre la superficie (y el anillo espejo).
   */
  drawCursor(ctx, camera, width, height, hover, opts = {}) {
    if (!ctx || !camera || !hover || !hover.point || !hover.normal) return;
    const tool = opts.shift ? 'smooth' : this.tool;
    const color = opts.invert ? '#f87171' : (TOOL_COLORS[tool] || '#60a5fa');

    const drawRing = (center, normal, dashed = false, alpha = 1) => {
      const ref = Math.abs(normal.y) < 0.9 ? _v1.set(0, 1, 0) : _v1.set(1, 0, 0);
      _tan.crossVectors(ref, normal).normalize();
      _bitan.crossVectors(normal, _tan).normalize();

      const steps = 36;
      const r = this.radius;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = dashed ? 1.4 : 2.0;
      if (dashed) ctx.setLineDash([5, 4]);

      ctx.beginPath();
      let started = false;
      for (let i = 0; i <= steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        const ca = Math.cos(a) * r, sa = Math.sin(a) * r;
        _proj.set(
          center.x + _tan.x * ca + _bitan.x * sa,
          center.y + _tan.y * ca + _bitan.y * sa,
          center.z + _tan.z * ca + _bitan.z * sa
        ).project(camera);
        if (_proj.z < -1 || _proj.z > 1) { started = false; continue; }
        const sx = (_proj.x * 0.5 + 0.5) * width;
        const sy = (-_proj.y * 0.5 + 0.5) * height;
        if (!started) { ctx.moveTo(sx, sy); started = true; }
        else ctx.lineTo(sx, sy);
      }
      ctx.stroke();

      if (!dashed) {
        // Anillo interior proporcional a la fuerza + punto central
        const ir = r * (0.18 + 0.55 * this.strength);
        ctx.beginPath();
        ctx.globalAlpha = 0.45;
        ctx.lineWidth = 1.1;
        started = false;
        for (let i = 0; i <= 24; i++) {
          const a = (i / 24) * Math.PI * 2;
          const ca = Math.cos(a) * ir, sa = Math.sin(a) * ir;
          _proj.set(
            center.x + _tan.x * ca + _bitan.x * sa,
            center.y + _tan.y * ca + _bitan.y * sa,
            center.z + _tan.z * ca + _bitan.z * sa
          ).project(camera);
          if (_proj.z < -1 || _proj.z > 1) { started = false; continue; }
          const sx = (_proj.x * 0.5 + 0.5) * width;
          const sy = (-_proj.y * 0.5 + 0.5) * height;
          if (!started) { ctx.moveTo(sx, sy); started = true; }
          else ctx.lineTo(sx, sy);
        }
        ctx.stroke();

        _proj.copy(center).project(camera);
        if (_proj.z >= -1 && _proj.z <= 1) {
          const cx2 = (_proj.x * 0.5 + 0.5) * width;
          const cy2 = (-_proj.y * 0.5 + 0.5) * height;
          ctx.globalAlpha = 0.95;
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(cx2, cy2, 2.8, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    };

    drawRing(hover.point, hover.normal, false, 0.95);
    if (hover.mirrorPoint && hover.mirrorNormal && hover.point.distanceTo(hover.mirrorPoint) > 1e-3) {
      drawRing(hover.mirrorPoint, hover.mirrorNormal, true, 0.6);
    }
  }

  static ensureUniqueGeometry(mesh, scene = null) {
    if (!mesh || !mesh.geometry) return null;
    const geo = mesh.geometry;
    let shared = false;
    if (scene && typeof scene.traverse === 'function') {
      scene.traverse((n) => {
        if (n !== mesh && n.isMesh && n.geometry === geo) shared = true;
      });
    }
    if (shared) {
      const cloned = geo.clone();
      if (typeof mesh.setGeometry === 'function') mesh.setGeometry(cloned);
      else mesh.geometry = cloned;
      return cloned;
    }
    return geo;
  }

  renderOverlay(canvas, camera, hover, opts = {}) {
    if (!canvas || canvas.hidden || !camera) return false;
    const refEl = opts.referenceElement || canvas;
    const cssW = Math.max(1, opts.width || refEl.clientWidth || canvas.clientWidth || 1);
    const cssH = Math.max(1, opts.height || refEl.clientHeight || canvas.clientHeight || 1);
    const dpr = Math.min((typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1, opts.maxDpr ?? 2);
    const pw = Math.round(cssW * dpr);
    const ph = Math.round(cssH * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    if (hover) {
      this.drawCursor(ctx, camera, cssW, cssH, hover, opts);
    }
    return true;
  }

  _releasePointerCapture(pointerId = this._activePointerId) {
    if (pointerId === null || pointerId === undefined || !this._captureEl) return;
    try {
      if (this._captureEl.hasPointerCapture?.(pointerId)) {
        this._captureEl.releasePointerCapture(pointerId);
      }
    } catch (_) {}
    this._captureEl = null;
  }

  commitStroke() {
    if (!this.isStroking) return null;
    const res = this.endStroke();
    if (res && res.diff && this._attached?.onStrokeEnd) {
      this._attached.onStrokeEnd(res);
    }
    return res;
  }

  setEnabled(on) {
    const next = Boolean(on);
    if (!next) {
      if (this.isStroking) this.commitStroke();
      this._releasePointerCapture();
      this._activePointerId = null;
      this._pointers.clear();
      this.hover = null;
    }
    this.enabled = next;
    const cfg = this._attached;
    if (cfg) {
      if (cfg.overlay) {
        cfg.overlay.hidden = !next;
        if (!next) {
          const ctx = cfg.overlay.getContext('2d');
          if (ctx) ctx.clearRect(0, 0, cfg.overlay.width, cfg.overlay.height);
        }
      }
      const ctrl = typeof cfg.getControls === 'function' ? cfg.getControls() : cfg.controls;
      if (ctrl && typeof cfg.getControlsEnabled === 'function') {
        ctrl.enabled = Boolean(cfg.getControlsEnabled());
      }
    }
    return this;
  }

  drawAttachedOverlay(camera) {
    const cfg = this._attached;
    if (!cfg || !cfg.overlay || !this.enabled || cfg.overlay.hidden || !camera) return false;
    const invert = this.alt ? !this.invert : this.invert;
    const targetEl = typeof cfg.pointerDownTarget === 'function'
      ? cfg.pointerDownTarget()
      : (cfg.pointerDownTarget || cfg.domElement);
    return this.renderOverlay(cfg.overlay, camera, this.hover, {
      referenceElement: cfg.referenceElement || targetEl,
      shift: this.shift,
      invert,
    });
  }

  attach(opts = {}) {
    this.detach();
    const domElement = opts.domElement;
    if (!domElement || typeof domElement.addEventListener !== 'function') return this;

    this._attached = opts;

    const resolveTarget = () =>
      typeof opts.pointerDownTarget === 'function'
        ? opts.pointerDownTarget()
        : (opts.pointerDownTarget || domElement);
    const resolveCamera = () => (typeof opts.getCamera === 'function' ? opts.getCamera() : opts.camera);
    const resolveControls = () => (typeof opts.getControls === 'function' ? opts.getControls() : opts.controls);
    const resolveScene = () => (typeof opts.getScene === 'function' ? opts.getScene() : opts.scene);
    const resolveControlsEnabled = () =>
      typeof opts.getControlsEnabled === 'function' ? Boolean(opts.getControlsEnabled()) : true;
    const toNdc = (e) => {
      const rectEl = resolveTarget() || domElement;
      const rect = rectEl.getBoundingClientRect();
      return {
        x: ((e.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
        y: -((e.clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1,
      };
    };

    const onPointerDown = (e) => {
      const targetEl = resolveTarget();
      if (targetEl && e.target !== targetEl) return;
      this._pointers.add(e.pointerId);
      if (!this.enabled) return;

      const ctrl = resolveControls();
      if (this._pointers.size > 1) {
        if (this.isStroking) {
          this.commitStroke();
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

      Sculptor.ensureUniqueGeometry(hit.mesh, resolveScene());
      const shift = this.shift || e.shiftKey;
      const alt = this.alt || e.altKey;
      const invert = alt ? !this.invert : this.invert;
      const started = this.beginStroke(hit.mesh, hit, cam, { shift, invert });
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
      this.shift = e.shiftKey;
      this.alt = e.altKey;
      const cam = resolveCamera();
      if (!cam) return;
      const { x: ndcX, y: ndcY } = toNdc(e);

      if (this.isStroking && e.pointerId === this._activePointerId) {
        const invert = this.alt ? !this.invert : this.invert;
        const hit = this.stepStroke(cam, ndcX, ndcY, { shift: this.shift, invert });
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
        this.commitStroke();
        const ctrl = resolveControls();
        if (ctrl) ctrl.enabled = resolveControlsEnabled();
        this._releasePointerCapture(e.pointerId);
      }
    };

    const onPointerLeave = () => {
      if (!this.isStroking) this.hover = null;
    };

    const onKeyDown = (e) => {
      this.shift = e.shiftKey;
      this.alt = e.altKey;
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
        const nextR = e.key === '[' ? Math.max(0.06, this.radius * 0.85) : Math.min(2.5, this.radius * 1.18);
        this.radius = Number(nextR.toFixed(2));
        opts.onRadiusChange?.(this.radius);
      }
    };

    const onKeyUp = (e) => {
      this.shift = e.shiftKey;
      this.alt = e.altKey;
    };

    const onBlur = () => {
      this.shift = false;
      this.alt = false;
      this._pointers.clear();
    };

    domElement.addEventListener('pointerdown', onPointerDown, { capture: true });
    domElement.addEventListener('pointermove', onPointerMove);
    domElement.addEventListener('pointerup', finishPointer);
    domElement.addEventListener('pointercancel', finishPointer);
    domElement.addEventListener('pointerleave', onPointerLeave);
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('keyup', onKeyUp);
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
        window.removeEventListener('keyup', onKeyUp);
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
