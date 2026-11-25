import { Object3D } from '../core/Object3D.js';
import { Mesh } from './Mesh.js';
import { InstancedMesh } from './InstancedMesh.js';
import { Bone } from './Bone.js';
import { Skeleton } from './Skeleton.js';
import { SkinnedMesh } from './SkinnedMesh.js';
import { convertMaterial } from '../materials/convertMaterial.js';
import { cloneSubsurfState } from '../modeling/SubdivisionSurface.js';

function isHelperNode(o) {
  return Boolean(o && (o.isGizmo || o.isTransformGizmo || o.isGridHelper || o.isSkeletonHelper || o.isCameraHelper));
}

function isDescendant(node, ancestor) {
  let cur = node;
  while (cur) {
    if (cur === ancestor) return true;
    cur = cur.parent;
  }
  return false;
}

/**
 * Copia un árbol de objetos (por ejemplo `gltf.scene`) con huesos y mallas con esqueleto propios.
 * La geometría y los materiales se comparten por defecto (puedes activar `{ copyGeometry: true }`
 * o `{ cloneMaterial: true }`); cada copia tiene sus huesos y su esqueleto, así que se puede animar por separado.
 */
export function cloneSkinned(source, opts = {}) {
  const map = new Map();
  const matCache = new Map();
  const geo = (o) => (opts.copyGeometry && o.geometry ? o.geometry.clone() : o.geometry);
  const mat = (m) => {
    if (!opts.cloneMaterial || !m) return m;
    if (Array.isArray(m)) return m.map((item) => mat(item));
    if (matCache.has(m)) return matCache.get(m);
    const cloned = convertMaterial(m);
    matCache.set(m, cloned);
    return cloned;
  };
  const cloneNode = (o) => {
    let c;
    if (o.isSkinnedMesh) c = new SkinnedMesh(geo(o), mat(o.material));
    else if (o.isInstancedMesh) {
      const maxCount = o.instanceMatrix ? ((o.instanceMatrix.array.length / 16) | 0) : (o.count || 0);
      c = new InstancedMesh(geo(o), mat(o.material), Math.max(maxCount, o.count || 0));
      c.count = o.count;
      c.cullInstances = o.cullInstances !== false;
      if (o.instanceMatrix) c.instanceMatrix.array.set(o.instanceMatrix.array.subarray(0, c.instanceMatrix.array.length));
      c.instanceMatrix.needsUpdate = true;
      if (o.boundingSphere) c.boundingSphere = { center: o.boundingSphere.center.clone(), radius: o.boundingSphere.radius };
    }
    else if (o.isMesh) c = new Mesh(geo(o), mat(o.material));
    else if (o.isBone) { c = new Bone(); c.length = o.length; }
    else c = new Object3D();
    c.name = o.name; c.visible = o.visible; c.castShadow = o.castShadow; c.receiveShadow = o.receiveShadow;
    c.pickable = o.pickable !== false; c.exportable = o.exportable !== false; c.outline = o.outline !== false;
    c.userData = Object.assign({}, o.userData);
    c.position.copy(o.position);
    if (o.pivot) c.pivot.copy(o.pivot);
    c.quaternion.copy(o.quaternion);
    c.scale.copy(o.scale);
    c.matrixAutoUpdate = o.matrixAutoUpdate;
    if (o.isMesh) {
      c.frustumCulled = o.frustumCulled;
      c.renderOrder = o.renderOrder;
      if (o.drawMode !== undefined) c.drawMode = o.drawMode;
      if (Array.isArray(o.morphTargetInfluences)) c.morphTargetInfluences = o.morphTargetInfluences.slice();
      if (o.morphTargetDictionary) c.morphTargetDictionary = Object.assign({}, o.morphTargetDictionary);
      cloneSubsurfState(o, c);
    }
    map.set(o, c);
    for (const ch of o.children) {
      if (opts.ignoreHelpers && isHelperNode(ch)) continue;
      c.add(cloneNode(ch));
    }
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
    if (o._bind) c._bind = o._bind.slice();
    if (o._bindNormal) c._bindNormal = o._bindNormal.slice();
  });
  return root;
}

