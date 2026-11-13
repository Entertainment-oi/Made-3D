import { Vec3 } from '../math/Vec3.js';
import { Mat4 } from '../math/Mat4.js';

const _v = new Vec3();
const _v2 = new Vec3();
const _p = new Vec3();
const _m = new Mat4();
const _inv = new Mat4();

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function isHelperOrNonModel(o) {
  return !o || o.isLight || o.isCamera || o.isGizmo || o.isTransformGizmo || o.isGridHelper || o.isSkeletonHelper;
}

function expandBoxPoint(min, max, x, y, z) {
  if (x < min.x) min.x = x; if (x > max.x) max.x = x;
  if (y < min.y) min.y = y; if (y > max.y) max.y = y;
  if (z < min.z) min.z = z; if (z > max.z) max.z = z;
}

function expandGeometryBox(min, max, posAttr, matElements) {
  const arr = posAttr.array;
  const n = posAttr.count;
  if (!n) return false;
  const step = n > 65536 ? Math.ceil(n / 65536) : 1;
  const e = matElements;
  for (let i = 0; i < n; i += step) {
    const o = i * 3;
    const x = arr[o], y = arr[o + 1], z = arr[o + 2];
    expandBoxPoint(
      min, max,
      e[0] * x + e[4] * y + e[8] * z + e[12],
      e[1] * x + e[5] * y + e[9] * z + e[13],
      e[2] * x + e[6] * y + e[10] * z + e[14]
    );
  }
  return true;
}

