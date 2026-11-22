import { Object3D } from '../core/Object3D.js';
import { Mesh } from './Mesh.js';
import { Geometry } from '../geometry/Geometry.js';
import { BasicMaterial } from '../materials/BuiltinMaterials.js';
import { Color } from '../math/Color.js';
import { Vec3 } from '../math/Vec3.js';
import { pointSegment2D } from '../core/raycast.js';

const _v1 = new Vec3(), _v2 = new Vec3();
const _p1 = new Vec3(), _p2 = new Vec3();
const _ORANGE_ACTIVE = '#ffaa40';
const _HOT = '#ffd60a';
const _clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

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
      ax += (bx - ax) * k; ay += (by - ay) * k; az += (bz - az) * k;
    } else if (z2 <= 0.01) {
      const k = (0.01 - z2) / (z1 - z2);
      bx += (ax - bx) * k; by += (ay - by) * k; bz += (az - bz) * k;
    }
  }
  projectPoint(_p1.set(ax, ay, az), camera, W, H, outA);
  projectPoint(_p2.set(bx, by, bz), camera, W, H, outB);
  return true;
}

/**
 * Recopila los huesos y conexiones asociados a un objeto (modelo, SkinnedMesh, Skeleton o Bone).
 */
export function collectRigFromTarget(target, sceneRoot = null) {
  const boneSet = new Set();
  const selectedBones = new Set();
  const addBoneSubtree = (bone) => {
    if (!bone || !bone.visible) return;
    if (bone.isBone) boneSet.add(bone);
    const ch = bone.children;
    for (let i = 0; i < ch.length; i++) {
      const c = ch[i];
      if (c.isBone || c.children.length) addBoneSubtree(c);
    }
  };
  const addSkeletonBones = (sk) => {
    if (!sk || !sk.bones) return;
    const bs = sk.bones;
    for (let i = 0; i < bs.length; i++) {
      const b = bs[i];
      if (!b || !b.visible) continue;
      let top = b;
      while (top.parent && top.parent.isBone && top.parent.visible) top = top.parent;
      addBoneSubtree(top);
    }
  };

  const list = Array.isArray(target) ? target : target ? [target] : [];
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
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
      let searchRoot = sceneRoot;
      if (!searchRoot) {
        let r = top;
        while (r.parent) r = r.parent;
        searchRoot = r;
      }
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
      const ch = n.children;
      for (let j = 0; j < ch.length; j++) walk(ch[j]);
    };
    walk(o);
  }

  return { bones: Array.from(boneSet), boneSet, selectedBones };
}

/**
 * Visualizador unificado de esqueleto (huesos, articulaciones y picking).
 *
 * Puede usarse de dos formas desde el mismo módulo:
 * 1) En 3D (scene.add(helper)): dibuja líneas y octaedros WebGL2 (solo sube buffers si los huesos cambian).
 * 2) En Canvas 2D (helper.draw2D(...) / helper.pickScreen(...)): usado por los gizmos de Made3D
 *    para dibujar y seleccionar huesos con precisión en pantalla sin duplicar lógica en GizmoBase.
 */
export class SkeletonHelper extends Object3D {
  constructor(target = null, opts = {}) {
    super();
    this.isSkeletonHelper = true;
    this.pickable = false;
    this.exportable = false;
    this.target = null;
    this.selected = null;
    this.bones = [];
    this.autoHide = opts.autoHide !== false;
    this.jointRadius = opts.jointRadius ?? null;
    this.color = new Color(opts.color ?? 0x5ad2ff);
    this.jointColor = new Color(opts.jointColor ?? 0xffffff);
    this.selectedColor = new Color(opts.selectedColor ?? 0xffaa40);

    this._rigCache = null;
    this._rigTargetSig = '';
    this._rigScreens = null;
    this._lastSig = '';
    this._projA = { x: 0, y: 0, w: 0 };
    this._projB = { x: 0, y: 0, w: 0 };

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
    this.linesMesh.pickable = false;
    this.linesMesh.exportable = false;

    const jointGeo = new Geometry();
    const jointMat = new BasicMaterial({
      vertexColors: true, color: 0xffffff,
      transparent: true, opacity: opts.jointOpacity ?? 0.98,
      depthTest, depthWrite: false, fog: false, side: 'double',
    });
    this.jointsMesh = new Mesh(jointGeo, jointMat);
    this.jointsMesh.frustumCulled = false;
    this.jointsMesh.renderOrder = (opts.renderOrder ?? 998) + 1;
    this.jointsMesh.pickable = false;
    this.jointsMesh.exportable = false;

    this.add(this.linesMesh, this.jointsMesh);
    this.matrixAutoUpdate = false;
    this.visible = false;
    if (target) this.setTarget(target);
  }

