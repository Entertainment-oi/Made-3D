import { Vec3 } from '../math/Vec3.js';
import { Quat } from '../math/Quat.js';
import { Mat4 } from '../math/Mat4.js';
import { Raycaster } from '../core/Raycaster.js';
import { pointSegment2D } from '../core/raycast.js';
import { clientToLocalPoint } from '../core/viewportCoords.js';
import { BufferAttribute } from '../geometry/BufferAttribute.js';
import { SphereGeometry } from '../geometry/primitives.js';
import { StandardMaterial } from '../materials/BuiltinMaterials.js';
import { prepareSculptGeometry } from '../sculpt/Sculptor.js';
import { Bone } from './Bone.js';
import { Skeleton } from './Skeleton.js';
import { SkeletonHelper } from './SkeletonHelper.js';
import { SkinnedMesh } from './SkinnedMesh.js';

const _raycaster = new Raycaster();
const _vA = new Vec3();
const _vB = new Vec3();
const _vC = new Vec3();
const _vD = new Vec3();
const _upY = new Vec3(0, 1, 0);
const _invMat = new Mat4();
const _qA = new Quat();
const _qB = new Quat();

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

function quatFromUnitVectors(from, to, out = new Quat()) {
  let r = from.x * to.x + from.y * to.y + from.z * to.z + 1;
  if (r < 1e-6) {
    r = 0;
    if (Math.abs(from.x) > Math.abs(from.z)) {
      out.set(-from.y, from.x, 0, r);
    } else {
      out.set(0, -from.z, from.y, r);
    }
  } else {
    out.set(
      from.y * to.z - from.z * to.y,
      from.z * to.x - from.x * to.z,
      from.x * to.y - from.y * to.x,
      r
    );
  }
  return out.normalize();
}

function projectPoint(p, camera, W, H, out) {
  const e = camera.matrixWorldInverse.elements;
  const f = camera.projectionMatrix.elements;
  const x = e[0] * p.x + e[4] * p.y + e[8] * p.z + e[12];
  const y = e[1] * p.x + e[5] * p.y + e[9] * p.z + e[13];
  const z = e[2] * p.x + e[6] * p.y + e[10] * p.z + e[14];
  const cx = f[0] * x + f[4] * y + f[8] * z + f[12];
  const cy = f[1] * x + f[5] * y + f[9] * z + f[13];
  const cw = f[3] * x + f[7] * y + f[11] * z + f[15];
  const w = cw > 1e-6 ? cw : 1e-6;
  out.x = ((cx / w) * 0.5 + 0.5) * W;
  out.y = (1 - ((cy / w) * 0.5 + 0.5)) * H;
  out.w = cw;
  return out;
}

function projectSegment(ax, ay, az, bx, by, bz, camera, W, H, outA, outB) {
  if (camera.fov !== undefined) {
    const ve = camera.matrixWorldInverse.elements;
    const z1 = -(ve[2] * ax + ve[6] * ay + ve[10] * az + ve[14]);
    const z2 = -(ve[2] * bx + ve[6] * by + ve[10] * bz + ve[14]);
    if (z1 <= 0.01 && z2 <= 0.01) return false;
    if (z1 <= 0.01) {
      const k = (0.01 - z1) / (z2 - z1);
      ax += (bx - ax) * k;
      ay += (by - ay) * k;
      az += (bz - az) * k;
    } else if (z2 <= 0.01) {
      const k = (0.01 - z2) / (z1 - z2);
      bx += (ax - bx) * k;
      by += (ay - by) * k;
      bz += (az - bz) * k;
    }
  }
  projectPoint(_vA.set(ax, ay, az), camera, W, H, outA);
  projectPoint(_vB.set(bx, by, bz), camera, W, H, outB);
  return true;
}

function pointSegmentDistanceSq3D(px, py, pz, ax, ay, az, bx, by, bz) {
  const vx = bx - ax;
  const vy = by - ay;
  const vz = bz - az;
  const wx = px - ax;
  const wy = py - ay;
  const wz = pz - az;
  const lenSq = vx * vx + vy * vy + vz * vz;
  let t = lenSq > 1e-10 ? (wx * vx + wy * vy + wz * vz) / lenSq : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const cx = ax + vx * t - px;
  const cy = ay + vy * t - py;
  const cz = az + vz * t - pz;
  return cx * cx + cy * cy + cz * cz;
}

function replaceObjectInHierarchy(oldObj, newObj, onReplaceMesh = null) {
  const parent = oldObj.parent;
  if (parent) {
    const idx = parent.children.indexOf(oldObj);
    if (idx >= 0) parent.children.splice(idx, 1, newObj);
    else parent.children.push(newObj);
    newObj.parent = parent;
    oldObj.parent = null;
  }
  for (const ch of oldObj.children.slice()) {
    newObj.add(ch);
  }
  newObj.updateMatrixWorld(true, true);
  if (typeof onReplaceMesh === 'function') {
    onReplaceMesh(oldObj, newObj);
  }
}

/**
 * Calcula pesos automáticos (`skinIndex`, `skinWeight` de 4 componentes) para una geometría
 * a partir de una lista de huesos usando margen Voronoi en distancia al cuadrado y mezcla
 * localizada en la articulación.
 */
export function computeAutoSkinWeights(geo, meshWorldMatrix, bones, options = {}) {
  const posAttr = geo?.attributes?.position;
  const count = posAttr ? posAttr.count : 0;
  const pos = posAttr ? posAttr.array : null;
  const skinIndex = new Float32Array(count * 4);
  const skinWeight = new Float32Array(count * 4);

  if (!pos || !count || !bones || !bones.length) return { skinIndex, skinWeight };

  const sigmaRatio = options.sigmaRatio ?? 0.16;
  const minSigma = options.minSigma ?? 0.03;
  const maxSigma = options.maxSigma ?? 0.24;
  const cutoff = options.cutoff ?? 0.015;

  const segs = [];
  for (let bi = 0; bi < bones.length; bi++) {
    const b = bones[bi];
    b.updateWorldMatrix(true, false);
    const e = b.matrixWorld.elements;
    const ax = e[12], ay = e[13], az = e[14];
    const hasChild = Rigger.hasChildBone(b);
    const subSegs = [];
    let maxLen = 0;

    if (b.length > 1e-5) {
      const tail = Rigger.getBoneTipWorld(b, 'tail', _vA);
      const len = Math.hypot(tail.x - ax, tail.y - ay, tail.z - az);
      subSegs.push({ ax, ay, az, bx: tail.x, by: tail.y, bz: tail.z, len });
      if (len > maxLen) maxLen = len;
    } else if (hasChild) {
      for (const c of b.children) {
        if (!c || !c.isBone || c.visible === false) continue;
        c.updateWorldMatrix(true, false);
        const ce = c.matrixWorld.elements;
        const cIsLeaf = !Rigger.hasChildBone(c) && c.length <= 1e-5;
        const tEnd = cIsLeaf ? 0.58 : 0.9;
        const bx = ax + (ce[12] - ax) * tEnd;
        const by = ay + (ce[13] - ay) * tEnd;
        const bz = az + (ce[14] - az) * tEnd;
        const len = Math.hypot(bx - ax, by - ay, bz - az);
        subSegs.push({ ax, ay, az, bx, by, bz, len });
        if (len > maxLen) maxLen = len;
      }
      if (!subSegs.length) {
        subSegs.push({ ax, ay, az, bx: ax, by: ay, bz: az, len: 0 });
      }
    } else {
      subSegs.push({ ax, ay, az, bx: ax, by: ay, bz: az, len: 0 });
    }

    const skip = maxLen <= 1e-5 && hasChild && bones.length > 1;
    segs.push({ subSegs, len: maxLen, skip });
  }

  const activeSegs = [];
  for (let bi = 0; bi < segs.length; bi++) {
    if (!segs[bi].skip) activeSegs.push(bi);
  }
  if (!activeSegs.length) activeSegs.push(0);

  const we = meshWorldMatrix.elements;
  const d2Arr = new Float64Array(segs.length);
  const segLens = new Float64Array(segs.length);
  const topIdx = new Int32Array(4);
  const topScore = new Float32Array(4);

  for (let v = 0; v < count; v++) {
    const o = v * 3;
    const lx = pos[o], ly = pos[o + 1], lz = pos[o + 2];
    const wx = we[0] * lx + we[4] * ly + we[8] * lz + we[12];
    const wy = we[1] * lx + we[5] * ly + we[9] * lz + we[13];
    const wz = we[2] * lx + we[6] * ly + we[10] * lz + we[14];

    let minIdx = activeSegs[0];
    let minD2 = Infinity;
    for (let k = 0; k < activeSegs.length; k++) {
      const bi = activeSegs[k];
      const subSegs = segs[bi].subSegs;
      let bestSubD2 = Infinity;
      let bestSubLen = segs[bi].len;
      for (let si = 0; si < subSegs.length; si++) {
        const s = subSegs[si];
        const d2 = pointSegmentDistanceSq3D(wx, wy, wz, s.ax, s.ay, s.az, s.bx, s.by, s.bz);
        if (d2 < bestSubD2) {
          bestSubD2 = d2;
          bestSubLen = s.len;
        }
      }
      d2Arr[bi] = bestSubD2;
      segLens[bi] = bestSubLen;
      if (bestSubD2 < minD2) {
        minD2 = bestSubD2;
        minIdx = bi;
      }
    }

    const minLen = segLens[minIdx];
    topIdx.fill(0);
    topScore.fill(0);

    for (let k = 0; k < activeSegs.length; k++) {
      const bi = activeSegs[k];
      const diff = Math.max(0, d2Arr[bi] - minD2);
      let score = 1;
      if (bi !== minIdx) {
        const sLen = segLens[bi];
        const baseLen = minLen > 1e-4 && sLen > 1e-4
          ? Math.min(minLen, sLen)
          : Math.max(minLen, sLen, 0.12);
        const sigma = clamp(baseLen * sigmaRatio, minSigma, maxSigma);
        score = Math.exp(-diff / (2 * sigma * sigma));
        if (score < cutoff) continue;
      }

      if (score > topScore[3]) {
        let posSlot = 3;
        while (posSlot > 0 && score > topScore[posSlot - 1]) {
          topScore[posSlot] = topScore[posSlot - 1];
          topIdx[posSlot] = topIdx[posSlot - 1];
          posSlot--;
        }
        topScore[posSlot] = score;
        topIdx[posSlot] = bi;
      }
    }

    const sum = topScore[0] + topScore[1] + topScore[2] + topScore[3];
    const b4 = v * 4;
    if (sum > 1e-12) {
      for (let k = 0; k < 4; k++) {
        skinIndex[b4 + k] = topScore[k] > 0 ? topIdx[k] : 0;
        skinWeight[b4 + k] = topScore[k] / sum;
      }
    } else {
      skinIndex[b4] = minIdx;
      skinWeight[b4] = 1;
    }
  }

  return { skinIndex, skinWeight };
}

/**
 * Convierte un peso `[0..1]` a color RGB del mapa de calor (sin influencia = gris).
 */
export function weightToHeatRgb(w, out, offset = 0) {
  if (!(w > 0.001)) {
    out[offset] = 0.45;
    out[offset + 1] = 0.45;
    out[offset + 2] = 0.48;
    return out;
  }
  const t = clamp(w, 0, 1);
  let r, g, b;
  if (t < 0.25) {
    const k = t / 0.25;
    r = 0.1 + (0.06 - 0.1) * k;
    g = 0.28 + (0.8 - 0.28) * k;
    b = 0.94;
  } else if (t < 0.5) {
    const k = (t - 0.25) / 0.25;
    r = 0.06 + (0.16 - 0.06) * k;
    g = 0.8 + (0.86 - 0.8) * k;
    b = 0.94 + (0.32 - 0.94) * k;
  } else if (t < 0.75) {
    const k = (t - 0.5) / 0.25;
    r = 0.16 + (0.98 - 0.16) * k;
    g = 0.86 + (0.84 - 0.86) * k;
    b = 0.32 + (0.12 - 0.32) * k;
  } else {
    const k = (t - 0.75) / 0.25;
    r = 0.98 + (0.96 - 0.98) * k;
    g = 0.84 + (0.16 - 0.84) * k;
    b = 0.12 + (0.14 - 0.12) * k;
  }
  out[offset] = r;
  out[offset + 1] = g;
  out[offset + 2] = b;
  return out;
}

