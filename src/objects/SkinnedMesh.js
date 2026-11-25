import { Mesh } from './Mesh.js';
import { Mat4 } from '../math/Mat4.js';
import { Vec3 } from '../math/Vec3.js';
import { intersectGeometry, raySphere } from '../core/raycast.js';

const _m = new Mat4();

/**
 * Malla deformada por un esqueleto.
 *
 * La geometría guarda los pesos y los índices de hueso (`skinIndex` y `skinWeight`, 4 componentes)
 * y el esqueleto guarda la pose de unión. El deformado es "linear blend skinning" en la CPU:
 *
 *   mundo(v) = Σ w_i · boneMatrix[i] · (bindMatrix · v)
 *
 * Por defecto el deformado se hace en la GPU (`gpuSkinning = true`): el vertex shader lee las matrices
 * de los huesos de una textura y la geometría se queda en la pose de unión, así que puedes usar la misma
 * geometría en cientos de personajes (cada uno con su propio esqueleto). Con `gpuSkinning = false` se
 * deforma en la CPU y el resultado se escribe en la propia geometría (`updateSkinnedVertices()`); el
 * renderer lo hace solo si `autoUpdateSkin`. El picking siempre usa la malla deformada.
 *
 *   const mesh = new SkinnedMesh(geo, mat);
 *   mesh.bind(new Skeleton([huesoRaiz, huesoHijo]));
 *   geo.setAttribute('skinIndex', indices, 4);
 *   geo.setAttribute('skinWeight', pesos, 4);
 */
export class SkinnedMesh extends Mesh {
  constructor(geometry, material) {
    super(geometry, material);
    this.isSkinnedMesh = true;
    this.skeleton = null;
    this.bindMatrix = new Mat4();          // espacio de la geometría → espacio de unión
    this.bindMatrixInverse = new Mat4();
    this.autoUpdateSkin = true;            // (solo con skinning en CPU) el renderer recalcula los vértices antes de dibujar
    this._gpu = true;
    this.skinPad = 0;                      // distancia máxima de un vértice a sus huesos en la pose de unión
    this._world = null;                    // posiciones deformadas (mundo)
    this._bind = null;                     // copia de las posiciones en la pose de unión
    this._bindNormal = null;               // copia de las normales en la pose de unión
  }

  // true (por defecto): los vértices se deforman en la GPU y la geometría no se toca, así que varias
  // mallas pueden compartirla. false: se deforman en la CPU y se escriben en la geometría.
  get gpuSkinning() { return this._gpu; }
  set gpuSkinning(v) {
    v = !!v;
    if (v === this._gpu) return;
    if (!v) {
      const p = this.geometry && this.geometry.attributes.position;
      const n = this.geometry && this.geometry.attributes.normal;
      if (p && !this._bind) this._bind = Float32Array.from(p.array);
      if (n && !this._bindNormal) this._bindNormal = Float32Array.from(n.array);
    } else {
      this.restoreBindPose();
    }
    this._gpu = v;
  }

  // Liga la malla a un esqueleto. `bindMatrix` es la transformación de la malla en el momento
  // de la unión (por defecto, la identidad). `skinPad` (opcional) evita recalcular la distancia máxima
  // de los vértices a sus huesos cuando ya se conoce.
  bind(skeleton, bindMatrix = null, skinPad = null) {
    this.skeleton = skeleton;
    if (bindMatrix) this.bindMatrix.copy(bindMatrix); else this.bindMatrix.identity();
    this.bindMatrixInverse.copyInverse(this.bindMatrix);
    // La pose de unión se captura con la posición actual de los huesos: hay que tener sus
    // matrices al día (por eso se actualizan aquí).
    for (const b of skeleton.bones) b.updateWorldMatrix(true, false);
    if (skeleton.autoInverses || !skeleton.boneInverses.length) skeleton.calculateInverses();
    const p = this.geometry && this.geometry.attributes ? this.geometry.attributes.position : null;
    const n = this.geometry && this.geometry.attributes ? this.geometry.attributes.normal : null;
    if (p && !this._gpu) this._bind = Float32Array.from(p.array);   // se guarda la pose de unión (solo la CPU la necesita)
    if (n && !this._gpu) this._bindNormal = Float32Array.from(n.array);
    if (skinPad === null) this.computeSkinPad(); else this.skinPad = skinPad;   // (al clonar se reutiliza el valor de la malla original)
    return this;
  }

