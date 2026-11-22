import { EventEmitter } from '../core/EventEmitter.js';
import { Mat4 } from '../math/Mat4.js';
import { Vec3 } from '../math/Vec3.js';

const _m = new Mat4();

/**
 * Esqueleto: la lista de huesos y las matrices que lleva cada uno desde la pose de unión
 * hasta la pose actual.
 *
 *   boneMatrix[i] = bones[i].matrixWorld * boneInverses[i]
 *
 * `boneInverses` se captura al crear el esqueleto (la pose en la que se ligaron los huesos);
 * si no se pasan, se calculan con la pose actual.
 *
 * Con el skinning en la GPU, `boneMatrices` se sube tal cual como una textura de 4 × n texels
 * (una fila por hueso), así que varias mallas pueden compartir un esqueleto sin repetir trabajo.
 */
export class Skeleton extends EventEmitter {
  constructor(bones = [], boneInverses = null) {
    super();
    this.isSkeleton = true;
    this.bones = bones;
    this.boneInverses = boneInverses ? boneInverses.slice() : [];
    this.autoInverses = false;   // true si las inversas se calcularon solas (se recalculan al ligar)
    this.boneMatrices = new Float32Array(bones.length * 16);
    this.version = 0;            // sube con cada update(): el renderer sube la textura de huesos solo si cambió
    this._frame = -1;
    // Esfera (en el mundo) que envuelve las posiciones de los huesos: sirve para el culling de las
    // mallas con skinning en la GPU, cuyos vértices no están donde dice la geometría.
    this.center = new Vec3();
    this.radius = 0;
    this.maxScale = 1;           // mayor escala relativa a la pose de unión
    if (this.boneInverses.length !== bones.length) { this.calculateInverses(); this.autoInverses = true; }
    this.update();
  }

  get count() { return this.bones.length; }

  // Captura la pose actual como pose de unión.
  calculateInverses() {
    this.boneInverses = this.bones.map((b) => new Mat4().copyInverse(b.matrixWorld));
    return this;
  }

  // Recalcula las matrices de los huesos (llámalo tras moverlos).
  update() {
    const n = this.bones.length;
    if (this.boneMatrices.length !== n * 16) this.boneMatrices = new Float32Array(n * 16);
    const bm = this.boneMatrices;
    let cx = 0, cy = 0, cz = 0, ms = 0;
    for (let i = 0; i < n; i++) {
      const we = this.bones[i].matrixWorld.elements;
      _m.multiplyMatrices(this.bones[i].matrixWorld, this.boneInverses[i]);
      bm.set(_m.elements, i * 16);
      cx += we[12]; cy += we[13]; cz += we[14];
      const o = i * 16;
      const s = Math.max(bm[o] * bm[o] + bm[o + 1] * bm[o + 1] + bm[o + 2] * bm[o + 2],
        bm[o + 4] * bm[o + 4] + bm[o + 5] * bm[o + 5] + bm[o + 6] * bm[o + 6],
        bm[o + 8] * bm[o + 8] + bm[o + 9] * bm[o + 9] + bm[o + 10] * bm[o + 10]);
      if (s > ms) ms = s;
    }
    if (n) {
      cx /= n; cy /= n; cz /= n;
      let r = 0;
      for (let i = 0; i < n; i++) {
        const we = this.bones[i].matrixWorld.elements;
        const d = Math.hypot(we[12] - cx, we[13] - cy, we[14] - cz);
        if (d > r) r = d;
      }
      this.center.set(cx, cy, cz); this.radius = r; this.maxScale = Math.sqrt(ms) || 1;
    } else {
      this.center.set(0, 0, 0); this.radius = 0; this.maxScale = 1;
    }
    this.version++;
    return this;
  }

  // update() como mucho una vez por cuadro (varias mallas pueden compartir el esqueleto).
  updateOnce(frame) {
    if (this._frame !== frame) { this._frame = frame; this.update(); }
    return this;
  }

  getBoneByName(name) {
    for (const b of this.bones) if (b.name === name) return b;
    return null;
  }