function getBoneWeightForVertex(si, sw, vertexIndex, boneIndex) {
  const b4 = vertexIndex * 4;
  let total = 0;
  for (let j = 0; j < 4; j++) {
    const w = sw[b4 + j];
    if (w > 0 && (Math.round(si[b4 + j]) | 0) === boneIndex) {
      total += w;
    }
  }
  return total;
}

/**
 * Actualiza el atributo `color` de la geometría de un `SkinnedMesh` para mostrar el mapa
 * de calor de influencias del hueso indicado.
 */
export function updateMeshWeightHeatmap(skMesh, bone) {
  if (!skMesh || !skMesh.geometry || !skMesh.skeleton) return false;
  const geo = skMesh.geometry;
  const pos = geo.attributes.position;
  const si = geo.attributes.skinIndex?.array;
  const sw = geo.attributes.skinWeight?.array;
  if (!pos || !si || !sw) return false;

  const boneIndex = skMesh.skeleton.bones.indexOf(bone);
  const vCount = pos.count;
  let colorAttr = geo.attributes.color;
  if (!colorAttr || colorAttr.itemSize !== 3 || colorAttr.count !== vCount) {
    colorAttr = new BufferAttribute(new Float32Array(vCount * 3), 3);
    geo.attributes.color = colorAttr;
  }
  const arr = colorAttr.array;

  for (let v = 0; v < vCount; v++) {
    const w = boneIndex >= 0 ? getBoneWeightForVertex(si, sw, v, boneIndex) : 0;
    weightToHeatRgb(w, arr, v * 3);
  }
  colorAttr.needsUpdate = true;
  return true;
}

/**
 * Pinta o borra pesos de un hueso sobre los vértices dentro de un radio esférico alrededor de `hitPoint`.
 */
export function applyWeightBrushAt(skMesh, hitPoint, bone, radius, strength = 0.42, modeOrErase = false, options = {}) {
  if (!skMesh || !skMesh.geometry || !skMesh.skeleton || !hitPoint) return false;
  const mode = typeof modeOrErase === 'string'
    ? (modeOrErase === 'erase' || modeOrErase === 'smooth' ? modeOrErase : 'paint')
    : (modeOrErase ? 'erase' : 'paint');

  const bones = skMesh.skeleton.bones || [];
  const boneIndex = bone ? bones.indexOf(bone) : -1;
  if (mode !== 'smooth' && boneIndex < 0) return false;
  if (mode === 'smooth' && !bones.length) return false;

  const geo = skMesh.geometry;
  const posAttr = geo.attributes.position;
  const siAttr = geo.attributes.skinIndex;
  const swAttr = geo.attributes.skinWeight;
  if (!posAttr || !siAttr || !swAttr) return false;

  const vCount = posAttr.count;
  const si = siAttr.array;
  const sw = swAttr.array;
  for (let i = 0; i < bones.length; i++) {
    bones[i]?.updateWorldMatrix(true, false);
  }
  skMesh.skeleton.update();

  if (!skMesh._world || skMesh._world.length < vCount * 3) {
    skMesh._world = new Float32Array(vCount * 3);
  }
  skMesh.computeSkinnedWorld(skMesh._world, vCount);
  const worldPos = skMesh._world;

  const topo = prepareSculptGeometry(geo);
  const r2 = radius * radius;
  const hx = hitPoint.x, hy = hitPoint.y, hz = hitPoint.z;
  let changed = false;

  if (mode === 'smooth') {
    if (!topo) return false;
    const { W, weldOffsets, weldMembers, adjOffsets, adjNeighbors } = topo;
    const prevSi = si.slice();
    const prevSw = sw.slice();
    const bIds = [];
    const bCur = [];
    const bAvg = [];
    const bBlend = [];

    const addWeightEntry = (id, curAdd, avgAdd) => {
      for (let i = 0; i < bIds.length; i++) {
        if (bIds[i] === id) {
          bCur[i] += curAdd;
          bAvg[i] += avgAdd;
          return;
        }
      }
      bIds.push(id);
      bCur.push(curAdd);
      bAvg.push(avgAdd);
    };

    for (let w = 0; w < W; w++) {
      const rep = weldMembers[weldOffsets[w]];
      const o = rep * 3;
      const dx = worldPos[o] - hx;
      const dy = worldPos[o + 1] - hy;
      const dz = worldPos[o + 2] - hz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= r2) continue;

      const adjStart = adjOffsets[w];
      const adjEnd = adjOffsets[w + 1];
      const deg = adjEnd - adjStart;
      if (deg <= 0) continue;

      const t = Math.sqrt(d2) / radius;
      const falloff = (1 - t * t) * (1 - t * t);
      const alpha = clamp(strength * falloff, 0, 1);
      if (alpha <= 1e-5) continue;

      bIds.length = 0;
      bCur.length = 0;
      bAvg.length = 0;

      const rb4 = rep * 4;
      for (let j = 0; j < 4; j++) {
        const cw = prevSw[rb4 + j];
        if (cw <= 1e-6) continue;
        addWeightEntry(Math.round(prevSi[rb4 + j]) | 0, cw, 0);
      }

      let avgSum = 0;
      const invDeg = 1 / deg;
      for (let a = adjStart; a < adjEnd; a++) {
        const nw = adjNeighbors[a];
        const nRep = weldMembers[weldOffsets[nw]];
        const nb4 = nRep * 4;
        for (let j = 0; j < 4; j++) {
          const nwVal = prevSw[nb4 + j];
          if (nwVal <= 1e-6) continue;
          const contrib = nwVal * invDeg;
          addWeightEntry(Math.round(prevSi[nb4 + j]) | 0, 0, contrib);
          avgSum += contrib;
        }
      }

      if (avgSum <= 1e-6) continue;
      const normAvg = 1 / avgSum;

      bBlend.length = bIds.length;
      for (let i = 0; i < bIds.length; i++) {
        bBlend[i] = bCur[i] * (1 - alpha) + (bAvg[i] * normAvg) * alpha;
      }

      // Ordenar descendente y conservar hasta 4 influencias normalizadas
      for (let i = 0; i < bIds.length - 1; i++) {
        for (let j = i + 1; j < bIds.length; j++) {
          if (bBlend[j] > bBlend[i]) {
            const tb = bBlend[i]; bBlend[i] = bBlend[j]; bBlend[j] = tb;
            const ti = bIds[i]; bIds[i] = bIds[j]; bIds[j] = ti;
          }
        }
      }

      const keep = Math.min(4, bIds.length);
      let keepSum = 0;
      for (let i = 0; i < keep; i++) {
        if (bBlend[i] > 1e-5) keepSum += bBlend[i];
      }
      if (keepSum <= 1e-6) continue;

      const start = weldOffsets[w];
      const end = weldOffsets[w + 1];
      let vertChanged = false;
      for (let j = 0; j < 4; j++) {
        const nextIdx = j < keep && bBlend[j] > 1e-5 ? bIds[j] : 0;
        const nextWt = j < keep && bBlend[j] > 1e-5 ? bBlend[j] / keepSum : 0;
        if (
          Math.abs(nextWt - prevSw[rb4 + j]) > 1e-5 ||
          (nextWt > 1e-5 && (Math.round(prevSi[rb4 + j]) | 0) !== nextIdx)
        ) {
          vertChanged = true;
          break;
        }
      }
      if (!vertChanged) continue;

      for (let k = start; k < end; k++) {
        const b4 = weldMembers[k] * 4;
        for (let j = 0; j < 4; j++) {
          if (j < keep && bBlend[j] > 1e-5) {
            si[b4 + j] = bIds[j];
            sw[b4 + j] = bBlend[j] / keepSum;
          } else {
            si[b4 + j] = 0;
            sw[b4 + j] = 0;
          }
        }
      }
      changed = true;
    }
  } else {
    let fallbackBoneIndex = -1;
    if (mode === 'erase' && bones.length > 1) {
      if (bone.parent && bone.parent.isBone) {
        fallbackBoneIndex = bones.indexOf(bone.parent);
      }
      if (fallbackBoneIndex < 0 && bone.children) {
        for (const ch of bone.children) {
          if (ch && ch.isBone) {
            const ci = bones.indexOf(ch);
            if (ci >= 0 && ci !== boneIndex) {
              fallbackBoneIndex = ci;
              break;
            }
          }
        }
      }
      if (fallbackBoneIndex < 0) {
        fallbackBoneIndex = bones.findIndex((b, idx) => idx !== boneIndex && Boolean(b));
      }
    }

    const idxs = new Int32Array(4);
    const wts = new Float32Array(4);

    const editVertex = (v, amount) => {
      const b4 = v * 4;
      let curW = 0;
      let sumOther = 0;
      let count = 0;

      for (let j = 0; j < 4; j++) {
        const w = sw[b4 + j];
        const bi = Math.round(si[b4 + j]) | 0;
        if (w <= 1e-6) continue;
        if (bi === boneIndex) {
          curW += w;
        } else {
          let merged = false;
          for (let k = 0; k < count; k++) {
            if (idxs[k] === bi) {
              wts[k] += w;
              merged = true;
              break;
            }
          }
          if (!merged && count < 4) {
            idxs[count] = bi;
            wts[count] = w;
            count++;
          }
          sumOther += w;
        }
      }

      let nextW;
      if (mode === 'erase') {
        if (curW <= 1e-6) return false;
        if (sumOther > 1e-5) {
          nextW = Math.max(0, curW - amount);
          if (nextW < 0.015) nextW = 0;
        } else if (fallbackBoneIndex >= 0) {
          nextW = Math.max(0, curW - amount);
          if (nextW < 0.015) nextW = 0;
          idxs[0] = fallbackBoneIndex;
          wts[0] = 1 - nextW;
          count = 1;
          sumOther = wts[0];
        } else {
          nextW = curW - amount * 1.4 <= 0.35 ? 0 : curW;
          if (amount >= 0.12) nextW = 0;
        }
      } else {
        nextW = Math.min(1, curW + amount);
        if (sumOther <= 1e-5) nextW = 1;
      }

      if (Math.abs(nextW - curW) <= 1e-5) return false;

      const outIdx = [];
      const outWt = [];

      if (nextW > 1e-5) {
        outIdx.push(boneIndex);
        outWt.push(nextW);
      }

      if (count > 0) {
        const remainingTarget = nextW > 1e-5 ? Math.max(0, 1 - nextW) : 1;
        if (remainingTarget > 1e-5 && sumOther > 1e-6) {
          const maxOther = nextW > 1e-5 ? 3 : 4;
          if (count > maxOther) {
            for (let a = 0; a < count - 1; a++) {
              for (let b = a + 1; b < count; b++) {
                if (wts[b] > wts[a]) {
                  const tw = wts[a]; wts[a] = wts[b]; wts[b] = tw;
                  const ti = idxs[a]; idxs[a] = idxs[b]; idxs[b] = ti;
                }
              }
            }
            count = maxOther;
            sumOther = 0;
            for (let k = 0; k < count; k++) sumOther += wts[k];
          }
          const scale = sumOther > 1e-6 ? remainingTarget / sumOther : 0;
          for (let k = 0; k < count; k++) {
            const wScaled = wts[k] * scale;
            if (wScaled > 1e-5) {
              outIdx.push(idxs[k]);
              outWt.push(wScaled);
            }
          }
        }
      }

      for (let j = 0; j < 4; j++) {
        if (j < outIdx.length) {
          si[b4 + j] = outIdx[j];
          sw[b4 + j] = outWt[j];
        } else {
          si[b4 + j] = 0;
          sw[b4 + j] = 0;
        }
      }
      return true;
    };

    if (topo) {
      const { W, weldOffsets, weldMembers } = topo;
      for (let w = 0; w < W; w++) {
        const rep = weldMembers[weldOffsets[w]];
        const o = rep * 3;
        const dx = worldPos[o] - hx;
        const dy = worldPos[o + 1] - hy;
        const dz = worldPos[o + 2] - hz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= r2) continue;
        const t = Math.sqrt(d2) / radius;
        const falloff = (1 - t * t) * (1 - t * t);
        const amount = strength * falloff;
        const start = weldOffsets[w];
        const end = weldOffsets[w + 1];
        for (let k = start; k < end; k++) {
          if (editVertex(weldMembers[k], amount)) changed = true;
        }
      }
    } else {
      for (let v = 0; v < vCount; v++) {
        const o = v * 3;
        const dx = worldPos[o] - hx;
        const dy = worldPos[o + 1] - hy;
        const dz = worldPos[o + 2] - hz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= r2) continue;
        const t = Math.sqrt(d2) / radius;
        const falloff = (1 - t * t) * (1 - t * t);
        if (editVertex(v, strength * falloff)) changed = true;
      }
    }
  }

  if (changed) {
    siAttr.needsUpdate = true;
    swAttr.needsUpdate = true;
    skMesh.refreshSkinning();
    if (options.refreshHeatmap !== false && bone) {
      updateMeshWeightHeatmap(skMesh, bone);
    }
  }
  return changed;
}

