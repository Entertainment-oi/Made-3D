import { Vec3 as Vector3 } from '../math/Vec3.js';
import { Quat as Quaternion } from '../math/Quat.js';
import { Mat4 as Matrix4 } from '../math/Mat4.js';
import { PAIRS } from './GizmoRenderer2D.js';

export const SNAP_DEFAULT = { translation: 0.5, rotation: Math.PI / 12, scale: 0.1 };
export const LABEL = {
  select: 'Seleccionar',
  translate: 'Mover',
  rotate: 'Rotar',
  scale: 'Escalar',
  pivot: 'Pivote',
};

const V = (x = 0, y = 0, z = 0) => new Vector3(x, y, z);
const fmt = (v) => (v < 0 ? '−' : '+') + Math.abs(v).toFixed(2);
const f2 = (v) => v.toFixed(2);

const _tmpPos = new Vector3();
const _tmpQuat = new Quaternion();
const _tmpScale = new Vector3();
const _tmpVec = new Vector3();
const _tmpQuat2 = new Quaternion();
const _tmpTarget = new Vector3();
const _tmpLocal = new Vector3();

// Scratch exclusivos para setWorldTransform (evita colisión si el llamador pasa _tmpQuat / _tmpTarget).
const _swInvParent = new Matrix4();
const _swPos = new Vector3();
const _swQuat = new Quaternion();
const _swScale = new Vector3();
const _swLocal = new Vector3();

function hasInvertibleMatrix3(m) {
  const e = m.elements;
  const det =
    e[0] * (e[5] * e[10] - e[9] * e[6]) -
    e[4] * (e[1] * e[10] - e[9] * e[2]) +
    e[8] * (e[1] * e[6] - e[5] * e[2]);
  return Number.isFinite(det) && Math.abs(det) > 1e-12;
}

export function screenRay(camera, raycaster, x, y, W, H) {
  camera.updateWorldMatrix(true, false);
  if (camera.updateViewMatrix) camera.updateViewMatrix();
  raycaster.setFromCamera({ x: (x / W) * 2 - 1, y: -(y / H) * 2 + 1 }, camera);
  return raycaster.ray;
}

export function closestT(P, D, { origin: O, direction: R }) {
  const b = D.dot(R);
  const x = P.x - O.x;
  const y = P.y - O.y;
  const z = P.z - O.z;
  const d = D.x * x + D.y * y + D.z * z;
  const e = R.x * x + R.y * y + R.z * z;
  const den = 1 - b * b;
  return den < 1e-6 ? null : (b * e - d) / den;
}

export function planeHit(P, n, { origin: O, direction: R }) {
  const den = R.dot(n);
  if (Math.abs(den) < 1e-6) return null;
  const s = ((P.x - O.x) * n.x + (P.y - O.y) * n.y + (P.z - O.z) * n.z) / den;
  return V(O.x + R.x * s, O.y + R.y * s, O.z + R.z * s);
}

/**
 * Posiciona/orienta `o` en el mundo de modo que su pivote quede en `worldPivotPos`
 * y su rotación mundial sea `worldQuat`, respetando el transform del padre y `o.pivot`.
 */
export function setWorldTransform(o, worldPivotPos, worldQuat) {
  const pa = o.parent;
  if (!pa) {
    if (worldPivotPos) {
      const pv = o.pivot;
      if (pv) o.position.set(worldPivotPos.x - pv.x, worldPivotPos.y - pv.y, worldPivotPos.z - pv.z);
      else o.position.copy(worldPivotPos);
    }
    if (worldQuat) o.quaternion.copy(worldQuat);
    return;
  }
  pa.updateWorldMatrix(true, false);
  _swInvParent.copyInverse(pa.matrixWorld);
  if (worldPivotPos) {
    _swLocal.copy(worldPivotPos).applyMatrix4(_swInvParent);
    const pv = o.pivot;
    if (pv) o.position.set(_swLocal.x - pv.x, _swLocal.y - pv.y, _swLocal.z - pv.z);
    else o.position.copy(_swLocal);
  }
  if (worldQuat) {
    pa.matrixWorld.decompose(_swPos, _swQuat, _swScale);
    o.quaternion.copy(_swQuat.invert().multiply(worldQuat));
  }
}

export function beginDrag(gizmo, key, F, ray, x, y, e) {
  const m = gizmo.editPivot ? 'pivot' : gizmo._mode;
  const axn = /^[xyz][+-]?$/.test(key) ? key[0] : null;
  const sg = key[1] === '-' ? -1 : 1;
  const A = axn ? V().copy(F.ax[axn]).multiplyScalar(sg) : null;

  const st = gizmo.objects.map((o) => {
    o.updateWorldMatrix(true, false);
    const p = V();
    if (o.getPivotWorldPosition) o.getPivotWorldPosition(p);
    else p.setFromMatrixPosition(o.matrixWorld);
    const q = new Quaternion();
    o.matrixWorld.decompose(_tmpPos, q, _tmpScale);
    let invWorld = null;
    if (m === 'pivot' && hasInvertibleMatrix3(o.matrixWorld)) {
      invWorld = new Matrix4().copyInverse(o.matrixWorld);
    }
    return { o, p, q, l: gizmo._local(o), invWorld };
  });

  const d = {
    key,
    axis: axn,
    sg,
    type: m,
    P0: F.P.clone(),
    L: F.L,
    st,
    x0: x,
    y0: y,
    clientX0: e.clientX,
    clientY0: e.clientY,
    shift: !!e.shiftKey,
    id: e.pointerId,
    moved: false,
    text: '',
    before: st.map((q) => q.l),
    ctrl: gizmo.controls ? gizmo.controls.enabled : true,
    raw: 0,
    acc: 0,
  };

  if (m === 'rotate') {
    d.A = key === 'view' ? F.back : A;
    const h = planeHit(F.P, d.A, ray);
    if (!h) return null;
    d.v0 = h.sub(F.P).normalize();
  } else if (A) {
    d.A = A;
    d.t0 = closestT(F.P, A, ray);
    if (d.t0 === null) return null;
  } else if (PAIRS[key]) {
    const [u, v, n] = PAIRS[key];
    d.n = F.ax[n];
    d.u = F.ax[u];
    d.w = F.ax[v];
    d.un = u;
    d.wn = v;
    d.axes = [u, v];
    d.h0 = planeHit(F.P, d.n, ray);
    if (!d.h0) return null;
    if (m === 'scale') {
      d.len0 = _tmpVec.subVectors(d.h0, F.P).length();
      if (d.len0 < 1e-6) return null;
    }
  } else if (key === 'free') {
    d.n = F.back;
    d.h0 = planeHit(F.P, d.n, ray);
    if (!d.h0) return null;
  }

  return d;
}

