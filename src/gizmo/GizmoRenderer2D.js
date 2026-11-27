import { Vec3 as Vector3 } from '../math/Vec3.js';
import { Quat as Quaternion } from '../math/Quat.js';

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const COL = { x: '#ff5d5d', y: '#3ddc84', z: '#4d9bff' };
export const HOT = '#ffd60a';
export const PAIRS = { xy: ['x', 'y', 'z'], yz: ['y', 'z', 'x'], xz: ['x', 'z', 'y'] }; // [u, v, normal]
export const PCOL = { xy: COL.z, yz: COL.x, xz: COL.y };
export const ORANGE = '#f15800';
export const ORANGE_ACTIVE = '#ffaa40';
export const PIVOT_ACCENT = '#38bdf8';

const AXV = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
const V = (x = 0, y = 0, z = 0) => new Vector3(x, y, z);

// Scratch compartidos para proyección y dibujo 2D sin asignaciones por frame.
const _tmpPos = new Vector3();
const _tmpQuat = new Quaternion();
const _tmpScale = new Vector3();
const _tmpVec = new Vector3();
const _tmpQuat2 = new Quaternion();

/**
 * Motor de proyección, picking 2D y renderizado sobre Canvas 2D para GizmoBase.
 */
export class GizmoRenderer2D {
  project(camera, p, W, H) {
    const e = camera.matrixWorldInverse.elements;
    const f = camera.projectionMatrix.elements;
    const x = e[0] * p.x + e[4] * p.y + e[8] * p.z + e[12];
    const y = e[1] * p.x + e[5] * p.y + e[9] * p.z + e[13];
    const z = e[2] * p.x + e[6] * p.y + e[10] * p.z + e[14];
    const cx = f[0] * x + f[4] * y + f[8] * z + f[12];
    const cy = f[1] * x + f[5] * y + f[9] * z + f[13];
    const cw = f[3] * x + f[7] * y + f[11] * z + f[15];
    const w = Math.max(1e-6, cw);
    return { x: ((cx / w) * 0.5 + 0.5) * W, y: (1 - ((cy / w) * 0.5 + 0.5)) * H, w: cw };
  }

  computeFrame(gizmo) {
    const os = gizmo.objects;
    if (!os.length) return null;
    const P = V();
    const bq = new Quaternion();
    for (let i = 0; i < os.length; i++) {
      const o = os[i];
      o.updateWorldMatrix(true, false);
      if (o.getPivotWorldPosition) o.getPivotWorldPosition(_tmpPos);
      else _tmpPos.setFromMatrixPosition(o.matrixWorld);
      P.add(_tmpPos);
    }
    P.multiplyScalar(1 / os.length);

    if (os.length === 1 && (gizmo._space === 'local' || (!gizmo.editPivot && gizmo._mode === 'scale'))) {
      os[0].matrixWorld.decompose(_tmpPos, bq, _tmpScale);
    }

    const ax = {};
    for (const k in AXV) ax[k] = V(...AXV[k]).applyQuaternion(bq);

    const cam = gizmo.camera;
    cam.updateWorldMatrix(true, false);
    if (cam.updateViewMatrix) cam.updateViewMatrix();
    const e = cam.matrixWorld.elements;
    const cp = _tmpVec.set(e[12], e[13], e[14]);
    const dist = Math.max(1e-3, cp.distanceTo(P));
    const H = gizmo.H || 1;
    const px = gizmo.size <= 1 ? gizmo.size * H : gizmo.size;
    const worldH = cam.fov
      ? 2 * dist * Math.tan((cam.fov * Math.PI) / 360)
      : Math.abs((cam.top ?? 1) - (cam.bottom ?? -1));

    return {
      P,
      ax,
      L: (px * worldH) / H,
      view: V().copy(P).sub(cp).normalize(),
      vis: this.project(cam, P, gizmo.W, H).w > 0.01,
      back: V(e[8], e[9], e[10]).normalize(),
      right: V(e[0], e[1], e[2]).normalize(),
      up: V(e[4], e[5], e[6]).normalize(),
      isPivotEdit: Boolean(gizmo.editPivot),
    };
  }

