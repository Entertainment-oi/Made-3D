import { Object3D } from '../core/Object3D.js';
import { Raycaster } from '../core/Raycaster.js';
import { Vec3 as Vector3 } from '../math/Vec3.js';
import { Quat as Quaternion } from '../math/Quat.js';
import { SelectionOutline } from './SelectionOutline.js';
import { collectRigFromTarget } from '../objects/SkeletonHelper.js';
import { pointSegment2D } from '../core/raycast.js';

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const V = (x = 0, y = 0, z = 0) => new Vector3(x, y, z);
const fmt = (v) => (v < 0 ? '−' : '+') + Math.abs(v).toFixed(2);
const f2 = (v) => v.toFixed(2);
const AXV = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
export const COL = { x: '#ff5d5d', y: '#3ddc84', z: '#4d9bff' };
export const HOT = '#ffd60a';
export const PAIRS = { xy: ['x', 'y', 'z'], yz: ['y', 'z', 'x'], xz: ['x', 'z', 'y'] };   // [u, v, normal]
export const PCOL = { xy: COL.z, yz: COL.x, xz: COL.y };
const ORANGE = '#f15800', ORANGE_ACTIVE = '#ffaa40';
const SNAP_DEFAULT = { translation: 0.5, rotation: Math.PI / 12, scale: 0.1 };
const LABEL = { translate: 'Mover', rotate: 'Rotar', scale: 'Escalar' };
const MODES = ['translate', 'rotate', 'scale'];

/**
 * Motor común de los gizmos de Made3D. Se dibuja en un canvas 2D encima del WebGL (NO son modelos 3D):
 * líneas finas, resaltado, arcos, lectura numérica y contorno de selección naranja estilo Blender.
 *
 * Hereda de Object3D para poder hacer scene.add(gizmo): así se dibuja solo en cada render().
 * Si no lo agregas a la escena, llama gizmo.draw() después de renderer.render(scene, camera).
 *
 *   const gizmo = new GizmoMade3d(camera, renderer.domElement, { controls });
 *   scene.add(gizmo); gizmo.attach(objeto);           // un objeto, una lista, o un hueso
 *
 * Eventos (gizmo.on / addEventListener): 'change', 'objectChange', 'dragging-changed' {value},
 *   'select' {object, objects}, 'pick' {hit, object, objects}, 'dragstart', 'drag' {text}, 'dragend', 'history'.
 * Rigging y selección: pasando `{ picker, selectionRoot }` o usando `setPicker(picker, root)` el gizmo muestra
 *   todo el esqueleto (puntos y conexiones) al seleccionar un modelo/hueso y lo oculta al deseleccionar,
 *   permite elegir huesos tocando el rig, y deselecciona tocando espacio vacío, con Escape, clic derecho o doble toque.
 * Lectura en vivo: gizmo.info.text. Atajos: Shift invierte el snap, Esc cancela arrastre o deselecciona.
 * Doble toque en el punto central: alterna espacio local / mundo.
 */
export class GizmoBase extends Object3D {
  // Los gizmos concretos definen estos estáticos: tamaño por defecto y el diseño (look).
  static SIZE = 120;
  static LOOK = {};

