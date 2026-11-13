import { Object3D } from '../core/Object3D.js';
import { Mesh } from './Mesh.js';
import { Bone } from './Bone.js';
import { Skeleton } from './Skeleton.js';
import { SkinnedMesh } from './SkinnedMesh.js';

/**
 * Copia un árbol de objetos (por ejemplo `gltf.scene`) con huesos y mallas con esqueleto propios.
 * La geometría y los materiales se comparten (no se duplican en la GPU); cada copia tiene sus huesos y su
 * esqueleto, así que se puede animar por separado. Con el skinning en la GPU esto permite cientos de
 * personajes con la misma malla.
 *
 *   const copia = cloneSkinned(gltf.scene);
 *   const mixer = new AnimationMixer(copia);
 *   mixer.clipAction(gltf.animations[0]).play();     // los clips funcionan en cualquier copia
 *
 * `{ copyGeometry: true }` da a cada copia su propia geometría (necesario si deformas en la CPU con
 * `gpuSkinning = false`, que escribe en la geometría).
 */
export function cloneSkinned(source, opts = {}) {
  const map = new Map();
  const geo = (o) => (opts.copyGeometry ? o.geometry.clone() : o.geometry);
  const cloneNode = (o) => {
    let c;
    if (o.isSkinnedMesh) c = new SkinnedMesh(geo(o), o.material);
    else if (o.isMesh && !o.isInstancedMesh) c = new Mesh(geo(o), o.material);
    else if (o.isBone) { c = new Bone(); c.length = o.length; }
    else c = new Object3D();
    c.name = o.name; c.visible = o.visible; c.castShadow = o.castShadow; c.receiveShadow = o.receiveShadow;
    c.userData = Object.assign({}, o.userData);
    c.position.copy(o.position); c.quaternion.copy(o.quaternion); c.scale.copy(o.scale);
    c.matrixAutoUpdate = o.matrixAutoUpdate;
    if (o.isMesh) { c.frustumCulled = o.frustumCulled; c.renderOrder = o.renderOrder; }
    map.set(o, c);
    for (const ch of o.children) c.add(cloneNode(ch));
    return c;
  };
  const root = cloneNode(source);
  root.updateMatrixWorld();
  const skeletons = new Map();
  source.traverse((o) => {
    if (!o.isSkinnedMesh || !o.skeleton) return;
    let sk = skeletons.get(o.skeleton);
    if (!sk) {
      const bones = o.skeleton.bones.map((b) => {
        const nb = map.get(b);
        if (!nb) throw new Error('cloneSkinned: un hueso del esqueleto no está dentro del árbol que se copia.');
        return nb;
      });
      sk = new Skeleton(bones, o.skeleton.boneInverses.map((m) => m.clone()));
      skeletons.set(o.skeleton, sk);
    }
    const c = map.get(o);
    c.gpuSkinning = o.gpuSkinning;
    c.bind(sk, o.bindMatrix, o.skinPad);
  });
  return root;
}
