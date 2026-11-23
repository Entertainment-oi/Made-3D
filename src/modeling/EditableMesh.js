import { Vec3 } from '../math/Vec3.js';
import { Mat4 } from '../math/Mat4.js';
import { Geometry } from '../geometry/Geometry.js';
import { performVolumetricUnionIfNeeded, simplifyUnionTopology } from './MeshUnion.js';

const _vA = new Vec3();
const _vD = new Vec3();
const _rayLocalOrigin = new Vec3();
const _rayLocalDir = new Vec3();

export function edgeKey(a, b) {
  return a < b ? `${a}_${b}` : `${b}_${a}`;
}

function directedKey(a, b) {
  return `${a}>${b}`;
}

function segIntersect2D(ax, ay, bx, by, cx, cy, dx, dy) {
  const rdx = bx - ax, rdy = by - ay;
  const sdx = dx - cx, sdy = dy - cy;
  const denom = rdx * sdy - rdy * sdx;
  if (Math.abs(denom) < 1e-8) return null;
  const qpx = cx - ax, qpy = cy - ay;
  const t = (qpx * sdy - qpy * sdx) / denom;
  const u = (qpx * rdy - qpy * rdx) / denom;
  if (t < -1e-4 || t > 1 + 1e-4 || u < -1e-4 || u > 1 + 1e-4) return null;
  return {
    t: Math.max(0, Math.min(1, t)),
    u: Math.max(0, Math.min(1, u)),
  };
}

