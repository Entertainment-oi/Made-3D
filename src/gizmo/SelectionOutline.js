import { Vec3 as Vector3 } from '../math/Vec3.js';
import { Mat4 } from '../math/Mat4.js';
import { Frustum } from '../render/Frustum.js';

/**
 * Contorno de selección estilo CAD/Made3D dibujado con líneas nítidas en Canvas 2D
 * siguiendo la silueta y bordes exteriores reales del objeto seleccionado
 * (con respaldo opcional en GPU mediante `mode: 'gpu'`).
 */

const _ct = new Vector3();
const _secCol = new Float32Array(4);
const _actCol = new Float32Array(4);
const _DEFAULT_MAX_MASK_PIXELS = 1920 * 1080;
const _MAX_RADIUS_PX = 10;
const _MAX_INSTANCES_OUTLINE = 256;

const _SILHOUETTE_CACHE = new WeakMap();
const _IDENTITY_MAT = new Mat4();

function parseColor(c, out) {
  if (typeof c === 'string') {
    let hex = c.trim();
    if (hex[0] === '#') hex = hex.slice(1);
    if (hex.length === 3) {
      out[0] = parseInt(hex[0] + hex[0], 16) / 255;
      out[1] = parseInt(hex[1] + hex[1], 16) / 255;
      out[2] = parseInt(hex[2] + hex[2], 16) / 255;
      out[3] = 1;
      return out;
    }
    if (hex.length >= 6) {
      out[0] = parseInt(hex.slice(0, 2), 16) / 255;
      out[1] = parseInt(hex.slice(2, 4), 16) / 255;
      out[2] = parseInt(hex.slice(4, 6), 16) / 255;
      out[3] = 1;
      return out;
    }
  } else if (typeof c === 'number') {
    out[0] = ((c >> 16) & 255) / 255;
    out[1] = ((c >> 8) & 255) / 255;
    out[2] = (c & 255) / 255;
    out[3] = 1;
    return out;
  } else if (c && c.r !== undefined) {
    out[0] = c.r; out[1] = c.g; out[2] = c.b; out[3] = 1;
    return out;
  }
  out[0] = 1; out[1] = 0.667; out[2] = 0.251; out[3] = 1;
  return out;
}

