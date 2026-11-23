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
  const polyPlanarTol = Math.max(planeTol, diag * 2e-4);

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
      }
    }
    return true;
  };

  // Subdividir caras cortadas preservando intactas las caras no cortadas
  const splitVerts = verts.map((v) => ({ x: v.x, y: v.y, z: v.z }));
  const seamSnap = Math.max(1e-5, Math.min(tol * 0.25, diag * 2e-4));

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