/**
 * Fija una lista de mallas (`Mesh` o `SkinnedMesh`) a un esqueleto de huesos calculando
 * sus pesos automáticos. Convierte mallas estáticas en `SkinnedMesh` y devuelve funciones
 * `undo()` / `redo()` listas para historial.
 */
export function bindMeshesToSkeleton(meshes, bones, options = {}) {
  const meshList = Array.isArray(meshes) ? meshes.filter(Rigger.isRigMesh) : [];
  const orderedBones = Array.isArray(bones) ? bones.filter((b) => b && b.isBone) : [];
  if (!meshList.length || !orderedBones.length) {
    return { ok: false, records: [], bones: [], primarySkinned: null, replaceMap: new Map() };
  }

  for (const b of orderedBones) b.updateWorldMatrix(true, false);

  const scene = options.scene || null;
  const onReplaceMesh = typeof options.onReplaceMesh === 'function' ? options.onReplaceMesh : null;
  const records = [];
  const replaceMap = new Map();

  for (const srcMesh of meshList) {
    const parent = srcMesh.parent;
    const isAlreadySkinned = Boolean(srcMesh.isSkinnedMesh);

    const prevGeo = srcMesh.geometry;
    let uniqueGeo = prevGeo;
    if (scene && typeof scene.traverse === 'function') {
      let shareCount = 0;
      scene.traverse((n) => {
        if (n !== srcMesh && n.isMesh && n.geometry === prevGeo) shareCount++;
      });
      if (shareCount > 0 && typeof prevGeo.clone === 'function') {
        uniqueGeo = prevGeo.clone();
        if (typeof srcMesh.setGeometry === 'function') srcMesh.setGeometry(uniqueGeo);
        else srcMesh.geometry = uniqueGeo;
      }
    }

    srcMesh.updateWorldMatrix(true, false);

    const prevSkinIdx = uniqueGeo.attributes.skinIndex ? uniqueGeo.attributes.skinIndex.array.slice() : null;
    const prevSkinWt = uniqueGeo.attributes.skinWeight ? uniqueGeo.attributes.skinWeight.array.slice() : null;
    const prevSkeleton = isAlreadySkinned ? srcMesh.skeleton : null;
    const prevBindMatrix = isAlreadySkinned ? srcMesh.bindMatrix.clone() : null;

    const { skinIndex, skinWeight } = computeAutoSkinWeights(
      uniqueGeo,
      srcMesh.matrixWorld,
      orderedBones,
      options.weightOptions
    );
    uniqueGeo.setAttribute('skinIndex', skinIndex, 4);
    uniqueGeo.setAttribute('skinWeight', skinWeight, 4);

    let targetSkinned = srcMesh;
    if (!isAlreadySkinned) {
      targetSkinned = new SkinnedMesh(uniqueGeo, srcMesh.material);
      targetSkinned.name = srcMesh.name;
      targetSkinned.position.copy(srcMesh.position);
      targetSkinned.quaternion.copy(srcMesh.quaternion);
      targetSkinned.scale.copy(srcMesh.scale);
      if (srcMesh.pivot && targetSkinned.pivot) targetSkinned.pivot.copy(srcMesh.pivot);
      targetSkinned.castShadow = srcMesh.castShadow;
      targetSkinned.receiveShadow = srcMesh.receiveShadow;
      targetSkinned.visible = srcMesh.visible;
      targetSkinned.frustumCulled = srcMesh.frustumCulled;
      targetSkinned.renderOrder = srcMesh.renderOrder;
      if (srcMesh.userData) targetSkinned.userData = { ...srcMesh.userData };
      replaceObjectInHierarchy(srcMesh, targetSkinned, onReplaceMesh);
      replaceMap.set(srcMesh, targetSkinned);
    }

    const skeleton = new Skeleton(orderedBones);
    targetSkinned.bind(skeleton, targetSkinned.matrixWorld.clone());
    targetSkinned.refreshSkinning();

    records.push({
      srcMesh,
      targetSkinned,
      parent,
      replaced: !isAlreadySkinned,
      prevGeo,
      uniqueGeo,
      prevSkinIdx,
      prevSkinWt,
      afterSkinIdx: skinIndex.slice(),
      afterSkinWt: skinWeight.slice(),
      prevSkeleton,
      prevBindMatrix,
      afterSkeleton: skeleton,
      afterBindMatrix: targetSkinned.bindMatrix.clone(),
    });
  }

  const undo = () => {
    const undoMap = new Map();
    for (const rec of records) {
      if (rec.replaced) {
        replaceObjectInHierarchy(rec.targetSkinned, rec.srcMesh, onReplaceMesh);
        undoMap.set(rec.targetSkinned, rec.srcMesh);
      }
      const geo = rec.srcMesh.geometry;
      if (rec.srcMesh.geometry !== rec.prevGeo) {
        if (typeof rec.srcMesh.setGeometry === 'function') rec.srcMesh.setGeometry(rec.prevGeo);
        else rec.srcMesh.geometry = rec.prevGeo;
      }
      if (geo === rec.uniqueGeo) {
        if (rec.prevSkinIdx) geo.setAttribute('skinIndex', rec.prevSkinIdx.slice(), 4);
        else delete geo.attributes.skinIndex;
        if (rec.prevSkinWt) geo.setAttribute('skinWeight', rec.prevSkinWt.slice(), 4);
        else delete geo.attributes.skinWeight;
      }
      if (!rec.replaced && rec.srcMesh.isSkinnedMesh) {
        if (rec.prevSkeleton) rec.srcMesh.bind(rec.prevSkeleton, rec.prevBindMatrix);
        else rec.srcMesh.skeleton = null;
        rec.srcMesh.refreshSkinning();
      }
    }
    return undoMap;
  };

  const redo = () => {
    for (const rec of records) {
      if (rec.replaced) {
        replaceObjectInHierarchy(rec.srcMesh, rec.targetSkinned, onReplaceMesh);
      }
      const mesh = rec.targetSkinned;
      if (mesh.geometry !== rec.uniqueGeo) {
        if (typeof mesh.setGeometry === 'function') mesh.setGeometry(rec.uniqueGeo);
        else mesh.geometry = rec.uniqueGeo;
      }
      rec.uniqueGeo.setAttribute('skinIndex', rec.afterSkinIdx.slice(), 4);
      rec.uniqueGeo.setAttribute('skinWeight', rec.afterSkinWt.slice(), 4);
      for (const b of rec.afterSkeleton.bones) b.updateWorldMatrix(true, false);
      mesh.bind(rec.afterSkeleton, rec.afterBindMatrix);
      mesh.refreshSkinning();
    }
    return replaceMap;
  };

  return {
    ok: true,
    records,
    bones: orderedBones,
    primarySkinned: records[0]?.targetSkinned || null,
    replaceMap,
    undo,
    redo,
  };
}

/**
 * Herramienta interactiva de rigging y pintura de pesos de Made3D.
 *
 * Encapsula toda la lógica de dominio sin depender del DOM del editor:
 * - Creación rápida de huesos en cadena, espejo (`_L` / `_R`) e imán centrado dentro de la malla.
 * - Cálculo automático de pesos (`computeAutoSkinWeights`) y fijado a `SkinnedMesh` (`bindRig`).
 * - Pintura y borrado de pesos con mapa de calor por vértice (`applyWeightBrushAt`).
 * - Dibujo del overlay 2D de huesos y brocha, y manejo opcional de eventos de puntero vía `attach()`.
 */
export class Rigger {
  constructor(opts = {}) {
    this.enabled = Boolean(opts.enabled);
    this.boneTool = Boolean(opts.boneTool);
    this.mirror = Boolean(opts.mirror);
    this.magnet = Boolean(opts.magnet);
    this.weightPaint = Boolean(opts.weightPaint);
    this.weightBrushMode = opts.weightBrushMode === 'erase' || opts.weightBrushMode === 'smooth'
      ? opts.weightBrushMode
      : (opts.eraser ? 'erase' : 'paint');
    this.brushSize = opts.brushSize ?? 0.4;
    this.brushStrength = opts.brushStrength ?? 0.42;

    this.activeTipBone = null;
    this.activeTipAttach = 'head';
    this.selectedBone = null;
    this.hover = null;
    this.isPainting = false;

    this._mirrorPairs = new WeakMap();
    this._savedWeightState = new WeakMap();
    this._pointers = new Set();
    this._pointerState = null;
    this._attached = null;
    this._cleanup = null;
  }

  get eraser() {
    return this.weightBrushMode === 'erase';
  }

  set eraser(on) {
    if (on) this.weightBrushMode = 'erase';
    else if (this.weightBrushMode === 'erase') this.weightBrushMode = 'paint';
  }

  static isRigMesh(m) {
    return Boolean(
      m &&
        m.isMesh &&
        m.geometry?.attributes?.position &&
        !m.isFloor &&
        !m.isInstancedMesh &&
        !(m.isHelper?.() || m.isGridHelper || m.isCameraHelper || m.isSkeletonHelper)
    );
  }

  static isSkinnedWithWeights(mesh) {
    return Boolean(
      mesh &&
        mesh.isSkinnedMesh &&
        mesh.skeleton &&
        mesh.skeleton.bones &&
        mesh.skeleton.bones.length > 0 &&
        mesh.geometry?.attributes?.skinIndex &&
        mesh.geometry?.attributes?.skinWeight
    );
  }

  static hasChildBone(bone) {
    return Boolean(bone && bone.children && bone.children.some((c) => c.isBone && c.visible !== false));
  }

  static collectMeshes(root) {
    const out = [];
    const seen = new Set();
    if (!root || !root.traverse) return out;
    root.traverse((n) => {
      if (seen.has(n)) return;
      if (Rigger.isRigMesh(n)) {
        seen.add(n);
        out.push(n);
      }
    });
    return out;
  }

