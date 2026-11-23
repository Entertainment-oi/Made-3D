import { edgeKey } from './EditableMesh.js';

function quantKey(x, y, z, invEps) {
  return `${Math.round(x * invEps)},${Math.round(y * invEps)},${Math.round(z * invEps)}`;
}

// ============================================================================
// BVH ligero sobre arreglo de triángulos (para intersección y ray-parity O(log N))
// ============================================================================

function buildTriBVH(tris, verts) {
  const n = tris.length;
  if (!n) return null;

  const order = new Int32Array(n);
  const bMinX = new Float64Array(n);
  const bMinY = new Float64Array(n);
  const bMinZ = new Float64Array(n);
  const bMaxX = new Float64Array(n);
  const bMaxY = new Float64Array(n);
  const bMaxZ = new Float64Array(n);
  const cX = new Float64Array(n);
  const cY = new Float64Array(n);
  const cZ = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    order[i] = i;
    const t = tris[i];
    const p0 = verts[t.a];
    const p1 = verts[t.b];
    const p2 = verts[t.c];
    bMinX[i] = Math.min(p0.x, p1.x, p2.x);
    bMinY[i] = Math.min(p0.y, p1.y, p2.y);
    bMinZ[i] = Math.min(p0.z, p1.z, p2.z);
    bMaxX[i] = Math.max(p0.x, p1.x, p2.x);
    bMaxY[i] = Math.max(p0.y, p1.y, p2.y);
    bMaxZ[i] = Math.max(p0.z, p1.z, p2.z);
    cX[i] = (p0.x + p1.x + p2.x) / 3;
    cY[i] = (p0.y + p1.y + p2.y) / 3;
    cZ[i] = (p0.z + p1.z + p2.z) / 3;
  }

  const LEAF = 6;
  const build = (start, end) => {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let k = start; k < end; k++) {
      const i = order[k];
      if (bMinX[i] < minX) minX = bMinX[i];
      if (bMinY[i] < minY) minY = bMinY[i];
      if (bMinZ[i] < minZ) minZ = bMinZ[i];
      if (bMaxX[i] > maxX) maxX = bMaxX[i];
      if (bMaxY[i] > maxY) maxY = bMaxY[i];
      if (bMaxZ[i] > maxZ) maxZ = bMaxZ[i];
    }
    const count = end - start;
    if (count <= LEAF) {
      return { minX, minY, minZ, maxX, maxY, maxZ, start, end, left: null, right: null };
    }
    const dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ;
    const cArr = dx >= dy && dx >= dz ? cX : (dy >= dz ? cY : cZ);
    const slice = order.subarray(start, end);
    slice.sort((a, b) => cArr[a] - cArr[b]);
    const mid = (start + end) >> 1;
    if (mid <= start || mid >= end) {
      return { minX, minY, minZ, maxX, maxY, maxZ, start, end, left: null, right: null };
    }
    return {
      minX, minY, minZ, maxX, maxY, maxZ,
      start: -1, end: -1,
      left: build(start, mid),
      right: build(mid, end),
    };
  };

  return {
    root: build(0, n),
    order,
    bMinX, bMinY, bMinZ, bMaxX, bMaxY, bMaxZ,
  };
}

function queryBVHBox(bvh, minX, minY, minZ, maxX, maxY, maxZ, onTri) {
  if (!bvh || !bvh.root) return;
  const stack = [bvh.root];
  const { order, bMinX, bMinY, bMinZ, bMaxX, bMaxY, bMaxZ } = bvh;
  while (stack.length) {
    const node = stack.pop();
    if (
      node.maxX < minX || node.minX > maxX ||
      node.maxY < minY || node.minY > maxY ||
      node.maxZ < minZ || node.minZ > maxZ
    ) {
      continue;
    }
    if (node.left === null) {
      for (let k = node.start; k < node.end; k++) {
        const ti = order[k];
        if (
          bMaxX[ti] < minX || bMinX[ti] > maxX ||
          bMaxY[ti] < minY || bMinY[ti] > maxY ||
          bMaxZ[ti] < minZ || bMinZ[ti] > maxZ
        ) {
          continue;
        }
        onTri(ti);
      }
    } else {
      stack.push(node.left, node.right);
    }
  }
}

function pointTriDistSq(px, py, pz, a, b, c) {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const acx = c.x - a.x, acy = c.y - a.y, acz = c.z - a.z;
  const apx = px - a.x, apy = py - a.y, apz = pz - a.z;

  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz;

  const bpx = px - b.x, bpy = py - b.y, bpz = pz - b.z;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz;

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    const qx = a.x + v * abx - px;
    const qy = a.y + v * aby - py;
    const qz = a.z + v * abz - pz;
    return qx * qx + qy * qy + qz * qz;
  }

  const cpx = px - c.x, cpy = py - c.y, cpz = pz - c.z;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz;

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    const qx = a.x + w * acx - px;
    const qy = a.y + w * acy - py;
    const qz = a.z + w * acz - pz;
    return qx * qx + qy * qy + qz * qz;
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    const qx = b.x + w * (c.x - b.x) - px;
    const qy = b.y + w * (c.y - b.y) - py;
    const qz = b.z + w * (c.z - b.z) - pz;
    return qx * qx + qy * qy + qz * qz;
  }

  const denom = 1 / (va + vb + vc || 1e-18);
  const v = vb * denom;
  const w = vc * denom;
  const qx = a.x + abx * v + acx * w - px;
  const qy = a.y + aby * v + acy * w - py;
  const qz = a.z + abz * v + acz * w - pz;
  return qx * qx + qy * qy + qz * qz;
}

function minDistTriToBVH(px, py, pz, bvh, tris, verts, cutoffSq) {
  let best = cutoffSq;
  let bestTri = null;
  const boxDistSq = (node) => {
    const dx = px < node.minX ? node.minX - px : (px > node.maxX ? px - node.maxX : 0);
    const dy = py < node.minY ? node.minY - py : (py > node.maxY ? py - node.maxY : 0);
    const dz = pz < node.minZ ? node.minZ - pz : (pz > node.maxZ ? pz - node.maxZ : 0);
    return dx * dx + dy * dy + dz * dz;
  };
  const stack = [bvh.root];
  const { order } = bvh;
  while (stack.length) {
    const node = stack.pop();
    if (boxDistSq(node) >= best) continue;
    if (node.left === null) {
      for (let k = node.start; k < node.end; k++) {
        const t = tris[order[k]];
        const d2 = pointTriDistSq(px, py, pz, verts[t.a], verts[t.b], verts[t.c]);
        if (d2 < best) {
          best = d2;
          bestTri = t;
        }
      }
    } else {
      const dl = boxDistSq(node.left);
      const dr = boxDistSq(node.right);
      if (dl < dr) {
        if (dr < best) stack.push(node.right);
        if (dl < best) stack.push(node.left);
      } else {
        if (dl < best) stack.push(node.left);
        if (dr < best) stack.push(node.right);
      }
    }
  }
  return { distSq: best, tri: bestTri };
}

function rayAABBHit(ox, oy, oz, invDx, invDy, invDz, node) {
  const tx1 = (node.minX - ox) * invDx;
  const tx2 = (node.maxX - ox) * invDx;
  let tmin = tx1 < tx2 ? tx1 : tx2;
  let tmax = tx1 > tx2 ? tx1 : tx2;

  const ty1 = (node.minY - oy) * invDy;
  const ty2 = (node.maxY - oy) * invDy;
  tmin = Math.max(tmin, ty1 < ty2 ? ty1 : ty2);
  tmax = Math.min(tmax, ty1 > ty2 ? ty1 : ty2);

  const tz1 = (node.minZ - oz) * invDz;
  const tz2 = (node.maxZ - oz) * invDz;
  tmin = Math.max(tmin, tz1 < tz2 ? tz1 : tz2);
  tmax = Math.min(tmax, tz1 > tz2 ? tz1 : tz2);

  return tmax >= Math.max(0, tmin);
}

function rayCountBVH(ox, oy, oz, dx, dy, dz, bvh, tris, verts) {
  const invDx = 1 / (Math.abs(dx) > 1e-12 ? dx : 1e-12);
  const invDy = 1 / (Math.abs(dy) > 1e-12 ? dy : 1e-12);
  const invDz = 1 / (Math.abs(dz) > 1e-12 ? dz : 1e-12);
  let hits = 0;
  const stack = [bvh.root];
  const { order } = bvh;

  while (stack.length) {
    const node = stack.pop();
    if (!rayAABBHit(ox, oy, oz, invDx, invDy, invDz, node)) continue;
    if (node.left === null) {
      for (let k = node.start; k < node.end; k++) {
        const t = tris[order[k]];
        const a = verts[t.a], b = verts[t.b], c = verts[t.c];
        const e1x = b.x - a.x, e1y = b.y - a.y, e1z = b.z - a.z;
        const e2x = c.x - a.x, e2y = c.y - a.y, e2z = c.z - a.z;
        const px = dy * e2z - dz * e2y;
        const py = dz * e2x - dx * e2z;
        const pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-11) continue;
        const invDet = 1 / det;
        const tx = ox - a.x, ty = oy - a.y, tz = oz - a.z;
        const u = (tx * px + ty * py + tz * pz) * invDet;
        if (u < -1e-7 || u > 1 + 1e-7) continue;
        const qx = ty * e1z - tz * e1y;
        const qy = tz * e1x - tx * e1z;
        const qz = tx * e1y - ty * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * invDet;
        if (v < -1e-7 || u + v > 1 + 1e-7) continue;
        const dist = (e2x * qx + e2y * qy + e2z * qz) * invDet;
        if (dist > 1e-6) hits++;
      }
    } else {
      stack.push(node.left, node.right);
    }
  }
  return hits;
}

const _PARITY_DIRS = [
  [0.9412, 0.2147, 0.2608],
  [0.1973, 0.9481, 0.2491],
  [0.2419, 0.1843, 0.9527],
];

function classifyPointVsClosedShell(px, py, pz, shellInfo, surfTolSq, outSurfaceTri = null) {
  const { bvh, tris, verts, minX, minY, minZ, maxX, maxY, maxZ } = shellInfo;
  if (!bvh || !bvh.root) return 'outside';
  const pad = Math.sqrt(surfTolSq);
  if (
    px < minX - pad || px > maxX + pad ||
    py < minY - pad || py > maxY + pad ||
    pz < minZ - pad || pz > maxZ + pad
  ) {
    return 'outside';
  }
  const hitSurf = minDistTriToBVH(px, py, pz, bvh, tris, verts, surfTolSq);
  if (hitSurf.tri && hitSurf.distSq < surfTolSq) {
    if (outSurfaceTri) outSurfaceTri.tri = hitSurf.tri;
    return 'surface';
  }

  let odd = 0;
  for (let i = 0; i < 3; i++) {
    const dir = _PARITY_DIRS[i];
    if ((rayCountBVH(px, py, pz, dir[0], dir[1], dir[2], bvh, tris, verts) & 1) === 1) {
      odd++;
    }
  }
  return odd >= 2 ? 'inside' : 'outside';
}

// ============================================================================
// Geometría Planar 2D / Polígonos Convexos e Intersección Polígono-Polígono
// ============================================================================

function cross2(ax, ay, bx, by, cx, cy) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function computePolygonBasis3D(pts) {
  const n = pts.length;
  if (n < 3) return null;
  let nx = 0, ny = 0, nz = 0;
  let ox = 0, oy = 0, oz = 0;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    nx += (p.y - q.y) * (p.z + q.z);
    ny += (p.z - q.z) * (p.x + q.x);
    nz += (p.x - q.x) * (p.y + q.y);
    ox += p.x; oy += p.y; oz += p.z;
  }
  const nLen = Math.hypot(nx, ny, nz);
  if (nLen < 1e-11) return null;
  const invN = 1 / nLen;
  const normal = { x: nx * invN, y: ny * invN, z: nz * invN };
  const origin = { x: ox / n, y: oy / n, z: oz / n };

  // Eje U ortogonal a normal usando la dirección más larga desde el origen
  let bestUx = 0, bestUy = 0, bestUz = 0, bestSq = -1;
  for (let i = 0; i < n; i++) {
    const rx = pts[i].x - origin.x;
    const ry = pts[i].y - origin.y;
    const rz = pts[i].z - origin.z;
    const dot = rx * normal.x + ry * normal.y + rz * normal.z;
    const px = rx - dot * normal.x;
    const py = ry - dot * normal.y;
    const pz = rz - dot * normal.z;
    const sq = px * px + py * py + pz * pz;
    if (sq > bestSq) {
      bestSq = sq;
      bestUx = px; bestUy = py; bestUz = pz;
    }
  }
  const uLen = Math.sqrt(bestSq);
  if (uLen < 1e-11) return null;
  const uAxis = { x: bestUx / uLen, y: bestUy / uLen, z: bestUz / uLen };
  let vAxis = {
    x: normal.y * uAxis.z - normal.z * uAxis.y,
    y: normal.z * uAxis.x - normal.x * uAxis.z,
    z: normal.x * uAxis.y - normal.y * uAxis.x,
  };

  const pts2D = new Array(n);
  let maxPlaneDist = 0;
  for (let i = 0; i < n; i++) {
    const rx = pts[i].x - origin.x;
    const ry = pts[i].y - origin.y;
    const rz = pts[i].z - origin.z;
    const dPlane = Math.abs(rx * normal.x + ry * normal.y + rz * normal.z);
    if (dPlane > maxPlaneDist) maxPlaneDist = dPlane;
    pts2D[i] = {
      x: rx * uAxis.x + ry * uAxis.y + rz * uAxis.z,
      y: rx * vAxis.x + ry * vAxis.y + rz * vAxis.z,
    };
  }

  let signedArea = 0;
  for (let i = 0; i < n; i++) {
    const p = pts2D[i], q = pts2D[(i + 1) % n];
    signedArea += p.x * q.y - q.x * p.y;
  }
  if (signedArea < 0) {
    vAxis = { x: -vAxis.x, y: -vAxis.y, z: -vAxis.z };
    for (let i = 0; i < n; i++) pts2D[i].y = -pts2D[i].y;
    signedArea = -signedArea;
  }

  return { normal, origin, uAxis, vAxis, pts2D, maxPlaneDist, area2: signedArea };
}

function isConvexCCW2D(pts2D) {
  const n = pts2D.length;
  if (n < 3) return false;
  if (n === 3) return true;
  let maxSpan = 0;
  for (let i = 0; i < n; i++) {
    const a = pts2D[i], b = pts2D[(i + 1) % n];
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    if (l > maxSpan) maxSpan = l;
  }
  const tol = -Math.max(1e-10, maxSpan * maxSpan * 1e-6);
  for (let i = 0; i < n; i++) {
    const a = pts2D[i];
    const b = pts2D[(i + 1) % n];
    const c = pts2D[(i + 2) % n];
    if (cross2(a.x, a.y, b.x, b.y, c.x, c.y) < tol) return false;
  }
  return true;
}

function clipConvexPolyEdgesAgainstPlane(pts, dists) {
  const n = pts.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[i], p1 = pts[(i + 1) % n];
    const d0 = dists[i], d1 = dists[(i + 1) % n];
    if (Math.abs(d0) <= 1e-8) {
      out.push({ x: p0.x, y: p0.y, z: p0.z });
    }
    if ((d0 > 1e-8 && d1 < -1e-8) || (d0 < -1e-8 && d1 > 1e-8)) {
      const t = d0 / (d0 - d1);
      out.push({
        x: p0.x + (p1.x - p0.x) * t,
        y: p0.y + (p1.y - p0.y) * t,
        z: p0.z + (p1.z - p0.z) * t,
      });
    }
  }
  if (out.length < 2) return null;
  let bestD = -1, pA = out[0], pB = out[1];
  for (let i = 0; i < out.length; i++) {
    for (let j = i + 1; j < out.length; j++) {
      const dx = out[j].x - out[i].x, dy = out[j].y - out[i].y, dz = out[j].z - out[i].z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d > bestD) { bestD = d; pA = out[i]; pB = out[j]; }
    }
  }
  return bestD > 1e-14 ? [pA, pB] : null;
}

function clipSegmentToConvexPoly2D(ax, ay, bx, by, polyPts2D) {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dy = by - ay;
  const n = polyPts2D.length;
  for (let i = 0; i < n; i++) {
    const e0 = polyPts2D[i];
    const e1 = polyPts2D[(i + 1) % n];
    const ex = e1.x - e0.x;
    const ey = e1.y - e0.y;
    const edgeLen = Math.hypot(ex, ey);
    const enx = -ey;
    const eny = ex;
    const num = (ax - e0.x) * enx + (ay - e0.y) * eny;
    const den = dx * enx + dy * eny;
    const eps = Math.max(1e-9, edgeLen * 1e-7);
    if (Math.abs(den) < 1e-12) {
      if (num < -eps) return null;
    } else {
      const t = -num / den;
      if (den > 0) {
        if (t > t0) t0 = t;
      } else {
        if (t < t1) t1 = t;
      }
      if (t0 > t1 + 1e-7) return null;
    }
  }
  if (t1 - t0 <= 1e-6) return null;
  t0 = Math.max(0, Math.min(1, t0));
  t1 = Math.max(0, Math.min(1, t1));
  if (t1 - t0 <= 1e-6) return null;
  return [t0, t1];
}

function polyPolySegments(fA, fB, verts, planeTol) {
  const nA = fA.normal, nB = fB.normal;
  const oA = fA.origin, oB = fB.origin;
  const dotN = nA.x * nB.x + nA.y * nB.y + nA.z * nB.z;

  const da = new Float64Array(fA.indices.length);
  let minDa = Infinity, maxDa = -Infinity, maxAbsDa = 0;
  for (let i = 0; i < fA.indices.length; i++) {
    const p = verts[fA.indices[i]];
    const d = (p.x - oB.x) * nB.x + (p.y - oB.y) * nB.y + (p.z - oB.z) * nB.z;
    da[i] = d;
    if (d < minDa) minDa = d;
    if (d > maxDa) maxDa = d;
    const ad = Math.abs(d);
    if (ad > maxAbsDa) maxAbsDa = ad;
  }

  const db = new Float64Array(fB.indices.length);
  let minDb = Infinity, maxDb = -Infinity, maxAbsDb = 0;
  for (let i = 0; i < fB.indices.length; i++) {
    const p = verts[fB.indices[i]];
    const d = (p.x - oA.x) * nA.x + (p.y - oA.y) * nA.y + (p.z - oA.z) * nA.z;
    db[i] = d;
    if (d < minDb) minDb = d;
    if (d > maxDb) maxDb = d;
    const ad = Math.abs(d);
    if (ad > maxAbsDb) maxAbsDb = ad;
  }

  if (Math.abs(dotN) > 0.992 && maxAbsDa <= planeTol && maxAbsDb <= planeTol) {
    return { coplanar: true };
  }

  const crossX = nA.y * nB.z - nA.z * nB.y;
  const crossY = nA.z * nB.x - nA.x * nB.z;
  const crossZ = nA.x * nB.y - nA.y * nB.x;
  const crossLenSq = crossX * crossX + crossY * crossY + crossZ * crossZ;
  if (crossLenSq < 1e-10) return null;

  const eps = 1e-6;
  if (maxDa < -eps || minDa > eps) return null;
  if (maxDb < -eps || minDb > eps) return null;

  const strictA = minDa < -eps && maxDa > eps;
  const strictB = minDb < -eps && maxDb > eps;
  if (!strictA && !strictB) return null;

  const ptsA = fA.indices.map((vi) => verts[vi]);
  const ptsB = fB.indices.map((vi) => verts[vi]);
  const segA = clipConvexPolyEdgesAgainstPlane(ptsA, da);
  if (!segA) return null;
  const segB = clipConvexPolyEdgesAgainstPlane(ptsB, db);
  if (!segB) return null;

  const invL = 1 / Math.sqrt(crossLenSq);
  const dx = crossX * invL, dy = crossY * invL, dz = crossZ * invL;
  const proj = (p) => p.x * dx + p.y * dy + p.z * dz;

  let aT0 = proj(segA[0]), aT1 = proj(segA[1]);
  let aP0 = segA[0], aP1 = segA[1];
  if (aT0 > aT1) { [aT0, aT1] = [aT1, aT0]; [aP0, aP1] = [aP1, aP0]; }

  let bT0 = proj(segB[0]), bT1 = proj(segB[1]);
  let bP0 = segB[0], bP1 = segB[1];
  if (bT0 > bT1) { [bT0, bT1] = [bT1, bT0]; [bP0, bP1] = [bP1, bP0]; }

  const lo = Math.max(aT0, bT0);
  const hi = Math.min(aT1, bT1);
  if (hi - lo <= 1e-6) return null;

  const lerp = (p, q, t) => ({
    x: p.x + (q.x - p.x) * t,
    y: p.y + (q.y - p.y) * t,
    z: p.z + (q.z - p.z) * t,
  });

  const P = lo === aT0 ? aP0 : (aT1 > aT0 ? lerp(aP0, aP1, (lo - aT0) / (aT1 - aT0)) : bP0);
  const Q = hi === aT1 ? aP1 : (aT1 > aT0 ? lerp(aP0, aP1, (hi - aT0) / (aT1 - aT0)) : bP1);
  if (Math.hypot(Q.x - P.x, Q.y - P.y, Q.z - P.z) <= 1e-6) return null;

  return { coplanar: false, segment: [P, Q] };
}

function triTriSegments(a0, a1, a2, nA, b0, b1, b2, nB, planeTol) {
  const dotN = nA.x * nB.x + nA.y * nB.y + nA.z * nB.z;
  const da0 = (a0.x - b0.x) * nB.x + (a0.y - b0.y) * nB.y + (a0.z - b0.z) * nB.z;
  const da1 = (a1.x - b0.x) * nB.x + (a1.y - b0.y) * nB.y + (a1.z - b0.z) * nB.z;
  const da2 = (a2.x - b0.x) * nB.x + (a2.y - b0.y) * nB.y + (a2.z - b0.z) * nB.z;

  const db0 = (b0.x - a0.x) * nA.x + (b0.y - a0.y) * nA.y + (b0.z - a0.z) * nA.z;
  const db1 = (b1.x - a0.x) * nA.x + (b1.y - a0.y) * nA.y + (b1.z - a0.z) * nA.z;
  const db2 = (b2.x - a0.x) * nA.x + (b2.y - a0.y) * nA.y + (b2.z - a0.z) * nA.z;

  if (
    Math.abs(dotN) > 0.992 &&
    Math.max(Math.abs(db0), Math.abs(db1), Math.abs(db2)) <= planeTol &&
    Math.max(Math.abs(da0), Math.abs(da1), Math.abs(da2)) <= planeTol
  ) {
    return { coplanar: true };
  }

  const crossX = nA.y * nB.z - nA.z * nB.y;
  const crossY = nA.z * nB.x - nA.x * nB.z;
  const crossZ = nA.x * nB.y - nA.y * nB.x;
  const crossLenSq = crossX * crossX + crossY * crossY + crossZ * crossZ;
  if (crossLenSq < 1e-10) return null;

  const eps = 1e-6;
  const minDa = Math.min(da0, da1, da2);
  const maxDa = Math.max(da0, da1, da2);
  const minDb = Math.min(db0, db1, db2);
  const maxDb = Math.max(db0, db1, db2);

  if (maxDa < -eps || minDa > eps) return null;
  if (maxDb < -eps || minDb > eps) return null;

  const strictA = minDa < -eps && maxDa > eps;
  const strictB = minDb < -eps && maxDb > eps;
  if (!strictA && !strictB) return null;

  const segA = clipConvexPolyEdgesAgainstPlane([a0, a1, a2], [da0, da1, da2]);
  if (!segA) return null;
  const segB = clipConvexPolyEdgesAgainstPlane([b0, b1, b2], [db0, db1, db2]);
  if (!segB) return null;

  const invL = 1 / Math.sqrt(crossLenSq);
  const dx = crossX * invL, dy = crossY * invL, dz = crossZ * invL;
  const proj = (p) => p.x * dx + p.y * dy + p.z * dz;

  let aT0 = proj(segA[0]), aT1 = proj(segA[1]);
  let aP0 = segA[0], aP1 = segA[1];
  if (aT0 > aT1) { [aT0, aT1] = [aT1, aT0]; [aP0, aP1] = [aP1, aP0]; }

  let bT0 = proj(segB[0]), bT1 = proj(segB[1]);
  let bP0 = segB[0], bP1 = segB[1];
  if (bT0 > bT1) { [bT0, bT1] = [bT1, bT0]; [bP0, bP1] = [bP1, bP0]; }

  const lo = Math.max(aT0, bT0);
  const hi = Math.min(aT1, bT1);
  if (hi - lo <= 1e-6) return null;

  const lerp = (p, q, t) => ({
    x: p.x + (q.x - p.x) * t,
    y: p.y + (q.y - p.y) * t,
    z: p.z + (q.z - p.z) * t,
  });

  const P = lo === aT0 ? aP0 : (aT1 > aT0 ? lerp(aP0, aP1, (lo - aT0) / (aT1 - aT0)) : bP0);
  const Q = hi === aT1 ? aP1 : (aT1 > aT0 ? lerp(aP0, aP1, (hi - aT0) / (aT1 - aT0)) : bP1);
  if (Math.hypot(Q.x - P.x, Q.y - P.y, Q.z - P.z) <= 1e-6) return null;

  return { coplanar: false, segment: [P, Q] };
}

function collectCoplanarFaceOverlapSegs(fA, fB, verts) {
  // Recorta únicamente las aristas reales del polígono B contra A y viceversa (sin diagonales internas)
  const { origin, uAxis, vAxis, pts2D: a2D } = fA;
  const toA2D = (p) => {
    const rx = p.x - origin.x, ry = p.y - origin.y, rz = p.z - origin.z;
    return { x: rx * uAxis.x + ry * uAxis.y + rz * uAxis.z, y: rx * vAxis.x + ry * vAxis.y + rz * vAxis.z };
  };

  const bPts = fB.indices.map((vi) => verts[vi]);
  const b2D = bPts.map(toA2D);
  let bArea = 0;
  for (let i = 0; i < b2D.length; i++) {
    const p = b2D[i], q = b2D[(i + 1) % b2D.length];
    bArea += p.x * q.y - q.x * p.y;
  }
  const b2DCCW = bArea >= 0 ? b2D : b2D.slice().reverse();

  const segsForA = [];
  for (let i = 0; i < bPts.length; i++) {
    const p0 = bPts[i], p1 = bPts[(i + 1) % bPts.length];
    const q0 = b2D[i], q1 = b2D[(i + 1) % bPts.length];
    const span = clipSegmentToConvexPoly2D(q0.x, q0.y, q1.x, q1.y, a2D);
    if (span) {
      const [t0, t1] = span;
      segsForA.push([
        { x: p0.x + (p1.x - p0.x) * t0, y: p0.y + (p1.y - p0.y) * t0, z: p0.z + (p1.z - p0.z) * t0 },
        { x: p0.x + (p1.x - p0.x) * t1, y: p0.y + (p1.y - p0.y) * t1, z: p0.z + (p1.z - p0.z) * t1 },
      ]);
    }
  }

  const segsForB = [];
  const aPts = fA.indices.map((vi) => verts[vi]);
  for (let i = 0; i < aPts.length; i++) {
    const p0 = aPts[i], p1 = aPts[(i + 1) % aPts.length];
    const q0 = a2D[i], q1 = a2D[(i + 1) % aPts.length];
    const span = clipSegmentToConvexPoly2D(q0.x, q0.y, q1.x, q1.y, b2DCCW);
    if (span) {
      const [t0, t1] = span;
      segsForB.push([
        { x: p0.x + (p1.x - p0.x) * t0, y: p0.y + (p1.y - p0.y) * t0, z: p0.z + (p1.z - p0.z) * t0 },
        { x: p0.x + (p1.x - p0.x) * t1, y: p0.y + (p1.y - p0.y) * t1, z: p0.z + (p1.z - p0.z) * t1 },
      ]);
    }
  }

  return { segsForA, segsForB };
}

function collectCoplanarTriBoundarySegs(tA, tB, verts, clipBEdgesOnly = true) {
  const a0 = verts[tA.a], a1 = verts[tA.b], a2 = verts[tA.c];
  const nA = tA.normal;
  const e1x = a1.x - a0.x, e1y = a1.y - a0.y, e1z = a1.z - a0.z;
  const uLen = Math.hypot(e1x, e1y, e1z);
  if (uLen < 1e-10) return null;
  const ux = e1x / uLen, uy = e1y / uLen, uz = e1z / uLen;
  const vx = nA.y * uz - nA.z * uy;
  const vy = nA.z * ux - nA.x * uz;
  const vz = nA.x * uy - nA.y * ux;

  const to2D = (p) => {
    const rx = p.x - a0.x, ry = p.y - a0.y, rz = p.z - a0.z;
    return { x: rx * ux + ry * uy + rz * uz, y: rx * vx + ry * vy + rz * vz };
  };

  const aPts = [a0, a1, a2];
  const a2D = [{ x: 0, y: 0 }, to2D(a1), to2D(a2)];

  const bPts = [verts[tB.a], verts[tB.b], verts[tB.c]];
  const b2D = bPts.map(to2D);
  const bArea = cross2(b2D[0].x, b2D[0].y, b2D[1].x, b2D[1].y, b2D[2].x, b2D[2].y);
  const b2DCCW = bArea >= 0 ? b2D : [b2D[0], b2D[2], b2D[1]];

  const segsForA = [];
  for (let i = 0; i < 3; i++) {
    if (clipBEdgesOnly && tB.edgeIsBoundary && !tB.edgeIsBoundary[i]) continue;
    const p0 = bPts[i], p1 = bPts[(i + 1) % 3];
    const q0 = b2D[i], q1 = b2D[(i + 1) % 3];
    const span = clipSegmentToConvexPoly2D(q0.x, q0.y, q1.x, q1.y, a2D);
    if (span) {
      const [t0, t1] = span;
      segsForA.push([
        { x: p0.x + (p1.x - p0.x) * t0, y: p0.y + (p1.y - p0.y) * t0, z: p0.z + (p1.z - p0.z) * t0 },
        { x: p0.x + (p1.x - p0.x) * t1, y: p0.y + (p1.y - p0.y) * t1, z: p0.z + (p1.z - p0.z) * t1 },
      ]);
    }
  }

  const segsForB = [];
  for (let i = 0; i < 3; i++) {
    if (clipBEdgesOnly && tA.edgeIsBoundary && !tA.edgeIsBoundary[i]) continue;
    const p0 = aPts[i], p1 = aPts[(i + 1) % 3];
    const q0 = a2D[i], q1 = a2D[(i + 1) % 3];
    const span = clipSegmentToConvexPoly2D(q0.x, q0.y, q1.x, q1.y, b2DCCW);
    if (span) {
      const [t0, t1] = span;
      segsForB.push([
        { x: p0.x + (p1.x - p0.x) * t0, y: p0.y + (p1.y - p0.y) * t0, z: p0.z + (p1.z - p0.z) * t0 },
        { x: p0.x + (p1.x - p0.x) * t1, y: p0.y + (p1.y - p0.y) * t1, z: p0.z + (p1.z - p0.z) * t1 },
      ]);
    }
  }

  return { segsForA, segsForB };
}