function buildSilhouetteCache(geo) {
  const posAttr = geo.attributes?.position;
  if (!posAttr || posAttr.count < 3) return null;
  const vCount = posAttr.count;
  const pos = posAttr.array;
  const idxAttr = geo.index || null;
  const idx = idxAttr ? idxAttr.array : null;
  const idxVer = idxAttr ? idxAttr.version : -1;

  // Escala espacial para tolerancia de soldado
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < vCount; i++) {
    const o = i * 3;
    const x = pos[o], y = pos[o + 1], z = pos[o + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1;
  const invEps = 1 / Math.max(1e-6, diag * 1e-5);

  const vertMap = new Map();
  const weldOf = new Int32Array(vCount);
  const repRawList = [];
  for (let i = 0; i < vCount; i++) {
    const o = i * 3;
    const key = `${Math.round(pos[o] * invEps)},${Math.round(pos[o + 1] * invEps)},${Math.round(pos[o + 2] * invEps)}`;
    let w = vertMap.get(key);
    if (w === undefined) {
      w = repRawList.length;
      vertMap.set(key, w);
      repRawList.push(i);
    }
    weldOf[i] = w;
  }

  const W = repRawList.length;
  const repRawIndex = new Int32Array(repRawList);
  const rawTris = idx ? (idx.length / 3) | 0 : (vCount / 3) | 0;
  const triList = [];

  for (let t = 0; t < rawTris; t++) {
    const t3 = t * 3;
    const ia = idx ? idx[t3] : t3;
    const ib = idx ? idx[t3 + 1] : t3 + 1;
    const ic = idx ? idx[t3 + 2] : t3 + 2;
    const wa = weldOf[ia], wb = weldOf[ib], wc = weldOf[ic];
    if (wa === wb || wb === wc || wc === wa) continue;
    const ao = ia * 3, bo = ib * 3, co = ic * 3;
    const e1x = pos[bo] - pos[ao], e1y = pos[bo + 1] - pos[ao + 1], e1z = pos[bo + 2] - pos[ao + 2];
    const e2x = pos[co] - pos[ao], e2y = pos[co + 1] - pos[ao + 1], e2z = pos[co + 2] - pos[ao + 2];
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    if (nx * nx + ny * ny + nz * nz <= 1e-20) continue;
    triList.push(wa, wb, wc);
  }

  const triCount = (triList.length / 3) | 0;
  const triW = new Int32Array(triList);

  const edgeMap = new Map();
  const edgeAList = [];
  const edgeBList = [];
  const edgeT0List = [];
  const edgeT1List = [];
  let edgeExtraFaces = null;

  const addEdge = (u, v, triIdx) => {
    const lo = u < v ? u : v;
    const hi = u < v ? v : u;
    const key = lo * W + hi;
    const existing = edgeMap.get(key);
    if (existing === undefined) {
      const ei = edgeAList.length;
      edgeMap.set(key, ei);
      edgeAList.push(lo);
      edgeBList.push(hi);
      edgeT0List.push(triIdx);
      edgeT1List.push(-1);
    } else if (edgeT1List[existing] < 0) {
      edgeT1List[existing] = triIdx;
    } else {
      if (!edgeExtraFaces) edgeExtraFaces = new Map();
      let arr = edgeExtraFaces.get(existing);
      if (!arr) { arr = []; edgeExtraFaces.set(existing, arr); }
      arr.push(triIdx);
    }
  };

  for (let t = 0; t < triCount; t++) {
    const t3 = t * 3;
    const wa = triW[t3], wb = triW[t3 + 1], wc = triW[t3 + 2];
    addEdge(wa, wb, t);
    addEdge(wb, wc, t);
    addEdge(wc, wa, t);
  }

  const edgeCount = edgeAList.length;
  return {
    vCount,
    idxVer,
    W,
    repRawIndex,
    triCount,
    triW,
    edgeCount,
    edgeA: new Int32Array(edgeAList),
    edgeB: new Int32Array(edgeBList),
    edgeT0: new Int32Array(edgeT0List),
    edgeT1: new Int32Array(edgeT1List),
    edgeExtraFaces,
    weldPos: new Float32Array(W * 3),
    triNormals: new Float32Array(triCount * 3),
    triCenters: new Float32Array(triCount * 3),
    triFront: new Uint8Array(triCount),
    posVer: -1,
    skinWeldPos: null,
    skinTriNormals: null,
    skinTriCenters: null,
  };
}

function getOrUpdateSilhouetteCache(geo) {
  if (!geo || !geo.attributes || !geo.attributes.position) return null;
  const posAttr = geo.attributes.position;
  const idxAttr = geo.index || null;
  const idxVer = idxAttr ? idxAttr.version : -1;
  let cache = _SILHOUETTE_CACHE.get(geo);
  if (!cache || cache.vCount !== posAttr.count || cache.idxVer !== idxVer) {
    cache = buildSilhouetteCache(geo);
    if (!cache) return null;
    _SILHOUETTE_CACHE.set(geo, cache);
  }
  if (cache.posVer !== posAttr.version) {
    updateNormalsAndCenters(posAttr.array, cache.weldPos, cache.triNormals, cache.triCenters, cache);
    cache.posVer = posAttr.version;
  }
  return cache;
}

function updateNormalsAndCenters(rawPos, outWeldPos, outNormals, outCenters, cache) {
  const { W, repRawIndex, triCount, triW } = cache;
  for (let w = 0; w < W; w++) {
    const ro = repRawIndex[w] * 3;
    const wo = w * 3;
    outWeldPos[wo] = rawPos[ro];
    outWeldPos[wo + 1] = rawPos[ro + 1];
    outWeldPos[wo + 2] = rawPos[ro + 2];
  }
  for (let t = 0; t < triCount; t++) {
    const t3 = t * 3;
    const ao = triW[t3] * 3;
    const bo = triW[t3 + 1] * 3;
    const co = triW[t3 + 2] * 3;
    const ax = outWeldPos[ao], ay = outWeldPos[ao + 1], az = outWeldPos[ao + 2];
    const bx = outWeldPos[bo], by = outWeldPos[bo + 1], bz = outWeldPos[bo + 2];
    const cx = outWeldPos[co], cy = outWeldPos[co + 1], cz = outWeldPos[co + 2];
    outCenters[t3] = (ax + bx + cx) / 3;
    outCenters[t3 + 1] = (ay + by + cy) / 3;
    outCenters[t3 + 2] = (az + bz + cz) / 3;

    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nx, ny, nz) || 1;
    outNormals[t3] = nx / len;
    outNormals[t3 + 1] = ny / len;
    outNormals[t3 + 2] = nz / len;
  }
}

export class SelectionOutline {
  constructor(opts = {}) {
    this.mode = opts.mode || 'canvas';                           // 'canvas' (borde lineal 2D) o 'gpu'
    this.width = opts.width ?? 2.2;                               // grosor del contorno en píxeles CSS
    this.resolutionScale = opts.resolutionScale ?? 'auto';        // 'auto' o escala fija en (0..1]
    this.maxMaskPixels = opts.maxMaskPixels ?? _DEFAULT_MAX_MASK_PIXELS;
    this._meshScratch = [];
    this._secMeshes = [];
    this._actMeshes = [];
    this._vp = new Mat4();
    this._mvp = new Mat4();
    this._invModel = new Mat4();
    this._instMat = new Mat4();
    this._skinWorldScratch = null;
    this._frustum = new Frustum();
    this._bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, full: false };

