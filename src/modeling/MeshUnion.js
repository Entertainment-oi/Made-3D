import { Vec3 } from '../math/Vec3.js';

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
// Intersección Triángulo-Triángulo (transversal + coplanar)
// ============================================================================

function clipTriEdgesAgainstPlane(a, b, c, da, db, dc) {
  const pts = [a, b, c];
  const ds = [da, db, dc];
  const out = [];
  for (let i = 0; i < 3; i++) {
    const p0 = pts[i], p1 = pts[(i + 1) % 3];
    const d0 = ds[i], d1 = ds[(i + 1) % 3];
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

function clipSegmentToTri2D(ax, ay, bx, by, ax2, ay2, bx2, by2, cx2, cy2) {
  // Liang-Barsky contra las 3 aristas orientadas CCW del triángulo (a2,b2,c2)
  const edges = [
    [ax2, ay2, bx2, by2],
    [bx2, by2, cx2, cy2],
    [cx2, cy2, ax2, ay2],
  ];
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dy = by - ay;
  for (let i = 0; i < 3; i++) {
    const [ex0, ey0, ex1, ey1] = edges[i];
    const enx = -(ey1 - ey0);
    const eny = ex1 - ex0;
    // Punto interior tiene (p - e0) · n >= 0
    const num = (ax - ex0) * enx + (ay - ey0) * eny;
    const den = dx * enx + dy * eny;
    if (Math.abs(den) < 1e-12) {
      if (num < -1e-7) return null;
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

function triTriSegments(a0, a1, a2, nA, b0, b1, b2, nB, planeTol) {
  const dotN = nA.x * nB.x + nA.y * nB.y + nA.z * nB.z;
  const da0 = (a0.x - b0.x) * nB.x + (a0.y - b0.y) * nB.y + (a0.z - b0.z) * nB.z;
  const da1 = (a1.x - b0.x) * nB.x + (a1.y - b0.y) * nB.y + (a1.z - b0.z) * nB.z;
  const da2 = (a2.x - b0.x) * nB.x + (a2.y - b0.y) * nB.y + (a2.z - b0.z) * nB.z;

  const db0 = (b0.x - a0.x) * nA.x + (b0.y - a0.y) * nA.y + (b0.z - a0.z) * nA.z;
  const db1 = (b1.x - a0.x) * nA.x + (b1.y - a0.y) * nA.y + (b1.z - a0.z) * nA.z;
  const db2 = (b2.x - a0.x) * nA.x + (b2.y - a0.y) * nA.y + (b2.z - a0.z) * nA.z;

  const crossX = nA.y * nB.z - nA.z * nB.y;
  const crossY = nA.z * nB.x - nA.x * nB.z;
  const crossZ = nA.x * nB.y - nA.y * nB.x;
  const crossLenSq = crossX * crossX + crossY * crossY + crossZ * crossZ;

  // Caso coplanar
  if (
    Math.abs(dotN) > 0.992 &&
    Math.max(Math.abs(db0), Math.abs(db1), Math.abs(db2)) <= planeTol
  ) {
    return { coplanar: true };
  }

  if (crossLenSq < 1e-10) return null;

  const eps = 1e-6;
  const minDa = Math.min(da0, da1, da2);
  const maxDa = Math.max(da0, da1, da2);
  const minDb = Math.min(db0, db1, db2);
  const maxDb = Math.max(db0, db1, db2);

  if (maxDa < -eps || minDa > eps) return null;
  if (maxDb < -eps || minDb > eps) return null;

  // Si ninguno de los dos triángulos atraviesa estrictamente el plano del otro (p. ej. cubos adyacentes flush),
  // solo se tocan en frontera sin penetración volumétrica.
  const strictA = minDa < -eps && maxDa > eps;
  const strictB = minDb < -eps && maxDb > eps;
  if (!strictA && !strictB) return null;

  const segA = clipTriEdgesAgainstPlane(a0, a1, a2, da0, da1, da2);
  if (!segA) return null;
  const segB = clipTriEdgesAgainstPlane(b0, b1, b2, db0, db1, db2);
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

function collectCoplanarOverlapSegs(targetA, targetB, verts) {
  // Recorta las 3 aristas de targetB contra targetA (y viceversa) en 2D plano de targetA
  const a0 = verts[targetA.a], a1 = verts[targetA.b], a2 = verts[targetA.c];
  const nA = targetA.normal;
  const e1x = a1.x - a0.x, e1y = a1.y - a0.y, e1z = a1.z - a0.z;
  const uLen = Math.hypot(e1x, e1y, e1z);
  if (uLen < 1e-10) return null;
  const ux = e1x / uLen, uy = e1y / uLen, uz = e1z / uLen;
  const vx = nA.y * uz - nA.z * uy;
  const vy = nA.z * ux - nA.x * uz;
  const vz = nA.x * uy - nA.y * ux;

  const to2D = (p) => {
    const rx = p.x - a0.x, ry = p.y - a0.y, rz = p.z - a0.z;
    return [rx * ux + ry * uy + rz * uz, rx * vx + ry * vy + rz * vz];
  };

  const [ax2, ay2] = [0, 0];
  const [bx2, by2] = to2D(a1);
  const [cx2, cy2] = to2D(a2);

  const bPts = [verts[targetB.a], verts[targetB.b], verts[targetB.c]];
  const b2D = bPts.map(to2D);
  // Orientación CCW de B en plano de A
  const bArea = (b2D[1][0] - b2D[0][0]) * (b2D[2][1] - b2D[0][1]) - (b2D[1][1] - b2D[0][1]) * (b2D[2][0] - b2D[0][0]);
  if (bArea < 0) {
    bPts.reverse();
    b2D.reverse();
  }

  const segsForA = [];
  for (let i = 0; i < 3; i++) {
    const p0 = bPts[i], p1 = bPts[(i + 1) % 3];
    const [x0, y0] = b2D[i];
    const [x1, y1] = b2D[(i + 1) % 3];
    const span = clipSegmentToTri2D(x0, y0, x1, y1, ax2, ay2, bx2, by2, cx2, cy2);
    if (span) {
      const [t0, t1] = span;
      segsForA.push([
        { x: p0.x + (p1.x - p0.x) * t0, y: p0.y + (p1.y - p0.y) * t0, z: p0.z + (p1.z - p0.z) * t0 },
        { x: p0.x + (p1.x - p0.x) * t1, y: p0.y + (p1.y - p0.y) * t1, z: p0.z + (p1.z - p0.z) * t1 },
      ]);
    }
  }

  const segsForB = [];
  const aPts = [a0, a1, a2];
  const a2D = [[ax2, ay2], [bx2, by2], [cx2, cy2]];
  for (let i = 0; i < 3; i++) {
    const p0 = aPts[i], p1 = aPts[(i + 1) % 3];
    const [x0, y0] = a2D[i];
    const [x1, y1] = a2D[(i + 1) % 3];
    const span = clipSegmentToTri2D(
      x0, y0, x1, y1,
      b2D[0][0], b2D[0][1],
      b2D[1][0], b2D[1][1],
      b2D[2][0], b2D[2][1]
    );
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
// Subdivisión Planar 2D de un Triángulo con Segmentos de Corte (PSLG + Ear Clipping)
// ============================================================================

function cross2(ax, ay, bx, by, cx, cy) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

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
      // Polígono casi degenerado o colineal: abanico restante limpio
      for (let i = 1; i + 1 < ring.length; i++) {
        out.push([ring[0], ring[i], ring[i + 1]]);
      }
      break;
    }
  }
  if (ring.length === 3) out.push([ring[0], ring[1], ring[2]]);
  return out;
}

function splitSingleTriangleWithSegments(a, b, c, uva, uvb, uvc, normal, segments, snapTol) {
  const e1x = b.x - a.x, e1y = b.y - a.y, e1z = b.z - a.z;
  const uLen = Math.hypot(e1x, e1y, e1z);
  if (uLen < 1e-10 || !segments.length) return null;
  const ux = e1x / uLen, uy = e1y / uLen, uz = e1z / uLen;
  const vx = normal.y * uz - normal.z * uy;
  const vy = normal.z * ux - normal.x * uz;
  const vz = normal.x * uy - normal.y * ux;

  const to2D = (p) => {
    const rx = p.x - a.x, ry = p.y - a.y, rz = p.z - a.z;
    return { x: rx * ux + ry * uy + rz * uz, y: rx * vx + ry * vy + rz * vz };
  };

  const p0 = { x: 0, y: 0 };
  const p1 = to2D(b);
  const p2 = to2D(c);
  const triArea = cross2(p0.x, p0.y, p1.x, p1.y, p2.x, p2.y);
  if (triArea <= 1e-12) return null;

  const scale = Math.max(uLen, Math.hypot(p2.x, p2.y), 1e-5);
  const snap = Math.max(1e-6, Math.min(snapTol, scale * 1e-3));
  const snapSq = snap * snap;

  // Colectar y recortar todos los segmentos dentro de (p0, p1, p2)
  const rawSegs = [];
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const q0 = to2D(s[0]);
    const q1 = to2D(s[1]);
    const span = clipSegmentToTri2D(q0.x, q0.y, q1.x, q1.y, p0.x, p0.y, p1.x, p1.y, p2.x, p2.y);
    if (!span) continue;
    const [t0, t1] = span;
    const ax = q0.x + (q1.x - q0.x) * t0, ay = q0.y + (q1.y - q0.y) * t0;
    const bx = q0.x + (q1.x - q0.x) * t1, by = q0.y + (q1.y - q0.y) * t1;
    if ((bx - ax) ** 2 + (by - ay) ** 2 <= snapSq * 0.25) continue;
    rawSegs.push([{ x: ax, y: ay }, { x: bx, y: by }]);
  }
  if (!rawSegs.length) return null;

  // Puntos unificados [p0, p1, p2, ...interiores]
  const pts2D = [p0, p1, p2];
  const triEdges2 = [[0, 1], [1, 2], [2, 0]];

  const addPoint = (x, y) => {
    // 1. Snapping exacto contra vértices existentes
    for (let i = 0; i < pts2D.length; i++) {
      const dx = x - pts2D[i].x, dy = y - pts2D[i].y;
      if (dx * dx + dy * dy <= snapSq) return i;
    }
    // 2. Proyección exacta sobre aristas de frontera si está dentro de snap
    let sx = x, sy = y;
    for (let e = 0; e < 3; e++) {
      const va = pts2D[triEdges2[e][0]], vb = pts2D[triEdges2[e][1]];
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
    // Clamping baricéntrico estricto al triángulo [0,1,2]
    const w1 = cross2(p2.x, p2.y, p0.x, p0.y, sx, sy) / triArea;
    const w2 = cross2(p0.x, p0.y, p1.x, p1.y, sx, sy) / triArea;
    const w0 = 1 - w1 - w2;
    if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) {
      const cw0 = Math.max(0, w0);
      const cw1 = Math.max(0, w1);
      const cw2 = Math.max(0, w2);
      const sum = cw0 + cw1 + cw2 || 1;
      sx = (p0.x * cw0 + p1.x * cw1 + p2.x * cw2) / sum;
      sy = (p0.y * cw0 + p1.y * cw1 + p2.y * cw2) / sum;
    }
    for (let i = 0; i < pts2D.length; i++) {
      const dx = sx - pts2D[i].x, dy = sy - pts2D[i].y;
      if (dx * dx + dy * dy <= snapSq) return i;
    }
    pts2D.push({ x: sx, y: sy });
    return pts2D.length - 1;
  };

  // Convertir rawSegs a pares de índices e intersectar pares de segmentos cruzados
  let segPairs = [];
  for (let i = 0; i < rawSegs.length; i++) {
    const ia = addPoint(rawSegs[i][0].x, rawSegs[i][0].y);
    const ib = addPoint(rawSegs[i][1].x, rawSegs[i][1].y);
    if (ia !== ib) segPairs.push([ia, ib]);
  }

  // Subdividir pares de segmentos donde se crucen o donde un punto intermedio caiga encima
  let changedSegs = true;
  let iterGuard = 0;
  while (changedSegs && iterGuard++ < 8) {
    changedSegs = false;
    // Cruces segmento-segmento
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

    // Partir segmentos por puntos intermedios existentes (colinealidad)
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

  // Mantener solo pares que no coincidan completamente con una arista exterior del triángulo padre
  let tris = [[0, 1, 2]];

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

  // Paso 1: Insertar todos los puntos vi >= 3 dentro de `tris`
  for (let vi = 3; vi < pts2D.length; vi++) {
    const p = pts2D[vi];
    // Comprobar si cae en alguna arista de los sub-triángulos existentes
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
          const opp = t[iOpp];
          // Conservar CCW original
          const a = t[iOpp], b = t[(iOpp + 1) % 3], cTri = t[(iOpp + 2) % 3];
          nextTris.push([a, b, vi], [a, vi, cTri]);
        } else {
          nextTris.push(t);
        }
      }
      tris = nextTris;
      continue;
    }

    // Buscar triángulo que contiene p
    for (let ti = 0; ti < tris.length; ti++) {
      const t = tris[ti];
      if (t[0] === vi || t[1] === vi || t[2] === vi) break;
      const bw = bary(p.x, p.y, t[0], t[1], t[2]);
      if (bw && bw[0] > -1e-4 && bw[1] > -1e-4 && bw[2] > -1e-4) {
        tris.splice(ti, 1, [t[0], t[1], vi], [t[1], t[2], vi], [t[2], t[0], vi]);
        break;
      }
    }
  }

  // Paso 2: Forzar cada segmento restringido (p, q) dividiendo/re-triangulando cavidades cruzadas
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
        if (tt > 1e-5 && tt < 1 - 1e-5 && uu > 1e-5 && uu < 1 - 1e-5) {
          crossedIdx.add(ti);
          break;
        }
      }
    }

    if (!crossedIdx.size) continue;

    // Extraer aristas de frontera de la cavidad de triángulos cruzados
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

    // Reconstruir anillo ordenado de frontera y partir por sp -> sq
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
    if (loop.length >= 4 && idxQ > 0) {
      const upper = loop.slice(0, idxQ + 1); // sp -> ... -> sq
      const lower = [sq, ...loop.slice(idxQ + 1), sp]; // sq -> ... -> sp
      const tUpper = earClipSimplePoly(upper, pts2D);
      const tLower = earClipSimplePoly(lower, pts2D);
      tris = nextTris.concat(tUpper, tLower);
    }
  }

  // Reconstruir vértices 3D + UVs por coordenadas baricéntricas
  const outVerts = [
    { x: a.x, y: a.y, z: a.z },
    { x: b.x, y: b.y, z: b.z },
    { x: c.x, y: c.y, z: c.z },
  ];
  const outUvs = [uva.slice(), uvb.slice(), uvc.slice()];
  for (let vi = 3; vi < pts2D.length; vi++) {
    const p = pts2D[vi];
    const w1 = cross2(p2.x, p2.y, p0.x, p0.y, p.x, p.y) / triArea;
    const w2 = cross2(p0.x, p0.y, p1.x, p1.y, p.x, p.y) / triArea;
    const w0 = 1 - w1 - w2;
    outVerts.push({
      x: a.x * w0 + b.x * w1 + c.x * w2,
      y: a.y * w0 + b.y * w1 + c.y * w2,
      z: a.z * w0 + b.z * w1 + c.z * w2,
    });
    outUvs.push([
      uva[0] * w0 + uvb[0] * w1 + uvc[0] * w2,
      uva[1] * w0 + uvb[1] * w1 + uvc[1] * w2,
    ]);
  }

  // Filtrar sub-triángulos degenerados y asegurar orientación consistente
  const cleanTris = [];
  for (let i = 0; i < tris.length; i++) {
    const [ia, ib, ic] = tris[i];
    if (ia === ib || ib === ic || ic === ia) continue;
    const area2 = cross2(pts2D[ia].x, pts2D[ia].y, pts2D[ib].x, pts2D[ib].y, pts2D[ic].x, pts2D[ic].y);
    if (Math.abs(area2) <= 1e-12) continue;
    cleanTris.push(area2 > 0 ? [ia, ib, ic] : [ia, ic, ib]);
  }

  return { verts: outVerts, uvs: outUvs, tris: cleanTris };
}

