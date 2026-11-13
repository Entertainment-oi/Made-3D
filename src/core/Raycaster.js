import { Vec3 } from '../math/Vec3.js';
import { Mat4 } from '../math/Mat4.js';

const _inv = new Mat4(), _a = new Vec3(), _b = new Vec3();
const byDistance = (a, b) => a.distance - b.distance;

/**
 * Rayo de picking. Construye el rayo desde la cámara (o a mano) y lo lanza contra la escena.
 * Cada objeto sabe cómo se intersecta: si tiene método `raycast(raycaster, intersects)` se usa ese,
 * así que puedes añadir objetos propios al picking sin tocar la librería.
 *
 *   const ray = new Raycaster();
 *   ray.setFromCamera({ x: 0, y: 0 }, camera);        // NDC: -1..1, y hacia arriba
 *   const hits = ray.intersectObject(scene, true);     // de cerca a lejos
 */
export class Raycaster {
  constructor() {
    this.ray = { origin: new Vec3(), direction: new Vec3(0, 0, -1) };
    this.near = 0;          // distancia mínima (unidades del mundo)
    this.far = Infinity;    // distancia máxima
    this.camera = null;
  }

  // Rayo desde la cámara. `ndc` en coordenadas normalizadas (-1..1, y hacia arriba).
  setFromCamera(ndc, camera) {
    _inv.copyInverse(camera.projectionMatrix);
    _a.set(ndc.x, ndc.y, -1).applyMatrix4(_inv).applyMatrix4(camera.matrixWorld);
    _b.set(ndc.x, ndc.y, 1).applyMatrix4(_inv).applyMatrix4(camera.matrixWorld);
    if (camera.fov !== undefined) this.ray.origin.setFromMatrixPosition(camera.matrixWorld);
    else this.ray.origin.copy(_a);
    this.ray.direction.copy(_b).sub(_a).normalize();
    this.camera = camera;
    return this;
  }

  // Rayo con origen y dirección explícitos (la dirección se normaliza).
  set(origin, direction) {
    this.ray.origin.copy(origin);
    this.ray.direction.copy(direction).normalize();
    return this;
  }

  // Punto a distancia `t` del origen del rayo.
  at(t, target = new Vec3()) {
    const r = this.ray;
    return target.set(r.origin.x + r.direction.x * t, r.origin.y + r.direction.y * t, r.origin.z + r.direction.z * t);
  }

  // Distancia del origen del rayo al punto `p` (a lo largo del rayo).
  distanceToPoint(p) {
    const r = this.ray;
    return (p.x - r.origin.x) * r.direction.x + (p.y - r.origin.y) * r.direction.y + (p.z - r.origin.z) * r.direction.z;
  }

  // Intersecta con un objeto y sus hijos. Devuelve los impactos ordenados de cerca a lejos.
  intersectObject(object, recursive = true, intersects = []) {
    if (!object) return intersects;
    object.updateWorldMatrix(true, recursive);
    this._intersect(object, intersects, recursive);
    intersects.sort(byDistance);
    return intersects;
  }

  // Igual, pero con varios objetos sueltos.
  intersectObjects(objects, recursive = true, intersects = []) {
    for (const o of objects) {
      if (!o) continue;
      o.updateWorldMatrix(true, recursive);
      this._intersect(o, intersects, recursive);
    }
    intersects.sort(byDistance);
    return intersects;
  }

  _intersect(object, intersects, recursive) {
    if (!object.visible) return;
    if (object.userData && object.userData.pickable === false) return;
    if (object.raycast) object.raycast(this, intersects);
    if (recursive) for (const c of object.children) this._intersect(c, intersects, recursive);
  }
}