export function updateDrag(gizmo, d, ray, x, y) {
  const st = d.st;
  let text = '';
  let snapped = false;

  if (d.type === 'translate' || d.type === 'pivot') {
    const sn = gizmo._snap('translation');
    const del = _tmpVec.set(0, 0, 0);
    snapped = !!sn;
    if (d.A) {
      const t = closestT(d.P0, d.A, ray);
      if (t === null) return false;
      let k = t - d.t0;
      if (sn) k = Math.round(k / sn) * sn;
      del.addScaledVector(d.A, k);
      text = `${d.axis.toUpperCase()}  ${fmt(k * d.sg)}`;
    } else {
      const h = planeHit(d.P0, d.n, ray);
      if (!h) return false;
      h.sub(d.h0);
      const q = (v) => (sn ? Math.round(v / sn) * sn : v);
      if (d.u) {
        const a = q(h.dot(d.u));
        const b = q(h.dot(d.w));
        del.addScaledVector(d.u, a).addScaledVector(d.w, b);
        text = `Δ${d.un.toUpperCase()} ${fmt(a)}   Δ${d.wn.toUpperCase()} ${fmt(b)}`;
      } else {
        del.set(q(h.x), q(h.y), q(h.z));
        text = `Δ ${del.length().toFixed(2)}`;
      }
    }

    if (d.type === 'translate') {
      for (let i = 0; i < st.length; i++) {
        const s = st[i];
        setWorldTransform(s.o, _tmpTarget.copy(s.p).add(del), null);
      }
    } else {
      for (let i = 0; i < st.length; i++) {
        const s = st[i];
        // Partir siempre del estado inicial del arrastre evita deriva numérica acumulada
        s.o.position.copy(s.l.p);
        if (s.o.pivot && s.l.pv) s.o.pivot.copy(s.l.pv);
        _tmpTarget.copy(s.p).add(del);
        if (s.invWorld && s.o.setPivot) {
          _tmpLocal.copy(_tmpTarget).applyMatrix4(s.invWorld);
          s.o.setPivot(_tmpLocal.x, _tmpLocal.y, _tmpLocal.z, true);
        } else if (s.o.setPivotWorld) {
          s.o.setPivotWorld(_tmpTarget, true);
        }
      }
    }
  } else if (d.type === 'rotate') {
    const h = planeHit(d.P0, d.A, ray);
    if (!h) return false;
    h.sub(d.P0).normalize();
    const raw = Math.atan2(d.A.dot(_tmpVec.crossVectors(d.v0, h)), d.v0.dot(h));
    let da = raw - d.raw;
    if (da > Math.PI) da -= 2 * Math.PI;
    if (da < -Math.PI) da += 2 * Math.PI;
    d.raw = raw;
    d.acc += da;
    let a = d.acc;
    const sn = gizmo._snap('rotation');
    snapped = !!sn;
    if (sn) a = Math.round(a / sn) * sn;
    const dq = _tmpQuat2.setFromAxisAngle(d.A, a);
    d.accShown = a;
    for (let i = 0; i < st.length; i++) {
      const s = st[i];
      const worldPos = _tmpTarget.copy(s.p).sub(d.P0).applyQuaternion(dq).add(d.P0);
      const worldQuat = _tmpQuat.copy(s.q).premultiply(dq);
      setWorldTransform(s.o, worldPos, worldQuat);
    }
    text = `${((a * 180) / Math.PI).toFixed(1)}°`;
  } else {
    let f;
    if (d.A) {
      const t = closestT(d.P0, d.A, ray);
      if (t === null) return false;
      f = 1 + (t - d.t0) / d.L;
    } else if (d.axes) {
      const h = planeHit(d.P0, d.n, ray);
      if (!h) return false;
      f = _tmpVec.subVectors(h, d.P0).length() / d.len0;
    } else {
      f = Math.exp(((x - d.x0) - (y - d.y0)) / 150);
    }
    const sn = gizmo._snap('scale');
    snapped = !!sn;
    if (sn) f = Math.round(f / sn) * sn;
    f = Math.max(0.001, f);
    const axes = d.axis ? [d.axis] : d.axes || ['x', 'y', 'z'];
    for (let i = 0; i < st.length; i++) {
      const s = st[i];
      const sc = s.o.scale.copy(s.l.s);
      for (let ai = 0; ai < axes.length; ai++) {
        const k = axes[ai];
        sc[k] = Math.max(0.001, sc[k] * f);
      }
    }
    text = `×${f2(f)}`;
  }

  d.text = text + (snapped ? '  · snap' : '');
  gizmo.info = { mode: d.type, key: d.key, text: d.text };
  return true;
}
