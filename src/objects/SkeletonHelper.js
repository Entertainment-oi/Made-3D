import { Object3D } from '../core/Object3D.js';
import { Mesh } from './Mesh.js';
import { Geometry } from '../geometry/Geometry.js';
import { BasicMaterial } from '../materials/BuiltinMaterials.js';
import { Color } from '../math/Color.js';
import { Vec3 } from '../math/Vec3.js';

const _v1 = new Vec3(), _v2 = new Vec3();
const _p1 = new Vec3(), _p2 = new Vec3();

/**
 * Recopila los huesos y conexiones asociados a un objeto (modelo, SkinnedMesh, Skeleton o Bone).
 */
export function collectRigFromTarget(target, sceneRoot = null) {
  const boneSet = new Set();
  const selectedBones = new Set();
  const addBoneSubtree = (bone) => {
    if (!bone || !bone.visible) return;
    if (bone.isBone) boneSet.add(bone);
    for (const c of bone.children) {
      if (c.isBone || c.children.length) addBoneSubtree(c);
    }
  };
  const addSkeletonBones = (sk) => {
    if (!sk || !sk.bones) return;
    for (const b of sk.bones) {
      if (!b || !b.visible) continue;
      let top = b;
      while (top.parent && top.parent.isBone && top.parent.visible) top = top.parent;
      addBoneSubtree(top);
    }
  };

  const list = Array.isArray(target) ? target : target ? [target] : [];
  for (const o of list) {
    if (!o) continue;
    if (o.isSkeleton) {
      addSkeletonBones(o);
      continue;
    }
    if (o.isBone) {
      selectedBones.add(o);
      let top = o;
      while (top.parent && top.parent.isBone && top.parent.visible) top = top.parent;
      addBoneSubtree(top);
      const searchRoot = sceneRoot || (() => { let r = top; while (r.parent) r = r.parent; return r; })();
      if (searchRoot && searchRoot.traverse) {
        searchRoot.traverse((n) => {
          if (n.isSkinnedMesh && n.skeleton && n.skeleton.bones.includes(o)) {
            addSkeletonBones(n.skeleton);
          }
        });
      }
      continue;
    }
    const walk = (n) => {
      if (!n || !n.visible) return;
      if (n.isBone) boneSet.add(n);
      if (n.isSkinnedMesh && n.skeleton) addSkeletonBones(n.skeleton);
      for (const c of n.children) walk(c);
    };
    walk(o);
  }

  return { bones: Array.from(boneSet), boneSet, selectedBones };
}

/**
 * Visualizador 3D de esqueleto (puntos de articulación y conexiones entre huesos).
 *
 * Se muestra al asignar un modelo/hueso con `setTarget(obj)` y se oculta automáticamente
 * cuando `setTarget(null)` (o cuando el objeto no tiene huesos). Puede agregarse a la escena
 * directamente o pasarse como `boneHelper` a un gizmo.
 */
export class SkeletonHelper extends Object3D {
  constructor(target = null, opts = {}) {
    super();
    this.isSkeletonHelper = true;
    this.userData.pickable = false;
    this.target = null;
    this.selected = null;
    this.bones = [];
    this.autoHide = opts.autoHide !== false;
    this.jointRadius = opts.jointRadius ?? null;   // null = tamaño automático según el esqueleto
    this.color = new Color(opts.color ?? 0x5ad2ff);
    this.jointColor = new Color(opts.jointColor ?? 0xffffff);
    this.selectedColor = new Color(opts.selectedColor ?? 0xffaa40);

    const depthTest = opts.depthTest ?? false;
    const lineGeo = new Geometry();
    const lineMat = new BasicMaterial({
      vertexColors: true, color: 0xffffff,
      transparent: true, opacity: opts.opacity ?? 0.92,
      depthTest, depthWrite: false, fog: false,
    });
    this.linesMesh = new Mesh(lineGeo, lineMat);
    this.linesMesh.drawMode = 'lines';
    this.linesMesh.frustumCulled = false;
    this.linesMesh.renderOrder = opts.renderOrder ?? 998;
    this.linesMesh.userData.pickable = false;

    const jointGeo = new Geometry();
    const jointMat = new BasicMaterial({
      vertexColors: true, color: 0xffffff,
      transparent: true, opacity: opts.jointOpacity ?? 0.98,
      depthTest, depthWrite: false, fog: false, side: 'double',
    });
    this.jointsMesh = new Mesh(jointGeo, jointMat);
    this.jointsMesh.frustumCulled = false;
    this.jointsMesh.renderOrder = (opts.renderOrder ?? 998) + 1;
    this.jointsMesh.userData.pickable = false;

    this.add(this.linesMesh, this.jointsMesh);
    this.matrixAutoUpdate = false;
    this.visible = false;
    if (target) this.setTarget(target);
  }

