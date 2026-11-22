import { Object3D } from '../core/Object3D.js';
import { Raycaster } from '../core/Raycaster.js';
import { Vec3 as Vector3 } from '../math/Vec3.js';
import { SelectionOutline } from './SelectionOutline.js';
import { SkeletonHelper } from '../objects/SkeletonHelper.js';
import {
  GizmoRenderer2D,
  clamp,
  COL,
  HOT,
  PAIRS,
  PCOL,
  ORANGE,
  ORANGE_ACTIVE,
} from './GizmoRenderer2D.js';
import {
  SNAP_DEFAULT,
  LABEL,
  screenRay,
  closestT,
  planeHit,
  setWorldTransform,
  beginDrag,
  updateDrag,
} from './GizmoTransform.js';

export { clamp, COL, HOT, PAIRS, PCOL };

const MODES = ['select', 'translate', 'rotate', 'scale'];
const _tmpVec = new Vector3();

/**
 * Motor común de los gizmos de Made3D. Se dibuja en un canvas 2D encima del WebGL/WebGPU (NO son modelos 3D):
 * líneas finas, resaltado, arcos y lectura numérica, con soporte de edición no destructiva de pivote (`editPivot`).
 * El contorno de selección se renderiza en GPU mediante SelectionOutline y el rigging se delega a SkeletonHelper.
 */
export class GizmoBase extends Object3D {
  static SIZE = 120;
  static LOOK = {};

