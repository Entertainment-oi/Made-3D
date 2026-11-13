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

  // Libera la textura de huesos de la GPU.
  dispose() { this.emit('dispose'); }
}