  invalidateSkinCache() {
    this._worldVersion = -1;
    this._worldPosAttr = null;
    return this;
  }

  refreshSkinning() {
    this.computeSkinPad();
    this._worldVersion = -1;
    this._worldPosAttr = null;
    if (!this._gpu) this.updateSkinnedVertices();
    return this;
  }

  setGeometry(geometry) {
    this.geometry = geometry;
    this._worldVersion = -1;
    this._worldPosAttr = null;
    if (!this._gpu && geometry && geometry.attributes && geometry.attributes.position) {
      this._bind = Float32Array.from(geometry.attributes.position.array);
      this._bindNormal = geometry.attributes.normal
        ? Float32Array.from(geometry.attributes.normal.array)
        : null;
      this.updateSkinnedVertices();
    } else {
      this._bind = null;
      this._bindNormal = null;
    }
    if (this.skeleton) this.computeSkinPad();
    return this;
  }

  // Distancia máxima de un vértice a los huesos que lo mueven (en la pose de unión). El renderer la usa
  // para saber hasta dónde llega la malla desde sus huesos y descartarla con la cámara sin deformarla.
  _computeSkinPad() {
    return this.computeSkinPad();
  }

  computeSkinPad() {
    this.skinPad = 0;
    const geo = this.geometry, sk = this.skeleton;
    if (!geo || !geo.attributes || !sk || !sk.bones || !sk.bones.length) return;
    const si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight, pos = geo.attributes.position;
    if (!si || !sw || !pos) return;
    const src = this._bind || pos.array;
    const n = Math.min(pos.count, (si.array.length / 4) | 0, (sw.array.length / 4) | 0);
    const be = this.bindMatrix.elements;
    const bp = new Float32Array(sk.bones.length * 3);
    for (let i = 0; i < sk.bones.length; i++) {
      const inv = sk.boneInverses[i];
      if (!inv) continue;
      _m.copyInverse(inv);
      bp[i * 3] = _m.elements[12]; bp[i * 3 + 1] = _m.elements[13]; bp[i * 3 + 2] = _m.elements[14];
    }
    let max = 0;
    for (let i = 0; i < n; i++) {
      const lx = src[i * 3], ly = src[i * 3 + 1], lz = src[i * 3 + 2];
      const x = be[0] * lx + be[4] * ly + be[8] * lz + be[12];
      const y = be[1] * lx + be[5] * ly + be[9] * lz + be[13];
      const z = be[2] * lx + be[6] * ly + be[10] * lz + be[14];
      for (let j = 0; j < 4; j++) {
        if (!sw.array[i * 4 + j]) continue;
        const bi = Math.round(si.array[i * 4 + j]) | 0;
        if (bi < 0 || bi >= sk.bones.length) continue;
        const b = bi * 3;
        const d = Math.hypot(x - bp[b], y - bp[b + 1], z - bp[b + 2]);
        if (d > max) max = d;
      }
    }
    this.skinPad = max;
  }