/**
 * Clona inteligentemente cualquier objeto o jerarquía (cámaras, mallas, TextGeometry,
 * grupos o personajes con esqueleto), clonando sus materiales de forma segura y
 * evitando duplicar nodos auxiliares internos si `ignoreHelpers !== false`.
 */
export function cloneObject(source, opts = {}) {
  if (!source) return null;
  const cloneMaterial = opts.cloneMaterial !== false;
  const cloneGeometry = Boolean(opts.cloneGeometry);
  const cloneTextGeometry = opts.cloneTextGeometry !== false;
  const ignoreHelpers = opts.ignoreHelpers !== false;
  const ignoreBonesInPlainClone = opts.ignoreBonesInPlainClone !== false;

  if (source.isCamera) {
    return source.clone(true);
  }

  if (source.isSkinnedMesh) {
    const selfContainedBones =
      source.skeleton && source.skeleton.bones.length > 0 && source.skeleton.bones.every((b) => isDescendant(b, source));
    if (selfContainedBones) {
      return cloneSkinned(source, { copyGeometry: cloneGeometry, cloneMaterial, ignoreHelpers });
    }
  }

  let hasBonesInside = false;
  const internalBones = new Set();
  source.traverse((n) => {
    if (n.isBone) {
      hasBonesInside = true;
      internalBones.add(n);
    }
  });

  if (hasBonesInside) {
    let hasExternalUsers = false;
    if (opts.scene && opts.scene.traverse) {
      opts.scene.traverse((n) => {
        if (hasExternalUsers) return;
        if (!n.isSkinnedMesh || !n.skeleton || isDescendant(n, source)) return;
        if (n.skeleton.bones.some((b) => internalBones.has(b))) hasExternalUsers = true;
      });
    }
    if (!hasExternalUsers) {
      let allSelfContained = true;
      source.traverse((n) => {
        if (!allSelfContained || !n.isSkinnedMesh || !n.skeleton) return;
        if (!n.skeleton.bones.every((b) => internalBones.has(b))) allSelfContained = false;
      });
      if (allSelfContained) {
        return cloneSkinned(source, { copyGeometry: cloneGeometry, cloneMaterial, ignoreHelpers });
      }
    }
  }

  const matCache = new Map();
  const cloneMap = new Map();
  const cloneMat = (m) => {
    if (!cloneMaterial || !m) return m;
    if (Array.isArray(m)) return m.map((item) => cloneMat(item));
    if (matCache.has(m)) return matCache.get(m);
    const cloned = convertMaterial(m);
    matCache.set(m, cloned);
    return cloned;
  };

  const cloneRecursive = (src) => {
    const node = src.clone(false);
    cloneMap.set(src, node);
    if (node.isMesh || node instanceof InstancedMesh) {
      if (src.geometry) {
        if (cloneGeometry || (cloneTextGeometry && src.geometry.isTextGeometry)) {
          node.geometry = src.geometry.clone();
        }
      }
      if (src.material) {
        node.material = cloneMat(src.material);
      }
      if (src.isMesh && src._subsurf) {
        cloneSubsurfState(src, node);
      }
    }
    for (let i = 0; i < src.children.length; i++) {
      const ch = src.children[i];
      if (ignoreHelpers && isHelperNode(ch)) continue;
      if (ignoreBonesInPlainClone && ch.isBone) continue;
      node.add(cloneRecursive(ch));
    }
    return node;
  };

  const root = cloneRecursive(source);
  root.traverse((node) => {
    if (node && node.isCameraHelper && node.camera && cloneMap.has(node.camera)) {
      node.setCamera(cloneMap.get(node.camera));
      if (typeof node.update === 'function') node.update();
    }
  });
  return root;
}
