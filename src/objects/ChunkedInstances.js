import { Object3D } from '../core/Object3D.js';
import { InstancedMesh } from './InstancedMesh.js';
import { BufferAttribute } from '../geometry/BufferAttribute.js';
import { Mat4 } from '../math/Mat4.js';
import { Vec3 } from '../math/Vec3.js';
import { SceneBvh, preloadMadeOptimize } from '../libs/made-optimize/made_optimize.js';

const _m = new Mat4();
const _invWorld = new Mat4();
const _localVP = new Mat4();
const _localCam = new Vec3();
const _planes = new Float32Array(24);
const _camArr = [0, 0, 0];

function extractFrustumPlanes(m, out) {
  const e = m.elements;
  const set = (i, a, b, c, d) => {
    const l = Math.hypot(a, b, c) || 1;
    out[i] = a / l; out[i + 1] = b / l; out[i + 2] = c / l; out[i + 3] = d / l;
  };
  set(0, e[3] + e[0], e[7] + e[4], e[11] + e[8], e[15] + e[12]);
  set(4, e[3] - e[0], e[7] - e[4], e[11] - e[8], e[15] - e[12]);
  set(8, e[3] + e[1], e[7] + e[5], e[11] + e[9], e[15] + e[13]);
  set(12, e[3] - e[1], e[7] - e[5], e[11] - e[9], e[15] - e[13]);
  set(16, e[3] + e[2], e[7] + e[6], e[11] + e[10], e[15] + e[14]);
  set(20, e[3] - e[2], e[7] - e[6], e[11] - e[10], e[15] - e[14]);
}

/**
 * Instancias repartidas en chunks (celdas del espacio). Cada chunk es un InstancedMesh con su propia esfera
 * envolvente: el renderer y el BVH de MadeOptimize descartan chunks enteros en O(log N) con selección de LOD,
 * sin recorrer todas las instancias ni subir matrices a la GPU por cuadro.
 *
 *   const world = new ChunkedInstances(geometry, material, { chunkSize: 16, lod: [{ distance: 80, geometry: low }, { distance: 200, geometry: null }] });
 *   world.addInstance(position, quaternion, scale);   // o world.addMatrix(mat4)
 *   world.build(); scene.add(world);
 *
 * LOD: `lod` = [{ distance, geometry }]; desde esa distancia se usa esa geometría (`null` = no dibujar).
 * Streaming: setChunk(cx, cy, cz, Float32Array) / removeChunk(cx, cy, cz).
 */
export class ChunkedInstances extends Object3D {
  constructor(geometry, material, opts = {}) {
    super();
    this.isChunkedInstances = true;
    this.geometry = geometry;
    this.material = material;
    this.chunkSize = opts.chunkSize ?? 16;
    this.useBvh = opts.useBvh !== false;
    if (this.useBvh) preloadMadeOptimize().catch(() => {});
    const lv = (opts.lod || []).map((l) => ({ distance: l.distance, geometry: l.geometry }));
    if (opts.maxDistance !== undefined) lv.push({ distance: opts.maxDistance, geometry: null });
    lv.sort((a, b) => a.distance - b.distance);
    if (!lv.length || lv[0].distance > 0) lv.unshift({ distance: 0, geometry });
    this.levels = lv;
    this._lodThresholds = Float32Array.from(lv.map((l) => l.distance));
    this.chunks = new Map();
    this._chunkList = [];
    this._visibleChunks = [];
    this._bvh = null;
    this._bvhDirty = false;
    this._pending = new Map();
    let gr = 0;
    for (const l of lv) if (l.geometry) { const bs = l.geometry.getBoundingSphere(); if (bs) gr = Math.max(gr, bs.radius + bs.center.length()); }
    this._geoRadius = gr;
  }

  get chunkCount() { return this.chunks.size; }
  get instanceCount() { let n = 0; for (const c of this.chunks.values()) n += c.count; return n; }

  _key(cx, cy, cz) { return cx + ',' + cy + ',' + cz; }