  // Posición deformada del vértice `index` en el espacio del mundo.
  skinnedWorld(index, target = new Vec3()) {
    const geo = this.geometry;
    const posAttr = geo && geo.attributes ? geo.attributes.position : null;
    const src = this._bind || (posAttr ? posAttr.array : null);
    if (!src || index < 0 || index * 3 + 2 >= src.length) return target.set(0, 0, 0);
    const si = geo.attributes.skinIndex ? geo.attributes.skinIndex.array : null;
    const sw = geo.attributes.skinWeight ? geo.attributes.skinWeight.array : null;
    const lx = src[index * 3], ly = src[index * 3 + 1], lz = src[index * 3 + 2];
    const be = this.bindMatrix.elements;                       // geometría → espacio de unión
    const bx = be[0] * lx + be[4] * ly + be[8] * lz + be[12];
    const by = be[1] * lx + be[5] * ly + be[9] * lz + be[13];
    const bz = be[2] * lx + be[6] * ly + be[10] * lz + be[14];
    const bm = this.skeleton ? this.skeleton.boneMatrices : null;
    const nBones = bm ? (bm.length / 16) | 0 : 0;
    if (!bm || !si || !sw || index * 4 + 3 >= si.length || index * 4 + 3 >= sw.length) {
      return target.set(bx, by, bz);
    }
    let ox = 0, oy = 0, oz = 0, applied = 0;
    for (let j = 0; j < 4; j++) {
      const w = sw[index * 4 + j];
      if (!w) continue;
      const bi = Math.round(si[index * 4 + j]) | 0;
      if (bi < 0 || bi >= nBones) continue;
      const o = bi * 16;
      ox += (bm[o] * bx + bm[o + 4] * by + bm[o + 8] * bz + bm[o + 12]) * w;
      oy += (bm[o + 1] * bx + bm[o + 5] * by + bm[o + 9] * bz + bm[o + 13]) * w;
      oz += (bm[o + 2] * bx + bm[o + 6] * by + bm[o + 10] * bz + bm[o + 14]) * w;
      applied += w;
    }
    return applied > 0 ? target.set(ox, oy, oz) : target.set(bx, by, bz);
  }

  // Rellena `out` (Float32Array) con las posiciones deformadas de todos los vértices, en el mundo.
  computeSkinnedWorld(out, count) {
    const geo = this.geometry;
    const posAttr = geo && geo.attributes ? geo.attributes.position : null;
    const src = this._bind || (posAttr ? posAttr.array : null);
    if (!src || !out) return out;
    const si = geo.attributes.skinIndex ? geo.attributes.skinIndex.array : null;
    const sw = geo.attributes.skinWeight ? geo.attributes.skinWeight.array : null;
    const maxV = Math.min(count, (src.length / 3) | 0, (out.length / 3) | 0);
    const skinnedLen = si && sw ? Math.min((si.length / 4) | 0, (sw.length / 4) | 0) : 0;
    const be = this.bindMatrix.elements;
    const bm = this.skeleton ? this.skeleton.boneMatrices : null;
    const nBones = bm ? (bm.length / 16) | 0 : 0;
    for (let i = 0; i < maxV; i++) {
      const lx = src[i * 3], ly = src[i * 3 + 1], lz = src[i * 3 + 2];
      // geometría → espacio de unión
      const bx = be[0] * lx + be[4] * ly + be[8] * lz + be[12];
      const by = be[1] * lx + be[5] * ly + be[9] * lz + be[13];
      const bz = be[2] * lx + be[6] * ly + be[10] * lz + be[14];
      if (!bm || !si || !sw || i >= skinnedLen) { out[i * 3] = bx; out[i * 3 + 1] = by; out[i * 3 + 2] = bz; continue; }
      let ox = 0, oy = 0, oz = 0, applied = 0;
      for (let j = 0; j < 4; j++) {
        const w = sw[i * 4 + j];
        if (!w) continue;
        const bi = Math.round(si[i * 4 + j]) | 0;
        if (bi < 0 || bi >= nBones) continue;
        const o = bi * 16;
        ox += (bm[o] * bx + bm[o + 4] * by + bm[o + 8] * bz + bm[o + 12]) * w;
        oy += (bm[o + 1] * bx + bm[o + 5] * by + bm[o + 9] * bz + bm[o + 13]) * w;
        oz += (bm[o + 2] * bx + bm[o + 6] * by + bm[o + 10] * bz + bm[o + 14]) * w;
        applied += w;
      }
      if (applied > 0) { out[i * 3] = ox; out[i * 3 + 1] = oy; out[i * 3 + 2] = oz; }
      else { out[i * 3] = bx; out[i * 3 + 1] = by; out[i * 3 + 2] = bz; }
    }
    return out;
  }