// ============================================================================
// Subdivisión Planar 2D de un Polígono Convexo con Segmentos de Corte (PSLG)
// ============================================================================

function earClipSimplePoly(poly, pts2D) {
  if (poly.length < 3) return [];
  if (poly.length === 3) return [[poly[0], poly[1], poly[2]]];
  let signedArea = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = pts2D[poly[i]], q = pts2D[poly[(i + 1) % poly.length]];
    signedArea += p.x * q.y - q.x * p.y;
  }
  const ring = signedArea >= 0 ? poly.slice() : poly.slice().reverse();
  const out = [];
  let guard = ring.length * ring.length + 16;

  while (ring.length > 3 && guard-- > 0) {
    let clipped = false;
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const prev = ring[(i - 1 + n) % n];
      const curr = ring[i];
      const next = ring[(i + 1) % n];
      const a = pts2D[prev], b = pts2D[curr], c = pts2D[next];
      const area = cross2(a.x, a.y, b.x, b.y, c.x, c.y);
      if (area <= 1e-12) continue;

      let containsOther = false;
      for (let j = 0; j < n; j++) {
        const idx = ring[j];
        if (idx === prev || idx === curr || idx === next) continue;
        const p = pts2D[idx];
        if (
          cross2(a.x, a.y, b.x, b.y, p.x, p.y) > -1e-11 &&
          cross2(b.x, b.y, c.x, c.y, p.x, p.y) > -1e-11 &&
          cross2(c.x, c.y, a.x, a.y, p.x, p.y) > -1e-11
        ) {
          containsOther = true;
          break;
        }
      }
      if (!containsOther) {
        out.push([prev, curr, next]);
        ring.splice(i, 1);
        clipped = true;
        break;
      }
    }
    if (!clipped) {
      for (let i = 1; i + 1 < ring.length; i++) {
        out.push([ring[0], ring[i], ring[i + 1]]);
      }
      break;
    }
  }
  if (ring.length === 3) out.push([ring[0], ring[1], ring[2]]);
  return out;
}

function splitConvexPolygonWithSegments(
  polyPts3D,
  polyUvs,
  polyPts2D,
  origin,
  uAxis,
  vAxis,
  segments,
  snapTol,
  origVertIndices
) {
  const m = polyPts3D.length;
  if (m < 3 || !segments.length) return null;

  const to2D = (p) => {
    const rx = p.x - origin.x, ry = p.y - origin.y, rz = p.z - origin.z;
    return {
      x: rx * uAxis.x + ry * uAxis.y + rz * uAxis.z,
      y: rx * vAxis.x + ry * vAxis.y + rz * vAxis.z,
    };
  };

  let scale = 0;
  for (let i = 0; i < m; i++) {
    const a = polyPts2D[i], b = polyPts2D[(i + 1) % m];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    if (d > scale) scale = d;
  }
  if (scale < 1e-8) return null;

  const snap = Math.max(1e-6, Math.min(snapTol, scale * 1e-3));
  const snapSq = snap * snap;

  // Recortar todos los segmentos al contorno convexo [0..m-1]
  const rawSegs = [];
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const q0 = to2D(s[0]);
    const q1 = to2D(s[1]);
    const span = clipSegmentToConvexPoly2D(q0.x, q0.y, q1.x, q1.y, polyPts2D);
    if (!span) continue;
    const [t0, t1] = span;
    const ax = q0.x + (q1.x - q0.x) * t0, ay = q0.y + (q1.y - q0.y) * t0;
    const bx = q0.x + (q1.x - q0.x) * t1, by = q0.y + (q1.y - q0.y) * t1;
    if ((bx - ax) ** 2 + (by - ay) ** 2 <= snapSq * 0.25) continue;
    rawSegs.push([{ x: ax, y: ay }, { x: bx, y: by }]);
  }
  if (!rawSegs.length) return null;

  const pts2D = polyPts2D.map((p) => ({ x: p.x, y: p.y }));
  const polyEdges = [];
  for (let i = 0; i < m; i++) polyEdges.push([i, (i + 1) % m]);

  const addPoint = (x, y) => {
    for (let i = 0; i < pts2D.length; i++) {
      const dx = x - pts2D[i].x, dy = y - pts2D[i].y;
      if (dx * dx + dy * dy <= snapSq) return i;
    }

    let sx = x, sy = y;
    for (let e = 0; e < m; e++) {
      const va = pts2D[polyEdges[e][0]], vb = pts2D[polyEdges[e][1]];
      const ex = vb.x - va.x, ey = vb.y - va.y;
      const lSq = ex * ex + ey * ey;
      if (lSq < 1e-14) continue;
      const t = ((sx - va.x) * ex + (sy - va.y) * ey) / lSq;
      if (t >= 0 && t <= 1) {
        const px = va.x + ex * t, py = va.y + ey * t;
        if ((sx - px) ** 2 + (sy - py) ** 2 <= snapSq) {
          sx = px; sy = py;
          break;
        }
      }
    }

    // Clamp suave hacia adentro del polígono convexo [0..m-1] si el punto se salió levemente
    for (let pass = 0; pass < 2; pass++) {
      for (let e = 0; e < m; e++) {
        const va = polyPts2D[e], vb = polyPts2D[(e + 1) % m];
        const ex = vb.x - va.x, ey = vb.y - va.y;
        const lSq = ex * ex + ey * ey;
        if (lSq < 1e-14) continue;
        const c = ex * (sy - va.y) - ey * (sx - va.x);
        if (c < -1e-6 * lSq) {
          const t = Math.max(0, Math.min(1, ((sx - va.x) * ex + (sy - va.y) * ey) / lSq));
          sx = va.x + ex * t;
          sy = va.y + ey * t;
        }
      }
    }

    for (let i = 0; i < pts2D.length; i++) {
      const dx = sx - pts2D[i].x, dy = sy - pts2D[i].y;
      if (dx * dx + dy * dy <= snapSq) return i;
    }
    pts2D.push({ x: sx, y: sy });
    return pts2D.length - 1;
  };

  let segPairs = [];
  for (let i = 0; i < rawSegs.length; i++) {
    const ia = addPoint(rawSegs[i][0].x, rawSegs[i][0].y);
    const ib = addPoint(rawSegs[i][1].x, rawSegs[i][1].y);
    if (ia !== ib) segPairs.push([ia, ib]);
  }
  if (!segPairs.length && pts2D.length === m) return null;

  // Dividir segmentos en cruces mutuos y puntos intermedios colineales
  let changedSegs = true;
  let iterGuard = 0;
  while (changedSegs && iterGuard++ < 8) {
    changedSegs = false;
    for (let i = 0; i < segPairs.length; i++) {
      for (let j = i + 1; j < segPairs.length; j++) {
        const [a0, a1] = segPairs[i];
        const [b0, b1] = segPairs[j];
        if (a0 === b0 || a0 === b1 || a1 === b0 || a1 === b1) continue;
        const pa = pts2D[a0], pb = pts2D[a1], pc = pts2D[b0], pd = pts2D[b1];
        const rdx = pb.x - pa.x, rdy = pb.y - pa.y;
        const sdx = pd.x - pc.x, sdy = pd.y - pc.y;
        const den = rdx * sdy - rdy * sdx;
        if (Math.abs(den) < 1e-12) continue;
        const qpx = pc.x - pa.x, qpy = pc.y - pa.y;
        const t = (qpx * sdy - qpy * sdx) / den;
        const u = (qpx * rdy - qpy * rdx) / den;
        if (t > 1e-4 && t < 1 - 1e-4 && u > 1e-4 && u < 1 - 1e-4) {
          addPoint(pa.x + rdx * t, pa.y + rdy * t);
          changedSegs = true;
        }
      }
    }

    const nextPairs = [];
    const seenEdge = new Set();
    for (let i = 0; i < segPairs.length; i++) {
      const [sa, sb] = segPairs[i];
      if (sa === sb) continue;
      const pa = pts2D[sa], pb = pts2D[sb];
      const ex = pb.x - pa.x, ey = pb.y - pa.y;
      const lSq = ex * ex + ey * ey;
      if (lSq < snapSq * 0.25) continue;

      const cuts = [{ vi: sa, t: 0 }, { vi: sb, t: 1 }];
      for (let vi = 0; vi < pts2D.length; vi++) {
        if (vi === sa || vi === sb) continue;
        const p = pts2D[vi];
        const t = ((p.x - pa.x) * ex + (p.y - pa.y) * ey) / lSq;
        if (t <= 1e-4 || t >= 1 - 1e-4) continue;
        const qx = pa.x + ex * t, qy = pa.y + ey * t;
        if ((p.x - qx) ** 2 + (p.y - qy) ** 2 <= snapSq) {
          cuts.push({ vi, t });
          changedSegs = true;
        }
      }
      cuts.sort((u, v) => u.t - v.t);
      for (let k = 0; k + 1 < cuts.length; k++) {
        const u = cuts[k].vi, v = cuts[k + 1].vi;
        if (u === v) continue;
        const ek = u < v ? `${u}_${v}` : `${v}_${u}`;
        if (!seenEdge.has(ek)) {
          seenEdge.add(ek);
          nextPairs.push([u, v]);
        }
      }
    }
    segPairs = nextPairs;
  }

  // Triangulación base del polígono [0..m-1] sin puntos interiores extra
  const baseRing = Array.from({ length: m }, (_, i) => i);
  const initTris = m === 3 ? [[0, 1, 2]] : earClipSimplePoly(baseRing, pts2D);
  let tris = initTris.map((t) => [t[0], t[1], t[2]]);

  const bary = (px, py, ia, ib, ic) => {
    const va = pts2D[ia], vb = pts2D[ib], vc = pts2D[ic];
    const area = cross2(va.x, va.y, vb.x, vb.y, vc.x, vc.y);
    if (Math.abs(area) < 1e-13) return null;
    const inv = 1 / area;
    const w0 = cross2(vb.x, vb.y, vc.x, vc.y, px, py) * inv;
    const w1 = cross2(vc.x, vc.y, va.x, va.y, px, py) * inv;
    const w2 = 1 - w0 - w1;
    return [w0, w1, w2];
  };

  // Paso 1: Insertar puntos nuevos vi >= m en la triangulación
  for (let vi = m; vi < pts2D.length; vi++) {
    const p = pts2D[vi];
    let hitEdge = null;
    let bestEdgeDist = snap;
    for (let ti = 0; ti < tris.length; ti++) {
      const t = tris[ti];
      for (let e = 0; e < 3; e++) {
        const u = t[e], v = t[(e + 1) % 3];
        if (u === vi || v === vi) continue;
        const pu = pts2D[u], pv = pts2D[v];
        const ex = pv.x - pu.x, ey = pv.y - pu.y;
        const lSq = ex * ex + ey * ey;
        if (lSq < 1e-14) continue;
        const frac = ((p.x - pu.x) * ex + (p.y - pu.y) * ey) / lSq;
        if (frac > 1e-4 && frac < 1 - 1e-4) {
          const d = Math.hypot(p.x - (pu.x + ex * frac), p.y - (pu.y + ey * frac));
          if (d < bestEdgeDist) {
            bestEdgeDist = d;
            hitEdge = u < v ? `${u}_${v}` : `${v}_${u}`;
          }
        }
      }
    }

    if (hitEdge) {
      const [su, sv] = hitEdge.split('_').map(Number);
      const nextTris = [];
      for (let ti = 0; ti < tris.length; ti++) {
        const t = tris[ti];
        const iu = t.indexOf(su), iv = t.indexOf(sv);
        if (iu >= 0 && iv >= 0) {
          const iOpp = 3 - iu - iv;
          const a = t[iOpp], b = t[(iOpp + 1) % 3], cTri = t[(iOpp + 2) % 3];
          nextTris.push([a, b, vi], [a, vi, cTri]);
        } else {
          nextTris.push(t);
        }
      }
      tris = nextTris;
      continue;
    }

    let bestTi = -1;
    let bestMinW = -1e-3;
    for (let ti = 0; ti < tris.length; ti++) {
      const t = tris[ti];
      if (t[0] === vi || t[1] === vi || t[2] === vi) {
        bestTi = -2;
        break;
      }
      const bw = bary(p.x, p.y, t[0], t[1], t[2]);
      if (bw) {
        const minW = Math.min(bw[0], bw[1], bw[2]);
        if (minW > bestMinW) {
          bestMinW = minW;
          bestTi = ti;
        }
      }
    }
    if (bestTi >= 0) {
      const t = tris[bestTi];
      tris.splice(bestTi, 1, [t[0], t[1], vi], [t[1], t[2], vi], [t[2], t[0], vi]);
    }
  }

  // Paso 2: Forzar segmentos mediante retriangulación de cavidades cruzadas
  const hasEdgeInTris = (u, v) => {
    for (let ti = 0; ti < tris.length; ti++) {
      const t = tris[ti];
      if ((t[0] === u || t[1] === u || t[2] === u) && (t[0] === v || t[1] === v || t[2] === v)) {
        return true;
      }
    }
    return false;
  };

  for (let si = 0; si < segPairs.length; si++) {
    const [sp, sq] = segPairs[si];
    if (sp === sq || hasEdgeInTris(sp, sq)) continue;

    const pS = pts2D[sp], pQ = pts2D[sq];
    const crossedIdx = new Set();
    for (let ti = 0; ti < tris.length; ti++) {
      const t = tris[ti];
      for (let e = 0; e < 3; e++) {
        const ea = t[e], eb = t[(e + 1) % 3];
        if (ea === sp || ea === sq || eb === sp || eb === sq) continue;
        const pA = pts2D[ea], pB = pts2D[eb];
        const rdx = pQ.x - pS.x, rdy = pQ.y - pS.y;
        const sdx = pB.x - pA.x, sdy = pB.y - pA.y;
        const den = rdx * sdy - rdy * sdx;
        if (Math.abs(den) < 1e-12) continue;
        const qpx = pA.x - pS.x, qpy = pA.y - pS.y;
        const tt = (qpx * sdy - qpy * sdx) / den;
        const uu = (qpx * rdy - qpy * rdx) / den;
        if (tt > 1e-6 && tt < 1 - 1e-6 && uu > 1e-6 && uu < 1 - 1e-6) {
          crossedIdx.add(ti);
          break;
        }
      }
    }

    if (!crossedIdx.size) continue;

    const dirSet = new Set();
    const boundaryEdges = [];
    const nextTris = [];
    for (let ti = 0; ti < tris.length; ti++) {
      if (!crossedIdx.has(ti)) {
        nextTris.push(tris[ti]);
        continue;
      }
      const t = tris[ti];
      for (let e = 0; e < 3; e++) {
        dirSet.add(`${t[e]}>${t[(e + 1) % 3]}`);
      }
    }
    for (const ti of crossedIdx) {
      const t = tris[ti];
      for (let e = 0; e < 3; e++) {
        const u = t[e], v = t[(e + 1) % 3];
        if (!dirSet.has(`${v}>${u}`)) {
          boundaryEdges.push([u, v]);
        }
      }
    }

    const nextVert = new Map();
    for (const [u, v] of boundaryEdges) nextVert.set(u, v);
    const loop = [];
    if (nextVert.has(sp)) {
      let cur = sp;
      const seen = new Set();
      while (cur !== undefined && !seen.has(cur) && loop.length <= boundaryEdges.length + 2) {
        seen.add(cur);
        loop.push(cur);
        cur = nextVert.get(cur);
      }
    }
    const idxQ = loop.indexOf(sq);
    if (loop.length >= 4 && idxQ > 0 && idxQ < loop.length) {
      const upper = loop.slice(0, idxQ + 1);
      const lower = [sq, ...loop.slice(idxQ + 1), sp];
      const tUpper = earClipSimplePoly(upper, pts2D);
      const tLower = earClipSimplePoly(lower, pts2D);
      if (tUpper.length && tLower.length) {
        tris = nextTris.concat(tUpper, tLower);
      }
    }
  }

  // Normalizar devanado CCW 2D de todos los triángulos
  for (let i = 0; i < tris.length; i++) {
    const t = tris[i];
    const area2 = cross2(pts2D[t[0]].x, pts2D[t[0]].y, pts2D[t[1]].x, pts2D[t[1]].y, pts2D[t[2]].x, pts2D[t[2]].y);
    if (area2 < 0) {
      const tmp = t[1]; t[1] = t[2]; t[2] = tmp;
    }
  }

  // Paso 3: Legalización Constrained Delaunay (Lawson Edge-Flipping)
  // Elimina triángulos aguja (0.1°) maximizando el ángulo mínimo sin cruzar segmentos de corte
  if (tris.length >= 2) {
    const constrained = new Set();
    for (let i = 0; i < m; i++) {
      const u = i, v = (i + 1) % m;
      constrained.add(u < v ? `${u}_${v}` : `${v}_${u}`);
    }
    for (let i = 0; i < segPairs.length; i++) {
      const u = segPairs[i][0], v = segPairs[i][1];
      if (u !== v) constrained.add(u < v ? `${u}_${v}` : `${v}_${u}`);
    }
    // Proteger también aristas sobre los bordes originales partidos por puntos nuevos
    for (let e = 0; e < m; e++) {
      const va = pts2D[e], vb = pts2D[(e + 1) % m];
      const ex = vb.x - va.x, ey = vb.y - va.y;
      const lSq = ex * ex + ey * ey;
      if (lSq < 1e-14) continue;
      const onEdge = [{ vi: e, t: 0 }, { vi: (e + 1) % m, t: 1 }];
      for (let vi = m; vi < pts2D.length; vi++) {
        const p = pts2D[vi];
        const t = ((p.x - va.x) * ex + (p.y - va.y) * ey) / lSq;
        if (t <= 1e-4 || t >= 1 - 1e-4) continue;
        const dx = p.x - (va.x + ex * t), dy = p.y - (va.y + ey * t);
        if (dx * dx + dy * dy <= snapSq * 1.1) onEdge.push({ vi, t });
      }
      if (onEdge.length > 2) {
        onEdge.sort((u, v) => u.t - v.t);
        for (let k = 0; k + 1 < onEdge.length; k++) {
          const u = onEdge[k].vi, v = onEdge[k + 1].vi;
          if (u !== v) constrained.add(u < v ? `${u}_${v}` : `${v}_${u}`);
        }
      }
    }

    const triMinSinSq = (ia, ib, ic) => {
      const pa = pts2D[ia], pb = pts2D[ib], pc = pts2D[ic];
      const area2 = cross2(pa.x, pa.y, pb.x, pb.y, pc.x, pc.y);
      if (area2 <= 1e-13) return 0;
      const l01 = (pb.x - pa.x) ** 2 + (pb.y - pa.y) ** 2;
      const l12 = (pc.x - pb.x) ** 2 + (pc.y - pb.y) ** 2;
      const l20 = (pa.x - pc.x) ** 2 + (pa.y - pc.y) ** 2;
      const maxProd = Math.max(l01 * l12, l12 * l20, l20 * l01);
      return maxProd > 1e-24 ? (area2 * area2) / maxProd : 0;
    };

    const maxPasses = Math.min(12, Math.max(4, tris.length));
    for (let pass = 0; pass < maxPasses; pass++) {
      let flippedHere = false;
      const edgeToTris = new Map();
      for (let ti = 0; ti < tris.length; ti++) {
        const t = tris[ti];
        for (let e = 0; e < 3; e++) {
          const u = t[e], v = t[(e + 1) % 3];
          if (u === v) continue;
          const ek = u < v ? `${u}_${v}` : `${v}_${u}`;
          let arr = edgeToTris.get(ek);
          if (!arr) { arr = []; edgeToTris.set(ek, arr); }
          arr.push(ti);
        }
      }

      const dirtyTri = new Uint8Array(tris.length);
      for (const [ek, list] of edgeToTris.entries()) {
        if (list.length !== 2 || constrained.has(ek)) continue;
        const ti0 = list[0], ti1 = list[1];
        if (dirtyTri[ti0] || dirtyTri[ti1]) continue;
        const t0 = tris[ti0], t1 = tris[ti1];
        const sep = ek.indexOf('_');
        const ea = Number(ek.slice(0, sep)), eb = Number(ek.slice(sep + 1));
        const ia0 = t0.indexOf(ea), ib0 = t0.indexOf(eb);
        if (ia0 < 0 || ib0 < 0) continue;
        const uFirst = ((ia0 + 1) % 3) === ib0;
        const a = uFirst ? ea : eb;
        const b = uFirst ? eb : ea;
        const c = t0[3 - ia0 - ib0];
        const ia1 = t1.indexOf(a), ib1 = t1.indexOf(b);
        if (ia1 < 0 || ib1 < 0) continue;
        const d = t1[3 - ia1 - ib1];
        if (c === d || a === c || b === c || a === d || b === d) continue;

        const pa = pts2D[a], pb = pts2D[b], pc = pts2D[c], pd = pts2D[d];
        // Verificar convexidad estricta del quad CCW [a, d, b, c]
        if (
          cross2(pa.x, pa.y, pd.x, pd.y, pb.x, pb.y) <= 1e-12 ||
          cross2(pb.x, pb.y, pc.x, pc.y, pa.x, pa.y) <= 1e-12 ||
          cross2(pc.x, pc.y, pa.x, pa.y, pd.x, pd.y) <= 1e-12 ||
          cross2(pd.x, pd.y, pb.x, pb.y, pc.x, pc.y) <= 1e-12
        ) continue;

        const qBefore = Math.min(triMinSinSq(a, b, c), triMinSinSq(b, a, d));
        const qAfter = Math.min(triMinSinSq(a, d, c), triMinSinSq(d, b, c));
        if (qAfter > qBefore * 1.01) {
          tris[ti0] = [a, d, c];
          tris[ti1] = [d, b, c];
          dirtyTri[ti0] = 1;
          dirtyTri[ti1] = 1;
          flippedHere = true;
        }
      }
      if (!flippedHere) break;
    }
  }

  // Reconstruir vértices 3D + UVs reutilizando esquinas originales 0..m-1 sin duplicarlas
  const outNewVerts = [];
  const vertGlobalIndices = new Int32Array(pts2D.length);
  const outUvs = new Array(pts2D.length);

  for (let vi = 0; vi < m; vi++) {
    vertGlobalIndices[vi] = origVertIndices ? origVertIndices[vi] : vi;
    outUvs[vi] = polyUvs[vi].slice();
  }

  for (let vi = m; vi < pts2D.length; vi++) {
    const p = pts2D[vi];
    let bestTri = initTris[0];
    let bestW = [1, 0, 0];
    let bestScore = -Infinity;
    for (let k = 0; k < initTris.length; k++) {
      const it = initTris[k];
      const bw = bary(p.x, p.y, it[0], it[1], it[2]);
      if (!bw) continue;
      const minW = Math.min(bw[0], bw[1], bw[2]);
      if (minW > bestScore) {
        bestScore = minW;
        bestTri = it;
        bestW = bw;
      }
    }
    const cw0 = Math.max(0, bestW[0]);
    const cw1 = Math.max(0, bestW[1]);
    const cw2 = Math.max(0, bestW[2]);
    const sum = cw0 + cw1 + cw2 || 1;
    const w0 = cw0 / sum, w1 = cw1 / sum, w2 = cw2 / sum;
    const p0 = polyPts3D[bestTri[0]], p1 = polyPts3D[bestTri[1]], p2 = polyPts3D[bestTri[2]];
    const uv0 = polyUvs[bestTri[0]], uv1 = polyUvs[bestTri[1]], uv2 = polyUvs[bestTri[2]];
    vertGlobalIndices[vi] = -(outNewVerts.length + 1); // indicador temporal relativo
    outNewVerts.push({
      x: p0.x * w0 + p1.x * w1 + p2.x * w2,
      y: p0.y * w0 + p1.y * w1 + p2.y * w2,
      z: p0.z * w0 + p1.z * w1 + p2.z * w2,
    });
    outUvs[vi] = [
      uv0[0] * w0 + uv1[0] * w1 + uv2[0] * w2,
      uv0[1] * w0 + uv1[1] * w1 + uv2[1] * w2,
    ];
  }

  const cleanTris = [];
  for (let i = 0; i < tris.length; i++) {
    const [ia, ib, ic] = tris[i];
    if (ia === ib || ib === ic || ic === ia) continue;
    const area2 = cross2(pts2D[ia].x, pts2D[ia].y, pts2D[ib].x, pts2D[ib].y, pts2D[ic].x, pts2D[ic].y);
    if (Math.abs(area2) <= 1e-13) continue;
    cleanTris.push(area2 > 0 ? [ia, ib, ic] : [ia, ic, ib]);
  }

  return { newVerts: outNewVerts, vertGlobalIndices, uvs: outUvs, tris: cleanTris };
}

// ============================================================================
// Pipeline unificado de unión booleana sólida de sub-mallas
// ============================================================================

export function computeFaceShellIds(editableMesh) {
  const F = editableMesh.faces.length;
  const shellIds = new Int32Array(F);
  shellIds.fill(-1);
  if (!F) return { shellIds, shellCount: 0 };

  const topo = editableMesh.getTopology();
  let curShell = 0;
  for (let seed = 0; seed < F; seed++) {
    if (shellIds[seed] >= 0) continue;
    shellIds[seed] = curShell;
    const stack = [seed];
    while (stack.length) {
      const fi = stack.pop();
      const fe = topo.faceEdges[fi] || [];
      for (let i = 0; i < fe.length; i++) {
        const e = topo.edges[fe[i]];
        if (!e) continue;
        for (let j = 0; j < e.faces.length; j++) {
          const nfi = e.faces[j];
          if (shellIds[nfi] < 0) {
            shellIds[nfi] = curShell;
            stack.push(nfi);
          }
        }
      }
    }
    curShell++;
  }
  return { shellIds, shellCount: curShell };
}

