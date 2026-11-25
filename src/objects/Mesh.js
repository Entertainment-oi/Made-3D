import { Object3D } from '../core/Object3D.js';
import { Vec3 } from '../math/Vec3.js';
import { intersectGeometry, raySphere } from '../core/raycast.js';

const _sphereCenter = new Vec3();

export class Mesh extends Object3D {
  constructor(geometry, material) {
    super();
    this.isMesh = true;
    this.geometry = geometry;
    this.material = material;
    this.morphTargetInfluences = [];
    this.morphTargetDictionary = {};
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
   * Intersección del rayo con la malla (descarte O(1) con la esfera envolvente antes de probar triángulos).
   * Añade a `intersects` un objeto por triángulo impactado:
   * { object, distance, point (mundo), normal (mundo), face: { a, b, c, normal (local) }, faceIndex, uv }
   */
  raycast(raycaster, intersects) {
    const mat = this.material;
    if (Array.isArray(mat) ? mat.length > 0 && mat.every((m) => m && m.visible === false) : (mat && mat.visible === false)) return;
    if (this.isPickable ? !this.isPickable() : (this.userData && this.userData.pickable === false)) return;
    if (!this.geometry || !this.geometry.attributes.position) return;

    const r = this.getWorldSphere(_sphereCenter);
    const ray = raycaster.ray;
    if (r > 0 && raySphere(ray.origin.x, ray.origin.y, ray.origin.z, ray.direction.x, ray.direction.y, ray.direction.z,
      _sphereCenter.x, _sphereCenter.y, _sphereCenter.z, r + 1e-4) === null) {
      return;
    }

    intersectGeometry(raycaster, intersects, this.geometry, this.matrixWorld, this);
  }
  copy(source, recursive = true) {
    super.copy(source, recursive);
    this.geometry = source.geometry;
    this.material = source.material;
    this.frustumCulled = source.frustumCulled;
    this.renderOrder = source.renderOrder;
    if (source.drawMode !== undefined) this.drawMode = source.drawMode;
    this.morphTargetInfluences = Array.isArray(source.morphTargetInfluences)
      ? source.morphTargetInfluences.slice()
      : [];
    this.morphTargetDictionary = source.morphTargetDictionary
      ? { ...source.morphTargetDictionary }
      : {};
    return this;
  }
}
