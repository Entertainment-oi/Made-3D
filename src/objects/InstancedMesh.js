import { Mesh } from './Mesh.js';
import { BufferAttribute } from '../geometry/BufferAttribute.js';
import { Mat4 } from '../math/Mat4.js';
import { intersectGeometry, raySphere } from '../core/raycast.js';

const _m = new Mat4(), _im = new Mat4();

// Miles de copias de una misma geometría en una sola llamada de dibujo.
export class InstancedMesh extends Mesh {
  // `matrices` (opcional): BufferAttribute o Float32Array de count×16 ya preparado (se comparte, no se copia).
  constructor(geometry, material, count = 0, matrices = null) {
    super(geometry, material);
    this.isInstancedMesh = true;
    this.count = count; // instancias activas (≤ capacidad)
    if (matrices) this.instanceMatrix = matrices instanceof BufferAttribute ? matrices : new BufferAttribute(matrices, 16);
    else {
      const arr = new Float32Array(count * 16);
      for (let i = 0; i < count; i++) { arr[i * 16] = arr[i * 16 + 5] = arr[i * 16 + 10] = arr[i * 16 + 15] = 1; }
      this.instanceMatrix = new BufferAttribute(arr, 16);
    }
    this.cullInstances = true; // culling por instancia (CPU)
    // Si lo defines ({ center: Vec3, radius }, en espacio del mesh) se usa para descartar TODO el mesh de una vez.
    this.boundingSphere = null;
  }
  // Libera sus buffers de GPU (la geometría y el material no se tocan).
  dispose() { this.dispatchEvent({ type: 'dispose' }); }
  setMatrixAt(i, mat4) { this.instanceMatrix.array.set(mat4.elements, i * 16); }
  setTransformAt(i, position, quaternion, scale) {
    _m.compose(position, quaternion, scale);
    this.instanceMatrix.array.set(_m.elements, i * 16);
  }
  // Llamar tras modificar instancias para que se suban a la GPU.
  commit() { this.instanceMatrix.needsUpdate = true; }

  // Picking: prueba cada instancia (el impacto incluye `instanceId`).
  raycast(raycaster, intersects) {
    const mat = this.material;
    if (mat && mat.visible === false) return;
    if (this.isPickable ? !this.isPickable() : (this.userData && this.userData.pickable === false)) return;
    const geo = this.geometry;
    if (!geo || !geo.attributes.position) return;
    const bs = geo.getBoundingSphere();
    if (!bs) return;
    const attr = this.instanceMatrix, arr = attr.array;
    const total = Math.min(this.count, (arr.length / 16) | 0);
    const r = raycaster.ray;
    for (let i = 0; i < total; i++) {
      const o = i * 16;
      _im.elements.set(arr.subarray(o, o + 16));
      _im.multiplyMatrices(this.matrixWorld, _im);   // matriz de la instancia en el mundo
      const e = _im.elements;
      const cx = e[0] * bs.center.x + e[4] * bs.center.y + e[8] * bs.center.z + e[12];
      const cy = e[1] * bs.center.x + e[5] * bs.center.y + e[9] * bs.center.z + e[13];
      const cz = e[2] * bs.center.x + e[6] * bs.center.y + e[10] * bs.center.z + e[14];
      // prueba rápida con la esfera envolvente de la instancia
      if (raySphere(r.origin.x, r.origin.y, r.origin.z, r.direction.x, r.direction.y, r.direction.z,
        cx, cy, cz, bs.radius * _im.getMaxScale()) === null) continue;
      intersectGeometry(raycaster, intersects, geo, _im, this, { instanceId: i });
    }
  }
  copy(source, recursive = true) {
    super.copy(source, recursive);
    this.count = source.count ?? 0;
    this.cullInstances = source.cullInstances !== false;
    if (source.instanceMatrix) {
      this.instanceMatrix = new BufferAttribute(source.instanceMatrix.array.slice(), 16);
    }
    this.boundingSphere = source.boundingSphere
      ? { center: source.boundingSphere.center.clone(), radius: source.boundingSphere.radius }
      : null;
    return this;
  }
}
