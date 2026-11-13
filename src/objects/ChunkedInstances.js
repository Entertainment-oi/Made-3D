import { Object3D } from '../core/Object3D.js';
import { InstancedMesh } from './InstancedMesh.js';
import { BufferAttribute } from '../geometry/BufferAttribute.js';
import { Mat4 } from '../math/Mat4.js';
import { Vec3 } from '../math/Vec3.js';

const _m = new Mat4();

/**
 * Instancias repartidas en chunks (celdas del espacio). Cada chunk es un InstancedMesh con su propia esfera
 * envolvente: el renderer descarta chunks enteros con una sola prueba, sin recorrer las instancias, y como cada
 * chunk tiene su buffer fijo no se sube nada a la GPU por cuadro.
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
    const lv = (opts.lod || []).map((l) => ({ distance: l.distance, geometry: l.geometry }));
    if (opts.maxDistance !== undefined) lv.push({ distance: opts.maxDistance, geometry: null });
    lv.sort((a, b) => a.distance - b.distance);
    if (!lv.length || lv[0].distance > 0) lv.unshift({ distance: 0, geometry });
    this.levels = lv;
    this.chunks = new Map();
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
    return this;
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
    return this;
  }
  removeChunk(cx, cy, cz) {
    const key = this._key(cx, cy, cz), ch = this.chunks.get(key);
    if (!ch) return this;
    for (const m of ch.meshes) if (m) { m.dispose(); this.remove(m); }
    this.chunks.delete(key);
    return this;
  }
  clear() {
    for (const ch of [...this.chunks.values()]) this.removeChunk(ch.cx, ch.cy, ch.cz);
    this._pending.clear();
    return this;
  }
  // Libera los buffers de GPU de todos los chunks (la geometría y el material los gestionas tú).
  dispose() { return this.clear(); }

  // El renderer lo llama antes de recorrer los hijos: elige el nivel de detalle de cada chunk según la distancia.
  onBeforeRender(renderer, camera) {
    if (!camera) return;
    const ce = camera.matrixWorld.elements, e = this.matrixWorld.elements, gs = this.matrixWorld.getMaxScale();
    const lv = this.levels, last = lv.length - 1;
    for (const ch of this.chunks.values()) {
      const c = ch.center;
      const wx = e[0] * c.x + e[4] * c.y + e[8] * c.z + e[12], wy = e[1] * c.x + e[5] * c.y + e[9] * c.z + e[13], wz = e[2] * c.x + e[6] * c.y + e[10] * c.z + e[14];
      // distancia al punto más cercano del chunk: el detalle alto se usa si alguna parte está cerca
      const d = Math.max(0, Math.hypot(wx - ce[12], wy - ce[13], wz - ce[14]) - ch.radius * gs);
      let k = 0;
      for (let i = last; i > 0; i--) if (d >= lv[i].distance) { k = i; break; }
      for (let i = 0; i < ch.meshes.length; i++) {
        const m = ch.meshes[i];
        if (m) {
          m.visible = i === k;
          m.castShadow = this.castShadow;
          m.receiveShadow = this.receiveShadow;
        }
      }
    }
  }
}