export function performVolumetricUnionIfNeeded(editableMesh, {
  threshold = 0.015,
  shellIds = null,
} = {}) {
  if (!editableMesh || editableMesh.faces.length < 2) return { performed: false };

  let fShells = shellIds;
  let shellCount = 0;
  if (!fShells || fShells.length !== editableMesh.faces.length) {
    const comp = computeFaceShellIds(editableMesh);
    fShells = comp.shellIds;
    shellCount = comp.shellCount;
  } else {
    let maxId = -1;
    for (let i = 0; i < fShells.length; i++) {
      if (fShells[i] > maxId) maxId = fShells[i];
    }
    shellCount = maxId + 1;
  }

  if (shellCount < 2) return { performed: false };

  const tol = Math.max(1e-6, Number(threshold) || 0.015);
  const verts = editableMesh.verts;

  let gMinX = Infinity, gMinY = Infinity, gMinZ = Infinity;
  let gMaxX = -Infinity, gMaxY = -Infinity, gMaxZ = -Infinity;
  for (let i = 0; i < verts.length; i++) {
    const p = verts[i];
    if (p.x < gMinX) gMinX = p.x; if (p.x > gMaxX) gMaxX = p.x;
    if (p.y < gMinY) gMinY = p.y; if (p.y > gMaxY) gMaxY = p.y;
    if (p.z < gMinZ) gMinZ = p.z; if (p.z > gMaxZ) gMaxZ = p.z;
  }
  const diag = Math.hypot(gMaxX - gMinX, gMaxY - gMinY, gMaxZ - gMinZ) || 1;
  const planeTol = Math.min(tol * 0.5, diag * 1e-4);
  const polyPlanarTol = Math.min(planeTol * 0.25, diag * 2e-5);

  const allTris = [];
  const facesMeta = new Array(editableMesh.faces.length);
  const trisByShell = Array.from({ length: shellCount }, () => []);
  const edgeCountByShell = Array.from({ length: shellCount }, () => new Map());

  const invPosEps = 1 / Math.max(1e-6, diag * 1e-5);
  const countShellEdge = (sId, a, b) => {
    const pa = verts[a], pb = verts[b];
    const ka = quantKey(pa.x, pa.y, pa.z, invPosEps);
    const kb = quantKey(pb.x, pb.y, pb.z, invPosEps);
    if (ka === kb) return;
    const map = edgeCountByShell[sId];
    const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
    map.set(k, (map.get(k) || 0) + 1);
  };

  for (let fi = 0; fi < editableMesh.faces.length; fi++) {
    const f = editableMesh.faces[fi];
    if (!f || f.length < 3) continue;
    const sId = fShells[fi];
    const fUv = editableMesh.faceUvs[fi] || f.map(() => [0, 0]);
    for (let i = 0; i < f.length; i++) {
      countShellEdge(sId, f[i], f[(i + 1) % f.length]);
    }

    const pts3D = f.map((vi) => verts[vi]);
    const basis = computePolygonBasis3D(pts3D);
    const isPlanarConvex = Boolean(
      basis &&
      basis.area2 > 1e-12 &&
      (f.length === 3 || (basis.maxPlaneDist <= polyPlanarTol && isConvexCCW2D(basis.pts2D)))
    );

    const triRefs = [];
    const boundaryEdgeSet = new Set();
    for (let i = 0; i < f.length; i++) {
      const a = f[i], b = f[(i + 1) % f.length];
      boundaryEdgeSet.add(edgeKey(a, b));
    }

    const pushTri = (ia, ib, ic, ua, ub, uc) => {
      const pa = verts[ia], pb = verts[ib], pc = verts[ic];
      const e1x = pb.x - pa.x, e1y = pb.y - pa.y, e1z = pb.z - pa.z;
      const e2x = pc.x - pa.x, e2y = pc.y - pa.y, e2z = pc.z - pa.z;
      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;
      const l = Math.hypot(nx, ny, nz);
      if (l < 1e-11) return;
      const triObj = {
        index: allTris.length,
        faceIndex: fi,
        shell: sId,
        a: ia, b: ib, c: ic,
        uva: ua.slice(), uvb: ub.slice(), uvc: uc.slice(),
        normal: { x: nx / l, y: ny / l, z: nz / l },
        edgeIsBoundary: [
          boundaryEdgeSet.has(edgeKey(ia, ib)),
          boundaryEdgeSet.has(edgeKey(ib, ic)),
          boundaryEdgeSet.has(edgeKey(ic, ia)),
        ],
      };
      allTris.push(triObj);
      trisByShell[sId].push(triObj);
      triRefs.push(triObj);
    };

    if (f.length === 3) {
      pushTri(f[0], f[1], f[2], fUv[0] || [0, 0], fUv[1] || [0, 0], fUv[2] || [0, 0]);
    } else if (f.length === 4) {
      pushTri(f[0], f[1], f[2], fUv[0] || [0, 0], fUv[1] || [0, 0], fUv[2] || [0, 0]);
      pushTri(f[0], f[2], f[3], fUv[0] || [0, 0], fUv[2] || [0, 0], fUv[3] || [0, 0]);
    } else {
      for (let i = 1; i + 1 < f.length; i++) {
        pushTri(f[0], f[i], f[i + 1], fUv[0] || [0, 0], fUv[i] || [0, 0], fUv[i + 1] || [0, 0]);
      }
    }

    facesMeta[fi] = {
      fi,
      shell: sId,
      indices: f,
      uvs: fUv,
      normal: basis ? basis.normal : (triRefs[0] ? triRefs[0].normal : { x: 0, y: 1, z: 0 }),
      origin: basis ? basis.origin : pts3D[0],
      uAxis: basis ? basis.uAxis : { x: 1, y: 0, z: 0 },
      vAxis: basis ? basis.vAxis : { x: 0, y: 0, z: 1 },
      pts2D: basis ? basis.pts2D : null,
      isPlanarConvex,
      triRefs,
    };
  }

  // Construir info & BVH por shell
  const shellInfos = new Array(shellCount);
  for (let s = 0; s < shellCount; s++) {
    const sTris = trisByShell[s];
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < sTris.length; i++) {
      const t = sTris[i];
      for (const vi of [t.a, t.b, t.c]) {
        const p = verts[vi];
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
        if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
      }
    }
    let openEdges = 0;
    for (const c of edgeCountByShell[s].values()) {
      if (c === 1) openEdges++;
    }
    shellInfos[s] = {
      shell: s,
      tris: sTris,
      verts,
      bvh: buildTriBVH(sTris, verts),
      minX, minY, minZ, maxX, maxY, maxZ,
      isClosed: sTris.length >= 4 && openEdges === 0,
    };
  }

  if (!shellInfos.some((s) => s.isClosed)) {
    return { performed: false };
  }

  // Colectar segmentos por cara planar convexa (`faceSegs`) o por triángulo fallback (`triSegs`)
  const faceSegs = new Map();
  const triSegs = new Map();
  const pushFaceSeg = (fi, seg) => {
    let arr = faceSegs.get(fi);
    if (!arr) { arr = []; faceSegs.set(fi, arr); }
    arr.push(seg);
  };
  const pushTriSeg = (triIdx, seg) => {
    let arr = triSegs.get(triIdx);
    if (!arr) { arr = []; triSegs.set(triIdx, arr); }
    arr.push(seg);
  };

  let hasTransverseCross = false;
  let hasStrictlyInside = false;
  const coplanarFacePairs = [];
  const coplanarTriPairs = [];
  const seenFacePairs = new Set();
  const surfTol = Math.max(1e-6, Math.min(tol * 0.05, diag * 1e-4));
  const surfTolSq = surfTol * surfTol;

  for (let sA = 0; sA < shellCount; sA++) {
    const infoA = shellInfos[sA];
    if (!infoA.tris.length) continue;
    for (let sB = sA + 1; sB < shellCount; sB++) {
      const infoB = shellInfos[sB];
      if (!infoB.tris.length) continue;
      if (
        infoA.maxX < infoB.minX - tol || infoA.minX > infoB.maxX + tol ||
        infoA.maxY < infoB.minY - tol || infoA.minY > infoB.maxY + tol ||
        infoA.maxZ < infoB.minZ - tol || infoA.minZ > infoB.maxZ + tol
      ) {
        continue;
      }

      for (let i = 0; i < infoA.tris.length; i++) {
        const tA = infoA.tris[i];
        const a0 = verts[tA.a], a1 = verts[tA.b], a2 = verts[tA.c];
        const minX = Math.min(a0.x, a1.x, a2.x) - planeTol;
        const minY = Math.min(a0.y, a1.y, a2.y) - planeTol;
        const minZ = Math.min(a0.z, a1.z, a2.z) - planeTol;
        const maxX = Math.max(a0.x, a1.x, a2.x) + planeTol;
        const maxY = Math.max(a0.y, a1.y, a2.y) + planeTol;
        const maxZ = Math.max(a0.z, a1.z, a2.z) + planeTol;

        const fA = facesMeta[tA.faceIndex];

        queryBVHBox(infoB.bvh, minX, minY, minZ, maxX, maxY, maxZ, (localIdxB) => {
          const tB = infoB.tris[localIdxB];
          const fB = facesMeta[tB.faceIndex];

          // Vía rápida limpia a nivel de polígono planar convexo (evita cortes fantasma contra diagonales de quads)
          if (fA && fB && fA.isPlanarConvex && fB.isPlanarConvex) {
            const pk = fA.fi < fB.fi ? `${fA.fi}_${fB.fi}` : `${fB.fi}_${fA.fi}`;
            if (seenFacePairs.has(pk)) return;
            seenFacePairs.add(pk);

            const hit = polyPolySegments(fA, fB, verts, planeTol);
            if (!hit) return;
            if (hit.coplanar) {
              coplanarFacePairs.push([fA, fB]);
            } else if (hit.segment) {
              hasTransverseCross = true;
              pushFaceSeg(fA.fi, hit.segment);
              pushFaceSeg(fB.fi, hit.segment);
            }
            return;
          }

          // Fallback triángulo-triángulo para caras no planares o cóncavas
          const b0 = verts[tB.a], b1 = verts[tB.b], b2 = verts[tB.c];
          const hit = triTriSegments(a0, a1, a2, tA.normal, b0, b1, b2, tB.normal, planeTol);
          if (!hit) return;
          if (hit.coplanar) {
            coplanarTriPairs.push([tA, tB]);
          } else if (hit.segment) {
            hasTransverseCross = true;
            if (fA && fA.isPlanarConvex) pushFaceSeg(fA.fi, hit.segment);
            else pushTriSeg(tA.index, hit.segment);
            if (fB && fB.isPlanarConvex) pushFaceSeg(fB.fi, hit.segment);
            else pushTriSeg(tB.index, hit.segment);
          }
        });
      }

      if (!hasStrictlyInside && infoB.isClosed) {
        for (let i = 0; i < infoA.tris.length; i++) {
          const t = infoA.tris[i];
          const cx = (verts[t.a].x + verts[t.b].x + verts[t.c].x) / 3;
          const cy = (verts[t.a].y + verts[t.b].y + verts[t.c].y) / 3;
          const cz = (verts[t.a].z + verts[t.b].z + verts[t.c].z) / 3;
          if (classifyPointVsClosedShell(cx, cy, cz, infoB, surfTolSq) === 'inside') {
            hasStrictlyInside = true;
            break;
          }
        }
      }
      if (!hasStrictlyInside && infoA.isClosed) {
        for (let i = 0; i < infoB.tris.length; i++) {
          const t = infoB.tris[i];
          const cx = (verts[t.a].x + verts[t.b].x + verts[t.c].x) / 3;
          const cy = (verts[t.a].y + verts[t.b].y + verts[t.c].y) / 3;
          const cz = (verts[t.a].z + verts[t.b].z + verts[t.c].z) / 3;
          if (classifyPointVsClosedShell(cx, cy, cz, infoA, surfTolSq) === 'inside') {
            hasStrictlyInside = true;
            break;
          }
        }
      }
    }
  }

  if (!hasTransverseCross && !hasStrictlyInside) {
    return { performed: false };
  }

  // Agregar segmentos coplanares usando únicamente aristas exteriores reales
  for (let i = 0; i < coplanarFacePairs.length; i++) {
    const [fA, fB] = coplanarFacePairs[i];
    const co = collectCoplanarFaceOverlapSegs(fA, fB, verts);
    for (let k = 0; k < co.segsForA.length; k++) pushFaceSeg(fA.fi, co.segsForA[k]);
    for (let k = 0; k < co.segsForB.length; k++) pushFaceSeg(fB.fi, co.segsForB[k]);
  }
  for (let i = 0; i < coplanarTriPairs.length; i++) {
    const [tA, tB] = coplanarTriPairs[i];
    const co = collectCoplanarTriBoundarySegs(tA, tB, verts, true);
    if (!co) continue;
    const fA = facesMeta[tA.faceIndex], fB = facesMeta[tB.faceIndex];
    for (let k = 0; k < co.segsForA.length; k++) {
      if (fA && fA.isPlanarConvex) pushFaceSeg(fA.fi, co.segsForA[k]);
      else pushTriSeg(tA.index, co.segsForA[k]);
    }
    for (let k = 0; k < co.segsForB.length; k++) {
      if (fB && fB.isPlanarConvex) pushFaceSeg(fB.fi, co.segsForB[k]);
      else pushTriSeg(tB.index, co.segsForB[k]);
    }
  }

  const coplanarTouchedFaces = new Set();
  for (let i = 0; i < coplanarFacePairs.length; i++) {
    coplanarTouchedFaces.add(coplanarFacePairs[i][0].fi);
    coplanarTouchedFaces.add(coplanarFacePairs[i][1].fi);
  }
  for (let i = 0; i < coplanarTriPairs.length; i++) {
    coplanarTouchedFaces.add(coplanarTriPairs[i][0].faceIndex);
    coplanarTouchedFaces.add(coplanarTriPairs[i][1].faceIndex);
  }

  const seamSnap = Math.max(1e-5, Math.min(tol * 0.25, diag * 2e-4));
  const chordVertTolSq = (seamSnap * 2.5) * (seamSnap * 2.5);

  const classifySubTriKeep = (pa, pb, pc, stNormal, stShell) => {
    const cx = (pa.x + pb.x + pc.x) / 3;
    const cy = (pa.y + pb.y + pc.y) / 3;
    const cz = (pa.z + pb.z + pc.z) / 3;
    const surfHolder = { tri: null };
    for (let s = 0; s < shellCount; s++) {
      if (s === stShell) continue;
      const sInfo = shellInfos[s];
      if (!sInfo.isClosed) continue;
      surfHolder.tri = null;
      const cls = classifyPointVsClosedShell(cx, cy, cz, sInfo, surfTolSq, surfHolder);
      if (cls === 'inside') return false;
      if (cls === 'surface' && surfHolder.tri) {
        const sn = surfHolder.tri.normal;
        const dot = sn.x * stNormal.x + sn.y * stNormal.y + sn.z * stNormal.z;
        if (dot < -0.9 || (dot > 0.9 && stShell > s)) {
          return false;
        }
        // Detectar sub-triángulos puente ("chord-bridge") sobre curvas transversales de intersección:
        // los 3 vértices caen sobre la otra malla y el centroide queda ligeramente dentro por sagitta
        if (Math.abs(dot) <= 0.9) {
          const da = minDistTriToBVH(pa.x, pa.y, pa.z, sInfo.bvh, sInfo.tris, sInfo.verts, chordVertTolSq);
          if (da.tri) {
            const db = minDistTriToBVH(pb.x, pb.y, pb.z, sInfo.bvh, sInfo.tris, sInfo.verts, chordVertTolSq);
            if (db.tri) {
              const dc = minDistTriToBVH(pc.x, pc.y, pc.z, sInfo.bvh, sInfo.tris, sInfo.verts, chordVertTolSq);
              if (dc.tri) {
                let odd = 0;
                for (let r = 0; r < 3; r++) {
                  const dir = _PARITY_DIRS[r];
                  if ((rayCountBVH(cx, cy, cz, dir[0], dir[1], dir[2], sInfo.bvh, sInfo.tris, sInfo.verts) & 1) === 1) {
                    odd++;
                  }
                }
                if (odd >= 2) return false;
              }
            }
          }
        }
      }
    }
    return true;
  };

  // Subdividir caras cortadas preservando intactas las caras no cortadas
  const splitVerts = verts.map((v) => ({ x: v.x, y: v.y, z: v.z }));

  const keptFaces = [];
  const keptUvs = [];
  const faceOrigins = [];
  let removedInsideCount = 0;

  for (let fi = 0; fi < editableMesh.faces.length; fi++) {
    const fInfo = facesMeta[fi];
    if (!fInfo) continue;

    const fSegs = faceSegs.get(fi);
    const anyTriSplit = fInfo.triRefs.some((t) => triSegs.has(t.index));

    // Caso 1: Cara planar convexa con segmentos de corte (split a nivel polígono sin diagonales falsas)
    if (fInfo.isPlanarConvex && fSegs && fSegs.length) {
      const polyPts3D = fInfo.indices.map((vi) => verts[vi]);
      const splitRes = splitConvexPolygonWithSegments(
        polyPts3D,
        fInfo.uvs,
        fInfo.pts2D,
        fInfo.origin,
        fInfo.uAxis,
        fInfo.vAxis,
        fSegs,
        seamSnap,
        fInfo.indices
      );
      if (splitRes && splitRes.tris.length) {
        const baseNewIdx = splitVerts.length;
        for (let k = 0; k < splitRes.newVerts.length; k++) {
          splitVerts.push(splitRes.newVerts[k]);
        }
        const mapLocalVert = (localVi) => {
          const g = splitRes.vertGlobalIndices[localVi];
          return g >= 0 ? g : baseNewIdx + (-g - 1);
        };
        for (let k = 0; k < splitRes.tris.length; k++) {
          const [ia, ib, ic] = splitRes.tris[k];
          const ga = mapLocalVert(ia);
          const gb = mapLocalVert(ib);
          const gc = mapLocalVert(ic);
          if (!classifySubTriKeep(splitVerts[ga], splitVerts[gb], splitVerts[gc], fInfo.normal, fInfo.shell)) {
            removedInsideCount++;
            continue;
          }
          keptFaces.push([ga, gb, gc]);
          keptUvs.push([splitRes.uvs[ia].slice(), splitRes.uvs[ib].slice(), splitRes.uvs[ic].slice()]);
          faceOrigins.push({ origFaceId: fi, shell: fInfo.shell, wasTouched: true });
        }
        continue;
      }
    }

    // Caso 2: Cara sin ningún corte -> preservar el polígono original completo (quad/N-gono) si sobrevive íntegro
    if ((!fSegs || !fSegs.length) && !anyTriSplit) {
      const triFlags = fInfo.triRefs.map((t) =>
        classifySubTriKeep(verts[t.a], verts[t.b], verts[t.c], t.normal, fInfo.shell)
      );
      const keepAll = triFlags.length > 0 && triFlags.every(Boolean);
      const dropAll = triFlags.length > 0 && triFlags.every((fl) => !fl);
      if (keepAll) {
        keptFaces.push(fInfo.indices.slice());
        keptUvs.push(fInfo.uvs.map((u) => u.slice()));
        faceOrigins.push({
          origFaceId: fi,
          shell: fInfo.shell,
          wasTouched: coplanarTouchedFaces.has(fi),
        });
        continue;
      }
      if (dropAll) {
        removedInsideCount += triFlags.length;
        continue;
      }
    }

    // Caso 3: Cara no planar / cóncava o parcialmente cortada por triángulos fallback
    for (let ti = 0; ti < fInfo.triRefs.length; ti++) {
      const t = fInfo.triRefs[ti];
      const tSegs = triSegs.get(t.index);
      if (tSegs && tSegs.length) {
        const triBasis = computePolygonBasis3D([verts[t.a], verts[t.b], verts[t.c]]);
        if (triBasis) {
          const splitRes = splitConvexPolygonWithSegments(
            [verts[t.a], verts[t.b], verts[t.c]],
            [t.uva, t.uvb, t.uvc],
            triBasis.pts2D,
            triBasis.origin,
            triBasis.uAxis,
            triBasis.vAxis,
            tSegs,
            seamSnap,
            [t.a, t.b, t.c]
          );
          if (splitRes && splitRes.tris.length) {
            const baseNewIdx = splitVerts.length;
            for (let k = 0; k < splitRes.newVerts.length; k++) {
              splitVerts.push(splitRes.newVerts[k]);
            }
            const mapLocalVert = (localVi) => {
              const g = splitRes.vertGlobalIndices[localVi];
              return g >= 0 ? g : baseNewIdx + (-g - 1);
            };
            for (let k = 0; k < splitRes.tris.length; k++) {
              const [ia, ib, ic] = splitRes.tris[k];
              const ga = mapLocalVert(ia);
              const gb = mapLocalVert(ib);
              const gc = mapLocalVert(ic);
              if (!classifySubTriKeep(splitVerts[ga], splitVerts[gb], splitVerts[gc], t.normal, t.shell)) {
                removedInsideCount++;
                continue;
              }
              keptFaces.push([ga, gb, gc]);
              keptUvs.push([splitRes.uvs[ia].slice(), splitRes.uvs[ib].slice(), splitRes.uvs[ic].slice()]);
              faceOrigins.push({ origFaceId: fi, shell: t.shell, wasTouched: true });
            }
            continue;
          }
        }
      }

      if (!classifySubTriKeep(verts[t.a], verts[t.b], verts[t.c], t.normal, t.shell)) {
        removedInsideCount++;
        continue;
      }
      keptFaces.push([t.a, t.b, t.c]);
      keptUvs.push([t.uva.slice(), t.uvb.slice(), t.uvc.slice()]);
      faceOrigins.push({
        origFaceId: fi,
        shell: t.shell,
        wasTouched: coplanarTouchedFaces.has(fi) || Boolean(anyTriSplit),
      });
    }
  }

  editableMesh.verts = splitVerts;
  editableMesh.faces = keptFaces;
  editableMesh.faceUvs = keptUvs;
  editableMesh.looseEdges = [];
  editableMesh.creases = new Map();
  editableMesh.invalidateTopology();

  return {
    performed: true,
    removedInsideCount,
    splitFaceCount: keptFaces.length,
    faceOrigins,
  };
}

// ============================================================================
// Simplificación Topológica Post-Unión (fusión de caras coplanares y disolución)
// ============================================================================

function computeFaceUnitNormal(face, verts) {
  const n = face.length;
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < n; i++) {
    const p = verts[face[i]];
    const q = verts[face[(i + 1) % n]];
    nx += (p.y - q.y) * (p.z + q.z);
    ny += (p.z - q.z) * (p.x + q.x);
    nz += (p.x - q.x) * (p.y + q.y);
  }
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-12) return null;
  return { x: nx / len, y: ny / len, z: nz / len };
}

function analyzeMergedRing2D(ring, verts, planeTol) {
  const n = ring.length;
  if (n < 3) return null;
  const pts = new Array(n);
  for (let i = 0; i < n; i++) pts[i] = verts[ring[i]];
  const basis = computePolygonBasis3D(pts);
  if (!basis || basis.area2 <= 1e-12) return null;
  if (basis.maxPlaneDist > planeTol) return null;

  const { pts2D } = basis;
  let trueCorners = 0;
  for (let i = 0; i < n; i++) {
    const prev = pts2D[(i - 1 + n) % n];
    const curr = pts2D[i];
    const next = pts2D[(i + 1) % n];
    const e1x = curr.x - prev.x, e1y = curr.y - prev.y;
    const e2x = next.x - curr.x, e2y = next.y - curr.y;
    const l1 = Math.hypot(e1x, e1y);
    const l2 = Math.hypot(e2x, e2y);
    if (l1 < 1e-8 || l2 < 1e-8) return null;
    const inv = 1 / (l1 * l2);
    const sinTurn = (e1x * e2y - e1y * e2x) * inv;
    const cosTurn = (e1x * e2x + e1y * e2y) * inv;
    if (sinTurn < -0.008) return null; // Esquina cóncava / reflex no permitida
    if (Math.abs(sinTurn) > 0.015 || cosTurn < 0.999) trueCorners++;
  }
  return { trueCorners, basis };
}

function tryBuildMergedFace(fA, uvA, fB, uvB, u, v, verts, planeTol) {
  const nA = fA.length, nB = fB.length;
  let ia = -1, p = -1, q = -1;
  for (let i = 0; i < nA; i++) {
    const a = fA[i], b = fA[(i + 1) % nA];
    if ((a === u && b === v) || (a === v && b === u)) {
      ia = i; p = a; q = b;
      break;
    }
  }
  if (ia < 0) return null;

  let ib = -1;
  for (let i = 0; i < nB; i++) {
    if (fB[i] === q && fB[(i + 1) % nB] === p) {
      ib = i;
      break;
    }
  }
  if (ib < 0) return null;

  const ring = [];
  const uvs = [];
  for (let k = 1; k <= nA; k++) {
    const idx = (ia + k) % nA;
    ring.push(fA[idx]);
    uvs.push((uvA[idx] || [0, 0]).slice());
  }
  for (let k = 2; k < nB; k++) {
    const idx = (ib + k) % nB;
    ring.push(fB[idx]);
    uvs.push((uvB[idx] || [0, 0]).slice());
  }

  if (ring.length < 3) return null;
  if (new Set(ring).size !== ring.length) return null;

  const info = analyzeMergedRing2D(ring, verts, planeTol);
  if (!info) return null;
  return { ring, uvs, trueCorners: info.trueCorners };
}

function mergeCoplanarFacesPass(
  editableMesh,
  faceOrigins,
  planeTol,
  allowCrossFace,
  normalDotMin = 0.9997,
  maxCrossCorners = 4
) {
  const verts = editableMesh.verts;
  let totalMerged = 0;

  for (let iter = 0; iter < 64; iter++) {
    const F = editableMesh.faces.length;
    if (F < 2) break;
    const topo = editableMesh.getTopology();
    const normals = new Array(F);
    for (let fi = 0; fi < F; fi++) {
      normals[fi] = computeFaceUnitNormal(editableMesh.faces[fi], verts);
    }

    // Buscar el mejor par candidato (priorizando mismo origFaceId -> quads <= 4 esquinas -> aristas más largas)
    const candidates = [];
    for (let ei = 0; ei < topo.edges.length; ei++) {
      const e = topo.edges[ei];
      if (!e || e.faces.length !== 2) continue;
      const fa = e.faces[0], fb = e.faces[1];
      if (fa === fb) continue;
      const normA = normals[fa], normB = normals[fb];
      if (!normA || !normB) continue;
      if (normA.x * normB.x + normA.y * normB.y + normA.z * normB.z < normalDotMin) continue;

      const origA = faceOrigins ? faceOrigins[fa] : null;
      const origB = faceOrigins ? faceOrigins[fb] : null;
      const sameOrig = Boolean(origA && origB && origA.origFaceId >= 0 && origA.origFaceId === origB.origFaceId);
      if (!sameOrig) {
        if (!allowCrossFace) continue;
        if (origA && origB && !origA.wasTouched && !origB.wasTouched) continue;
      }

      const merged = tryBuildMergedFace(
        editableMesh.faces[fa],
        editableMesh.faceUvs[fa] || [],
        editableMesh.faces[fb],
        editableMesh.faceUvs[fb] || [],
        e.a,
        e.b,
        verts,
        planeTol
      );
      if (!merged) continue;
      if (!sameOrig && merged.trueCorners > maxCrossCorners) continue;

      const pa = verts[e.a], pb = verts[e.b];
      const edgeLenSq = (pb.x - pa.x) ** 2 + (pb.y - pa.y) ** 2 + (pb.z - pa.z) ** 2;
      const priority =
        (sameOrig ? 1e6 : 0) +
        (merged.trueCorners <= 4 ? 1e4 : 0) -
        merged.trueCorners * 100 +
        Math.min(100, edgeLenSq);

      candidates.push({ fa, fb, merged, origA, origB, priority });
    }

    if (!candidates.length) break;
    candidates.sort((x, y) => y.priority - x.priority);

    const usedFace = new Uint8Array(F);
    const replaceWith = new Map();
    const dropFace = new Uint8Array(F);
    let mergedThisPass = 0;

    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      if (usedFace[c.fa] || usedFace[c.fb]) continue;
      usedFace[c.fa] = 1;
      usedFace[c.fb] = 1;
      dropFace[c.fb] = 1;
      replaceWith.set(c.fa, c);
      mergedThisPass++;
    }

    if (!mergedThisPass) break;
    totalMerged += mergedThisPass;

    const nextFaces = [];
    const nextUvs = [];
    const nextOrigins = faceOrigins ? [] : null;
    for (let fi = 0; fi < F; fi++) {
      if (dropFace[fi]) continue;
      const rep = replaceWith.get(fi);
      if (rep) {
        nextFaces.push(rep.merged.ring);
        nextUvs.push(rep.merged.uvs);
        if (nextOrigins) {
          nextOrigins.push({
            origFaceId: rep.origA && rep.origB && rep.origA.origFaceId === rep.origB.origFaceId
              ? rep.origA.origFaceId
              : -1,
            shell: rep.origA ? rep.origA.shell : -1,
            wasTouched: true,
          });
        }
      } else {
        nextFaces.push(editableMesh.faces[fi]);
        nextUvs.push(editableMesh.faceUvs[fi] || editableMesh.faces[fi].map(() => [0, 0]));
        if (nextOrigins) nextOrigins.push(faceOrigins[fi]);
      }
    }
    editableMesh.faces = nextFaces;
    editableMesh.faceUvs = nextUvs;
    if (faceOrigins && nextOrigins) {
      faceOrigins.splice(0, faceOrigins.length, ...nextOrigins);
    }
    editableMesh.invalidateTopology();
  }

  return totalMerged;
}

function dissolveFlatInteriorVertices(editableMesh, faceOrigins, planeTol, normalDotMin = 0.9997) {
  let dissolved = 0;
  const verts = editableMesh.verts;

  for (let pass = 0; pass < 8; pass++) {
    let changedPass = false;
    const topo = editableMesh.getTopology();
    const F = editableMesh.faces.length;
    const normals = new Array(F);
    for (let fi = 0; fi < F; fi++) {
      normals[fi] = computeFaceUnitNormal(editableMesh.faces[fi], verts);
    }

    const removedFaces = new Uint8Array(F);
    const addedFaces = [];
    const addedUvs = [];
    const addedOrigins = [];

    for (let vi = 0; vi < verts.length; vi++) {
      const incEdges = topo.vertEdges[vi];
      const incFaces = topo.vertFaces[vi];
      if (!incEdges || !incFaces || incFaces.length < 3 || incFaces.length !== incEdges.length) continue;

      let skip = false;
      let anyTouched = !faceOrigins;
      for (let i = 0; i < incEdges.length; i++) {
        const e = topo.edges[incEdges[i]];
        if (!e || e.faces.length !== 2) { skip = true; break; }
      }
      if (skip) continue;

      for (let i = 0; i < incFaces.length; i++) {
        const fi = incFaces[i];
        if (removedFaces[fi] || !normals[fi]) { skip = true; break; }
        if (faceOrigins && faceOrigins[fi]?.wasTouched) anyTouched = true;
      }
      if (skip || !anyTouched) continue;

      const refN = normals[incFaces[0]];
      const pV = verts[vi];
      let coplanar = true;
      for (let i = 0; i < incFaces.length; i++) {
        const fi = incFaces[i];
        const ni = normals[fi];
        if (ni.x * refN.x + ni.y * refN.y + ni.z * refN.z < normalDotMin) {
          coplanar = false;
          break;
        }
        const f = editableMesh.faces[fi];
        for (let k = 0; k < f.length; k++) {
          const p = verts[f[k]];
          const d = Math.abs((p.x - pV.x) * refN.x + (p.y - pV.y) * refN.y + (p.z - pV.z) * refN.z);
          if (d > planeTol) { coplanar = false; break; }
        }
        if (!coplanar) break;
      }
      if (!coplanar) continue;

      // Construir anillo exterior ordenado alrededor de vi
      const byStart = new Map();
      let validRing = true;
      for (let i = 0; i < incFaces.length; i++) {
        const fi = incFaces[i];
        const f = editableMesh.faces[fi];
        const fUv = editableMesh.faceUvs[fi] || f.map(() => [0, 0]);
        const pos = f.indexOf(vi);
        if (pos < 0) { validRing = false; break; }
        const n = f.length;
        const startV = f[(pos + 1) % n];
        const endV = f[(pos - 1 + n) % n];
        if (byStart.has(startV)) { validRing = false; break; }
        const chain = [];
        const chainUv = [];
        for (let step = 1; step < n - 1; step++) {
          const idx = (pos + step) % n;
          chain.push(f[idx]);
          chainUv.push((fUv[idx] || [0, 0]).slice());
        }
        byStart.set(startV, { startV, endV, chain, chainUv, origId: faceOrigins ? faceOrigins[fi]?.origFaceId : -1 });
      }
      if (!validRing || byStart.size !== incFaces.length) continue;

      const firstEntry = byStart.values().next().value;
      const loop = [];
      const loopUv = [];
      let cur = firstEntry;
      let visited = 0;
      const origSet = new Set();
      while (cur && visited < incFaces.length) {
        visited++;
        origSet.add(cur.origId);
        for (let k = 0; k < cur.chain.length; k++) {
          loop.push(cur.chain[k]);
          loopUv.push(cur.chainUv[k]);
        }
        cur = byStart.get(cur.endV);
      }
      if (visited !== incFaces.length || !cur || cur.startV !== firstEntry.startV) continue;
      if (loop.length < 3 || new Set(loop).size !== loop.length) continue;

      const ringInfo = analyzeMergedRing2D(loop, verts, planeTol);
      const sameOrigAll = origSet.size === 1 && !origSet.has(-1);
      if (ringInfo && (sameOrigAll || ringInfo.trueCorners <= 6)) {
        for (let i = 0; i < incFaces.length; i++) removedFaces[incFaces[i]] = 1;
        addedFaces.push(loop);
        addedUvs.push(loopUv);
        addedOrigins.push({
          origFaceId: sameOrigAll ? firstEntry.origId : -1,
          shell: faceOrigins ? faceOrigins[incFaces[0]]?.shell ?? -1 : -1,
          wasTouched: true,
        });
        dissolved++;
        changedPass = true;
      }
    }

    if (!changedPass) break;

    const nextFaces = [];
    const nextUvs = [];
    const nextOrigins = faceOrigins ? [] : null;
    for (let fi = 0; fi < F; fi++) {
      if (removedFaces[fi]) continue;
      nextFaces.push(editableMesh.faces[fi]);
      nextUvs.push(editableMesh.faceUvs[fi] || editableMesh.faces[fi].map(() => [0, 0]));
      if (nextOrigins) nextOrigins.push(faceOrigins[fi]);
    }
    for (let i = 0; i < addedFaces.length; i++) {
      nextFaces.push(addedFaces[i]);
      nextUvs.push(addedUvs[i]);
      if (nextOrigins) nextOrigins.push(addedOrigins[i]);
    }
    editableMesh.faces = nextFaces;
    editableMesh.faceUvs = nextUvs;
    if (faceOrigins && nextOrigins) {
      faceOrigins.splice(0, faceOrigins.length, ...nextOrigins);
    }
    editableMesh.invalidateTopology();
  }

  return dissolved;
}