  buildShapes(gizmo, F) {
    const m = gizmo.editPivot ? 'translate' : gizmo._mode;
    if (m === 'select') return [];
    if (m === 'scale' && gizmo.objects.length > 0 && gizmo.objects.every((o) => o && o.isCamera)) return [];
    const { P, ax, L, view } = F;
    const S = [];
    const k = gizmo.look;
    const pr = (v) => this.project(gizmo.camera, v, gizmo.W, gizmo.H);
    const p0 = pr(P);
    const at = (a, t) => _tmpVec.copy(P).addScaledVector(ax[a], t * L);
    const on = (a) => gizmo.show[a.toUpperCase()] !== false;

    if (m !== 'rotate') {
      const endB = m === 'scale' ? k.scaleB : k.arrowB;
      for (const a of 'xyz') {
        if (!on(a)) continue;
        const dv = ax[a].dot(view);
        const end = clamp((1 - Math.abs(dv)) * 7, 0, 1);
        for (const sg of k.bothSides ? [1, -1] : [dv > 0 ? -1 : 1]) {
          const away = sg * dv;
          const b = pr(at(a, sg * endB));
          S.push({
            key: a + (sg > 0 ? '+' : '-'),
            kind: m === 'scale' ? 'sbox' : 'arrow',
            c: COL[a],
            a: pr(at(a, sg * k.arrowA)),
            b,
            z: b.w,
            f: end * (k.bothSides ? clamp((0.55 - away) / 0.35, 0, 1) : 1),
          });
        }
      }
      S.push({
        key: m === 'scale' ? 'uni' : 'free',
        kind: 'dot',
        c: gizmo.editPivot ? PIVOT_ACCENT : '#ffffff',
        f: 1,
        a: p0,
        r: m === 'scale' ? k.dotS : k.dotT,
        z: -1e3,
      });
      const [lo, hi] = m === 'scale' ? k.squad : k.quad;
      for (const pk in PAIRS) {
        const [u, v, n] = PAIRS[pk];
        if (!on(u) || !on(v)) continue;
        const su = ax[u].dot(view) > 0 ? -1 : 1;
        const sv = ax[v].dot(view) > 0 ? -1 : 1;
        const pt = (a, b) => pr(_tmpVec.copy(P).addScaledVector(ax[u], su * a * L).addScaledVector(ax[v], sv * b * L));
        S.push({
          key: pk,
          kind: 'quad',
          c: PCOL[pk],
          f: clamp(Math.abs(ax[n].dot(view)) * 6, 0, 1),
          n: ax[n],
          pts: [pt(lo, lo), pt(hi, lo), pt(hi, hi), pt(lo, hi)],
          z: p0.w,
        });
      }
    } else {
      const ring = (key, u, v, n, R, c, f, z) => {
        const pts = [];
        for (let i = 0; i <= 64; i++) {
          const t = (i / 64) * Math.PI * 2;
          const pp = pr(_tmpVec.copy(P).addScaledVector(u, Math.cos(t) * R * L).addScaledVector(v, Math.sin(t) * R * L));
          pp.front = key === 'view' || pp.w < p0.w;
          pts.push(pp);
        }
        S.push({ key, kind: 'ring', c, f, n, pts, z });
      };
      ring('view', F.right, F.up, F.back, k.viewR, k.viewC, k.viewF, p0.w + 1);
      if (on('x')) ring('x', ax.y, ax.z, ax.x, k.ringR, COL.x, 1, p0.w);
      if (on('y')) ring('y', ax.z, ax.x, ax.y, k.ringR, COL.y, 1, p0.w);
      if (on('z')) ring('z', ax.x, ax.y, ax.z, k.ringR, COL.z, 1, p0.w);
    }
    return S;
  }