// ============================================================================
// Pipeline unificado de soldado + unión booleana sólida de sub-mallas
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

  // Escala global
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

  // Triangulación temporal de cada cara por shell
  const allTris = [];
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
        shell: sId,
        a: ia, b: ib, c: ic,
        uva: ua.slice(), uvb: ub.slice(), uvc: uc.slice(),
        normal: { x: nx / l, y: ny / l, z: nz / l },
      };
      allTris.push(triObj);
      trisByShell[sId].push(triObj);
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

  // Buscar pares de shells con AABB superpuestos y recopilar intersecciones transversales/coplanares + contención interior
  const triSegs = new Map(); // global tri.index -> Array<[p, q]>
  const pushTriSeg = (triIdx, seg) => {
    let arr = triSegs.get(triIdx);
    if (!arr) { arr = []; triSegs.set(triIdx, arr); }
    arr.push(seg);
  };

  let hasTransverseCross = false;
  let hasStrictlyInside = false;
  const coplanarPairs = [];
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

      // 1. Comprobar intersección triángulo-triángulo usando BVH de shell B
      for (let i = 0; i < infoA.tris.length; i++) {
        const tA = infoA.tris[i];
        const a0 = verts[tA.a], a1 = verts[tA.b], a2 = verts[tA.c];
        const minX = Math.min(a0.x, a1.x, a2.x) - planeTol;
        const minY = Math.min(a0.y, a1.y, a2.y) - planeTol;
        const minZ = Math.min(a0.z, a1.z, a2.z) - planeTol;
        const maxX = Math.max(a0.x, a1.x, a2.x) + planeTol;
        const maxY = Math.max(a0.y, a1.y, a2.y) + planeTol;
        const maxZ = Math.max(a0.z, a1.z, a2.z) + planeTol;

        queryBVHBox(infoB.bvh, minX, minY, minZ, maxX, maxY, maxZ, (localIdxB) => {
          const tB = infoB.tris[localIdxB];
          const b0 = verts[tB.a], b1 = verts[tB.b], b2 = verts[tB.c];
          const hit = triTriSegments(a0, a1, a2, tA.normal, b0, b1, b2, tB.normal, planeTol);
          if (!hit) return;
          if (hit.coplanar) {
            coplanarPairs.push([tA, tB]);
          } else if (hit.segment) {
            hasTransverseCross = true;
            pushTriSeg(tA.index, hit.segment);
            pushTriSeg(tB.index, hit.segment);
          }
        });
      }

      // 2. Comprobar contención estricta de algún centroide/vértice si alguno es sólido cerrado
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

  // Si no hay cruce transversal ni penetración interior: verificar si hay pares coplanares con diferente tamaño
  // (p. ej. cubo pequeño pegado contra cara de cubo grande). Si son cubos flush idénticos, preservar quads originales.
  if (!hasTransverseCross && !hasStrictlyInside) {
    return { performed: false };
  }

  // Agregar segmentos coplanares para que caras compartidas en el mismo plano (p.ej. tapas superiores de dos cubos)
  // queden perfectamente divididas y coincidan esquina a esquina
  for (let i = 0; i < coplanarPairs.length; i++) {
    const [tA, tB] = coplanarPairs[i];
    const co = collectCoplanarOverlapSegs(tA, tB, verts);
    if (!co) continue;
    for (let k = 0; k < co.segsForA.length; k++) pushTriSeg(tA.index, co.segsForA[k]);
    for (let k = 0; k < co.segsForB.length; k++) pushTriSeg(tB.index, co.segsForB[k]);
  }

  // Subdividir los triángulos cruzados y conservar lista plana de sub-triángulos
  const splitVerts = verts.map((v) => ({ x: v.x, y: v.y, z: v.z }));
  const seamSnap = Math.max(1e-5, Math.min(tol * 0.25, diag * 2e-4));
  const subTris = [];

  for (let ti = 0; ti < allTris.length; ti++) {
    const t = allTris[ti];
    const segs = triSegs.get(t.index);
    if (segs && segs.length) {
      const splitRes = splitSingleTriangleWithSegments(
        verts[t.a], verts[t.b], verts[t.c],
        t.uva, t.uvb, t.uvc,
        t.normal,
        segs,
        seamSnap
      );
      if (splitRes && splitRes.tris.length) {
        const baseIdx = splitVerts.length;
        for (let k = 0; k < splitRes.verts.length; k++) {
          splitVerts.push(splitRes.verts[k]);
        }
        for (let k = 0; k < splitRes.tris.length; k++) {
          const [ia, ib, ic] = splitRes.tris[k];
          subTris.push({
            shell: t.shell,
            a: baseIdx + ia,
            b: baseIdx + ib,
            c: baseIdx + ic,
            uvs: [splitRes.uvs[ia], splitRes.uvs[ib], splitRes.uvs[ic]],
            normal: t.normal,
          });
        }
        continue;
      }
    }
    subTris.push({
      shell: t.shell,
      a: t.a, b: t.b, c: t.c,
      uvs: [t.uva.slice(), t.uvb.slice(), t.uvc.slice()],
      normal: t.normal,
    });
  }

  // Filtrar todo sub-triángulo cuyo centroide quede estrictamente dentro de OTRA shell cerrada
  const keptFaces = [];
  const keptUvs = [];
  const keptNormals = [];
  const keptShells = [];
  let removedInsideCount = 0;

  for (let i = 0; i < subTris.length; i++) {
    const st = subTris[i];
    const pa = splitVerts[st.a], pb = splitVerts[st.b], pc = splitVerts[st.c];
    const cx = (pa.x + pb.x + pc.x) / 3;
    const cy = (pa.y + pb.y + pc.y) / 3;
    const cz = (pa.z + pb.z + pc.z) / 3;

    let drop = false;
    const surfHolder = { tri: null };
    for (let s = 0; s < shellCount; s++) {
      if (s === st.shell) continue;
      const sInfo = shellInfos[s];
      if (!sInfo.isClosed) continue;
      surfHolder.tri = null;
      const cls = classifyPointVsClosedShell(cx, cy, cz, sInfo, surfTolSq, surfHolder);
      if (cls === 'inside') {
        drop = true;
        break;
      }
      if (cls === 'surface' && surfHolder.tri) {
        const sn = surfHolder.tri.normal;
        const dot = sn.x * st.normal.x + sn.y * st.normal.y + sn.z * st.normal.z;
        if (dot < -0.9 || (dot > 0.9 && st.shell > s)) {
          drop = true;
          break;
        }
      }
    }

    if (drop) {
      removedInsideCount++;
      continue;
    }

    keptFaces.push([st.a, st.b, st.c]);
    keptUvs.push(st.uvs);
    keptNormals.push(st.normal);
    keptShells.push(st.shell);
  }

  // Reemplazar malla con la superficie exterior dividida (luego weldShells soldará vértices, quitará duplicados/opuestos y podará interiores)
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
    shellTags: keptShells,
  };
}