  addMatrix(mat4) {
    const e = mat4.elements, s = this.chunkSize;
    const cx = Math.floor(e[12] / s), cy = Math.floor(e[13] / s), cz = Math.floor(e[14] / s), key = this._key(cx, cy, cz);
    let p = this._pending.get(key);
    if (!p) { p = { cx, cy, cz, data: [] }; this._pending.set(key, p); }
    for (let i = 0; i < 16; i++) p.data.push(e[i]);
    return this;
  }
  addInstance(position, quaternion, scale) {
    _m.compose(position, quaternion || { x: 0, y: 0, z: 0, w: 1 }, scale || { x: 1, y: 1, z: 1 });
    return this.addMatrix(_m);
  }

  // Crea (o completa) los chunks con lo acumulado por addMatrix / addInstance.
  build() {
    for (const p of this._pending.values()) {
      const old = this.chunks.get(this._key(p.cx, p.cy, p.cz));
      const add = Float32Array.from(p.data);
      let data = add;
      if (old) { data = new Float32Array(old.matrices.length + add.length); data.set(old.matrices); data.set(add, old.matrices.length); }
      this.setChunk(p.cx, p.cy, p.cz, data);
    }
    this._pending.clear();
    if (this._bvhDirty) this._rebuildBvh();
    return this;
  }

  _rebuildBvh() {
    this._bvhDirty = false;
    const list = Array.from(this.chunks.values());
    this._chunkList = list;
    if (!this.useBvh || list.length < 8) {
      if (this._bvh) {
        this._bvh.dispose();
        this._bvh = null;
      }
      return;
    }
    const spheres = new Float32Array(list.length * 4);
    for (let i = 0; i < list.length; i++) {
      const ch = list[i];
      spheres[i * 4] = ch.center.x;
      spheres[i * 4 + 1] = ch.center.y;
      spheres[i * 4 + 2] = ch.center.z;
      spheres[i * 4 + 3] = ch.radius;
    }
    if (!this._bvh) {
      this._bvh = new SceneBvh(spheres);
    } else {
      this._bvh.rebuild(spheres);
    }
  }

  // Reemplaza por completo el contenido de un chunk (matrices de n×16 floats).
  setChunk(cx, cy, cz, matrices) {
    this.removeChunk(cx, cy, cz);
    const n = (matrices.length / 16) | 0;
    if (!n) return this;
    const a = matrices;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < n; i++) {
      const o = i * 16, x = a[o + 12], y = a[o + 13], z = a[o + 14];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    const c = new Vec3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    let r = 0;
    for (let i = 0; i < n; i++) {
      const o = i * 16;
      const d = Math.hypot(a[o + 12] - c.x, a[o + 13] - c.y, a[o + 14] - c.z);
      const s = Math.sqrt(Math.max(
        a[o] * a[o] + a[o + 1] * a[o + 1] + a[o + 2] * a[o + 2],
        a[o + 4] * a[o + 4] + a[o + 5] * a[o + 5] + a[o + 6] * a[o + 6],
        a[o + 8] * a[o + 8] + a[o + 9] * a[o + 9] + a[o + 10] * a[o + 10]));
      const t = d + this._geoRadius * s;
      if (t > r) r = t;
    }
    const attr = new BufferAttribute(a, 16);   // compartido entre los niveles de LOD
    const meshes = this.levels.map((lv) => {
      if (!lv.geometry) return null;
      const m = new InstancedMesh(lv.geometry, this.material, n, attr);
      m.cullInstances = false;
      m.boundingSphere = { center: c, radius: r };
      m.castShadow = this.castShadow;
      m.receiveShadow = this.receiveShadow;
      m.matrixAutoUpdate = false;
      m.visible = false;
      this.add(m);
      return m;
    });
    this.chunks.set(this._key(cx, cy, cz), { cx, cy, cz, matrices: a, count: n, center: c, radius: r, meshes });
    this._bvhDirty = true;
    return this;
  }
  removeChunk(cx, cy, cz) {
    const key = this._key(cx, cy, cz), ch = this.chunks.get(key);
    if (!ch) return this;
    for (const m of ch.meshes) if (m) { m.dispose(); this.remove(m); }
    this.chunks.delete(key);
    this._bvhDirty = true;
    return this;
  }
  clear() {
    for (const ch of [...this.chunks.values()]) this.removeChunk(ch.cx, ch.cy, ch.cz);
    this._pending.clear();
    this._visibleChunks.length = 0;
    this._chunkList.length = 0;
    if (this._bvh) {
      this._bvh.dispose();
      this._bvh = null;
    }
    this._bvhDirty = false;
    return this;
  }
  // Libera los buffers de GPU de todos los chunks (la geometría y el material los gestionas tú).
  dispose() { return this.clear(); }