  constructor(camera, domElement, o = {}) {
    super();
    this.camera = camera; this.domElement = domElement;
    this.controls = o.controls || null;            // OrbitControls a pausar mientras se arrastra
    this.size = o.size ?? this.constructor.SIZE;   // <= 1: fracción de la altura de pantalla · > 1: píxeles
    this.look = { ...this.constructor.LOOK, ...(o.look || {}) };
    this.enabled = true;
    this.show = { X: true, Y: true, Z: true };     // ocultar ejes concretos
    this.boneHelper = o.boneHelper || null;        // helper opcional con .pick(ray) / .setSelected(bone)
    this.picker = o.picker || null;                // Picker opcional para selección/deselección nativa
    this.selectionRoot = o.selectionRoot || o.scene || null;
    this.autoSelect = o.autoSelect ?? !!o.picker;
    this.showRig = o.showRig !== false;            // mostrar puntos y conexiones del rigging al seleccionar y ocultar al deseleccionar
    this.pickRigBones = o.pickRigBones !== false;  // permite tocar puntos/conexiones del rig visible para elegir un hueso
    this.deselectOnEscape = o.deselectOnEscape !== false;
    this.deselectOnEmpty = o.deselectOnEmpty !== false;
    this.deselectOnRightClick = o.deselectOnRightClick !== false;
    this.deselectOnDoubleTap = o.deselectOnDoubleTap !== false;
    this.translationSnap = null; this.rotationSnap = null; this.scaleSnap = null;   // null = sin snap (unidades / radianes / paso)
    this.shift = false;
    this.maxPixelRatio = o.maxPixelRatio ?? 2;
    this.outline = o.outline !== false;            // contorno naranja de la selección
    this.outliner = new SelectionOutline();
    this.objects = []; this.hover = null; this._hoverBone = null; this.drag = null; this.undoStack = []; this.redoStack = [];
    this.info = { mode: '', key: null, text: '' };
    this.W = 1; this.H = 1; this.dpr = 1;
    this._mode = MODES.includes(o.mode) ? o.mode : 'translate'; this._space = o.space || 'world';
    this._tap = null; this._rightTap = null; this._pointers = new Set(); this._lastTap = 0; this._lastSelectTap = { t: 0, obj: null };
    this._lastFrame = -1; this._vis = true; this._box = '';
    this._rigScreens = null;
    this.ray = new Raycaster();

    this._own = !o.overlay;
    this.ov = o.overlay || this._makeOverlay();
    this.ctx = this.ov.getContext('2d');
    this._layout();

    this._onDown = (e) => this._down(e); this._onMove = (e) => this._move(e); this._onUp = (e) => this._up(e);
    this._onLeave = () => { if (!this.drag && (this.hover || this._hoverBone)) { this.hover = null; this._hoverBone = null; this._fire('change'); } };
    this._onKey = (e) => {
      if (e.key === 'Shift') this.shift = e.type === 'keydown';
      else if (e.key === 'Escape' && e.type === 'keydown') {
        if (this.drag) this.cancel();
        else if (this.deselectOnEscape && this.objects.length) {
          this.detach();
          this._lastSelectTap = { t: 0, obj: null };
          this._fire('pick', { hit: null, object: null, objects: [] });
        }
      }
    };
    this._onBlur = () => { this.shift = false; };
    domElement.addEventListener('pointerdown', this._onDown, { capture: true });
    domElement.addEventListener('pointermove', this._onMove);
    domElement.addEventListener('pointerup', this._onUp);
    domElement.addEventListener('pointercancel', this._onUp);
    domElement.addEventListener('pointerleave', this._onLeave);
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this._onKey); window.addEventListener('keyup', this._onKey); window.addEventListener('blur', this._onBlur);
    }
  }
  get isGizmo() { return true; }
  get isTransformGizmo() { return true; }

  // El renderer solo llama a onBeforeRender de objetos visibles: `visible` siempre se ve true y el ocultar se maneja aquí.
  get visible() { return true; } set visible(v) { this._vis = !!v; if (!this._vis && this.ctx) this._clear(); }

  // ---------- API pública ----------
  get object() { return this.objects.length ? this.objects[this.objects.length - 1] : null; }
  get mode() { return this._mode; } set mode(m) { this.setMode(m); }
  get space() { return this._space; } set space(s) { this.setSpace(s); }
  _fire(type, data) { this.dispatchEvent(Object.assign({ type }, data)); }
  on(t, f) { if (!this._warnedEventAliases) { console.warn('Made3D: gizmo.on() está deprecado; usa addEventListener().'); this._warnedEventAliases = true; } this.addEventListener(t, f); return this; }
  off(t, f) { if (!this._warnedEventAliases) { console.warn('Made3D: gizmo.off() está deprecado; usa removeEventListener().'); this._warnedEventAliases = true; } this.removeEventListener(t, f); return this; }
  emit(type, data) { if (!this._warnedEventAliases) { console.warn('Made3D: gizmo.emit() está deprecado; usa dispatchEvent().'); this._warnedEventAliases = true; } this.dispatchEvent(Object.assign({ type }, data)); return this; }
  setPicker(picker, root = null) {
    this.picker = picker || null;
    if (root !== null) this.selectionRoot = root;
    this.autoSelect = !!this.picker;
    return this;
  }
  _sceneRoot() {
    let r = this.parent;
    while (r && r.parent) r = r.parent;
    return r;
  }
  _isDescendantOf(node, ancestor) {
    let p = node;
    while (p) { if (p === ancestor) return true; p = p.parent; }
    return false;
  }
  _selectRigBone(rigHit, shift = false) {
    const bone = rigHit.bone;
    const now = performance.now();
    if (shift) {
      const cur = this.objects.slice();
      const pos = cur.indexOf(bone);
      if (pos >= 0) cur.splice(pos, 1); else cur.push(bone);
      this.attach(cur);
      this._fire('pick', { hit: { type: 'bone', object: bone, bone, screenDistance: rigHit.px }, object: this.object, objects: this.objects.slice() });
    } else if (this.deselectOnDoubleTap && this.objects.length === 1 && this.objects[0] === bone &&
        now - this._lastSelectTap.t < 380 && this._lastSelectTap.obj === bone) {
      this.detach();
      this._lastSelectTap = { t: 0, obj: null };
      this._fire('pick', { hit: null, object: null, objects: [] });
    } else {
      this.attach(bone);
      this._lastSelectTap = { t: now, obj: bone };
      const anims = this.picker && this.picker.mixer ? this.picker.mixer.findTracks(bone) : [];
      const hit = {
        type: 'bone', object: bone, bone, screenDistance: rigHit.px,
        distance: this._proj(V().setFromMatrixPosition(bone.matrixWorld)).w,
        animations: anims,
        animation: anims.length && this.picker ? this.picker._animInfo(anims[0]) : null,
      };
      this._fire('pick', { hit, object: bone, objects: this.objects.slice() });
    }
  }
  // attach(objeto) · attach([a, b, c]) · attach(hueso) · attach(null)
  attach(o) {
    const list = !o ? [] : Array.isArray(o) ? o.filter(Boolean) : [o];
    const same = list.length === this.objects.length && list.every((x, i) => x === this.objects[i]);
    this.objects = list; this.hover = null; this._hoverBone = null;
    if (!list.length) this._rigScreens = null;
    const last = list.length ? list[list.length - 1] : null;
    if (this.boneHelper) {
      if (this.boneHelper.setTarget) this.boneHelper.setTarget(list.length ? (list.length === 1 ? list[0] : list) : null);
      if (this.boneHelper.setSelected) this.boneHelper.setSelected(last && last.isBone ? last : null);
    }
    if (!same) this._fire('select', { object: last, objects: list.slice() });
    this._fire('change'); return this;
  }
  detach() { return this.attach(null); }
  setMode(m) { if (MODES.includes(m) && m !== this._mode) { this._mode = m; this.hover = null; this._fire('change'); } return this; }
  setSpace(s) { if (s !== this._space) { this._space = s; this._fire('change'); } return this; }
  setSize(s) { this.size = s; return this; }
  setSnap(on, { translation = SNAP_DEFAULT.translation, rotation = SNAP_DEFAULT.rotation, scale = SNAP_DEFAULT.scale } = {}) {
    this.translationSnap = on ? translation : null; this.rotationSnap = on ? rotation : null; this.scaleSnap = on ? scale : null;
    return this;
  }
  undo() { const h = this.undoStack.pop(); if (h) { this._restore(h.os, h.before); this.redoStack.push(h); this._changed(); this._fire('history'); } }
  redo() { const h = this.redoStack.pop(); if (h) { this._restore(h.os, h.after); this.undoStack.push(h); this._changed(); this._fire('history'); } }
  cancel() {
    const d = this.drag; if (!d) return;
    this._restore(d.st.map((s) => s.o), d.before); this._end(d); this._changed();
    this._fire('dragging-changed', { value: false });
  }
  dispose() {
    const d = this.domElement;
    d.removeEventListener('pointerdown', this._onDown, { capture: true });
    d.removeEventListener('pointermove', this._onMove); d.removeEventListener('pointerup', this._onUp);
    d.removeEventListener('pointercancel', this._onUp); d.removeEventListener('pointerleave', this._onLeave);
    if (typeof window !== 'undefined') { window.removeEventListener('keydown', this._onKey); window.removeEventListener('keyup', this._onKey); window.removeEventListener('blur', this._onBlur); }
    if (this._own && this.ov.parentNode) this.ov.parentNode.removeChild(this.ov);
    this.removeFromParent();
  }
  // El renderer lo llama una vez por cuadro (con la cámara principal) si el gizmo está en la escena.
  onBeforeRender(renderer, camera) {
    if (camera !== this.camera) return;
    const fid = renderer && renderer._frameId;
    if (fid !== undefined && fid === this._lastFrame) return;
    this._lastFrame = fid; this.draw();
  }

  // ---------- historial y cancelación ----------
  _local(o) { return { p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() }; }
  _restore(os, st) { os.forEach((o, i) => { o.position.copy(st[i].p); o.quaternion.copy(st[i].q); o.scale.copy(st[i].s); }); }
  _end(d) { this.drag = null; if (this.controls) this.controls.enabled = d.ctrl; }
  _changed() { this._fire('objectChange'); this._fire('change'); }
  // snap activo para 'translation' | 'rotation' | 'scale' (Shift lo invierte). null = sin snap.
  _snap(kind) { const v = this[kind + 'Snap'], on = v != null; return on !== this.shift ? (v ?? SNAP_DEFAULT[kind]) : null; }

  // ---------- canvas superpuesto ----------
  _makeOverlay() {
    const cv = document.createElement('canvas');
    Object.assign(cv.style, { position: 'absolute', pointerEvents: 'none', left: '0px', top: '0px' });
    const p = this.domElement.parentNode; if (p) p.insertBefore(cv, this.domElement.nextSibling);
    return cv;
  }
  _layout() {
    const el = this.domElement, W = el.clientWidth || el.width || 1, H = el.clientHeight || el.height || 1;
    const dpr = Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, this.maxPixelRatio), ov = this.ov;
    const pw = Math.max(1, Math.round(W * dpr)), ph = Math.max(1, Math.round(H * dpr));
    if (ov.width !== pw || ov.height !== ph) { ov.width = pw; ov.height = ph; }
    this.W = W; this.H = H; this.dpr = dpr;
    if (this._own) {
      const box = el.offsetLeft + ',' + el.offsetTop + ',' + W + ',' + H;
      if (box !== this._box) { this._box = box; const s = ov.style; s.left = el.offsetLeft + 'px'; s.top = el.offsetTop + 'px'; s.width = W + 'px'; s.height = H + 'px'; }
    }
  }
  _clear() { const c = this.ctx; c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, this.ov.width, this.ov.height); }

  // ---------- geometría en pantalla ----------
  _proj(p) {
    const e = this.camera.matrixWorldInverse.elements, f = this.camera.projectionMatrix.elements;
    const x = e[0] * p.x + e[4] * p.y + e[8] * p.z + e[12], y = e[1] * p.x + e[5] * p.y + e[9] * p.z + e[13], z = e[2] * p.x + e[6] * p.y + e[10] * p.z + e[14];
    const cx = f[0] * x + f[4] * y + f[8] * z + f[12], cy = f[1] * x + f[5] * y + f[9] * z + f[13], cw = f[3] * x + f[7] * y + f[11] * z + f[15], w = Math.max(1e-6, cw);
    return { x: (cx / w * 0.5 + 0.5) * this.W, y: (1 - (cy / w * 0.5 + 0.5)) * this.H, w: cw };
  }
  // pivote (promedio de los objetos), ejes, tamaño de una unidad del gizmo en el mundo y vectores de cámara
  _frame() {
    const os = this.objects; if (!os.length) return null;
    const P = V(), q = new Quaternion(), s = V(), c = V(), bq = new Quaternion();
    for (const o of os) { o.updateWorldMatrix(true, false); o.matrixWorld.decompose(c, q, s); P.add(c); }
    P.multiplyScalar(1 / os.length);
    if (os.length === 1 && (this._space === 'local' || this._mode === 'scale')) os[0].matrixWorld.decompose(c, bq, s);
    const ax = {}; for (const k in AXV) ax[k] = V(...AXV[k]).applyQuaternion(bq);
    const cam = this.camera; cam.updateWorldMatrix(true, false);
    if (cam.updateViewMatrix) cam.updateViewMatrix();
    const e = cam.matrixWorld.elements, cp = V(e[12], e[13], e[14]), dist = Math.max(1e-3, cp.distanceTo(P));
    const H = this.H || 1, px = this.size <= 1 ? this.size * H : this.size;
    const worldH = cam.fov ? 2 * dist * Math.tan(cam.fov * Math.PI / 360) : Math.abs((cam.top ?? 1) - (cam.bottom ?? -1));
    return { P, ax, L: px * worldH / H, view: V().copy(P).sub(cp).normalize(), vis: this._proj(P).w > 0.01,
      back: V(e[8], e[9], e[10]).normalize(), right: V(e[0], e[1], e[2]).normalize(), up: V(e[4], e[5], e[6]).normalize() };
  }

  // Formas del gizmo según el modo y el diseño (this.look). Las flechas que miran directo a la cámara se desvanecen,
  // los ejes se orientan hacia el lado que ve la cámara y los planos se colocan en el cuadrante visible.
  _shapes(F) {
    const { P, ax, L, view } = F, S = [], m = this._mode, k = this.look, pr = (v) => this._proj(v), p0 = pr(P);
    const at = (a, t) => V().copy(P).addScaledVector(ax[a], t * L), on = (a) => this.show[a.toUpperCase()] !== false;
    if (m !== 'rotate') {
      const endB = m === 'scale' ? k.scaleB : k.arrowB;
      for (const a of 'xyz') {
        if (!on(a)) continue;
        const dv = ax[a].dot(view), end = clamp((1 - Math.abs(dv)) * 7, 0, 1);   // visto de punta: se oculta
        for (const sg of k.bothSides ? [1, -1] : [dv > 0 ? -1 : 1]) {
          const away = sg * dv, b = pr(at(a, sg * endB));
          S.push({ key: a + (sg > 0 ? '+' : '-'), kind: m === 'scale' ? 'sbox' : 'arrow', c: COL[a], a: pr(at(a, sg * k.arrowA)), b, z: b.w,
            f: end * (k.bothSides ? clamp((0.55 - away) / 0.35, 0, 1) : 1) });   // la que apunta hacia atrás se oculta
        }
      }
      S.push({ key: m === 'scale' ? 'uni' : 'free', kind: 'dot', c: '#ffffff', f: 1, a: p0, r: m === 'scale' ? k.dotS : k.dotT, z: -1e3 });
      const [lo, hi] = m === 'scale' ? k.squad : k.quad;
      for (const pk in PAIRS) {
        const [u, v, n] = PAIRS[pk]; if (!on(u) || !on(v)) continue;
        const su = ax[u].dot(view) > 0 ? -1 : 1, sv = ax[v].dot(view) > 0 ? -1 : 1;
        const pt = (a, b) => pr(V().copy(P).addScaledVector(ax[u], su * a * L).addScaledVector(ax[v], sv * b * L));
        S.push({ key: pk, kind: 'quad', c: PCOL[pk], f: clamp(Math.abs(ax[n].dot(view)) * 6, 0, 1), n: ax[n], pts: [pt(lo, lo), pt(hi, lo), pt(hi, hi), pt(lo, hi)], z: p0.w });
      }
    } else {
      const ring = (key, u, v, n, R, c, f, z) => {
        const pts = [];
        for (let i = 0; i <= 64; i++) {
          const t = i / 64 * Math.PI * 2, pp = pr(V().copy(P).addScaledVector(u, Math.cos(t) * R * L).addScaledVector(v, Math.sin(t) * R * L));
          pp.front = key === 'view' || pp.w < p0.w; pts.push(pp);   // la mitad de atrás se dibuja tenue y no se toca
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
  _dist(s, x, y) {
    const seg = (a, b) => { const dx = b.x - a.x, dy = b.y - a.y, t = clamp(((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1), 0, 1); return Math.hypot(x - a.x - t * dx, y - a.y - t * dy); };
    if (s.kind === 'arrow' || s.kind === 'sbox') return seg(s.a, s.b);
    if (s.kind === 'dot') return Math.max(0, Math.hypot(x - s.a.x, y - s.a.y) - s.r);
    if (s.kind === 'quad') {
      const p = s.pts; let ins = false;
      for (let i = 0, j = 3; i < 4; j = i++) if ((p[i].y > y) !== (p[j].y > y) && x < (p[j].x - p[i].x) * (y - p[i].y) / (p[j].y - p[i].y) + p[i].x) ins = !ins;
      return ins ? 0 : Infinity;
    }
    let d = Infinity; for (let i = 0; i < s.pts.length - 1; i++) if (s.pts[i].front || s.pts[i + 1].front) d = Math.min(d, seg(s.pts[i], s.pts[i + 1]));
    return d;
  }
  // devuelve la forma bajo el puntero (o null). Descarta anillos y planos vistos de canto: arrastrarlos sería degenerado.
  _pick(x, y, touch) {
    const F = this._frame(); if (!F || !F.vis) return null;
    const R = this._ray(x, y).direction, T = touch ? 18 : 12; let best = null, bd = Infinity;
    for (const s of this._shapes(F)) {
      if (s.f < 0.25) continue;
      if (s.n && Math.abs(s.n.dot(R)) < 0.08) continue;
      let d = this._dist(s, x, y); if (d > (s.kind === 'dot' ? T / 2 : T)) continue;
      d -= s.kind === 'dot' ? 100 : s.kind === 'quad' ? 8 : 0;   // el centro gana a los planos y estos a los ejes
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }

  // Proyecta un segmento mundial [A, B] a pantalla, recortando contra el plano cercano si la cámara es perspectiva.
  _projSeg(ax, ay, az, bx, by, bz) {
    const cam = this.camera;
    if (cam.fov !== undefined) {
      const ve = cam.matrixWorldInverse.elements;
      const z1 = -(ve[2] * ax + ve[6] * ay + ve[10] * az + ve[14]);
      const z2 = -(ve[2] * bx + ve[6] * by + ve[10] * bz + ve[14]);
      if (z1 <= 0.01 && z2 <= 0.01) return null;
      if (z1 <= 0.01) {
        const k = (0.01 - z1) / (z2 - z1);
        ax += (bx - ax) * k; ay += (by - ay) * k; az += (bz - az) * k;
      } else if (z2 <= 0.01) {
        const k = (0.01 - z2) / (z1 - z2);
        bx += (ax - bx) * k; by += (ay - by) * k; bz += (az - bz) * k;
      }
    }
    const p1 = this._proj(V(ax, ay, az));
    const p2 = this._proj(V(bx, by, bz));
    return [p1, p2];
  }

  // Dibuja todos los puntos de articulación y conexiones del rigging asociado a la selección actual.
  _drawRig(c, rig) {
    const { bones, boneSet, selectedBones } = rig;
    const heads = new Map();
    const joints = [];
    const segs = [];
    const tails = [];

    for (const b of bones) {
      b.updateWorldMatrix(true, false);
      const e = b.matrixWorld.elements;
      const hx = e[12], hy = e[13], hz = e[14];
      heads.set(b, [hx, hy, hz]);
      const p = this._proj(V(hx, hy, hz));
      let level = 0, pa = b.parent;
      while (pa) { if (pa.isBone) level++; pa = pa.parent; }
      joints.push({ bone: b, x: p.x, y: p.y, w: p.w, level, selected: selectedBones.has(b) });
    }

    for (const b of bones) {
      const p = b.parent;
      const hb = heads.get(b);
      if (p && p.isBone && boneSet.has(p)) {
        const hp = heads.get(p);
        const proj = this._projSeg(hp[0], hp[1], hp[2], hb[0], hb[1], hb[2]);
        if (proj) {
          segs.push({
            bone: p,
            child: b,
            ax: proj[0].x, ay: proj[0].y,
            bx: proj[1].x, by: proj[1].y,
            active: selectedBones.has(p) || selectedBones.has(b),
            hovered: this._hoverBone === p || this._hoverBone === b,
          });
        }
      }
      const hasChildBone = b.children.some((ch) => ch.isBone && ch.visible && boneSet.has(ch));
      if (!hasChildBone && b.length) {
        const tail = b.getWorldTail(V());
        const proj = this._projSeg(hb[0], hb[1], hb[2], tail.x, tail.y, tail.z);
        if (proj) {
          const active = selectedBones.has(b);
          const hovered = this._hoverBone === b;
          segs.push({
            bone: b, child: null,
            ax: proj[0].x, ay: proj[0].y,
            bx: proj[1].x, by: proj[1].y,
            active, hovered,
          });
          if (proj[1].w > 0.01) tails.push({ x: proj[1].x, y: proj[1].y, active, hovered });
        }
      }
    }

    this._rigScreens = { joints, segs };

    c.save();
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.setLineDash([]);
    c.shadowBlur = 0;

    // 1) Conexiones entre huesos (cuña direccional suave + trazo con halo oscuro para contraste)
    for (const s of segs) {
      const dx = s.bx - s.ax, dy = s.by - s.ay;
      const len = Math.hypot(dx, dy);
      const strokeCol = s.active ? ORANGE_ACTIVE : s.hovered ? HOT : '#5eead4';
      const fillCol = s.active ? 'rgba(255, 170, 64, 0.24)' : s.hovered ? 'rgba(255, 214, 10, 0.22)' : 'rgba(94, 234, 212, 0.16)';
      if (len >= 10) {
        const ux = dx / len, uy = dy / len;
        const nx = -uy, ny = ux;
        const k = clamp(len * 0.075, 2.4, s.active ? 5.2 : 3.8);
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

    // 2) Puntas de huesos terminales con `length > 0`
    for (const tp of tails) {
      c.beginPath();
      c.arc(tp.x, tp.y, 2.8, 0, 7);
      c.fillStyle = tp.active ? ORANGE_ACTIVE : tp.hovered ? HOT : '#5eead4';
      c.strokeStyle = 'rgba(10, 14, 20, 0.8)';
      c.lineWidth = 1.2;
      c.fill();
      c.stroke();
    }

    // 3) Puntos de articulación de todos los huesos
    for (const j of joints) {
      if (j.w <= 0.01) continue;
      const isHover = this._hoverBone === j.bone;
      const r = j.selected ? 5.8 : isHover ? 5.0 : 3.8;
      c.beginPath();
      c.arc(j.x, j.y, r, 0, 7);
      c.fillStyle = j.selected ? ORANGE_ACTIVE : isHover ? HOT : '#38bdf8';
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
  }

  _pickRigBoneScreen(x, y, touch) {
    const rs = this._rigScreens;
    if (!rs) return null;
    const jTol = touch ? 18 : 10;
    const sTol = touch ? 16 : 9;
    let best = null;
    for (const j of rs.joints) {
      if (j.w <= 0.01) continue;
      if (j.bone.userData && j.bone.userData.pickable === false) continue;
      const d = Math.hypot(x - j.x, y - j.y);
      if (d > jTol) continue;
      if (!best || d < best.px - 1.5 || (Math.abs(d - best.px) <= 1.5 && j.level > best.level)) {
        best = { bone: j.bone, px: d, level: j.level };
      }
    }
    if (best) return best;
    for (const s of rs.segs) {
      if (s.bone.userData && s.bone.userData.pickable === false) continue;
      const { d } = pointSegment2D(x, y, s.ax, s.ay, s.bx, s.by);
      if (d <= sTol && (!best || d < best.px)) {
        best = { bone: s.bone, px: d, level: 0 };
      }
    }
    return best;
  }

  // ---------- dibujo ----------
  draw() {
    this._layout();
    const c = this.ctx, dpr = this.dpr; c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, this.W, this.H);
    if (!this._vis) { this._rigScreens = null; return; }
    const F = this._frame(); if (!F) { this._rigScreens = null; return; }
    c.save(); c.lineCap = c.lineJoin = 'round'; c.setLineDash([]); c.shadowBlur = 0; c.globalAlpha = 1;
    let rig = null;
    if (this.showRig && !(this.boneHelper && this.boneHelper.isSkeletonHelper && this.boneHelper.visible)) {
      rig = collectRigFromTarget(this.objects, this.selectionRoot || this._sceneRoot());
    }
    const rigDrawnBones = rig && rig.bones.length ? rig.bones : null;
    this.objects.forEach((o, i) => {
      const col = i === this.objects.length - 1 ? ORANGE_ACTIVE : ORANGE;
      if (this.outline) this.outliner.drawTree(c, this, o, col);
      if (rigDrawnBones && o.isBone) return;   // el rig lo dibuja como articulación resaltada
      const p = this._proj(V().setFromMatrixPosition(o.matrixWorld));   // punto de origen, como en Blender
      if (p.w <= 0.01) return;
      c.fillStyle = col; c.strokeStyle = 'rgba(0,0,0,.65)'; c.lineWidth = 1; c.beginPath(); c.arc(p.x, p.y, o.isBone ? 4.6 : 3.6, 0, 7); c.fill(); c.stroke();
    });
    c.restore();
    if (rigDrawnBones) this._drawRig(c, rig);
    else this._rigScreens = null;
    if (!F.vis) return;
    const d = this.drag, act = d ? d.key : this.hover, p0 = this._proj(F.P);
    c.lineCap = c.lineJoin = 'round';
    for (const s of this._shapes(F).sort((a, b) => b.z - a.z)) if (s.f >= 0.02) this._drawShape(c, s, s.key === act, d);
    c.shadowBlur = 0; c.globalAlpha = 1;
    if (d && d.moved) this._drawDrag(c, d, p0);
  }
  _drawShape(c, s, hot, d) {
    const k = this.look, col = hot ? HOT : s.c, ga = s.f * (d && !hot ? 0.16 : 1);
    c.globalAlpha = ga; c.strokeStyle = c.fillStyle = col; c.shadowColor = hot ? HOT : 'rgba(0,0,0,.45)'; c.shadowBlur = hot ? k.glowHot : k.glow;
    if (s.kind === 'arrow' || s.kind === 'sbox') {
      c.lineWidth = hot ? k.lineHot : k.line; c.beginPath(); c.moveTo(s.a.x, s.a.y); c.lineTo(s.b.x, s.b.y); c.stroke();
      const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y, l = Math.hypot(dx, dy) || 1, ux = dx / l, uy = dy / l, h = k.head;
      if (s.kind === 'arrow') { c.beginPath(); c.moveTo(s.b.x + ux * h, s.b.y + uy * h); c.lineTo(s.b.x - ux * h * 0.25 - uy * h * 0.58, s.b.y - uy * h * 0.25 + ux * h * 0.58); c.lineTo(s.b.x - ux * h * 0.25 + uy * h * 0.58, s.b.y - uy * h * 0.25 - ux * h * 0.58); c.closePath(); c.fill(); }
      else c.fillRect(s.b.x - k.box, s.b.y - k.box, k.box * 2, k.box * 2);
    } else if (s.kind === 'quad') {
      c.beginPath(); s.pts.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y))); c.closePath();
      c.globalAlpha = ga * k.quadFill; c.fill(); c.globalAlpha = ga; c.lineWidth = 1.5; c.stroke();
    } else if (s.kind === 'dot') {
      if (k.dotRing) { c.lineWidth = 2.5; c.beginPath(); c.arc(s.a.x, s.a.y, s.r - 3, 0, 7); c.stroke(); c.beginPath(); c.arc(s.a.x, s.a.y, 3.5, 0, 7); c.fill(); }
      else if (this._mode === 'scale') { const r = s.r * 0.5; c.fillRect(s.a.x - r, s.a.y - r, r * 2, r * 2); }
      else { c.beginPath(); c.arc(s.a.x, s.a.y, s.r * 0.5, 0, 7); c.fill(); }
    } else {
      c.lineWidth = hot ? k.ringHot : k.ring;
      for (const front of [false, true]) {
        c.globalAlpha = ga * (front ? 1 : 0.25); c.beginPath();
        for (let i = 0; i < s.pts.length - 1; i++) if (s.pts[i].front === front) { c.moveTo(s.pts[i].x, s.pts[i].y); c.lineTo(s.pts[i + 1].x, s.pts[i + 1].y); }
        c.stroke();
      }
    }
  }
  _drawDrag(c, d, p0) {
    if (d.type === 'rotate') {
      const q = new Quaternion(), o0 = this._proj(d.P0), pts = [o0], acc = d.accShown ?? d.acc, n = Math.max(2, Math.ceil(Math.abs(acc) / 0.1));
      for (let i = 0; i <= n; i++) pts.push(this._proj(V().copy(d.v0).applyQuaternion(q.setFromAxisAngle(d.A, acc * i / n)).multiplyScalar(this.look.ringR * d.L).add(d.P0)));
      c.beginPath(); pts.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y))); c.closePath();
      c.fillStyle = 'rgba(255,214,10,.22)'; c.fill(); c.strokeStyle = HOT; c.lineWidth = 1.5; c.stroke();
    } else if (d.type === 'translate') {
      const o0 = this._proj(d.P0); c.setLineDash([4, 5]); c.strokeStyle = HOT; c.lineWidth = 1.5; c.beginPath(); c.moveTo(o0.x, o0.y); c.lineTo(p0.x, p0.y); c.stroke(); c.setLineDash([]);
      c.fillStyle = HOT; c.beginPath(); c.arc(o0.x, o0.y, 3.5, 0, 7); c.fill();
    }
    c.font = '600 13px system-ui, sans-serif'; c.textBaseline = 'middle';
    const w = c.measureText(d.text).width + 20, x = clamp(p0.x + 26, 4, this.W - w - 4), y = clamp(p0.y - 52, 4, this.H - 32);
    c.fillStyle = 'rgba(16,20,28,.9)'; c.beginPath();
    if (c.roundRect) c.roundRect(x, y, w, 28, 14); else c.rect(x, y, w, 28);
    c.fill(); c.fillStyle = '#fff'; c.fillText(d.text, x + 10, y + 14.5);
  }

  // ---------- interacción ----------
  _xy(e) {
    this._layout();
    const r = this.domElement.getBoundingClientRect();
    return [(e.clientX - r.left) * (this.W / (r.width || 1)), (e.clientY - r.top) * (this.H / (r.height || 1))];
  }
  _ray(x, y) {
    this.camera.updateWorldMatrix(true, false);
    if (this.camera.updateViewMatrix) this.camera.updateViewMatrix();
    this.ray.setFromCamera({ x: x / this.W * 2 - 1, y: -(y / this.H) * 2 + 1 }, this.camera);
    return this.ray.ray;
  }
  // parámetro t del punto del eje (P + tD) más cercano al rayo
  _closestT(P, D, { origin: O, direction: R }) {
    const b = D.dot(R), x = P.x - O.x, y = P.y - O.y, z = P.z - O.z, d = D.x * x + D.y * y + D.z * z, e = R.x * x + R.y * y + R.z * z, den = 1 - b * b;
    return den < 1e-6 ? null : (b * e - d) / den;
  }
  // punto donde el rayo corta el plano (P, n)
  _planeHit(P, n, { origin: O, direction: R }) {
    const den = R.dot(n); if (Math.abs(den) < 1e-6) return null;
    const s = ((P.x - O.x) * n.x + (P.y - O.y) * n.y + (P.z - O.z) * n.z) / den; return V(O.x + R.x * s, O.y + R.y * s, O.z + R.z * s);
  }
  // pone la pose MUNDIAL de un objeto convirtiéndola al espacio local de su padre
  _setWorld(o, pos, quat) {
    const pa = o.parent; if (!pa) { o.position.copy(pos); if (quat) o.quaternion.copy(quat); return; }
    pa.updateWorldMatrix(true, false);
    o.position.copy(pos).applyMatrix4(pa.matrixWorld.clone().invert());
    if (quat) { const pp = V(), pq = new Quaternion(), ps = V(); pa.matrixWorld.decompose(pp, pq, ps); o.quaternion.copy(pq.invert().multiply(quat)); }
  }
  _down(e) {
    const pid = e.pointerId ?? 1;
    this._pointers.add(pid);
    if (this._pointers.size > 1) {
      this._tap = null;
      this._rightTap = null;
      return;
    }
    if (this.enabled && e.pointerType === 'mouse' && e.button === 2) {
      this._rightTap = { x: e.clientX, y: e.clientY, t: performance.now(), id: pid };
      return;
    }
    if (this.enabled && (this.boneHelper || this.autoSelect || this.pickRigBones) && (e.pointerType !== 'mouse' || e.button === 0)) {
      this._tap = { x: e.clientX, y: e.clientY, t: performance.now(), id: pid, shift: !!e.shiftKey };
    }
    if (!this.enabled || !this._vis || !this.objects.length || this.drag || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const [x, y] = this._xy(e), s = this._pick(x, y, e.pointerType !== 'mouse'); if (!s) return;
    const key = s.key, F = this._frame(), r = this._ray(x, y), m = this._mode;
    const axn = /^[xyz][+-]?$/.test(key) ? key[0] : null, sg = key[1] === '-' ? -1 : 1, A = axn ? V().copy(F.ax[axn]).multiplyScalar(sg) : null;
    const st = this.objects.map((o) => { const p = V(), q = new Quaternion(), sc = V(); o.matrixWorld.decompose(p, q, sc); return { o, p, q, l: this._local(o) }; });
    const d = { key, axis: axn, sg, type: m, P0: F.P.clone(), L: F.L, st, x0: x, y0: y, clientX0: e.clientX, clientY0: e.clientY, shift: !!e.shiftKey, id: e.pointerId, moved: false, text: '', before: st.map((q) => q.l), ctrl: this.controls ? this.controls.enabled : true, raw: 0, acc: 0 };
    if (m === 'rotate') { d.A = key === 'view' ? F.back : A; const h = this._planeHit(F.P, d.A, r); if (!h) return; d.v0 = h.sub(F.P).normalize(); }
    else if (A) { d.A = A; d.t0 = this._closestT(F.P, A, r); if (d.t0 === null) return; }
    else if (PAIRS[key]) {
      const [u, v, n] = PAIRS[key]; d.n = F.ax[n]; d.u = F.ax[u]; d.w = F.ax[v]; d.un = u; d.wn = v; d.axes = [u, v];
      d.h0 = this._planeHit(F.P, d.n, r); if (!d.h0) return;
      if (m === 'scale') { d.len0 = V().subVectors(d.h0, F.P).length(); if (d.len0 < 1e-6) return; }
    } else if (key === 'free') { d.n = F.back; d.h0 = this._planeHit(F.P, d.n, r); if (!d.h0) return; }
    e.stopImmediatePropagation(); e.preventDefault(); this._tap = null; this._rightTap = null;
    this.drag = d; if (this.controls) this.controls.enabled = false;
    try { this.domElement.setPointerCapture(e.pointerId); } catch (_) { /* sin captura */ }
    this.info = { mode: m, key, text: LABEL[m] + ' ' + key.toUpperCase() };
    this._fire('dragging-changed', { value: true });
    this._fire('dragstart', { mode: m, key, objects: this.objects.slice(), before: d.before });
    this._fire('change');
  }
  _move(e) {
    const d = this.drag;
    if (!d) {
      if (e.pointerType === 'mouse' && this.enabled && this._vis && this.objects.length) {
        const [x, y] = this._xy(e), s = this._pick(x, y, false), h = s ? s.key : null;
        let hb = null;
        if (!h && this.pickRigBones && this._rigScreens && !(this.boneHelper && this.boneHelper.isSkeletonHelper && this.boneHelper.visible)) {
          const rh = this._pickRigBoneScreen(x, y, false);
          if (rh) hb = rh.bone;
        }
        if (h !== this.hover || hb !== this._hoverBone) {
          this.hover = h; this._hoverBone = hb;
          this.domElement.style.cursor = (h || hb) ? 'pointer' : '';
          this._fire('change');
        }
      }
      return;
    }
    if (e.pointerId !== d.id) return;
    const [x, y] = this._xy(e);
    if (!d.moved && Math.hypot(x - d.x0, y - d.y0) < 3) return;
    d.moved = true;
    const r = this._ray(x, y), st = d.st; let text = '', snapped = false;
    if (d.type === 'translate') {
      const sn = this._snap('translation'), del = V(); snapped = !!sn;
      if (d.A) {
        const t = this._closestT(d.P0, d.A, r); if (t === null) return;
        let k = t - d.t0; if (sn) k = Math.round(k / sn) * sn;
        del.addScaledVector(d.A, k); text = `${d.axis.toUpperCase()}  ${fmt(k * d.sg)}`;
      } else {
        const h = this._planeHit(d.P0, d.n, r); if (!h) return; h.sub(d.h0);
        const q = (v) => (sn ? Math.round(v / sn) * sn : v);
        if (d.u) { const a = q(h.dot(d.u)), b = q(h.dot(d.w)); del.addScaledVector(d.u, a).addScaledVector(d.w, b); text = `Δ${d.un.toUpperCase()} ${fmt(a)}   Δ${d.wn.toUpperCase()} ${fmt(b)}`; }
        else { del.set(q(h.x), q(h.y), q(h.z)); text = `Δ ${del.length().toFixed(2)}`; }
      }
      for (const s of st) this._setWorld(s.o, V().copy(s.p).add(del), null);
    } else if (d.type === 'rotate') {
      const h = this._planeHit(d.P0, d.A, r); if (!h) return; h.sub(d.P0).normalize();
      const raw = Math.atan2(d.A.dot(V().crossVectors(d.v0, h)), d.v0.dot(h)); let da = raw - d.raw;
      if (da > Math.PI) da -= 2 * Math.PI; if (da < -Math.PI) da += 2 * Math.PI;
      d.raw = raw; d.acc += da; let a = d.acc;
      const sn = this._snap('rotation'); snapped = !!sn; if (sn) a = Math.round(a / sn) * sn;
      const dq = new Quaternion().setFromAxisAngle(d.A, a); d.accShown = a;
      for (const s of st) this._setWorld(s.o, V().copy(s.p).sub(d.P0).applyQuaternion(dq).add(d.P0), new Quaternion().copy(s.q).premultiply(dq));
      text = `${(a * 180 / Math.PI).toFixed(1)}°`;
    } else {
      let f;
      if (d.A) { const t = this._closestT(d.P0, d.A, r); if (t === null) return; f = 1 + (t - d.t0) / d.L; }
      else if (d.axes) { const h = this._planeHit(d.P0, d.n, r); if (!h) return; f = V().subVectors(h, d.P0).length() / d.len0; }
      else f = Math.exp(((x - d.x0) - (y - d.y0)) / 150);
      const sn = this._snap('scale'); snapped = !!sn; if (sn) f = Math.round(f / sn) * sn;
      f = Math.max(0.001, f);
      const axes = d.axis ? [d.axis] : d.axes || ['x', 'y', 'z'];
      for (const s of st) { const sc = s.l.s.clone(); for (const k of axes) sc[k] = Math.max(0.001, sc[k] * f); s.o.scale.copy(sc); }
      text = `×${f2(f)}`;
    }
    d.text = text + (snapped ? '  · snap' : '');
    this.info = { mode: d.type, key: d.key, text: LABEL[d.type] + ' ' + d.text };
    this._fire('drag', { text: d.text });
    this._changed();
  }
  _up(e) {
    const pid = e.pointerId ?? 1;
    this._pointers.delete(pid);
    const rt = this._rightTap;
    if (rt && pid === rt.id) {
      this._rightTap = null;
      if (!this.drag && this.deselectOnRightClick && this.objects.length &&
          Math.hypot(e.clientX - rt.x, e.clientY - rt.y) <= 5 && performance.now() - rt.t < 350) {
        this.detach();
        this._lastSelectTap = { t: 0, obj: null };
        this._fire('pick', { hit: null, object: null, objects: [] });
        return;
      }
    }
    const tp = this._tap;
    if (tp && pid === tp.id) {
      this._tap = null;
      const touch = e.pointerType !== 'mouse';
      const tapTol = touch ? 14 : 6;
      const now = performance.now();
      if (!this.drag && Math.hypot(e.clientX - tp.x, e.clientY - tp.y) <= tapTol && now - tp.t < 480) {
        const [x, y] = this._xy(e);
        if (this.boneHelper && this.boneHelper.pick) {
          this._ray(x, y);
          const bone = this.boneHelper.pick(this.ray);
          if (bone) { this.attach(bone); return; }
        }
        if (this.pickRigBones && this.objects.length && this._rigScreens &&
            !(this.boneHelper && this.boneHelper.isSkeletonHelper && this.boneHelper.visible)) {
          const rigHit = this._pickRigBoneScreen(x, y, touch);
          if (rigHit) {
            this._selectRigBone(rigHit, tp.shift);
            return;
          }
        }
        if (this.autoSelect && this.picker) {
          const root = this.selectionRoot || this._sceneRoot();
          if (root) {
            const hit = this.picker.pick(e, this.camera, root);
            if (!hit) {
              if (this.deselectOnEmpty && !tp.shift && this.objects.length) this.detach();
              this._lastSelectTap = { t: 0, obj: null };
              this._fire('pick', { hit: null, object: null, objects: [] });
            } else {
              const targetObj = hit.type === 'bone' ? hit.bone : hit.object;
              if (tp.shift) {
                const cur = this.objects.slice();
                const pos = cur.indexOf(targetObj);
                if (pos >= 0) cur.splice(pos, 1); else cur.push(targetObj);
                this.attach(cur);
                this._fire('pick', { hit, object: this.object, objects: this.objects.slice() });
              } else if (this.deselectOnDoubleTap && this.objects.length === 1 &&
                  (this.objects[0] === targetObj || this._isDescendantOf(targetObj, this.objects[0])) &&
                  now - this._lastSelectTap.t < 380 && this._lastSelectTap.obj === this.objects[0]) {
                this.detach();
                this._lastSelectTap = { t: 0, obj: null };
                this._fire('pick', { hit: null, object: null, objects: [] });
              } else {
                this.attach(targetObj);
                this._lastSelectTap = { t: now, obj: targetObj };
                this._fire('pick', { hit, object: targetObj, objects: this.objects.slice() });
              }
            }
            return;
          }
        }
      }
    }
    const d = this.drag;
    if (!d) { if (e.pointerType !== 'mouse') { this.hover = null; this._hoverBone = null; } return; }
    if (e.pointerId !== d.id) return;
    this._end(d);
    try { this.domElement.releasePointerCapture(e.pointerId); } catch (_) { /* nada */ }
    if (d.moved) {
      const h = { os: d.st.map((s) => s.o), before: d.before, after: d.st.map((s) => this._local(s.o)) };
      this.undoStack.push(h); this.redoStack.length = 0; this._fire('dragend', h); this._fire('history');
    } else if (d.key === 'free' || d.key === 'uni') {   // doble toque en el centro: local ⇄ mundo
      const now = performance.now();
      if (now - this._lastTap < 350) { this.setSpace(this._space === 'world' ? 'local' : 'world'); this._lastTap = 0; } else this._lastTap = now;
    } else if (this.pickRigBones && this._rigScreens && !(this.boneHelper && this.boneHelper.isSkeletonHelper && this.boneHelper.visible)) {
      const touch = e.pointerType !== 'mouse';
      const tapTol = touch ? 14 : 6;
      if (Math.hypot(e.clientX - d.clientX0, e.clientY - d.clientY0) <= tapTol) {
        const [x, y] = this._xy(e);
        const rigHit = this._pickRigBoneScreen(x, y, touch);
        if (rigHit) this._selectRigBone(rigHit, d.shift);
      }
    }
    if (e.pointerType !== 'mouse') { this.hover = null; this._hoverBone = null; }
    this._fire('dragging-changed', { value: false });
    this._fire('change');
  }
}