  static collectBones(root, extraMeshes = []) {
    const out = [];
    const seen = new Set();
    const walk = (n) => {
      if (!n || seen.has(n)) return;
      if (n.isBone) {
        seen.add(n);
        out.push(n);
      }
      if (n.children) {
        for (let i = 0; i < n.children.length; i++) walk(n.children[i]);
      }
    };
    if (root) walk(root);
    if (Array.isArray(extraMeshes)) {
      for (const sm of extraMeshes) {
        if (!sm?.skeleton?.bones) continue;
        for (const b of sm.skeleton.bones) {
          if (b && b.isBone && !seen.has(b)) {
            seen.add(b);
            out.push(b);
          }
        }
      }
    }
    return out;
  }

  static collectContext(root, selected = null, isNodeValid = null) {
    if (!root) {
      return {
        root: null,
        mesh: null,
        meshes: [],
        skinnedMeshes: [],
        allBones: [],
        hasSkinnedWeights: false,
      };
    }
    const meshes = Rigger.collectMeshes(root);
    const skinnedMeshes = meshes.filter(Rigger.isSkinnedWithWeights);
    let primaryMesh = null;
    if (selected && Rigger.isRigMesh(selected) && meshes.includes(selected)) {
      primaryMesh = selected;
    } else if (skinnedMeshes.length) {
      primaryMesh = skinnedMeshes[0];
    } else if (meshes.length) {
      primaryMesh = meshes[0];
    }

    let allBones = Rigger.collectBones(root, skinnedMeshes);
    if (typeof isNodeValid === 'function') {
      allBones = allBones.filter(isNodeValid);
    }

    return {
      root,
      mesh: primaryMesh,
      meshes,
      skinnedMeshes,
      allBones,
      hasSkinnedWeights: skinnedMeshes.length > 0,
    };
  }

  static worldToRootLocal(root, worldPt, out = new Vec3()) {
    root.updateWorldMatrix(true, false);
    _invMat.copyInverse(root.matrixWorld);
    return out.copy(worldPt).applyMatrix4(_invMat);
  }

  static rootLocalToWorld(root, localPt, out = new Vec3()) {
    root.updateWorldMatrix(true, false);
    return out.copy(localPt).applyMatrix4(root.matrixWorld);
  }

  static mirrorWorldPoint(root, worldPt, out = new Vec3()) {
    const local = Rigger.worldToRootLocal(root, worldPt, _vC);
    local.x = -local.x;
    return Rigger.rootLocalToWorld(root, local, out);
  }

  static getMirrorCenterThreshold(root, primaryMesh = null) {
    const m = primaryMesh || root;
    if (!m) return 0.025;
    const geo = primaryMesh?.geometry;
    if (geo) {
      const bb = geo.getBoundingBox?.();
      if (bb) {
        const spanX = Math.abs(bb.max.x - bb.min.x);
        return Math.max(0.015, spanX * 0.028);
      }
    }
    return 0.025;
  }

  static isPointOnMirrorCenter(root, worldPt, primaryMesh = null) {
    if (!root) return true;
    const local = Rigger.worldToRootLocal(root, worldPt, _vC);
    return Math.abs(local.x) <= Rigger.getMirrorCenterThreshold(root, primaryMesh);
  }

  static orientBoneWorld(bone, worldHead, worldTail) {
    const parent = bone.parent;
    if (parent) parent.updateWorldMatrix(true, false);
    const invParent = parent ? _invMat.copyInverse(parent.matrixWorld) : _invMat.identity();

    const lh = _vC.copy(worldHead).applyMatrix4(invParent);
    const lt = _vD.copy(worldTail).applyMatrix4(invParent);
    bone.position.copy(lh);

    const dx = lt.x - lh.x;
    const dy = lt.y - lh.y;
    const dz = lt.z - lh.z;
    const len = Math.hypot(dx, dy, dz);

    if (len > 1e-5) {
      _vA.set(dx / len, dy / len, dz / len);
      quatFromUnitVectors(_upY, _vA, bone.quaternion);
      bone.length = len;
    } else {
      bone.quaternion.identity();
      bone.length = 0;
    }
    bone.updateMatrixWorld(true, false);
    return bone;
  }

  static setBoneWorldPosition(bone, worldPt, keepWorldRotation = false) {
    if (!bone || !worldPt) return bone;
    const parent = bone.parent;
    if (parent) parent.updateWorldMatrix(true, false);
    if (keepWorldRotation) {
      bone.updateWorldMatrix(true, false);
      bone.getWorldQuaternion(_qB);
    }
    const invParent = parent ? _invMat.copyInverse(parent.matrixWorld) : _invMat.identity();
    bone.position.copy(worldPt).applyMatrix4(invParent);
    if (keepWorldRotation) {
      if (parent) {
        parent.getWorldQuaternion(_qA);
        _qA.invert();
        bone.quaternion.copy(_qB).premultiply(_qA);
      } else {
        bone.quaternion.copy(_qB);
      }
    }
    bone.updateMatrixWorld(true, true);
    return bone;
  }

  static getBoneTipWorld(bone, attach = 'tail', out = new Vec3()) {
    if (!bone) return out.set(0, 0, 0);
    bone.updateWorldMatrix(true, false);
    if (attach === 'head') return out.setFromMatrixPosition(bone.matrixWorld);
    if (bone.length > 1e-6) {
      return out.set(0, bone.length, 0).applyMatrix4(bone.matrixWorld);
    }
    return bone.getWorldTail(out);
  }

  static pickSurface(camera, ndcX, ndcY, meshes, { magnet = false } = {}) {
    if (!camera || !meshes || !meshes.length) return null;
    _raycaster.setFromCamera({ x: ndcX, y: ndcY }, camera);
    const hits = _raycaster.intersectObjects(meshes, false);
    if (!hits.length) return null;

    const first = hits[0];
    const hitMesh = first.object;
    const finalPoint = first.point.clone();

    if (magnet && hitMesh) {
      const mats = Array.isArray(hitMesh.material) ? hitMesh.material : [hitMesh.material];
      const prevSides = mats.map((m) => (m ? m.side : 'front'));
      const doubleHits = [];
      try {
        for (const m of mats) if (m) m.side = 'double';
        _raycaster.intersectObject(hitMesh, false, doubleHits);
      } finally {
        mats.forEach((m, i) => {
          if (m) m.side = prevSides[i];
        });
      }

      if (doubleHits.length >= 2) {
        const entry = doubleHits[0];
        let exit = null;
        for (let i = 1; i < doubleHits.length; i++) {
          if (doubleHits[i].distance > entry.distance + 1e-4) {
            exit = doubleHits[i];
            break;
          }
        }
        if (exit) {
          finalPoint.copy(entry.point).add(exit.point).multiplyScalar(0.5);
        }
      } else if (first.normal) {
        const n = first.normal;
        const inwardOrigin = first.point.clone().addScaledVector(n, -1e-3);
        const inwardDir = n.clone().multiplyScalar(-1);
        const prevRayOrigin = _raycaster.ray.origin.clone();
        const prevRayDir = _raycaster.ray.direction.clone();
        _raycaster.set(inwardOrigin, inwardDir);
        const backHits = [];
        const prevSides2 = mats.map((m) => (m ? m.side : 'front'));
        try {
          for (const m of mats) if (m) m.side = 'double';
          _raycaster.intersectObject(hitMesh, false, backHits);
        } finally {
          mats.forEach((m, i) => {
            if (m) m.side = prevSides2[i];
          });
          _raycaster.set(prevRayOrigin, prevRayDir);
        }
        if (backHits.length) {
          const bs = hitMesh.geometry?.getBoundingSphere?.();
          const maxThick = bs ? bs.radius * 2.2 * hitMesh.matrixWorld.getMaxScale() : 50;
          const exit = backHits.find((h) => h.distance > 1e-4 && h.distance <= maxThick);
          if (exit) {
            finalPoint.copy(first.point).add(exit.point).multiplyScalar(0.5);
          }
        }
      }
    }

    return {
      point: finalPoint,
      surfacePoint: first.point.clone(),
      normal: first.normal ? first.normal.clone() : new Vec3(0, 1, 0),
      mesh: hitMesh,
    };
  }

  static getScreenEndpoints(bones, camera, W, H) {
    const endpoints = [];
    const p = { x: 0, y: 0, w: 0 };
    if (!bones || !bones.length || !camera) return endpoints;
    for (const b of bones) {
      if (!b || !b.visible) continue;
      b.updateWorldMatrix(true, false);
      const headPos = _vB.setFromMatrixPosition(b.matrixWorld);
      projectPoint(headPos, camera, W, H, p);
      const parentIsBone = Boolean(b.parent && b.parent.isBone);
      const isLeaf = !Rigger.hasChildBone(b);
      if (p.w > 0.01) {
        endpoints.push({
          bone: b,
          attach: 'head',
          displayBone: b,
          x: p.x,
          y: p.y,
          isTip: isLeaf,
          isRootHead: !parentIsBone,
          isTail: false,
        });
      }
      if (isLeaf && b.length > 1e-5) {
        const tailPos = Rigger.getBoneTipWorld(b, 'tail', _vB);
        projectPoint(tailPos, camera, W, H, p);
        if (p.w > 0.01) {
          endpoints.push({
            bone: b,
            attach: 'tail',
            displayBone: b,
            x: p.x,
            y: p.y,
            isTip: true,
            isRootHead: false,
            isTail: true,
          });
        }
      }
    }
    return endpoints;
  }

  static pickEndpoint2D(localX, localY, W, H, camera, bones, { touch = false } = {}) {
    if (!camera || !bones || !bones.length) return null;
    const endpoints = Rigger.getScreenEndpoints(bones, camera, W, H);
    const tol = touch ? 22 : 13;

    let best = null;
    let bestScore = Infinity;
    for (const ep of endpoints) {
      const d = Math.hypot(localX - ep.x, localY - ep.y);
      if (d > tol) continue;
      const score = d - (ep.isTip ? 2.5 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = ep;
      }
    }
    return best;
  }

  static pickBoneSegment2D(localX, localY, W, H, camera, bones, { touch = false } = {}) {
    if (!camera || !bones || !bones.length) return null;
    const boneSet = new Set(bones);
    const tol = touch ? 18 : 11;
    const pA = { x: 0, y: 0, w: 0 };
    const pB = { x: 0, y: 0, w: 0 };

    let bestBone = null;
    let bestDist = Infinity;

    for (const b of bones) {
      if (!b || !b.visible) continue;
      b.updateWorldMatrix(true, false);
      const hb = _vC.setFromMatrixPosition(b.matrixWorld);

      if (b.parent && b.parent.isBone && boneSet.has(b.parent)) {
        b.parent.updateWorldMatrix(true, false);
        const hp = _vD.setFromMatrixPosition(b.parent.matrixWorld);
        if (projectSegment(hp.x, hp.y, hp.z, hb.x, hb.y, hb.z, camera, W, H, pA, pB)) {
          const { d } = pointSegment2D(localX, localY, pA.x, pA.y, pB.x, pB.y);
          if (d <= tol && d < bestDist) {
            bestDist = d;
            bestBone = b.parent;
          }
        }
      }

      if (!Rigger.hasChildBone(b) && b.length > 1e-5) {
        const tb = Rigger.getBoneTipWorld(b, 'tail', _vD);
        if (projectSegment(hb.x, hb.y, hb.z, tb.x, tb.y, tb.z, camera, W, H, pA, pB)) {
          const { d } = pointSegment2D(localX, localY, pA.x, pA.y, pB.x, pB.y);
          if (d <= tol && d < bestDist) {
            bestDist = d;
            bestBone = b;
          }
        }
      }
    }
    return bestBone;
  }