function pointInPoly2D(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y;
    const xj = pts[j].x, yj = pts[j].y;
    const intersect = ((yi > py) !== (yj > py)) &&
      (px < ((xj - xi) * (py - yi)) / ((yj - yi) || 1e-9) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function isConvexQuad(p0, p1, p2, p3, normal) {
  const pts = [p0, p1, p2, p3];
  for (let i = 0; i < 4; i++) {
    const a = pts[i];
    const b = pts[(i + 1) & 3];
    const c = pts[(i + 2) & 3];
    const e1x = b.x - a.x;
    const e1y = b.y - a.y;
    const e1z = b.z - a.z;
    const e2x = c.x - b.x;
    const e2y = c.y - b.y;
    const e2z = c.z - b.z;
    const cx = e1y * e2z - e1z * e2y;
    const cy = e1z * e2x - e1x * e2z;
    const cz = e1x * e2y - e1y * e2x;
    if (cx * normal.x + cy * normal.y + cz * normal.z <= 1e-6) {
      return false;
    }
  }
  return true;
}

function rayTriangleLocal(ox, oy, oz, dx, dy, dz, a, b, c) {
  const e1x = b.x - a.x, e1y = b.y - a.y, e1z = b.z - a.z;
  const e2x = c.x - a.x, e2y = c.y - a.y, e2z = c.z - a.z;
  const px = dy * e2z - dz * e2y;
  const py = dz * e2x - dx * e2z;
  const pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-9) return null;
  const invDet = 1 / det;
  const tx = ox - a.x, ty = oy - a.y, tz = oz - a.z;
  const u = (tx * px + ty * py + tz * pz) * invDet;
  if (u < -1e-5 || u > 1 + 1e-5) return null;
  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * invDet;
  if (v < -1e-5 || u + v > 1 + 1e-5) return null;
  const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;
  return t > 1e-5 ? t : null;
}

/**
 * Malla poligonal topológica (vértices soldados, aristas únicas, caras N-gon / quads)
 * para edición 3D interactiva y subdivisión Catmull-Clark no destructiva.
 */
export class EditableMesh {
  constructor(verts = [], faces = [], faceUvs = null, looseEdges = [], creases = null) {
    this.verts = verts; // Array<{ x, y, z }>
    this.faces = faces; // Array<number[]>
    this.faceUvs = faceUvs || faces.map((f) => f.map(() => [0, 0]));
    this.looseEdges = looseEdges; // Array<[number, number]>
    this.creases = creases instanceof Map ? new Map(creases) : new Map(); // edgeKey -> weight [0..1]
    this._topologyCache = null;
  }

  invalidateTopology() {
    this._topologyCache = null;
  }

  getEdgeCrease(a, b) {
    return this.creases.get(edgeKey(a, b)) || 0;
  }

  setEdgeCrease(a, b, value) {
    if (a === b || a < 0 || b < 0 || a >= this.verts.length || b >= this.verts.length) return 0;
    const v = Math.max(0, Math.min(1, Number(value) || 0));
    const k = edgeKey(a, b);
    if (v <= 1e-4) {
      this.creases.delete(k);
      return 0;
    }
    this.creases.set(k, v);
    return v;
  }

  _collectTargetEdgesForCrease(mode, selection) {
    const edges = this.getEdges();
    const out = [];
    if (!selection || !selection.size) return out;
    if (mode === 'edge') {
      for (const ei of selection) {
        if (edges[ei]) out.push(edges[ei]);
      }
      return out;
    }
    if (mode === 'vertex') {
      for (let ei = 0; ei < edges.length; ei++) {
        const e = edges[ei];
        if (selection.has(e.a) && selection.has(e.b)) out.push(e);
      }
      if (!out.length) {
        for (let ei = 0; ei < edges.length; ei++) {
          const e = edges[ei];
          if (selection.has(e.a) || selection.has(e.b)) out.push(e);
        }
      }
      return out;
    }
    // mode === 'face'
    const selFaces = new Set(selection);
    const allInside = [];
    for (let ei = 0; ei < edges.length; ei++) {
      const e = edges[ei];
      let selCount = 0;
      for (let i = 0; i < e.faces.length; i++) {
        if (selFaces.has(e.faces[i])) selCount++;
      }
      if (selCount > 0) allInside.push({ edge: e, isBorder: selCount < e.faces.length || e.faces.length === 1 });
    }
    const borders = allInside.filter((it) => it.isBorder).map((it) => it.edge);
    return borders.length ? borders : allInside.map((it) => it.edge);
  }

  setSelectionCrease(mode, selection, value) {
    const targets = this._collectTargetEdgesForCrease(mode, selection);
    if (!targets.length) return { changed: false, count: 0, value: 0 };
    const v = Math.max(0, Math.min(1, Number(value) || 0));
    for (let i = 0; i < targets.length; i++) {
      this.setEdgeCrease(targets[i].a, targets[i].b, v);
    }
    return { changed: true, count: targets.length, value: v };
  }

  getSelectionAverageCrease(mode, selection) {
    const targets = this._collectTargetEdgesForCrease(mode, selection);
    if (!targets.length) return 0;
    let sum = 0;
    for (let i = 0; i < targets.length; i++) {
      sum += this.getEdgeCrease(targets[i].a, targets[i].b);
    }
    return sum / targets.length;
  }

  _remapCreases(remap) {
    if (!this.creases || !this.creases.size) return;
    const next = new Map();
    for (const [k, w] of this.creases.entries()) {
      const sep = k.indexOf('_');
      if (sep < 0) continue;
      const a0 = Number(k.slice(0, sep));
      const b0 = Number(k.slice(sep + 1));
      const a = remap[a0];
      const b = remap[b0];
      if (a === undefined || b === undefined || a < 0 || b < 0 || a === b) continue;
      const nk = edgeKey(a, b);
      const prev = next.get(nk) || 0;
      if (w > prev) next.set(nk, w);
    }
    this.creases = next;
  }

  clone() {
    const verts = this.verts.map((v) => ({ x: v.x, y: v.y, z: v.z }));
    const faces = this.faces.map((f) => f.slice());
    const faceUvs = this.faceUvs.map((uvs) => uvs.map((uv) => [uv[0], uv[1]]));
    const looseEdges = this.looseEdges.map((e) => [e[0], e[1]]);
    return new EditableMesh(verts, faces, faceUvs, looseEdges, this.creases);
  }

  copyPositionsFrom(other) {
    if (!other || other.verts.length !== this.verts.length) return false;
    for (let i = 0; i < this.verts.length; i++) {
      this.verts[i].x = other.verts[i].x;
      this.verts[i].y = other.verts[i].y;
      this.verts[i].z = other.verts[i].z;
    }
    this.invalidateTopology();
    return true;
  }

  /**
   * Construye un EditableMesh soldando vértices duplicados y reconstruyendo caras cuadrangulares
   * a partir de triángulos coplanares (p. ej. un Cubo pasa de 24 vértices / 12 triángulos a 8 vértices / 6 quads).
   */
  static fromGeometry(geo, opts = {}) {
    if (!geo || !geo.attributes || !geo.attributes.position) {
      return new EditableMesh();
    }
    const posAttr = geo.attributes.position;
    const pos = posAttr.array;
    const uvAttr = geo.attributes.uv || null;
    const uvArr = uvAttr ? uvAttr.array : null;
    const vCount = posAttr.count;
    const idxAttr = geo.index || null;
    const idx = idxAttr ? idxAttr.array : null;

    const bb = geo.getBoundingBox();
    const dx = bb ? bb.max.x - bb.min.x : 1;
    const dy = bb ? bb.max.y - bb.min.y : 1;
    const dz = bb ? bb.max.z - bb.min.z : 1;
    const diag = Math.hypot(dx, dy, dz) || 1;
    const eps = Math.max(1e-6, diag * 1e-5);
    const invEps = 1 / eps;

    const map = new Map();
    const weldOf = new Int32Array(vCount);
    const verts = [];

    for (let i = 0; i < vCount; i++) {
      const o = i * 3;
      const x = pos[o], y = pos[o + 1], z = pos[o + 2];
      const key = `${Math.round(x * invEps)},${Math.round(y * invEps)},${Math.round(z * invEps)}`;
      let w = map.get(key);
      if (w === undefined) {
        w = verts.length;
        map.set(key, w);
        verts.push({ x, y, z });
      }
      weldOf[i] = w;
    }

    const triCount = idx ? (idx.length / 3) | 0 : (vCount / 3) | 0;
    const tris = [];
    const triUvs = [];
    const triNormals = [];

    for (let t = 0; t < triCount; t++) {
      const t3 = t * 3;
      const ia = idx ? idx[t3] : t3;
      const ib = idx ? idx[t3 + 1] : t3 + 1;
      const ic = idx ? idx[t3 + 2] : t3 + 2;
      const a = weldOf[ia];
      const b = weldOf[ib];
      const c = weldOf[ic];
      if (a === b || b === c || c === a) continue;

      const pa = verts[a], pb = verts[b], pc = verts[c];
      const e1x = pb.x - pa.x, e1y = pb.y - pa.y, e1z = pb.z - pa.z;
      const e2x = pc.x - pa.x, e2y = pc.y - pa.y, e2z = pc.z - pa.z;
      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;
      const len = Math.hypot(nx, ny, nz);
      if (len < 1e-10) continue;

      tris.push([a, b, c]);
      triUvs.push([
        uvArr ? [uvArr[ia * 2], uvArr[ia * 2 + 1]] : [0, 0],
        uvArr ? [uvArr[ib * 2], uvArr[ib * 2 + 1]] : [0, 0],
        uvArr ? [uvArr[ic * 2], uvArr[ic * 2 + 1]] : [0, 0],
      ]);
      triNormals.push({ x: nx / len, y: ny / len, z: nz / len });
    }

    if (opts.reconstructQuads === false) {
      return new EditableMesh(verts, tris, triUvs, []);
    }

    const used = new Uint8Array(tris.length);
    const faces = [];
    const faceUvs = [];

    const tryMergePair = (t0, t1) => {
      if (t0 === t1 || used[t0] || used[t1]) return false;
      const n0 = triNormals[t0];
      const n1 = triNormals[t1];
      if (n0.x * n1.x + n0.y * n1.y + n0.z * n1.z < 0.9985) return false;

      const f0 = tris[t0];
      const f1 = tris[t1];
      const uv0 = triUvs[t0];
      const uv1 = triUvs[t1];

      for (let i = 0; i < 3; i++) {
        const u = f0[i];
        const v = f0[(i + 1) % 3];
        for (let j = 0; j < 3; j++) {
          if (f1[j] === v && f1[(j + 1) % 3] === u) {
            const c = f0[(i + 2) % 3];
            const d = f1[(j + 2) % 3];
            if (c === d) continue;
            // Orden CCW del quad: u -> d -> v -> c
            if (!isConvexQuad(verts[u], verts[d], verts[v], verts[c], n0)) return false;
            faces.push([u, d, v, c]);
            faceUvs.push([
              uv0[i].slice(),
              uv1[(j + 2) % 3].slice(),
              uv0[(i + 1) % 3].slice(),
              uv0[(i + 2) % 3].slice(),
            ]);
            used[t0] = 1;
            used[t1] = 1;
            return true;
          }
        }
      }
      return false;
    };

    // Paso 1: parear triángulos consecutivos (patrón estándar de primitivas Box/Plane/Sphere/Cylinder/Torus)
    for (let t = 0; t + 1 < tris.length; t += 2) {
      tryMergePair(t, t + 1);
    }

    // Paso 2: parear cualquier otro par coplanar restante por arista compartida más larga (diagonal)
    const dirMap = new Map();
    for (let t = 0; t < tris.length; t++) {
      if (used[t]) continue;
      const f = tris[t];
      for (let i = 0; i < 3; i++) {
        const k = directedKey(f[i], f[(i + 1) % 3]);
        if (!dirMap.has(k)) dirMap.set(k, t);
      }
    }

    const candidates = [];
    for (let t0 = 0; t0 < tris.length; t0++) {
      if (used[t0]) continue;
      const f0 = tris[t0];
      for (let i = 0; i < 3; i++) {
        const u = f0[i];
        const v = f0[(i + 1) % 3];
        const t1 = dirMap.get(directedKey(v, u));
        if (t1 === undefined || t1 <= t0 || used[t1]) continue;
        const n0 = triNormals[t0];
        const n1 = triNormals[t1];
        const dot = n0.x * n1.x + n0.y * n1.y + n0.z * n1.z;
        if (dot < 0.9985) continue;
        const pu = verts[u], pv = verts[v];
        const lenSq = (pu.x - pv.x) ** 2 + (pu.y - pv.y) ** 2 + (pu.z - pv.z) ** 2;
        candidates.push({ t0, t1, score: dot * 10 + lenSq });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    for (let i = 0; i < candidates.length; i++) {
      tryMergePair(candidates[i].t0, candidates[i].t1);
    }

    for (let t = 0; t < tris.length; t++) {
      if (!used[t]) {
        faces.push(tris[t].slice());
        faceUvs.push(triUvs[t].map((uv) => uv.slice()));
      }
    }

    return new EditableMesh(verts, faces, faceUvs, []);
  }

  getTopology() {
    if (this._topologyCache) return this._topologyCache;

    const edgeMap = new Map();
    const edges = [];
    const vertFaces = Array.from({ length: this.verts.length }, () => []);
    const vertEdges = Array.from({ length: this.verts.length }, () => []);
    const faceEdges = new Array(this.faces.length);

    for (let fi = 0; fi < this.faces.length; fi++) {
      const f = this.faces[fi];
      const fe = [];
      for (let i = 0; i < f.length; i++) {
        const a = f[i];
        const b = f[(i + 1) % f.length];
        if (!vertFaces[a].includes(fi)) vertFaces[a].push(fi);

        const key = edgeKey(a, b);
        let ei = edgeMap.get(key);
        if (ei === undefined) {
          ei = edges.length;
          const lo = a < b ? a : b;
          const hi = a < b ? b : a;
          edgeMap.set(key, ei);
          edges.push({ key, a: lo, b: hi, faces: [], loose: false });
          vertEdges[lo].push(ei);
          vertEdges[hi].push(ei);
        }
        edges[ei].faces.push(fi);
        fe.push(ei);
      }
      faceEdges[fi] = fe;
    }

    for (let li = 0; li < this.looseEdges.length; li++) {
      const [a, b] = this.looseEdges[li];
      if (a === b || a < 0 || b < 0 || a >= this.verts.length || b >= this.verts.length) continue;
      const key = edgeKey(a, b);
      if (edgeMap.has(key)) continue;
      const ei = edges.length;
      const lo = a < b ? a : b;
      const hi = a < b ? b : a;
      edgeMap.set(key, ei);
      edges.push({ key, a: lo, b: hi, faces: [], loose: true });
      vertEdges[lo].push(ei);
      vertEdges[hi].push(ei);
    }

    this._topologyCache = { edges, edgeMap, vertFaces, vertEdges, faceEdges };
    return this._topologyCache;
  }

  getEdges() {
    return this.getTopology().edges;
  }

  computeFaceNormal(fi, out = new Vec3()) {
    const f = this.faces[fi];
    if (!f || f.length < 3) return out.set(0, 1, 0);
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < f.length; i++) {
      const a = this.verts[f[i]];
      const b = this.verts[f[(i + 1) % f.length]];
      nx += (a.y - b.y) * (a.z + b.z);
      ny += (a.z - b.z) * (a.x + b.x);
      nz += (a.x - b.x) * (a.y + b.y);
    }
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-10) return out.set(0, 1, 0);
    return out.set(nx / len, ny / len, nz / len);
  }

  computeFaceAreaNormal(fi, out = new Vec3()) {
    const f = this.faces[fi];
    if (!f || f.length < 3) return out.set(0, 0, 0);
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < f.length; i++) {
      const a = this.verts[f[i]];
      const b = this.verts[f[(i + 1) % f.length]];
      nx += (a.y - b.y) * (a.z + b.z);
      ny += (a.z - b.z) * (a.x + b.x);
      nz += (a.x - b.x) * (a.y + b.y);
    }
    return out.set(nx * 0.5, ny * 0.5, nz * 0.5);
  }

  computeFaceCenter(fi, out = new Vec3()) {
    const f = this.faces[fi];
    if (!f || !f.length) return out.set(0, 0, 0);
    let sx = 0, sy = 0, sz = 0;
    for (let i = 0; i < f.length; i++) {
      const p = this.verts[f[i]];
      sx += p.x; sy += p.y; sz += p.z;
    }
    const inv = 1 / f.length;
    return out.set(sx * inv, sy * inv, sz * inv);
  }

  computeVertexNormal(vi, out = new Vec3()) {
    const { vertFaces } = this.getTopology();
    const list = vertFaces[vi] || [];
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < list.length; i++) {
      this.computeFaceAreaNormal(list[i], _vA);
      nx += _vA.x; ny += _vA.y; nz += _vA.z;
    }
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-10) return out.set(0, 1, 0);
    return out.set(nx / len, ny / len, nz / len);
  }

  /**
   * Compila la malla poligonal a una Geometry indexada de Made3D.
   * Respeta aristas duras (creases >= creaseThreshold) generando división de normales suave/dura por arista.
   */
  toGeometry({ flatShading = false, creaseThreshold = 0.5 } = {}) {
    const geo = new Geometry();
    const positions = [];
    const normals = [];
    const uvs = [];
    const indices = [];

    let hasSharpCreases = false;
    if (!flatShading && this.creases && this.creases.size > 0) {
      for (const w of this.creases.values()) {
        if (w >= creaseThreshold) {
          hasSharpCreases = true;
          break;
        }
      }
    }

    const faceAreaNormals = new Array(this.faces.length);
    const faceNormals = new Array(this.faces.length);
    const vertNormals = !flatShading && !hasSharpCreases
      ? Array.from({ length: this.verts.length }, () => [0, 0, 0])
      : null;

    for (let fi = 0; fi < this.faces.length; fi++) {
      const an = this.computeFaceAreaNormal(fi, _vA);
      faceAreaNormals[fi] = [an.x, an.y, an.z];
      const len = Math.hypot(an.x, an.y, an.z) || 1;
      faceNormals[fi] = [an.x / len, an.y / len, an.z / len];
      if (vertNormals) {
        const f = this.faces[fi];
        for (let i = 0; i < f.length; i++) {
          const vn = vertNormals[f[i]];
          vn[0] += an.x; vn[1] += an.y; vn[2] += an.z;
        }
      }
    }

    if (vertNormals) {
      for (let i = 0; i < vertNormals.length; i++) {
        const vn = vertNormals[i];
        const l = Math.hypot(vn[0], vn[1], vn[2]) || 1;
        vn[0] /= l; vn[1] /= l; vn[2] /= l;
      }
    }

    // Si existen aristas con dureza >= creaseThreshold, agrupar abanicos de caras lisas por vértice
    const cornerNormals = hasSharpCreases ? new Array(this.faces.length) : null;
    if (hasSharpCreases) {
      const topo = this.getTopology();
      for (let fi = 0; fi < this.faces.length; fi++) {
        cornerNormals[fi] = new Array(this.faces[fi].length);
      }

      for (let vi = 0; vi < this.verts.length; vi++) {
        const incFaces = topo.vertFaces[vi];
        if (!incFaces || !incFaces.length) continue;
        if (incFaces.length === 1) {
          const fi = incFaces[0];
          const f = this.faces[fi];
          const n = faceNormals[fi];
          for (let k = 0; k < f.length; k++) {
            if (f[k] === vi) cornerNormals[fi][k] = n;
          }
          continue;
        }

        // Construir adyacencia suave entre caras incidentes a `vi`
        const incSet = new Set(incFaces);
        const visited = new Set();
        for (let startIdx = 0; startIdx < incFaces.length; startIdx++) {
          const seed = incFaces[startIdx];
          if (visited.has(seed)) continue;
          const group = [];
          const queue = [seed];
          visited.add(seed);
          let sx = 0, sy = 0, sz = 0;

          while (queue.length) {
            const curFi = queue.pop();
            group.push(curFi);
            const an = faceAreaNormals[curFi];
            sx += an[0]; sy += an[1]; sz += an[2];

            const fe = topo.faceEdges[curFi] || [];
            for (let eiIdx = 0; eiIdx < fe.length; eiIdx++) {
              const e = topo.edges[fe[eiIdx]];
              if (!e || (e.a !== vi && e.b !== vi)) continue;
              if (this.getEdgeCrease(e.a, e.b) >= creaseThreshold) continue;
              for (let nfIdx = 0; nfIdx < e.faces.length; nfIdx++) {
                const nfi = e.faces[nfIdx];
                if (incSet.has(nfi) && !visited.has(nfi)) {
                  visited.add(nfi);
                  queue.push(nfi);
                }
              }
            }
          }

          const len = Math.hypot(sx, sy, sz) || 1;
          const gn = [sx / len, sy / len, sz / len];
          for (let gi = 0; gi < group.length; gi++) {
            const gfi = group[gi];
            const f = this.faces[gfi];
            for (let k = 0; k < f.length; k++) {
              if (f[k] === vi) cornerNormals[gfi][k] = gn;
            }
          }
        }
      }
    }

    const cornerCache = new Map();
    const emitCorner = (vi, uv, nrm) => {
      if (!flatShading) {
        const uq = Math.round(uv[0] * 10000);
        const vq = Math.round(uv[1] * 10000);
        const key = hasSharpCreases
          ? `${vi}_${uq}_${vq}_${Math.round(nrm[0] * 1000)}_${Math.round(nrm[1] * 1000)}_${Math.round(nrm[2] * 1000)}`
          : `${vi}_${uq}_${vq}`;
        const existing = cornerCache.get(key);
        if (existing !== undefined) return existing;
        const idx = (positions.length / 3) | 0;
        const p = this.verts[vi];
        positions.push(p.x, p.y, p.z);
        normals.push(nrm[0], nrm[1], nrm[2]);
        uvs.push(uv[0], uv[1]);
        cornerCache.set(key, idx);
        return idx;
      }
      const idx = (positions.length / 3) | 0;
      const p = this.verts[vi];
      positions.push(p.x, p.y, p.z);
      normals.push(nrm[0], nrm[1], nrm[2]);
      uvs.push(uv[0], uv[1]);
      return idx;
    };

    const emitCustomVertex = (x, y, z, uv, nrm) => {
      const idx = (positions.length / 3) | 0;
      positions.push(x, y, z);
      normals.push(nrm[0], nrm[1], nrm[2]);
      uvs.push(uv[0], uv[1]);
      return idx;
    };

    const triAlignScore = (a, b, c, refN) => {
      const e1x = b.x - a.x, e1y = b.y - a.y, e1z = b.z - a.z;
      const e2x = c.x - a.x, e2y = c.y - a.y, e2z = c.z - a.z;
      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;
      const l = Math.hypot(nx, ny, nz);
      if (l < 1e-10) return -1;
      return (nx * refN[0] + ny * refN[1] + nz * refN[2]) / l;
    };

    for (let fi = 0; fi < this.faces.length; fi++) {
      const f = this.faces[fi];
      if (!f || f.length < 3) continue;
      const fUv = this.faceUvs[fi] || f.map(() => [0, 0]);
      const fn = faceNormals[fi];

      const cornerIndices = new Array(f.length);
      for (let i = 0; i < f.length; i++) {
        const vi = f[i];
        const nrm = flatShading ? fn : (hasSharpCreases ? (cornerNormals[fi][i] || fn) : vertNormals[vi]);
        cornerIndices[i] = emitCorner(vi, fUv[i] || [0, 0], nrm);
      }

      if (f.length === 3) {
        indices.push(cornerIndices[0], cornerIndices[1], cornerIndices[2]);
      } else if (f.length === 4) {
        const p0 = this.verts[f[0]], p1 = this.verts[f[1]], p2 = this.verts[f[2]], p3 = this.verts[f[3]];
        const s02 = Math.min(triAlignScore(p0, p1, p2, fn), triAlignScore(p0, p2, p3, fn));
        const s13 = Math.min(triAlignScore(p1, p2, p3, fn), triAlignScore(p1, p3, p0, fn));
        // Mantener la diagonal 0-2 consistente al mover aristas y solo alternar a 1-3 si el quad se vuelve cóncavo/invertido
        if (s02 < 0.1 && s13 > s02 + 0.15) {
          indices.push(
            cornerIndices[1], cornerIndices[2], cornerIndices[3],
            cornerIndices[1], cornerIndices[3], cornerIndices[0]
          );
        } else {
          indices.push(
            cornerIndices[0], cornerIndices[1], cornerIndices[2],
            cornerIndices[0], cornerIndices[2], cornerIndices[3]
          );
        }
      } else {
        // N-gon (>= 5 vértices): abanico desde centroide para conservar todos los vértices de borde sin grietas
        let cx = 0, cy = 0, cz = 0, cu = 0, cv = 0;
        let nx = 0, ny = 0, nz = 0;
        for (let i = 0; i < f.length; i++) {
          const p = this.verts[f[i]];
          cx += p.x; cy += p.y; cz += p.z;
          const uv = fUv[i] || [0, 0];
          cu += uv[0]; cv += uv[1];
          if (!flatShading) {
            const vn = hasSharpCreases ? (cornerNormals[fi][i] || fn) : vertNormals[f[i]];
            nx += vn[0]; ny += vn[1]; nz += vn[2];
          }
        }
        const inv = 1 / f.length;
        let centerNormal = fn;
        if (!flatShading) {
          const l = Math.hypot(nx, ny, nz) || 1;
          centerNormal = [nx / l, ny / l, nz / l];
        }
        const centerIdx = emitCustomVertex(cx * inv, cy * inv, cz * inv, [cu * inv, cv * inv], centerNormal);
        for (let i = 0; i < f.length; i++) {
          indices.push(cornerIndices[i], cornerIndices[(i + 1) % f.length], centerIdx);
        }
      }
    }

    if (!positions.length) {
      positions.push(0, 0, 0, 0, 0, 0, 0, 0, 0);
      normals.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
      uvs.push(0, 0, 0, 0, 0, 0);
      indices.push(0, 1, 2);
    }

    geo.setAttribute('position', new Float32Array(positions), 3);
    geo.setAttribute('normal', new Float32Array(normals), 3);
    geo.setAttribute('uv', new Float32Array(uvs), 2);
    geo.setIndex(indices);
    return geo;
  }

  /**
   * Lanza un rayo en espacio mundo contra las caras poligonales del EditableMesh.
   */
  raycastFace(ray, invMatrixWorld) {
    if (!ray || !invMatrixWorld || !this.faces.length) return null;
    _rayLocalOrigin.copy(ray.origin).applyMatrix4(invMatrixWorld);
    const ie = invMatrixWorld.elements;
    const dx = ie[0] * ray.direction.x + ie[4] * ray.direction.y + ie[8] * ray.direction.z;
    const dy = ie[1] * ray.direction.x + ie[5] * ray.direction.y + ie[9] * ray.direction.z;
    const dz = ie[2] * ray.direction.x + ie[6] * ray.direction.y + ie[10] * ray.direction.z;
    _rayLocalDir.set(dx, dy, dz);

    let bestT = Infinity;
    let bestFace = -1;

    for (let fi = 0; fi < this.faces.length; fi++) {
      const f = this.faces[fi];
      if (f.length < 3) continue;
      if (f.length <= 4) {
        const a = this.verts[f[0]];
        for (let i = 1; i + 1 < f.length; i++) {
          const t = rayTriangleLocal(
            _rayLocalOrigin.x, _rayLocalOrigin.y, _rayLocalOrigin.z,
            _rayLocalDir.x, _rayLocalDir.y, _rayLocalDir.z,
            a, this.verts[f[i]], this.verts[f[i + 1]]
          );
          if (t !== null && t < bestT) {
            bestT = t;
            bestFace = fi;
          }
        }
      } else {
        const center = this.computeFaceCenter(fi, _vD);
        for (let i = 0; i < f.length; i++) {
          const t = rayTriangleLocal(
            _rayLocalOrigin.x, _rayLocalOrigin.y, _rayLocalOrigin.z,
            _rayLocalDir.x, _rayLocalDir.y, _rayLocalDir.z,
            this.verts[f[i]], this.verts[f[(i + 1) % f.length]], center
          );
          if (t !== null && t < bestT) {
            bestT = t;
            bestFace = fi;
          }
        }
      }
    }

    if (bestFace < 0) return null;
    const localPoint = _rayLocalOrigin.clone().addScaledVector(_rayLocalDir, bestT);
    return { faceIndex: bestFace, t: bestT, localPoint };
  }

  /**
   * Devuelve índices únicos de vértices cubiertos por la selección actual ('vertex' | 'edge' | 'face').
   */
  getSelectedVertexIndices(mode, selection) {
    const out = new Set();
    if (!selection || !selection.size) return out;
    if (mode === 'vertex') {
      for (const vi of selection) {
        if (vi >= 0 && vi < this.verts.length) out.add(vi);
      }
    } else if (mode === 'edge') {
      const edges = this.getEdges();
      for (const ei of selection) {
        const e = edges[ei];
        if (e) { out.add(e.a); out.add(e.b); }
      }
    } else if (mode === 'face') {
      for (const fi of selection) {
        const f = this.faces[fi];
        if (f) {
          for (let i = 0; i < f.length; i++) out.add(f[i]);
        }
      }
    }
    return out;
  }

  /**
   * Elimina vértices huérfanos sin caras ni aristas sueltas asociadas y remapea índices.
   */
  pruneUnusedVertices() {
    const used = new Uint8Array(this.verts.length);
    for (let fi = 0; fi < this.faces.length; fi++) {
      const f = this.faces[fi];
      for (let i = 0; i < f.length; i++) used[f[i]] = 1;
    }
    for (let li = 0; li < this.looseEdges.length; li++) {
      const [a, b] = this.looseEdges[li];
      if (a >= 0 && a < used.length) used[a] = 1;
      if (b >= 0 && b < used.length) used[b] = 1;
    }

    const remap = new Int32Array(this.verts.length);
    remap.fill(-1);
    const nextVerts = [];
    for (let i = 0; i < this.verts.length; i++) {
      if (used[i]) {
        remap[i] = nextVerts.length;
        nextVerts.push(this.verts[i]);
      }
    }
    if (nextVerts.length === this.verts.length) {
      this.invalidateTopology();
      return null;
    }

    this.verts = nextVerts;
    for (let fi = 0; fi < this.faces.length; fi++) {
      const f = this.faces[fi];
      for (let i = 0; i < f.length; i++) f[i] = remap[f[i]];
    }
    this.looseEdges = this.looseEdges
      .map(([a, b]) => [remap[a], remap[b]])
      .filter(([a, b]) => a >= 0 && b >= 0 && a !== b);
    this._remapCreases(remap);
    this.invalidateTopology();
    return remap;
  }

  /**
   * Subdivide las caras, aristas o vértices seleccionados (o toda la malla si no hay selección)
   * manteniendo topología cerrada sin grietas en T-junctions.
   */
  subdivideSelection(mode, selection, cuts = 1) {
    const nCuts = Math.max(1, Math.min(4, cuts | 0));
    const topo = this.getTopology();
    const { edges, edgeMap } = topo;

    const targetFaces = new Set();
    const targetEdges = new Set();

    if (mode === 'face') {
      if (selection && selection.size) {
        for (const fi of selection) {
          if (fi >= 0 && fi < this.faces.length) targetFaces.add(fi);
        }
      } else {
        for (let fi = 0; fi < this.faces.length; fi++) targetFaces.add(fi);
      }
      for (const fi of targetFaces) {
        const fe = topo.faceEdges[fi] || [];
        for (let i = 0; i < fe.length; i++) targetEdges.add(fe[i]);
      }
    } else if (mode === 'edge') {
      if (selection && selection.size) {
        for (const ei of selection) {
          if (ei >= 0 && ei < edges.length) targetEdges.add(ei);
        }
      } else {
        for (let fi = 0; fi < this.faces.length; fi++) targetFaces.add(fi);
        for (let ei = 0; ei < edges.length; ei++) targetEdges.add(ei);
      }
    } else {
      // mode === 'vertex'
      const vSel = selection || new Set();
      if (vSel.size >= 2) {
        for (let ei = 0; ei < edges.length; ei++) {
          if (vSel.has(edges[ei].a) && vSel.has(edges[ei].b)) targetEdges.add(ei);
        }
      }
      if (!targetEdges.size) {
        for (let fi = 0; fi < this.faces.length; fi++) targetFaces.add(fi);
        for (let ei = 0; ei < edges.length; ei++) targetEdges.add(ei);
      }
    }

    if (!targetFaces.size && !targetEdges.size) {
      return { changed: false, selected: new Set() };
    }

    // Si en modo arista una cara tiene todas sus aristas seleccionadas, subdividir la cara completa
    if (mode === 'edge' && !targetFaces.size) {
      for (let fi = 0; fi < this.faces.length; fi++) {
        const fe = topo.faceEdges[fi];
        if (fe && fe.length && fe.every((ei) => targetEdges.has(ei))) {
          targetFaces.add(fi);
        }
      }
    }

    // Crear los vértices de corte a lo largo de cada arista objetivo (ordenados lo -> hi)
    const edgeSplits = new Map(); // edgeKey -> number[] (vértices internos de corte)
    for (const ei of targetEdges) {
      const e = edges[ei];
      const va = this.verts[e.a];
      const vb = this.verts[e.b];
      const mids = [];
      for (let k = 1; k <= nCuts; k++) {
        const t = k / (nCuts + 1);
        const vi = this.verts.length;
        this.verts.push({
          x: va.x + (vb.x - va.x) * t,
          y: va.y + (vb.y - va.y) * t,
          z: va.z + (vb.z - va.z) * t,
        });
        mids.push(vi);
      }
      edgeSplits.set(e.key, mids);
    }

    const getEdgeChain = (a, b) => {
      const mids = edgeSplits.get(edgeKey(a, b));
      if (!mids || !mids.length) return [];
      return a < b ? mids : mids.slice().reverse();
    };

    const nextFaces = [];
    const nextFaceUvs = [];
    const newSelectedFaces = new Set();
    const newSelectedEdgesKeys = new Set();
    const newSelectedVerts = new Set();

    for (const arr of edgeSplits.values()) {
      for (let i = 0; i < arr.length; i++) newSelectedVerts.add(arr[i]);
    }

    const N = nCuts + 1;

    for (let fi = 0; fi < this.faces.length; fi++) {
      const f = this.faces[fi];
      const fUv = this.faceUvs[fi] || f.map(() => [0, 0]);
      const fe = topo.faceEdges[fi] || [];

      if (targetFaces.has(fi)) {
        if (f.length === 4) {
          const [v0, v1, v2, v3] = f;
          const top = [v0, ...getEdgeChain(v0, v1), v1]; // i=0..N de v0 -> v1
          const bottom = [v3, ...getEdgeChain(v3, v2), v2]; // i=0..N de v3 -> v2
          const left = [v0, ...getEdgeChain(v0, v3), v3]; // j=0..N de v0 -> v3
          const right = [v1, ...getEdgeChain(v1, v2), v2]; // j=0..N de v1 -> v2

          const hasQuadCorners = new Set([v0, v1, v2, v3]).size === 4;
          const validSides =
            hasQuadCorners &&
            top.length === N + 1 &&
            bottom.length === N + 1 &&
            left.length === N + 1 &&
            right.length === N + 1;

          if (validSides) {
            // Subdivisión en rejilla N x N para quads
            const [uv0, uv1, uv2, uv3] = fUv;
            const grid = Array.from({ length: N + 1 }, () => new Int32Array(N + 1).fill(-1));
            const gridUv = Array.from({ length: N + 1 }, () => new Array(N + 1));

            for (let j = 0; j <= N; j++) {
              const vFrac = j / N;
              for (let i = 0; i <= N; i++) {
                const uFrac = i / N;
                const u = (1 - uFrac) * (1 - vFrac) * uv0[0] + uFrac * (1 - vFrac) * uv1[0] + uFrac * vFrac * uv2[0] + (1 - uFrac) * vFrac * uv3[0];
                const v = (1 - uFrac) * (1 - vFrac) * uv0[1] + uFrac * (1 - vFrac) * uv1[1] + uFrac * vFrac * uv2[1] + (1 - uFrac) * vFrac * uv3[1];
                gridUv[j][i] = [u, v];

                if (j === 0) grid[j][i] = top[i];
                else if (j === N) grid[j][i] = bottom[i];
                else if (i === 0) grid[j][i] = left[j];
                else if (i === N) grid[j][i] = right[j];
                else {
                  const p0 = this.verts[v0], p1 = this.verts[v1], p2 = this.verts[v2], p3 = this.verts[v3];
                  const vi = this.verts.length;
                  this.verts.push({
                    x: (1 - uFrac) * (1 - vFrac) * p0.x + uFrac * (1 - vFrac) * p1.x + uFrac * vFrac * p2.x + (1 - uFrac) * vFrac * p3.x,
                    y: (1 - uFrac) * (1 - vFrac) * p0.y + uFrac * (1 - vFrac) * p1.y + uFrac * vFrac * p2.y + (1 - uFrac) * vFrac * p3.y,
                    z: (1 - uFrac) * (1 - vFrac) * p0.z + uFrac * (1 - vFrac) * p1.z + uFrac * vFrac * p2.z + (1 - uFrac) * vFrac * p3.z,
                  });
                  grid[j][i] = vi;
                  newSelectedVerts.add(vi);
                }
              }
            }

            for (let j = 0; j < N; j++) {
              for (let i = 0; i < N; i++) {
                const qa = grid[j][i], qb = grid[j][i + 1], qc = grid[j + 1][i + 1], qd = grid[j + 1][i];
                if (qa < 0 || qb < 0 || qc < 0 || qd < 0) continue;
                const qIdx = nextFaces.length;
                nextFaces.push([qa, qb, qc, qd]);
                nextFaceUvs.push([gridUv[j][i], gridUv[j][i + 1], gridUv[j + 1][i + 1], gridUv[j + 1][i]]);
                newSelectedFaces.add(qIdx);
              }
            }
            continue;
          }
        }

        // Polígono no-quad (triángulo, N-gon o quad irregular):
        // Respetar siempre los cortes existentes en edgeSplits sin sobrescribirlos
        const k = f.length;
        if (k < 3) continue;

        let cx = 0, cy = 0, cz = 0, cu = 0, cv = 0;
        for (let i = 0; i < k; i++) {
          const p = this.verts[f[i]];
          const uv = fUv[i] || [0, 0];
          cx += p.x; cy += p.y; cz += p.z;
          cu += uv[0]; cv += uv[1];
        }
        const fc = this.verts.length;
        this.verts.push({ x: cx / k, y: cy / k, z: cz / k });
        newSelectedVerts.add(fc);
        const fcUv = [cu / k, cv / k];

        if (nCuts === 1) {
          const mids = new Array(k);
          const midUvs = new Array(k);
          let allMidReady = true;
          for (let i = 0; i < k; i++) {
            const a = f[i], b = f[(i + 1) % k];
            const chain = getEdgeChain(a, b);
            if (chain.length !== 1) {
              allMidReady = false;
              break;
            }
            mids[i] = chain[0];
            const uvA = fUv[i] || [0, 0];
            const uvB = fUv[(i + 1) % k] || [0, 0];
            midUvs[i] = [(uvA[0] + uvB[0]) * 0.5, (uvA[1] + uvB[1]) * 0.5];
          }
          if (allMidReady) {
            for (let i = 0; i < k; i++) {
              const prev = (i - 1 + k) % k;
              const uvCorner = (fUv[i] || [0, 0]).slice();
              const qIdx = nextFaces.length;
              nextFaces.push([f[i], mids[i], fc, mids[prev]]);
              nextFaceUvs.push([uvCorner, midUvs[i].slice(), fcUv.slice(), midUvs[prev].slice()]);
              newSelectedFaces.add(qIdx);
            }
            continue;
          }
        }

        // Subdivisión concéntrica conforme al borde para nCuts >= 2 (o cadenas mixtas)
        const boundary = [];
        const boundaryUv = [];
        for (let i = 0; i < k; i++) {
          const a = f[i];
          const b = f[(i + 1) % k];
          const uvA = fUv[i] || [0, 0];
          const uvB = fUv[(i + 1) % k] || [0, 0];
          boundary.push(a);
          boundaryUv.push(uvA.slice());
          const chain = getEdgeChain(a, b);
          for (let s = 0; s < chain.length; s++) {
            const frac = (s + 1) / (chain.length + 1);
            boundary.push(chain[s]);
            boundaryUv.push([uvA[0] + (uvB[0] - uvA[0]) * frac, uvA[1] + (uvB[1] - uvA[1]) * frac]);
          }
        }

        const M = boundary.length;
        if (M < 3) continue;

        const fcPos = this.verts[fc];
        const rings = [boundary];
        const ringsUv = [boundaryUv];

        for (let step = 1; step <= nCuts; step++) {
          const alpha = step / (nCuts + 1);
          const invAlpha = 1 - alpha;
          const rVerts = new Array(M);
          const rUvs = new Array(M);
          for (let m = 0; m < M; m++) {
            const bp = this.verts[boundary[m]];
            const buv = boundaryUv[m];
            const nvi = this.verts.length;
            this.verts.push({
              x: bp.x * invAlpha + fcPos.x * alpha,
              y: bp.y * invAlpha + fcPos.y * alpha,
              z: bp.z * invAlpha + fcPos.z * alpha,
            });
            rVerts[m] = nvi;
            rUvs[m] = [buv[0] * invAlpha + fcUv[0] * alpha, buv[1] * invAlpha + fcUv[1] * alpha];
            newSelectedVerts.add(nvi);
          }
          rings.push(rVerts);
          ringsUv.push(rUvs);
        }

        // Anillos de quads entre anillos concéntricos
        for (let r = 0; r < rings.length - 1; r++) {
          const rOut = rings[r];
          const rIn = rings[r + 1];
          const uvOut = ringsUv[r];
          const uvIn = ringsUv[r + 1];
          for (let m = 0; m < M; m++) {
            const mNext = (m + 1) % M;
            const a = rOut[m], b = rOut[mNext], c = rIn[mNext], d = rIn[m];
            if (new Set([a, b, c, d]).size < 3) continue;
            const qIdx = nextFaces.length;
            nextFaces.push([a, b, c, d]);
            nextFaceUvs.push([uvOut[m].slice(), uvOut[mNext].slice(), uvIn[mNext].slice(), uvIn[m].slice()]);
            newSelectedFaces.add(qIdx);
          }
        }

        // Abanico central hacia fc
        const inner = rings[rings.length - 1];
        const innerUv = ringsUv[ringsUv.length - 1];
        for (let m = 0; m < M; m++) {
          const mNext = (m + 1) % M;
          const a = inner[m], b = inner[mNext];
          if (a === b || a === fc || b === fc) continue;
          const qIdx = nextFaces.length;
          nextFaces.push([a, b, fc]);
          nextFaceUvs.push([innerUv[m].slice(), innerUv[mNext].slice(), fcUv.slice()]);
          newSelectedFaces.add(qIdx);
        }
        continue;
      }

      // En modo arista: si un quad tiene exactamente 2 aristas opuestas seleccionadas, cortar en tiras (loop/ring cut)
      if (mode === 'edge' && f.length === 4) {
        const s0 = targetEdges.has(fe[0]);
        const s1 = targetEdges.has(fe[1]);
        const s2 = targetEdges.has(fe[2]);
        const s3 = targetEdges.has(fe[3]);
        if (s0 && s2 && !s1 && !s3) {
          const top = [f[0], ...getEdgeChain(f[0], f[1]), f[1]];
          const bot = [f[3], ...getEdgeChain(f[3], f[2]), f[2]];
          for (let i = 0; i < N; i++) {
            const t0 = i / N, t1 = (i + 1) / N;
            const uvA = [fUv[0][0] + (fUv[1][0] - fUv[0][0]) * t0, fUv[0][1] + (fUv[1][1] - fUv[0][1]) * t0];
            const uvB = [fUv[0][0] + (fUv[1][0] - fUv[0][0]) * t1, fUv[0][1] + (fUv[1][1] - fUv[0][1]) * t1];
            const uvC = [fUv[3][0] + (fUv[2][0] - fUv[3][0]) * t1, fUv[3][1] + (fUv[2][1] - fUv[3][1]) * t1];
            const uvD = [fUv[3][0] + (fUv[2][0] - fUv[3][0]) * t0, fUv[3][1] + (fUv[2][1] - fUv[3][1]) * t0];
            nextFaces.push([top[i], top[i + 1], bot[i + 1], bot[i]]);
            nextFaceUvs.push([uvA, uvB, uvC, uvD]);
            if (i > 0) newSelectedEdgesKeys.add(edgeKey(top[i], bot[i]));
          }
          continue;
        }
        if (s1 && s3 && !s0 && !s2) {
          const right = [f[1], ...getEdgeChain(f[1], f[2]), f[2]];
          const left = [f[0], ...getEdgeChain(f[0], f[3]), f[3]];
          for (let j = 0; j < N; j++) {
            const t0 = j / N, t1 = (j + 1) / N;
            const uvA = [fUv[0][0] + (fUv[3][0] - fUv[0][0]) * t0, fUv[0][1] + (fUv[3][1] - fUv[0][1]) * t0];
            const uvB = [fUv[1][0] + (fUv[2][0] - fUv[1][0]) * t0, fUv[1][1] + (fUv[2][1] - fUv[1][1]) * t0];
            const uvC = [fUv[1][0] + (fUv[2][0] - fUv[1][0]) * t1, fUv[1][1] + (fUv[2][1] - fUv[1][1]) * t1];
            const uvD = [fUv[0][0] + (fUv[3][0] - fUv[0][0]) * t1, fUv[0][1] + (fUv[3][1] - fUv[0][1]) * t1];
            nextFaces.push([left[j], right[j], right[j + 1], left[j + 1]]);
            nextFaceUvs.push([uvA, uvB, uvC, uvD]);
            if (j > 0) newSelectedEdgesKeys.add(edgeKey(left[j], right[j]));
          }
          continue;
        }
      }

      // Cara no seleccionada (o parcialmente dividida): insertar los vértices de corte de sus aristas vecinas para no crear grietas
      const ring = [];
      const ringUv = [];
      for (let i = 0; i < f.length; i++) {
        const a = f[i];
        const b = f[(i + 1) % f.length];
        const uvA = fUv[i] || [0, 0];
        const uvB = fUv[(i + 1) % f.length] || [0, 0];
        ring.push(a);
        ringUv.push(uvA.slice());
        const chain = getEdgeChain(a, b);
        for (let k = 0; k < chain.length; k++) {
          const t = (k + 1) / (chain.length + 1);
          ring.push(chain[k]);
          ringUv.push([uvA[0] + (uvB[0] - uvA[0]) * t, uvA[1] + (uvB[1] - uvA[1]) * t]);
        }
      }
      nextFaces.push(ring);
      nextFaceUvs.push(ringUv);
    }

    // Actualizar aristas sueltas si alguna se dividió
    const nextLoose = [];
    for (let li = 0; li < this.looseEdges.length; li++) {
      const [a, b] = this.looseEdges[li];
      const chain = getEdgeChain(a, b);
      if (!chain.length) {
        nextLoose.push([a, b]);
      } else {
        const full = [a, ...chain, b];
        for (let i = 0; i < full.length - 1; i++) {
          nextLoose.push([full[i], full[i + 1]]);
          newSelectedEdgesKeys.add(edgeKey(full[i], full[i + 1]));
        }
      }
    }

    // Recolectar aristas seleccionadas tras subdividir
    for (const ei of targetEdges) {
      const e = edges[ei];
      const chain = getEdgeChain(e.a, e.b);
      const full = [e.a, ...chain, e.b];
      for (let i = 0; i < full.length - 1; i++) {
        newSelectedEdgesKeys.add(edgeKey(full[i], full[i + 1]));
      }
    }

    // Propagar y dividir dureza (crease) en aristas divididas
    for (const [k, chain] of edgeSplits.entries()) {
      const w = this.creases.get(k);
      if (!w) continue;
      const sep = k.indexOf('_');
      const a = Number(k.slice(0, sep));
      const b = Number(k.slice(sep + 1));
      this.creases.delete(k);
      const full = [a, ...chain, b];
      for (let i = 0; i < full.length - 1; i++) {
        this.creases.set(edgeKey(full[i], full[i + 1]), w);
      }
    }

    this.faces = nextFaces;
    this.faceUvs = nextFaceUvs;
    this.looseEdges = nextLoose;
    this.invalidateTopology();

    if (mode === 'face') {
      return { changed: true, selected: newSelectedFaces };
    }
    if (mode === 'edge') {
      const nextTopo = this.getTopology();
      const edgeSel = new Set();
      for (const k of newSelectedEdgesKeys) {
        const ei = nextTopo.edgeMap.get(k);
        if (ei !== undefined) edgeSel.add(ei);
      }
      return { changed: true, selected: edgeSel };
    }
    return { changed: true, selected: newSelectedVerts };
  }

  /**
   * Extruye las caras, aristas o vértices seleccionados a lo largo de la normal (o desplazamiento).
   */
  extrudeSelection(mode, selection, distance = 0.06) {
    if (!selection || !selection.size) return { changed: false, selected: new Set() };

    if (mode === 'face') {
      const selFaces = new Set();
      for (const fi of selection) {
        if (fi >= 0 && fi < this.faces.length) selFaces.add(fi);
      }
      if (!selFaces.size) return { changed: false, selected: new Set() };

      // Half-edges de caras seleccionadas
      const halfEdgeOwner = new Map();
      const selVerts = new Set();
      const avgN = new Vec3();
      const vNormals = new Map();

      for (const fi of selFaces) {
        const f = this.faces[fi];
        const fn = this.computeFaceNormal(fi, _vA);
        avgN.add(fn);
        for (let i = 0; i < f.length; i++) {
          const u = f[i];
          const v = f[(i + 1) % f.length];
          selVerts.add(u);
          let vn = vNormals.get(u);
          if (!vn) { vn = new Vec3(); vNormals.set(u, vn); }
          vn.add(fn);
          halfEdgeOwner.set(directedKey(u, v), { fi, i, u, v });
        }
      }

      const avgLen = avgN.length();
      const useRegionDir = avgLen > 0.25 * Math.max(1, selFaces.size * 0.35);
      if (useRegionDir) avgN.multiplyScalar(1 / avgLen);

      // Clonar vértices para la tapa extruida
      const vertCopy = new Map();
      for (const vi of selVerts) {
        const src = this.verts[vi];
        let dir = avgN;
        if (!useRegionDir) {
          const vn = vNormals.get(vi);
          dir = vn ? vn.clone() : new Vec3(0, 1, 0);
          if (dir.lengthSq() < 1e-8) dir.set(0, 1, 0);
          else dir.normalize();
        }
        const nv = this.verts.length;
        this.verts.push({
          x: src.x + dir.x * distance,
          y: src.y + dir.y * distance,
          z: src.z + dir.z * distance,
        });
        vertCopy.set(vi, nv);
      }

      // Paredes laterales para cada borde exterior de la región seleccionada
      const sideFaces = [];
      const sideUvs = [];
      for (const info of halfEdgeOwner.values()) {
        if (halfEdgeOwner.has(directedKey(info.v, info.u))) continue; // borde interno entre 2 caras seleccionadas
        const uNew = vertCopy.get(info.u);
        const vNew = vertCopy.get(info.v);
        if (uNew === undefined || vNew === undefined || info.u === info.v) continue;
        const origFace = this.faces[info.fi];
        const fUv = this.faceUvs[info.fi] || [];
        const uvU = fUv[info.i] || [0, 0];
        const uvV = fUv[(info.i + 1) % origFace.length] || [1, 0];
        sideFaces.push([info.u, info.v, vNew, uNew]);
        sideUvs.push([uvU.slice(), uvV.slice(), [uvV[0], uvV[1] + 0.5], [uvU[0], uvU[1] + 0.5]]);
      }

      // Reemplazar vértices de las caras seleccionadas por las copias extruidas
      for (const fi of selFaces) {
        const f = this.faces[fi];
        for (let i = 0; i < f.length; i++) {
          const mapped = vertCopy.get(f[i]);
          if (mapped !== undefined) f[i] = mapped;
        }
      }

      while (this.faceUvs.length < this.faces.length) {
        this.faceUvs.push(this.faces[this.faceUvs.length].map(() => [0, 0]));
      }
      for (let i = 0; i < sideFaces.length; i++) {
        this.faces.push(sideFaces[i]);
        this.faceUvs.push(sideUvs[i]);
      }

      this.pruneUnusedVertices();
      this.invalidateTopology();
      return { changed: true, selected: selFaces };
    }

    if (mode === 'edge') {
      const topo = this.getTopology();
      const selEdges = [];
      const vertSet = new Set();
      for (const ei of selection) {
        const e = topo.edges[ei];
        if (e) {
          selEdges.push(e);
          vertSet.add(e.a);
          vertSet.add(e.b);
        }
      }
      if (!selEdges.length) return { changed: false, selected: new Set() };

      const vertCopy = new Map();
      for (const vi of vertSet) {
        const src = this.verts[vi];
        const nrm = this.computeVertexNormal(vi, _vA);
        const nv = this.verts.length;
        this.verts.push({
          x: src.x + nrm.x * distance,
          y: src.y + nrm.y * distance,
          z: src.z + nrm.z * distance,
        });
        vertCopy.set(vi, nv);
      }

      const newEdgeKeys = [];
      for (let i = 0; i < selEdges.length; i++) {
        const e = selEdges[i];
        let u = e.a;
        let v = e.b;
        // Respetar orientación opuesta si tiene exactamente 1 cara incidente (borde abierto)
        if (e.faces.length === 1) {
          const f = this.faces[e.faces[0]];
          for (let k = 0; k < f.length; k++) {
            if (f[k] === e.a && f[(k + 1) % f.length] === e.b) {
              u = e.b;
              v = e.a;
              break;
            }
          }
        }
        const uNew = vertCopy.get(u);
        const vNew = vertCopy.get(v);
        this.faces.push([u, v, vNew, uNew]);
        this.faceUvs.push([[0, 0], [1, 0], [1, 1], [0, 1]]);
        newEdgeKeys.push(edgeKey(uNew, vNew));
      }

      this.invalidateTopology();
      const nextTopo = this.getTopology();
      const nextSel = new Set();
      for (let i = 0; i < newEdgeKeys.length; i++) {
        const ei = nextTopo.edgeMap.get(newEdgeKeys[i]);
        if (ei !== undefined) nextSel.add(ei);
      }
      return { changed: true, selected: nextSel };
    }

    // mode === 'vertex'
    const selVerts = [];
    for (const vi of selection) {
      if (vi >= 0 && vi < this.verts.length) selVerts.push(vi);
    }
    if (!selVerts.length) return { changed: false, selected: new Set() };

    const nextVerts = new Set();
    const copyMap = new Map();
    for (let i = 0; i < selVerts.length; i++) {
      const vi = selVerts[i];
      const src = this.verts[vi];
      const nrm = this.computeVertexNormal(vi, _vA);
      const nv = this.verts.length;
      this.verts.push({
        x: src.x + nrm.x * distance,
        y: src.y + nrm.y * distance,
        z: src.z + nrm.z * distance,
      });
      copyMap.set(vi, nv);
      nextVerts.add(nv);
    }
    // Si dos vértices seleccionados formaban una arista, crear también cara puente
    const topo = this.getTopology();
    const bridgedVerts = new Set();
    for (let i = 0; i < topo.edges.length; i++) {
      const e = topo.edges[i];
      if (copyMap.has(e.a) && copyMap.has(e.b)) {
        const aNew = copyMap.get(e.a);
        const bNew = copyMap.get(e.b);
        this.faces.push([e.a, e.b, bNew, aNew]);
        this.faceUvs.push([[0, 0], [1, 0], [1, 1], [0, 1]]);
        bridgedVerts.add(e.a);
        bridgedVerts.add(e.b);
      }
    }
    for (const [vi, nv] of copyMap.entries()) {
      if (!bridgedVerts.has(vi)) {
        this.looseEdges.push([vi, nv]);
      }
    }

    this.invalidateTopology();
    return { changed: true, selected: nextVerts };
  }

  /**
   * Elimina las caras, aristas o vértices seleccionados manteniendo la malla válida.
   */
  deleteSelection(mode, selection) {
    if (!selection || !selection.size) return { changed: false, selected: new Set() };

    const removeFaces = new Set();
    if (mode === 'face') {
      for (const fi of selection) removeFaces.add(fi);
    } else if (mode === 'edge') {
      const edges = this.getEdges();
      const removeLooseKeys = new Set();
      for (const ei of selection) {
        const e = edges[ei];
        if (!e) continue;
        removeLooseKeys.add(e.key);
        for (let i = 0; i < e.faces.length; i++) removeFaces.add(e.faces[i]);
      }
      this.looseEdges = this.looseEdges.filter(([a, b]) => !removeLooseKeys.has(edgeKey(a, b)));
    } else {
      for (let fi = 0; fi < this.faces.length; fi++) {
        const f = this.faces[fi];
        if (f.some((vi) => selection.has(vi))) removeFaces.add(fi);
      }
      this.looseEdges = this.looseEdges.filter(([a, b]) => !selection.has(a) && !selection.has(b));
    }

    if (removeFaces.size >= this.faces.length && this.looseEdges.length === 0) {
      return { changed: false, error: 'No puedes eliminar todas las caras del objeto.' };
    }

    const nextFaces = [];
    const nextFaceUvs = [];
    for (let fi = 0; fi < this.faces.length; fi++) {
      if (!removeFaces.has(fi)) {
        nextFaces.push(this.faces[fi]);
        nextFaceUvs.push(this.faceUvs[fi]);
      }
    }

    if (nextFaces.length === this.faces.length && mode !== 'edge' && mode !== 'vertex') {
      return { changed: false, selected: new Set() };
    }

    this.faces = nextFaces;
    this.faceUvs = nextFaceUvs;
    this.pruneUnusedVertices();
    this.invalidateTopology();
    return { changed: true, selected: new Set() };
  }

  _interpolateFaceUv(fi, px, py, pz) {
    const f = this.faces[fi];
    const fUv = this.faceUvs[fi] || [];
    if (!f || !f.length) return [0, 0];
    let wSum = 0, uSum = 0, vSum = 0;
    for (let i = 0; i < f.length; i++) {
      const v = this.verts[f[i]];
      const d = Math.hypot(px - v.x, py - v.y, pz - v.z);
      if (d < 1e-6) return (fUv[i] || [0, 0]).slice();
      const w = 1 / (d * d);
      const uv = fUv[i] || [0, 0];
      uSum += uv[0] * w;
      vSum += uv[1] * w;
      wSum += w;
    }
    return wSum > 0 ? [uSum / wSum, vSum / wSum] : [0, 0];
  }

  /**
   * Corta caras visibles tocadas por un trazo 2D (cuchillo libre) en espacio pantalla.
   * - Si la línea cruza una o varias caras, las divide limpiamente siguiendo la traza 3D exacta.
   * - Si la línea termina parcialmente dentro de una cara, crea el corte hasta el punto exacto donde terminó.
   * - Mantiene las caras vecinas sin grietas.
   */
  knifeCut({
    projVerts,
    faceFrontMask,
    planePointLocal,
    planeNormalLocal,
    ray0Local,
    ray1Local,
    x0,
    y0,
    x1,
    y1,
  }) {
    if (!this.faces.length || !projVerts || !planePointLocal || !planeNormalLocal) {
      return { changed: false, selectedFaces: new Set(), selectedEdges: new Set() };
    }
    if (Math.hypot(x1 - x0, y1 - y0) < 4) {
      return { changed: false, selectedFaces: new Set(), selectedEdges: new Set() };
    }

    const topo = this.getTopology();
    const { edges, edgeMap } = topo;

    // Distancias firmadas de vértices al plano de corte local
    const vertSide = new Float64Array(this.verts.length);
    for (let vi = 0; vi < this.verts.length; vi++) {
      const p = this.verts[vi];
      vertSide[vi] =
        (p.x - planePointLocal.x) * planeNormalLocal.x +
        (p.y - planePointLocal.y) * planeNormalLocal.y +
        (p.z - planePointLocal.z) * planeNormalLocal.z;
    }

    const edgeCutVert = new Map(); // edgeKey -> vi
    const edgeCutMap = new Map(); // edgeKey -> { vi, tLo }
    const faceOperations = new Map(); // fi -> { cutsOnEdges: Map<ei, vi>, interiorPoints: Array<{ vi, uv, t }> }
    const createdEdgePairs = [];

    const getOrCutEdge = (ei, fallbackU = 0.5, refA = null) => {
      const e = edges[ei];
      if (!e) return null;
      const existing = edgeCutVert.get(e.key);
      if (existing !== undefined) return existing;

      const da = vertSide[e.a];
      const db = vertSide[e.b];
      let t = fallbackU;
      if (Math.abs(da - db) > 1e-8) {
        t = da / (da - db);
      } else if (refA !== null && refA !== e.a) {
        t = 1 - fallbackU;
      }
      t = Math.max(0, Math.min(1, t));

      if (t <= 0.025) {
        edgeCutVert.set(e.key, e.a);
        return e.a;
      }
      if (t >= 0.975) {
        edgeCutVert.set(e.key, e.b);
        return e.b;
      }

      const va = this.verts[e.a];
      const vb = this.verts[e.b];
      const vi = this.verts.length;
      this.verts.push({
        x: va.x + (vb.x - va.x) * t,
        y: va.y + (vb.y - va.y) * t,
        z: va.z + (vb.z - va.z) * t,
      });
      edgeCutVert.set(e.key, vi);
      edgeCutMap.set(e.key, { vi, tLo: t });
      return vi;
    };

    const rayToFacePoint = (fi, rayLocal) => {
      const fn = this.computeFaceNormal(fi, _vA);
      const fc = this.computeFaceCenter(fi, _vD);
      const denom = fn.x * rayLocal.direction.x + fn.y * rayLocal.direction.y + fn.z * rayLocal.direction.z;
      if (Math.abs(denom) < 1e-7) return null;
      const num =
        (fc.x - rayLocal.origin.x) * fn.x +
        (fc.y - rayLocal.origin.y) * fn.y +
        (fc.z - rayLocal.origin.z) * fn.z;
      const tr = num / denom;
      if (!Number.isFinite(tr) || tr <= 0) return null;
      const px = rayLocal.origin.x + rayLocal.direction.x * tr;
      const py = rayLocal.origin.y + rayLocal.direction.y * tr;
      const pz = rayLocal.origin.z + rayLocal.direction.z * tr;
      return { x: px, y: py, z: pz, uv: this._interpolateFaceUv(fi, px, py, pz) };
    };

    for (let fi = 0; fi < this.faces.length; fi++) {
      if (faceFrontMask && !faceFrontMask[fi]) continue;
      const f = this.faces[fi];
      if (!f || f.length < 3) continue;

      const poly2D = [];
      let validPoly = true;
      for (let i = 0; i < f.length; i++) {
        const p = projVerts[f[i]];
        if (!p || p.w <= 0.01) { validPoly = false; break; }
        poly2D.push(p);
      }
      if (!validPoly) continue;

      const edgeCrossings = [];
      for (let i = 0; i < f.length; i++) {
        const a = f[i];
        const b = f[(i + 1) % f.length];
        const pa = poly2D[i];
        const pb = poly2D[(i + 1) % f.length];
        const hit = segIntersect2D(x0, y0, x1, y1, pa.x, pa.y, pb.x, pb.y);
        if (hit) {
          const ei = edgeMap.get(edgeKey(a, b));
          if (ei !== undefined) {
            edgeCrossings.push({ ei, a, b, tSeg: hit.t, uEdge: hit.u });
          }
        }
      }

      const startInside = pointInPoly2D(x0, y0, poly2D);
      const endInside = pointInPoly2D(x1, y1, poly2D);

      if (!edgeCrossings.length && !startInside && !endInside) continue;

      edgeCrossings.sort((a, b) => a.tSeg - b.tSeg);
      const cutVertsOrdered = [];
      const seenVerts = new Set();
      for (let i = 0; i < edgeCrossings.length; i++) {
        const c = edgeCrossings[i];
        const vi = getOrCutEdge(c.ei, c.uEdge, c.a);
        if (vi !== null && !seenVerts.has(vi)) {
          seenVerts.add(vi);
          cutVertsOrdered.push({ vi, isInterior: false, tSeg: c.tSeg });
        }
      }

      const interiorPoints = [];
      if (startInside && ray0Local) {
        const pt = rayToFacePoint(fi, ray0Local);
        if (pt) {
          // Evitar duplicar si está casi encima de un vértice de borde cortado
          let nearExisting = -1;
          let minD = 1e-3;
          for (const cv of cutVertsOrdered) {
            const v = this.verts[cv.vi];
            const d = Math.hypot(v.x - pt.x, v.y - pt.y, v.z - pt.z);
            if (d < minD) { minD = d; nearExisting = cv.vi; }
          }
          if (nearExisting < 0) {
            const vi = this.verts.length;
            this.verts.push({ x: pt.x, y: pt.y, z: pt.z });
            interiorPoints.push({ vi, uv: pt.uv, tSeg: 0 });
          }
        }
      }
      if (endInside && ray1Local) {
        const pt = rayToFacePoint(fi, ray1Local);
        if (pt) {
          let nearExisting = -1;
          let minD = 1e-3;
          for (const cv of cutVertsOrdered) {
            const v = this.verts[cv.vi];
            const d = Math.hypot(v.x - pt.x, v.y - pt.y, v.z - pt.z);
            if (d < minD) { minD = d; nearExisting = cv.vi; }
          }
          for (const ip of interiorPoints) {
            const v = this.verts[ip.vi];
            const d = Math.hypot(v.x - pt.x, v.y - pt.y, v.z - pt.z);
            if (d < minD) { minD = d; nearExisting = ip.vi; }
          }
          if (nearExisting < 0) {
            const vi = this.verts.length;
            this.verts.push({ x: pt.x, y: pt.y, z: pt.z });
            interiorPoints.push({ vi, uv: pt.uv, tSeg: 1 });
          }
        }
      }

      if (cutVertsOrdered.length >= 2 || (cutVertsOrdered.length >= 1 && interiorPoints.length >= 1) || interiorPoints.length >= 2) {
        faceOperations.set(fi, { cutVertsOrdered, interiorPoints });
      }
    }

    if (!faceOperations.size && !edgeCutMap.size) {
      return { changed: false, selectedFaces: new Set(), selectedEdges: new Set() };
    }

    const nextFaces = [];
    const nextFaceUvs = [];
    const selectedFaces = new Set();

    const getEdgeChainVert = (a, b) => {
      const info = edgeCutMap.get(edgeKey(a, b));
      if (!info) return null;
      return info.vi;
    };

    const buildRingWithEdgeCuts = (fi) => {
      const f = this.faces[fi];
      const fUv = this.faceUvs[fi] || f.map(() => [0, 0]);
      const ring = [];
      const ringUv = [];
      for (let i = 0; i < f.length; i++) {
        const a = f[i];
        const b = f[(i + 1) % f.length];
        const uvA = fUv[i] || [0, 0];
        const uvB = fUv[(i + 1) % f.length] || [0, 0];
        if (!ring.length || ring[ring.length - 1] !== a) {
          ring.push(a);
          ringUv.push(uvA.slice());
        }
        const midVi = getEdgeChainVert(a, b);
        if (midVi !== null && midVi !== a && midVi !== b) {
          const info = edgeCutMap.get(edgeKey(a, b));
          const frac = a < b ? info.tLo : 1 - info.tLo;
          ring.push(midVi);
          ringUv.push([uvA[0] + (uvB[0] - uvA[0]) * frac, uvA[1] + (uvB[1] - uvA[1]) * frac]);
        }
      }
      if (ring.length > 1 && ring[ring.length - 1] === ring[0]) {
        ring.pop();
        ringUv.pop();
      }
      return { ring, ringUv };
    };

    for (let fi = 0; fi < this.faces.length; fi++) {
      const { ring, ringUv } = buildRingWithEdgeCuts(fi);
      const op = faceOperations.get(fi);
      if (!op) {
        nextFaces.push(ring);
        nextFaceUvs.push(ringUv);
        continue;
      }

      const { cutVertsOrdered, interiorPoints } = op;

      // Caso A: al menos 2 puntos en el contorno de la cara -> dividir cara en 2 polígonos por cuerda
      if (cutVertsOrdered.length >= 2 && interiorPoints.length === 0) {
        const vA = cutVertsOrdered[0].vi;
        const vB = cutVertsOrdered[cutVertsOrdered.length - 1].vi;
        const idxA = ring.indexOf(vA);
        const idxB = ring.indexOf(vB);
        if (idxA >= 0 && idxB >= 0 && idxA !== idxB) {
          const n = ring.length;
          const poly1 = [], uv1 = [];
          for (let i = idxA; ; i = (i + 1) % n) {
            poly1.push(ring[i]);
            uv1.push(ringUv[i].slice());
            if (i === idxB) break;
          }
          const poly2 = [], uv2 = [];
          for (let i = idxB; ; i = (i + 1) % n) {
            poly2.push(ring[i]);
            uv2.push(ringUv[i].slice());
            if (i === idxA) break;
          }
          if (poly1.length >= 3 && poly2.length >= 3) {
            selectedFaces.add(nextFaces.length);
            nextFaces.push(poly1);
            nextFaceUvs.push(uv1);
            selectedFaces.add(nextFaces.length);
            nextFaces.push(poly2);
            nextFaceUvs.push(uv2);
            createdEdgePairs.push([vA, vB]);
            continue;
          }
        }
      }

      // Caso B: 1 punto en el contorno + 1 punto interior (tocó un poco esta cara y terminó dentro)
      if (cutVertsOrdered.length >= 1 && interiorPoints.length >= 1) {
        const vEdge = cutVertsOrdered[0].vi;
        const pInfo = interiorPoints[interiorPoints.length - 1];
        const vInt = pInfo.vi;
        const uvInt = pInfo.uv;
        const idxE = ring.indexOf(vEdge);
        if (idxE >= 0 && ring.length >= 3) {
          // Rotar anillo para empezar en vEdge y dividir en abanico alrededor de vInt conservando la arista (vEdge, vInt)
          const rotR = [];
          const rotUv = [];
          for (let i = 0; i < ring.length; i++) {
            const k = (idxE + i) % ring.length;
            rotR.push(ring[k]);
            rotUv.push(ringUv[k]);
          }
          const fn = this.computeFaceNormal(fi, _vA);
          let i = 0;
          while (i < rotR.length) {
            const a = rotR[i];
            const b = rotR[(i + 1) % rotR.length];
            const uvA = rotUv[i];
            const uvB = rotUv[(i + 1) % rotR.length];
            // Intentar agrupar en quad si NO cruza el origen y es convexo
            if (i + 2 < rotR.length) {
              const c = rotR[i + 2];
              const uvC = rotUv[i + 2];
              if (
                a !== b && b !== c && c !== vInt &&
                isConvexQuad(this.verts[a], this.verts[b], this.verts[c], this.verts[vInt], fn)
              ) {
                selectedFaces.add(nextFaces.length);
                nextFaces.push([a, b, c, vInt]);
                nextFaceUvs.push([uvA.slice(), uvB.slice(), uvC.slice(), uvInt.slice()]);
                i += 2;
                continue;
              }
            }
            if (a !== b && b !== vInt && a !== vInt) {
              selectedFaces.add(nextFaces.length);
              nextFaces.push([a, b, vInt]);
              nextFaceUvs.push([uvA.slice(), uvB.slice(), uvInt.slice()]);
            }
            i += 1;
          }
          createdEdgePairs.push([vEdge, vInt]);
          // Si además entró y salió o tuvo otro corte parcial, conectar si había segundo punto interior
          continue;
        }
      }

      // Caso C: ambos extremos dentro de la misma cara
      if (interiorPoints.length >= 2 && ring.length >= 3) {
        const pA = interiorPoints[0];
        const pB = interiorPoints[interiorPoints.length - 1];
        const vA = this.verts[pA.vi];
        const vB = this.verts[pB.vi];
        let ux = vB.x - vA.x, uy = vB.y - vA.y, uz = vB.z - vA.z;
        const uLen = Math.hypot(ux, uy, uz) || 1;
        ux /= uLen; uy /= uLen; uz /= uLen;

        let iMin = 0, iMax = 0, minProj = Infinity, maxProj = -Infinity;
        for (let i = 0; i < ring.length; i++) {
          const pv = this.verts[ring[i]];
          const pr = (pv.x - vA.x) * ux + (pv.y - vA.y) * uy + (pv.z - vA.z) * uz;
          if (pr < minProj) { minProj = pr; iMin = i; }
          if (pr > maxProj) { maxProj = pr; iMax = i; }
        }
        if (iMin === iMax) iMax = (iMin + 1) % ring.length;

        const n = ring.length;
        const poly1 = [], uv1 = [];
        for (let i = iMin; ; i = (i + 1) % n) {
          poly1.push(ring[i]);
          uv1.push(ringUv[i].slice());
          if (i === iMax) break;
        }
        poly1.push(pB.vi, pA.vi);
        uv1.push(pB.uv.slice(), pA.uv.slice());

        const poly2 = [], uv2 = [];
        for (let i = iMax; ; i = (i + 1) % n) {
          poly2.push(ring[i]);
          uv2.push(ringUv[i].slice());
          if (i === iMin) break;
        }
        poly2.push(pA.vi, pB.vi);
        uv2.push(pA.uv.slice(), pB.uv.slice());

        selectedFaces.add(nextFaces.length);
        nextFaces.push(poly1);
        nextFaceUvs.push(uv1);
        selectedFaces.add(nextFaces.length);
        nextFaces.push(poly2);
        nextFaceUvs.push(uv2);
        createdEdgePairs.push([pA.vi, pB.vi]);
        continue;
      }

      nextFaces.push(ring);
      nextFaceUvs.push(ringUv);
    }

    for (const [k, info] of edgeCutMap.entries()) {
      const w = this.creases.get(k);
      if (!w) continue;
      const sep = k.indexOf('_');
      const a = Number(k.slice(0, sep));
      const b = Number(k.slice(sep + 1));
      if (info.vi !== a && info.vi !== b) {
        this.creases.delete(k);
        this.creases.set(edgeKey(a, info.vi), w);
        this.creases.set(edgeKey(info.vi, b), w);
      }
    }

    this.faces = nextFaces;
    this.faceUvs = nextFaceUvs;
    this.invalidateTopology();

    const nextTopo = this.getTopology();
    const selectedEdges = new Set();
    for (let i = 0; i < createdEdgePairs.length; i++) {
      const [a, b] = createdEdgePairs[i];
      const ei = nextTopo.edgeMap.get(edgeKey(a, b));
      if (ei !== undefined) selectedEdges.add(ei);
    }

    return {
      changed: true,
      selectedFaces,
      selectedEdges,
    };
  }

  /**
   * Calcula un bucle completo (anillo de aristas en quads o plano 360°) para previsualización o ejecución.
   */
  computeLoopCutPlan({
    projVerts,
    faceFrontMask,
    anchorFace,
    anchorLocal,
    isVerticalCut,
    planeNormalLocal,
    planePointLocal,
  }) {
    const topo = this.getTopology();
    const { edges, faceEdges } = topo;

    // 1. Intentar anillo topológico de quads cuando la cara ancla es un cuadrilátero
    if (anchorFace >= 0 && anchorFace < this.faces.length && this.faces[anchorFace].length === 4) {
      const f = this.faces[anchorFace];
      const fe = faceEdges[anchorFace];

      const edgeScreenScore = (ei) => {
        const e = edges[ei];
        const pa = projVerts[e.a], pb = projVerts[e.b];
        if (!pa || !pb) return 0;
        const ex = pb.x - pa.x, ey = pb.y - pa.y;
        const len = Math.hypot(ex, ey) || 1;
        // Corte vertical (|): corta a través de las aristas más horizontales (|ex|/len alto)
        // Corte horizontal (—): corta a través de las aristas más verticales (|ey|/len alto)
        return isVerticalCut ? Math.abs(ex) / len : Math.abs(ey) / len;
      };

      const scorePair02 = (edgeScreenScore(fe[0]) + edgeScreenScore(fe[2])) * 0.5;
      const scorePair13 = (edgeScreenScore(fe[1]) + edgeScreenScore(fe[3])) * 0.5;
      const startEdge = scorePair02 >= scorePair13 ? fe[0] : fe[1];
      const oppEdge = scorePair02 >= scorePair13 ? fe[2] : fe[3];

      // Fracción t a lo largo de startEdge usando la posición del cursor sobre la cara ancla
      let startT = 0.5;
      if (anchorLocal) {
        const eS = edges[startEdge];
        const eO = edges[oppEdge];
        const va = this.verts[eS.a], vb = this.verts[eS.b];
        const vc = this.verts[eO.a], vd = this.verts[eO.b];
        // Alinear dirección promedio de aristas opuestas del quad
        const daX = vb.x - va.x, daY = vb.y - va.y, daZ = vb.z - va.z;
        let dbX = vd.x - vc.x, dbY = vd.y - vc.y, dbZ = vd.z - vc.z;
        if (daX * dbX + daY * dbY + daZ * dbZ < 0) {
          dbX = -dbX; dbY = -dbY; dbZ = -dbZ;
        }
        const dirX = (daX + dbX) * 0.5;
        const dirY = (daY + dbY) * 0.5;
        const dirZ = (daZ + dbZ) * 0.5;
        const dSq = dirX * dirX + dirY * dirY + dirZ * dirZ;
        if (dSq > 1e-8) {
          const fc = this.computeFaceCenter(anchorFace, _vD);
          const relX = anchorLocal.x - fc.x;
          const relY = anchorLocal.y - fc.y;
          const relZ = anchorLocal.z - fc.z;
          const u = 0.5 + (relX * dirX + relY * dirY + relZ * dirZ) / dSq;
          startT = Math.max(0.06, Math.min(0.94, u));
        }
      }

      // Recorrer el anillo de aristas opuestas en ambos sentidos desde startEdge
      const edgeFractions = new Map();
      edgeFractions.set(startEdge, startT);
      const queue = [{ ei: startEdge, t: startT, fromFace: -1 }];

      while (queue.length) {
        const cur = queue.shift();
        const incFaces = edges[cur.ei].faces;
        for (let fiIdx = 0; fiIdx < incFaces.length; fiIdx++) {
          const fi = incFaces[fiIdx];
          if (fi === cur.fromFace) continue;
          const qf = this.faces[fi];
          if (!qf || qf.length !== 4) continue;
          const qfe = faceEdges[fi];
          let k = -1;
          for (let s = 0; s < 4; s++) {
            if (qfe[s] === cur.ei) { k = s; break; }
          }
          if (k < 0) continue;

          const a = qf[k];
          const b = qf[(k + 1) % 4];
          const c = qf[(k + 2) % 4];
          const oppEi = qfe[(k + 2) % 4];

          const curE = edges[cur.ei];
          const tAB = a === curE.a ? cur.t : 1 - cur.t;
          const oppE = edges[oppEi];
          const tOpp = c === oppE.a ? 1 - tAB : tAB;

          if (!edgeFractions.has(oppEi)) {
            edgeFractions.set(oppEi, tOpp);
            queue.push({ ei: oppEi, t: tOpp, fromFace: fi });
          }
        }
      }

      if (edgeFractions.size >= 2) {
        const previewSegments = [];
        for (let fi = 0; fi < this.faces.length; fi++) {
          const qf = this.faces[fi];
          if (!qf || qf.length !== 4) continue;
          const qfe = faceEdges[fi];
          const pairA = edgeFractions.has(qfe[0]) && edgeFractions.has(qfe[2]);
          const pairB = edgeFractions.has(qfe[1]) && edgeFractions.has(qfe[3]);
          if (pairA) {
            const e0 = edges[qfe[0]], t0 = edgeFractions.get(qfe[0]);
            const e2 = edges[qfe[2]], t2 = edgeFractions.get(qfe[2]);
            previewSegments.push([
              {
                x: this.verts[e0.a].x + (this.verts[e0.b].x - this.verts[e0.a].x) * t0,
                y: this.verts[e0.a].y + (this.verts[e0.b].y - this.verts[e0.a].y) * t0,
                z: this.verts[e0.a].z + (this.verts[e0.b].z - this.verts[e0.a].z) * t0,
              },
              {
                x: this.verts[e2.a].x + (this.verts[e2.b].x - this.verts[e2.a].x) * t2,
                y: this.verts[e2.a].y + (this.verts[e2.b].y - this.verts[e2.a].y) * t2,
                z: this.verts[e2.a].z + (this.verts[e2.b].z - this.verts[e2.a].z) * t2,
              },
            ]);
          } else if (pairB) {
            const e1 = edges[qfe[1]], t1 = edgeFractions.get(qfe[1]);
            const e3 = edges[qfe[3]], t3 = edgeFractions.get(qfe[3]);
            previewSegments.push([
              {
                x: this.verts[e1.a].x + (this.verts[e1.b].x - this.verts[e1.a].x) * t1,
                y: this.verts[e1.a].y + (this.verts[e1.b].y - this.verts[e1.a].y) * t1,
                z: this.verts[e1.a].z + (this.verts[e1.b].z - this.verts[e1.a].z) * t1,
              },
              {
                x: this.verts[e3.a].x + (this.verts[e3.b].x - this.verts[e3.a].x) * t3,
                y: this.verts[e3.a].y + (this.verts[e3.b].y - this.verts[e3.a].y) * t3,
                z: this.verts[e3.a].z + (this.verts[e3.b].z - this.verts[e3.a].z) * t3,
              },
            ]);
          }
        }
        if (previewSegments.length >= 1) {
          return { kind: 'ring', edgeFractions, previewSegments };
        }
      }
    }

    // 2. Respaldo 360° por plano infinito (para triángulos / N-gonos / mallas irregulares)
    if (planePointLocal && planeNormalLocal) {
      const previewSegments = [];
      const vertSide = new Float64Array(this.verts.length);
      for (let vi = 0; vi < this.verts.length; vi++) {
        const p = this.verts[vi];
        vertSide[vi] =
          (p.x - planePointLocal.x) * planeNormalLocal.x +
          (p.y - planePointLocal.y) * planeNormalLocal.y +
          (p.z - planePointLocal.z) * planeNormalLocal.z;
      }
      for (let fi = 0; fi < this.faces.length; fi++) {
        const f = this.faces[fi];
        const hits = [];
        for (let i = 0; i < f.length; i++) {
          const a = f[i], b = f[(i + 1) % f.length];
          const da = vertSide[a], db = vertSide[b];
          if ((da >= 0 && db < 0) || (da < 0 && db >= 0)) {
            const t = da / (da - db);
            const va = this.verts[a], vb = this.verts[b];
            hits.push({
              x: va.x + (vb.x - va.x) * t,
              y: va.y + (vb.y - va.y) * t,
              z: va.z + (vb.z - va.z) * t,
            });
          }
        }
        if (hits.length >= 2) {
          previewSegments.push([hits[0], hits[hits.length - 1]]);
        }
      }
      if (previewSegments.length >= 1) {
        return { kind: 'plane', planePointLocal, planeNormalLocal, previewSegments };
      }
    }

    return null;
  }

  /**
   * Ejecuta un corte en bucle completo (360° horizontal o vertical) sobre todo el modelo.
   */
  loopCut(plan) {
    if (!plan) return { changed: false, selectedFaces: new Set(), selectedEdges: new Set() };

    if (plan.kind === 'ring' && plan.edgeFractions?.size) {
      const topo = this.getTopology();
      const { edges, faceEdges } = topo;
      const cutVertOfEdge = new Map(); // ei -> vi

      for (const [ei, t] of plan.edgeFractions.entries()) {
        const e = edges[ei];
        if (!e) continue;
        const va = this.verts[e.a];
        const vb = this.verts[e.b];
        const vi = this.verts.length;
        this.verts.push({
          x: va.x + (vb.x - va.x) * t,
          y: va.y + (vb.y - va.y) * t,
          z: va.z + (vb.z - va.z) * t,
        });
        cutVertOfEdge.set(ei, vi);
      }

      const nextFaces = [];
      const nextFaceUvs = [];
      const selectedFaces = new Set();
      const createdEdgePairs = [];

      const edgeCutInfo = new Map(); // edgeKey -> { vi, tLo }
      for (const [ei, vi] of cutVertOfEdge.entries()) {
        const e = edges[ei];
        edgeCutInfo.set(e.key, { vi, tLo: plan.edgeFractions.get(ei) });
      }

      const interpEdgeUv = (a, b, uvA, uvB, tLo) => {
        const frac = a < b ? tLo : 1 - tLo;
        return [uvA[0] + (uvB[0] - uvA[0]) * frac, uvA[1] + (uvB[1] - uvA[1]) * frac];
      };

      for (let fi = 0; fi < this.faces.length; fi++) {
        const f = this.faces[fi];
        const fUv = this.faceUvs[fi] || f.map(() => [0, 0]);
        const fe = faceEdges[fi] || [];

        if (f.length === 4) {
          const has02 = cutVertOfEdge.has(fe[0]) && cutVertOfEdge.has(fe[2]);
          const has13 = cutVertOfEdge.has(fe[1]) && cutVertOfEdge.has(fe[3]);

          if (has02) {
            const [v0, v1, v2, v3] = f;
            const [uv0, uv1, uv2, uv3] = fUv;
            const m02 = cutVertOfEdge.get(fe[0]);
            const m23 = cutVertOfEdge.get(fe[2]);
            const uvM02 = interpEdgeUv(v0, v1, uv0, uv1, edgeCutInfo.get(edgeKey(v0, v1)).tLo);
            const uvM23 = interpEdgeUv(v2, v3, uv2, uv3, edgeCutInfo.get(edgeKey(v2, v3)).tLo);

            selectedFaces.add(nextFaces.length);
            nextFaces.push([v0, m02, m23, v3]);
            nextFaceUvs.push([uv0.slice(), uvM02, uvM23, uv3.slice()]);

            selectedFaces.add(nextFaces.length);
            nextFaces.push([m02, v1, v2, m23]);
            nextFaceUvs.push([uvM02.slice(), uv1.slice(), uv2.slice(), uvM23.slice()]);

            createdEdgePairs.push([m02, m23]);
            continue;
          }
          if (has13) {
            const [v0, v1, v2, v3] = f;
            const [uv0, uv1, uv2, uv3] = fUv;
            const m12 = cutVertOfEdge.get(fe[1]);
            const m30 = cutVertOfEdge.get(fe[3]);
            const uvM12 = interpEdgeUv(v1, v2, uv1, uv2, edgeCutInfo.get(edgeKey(v1, v2)).tLo);
            const uvM30 = interpEdgeUv(v3, v0, uv3, uv0, edgeCutInfo.get(edgeKey(v3, v0)).tLo);

            selectedFaces.add(nextFaces.length);
            nextFaces.push([v0, v1, m12, m30]);
            nextFaceUvs.push([uv0.slice(), uv1.slice(), uvM12, uvM30]);

            selectedFaces.add(nextFaces.length);
            nextFaces.push([m30, m12, v2, v3]);
            nextFaceUvs.push([uvM30.slice(), uvM12.slice(), uv2.slice(), uv3.slice()]);

            createdEdgePairs.push([m12, m30]);
            continue;
          }
        }

        // Si es vecina no-quad de una arista cortada, insertar el vértice de corte para no abrir grietas
        const ring = [];
        const ringUv = [];
        for (let i = 0; i < f.length; i++) {
          const a = f[i], b = f[(i + 1) % f.length];
          const uvA = fUv[i] || [0, 0], uvB = fUv[(i + 1) % f.length] || [0, 0];
          ring.push(a);
          ringUv.push(uvA.slice());
          const info = edgeCutInfo.get(edgeKey(a, b));
          if (info) {
            ring.push(info.vi);
            ringUv.push(interpEdgeUv(a, b, uvA, uvB, info.tLo));
          }
        }
        nextFaces.push(ring);
        nextFaceUvs.push(ringUv);
      }

      for (const [k, info] of edgeCutInfo.entries()) {
        const w = this.creases.get(k);
        if (!w) continue;
        const sep = k.indexOf('_');
        const a = Number(k.slice(0, sep));
        const b = Number(k.slice(sep + 1));
        if (info.vi !== a && info.vi !== b) {
          this.creases.delete(k);
          this.creases.set(edgeKey(a, info.vi), w);
          this.creases.set(edgeKey(info.vi, b), w);
        }
      }

      this.faces = nextFaces;
      this.faceUvs = nextFaceUvs;
      this.invalidateTopology();

      const nextTopo = this.getTopology();
      const selectedEdges = new Set();
      for (let i = 0; i < createdEdgePairs.length; i++) {
        const ei = nextTopo.edgeMap.get(edgeKey(createdEdgePairs[i][0], createdEdgePairs[i][1]));
        if (ei !== undefined) selectedEdges.add(ei);
      }
      return { changed: true, selectedFaces, selectedEdges };
    }

    if (plan.kind === 'plane' && plan.planePointLocal && plan.planeNormalLocal) {
      return this.sliceByPlaneLocal(plan.planePointLocal, plan.planeNormalLocal);
    }

    return { changed: false, selectedFaces: new Set(), selectedEdges: new Set() };
  }

  /**
   * Corta todo el modelo alrededor con un plano 3D local (respaldo 360° para mallas no-quad).
   */
  sliceByPlaneLocal(planePointLocal, planeNormalLocal) {
    if (!this.faces.length || !planePointLocal || !planeNormalLocal) {
      return { changed: false, selectedFaces: new Set(), selectedEdges: new Set() };
    }
    const topo = this.getTopology();
    const { edges } = topo;

    const vertSide = new Float64Array(this.verts.length);
    for (let vi = 0; vi < this.verts.length; vi++) {
      const p = this.verts[vi];
      vertSide[vi] =
        (p.x - planePointLocal.x) * planeNormalLocal.x +
        (p.y - planePointLocal.y) * planeNormalLocal.y +
        (p.z - planePointLocal.z) * planeNormalLocal.z;
    }

    const edgeCutMap = new Map();
    for (let ei = 0; ei < edges.length; ei++) {
      const e = edges[ei];
      const da = vertSide[e.a];
      const db = vertSide[e.b];
      if ((da >= 0 && db < 0) || (da < 0 && db >= 0)) {
        const t = Math.max(0, Math.min(1, da / (da - db)));
        if (t <= 0.02) {
          edgeCutMap.set(e.key, { vi: e.a, tLo: 0 });
        } else if (t >= 0.98) {
          edgeCutMap.set(e.key, { vi: e.b, tLo: 1 });
        } else {
          const va = this.verts[e.a], vb = this.verts[e.b];
          const vi = this.verts.length;
          this.verts.push({
            x: va.x + (vb.x - va.x) * t,
            y: va.y + (vb.y - va.y) * t,
            z: va.z + (vb.z - va.z) * t,
          });
          edgeCutMap.set(e.key, { vi, tLo: t });
        }
      }
    }

    if (!edgeCutMap.size) {
      return { changed: false, selectedFaces: new Set(), selectedEdges: new Set() };
    }

    const nextFaces = [];
    const nextFaceUvs = [];
    const selectedFaces = new Set();
    const createdEdgePairs = [];

    for (let fi = 0; fi < this.faces.length; fi++) {
      const f = this.faces[fi];
      const fUv = this.faceUvs[fi] || f.map(() => [0, 0]);
      const ring = [];
      const ringUv = [];
      const cutsInFace = [];

      for (let i = 0; i < f.length; i++) {
        const a = f[i], b = f[(i + 1) % f.length];
        const uvA = fUv[i] || [0, 0], uvB = fUv[(i + 1) % f.length] || [0, 0];
        if (!ring.length || ring[ring.length - 1] !== a) {
          ring.push(a);
          ringUv.push(uvA.slice());
        }
        const info = edgeCutMap.get(edgeKey(a, b));
        if (info && info.vi !== a && info.vi !== b) {
          const frac = a < b ? info.tLo : 1 - info.tLo;
          cutsInFace.push(info.vi);
          ring.push(info.vi);
          ringUv.push([uvA[0] + (uvB[0] - uvA[0]) * frac, uvA[1] + (uvB[1] - uvA[1]) * frac]);
        } else if (info && (info.vi === a || info.vi === b)) {
          if (!cutsInFace.includes(info.vi)) cutsInFace.push(info.vi);
        }
      }
      if (ring.length > 1 && ring[ring.length - 1] === ring[0]) {
        ring.pop();
        ringUv.pop();
      }

      if (cutsInFace.length >= 2) {
        const idxA = ring.indexOf(cutsInFace[0]);
        const idxB = ring.indexOf(cutsInFace[cutsInFace.length - 1]);
        if (idxA >= 0 && idxB >= 0 && idxA !== idxB) {
          const n = ring.length;
          const poly1 = [], uv1 = [];
          for (let i = idxA; ; i = (i + 1) % n) {
            poly1.push(ring[i]);
            uv1.push(ringUv[i].slice());
            if (i === idxB) break;
          }
          const poly2 = [], uv2 = [];
          for (let i = idxB; ; i = (i + 1) % n) {
            poly2.push(ring[i]);
            uv2.push(ringUv[i].slice());
            if (i === idxA) break;
          }
          if (poly1.length >= 3 && poly2.length >= 3) {
            selectedFaces.add(nextFaces.length);
            nextFaces.push(poly1);
            nextFaceUvs.push(uv1);
            selectedFaces.add(nextFaces.length);
            nextFaces.push(poly2);
            nextFaceUvs.push(uv2);
            createdEdgePairs.push([cutsInFace[0], cutsInFace[cutsInFace.length - 1]]);
            continue;
          }
        }
      }

      nextFaces.push(ring);
      nextFaceUvs.push(ringUv);
    }

    for (const [k, info] of edgeCutMap.entries()) {
      const w = this.creases.get(k);
      if (!w) continue;
      const sep = k.indexOf('_');
      const a = Number(k.slice(0, sep));
      const b = Number(k.slice(sep + 1));
      if (info.vi !== a && info.vi !== b) {
        this.creases.delete(k);
        this.creases.set(edgeKey(a, info.vi), w);
        this.creases.set(edgeKey(info.vi, b), w);
      }
    }

    this.faces = nextFaces;
    this.faceUvs = nextFaceUvs;
    this.invalidateTopology();

    const nextTopo = this.getTopology();
    const selectedEdges = new Set();
    for (let i = 0; i < createdEdgePairs.length; i++) {
      const ei = nextTopo.edgeMap.get(edgeKey(createdEdgePairs[i][0], createdEdgePairs[i][1]));
      if (ei !== undefined) selectedEdges.add(ei);
    }
    return { changed: true, selectedFaces, selectedEdges };
  }

  /**
   * Fusiona vértices cercanos o apilados repetidamente dentro de `threshold` (iterando hasta converger).
   * Elimina aristas y caras colapsadas y remapea UVs/durezas manteniendo topología válida.
   */
  mergeByDistance(threshold = 0.005, onlyVertices = null, { dedupeFaces = true, iterative = true, faceTags = null } = {}) {
    const distTol = Math.max(1e-7, Number(threshold) || 0.005);
    const tolSq = distTol * distTol;
    const cell = distTol;
    const invCell = 1 / cell;

    let activeFilter = null;
    if (onlyVertices && onlyVertices.size >= 2) {
      activeFilter = new Set();
      for (const vi of onlyVertices) {
        if (vi >= 0 && vi < this.verts.length) activeFilter.add(vi);
      }
      if (activeFilter.size < 2) return { changed: false, mergedCount: 0, selected: new Set() };
    }

    let totalMerged = 0;
    const mergedRepRefs = new Set();
    const maxIters = iterative ? 8 : 1;

    for (let iter = 0; iter < maxIters; iter++) {
      const V = this.verts.length;
      if (V < 2) break;

      const candidates = [];
      if (activeFilter) {
        for (const vi of activeFilter) {
          if (vi >= 0 && vi < V) candidates.push(vi);
        }
        candidates.sort((a, b) => a - b);
      } else {
        for (let vi = 0; vi < V; vi++) candidates.push(vi);
      }
      if (candidates.length < 2) break;

      const buckets = new Map();
      const parent = new Int32Array(V);
      for (let i = 0; i < V; i++) parent[i] = i;

      const find = (x) => {
        while (parent[x] !== x) {
          parent[x] = parent[parent[x]];
          x = parent[x];
        }
        return x;
      };
      const unite = (a, b) => {
        const ra = find(a);
        const rb = find(b);
        if (ra === rb) return;
        if (ra < rb) parent[rb] = ra;
        else parent[ra] = rb;
      };

      for (let ci = 0; ci < candidates.length; ci++) {
        const vi = candidates[ci];
        const p = this.verts[vi];
        const gx = Math.floor(p.x * invCell);
        const gy = Math.floor(p.y * invCell);
        const gz = Math.floor(p.z * invCell);
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            for (let dz = -1; dz <= 1; dz++) {
              const key = `${gx + dx},${gy + dy},${gz + dz}`;
              const list = buckets.get(key);
              if (!list) continue;
              for (let j = 0; j < list.length; j++) {
                const uj = list[j];
                const q = this.verts[uj];
                const ddx = p.x - q.x, ddy = p.y - q.y, ddz = p.z - q.z;
                if (ddx * ddx + ddy * ddy + ddz * ddz <= tolSq) {
                  unite(vi, uj);
                }
              }
            }
          }
        }
        const ownKey = `${gx},${gy},${gz}`;
        let arr = buckets.get(ownKey);
        if (!arr) { arr = []; buckets.set(ownKey, arr); }
        arr.push(vi);
      }

      const clusters = new Map();
      for (let ci = 0; ci < candidates.length; ci++) {
        const vi = candidates[ci];
        const r = find(vi);
        let grp = clusters.get(r);
        if (!grp) { grp = []; clusters.set(r, grp); }
        grp.push(vi);
      }

      let mergedCount = 0;
      const rawRemap = new Int32Array(V);
      for (let i = 0; i < V; i++) rawRemap[i] = i;

      for (const [rep, grp] of clusters.entries()) {
        if (grp.length <= 1) continue;
        mergedCount += grp.length - 1;
        let sx = 0, sy = 0, sz = 0;
        for (let i = 0; i < grp.length; i++) {
          const p = this.verts[grp[i]];
          sx += p.x; sy += p.y; sz += p.z;
          rawRemap[grp[i]] = rep;
        }
        const inv = 1 / grp.length;
        const repObj = { x: sx * inv, y: sy * inv, z: sz * inv };
        this.verts[rep] = repObj;
        mergedRepRefs.add(repObj);
      }

      if (mergedCount === 0) break;
      totalMerged += mergedCount;

      const nextFaces = [];
      const nextFaceUvs = [];
      const nextFaceTags = Array.isArray(faceTags) ? [] : null;
      const seenFaces = new Set();

      for (let fi = 0; fi < this.faces.length; fi++) {
        const f = this.faces[fi];
        const fUv = this.faceUvs[fi] || [];
        const ring = [];
        const ringUv = [];
        for (let i = 0; i < f.length; i++) {
          const nv = rawRemap[f[i]];
          if (!ring.length || ring[ring.length - 1] !== nv) {
            ring.push(nv);
            ringUv.push((fUv[i] || [0, 0]).slice());
          }
        }
        if (ring.length > 1 && ring[ring.length - 1] === ring[0]) {
          ring.pop();
          ringUv.pop();
        }
        const uniq = new Set(ring);
        if (ring.length < 3 || uniq.size < 3) continue;
        if (dedupeFaces) {
          const canon = ring.slice().sort((a, b) => a - b).join(',');
          if (seenFaces.has(canon)) continue;
          seenFaces.add(canon);
        }
        nextFaces.push(ring);
        nextFaceUvs.push(ringUv);
        if (nextFaceTags) nextFaceTags.push(faceTags[fi]);
      }

      const looseSet = new Set();
      const nextLoose = [];
      for (let li = 0; li < this.looseEdges.length; li++) {
        const a = rawRemap[this.looseEdges[li][0]];
        const b = rawRemap[this.looseEdges[li][1]];
        if (a === b) continue;
        const k = edgeKey(a, b);
        if (!looseSet.has(k)) {
          looseSet.add(k);
          nextLoose.push([a, b]);
        }
      }

      const filterRefs = activeFilter ? [...activeFilter].map((vi) => this.verts[rawRemap[vi]]) : null;

      this.faces = nextFaces;
      this.faceUvs = nextFaceUvs;
      if (nextFaceTags) {
        faceTags.splice(0, faceTags.length, ...nextFaceTags);
      }
      this.looseEdges = nextLoose;
      this._remapCreases(rawRemap);
      this.pruneUnusedVertices();

      if (filterRefs) {
        activeFilter = new Set();
        for (let i = 0; i < filterRefs.length; i++) {
          const idx = this.verts.indexOf(filterRefs[i]);
          if (idx >= 0) activeFilter.add(idx);
        }
      }
    }

    if (totalMerged === 0) {
      return { changed: false, mergedCount: 0, selected: new Set() };
    }

    const selectedVerts = new Set();
    for (const ref of mergedRepRefs) {
      const idx = this.verts.indexOf(ref);
      if (idx >= 0) selectedVerts.add(idx);
    }

    return { changed: true, mergedCount: totalMerged, selected: selectedVerts };
  }

  /**
   * Construye un puente entre 2 bucles/cadenas de aristas (o 2 caras separadas)
   * o rellena un hueco cerrado (Fill) a partir de aristas/vértices seleccionados.
   */
  fillOrBridge(mode, selection) {
    if (!selection || !selection.size) {
      return { changed: false, error: 'Selecciona un borde abierto (para rellenar) o 2 bucles/caras (para puente).' };
    }

    const topo = this.getTopology();
    const existingEdgeDirs = new Set();
    const existingFaceSigs = new Set();
    for (let fi = 0; fi < this.faces.length; fi++) {
      const f = this.faces[fi];
      for (let i = 0; i < f.length; i++) {
        existingEdgeDirs.add(directedKey(f[i], f[(i + 1) % f.length]));
      }
      existingFaceSigs.add(f.slice().sort((a, b) => a - b).join(','));
    }

    const alignLoopWinding = (vertsLoop) => {
      let agree = 0;
      let oppose = 0;
      for (let i = 0; i < vertsLoop.length; i++) {
        const u = vertsLoop[i];
        const v = vertsLoop[(i + 1) % vertsLoop.length];
        if (existingEdgeDirs.has(directedKey(v, u))) agree++;
        if (existingEdgeDirs.has(directedKey(u, v))) oppose++;
      }
      if (oppose > agree) return vertsLoop.slice().reverse();
      return vertsLoop;
    };

    const distSq = (ia, ib) => {
      const a = this.verts[ia], b = this.verts[ib];
      const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
      return dx * dx + dy * dy + dz * dz;
    };

    // Extraer componentes de aristas según modo de selección
    let selectedEdgePairs = [];
    let removedFacesForBridge = null;

    if (mode === 'face') {
      const selFaces = [];
      for (const fi of selection) {
        if (fi >= 0 && fi < this.faces.length) selFaces.push(fi);
      }
      if (selFaces.length < 2) {
        return { changed: false, error: 'En modo Cara selecciona al menos 2 caras enfrentadas/separadas para crear un puente.' };
      }
      // Agrupar caras seleccionadas en regiones conectadas por arista
      const selSet = new Set(selFaces);
      const visitedF = new Set();
      const regions = [];
      for (const seed of selFaces) {
        if (visitedF.has(seed)) continue;
        const reg = [];
        const q = [seed];
        visitedF.add(seed);
        while (q.length) {
          const fi = q.pop();
          reg.push(fi);
          const fe = topo.faceEdges[fi] || [];
          for (let i = 0; i < fe.length; i++) {
            const e = topo.edges[fe[i]];
            for (let j = 0; j < e.faces.length; j++) {
              const nfi = e.faces[j];
              if (selSet.has(nfi) && !visitedF.has(nfi)) {
                visitedF.add(nfi);
                q.push(nfi);
              }
            }
          }
        }
        regions.push(reg);
      }
      if (regions.length < 2) {
        return { changed: false, error: 'Selecciona 2 caras separadas (no adyacentes) para unirlas con un puente.' };
      }
      // Tomar las fronteras de las 2 primeras regiones y eliminar esas caras tapa
      const targetRegs = [regions[0], regions[1]];
      removedFacesForBridge = new Set([...targetRegs[0], ...targetRegs[1]]);
      for (const reg of targetRegs) {
        const regSet = new Set(reg);
        const dirEdges = new Set();
        for (const fi of reg) {
          const f = this.faces[fi];
          for (let i = 0; i < f.length; i++) {
            const u = f[i], v = f[(i + 1) % f.length];
            const ei = topo.edgeMap.get(edgeKey(u, v));
            const e = topo.edges[ei];
            const internalCount = e ? e.faces.filter((x) => regSet.has(x)).length : 1;
            if (internalCount <= 1) {
              const pair = [u, v];
              selectedEdgePairs.push(pair);
              dirEdges.add(directedKey(u, v));
            }
          }
        }
      }
    } else if (mode === 'edge') {
      for (const ei of selection) {
        const e = topo.edges[ei];
        if (e) selectedEdgePairs.push([e.a, e.b]);
      }
    } else {
      // mode === 'vertex'
      const vSel = new Set(selection);
      for (let ei = 0; ei < topo.edges.length; ei++) {
        const e = topo.edges[ei];
        if (vSel.has(e.a) && vSel.has(e.b)) selectedEdgePairs.push([e.a, e.b]);
      }
      // Si seleccionaron >= 3 vértices sin aristas entre sí (por ej. esquina o anillo suelto), rellenar ordenando por ángulo
      if (!selectedEdgePairs.length && vSel.size >= 3) {
        const list = [...vSel].filter((vi) => vi >= 0 && vi < this.verts.length);
        let cx = 0, cy = 0, cz = 0;
        for (const vi of list) { cx += this.verts[vi].x; cy += this.verts[vi].y; cz += this.verts[vi].z; }
        cx /= list.length; cy /= list.length; cz /= list.length;
        // Normal promedio de vértices
        let nx = 0, ny = 0, nz = 0;
        for (const vi of list) {
          const vn = this.computeVertexNormal(vi, _vA);
          nx += vn.x; ny += vn.y; nz += vn.z;
        }
        const nLen = Math.hypot(nx, ny, nz);
        if (nLen > 1e-6) { nx /= nLen; ny /= nLen; nz /= nLen; }
        else { nx = 0; ny = 1; nz = 0; }
        const ref = Math.abs(nx) < 0.9 ? new Vec3(1, 0, 0) : new Vec3(0, 1, 0);
        const nVec = new Vec3(nx, ny, nz);
        const tU = new Vec3().crossVectors(ref, nVec).normalize();
        const tV = new Vec3().crossVectors(nVec, tU).normalize();
        list.sort((ia, ib) => {
          const pa = this.verts[ia], pb = this.verts[ib];
          const aa = Math.atan2((pa.x - cx) * tV.x + (pa.y - cy) * tV.y + (pa.z - cz) * tV.z, (pa.x - cx) * tU.x + (pa.y - cy) * tU.y + (pa.z - cz) * tU.z);
          const ab = Math.atan2((pb.x - cx) * tV.x + (pb.y - cy) * tV.y + (pb.z - cz) * tV.z, (pb.x - cx) * tU.x + (pb.y - cy) * tU.y + (pb.z - cz) * tU.z);
          return aa - ab;
        });
        const sig = list.slice().sort((a, b) => a - b).join(',');
        if (existingFaceSigs.has(sig)) return { changed: false, error: 'Esa cara ya existe en la malla.' };
        const fi = this.faces.length;
        this.faces.push(alignLoopWinding(list));
        this.faceUvs.push(list.map((_, i) => [Math.cos((i / list.length) * Math.PI * 2) * 0.5 + 0.5, Math.sin((i / list.length) * Math.PI * 2) * 0.5 + 0.5]));
        this.invalidateTopology();
        return { changed: true, op: 'fill', createdFaces: 1, selected: new Set([fi]) };
      }
    }

    if (!selectedEdgePairs.length) {
      return { changed: false, error: 'Selecciona aristas conectadas (relleno) o 2 bucles separados (puente).' };
    }

    // Construir grafo no dirigido con `selectedEdgePairs` y separar componentes conexas
    const adj = new Map();
    const addAdj = (u, v) => {
      let s = adj.get(u);
      if (!s) { s = new Set(); adj.set(u, s); }
      s.add(v);
    };
    for (let i = 0; i < selectedEdgePairs.length; i++) {
      const [u, v] = selectedEdgePairs[i];
      if (u === v) continue;
      addAdj(u, v);
      addAdj(v, u);
    }

    const visitedV = new Set();
    const chains = [];
    for (const startV of adj.keys()) {
      if (visitedV.has(startV)) continue;
      const compVerts = [];
      const stack = [startV];
      visitedV.add(startV);
      while (stack.length) {
        const u = stack.pop();
        compVerts.push(u);
        for (const w of adj.get(u)) {
          if (!visitedV.has(w)) {
            visitedV.add(w);
            stack.push(w);
          }
        }
      }
      // Ordenar componente como camino o ciclo
      let ends = compVerts.filter((v) => adj.get(v).size === 1);
      const closed = ends.length === 0;
      const cur0 = ends.length ? ends[0] : compVerts[0];
      const ordered = [cur0];
      const walked = new Set([cur0]);
      let curr = cur0;
      while (true) {
        let next = null;
        for (const nb of adj.get(curr)) {
          if (!walked.has(nb)) { next = nb; break; }
        }
        if (next === null) break;
        ordered.push(next);
        walked.add(next);
        curr = next;
      }
      chains.push({ verts: ordered, closed });
    }

    // CASO A: PUENTE (2 cadenas/bucles)
    if (chains.length === 2) {
      const A = chains[0];
      const B = chains[1];
      if (A.verts.length < 2 || B.verts.length < 2) {
        return { changed: false, error: 'Cada bucle o cadena para el puente necesita al menos 2 vértices.' };
      }

      if (removedFacesForBridge && removedFacesForBridge.size) {
        const nextFaces = [];
        const nextUvs = [];
        for (let fi = 0; fi < this.faces.length; fi++) {
          if (!removedFacesForBridge.has(fi)) {
            nextFaces.push(this.faces[fi]);
            nextUvs.push(this.faceUvs[fi]);
          }
        }
        this.faces = nextFaces;
        this.faceUvs = nextUvs;
        existingEdgeDirs.clear();
        for (let fi = 0; fi < this.faces.length; fi++) {
          const f = this.faces[fi];
          for (let i = 0; i < f.length; i++) {
            existingEdgeDirs.add(directedKey(f[i], f[(i + 1) % f.length]));
          }
        }
      }

      const listA = A.verts.slice();
      let listB = B.verts.slice();

      if (A.closed && B.closed) {
        // Encontrar rotación + dirección en B que minimice distancia total entre parejas
        let bestListB = listB;
        let bestCost = Infinity;
        for (let rev = 0; rev < 2; rev++) {
          const cand = rev === 0 ? listB : listB.slice().reverse();
          for (let shift = 0; shift < cand.length; shift++) {
            let cost = 0;
            const n = Math.max(listA.length, cand.length);
            for (let k = 0; k < n; k++) {
              const ia = listA[Math.floor((k * listA.length) / n)];
              const ib = cand[(Math.floor((k * cand.length) / n) + shift) % cand.length];
              cost += distSq(ia, ib);
            }
            if (cost < bestCost) {
              bestCost = cost;
              bestListB = cand.map((_, idx) => cand[(idx + shift) % cand.length]);
            }
          }
        }
        listB = bestListB;
      } else {
        // Cadenas abiertas: elegir orientación directa o invertida
        const costFwd = distSq(listA[0], listB[0]) + distSq(listA[listA.length - 1], listB[listB.length - 1]);
        const costRev = distSq(listA[0], listB[listB.length - 1]) + distSq(listA[listA.length - 1], listB[0]);
        if (costRev < costFwd) listB.reverse();
      }

      const segA = A.closed ? listA.length : listA.length - 1;
      const segB = B.closed ? listB.length : listB.length - 1;
      const steps = Math.max(segA, segB);

      const bridgeFaces = [];
      const bridgeUvs = [];
      let revAgree = 0;
      let fwdAgree = 0;

      for (let s = 0; s < steps; s++) {
        const iA0 = Math.floor((s * segA) / steps);
        const iA1 = Math.floor(((s + 1) * segA) / steps);
        const iB0 = Math.floor((s * segB) / steps);
        const iB1 = Math.floor(((s + 1) * segB) / steps);

        const a0 = listA[iA0 % listA.length];
        const a1 = listA[iA1 % listA.length];
        const b0 = listB[iB0 % listB.length];
        const b1 = listB[iB1 % listB.length];

        const poly = [];
        if (a0 !== a1) poly.push(a0, a1);
        else poly.push(a0);
        if (b1 !== b0) poly.push(b1, b0);
        else if (b0 !== poly[poly.length - 1]) poly.push(b0);

        if (poly.length < 3) continue;
        // Verificar orientación contra las caras vecinas existentes en borde A
        if (a0 !== a1) {
          if (existingEdgeDirs.has(directedKey(a0, a1))) fwdAgree++;
          if (existingEdgeDirs.has(directedKey(a1, a0))) revAgree++;
        }
        if (b0 !== b1) {
          if (existingEdgeDirs.has(directedKey(b1, b0))) fwdAgree++;
          if (existingEdgeDirs.has(directedKey(b0, b1))) revAgree++;
        }
        bridgeFaces.push(poly);
        bridgeUvs.push(
          poly.length === 4
            ? [[s / steps, 0], [(s + 1) / steps, 0], [(s + 1) / steps, 1], [s / steps, 1]]
            : [[s / steps, 0], [(s + 1) / steps, 0], [0.5, 1]]
        );
      }

      if (!bridgeFaces.length) {
        return { changed: false, error: 'No se pudieron construir caras válidas para el puente.' };
      }

      // Si las aristas existentes siguen la dirección `a0 -> a1`, la cara nueva debe ir `a1 -> a0` (invertir)
      const shouldFlip = fwdAgree > revAgree;
      const createdFaceIndices = new Set();
      for (let i = 0; i < bridgeFaces.length; i++) {
        const f = shouldFlip ? bridgeFaces[i].slice().reverse() : bridgeFaces[i];
        const uvs = shouldFlip ? bridgeUvs[i].slice().reverse() : bridgeUvs[i];
        createdFaceIndices.add(this.faces.length);
        this.faces.push(f);
        this.faceUvs.push(uvs);
      }

      this.pruneUnusedVertices();
      return {
        changed: true,
        op: 'bridge',
        createdFaces: bridgeFaces.length,
        selected: mode === 'face' ? createdFaceIndices : new Set(),
      };
    }

    // CASO B: RELLENO (Fill) de 1 bucle o cadena de >= 3 vértices
    if (chains.length === 1 && chains[0].verts.length >= 3) {
      const cycle = alignLoopWinding(chains[0].verts);
      const sig = cycle.slice().sort((a, b) => a - b).join(',');
      if (existingFaceSigs.has(sig)) {
        return { changed: false, error: 'Ese contorno ya está cubierto por una cara.' };
      }
      const n = cycle.length;
      const fi = this.faces.length;
      this.faces.push(cycle);
      this.faceUvs.push(
        cycle.map((_, i) => [
          0.5 + 0.5 * Math.cos((i / n) * Math.PI * 2),
          0.5 + 0.5 * Math.sin((i / n) * Math.PI * 2),
        ])
      );
      this.invalidateTopology();
      return {
        changed: true,
        op: 'fill',
        createdFaces: 1,
        selected: mode === 'face' ? new Set([fi]) : new Set(),
      };
    }

    return {
      changed: false,
      error: chains.length > 2
        ? 'Selecciona exactamente 2 bucles separados para Puente o 1 contorno cerrado para Rellenar.'
        : 'El contorno seleccionado necesita al menos 3 vértices para rellenar.',
    };
  }

  /**
   * Bisela las aristas, bordes de caras o vértices seleccionados con ancho y segmentos configurables.
   */
  bevelSelection(mode, selection, width = 0.08, segments = 1) {
    if (!selection || !selection.size) {
      return { changed: false, error: 'Selecciona aristas, caras o vértices para biselar.' };
    }
    const segCount = Math.max(1, Math.min(4, Math.round(Number(segments) || 1)));
    const reqWidth = Math.max(1e-4, Number(width) || 0.08);
    const topo = this.getTopology();
    const { edges, edgeMap, vertEdges, vertFaces, faceEdges } = topo;

    // 1. Biselado de vértices (chamfer corner)
    if (mode === 'vertex') {
      const targetVerts = new Set();
      for (const vi of selection) {
        if (vi >= 0 && vi < this.verts.length && (vertFaces[vi]?.length || 0) >= 2) targetVerts.add(vi);
      }
      if (!targetVerts.size) return { changed: false, error: 'Selecciona vértices conectados a caras para biselar.' };

      const chamferCornerVerts = new Map(); // `${vi}_${fi}` or `${vi}_${otherEnd}` -> newVertIdx
      const vertexCapList = new Map(); // vi -> Array<newVertIdx>

      const getChamferPoint = (vi, otherVi) => {
        const key = `${vi}>${otherVi}`;
        const existing = chamferCornerVerts.get(key);
        if (existing !== undefined) return existing;
        const p = this.verts[vi];
        const q = this.verts[otherVi];
        const dx = q.x - p.x, dy = q.y - p.y, dz = q.z - p.z;
        const len = Math.hypot(dx, dy, dz) || 1;
        const step = Math.min(reqWidth, len * 0.42);
        const t = step / len;
        const nv = this.verts.length;
        this.verts.push({ x: p.x + dx * t, y: p.y + dy * t, z: p.z + dz * t });
        chamferCornerVerts.set(key, nv);
        let arr = vertexCapList.get(vi);
        if (!arr) { arr = []; vertexCapList.set(vi, arr); }
        arr.push(nv);
        return nv;
      };

      const nextFaces = [];
      const nextUvs = [];
      for (let fi = 0; fi < this.faces.length; fi++) {
        const f = this.faces[fi];
        const fUv = this.faceUvs[fi] || f.map(() => [0, 0]);
        const ring = [];
        const ringUv = [];
        for (let i = 0; i < f.length; i++) {
          const vi = f[i];
          const prev = f[(i - 1 + f.length) % f.length];
          const next = f[(i + 1) % f.length];
          if (targetVerts.has(vi)) {
            const pPrev = getChamferPoint(vi, prev);
            const pNext = getChamferPoint(vi, next);
            const uv = fUv[i] || [0, 0];
            ring.push(pPrev, pNext);
            ringUv.push(uv.slice(), uv.slice());
          } else {
            ring.push(vi);
            ringUv.push((fUv[i] || [0, 0]).slice());
          }
        }
        nextFaces.push(ring);
        nextUvs.push(ringUv);
      }

      const capIndices = new Set();
      for (const [vi, capVerts] of vertexCapList.entries()) {
        if (capVerts.length < 3) continue;
        const vn = this.computeVertexNormal(vi, _vA);
        const origin = this.verts[vi];
        const ref = Math.abs(vn.x) < 0.9 ? new Vec3(1, 0, 0) : new Vec3(0, 1, 0);
        const tU = new Vec3().crossVectors(ref, vn).normalize();
        const tV = new Vec3().crossVectors(vn, tU).normalize();
        capVerts.sort((ia, ib) => {
          const pa = this.verts[ia], pb = this.verts[ib];
          const aa = Math.atan2((pa.x - origin.x) * tV.x + (pa.y - origin.y) * tV.y + (pa.z - origin.z) * tV.z, (pa.x - origin.x) * tU.x + (pa.y - origin.y) * tU.y + (pa.z - origin.z) * tU.z);
          const ab = Math.atan2((pb.x - origin.x) * tV.x + (pb.y - origin.y) * tV.y + (pb.z - origin.z) * tV.z, (pb.x - origin.x) * tU.x + (pb.y - origin.y) * tU.y + (pb.z - origin.z) * tU.z);
          return aa - ab;
        });
        capIndices.add(nextFaces.length);
        nextFaces.push(capVerts);
        nextUvs.push(capVerts.map((_, i) => [0.5 + 0.5 * Math.cos((i / capVerts.length) * Math.PI * 2), 0.5 + 0.5 * Math.sin((i / capVerts.length) * Math.PI * 2)]));
      }

      this.faces = nextFaces;
      this.faceUvs = nextUvs;
      const remap = this.pruneUnusedVertices();
      const newSel = new Set();
      for (const list of vertexCapList.values()) {
        list.forEach((v) => {
          const rv = remap ? remap[v] : v;
          if (rv >= 0 && rv < this.verts.length) newSel.add(rv);
        });
      }
      return { changed: true, selected: newSel };
    }

    // 2. Biselado de aristas (modo Arista o borde de región en modo Cara)
    const bevelEdgeSet = new Set();
    if (mode === 'edge') {
      for (const ei of selection) {
        const e = edges[ei];
        if (e && e.faces.length >= 1) bevelEdgeSet.add(ei);
      }
    } else if (mode === 'face') {
      const selFaces = new Set(selection);
      for (let ei = 0; ei < edges.length; ei++) {
        const e = edges[ei];
        let inSel = 0;
        for (let i = 0; i < e.faces.length; i++) {
          if (selFaces.has(e.faces[i])) inSel++;
        }
        if (inSel === 1) bevelEdgeSet.add(ei);
      }
      if (!bevelEdgeSet.size) {
        for (const fi of selFaces) {
          (faceEdges[fi] || []).forEach((ei) => bevelEdgeSet.add(ei));
        }
      }
    }

    if (!bevelEdgeSet.size) {
      return { changed: false, error: 'No se encontraron aristas válidas para biselar.' };
    }

    // Calcular distancia segura limitada por la arista más corta incidente a cualquier vértice tocado
    const touchedVerts = new Set();
    for (const ei of bevelEdgeSet) {
      touchedVerts.add(edges[ei].a);
      touchedVerts.add(edges[ei].b);
    }

    let safeW = reqWidth;
    for (const vi of touchedVerts) {
      const inc = vertEdges[vi] || [];
      for (let i = 0; i < inc.length; i++) {
        const e = edges[inc[i]];
        const pa = this.verts[e.a], pb = this.verts[e.b];
        const l = Math.hypot(pb.x - pa.x, pb.y - pa.y, pb.z - pa.z);
        if (l > 1e-6) safeW = Math.min(safeW, l * 0.42);
      }
    }
    safeW = Math.max(1e-4, safeW);

    // Calcular desplazamiento de cada esquina (fi, vi)
    // - Si una sola arista del par (ePrev, eNext) en cara `fi` está biselada -> deslizar sobre la NO biselada (`edgeSlideVert`)
    // - Si AMBAS aristas (ePrev, eNext) en cara `fi` están biseladas -> desplazar por bisectriz dentro del plano de `fi` (`faceCornerVert`)
    const edgeSlideVert = new Map(); // `${ei}_${vi}` -> newVi (aristas NO biseladas con extremo biselado)
    const faceCornerVert = new Map(); // `${fi}_${vi}` -> newVi (ambas aristas en fi biseladas)
    const vertexCornerPositions = new Map(); // `${vi}` -> Set<newVi> para tapa de esquina cuando >= 2 aristas biseladas confluyen

    const registerCornerVert = (origV, newV) => {
      let s = vertexCornerPositions.get(origV);
      if (!s) { s = new Set(); vertexCornerPositions.set(origV, s); }
      s.add(newV);
    };

    const getOrCreateSlideOnEdge = (ei, vi) => {
      const key = `${ei}_${vi}`;
      const ex = edgeSlideVert.get(key);
      if (ex !== undefined) return ex;
      const e = edges[ei];
      const other = e.a === vi ? e.b : e.a;
      const p = this.verts[vi], q = this.verts[other];
      const dx = q.x - p.x, dy = q.y - p.y, dz = q.z - p.z;
      const len = Math.hypot(dx, dy, dz) || 1;
      const t = Math.min(0.45, safeW / len);
      const nv = this.verts.length;
      this.verts.push({ x: p.x + dx * t, y: p.y + dy * t, z: p.z + dz * t });
      edgeSlideVert.set(key, nv);
      registerCornerVert(vi, nv);
      return nv;
    };

    const getOrCreateFaceCorner = (fi, cornerIdx) => {
      const f = this.faces[fi];
      const vi = f[cornerIdx];
      const key = `${fi}_${vi}`;
      const ex = faceCornerVert.get(key);
      if (ex !== undefined) return ex;

      const prevV = f[(cornerIdx - 1 + f.length) % f.length];
      const nextV = f[(cornerIdx + 1) % f.length];
      const p = this.verts[vi], pPrev = this.verts[prevV], pNext = this.verts[nextV];
      let d1x = pPrev.x - p.x, d1y = pPrev.y - p.y, d1z = pPrev.z - p.z;
      let d2x = pNext.x - p.x, d2y = pNext.y - p.y, d2z = pNext.z - p.z;
      const l1 = Math.hypot(d1x, d1y, d1z) || 1;
      const l2 = Math.hypot(d2x, d2y, d2z) || 1;
      d1x /= l1; d1y /= l1; d1z /= l1;
      d2x /= l2; d2y /= l2; d2z /= l2;

      const fn = this.computeFaceNormal(fi, _vA);
      // Normales internas dentro del plano de la cara perpendiculares a cada arista
      const n1x = fn.y * d1z - fn.z * d1y;
      const n1y = fn.z * d1x - fn.x * d1z;
      const n1z = fn.x * d1y - fn.y * d1x;
      // Asegurar hacia el interior (dot con d2 > 0)
      const s1 = n1x * d2x + n1y * d2y + n1z * d2z >= 0 ? 1 : -1;
      const ox = (d1x + d2x);
      const oy = (d1y + d2y);
      const oz = (d1z + d2z);
      let bx = ox, by = oy, bz = oz;
      const bLen = Math.hypot(bx, by, bz);
      let stepLen = safeW;
      if (bLen > 1e-4) {
        bx /= bLen; by /= bLen; bz /= bLen;
        const proj = Math.abs(bx * n1x * s1 + by * n1y * s1 + bz * n1z * s1);
        stepLen = proj > 0.25 ? Math.min(safeW / proj, Math.min(l1, l2) * 0.45) : safeW;
      } else {
        bx = n1x * s1; by = n1y * s1; bz = n1z * s1;
      }
      const nv = this.verts.length;
      this.verts.push({ x: p.x + bx * stepLen, y: p.y + by * stepLen, z: p.z + bz * stepLen });
      faceCornerVert.set(key, nv);
      registerCornerVert(vi, nv);
      return nv;
    };

    // Primer paso: pre-crear los puntos deslizados en las caras tocadas por aristas biseladas
    const faceCornerOfEdge = new Map(); // `${fi}_${ei}_${vi}` -> newVi
    for (let fi = 0; fi < this.faces.length; fi++) {
      const f = this.faces[fi];
      const fe = faceEdges[fi] || [];
      for (let i = 0; i < f.length; i++) {
        const vi = f[i];
        const ePrev = fe[(i - 1 + f.length) % f.length];
        const eNext = fe[i];
        const bPrev = bevelEdgeSet.has(ePrev);
        const bNext = bevelEdgeSet.has(eNext);
        if (bPrev && bNext) {
          const nv = getOrCreateFaceCorner(fi, i);
          faceCornerOfEdge.set(`${fi}_${ePrev}_${vi}`, nv);
          faceCornerOfEdge.set(`${fi}_${eNext}_${vi}`, nv);
        } else if (bPrev && !bNext) {
          const nv = getOrCreateSlideOnEdge(eNext, vi);
          faceCornerOfEdge.set(`${fi}_${ePrev}_${vi}`, nv);
        } else if (!bPrev && bNext) {
          const nv = getOrCreateSlideOnEdge(ePrev, vi);
          faceCornerOfEdge.set(`${fi}_${eNext}_${vi}`, nv);
        }
      }
    }

    // Segundo paso: pre-construir cadenas de arco y tiras de bisel para cada arista biselada (con `segCount` segmentos)
    const segChainCache = new Map(); // `${vA}>${vB}` -> Array<int> length segCount+1
    const getOrBuildArcChain = (vStart, vEnd, origVert) => {
      if (segCount <= 1) return [vStart, vEnd];
      const key = `${vStart}>${vEnd}`;
      const ex = segChainCache.get(key);
      if (ex) return ex;
      const revKey = `${vEnd}>${vStart}`;
      const revEx = segChainCache.get(revKey);
      if (revEx) return revEx.slice().reverse();

      const pA = this.verts[vStart];
      const pB = this.verts[vEnd];
      const pO = this.verts[origVert];
      const chain = [vStart];
      for (let s = 1; s < segCount; s++) {
        const t = s / segCount;
        // Perfil redondeado suave: mezcla lineal + desplazamiento hacia pO proporcional a sin(pi*t)
        const lx = pA.x + (pB.x - pA.x) * t;
        const ly = pA.y + (pB.y - pA.y) * t;
        const lz = pA.z + (pB.z - pA.z) * t;
        const midX = (pA.x + pB.x) * 0.5;
        const midY = (pA.y + pB.y) * 0.5;
        const midZ = (pA.z + pB.z) * 0.5;
        const bulge = Math.sin(t * Math.PI) * 0.42;
        const nv = this.verts.length;
        this.verts.push({
          x: lx + (pO.x - midX) * bulge,
          y: ly + (pO.y - midY) * bulge,
          z: lz + (pO.z - midZ) * bulge,
        });
        chain.push(nv);
      }
      chain.push(vEnd);
      segChainCache.set(key, chain);
      return chain;
    };

    const stripFaces = [];
    const stripUvs = [];
    const newlyCreatedEdgeKeys = [];
    for (const ei of bevelEdgeSet) {
      const e = edges[ei];
      if (e.faces.length !== 2) continue;
      const fi0 = e.faces[0];
      const fi1 = e.faces[1];
      const f0 = this.faces[fi0];

      // Determinar orden dirigido (u -> v) en f0
      let u = e.a, v = e.b;
      for (let i = 0; i < f0.length; i++) {
        if (f0[i] === e.a && f0[(i + 1) % f0.length] === e.b) { u = e.a; v = e.b; break; }
        if (f0[i] === e.b && f0[(i + 1) % f0.length] === e.a) { u = e.b; v = e.a; break; }
      }

      const c0u = faceCornerOfEdge.get(`${fi0}_${ei}_${u}`);
      const c0v = faceCornerOfEdge.get(`${fi0}_${ei}_${v}`);
      const c1u = faceCornerOfEdge.get(`${fi1}_${ei}_${u}`);
      const c1v = faceCornerOfEdge.get(`${fi1}_${ei}_${v}`);
      if (c0u === undefined || c0v === undefined || c1u === undefined || c1v === undefined) continue;

      const chainU = getOrBuildArcChain(c0u, c1u, u);
      const chainV = getOrBuildArcChain(c0v, c1v, v);
      for (let s = 0; s < segCount; s++) {
        const a = chainU[s], b = chainU[s + 1], c = chainV[s + 1], d = chainV[s];
        if (new Set([a, b, c, d]).size < 3) continue;
        // En f0 la arista iba u -> v; en el bisel adyacente debe ir v -> u (d -> a -> b -> c)
        stripFaces.push([d, a, b, c]);
        stripUvs.push([[1, s / segCount], [0, s / segCount], [0, (s + 1) / segCount], [1, (s + 1) / segCount]]);
        newlyCreatedEdgeKeys.push(edgeKey(a, d), edgeKey(b, c));
      }
    }

    // Tercer paso: reconstruir las caras originales (incluyendo caras no tocadas cuyas aristas tengan arcos/deslizamientos!)
    const nextFaces = [];
    const nextUvs = [];
    const beveledFaceIndices = new Set();

    for (let fi = 0; fi < this.faces.length; fi++) {
      const f = this.faces[fi];
      const fUv = this.faceUvs[fi] || f.map(() => [0, 0]);
      const fe = faceEdges[fi] || [];
      const ring = [];
      const ringUv = [];

      for (let i = 0; i < f.length; i++) {
        const vi = f[i];
        const uv = fUv[i] || [0, 0];
        const ePrev = fe[(i - 1 + f.length) % f.length];
        const eNext = fe[i];
        const bPrev = bevelEdgeSet.has(ePrev);
        const bNext = bevelEdgeSet.has(eNext);

        if (bPrev && bNext) {
          ring.push(faceCornerVert.get(`${fi}_${vi}`));
          ringUv.push(uv.slice());
        } else if (bPrev && !bNext) {
          ring.push(edgeSlideVert.get(`${eNext}_${vi}`));
          ringUv.push(uv.slice());
        } else if (!bPrev && bNext) {
          ring.push(edgeSlideVert.get(`${ePrev}_${vi}`));
          ringUv.push(uv.slice());
        } else {
          // Ninguna de las 2 aristas en esta cara está biselada, pero otro lado del vértice podría haber deslizado sobre ellas
          const sPrev = edgeSlideVert.get(`${ePrev}_${vi}`);
          const sNext = edgeSlideVert.get(`${eNext}_${vi}`);
          if (sPrev !== undefined && sNext !== undefined) {
            ring.push(sPrev);
            ringUv.push(uv.slice());
            const ch = segChainCache.get(`${sPrev}>${sNext}`) || segChainCache.get(`${sNext}>${sPrev}`)?.slice().reverse();
            if (ch && ch.length > 2) {
              for (let k = 1; k < ch.length - 1; k++) {
                ring.push(ch[k]);
                ringUv.push(uv.slice());
              }
            }
            ring.push(sNext);
            ringUv.push(uv.slice());
          } else if (sPrev !== undefined) {
            ring.push(sPrev, vi);
            ringUv.push(uv.slice(), uv.slice());
          } else if (sNext !== undefined) {
            ring.push(vi, sNext);
            ringUv.push(uv.slice(), uv.slice());
          } else {
            ring.push(vi);
            ringUv.push(uv.slice());
          }
        }
      }

      if (ring.length >= 3) {
        nextFaces.push(ring);
        nextUvs.push(ringUv);
      }
    }

    for (let si = 0; si < stripFaces.length; si++) {
      beveledFaceIndices.add(nextFaces.length);
      nextFaces.push(stripFaces[si]);
      nextUvs.push(stripUvs[si]);
    }

    // Cuarto paso: tapar esquinas donde convergen >= 2 aristas biseladas (p.ej. esquinas de un cubo)
    for (const origV of touchedVerts) {
      let bevIncident = 0;
      const inc = vertEdges[origV] || [];
      for (let i = 0; i < inc.length; i++) {
        if (bevelEdgeSet.has(inc[i])) bevIncident++;
      }
      if (bevIncident < 2) continue;

      const cornersSet = vertexCornerPositions.get(origV);
      if (!cornersSet || cornersSet.size < 3) continue;
      const capVerts = [...cornersSet];
      const vn = this.computeVertexNormal(origV, _vA);
      const origin = this.verts[origV];
      const ref = Math.abs(vn.x) < 0.9 ? new Vec3(1, 0, 0) : new Vec3(0, 1, 0);
      const tU = new Vec3().crossVectors(ref, vn).normalize();
      const tV = new Vec3().crossVectors(vn, tU).normalize();
      capVerts.sort((ia, ib) => {
        const pa = this.verts[ia], pb = this.verts[ib];
        const aa = Math.atan2((pa.x - origin.x) * tV.x + (pa.y - origin.y) * tV.y + (pa.z - origin.z) * tV.z, (pa.x - origin.x) * tU.x + (pa.y - origin.y) * tU.y + (pa.z - origin.z) * tU.z);
        const ab = Math.atan2((pb.x - origin.x) * tV.x + (pb.y - origin.y) * tV.y + (pb.z - origin.z) * tV.z, (pb.x - origin.x) * tU.x + (pb.y - origin.y) * tU.y + (pb.z - origin.z) * tU.z);
        return aa - ab;
      });

      // Si segCount > 1 y hay cadenas de arco entre esquinas consecutivas, insertar vértices intermedios del arco!
      const expandedCap = [];
      for (let i = 0; i < capVerts.length; i++) {
        const va = capVerts[i];
        const vb = capVerts[(i + 1) % capVerts.length];
        expandedCap.push(va);
        const ch = segChainCache.get(`${va}>${vb}`) || segChainCache.get(`${vb}>${va}`)?.slice().reverse();
        if (ch && ch.length > 2) {
          for (let k = 1; k < ch.length - 1; k++) expandedCap.push(ch[k]);
        }
      }

      if (expandedCap.length >= 3) {
        const cfi = nextFaces.length;
        nextFaces.push(expandedCap);
        nextUvs.push(expandedCap.map((_, i) => [0.5 + 0.4 * Math.cos((i / expandedCap.length) * Math.PI * 2), 0.5 + 0.4 * Math.sin((i / expandedCap.length) * Math.PI * 2)]));
        beveledFaceIndices.add(cfi);
      }
    }

    this.faces = nextFaces;
    this.faceUvs = nextUvs;
    this.pruneUnusedVertices();

    if (mode === 'face') {
      return { changed: true, selected: beveledFaceIndices };
    }
    const nextTopo = this.getTopology();
    const nextEdgeSel = new Set();
    for (let i = 0; i < newlyCreatedEdgeKeys.length; i++) {
      const ei = nextTopo.edgeMap.get(newlyCreatedEdgeKeys[i]);
      if (ei !== undefined) nextEdgeSel.add(ei);
    }
    return { changed: true, selected: nextEdgeSel };
  }

  /**
   * Solda múltiples sub-mallas o elementos adyacentes/superpuestos dentro de este EditableMesh para que
   * formen una sola pieza sólida coherente: divide intersecciones 3D, elimina caras y vértices interiores,
   * fusiona vértices apilados repetidamente y cose uniones en T.
   */
  weldShells({
    threshold = 0.02,
    removeInteriorFaces = true,
    stitchTJunctions = true,
    solidity = 0.8,
    shellIds = null,
  } = {}) {
    const tol = Math.max(1e-6, Number(threshold) || 0.02);
    const prevVertCount = this.verts.length;
    let totalMergedVerts = 0;
    let totalRemovedInterior = 0;
    let totalStitchedEdges = 0;
    let didUnion = false;
    let faceOrigins = null;

    // Escala de la malla para proteger triángulos finos de corte booleano frente a colapsos
    let gMinX = Infinity, gMinY = Infinity, gMinZ = Infinity;
    let gMaxX = -Infinity, gMaxY = -Infinity, gMaxZ = -Infinity;
    for (let i = 0; i < this.verts.length; i++) {
      const p = this.verts[i];
      if (p.x < gMinX) gMinX = p.x; if (p.x > gMaxX) gMaxX = p.x;
      if (p.y < gMinY) gMinY = p.y; if (p.y > gMaxY) gMaxY = p.y;
      if (p.z < gMinZ) gMinZ = p.z; if (p.z > gMaxZ) gMaxZ = p.z;
    }
    const diag = Math.hypot(gMaxX - gMinX, gMaxY - gMinY, gMaxZ - gMinZ) || 1;

    // 0. Unión booleana sólida si existen 2+ shells con intersección volumétrica o penetración interior
    if (removeInteriorFaces && this.faces.length >= 2) {
      const unionRes = performVolumetricUnionIfNeeded(this, {
        threshold: tol,
        shellIds,
      });
      if (unionRes && unionRes.performed) {
        didUnion = true;
        totalRemovedInterior += unionRes.removedInsideCount || 0;
        faceOrigins = unionRes.faceOrigins || null;
      }
    }

    // Tras un corte booleano exacto, limitar el soldado posterior a tolerancia de costura fina para
    // no colapsar micro-triángulos legítimos en la curva de intersección (evita aristas de 4 caras).
    const activeTol = didUnion ? Math.min(tol, Math.max(2e-4, diag * 8e-4)) : tol;
    const activeTolSq = activeTol * activeTol;

    // 1. Soldar vértices cercanos o apilados iterativamente hasta converger (conservando paredes opuestas aún)
    const firstMerge = this.mergeByDistance(activeTol, null, {
      dedupeFaces: !removeInteriorFaces,
      iterative: true,
      faceTags: faceOrigins,
    });
    if (firstMerge.changed) {
      totalMergedVerts += firstMerge.mergedCount;
    }

    // 2. Costura de uniones en T: si un vértice cae sobre una arista de otra cara, partir esa arista
    if (stitchTJunctions && this.faces.length >= 2 && this.verts.length <= 20000) {
      const splitInserts = new Map(); // edgeKey -> Array<{ vi, t }>
      const topo = this.getTopology();
      for (let ei = 0; ei < topo.edges.length; ei++) {
        const e = topo.edges[ei];
        const pa = this.verts[e.a];
        const pb = this.verts[e.b];
        const ex = pb.x - pa.x, ey = pb.y - pa.y, ez = pb.z - pa.z;
        const lenSq = ex * ex + ey * ey + ez * ez;
        if (lenSq <= activeTolSq * 4) continue;
        const edgeLen = Math.sqrt(lenSq);
        const endMargin = Math.min(0.015, Math.max(1e-4, (activeTol * 1.05) / edgeLen));
        const minX = Math.min(pa.x, pb.x) - activeTol, maxX = Math.max(pa.x, pb.x) + activeTol;
        const minY = Math.min(pa.y, pb.y) - activeTol, maxY = Math.max(pa.y, pb.y) + activeTol;
        const minZ = Math.min(pa.z, pb.z) - activeTol, maxZ = Math.max(pa.z, pb.z) + activeTol;

        for (let vi = 0; vi < this.verts.length; vi++) {
          if (vi === e.a || vi === e.b) continue;
          const p = this.verts[vi];
          if (p.x < minX || p.x > maxX || p.y < minY || p.y > maxY || p.z < minZ || p.z > maxZ) continue;
          const t = ((p.x - pa.x) * ex + (p.y - pa.y) * ey + (p.z - pa.z) * ez) / lenSq;
          if (t <= endMargin || t >= 1 - endMargin) continue;
          const qx = pa.x + ex * t, qy = pa.y + ey * t, qz = pa.z + ez * t;
          const dSq = (p.x - qx) ** 2 + (p.y - qy) ** 2 + (p.z - qz) ** 2;
          if (dSq <= activeTolSq) {
            let arr = splitInserts.get(e.key);
            if (!arr) { arr = []; splitInserts.set(e.key, arr); }
            arr.push({ vi, t: e.a < e.b ? t : 1 - t });
          }
        }
      }

      if (splitInserts.size > 0) {
        const nextFaces = [];
        const nextUvs = [];
        for (let fi = 0; fi < this.faces.length; fi++) {
          const f = this.faces[fi];
          const fUv = this.faceUvs[fi] || f.map(() => [0, 0]);
          const ring = [];
          const ringUv = [];
          for (let i = 0; i < f.length; i++) {
            const a = f[i];
            const b = f[(i + 1) % f.length];
            const uvA = fUv[i] || [0, 0];
            const uvB = fUv[(i + 1) % f.length] || [0, 0];
            ring.push(a);
            ringUv.push(uvA.slice());
            const k = edgeKey(a, b);
            const inserts = splitInserts.get(k);
            if (inserts && inserts.length) {
              const lo = Math.min(a, b);
              const ordered = inserts
                .map((it) => ({
                  vi: it.vi,
                  frac: a === lo ? it.t : 1 - it.t,
                }))
                .sort((u, v) => u.frac - v.frac);
              for (const ins of ordered) {
                if (!ring.includes(ins.vi)) {
                  ring.push(ins.vi);
                  ringUv.push([
                    uvA[0] + (uvB[0] - uvA[0]) * ins.frac,
                    uvA[1] + (uvB[1] - uvA[1]) * ins.frac,
                  ]);
                  totalStitchedEdges++;
                }
              }
            }
          }
          nextFaces.push(ring);
          nextUvs.push(ringUv);
        }
        this.faces = nextFaces;
        this.faceUvs = nextUvs;
        this.invalidateTopology();

        // Resoldar en caso de que la costura dejara vértices duplicados adyacentes
        const postStitchWeld = this.mergeByDistance(activeTol, null, {
          dedupeFaces: !removeInteriorFaces,
          iterative: true,
          faceTags: faceOrigins,
        });
        if (postStitchWeld.changed) {
          totalMergedVerts += postStitchWeld.mergedCount;
        }
      }
    }

    const tolSq = activeTolSq;

    // 3. Eliminar caras interiores superpuestas o encontradas frente a frente entre piezas unidas
    if (removeInteriorFaces && this.faces.length >= 2) {
      const removed = new Uint8Array(this.faces.length);
      const normals = new Array(this.faces.length);
      const centroids = new Array(this.faces.length);
      const sigGroups = new Map();

      for (let fi = 0; fi < this.faces.length; fi++) {
        const f = this.faces[fi];
        normals[fi] = this.computeFaceNormal(fi, new Vec3());
        centroids[fi] = this.computeFaceCenter(fi, new Vec3());
        const sig = f.slice().sort((a, b) => a - b).join(',');
        let list = sigGroups.get(sig);
        if (!list) { list = []; sigGroups.set(sig, list); }
        list.push(fi);
      }

      // 3a. Coincidencia exacta de conjunto de vértices:
      // Opuestas -> pared interior (borrar ambas). Mismo sentido -> cara coplanar duplicada (conservar una).
      let removedHere = 0;
      for (const list of sigGroups.values()) {
        if (list.length < 2) continue;
        for (let i = 0; i < list.length; i++) {
          const fa = list[i];
          if (removed[fa]) continue;
          for (let j = i + 1; j < list.length; j++) {
            const fb = list[j];
            if (removed[fb]) continue;
            const dot = normals[fa].dot(normals[fb]);
            if (dot < -0.5) {
              removed[fa] = 1;
              removed[fb] = 1;
              totalRemovedInterior += 2;
              removedHere += 2;
              break;
            } else if (dot > 0.8) {
              removed[fb] = 1;
              removedHere += 1;
            }
          }
        }
      }

      // 3b. Coincidencia geométrica aproximada dentro de tol (opuestas o duplicadas superpuestas)
      for (let i = 0; i < this.faces.length; i++) {
        if (removed[i]) continue;
        const ci = centroids[i];
        const ni = normals[i];
        const fLen = this.faces[i].length;
        for (let j = i + 1; j < this.faces.length; j++) {
          if (removed[j] || this.faces[j].length !== fLen) continue;
          const dot = ni.dot(normals[j]);
          if (Math.abs(dot) < 0.92) continue;
          const cj = centroids[j];
          const dSq = (ci.x - cj.x) ** 2 + (ci.y - cj.y) ** 2 + (ci.z - cj.z) ** 2;
          if (dSq > tolSq * 2.25) continue;
          const fiVerts = this.faces[i];
          const fjVerts = this.faces[j];
          let allMatch = true;
          for (let k = 0; k < fjVerts.length; k++) {
            const pj = this.verts[fjVerts[k]];
            let best = Infinity;
            for (let m = 0; m < fiVerts.length; m++) {
              const pi = this.verts[fiVerts[m]];
              const vd = (pi.x - pj.x) ** 2 + (pi.y - pj.y) ** 2 + (pi.z - pj.z) ** 2;
              if (vd < best) best = vd;
            }
            if (best > tolSq * 2.25) {
              allMatch = false;
              break;
            }
          }
          if (allMatch) {
            if (dot < -0.92) {
              removed[i] = 1;
              removed[j] = 1;
              totalRemovedInterior += 2;
              removedHere += 2;
              break;
            } else if (dot > 0.92) {
              removed[j] = 1;
              removedHere += 1;
            }
          }
        }
      }

      if (removedHere > 0) {
        const nextFaces = [];
        const nextUvs = [];
        const nextOrigins = faceOrigins ? [] : null;
        for (let fi = 0; fi < this.faces.length; fi++) {
          if (removed[fi]) continue;
          nextFaces.push(this.faces[fi]);
          nextUvs.push(this.faceUvs[fi] || this.faces[fi].map(() => [0, 0]));
          if (nextOrigins) nextOrigins.push(faceOrigins[fi]);
        }
        this.faces = nextFaces;
        this.faceUvs = nextUvs;
        if (nextOrigins) {
          faceOrigins.splice(0, faceOrigins.length, ...nextOrigins);
        }
        this.invalidateTopology();
      }
    }

    // 4. Simplificar topología booleana según el nivel de solidez deseado
    if (didUnion && this.faces.length >= 2) {
      simplifyUnionTopology(this, faceOrigins, {
        planeTol: Math.min(tol * 0.5, Math.max(1e-4, diag * 3e-4)),
        edgeTol: activeTol * 2,
        solidity,
      });
    }

    // 5. Limpieza final obligatoria: borrar todo vértice interior, suelto o huérfano y fusionar duplicados residuales
    this.pruneUnusedVertices();
    const prunedCount = Math.max(0, prevVertCount - this.verts.length);
    this.invalidateTopology();

    return {
      changed: didUnion || totalMergedVerts > 0 || totalRemovedInterior > 0 || totalStitchedEdges > 0 || prunedCount > 0,
      mergedVertices: totalMergedVerts,
      removedInteriorFaces: totalRemovedInterior,
      stitchedEdges: totalStitchedEdges,
    };
  }

  /**
   * Combina múltiples mallas (con sus transformaciones en mundo) en un único EditableMesh coherente,
   * transformando todo al espacio local del destino y ejecutando unión sólida + soldado estructural.
   */
  static mergeMeshes(items, opts = {}) {
    const list = Array.isArray(items) ? items.filter(Boolean) : [];
    if (!list.length) return { mesh: new EditableMesh(), mergedVertices: 0, removedInteriorFaces: 0, stitchedEdges: 0 };

    const invTarget = new Mat4();
    if (opts.targetMatrixWorld) {
      invTarget.copy(opts.targetMatrixWorld).invert();
    }
    const relMat = new Mat4();
    const tmpP = new Vec3();

    const combinedVerts = [];
    const combinedFaces = [];
    const combinedFaceUvs = [];
    const combinedLoose = [];
    const combinedCreases = new Map();
    const combinedShellIds = [];

    for (let k = 0; k < list.length; k++) {
      const entry = list[k];
      const srcGeo = entry.geometry || entry.mesh?.geometry || null;
      const dirtySculpt = Boolean(
        entry.mesh?._subsurfDirtyFromGeometry ||
        (srcGeo && srcGeo._modifiedBySculpt && !srcGeo._isGeneratedSubsurf)
      );
      const em = !dirtySculpt && entry.editableMesh
        ? entry.editableMesh
        : entry.isEditableMesh
        ? entry
        : !dirtySculpt && entry.mesh?._subsurf?.baseMesh
        ? entry.mesh._subsurf.baseMesh
        : srcGeo
        ? EditableMesh.fromGeometry(srcGeo)
        : null;
      if (!em || !em.verts.length) continue;

      const worldMat = entry.matrixWorld || entry.mesh?.matrixWorld || null;
      if (worldMat) {
        if (entry.mesh?.updateWorldMatrix) entry.mesh.updateWorldMatrix(true, false);
        relMat.multiplyMatrices(invTarget, worldMat);
      } else {
        relMat.identity();
      }

      // Detectar si una escala negativa invirtió el devanado de las caras
      const e = relMat.elements;
      const det3 =
        e[0] * (e[5] * e[10] - e[6] * e[9]) -
        e[4] * (e[1] * e[10] - e[2] * e[9]) +
        e[8] * (e[1] * e[6] - e[2] * e[5]);
      const flipWinding = det3 < 0;

      const vOffset = combinedVerts.length;
      for (let vi = 0; vi < em.verts.length; vi++) {
        const src = em.verts[vi];
        tmpP.set(src.x, src.y, src.z).applyMatrix4(relMat);
        combinedVerts.push({ x: tmpP.x, y: tmpP.y, z: tmpP.z });
      }

      for (let fi = 0; fi < em.faces.length; fi++) {
        const f = em.faces[fi].map((vi) => vi + vOffset);
        const uv = (em.faceUvs[fi] || f.map(() => [0, 0])).map((pair) => [pair[0], pair[1]]);
        if (flipWinding) {
          f.reverse();
          uv.reverse();
        }
        combinedFaces.push(f);
        combinedFaceUvs.push(uv);
        combinedShellIds.push(k);
      }

      for (let li = 0; li < em.looseEdges.length; li++) {
        combinedLoose.push([em.looseEdges[li][0] + vOffset, em.looseEdges[li][1] + vOffset]);
      }

      if (em.creases && em.creases.size) {
        for (const [ck, cw] of em.creases.entries()) {
          const sep = ck.indexOf('_');
          const a = Number(ck.slice(0, sep)) + vOffset;
          const b = Number(ck.slice(sep + 1)) + vOffset;
          combinedCreases.set(edgeKey(a, b), cw);
        }
      }
    }

    const merged = new EditableMesh(combinedVerts, combinedFaces, combinedFaceUvs, combinedLoose, combinedCreases);
    const weldRes = merged.weldShells({
      threshold: opts.threshold ?? 0.02,
      removeInteriorFaces: opts.removeInteriorFaces !== false,
      stitchTJunctions: opts.stitchTJunctions !== false,
      solidity: opts.solidity ?? 0.8,
      shellIds: combinedShellIds,
    });

    return {
      mesh: merged,
      ...weldRes,
    };
  }
}