  constructor(camera, domElement, o = {}) {
    super();
    this.camera = camera;
    this.domElement = domElement;
    this.controls = o.controls || null;
    this.size = o.size ?? this.constructor.SIZE;
    this.look = { ...this.constructor.LOOK, ...(o.look || {}) };
    this.enabled = true;
    this.show = { X: true, Y: true, Z: true };
    this.boneHelper = o.boneHelper || null;
    this._autoBoneHelper = null;
    this.picker = o.picker || null;
    this.selectionRoot = o.selectionRoot || o.scene || null;
    this.autoSelect = o.autoSelect ?? !!o.picker;
    this.showRig = o.showRig !== false;
    this.pickRigBones = o.pickRigBones !== false;
    this.cycleOverlap = o.cycleOverlap !== false;
    this.deselectOnEscape = o.deselectOnEscape !== false;
    this.deselectOnEmpty = o.deselectOnEmpty !== false;
    this.deselectOnRightClick = o.deselectOnRightClick !== false;
    this.deselectOnDoubleTap = o.deselectOnDoubleTap !== false;
    this.longPressMs = o.longPressMs ?? 360;
    this.multiSelectMode = false;
    this._longPressTimer = 0;
    this.translationSnap = null;
    this.rotationSnap = null;
    this.scaleSnap = null;
    this.shift = false;
    this.maxPixelRatio = o.maxPixelRatio ?? 2;
    this.outline = o.outline !== false;
    this.outliner = new SelectionOutline();
    this._renderer2d = new GizmoRenderer2D();

    this.objects = [];
    this.hover = null;
    this._hoverBone = null;
    this.drag = null;
    this.trackHistory = o.trackHistory !== false;
    this.undoStack = [];
    this.redoStack = [];
    this.info = { mode: '', key: null, text: '' };
    this.W = 1;
    this.H = 1;
    this.dpr = 1;
    this._mode = MODES.includes(o.mode) ? o.mode : 'translate';
    this._space = o.space || 'world';
    this._editPivot = Boolean(o.editPivot);
    this._tap = null;
    this._rightTap = null;
    this._pointers = new Set();
    this._lastTap = 0;
    this._lastSelectTap = { t: 0, obj: null };
    this.exportable = false;
    this._disposed = false;
    this._lastFrame = -1;
    this._lastGpuOutlineFrame = -1;
    this._vis = true;
    this._box = '';
    this._rect = null;
    this._rectTime = -1;
    this.ray = new Raycaster();

    this._own = !o.overlay;
    this.ov = o.overlay || this._makeOverlay();
    this.ctx = this.ov.getContext('2d');
    this._layout();

    this._onDown = (e) => { if (!this._disposed) this._down(e); };
    this._onMove = (e) => { if (!this._disposed) this._move(e); };
    this._onUp = (e) => { if (!this._disposed) this._up(e); };
    this._onLeave = () => {
      if (this._disposed) return;
      if (!this.drag && (this.hover || this._hoverBone)) {
        this.hover = null;
        this._hoverBone = null;
        this._fire('change');
      }
    };
    this._onInvalidateRect = () => { this._rect = null; };
    this._onKey = (e) => {
      if (this._disposed) return;
      if (e.key === 'Shift') this.shift = e.type === 'keydown';
      else if (e.key === 'Escape' && e.type === 'keydown') {
        if (this.drag) {
          e.preventDefault();
          this.cancel();
        } else if (this._editPivot) {
          e.preventDefault();
          this.setEditPivot(false);
        } else if (this.deselectOnEscape && this.objects.length) {
          this.detach();
          this._lastSelectTap = { t: 0, obj: null };
          this._fire('pick', { hit: null, object: null, objects: [] });
        }
      }
    };
    this._onBlur = () => {
      if (this._disposed) return;
      this.shift = false;
      this._pointers.clear();
      this._tap = null;
      this._rightTap = null;
      if (this.drag) this.cancel();
    };

    domElement.addEventListener('pointerdown', this._onDown, { capture: true });
    domElement.addEventListener('pointermove', this._onMove);
    domElement.addEventListener('pointerup', this._onUp);
    domElement.addEventListener('pointercancel', this._onUp);
    domElement.addEventListener('pointerleave', this._onLeave);
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this._onKey);
      window.addEventListener('keyup', this._onKey);
      window.addEventListener('blur', this._onBlur);
      window.addEventListener('resize', this._onInvalidateRect, { passive: true });
      window.addEventListener('scroll', this._onInvalidateRect, { passive: true });
    }
  }

  get isGizmo() { return true; }
  get isTransformGizmo() { return true; }

  // El renderer solo llama a onBeforeRender de objetos visibles: `visible` siempre se ve true y el ocultar se maneja aquí.
  get visible() { return true; }
  set visible(v) { this._vis = !!v; if (!this._vis && this.ctx) this._clear(); }

  // ---------- API pública ----------
  get object() { return this.objects.length ? this.objects[this.objects.length - 1] : null; }
  get mode() { return this._mode; }
  set mode(m) { this.setMode(m); }
  get space() { return this._space; }
  set space(s) { this.setSpace(s); }
  get editPivot() { return this._editPivot; }
  set editPivot(v) { this.setEditPivot(v); }

  _fire(type, data) { this.emit(type, data); }

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

  _has3DSkeletonHelper() {
    return !!(this.boneHelper && this.boneHelper.isSkeletonHelper && this.boneHelper.parent && this.boneHelper.visible);
  }

  _getRigHelper() {
    if (this.boneHelper) return this.boneHelper;
    if (!this._autoBoneHelper) this._autoBoneHelper = new SkeletonHelper(null, { autoHide: false });
    return this._autoBoneHelper;
  }

  invalidateRig() {
    if (this._autoBoneHelper && this._autoBoneHelper.invalidateRig) this._autoBoneHelper.invalidateRig();
    if (this.boneHelper && this.boneHelper.invalidateRig) this.boneHelper.invalidateRig();
    return this;
  }

  _selectRigBone(rigHit, shift = false) {
    const candidates = rigHit.candidates && rigHit.candidates.length ? rigHit.candidates : [rigHit.bone];
    let bone = rigHit.bone;
    const now = performance.now();
    if (!shift && this.cycleOverlap && candidates.length > 1) {
      const curIdx = this.objects.length === 1 ? candidates.indexOf(this.objects[0]) : -1;
      bone = curIdx >= 0 ? candidates[(curIdx + 1) % candidates.length] : candidates[0];
    }
    if (shift) {
      const cur = this.objects.slice();
      const pos = cur.indexOf(bone);
      if (pos >= 0) cur.splice(pos, 1); else cur.push(bone);
      this.attach(cur);
      this._fire('pick', { hit: { type: 'bone', object: bone, bone, screenDistance: rigHit.px, candidates }, object: this.object, objects: this.objects.slice() });
    } else if (
      this.deselectOnDoubleTap &&
      candidates.length <= 1 &&
      this.objects.length === 1 &&
      this.objects[0] === bone &&
      now - this._lastSelectTap.t < 380 &&
      this._lastSelectTap.obj === bone
    ) {
      this.detach();
      this._lastSelectTap = { t: 0, obj: null };
      this._fire('pick', { hit: null, object: null, objects: [] });
    } else {
      this.attach(bone);
      this._lastSelectTap = { t: now, obj: bone };
      const anims = this.picker && this.picker.mixer ? this.picker.mixer.findTracks(bone) : [];
      const hit = {
        type: 'bone',
        object: bone,
        bone,
        screenDistance: rigHit.px,
        candidates,
        distance: this._proj(_tmpVec.setFromMatrixPosition(bone.matrixWorld)).w,
        animations: anims,
        animation: anims.length && this.picker ? this.picker._animInfo(anims[0]) : null,
      };
      this._fire('pick', { hit, object: bone, objects: this.objects.slice() });
    }
  }

  setMultiSelectMode(enabled) {
    const next = Boolean(enabled);
    if (this.multiSelectMode === next) return this;
    this.multiSelectMode = next;
    this._fire('multiSelectChange', { value: next });
    this._fire('change');
    return this;
  }

  _clearLongPress() {
    if (this._longPressTimer) {
      clearTimeout(this._longPressTimer);
      this._longPressTimer = 0;
    }
  }

  // attach(objeto) · attach([a, b, c]) · attach(hueso) · attach(null)
  attach(o) {
    const list = !o ? [] : Array.isArray(o) ? o.filter(Boolean) : [o];
    const same = list.length === this.objects.length && list.every((x, i) => x === this.objects[i]);
    if (!list.length) this.multiSelectMode = false;
    this.objects = list;
    this.hover = null;
    this._hoverBone = null;
    const last = list.length ? list[list.length - 1] : null;
    const targetArg = list.length ? (list.length === 1 ? list[0] : list) : null;
    const selectedBone = last && last.isBone ? last : null;
    if (this.boneHelper) {
      if (this.boneHelper.setTarget) this.boneHelper.setTarget(targetArg);
      if (this.boneHelper.setSelected) this.boneHelper.setSelected(selectedBone);
    }
    if (this._autoBoneHelper) {
      this._autoBoneHelper.setTarget(targetArg);
      this._autoBoneHelper.setSelected(selectedBone);
    }
    if (!same) this._fire('select', { object: last, objects: list.slice() });
    this._fire('change');
    return this;
  }

  detach() {
    this._clearLongPress();
    this.multiSelectMode = false;
    if (this.picker) this.picker._lastBonePick = null;
    return this.attach(null);
  }

  setMode(m) {
    if (MODES.includes(m) && m !== this._mode) {
      this._mode = m;
      this.hover = null;
      this._fire('change');
    }
    return this;
  }

  setEditPivot(on) {
    const next = Boolean(on);
    if (next !== this._editPivot) {
      if (this.drag) this.cancel();
      this._editPivot = next;
      this.hover = null;
      this._fire('editPivotChange', { value: next });
      this._fire('change');
    }
    return this;
  }

  setSpace(s) { if (s !== this._space) { this._space = s; this._fire('change'); } return this; }
  setSize(s) { this.size = s; return this; }

  setSnap(on, { translation = SNAP_DEFAULT.translation, rotation = SNAP_DEFAULT.rotation, scale = SNAP_DEFAULT.scale } = {}) {
    this.translationSnap = on ? translation : null;
    this.rotationSnap = on ? rotation : null;
    this.scaleSnap = on ? scale : null;
    return this;
  }

  undo() {
    const h = this.undoStack.pop();
    if (h) {
      this._restore(h.os, h.before);
      this.redoStack.push(h);
      this._changed();
      this._fire('history', { action: 'undo', entry: h });
    }
  }

  redo() {
    const h = this.redoStack.pop();
    if (h) {
      this._restore(h.os, h.after);
      this.undoStack.push(h);
      this._changed();
      this._fire('history', { action: 'redo', entry: h });
    }
  }

  cancel() {
    const d = this.drag;
    if (!d) return;
    this._restore(d.st.map((s) => s.o), d.before);
    this._end(d);
    try {
      if (this.domElement.hasPointerCapture && this.domElement.hasPointerCapture(d.id)) {
        this.domElement.releasePointerCapture(d.id);
      }
    } catch (_) { /* nada */ }
    this._changed();
    this._fire('dragging-changed', { value: false });
  }

  dispose() {
    if (this._disposed) return;
    if (this.drag) this.cancel();
    this._disposed = true;
    this.enabled = false;
    this._pointers.clear();
    this._tap = null;
    this._rightTap = null;
    const d = this.domElement;
    d.removeEventListener('pointerdown', this._onDown, { capture: true });
    d.removeEventListener('pointermove', this._onMove);
    d.removeEventListener('pointerup', this._onUp);
    d.removeEventListener('pointercancel', this._onUp);
    d.removeEventListener('pointerleave', this._onLeave);
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', this._onKey);
      window.removeEventListener('keyup', this._onKey);
      window.removeEventListener('blur', this._onBlur);
      window.removeEventListener('resize', this._onInvalidateRect);
      window.removeEventListener('scroll', this._onInvalidateRect);
    }
    this.objects.length = 0;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    if (this._autoBoneHelper) { this._autoBoneHelper.dispose(); this._autoBoneHelper = null; }
    if (this._own && this.ov.parentNode) this.ov.parentNode.removeChild(this.ov);
    this.removeFromParent();
  }

  // El renderer llama onBeforeRender antes de dibujar la escena 3D y onAfterRender después.
  onBeforeRender(renderer, camera) {
    if (camera !== this.camera) return;
    const fid = renderer && renderer._frameId;
    if (fid !== undefined && fid === this._lastFrame) return;
    this._lastFrame = fid;
    this._draw2D(this.outliner.mode === 'gpu');
  }

  onAfterRender(renderer, scene, camera) {
    if (this.outliner.mode !== 'gpu') return;
    if (camera !== this.camera || !this.outline || !this._vis || !this.objects.length) return;
    const fid = renderer && renderer._frameId;
    if (fid !== undefined && fid === this._lastGpuOutlineFrame) return;
    this._lastGpuOutlineFrame = fid;
    const yellowMulti = this.multiSelectMode || this.objects.length > 1;
    this.outliner.render(renderer, this.camera, this.objects, {
      activeColor: yellowMulti ? '#facc15' : ORANGE_ACTIVE,
      secondaryColor: yellowMulti ? '#fde047' : ORANGE,
    });
  }

  // ---------- historial y cancelación ----------
  _local(o) {
    return {
      p: o.position.clone(),
      q: o.quaternion.clone(),
      s: o.scale.clone(),
      pv: o.pivot ? o.pivot.clone() : new Vector3(),
    };
  }
  _restore(os, st) {
    os.forEach((o, i) => {
      o.position.copy(st[i].p);
      o.quaternion.copy(st[i].q);
      o.scale.copy(st[i].s);
      if (o.pivot && st[i].pv) o.pivot.copy(st[i].pv);
      if (o.updateMatrixWorld) o.updateMatrixWorld();
    });
  }
  _end(d) { this.drag = null; if (this.controls) this.controls.enabled = d.ctrl; }
  _changed() { this._fire('objectChange'); this._fire('change'); }
  _snap(kind) { const v = this[kind + 'Snap'], on = v != null; return on !== this.shift ? (v ?? SNAP_DEFAULT[kind]) : null; }

  // ---------- canvas superpuesto ----------
  _makeOverlay() {
    const cv = document.createElement('canvas');
    Object.assign(cv.style, { position: 'absolute', pointerEvents: 'none', left: '0px', top: '0px' });
    const p = this.domElement.parentNode;
    if (p) p.insertBefore(cv, this.domElement.nextSibling);
    return cv;
  }

  _layout() {
    const el = this.domElement;
    const W = el.clientWidth || el.width || 1;
    const H = el.clientHeight || el.height || 1;
    const dpr = Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, this.maxPixelRatio);
    const ov = this.ov;
    const pw = Math.max(1, Math.round(W * dpr));
    const ph = Math.max(1, Math.round(H * dpr));
    if (ov.width !== pw || ov.height !== ph) { ov.width = pw; ov.height = ph; this._rect = null; }
    this.W = W;
    this.H = H;
    this.dpr = dpr;
    if (this._own) {
      const box = el.offsetLeft + ',' + el.offsetTop + ',' + W + ',' + H;
      if (box !== this._box) {
        this._box = box;
        this._rect = null;
        const s = ov.style;
        s.left = el.offsetLeft + 'px';
        s.top = el.offsetTop + 'px';
        s.width = W + 'px';
        s.height = H + 'px';
      }
    }
  }

  _clear() {
    const c = this.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.ov.width, this.ov.height);
  }

  // ---------- delegaciones de proyección / picking / dibujo / transform ----------
  _proj(p) { return this._renderer2d.project(this.camera, p, this.W, this.H); }
  _frame() { return this._renderer2d.computeFrame(this); }
  _shapes(F) { return this._renderer2d.buildShapes(this, F); }
  _dist(s, x, y) { return this._renderer2d.distToShape(s, x, y); }
  _pick(x, y, touch) { return this._renderer2d.pick(this, x, y, touch, this._ray(x, y).direction); }

  draw(renderer = null) {
    if (this.outliner.mode === 'gpu' && renderer && !renderer.isContextLost?.() && typeof renderer.renderOutline === 'function' && this.outline && this._vis && this.objects.length) {
      const fid = renderer._frameId;
      if (fid === undefined || fid !== this._lastGpuOutlineFrame) {
        this._lastGpuOutlineFrame = fid;
        const yellowMulti = this.multiSelectMode || this.objects.length > 1;
        this.outliner.render(renderer, this.camera, this.objects, {
          activeColor: yellowMulti ? '#facc15' : ORANGE_ACTIVE,
          secondaryColor: yellowMulti ? '#fde047' : ORANGE,
        });
      }
      this._draw2D(true);
      return;
    }
    this._draw2D(false);
  }

  _draw2D(skipOutline) { this._renderer2d.draw2D(this, skipOutline); }

  _xy(e, forceRect = false) {
    const now = performance.now();
    if (forceRect || !this._rect || now - this._rectTime > 250) {
      this._layout();
      this._rect = this.domElement.getBoundingClientRect();
      this._rectTime = now;
    }
    const r = this._rect;
    return [(e.clientX - r.left) * (this.W / (r.width || 1)), (e.clientY - r.top) * (this.H / (r.height || 1))];
  }

  _ray(x, y) { return screenRay(this.camera, this.ray, x, y, this.W, this.H); }
  _closestT(P, D, ray) { return closestT(P, D, ray); }
  _planeHit(P, n, ray) { return planeHit(P, n, ray); }
  _setWorld(o, pos, quat) { setWorldTransform(o, pos, quat); }

  // ---------- interacción ----------
  _down(e) {
    const pid = e.pointerId ?? 1;
    this._pointers.add(pid);
    this._clearLongPress();
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
      this._tap = { x: e.clientX, y: e.clientY, t: performance.now(), id: pid, shift: !!e.shiftKey, longPressed: false };
      if (this.autoSelect && this.picker && this.longPressMs > 0) {
        const snapClientX = e.clientX;
        const snapClientY = e.clientY;
        const touch = e.pointerType !== 'mouse';
        this._longPressTimer = setTimeout(() => {
          this._longPressTimer = 0;
          if (!this._tap || this._tap.id !== pid || this.drag || this._disposed || !this.enabled) return;
          const root = this.selectionRoot || this._sceneRoot();
          if (!root) return;
          const hit = this.picker.pick({ clientX: snapClientX, clientY: snapClientY }, this.camera, root);
          if (!hit) return;
          const targetObj = hit.type === 'bone' ? hit.bone : hit.object;
          if (!targetObj) return;
          this._tap.longPressed = true;
          this._tap = null;
          if (this.controls && typeof this.controls.cancelPointer === 'function') {
            this.controls.cancelPointer(pid);
          }
          this.setMultiSelectMode(true);
          const cur = this.objects.slice();
          const pos = cur.indexOf(targetObj);
          if (pos < 0) cur.push(targetObj);
          else if (cur.length > 1) cur.splice(pos, 1);
          this.attach(cur);
          if (touch && typeof navigator !== 'undefined' && navigator.vibrate) {
            try { navigator.vibrate(18); } catch (_) {}
          }
          this._fire('pick', { hit, object: this.object, objects: this.objects.slice() });
        }, this.longPressMs);
      }
    }
    if (
      !this.enabled ||
      !this._vis ||
      (!this._editPivot && this._mode === 'select') ||
      !this.objects.length ||
      this.drag ||
      (e.pointerType === 'mouse' && e.button !== 0)
    ) {
      return;
    }

    const [x, y] = this._xy(e, true);
    const s = this._pick(x, y, e.pointerType !== 'mouse');
    if (!s) return;

    const F = this._frame();
    if (!F) return;
    const r = this._ray(x, y);
    const d = beginDrag(this, s.key, F, r, x, y, e);
    if (!d) return;

    e.stopImmediatePropagation();
    e.preventDefault();
    this._clearLongPress();
    this._tap = null;
    this._rightTap = null;
    this.drag = d;
    if (this.controls) this.controls.enabled = false;
    try { this.domElement.setPointerCapture(e.pointerId); } catch (_) { /* sin captura */ }
    this.info = { mode: d.type, key: d.key, text: LABEL[d.type] + ' ' + d.key.toUpperCase() };
    this._fire('dragging-changed', { value: true });
    this._fire('dragstart', { mode: d.type, key: d.key, objects: this.objects.slice(), before: d.before });
    this._fire('change');
  }

  _move(e) {
    if (this._tap && e.pointerId === this._tap.id) {
      const tapTol = e.pointerType !== 'mouse' ? 14 : 6;
      if (Math.hypot(e.clientX - this._tap.x, e.clientY - this._tap.y) > tapTol) {
        this._clearLongPress();
      }
    }
    const d = this.drag;
    if (!d) {
      if (e.pointerType === 'mouse' && this.enabled && this._vis && this.objects.length) {
        const [x, y] = this._xy(e);
        const s = this._pick(x, y, false);
        const h = s ? s.key : null;
        let hb = null;
        if (!h && this.pickRigBones && !this._has3DSkeletonHelper()) {
          const rigHelper = this._getRigHelper();
          const rh = rigHelper && rigHelper.pickScreen ? rigHelper.pickScreen(x, y, false) : null;
          if (rh) hb = rh.bone;
        }
        if (h !== this.hover || hb !== this._hoverBone) {
          this.hover = h;
          this._hoverBone = hb;
          this.domElement.style.cursor = h || hb ? 'pointer' : '';
          this._fire('change');
        }
      }
      return;
    }
    if (e.pointerId !== d.id) return;
    const [x, y] = this._xy(e);
    if (!d.moved && Math.hypot(x - d.x0, y - d.y0) < 3) return;
    d.moved = true;
    const r = this._ray(x, y);
    if (!updateDrag(this, d, r, x, y)) return;
    this._fire('drag', { text: d.text });
    this._changed();
  }

  _up(e) {
    const pid = e.pointerId ?? 1;
    this._pointers.delete(pid);
    this._clearLongPress();
    const rt = this._rightTap;
    if (rt && pid === rt.id) {
      this._rightTap = null;
      if (
        !this.drag &&
        this.deselectOnRightClick &&
        this.objects.length &&
        Math.hypot(e.clientX - rt.x, e.clientY - rt.y) <= 5 &&
        performance.now() - rt.t < 350
      ) {
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
      if (!this.drag && Math.hypot(e.clientX - tp.x, e.clientY - tp.y) <= tapTol && now - tp.t < 900) {
        const [x, y] = this._xy(e);
        if (this._has3DSkeletonHelper() && this.boneHelper.pick) {
          this._ray(x, y);
          const bone = this.boneHelper.pick(this.ray.ray);
          if (bone) {
            this.attach(bone);
            this._lastSelectTap = { t: now, obj: bone };
            this._fire('pick', { hit: { type: 'bone', object: bone, bone }, object: bone, objects: this.objects.slice() });
            return;
          }
        }
        if (this.pickRigBones && this.objects.length && !this._has3DSkeletonHelper()) {
          const rigHelper = this._getRigHelper();
          const rigHit = rigHelper && rigHelper.pickScreen ? rigHelper.pickScreen(x, y, touch) : null;
          if (rigHit) {
            this._selectRigBone(rigHit, tp.shift || this.multiSelectMode);
            return;
          }
        }
        if (this.autoSelect && this.picker) {
          const root = this.selectionRoot || this._sceneRoot();
          if (root) {
            const hit = this.picker.pick(e, this.camera, root);
            if (!hit) {
              if (this.deselectOnEmpty && (!tp.shift || this.multiSelectMode) && (this.objects.length || this.multiSelectMode)) {
                this.detach();
              }
              this._lastSelectTap = { t: 0, obj: null };
              this._fire('pick', { hit: null, object: null, objects: [] });
            } else {
              const targetObj = hit.type === 'bone' ? hit.bone : hit.object;
              if (tp.shift || this.multiSelectMode) {
                const cur = this.objects.slice();
                const pos = cur.indexOf(targetObj);
                if (pos >= 0) cur.splice(pos, 1); else cur.push(targetObj);
                this.attach(cur);
                this._fire('pick', { hit, object: this.object, objects: this.objects.slice() });
              } else if (
                this.deselectOnDoubleTap &&
                !(hit.candidates && hit.candidates.length > 1) &&
                this.objects.length === 1 &&
                (this.objects[0] === targetObj || this._isDescendantOf(targetObj, this.objects[0])) &&
                now - this._lastSelectTap.t < 380 &&
                this._lastSelectTap.obj === this.objects[0]
              ) {
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
    if (!d) {
      if (e.pointerType !== 'mouse') { this.hover = null; this._hoverBone = null; }
      return;
    }
    if (e.pointerId !== d.id) return;
    this._end(d);
    try { this.domElement.releasePointerCapture(e.pointerId); } catch (_) { /* nada */ }
    if (d.moved) {
      const h = { os: d.st.map((s) => s.o), before: d.before, after: d.st.map((s) => this._local(s.o)) };
      this._fire('dragend', h);
      if (this.trackHistory) {
        this.undoStack.push(h);
        this.redoStack.length = 0;
        this._fire('history');
      }
    } else {
      const touch = e.pointerType !== 'mouse';
      const tapTol = touch ? 14 : 6;
      const isTap = Math.hypot(e.clientX - d.clientX0, e.clientY - d.clientY0) <= tapTol;
      const canRigPick = isTap && this.pickRigBones && !this._has3DSkeletonHelper();
      const rigHelper = canRigPick ? this._getRigHelper() : null;
      const rigHit = rigHelper && rigHelper.pickScreen ? rigHelper.pickScreen(...this._xy(e), touch) : null;
      const isCenter = d.key === 'free' || d.key === 'uni';
      if (rigHit && (!isCenter || (this.cycleOverlap && rigHit.candidates && rigHit.candidates.length > 1))) {
        this._selectRigBone(rigHit, d.shift);
      } else if (isCenter) {
        const now = performance.now();
        if (now - this._lastTap < 350) {
          this.setSpace(this._space === 'world' ? 'local' : 'world');
          this._lastTap = 0;
        } else {
          this._lastTap = now;
        }
      }
    }
    if (e.pointerType !== 'mouse') { this.hover = null; this._hoverBone = null; }
    this._fire('dragging-changed', { value: false });
    this._fire('change');
  }
}