  distToShape(s, x, y) {
    const seg = (a, b) => {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const t = clamp(((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1), 0, 1);
      return Math.hypot(x - a.x - t * dx, y - a.y - t * dy);
    };
    if (s.kind === 'arrow' || s.kind === 'sbox') return seg(s.a, s.b);
    if (s.kind === 'dot') return Math.max(0, Math.hypot(x - s.a.x, y - s.a.y) - s.r);
    if (s.kind === 'quad') {
      const p = s.pts;
      let ins = false;
      for (let i = 0, j = 3; i < 4; j = i++) {
        if ((p[i].y > y) !== (p[j].y > y) && x < ((p[j].x - p[i].x) * (y - p[i].y)) / (p[j].y - p[i].y) + p[i].x) {
          ins = !ins;
        }
      }
      return ins ? 0 : Infinity;
    }
    let d = Infinity;
    for (let i = 0; i < s.pts.length - 1; i++) {
      if (s.pts[i].front || s.pts[i + 1].front) d = Math.min(d, seg(s.pts[i], s.pts[i + 1]));
    }
    return d;
  }

  pick(gizmo, x, y, touch, rayDir) {
    if (!gizmo.editPivot && gizmo._mode === 'select') return null;
    const F = this.computeFrame(gizmo);
    if (!F || !F.vis) return null;
    const T = touch ? 18 : 12;
    let best = null;
    let bd = Infinity;
    const shapes = this.buildShapes(gizmo, F);
    for (let i = 0; i < shapes.length; i++) {
      const s = shapes[i];
      if (s.f < 0.25) continue;
      if (s.n && Math.abs(s.n.dot(rayDir)) < 0.08) continue;
      let d = this.distToShape(s, x, y);
      if (d > (s.kind === 'dot' ? T / 2 : T)) continue;
      d -= s.kind === 'dot' ? 100 : s.kind === 'quad' ? 8 : 0;
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    return best;
  }

  draw2D(gizmo, skipOutline) {
    gizmo._layout();
    const c = gizmo.ctx;
    const dpr = gizmo.dpr;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, gizmo.W, gizmo.H);
    if (!gizmo._vis) return;
    const F = this.computeFrame(gizmo);
    if (!F) return;

    const use3DRig = gizmo._has3DSkeletonHelper();
    const rigHelper = gizmo.showRig && !use3DRig ? gizmo._getRigHelper() : null;
    if (rigHelper) {
      const last = gizmo.objects.length ? gizmo.objects[gizmo.objects.length - 1] : null;
      rigHelper.setTarget(gizmo.objects.length ? (gizmo.objects.length === 1 ? gizmo.objects[0] : gizmo.objects) : null);
      if (rigHelper.setSelected) rigHelper.setSelected(last && last.isBone ? last : null);
    }

    c.save();
    c.lineCap = c.lineJoin = 'round';
    c.setLineDash([]);
    c.shadowBlur = 0;
    c.globalAlpha = 1;
    const hasRigBones = !!(rigHelper && rigHelper.bones && rigHelper.bones.length);
    const yellowMulti = Boolean(gizmo.multiSelectMode || gizmo.objects.length > 1);
    for (let i = 0; i < gizmo.objects.length; i++) {
      const o = gizmo.objects[i];
      const col = yellowMulti
        ? '#facc15'
        : (i === gizmo.objects.length - 1 ? '#f59e0b' : ORANGE);
      if (!skipOutline && gizmo.outline) gizmo.outliner.drawTree(c, gizmo, o, col);
      if ((hasRigBones || use3DRig) && o.isBone) continue;

      if (o.getPivotWorldPosition) o.getPivotWorldPosition(_tmpVec);
      else _tmpVec.setFromMatrixPosition(o.matrixWorld);
      const p = this.project(gizmo.camera, _tmpVec, gizmo.W, gizmo.H);
      if (p.w <= 0.01) continue;

      c.fillStyle = gizmo.editPivot ? PIVOT_ACCENT : col;
      c.strokeStyle = 'rgba(0,0,0,.65)';
      c.lineWidth = 1;
      c.beginPath();
      c.arc(p.x, p.y, o.isBone ? 4.6 : 3.6, 0, 7);
      c.fill();
      c.stroke();
    }
    c.restore();

    if (rigHelper && rigHelper.draw2D) {
      rigHelper.draw2D(c, gizmo.camera, gizmo.W, gizmo.H, {
        sceneRoot: gizmo.selectionRoot || gizmo._sceneRoot(),
        hoverBone: gizmo._hoverBone,
      });
    }

    if (!F.vis || (!gizmo.editPivot && gizmo._mode === 'select')) return;
    const d = gizmo.drag;
    const act = d ? d.key : gizmo.hover;
    const p0 = this.project(gizmo.camera, F.P, gizmo.W, gizmo.H);

    if (gizmo.editPivot) {
      this._drawPivotReticle(c, p0);
    }

    c.lineCap = c.lineJoin = 'round';
    const shapes = this.buildShapes(gizmo, F).sort((a, b) => b.z - a.z);
    for (let i = 0; i < shapes.length; i++) {
      const s = shapes[i];
      if (s.f >= 0.02) this.drawShape(c, gizmo, s, s.key === act, d);
    }
    c.shadowBlur = 0;
    c.globalAlpha = 1;
    if (d && d.moved) this.drawDrag(c, gizmo, d, p0);
  }

  _drawPivotReticle(c, p0) {
    c.save();
    c.strokeStyle = PIVOT_ACCENT;
    c.lineWidth = 1.6;
    c.setLineDash([3, 3]);
    c.beginPath();
    c.arc(p0.x, p0.y, 17, 0, Math.PI * 2);
    c.stroke();
    c.setLineDash([]);
    const r0 = 7;
    const r1 = 22;
    c.beginPath();
    c.moveTo(p0.x - r1, p0.y); c.lineTo(p0.x - r0, p0.y);
    c.moveTo(p0.x + r0, p0.y); c.lineTo(p0.x + r1, p0.y);
    c.moveTo(p0.x, p0.y - r1); c.lineTo(p0.x, p0.y - r0);
    c.moveTo(p0.x, p0.y + r0); c.lineTo(p0.x, p0.y + r1);
    c.stroke();
    c.restore();
  }

  drawShape(c, gizmo, s, hot, d) {
    const k = gizmo.look;
    const col = hot ? HOT : s.c;
    const ga = s.f * (d && !hot ? 0.16 : 1);
    c.globalAlpha = ga;
    c.strokeStyle = c.fillStyle = col;
    c.shadowColor = hot ? HOT : 'rgba(0,0,0,.45)';
    c.shadowBlur = hot ? k.glowHot : k.glow;

    if (s.kind === 'arrow' || s.kind === 'sbox') {
      c.lineWidth = hot ? k.lineHot : k.line;
      c.beginPath();
      c.moveTo(s.a.x, s.a.y);
      c.lineTo(s.b.x, s.b.y);
      c.stroke();
      const dx = s.b.x - s.a.x;
      const dy = s.b.y - s.a.y;
      const l = Math.hypot(dx, dy) || 1;
      const ux = dx / l;
      const uy = dy / l;
      const h = k.head;
      if (s.kind === 'arrow') {
        c.beginPath();
        c.moveTo(s.b.x + ux * h, s.b.y + uy * h);
        c.lineTo(s.b.x - ux * h * 0.25 - uy * h * 0.58, s.b.y - uy * h * 0.25 + ux * h * 0.58);
        c.lineTo(s.b.x - ux * h * 0.25 + uy * h * 0.58, s.b.y - uy * h * 0.25 - ux * h * 0.58);
        c.closePath();
        c.fill();
      } else {
        c.fillRect(s.b.x - k.box, s.b.y - k.box, k.box * 2, k.box * 2);
      }
    } else if (s.kind === 'quad') {
      c.beginPath();
      s.pts.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
      c.closePath();
      c.globalAlpha = ga * k.quadFill;
      c.fill();
      c.globalAlpha = ga;
      c.lineWidth = 1.5;
      c.stroke();
    } else if (s.kind === 'dot') {
      if (k.dotRing || gizmo.editPivot) {
        c.lineWidth = 2.5;
        c.beginPath();
        c.arc(s.a.x, s.a.y, s.r - 3, 0, 7);
        c.stroke();
        c.beginPath();
        c.arc(s.a.x, s.a.y, 3.5, 0, 7);
        c.fill();
      } else if (gizmo._mode === 'scale') {
        const r = s.r * 0.5;
        c.fillRect(s.a.x - r, s.a.y - r, r * 2, r * 2);
      } else {
        c.beginPath();
        c.arc(s.a.x, s.a.y, s.r * 0.5, 0, 7);
        c.fill();
      }
    } else {
      c.lineWidth = hot ? k.ringHot : k.ring;
      for (const front of [false, true]) {
        c.globalAlpha = ga * (front ? 1 : 0.25);
        c.beginPath();
        for (let i = 0; i < s.pts.length - 1; i++) {
          if (s.pts[i].front === front) {
            c.moveTo(s.pts[i].x, s.pts[i].y);
            c.lineTo(s.pts[i + 1].x, s.pts[i + 1].y);
          }
        }
        c.stroke();
      }
    }
  }

  drawDrag(c, gizmo, d, p0) {
    if (d.type === 'rotate') {
      const q = _tmpQuat2;
      const o0 = this.project(gizmo.camera, d.P0, gizmo.W, gizmo.H);
      const pts = [o0];
      const acc = d.accShown ?? d.acc;
      const n = Math.max(2, Math.ceil(Math.abs(acc) / 0.1));
      for (let i = 0; i <= n; i++) {
        pts.push(
          this.project(
            gizmo.camera,
            _tmpVec.copy(d.v0).applyQuaternion(q.setFromAxisAngle(d.A, (acc * i) / n)).multiplyScalar(gizmo.look.ringR * d.L).add(d.P0),
            gizmo.W,
            gizmo.H
          )
        );
      }
      c.beginPath();
      pts.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
      c.closePath();
      c.fillStyle = 'rgba(255,214,10,.22)';
      c.fill();
      c.strokeStyle = HOT;
      c.lineWidth = 1.5;
      c.stroke();
    } else if (d.type === 'boneTail' && d.st[0]?.o?.getWorldTail) {
      const tCur = d.st[0].o.getWorldTail(_tmpVec);
      const pt = this.project(gizmo.camera, tCur, gizmo.W, gizmo.H);
      if (pt.w > 0.01) {
        c.setLineDash([4, 4]);
        c.strokeStyle = HOT;
        c.lineWidth = 1.6;
        c.beginPath();
        c.moveTo(p0.x, p0.y);
        c.lineTo(pt.x, pt.y);
        c.stroke();
        c.setLineDash([]);
        c.fillStyle = HOT;
        c.beginPath();
        c.arc(pt.x, pt.y, 4.2, 0, 7);
        c.fill();
      }
    } else if (d.type === 'translate' || d.type === 'pivot') {
      const o0 = this.project(gizmo.camera, d.P0, gizmo.W, gizmo.H);
      const accent = d.type === 'pivot' ? PIVOT_ACCENT : HOT;
      c.setLineDash([4, 5]);
      c.strokeStyle = accent;
      c.lineWidth = 1.5;
      c.beginPath();
      c.moveTo(o0.x, o0.y);
      c.lineTo(p0.x, p0.y);
      c.stroke();
      c.setLineDash([]);
      c.fillStyle = accent;
      c.beginPath();
      c.arc(o0.x, o0.y, 3.5, 0, 7);
      c.fill();
    }
    c.font = '600 13px system-ui, sans-serif';
    c.textBaseline = 'middle';
    const w = c.measureText(d.text).width + 20;
    const x = clamp(p0.x + 26, 4, gizmo.W - w - 4);
    const y = clamp(p0.y - 52, 4, gizmo.H - 32);
    c.fillStyle = 'rgba(16,20,28,.9)';
    c.beginPath();
    if (c.roundRect) c.roundRect(x, y, w, 28, 14);
    else c.rect(x, y, w, 28);
    c.fill();
    c.fillStyle = '#fff';
    c.fillText(d.text, x + 10, y + 14.5);
  }
}