  // El renderer lo llama antes de recorrer los hijos: elige el nivel de detalle y realiza culling BVH si aplica.
  onBeforeRender(renderer, camera) {
    if (!camera) return;
    if (this._bvhDirty) this._rebuildBvh();

    const ce = camera.matrixWorld.elements;
    if (this._bvh && renderer && renderer._viewProj) {
      for (let i = 0; i < this._visibleChunks.length; i++) {
        const ch = this._visibleChunks[i];
        for (let j = 0; j < ch.meshes.length; j++) {
          if (ch.meshes[j]) ch.meshes[j].visible = false;
        }
      }
      this._visibleChunks.length = 0;

      const e = this.matrixWorld.elements;
      const isIdentity =
        e[0] === 1 && e[5] === 1 && e[10] === 1 && e[15] === 1 &&
        e[1] === 0 && e[2] === 0 && e[3] === 0 &&
        e[4] === 0 && e[6] === 0 && e[7] === 0 &&
        e[8] === 0 && e[9] === 0 && e[11] === 0 &&
        e[12] === 0 && e[13] === 0 && e[14] === 0;

      if (isIdentity) {
        const fp = renderer._frustum?.p;
        if (fp) {
          for (let i = 0; i < 24; i++) _planes[i] = fp[i];
        } else {
          extractFrustumPlanes(renderer._viewProj, _planes);
        }
        _camArr[0] = ce[12];
        _camArr[1] = ce[13];
        _camArr[2] = ce[14];
      } else {
        _localVP.multiplyMatrices(renderer._viewProj, this.matrixWorld);
        extractFrustumPlanes(_localVP, _planes);
        _invWorld.copy(this.matrixWorld).invert();
        _localCam.set(ce[12], ce[13], ce[14]).applyMatrix4(_invWorld);
        _camArr[0] = _localCam.x;
        _camArr[1] = _localCam.y;
        _camArr[2] = _localCam.z;
      }

      const res = this._bvh.queryFrustum(_planes, _camArr, this._lodThresholds);
      const list = this._chunkList;
      for (let i = 0; i < res.count; i++) {
        const ch = list[res.indices[i]];
        if (!ch) continue;
        const m = ch.meshes[res.lods[i]];
        if (m) {
          m.visible = true;
          m.castShadow = this.castShadow;
          m.receiveShadow = this.receiveShadow;
          this._visibleChunks.push(ch);
        }
      }
      return;
    }

    this._visibleChunks.length = 0;
    const e = this.matrixWorld.elements, gs = this.matrixWorld.getMaxScale();
    const lv = this.levels, last = lv.length - 1;
    for (const ch of this.chunks.values()) {
      const c = ch.center;
      const wx = e[0] * c.x + e[4] * c.y + e[8] * c.z + e[12], wy = e[1] * c.x + e[5] * c.y + e[9] * c.z + e[13], wz = e[2] * c.x + e[6] * c.y + e[10] * c.z + e[14];
      // distancia al punto más cercano del chunk: el detalle alto se usa si alguna parte está cerca
      const d = Math.max(0, Math.hypot(wx - ce[12], wy - ce[13], wz - ce[14]) - ch.radius * gs);
      let k = 0;
      for (let i = last; i > 0; i--) if (d >= lv[i].distance) { k = i; break; }
      let anyVis = false;
      for (let i = 0; i < ch.meshes.length; i++) {
        const m = ch.meshes[i];
        if (m) {
          m.visible = i === k;
          m.castShadow = this.castShadow;
          m.receiveShadow = this.receiveShadow;
          if (m.visible) anyVis = true;
        }
      }
      if (anyVis) this._visibleChunks.push(ch);
    }
  }
}