  _nextBoneName(bones, suffix = '') {
    const existing = new Set((bones || []).map((b) => b.name));
    let idx = (bones?.length || 0) + 1;
    while (existing.has(`Hueso ${idx}${suffix}`)) idx++;
    return `Hueso ${idx}${suffix}`;
  }

  _isNodeAlive(node) {
    if (!node) return false;
    const cfg = this._attached;
    if (cfg && typeof cfg.isNodeAlive === 'function') {
      return Boolean(cfg.isNodeAlive(node));
    }
    const scene = cfg && typeof cfg.getScene === 'function' ? cfg.getScene() : cfg?.scene;
    if (!scene) return true;
    let cur = node;
    while (cur) {
      if (cur === scene) return true;
      cur = cur.parent;
    }
    return false;
  }

  _invalidateScene(opts = {}) {
    const cfg = this._attached || {};
    const scene = opts.scene || (typeof cfg.getScene === 'function' ? cfg.getScene() : cfg.scene);
    const gizmo = opts.gizmo || (typeof cfg.getGizmo === 'function' ? cfg.getGizmo() : cfg.gizmo);
    const picker = opts.picker || (typeof cfg.getPicker === 'function' ? cfg.getPicker() : cfg.picker);
    const mixer = opts.mixer || (typeof cfg.getMixer === 'function' ? cfg.getMixer() : cfg.mixer);
    SkeletonHelper.invalidateScene(scene, { gizmo, picker, mixer });
    if (typeof cfg.onInvalidate === 'function') cfg.onInvalidate();
  }

  _emitStatus(msg, isWarn = false) {
    if (msg && this._attached && typeof this._attached.onStatus === 'function') {
      this._attached.onStatus(msg, isWarn);
    }
  }

  _emitStateChange() {
    if (this._attached && typeof this._attached.onStateChange === 'function') {
      this._attached.onStateChange(this);
    }
  }

  setBrushSize(v) {
    const num = Number(v);
    if (!Number.isFinite(num)) return this.brushSize;
    this.brushSize = clamp(num, 0.05, 3.0);
    return this.brushSize;
  }

  setBrushStrength(v) {
    const num = Number(v);
    if (!Number.isFinite(num)) return this.brushStrength;
    this.brushStrength = clamp(num, 0.01, 1.0);
    return this.brushStrength;
  }

  setMirror(on) {
    this.mirror = Boolean(on);
    return this.mirror;
  }

  setMagnet(on) {
    this.magnet = Boolean(on);
    return this.magnet;
  }

  setWeightBrushMode(mode) {
    this.weightBrushMode = mode === 'erase' || mode === 'smooth' ? mode : 'paint';
    return this.weightBrushMode;
  }

  setEraser(on) {
    this.setWeightBrushMode(on ? 'erase' : 'paint');
    return this.eraser;
  }

  resolveMirrorBone(bone, bones = [], root = null, primaryMesh = null) {
    if (!bone || !bones || !bones.length) return null;
    const boneSet = new Set(bones);

    const paired = this._mirrorPairs.get(bone);
    if (paired && boneSet.has(paired) && this._isNodeAlive(paired)) {
      return paired;
    }

    const name = typeof bone.name === 'string' ? bone.name : '';
    if (name) {
      const candidates = new Set();
      const suffixMatch = name.match(/^(.*)([._:\-\s])([LlRr])$/);
      if (suffixMatch) {
        const opp = suffixMatch[3] === 'L' ? 'R' : suffixMatch[3] === 'R' ? 'L' : suffixMatch[3] === 'l' ? 'r' : 'l';
        candidates.add(`${suffixMatch[1]}${suffixMatch[2]}${opp}`);
      }
      const prefixMatch = name.match(/^([LlRr])([._:\-\s])(.*)$/);
      if (prefixMatch) {
        const opp = prefixMatch[1] === 'L' ? 'R' : prefixMatch[1] === 'R' ? 'L' : prefixMatch[1] === 'l' ? 'r' : 'l';
        candidates.add(`${opp}${prefixMatch[2]}${prefixMatch[3]}`);
      }
      const wordMatch = name.replace(/(Left|Right|LEFT|RIGHT|left|right|Izq|Der|IZQ|DER|izq|der)/g, (tok) => {
        if (tok === 'Left') return 'Right';
        if (tok === 'Right') return 'Left';
        if (tok === 'LEFT') return 'RIGHT';
        if (tok === 'RIGHT') return 'LEFT';
        if (tok === 'left') return 'right';
        if (tok === 'right') return 'left';
        if (tok === 'Izq') return 'Der';
        if (tok === 'Der') return 'Izq';
        if (tok === 'IZQ') return 'DER';
        if (tok === 'DER') return 'IZQ';
        if (tok === 'izq') return 'der';
        return 'izq';
      });
      if (wordMatch !== name) candidates.add(wordMatch);

      if (candidates.size > 0) {
        for (const cand of bones) {
          if (cand && cand !== bone && candidates.has(cand.name)) {
            return cand;
          }
        }
      }
    }

    const refRoot = root || primaryMesh;
    if (refRoot) {
      bone.updateWorldMatrix(true, false);
      const boneWorld = bone.getWorldPosition(new Vec3());
      const localBone = Rigger.worldToRootLocal(refRoot, boneWorld, new Vec3());
      const centerThresh = Rigger.getMirrorCenterThreshold(refRoot, primaryMesh);
      if (Math.abs(localBone.x) <= centerThresh) {
        return bone;
      }

      const targetLocalX = -localBone.x;
      const targetLocalY = localBone.y;
      const targetLocalZ = localBone.z;
      const maxTolerance = Math.max(0.15, Math.abs(localBone.x) * 0.65);
      let bestBone = null;
      let bestDist = Infinity;

      for (const cand of bones) {
        if (!cand || cand === bone || !cand.isBone) continue;
        cand.updateWorldMatrix(true, false);
        const candLocal = Rigger.worldToRootLocal(refRoot, cand.getWorldPosition(_vD), _vC);
        const dist = Math.hypot(
          candLocal.x - targetLocalX,
          candLocal.y - targetLocalY,
          candLocal.z - targetLocalZ
        );
        if (dist <= maxTolerance && dist < bestDist) {
          bestDist = dist;
          bestBone = cand;
        }
      }
      if (bestBone) return bestBone;
    }

    return null;
  }

  applyWeightBrushStrokeAt(skMesh, hitPoint, bone, root = null) {
    if (!skMesh || !hitPoint) return false;
    const mode = this.weightBrushMode;
    if (mode !== 'smooth' && !bone) return false;

    let anyChanged = applyWeightBrushAt(
      skMesh,
      hitPoint,
      bone,
      this.brushSize,
      this.brushStrength,
      mode,
      { refreshHeatmap: true }
    );

    if (this.mirror) {
      const mirrorRoot = root || skMesh;
      const mirrorPt = Rigger.mirrorWorldPoint(mirrorRoot, hitPoint, new Vec3());
      const overlapCenter = hitPoint.distanceTo(mirrorPt) < this.brushSize * 0.35;
      const bones = skMesh.skeleton?.bones || [];

      if (mode === 'smooth') {
        if (!overlapCenter) {
          const mirrorChanged = applyWeightBrushAt(
            skMesh,
            mirrorPt,
            bone,
            this.brushSize,
            this.brushStrength,
            'smooth',
            { refreshHeatmap: true }
          );
          if (mirrorChanged) anyChanged = true;
        }
      } else {
        const mirrorBone = this.resolveMirrorBone(bone, bones, mirrorRoot, skMesh);
        if (mirrorBone && !(mirrorBone === bone && overlapCenter)) {
          const mirrorChanged = applyWeightBrushAt(
            skMesh,
            mirrorPt,
            mirrorBone,
            this.brushSize,
            this.brushStrength,
            mode,
            { refreshHeatmap: mirrorBone === bone }
          );
          if (mirrorChanged) {
            anyChanged = true;
            if (mirrorBone !== bone) {
              updateMeshWeightHeatmap(skMesh, bone);
            }
          }
        }
      }
    }

    return anyChanged;
  }

  setBoneTool(on, sceneForRestore = null) {
    const next = Boolean(on);
    this.boneTool = next;
    if (next && this.weightPaint) {
      this.weightPaint = false;
      this.hover = null;
      this.restoreWeightPaint(sceneForRestore);
    }
    return this.boneTool;
  }

  setWeightPaint(on, context = null, sceneForRestore = null) {
    const next = Boolean(on);
    if (next) {
      if (!context || !context.hasSkinnedWeights) {
        return { ok: false, message: 'Fija primero un esqueleto a la malla para editar sus pesos.' };
      }
      this.boneTool = false;
      this.weightPaint = true;
      this.enterWeightPaint(context);
      return {
        ok: true,
        message: `Pesos activo (${this.selectedBone?.name || 'Hueso'}). Pinta en la malla o toca otro hueso.`,
      };
    }
    this.weightPaint = false;
    this.hover = null;
    this.restoreWeightPaint(sceneForRestore || context?.skinnedMeshes);
    return { ok: true, message: 'Editor de pesos cerrado.' };
  }

  enterWeightPaint(context) {
    if (!context || !context.hasSkinnedWeights) return false;

    if (!this.selectedBone || !context.skinnedMeshes.some((sm) => sm.skeleton.bones.includes(this.selectedBone))) {
      this.selectedBone = context.skinnedMeshes[0]?.skeleton?.bones?.[0] || null;
    }

    for (const sm of context.skinnedMeshes) {
      const vCount = sm.geometry?.attributes?.position?.count || 0;
      let saved = this._savedWeightState.get(sm);
      if (!saved) {
        const origColorAttr = sm.geometry?.attributes?.color || null;
        const heatmapAttr = new BufferAttribute(new Float32Array(vCount * 3), 3);
        saved = {
          material: sm.material,
          colorAttr: origColorAttr,
          heatmapAttr,
        };
        this._savedWeightState.set(sm, saved);
        sm.material = new StandardMaterial({
          color: 0xffffff,
          vertexColors: true,
          shininess: 16,
        });
      } else if (!saved.heatmapAttr || saved.heatmapAttr.count !== vCount) {
        saved.heatmapAttr = new BufferAttribute(new Float32Array(vCount * 3), 3);
      }
      if (sm.geometry) {
        sm.geometry.attributes.color = saved.heatmapAttr;
      }
      updateMeshWeightHeatmap(sm, this.selectedBone);
    }
    return true;
  }

  restoreWeightPaint(sceneOrMeshes = null) {
    const restoreNode = (n) => {
      if (!n) return;
      const saved = this._savedWeightState.get(n);
      if (!saved) return;
      n.material = saved.material;
      if (n.geometry) {
        if (saved.colorAttr) {
          n.geometry.attributes.color = saved.colorAttr;
          saved.colorAttr.needsUpdate = true;
        } else {
          delete n.geometry.attributes.color;
        }
      }
      this._savedWeightState.delete(n);
    };

    const target = sceneOrMeshes
      || (this._attached && (typeof this._attached.getScene === 'function' ? this._attached.getScene() : this._attached.scene));
    if (!target) return;
    if (Array.isArray(target)) {
      for (const m of target) restoreNode(m);
    } else if (typeof target.traverse === 'function') {
      target.traverse(restoreNode);
    } else {
      restoreNode(target);
    }
  }

  refreshHeatmaps(context) {
    if (!this.weightPaint || !context) return false;
    for (const sm of context.skinnedMeshes) {
      if (this._savedWeightState.has(sm)) {
        updateMeshWeightHeatmap(sm, this.selectedBone);
      }
    }
    return true;
  }

  selectWeightBone(bone, context = null) {
    if (!bone || !bone.isBone) return false;
    this.selectedBone = bone;
    if (context) this.refreshHeatmaps(context);
    return true;
  }