  setTarget(target) {
    this.target = target || null;
    if (!target) {
      this.bones = [];
      if (this.autoHide) this.visible = false;
      return this;
    }
    this.update();
    if (this.autoHide) this.visible = this.bones.length > 0;
    return this;
  }

  setSelected(bone) {
    this.selected = bone && bone.isBone ? bone : null;
    return this;
  }

  onBeforeRender() {
    if (this.visible && this.target) this.update();
  }

  update() {
    if (!this.target) {
      this.bones = [];
      if (this.autoHide) this.visible = false;
      return this;
    }
    let sceneRoot = this.parent;
    while (sceneRoot && sceneRoot.parent) sceneRoot = sceneRoot.parent;
    const { bones, boneSet, selectedBones } = collectRigFromTarget(this.target, sceneRoot);
    this.bones = bones;
    if (this.selected) selectedBones.add(this.selected);
    if (!bones.length) {
      if (this.autoHide) this.visible = false;
      return this;
    }

    const heads = new Map();
    const segs = [];
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const b of bones) {
      b.updateWorldMatrix(true, false);
      const e = b.matrixWorld.elements;
      const hx = e[12], hy = e[13], hz = e[14];
      heads.set(b, [hx, hy, hz]);
      if (hx < minX) minX = hx; if (hx > maxX) maxX = hx;
      if (hy < minY) minY = hy; if (hy > maxY) maxY = hy;
      if (hz < minZ) minZ = hz; if (hz > maxZ) maxZ = hz;
    }

    let lenSum = 0, lenCount = 0;
    for (const b of bones) {
      const p = b.parent;
      const hb = heads.get(b);
      if (p && p.isBone && boneSet.has(p)) {
        const hp = heads.get(p);
        const active = selectedBones.has(p) || selectedBones.has(b);
        segs.push({ ax: hp[0], ay: hp[1], az: hp[2], bx: hb[0], by: hb[1], bz: hb[2], active });
        const d = Math.hypot(hb[0] - hp[0], hb[1] - hp[1], hb[2] - hp[2]);
        if (d > 1e-6) { lenSum += d; lenCount++; }
      }
      const hasChildBone = b.children.some((c) => c.isBone && c.visible && boneSet.has(c));
      if (!hasChildBone && b.length) {
        const tail = b.getWorldTail(_v1);
        segs.push({ ax: hb[0], ay: hb[1], az: hb[2], bx: tail.x, by: tail.y, bz: tail.z, active: selectedBones.has(b) });
        const d = Math.hypot(tail.x - hb[0], tail.y - hb[1], tail.z - hb[2]);
        if (d > 1e-6) { lenSum += d; lenCount++; }
      }
    }

    const span = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
    const avgLen = lenCount ? lenSum / lenCount : span * 0.15;
    const baseR = this.jointRadius ?? Math.max(0.004, Math.min((avgLen || span || 1) * 0.12, (span || 1) * 0.045));

