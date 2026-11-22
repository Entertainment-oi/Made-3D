import { Object3D } from '../core/Object3D.js';
import { Vec3 } from '../math/Vec3.js';

/**
 * Hueso de un esqueleto. Es un Object3D normal, pero marcado con `isBone` para que el picking,
 * el gizmo y las animaciones lo reconozcan.
 *
 * La "cabeza" del hueso es su origen; el "final" es la cabeza de su primer hijo (o, si no tiene
 * hijos, `length` unidades hacia su eje Y local).
 */
export class Bone extends Object3D {
  constructor() {
    super();
    this.isBone = true;
    this.length = 0;   // longitud del hueso cuando no tiene hijos (en unidades locales)
  }
  // Final del hueso en coordenadas del mundo.
  getWorldTail(target = new Vec3()) {
    for (const c of this.children) {
      if (c.isBone) return target.setFromMatrixPosition(c.matrixWorld);
    }
    if (this.length) return target.set(0, this.length, 0).applyMatrix4(this.matrixWorld);
    return target.setFromMatrixPosition(this.matrixWorld);
  }
  // El hueso y sus descendientes.
  getBoneTree() {
    const out = [];
    const walk = (b) => { out.push(b); for (const c of b.children) if (c.isBone) walk(c); };
    walk(this);
    return out;
  }
  copy(source, recursive = true) {
    super.copy(source, recursive);
    this.length = source.length ?? 0;
    return this;
  }
}