  // Rellena `out` (Float32Array) con las normales deformadas de todos los vértices, en el mundo.
  computeSkinnedWorldNormals(out, count) {
    const geo = this.geometry;
    const norAttr = geo && geo.attributes ? geo.attributes.normal : null;
    const nSrc = this._bindNormal || (norAttr ? norAttr.array : null);
    if (!nSrc || !out) return out;
    const si = geo.attributes.skinIndex ? geo.attributes.skinIndex.array : null;
    const sw = geo.attributes.skinWeight ? geo.attributes.skinWeight.array : null;
    const maxV = Math.min(count, (nSrc.length / 3) | 0, (out.length / 3) | 0);
    const skinnedLen = si && sw ? Math.min((si.length / 4) | 0, (sw.length / 4) | 0) : 0;
    const be = this.bindMatrix.elements;
    const bm = this.skeleton ? this.skeleton.boneMatrices : null;
    const nBones = bm ? (bm.length / 16) | 0 : 0;
    for (let i = 0; i < maxV; i++) {
      let m00 = 0, m10 = 0, m20 = 0, m01 = 0, m11 = 0, m21 = 0, m02 = 0, m12 = 0, m22 = 0;
      let applied = 0;
      if (bm && si && sw && i < skinnedLen) {
        for (let j = 0; j < 4; j++) {
          const w = sw[i * 4 + j];
          if (!w) continue;
          const bi = Math.round(si[i * 4 + j]) | 0;
          if (bi < 0 || bi >= nBones) continue;
          const o = bi * 16;
          m00 += bm[o] * w; m10 += bm[o + 1] * w; m20 += bm[o + 2] * w;
          m01 += bm[o + 4] * w; m11 += bm[o + 5] * w; m21 += bm[o + 6] * w;
          m02 += bm[o + 8] * w; m12 += bm[o + 9] * w; m22 += bm[o + 10] * w;
          applied += w;
        }
      }
      if (!(applied > 0)) { m00 = m11 = m22 = 1; }
      const s00 = m00 * be[0] + m01 * be[1] + m02 * be[2];
      const s10 = m10 * be[0] + m11 * be[1] + m12 * be[2];
      const s20 = m20 * be[0] + m21 * be[1] + m22 * be[2];
      const s01 = m00 * be[4] + m01 * be[5] + m02 * be[6];
      const s11 = m10 * be[4] + m11 * be[5] + m12 * be[6];
      const s21 = m20 * be[4] + m21 * be[5] + m22 * be[6];
      const s02 = m00 * be[8] + m01 * be[9] + m02 * be[10];
      const s12 = m10 * be[8] + m11 * be[9] + m12 * be[10];
      const s22 = m20 * be[8] + m21 * be[9] + m22 * be[10];
      const c00 = s11 * s22 - s21 * s12, c10 = -(s01 * s22 - s21 * s02), c20 = s01 * s12 - s11 * s02;
      const c01 = -(s10 * s22 - s20 * s12), c11 = s00 * s22 - s20 * s02, c21 = -(s00 * s12 - s10 * s02);
      const c02 = s10 * s21 - s20 * s11, c12 = -(s00 * s21 - s20 * s01), c22 = s00 * s11 - s10 * s01;
      const det = s00 * c00 + s10 * c10 + s20 * c20;
      const inv = Math.abs(det) > 1e-20 ? 1 / det : 1;
      const nx = nSrc[i * 3], ny = nSrc[i * 3 + 1], nz = nSrc[i * 3 + 2];
      const wx = (c00 * nx + c01 * ny + c02 * nz) * inv;
      const wy = (c10 * nx + c11 * ny + c12 * nz) * inv;
      const wz = (c20 * nx + c21 * ny + c22 * nz) * inv;
      const l = Math.hypot(wx, wy, wz) || 1;
      out[i * 3] = wx / l; out[i * 3 + 1] = wy / l; out[i * 3 + 2] = wz / l;
    }
    return out;
  }