  beginWeightStroke(skMesh) {
    if (!skMesh || !skMesh.geometry) return null;
    const si = skMesh.geometry.attributes.skinIndex;
    const sw = skMesh.geometry.attributes.skinWeight;
    if (!si || !sw) return null;
    return {
      skMesh,
      beforeIdx: si.array.slice(),
      beforeWt: sw.array.slice(),
      changed: false,
    };
  }

  endWeightStroke(stroke, opts = {}) {
    if (!stroke || !stroke.changed) return null;
    const skMesh = stroke.skMesh;
    const geo = skMesh.geometry;
    const afterIdx = geo.attributes.skinIndex.array.slice();
    const afterWt = geo.attributes.skinWeight.array.slice();
    const beforeIdx = stroke.beforeIdx;
    const beforeWt = stroke.beforeWt;
    const getContext = typeof opts.getContext === 'function' ? opts.getContext : null;

    const applyArrays = (idxArr, wtArr) => {
      const si = geo.attributes.skinIndex;
      const sw = geo.attributes.skinWeight;
      if (!si || !sw) return;
      si.array.set(idxArr);
      sw.array.set(wtArr);
      si.needsUpdate = true;
      sw.needsUpdate = true;
      skMesh.refreshSkinning();
      const ctx = getContext ? getContext() : null;
      if (ctx) this.refreshHeatmaps(ctx);
      else if (this.weightPaint) updateMeshWeightHeatmap(skMesh, this.selectedBone);
    };

    const label = this.weightBrushMode === 'erase'
      ? 'Borrar pesos'
      : this.weightBrushMode === 'smooth'
      ? 'Suavizar pesos'
      : 'Pintar pesos';

    return {
      type: 'weightPaint',
      label,
      undo: () => applyArrays(beforeIdx, beforeWt),
      redo: () => applyArrays(afterIdx, afterWt),
    };
  }

  tapBoneTool(localX, localY, W, H, camera, context, opts = {}) {
    const touch = Boolean(opts.touch);
    if (!context || !context.mesh) {
      return { action: 'noMesh', isWarn: true, message: 'Agrega o selecciona una malla primero para crear huesos.' };
    }

    const activeTip = this.activeTipBone && this._isNodeAlive(this.activeTipBone) ? this.activeTipBone : null;

    const ep = Rigger.pickEndpoint2D(localX, localY, W, H, camera, context.allBones, { touch });
    if (ep) {
      if (activeTip && ep.bone === activeTip && (!ep.isTail || this.activeTipAttach === 'tail')) {
        this.activeTipBone = null;
        this.activeTipAttach = 'head';
        return {
          action: 'deselectTip',
          message: 'Hueso deseleccionado. Toca la malla para crear un hueso independiente o toca otro hueso.',
        };
      }

      // Conectar dos huesos si hay un hueso activo y el tocado es un hueso raíz independiente sin ciclo
      if (
        activeTip &&
        ep.bone !== activeTip &&
        !(ep.bone.parent && ep.bone.parent.isBone) &&
        !(activeTip._isAncestor && activeTip._isAncestor(ep.bone))
      ) {
        const connectSingle = (parentBone, targetBone) => {
          targetBone.updateWorldMatrix(true, false);
          const worldPos = targetBone.getWorldPosition(new Vec3());
          const beforeParent = targetBone.parent;
          const beforeIndex = beforeParent ? beforeParent.children.indexOf(targetBone) : -1;
          const beforePos = targetBone.position.clone();
          const beforeQuat = targetBone.quaternion.clone();
          const beforeScale = targetBone.scale.clone();

          parentBone.add(targetBone);
          Rigger.setBoneWorldPosition(targetBone, worldPos, true);

          return {
            bone: targetBone,
            beforeParent,
            beforeIndex,
            beforePos,
            beforeQuat,
            beforeScale,
            afterParent: parentBone,
            afterIndex: parentBone.children.indexOf(targetBone),
            afterPos: targetBone.position.clone(),
            afterQuat: targetBone.quaternion.clone(),
            afterScale: targetBone.scale.clone(),
          };
        };

        const recs = [connectSingle(activeTip, ep.bone)];

        if (this.mirror) {
          activeTip.updateWorldMatrix(true, false);
          const activeW = activeTip.getWorldPosition(new Vec3());
          let mParent = this._mirrorPairs.get(activeTip);
          if (!mParent && Rigger.isPointOnMirrorCenter(context.root, activeW, context.mesh)) {
            mParent = activeTip;
          }
          const mTarget = this._mirrorPairs.get(ep.bone);
          if (
            mParent &&
            mTarget &&
            this._isNodeAlive(mParent) &&
            this._isNodeAlive(mTarget) &&
            mParent !== mTarget &&
            mTarget !== ep.bone &&
            !(mTarget.parent && mTarget.parent.isBone) &&
            !(mParent._isAncestor && mParent._isAncestor(mTarget))
          ) {
            recs.push(connectSingle(mParent, mTarget));
          }
        }

        this.activeTipBone = ep.bone;
        this.activeTipAttach = 'head';
        this.selectedBone = ep.bone;
        this._invalidateScene(opts);

        const applyRec = (r, useAfter) => {
          const p = useAfter ? r.afterParent : r.beforeParent;
          const idx = useAfter ? r.afterIndex : r.beforeIndex;
          r.bone.removeFromParent();
          if (p) {
            const at = idx >= 0 ? Math.min(idx, p.children.length) : p.children.length;
            p.children.splice(at, 0, r.bone);
            r.bone.parent = p;
          }
          r.bone.position.copy(useAfter ? r.afterPos : r.beforePos);
          r.bone.quaternion.copy(useAfter ? r.afterQuat : r.beforeQuat);
          r.bone.scale.copy(useAfter ? r.afterScale : r.beforeScale);
          r.bone.updateMatrixWorld(true, true);
        };

        const command = {
          type: 'rigBoneConnect',
          label: 'Conectar huesos',
          undo: () => {
            for (let i = recs.length - 1; i >= 0; i--) applyRec(recs[i], false);
            this._invalidateScene(opts);
          },
          redo: () => {
            for (let i = 0; i < recs.length; i++) applyRec(recs[i], true);
            this._invalidateScene(opts);
          },
        };

        return {
          action: 'connectBones',
          bone: ep.bone,
          parentBone: activeTip,
          mirrorBone: recs[1]?.bone || null,
          command,
          message: `${activeTip.name} conectado con ${ep.bone.name}.`,
        };
      }

      this.activeTipBone = ep.bone;
      this.activeTipAttach = ep.attach || 'head';
      this.selectedBone = ep.bone;
      return {
        action: 'selectTip',
        bone: ep.bone,
        attach: this.activeTipAttach,
        message: `Hueso seleccionado (${ep.bone.name || 'Hueso'}). Toca la malla o un hueso libre para conectar.`,
      };
    }

    const ndcX = (localX / Math.max(1, W)) * 2 - 1;
    const ndcY = -(localY / Math.max(1, H)) * 2 + 1;
    const hit = Rigger.pickSurface(camera, ndcX, ndcY, context.meshes, { magnet: this.magnet });
    if (!hit) {
      if (this.activeTipBone) {
        this.activeTipBone = null;
        this.activeTipAttach = 'head';
        return {
          action: 'deselectTip',
          message: 'Hueso deseleccionado. Toca la malla o un hueso para seguir editando.',
        };
      }
      return {
        action: 'miss',
        message: 'Toca sobre la malla (no el vacío) para colocar un hueso.',
      };
    }

    const worldPt = hit.point;
    const parentContainer = context.meshes.length === 1 && context.mesh ? context.mesh : context.root;
    if (!parentContainer) return { action: 'noContainer' };

    // Caso A: Iniciar un hueso raíz independiente en worldPt (solo un punto)
    if (!activeTip) {
      const useMirror = this.mirror && !Rigger.isPointOnMirrorCenter(context.root, worldPt, context.mesh);
      const b0 = new Bone();
      b0.name = this._nextBoneName(context.allBones, useMirror ? '_L' : '');
      parentContainer.add(b0);
      Rigger.setBoneWorldPosition(b0, worldPt);

      const added = [{ obj: b0, parent: parentContainer, index: parentContainer.children.indexOf(b0) }];
      let bm = null;

      if (useMirror) {
        const mPt = Rigger.mirrorWorldPoint(context.root, worldPt, new Vec3());
        bm = new Bone();
        bm.name = b0.name.replace(/_L$/, '_R');
        parentContainer.add(bm);
        Rigger.setBoneWorldPosition(bm, mPt);
        this._mirrorPairs.set(b0, bm);
        this._mirrorPairs.set(bm, b0);
        added.push({ obj: bm, parent: parentContainer, index: parentContainer.children.indexOf(bm) });
      }

      this.activeTipBone = b0;
      this.activeTipAttach = 'head';
      this.selectedBone = b0;
      this._invalidateScene(opts);

      const command = {
        type: 'rigBoneAdd',
        label: 'Crear hueso',
        added,
        undo: () => {
          for (let i = added.length - 1; i >= 0; i--) {
            const { obj } = added[i];
            obj.removeFromParent();
          }
          this._invalidateScene(opts);
        },
        redo: () => {
          for (const { obj, parent, index } of added) {
            if (!parent.children.includes(obj)) {
              const at = index >= 0 ? Math.min(index, parent.children.length) : parent.children.length;
              parent.children.splice(at, 0, obj);
            }
            obj.parent = parent;
            obj.updateMatrixWorld(true, true);
          }
          this._invalidateScene(opts);
        },
      };

      return {
        action: 'startRoot',
        bone: b0,
        mirrorBone: bm,
        added,
        command,
        message: `${b0.name} colocado. Toca otro punto de la malla para crear y conectar el siguiente hueso.`,
      };
    }

    // Caso B: Crear nuevo hueso en worldPt y conectarlo al hueso activo (activeTip -> bChild)
    activeTip.updateWorldMatrix(true, false);
    const activeW = activeTip.getWorldPosition(new Vec3());
    const isSymmetricTarget = this.mirror && !Rigger.isPointOnMirrorCenter(context.root, worldPt, context.mesh);

    let mirrorParent = null;
    if (isSymmetricTarget) {
      const twin = this._mirrorPairs.get(activeTip);
      if (twin && this._isNodeAlive(twin)) {
        mirrorParent = twin;
      } else if (Rigger.isPointOnMirrorCenter(context.root, activeW, context.mesh)) {
        mirrorParent = activeTip;
      }
    }

    const bChild = new Bone();
    bChild.name = this._nextBoneName(context.allBones, mirrorParent ? '_L' : '');
    activeTip.add(bChild);
    Rigger.setBoneWorldPosition(bChild, worldPt);

    const added = [{ obj: bChild, parent: activeTip, index: activeTip.children.indexOf(bChild) }];
    let bMirror = null;

    if (mirrorParent) {
      const mPt = Rigger.mirrorWorldPoint(context.root, worldPt, new Vec3());
      bMirror = new Bone();
      bMirror.name = bChild.name.replace(/_L$/, '_R');
      mirrorParent.add(bMirror);
      Rigger.setBoneWorldPosition(bMirror, mPt);
      this._mirrorPairs.set(bChild, bMirror);
      this._mirrorPairs.set(bMirror, bChild);
      added.push({ obj: bMirror, parent: mirrorParent, index: mirrorParent.children.indexOf(bMirror) });
    }

    this.activeTipBone = bChild;
    this.activeTipAttach = 'head';
    this.selectedBone = bChild;
    this._invalidateScene(opts);

    const command = {
      type: 'rigBoneAdd',
      label: 'Crear hueso conectado',
      added,
      undo: () => {
        for (let i = added.length - 1; i >= 0; i--) {
          added[i].obj.removeFromParent();
        }
        this._invalidateScene(opts);
      },
      redo: () => {
        for (const { obj, parent, index } of added) {
          if (!parent.children.includes(obj)) {
            const at = index >= 0 ? Math.min(index, parent.children.length) : parent.children.length;
            parent.children.splice(at, 0, obj);
          }
          obj.parent = parent;
          obj.updateMatrixWorld(true, true);
        }
        this._invalidateScene(opts);
      },
    };

    return {
      action: 'chainChild',
      bone: bChild,
      mirrorBone: bMirror,
      added,
      command,
      message: `${bChild.name} conectado a ${activeTip.name}.`,
    };
  }