  _targetSignature(target, sceneRoot) {
    if (!target) return '';
    const rootId = sceneRoot ? sceneRoot.id + ':' + sceneRoot.children.length : '0';
    if (!Array.isArray(target)) return rootId + '|' + (target.id ?? 'x');
    let s = rootId + '|';
    for (let i = 0; i < target.length; i++) s += (target[i]?.id ?? 'x') + ',';
    return s;
  }

  _getRig(sceneRoot = null) {
    if (!this.target) {
      this._rigCache = null;
      this._rigTargetSig = '';
      this.bones = [];
      return null;
    }
    if (!sceneRoot) {
      let r = this.parent;
      while (r && r.parent) r = r.parent;
      sceneRoot = r;
    }
    const sig = this._targetSignature(this.target, sceneRoot);
    if (!this._rigCache || this._rigTargetSig !== sig) {
      this._rigCache = collectRigFromTarget(this.target, sceneRoot);
      this._rigTargetSig = sig;
      this.bones = this._rigCache.bones;
      this._lastSig = '';
    }
    return this._rigCache;
  }

  invalidateRig() {
    this._rigCache = null;
    this._rigTargetSig = '';
    this._lastSig = '';
    return this;
  }

  setTarget(target) {
    this.target = target || null;
    this._rigCache = null;
    this._rigTargetSig = '';
    this._lastSig = '';
    if (!target) {
      this.bones = [];
      this._rigScreens = null;
      if (this.autoHide) this.visible = false;
      return this;
    }
    const rig = this._getRig();
    if (this.autoHide) this.visible = !!(rig && rig.bones.length > 0);
    if (this.parent) this.update();
    return this;
  }

  setSelected(bone) {
    const next = bone && bone.isBone ? bone : null;
    if (this.selected !== next) {
      this.selected = next;
      this._lastSig = '';
    }
    return this;
  }

  onBeforeRender() {
    if (this.visible && this.target) this.update();
  }