    // Búferes reutilizables para filtrado de silueta exterior 2D en Canvas (sin asignaciones por cuadro)
    this._projX = new Float32Array(0);
    this._projY = new Float32Array(0);
    this._clipX = new Float32Array(0);
    this._clipY = new Float32Array(0);
    this._clipZ = new Float32Array(0);
    this._clipW = new Float32Array(0);
    this._projOk = new Uint8Array(0);
    this._triScreen = new Float32Array(0);
    this._triValid = new Uint8Array(0);
    this._gridHead = new Int32Array(24 * 24);
    this._entryTri = new Int32Array(0);
    this._entryNext = new Int32Array(0);
    this._gridGx0 = 0;
    this._gridGy0 = 0;
    this._gridGx1 = 0;
    this._gridGy1 = 0;
    this._gridInvCellW = 1;
    this._gridInvCellH = 1;
  }

  _ensureVertBuffers(W) {
    if (this._projX.length < W) {
      this._projX = new Float32Array(W);
      this._projY = new Float32Array(W);
      this._clipX = new Float32Array(W);
      this._clipY = new Float32Array(W);
      this._clipZ = new Float32Array(W);
      this._clipW = new Float32Array(W);
      this._projOk = new Uint8Array(W);
    }
  }

  _ensureTriBuffers(triCount) {
    if (this._triValid.length < triCount) {
      this._triValid = new Uint8Array(triCount);
      this._triScreen = new Float32Array(triCount * 6);
    }
    const minEntries = Math.max(256, triCount * 2);
    if (this._entryTri.length < minEntries) {
      this._entryTri = new Int32Array(minEntries);
      this._entryNext = new Int32Array(minEntries);
    }
  }

  _growEntryBuffers() {
    const nextCap = Math.max(512, this._entryTri.length * 2);
    const nt = new Int32Array(nextCap);
    const nn = new Int32Array(nextCap);
    nt.set(this._entryTri);
    nn.set(this._entryNext);
    this._entryTri = nt;
    this._entryNext = nn;
  }

  _isPointInsideMesh2D(px, py) {
    if (px < this._gridGx0 || px > this._gridGx1 || py < this._gridGy0 || py > this._gridGy1) {
      return false;
    }
    const N = 24;
    let ix = ((px - this._gridGx0) * this._gridInvCellW) | 0;
    let iy = ((py - this._gridGy0) * this._gridInvCellH) | 0;
    if (ix < 0) ix = 0; else if (ix >= N) ix = N - 1;
    if (iy < 0) iy = 0; else if (iy >= N) iy = N - 1;

    const triScreen = this._triScreen;
    let ei = this._gridHead[iy * N + ix];
    while (ei >= 0) {
      const t = this._entryTri[ei];
      const o = t * 6;
      const ax = triScreen[o], ay = triScreen[o + 1];
      const bx = triScreen[o + 2], by = triScreen[o + 3];
      const cx = triScreen[o + 4], cy = triScreen[o + 5];

      const e0 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
      const e1 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
      const e2 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);

      const t0 = (Math.abs(bx - ax) + Math.abs(by - ay)) * 0.02;
      const t1 = (Math.abs(cx - bx) + Math.abs(cy - by)) * 0.02;
      const t2 = (Math.abs(ax - cx) + Math.abs(ay - cy)) * 0.02;

      if ((e0 >= -t0 && e1 >= -t1 && e2 >= -t2) || (e0 <= t0 && e1 <= t1 && e2 <= t2)) {
        return true;
      }
      ei = this._entryNext[ei];
    }
    return false;
  }

  _resolveScale(w, h) {
    if (typeof this.resolutionScale === 'number' && Number.isFinite(this.resolutionScale)) {
      return Math.max(0.25, Math.min(1, this.resolutionScale));
    }
    const pixels = w * h;
    const cap = Math.max(65536, Number(this.maxMaskPixels) || _DEFAULT_MAX_MASK_PIXELS);
    if (pixels <= cap) return 1;
    return Math.max(0.45, Math.min(1, Math.sqrt(cap / pixels)));
  }

  _collectMeshes(node, out) {
    if (!node || !node.visible) return;
    if (
      node.isGizmo ||
      node.isTransformGizmo ||
      node.isSkeletonHelper ||
      node.isGridHelper ||
      node.isCameraHelper ||
      node.isLight ||
      node.isCamera
    ) {
      return;
    }
    if (node.isOutlineEnabled ? !node.isOutlineEnabled() : (node.outline === false || (node.userData && node.userData.noOutline))) return;
    if (node.isMesh && node.geometry && node.geometry.attributes?.position &&
        (!node.material || node.material.visible !== false)) {
      out.push(node);
    }
    const ch = node.children;
    for (let i = 0; i < ch.length; i++) this._collectMeshes(ch[i], out);
  }

  _drawMeshSilhouette(ctx, camera, modelMatrix, cache, wPos, tNorm, tCent, W, H, strokeColor, lineWidth) {
    const ce = camera.matrixWorld.elements;
    const camPosW_x = ce[12], camPosW_y = ce[13], camPosW_z = ce[14];
    const camBackW_x = ce[8], camBackW_y = ce[9], camBackW_z = ce[10];
    const isOrtho = Boolean(camera.isOrthographicCamera || !camera.fov);

    const useInv = modelMatrix !== _IDENTITY_MAT;
    let sign = 1;
    let camLx = camPosW_x, camLy = camPosW_y, camLz = camPosW_z;
    let dirLx = camBackW_x, dirLy = camBackW_y, dirLz = camBackW_z;

    if (useInv) {
      this._invModel.copyInverse(modelMatrix);
      const me3 = modelMatrix.elements;
      const det3 =
        me3[0] * (me3[5] * me3[10] - me3[6] * me3[9]) -
        me3[4] * (me3[1] * me3[10] - me3[2] * me3[9]) +
        me3[8] * (me3[1] * me3[6] - me3[2] * me3[5]);
      sign = det3 < 0 ? -1 : 1;
      const ie = this._invModel.elements;
      if (isOrtho) {
        dirLx = ie[0] * camBackW_x + ie[4] * camBackW_y + ie[8] * camBackW_z;
        dirLy = ie[1] * camBackW_x + ie[5] * camBackW_y + ie[9] * camBackW_z;
        dirLz = ie[2] * camBackW_x + ie[6] * camBackW_y + ie[10] * camBackW_z;
      } else {
        camLx = ie[0] * camPosW_x + ie[4] * camPosW_y + ie[8] * camPosW_z + ie[12];
        camLy = ie[1] * camPosW_x + ie[5] * camPosW_y + ie[9] * camPosW_z + ie[13];
        camLz = ie[2] * camPosW_x + ie[6] * camPosW_y + ie[10] * camPosW_z + ie[14];
      }
      this._mvp.multiplyMatrices(this._vp, modelMatrix);
    } else {
      this._mvp.copy(this._vp);
    }

    const { W: vertCount, triCount, triW, triFront, edgeCount, edgeA, edgeB, edgeT0, edgeT1, edgeExtraFaces } = cache;
    if (isOrtho) {
      for (let t = 0; t < triCount; t++) {
        const t3 = t * 3;
        const dot = (tNorm[t3] * dirLx + tNorm[t3 + 1] * dirLy + tNorm[t3 + 2] * dirLz) * sign;
        triFront[t] = dot > 0 ? 1 : 0;
      }
    } else {
      for (let t = 0; t < triCount; t++) {
        const t3 = t * 3;
        const dx = camLx - tCent[t3];
        const dy = camLy - tCent[t3 + 1];
        const dz = camLz - tCent[t3 + 2];
        const dot = (tNorm[t3] * dx + tNorm[t3 + 1] * dy + tNorm[t3 + 2] * dz) * sign;
        triFront[t] = dot > 0 ? 1 : 0;
      }
    }

    const me = this._mvp.elements;
    const m0 = me[0], m1 = me[1], m2 = me[2], m3 = me[3];
    const m4 = me[4], m5 = me[5], m6 = me[6], m7 = me[7];
    const m8 = me[8], m9 = me[9], m10 = me[10], m11 = me[11];
    const m12 = me[12], m13 = me[13], m14 = me[14], m15 = me[15];

    const W_MIN = 1e-4;
    this._ensureVertBuffers(vertCount);
    this._ensureTriBuffers(triCount);

    const projX = this._projX;
    const projY = this._projY;
    const clipX = this._clipX;
    const clipY = this._clipY;
    const clipZ = this._clipZ;
    const clipW = this._clipW;
    const projOk = this._projOk;

    for (let v = 0; v < vertCount; v++) {
      const vo = v * 3;
      const px = wPos[vo], py = wPos[vo + 1], pz = wPos[vo + 2];
      const cx = m0 * px + m4 * py + m8 * pz + m12;
      const cy = m1 * px + m5 * py + m9 * pz + m13;
      const cz = m2 * px + m6 * py + m10 * pz + m14;
      const cw = m3 * px + m7 * py + m11 * pz + m15;
      clipX[v] = cx;
      clipY[v] = cy;
      clipZ[v] = cz;
      clipW[v] = cw;
      if (cw >= W_MIN && cz + cw >= 0) {
        const inv = 1 / cw;
        const sx = (cx * inv * 0.5 + 0.5) * W;
        const sy = (0.5 - cy * inv * 0.5) * H;
        if (Number.isFinite(sx) && Number.isFinite(sy)) {
          projX[v] = sx;
          projY[v] = sy;
          projOk[v] = 1;
          continue;
        }
      }
      projOk[v] = 0;
    }

    // Construir cobertura 2D en espacio de pantalla para filtrar aristas interiores y dejar solo la orilla externa
    const triScreen = this._triScreen;
    const triValid = this._triValid;
    let meshMinX = Infinity, meshMaxX = -Infinity;
    let meshMinY = Infinity, meshMaxY = -Infinity;
    let validTris = 0;

    for (let t = 0; t < triCount; t++) {
      const t3 = t * 3;
      const va = triW[t3], vb = triW[t3 + 1], vc = triW[t3 + 2];
      if (!projOk[va] || !projOk[vb] || !projOk[vc]) {
        triValid[t] = 0;
        continue;
      }
      const ax = projX[va], ay = projY[va];
      const bx = projX[vb], by = projY[vb];
      const cx = projX[vc], cy = projY[vc];
      const area2 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (Math.abs(area2) <= 1e-4) {
        triValid[t] = 0;
        continue;
      }
      const tx0 = ax < bx ? (ax < cx ? ax : cx) : (bx < cx ? bx : cx);
      const tx1 = ax > bx ? (ax > cx ? ax : cx) : (bx > cx ? bx : cx);
      const ty0 = ay < by ? (ay < cy ? ay : cy) : (by < cy ? by : cy);
      const ty1 = ay > by ? (ay > cy ? ay : cy) : (by > cy ? by : cy);
      if (tx1 < -64 || tx0 > W + 64 || ty1 < -64 || ty0 > H + 64) {
        triValid[t] = 0;
        continue;
      }
      const o = t * 6;
      triScreen[o] = ax; triScreen[o + 1] = ay;
      triScreen[o + 2] = bx; triScreen[o + 3] = by;
      triScreen[o + 4] = cx; triScreen[o + 5] = cy;
      triValid[t] = 1;
      validTris++;
      if (tx0 < meshMinX) meshMinX = tx0;
      if (tx1 > meshMaxX) meshMaxX = tx1;
      if (ty0 < meshMinY) meshMinY = ty0;
      if (ty1 > meshMaxY) meshMaxY = ty1;
    }

    const useBoundaryFilter = validTris > 0;
    if (useBoundaryFilter) {
      const N = 24;
      this._gridHead.fill(-1);
      const gx0 = Math.max(-64, meshMinX - 4);
      const gx1 = Math.min(W + 64, meshMaxX + 4);
      const gy0 = Math.max(-64, meshMinY - 4);
      const gy1 = Math.min(H + 64, meshMaxY + 4);
      const gw = Math.max(1e-3, gx1 - gx0);
      const gh = Math.max(1e-3, gy1 - gy0);
      const invCW = N / gw;
      const invCH = N / gh;
      this._gridGx0 = gx0;
      this._gridGx1 = gx1;
      this._gridGy0 = gy0;
      this._gridGy1 = gy1;
      this._gridInvCellW = invCW;
      this._gridInvCellH = invCH;

      let entryCount = 0;
      const gridHead = this._gridHead;
      for (let t = 0; t < triCount; t++) {
        if (!triValid[t]) continue;
        const o = t * 6;
        const ax = triScreen[o], ay = triScreen[o + 1];
        const bx = triScreen[o + 2], by = triScreen[o + 3];
        const cx = triScreen[o + 4], cy = triScreen[o + 5];
        const tx0 = ax < bx ? (ax < cx ? ax : cx) : (bx < cx ? bx : cx);
        const tx1 = ax > bx ? (ax > cx ? ax : cx) : (bx > cx ? bx : cx);
        const ty0 = ay < by ? (ay < cy ? ay : cy) : (by < cy ? by : cy);
        const ty1 = ay > by ? (ay > cy ? ay : cy) : (by > cy ? by : cy);

        let ix0 = ((tx0 - gx0) * invCW) | 0;
        let ix1 = ((tx1 - gx0) * invCW) | 0;
        let iy0 = ((ty0 - gy0) * invCH) | 0;
        let iy1 = ((ty1 - gy0) * invCH) | 0;
        if (ix1 < 0 || ix0 >= N || iy1 < 0 || iy0 >= N) continue;
        if (ix0 < 0) ix0 = 0; if (ix1 >= N) ix1 = N - 1;
        if (iy0 < 0) iy0 = 0; if (iy1 >= N) iy1 = N - 1;

        for (let iy = iy0; iy <= iy1; iy++) {
          const row = iy * N;
          for (let ix = ix0; ix <= ix1; ix++) {
            if (entryCount >= this._entryTri.length) this._growEntryBuffers();
            const cell = row + ix;
            this._entryTri[entryCount] = t;
            this._entryNext[entryCount] = gridHead[cell];
            gridHead[cell] = entryCount++;
          }
        }
      }
    }

    ctx.beginPath();
    let drawn = 0;

    for (let ei = 0; ei < edgeCount; ei++) {
      const t0 = edgeT0[ei];
      const t1 = edgeT1[ei];
      let isSilhouette = false;
      if (t1 < 0) {
        isSilhouette = true;
      } else if (triFront[t0] !== triFront[t1]) {
        isSilhouette = true;
      } else if (edgeExtraFaces && edgeExtraFaces.has(ei)) {
        const extra = edgeExtraFaces.get(ei);
        const f0 = triFront[t0];
        for (let k = 0; k < extra.length; k++) {
          if (triFront[extra[k]] !== f0) {
            isSilhouette = true;
            break;
          }
        }
      }
      if (!isSilhouette) continue;

      const va = edgeA[ei];
      const vb = edgeB[ei];
      let sx0, sy0, sx1, sy1;

      if (projOk[va] && projOk[vb]) {
        sx0 = projX[va]; sy0 = projY[va];
        sx1 = projX[vb]; sy1 = projY[vb];
      } else {
        let ax = clipX[va], ay = clipY[va], az = clipZ[va], aw = clipW[va];
        let bx = clipX[vb], by = clipY[vb], bz = clipZ[vb], bw = clipW[vb];

        if (aw < W_MIN && bw < W_MIN) continue;
        if (aw < W_MIN) {
          const t = (W_MIN - aw) / (bw - aw);
          ax += (bx - ax) * t;
          ay += (by - ay) * t;
          az += (bz - az) * t;
          aw = W_MIN;
        } else if (bw < W_MIN) {
          const t = (W_MIN - bw) / (aw - bw);
          bx += (ax - bx) * t;
          by += (ay - by) * t;
          bz += (az - bz) * t;
          bw = W_MIN;
        }

        const da = az + aw;
        const db = bz + bw;
        if (da < 0 && db < 0) continue;
        if (da < 0) {
          const t = da / (da - db);
          ax += (bx - ax) * t;
          ay += (by - ay) * t;
          az += (bz - az) * t;
          aw += (bw - aw) * t;
        } else if (db < 0) {
          const t = db / (db - da);
          bx += (ax - bx) * t;
          by += (ay - by) * t;
          bz += (az - bz) * t;
          bw += (aw - bw) * t;
        }

        const invA = 1 / aw;
        const invB = 1 / bw;
        sx0 = (ax * invA * 0.5 + 0.5) * W;
        sy0 = (0.5 - ay * invA * 0.5) * H;
        sx1 = (bx * invB * 0.5 + 0.5) * W;
        sy1 = (0.5 - by * invB * 0.5) * H;
      }

      if (!Number.isFinite(sx0) || !Number.isFinite(sy0) || !Number.isFinite(sx1) || !Number.isFinite(sy1)) continue;
      if (
        Math.max(sx0, sx1) < -64 ||
        Math.min(sx0, sx1) > W + 64 ||
        Math.max(sy0, sy1) < -64 ||
        Math.min(sy0, sy1) > H + 64
      ) {
        continue;
      }
      const dx = sx1 - sx0;
      const dy = sy1 - sy0;
      const len2 = dx * dx + dy * dy;
      if (len2 < 0.04) continue;

      if (!useBoundaryFilter) {
        ctx.moveTo(sx0, sy0);
        ctx.lineTo(sx1, sy1);
        drawn++;
        continue;
      }

      const len = Math.sqrt(len2);
      const nx = -dy / len;
      const ny = dx / len;
      const eps = Math.min(1.1, Math.max(0.45, len * 0.15));
      const steps = len > 18 ? Math.min(8, Math.ceil(len / 18)) : 1;

      if (steps === 1) {
        const mx = (sx0 + sx1) * 0.5;
        const my = (sy0 + sy1) * 0.5;
        const inPlus = this._isPointInsideMesh2D(mx + nx * eps, my + ny * eps);
        const inMinus = this._isPointInsideMesh2D(mx - nx * eps, my - ny * eps);
        if (inPlus && inMinus) continue;
        ctx.moveTo(sx0, sy0);
        ctx.lineTo(sx1, sy1);
        drawn++;
      } else {
        let runStart = -1;
        for (let s = 0; s < steps; s++) {
          const tm = (s + 0.5) / steps;
          const mx = sx0 + dx * tm;
          const my = sy0 + dy * tm;
          const inPlus = this._isPointInsideMesh2D(mx + nx * eps, my + ny * eps);
          const inMinus = this._isPointInsideMesh2D(mx - nx * eps, my - ny * eps);
          const onBoundary = !(inPlus && inMinus);
          if (onBoundary) {
            if (runStart < 0) runStart = s;
          } else if (runStart >= 0) {
            const t0s = runStart / steps;
            const t1s = s / steps;
            ctx.moveTo(sx0 + dx * t0s, sy0 + dy * t0s);
            ctx.lineTo(sx0 + dx * t1s, sy0 + dy * t1s);
            drawn++;
            runStart = -1;
          }
        }
        if (runStart >= 0) {
          const t0s = runStart / steps;
          ctx.moveTo(sx0 + dx * t0s, sy0 + dy * t0s);
          ctx.lineTo(sx1, sy1);
          drawn++;
        }
      }
    }

    if (drawn > 0) {
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = lineWidth;
      ctx.stroke();
    }
  }

  /**
   * Dibuja en Canvas 2D la silueta exacta de las aristas exteriores de los objetos seleccionados
   * (mismo estilo nítido de trazado lineal que las luces de escena).
   */
  drawCanvas(ctx, camera, objects, W, H, {
    activeColor = '#f59e0b',
    secondaryColor = '#f15800',
    multiColor = '#facc15',
    multiSelect = false,
    lineWidth = null,
  } = {}) {
    const objList = Array.isArray(objects) ? objects : (objects ? [objects] : []);
    if (!ctx || !camera || !objList.length || !(W > 0) || !(H > 0)) return;

    if (camera.updateMatrixWorld && !camera.parent) camera.updateMatrixWorld();
    if (camera.updateViewMatrix) camera.updateViewMatrix();
    camera.updateWorldMatrix?.(true, false);
    this._vp.multiplyMatrices(camera.projectionMatrix, camera.viewMatrix);

    const strokeW = Number.isFinite(Number(lineWidth)) ? Number(lineWidth) : this.width;
    const isMulti = Boolean(multiSelect || objList.length > 1);
    const meshes = this._meshScratch;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.setLineDash([]);
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 0.96;

    for (let oi = 0; oi < objList.length; oi++) {
      const root = objList[oi];
      if (!root) continue;
      meshes.length = 0;
      this._collectMeshes(root, meshes);
      if (!meshes.length) continue;

      const col = isMulti
        ? multiColor
        : (oi === objList.length - 1 ? activeColor : secondaryColor);

      for (let mi = 0; mi < meshes.length; mi++) {
        const mesh = meshes[mi];
        const cache = getOrUpdateSilhouetteCache(mesh.geometry);
        if (!cache || !cache.edgeCount) continue;

        if (mesh.isSkinnedMesh && mesh.skeleton && mesh.skeleton.bones?.length && typeof mesh.computeSkinnedWorld === 'function') {
          mesh.skeleton.update();
          const vCount = mesh.geometry.attributes.position.count;
          if (!this._skinWorldScratch || this._skinWorldScratch.length < vCount * 3) {
            this._skinWorldScratch = new Float32Array(vCount * 3);
          }
          mesh.computeSkinnedWorld(this._skinWorldScratch, vCount);
          if (!cache.skinWeldPos) {
            cache.skinWeldPos = new Float32Array(cache.W * 3);
            cache.skinTriNormals = new Float32Array(cache.triCount * 3);
            cache.skinTriCenters = new Float32Array(cache.triCount * 3);
          }
          updateNormalsAndCenters(
            this._skinWorldScratch,
            cache.skinWeldPos,
            cache.skinTriNormals,
            cache.skinTriCenters,
            cache
          );
          this._drawMeshSilhouette(
            ctx,
            camera,
            _IDENTITY_MAT,
            cache,
            cache.skinWeldPos,
            cache.skinTriNormals,
            cache.skinTriCenters,
            W,
            H,
            col,
            strokeW
          );
          continue;
        }

        mesh.updateWorldMatrix(true, false);

        if (mesh.isInstancedMesh && mesh.instanceMatrix) {
          const arr = mesh.instanceMatrix.array;
          const total = Math.min(mesh.count || 0, (arr.length / 16) | 0, _MAX_INSTANCES_OUTLINE);
          for (let ii = 0; ii < total; ii++) {
            const o = ii * 16;
            this._instMat.elements.set(arr.subarray(o, o + 16));
            this._instMat.multiplyMatrices(mesh.matrixWorld, this._instMat);
            this._drawMeshSilhouette(
              ctx,
              camera,
              this._instMat,
              cache,
              cache.weldPos,
              cache.triNormals,
              cache.triCenters,
              W,
              H,
              col,
              strokeW
            );
          }
          continue;
        }

        this._drawMeshSilhouette(
          ctx,
          camera,
          mesh.matrixWorld,
          cache,
          cache.weldPos,
          cache.triNormals,
          cache.triCenters,
          W,
          H,
          col,
          strokeW
        );
      }
    }

    meshes.length = 0;
    ctx.restore();
  }

  _projectSphereNdc(cx, cy, cz, r, camera, bounds) {
    if (bounds.full) return;
    const ve = camera.viewMatrix.elements;
    const vx = ve[0] * cx + ve[4] * cy + ve[8] * cz + ve[12];
    const vy = ve[1] * cx + ve[5] * cy + ve[9] * cz + ve[13];
    const vz = ve[2] * cx + ve[6] * cy + ve[10] * cz + ve[14];
    const near = Math.max(1e-4, camera.near || 0.05);
    if (vz + r >= -near * 1.05) {
      bounds.full = true;
      return;
    }
    const pe = camera.projectionMatrix.elements;
    for (let xi = -1; xi <= 1; xi += 2) {
      const px = vx + xi * r;
      for (let yi = -1; yi <= 1; yi += 2) {
        const py = vy + yi * r;
        for (let zi = -1; zi <= 1; zi += 2) {
          const pz = vz + zi * r;
          const cw = pe[3] * px + pe[7] * py + pe[11] * pz + pe[15];
          if (cw <= 1e-4) {
            bounds.full = true;
            return;
          }
          const nx = (pe[0] * px + pe[4] * py + pe[8] * pz + pe[12]) / cw;
          const ny = (pe[1] * px + pe[5] * py + pe[9] * pz + pe[13]) / cw;
          if (nx < bounds.minX) bounds.minX = nx;
          if (nx > bounds.maxX) bounds.maxX = nx;
          if (ny < bounds.minY) bounds.minY = ny;
          if (ny > bounds.maxY) bounds.maxY = ny;
        }
      }
    }
  }

  _projectBoxNdc(bb, matrixWorld, bounds) {
    if (bounds.full) return;
    this._mvp.multiplyMatrices(this._vp, matrixWorld);
    const me = this._mvp.elements;
    const x0 = bb.min.x, x1 = bb.max.x;
    const y0 = bb.min.y, y1 = bb.max.y;
    const z0 = bb.min.z, z1 = bb.max.z;
    for (let i = 0; i < 8; i++) {
      const x = (i & 1) ? x1 : x0;
      const y = (i & 2) ? y1 : y0;
      const z = (i & 4) ? z1 : z0;
      const cw = me[3] * x + me[7] * y + me[11] * z + me[15];
      if (cw <= 1e-4) {
        bounds.full = true;
        return;
      }
      const nx = (me[0] * x + me[4] * y + me[8] * z + me[12]) / cw;
      const ny = (me[1] * x + me[5] * y + me[9] * z + me[13]) / cw;
      if (nx < bounds.minX) bounds.minX = nx;
      if (nx > bounds.maxX) bounds.maxX = nx;
      if (ny < bounds.minY) bounds.minY = ny;
      if (ny > bounds.maxY) bounds.maxY = ny;
    }
  }

  /**
   * Contorno opcional en GPU (WebGL2 o WebGPU) cuando `mode === 'gpu'`.
   */
  render(renderer, camera, objects, { activeColor = '#ffaa40', secondaryColor = '#f15800' } = {}) {
    const objList = Array.isArray(objects) ? objects : (objects ? [objects] : null);
    if (!renderer || renderer.isContextLost?.() || renderer.contextLost || !renderer.renderOutline || !camera || !objList || !objList.length) return;

    const W = renderer.domElement.width || 1;
    const H = renderer.domElement.height || 1;
    const scale = this._resolveScale(W, H);
    const mw = Math.max(1, Math.round(W * scale));
    const mh = Math.max(1, Math.round(H * scale));

    if (camera.updateMatrixWorld && !camera.parent) camera.updateMatrixWorld();
    if (camera.updateViewMatrix) camera.updateViewMatrix();
    this._vp.multiplyMatrices(camera.projectionMatrix, camera.viewMatrix);
    this._frustum.setFromMatrix(this._vp);

    const bounds = this._bounds;
    bounds.minX = Infinity; bounds.maxX = -Infinity;
    bounds.minY = Infinity; bounds.maxY = -Infinity;
    bounds.full = false;

    const meshes = this._meshScratch;
    const secMeshes = this._secMeshes;
    const actMeshes = this._actMeshes;
    secMeshes.length = 0;
    actMeshes.length = 0;

    for (let oi = 0; oi < objList.length; oi++) {
      meshes.length = 0;
      this._collectMeshes(objList[oi], meshes);
      if (!meshes.length) continue;
      const bucket = oi === objList.length - 1 ? actMeshes : secMeshes;

      for (let mi = 0; mi < meshes.length; mi++) {
        const mesh = meshes[mi];
        const instanced = !!mesh.isInstancedMesh;
        const skin = renderer._isGpuSkin(mesh);
        const morph = renderer._hasMorph(mesh);

        if (skin) {
          mesh.skeleton.updateOnce(renderer._frame);
          const sk = mesh.skeleton;
          const r = sk.radius + mesh.skinPad * sk.maxScale;
          if (!this._frustum.intersectsSphere(sk.center.x, sk.center.y, sk.center.z, r)) continue;
          this._projectSphereNdc(sk.center.x, sk.center.y, sk.center.z, r, camera, bounds);
        } else {
          if (mesh.isSkinnedMesh && mesh.autoUpdateSkin && mesh._cpuSkinFrame !== renderer._frame) {
            if (mesh.skeleton) mesh.skeleton.update();
            mesh.updateSkinnedVertices();
            mesh._cpuSkinFrame = renderer._frame;
          }
          const bs = mesh.boundingSphere || (instanced ? null : mesh.geometry.getBoundingSphere());
          if (bs) {
            const e = mesh.matrixWorld.elements, c = bs.center;
            const wx = e[0] * c.x + e[4] * c.y + e[8] * c.z + e[12];
            const wy = e[1] * c.x + e[5] * c.y + e[9] * c.z + e[13];
            const wz = e[2] * c.x + e[6] * c.y + e[10] * c.z + e[14];
            const morphPad = morph ? 1.5 : 1;
            const wr = bs.radius * mesh.matrixWorld.getMaxScale() * morphPad;
            if (!this._frustum.intersectsSphere(wx, wy, wz, wr)) continue;
            if (!morph && !instanced) {
              const bb = mesh.geometry.getBoundingBox();
              if (bb) this._projectBoxNdc(bb, mesh.matrixWorld, bounds);
              else this._projectSphereNdc(wx, wy, wz, wr, camera, bounds);
            } else {
              this._projectSphereNdc(wx, wy, wz, wr, camera, bounds);
            }
          } else {
            bounds.full = true;
          }
        }
        bucket.push(mesh);
      }
    }
    meshes.length = 0;

    if (!secMeshes.length && !actMeshes.length) return;

    const scaleX = mw / W;
    const scaleY = mh / H;
    const radiusScreen = Math.max(1.0, Math.min(8.0, this.width * (renderer.pixelRatio || 1)));
    const radiusMask = Math.max(1.0, Math.min(_MAX_RADIUS_PX, radiusScreen * Math.min(scaleX, scaleY)));
    const intRadius = Math.max(1, Math.min(_MAX_RADIUS_PX, Math.ceil(radiusMask)));
    const mPad = intRadius + 3;

    let msx0 = 0, msy0 = 0, msx1 = mw, msy1 = mh;
    if (!bounds.full) {
      if (bounds.maxX < -1 || bounds.minX > 1 || bounds.maxY < -1 || bounds.minY > 1) {
        secMeshes.length = 0;
        actMeshes.length = 0;
        return;
      }
      msx0 = Math.max(0, Math.floor((bounds.minX * 0.5 + 0.5) * mw) - mPad);
      msx1 = Math.min(mw, Math.ceil((bounds.maxX * 0.5 + 0.5) * mw) + mPad);
      msy0 = Math.max(0, Math.floor((bounds.minY * 0.5 + 0.5) * mh) - mPad);
      msy1 = Math.min(mh, Math.ceil((bounds.maxY * 0.5 + 0.5) * mh) + mPad);
    }
    const msw = msx1 - msx0;
    const msh = msy1 - msy0;
    if (msw <= 0 || msh <= 0) {
      secMeshes.length = 0;
      actMeshes.length = 0;
      return;
    }

    const sx0 = Math.max(0, Math.floor(msx0 / scaleX) - 2);
    const sy0 = Math.max(0, Math.floor(msy0 / scaleY) - 2);
    const sx1 = Math.min(W, Math.ceil(msx1 / scaleX) + 2);
    const sy1 = Math.min(H, Math.ceil(msy1 / scaleY) + 2);
    const sw = sx1 - sx0;
    const sh = sy1 - sy0;

    renderer.renderOutline({
      camera,
      secMeshes,
      actMeshes,
      activeColor: parseColor(activeColor, _actCol),
      secondaryColor: parseColor(secondaryColor, _secCol),
      W, H, mw, mh,
      scaleX, scaleY,
      radiusMask, intRadius,
      msx0, msy0, msx1, msy1, msw, msh,
      sx0, sy0, sw, sh,
    });

    secMeshes.length = 0;
    actMeshes.length = 0;
  }

  /**
   * Dibuja en Canvas 2D la silueta exacta de las aristas de borde del subárbol `o`.
   */
  drawTree(c, g, o, col) {
    if (!c || !g || !g.camera || !o || !o.visible) return;
    this.drawCanvas(c, g.camera, [o], g.W || 1, g.H || 1, {
      activeColor: col,
      secondaryColor: col,
      multiColor: col,
      multiSelect: false,
    });
  }

  draw(c, g, o, col) {
    if (!c || !g || !g.camera || !o || !o.visible) return;
    if (o.isMesh && o.geometry?.attributes?.position) {
      this.drawCanvas(c, g.camera, [o], g.W || 1, g.H || 1, {
        activeColor: col,
        secondaryColor: col,
        multiColor: col,
        multiSelect: false,
      });
      return;
    }
    o.updateWorldMatrix(true, false);
    let r = 0, hasSphere = false;
    if (o.getWorldSphere) {
      r = o.getWorldSphere(_ct);
      hasSphere = true;
    }
    if (!hasSphere) return;
    const p = g._proj(_ct);
    if (p.w <= 0.01) return;
    const worldH = g.camera.fov ? 2 * p.w * Math.tan(g.camera.fov * Math.PI / 360) : Math.abs((g.camera.top ?? 1) - (g.camera.bottom ?? -1));
    const rad = Math.max(0, Math.min(r / ((worldH || 1) / g.H), 2000));
    if (Number.isFinite(rad) && rad > 0) {
      c.strokeStyle = col;
      c.lineWidth = this.width;
      c.beginPath();
      c.arc(p.x, p.y, rad, 0, 7);
      c.stroke();
    }
  }
}