  bindRig(context, options = {}) {
    this.restoreWeightPaint(options.scene || context?.skinnedMeshes);

    if (!context || !context.meshes || !context.meshes.length) {
      return { ok: false, isWarn: true, message: 'No hay una malla válida en la escena para fijar el esqueleto.' };
    }
    if (!context.allBones || !context.allBones.length) {
      return { ok: false, isWarn: true, message: 'Crea primero al menos un hueso con la herramienta "Hueso".' };
    }

    const res = bindMeshesToSkeleton(context.meshes, context.allBones, options);
    if (!res.ok) {
      return { ok: false, isWarn: true, message: 'No se pudo fijar el esqueleto.' };
    }

    this.boneTool = false;
    this.activeTipBone = null;
    this._invalidateScene(options);

    const undo = () => {
      this.restoreWeightPaint(options.scene || context?.skinnedMeshes);
      const undoMap = res.undo();
      this._invalidateScene(options);
      return undoMap;
    };

    const redo = () => {
      this.restoreWeightPaint(options.scene || context?.skinnedMeshes);
      const redoMap = res.redo();
      this._invalidateScene(options);
      return redoMap;
    };

    return {
      ...res,
      undo,
      redo,
      message: `Esqueleto fijado con pesos automáticos (${res.bones.length} huesos). Listo para Pose o Pesos.`,
    };
  }

  drawBrushCircle2D(c, camera, W, H, center, normal, radius, modeOrErase = false) {
    let ax = 1, ay = 0, az = 0;
    if (Math.abs(normal.x) > 0.85) {
      ax = 0; ay = 1; az = 0;
    }
    let ux = ay * normal.z - az * normal.y;
    let uy = az * normal.x - ax * normal.z;
    let uz = ax * normal.y - ay * normal.x;
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul; uy /= ul; uz /= ul;
    const vx = normal.y * uz - normal.z * uy;
    const vy = normal.z * ux - normal.x * uz;
    const vz = normal.x * uy - normal.y * ux;

    const steps = 32;
    const p = { x: 0, y: 0, w: 0 };
    c.save();
    c.beginPath();
    let started = false;
    for (let i = 0; i <= steps; i++) {
      const th = (i / steps) * Math.PI * 2;
      const cs = Math.cos(th) * radius;
      const sn = Math.sin(th) * radius;
      _vC.set(
        center.x + ux * cs + vx * sn,
        center.y + uy * cs + vy * sn,
        center.z + uz * cs + vz * sn
      );
      projectPoint(_vC, camera, W, H, p);
      if (p.w <= 0.01) continue;
      if (!started) {
        c.moveTo(p.x, p.y);
        started = true;
      } else {
        c.lineTo(p.x, p.y);
      }
    }
    c.closePath();
    const mode = typeof modeOrErase === 'string' ? modeOrErase : (modeOrErase ? 'erase' : 'paint');
    c.lineWidth = 2.0;
    c.strokeStyle = mode === 'erase'
      ? 'rgba(248, 113, 113, 0.92)'
      : mode === 'smooth'
      ? 'rgba(56, 189, 248, 0.92)'
      : 'rgba(250, 204, 21, 0.92)';
    c.stroke();
    c.lineWidth = 1.0;
    c.strokeStyle = 'rgba(15, 17, 22, 0.65)';
    c.stroke();
    c.restore();
  }

  _drawBoneDiamond(c, ax, ay, bx, by, active) {
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    const strokeCol = active ? '#ffaa40' : '#5eead4';
    const fillCol = active ? 'rgba(255, 170, 64, 0.28)' : 'rgba(94, 234, 212, 0.18)';

    if (len >= 10) {
      const ux = dx / len;
      const uy = dy / len;
      const nx = -uy;
      const ny = ux;
      const k = clamp(len * 0.08, 2.5, active ? 5.6 : 4.2);
      const mx = ax + dx * 0.22;
      const my = ay + dy * 0.22;

      c.beginPath();
      c.moveTo(ax, ay);
      c.lineTo(mx + nx * k, my + ny * k);
      c.lineTo(bx, by);
      c.lineTo(mx - nx * k, my - ny * k);
      c.closePath();
      c.fillStyle = fillCol;
      c.fill();
      c.lineWidth = active ? 3.8 : 3.0;
      c.strokeStyle = 'rgba(10, 14, 20, 0.75)';
      c.stroke();
      c.lineWidth = active ? 2.1 : 1.5;
      c.strokeStyle = strokeCol;
      c.stroke();
    } else {
      c.beginPath();
      c.moveTo(ax, ay);
      c.lineTo(bx, by);
      c.lineWidth = 3.2;
      c.strokeStyle = 'rgba(10, 14, 20, 0.75)';
      c.stroke();
      c.lineWidth = 1.6;
      c.strokeStyle = strokeCol;
      c.stroke();
    }
  }

  drawOverlay(c, camera, W, H, bones = []) {
    if (!this.enabled || !camera || !(this.boneTool || this.weightPaint)) return false;

    if (bones && bones.length) {
      const boneSet = new Set(bones);
      const pA = { x: 0, y: 0, w: 0 };
      const pB = { x: 0, y: 0, w: 0 };

      c.save();
      c.lineCap = 'round';
      c.lineJoin = 'round';

      for (const b of bones) {
        if (!b || !b.visible) continue;
        b.updateWorldMatrix(true, false);
        const hb = _vC.setFromMatrixPosition(b.matrixWorld);

        if (b.parent && b.parent.isBone && boneSet.has(b.parent)) {
          b.parent.updateWorldMatrix(true, false);
          const hp = _vD.setFromMatrixPosition(b.parent.matrixWorld);
          if (projectSegment(hp.x, hp.y, hp.z, hb.x, hb.y, hb.z, camera, W, H, pA, pB)) {
            const isSel = this.weightPaint
              ? this.selectedBone === b.parent
              : this.activeTipBone === b.parent || this.selectedBone === b.parent;
            this._drawBoneDiamond(c, pA.x, pA.y, pB.x, pB.y, isSel);
          }
        }

        if (!Rigger.hasChildBone(b) && b.length > 1e-5) {
          const tb = Rigger.getBoneTipWorld(b, 'tail', _vD);
          if (projectSegment(hb.x, hb.y, hb.z, tb.x, tb.y, tb.z, camera, W, H, pA, pB)) {
            const isSel = this.weightPaint
              ? this.selectedBone === b
              : this.activeTipBone === b || this.selectedBone === b;
            this._drawBoneDiamond(c, pA.x, pA.y, pB.x, pB.y, isSel);
          }
        }
      }

      const endpoints = Rigger.getScreenEndpoints(bones, camera, W, H);
      for (const ep of endpoints) {
        const isSelectedTip =
          this.boneTool &&
          this.activeTipBone === ep.bone &&
          (!ep.isTail || this.activeTipAttach === 'tail');
        const isSelectedWeight =
          this.weightPaint &&
          this.selectedBone === ep.displayBone;

        const r = isSelectedTip ? 6.5 : ep.isTip ? 4.6 : 4.2;
        c.beginPath();
        c.arc(ep.x, ep.y, r, 0, Math.PI * 2);
        c.fillStyle = isSelectedTip || isSelectedWeight ? '#ffaa40' : ep.isTip ? '#5eead4' : '#38bdf8';
        c.strokeStyle = 'rgba(10, 14, 20, 0.9)';
        c.lineWidth = 1.6;
        c.fill();
        c.stroke();

        if (isSelectedTip) {
          c.beginPath();
          c.arc(ep.x, ep.y, 10, 0, Math.PI * 2);
          c.strokeStyle = 'rgba(255, 170, 64, 0.85)';
          c.lineWidth = 1.4;
          c.stroke();
        }
      }
      c.restore();
    }

    if (this.weightPaint && this.hover && this.hover.point && this.hover.normal) {
      this.drawBrushCircle2D(c, camera, W, H, this.hover.point, this.hover.normal, this.brushSize, this.weightBrushMode);
    }
    return true;
  }