function getLocalGeometryMinMax(posAttr) {
  const arr = posAttr.array;
  const n = posAttr.count;
  const step = n > 65536 ? Math.ceil(n / 65536) : 1;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i += step) {
    const x = arr[i * 3], y = arr[i * 3 + 1], z = arr[i * 3 + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return minX === Infinity ? null : [minX, minY, minZ, maxX, maxY, maxZ];
}

function isFlatFloorMesh(o, min, max) {
  if (o.userData && (o.userData.isFloor === true || o.userData.pickable === false)) return true;
  if (!o.isMesh || o.isSkinnedMesh) return false;
  const dx = max.x - min.x;
  const dy = max.y - min.y;
  const dz = max.z - min.z;
  const span = Math.max(dx, dz);
  return span >= 8 && dy <= span * 0.05;
}

/**
 * Calcula la caja envolvente exacta (AABB en espacio del mundo) de un objeto y sus descendientes.
 */
export function computeBounds(object, opts = {}) {
  const min = new Vec3(Infinity, Infinity, Infinity);
  const max = new Vec3(-Infinity, -Infinity, -Infinity);
  const includeInvisible = !!opts.includeInvisible;
  const ignoreFloors = !!opts.ignoreFloors;
  let hasMesh = false;

  if (object) {
    object.updateWorldMatrix(true, true);
    const bonePts = [];

    const walk = (o) => {
      if (!o) return;
      if (!includeInvisible && !o.visible) return;
      if (isHelperOrNonModel(o)) return;
      if (o.userData && o.userData.autoScaleIgnore === true) return;

      if (o.isMesh && o.geometry && o.geometry.attributes && o.geometry.attributes.position) {
        const pos = o.geometry.attributes.position;
        if (pos.count > 0) {
          const bMin = ignoreFloors ? new Vec3(Infinity, Infinity, Infinity) : min;
          const bMax = ignoreFloors ? new Vec3(-Infinity, -Infinity, -Infinity) : max;
          let added = false;

          if (o.isInstancedMesh && o.instanceMatrix) {
            const box = getLocalGeometryMinMax(pos);
            if (box) {
              const [x0, y0, z0, x1, y1, z1] = box;
              const arr = o.instanceMatrix.array;
              const total = Math.min(o.count || 0, (arr.length / 16) | 0);
              for (let i = 0; i < total; i++) {
                _m.elements.set(arr.subarray(i * 16, i * 16 + 16));
                _m.multiplyMatrices(o.matrixWorld, _m);
                const e = _m.elements;
                for (let cx = 0; cx < 2; cx++) {
                  const x = cx ? x1 : x0;
                  for (let cy = 0; cy < 2; cy++) {
                    const y = cy ? y1 : y0;
                    for (let cz = 0; cz < 2; cz++) {
                      const z = cz ? z1 : z0;
                      expandBoxPoint(
                        bMin, bMax,
                        e[0] * x + e[4] * y + e[8] * z + e[12],
                        e[1] * x + e[5] * y + e[9] * z + e[13],
                        e[2] * x + e[6] * y + e[10] * z + e[14]
                      );
                    }
                  }
                }
              }
              added = total > 0;
            }
          } else if (o.isSkinnedMesh && o.skeleton) {
            o.skeleton.update();
            const n = pos.count;
            const step = n > 65536 ? Math.ceil(n / 65536) : 1;
            for (let i = 0; i < n; i += step) {
              o.skinnedWorld(i, _v);
              expandBoxPoint(bMin, bMax, _v.x, _v.y, _v.z);
            }
            added = true;
          } else {
            added = expandGeometryBox(bMin, bMax, pos, o.matrixWorld.elements);
          }

          if (added) {
            if (ignoreFloors) {
              if (!isFlatFloorMesh(o, bMin, bMax)) {
                expandBoxPoint(min, max, bMin.x, bMin.y, bMin.z);
                expandBoxPoint(min, max, bMax.x, bMax.y, bMax.z);
                hasMesh = true;
              }
            } else {
              hasMesh = true;
            }
          }
        }
      } else if (o.isBone) {
        o.getWorldPosition(_v);
        bonePts.push(_v.x, _v.y, _v.z);
        if (o.length) {
          o.getWorldTail(_v2);
          bonePts.push(_v2.x, _v2.y, _v2.z);
        }
      }

      for (const c of o.children) walk(c);
    };

    walk(object);

    if (!hasMesh && bonePts.length) {
      for (let i = 0; i < bonePts.length; i += 3) {
        expandBoxPoint(min, max, bonePts[i], bonePts[i + 1], bonePts[i + 2]);
      }
      hasMesh = true;
    }
  }

  if (!hasMesh || min.x === Infinity) {
    return {
      empty: true,
      min: new Vec3(0, 0, 0),
      max: new Vec3(0, 0, 0),
      size: new Vec3(0, 0, 0),
      center: new Vec3(0, 0, 0),
      radius: 0,
      maxDim: 0,
    };
  }

  const size = new Vec3(max.x - min.x, max.y - min.y, max.z - min.z);
  const center = new Vec3((min.x + max.x) * 0.5, (min.y + max.y) * 0.5, (min.z + max.z) * 0.5);
  const maxDim = Math.max(size.x, size.y, size.z);
  const radius = size.length() * 0.5;
  return { empty: false, min, max, size, center, radius, maxDim };
}

/**
 * Calcula el tamaño de referencia natural de una escena analizando los objetos existentes,
 * cuadrícula (`GridHelper`) y altura del suelo para que los modelos añadidos encajen bien.
 */
export function computeSceneReference(sceneOrNode, exclude = null, opts = {}) {
  let sceneRoot = sceneOrNode || null;
  while (sceneRoot && !sceneRoot.isScene && sceneRoot.parent) sceneRoot = sceneRoot.parent;
  if (!sceneRoot) sceneRoot = sceneOrNode;

  let gridSize = 0;
  let groundY = null;

  if (sceneRoot) {
    sceneRoot.traverse((o) => {
      if (!o || !o.visible || o === exclude) return;
      if (o.isGridHelper) {
        if (o.size > gridSize) gridSize = o.size;
        if (groundY === null) groundY = o.matrixWorld ? o.matrixWorld.elements[13] : o.position.y;
        return;
      }
      if (o.isMesh && o.userData && (o.userData.isFloor === true || o.userData.pickable === false)) {
        const b = computeBounds(o);
        if (!b.empty) {
          if (groundY === null || b.max.y > groundY) groundY = b.max.y;
        }
      }
    });
  }
  if (groundY === null) groundY = 0;

  let container = opts.referenceRoot || (exclude && exclude.parent ? exclude.parent : sceneRoot);
  if (container && container === sceneRoot) {
    const candidates = container.children.filter((c) => !isHelperOrNonModel(c) && c !== exclude);
    if (candidates.length === 1 && !candidates[0].isMesh && candidates[0].children.length > 0) {
      container = candidates[0];
    }
  }

  const sizes = [];
  if (container && container.children) {
    for (const child of container.children) {
      if (!child || !child.visible || child === exclude) continue;
      if (isHelperOrNonModel(child)) continue;
      if (child.userData && (child.userData.autoScaleIgnore === true || child.userData.isFloor === true || child.userData.pickable === false)) continue;
      const b = computeBounds(child, { ignoreFloors: true });
      if (b.empty || b.maxDim <= 1e-5) continue;
      sizes.push(b.maxDim);
    }
  }

  let targetSize;
  let source;
  if (sizes.length > 0) {
    sizes.sort((a, b) => a - b);
    const mid = Math.floor(sizes.length / 2);
    const median = sizes.length % 2 === 1 ? sizes[mid] : (sizes[mid - 1] + sizes[mid]) * 0.5;
    targetSize = clamp(median, opts.minReferenceSize ?? 0.35, opts.maxReferenceSize ?? 30);
    source = 'objects';
  } else if (gridSize > 0) {
    targetSize = clamp(gridSize * 0.11, 1.5, 5.5);
    source = 'grid';
  } else {
    targetSize = opts.defaultTargetSize ?? 2.6;
    source = 'default';
  }

  const maxRatio = opts.maxRatio ?? 2.2;
  const minRatio = opts.minRatio ?? 0.28;
  return {
    targetSize,
    maxSize: targetSize * maxRatio,
    minSize: targetSize * minRatio,
    groundY,
    gridSize,
    objectCount: sizes.length,
    source,
  };
}

function shouldSkipAutoScale(object) {
  if (!object || isHelperOrNonModel(object)) return true;
  if (object.userData && (object.userData.autoScale === false || object.userData.autoScaleIgnore === true || object.userData.isFloor === true || object.userData.pickable === false)) {
    return true;
  }
  return false;
}

/**
 * Restaura la posición y escala originales previas a `autoScaleObject`.
 */
export function resetAutoScale(object) {
  if (!object || !object.userData || !object.userData._autoScaleOriginal) return false;
  const orig = object.userData._autoScaleOriginal;
  object.position.copy(orig.position);
  object.scale.copy(orig.scale);
  delete object.userData._autoScaleApplied;
  object.updateWorldMatrix(true, true);
  return true;
}

/**
 * Escala automáticamente un objeto/modelo para que encaje en la escena (o al tamaño objetivo),
 * guardando su transformación original para poder revertir con `resetAutoScale(object)`.
 */
export function autoScaleObject(object, opts = {}) {
  if (shouldSkipAutoScale(object)) return { applied: false, reason: 'skipped' };

  if (object.userData && object.userData._autoScaleOriginal && !opts.preserveCurrent) {
    const orig = object.userData._autoScaleOriginal;
    object.position.copy(orig.position);
    object.scale.copy(orig.scale);
    object.updateWorldMatrix(true, true);
  }

  const bounds = computeBounds(object);
  if (bounds.empty || bounds.maxDim <= 1e-6) {
    return { applied: false, reason: 'empty', bounds };
  }

  const sceneRefSource = opts.scene || object.parent || null;
  const reference = sceneRefSource ? computeSceneReference(sceneRefSource, object, opts) : null;
  const targetSize = opts.targetSize ?? (reference ? reference.targetSize : (opts.defaultTargetSize ?? 2.6));
  const mode = opts.mode || 'fit';
  const maxRatio = opts.maxRatio ?? 2.2;
  const minRatio = opts.minRatio ?? 0.28;

  if (mode === 'clamp' || mode === 'smart') {
    const ratio = bounds.maxDim / (targetSize || 1);
    if (ratio <= maxRatio && ratio >= minRatio) {
      return {
        applied: false,
        reason: 'within-range',
        factor: 1,
        originalSize: bounds.maxDim,
        finalSize: bounds.maxDim,
        targetSize,
        bounds,
        reference,
      };
    }
  }

  if (!object.userData) object.userData = {};
  if (!object.userData._autoScaleOriginal) {
    object.userData._autoScaleOriginal = {
      position: object.position.clone(),
      scale: object.scale.clone(),
    };
  }

  const factor = targetSize / bounds.maxDim;
  object.scale.multiplyScalar(factor);
  object.updateWorldMatrix(true, true);

  const alignBottom = opts.alignBottom !== false;
  const centerXZ = opts.centerXZ !== false;
  let finalBounds = computeBounds(object);

  if (!finalBounds.empty && (alignBottom || centerXZ)) {
    const groundY = opts.groundY ?? (reference ? reference.groundY : 0);
    const ax = opts.anchor ? opts.anchor.x : 0;
    const az = opts.anchor ? opts.anchor.z : 0;
    const dx = centerXZ ? ax - finalBounds.center.x : 0;
    const dy = alignBottom ? groundY - finalBounds.min.y : 0;
    const dz = centerXZ ? az - finalBounds.center.z : 0;

    if (Math.abs(dx) > 1e-6 || Math.abs(dy) > 1e-6 || Math.abs(dz) > 1e-6) {
      if (object.parent) {
        object.parent.updateWorldMatrix(true, false);
        object.getWorldPosition(_p);
        _p.set(_p.x + dx, _p.y + dy, _p.z + dz);
        _inv.copyInverse(object.parent.matrixWorld);
        _p.applyMatrix4(_inv);
        object.position.copy(_p);
      } else {
        object.position.set(object.position.x + dx, object.position.y + dy, object.position.z + dz);
      }
      object.updateWorldMatrix(true, true);
      finalBounds = computeBounds(object);
    }
  }

  const info = {
    applied: true,
    factor,
    originalSize: bounds.maxDim,
    finalSize: finalBounds.maxDim,
    targetSize,
    bounds: finalBounds,
    reference,
  };
  object.userData._autoScaleApplied = info;
  return info;
}