function dissolveCollinearVertices(editableMesh, faceOrigins, edgeTol, collinearDotMax = -0.9999) {
  let dissolved = 0;
  const verts = editableMesh.verts;

  for (let pass = 0; pass < 12; pass++) {
    let changedPass = false;
    const topo = editableMesh.getTopology();
    const activeEdges = new Set();

    for (let vi = 0; vi < verts.length; vi++) {
      const incEdges = topo.vertEdges[vi];
      const incFaces = topo.vertFaces[vi];
      if (!incEdges || !incFaces || incEdges.length !== 2 || incFaces.length !== 2) continue;
      if (incFaces[0] === incFaces[1]) continue;

      const e0 = topo.edges[incEdges[0]];
      const e1 = topo.edges[incEdges[1]];
      if (!e0 || !e1 || e0.faces.length !== 2 || e1.faces.length !== 2) continue;

      const a = e0.a === vi ? e0.b : e0.a;
      const b = e1.a === vi ? e1.b : e1.a;
      if (a === b) continue;

      const f0 = editableMesh.faces[incFaces[0]];
      const f1 = editableMesh.faces[incFaces[1]];
      if (!f0 || !f1 || f0.length < 4 || f1.length < 4) continue;

      const abKey = edgeKey(a, b);
      if (topo.edgeMap.has(abKey) || activeEdges.has(abKey)) continue;

      if (faceOrigins && !faceOrigins[incFaces[0]]?.wasTouched && !faceOrigins[incFaces[1]]?.wasTouched) continue;

      const pv = verts[vi], pa = verts[a], pb = verts[b];
      const dax = pa.x - pv.x, day = pa.y - pv.y, daz = pa.z - pv.z;
      const dbx = pb.x - pv.x, dby = pb.y - pv.y, dbz = pb.z - pv.z;
      const la = Math.hypot(dax, day, daz);
      const lb = Math.hypot(dbx, dby, dbz);
      if (la < 1e-8 || lb < 1e-8) continue;
      const dot = (dax * dbx + day * dby + daz * dbz) / (la * lb);
      if (dot > collinearDotMax) continue;

      // Comprobar distancia perpendicular de pv al segmento ab
      const abx = pb.x - pa.x, aby = pb.y - pa.y, abz = pb.z - pa.z;
      const abSq = abx * abx + aby * aby + abz * abz;
      if (abSq < 1e-14) continue;
      const t = ((pv.x - pa.x) * abx + (pv.y - pa.y) * aby + (pv.z - pa.z) * abz) / abSq;
      if (t <= 0 || t >= 1) continue;
      const px = pa.x + abx * t, py = pa.y + aby * t, pz = pa.z + abz * t;
      if (Math.hypot(pv.x - px, pv.y - py, pv.z - pz) > edgeTol * 0.5) continue;

      const pos0 = f0.indexOf(vi);
      const pos1 = f1.indexOf(vi);
      if (pos0 < 0 || pos1 < 0) continue;
      const prev0 = f0[(pos0 - 1 + f0.length) % f0.length];
      const next0 = f0[(pos0 + 1) % f0.length];
      const prev1 = f1[(pos1 - 1 + f1.length) % f1.length];
      const next1 = f1[(pos1 + 1) % f1.length];
      if (!((prev0 === a && next0 === b) || (prev0 === b && next0 === a))) continue;
      if (!((prev1 === a && next1 === b) || (prev1 === b && next1 === a))) continue;

      f0.splice(pos0, 1);
      if (editableMesh.faceUvs[incFaces[0]]) editableMesh.faceUvs[incFaces[0]].splice(pos0, 1);
      f1.splice(pos1, 1);
      if (editableMesh.faceUvs[incFaces[1]]) editableMesh.faceUvs[incFaces[1]].splice(pos1, 1);
      if (faceOrigins) {
        faceOrigins[incFaces[0]].wasTouched = true;
        faceOrigins[incFaces[1]].wasTouched = true;
      }
      activeEdges.add(abKey);
      dissolved++;
      changedPass = true;
      break; // re-indexar topología de forma segura tras modificar caras
    }

    if (!changedPass) break;
    editableMesh.invalidateTopology();
  }

  return dissolved;
}

export function simplifyUnionTopology(editableMesh, faceOrigins = null, {
  planeTol = 1e-4,
  edgeTol = 1e-3,
  solidity = 0.8,
} = {}) {
  if (!editableMesh || editableMesh.faces.length < 2) return { mergedFaces: 0, dissolvedVerts: 0 };

  const rawSolidity = Number(solidity);
  const s = Number.isFinite(rawSolidity) ? Math.max(0, Math.min(1, rawSolidity)) : 0.8;
  if (s <= 0) {
    return { mergedFaces: 0, dissolvedVerts: 0 };
  }

  const allowCrossFace = s >= 0.45;
  const allowCollinearDissolve = s >= 0.45;
  const normalDotMin = s >= 0.85
    ? 0.9996 - ((s - 0.85) / 0.15) * 0.0026
    : 0.9999 - s * 0.0003;
  const effPlaneTol = planeTol * (s >= 0.85 ? 1 + ((s - 0.85) / 0.15) * 1.5 : 0.5 + s * 0.625);
  const effEdgeTol = edgeTol * (s >= 0.85 ? 1 + ((s - 0.85) / 0.15) * 0.75 : 0.6 + s * 0.5);
  const maxCrossCorners = s >= 0.95 ? 6 : 4;
  const collinearDotMax = -(0.99995 - s * 0.00025);

  let mergedFaces = 0;
  let dissolvedVerts = 0;

  for (let outer = 0; outer < 4; outer++) {
    let changed = false;
    // 1. Restaurar sub-triángulos de una misma cara original (sin diagonales internas innecesarias)
    const m1 = mergeCoplanarFacesPass(editableMesh, faceOrigins, effPlaneTol, false, normalDotMin, maxCrossCorners);
    if (m1 > 0) { mergedFaces += m1; changed = true; }

    // 2. Eliminar vértices interiores coplanares atrapados entre sub-parches
    const d1 = dissolveFlatInteriorVertices(editableMesh, faceOrigins, effPlaneTol, normalDotMin);
    if (d1 > 0) { dissolvedVerts += d1; changed = true; }

    // 3. Fusionar caras coplanares alineadas entre parches vecinos formando rectángulos/quads limpios
    if (allowCrossFace) {
      const m2 = mergeCoplanarFacesPass(editableMesh, faceOrigins, effPlaneTol, true, normalDotMin, maxCrossCorners);
      if (m2 > 0) { mergedFaces += m2; changed = true; }
    }

    // 4. Eliminar vértices de costura colineales de grado 2 sobre aristas rectas
    if (allowCollinearDissolve) {
      const d2 = dissolveCollinearVertices(editableMesh, faceOrigins, effEdgeTol, collinearDotMax);
      if (d2 > 0) { dissolvedVerts += d2; changed = true; }
    }

    if (!changed) break;
  }

  return { mergedFaces, dissolvedVerts };
}

// ============================================================================
// Saneamiento No-Manifold, Colapso de Astillas y Suavizado de Pegue (Fillet)
// ============================================================================

function computeFaceAreaSq3D(face, verts) {
  if (!face || face.length < 3) return 0;
  const p0 = verts[face[0]];
  let nx = 0, ny = 0, nz = 0;
  for (let i = 1; i + 1 < face.length; i++) {
    const p1 = verts[face[i]];
    const p2 = verts[face[i + 1]];
    const ax = p1.x - p0.x, ay = p1.y - p0.y, az = p1.z - p0.z;
    const bx = p2.x - p0.x, by = p2.y - p0.y, bz = p2.z - p0.z;
    nx += ay * bz - az * by;
    ny += az * bx - ax * bz;
    nz += ax * by - ay * bx;
  }
  return 0.25 * (nx * nx + ny * ny + nz * nz);
}

export function pruneNonManifoldFlaps(editableMesh, faceOrigins = null, { sealPinholes = false } = {}) {
  if (!editableMesh || editableMesh.faces.length < 2) {
    return { removed: 0, sealed: 0 };
  }

  let removedTotal = 0;
  let sealedTotal = 0;
  const verts = editableMesh.verts;

  // 1. Eliminar caras exactamente duplicadas o con el mismo conjunto de vértices en sentido opuesto
  {
    const F = editableMesh.faces.length;
    const removed = new Uint8Array(F);
    const sigGroups = new Map();
    const normals = new Array(F);
    for (let fi = 0; fi < F; fi++) {
      const f = editableMesh.faces[fi];
      normals[fi] = computeFaceUnitNormal(f, verts);
      const sig = f.slice().sort((a, b) => a - b).join(',');
      let list = sigGroups.get(sig);
      if (!list) { list = []; sigGroups.set(sig, list); }
      list.push(fi);
    }
    let dropped = 0;
    for (const list of sigGroups.values()) {
      if (list.length < 2) continue;
      for (let i = 0; i < list.length; i++) {
        const fa = list[i];
        if (removed[fa] || !normals[fa]) continue;
        for (let j = i + 1; j < list.length; j++) {
          const fb = list[j];
          if (removed[fb] || !normals[fb]) continue;
          const dot = normals[fa].x * normals[fb].x + normals[fa].y * normals[fb].y + normals[fa].z * normals[fb].z;
          if (dot < -0.5) {
            removed[fa] = 1;
            removed[fb] = 1;
            dropped += 2;
            break;
          } else if (dot > 0.8) {
            removed[fb] = 1;
            dropped += 1;
          }
        }
      }
    }
    if (dropped > 0) {
      const nextFaces = [];
      const nextUvs = [];
      const nextOrigins = faceOrigins ? [] : null;
      for (let fi = 0; fi < F; fi++) {
        if (removed[fi]) continue;
        nextFaces.push(editableMesh.faces[fi]);
        nextUvs.push(editableMesh.faceUvs[fi] || editableMesh.faces[fi].map(() => [0, 0]));
        if (nextOrigins) nextOrigins.push(faceOrigins[fi]);
      }
      editableMesh.faces = nextFaces;
      editableMesh.faceUvs = nextUvs;
      if (faceOrigins && nextOrigins) faceOrigins.splice(0, faceOrigins.length, ...nextOrigins);
      editableMesh.invalidateTopology();
      removedTotal += dropped;
    }
  }

  // 2. Poda voraz basada en reducción de defecto de arista:
  // Elimina pestañas colgantes y triángulos puente en aristas con >= 3 caras sin abrir mallas válidas.
  const edgeDefect = (c) => (c <= 0 || c === 2 ? 0 : c === 1 ? 1 : (c - 2) * 1.5);

  for (let pass = 0; pass < 16; pass++) {
    const F = editableMesh.faces.length;
    if (F < 3) break;
    const topo = editableMesh.getTopology();
    let hasNonManifold = false;
    for (let ei = 0; ei < topo.edges.length; ei++) {
      if (topo.edges[ei].faces.length >= 3) {
        hasNonManifold = true;
        break;
      }
    }
    if (!hasNonManifold) break;

    const edgeCounts = new Int32Array(topo.edges.length);
    for (let ei = 0; ei < topo.edges.length; ei++) {
      edgeCounts[ei] = topo.edges[ei].faces.length;
    }

    const candidates = [];
    const candidateSeen = new Uint8Array(F);
    for (let ei = 0; ei < topo.edges.length; ei++) {
      const e = topo.edges[ei];
      if (e.faces.length < 3) continue;
      for (let k = 0; k < e.faces.length; k++) {
        const fi = e.faces[k];
        if (candidateSeen[fi]) continue;
        candidateSeen[fi] = 1;
        const fe = topo.faceEdges[fi] || [];
        const uniqueEdges = [];
        const edgeSeen = new Set();
        let gain = 0;
        for (let m = 0; m < fe.length; m++) {
          const eIdx = fe[m];
          if (edgeSeen.has(eIdx)) continue;
          edgeSeen.add(eIdx);
          uniqueEdges.push(eIdx);
          const c = edgeCounts[eIdx];
          gain += edgeDefect(c) - edgeDefect(c - 1);
        }
        if (gain > 0.05) {
          candidates.push({
            fi,
            uniqueEdges,
            gain,
            wasTouched: faceOrigins?.[fi]?.wasTouched ? 1 : 0,
            areaSq: computeFaceAreaSq3D(editableMesh.faces[fi], verts),
          });
        }
      }
    }

    if (!candidates.length) break;
    candidates.sort((a, b) => {
      const dg = Math.round(b.gain * 100) - Math.round(a.gain * 100);
      if (dg !== 0) return dg;
      if (b.wasTouched !== a.wasTouched) return b.wasTouched - a.wasTouched;
      return a.areaSq - b.areaSq;
    });

    const removed = new Uint8Array(F);
    let removedHere = 0;
    for (let i = 0; i < candidates.length; i++) {
      const cand = candidates[i];
      let touchesNM = false;
      let curGain = 0;
      for (let m = 0; m < cand.uniqueEdges.length; m++) {
        const eIdx = cand.uniqueEdges[m];
        const c = edgeCounts[eIdx];
        if (c >= 3) touchesNM = true;
        curGain += edgeDefect(c) - edgeDefect(c - 1);
      }
      if (!touchesNM || curGain <= 0.05) continue;
      removed[cand.fi] = 1;
      removedHere++;
      for (let m = 0; m < cand.uniqueEdges.length; m++) {
        edgeCounts[cand.uniqueEdges[m]]--;
      }
    }

    if (!removedHere) break;
    removedTotal += removedHere;

    const nextFaces = [];
    const nextUvs = [];
    const nextOrigins = faceOrigins ? [] : null;
    for (let fi = 0; fi < F; fi++) {
      if (removed[fi]) continue;
      nextFaces.push(editableMesh.faces[fi]);
      nextUvs.push(editableMesh.faceUvs[fi] || editableMesh.faces[fi].map(() => [0, 0]));
      if (nextOrigins) nextOrigins.push(faceOrigins[fi]);
    }
    editableMesh.faces = nextFaces;
    editableMesh.faceUvs = nextUvs;
    if (faceOrigins && nextOrigins) faceOrigins.splice(0, faceOrigins.length, ...nextOrigins);
    editableMesh.invalidateTopology();
  }

  // 3. Sellar poros aislados de exactamente 3 aristas de borde (1 triángulo faltante)
  if (sealPinholes && editableMesh.faces.length >= 6) {
    const topo = editableMesh.getTopology();
    const bAdj = new Map();
    const addAdj = (u, v, fi) => {
      let arr = bAdj.get(u);
      if (!arr) { arr = []; bAdj.set(u, arr); }
      arr.push({ other: v, fi });
    };
    for (let ei = 0; ei < topo.edges.length; ei++) {
      const e = topo.edges[ei];
      if (e.faces.length !== 1) continue;
      addAdj(e.a, e.b, e.faces[0]);
      addAdj(e.b, e.a, e.faces[0]);
    }

    if (bAdj.size >= 3) {
      const existingTriSigs = new Set();
      for (let fi = 0; fi < editableMesh.faces.length; fi++) {
        const f = editableMesh.faces[fi];
        if (f.length === 3) {
          existingTriSigs.add(f.slice().sort((x, y) => x - y).join(','));
        }
      }
      const visitedTri = new Set();
      let added = 0;
      for (const [a, listA] of bAdj.entries()) {
        if (listA.length !== 2) continue;
        const b = listA[0].other;
        const c = listA[1].other;
        if (b === c || a === b || a === c) continue;
        const listB = bAdj.get(b);
        const listC = bAdj.get(c);
        if (!listB || !listC || listB.length !== 2 || listC.length !== 2) continue;
        if (!listB.some((x) => x.other === c)) continue;

        const sig = [a, b, c].sort((x, y) => x - y).join(',');
        if (visitedTri.has(sig) || existingTriSigs.has(sig)) continue;
        visitedTri.add(sig);

        // Determinar devanado opuesto a la cara adyacente sobre la arista (a, b)
        const adjFace = editableMesh.faces[listA[0].fi];
        const idxA = adjFace.indexOf(a);
        const nextV = adjFace[(idxA + 1) % adjFace.length];
        const newFace = nextV === b ? [b, a, c] : [a, b, c];
        if (computeFaceAreaSq3D(newFace, verts) <= 1e-16) continue;

        editableMesh.faces.push(newFace);
        editableMesh.faceUvs.push([[0, 0], [0, 0], [0, 0]]);
        if (faceOrigins) {
          faceOrigins.push({
            origFaceId: -1,
            shell: faceOrigins[listA[0].fi]?.shell ?? -1,
            wasTouched: true,
          });
        }
        existingTriSigs.add(sig);
        added++;
        sealedTotal++;
      }
      if (added > 0) editableMesh.invalidateTopology();
    }
  }

  return { removed: removedTotal, sealed: sealedTotal };
}

export function collapseTinySeamSlivers(editableMesh, faceOrigins = null, { maxEdgeLen = 1e-3 } = {}) {
  if (!editableMesh || editableMesh.faces.length < 4) return { collapsed: 0 };
  const verts = editableMesh.verts;

  const seamLengths = [];
  {
    const topo = editableMesh.getTopology();
    for (let ei = 0; ei < topo.edges.length; ei++) {
      const e = topo.edges[ei];
      if (faceOrigins && !faceOrigins[e.faces[0]]?.wasTouched && !faceOrigins[e.faces[1]]?.wasTouched) continue;
      const pa = verts[e.a], pb = verts[e.b];
      const len = Math.hypot(pb.x - pa.x, pb.y - pa.y, pb.z - pa.z);
      if (len > 1e-8) seamLengths.push(len);
    }
  }
  if (!seamLengths.length) return { collapsed: 0 };
  seamLengths.sort((a, b) => a - b);
  const medSeamLen = seamLengths[(seamLengths.length * 0.5) | 0];
  const sliverCut = Math.min(maxEdgeLen, medSeamLen * 0.18);
  const needleCut = Math.min(maxEdgeLen * 3.0, medSeamLen * 0.35);
  if (sliverCut <= 1e-7) return { collapsed: 0 };

  const triQualityInfo = (f) => {
    const p0 = verts[f[0]], p1 = verts[f[1]], p2 = verts[f[2]];
    const e01 = Math.hypot(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z);
    const e12 = Math.hypot(p2.x - p1.x, p2.y - p1.y, p2.z - p1.z);
    const e20 = Math.hypot(p0.x - p2.x, p0.y - p2.y, p0.z - p2.z);
    const e1x = p1.x - p0.x, e1y = p1.y - p0.y, e1z = p1.z - p0.z;
    const e2x = p2.x - p0.x, e2y = p2.y - p0.y, e2z = p2.z - p0.z;
    const cx = e1y * e2z - e1z * e2y;
    const cy = e1z * e2x - e1x * e2z;
    const cz = e1x * e2y - e1y * e2x;
    const area2 = Math.hypot(cx, cy, cz);
    const sumSq = e01 * e01 + e12 * e12 + e20 * e20;
    const maxProd = Math.max(e01 * e12, e12 * e20, e20 * e01);
    const q = sumSq > 1e-18 ? area2 / sumSq : 0;
    const sinSq = maxProd > 1e-12 ? (area2 * area2) / (maxProd * maxProd) : 0;
    return { q, sinSq, area2, minE: Math.min(e01, e12, e20), maxE: Math.max(e01, e12, e20) };
  };

  let totalCollapsed = 0;

  // Paso 0: Voltear diagonales entre pares de triángulos coplanares o casi planos tocados por el corte
  for (let fPass = 0; fPass < 3; fPass++) {
    const topo = editableMesh.getTopology();
    const V = verts.length;
    const vNbrs = Array.from({ length: V }, () => new Set());
    for (let ei = 0; ei < topo.edges.length; ei++) {
      const e = topo.edges[ei];
      vNbrs[e.a].add(e.b);
      vNbrs[e.b].add(e.a);
    }
    const faceTouched = new Uint8Array(editableMesh.faces.length);
    const fNormals = editableMesh.faces.map((f) => computeFaceUnitNormal(f, verts));
    let flips = 0;
    for (let ei = 0; ei < topo.edges.length; ei++) {
      const e = topo.edges[ei];
      if (e.faces.length !== 2) continue;
      const [fi0, fi1] = e.faces;
      if (faceTouched[fi0] || faceTouched[fi1]) continue;
      const f0 = editableMesh.faces[fi0], f1 = editableMesh.faces[fi1];
      if (!f0 || !f1 || f0.length !== 3 || f1.length !== 3) continue;
      if (faceOrigins && !faceOrigins[fi0]?.wasTouched && !faceOrigins[fi1]?.wasTouched) continue;
      if (faceOrigins && faceOrigins[fi0]?.shell !== faceOrigins[fi1]?.shell) continue;
      const n0 = fNormals[fi0], n1 = fNormals[fi1];
      if (!n0 || !n1 || (n0.x * n1.x + n0.y * n1.y + n0.z * n1.z) < 0.992) continue;

      const iu0 = f0.indexOf(e.a), iv0 = f0.indexOf(e.b);
      if (iu0 < 0 || iv0 < 0) continue;
      const uFirst = ((iu0 + 1) % 3) === iv0;
      const a = uFirst ? e.a : e.b;
      const b = uFirst ? e.b : e.a;
      const c = f0[3 - f0.indexOf(a) - f0.indexOf(b)];
      const d = f1[3 - f1.indexOf(a) - f1.indexOf(b)];
      if (c === d || vNbrs[c].has(d)) continue;

      const q0 = triQualityInfo(f0);
      const q1 = triQualityInfo(f1);
      const minSinBefore = Math.min(q0.sinSq, q1.sinSq);
      if (minSinBefore >= 0.03) continue; // ya tiene ángulo >= ~10°

      const nf0 = [a, d, c], nf1 = [d, b, c];
      const nn0 = computeFaceUnitNormal(nf0, verts);
      const nn1 = computeFaceUnitNormal(nf1, verts);
      if (!nn0 || !nn1) continue;
      if (nn0.x * n0.x + nn0.y * n0.y + nn0.z * n0.z < 0.985) continue;
      if (nn1.x * n1.x + nn1.y * n1.y + nn1.z * n1.z < 0.985) continue;
      const nq0 = triQualityInfo(nf0);
      const nq1 = triQualityInfo(nf1);
      const minSinAfter = Math.min(nq0.sinSq, nq1.sinSq);
      if (minSinAfter <= minSinBefore * 1.4) continue;

      const uv0 = editableMesh.faceUvs[fi0] || [[0, 0], [0, 0], [0, 0]];
      const uv1 = editableMesh.faceUvs[fi1] || [[0, 0], [0, 0], [0, 0]];
      const getUv = (face, uvs, vi) => {
        const idx = face.indexOf(vi);
        return idx >= 0 && uvs[idx] ? uvs[idx].slice() : [0, 0];
      };
      const uvA = getUv(f0, uv0, a), uvB = getUv(f0, uv0, b), uvC = getUv(f0, uv0, c), uvD = getUv(f1, uv1, d);
      editableMesh.faces[fi0] = nf0;
      editableMesh.faceUvs[fi0] = [uvA, uvD, uvC];
      editableMesh.faces[fi1] = nf1;
      editableMesh.faceUvs[fi1] = [uvD.slice(), uvB, uvC.slice()];
      if (faceOrigins?.[fi0]) faceOrigins[fi0].wasTouched = true;
      if (faceOrigins?.[fi1]) faceOrigins[fi1].wasTouched = true;
      vNbrs[a].delete(b); vNbrs[b].delete(a);
      vNbrs[c].add(d); vNbrs[d].add(c);
      faceTouched[fi0] = 1; faceTouched[fi1] = 1;
      flips++;
    }
    if (!flips) break;
    editableMesh.invalidateTopology();
  }

  for (let pass = 0; pass < 6; pass++) {
    const topo = editableMesh.getTopology();
    const V = verts.length;
    const F = editableMesh.faces.length;

    const isBoundaryVert = new Uint8Array(V);
    const isSeamVert = new Uint8Array(V);
    const isSharpCorner = new Uint8Array(V);
    const vertNeighbors = Array.from({ length: V }, () => new Set());
    const faceNormals = new Array(F);
    for (let fi = 0; fi < F; fi++) {
      faceNormals[fi] = computeFaceUnitNormal(editableMesh.faces[fi], verts);
    }

    const sharpEdgeDeg = new Int32Array(V);
    for (let ei = 0; ei < topo.edges.length; ei++) {
      const e = topo.edges[ei];
      vertNeighbors[e.a].add(e.b);
      vertNeighbors[e.b].add(e.a);
      if (e.faces.length !== 2) {
        isBoundaryVert[e.a] = 1;
        isBoundaryVert[e.b] = 1;
      } else {
        const na = faceNormals[e.faces[0]], nb = faceNormals[e.faces[1]];
        if (na && nb && (na.x * nb.x + na.y * nb.y + na.z * nb.z) < 0.65) {
          sharpEdgeDeg[e.a]++;
          sharpEdgeDeg[e.b]++;
        }
      }
    }
    for (let vi = 0; vi < V; vi++) {
      if (sharpEdgeDeg[vi] >= 3) isSharpCorner[vi] = 1;
    }

    if (faceOrigins) {
      for (let vi = 0; vi < V; vi++) {
        const inc = topo.vertFaces[vi] || [];
        let firstShell = -1;
        for (let i = 0; i < inc.length; i++) {
          const sh = faceOrigins[inc[i]]?.shell ?? -1;
          if (sh < 0) continue;
          if (firstShell < 0) firstShell = sh;
          else if (sh !== firstShell) { isSeamVert[vi] = 1; break; }
        }
      }
    }

    const triInfo = new Array(F);
    for (let fi = 0; fi < F; fi++) {
      if (editableMesh.faces[fi].length === 3) {
        triInfo[fi] = triQualityInfo(editableMesh.faces[fi]);
      }
    }

    const candidates = [];
    for (let ei = 0; ei < topo.edges.length; ei++) {
      const e = topo.edges[ei];
      if (e.faces.length !== 2) continue;
      if (isBoundaryVert[e.a] || isBoundaryVert[e.b]) continue;
      const fa = e.faces[0], fb = e.faces[1];
      if (fa === fb) continue;
      const lenA = editableMesh.faces[fa].length;
      const lenB = editableMesh.faces[fb].length;
      if (lenA < 3 || lenB < 3) continue;
      if (faceOrigins && !faceOrigins[fa]?.wasTouched && !faceOrigins[fb]?.wasTouched) continue;
      const pa = verts[e.a], pb = verts[e.b];
      const len = Math.hypot(pb.x - pa.x, pb.y - pa.y, pb.z - pa.z);

      const isSharpTri =
        (triInfo[fa] && triInfo[fa].sinSq < 0.06 && Math.abs(len - triInfo[fa].minE) < 1e-7) ||
        (triInfo[fb] && triInfo[fb].sinSq < 0.06 && Math.abs(len - triInfo[fb].minE) < 1e-7);

      if (len < sliverCut || (isSharpTri && len < needleCut)) {
        candidates.push({ ei, u: e.a, v: e.b, fa, fb, len });
      }
    }

    if (!candidates.length) break;
    candidates.sort((a, b) => a.len - b.len);

    const dirtyVert = new Uint8Array(V);
    const droppedFace = new Uint8Array(F);

    let collapsedHere = 0;
    for (let i = 0; i < candidates.length; i++) {
      const { u, v, fa, fb } = candidates[i];
      if (dirtyVert[u] || dirtyVert[v] || droppedFace[fa] || droppedFace[fb]) continue;

      const fA = editableMesh.faces[fa];
      const fB = editableMesh.faces[fb];
      const bothTris = fA.length === 3 && fB.length === 3;
      const expectedCommon = (fA.length === 3 ? 1 : 0) + (fB.length === 3 ? 1 : 0);

      let commonCount = 0;
      const nu = vertNeighbors[u];
      const nv = vertNeighbors[v];
      for (const w of nu) {
        if (nv.has(w)) commonCount++;
      }
      if (commonCount !== expectedCommon) continue;

      if (isSharpCorner[u] && isSharpCorner[v]) continue;

      const seamU = isSeamVert[u], seamV = isSeamVert[v];
      const cornerU = isSharpCorner[u], cornerV = isSharpCorner[v];
      const ridgeU = sharpEdgeDeg[u] > 0, ridgeV = sharpEdgeDeg[v] > 0;
      const pu = verts[u], pv = verts[v];
      let target;
      if (cornerU && !cornerV) {
        target = { x: pu.x, y: pu.y, z: pu.z };
      } else if (!cornerU && cornerV) {
        target = { x: pv.x, y: pv.y, z: pv.z };
      } else if (seamU && !seamV) {
        target = { x: pu.x, y: pu.y, z: pu.z };
      } else if (!seamU && seamV) {
        target = { x: pv.x, y: pv.y, z: pv.z };
      } else if (ridgeU && !ridgeV) {
        target = { x: pu.x, y: pu.y, z: pu.z };
      } else if (!ridgeU && ridgeV) {
        target = { x: pv.x, y: pv.y, z: pv.z };
      } else {
        target = { x: (pu.x + pv.x) * 0.5, y: (pu.y + pv.y) * 0.5, z: (pu.z + pv.z) * 0.5 };
      }

      const dropF1 = fA.length === 3 ? fa : (fB.length === 3 ? fb : -1);
      const dropF2 = bothTris ? fb : -1;

      const incFaces = new Set([...(topo.vertFaces[u] || []), ...(topo.vertFaces[v] || [])]);
      let valid = true;
      for (const fi of incFaces) {
        if (fi === dropF1 || fi === dropF2 || droppedFace[fi]) continue;
        const oldN = faceNormals[fi];
        if (!oldN) { valid = false; break; }
        const f = editableMesh.faces[fi];
        // Si f contiene ambos u y v (ej. quad/N-gono cuando !bothTris), solo quedará kept en lugar de (u,v)
        const mapped = [];
        const seenMapped = new Set();
        for (let k = 0; k < f.length; k++) {
          const vi = f[k];
          const mv = (vi === u || vi === v) ? -1 : vi;
          if (mapped.length && mapped[mapped.length - 1] === mv) continue;
          if (mapped.length && mv === mapped[0] && k === f.length - 1) continue;
          if (seenMapped.has(mv)) { valid = false; break; }
          seenMapped.add(mv);
          mapped.push(mv);
        }
        if (!valid || mapped.length < 3) { valid = false; break; }
        const pts = mapped.map((vi) => (vi === -1 ? target : verts[vi]));
        let nx = 0, ny = 0, nz = 0;
        for (let k = 0; k < pts.length; k++) {
          const p = pts[k], q = pts[(k + 1) % pts.length];
          nx += (p.y - q.y) * (p.z + q.z);
          ny += (p.z - q.z) * (p.x + q.x);
          nz += (p.x - q.x) * (p.y + q.y);
        }
        const nl = Math.hypot(nx, ny, nz);
        if (nl < 1e-12) { valid = false; break; }
        const dot = (nx / nl) * oldN.x + (ny / nl) * oldN.y + (nz / nl) * oldN.z;
        if (dot <= 0.45) { valid = false; break; }
      }
      if (!valid) continue;

      const kept = Math.min(u, v);
      const drop = Math.max(u, v);
      verts[kept] = target;
      droppedFace[dropF1] = 1;
      if (dropF2 >= 0) droppedFace[dropF2] = 1;

      for (const fi of incFaces) {
        if (fi === dropF1 || fi === dropF2 || droppedFace[fi]) continue;
        const f = editableMesh.faces[fi];
        const fUv = editableMesh.faceUvs[fi];
        const nextIdx = [];
        const nextUv = fUv ? [] : null;
        for (let k = 0; k < f.length; k++) {
          const vi = f[k] === drop ? kept : f[k];
          if (nextIdx.length && nextIdx[nextIdx.length - 1] === vi) continue;
          if (nextIdx.length && vi === nextIdx[0] && k === f.length - 1) continue;
          nextIdx.push(vi);
          if (nextUv) nextUv.push((fUv[k] || [0, 0]).slice());
        }
        editableMesh.faces[fi] = nextIdx;
        if (nextUv) editableMesh.faceUvs[fi] = nextUv;
        if (faceOrigins?.[fi]) faceOrigins[fi].wasTouched = true;
      }

      dirtyVert[u] = 1;
      dirtyVert[v] = 1;
      for (const w of nu) dirtyVert[w] = 1;
      for (const w of nv) dirtyVert[w] = 1;
      collapsedHere++;
    }

    if (!collapsedHere) break;
    totalCollapsed += collapsedHere;

    const nextFaces = [];
    const nextUvs = [];
    const nextOrigins = faceOrigins ? [] : null;
    for (let fi = 0; fi < F; fi++) {
      if (droppedFace[fi]) continue;
      nextFaces.push(editableMesh.faces[fi]);
      nextUvs.push(editableMesh.faceUvs[fi] || editableMesh.faces[fi].map(() => [0, 0]));
      if (nextOrigins) nextOrigins.push(faceOrigins[fi]);
    }
    editableMesh.faces = nextFaces;
    editableMesh.faceUvs = nextUvs;
    if (faceOrigins && nextOrigins) faceOrigins.splice(0, faceOrigins.length, ...nextOrigins);
    editableMesh.invalidateTopology();
  }

  return { collapsed: totalCollapsed };
}