  // Crea un parche reversible para eliminar un conjunto de huesos y remapear los pesos de las mallas.
  createBoneRemovalPatch(bonesToRemove, meshes = []) {
    const removeSet = bonesToRemove instanceof Set
      ? bonesToRemove
      : (bonesToRemove && (bonesToRemove.isBone || bonesToRemove.isObject3D))
        ? new Set([bonesToRemove])
        : new Set(bonesToRemove || []);
    const beforeBones = this.bones.slice();
    const beforeInverses = this.boneInverses.slice();
    const beforeAutoInverses = Boolean(this.autoInverses);
    const afterAutoInverses = beforeAutoInverses;

    const oldIndexMap = new Map();
    const oldToNew = new Int32Array(beforeBones.length).fill(-1);
    const afterBones = [];
    const afterInverses = [];

    for (let i = 0; i < beforeBones.length; i++) {
      oldIndexMap.set(beforeBones[i], i);
      if (!removeSet.has(beforeBones[i])) {
        oldToNew[i] = afterBones.length;
        afterBones.push(beforeBones[i]);
        afterInverses.push(beforeInverses[i]);
      }
    }

    const fallbackNew = new Int32Array(beforeBones.length).fill(-1);
    for (let i = 0; i < beforeBones.length; i++) {
      if (oldToNew[i] >= 0) continue;
      let p = beforeBones[i].parent;
      while (p && p.isBone) {
        const pOld = oldIndexMap.get(p);
        if (pOld !== undefined && oldToNew[pOld] >= 0) {
          fallbackNew[i] = oldToNew[pOld];
          break;
        }
        p = p.parent;
      }
    }

    const meshList = Array.isArray(meshes) ? meshes : [];
    const geoPatches = [];
    const seenGeo = new Set();
    const idxs = new Int32Array(4);
    const wts = new Float32Array(4);

    for (const mesh of meshList) {
      const geo = mesh && mesh.geometry;
      if (!geo || seenGeo.has(geo)) continue;
      seenGeo.add(geo);
      const si = geo.attributes && geo.attributes.skinIndex;
      const sw = geo.attributes && geo.attributes.skinWeight;
      if (!si || !sw) continue;

      const beforeIndex = si.array.slice();
      const beforeWeight = sw.array.slice();
      const afterIndex = beforeIndex.slice();
      const afterWeight = beforeWeight.slice();
      const count = si.count;

      for (let v = 0; v < count; v++) {
        const base = v * 4;
        let anyRemoved = false;
        let prevSum = 0;
        let outN = 0;
        for (let j = 0; j < 4; j++) {
          const w = beforeWeight[base + j];
          const rawBi = Math.round(beforeIndex[base + j]) | 0;
          if (w <= 0) continue;
          prevSum += w;
          const direct = rawBi >= 0 && rawBi < oldToNew.length ? oldToNew[rawBi] : -1;
          let mapped = direct;
          if (direct < 0) {
            anyRemoved = true;
            mapped = rawBi >= 0 && rawBi < fallbackNew.length ? fallbackNew[rawBi] : -1;
          }
          if (mapped >= 0) {
            let merged = false;
            for (let k = 0; k < outN; k++) {
              if (idxs[k] === mapped) {
                wts[k] += w;
                merged = true;
                break;
              }
            }
            if (!merged && outN < 4) {
              idxs[outN] = mapped;
              wts[outN] = w;
              outN++;
            }
          }
        }

        if (!anyRemoved) {
          for (let j = 0; j < 4; j++) {
            if (beforeWeight[base + j] > 0) {
              const rawBi = Math.round(beforeIndex[base + j]) | 0;
              afterIndex[base + j] = rawBi >= 0 && rawBi < oldToNew.length ? Math.max(0, oldToNew[rawBi]) : 0;
            }
          }
          continue;
        }

        let newSum = 0;
        for (let k = 0; k < outN; k++) newSum += wts[k];
        if (newSum > 1e-6) {
          const scale = prevSum > 1e-6 ? prevSum / newSum : 1 / newSum;
          for (let j = 0; j < 4; j++) {
            if (j < outN) {
              afterIndex[base + j] = idxs[j];
              afterWeight[base + j] = wts[j] * scale;
            } else {
              afterIndex[base + j] = 0;
              afterWeight[base + j] = 0;
            }
          }
        } else {
          for (let j = 0; j < 4; j++) {
            afterIndex[base + j] = 0;
            afterWeight[base + j] = 0;
          }
        }
      }

      geoPatches.push({ geo, beforeIndex, beforeWeight, afterIndex, afterWeight });
    }

    return {
      skeleton: this,
      meshes: meshList.slice(),
      beforeBones,
      beforeInverses,
      beforeAutoInverses,
      afterBones,
      afterInverses,
      afterAutoInverses,
      geoPatches,
      removedCount: beforeBones.length - afterBones.length,
    };
  }

  static applyBonePatch(patch, useAfter = true) {
    if (!patch || !patch.skeleton) return;
    const sk = patch.skeleton;
    sk.bones = (useAfter ? patch.afterBones : patch.beforeBones).slice();
    sk.boneInverses = (useAfter ? patch.afterInverses : patch.beforeInverses).slice();
    sk.boneMatrices = new Float32Array(sk.bones.length * 16);
    sk.autoInverses = useAfter ? patch.afterAutoInverses : patch.beforeAutoInverses;

    for (const gp of patch.geoPatches) {
      const si = gp.geo.attributes.skinIndex;
      const sw = gp.geo.attributes.skinWeight;
      if (si) {
        si.array.set(useAfter ? gp.afterIndex : gp.beforeIndex);
        si.needsUpdate = true;
      }
      if (sw) {
        sw.array.set(useAfter ? gp.afterWeight : gp.beforeWeight);
        sw.needsUpdate = true;
      }
    }

    for (const b of sk.bones) b.updateWorldMatrix(true, false);
    sk.update();

    for (const mesh of patch.meshes) {
      if (mesh && typeof mesh.refreshSkinning === 'function') {
        mesh.refreshSkinning();
      }
    }
  }

  removeBones(bonesToRemove, meshes = []) {
    const patch = this.createBoneRemovalPatch(bonesToRemove, meshes);
    Skeleton.applyBonePatch(patch, true);
    return patch;
  }

  static collectRemovalPatches(scene, removedRoot) {
    if (!removedRoot || !scene || !scene.traverse) return [];
    const removedBones = new Set();
    if (removedRoot.traverse) {
      removedRoot.traverse((n) => {
        if (n.isBone) removedBones.add(n);
      });
    } else if (removedRoot.isBone) {
      removedBones.add(removedRoot);
    }
    if (!removedBones.size) return [];

    const bySkel = new Map();
    scene.traverse((n) => {
      if (!n.isSkinnedMesh || !n.skeleton || !n.skeleton.bones) return;
      const sk = n.skeleton;
      if (!sk.bones.some((b) => removedBones.has(b))) return;
      let entry = bySkel.get(sk);
      if (!entry) {
        entry = { skeleton: sk, meshes: [] };
        bySkel.set(sk, entry);
      }
      entry.meshes.push(n);
    });

    const patches = [];
    for (const { skeleton: sk, meshes } of bySkel.values()) {
      const patch = sk.createBoneRemovalPatch(removedBones, meshes);
      if (patch) patches.push(patch);
    }
    return patches;
  }

  // Libera la textura de huesos de la GPU.
  dispose() { this.emit('dispose'); }
}
