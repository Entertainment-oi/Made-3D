import { Object3D } from '../core/Object3D.js';
import { intersectGeometry } from '../core/raycast.js';

export class Mesh extends Object3D {
  constructor(geometry, material) {
    super();
    this.isMesh = true;
    this.geometry = geometry;
    this.material = material;
    this.frustumCulled = true; // no se dibuja si la cámara no lo ve
    this.renderOrder = 0;
  }
  // Esfera envolvente en coordenadas del mundo: devuelve el radio y deja el centro en `target`.
  getWorldSphere(target) {
    const bs = this.geometry && this.geometry.getBoundingSphere();
    if (!bs) { target.setFromMatrixPosition(this.matrixWorld); return 0; }
    target.copy(bs.center).applyMatrix4(this.matrixWorld);
    return bs.radius * this.matrixWorld.getMaxScale();
  }

  /**
   * Intersección del rayo con la malla (contra los triángulos de verdad, no contra la esfera).
   * Añade a `intersects` un objeto por triángulo impactado:
   * { object, distance, point (mundo), normal (mundo), face: { a, b, c, normal (local) }, faceIndex, uv }
   */
  raycast(raycaster, intersects) {
    const mat = this.material;
    if (mat && mat.visible === false) return;
    if (this.userData && this.userData.pickable === false) return;
    intersectGeometry(raycaster, intersects, this.geometry, this.matrixWorld, this);
  }
}