  update(sceneRoot = null) {
    const rig = this._getRig(sceneRoot);
    if (!rig || !rig.bones.length) {
      this.bones = [];
      if (this.autoHide) this.visible = false;
      return this;
    }

    const { bones, boneSet, selectedBones } = rig;
    const heads = new Map();
    const segs = [];
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let poseHash = selectedBones.size * 31 + (this.selected ? this.selected.id : 0);

    for (let i = 0; i < bones.length; i++) {
      const b = bones[i];
      b.updateWorldMatrix(true, false);
      const e = b.matrixWorld.elements;
      const hx = e[12], hy = e[13], hz = e[14];
      heads.set(b, [hx, hy, hz]);
      poseHash = (poseHash * 16777619) ^ (Math.round(hx * 1e4) + Math.round(hy * 1e4) * 3 + Math.round(hz * 1e4) * 7);
      if (hx < minX) minX = hx; if (hx > maxX) maxX = hx;
      if (hy < minY) minY = hy; if (hy > maxY) maxY = hy;
      if (hz < minZ) minZ = hz; if (hz > maxZ) maxZ = hz;
      const hasChildBone = b.children.some((c) => c.isBone && c.visible && boneSet.has(c));
      if (!hasChildBone && b.length) {
        const tail = b.getWorldTail(_v1);
        poseHash = (poseHash * 16777619) ^ (Math.round(tail.x * 1e4) + Math.round(tail.y * 1e4) * 3 + Math.round(tail.z * 1e4) * 7);
        if (tail.x < minX) minX = tail.x; if (tail.x > maxX) maxX = tail.x;
        if (tail.y < minY) minY = tail.y; if (tail.y > maxY) maxY = tail.y;
        if (tail.z < minZ) minZ = tail.z; if (tail.z > maxZ) maxZ = tail.z;
      }
    }

    const activeSet = this.selected ? new Set(selectedBones).add(this.selected) : selectedBones;
    let selKey = '';
    for (const sb of activeSet) selKey += sb.id + ',';
    const sig = poseHash + '|' + selKey + '|' + bones.length;
    if (sig === this._lastSig) return this;
    this._lastSig = sig;

    let lenSum = 0, lenCount = 0;
    for (let i = 0; i < bones.length; i++) {
      const b = bones[i];
      const p = b.parent;
      const hb = heads.get(b);
      if (p && p.isBone && boneSet.has(p)) {
        const hp = heads.get(p);
        const active = activeSet.has(p) || activeSet.has(b);
        segs.push({ ax: hp[0], ay: hp[1], az: hp[2], bx: hb[0], by: hb[1], bz: hb[2], active });
        const d = Math.hypot(hb[0] - hp[0], hb[1] - hp[1], hb[2] - hp[2]);
        if (d > 1e-6) { lenSum += d; lenCount++; }
      }
      const hasChildBone = b.children.some((c) => c.isBone && c.visible && boneSet.has(c));
      if (!hasChildBone && b.length) {
        const tail = b.getWorldTail(_v1);
        segs.push({ ax: hb[0], ay: hb[1], az: hb[2], bx: tail.x, by: tail.y, bz: tail.z, active: activeSet.has(b) });
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
      const isSel = activeSet.has(b);
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

  // Dibuja el rig en un canvas 2D superpuesto (usado por GizmoBase cuando no se añade el helper 3D a la escena).
  draw2D(c, camera, W, H, { sceneRoot = null, hoverBone = null } = {}) {
    const rig = this._getRig(sceneRoot);
    if (!rig || !rig.bones.length) {
      this._rigScreens = null;
      return false;
    }

    const { bones, boneSet, selectedBones } = rig;
    const heads = new Map();
    const joints = [];
    const segs = [];
    const tails = [];

    for (let i = 0; i < bones.length; i++) {
      const b = bones[i];
      b.updateWorldMatrix(true, false);
      const e = b.matrixWorld.elements;
      const hx = e[12], hy = e[13], hz = e[14];
      heads.set(b, [hx, hy, hz]);
      projectPoint(_v1.set(hx, hy, hz), camera, W, H, this._projA);
      let level = 0, pa = b.parent;
      while (pa) { if (pa.isBone) level++; pa = pa.parent; }
      joints.push({
        bone: b,
        x: this._projA.x,
        y: this._projA.y,
        w: this._projA.w,
        level,
        selected: selectedBones.has(b) || this.selected === b,
      });
    }

    for (let i = 0; i < bones.length; i++) {
      const b = bones[i];
      const p = b.parent;
      const hb = heads.get(b);
      if (p && p.isBone && boneSet.has(p)) {
        const hp = heads.get(p);
        if (projectSegment(hp[0], hp[1], hp[2], hb[0], hb[1], hb[2], camera, W, H, this._projA, this._projB)) {
          segs.push({
            bone: p,
            child: b,
            ax: this._projA.x, ay: this._projA.y,
            bx: this._projB.x, by: this._projB.y,
            active: selectedBones.has(p) || selectedBones.has(b) || this.selected === p || this.selected === b,
            hovered: hoverBone === p || hoverBone === b,
          });
        }
      }
      const hasChildBone = b.children.some((ch) => ch.isBone && ch.visible && boneSet.has(ch));
      if (!hasChildBone && b.length) {
        const tail = b.getWorldTail(_v2);
        if (projectSegment(hb[0], hb[1], hb[2], tail.x, tail.y, tail.z, camera, W, H, this._projA, this._projB)) {
          const active = selectedBones.has(b) || this.selected === b;
          const hovered = hoverBone === b;
          segs.push({
            bone: b, child: null,
            ax: this._projA.x, ay: this._projA.y,
            bx: this._projB.x, by: this._projB.y,
            active, hovered,
          });
          if (this._projB.w > 0.01) tails.push({ x: this._projB.x, y: this._projB.y, active, hovered });
        }
      }
    }

    this._rigScreens = { joints, segs };

    c.save();
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.setLineDash([]);
    c.shadowBlur = 0;

    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      const dx = s.bx - s.ax, dy = s.by - s.ay;
      const len = Math.hypot(dx, dy);
      const strokeCol = s.active ? _ORANGE_ACTIVE : s.hovered ? _HOT : '#5eead4';
      const fillCol = s.active ? 'rgba(255, 170, 64, 0.24)' : s.hovered ? 'rgba(255, 214, 10, 0.22)' : 'rgba(94, 234, 212, 0.16)';
      if (len >= 10) {
        const ux = dx / len, uy = dy / len;
        const nx = -uy, ny = ux;
        const k = _clamp(len * 0.075, 2.4, s.active ? 5.2 : 3.8);
        const mx = s.ax + dx * 0.2, my = s.ay + dy * 0.2;
        c.beginPath();
        c.moveTo(s.ax, s.ay);
        c.lineTo(mx + nx * k, my + ny * k);
        c.lineTo(s.bx, s.by);
        c.lineTo(mx - nx * k, my - ny * k);
        c.closePath();
        c.fillStyle = fillCol;
        c.fill();
        c.lineWidth = s.active ? 3.8 : 3.0;
        c.strokeStyle = 'rgba(10, 14, 20, 0.72)';
        c.stroke();
        c.lineWidth = s.active ? 2.0 : 1.45;
        c.strokeStyle = strokeCol;
        c.stroke();
      } else {
        c.beginPath(); c.moveTo(s.ax, s.ay); c.lineTo(s.bx, s.by);
        c.lineWidth = 3.2; c.strokeStyle = 'rgba(10, 14, 20, 0.72)'; c.stroke();
        c.lineWidth = 1.6; c.strokeStyle = strokeCol; c.stroke();
      }
    }

    for (let i = 0; i < tails.length; i++) {
      const tp = tails[i];
      c.beginPath();
      c.arc(tp.x, tp.y, 2.8, 0, 7);
      c.fillStyle = tp.active ? _ORANGE_ACTIVE : tp.hovered ? _HOT : '#5eead4';
      c.strokeStyle = 'rgba(10, 14, 20, 0.8)';
      c.lineWidth = 1.2;
      c.fill();
      c.stroke();
    }

    for (let i = 0; i < joints.length; i++) {
      const j = joints[i];
      if (j.w <= 0.01) continue;
      const isHover = hoverBone === j.bone;
      const r = j.selected ? 5.8 : isHover ? 5.0 : 3.8;
      c.beginPath();
      c.arc(j.x, j.y, r, 0, 7);
      c.fillStyle = j.selected ? _ORANGE_ACTIVE : isHover ? _HOT : '#38bdf8';
      c.strokeStyle = 'rgba(10, 14, 20, 0.88)';
      c.lineWidth = 1.6;
      c.fill();
      c.stroke();
      if (j.selected) {
        c.beginPath();
        c.arc(j.x, j.y, 2.0, 0, 7);
        c.fillStyle = '#ffffff';
        c.fill();
      }
    }
    c.restore();
    return true;
  }

  // Picking 2D sobre las articulaciones y segmentos proyectados en el último draw2D().
  pickScreen(x, y, touch = false) {
    const rs = this._rigScreens;
    if (!rs) return null;
    const jTol = touch ? 18 : 10;
    const sTol = touch ? 16 : 9;
    const jointHits = [];
    for (let i = 0; i < rs.joints.length; i++) {
      const j = rs.joints[i];
      if (j.w <= 0.01) continue;
      if (j.bone.isPickable ? !j.bone.isPickable() : (j.bone.userData && j.bone.userData.pickable === false)) continue;
      const d = Math.hypot(x - j.x, y - j.y);
      if (d <= jTol) jointHits.push({ bone: j.bone, px: d, level: j.level, x: j.x, y: j.y });
    }
    if (jointHits.length) {
      jointHits.sort((a, b) => {
        if (Math.abs(a.px - b.px) > 1.5) return a.px - b.px;
        if (b.level !== a.level) return b.level - a.level;
        return a.bone.id - b.bone.id;
      });
      const first = jointHits[0];
      const candidates = [];
      const seen = new Set();
      for (const h of jointHits) {
        if (Math.hypot(h.x - first.x, h.y - first.y) <= 6 || h.px <= first.px + 4) {
          if (!seen.has(h.bone)) { seen.add(h.bone); candidates.push(h.bone); }
        }
      }
      return { bone: first.bone, px: first.px, level: first.level, candidates };
    }

    const segHits = [];
    for (let i = 0; i < rs.segs.length; i++) {
      const s = rs.segs[i];
      if (s.bone.isPickable ? !s.bone.isPickable() : (s.bone.userData && s.bone.userData.pickable === false)) continue;
      const { d } = pointSegment2D(x, y, s.ax, s.ay, s.bx, s.by);
      if (d <= sTol) {
        let lvl = 0, p = s.bone.parent;
        while (p) { if (p.isBone) lvl++; p = p.parent; }
        segHits.push({ bone: s.bone, px: d, level: lvl });
      }
    }
    if (!segHits.length) return null;
    segHits.sort((a, b) => {
      if (Math.abs(a.px - b.px) > 1.5) return a.px - b.px;
      if (b.level !== a.level) return b.level - a.level;
      return a.bone.id - b.bone.id;
    });
    const first = segHits[0];
    const candidates = [];
    const seen = new Set();
    for (const h of segHits) {
      if (h.px <= first.px + 4 && !seen.has(h.bone)) {
        seen.add(h.bone);
        candidates.push(h.bone);
      }
    }
    return { bone: first.bone, px: first.px, level: first.level, candidates };
  }

  // Picking aproximado en 3D contra todos los segmentos del esqueleto (padre→hijos y punta terminal).
  pick(rayOrCaster, maxDistance = Infinity) {
    const ray = rayOrCaster && rayOrCaster.ray ? rayOrCaster.ray : rayOrCaster;
    if (!this.visible || !this.bones.length || !ray || !ray.origin || !ray.direction) return null;
    const ro = ray.origin, rd = ray.direction;
    const hits = [];
    const testSeg = (bone, head, tail) => {
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
        if (denom > 1e-8) t = Math.max(0, Math.min(1, (bDot * d - a * e) / denom));
      }
      _p1.set(head.x + abx * t, head.y + aby * t, head.z + abz * t);
      const s = Math.max(0, (_p1.x - ro.x) * rd.x + (_p1.y - ro.y) * rd.y + (_p1.z - ro.z) * rd.z);
      _p2.set(ro.x + rd.x * s, ro.y + rd.y * s, ro.z + rd.z * s);
      const dist = _p1.distanceTo(_p2);
      const thresh = Math.max(0.05, Math.sqrt(ab2) * 0.18);
      if (dist <= thresh && dist < maxDistance) {
        let level = 0, p = bone.parent;
        while (p) { if (p.isBone) level++; p = p.parent; }
        hits.push({ bone, dist, level });
      }
    };

    for (let i = 0; i < this.bones.length; i++) {
      const b = this.bones[i];
      if (!b.visible || (b.isPickable ? !b.isPickable() : (b.userData && b.userData.pickable === false))) continue;
      b.updateWorldMatrix(true, false);
      const head = _v1.setFromMatrixPosition(b.matrixWorld);
      let testedChild = false;
      for (let j = 0; j < b.children.length; j++) {
        const c = b.children[j];
        if (c.isBone && c.visible) {
          c.updateWorldMatrix(true, false);
          testSeg(b, head, _v2.setFromMatrixPosition(c.matrixWorld));
          testedChild = true;
        }
      }
      if (!testedChild) {
        testSeg(b, head, b.getWorldTail(_v2));
      }
    }
    if (!hits.length) return null;
    hits.sort((a, b) => {
      if (Math.abs(a.dist - b.dist) > 0.02) return a.dist - b.dist;
      if (b.level !== a.level) return b.level - a.level;
      return a.bone.id - b.bone.id;
    });
    const bestDist = hits[0].dist;
    const ties = hits.filter((h) => Math.abs(h.dist - bestDist) <= 0.03).map((h) => h.bone);
    if (ties.length > 1 && this.selected) {
      const idx = ties.indexOf(this.selected);
      if (idx >= 0) return ties[(idx + 1) % ties.length];
    }
    return ties[0];
  }

  static invalidateScene(scene, opts = {}) {
    if (opts.gizmo && typeof opts.gizmo.invalidateRig === 'function') {
      opts.gizmo.invalidateRig();
    }
    if (scene && typeof scene.traverse === 'function') {
      scene.traverse((n) => {
        if (n.isSkeletonHelper && typeof n.invalidateRig === 'function') {
          n.invalidateRig();
        }
      });
    }
    if (opts.picker && typeof opts.picker.invalidateCache === 'function') {
      opts.picker.invalidateCache();
    }
    if (opts.mixer && typeof opts.mixer.invalidateCache === 'function') {
      opts.mixer.invalidateCache();
    }
  }

  dispose() {
    this.linesMesh.geometry.dispose();
    this.linesMesh.material.dispose();
    this.jointsMesh.geometry.dispose();
    this.jointsMesh.material.dispose();
    return this;
  }
}