    // Conexiones (segmentos de líneas)
    const lGeo = this.linesMesh.geometry;
    const lVerts = segs.length * 2;
    let lPos = lGeo.attributes.position && lGeo.attributes.position.array;
    let lCol = lGeo.attributes.color && lGeo.attributes.color.array;
    if (!lPos || lPos.length !== lVerts * 3) {
      lPos = new Float32Array(lVerts * 3);
      lCol = new Float32Array(lVerts * 3);
      lGeo.setAttribute('position', lPos, 3);
      lGeo.setAttribute('color', lCol, 3);
    }
    const cDef = this.color, cSel = this.selectedColor, cJnt = this.jointColor;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i], o = i * 6, c = s.active ? cSel : cDef;
      lPos[o] = s.ax; lPos[o + 1] = s.ay; lPos[o + 2] = s.az;
      lPos[o + 3] = s.bx; lPos[o + 4] = s.by; lPos[o + 5] = s.bz;
      lCol[o] = c.r; lCol[o + 1] = c.g; lCol[o + 2] = c.b;
      lCol[o + 3] = c.r; lCol[o + 4] = c.g; lCol[o + 5] = c.b;
    }
    lGeo.attributes.position.needsUpdate = true;
    lGeo.attributes.color.needsUpdate = true;

    // Puntos de articulación (octaedros de 8 triángulos = 24 vértices por hueso)
    const jGeo = this.jointsMesh.geometry;
    const vertsPerJoint = 24;
    const jVerts = bones.length * vertsPerJoint;
    let jPos = jGeo.attributes.position && jGeo.attributes.position.array;
    let jCol = jGeo.attributes.color && jGeo.attributes.color.array;
    if (!jPos || jPos.length !== jVerts * 3) {
      jPos = new Float32Array(jVerts * 3);
      jCol = new Float32Array(jVerts * 3);
      jGeo.setAttribute('position', jPos, 3);
      jGeo.setAttribute('color', jCol, 3);
    }
    const faces = [
      [0, 1, 0, 0, 0, 1, 1, 0, 0], [0, 1, 0, 1, 0, 0, 0, 0, -1],
      [0, 1, 0, 0, 0, -1, -1, 0, 0], [0, 1, 0, -1, 0, 0, 0, 0, 1],
      [0, -1, 0, 1, 0, 0, 0, 0, 1], [0, -1, 0, 0, 0, -1, 1, 0, 0],
      [0, -1, 0, -1, 0, 0, 0, 0, -1], [0, -1, 0, 0, 0, 1, -1, 0, 0],
    ];
    for (let bi = 0; bi < bones.length; bi++) {
      const b = bones[bi], h = heads.get(b);
      const isSel = selectedBones.has(b);
      const r = isSel ? baseR * 1.45 : baseR;
      const c = isSel ? cSel : cJnt;
      let o = bi * vertsPerJoint * 3;
      for (let f = 0; f < 8; f++) {
        const tri = faces[f];
        for (let k = 0; k < 3; k++) {
          jPos[o] = h[0] + tri[k * 3] * r;
          jPos[o + 1] = h[1] + tri[k * 3 + 1] * r;
          jPos[o + 2] = h[2] + tri[k * 3 + 2] * r;
          jCol[o] = c.r; jCol[o + 1] = c.g; jCol[o + 2] = c.b;
          o += 3;
        }
      }
    }
    jGeo.attributes.position.needsUpdate = true;
    jGeo.attributes.color.needsUpdate = true;
    return this;
  }

  // Picking aproximado en 3D contra los segmentos del esqueleto (usado opcionalmente por gizmo.boneHelper).
  pick(ray, maxDistance = Infinity) {
    if (!this.visible || !this.bones.length || !ray) return null;
    let best = null, bestDist = maxDistance;
    const ro = ray.origin, rd = ray.direction;
    for (const b of this.bones) {
      if (!b.visible || (b.userData && b.userData.pickable === false)) continue;
      const head = _v1.setFromMatrixPosition(b.matrixWorld);
      const tail = b.getWorldTail(_v2);
      const abx = tail.x - head.x, aby = tail.y - head.y, abz = tail.z - head.z;
      const ab2 = abx * abx + aby * aby + abz * abz;
      let t = 0;
      if (ab2 > 1e-8) {
        const w0x = head.x - ro.x, w0y = head.y - ro.y, w0z = head.z - ro.z;
        const a = rd.x * rd.x + rd.y * rd.y + rd.z * rd.z;
        const bDot = rd.x * abx + rd.y * aby + rd.z * abz;
        const c = ab2;
        const d = rd.x * w0x + rd.y * w0y + rd.z * w0z;
        const e = abx * w0x + aby * w0y + abz * w0z;
        const denom = a * c - bDot * bDot;
        if (denom > 1e-8) t = Math.max(0, Math.min(1, (a * e - bDot * d) / denom));
      }
      _p1.set(head.x + abx * t, head.y + aby * t, head.z + abz * t);
      const s = Math.max(0, (_p1.x - ro.x) * rd.x + (_p1.y - ro.y) * rd.y + (_p1.z - ro.z) * rd.z);
      _p2.set(ro.x + rd.x * s, ro.y + rd.y * s, ro.z + rd.z * s);
      const dist = _p1.distanceTo(_p2);
      const thresh = Math.max(0.05, Math.sqrt(ab2) * 0.18);
      if (dist <= thresh && dist < bestDist) { bestDist = dist; best = b; }
    }
    return best;
  }

  dispose() {
    this.linesMesh.geometry.dispose();
    this.linesMesh.material.dispose();
    this.jointsMesh.geometry.dispose();
    this.jointsMesh.material.dispose();
    return this;
  }
}