  renderOverlay(canvas, camera, bones, opts = {}) {
    if (!canvas || !camera || !this.enabled) return false;
    const refEl = opts.referenceElement || canvas;
    const cssW = Math.max(1, opts.width || refEl.clientWidth || canvas.clientWidth || 1);
    const cssH = Math.max(1, opts.height || refEl.clientHeight || canvas.clientHeight || 1);
    const dpr = Math.min((typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1, opts.maxDpr ?? 2);
    const pw = Math.round(cssW * dpr);
    const ph = Math.round(cssH * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    this.drawOverlay(ctx, camera, cssW, cssH, bones);
    return true;
  }

  drawAttachedOverlay(camera) {
    const cfg = this._attached;
    if (!cfg || !cfg.overlay || !this.enabled || cfg.overlay.hidden || !camera) return false;
    const ctx = typeof cfg.getContext === 'function' ? cfg.getContext() : null;
    const bones = ctx?.allBones || [];
    return this.renderOverlay(cfg.overlay, camera, bones, {
      referenceElement: cfg.referenceElement || cfg.domElement,
    });
  }

  setEnabled(on) {
    const next = Boolean(on);
    if (!next) {
      if (this._pointerState?.weightStroke?.changed) {
        const cmd = this.endWeightStroke(this._pointerState.weightStroke, {
          getContext: this._attached?.getContext,
        });
        if (cmd) this._attached?.onHistoryCommand?.(cmd);
      }
      if (this._pointerState?.controlsPaused && this._attached) {
        const ctrl = typeof this._attached.getControls === 'function' ? this._attached.getControls() : this._attached.controls;
        const canEnable = typeof this._attached.getControlsEnabled === 'function' ? Boolean(this._attached.getControlsEnabled()) : true;
        if (ctrl) ctrl.enabled = canEnable;
      }
      this._pointerState = null;
      this._pointers.clear();
      this.isPainting = false;
      this.weightPaint = false;
      this.boneTool = false;
      this.hover = null;
      this.restoreWeightPaint();
    }
    this.enabled = next;
    const cfg = this._attached;
    if (cfg?.overlay) {
      cfg.overlay.hidden = !next;
      if (!next) {
        const c = cfg.overlay.getContext('2d');
        if (c) c.clearRect(0, 0, cfg.overlay.width, cfg.overlay.height);
      }
    }
    return this;
  }

  attach(opts = {}) {
    this.detach();
    const domElement = opts.domElement;
    if (!domElement || typeof domElement.addEventListener !== 'function') return this;

    this._attached = opts;

    const resolveTarget = () =>
      typeof opts.pointerDownTarget === 'function'
        ? opts.pointerDownTarget()
        : (opts.pointerDownTarget || domElement);
    const resolveCamera = () => (typeof opts.getCamera === 'function' ? opts.getCamera() : opts.camera);
    const resolveControls = () => (typeof opts.getControls === 'function' ? opts.getControls() : opts.controls);
    const resolveControlsEnabled = () =>
      typeof opts.getControlsEnabled === 'function' ? Boolean(opts.getControlsEnabled()) : true;
    const resolveContext = () => (typeof opts.getContext === 'function' ? opts.getContext() : null);
    const getDims = () => ({
      W: Math.max(1, (opts.referenceElement || domElement).clientWidth || 1),
      H: Math.max(1, (opts.referenceElement || domElement).clientHeight || 1),
    });

    const onPointerDown = (e) => {
      if (!this.enabled) return;
      const targetEl = resolveTarget();
      if (targetEl && e.target !== targetEl) return;
      this._pointers.add(e.pointerId);

      const ctrl = resolveControls();
      if (this._pointers.size > 1) {
        if (this._pointerState?.controlsPaused && ctrl) {
          ctrl.enabled = resolveControlsEnabled();
        }
        if (this._pointerState?.weightStroke?.changed) {
          const cmd = this.endWeightStroke(this._pointerState.weightStroke, { getContext: resolveContext });
          if (cmd) opts.onHistoryCommand?.(cmd);
        }
        this._pointerState = null;
        this.isPainting = false;
        return;
      }

      if (e.pointerType === 'mouse' && e.button !== 0) return;

      const [lx, ly] = clientToLocalPoint(opts.referenceElement || domElement, e);
      const isTouch = e.pointerType !== 'mouse';

      if (this.boneTool) {
        this._pointerState = {
          mode: 'bone',
          id: e.pointerId,
          startX: lx,
          startY: ly,
          moved: false,
          isTouch,
        };
        return;
      }

      if (this.weightPaint) {
        const ctx = resolveContext();
        const cam = resolveCamera();
        if (!ctx?.hasSkinnedWeights || !cam) return;

        const { W, H } = getDims();
        const boneEp = Rigger.pickEndpoint2D(lx, ly, W, H, cam, ctx.allBones, { touch: isTouch });
        const boneSeg = boneEp ? boneEp.displayBone : Rigger.pickBoneSegment2D(lx, ly, W, H, cam, ctx.allBones, { touch: isTouch });
        const ndcX = (lx / W) * 2 - 1;
        const ndcY = -(ly / H) * 2 + 1;
        const hit = Rigger.pickSurface(cam, ndcX, ndcY, ctx.skinnedMeshes, { magnet: false });

        if (!hit && !boneSeg) return;

        const controlsWereEnabled = ctrl ? ctrl.enabled : true;
        if (ctrl) {
          if (typeof ctrl.cancelPointer === 'function') ctrl.cancelPointer(e.pointerId);
          ctrl.enabled = false;
        }

        const stroke = hit ? this.beginWeightStroke(hit.mesh) : null;
        let paintedNow = false;
        if (hit && !boneSeg && stroke && (this.selectedBone || this.weightBrushMode === 'smooth')) {
          if (this.applyWeightBrushStrokeAt(hit.mesh, hit.point, this.selectedBone, ctx.root)) {
            stroke.changed = true;
            paintedNow = true;
          }
        }

        this.isPainting = Boolean(hit && !boneSeg);
        if (hit) this.hover = { point: hit.point, normal: hit.normal, mesh: hit.mesh };

        this._pointerState = {
          mode: 'weights',
          id: e.pointerId,
          startX: lx,
          startY: ly,
          moved: false,
          isTouch,
          boneCandidate: boneSeg,
          weightStroke: stroke,
          paintedNow,
          controlsPaused: Boolean(ctrl),
          controlsWereEnabled,
        };
      }
    };

    const onPointerMove = (e) => {
      if (!this.enabled) return;
      const cam = resolveCamera();
      if (!cam) return;
      const [lx, ly] = clientToLocalPoint(opts.referenceElement || domElement, e);
      const { W, H } = getDims();
      const ndcX = (lx / W) * 2 - 1;
      const ndcY = -(ly / H) * 2 + 1;

      if (this.weightPaint && !this._pointerState && e.pointerType === 'mouse') {
        const ctx = resolveContext();
        if (ctx?.hasSkinnedWeights) {
          const hit = Rigger.pickSurface(cam, ndcX, ndcY, ctx.skinnedMeshes, { magnet: false });
          this.hover = hit ? { point: hit.point, normal: hit.normal, mesh: hit.mesh } : null;
        }
      }

      if (!this._pointerState || this._pointerState.id !== e.pointerId) return;

      const dist = Math.hypot(lx - this._pointerState.startX, ly - this._pointerState.startY);
      if (dist > 6) this._pointerState.moved = true;

      if (this._pointerState.mode === 'weights' && this._pointerState.moved) {
        const ctx = resolveContext();
        const hit = ctx?.skinnedMeshes?.length
          ? Rigger.pickSurface(cam, ndcX, ndcY, ctx.skinnedMeshes, { magnet: false })
          : null;
        this.hover = hit ? { point: hit.point, normal: hit.normal, mesh: hit.mesh } : null;

        if (hit) {
          if (!this._pointerState.weightStroke || this._pointerState.weightStroke.skMesh !== hit.mesh) {
            if (this._pointerState.weightStroke?.changed) {
              const cmd = this.endWeightStroke(this._pointerState.weightStroke, { getContext: resolveContext });
              if (cmd) opts.onHistoryCommand?.(cmd);
            }
            this._pointerState.weightStroke = this.beginWeightStroke(hit.mesh);
          }
          const ctrl = resolveControls();
          if (ctrl) {
            if (typeof ctrl.cancelPointer === 'function') ctrl.cancelPointer(e.pointerId);
            ctrl.enabled = false;
            this._pointerState.controlsPaused = true;
          }
          this.isPainting = true;
          if (this._pointerState.weightStroke && (this.selectedBone || this.weightBrushMode === 'smooth')) {
            if (this.applyWeightBrushStrokeAt(hit.mesh, hit.point, this.selectedBone, ctx?.root)) {
              this._pointerState.weightStroke.changed = true;
            }
          }
        }
      }
    };

    const endPointer = (e) => {
      this._pointers.delete(e.pointerId);
      if (!this._pointerState || this._pointerState.id !== e.pointerId) return;

      const st = this._pointerState;
      this._pointerState = null;
      this.isPainting = false;

      if (st.controlsPaused) {
        const ctrl = resolveControls();
        if (ctrl) ctrl.enabled = st.controlsWereEnabled && resolveControlsEnabled();
      }

      if (st.mode === 'bone' && !st.moved) {
        const [lx, ly] = clientToLocalPoint(opts.referenceElement || domElement, e);
        const { W, H } = getDims();
        const cam = resolveCamera();
        const ctx = resolveContext();
        const res = this.tapBoneTool(lx, ly, W, H, cam, ctx, { touch: st.isTouch });
        if (res.command) opts.onHistoryCommand?.(res.command);
        if (res.message) this._emitStatus(res.message, Boolean(res.isWarn));
        this._emitStateChange();
        return;
      }

      if (st.mode === 'weights') {
        if (!st.moved && st.boneCandidate) {
          const ctx = resolveContext();
          this.selectWeightBone(st.boneCandidate, ctx);
          opts.onSelectBone?.(st.boneCandidate);
          this._emitStatus(`Pesos del hueso: ${st.boneCandidate.name || `Hueso #${st.boneCandidate.id}`}`);
          this._emitStateChange();
        } else if (st.weightStroke?.changed) {
          const cmd = this.endWeightStroke(st.weightStroke, { getContext: resolveContext });
          if (cmd) opts.onHistoryCommand?.(cmd);
        }
      }
    };

    const onBlur = () => {
      this._pointers.clear();
      if (this._pointerState?.controlsPaused) {
        const ctrl = resolveControls();
        if (ctrl) ctrl.enabled = resolveControlsEnabled();
      }
      if (this._pointerState?.weightStroke?.changed) {
        const cmd = this.endWeightStroke(this._pointerState.weightStroke, { getContext: resolveContext });
        if (cmd) opts.onHistoryCommand?.(cmd);
      }
      this._pointerState = null;
      this.isPainting = false;
    };

    domElement.addEventListener('pointerdown', onPointerDown);
    if (typeof window !== 'undefined') {
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', endPointer);
      window.addEventListener('pointercancel', endPointer);
      window.addEventListener('blur', onBlur);
    }

    this._cleanup = () => {
      domElement.removeEventListener('pointerdown', onPointerDown);
      if (typeof window !== 'undefined') {
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', endPointer);
        window.removeEventListener('pointercancel', endPointer);
        window.removeEventListener('blur', onBlur);
      }
    };
    return this;
  }

  detach() {
    if (this._cleanup) {
      this._cleanup();
      this._cleanup = null;
    }
    this._pointers.clear();
    this._pointerState = null;
    this._attached = null;
    return this;
  }

  /**
   * Construye un personaje de prueba articulado con piel deformada, pesos de skinning
   * y una jerarquía de huesos-punto listos para animar y probar en escena.
   */
  static createSampleRig({ color = 0x38bdf8, shininess = 42, position = null } = {}) {
    const geo = new SphereGeometry(0.85, 24, 18);
    const posAttr = geo.attributes.position;
    const arr = posAttr.array;
    const count = posAttr.count;
    const skinIndex = new Float32Array(count * 4);
    const skinWeight = new Float32Array(count * 4);

    const yCenterOffset = 1.2325;
    for (let i = 0; i < count; i++) {
      const x = arr[i * 3] * 0.72;
      const yRaw = (arr[i * 3 + 1] + 0.85) * 1.45;
      const y = yRaw - yCenterOffset;
      const z = arr[i * 3 + 2] * 0.72;
      arr[i * 3] = x;
      arr[i * 3 + 1] = y;
      arr[i * 3 + 2] = z;

      if (yRaw < 0.95) {
        skinIndex[i * 4] = 2;
        skinWeight[i * 4] = 1;
      } else if (yRaw < 1.75) {
        const t = (yRaw - 0.95) / 0.8;
        skinIndex[i * 4] = 2;
        skinIndex[i * 4 + 1] = 3;
        skinWeight[i * 4] = 1 - t;
        skinWeight[i * 4 + 1] = t;
      } else {
        const t = Math.min(1, (yRaw - 1.75) / 0.7);
        skinIndex[i * 4] = 3;
        skinIndex[i * 4 + 1] = 4;
        skinWeight[i * 4] = 1 - t;
        skinWeight[i * 4 + 1] = t;
      }
    }
    posAttr.needsUpdate = true;
    geo.setAttribute('skinIndex', skinIndex, 4);
    geo.setAttribute('skinWeight', skinWeight, 4);

    const mat = new StandardMaterial({ color, shininess });
    const skinned = new SkinnedMesh(geo, mat);
    skinned.castShadow = true;
    skinned.receiveShadow = true;

    const boneRaiz = new Bone();
    boneRaiz.name = 'Raiz';
    boneRaiz.position.set(0, 0.4 - yCenterOffset, 0);

    const boneCadera = new Bone();
    boneCadera.name = 'Cadera';
    boneCadera.position.set(0, 0, 0);

    const boneBaseFK = new Bone();
    boneBaseFK.name = 'Base_FK';
    boneBaseFK.position.set(0, 0, 0);

    const boneTorso = new Bone();
    boneTorso.name = 'Torso';
    boneTorso.position.set(0, 0.95, 0);

    const boneCabeza = new Bone();
    boneCabeza.name = 'Cabeza';
    boneCabeza.position.set(0, 0.8, 0);

    boneRaiz.add(boneCadera);
    boneCadera.add(boneBaseFK);
    boneBaseFK.add(boneTorso);
    boneTorso.add(boneCabeza);

    skinned.add(boneRaiz);
    if (Array.isArray(position)) {
      skinned.position.set(position[0] || 0, position[1] || 0, position[2] || 0);
    } else if (position && position.x !== undefined) {
      skinned.position.copy(position);
    } else {
      skinned.position.set(0, 0, 0);
    }
    skinned.bind(new Skeleton([boneRaiz, boneCadera, boneBaseFK, boneTorso, boneCabeza]));
    return skinned;
  }
}