  // Escribe las posiciones (y normales) deformadas en la geometría (solo para el skinning en CPU) y devuelve true si cambió algo.
  updateSkinnedVertices() {
    const geo = this.geometry;
    const pos = geo && geo.attributes ? geo.attributes.position : null;
    if (!pos || !this.skeleton) return false;
    if (!this._bind) this._bind = Float32Array.from(pos.array);   // con skinning en GPU la geometría sigue en la pose de unión: se guarda antes de sobrescribirla
    const nor = geo.attributes.normal;
    if (nor && !this._bindNormal) this._bindNormal = Float32Array.from(nor.array);
    const n = pos.count;
    if (!this._world || this._world.length < n * 3) this._world = new Float32Array(n * 3);
    this.computeSkinnedWorld(this._world, n);
    // del mundo al espacio local de la malla (el renderer aplica su matrixWorld)
    _m.copyInverse(this.matrixWorld);
    const e = _m.elements, arr = pos.array;
    for (let i = 0; i < n; i++) {
      const x = this._world[i * 3], y = this._world[i * 3 + 1], z = this._world[i * 3 + 2];
      arr[i * 3] = e[0] * x + e[4] * y + e[8] * z + e[12];
      arr[i * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
      arr[i * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    }
    pos.needsUpdate = true;

    if (nor && this._bindNormal) {
      const si = geo.attributes.skinIndex ? geo.attributes.skinIndex.array : null;
      const sw = geo.attributes.skinWeight ? geo.attributes.skinWeight.array : null;
      const bm = this.skeleton.boneMatrices;
      const nBones = bm ? (bm.length / 16) | 0 : 0;
      const be = this.bindMatrix.elements;
      const mw = this.matrixWorld.elements;
      const nSrc = this._bindNormal, nDst = nor.array;
      for (let i = 0; i < n; i++) {
        let m00 = 0, m10 = 0, m20 = 0, m01 = 0, m11 = 0, m21 = 0, m02 = 0, m12 = 0, m22 = 0;
        let applied = 0;
        if (bm && si && sw) {
          for (let j = 0; j < 4; j++) {
            const w = sw[i * 4 + j];
            if (!w) continue;
            const bi = Math.round(si[i * 4 + j]) | 0;
            if (bi < 0 || bi >= nBones) continue;
            const o = bi * 16;
            m00 += bm[o] * w; m10 += bm[o + 1] * w; m20 += bm[o + 2] * w;
            m01 += bm[o + 4] * w; m11 += bm[o + 5] * w; m21 += bm[o + 6] * w;
            m02 += bm[o + 8] * w; m12 += bm[o + 9] * w; m22 += bm[o + 10] * w;
            applied += w;
          }
        }
        if (!(applied > 0)) { m00 = m11 = m22 = 1; }
        // skinMat3 * bindMatrix3
        const s00 = m00 * be[0] + m01 * be[1] + m02 * be[2];
        const s10 = m10 * be[0] + m11 * be[1] + m12 * be[2];
        const s20 = m20 * be[0] + m21 * be[1] + m22 * be[2];
        const s01 = m00 * be[4] + m01 * be[5] + m02 * be[6];
        const s11 = m10 * be[4] + m11 * be[5] + m12 * be[6];
        const s21 = m20 * be[4] + m21 * be[5] + m22 * be[6];
        const s02 = m00 * be[8] + m01 * be[9] + m02 * be[10];
        const s12 = m10 * be[8] + m11 * be[9] + m12 * be[10];
        const s22 = m20 * be[8] + m21 * be[9] + m22 * be[10];
        // cofator (inversa transpuesta sin dividir por det aún)
        const c00 = s11 * s22 - s21 * s12, c10 = -(s01 * s22 - s21 * s02), c20 = s01 * s12 - s11 * s02;
        const c01 = -(s10 * s22 - s20 * s12), c11 = s00 * s22 - s20 * s02, c21 = -(s00 * s12 - s10 * s02);
        const c02 = s10 * s21 - s20 * s11, c12 = -(s00 * s21 - s20 * s01), c22 = s00 * s11 - s10 * s01;
        const det = s00 * c00 + s10 * c10 + s20 * c20;
        const inv = Math.abs(det) > 1e-20 ? 1 / det : 1;
        const nx = nSrc[i * 3], ny = nSrc[i * 3 + 1], nz = nSrc[i * 3 + 2];
        const wx = (c00 * nx + c01 * ny + c02 * nz) * inv;
        const wy = (c10 * nx + c11 * ny + c12 * nz) * inv;
        const wz = (c20 * nx + c21 * ny + c22 * nz) * inv;
        // mundo → local de la malla: transpuesta de mat3(matrixWorld)
        let lx = mw[0] * wx + mw[1] * wy + mw[2] * wz;
        let ly = mw[4] * wx + mw[5] * wy + mw[6] * wz;
        let lz = mw[8] * wx + mw[9] * wy + mw[10] * wz;
        const l = Math.hypot(lx, ly, lz) || 1;
        nDst[i * 3] = lx / l; nDst[i * 3 + 1] = ly / l; nDst[i * 3 + 2] = lz / l;
      }
      nor.needsUpdate = true;
    }
    return true;
  }

  // Vuelve a la pose de unión (los vértices originales).
  restoreBindPose() {
    const attrs = this.geometry && this.geometry.attributes;
    if (!attrs) return this;
    const pos = attrs.position;
    if (pos && this._bind) {
      pos.array.set(this._bind);
      pos.needsUpdate = true;
    }
    const nor = attrs.normal;
    if (nor && this._bindNormal) {
      nor.array.set(this._bindNormal);
      nor.needsUpdate = true;
    }
    return this;
  }

  // Picking contra la malla deformada (con descarte previo por esfera del esqueleto y caché por pose).
  raycast(raycaster, intersects) {
    const mat = this.material;
    if (Array.isArray(mat) ? mat.length > 0 && mat.every((m) => m && m.visible === false) : (mat && mat.visible === false)) return;
    if (this.isPickable ? !this.isPickable() : (this.userData && this.userData.pickable === false)) return;
    const geo = this.geometry;
    if (!geo || !geo.attributes.position) return;
    const sk = this.skeleton;
    if (!sk || !sk.bones || !sk.bones.length) return super.raycast(raycaster, intersects);
    for (let i = 0; i < sk.bones.length; i++) if (sk.bones[i]) sk.bones[i].updateWorldMatrix(true, false);
    sk.update();
    const r = raycaster.ray;
    const boundR = sk.radius + this.skinPad * sk.maxScale;
    if (boundR > 0 && raySphere(r.origin.x, r.origin.y, r.origin.z, r.direction.x, r.direction.y, r.direction.z,
      sk.center.x, sk.center.y, sk.center.z, boundR + 1e-3) === null) {
      return;
    }
    const posAttr = geo.attributes.position;
    const n = posAttr.count;
    if (!this._world || this._world.length < n * 3) this._world = new Float32Array(n * 3);
    const be = this.bindMatrix.elements;
    let bindDirty = !this._worldBindMat;
    if (!bindDirty) {
      for (let i = 0; i < 16; i++) {
        if (this._worldBindMat[i] !== be[i]) { bindDirty = true; break; }
      }
    }
    if (
      bindDirty ||
      this._worldVersion !== sk.version ||
      this._worldCount !== n ||
      this._worldPosAttr !== posAttr ||
      this._worldPosVer !== posAttr.version
    ) {
      this.computeSkinnedWorld(this._world, n);
      this._worldVersion = sk.version;
      this._worldCount = n;
      this._worldPosAttr = posAttr;
      this._worldPosVer = posAttr.version;
      if (!this._worldBindMat) this._worldBindMat = new Float32Array(16);
      this._worldBindMat.set(be);
    }
    intersectGeometry(raycaster, intersects, geo, this.matrixWorld, this, null, this._world);
  }
  copy(source, recursive = true) {
    super.copy(source, recursive);
    this._gpu = source._gpu !== false;
    this.autoUpdateSkin = source.autoUpdateSkin !== false;
    this.skinPad = source.skinPad ?? 0;
    this.bindMatrix.copy(source.bindMatrix);
    this.bindMatrixInverse.copy(source.bindMatrixInverse);
    if (source.skeleton) {
      this.bind(source.skeleton, source.bindMatrix, source.skinPad);
    }
    this._bind = source._bind ? source._bind.slice() : (this._bind || null);
    this._bindNormal = source._bindNormal ? source._bindNormal.slice() : (this._bindNormal || null);
    return this;
  }
}