export function smoothUnionSeam(editableMesh, faceOrigins = null, seamSmooth = 0) {
  const s = Math.max(0, Math.min(1, Number(seamSmooth) || 0));
  if (s <= 0 || !editableMesh || editableMesh.faces.length < 4) {
    return { smoothed: false, refinedFaces: 0 };
  }
  if (!faceOrigins || faceOrigins.length !== editableMesh.faces.length) {
    return { smoothed: false, refinedFaces: 0 };
  }

  const collectSeamData = () => {
    const topo = editableMesh.getTopology();
    const seamVerts = new Set();
    const seamEdgeLens = [];
    for (let ei = 0; ei < topo.edges.length; ei++) {
      const e = topo.edges[ei];
      if (e.faces.length < 2) continue;
      let s0 = -1;
      let multiShell = false;
      for (let i = 0; i < e.faces.length; i++) {
        const sh = faceOrigins[e.faces[i]]?.shell ?? -1;
        if (sh < 0) continue;
        if (s0 < 0) s0 = sh;
        else if (sh !== s0) { multiShell = true; break; }
      }
      if (multiShell) {
        seamVerts.add(e.a);
        seamVerts.add(e.b);
        const pa = editableMesh.verts[e.a], pb = editableMesh.verts[e.b];
        const l = Math.hypot(pb.x - pa.x, pb.y - pa.y, pb.z - pa.z);
        if (l > 1e-8) seamEdgeLens.push(l);
      }
    }
    for (let vi = 0; vi < editableMesh.verts.length; vi++) {
      if (seamVerts.has(vi)) continue;
      const inc = topo.vertFaces[vi] || [];
      let s0 = -1;
      for (let i = 0; i < inc.length; i++) {
        const sh = faceOrigins[inc[i]]?.shell ?? -1;
        if (sh < 0) continue;
        if (s0 < 0) s0 = sh;
        else if (sh !== s0) { seamVerts.add(vi); break; }
      }
    }
    return { topo, seamVerts, seamEdgeLens };
  };

  let { topo, seamVerts, seamEdgeLens } = collectSeamData();
  if (!seamVerts.size) return { smoothed: false, refinedFaces: 0 };

  // 0. Triangular N-gonos (>=5 vértices) que tocan la costura para que el remallado sea válido
  {
    let splitNgons = false;
    const nextFaces = [];
    const nextUvs = [];
    const nextOrigins = [];
    for (let fi = 0; fi < editableMesh.faces.length; fi++) {
      const f = editableMesh.faces[fi];
      const fUv = editableMesh.faceUvs[fi] || f.map(() => [0, 0]);
      const orig = faceOrigins[fi] || { origFaceId: -1, shell: -1, wasTouched: false };
      if (f.length >= 5 && f.some((vi) => seamVerts.has(vi))) {
        const pts3D = f.map((vi) => editableMesh.verts[vi]);
        const basis = computePolygonBasis3D(pts3D);
        if (basis && basis.pts2D) {
          const tris2D = earClipSimplePoly(f.map((_, idx) => idx), basis.pts2D);
          if (tris2D.length) {
            splitNgons = true;
            for (let t = 0; t < tris2D.length; t++) {
              const [ia, ib, ic] = tris2D[t];
              nextFaces.push([f[ia], f[ib], f[ic]]);
              nextUvs.push([(fUv[ia] || [0, 0]).slice(), (fUv[ib] || [0, 0]).slice(), (fUv[ic] || [0, 0]).slice()]);
              nextOrigins.push({ origFaceId: -1, shell: orig.shell, wasTouched: true });
            }
            continue;
          }
        }
      }
      nextFaces.push(f);
      nextUvs.push(fUv);
      nextOrigins.push(orig);
    }
    if (splitNgons) {
      editableMesh.faces = nextFaces;
      editableMesh.faceUvs = nextUvs;
      faceOrigins.splice(0, faceOrigins.length, ...nextOrigins);
      editableMesh.invalidateTopology();
      ({ topo, seamVerts, seamEdgeLens } = collectSeamData());
    }
  }

  // Calcular escala de la malla y radio geodésico del collar de transición
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < editableMesh.verts.length; i++) {
    const p = editableMesh.verts[i];
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
  }
  const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1;
  seamEdgeLens.sort((a, b) => a - b);
  const medSeamLen = seamEdgeLens.length ? seamEdgeLens[(seamEdgeLens.length * 0.5) | 0] : diag * 0.03;
  const filletRadius = Math.max(diag * 0.015, Math.min(diag * 0.075, medSeamLen * (0.65 + 1.05 * s)));
  const bandRadius = filletRadius * 1.25;

  // Dijkstra geodésico desde los vértices de costura hasta maxRadius
  const computeGeodesicDist = (maxDist) => {
    const V = editableMesh.verts.length;
    const dist = new Float64Array(V);
    dist.fill(Infinity);
    const curTopo = editableMesh.getTopology();
    const heap = []; // min-heap [d, vi]
    const pushHeap = (d, vi) => {
      heap.push([d, vi]);
      let idx = heap.length - 1;
      while (idx > 0) {
        const p = (idx - 1) >> 1;
        if (heap[p][0] <= heap[idx][0]) break;
        const tmp = heap[p]; heap[p] = heap[idx]; heap[idx] = tmp;
        idx = p;
      }
    };
    const popHeap = () => {
      const top = heap[0];
      const last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let idx = 0;
        const n = heap.length;
        while (true) {
          let best = idx;
          const l = idx * 2 + 1, r = idx * 2 + 2;
          if (l < n && heap[l][0] < heap[best][0]) best = l;
          if (r < n && heap[r][0] < heap[best][0]) best = r;
          if (best === idx) break;
          const tmp = heap[idx]; heap[idx] = heap[best]; heap[best] = tmp;
          idx = best;
        }
      }
      return top;
    };

    for (const vi of seamVerts) {
      if (vi >= 0 && vi < V) {
        dist[vi] = 0;
        pushHeap(0, vi);
      }
    }

    const verts = editableMesh.verts;
    while (heap.length) {
      const [du, u] = popHeap();
      if (du > dist[u] || du >= maxDist) continue;
      const incE = curTopo.vertEdges[u] || [];
      const pu = verts[u];
      for (let i = 0; i < incE.length; i++) {
        const e = curTopo.edges[incE[i]];
        if (!e) continue;
        const w = e.a === u ? e.b : e.a;
        const pw = verts[w];
        const nd = du + Math.hypot(pw.x - pu.x, pw.y - pu.y, pw.z - pu.z);
        if (nd < dist[w] && nd <= maxDist) {
          dist[w] = nd;
          pushHeap(nd, w);
        }
      }
    }
    return { dist, topo: curTopo };
  };

  // Detectar aristas agudas pre-existentes de las propias piezas (misma shell, dihedral < 0.68)
  // para evitar deformar filos de cajas o tapas de cilindros al suavizar la costura.
  const sharpFeatureEdges = new Set();
  const buildFeatureMaps = () => {
    const fNorms = editableMesh.faces.map((f) => computeFaceUnitNormal(f, editableMesh.verts));
    const vCount = editableMesh.verts.length;
    const featAdj = Array.from({ length: vCount }, () => []);
    for (let ei = 0; ei < topo.edges.length; ei++) {
      const e = topo.edges[ei];
      if (e.faces.length !== 2) continue;
      if (sharpFeatureEdges.has(e.key)) {
        featAdj[e.a].push(e.b);
        featAdj[e.b].push(e.a);
        continue;
      }
      const sh0 = faceOrigins[e.faces[0]]?.shell ?? -1;
      const sh1 = faceOrigins[e.faces[1]]?.shell ?? -1;
      if (sh0 < 0 || sh0 !== sh1) continue;
      const n0 = fNorms[e.faces[0]], n1 = fNorms[e.faces[1]];
      if (n0 && n1 && (n0.x * n1.x + n0.y * n1.y + n0.z * n1.z) < 0.68) {
        sharpFeatureEdges.add(e.key);
        featAdj[e.a].push(e.b);
        featAdj[e.b].push(e.a);
      }
    }
    return featAdj;
  };
  let featAdj = buildFeatureMaps();

  let { dist: geoDist } = computeGeodesicDist(bandRadius * 1.2);

  // 1. Subdividir quads en el collar geodésico y ejecutar remallado isotrópico local
  let refinedFaces = 0;
  {
    const nextFaces = [];
    const nextUvs = [];
    const nextOrigins = [];
    const verts = editableMesh.verts;
    const triQual = (a, b, c) => {
      const pa = verts[a], pb = verts[b], pc = verts[c];
      const e1x = pb.x - pa.x, e1y = pb.y - pa.y, e1z = pb.z - pa.z;
      const e2x = pc.x - pa.x, e2y = pc.y - pa.y, e2z = pc.z - pa.z;
      const cx = e1y * e2z - e1z * e2y;
      const cy = e1z * e2x - e1x * e2z;
      const cz = e1x * e2y - e1y * e2x;
      const area2 = Math.hypot(cx, cy, cz);
      const lSq = (e1x * e1x + e1y * e1y + e1z * e1z) + (e2x * e2x + e2y * e2y + e2z * e2z) +
        ((pc.x - pb.x) ** 2 + (pc.y - pb.y) ** 2 + (pc.z - pb.z) ** 2);
      return area2 / (lSq || 1e-12);
    };

    for (let fi = 0; fi < editableMesh.faces.length; fi++) {
      const f = editableMesh.faces[fi];
      const fUv = editableMesh.faceUvs[fi] || f.map(() => [0, 0]);
      const orig = faceOrigins[fi] || { origFaceId: -1, shell: -1, wasTouched: false };
      if (f.length === 4 && f.some((vi) => geoDist[vi] <= bandRadius * 1.55)) {
        const q02 = Math.min(triQual(f[0], f[1], f[2]), triQual(f[0], f[2], f[3]));
        const q13 = Math.min(triQual(f[1], f[2], f[3]), triQual(f[1], f[3], f[0]));
        const u0 = fUv[0] || [0, 0], u1 = fUv[1] || [0, 0], u2 = fUv[2] || [0, 0], u3 = fUv[3] || [0, 0];
        if (q02 >= q13) {
          nextFaces.push([f[0], f[1], f[2]], [f[0], f[2], f[3]]);
          nextUvs.push([u0.slice(), u1.slice(), u2.slice()], [u0.slice(), u2.slice(), u3.slice()]);
        } else {
          nextFaces.push([f[1], f[2], f[3]], [f[1], f[3], f[0]]);
          nextUvs.push([u1.slice(), u2.slice(), u3.slice()], [u1.slice(), u3.slice(), u0.slice()]);
        }
        nextOrigins.push({ origFaceId: -1, shell: orig.shell, wasTouched: true }, { origFaceId: -1, shell: orig.shell, wasTouched: true });
        refinedFaces++;
      } else {
        nextFaces.push(f);
        nextUvs.push(fUv);
        nextOrigins.push(orig);
      }
    }
    if (refinedFaces > 0) {
      editableMesh.faces = nextFaces;
      editableMesh.faceUvs = nextUvs;
      faceOrigins.splice(0, faceOrigins.length, ...nextOrigins);
      editableMesh.invalidateTopology();
      ({ topo, seamVerts } = collectSeamData());
      ({ dist: geoDist } = computeGeodesicDist(bandRadius));
      featAdj = buildFeatureMaps();
    }
  }

  // Remallado isotrópico local dentro de geoDist <= bandRadius (Edge Split -> Collapse -> Edge Flip -> Tangential Relax)
  const targetLen = Math.max(diag * 0.008, Math.min(filletRadius * 0.42, medSeamLen * 1.05));
  const remeshIters = 5;
  for (let rIter = 0; rIter < remeshIters; rIter++) {
    if (editableMesh.faces.length >= 35000) break;

    // A) Edge Split en aristas largas dentro de la banda (intercalado con colapso y volteo en cada iteración)
    {
      ({ dist: geoDist, topo } = computeGeodesicDist(bandRadius * 1.15));
      const maxLen = targetLen * 1.42;
      const splitMap = new Map(); // edgeKey -> { u, v, midVi }
      for (let ei = 0; ei < topo.edges.length; ei++) {
        const e = topo.edges[ei];
        if (e.faces.length !== 2) continue;
        const fa = editableMesh.faces[e.faces[0]], fb = editableMesh.faces[e.faces[1]];
        if (!fa || !fb || fa.length !== 3 || fb.length !== 3) continue;
        const pa = editableMesh.verts[e.a], pb = editableMesh.verts[e.b];
        const len = Math.hypot(pb.x - pa.x, pb.y - pa.y, pb.z - pa.z);
        const endInBand = geoDist[e.a] <= bandRadius || geoDist[e.b] <= bandRadius;
        if (!endInBand) {
          if (len <= maxLen * 1.55) continue;
          const oppInBand =
            fa.some((vi) => geoDist[vi] <= bandRadius * 1.05) ||
            fb.some((vi) => geoDist[vi] <= bandRadius * 1.05);
          if (!oppInBand) continue;
        } else if (len <= maxLen) {
          continue;
        }
        const midVi = editableMesh.verts.length;
        editableMesh.verts.push({
          x: (pa.x + pb.x) * 0.5,
          y: (pa.y + pb.y) * 0.5,
          z: (pa.z + pb.z) * 0.5,
        });
        if (sharpFeatureEdges.has(e.key)) {
          sharpFeatureEdges.delete(e.key);
          sharpFeatureEdges.add(edgeKey(e.a, midVi));
          sharpFeatureEdges.add(edgeKey(midVi, e.b));
        }
        splitMap.set(e.key, { u: e.a, v: e.b, midVi });
      }

      if (splitMap.size > 0 && editableMesh.faces.length + splitMap.size * 2 < 35000) {

      const nextFaces = [];
      const nextUvs = [];
      const nextOrigins = [];
      const distSqV = (vi, vj) => {
        const a = editableMesh.verts[vi], b = editableMesh.verts[vj];
        return (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;
      };
      for (let fi = 0; fi < editableMesh.faces.length; fi++) {
        const f = editableMesh.faces[fi];
        const fUv = editableMesh.faceUvs[fi] || f.map(() => [0, 0]);
        const orig = faceOrigins[fi] || { origFaceId: -1, shell: -1, wasTouched: false };
        if (f.length !== 3) {
          nextFaces.push(f); nextUvs.push(fUv); nextOrigins.push(orig);
          continue;
        }
        const splits = new Array(3);
        let cnt = 0;
        for (let k = 0; k < 3; k++) {
          const sp = splitMap.get(edgeKey(f[k], f[(k + 1) % 3]));
          if (sp) {
            const ua = fUv[k] || [0, 0], ub = fUv[(k + 1) % 3] || [0, 0];
            splits[k] = { midVi: sp.midVi, uv: [(ua[0] + ub[0]) * 0.5, (ua[1] + ub[1]) * 0.5] };
            cnt++;
          } else {
            splits[k] = null;
          }
        }
        if (cnt === 0) {
          nextFaces.push(f); nextUvs.push(fUv); nextOrigins.push(orig);
          continue;
        }
        refinedFaces++;
        const pushTri = (vertsArr, uvsArr) => {
          nextFaces.push(vertsArr);
          nextUvs.push(uvsArr);
          nextOrigins.push({ origFaceId: -1, shell: orig.shell, wasTouched: true });
        };
        const [v0, v1, v2] = f;
        const [u0, u1, u2] = [fUv[0] || [0, 0], fUv[1] || [0, 0], fUv[2] || [0, 0]];
        const [s0, s1, s2] = splits;
        if (cnt === 3) {
          pushTri([v0, s0.midVi, s2.midVi], [u0.slice(), s0.uv.slice(), s2.uv.slice()]);
          pushTri([s0.midVi, v1, s1.midVi], [s0.uv.slice(), u1.slice(), s1.uv.slice()]);
          pushTri([s2.midVi, s1.midVi, v2], [s2.uv.slice(), s1.uv.slice(), u2.slice()]);
          pushTri([s0.midVi, s1.midVi, s2.midVi], [s0.uv.slice(), s1.uv.slice(), s2.uv.slice()]);
        } else if (cnt === 2) {
          const rot = !s1 ? 0 : (!s2 ? 1 : 2);
          const rv = [f[rot], f[(rot + 1) % 3], f[(rot + 2) % 3]];
          const ru = [fUv[rot] || [0, 0], fUv[(rot + 1) % 3] || [0, 0], fUv[(rot + 2) % 3] || [0, 0]];
          const sa = splits[rot], sb = splits[(rot + 2) % 3];
          pushTri([rv[0], sa.midVi, sb.midVi], [ru[0].slice(), sa.uv.slice(), sb.uv.slice()]);
          if (distSqV(sa.midVi, rv[2]) <= distSqV(sb.midVi, rv[1])) {
            pushTri([sa.midVi, rv[1], rv[2]], [sa.uv.slice(), ru[1].slice(), ru[2].slice()]);
            pushTri([sa.midVi, rv[2], sb.midVi], [sa.uv.slice(), ru[2].slice(), sb.uv.slice()]);
          } else {
            pushTri([sa.midVi, rv[1], sb.midVi], [sa.uv.slice(), ru[1].slice(), sb.uv.slice()]);
            pushTri([sb.midVi, rv[1], rv[2]], [sb.uv.slice(), ru[1].slice(), ru[2].slice()]);
          }
        } else {
          const rot = s0 ? 0 : (s1 ? 1 : 2);
          const rv = [f[rot], f[(rot + 1) % 3], f[(rot + 2) % 3]];
          const ru = [fUv[rot] || [0, 0], fUv[(rot + 1) % 3] || [0, 0], fUv[(rot + 2) % 3] || [0, 0]];
          const sm = splits[rot];
          pushTri([rv[0], sm.midVi, rv[2]], [ru[0].slice(), sm.uv.slice(), ru[2].slice()]);
          pushTri([sm.midVi, rv[1], rv[2]], [sm.uv.slice(), ru[1].slice(), ru[2].slice()]);
        }
      }
        editableMesh.faces = nextFaces;
        editableMesh.faceUvs = nextUvs;
        faceOrigins.splice(0, faceOrigins.length, ...nextOrigins);
        editableMesh.invalidateTopology();
        ({ topo, seamVerts } = collectSeamData());
        featAdj = buildFeatureMaps();
      }
    }

    // B) Colapso de aristas cortas o esquirlas dentro de la banda
    ({ dist: geoDist, topo } = computeGeodesicDist(bandRadius));
    const V = editableMesh.verts.length;
    const minLen = targetLen * 0.42;
    const sliverLenCap = targetLen * 0.78;
    const isBoundaryVert = new Uint8Array(V);
    const vertNeighbors = Array.from({ length: V }, () => new Set());
    for (let ei = 0; ei < topo.edges.length; ei++) {
      const e = topo.edges[ei];
      vertNeighbors[e.a].add(e.b);
      vertNeighbors[e.b].add(e.a);
      if (e.faces.length !== 2) {
        isBoundaryVert[e.a] = 1;
        isBoundaryVert[e.b] = 1;
      }
    }
    const faceNormals = editableMesh.faces.map((f) => computeFaceUnitNormal(f, editableMesh.verts));
    const triQCol = (f) => {
      if (!f || f.length !== 3) return 1;
      const p0 = editableMesh.verts[f[0]], p1 = editableMesh.verts[f[1]], p2 = editableMesh.verts[f[2]];
      const e1x = p1.x - p0.x, e1y = p1.y - p0.y, e1z = p1.z - p0.z;
      const e2x = p2.x - p0.x, e2y = p2.y - p0.y, e2z = p2.z - p0.z;
      const area2 = Math.hypot(e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x);
      const l01 = e1x * e1x + e1y * e1y + e1z * e1z;
      const l20 = e2x * e2x + e2y * e2y + e2z * e2z;
      const l12 = (p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2 + (p2.z - p1.z) ** 2;
      return area2 / ((l01 + l20 + l12) || 1e-12);
    };
    const droppedFace = new Uint8Array(editableMesh.faces.length);
    const dirtyVert = new Uint8Array(V);
    const candidates = [];
    for (let ei = 0; ei < topo.edges.length; ei++) {
      const e = topo.edges[ei];
      if (e.faces.length !== 2) continue;
      if (isBoundaryVert[e.a] || isBoundaryVert[e.b]) continue;
      if (Math.min(geoDist[e.a], geoDist[e.b]) > bandRadius * 0.94) continue;
      const fa = editableMesh.faces[e.faces[0]], fb = editableMesh.faces[e.faces[1]];
      if (!fa || !fb || fa.length !== 3 || fb.length !== 3) continue;
      const pa = editableMesh.verts[e.a], pb = editableMesh.verts[e.b];
      const len = Math.hypot(pb.x - pa.x, pb.y - pa.y, pb.z - pa.z);
      const isBadSliver = Math.min(triQCol(fa), triQCol(fb)) < 0.045;
      if (len < minLen || (isBadSliver && len < sliverLenCap)) candidates.push({ ei, len });
    }
    candidates.sort((x, y) => x.len - y.len);
    let collapsedHere = 0;
    for (let ci = 0; ci < candidates.length; ci++) {
      const e = topo.edges[candidates[ci].ei];
      const u = e.a, v = e.b;
      if (dirtyVert[u] || dirtyVert[v]) continue;
      const [fa, fb] = e.faces;
      if (droppedFace[fa] || droppedFace[fb]) continue;

      const fDegU = featAdj[u]?.length || 0;
      const fDegV = featAdj[v]?.length || 0;
      // Proteger esquinas rígidas fuera de la costura
      if ((fDegU >= 3 && !seamVerts.has(u)) && (fDegV >= 3 && !seamVerts.has(v))) continue;

      let common = 0;
      const nu = vertNeighbors[u], nv = vertNeighbors[v];
      for (const w of nu) {
        if (nv.has(w)) common++;
      }
      if (common !== 2) continue;

      const seamU = seamVerts.has(u), seamV = seamVerts.has(v);
      const pu = editableMesh.verts[u], pv = editableMesh.verts[v];
      let target;
      if (fDegU >= 3 && !seamU) target = { x: pu.x, y: pu.y, z: pu.z };
      else if (fDegV >= 3 && !seamV) target = { x: pv.x, y: pv.y, z: pv.z };
      else if (seamU && !seamV) target = { x: pu.x, y: pu.y, z: pu.z };
      else if (!seamU && seamV) target = { x: pv.x, y: pv.y, z: pv.z };
      else if (fDegU > 0 && fDegV === 0) target = { x: pu.x, y: pu.y, z: pu.z };
      else if (fDegV > 0 && fDegU === 0) target = { x: pv.x, y: pv.y, z: pv.z };
      else target = { x: (pu.x + pv.x) * 0.5, y: (pu.y + pv.y) * 0.5, z: (pu.z + pv.z) * 0.5 };

      const incFaces = new Set([...(topo.vertFaces[u] || []), ...(topo.vertFaces[v] || [])]);
      let valid = true;
      for (const fi of incFaces) {
        if (fi === fa || fi === fb || droppedFace[fi]) continue;
        const oldN = faceNormals[fi];
        if (!oldN) { valid = false; break; }
        const f = editableMesh.faces[fi];
        const pts = f.map((vi) => ((vi === u || vi === v) ? target : editableMesh.verts[vi]));
        const curN = computeFaceUnitNormal([0, 1, 2], pts);
        if (!curN || curN.x * oldN.x + curN.y * oldN.y + curN.z * oldN.z <= 0.4) {
          valid = false; break;
        }
      }
      if (!valid) continue;

      const kept = Math.min(u, v), drop = Math.max(u, v);
      editableMesh.verts[kept] = target;
      droppedFace[fa] = 1;
      droppedFace[fb] = 1;
      for (const fi of incFaces) {
        if (fi === fa || fi === fb || droppedFace[fi]) continue;
        const f = editableMesh.faces[fi];
        for (let k = 0; k < f.length; k++) {
          if (f[k] === drop) f[k] = kept;
        }
        if (faceOrigins[fi]) faceOrigins[fi].wasTouched = true;
      }
      // Remapear sharpFeatureEdges de drop -> kept
      if (sharpFeatureEdges.size > 0) {
        for (const ck of [...sharpFeatureEdges]) {
          const sep = ck.indexOf('_');
          const ca = Number(ck.slice(0, sep)), cb = Number(ck.slice(sep + 1));
          if (ca !== drop && cb !== drop) continue;
          sharpFeatureEdges.delete(ck);
          const na = ca === drop ? kept : ca;
          const nb = cb === drop ? kept : cb;
          if (na !== nb) sharpFeatureEdges.add(edgeKey(na, nb));
        }
      }
      dirtyVert[u] = 1; dirtyVert[v] = 1;
      for (const w of nu) dirtyVert[w] = 1;
      for (const w of nv) dirtyVert[w] = 1;
      collapsedHere++;
    }
    if (collapsedHere > 0) {
      const nextFaces = [], nextUvs = [], nextOrigins = [];
      for (let fi = 0; fi < editableMesh.faces.length; fi++) {
        if (droppedFace[fi]) continue;
        nextFaces.push(editableMesh.faces[fi]);
        nextUvs.push(editableMesh.faceUvs[fi] || editableMesh.faces[fi].map(() => [0, 0]));
        nextOrigins.push(faceOrigins[fi]);
      }
      editableMesh.faces = nextFaces;
      editableMesh.faceUvs = nextUvs;
      faceOrigins.splice(0, faceOrigins.length, ...nextOrigins);
      editableMesh.invalidateTopology();
      ({ topo, seamVerts } = collectSeamData());
      featAdj = buildFeatureMaps();
    }

    // C) Edge Flip guiado por eliminación de esquirlas + valencia (objetivo = 6) con guarda diedral (> 0.72)
    ({ dist: geoDist, topo } = computeGeodesicDist(bandRadius));
    const Vflip = editableMesh.verts.length;
    const deg = new Int32Array(Vflip);
    const vNeighbors = Array.from({ length: Vflip }, () => new Set());
    for (let ei = 0; ei < topo.edges.length; ei++) {
      const e = topo.edges[ei];
      deg[e.a]++; deg[e.b]++;
      vNeighbors[e.a].add(e.b);
      vNeighbors[e.b].add(e.a);
    }
    const faceTouched = new Uint8Array(editableMesh.faces.length);
    const vertsArr = editableMesh.verts;
    const triQuality = (p0, p1, p2) => {
      const e1x = p1.x - p0.x, e1y = p1.y - p0.y, e1z = p1.z - p0.z;
      const e2x = p2.x - p0.x, e2y = p2.y - p0.y, e2z = p2.z - p0.z;
      const cx = e1y * e2z - e1z * e2y;
      const cy = e1z * e2x - e1x * e2z;
      const cz = e1x * e2y - e1y * e2x;
      const area2 = Math.hypot(cx, cy, cz);
      if (area2 < 1e-12) return { q: 0, n: null };
      const sumSq =
        (e1x * e1x + e1y * e1y + e1z * e1z) +
        (e2x * e2x + e2y * e2y + e2z * e2z) +
        ((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2 + (p2.z - p1.z) ** 2);
      return { q: area2 / (sumSq || 1e-12), n: { x: cx / area2, y: cy / area2, z: cz / area2 } };
    };
    let flips = 0;
    for (let ei = 0; ei < topo.edges.length; ei++) {
      const e = topo.edges[ei];
      if (e.faces.length !== 2) continue;
      if (sharpFeatureEdges.has(e.key)) continue;
      if (geoDist[e.a] > bandRadius && geoDist[e.b] > bandRadius) continue;
      const [fi0, fi1] = e.faces;
      if (faceTouched[fi0] || faceTouched[fi1]) continue;
      const f0 = editableMesh.faces[fi0], f1 = editableMesh.faces[fi1];
      if (!f0 || !f1 || f0.length !== 3 || f1.length !== 3) continue;

      const iu0 = f0.indexOf(e.a), iv0 = f0.indexOf(e.b);
      if (iu0 < 0 || iv0 < 0) continue;
      const uFirstInF0 = ((iu0 + 1) % 3) === iv0;
      const a = uFirstInF0 ? e.a : e.b;
      const b = uFirstInF0 ? e.b : e.a;
      const c = f0[3 - f0.indexOf(a) - f0.indexOf(b)];
      const d = f1[3 - f1.indexOf(a) - f1.indexOf(b)];
      if (c === d || vNeighbors[c].has(d)) continue;
      if (deg[a] <= 3 || deg[b] <= 3) continue;

      const t0 = triQuality(vertsArr[a], vertsArr[b], vertsArr[c]);
      const t1 = triQuality(vertsArr[b], vertsArr[a], vertsArr[d]);
      const minQBefore = Math.min(t0.q, t1.q);
      const maxQBefore = Math.max(t0.q, t1.q);
      const n0 = triQuality(vertsArr[a], vertsArr[d], vertsArr[c]);
      const n1 = triQuality(vertsArr[d], vertsArr[b], vertsArr[c]);
      if (!n0.n || !n1.n) continue;
      if (n0.n.x * n1.n.x + n0.n.y * n1.n.y + n0.n.z * n1.n.z < 0.72) continue;

      const regularValid =
        t0.n && t1.n &&
        (t0.n.x * t1.n.x + t0.n.y * t1.n.y + t0.n.z * t1.n.z >= 0.72) &&
        (n0.n.x * t0.n.x + n0.n.y * t0.n.y + n0.n.z * t0.n.z >= 0.55) &&
        (n1.n.x * t1.n.x + n1.n.y * t1.n.y + n1.n.z * t1.n.z >= 0.55);

      let sliverValid = false;
      if (!regularValid && minQBefore < 0.03 && maxQBefore >= 0.01) {
        const refN = t0.q >= t1.q ? t0.n : t1.n;
        if (
          refN &&
          n0.n.x * refN.x + n0.n.y * refN.y + n0.n.z * refN.z >= 0.82 &&
          n1.n.x * refN.x + n1.n.y * refN.y + n1.n.z * refN.z >= 0.82 &&
          n0.n.x * n1.n.x + n0.n.y * n1.n.y + n0.n.z * n1.n.z >= 0.85 &&
          Math.min(n0.q, n1.q) >= Math.max(0.005, minQBefore * 2.5)
        ) {
          // Confirmar que los dos triángulos resultantes conservan la misma orientación alrededor de refN
          const pa = vertsArr[a], pb = vertsArr[b], pc = vertsArr[c], pd = vertsArr[d];
          const slivV = t0.q < t1.q ? pc : pd;
          const e1x = pb.x - pa.x, e1y = pb.y - pa.y, e1z = pb.z - pa.z;
          const e2x = slivV.x - pa.x, e2y = slivV.y - pa.y, e2z = slivV.z - pa.z;
          const sgn = t0.q < t1.q ? 1 : -1;
          const cx = (e1y * e2z - e1z * e2y) * sgn;
          const cy = (e1z * e2x - e1x * e2z) * sgn;
          const cz = (e1x * e2y - e1y * e2x) * sgn;
          const refOpp = t0.q < t1.q ? pd : pc;
          const r1x = pb.x - pa.x, r1y = pb.y - pa.y, r1z = pb.z - pa.z;
          const r2x = refOpp.x - pa.x, r2y = refOpp.y - pa.y, r2z = refOpp.z - pa.z;
          const refArea2 = Math.hypot(r1y * r2z - r1z * r2y, r1z * r2x - r1x * r2z, r1x * r2y - r1y * r2x);
          if (cx * refN.x + cy * refN.y + cz * refN.z >= -0.05 * refArea2) {
            sliverValid = true;
          }
        }
      }
      if (!regularValid && !sliverValid) continue;

      const errBefore = (deg[a] - 6) ** 2 + (deg[b] - 6) ** 2 + (deg[c] - 6) ** 2 + (deg[d] - 6) ** 2;
      const errAfter = (deg[a] - 7) ** 2 + (deg[b] - 7) ** 2 + (deg[c] - 5) ** 2 + (deg[d] - 5) ** 2;
      const minQAfter = Math.min(n0.q, n1.q);
      if (minQAfter < minQBefore * 0.65) continue;
      const fixesSliver = sliverValid || (minQBefore < 0.14 && minQAfter > Math.max(minQBefore * 1.2, 0.05) && errAfter <= errBefore + 4) || minQAfter > minQBefore * 1.75;
      if (!fixesSliver && !(errAfter < errBefore || (errAfter === errBefore && minQAfter > minQBefore * 1.06))) continue;

      const uv0 = editableMesh.faceUvs[fi0] || [[0, 0], [0, 0], [0, 0]];
      const uv1 = editableMesh.faceUvs[fi1] || [[0, 0], [0, 0], [0, 0]];
      const getUv = (face, uvs, vi) => {
        const idx = face.indexOf(vi);
        return idx >= 0 && uvs[idx] ? uvs[idx].slice() : [0, 0];
      };
      const uvA = getUv(f0, uv0, a), uvB = getUv(f0, uv0, b), uvC = getUv(f0, uv0, c), uvD = getUv(f1, uv1, d);
      editableMesh.faces[fi0] = [a, d, c];
      editableMesh.faceUvs[fi0] = [uvA, uvD, uvC];
      editableMesh.faces[fi1] = [d, b, c];
      editableMesh.faceUvs[fi1] = [uvD.slice(), uvB, uvC.slice()];
      if (faceOrigins[fi0]) faceOrigins[fi0].wasTouched = true;
      if (faceOrigins[fi1]) faceOrigins[fi1].wasTouched = true;

      deg[a]--; deg[b]--; deg[c]++; deg[d]++;
      vNeighbors[a].delete(b); vNeighbors[b].delete(a);
      vNeighbors[c].add(d); vNeighbors[d].add(c);
      faceTouched[fi0] = 1; faceTouched[fi1] = 1;
      flips++;
    }
    if (flips > 0) {
      editableMesh.invalidateTopology();
      ({ topo, seamVerts } = collectSeamData());
    }

    // D) Relajación tangencial suave en la banda (preservando esquinas y filos)
    ({ dist: geoDist, topo } = computeGeodesicDist(bandRadius));
    featAdj = buildFeatureMaps();
    const Vrel = editableMesh.verts.length;
    const isBnd = new Uint8Array(Vrel);
    const vNbrs = Array.from({ length: Vrel }, () => new Set());
    for (let ei = 0; ei < topo.edges.length; ei++) {
      const e = topo.edges[ei];
      vNbrs[e.a].add(e.b); vNbrs[e.b].add(e.a);
      if (e.faces.length !== 2) { isBnd[e.a] = 1; isBnd[e.b] = 1; }
    }
    const fNormalsRel = editableMesh.faces.map((f) => computeFaceUnitNormal(f, editableMesh.verts));
    for (let vi = 0; vi < Vrel; vi++) {
      if (isBnd[vi] || geoDist[vi] >= bandRadius * 0.95) continue;
      const fList = featAdj[vi] || [];
      // Preservar filos rígidos originales de la pieza fuera de la costura booleana
      if (!seamVerts.has(vi) && fList.length > 0) continue;
      const nbrs = vNbrs[vi];
      if (!nbrs.size) continue;
      let ax = 0, ay = 0, az = 0;
      for (const w of nbrs) {
        const pw = editableMesh.verts[w];
        ax += pw.x; ay += pw.y; az += pw.z;
      }
      const inv = 1 / nbrs.size;
      ax *= inv; ay *= inv; az *= inv;
      const p = editableMesh.verts[vi];
      let dx = ax - p.x, dy = ay - p.y, dz = az - p.z;
      const incF = topo.vertFaces[vi] || [];
      if (seamVerts.has(vi) || fList.length === 0) {
        let vnx = 0, vny = 0, vnz = 0;
        for (let k = 0; k < incF.length; k++) {
          const fn = fNormalsRel[incF[k]];
          if (fn) { vnx += fn.x; vny += fn.y; vnz += fn.z; }
        }
        const vnl = Math.hypot(vnx, vny, vnz);
        if (vnl > 1e-6) {
          vnx /= vnl; vny /= vnl; vnz /= vnl;
          const proj = dx * vnx + dy * vny + dz * vnz;
          dx -= proj * vnx; dy -= proj * vny; dz -= proj * vnz;
        }
      }
      const faceAreaShape = (f) => {
        if (!f || f.length !== 3) return 1;
        const p0 = editableMesh.verts[f[0]], p1 = editableMesh.verts[f[1]], p2 = editableMesh.verts[f[2]];
        const e1x = p1.x - p0.x, e1y = p1.y - p0.y, e1z = p1.z - p0.z;
        const e2x = p2.x - p0.x, e2y = p2.y - p0.y, e2z = p2.z - p0.z;
        const area2 = Math.hypot(e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x);
        const sSq = (e1x * e1x + e1y * e1y + e1z * e1z) + (e2x * e2x + e2y * e2y + e2z * e2z) +
          ((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2 + (p2.z - p1.z) ** 2);
        return area2 / (sSq || 1e-12);
      };
      const preQRel = incF.map((fi) => faceAreaShape(editableMesh.faces[fi]));
      const ox = p.x, oy = p.y, oz = p.z;
      p.x = ox + dx * 0.35; p.y = oy + dy * 0.35; p.z = oz + dz * 0.35;
      const incE = topo.vertEdges[vi] || [];
      let flipped = false;
      const curNormRel = new Map();
      for (let k = 0; k < incF.length; k++) {
        const fi = incF[k];
        const refN = fNormalsRel[fi];
        if (!refN) continue;
        const curN = computeFaceUnitNormal(editableMesh.faces[fi], editableMesh.verts);
        if (!curN || curN.x * refN.x + curN.y * refN.y + curN.z * refN.z < 0.45) {
          flipped = true; break;
        }
        const qAfter = faceAreaShape(editableMesh.faces[fi]);
        if (qAfter < Math.min(preQRel[k] * 0.45, 0.02)) {
          flipped = true; break;
        }
        curNormRel.set(fi, curN);
      }
      if (!flipped) {
        for (let k = 0; k < incE.length; k++) {
          const e = topo.edges[incE[k]];
          if (!e || e.faces.length !== 2 || sharpFeatureEdges.has(e.key)) continue;
          const [fi0, fi1] = e.faces;
          const pre0 = fNormalsRel[fi0], pre1 = fNormalsRel[fi1];
          const preDot = pre0 && pre1 ? (pre0.x * pre1.x + pre0.y * pre1.y + pre0.z * pre1.z) : 1;
          const cn0 = curNormRel.get(fi0) || pre0;
          const cn1 = curNormRel.get(fi1) || pre1;
          const curDot = cn0 && cn1 ? (cn0.x * cn1.x + cn0.y * cn1.y + cn0.z * cn1.z) : 1;
          if (curDot < -0.1 && preDot > curDot + 0.02) {
            flipped = true; break;
          }
        }
      }
      if (flipped) { p.x = ox; p.y = oy; p.z = oz; }
    }
  }

  // 2. Suavizado HC-Smoothing (Vollmer 1999) con caída coseno geodésica y preservación de volumen y filos
  ({ topo, seamVerts } = collectSeamData());
  ({ dist: geoDist } = computeGeodesicDist(filletRadius));
  featAdj = buildFeatureMaps();

  const V = editableMesh.verts.length;
  const boundaryVert = new Uint8Array(V);
  for (let ei = 0; ei < topo.edges.length; ei++) {
    const e = topo.edges[ei];
    if (e.faces.length !== 2) {
      boundaryVert[e.a] = 1;
      boundaryVert[e.b] = 1;
    }
  }

  const smoothWeight = new Float32Array(V);
  const isFlatRing = new Uint8Array(V);
  const preSmoothFaceNormals = editableMesh.faces.map((f) => computeFaceUnitNormal(f, editableMesh.verts));
  const activeVerts = [];
  for (let vi = 0; vi < V; vi++) {
    const d = geoDist[vi];
    if (boundaryVert[vi] || d >= filletRadius) continue;
    const fDeg = featAdj[vi]?.length || 0;
    // Fijar esquinas y filos rígidos originales de la pieza fuera de la costura
    if (!seamVerts.has(vi) && fDeg > 0) continue;
    const w = 0.5 * (1 + Math.cos((Math.PI * d) / filletRadius));
    if (w > 1e-3) {
      smoothWeight[vi] = w;
      activeVerts.push(vi);
      if (!seamVerts.has(vi)) {
        const incF = topo.vertFaces[vi] || [];
        let minFD = 1;
        const fn0 = incF.length ? preSmoothFaceNormals[incF[0]] : null;
        if (fn0) {
          for (let k = 1; k < incF.length; k++) {
            const fnk = preSmoothFaceNormals[incF[k]];
            if (fnk) {
              const dt = fn0.x * fnk.x + fn0.y * fnk.y + fn0.z * fnk.z;
              if (dt < minFD) minFD = dt;
            }
          }
          if (minFD >= 0.992) isFlatRing[vi] = 1;
        }
      }
    }
  }

  if (!activeVerts.length) return { smoothed: refinedFaces > 0, refinedFaces };

  const activeFaceSet = new Set();
  const nbrSets = new Map();
  for (let i = 0; i < activeVerts.length; i++) {
    const vi = activeVerts[i];
    const incF = topo.vertFaces[vi] || [];
    for (let k = 0; k < incF.length; k++) activeFaceSet.add(incF[k]);
    const incE = topo.vertEdges[vi] || [];
    const sNbr = new Set();
    for (let k = 0; k < incE.length; k++) {
      const e = topo.edges[incE[k]];
      if (e) sNbr.add(e.a === vi ? e.b : e.a);
    }
    nbrSets.set(vi, [...sNbr]);
  }
  const activeFaces = [...activeFaceSet];

  const verts = editableMesh.verts;
  const origPos = verts.map((v) => ({ x: v.x, y: v.y, z: v.z }));

  const accumX = new Float64Array(V);
  const accumY = new Float64Array(V);
  const accumZ = new Float64Array(V);
  const accumW = new Float64Array(V);

  const smoothX = new Float64Array(V);
  const smoothY = new Float64Array(V);
  const smoothZ = new Float64Array(V);
  const bX = new Float64Array(V);
  const bY = new Float64Array(V);
  const bZ = new Float64Array(V);
  const nextX = new Float64Array(V);
  const nextY = new Float64Array(V);
  const nextZ = new Float64Array(V);

  const addEdgeCot = (u, v, w) => {
    const pu = verts[u], pv = verts[v];
    if (smoothWeight[u] > 0) {
      accumX[u] += pv.x * w; accumY[u] += pv.y * w; accumZ[u] += pv.z * w; accumW[u] += w;
    }
    if (smoothWeight[v] > 0) {
      accumX[v] += pu.x * w; accumY[v] += pu.y * w; accumZ[v] += pu.z * w; accumW[v] += w;
    }
  };

  const cotAt = (pa, pb, pc) => {
    const ax = pa.x - pc.x, ay = pa.y - pc.y, az = pa.z - pc.z;
    const bx = pb.x - pc.x, by = pb.y - pc.y, bz = pb.z - pc.z;
    const dot = ax * bx + ay * by + az * bz;
    const cx = ay * bz - az * by;
    const cy = az * bx - ax * bz;
    const cz = ax * by - ay * bx;
    const area2 = Math.hypot(cx, cy, cz);
    if (area2 < 1e-12) return 0.25;
    return Math.max(0.05, Math.min(8.0, dot / area2));
  };

  const alpha = 0.2;
  const beta = 0.6;
  const stepScale = 0.65 * (0.45 + 0.55 * Math.min(1, s / 0.5));
  const hcIters = Math.max(4, Math.round(5 + 12 * s));

  for (let it = 0; it < hcIters; it++) {
    // Guardar normales inmediatas previas al paso (nunca permitir pliegue hacia atrás)
    const preNormals = new Map();
    for (let i = 0; i < activeFaces.length; i++) {
      const fi = activeFaces[i];
      const n = computeFaceUnitNormal(editableMesh.faces[fi], verts);
      if (n) preNormals.set(fi, n);
    }

    for (let i = 0; i < activeVerts.length; i++) {
      const vi = activeVerts[i];
      accumX[vi] = 0; accumY[vi] = 0; accumZ[vi] = 0; accumW[vi] = 0;
      bX[vi] = 0; bY[vi] = 0; bZ[vi] = 0;
    }

    for (let i = 0; i < activeFaces.length; i++) {
      const f = editableMesh.faces[activeFaces[i]];
      const n = f.length;
      if (n === 3) {
        const i0 = f[0], i1 = f[1], i2 = f[2];
        const p0 = verts[i0], p1 = verts[i1], p2 = verts[i2];
        addEdgeCot(i0, i1, cotAt(p0, p1, p2));
        addEdgeCot(i1, i2, cotAt(p1, p2, p0));
        addEdgeCot(i2, i0, cotAt(p2, p0, p1));
      } else {
        for (let k = 0; k < n; k++) {
          addEdgeCot(f[k], f[(k + 1) % n], 0.5);
        }
      }
    }

    // Paso 1 HC: promedio Laplaciano cotangente & vector de corrección b[vi]
    for (let i = 0; i < activeVerts.length; i++) {
      const vi = activeVerts[i];
      const p = verts[vi];
      const op = origPos[vi];
      const wSum = accumW[vi];
      if (wSum <= 1e-10) {
        smoothX[vi] = p.x; smoothY[vi] = p.y; smoothZ[vi] = p.z;
        continue;
      }
      const sx = accumX[vi] / wSum;
      const sy = accumY[vi] / wSum;
      const sz = accumZ[vi] / wSum;
      smoothX[vi] = sx; smoothY[vi] = sy; smoothZ[vi] = sz;
      if (!isFlatRing[vi]) {
        bX[vi] = sx - (alpha * op.x + (1 - alpha) * p.x);
        bY[vi] = sy - (alpha * op.y + (1 - alpha) * p.y);
        bZ[vi] = sz - (alpha * op.z + (1 - alpha) * p.z);
      }
    }

    // Paso 2 HC: devolver volumen compensando en zonas curvas sin abultar paredes planas
    for (let i = 0; i < activeVerts.length; i++) {
      const vi = activeVerts[i];
      const p = verts[vi];
      let targetX = smoothX[vi];
      let targetY = smoothY[vi];
      let targetZ = smoothZ[vi];
      if (!isFlatRing[vi]) {
        const nbrs = nbrSets.get(vi) || [];
        let nbx = 0, nby = 0, nbz = 0;
        let nbCnt = 0;
        for (let k = 0; k < nbrs.length; k++) {
          const j = nbrs[k];
          if (isFlatRing[j]) continue;
          nbx += bX[j]; nby += bY[j]; nbz += bZ[j];
          nbCnt++;
        }
        const inv = nbCnt ? 1 / nbCnt : 0;
        targetX -= beta * bX[vi] + (1 - beta) * (nbx * inv);
        targetY -= beta * bY[vi] + (1 - beta) * (nby * inv);
        targetZ -= beta * bZ[vi] + (1 - beta) * (nbz * inv);
      }

      const blend = smoothWeight[vi] * stepScale;
      nextX[vi] = p.x + (targetX - p.x) * blend;
      nextY[vi] = p.y + (targetY - p.y) * blend;
      nextZ[vi] = p.z + (targetZ - p.z) * blend;
    }

    // Aplicar con verificación estricta de no-inversión y sin pellizcos diedrales
    for (let i = 0; i < activeVerts.length; i++) {
      const vi = activeVerts[i];
      const p = verts[vi];
      const ox = p.x, oy = p.y, oz = p.z;
      const tx = nextX[vi], ty = nextY[vi], tz = nextZ[vi];
      if (tx === ox && ty === oy && tz === oz) continue;
      const incF = topo.vertFaces[vi] || [];
      const incE = topo.vertEdges[vi] || [];

      const triShapeOf = (f) => {
        if (!f || f.length !== 3) return 1;
        const p0 = verts[f[0]], p1 = verts[f[1]], p2 = verts[f[2]];
        const e1x = p1.x - p0.x, e1y = p1.y - p0.y, e1z = p1.z - p0.z;
        const e2x = p2.x - p0.x, e2y = p2.y - p0.y, e2z = p2.z - p0.z;
        const area2 = Math.hypot(e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x);
        const sSq = (e1x * e1x + e1y * e1y + e1z * e1z) + (e2x * e2x + e2y * e2y + e2z * e2z) +
          ((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2 + (p2.z - p1.z) ** 2);
        return area2 / (sSq || 1e-12);
      };
      const preShapes = incF.map((fi) => triShapeOf(editableMesh.faces[fi]));
      let accepted = false;
      for (const frac of [1.0, 0.5]) {
        p.x = ox + (tx - ox) * frac;
        p.y = oy + (ty - oy) * frac;
        p.z = oz + (tz - oz) * frac;
        let flipped = false;
        const curFaceNorms = new Map();
        for (let k = 0; k < incF.length; k++) {
          const fi = incF[k];
          const refN = preNormals.get(fi);
          if (!refN) continue;
          const curN = computeFaceUnitNormal(editableMesh.faces[fi], verts);
          if (!curN || curN.x * refN.x + curN.y * refN.y + curN.z * refN.z < 0.35) {
            flipped = true;
            break;
          }
          const origN = preSmoothFaceNormals[fi];
          if (origN && curN.x * origN.x + curN.y * origN.y + curN.z * origN.z < -0.05) {
            flipped = true;
            break;
          }
          const qAfter = triShapeOf(editableMesh.faces[fi]);
          if (qAfter < Math.min(preShapes[k] * 0.45, 0.02)) {
            flipped = true;
            break;
          }
          curFaceNorms.set(fi, curN);
        }
        if (!flipped) {
          for (let k = 0; k < incE.length; k++) {
            const e = topo.edges[incE[k]];
            if (!e || e.faces.length !== 2 || sharpFeatureEdges.has(e.key)) continue;
            const [fi0, fi1] = e.faces;
            const pre0 = preNormals.get(fi0) || computeFaceUnitNormal(editableMesh.faces[fi0], verts);
            const pre1 = preNormals.get(fi1) || computeFaceUnitNormal(editableMesh.faces[fi1], verts);
            const preDot = pre0 && pre1 ? (pre0.x * pre1.x + pre0.y * pre1.y + pre0.z * pre1.z) : 1;
            const cn0 = curFaceNorms.get(fi0) || pre0;
            const cn1 = curFaceNorms.get(fi1) || pre1;
            const curDot = cn0 && cn1 ? (cn0.x * cn1.x + cn0.y * cn1.y + cn0.z * cn1.z) : 1;
            if (curDot < -0.05 && preDot >= curDot) {
              flipped = true;
              break;
            }
          }
        }
        if (!flipped) {
          accepted = true;
          break;
        }
      }
      if (!accepted) {
        p.x = ox; p.y = oy; p.z = oz;
      }
    }
  }

  // 3. Pulido final de aristas en la banda y halo coplanar para eliminar esquirlas tras suavizado HC
  for (let polPass = 0; polPass < 3; polPass++) {
    ({ dist: geoDist, topo } = computeGeodesicDist(bandRadius * 1.6));
    const Vpol = editableMesh.verts.length;
    const vNbrsPol = Array.from({ length: Vpol }, () => new Set());
    for (let ei = 0; ei < topo.edges.length; ei++) {
      const e = topo.edges[ei];
      vNbrsPol[e.a].add(e.b);
      vNbrsPol[e.b].add(e.a);
    }
    const triQPol = (p0, p1, p2) => {
      const e1x = p1.x - p0.x, e1y = p1.y - p0.y, e1z = p1.z - p0.z;
      const e2x = p2.x - p0.x, e2y = p2.y - p0.y, e2z = p2.z - p0.z;
      const cx = e1y * e2z - e1z * e2y;
      const cy = e1z * e2x - e1x * e2z;
      const cz = e1x * e2y - e1y * e2x;
      const area2 = Math.hypot(cx, cy, cz);
      if (area2 < 1e-12) return { q: 0, n: null };
      const sumSq =
        (e1x * e1x + e1y * e1y + e1z * e1z) +
        (e2x * e2x + e2y * e2y + e2z * e2z) +
        ((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2 + (p2.z - p1.z) ** 2);
      return { q: area2 / (sumSq || 1e-12), n: { x: cx / area2, y: cy / area2, z: cz / area2 } };
    };
    const vertsPol = editableMesh.verts;
    const faceTouchedPol = new Uint8Array(editableMesh.faces.length);
    let flippedPol = false;
    for (let ei = 0; ei < topo.edges.length; ei++) {
      const e = topo.edges[ei];
      if (e.faces.length !== 2 || sharpFeatureEdges.has(e.key)) continue;
      const [fi0, fi1] = e.faces;
      if (faceTouchedPol[fi0] || faceTouchedPol[fi1]) continue;
      const f0 = editableMesh.faces[fi0], f1 = editableMesh.faces[fi1];
      if (!f0 || !f1 || f0.length !== 3 || f1.length !== 3) continue;
      const inBand =
        geoDist[e.a] <= bandRadius * 1.5 ||
        geoDist[e.b] <= bandRadius * 1.5 ||
        f0.some((vi) => geoDist[vi] <= bandRadius * 1.5) ||
        f1.some((vi) => geoDist[vi] <= bandRadius * 1.5) ||
        Boolean(faceOrigins[fi0]?.wasTouched || faceOrigins[fi1]?.wasTouched);
      if (!inBand) continue;
      const iu0 = f0.indexOf(e.a), iv0 = f0.indexOf(e.b);
      if (iu0 < 0 || iv0 < 0) continue;
      const uFirst = ((iu0 + 1) % 3) === iv0;
      const a = uFirst ? e.a : e.b, b = uFirst ? e.b : e.a;
      const c = f0[3 - f0.indexOf(a) - f0.indexOf(b)];
      const d = f1[3 - f1.indexOf(a) - f1.indexOf(b)];
      if (c === d || vNbrsPol[c].has(d)) continue;
      const t0 = triQPol(vertsPol[a], vertsPol[b], vertsPol[c]);
      const t1 = triQPol(vertsPol[b], vertsPol[a], vertsPol[d]);
      const minQBefore = Math.min(t0.q, t1.q);
      if (minQBefore >= 0.14) continue;
      // Fuera de la banda directa solo corregir esquirlas muy estrechas coplanares
      const nearBand = geoDist[e.a] <= bandRadius * 1.5 || geoDist[e.b] <= bandRadius * 1.5;
      if (!nearBand && minQBefore >= 0.03) continue;
      const n0 = triQPol(vertsPol[a], vertsPol[d], vertsPol[c]);
      const n1 = triQPol(vertsPol[d], vertsPol[b], vertsPol[c]);
      if (!n0.n || !n1.n) continue;
      if (n0.n.x * n1.n.x + n0.n.y * n1.n.y + n0.n.z * n1.n.z < 0.78) continue;

      const regularPol =
        nearBand &&
        t0.n && t1.n &&
        t0.n.x * t1.n.x + t0.n.y * t1.n.y + t0.n.z * t1.n.z >= 0.86 &&
        n0.n.x * t0.n.x + n0.n.y * t0.n.y + n0.n.z * t0.n.z >= 0.72 &&
        n1.n.x * t1.n.x + n1.n.y * t1.n.y + n1.n.z * t1.n.z >= 0.72;

      let sliverPol = false;
      if (!regularPol && minQBefore < 0.03 && Math.max(t0.q, t1.q) >= 0.01) {
        const refN = t0.q >= t1.q ? t0.n : t1.n;
        if (
          refN &&
          n0.n.x * refN.x + n0.n.y * refN.y + n0.n.z * refN.z >= 0.84 &&
          n1.n.x * refN.x + n1.n.y * refN.y + n1.n.z * refN.z >= 0.84 &&
          n0.n.x * n1.n.x + n0.n.y * n1.n.y + n0.n.z * n1.n.z >= 0.86 &&
          Math.min(n0.q, n1.q) >= Math.max(0.005, minQBefore * 2.5)
        ) {
          const pa = vertsPol[a], pb = vertsPol[b], pc = vertsPol[c], pd = vertsPol[d];
          const slivV = t0.q < t1.q ? pc : pd;
          const e1x = pb.x - pa.x, e1y = pb.y - pa.y, e1z = pb.z - pa.z;
          const e2x = slivV.x - pa.x, e2y = slivV.y - pa.y, e2z = slivV.z - pa.z;
          const sgn = t0.q < t1.q ? 1 : -1;
          const cx = (e1y * e2z - e1z * e2y) * sgn;
          const cy = (e1z * e2x - e1x * e2z) * sgn;
          const cz = (e1x * e2y - e1y * e2x) * sgn;
          const refOpp = t0.q < t1.q ? pd : pc;
          const r2x = refOpp.x - pa.x, r2y = refOpp.y - pa.y, r2z = refOpp.z - pa.z;
          const refArea2 = Math.hypot(e1y * r2z - e1z * r2y, e1z * r2x - e1x * r2z, e1x * r2y - e1y * r2x);
          if (cx * refN.x + cy * refN.y + cz * refN.z >= -0.05 * refArea2) {
            sliverPol = true;
          }
        }
      }
      if (!regularPol && !sliverPol) continue;
      const minQAfter = Math.min(n0.q, n1.q);
      if (minQAfter <= minQBefore * 1.35) continue;
      const uv0 = editableMesh.faceUvs[fi0] || [[0, 0], [0, 0], [0, 0]];
      const uv1 = editableMesh.faceUvs[fi1] || [[0, 0], [0, 0], [0, 0]];
      const getUv = (face, uvs, vi) => {
        const idx = face.indexOf(vi);
        return idx >= 0 && uvs[idx] ? uvs[idx].slice() : [0, 0];
      };
      const uvA = getUv(f0, uv0, a), uvB = getUv(f0, uv0, b), uvC = getUv(f0, uv0, c), uvD = getUv(f1, uv1, d);
      editableMesh.faces[fi0] = [a, d, c];
      editableMesh.faceUvs[fi0] = [uvA, uvD, uvC];
      editableMesh.faces[fi1] = [d, b, c];
      editableMesh.faceUvs[fi1] = [uvD.slice(), uvB, uvC.slice()];
      if (faceOrigins[fi0]) faceOrigins[fi0].wasTouched = true;
      if (faceOrigins[fi1]) faceOrigins[fi1].wasTouched = true;
      vNbrsPol[a].delete(b); vNbrsPol[b].delete(a);
      vNbrsPol[c].add(d); vNbrsPol[d].add(c);
      faceTouchedPol[fi0] = 1; faceTouchedPol[fi1] = 1;
      flippedPol = true;
    }
    if (!flippedPol) break;
    editableMesh.invalidateTopology();
  }

  // 4. Limpiar durezas residuales en la costura suavizada para sombreado continuo
  if (editableMesh.creases && editableMesh.creases.size > 0) {
    for (const ck of [...editableMesh.creases.keys()]) {
      const sep = ck.indexOf('_');
      if (sep < 0) continue;
      const a = Number(ck.slice(0, sep));
      const b = Number(ck.slice(sep + 1));
      if (smoothWeight[a] > 0.25 && smoothWeight[b] > 0.25) {
        editableMesh.creases.delete(ck);
      }
    }
  }

  editableMesh.invalidateTopology();
  return { smoothed: true, refinedFaces };
}

// ============================================================================
// Unión Orgánica Única (SDF Smooth-Minimum + Surface Nets Disperso Todo-Quads)
// ============================================================================

function sminPoly(a, b, k) {
  if (k <= 1e-8) return a < b ? a : b;
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/**
 * Simplifica un EditableMesh hasta `targetVerts` usando QEM (Quadric Error Metrics) adaptativo por curvatura,
 * protección diédrica 1-ring + bordes abiertos (Garland-Heckbert), balanceo de valencia multietapa,
 * relajación tangencial respetando filos y re-emparejamiento a quads convexos planos.
 */
export function decimateMeshQEM(editableMesh, targetVerts, {
  preserveUvs = true,
  preserveCreases = true,
  protectBoundaries = true,
} = {}) {
  if (!editableMesh || !editableMesh.verts.length || !editableMesh.faces.length) {
    return { changed: false };
  }
  const origVertCount = editableMesh.verts.length;
  const clampedTarget = Math.max(4, Math.min(origVertCount - 1, Math.round(targetVerts)));
  if (origVertCount <= clampedTarget || origVertCount <= 5) {
    return { changed: false };
  }

  const outVerts = editableMesh.verts.map((v) => ({ x: v.x, y: v.y, z: v.z }));

  // 1. Triangular quads (diagonal más corta) y polígonos conservando UVs por esquina
  const qTris = [];
  const triUvs = [];
  const hasSourceUvs = preserveUvs && Array.isArray(editableMesh.faceUvs) && editableMesh.faceUvs.length === editableMesh.faces.length;

  for (let fi = 0; fi < editableMesh.faces.length; fi++) {
    const f = editableMesh.faces[fi];
    if (!f || f.length < 3) continue;
    const fUv = hasSourceUvs && Array.isArray(editableMesh.faceUvs[fi])
      ? editableMesh.faceUvs[fi]
      : f.map(() => [0, 0]);
    const uvAt = (idx) => {
      const u = fUv[idx];
      return u && Number.isFinite(u[0]) && Number.isFinite(u[1]) ? [u[0], u[1]] : [0, 0];
    };

    if (f.length === 3) {
      qTris.push([f[0], f[1], f[2]]);
      triUvs.push([uvAt(0), uvAt(1), uvAt(2)]);
    } else if (f.length === 4) {
      const p0 = outVerts[f[0]], p1 = outVerts[f[1]], p2 = outVerts[f[2]], p3 = outVerts[f[3]];
      const d02 = (p0.x - p2.x) ** 2 + (p0.y - p2.y) ** 2 + (p0.z - p2.z) ** 2;
      const d13 = (p1.x - p3.x) ** 2 + (p1.y - p3.y) ** 2 + (p1.z - p3.z) ** 2;
      if (d02 <= d13) {
        qTris.push([f[0], f[1], f[2]], [f[0], f[2], f[3]]);
        triUvs.push([uvAt(0), uvAt(1), uvAt(2)], [uvAt(0), uvAt(2), uvAt(3)]);
      } else {
        qTris.push([f[1], f[2], f[3]], [f[1], f[3], f[0]]);
        triUvs.push([uvAt(1), uvAt(2), uvAt(3)], [uvAt(1), uvAt(3), uvAt(0)]);
      }
    } else {
      for (let i = 1; i + 1 < f.length; i++) {
        qTris.push([f[0], f[i], f[i + 1]]);
        triUvs.push([uvAt(0), uvAt(i), uvAt(i + 1)]);
      }
    }
  }

  if (qTris.length < 4) return { changed: false };

  // 2. Mapear durezas de arista (creases) si existen
  const edgeCreases = new Map();
  if (preserveCreases && editableMesh.creases && editableMesh.creases.size > 0) {
    for (const [k, val] of editableMesh.creases.entries()) {
      if (val > 0.001) edgeCreases.set(k, val);
    }
  }
  const getCrease = (a, b) => (edgeCreases.size ? (edgeCreases.get(edgeKey(a, b)) || 0) : 0);

  // 3. Construir cuádricas Q (10 coeficientes simétricos por vértice) ponderadas por área
  const Vq = outVerts.length;
  const Q = new Float64Array(Vq * 10);
  const vertFaces = Array.from({ length: Vq }, () => new Set());
  const vertNbrs = Array.from({ length: Vq }, () => new Set());
  const aliveVert = new Uint8Array(Vq);
  aliveVert.fill(1);
  const aliveFace = new Uint8Array(qTris.length);
  aliveFace.fill(1);
  const vertStamp = new Int32Array(Vq);
  const edgeFaceCounts = new Map();

  let totalArea = 0;
  let totalEdgeLen = 0;
  let edgeSampleCount = 0;

  for (let ti = 0; ti < qTris.length; ti++) {
    const [a, b, c] = qTris[ti];
    if (a === b || b === c || c === a) {
      aliveFace[ti] = 0;
      continue;
    }
    vertFaces[a].add(ti); vertFaces[b].add(ti); vertFaces[c].add(ti);
    vertNbrs[a].add(b); vertNbrs[a].add(c);
    vertNbrs[b].add(a); vertNbrs[b].add(c);
    vertNbrs[c].add(a); vertNbrs[c].add(b);

    for (const [ea, eb] of [[a, b], [b, c], [c, a]]) {
      const ek = ea < eb ? `${ea}_${eb}` : `${eb}_${ea}`;
      const prev = edgeFaceCounts.get(ek);
      if (prev) prev.push(ti);
      else edgeFaceCounts.set(ek, [ti]);
    }

    const pa = outVerts[a], pb = outVerts[b], pc = outVerts[c];
    const e1x = pb.x - pa.x, e1y = pb.y - pa.y, e1z = pb.z - pa.z;
    const e2x = pc.x - pa.x, e2y = pc.y - pa.y, e2z = pc.z - pa.z;
    totalEdgeLen += Math.hypot(e1x, e1y, e1z) + Math.hypot(e2x, e2y, e2z);
    edgeSampleCount += 2;

    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    const area2 = Math.hypot(nx, ny, nz);
    if (area2 < 1e-14) continue;
    const area = area2 * 0.5;
    totalArea += area;
    const ux = nx / area2, uy = ny / area2, uz = nz / area2;
    const d = -(ux * pa.x + uy * pa.y + uz * pa.z);

    const q00 = ux * ux * area, q01 = ux * uy * area, q02 = ux * uz * area, q03 = ux * d * area;
    const q11 = uy * uy * area, q12 = uy * uz * area, q13 = uy * d * area;
    const q22 = uz * uz * area, q23 = uz * d * area, q33 = d * d * area;

    for (const vi of [a, b, c]) {
      const base = vi * 10;
      Q[base] += q00; Q[base + 1] += q01; Q[base + 2] += q02; Q[base + 3] += q03;
      Q[base + 4] += q11; Q[base + 5] += q12; Q[base + 6] += q13;
      Q[base + 7] += q22; Q[base + 8] += q23; Q[base + 9] += q33;
    }
  }

  // Marcar vértices en borde abierto y añadir planos de restricción perpendicular Garland-Heckbert
  const isBoundaryVert = new Uint8Array(Vq);
  if (protectBoundaries) {
    for (const [ek, fis] of edgeFaceCounts.entries()) {
      if (fis.length !== 1) continue;
      const fi = fis[0];
      const f = qTris[fi];
      const sep = ek.indexOf('_');
      const a = Number(ek.slice(0, sep));
      const b = Number(ek.slice(sep + 1));
      isBoundaryVert[a] = 1;
      isBoundaryVert[b] = 1;

      const pa = outVerts[a], pb = outVerts[b];
      const f0 = outVerts[f[0]], f1 = outVerts[f[1]], f2 = outVerts[f[2]];
      const fnx = (f1.y - f0.y) * (f2.z - f0.z) - (f1.z - f0.z) * (f2.y - f0.y);
      const fny = (f1.z - f0.z) * (f2.x - f0.x) - (f1.x - f0.x) * (f2.z - f0.z);
      const fnz = (f1.x - f0.x) * (f2.y - f0.y) - (f1.y - f0.y) * (f2.x - f0.x);
      const ex = pb.x - pa.x, ey = pb.y - pa.y, ez = pb.z - pa.z;
      const eLenSq = ex * ex + ey * ey + ez * ez;
      if (eLenSq < 1e-14) continue;
      let bx = ey * fnz - ez * fny;
      let by = ez * fnx - ex * fnz;
      let bz = ex * fny - ey * fnx;
      const bLen = Math.hypot(bx, by, bz);
      if (bLen < 1e-14) continue;
      bx /= bLen; by /= bLen; bz /= bLen;
      const bd = -(bx * pa.x + by * pa.y + bz * pa.z);
      const w = eLenSq * 4.0;
      for (const vi of [a, b]) {
        const base = vi * 10;
        Q[base] += bx * bx * w; Q[base + 1] += bx * by * w; Q[base + 2] += bx * bz * w; Q[base + 3] += bx * bd * w;
        Q[base + 4] += by * by * w; Q[base + 5] += by * bz * w; Q[base + 6] += by * bd * w;
        Q[base + 7] += bz * bz * w; Q[base + 8] += bz * bd * w; Q[base + 9] += bd * bd * w;
      }
    }
  }

  const avgEdgeLen = totalEdgeLen / Math.max(1, edgeSampleCount);
  const avgTriArea = totalArea / Math.max(1, qTris.length);
  const lenTieWeight = avgTriArea * 4e-3;
  const stepBoundSq = Math.max(1e-8, avgEdgeLen * avgEdgeLen * 4.0);

  const evalQArr = (q00, q01, q02, q03, q11, q12, q13, q22, q23, q33, x, y, z) => (
    q00 * x * x + 2 * q01 * x * y + 2 * q02 * x * z + 2 * q03 * x +
    q11 * y * y + 2 * q12 * y * z + 2 * q13 * y +
    q22 * z * z + 2 * q23 * z + q33
  );

  const computePairCost = (u, v) => {
    const bu = u * 10, bv = v * 10;
    const q00 = Q[bu] + Q[bv], q01 = Q[bu + 1] + Q[bv + 1], q02 = Q[bu + 2] + Q[bv + 2], q03 = Q[bu + 3] + Q[bv + 3];
    const q11 = Q[bu + 4] + Q[bv + 4], q12 = Q[bu + 5] + Q[bv + 5], q13 = Q[bu + 6] + Q[bv + 6];
    const q22 = Q[bu + 7] + Q[bv + 7], q23 = Q[bu + 8] + Q[bv + 8], q33 = Q[bu + 9] + Q[bv + 9];

    const pu = outVerts[u], pv = outVerts[v];
    const mx = (pu.x + pv.x) * 0.5, my = (pu.y + pv.y) * 0.5, mz = (pu.z + pv.z) * 0.5;
    const edgeLenSq = (pv.x - pu.x) ** 2 + (pv.y - pu.y) ** 2 + (pv.z - pu.z) ** 2;

    let bx = mx, by = my, bz = mz;
    let bestErr = evalQArr(q00, q01, q02, q03, q11, q12, q13, q22, q23, q33, mx, my, mz);

    const det =
      q00 * (q11 * q22 - q12 * q12) -
      q01 * (q01 * q22 - q12 * q02) +
      q02 * (q01 * q12 - q11 * q02);

    const tr = q00 + q11 + q22;
    if (Math.abs(det) > 1e-10 * tr * tr * tr) {
      const invDet = 1 / det;
      const sx = -(
        q03 * (q11 * q22 - q12 * q12) -
        q01 * (q13 * q22 - q12 * q23) +
        q02 * (q13 * q12 - q11 * q23)
      ) * invDet;
      const sy = -(
        q00 * (q13 * q22 - q12 * q23) -
        q03 * (q01 * q22 - q12 * q02) +
        q02 * (q01 * q23 - q13 * q02)
      ) * invDet;
      const sz = -(
        q00 * (q11 * q23 - q13 * q12) -
        q01 * (q01 * q23 - q13 * q02) +
        q03 * (q01 * q12 - q11 * q02)
      ) * invDet;

      const dMidSq = (sx - mx) ** 2 + (sy - my) ** 2 + (sz - mz) ** 2;
      if (dMidSq <= Math.max(edgeLenSq * 1.2, stepBoundSq)) {
        const sErr = evalQArr(q00, q01, q02, q03, q11, q12, q13, q22, q23, q33, sx, sy, sz);
        if (sErr < bestErr) {
          bestErr = sErr;
          bx = sx; by = sy; bz = sz;
        }
      }
    }

    const euErr = evalQArr(q00, q01, q02, q03, q11, q12, q13, q22, q23, q33, pu.x, pu.y, pu.z);
    if (euErr < bestErr) { bestErr = euErr; bx = pu.x; by = pu.y; bz = pu.z; }
    const evErr = evalQArr(q00, q01, q02, q03, q11, q12, q13, q22, q23, q33, pv.x, pv.y, pv.z);
    if (evErr < bestErr) { bestErr = evErr; bx = pv.x; by = pv.y; bz = pv.z; }

    // Si solo uno de los extremos está en borde abierto, anclar al vértice de borde para no encoger siluetas
    if (isBoundaryVert[u] && !isBoundaryVert[v]) {
      bx = pu.x; by = pu.y; bz = pu.z;
      bestErr = euErr;
    } else if (!isBoundaryVert[u] && isBoundaryVert[v]) {
      bx = pv.x; by = pv.y; bz = pv.z;
      bestErr = evErr;
    }

    const degPenalty = 1 + 0.12 * Math.max(0, vertNbrs[u].size + vertNbrs[v].size - 10);
    const cost = Math.max(0, bestErr) + lenTieWeight * edgeLenSq * degPenalty;
    return { cost, x: bx, y: by, z: bz };
  };

  const heap = [];
  const pushHeap = (item) => {
    heap.push(item);
    let idx = heap.length - 1;
    while (idx > 0) {
      const p = (idx - 1) >> 1;
      if (heap[p].cost <= heap[idx].cost) break;
      const tmp = heap[p]; heap[p] = heap[idx]; heap[idx] = tmp;
      idx = p;
    }
  };
  const popHeap = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let idx = 0;
      const len = heap.length;
      while (true) {
        let best = idx;
        const l = idx * 2 + 1, r = idx * 2 + 2;
        if (l < len && heap[l].cost < heap[best].cost) best = l;
        if (r < len && heap[r].cost < heap[best].cost) best = r;
        if (best === idx) break;
        const tmp = heap[idx]; heap[idx] = heap[best]; heap[best] = tmp;
        idx = best;
      }
    }
    return top;
  };

  let curVertCount = 0;
  for (let vi = 0; vi < Vq; vi++) {
    if (vertFaces[vi].size > 0) curVertCount++;
    else aliveVert[vi] = 0;
  }

  const triUnitNormalAndQual = (pa, pb, pc) => {
    const e1x = pb.x - pa.x, e1y = pb.y - pa.y, e1z = pb.z - pa.z;
    const e2x = pc.x - pa.x, e2y = pc.y - pa.y, e2z = pc.z - pa.z;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    const area2 = Math.hypot(nx, ny, nz);
    if (area2 < 1e-12) return null;
    const sumSq =
      (e1x * e1x + e1y * e1y + e1z * e1z) +
      (e2x * e2x + e2y * e2y + e2z * e2z) +
      ((pc.x - pb.x) ** 2 + (pc.y - pb.y) ** 2 + (pc.z - pb.z) ** 2);
    return { x: nx / area2, y: ny / area2, z: nz / area2, q: area2 / (sumSq || 1e-12) };
  };

  // Helper para voltear arista (a,b) cuando reduce estrellas de alta valencia o mejora aspecto en zonas planas
  const tryActiveEdgeFlip = (a, b) => {
    if (!aliveVert[a] || !aliveVert[b] || !vertNbrs[a].has(b)) return false;
    if (getCrease(a, b) > 0.1) return false;
    const shared = [];
    for (const fi of vertFaces[a]) {
      if (aliveFace[fi] && vertFaces[b].has(fi)) shared.push(fi);
    }
    if (shared.length !== 2) return false;
    const [fi0, fi1] = shared;
    const f0 = qTris[fi0], f1 = qTris[fi1];
    const ia0 = f0.indexOf(a), ib0 = f0.indexOf(b);
    if (ia0 < 0 || ib0 < 0) return false;
    const aFirst = ((ia0 + 1) % 3) === ib0;
    const va = aFirst ? a : b;
    const vb = aFirst ? b : a;
    const vc = f0[3 - f0.indexOf(va) - f0.indexOf(vb)];
    const vd = f1[3 - f1.indexOf(va) - f1.indexOf(vb)];
    if (vc === vd || vertNbrs[vc].has(vd)) return false;
    if (vertNbrs[va].size <= 3 || vertNbrs[vb].size <= 3) return false;

    const t0 = triUnitNormalAndQual(outVerts[va], outVerts[vb], outVerts[vc]);
    const t1 = triUnitNormalAndQual(outVerts[vb], outVerts[va], outVerts[vd]);
    if (!t0 || !t1 || t0.x * t1.x + t0.y * t1.y + t0.z * t1.z < 0.90) return false;

    const n0 = triUnitNormalAndQual(outVerts[va], outVerts[vd], outVerts[vc]);
    const n1 = triUnitNormalAndQual(outVerts[vd], outVerts[vb], outVerts[vc]);
    if (!n0 || !n1) return false;
    if (
      n0.x * t0.x + n0.y * t0.y + n0.z * t0.z < 0.72 ||
      n1.x * t1.x + n1.y * t1.y + n1.z * t1.z < 0.72 ||
      n0.x * n1.x + n0.y * n1.y + n0.z * n1.z < 0.08
    ) return false;

    const da = vertNbrs[va].size, db = vertNbrs[vb].size, dc = vertNbrs[vc].size, dd = vertNbrs[vd].size;
    const errBefore = (da - 6) ** 2 + (db - 6) ** 2 + (dc - 6) ** 2 + (dd - 6) ** 2;
    const errAfter = (da - 7) ** 2 + (db - 7) ** 2 + (dc - 5) ** 2 + (dd - 5) ** 2;
    const qBefore = Math.min(t0.q, t1.q);
    const qAfter = Math.min(n0.q, n1.q);
    if (qAfter < qBefore * 0.75) return false;
    if (!(errAfter < errBefore || (errAfter === errBefore && qAfter > qBefore * 1.06))) return false;

    const uv0 = triUvs[fi0], uv1 = triUvs[fi1];
    const getUv = (f, uvArr, vi) => {
      const idx = f.indexOf(vi);
      return idx >= 0 ? uvArr[idx] : [0, 0];
    };
    const uvA = getUv(f0, uv0, va);
    const uvB = getUv(f0, uv0, vb);
    const uvC = getUv(f0, uv0, vc);
    const uvD = getUv(f1, uv1, vd);

    qTris[fi0] = [va, vd, vc];
    triUvs[fi0] = [uvA.slice(), uvD.slice(), uvC.slice()];
    qTris[fi1] = [vd, vb, vc];
    triUvs[fi1] = [uvD.slice(), uvB.slice(), uvC.slice()];

    vertFaces[vb].delete(fi0);
    vertFaces[vd].add(fi0);
    vertFaces[va].delete(fi1);
    vertFaces[vc].add(fi1);
    vertNbrs[va].delete(vb); vertNbrs[vb].delete(va);
    vertNbrs[vc].add(vd); vertNbrs[vd].add(vc);
    vertStamp[va]++; vertStamp[vb]++; vertStamp[vc]++; vertStamp[vd]++;
    return true;
  };

  const runGlobalActiveEdgeFlips = (passes = 2) => {
    for (let fPass = 0; fPass < passes; fPass++) {
      for (let a = 0; a < Vq; a++) {
        if (!aliveVert[a]) continue;
        for (const b of [...vertNbrs[a]]) {
          if (a < b && aliveVert[b]) tryActiveEdgeFlip(a, b);
        }
      }
    }
  };

  const rebuildHeap = () => {
    heap.length = 0;
    for (let u = 0; u < Vq; u++) {
      if (!aliveVert[u]) continue;
      for (const v of vertNbrs[u]) {
        if (u < v && aliveVert[v]) {
          const c = computePairCost(u, v);
          pushHeap({ u, v, su: vertStamp[u], sv: vertStamp[v], ...c });
        }
      }
    }
  };

  // Ejecutar colapsos en hasta 3 etapas alternando Edge Flips globales
  const stageCount = 3;
  const startVerts = curVertCount;
  for (let stage = 0; stage < stageCount && curVertCount > clampedTarget; stage++) {
    rebuildHeap();
    const stageRatio = (stage + 1) / stageCount;
    const stageTarget = stage === stageCount - 1
      ? clampedTarget
      : Math.max(clampedTarget, Math.round(startVerts - (startVerts - clampedTarget) * stageRatio));
    const maxCombinedDeg = stage === 2 ? 10 : 9;

    while (heap.length && curVertCount > stageTarget) {
      const item = popHeap();
      const { u, v, su, sv, x, y, z } = item;
      if (!aliveVert[u] || !aliveVert[v]) continue;
      if (vertStamp[u] !== su || vertStamp[v] !== sv) continue;
      if (!vertNbrs[u].has(v)) continue;

      const sharedFaces = [];
      for (const fi of vertFaces[u]) {
        if (aliveFace[fi] && vertFaces[v].has(fi)) sharedFaces.push(fi);
      }
      if (sharedFaces.length !== 2 && sharedFaces.length !== 1) continue;

      const nu = vertNbrs[u], nv = vertNbrs[v];
      const common = [];
      for (const w of nu) {
        if (nv.has(w)) common.push(w);
      }
      if (sharedFaces.length === 2) {
        if (common.length !== 2) continue;
        if (vertNbrs[common[0]].size < 4 || vertNbrs[common[1]].size < 4) continue;
        if (isBoundaryVert[u] && isBoundaryVert[v]) continue;
      } else {
        if (common.length !== 1 || !isBoundaryVert[u] || !isBoundaryVert[v]) continue;
        if (vertNbrs[common[0]].size < 3) continue;
      }
      if (nu.size + nv.size - 4 > maxCombinedDeg) continue;

      const targetPos = { x, y, z };
      let valid = true;
      const ringNorms = [];
      const checkRingFace = (fi, collapsedVert) => {
        const f = qTris[fi];
        const oldInfo = triUnitNormalAndQual(outVerts[f[0]], outVerts[f[1]], outVerts[f[2]]);
        if (!oldInfo) return false;
        const newInfo = triUnitNormalAndQual(
          f[0] === collapsedVert ? targetPos : outVerts[f[0]],
          f[1] === collapsedVert ? targetPos : outVerts[f[1]],
          f[2] === collapsedVert ? targetPos : outVerts[f[2]]
        );
        if (!newInfo || newInfo.q < 0.08 || oldInfo.x * newInfo.x + oldInfo.y * newInfo.y + oldInfo.z * newInfo.z < 0.72) {
          return false;
        }
        let r0 = -1, r1 = -1;
        for (let k = 0; k < 3; k++) {
          if (f[k] !== collapsedVert) {
            if (r0 < 0) r0 = f[k];
            else r1 = f[k];
          }
        }
        // Proteger el ángulo diédrico contra la cara vecina al borde exterior (r0, r1) del 1-ring
        for (const extFi of vertFaces[r0]) {
          if (extFi === fi || !aliveFace[extFi] || !vertFaces[r1].has(extFi)) continue;
          const ef = qTris[extFi];
          const extN = triUnitNormalAndQual(outVerts[ef[0]], outVerts[ef[1]], outVerts[ef[2]]);
          if (extN) {
            const oldRimDot = oldInfo.x * extN.x + oldInfo.y * extN.y + oldInfo.z * extN.z;
            const newRimDot = newInfo.x * extN.x + newInfo.y * extN.y + newInfo.z * extN.z;
            if (newRimDot < Math.min(0.05, oldRimDot - 0.05)) return false;
          }
          break;
        }
        ringNorms.push({ r0, r1, oldInfo, newInfo });
        return true;
      };

      const s0 = sharedFaces[0];
      const s1 = sharedFaces.length > 1 ? sharedFaces[1] : -1;
      for (const fi of vertFaces[u]) {
        if (!aliveFace[fi] || fi === s0 || fi === s1) continue;
        if (!checkRingFace(fi, u)) { valid = false; break; }
      }
      if (!valid) continue;
      for (const fi of vertFaces[v]) {
        if (!aliveFace[fi] || fi === s0 || fi === s1) continue;
        if (!checkRingFace(fi, v)) { valid = false; break; }
      }
      if (!valid) continue;

      for (let a = 0; a < ringNorms.length && valid; a++) {
        const ra = ringNorms[a];
        for (let b = a + 1; b < ringNorms.length; b++) {
          const rb = ringNorms[b];
          const shareSpoke = ra.r0 === rb.r0 || ra.r0 === rb.r1 || ra.r1 === rb.r0 || ra.r1 === rb.r1;
          if (!shareSpoke) continue;
          const newDot = ra.newInfo.x * rb.newInfo.x + ra.newInfo.y * rb.newInfo.y + ra.newInfo.z * rb.newInfo.z;
          if (newDot < 0.05) {
            const oldDot = ra.oldInfo.x * rb.oldInfo.x + ra.oldInfo.y * rb.oldInfo.y + ra.oldInfo.z * rb.oldInfo.z;
            if (newDot < Math.min(0.05, oldDot - 0.05)) { valid = false; break; }
          }
        }
      }
      if (!valid) continue;

      // Interpolar UVs continuas a lo largo del segmento pu -> pv antes de mover u
      if (preserveUvs) {
        const pu = outVerts[u], pv = outVerts[v];
        const edx = pv.x - pu.x, edy = pv.y - pu.y, edz = pv.z - pu.z;
        const eLenSq = edx * edx + edy * edy + edz * edz;
        const t = eLenSq > 1e-12
          ? Math.max(0, Math.min(1, ((x - pu.x) * edx + (y - pu.y) * edy + (z - pu.z) * edz) / eLenSq))
          : 0.5;
        const chartSamples = [];
        for (const sfi of sharedFaces) {
          const sf = qTris[sfi], suv = triUvs[sfi];
          const iu = sf.indexOf(u), iv = sf.indexOf(v);
          if (iu >= 0 && iv >= 0) {
            const uvU = suv[iu], uvV = suv[iv];
            chartSamples.push({
              uvU,
              uvV,
              blend: [uvU[0] + (uvV[0] - uvU[0]) * t, uvU[1] + (uvV[1] - uvU[1]) * t],
            });
          }
        }
        if (chartSamples.length) {
          for (const fi of vertFaces[u]) {
            if (!aliveFace[fi] || fi === s0 || fi === s1) continue;
            const iu = qTris[fi].indexOf(u);
            if (iu < 0) continue;
            const curUv = triUvs[fi][iu];
            for (const ch of chartSamples) {
              if (Math.hypot(curUv[0] - ch.uvU[0], curUv[1] - ch.uvU[1]) < 0.18) {
                triUvs[fi][iu] = ch.blend.slice();
                break;
              }
            }
          }
          for (const fi of vertFaces[v]) {
            if (!aliveFace[fi] || fi === s0 || fi === s1) continue;
            const iv = qTris[fi].indexOf(v);
            if (iv < 0) continue;
            const curUv = triUvs[fi][iv];
            for (const ch of chartSamples) {
              if (Math.hypot(curUv[0] - ch.uvV[0], curUv[1] - ch.uvV[1]) < 0.18) {
                triUvs[fi][iv] = ch.blend.slice();
                break;
              }
            }
          }
        }
      }

      outVerts[u].x = x; outVerts[u].y = y; outVerts[u].z = z;
      isBoundaryVert[u] = isBoundaryVert[u] | isBoundaryVert[v];
      aliveVert[v] = 0;
      const bu = u * 10, bv = v * 10;
      for (let k = 0; k < 10; k++) Q[bu + k] += Q[bv + k];

      for (const sfi of sharedFaces) {
        aliveFace[sfi] = 0;
        const sf = qTris[sfi];
        for (let k = 0; k < 3; k++) vertFaces[sf[k]].delete(sfi);
      }

      for (const fi of vertFaces[v]) {
        if (!aliveFace[fi]) continue;
        const f = qTris[fi];
        for (let k = 0; k < 3; k++) {
          if (f[k] === v) f[k] = u;
        }
        vertFaces[u].add(fi);
      }

      if (edgeCreases.size) {
        edgeCreases.delete(edgeKey(u, v));
        for (const w of vertNbrs[v]) {
          const kv = edgeKey(v, w);
          const cr = edgeCreases.get(kv);
          if (cr !== undefined) {
            edgeCreases.delete(kv);
            if (w !== u) {
              const ku = edgeKey(u, w);
              edgeCreases.set(ku, Math.max(edgeCreases.get(ku) || 0, cr));
            }
          }
        }
      }

      vertNbrs[u].delete(v);
      for (const w of vertNbrs[v]) {
        vertNbrs[w].delete(v);
        if (w !== u) {
          vertNbrs[w].add(u);
          vertNbrs[u].add(w);
        }
      }
      vertNbrs[v].clear();
      vertFaces[v].clear();

      if (vertNbrs[u].size >= 8) {
        for (const w of [...vertNbrs[u]]) {
          tryActiveEdgeFlip(u, w);
        }
      }

      vertStamp[u]++;
      for (const w of vertNbrs[u]) vertStamp[w]++;
      for (const w of vertNbrs[u]) {
        const c = computePairCost(u, w);
        pushHeap({ u: Math.min(u, w), v: Math.max(u, w), su: vertStamp[Math.min(u, w)], sv: vertStamp[Math.max(u, w)], ...c });
      }
      curVertCount--;
    }

    runGlobalActiveEdgeFlips(2);
  }

  // 4. Compactar vértices y triángulos vivos
  const vRemap = new Int32Array(Vq);
  vRemap.fill(-1);
  const decVerts = [];
  const decBound = [];
  for (let vi = 0; vi < Vq; vi++) {
    if (!aliveVert[vi]) continue;
    vRemap[vi] = decVerts.length;
    decVerts.push(outVerts[vi]);
    decBound.push(isBoundaryVert[vi]);
  }
  const decTris = [];
  const decTriUvs = [];
  for (let ti = 0; ti < qTris.length; ti++) {
    if (!aliveFace[ti]) continue;
    const f = qTris[ti];
    decTris.push([vRemap[f[0]], vRemap[f[1]], vRemap[f[2]]]);
    decTriUvs.push(triUvs[ti]);
  }
  const decCreases = new Map();
  if (edgeCreases.size) {
    for (const [k, cr] of edgeCreases.entries()) {
      const sep = k.indexOf('_');
      const oa = Number(k.slice(0, sep));
      const ob = Number(k.slice(sep + 1));
      const na = vRemap[oa], nb = vRemap[ob];
      if (na >= 0 && nb >= 0 && na !== nb) {
        decCreases.set(edgeKey(na, nb), cr);
      }
    }
  }

  const Vd = decVerts.length;
  const dNbrs = Array.from({ length: Vd }, () => new Set());
  const dVFaces = Array.from({ length: Vd }, () => new Set());
  const dCreaseVert = new Uint8Array(Vd);
  for (let ti = 0; ti < decTris.length; ti++) {
    const f = decTris[ti];
    for (let k = 0; k < 3; k++) {
      const a = f[k], b = f[(k + 1) % 3];
      dNbrs[a].add(b); dNbrs[b].add(a);
      dVFaces[a].add(ti);
      if (decCreases.size && (decCreases.get(edgeKey(a, b)) || 0) > 0.1) {
        dCreaseVert[a] = 1; dCreaseVert[b] = 1;
      }
    }
  }

  // 5. Relajación tangencial ligera bloqueando bordes abiertos, creases y aristas agudas
  for (let rPass = 0; rPass < 2; rPass++) {
    const fNorms = decTris.map((f) => computeFaceUnitNormal(f, decVerts));
    for (let vi = 0; vi < Vd; vi++) {
      if (decBound[vi] || dCreaseVert[vi]) continue;
      const nbrs = dNbrs[vi];
      const incSet = dVFaces[vi];
      if (!nbrs.size || !incSet.size) continue;
      const incF = [...incSet];

      let minLocalDot = 1;
      for (let a = 0; a < incF.length && minLocalDot >= 0.80; a++) {
        const na = fNorms[incF[a]];
        if (!na) continue;
        for (let b = a + 1; b < incF.length; b++) {
          const nb = fNorms[incF[b]];
          if (!nb) continue;
          const d = na.x * nb.x + na.y * nb.y + na.z * nb.z;
          if (d < minLocalDot) minLocalDot = d;
        }
      }
      if (minLocalDot < 0.80) continue;

      let ax = 0, ay = 0, az = 0;
      for (const w of nbrs) {
        const q = decVerts[w];
        ax += q.x; ay += q.y; az += q.z;
      }
      const inv = 1 / nbrs.size;
      const p = decVerts[vi];
      let dx = ax * inv - p.x, dy = ay * inv - p.y, dz = az * inv - p.z;
      let vnx = 0, vny = 0, vnz = 0;
      for (let k = 0; k < incF.length; k++) {
        const fn = fNorms[incF[k]];
        if (fn) { vnx += fn.x; vny += fn.y; vnz += fn.z; }
      }
      const vnl = Math.hypot(vnx, vny, vnz);
      if (vnl > 1e-6) {
        vnx /= vnl; vny /= vnl; vnz /= vnl;
        const proj = dx * vnx + dy * vny + dz * vnz;
        dx -= proj * vnx; dy -= proj * vny; dz -= proj * vnz;
      }
      const oxP = p.x, oyP = p.y, ozP = p.z;
      p.x = oxP + dx * 0.25; p.y = oyP + dy * 0.25; p.z = ozP + dz * 0.25;
      let flipped = false;
      for (let k = 0; k < incF.length; k++) {
        const fi = incF[k];
        const refN = fNorms[fi];
        if (!refN) continue;
        const cur = triUnitNormalAndQual(decVerts[decTris[fi][0]], decVerts[decTris[fi][1]], decVerts[decTris[fi][2]]);
        if (!cur || cur.q < 0.08 || cur.x * refN.x + cur.y * refN.y + cur.z * refN.z < 0.85) {
          flipped = true; break;
        }
      }
      if (flipped) { p.x = oxP; p.y = oyP; p.z = ozP; }
    }
  }

  // 6. Re-emparejar pares de triángulos coplanares/suaves en quads limpios
  const edgeAdj = new Map();
  for (let ti = 0; ti < decTris.length; ti++) {
    const f = decTris[ti];
    for (let k = 0; k < 3; k++) {
      const a = f[k], b = f[(k + 1) % 3];
      const ek = a < b ? `${a}_${b}` : `${b}_${a}`;
      let arr = edgeAdj.get(ek);
      if (!arr) { arr = []; edgeAdj.set(ek, arr); }
      arr.push(ti);
    }
  }

  const tNorms = decTris.map((f) => computeFaceUnitNormal(f, decVerts));
  const pairs = [];
  for (const arr of edgeAdj.values()) {
    if (arr.length !== 2) continue;
    const [t0, t1] = arr;
    const n0 = tNorms[t0], n1 = tNorms[t1];
    if (!n0 || !n1) continue;
    const dot = n0.x * n1.x + n0.y * n1.y + n0.z * n1.z;
    if (dot < 0.94) continue;

    const f0 = decTris[t0], f1 = decTris[t1];
    let sharedA = -1, sharedB = -1, opp0 = -1, opp1 = -1;
    let idxA0 = -1, idxB0 = -1, idxO0 = -1;
    for (let k = 0; k < 3; k++) {
      const va = f0[k], vb = f0[(k + 1) % 3], vc = f0[(k + 2) % 3];
      if (f1.includes(va) && f1.includes(vb)) {
        sharedA = va; sharedB = vb; opp0 = vc;
        idxA0 = k; idxB0 = (k + 1) % 3; idxO0 = (k + 2) % 3;
        break;
      }
    }
    if (sharedA < 0) continue;
    if (decCreases.size && (decCreases.get(edgeKey(sharedA, sharedB)) || 0) > 0.1) continue;
    const idxO1 = f1.findIndex((v) => v !== sharedA && v !== sharedB);
    if (idxO1 < 0) continue;
    opp1 = f1[idxO1];
    if (opp1 === opp0) continue;

    const quad = [sharedA, opp1, sharedB, opp0];
    const pts = quad.map((vi) => decVerts[vi]);
    const avgNx = n0.x + n1.x, avgNy = n0.y + n1.y, avgNz = n0.z + n1.z;
    const nl = Math.hypot(avgNx, avgNy, avgNz) || 1;
    const ax = avgNx / nl, ay = avgNy / nl, az = avgNz / nl;

    let convexOk = true;
    for (let k = 0; k < 4; k++) {
      const p0 = pts[k], p1 = pts[(k + 1) % 4], p2 = pts[(k + 2) % 4];
      const u1x = p1.x - p0.x, u1y = p1.y - p0.y, u1z = p1.z - p0.z;
      const u2x = p2.x - p1.x, u2y = p2.y - p1.y, u2z = p2.z - p1.z;
      const cx = u1y * u2z - u1z * u2y;
      const cy = u1z * u2x - u1x * u2z;
      const cz = u1x * u2y - u1y * u2x;
      if (cx * ax + cy * ay + cz * az <= 1e-10) {
        convexOk = false; break;
      }
    }
    if (!convexOk) continue;

    const qAlt0 = triUnitNormalAndQual(pts[0], pts[1], pts[2]);
    const qAlt1 = triUnitNormalAndQual(pts[0], pts[2], pts[3]);
    if (
      !qAlt0 || !qAlt1 || qAlt0.q < 0.08 || qAlt1.q < 0.08 ||
      qAlt0.x * ax + qAlt0.y * ay + qAlt0.z * az < 0.78 ||
      qAlt1.x * ax + qAlt1.y * ay + qAlt1.z * az < 0.78
    ) continue;

    const diagShared = Math.hypot(
      decVerts[sharedA].x - decVerts[sharedB].x,
      decVerts[sharedA].y - decVerts[sharedB].y,
      decVerts[sharedA].z - decVerts[sharedB].z
    );
    const diagCross = Math.hypot(
      decVerts[opp0].x - decVerts[opp1].x,
      decVerts[opp0].y - decVerts[opp1].y,
      decVerts[opp0].z - decVerts[opp1].z
    );
    const ratio = Math.min(diagShared, diagCross) / (Math.max(diagShared, diagCross) || 1);
    if (ratio < 0.45) continue;

    const quadUv = [
      decTriUvs[t0][idxA0].slice(),
      decTriUvs[t1][idxO1].slice(),
      decTriUvs[t0][idxB0].slice(),
      decTriUvs[t0][idxO0].slice(),
    ];
    pairs.push({ t0, t1, quad, quadUv, score: dot * 2 + ratio });
  }

  pairs.sort((a, b) => b.score - a.score);
  const pairedTri = new Uint8Array(decTris.length);
  const finalFaces = [];
  const finalUvs = [];
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    if (pairedTri[p.t0] || pairedTri[p.t1]) continue;
    pairedTri[p.t0] = 1;
    pairedTri[p.t1] = 1;
    finalFaces.push(p.quad);
    finalUvs.push(p.quadUv);
  }
  for (let ti = 0; ti < decTris.length; ti++) {
    if (!pairedTri[ti]) {
      finalFaces.push(decTris[ti]);
      finalUvs.push(decTriUvs[ti]);
    }
  }

  if (decVerts.length >= origVertCount) {
    return {
      changed: false,
      beforeVerts: origVertCount,
      afterVerts: origVertCount,
      faceCount: editableMesh.faces.length,
    };
  }

  editableMesh.verts = decVerts;
  editableMesh.faces = finalFaces;
  if (preserveUvs) editableMesh.faceUvs = finalUvs;
  if (preserveCreases) editableMesh.creases = decCreases;
  editableMesh.looseEdges = [];
  editableMesh.pruneUnusedVertices();
  editableMesh.invalidateTopology();

  return {
    changed: editableMesh.verts.length < origVertCount,
    beforeVerts: origVertCount,
    afterVerts: editableMesh.verts.length,
    faceCount: editableMesh.faces.length,
  };
}

export function performOrganicSdfUnion(editableMesh, {
  shellIds = null,
  seamSmooth = 0.5,
  solidity = 0.8,
  resolution = 48,
} = {}) {
  if (!editableMesh || editableMesh.faces.length < 4) return { performed: false };

  let fShells = shellIds;
  let shellCount = 0;
  if (!fShells || fShells.length !== editableMesh.faces.length) {
    const comp = computeFaceShellIds(editableMesh);
    fShells = comp.shellIds;
    shellCount = comp.shellCount;
  } else {
    let maxId = -1;
    for (let i = 0; i < fShells.length; i++) {
      if (fShells[i] > maxId) maxId = fShells[i];
    }
    shellCount = maxId + 1;
  }
  if (shellCount < 2) return { performed: false };

  const verts = editableMesh.verts;
  let gMinX = Infinity, gMinY = Infinity, gMinZ = Infinity;
  let gMaxX = -Infinity, gMaxY = -Infinity, gMaxZ = -Infinity;
  for (let i = 0; i < verts.length; i++) {
    const p = verts[i];
    if (p.x < gMinX) gMinX = p.x; if (p.x > gMaxX) gMaxX = p.x;
    if (p.y < gMinY) gMinY = p.y; if (p.y > gMaxY) gMaxY = p.y;
    if (p.z < gMinZ) gMinZ = p.z; if (p.z > gMaxZ) gMaxZ = p.z;
  }
  const sizeX = gMaxX - gMinX;
  const sizeY = gMaxY - gMinY;
  const sizeZ = gMaxZ - gMinZ;
  const maxSpan = Math.max(sizeX, sizeY, sizeZ, 1e-4);
  const diag = Math.hypot(sizeX, sizeY, sizeZ) || 1;
  const invPosEps = 1 / Math.max(1e-6, diag * 1e-5);

  const trisByShell = Array.from({ length: shellCount }, () => []);
  const edgeCountByShell = Array.from({ length: shellCount }, () => new Map());

  const countShellEdge = (sId, a, b) => {
    const pa = verts[a], pb = verts[b];
    const ka = quantKey(pa.x, pa.y, pa.z, invPosEps);
    const kb = quantKey(pb.x, pb.y, pb.z, invPosEps);
    if (ka === kb) return;
    const map = edgeCountByShell[sId];
    const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
    map.set(k, (map.get(k) || 0) + 1);
  };

  for (let fi = 0; fi < editableMesh.faces.length; fi++) {
    const f = editableMesh.faces[fi];
    if (!f || f.length < 3) continue;
    const sId = fShells[fi];
    for (let i = 0; i < f.length; i++) {
      countShellEdge(sId, f[i], f[(i + 1) % f.length]);
    }
    const pushT = (ia, ib, ic) => {
      const pa = verts[ia], pb = verts[ib], pc = verts[ic];
      const e1x = pb.x - pa.x, e1y = pb.y - pa.y, e1z = pb.z - pa.z;
      const e2x = pc.x - pa.x, e2y = pc.y - pa.y, e2z = pc.z - pa.z;
      const l = Math.hypot(e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x);
      if (l > 1e-11) trisByShell[sId].push({ a: ia, b: ib, c: ic });
    };
    if (f.length === 3) {
      pushT(f[0], f[1], f[2]);
    } else if (f.length === 4) {
      pushT(f[0], f[1], f[2]);
      pushT(f[0], f[2], f[3]);
    } else {
      for (let i = 1; i + 1 < f.length; i++) pushT(f[0], f[i], f[i + 1]);
    }
  }

  const shellInfos = [];
  for (let s = 0; s < shellCount; s++) {
    const sTris = trisByShell[s];
    if (sTris.length < 4) return { performed: false };
    let openEdges = 0;
    for (const c of edgeCountByShell[s].values()) {
      if (c === 1) { openEdges++; break; }
    }
    if (openEdges > 0) {
      return { performed: false };
    }
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < sTris.length; i++) {
      const t = sTris[i];
      for (const vi of [t.a, t.b, t.c]) {
        const p = verts[vi];
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
        if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
      }
    }
    shellInfos.push({
      tris: sTris,
      verts,
      bvh: buildTriBVH(sTris, verts),
      minX, minY, minZ, maxX, maxY, maxZ,
    });
  }

  const sNorm = Math.max(0, Math.min(1, Number(seamSmooth) || 0));
  const blendK = sNorm <= 0.01 ? 0 : maxSpan * (0.012 + 0.13 * Math.pow(sNorm, 1.15));
  const res = Math.max(36, Math.min(72, Math.round(resolution)));
  const h = maxSpan / (res - 6);
  const pad = h * 3 + blendK * 0.4;

  const ox = gMinX - pad;
  const oy = gMinY - pad;
  const oz = gMinZ - pad;
  const nx = Math.max(12, Math.ceil((sizeX + pad * 2) / h) + 2);
  const ny = Math.max(12, Math.ceil((sizeY + pad * 2) / h) + 2);
  const nz = Math.max(12, Math.ceil((sizeZ + pad * 2) / h) + 2);

  const minUnsignedDistAnyShell = (px, py, pz, maxCutoff) => {
    let bestSq = maxCutoff * maxCutoff;
    for (let i = 0; i < shellInfos.length; i++) {
      const sh = shellInfos[i];
      const dx = px < sh.minX ? sh.minX - px : (px > sh.maxX ? px - sh.maxX : 0);
      const dy = py < sh.minY ? sh.minY - py : (py > sh.maxY ? py - sh.maxY : 0);
      const dz = pz < sh.minZ ? sh.minZ - pz : (pz > sh.maxZ ? pz - sh.maxZ : 0);
      if (dx * dx + dy * dy + dz * dz >= bestSq) continue;
      const r = minDistTriToBVH(px, py, pz, sh.bvh, sh.tris, sh.verts, bestSq);
      if (r.distSq < bestSq) bestSq = r.distSq;
    }
    return Math.sqrt(bestSq);
  };

  const bandCutoff = h * 2.2 + blendK * 0.55;
  const bandCutoffSq = bandCutoff * bandCutoff;
  const evalShellSDF = (px, py, pz, sh) => {
    const dx = px < sh.minX ? sh.minX - px : (px > sh.maxX ? px - sh.maxX : 0);
    const dy = py < sh.minY ? sh.minY - py : (py > sh.maxY ? py - sh.maxY : 0);
    const dz = pz < sh.minZ ? sh.minZ - pz : (pz > sh.maxZ ? pz - sh.maxZ : 0);
    const boxSq = dx * dx + dy * dy + dz * dz;
    if (boxSq > 0) {
      if (boxSq >= bandCutoffSq) return Math.sqrt(boxSq);
      const r = minDistTriToBVH(px, py, pz, sh.bvh, sh.tris, sh.verts, bandCutoffSq);
      return Math.sqrt(r.distSq);
    }
    const r = minDistTriToBVH(px, py, pz, sh.bvh, sh.tris, sh.verts, bandCutoffSq);
    const dist = Math.sqrt(r.distSq);
    let odd = 0;
    for (let ri = 0; ri < 3; ri++) {
      const dir = _PARITY_DIRS[ri];
      if ((rayCountBVH(px, py, pz, dir[0], dir[1], dir[2], sh.bvh, sh.tris, sh.verts) & 1) === 1) {
        odd++;
      }
      if (ri === 1 && odd === 0) break;
      if (ri === 1 && odd === 2) break;
    }
    return odd >= 2 ? -dist : dist;
  };

  const evalCombinedSDF = (px, py, pz) => {
    let acc = evalShellSDF(px, py, pz, shellInfos[0]);
    for (let i = 1; i < shellInfos.length; i++) {
      const d = evalShellSDF(px, py, pz, shellInfos[i]);
      acc = sminPoly(acc, d, blendK);
    }
    return acc;
  };

  const c8Margin = h * 4 * Math.sqrt(3) + h * 1.6 + blendK * 0.35;
  const c4Margin = h * 2 * Math.sqrt(3) + h * 1.4 + blendK * 0.35;
  const activeFineCells = [];

  for (let bx = 0; bx < nx; bx += 8) {
    const xEnd = Math.min(nx - 1, bx + 8);
    for (let by = 0; by < ny; by += 8) {
      const yEnd = Math.min(ny - 1, by + 8);
      for (let bz = 0; bz < nz; bz += 8) {
        const zEnd = Math.min(nz - 1, bz + 8);
        const cx8 = ox + ((bx + xEnd) * 0.5) * h;
        const cy8 = oy + ((by + yEnd) * 0.5) * h;
        const cz8 = oz + ((bz + zEnd) * 0.5) * h;
        if (minUnsignedDistAnyShell(cx8, cy8, cz8, c8Margin + 1e-5) > c8Margin) continue;

        for (let sx = bx; sx < xEnd; sx += 4) {
          const sxEnd = Math.min(xEnd, sx + 4);
          for (let sy = by; sy < yEnd; sy += 4) {
            const syEnd = Math.min(yEnd, sy + 4);
            for (let sz = bz; sz < zEnd; sz += 4) {
              const szEnd = Math.min(zEnd, sz + 4);
              const cx4 = ox + ((sx + sxEnd) * 0.5) * h;
              const cy4 = oy + ((sy + syEnd) * 0.5) * h;
              const cz4 = oz + ((sz + szEnd) * 0.5) * h;
              if (minUnsignedDistAnyShell(cx4, cy4, cz4, c4Margin + 1e-5) > c4Margin) continue;

              for (let ix = sx; ix < sxEnd; ix++) {
                for (let iy = sy; iy < syEnd; iy++) {
                  for (let iz = sz; iz < szEnd; iz++) {
                    activeFineCells.push([ix, iy, iz]);
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  if (!activeFineCells.length) return { performed: false };

  const strideZ = nz + 1;
  const strideYZ = (ny + 1) * strideZ;
  const cornerKey = (ix, iy, iz) => ix * strideYZ + iy * strideZ + iz;

  const field = new Map();
  const sampleCorner = (ix, iy, iz) => {
    const k = cornerKey(ix, iy, iz);
    let val = field.get(k);
    if (val === undefined) {
      val = evalCombinedSDF(ox + ix * h, oy + iy * h, oz + iz * h);
      field.set(k, val);
    }
    return val;
  };

  const CUBE_EDGES = [
    [0, 1], [2, 3], [4, 5], [6, 7],
    [0, 2], [1, 3], [4, 6], [5, 7],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  const CORNER_OFF = [
    [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
    [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
  ];

  const outVerts = [];
  const cellVertMap = new Map();
  const surfaceCells = [];

  for (let ci = 0; ci < activeFineCells.length; ci++) {
    const [ix, iy, iz] = activeFineCells[ci];
    const cVals = new Float64Array(8);
    let mask = 0;
    for (let c = 0; c < 8; c++) {
      const off = CORNER_OFF[c];
      const v = sampleCorner(ix + off[0], iy + off[1], iz + off[2]);
      cVals[c] = v;
      if (v <= 0) mask |= (1 << c);
    }
    if (mask === 0 || mask === 255) continue;

    let sx = 0, sy = 0, sz = 0, crossCount = 0;
    for (let ei = 0; ei < 12; ei++) {
      const [ca, cb] = CUBE_EDGES[ei];
      const inA = (mask & (1 << ca)) !== 0;
      const inB = (mask & (1 << cb)) !== 0;
      if (inA === inB) continue;
      const va = cVals[ca], vb = cVals[cb];
      const t = Math.max(0.02, Math.min(0.98, Math.abs(va - vb) > 1e-12 ? -va / (vb - va) : 0.5));
      const oa = CORNER_OFF[ca], ob = CORNER_OFF[cb];
      sx += oa[0] + (ob[0] - oa[0]) * t;
      sy += oa[1] + (ob[1] - oa[1]) * t;
      sz += oa[2] + (ob[2] - oa[2]) * t;
      crossCount++;
    }
    if (!crossCount) continue;
    const inv = 1 / crossCount;
    const vi = outVerts.length;
    outVerts.push({
      x: ox + (ix + sx * inv) * h,
      y: oy + (iy + sy * inv) * h,
      z: oz + (iz + sz * inv) * h,
    });
    cellVertMap.set(cornerKey(ix, iy, iz), vi);
    surfaceCells.push([ix, iy, iz]);
  }

  if (outVerts.length < 8) return { performed: false };

  const outFaces = [];
  const emittedEdge = new Set();
  const tryQuad = (v0, v1, v2, v3, flip) => {
    if (v0 === undefined || v1 === undefined || v2 === undefined || v3 === undefined) return;
    outFaces.push(flip ? [v0, v3, v2, v1] : [v0, v1, v2, v3]);
  };

  for (let ci = 0; ci < surfaceCells.length; ci++) {
    const [ix, iy, iz] = surfaceCells[ci];

    for (let dy = 0; dy <= 1; dy++) {
      const y = iy + dy;
      if (y < 1 || y >= ny) continue;
      for (let dz = 0; dz <= 1; dz++) {
        const z = iz + dz;
        if (z < 1 || z >= nz) continue;
        const ek = `X_${ix}_${y}_${z}`;
        if (emittedEdge.has(ek)) continue;
        const v0 = field.get(cornerKey(ix, y, z));
        const v1 = field.get(cornerKey(ix + 1, y, z));
        if (v0 === undefined || v1 === undefined) continue;
        const in0 = v0 <= 0, in1 = v1 <= 0;
        if (in0 === in1) continue;
        emittedEdge.add(ek);
        const c0 = cellVertMap.get(cornerKey(ix, y - 1, z - 1));
        const c1 = cellVertMap.get(cornerKey(ix, y, z - 1));
        const c2 = cellVertMap.get(cornerKey(ix, y, z));
        const c3 = cellVertMap.get(cornerKey(ix, y - 1, z));
        tryQuad(c0, c1, c2, c3, !in0);
      }
    }

    for (let dx = 0; dx <= 1; dx++) {
      const x = ix + dx;
      if (x < 1 || x >= nx) continue;
      for (let dz = 0; dz <= 1; dz++) {
        const z = iz + dz;
        if (z < 1 || z >= nz) continue;
        const ek = `Y_${x}_${iy}_${z}`;
        if (emittedEdge.has(ek)) continue;
        const v0 = field.get(cornerKey(x, iy, z));
        const v1 = field.get(cornerKey(x, iy + 1, z));
        if (v0 === undefined || v1 === undefined) continue;
        const in0 = v0 <= 0, in1 = v1 <= 0;
        if (in0 === in1) continue;
        emittedEdge.add(ek);
        const c0 = cellVertMap.get(cornerKey(x - 1, iy, z - 1));
        const c1 = cellVertMap.get(cornerKey(x - 1, iy, z));
        const c2 = cellVertMap.get(cornerKey(x, iy, z));
        const c3 = cellVertMap.get(cornerKey(x, iy, z - 1));
        tryQuad(c0, c1, c2, c3, !in0);
      }
    }

    for (let dx = 0; dx <= 1; dx++) {
      const x = ix + dx;
      if (x < 1 || x >= nx) continue;
      for (let dy = 0; dy <= 1; dy++) {
        const y = iy + dy;
        if (y < 1 || y >= ny) continue;
        const ek = `Z_${x}_${y}_${iz}`;
        if (emittedEdge.has(ek)) continue;
        const v0 = field.get(cornerKey(x, y, iz));
        const v1 = field.get(cornerKey(x, y, iz + 1));
        if (v0 === undefined || v1 === undefined) continue;
        const in0 = v0 <= 0, in1 = v1 <= 0;
        if (in0 === in1) continue;
        emittedEdge.add(ek);
        const c0 = cellVertMap.get(cornerKey(x - 1, y - 1, iz));
        const c1 = cellVertMap.get(cornerKey(x, y - 1, iz));
        const c2 = cellVertMap.get(cornerKey(x, y, iz));
        const c3 = cellVertMap.get(cornerKey(x - 1, y, iz));
        tryQuad(c0, c1, c2, c3, !in0);
      }
    }
  }

  if (outFaces.length < 6) return { performed: false };

  const Vout = outVerts.length;
  const nbrSets = Array.from({ length: Vout }, () => new Set());
  for (let fi = 0; fi < outFaces.length; fi++) {
    const f = outFaces[fi];
    for (let k = 0; k < f.length; k++) {
      const a = f[k], b = f[(k + 1) % f.length];
      nbrSets[a].add(b);
      nbrSets[b].add(a);
    }
  }
  const nbrLists = nbrSets.map((set) => [...set]);
  const origVerts = outVerts.map((v) => ({ x: v.x, y: v.y, z: v.z }));
  const smoothX = new Float64Array(Vout);
  const smoothY = new Float64Array(Vout);
  const smoothZ = new Float64Array(Vout);
  const bX = new Float64Array(Vout);
  const bY = new Float64Array(Vout);
  const bZ = new Float64Array(Vout);

  const runHCPass = (alpha, beta) => {
    for (let vi = 0; vi < Vout; vi++) {
      const nbrs = nbrLists[vi];
      const p = outVerts[vi], op = origVerts[vi];
      if (!nbrs.length) {
        smoothX[vi] = p.x; smoothY[vi] = p.y; smoothZ[vi] = p.z;
        bX[vi] = 0; bY[vi] = 0; bZ[vi] = 0;
        continue;
      }
      let ax = 0, ay = 0, az = 0;
      for (let k = 0; k < nbrs.length; k++) {
        const q = outVerts[nbrs[k]];
        ax += q.x; ay += q.y; az += q.z;
      }
      const inv = 1 / nbrs.length;
      const sx = ax * inv, sy = ay * inv, sz = az * inv;
      smoothX[vi] = sx; smoothY[vi] = sy; smoothZ[vi] = sz;
      bX[vi] = sx - (alpha * op.x + (1 - alpha) * p.x);
      bY[vi] = sy - (alpha * op.y + (1 - alpha) * p.y);
      bZ[vi] = sz - (alpha * op.z + (1 - alpha) * p.z);
    }
    for (let vi = 0; vi < Vout; vi++) {
      const nbrs = nbrLists[vi];
      if (!nbrs.length) continue;
      let nbx = 0, nby = 0, nbz = 0;
      for (let k = 0; k < nbrs.length; k++) {
        const j = nbrs[k];
        nbx += bX[j]; nby += bY[j]; nbz += bZ[j];
      }
      const inv = 1 / nbrs.length;
      outVerts[vi].x = smoothX[vi] - (beta * bX[vi] + (1 - beta) * (nbx * inv));
      outVerts[vi].y = smoothY[vi] - (beta * bY[vi] + (1 - beta) * (nby * inv));
      outVerts[vi].z = smoothZ[vi] - (beta * bZ[vi] + (1 - beta) * (nbz * inv));
    }
  };

  for (let p = 0; p < 4; p++) runHCPass(0.2, 0.55);

  const trilinearSampleAndGrad = (px, py, pz) => {
    const gx = (px - ox) / h;
    const gy = (py - oy) / h;
    const gz = (pz - oz) / h;
    const ix = Math.max(0, Math.min(nx - 1, Math.floor(gx)));
    const iy = Math.max(0, Math.min(ny - 1, Math.floor(gy)));
    const iz = Math.max(0, Math.min(nz - 1, Math.floor(gz)));
    const tx = Math.max(0, Math.min(1, gx - ix));
    const ty = Math.max(0, Math.min(1, gy - iy));
    const tz = Math.max(0, Math.min(1, gz - iz));

    const v000 = sampleCorner(ix, iy, iz);
    const v100 = sampleCorner(ix + 1, iy, iz);
    const v010 = sampleCorner(ix, iy + 1, iz);
    const v110 = sampleCorner(ix + 1, iy + 1, iz);
    const v001 = sampleCorner(ix, iy, iz + 1);
    const v101 = sampleCorner(ix + 1, iy, iz + 1);
    const v011 = sampleCorner(ix, iy + 1, iz + 1);
    const v111 = sampleCorner(ix + 1, iy + 1, iz + 1);

    const itx = 1 - tx, ity = 1 - ty, itz = 1 - tz;
    const f =
      v000 * itx * ity * itz + v100 * tx * ity * itz +
      v010 * itx * ty * itz + v110 * tx * ty * itz +
      v001 * itx * ity * tz + v101 * tx * ity * tz +
      v011 * itx * ty * tz + v111 * tx * ty * tz;

    const dfx = (
      (v100 - v000) * ity * itz + (v110 - v010) * ty * itz +
      (v101 - v001) * ity * tz + (v111 - v011) * ty * tz
    ) / h;
    const dfy = (
      (v010 - v000) * itx * itz + (v110 - v100) * tx * itz +
      (v011 - v001) * itx * tz + (v111 - v101) * tx * tz
    ) / h;
    const dfz = (
      (v001 - v000) * itx * ity + (v101 - v100) * tx * ity +
      (v011 - v010) * itx * ty + (v111 - v110) * tx * ty
    ) / h;

    return { f, dfx, dfy, dfz };
  };

  for (let step = 0; step < 2; step++) {
    for (let vi = 0; vi < Vout; vi++) {
      const p = outVerts[vi];
      const { f, dfx, dfy, dfz } = trilinearSampleAndGrad(p.x, p.y, p.z);
      const g2 = dfx * dfx + dfy * dfy + dfz * dfz;
      if (g2 < 1e-12) continue;
      const dStep = Math.max(-0.35 * h, Math.min(0.35 * h, -f / Math.sqrt(g2)));
      const invG = 1 / Math.sqrt(g2);
      p.x += dfx * invG * dStep;
      p.y += dfy * invG * dStep;
      p.z += dfz * invG * dStep;
    }
  }

  for (let p = 0; p < 2; p++) runHCPass(0.25, 0.5);

  const origFaceCount = editableMesh.faces.length;
  const origVertCount = verts.length;
  editableMesh.verts = outVerts;
  editableMesh.faces = outFaces;
  editableMesh.faceUvs = [];
  editableMesh.looseEdges = [];
  editableMesh.creases = new Map();
  editableMesh.invalidateTopology();

  // Paso 5: Simplificación QEM adaptativa por curvatura (reutilizando decimateMeshQEM)
  const sol = Math.max(0, Math.min(1, Number(solidity ?? 0.8)));
  if (sol > 0 && outVerts.length > 280) {
    const baseTarget = Math.min(2000, Math.max(750, Math.round(origVertCount * 0.95)));
    const solFactor = Math.max(0.45, 1.7 - 1.15 * sol);
    const targetVerts = Math.max(240, Math.min(outVerts.length - 1, Math.round(baseTarget * solFactor)));
    if (outVerts.length > targetVerts) {
      decimateMeshQEM(editableMesh, targetVerts, {
        preserveUvs: false,
        preserveCreases: false,
        protectBoundaries: false,
      });
    }
  }

  const finalVerts = editableMesh.verts;
  const finalFaces = editableMesh.faces;

  // Verificar volumen con signo positivo (devanado CCW hacia afuera)
  let signedVol = 0;
  for (let fi = 0; fi < finalFaces.length; fi++) {
    const f = finalFaces[fi];
    const p0 = finalVerts[f[0]];
    for (let k = 1; k + 1 < f.length; k++) {
      const p1 = finalVerts[f[k]], p2 = finalVerts[f[k + 1]];
      signedVol +=
        p0.x * (p1.y * p2.z - p1.z * p2.y) -
        p0.y * (p1.x * p2.z - p1.z * p2.x) +
        p0.z * (p1.x * p2.y - p1.y * p2.x);
    }
  }
  if (signedVol < 0) {
    for (let fi = 0; fi < finalFaces.length; fi++) finalFaces[fi].reverse();
  }

  // Generar UVs triplanares continuas normalizadas al rango de la malla
  const outUvs = new Array(finalFaces.length);
  const invSpan = 1 / maxSpan;
  for (let fi = 0; fi < finalFaces.length; fi++) {
    const f = finalFaces[fi];
    const n = computeFaceUnitNormal(f, finalVerts) || { x: 0, y: 1, z: 0 };
    const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
    outUvs[fi] = f.map((vi) => {
      const p = finalVerts[vi];
      if (ax >= ay && ax >= az) {
        return [(p.z - gMinZ) * invSpan, (p.y - gMinY) * invSpan];
      }
      if (ay >= ax && ay >= az) {
        return [(p.x - gMinX) * invSpan, (p.z - gMinZ) * invSpan];
      }
      return [(p.x - gMinX) * invSpan, (p.y - gMinY) * invSpan];
    });
  }

  editableMesh.faceUvs = outUvs;
  editableMesh.looseEdges = [];
  editableMesh.creases = new Map();
  editableMesh.invalidateTopology();

  return {
    performed: true,
    removedInsideCount: origFaceCount,
    splitFaceCount: finalFaces.length,
  };
}
