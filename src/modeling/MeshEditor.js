import { Vec3 } from '../math/Vec3.js';
import { Quat } from '../math/Quat.js';
import { Mat4 } from '../math/Mat4.js';
import { Raycaster } from '../core/Raycaster.js';
import { GizmoMade3d } from '../gizmo/GizmoMade3d.js';
import { GizmoRenderer2D, clamp, PAIRS } from '../gizmo/GizmoRenderer2D.js';
import { screenRay, closestT, planeHit, SNAP_DEFAULT, LABEL } from '../gizmo/GizmoTransform.js';
import {
  ensureEditableBase,
  syncMeshSubsurf,
  snapshotMeshModelingState,
  restoreMeshModelingState,
  isSubsurfSupported,
  adjustMeshVertexDensity,
} from './SubdivisionSurface.js';

export const EDIT_SELECTION_MODES = ['vertex', 'edge', 'face'];
export const EDIT_TRANSFORM_MODES = ['select', 'translate', 'rotate', 'scale'];
export const EDIT_CUT_MODES = ['knife', 'loop'];

const _tmpVec = new Vec3();
const _tmpVec2 = new Vec3();
const _tmpVec3 = new Vec3();
const _tmpPos = new Vec3();
const _tmpQuat = new Quat();
const _tmpQuat2 = new Quat();
const _tmpScale = new Vec3();
const _invMat = new Mat4();
const _rayTmp0 = new Raycaster();
const _rayTmp1 = new Raycaster();
const _rayLocal0 = { origin: new Vec3(), direction: new Vec3(0, 0, -1) };
const _rayLocal1 = { origin: new Vec3(), direction: new Vec3(0, 0, -1) };

const fmt = (v) => (v < 0 ? '−' : '+') + Math.abs(v).toFixed(2);
const f2 = (v) => v.toFixed(2);

function distToSegment2D(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-6) return Math.hypot(px - ax, py - ay);
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / lenSq, 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Controlador interactivo de Edición 3D (vértices, aristas, caras, mover, rotar, escalar, extruir, dividir)
 * y renderizador 2D de jaulas de control para mallas con Subdivisión Suave.
 */
export class MeshEditor {
  constructor(opts = {}) {
    this.enabled = Boolean(opts.enabled);
    this.mesh = null;
    this.selectionMode = EDIT_SELECTION_MODES.includes(opts.selectionMode) ? opts.selectionMode : 'face';
    this.transformMode = EDIT_TRANSFORM_MODES.includes(opts.transformMode) ? opts.transformMode : 'translate';
    this.cutMode = EDIT_CUT_MODES.includes(opts.cutMode) ? opts.cutMode : 'knife';
    this.cutTool = null; // null | 'knife' | 'loop'
    this.space = opts.space === 'local' ? 'local' : 'world';
    this.snap = Boolean(opts.snap);
    this.size = opts.size ?? GizmoMade3d.SIZE;
    this.look = GizmoMade3d.LOOK;
    this.show = { X: true, Y: true, Z: true };

    this.selectedVertices = new Set();
    this.selectedEdges = new Set();
    this.selectedFaces = new Set();

    this.multiSelectMode = false;
    this.boxSelectMode = false;
    this.longPressMs = 360;

    this.hoverElement = null; // { type, index }
    this.hoverGizmo = null;
    this.drag = null;
    this.cutDrag = null;
    this.boxDrag = null;
    this.info = { mode: 'select', key: null, text: '' };
    this.shift = false;

    this._renderer2d = new GizmoRenderer2D();
    this._ray = new Raycaster();
    this._pointers = new Set();
    this._tap = null;
    this._longPressTimer = null;
    this._captureEl = null;
    this._attached = null;
    this._cleanup = null;
    this._W = 1;
    this._H = 1;
    this._dpr = 1;
    this._normalMat3 = new Float32Array(9);
    this._lastSpaceTap = 0;
  }

  static isEditable(obj) {
    return isSubsurfSupported(obj);
  }

  get baseMesh() {
    if (!this.mesh) return null;
    if (
      !this.mesh._subsurf ||
      !this.mesh._subsurf.baseMesh ||
      this.mesh._subsurfDirtyFromGeometry ||
      (this.mesh.geometry && this.mesh.geometry._modifiedBySculpt && !this.mesh.geometry._isGeneratedSubsurf)
    ) {
      ensureEditableBase(this.mesh);
    }
    return this.mesh._subsurf?.baseMesh || null;
  }

  getActiveSelectionSet() {
    if (this.selectionMode === 'vertex') return this.selectedVertices;
    if (this.selectionMode === 'edge') return this.selectedEdges;
    return this.selectedFaces;
  }

  setActiveSelectionSet(nextSet) {
    if (this.selectionMode === 'vertex') this.selectedVertices = nextSet;
    else if (this.selectionMode === 'edge') this.selectedEdges = nextSet;
    else this.selectedFaces = nextSet;
  }

  getSelectionCount() {
    return this.getActiveSelectionSet().size;
  }

  getStats() {
    const base = this.baseMesh;
    if (!base) return { verts: 0, edges: 0, faces: 0, selectedCount: 0, selectedVerts: 0 };
    const selVerts = base.getSelectedVertexIndices(this.selectionMode, this.getActiveSelectionSet());
    return {
      verts: base.verts.length,
      edges: base.getEdges().length,
      faces: base.faces.length,
      selectedCount: this.getSelectionCount(),
      selectedVerts: selVerts.size,
    };
  }

  setMesh(mesh) {
    if (this.drag) this.cancelDrag();
    if (this.cutDrag) this.cancelCutDrag();
    this.clearSelection();
    this.hoverElement = null;
    this.hoverGizmo = null;
    if (!mesh || !isSubsurfSupported(mesh)) {
      this.mesh = null;
      this._attached?.onSelectionChange?.(this.getStats());
      return null;
    }
    ensureEditableBase(mesh);
    this.mesh = mesh;
    this._attached?.onSelectionChange?.(this.getStats());
    return mesh;
  }

  setSelectionMode(mode) {
    if (!EDIT_SELECTION_MODES.includes(mode) || mode === this.selectionMode) return this;
    const prevMode = this.selectionMode;
    const base = this.baseMesh;
    if (base) {
      const prevSet = this.getActiveSelectionSet();
      const nextSet = new Set();
      const topo = base.getTopology();

      if (prevMode === 'vertex') {
        if (mode === 'edge') {
          for (let ei = 0; ei < topo.edges.length; ei++) {
            const e = topo.edges[ei];
            if (prevSet.has(e.a) && prevSet.has(e.b)) nextSet.add(ei);
          }
        } else if (mode === 'face') {
          for (let fi = 0; fi < base.faces.length; fi++) {
            if (base.faces[fi].every((vi) => prevSet.has(vi))) nextSet.add(fi);
          }
        }
      } else if (prevMode === 'edge') {
        if (mode === 'vertex') {
          for (const ei of prevSet) {
            const e = topo.edges[ei];
            if (e) { nextSet.add(e.a); nextSet.add(e.b); }
          }
        } else if (mode === 'face') {
          for (let fi = 0; fi < base.faces.length; fi++) {
            const fe = topo.faceEdges[fi] || [];
            if (fe.length && fe.every((ei) => prevSet.has(ei))) nextSet.add(fi);
          }
        }
      } else if (prevMode === 'face') {
        if (mode === 'vertex') {
          for (const fi of prevSet) {
            const f = base.faces[fi];
            if (f) f.forEach((vi) => nextSet.add(vi));
          }
        } else if (mode === 'edge') {
          for (const fi of prevSet) {
            const fe = topo.faceEdges[fi] || [];
            fe.forEach((ei) => nextSet.add(ei));
          }
        }
      }

      this.selectionMode = mode;
      this.setActiveSelectionSet(nextSet);
    } else {
      this.selectionMode = mode;
    }

    this.hoverElement = null;
    this.hoverGizmo = null;
    this._attached?.onSelectionChange?.(this.getStats());
    return this;
  }

  setTransformMode(mode) {
    if (!EDIT_TRANSFORM_MODES.includes(mode)) return this;
    if (this.drag) this.cancelDrag();
    if (this.cutDrag) this.cancelCutDrag();
    this.cutTool = null;
    this.transformMode = mode;
    this.hoverGizmo = null;
    this._attached?.onModeChange?.(mode);
    return this;
  }

  setCutMode(mode) {
    if (!EDIT_CUT_MODES.includes(mode)) return this;
    this.cutMode = mode;
    if (this.cutTool) this.cutTool = mode;
    this._attached?.onModeChange?.(this.cutTool || this.transformMode);
    return this;
  }

  setCutTool(modeOrNull) {
    if (this.drag) this.cancelDrag();
    if (this.cutDrag) this.cancelCutDrag();
    if (!modeOrNull) {
      this.cutTool = null;
    } else {
      const m = EDIT_CUT_MODES.includes(modeOrNull) ? modeOrNull : this.cutMode;
      this.cutMode = m;
      this.cutTool = m;
    }
    this.hoverGizmo = null;
    const targetEl =
      typeof this._attached?.pointerDownTarget === 'function'
        ? this._attached.pointerDownTarget()
        : this._attached?.pointerDownTarget;
    if (targetEl && !this.cutTool) targetEl.style.cursor = '';
    this._attached?.onModeChange?.(this.cutTool || this.transformMode);
    return this;
  }

  setSpace(space) {
    this.space = space === 'local' ? 'local' : 'world';
    return this;
  }

  setSnap(on) {
    this.snap = Boolean(on);
    return this;
  }

  setMultiSelectMode(on) {
    const next = Boolean(on);
    if (this.multiSelectMode === next) return this;
    this.multiSelectMode = next;
    this._attached?.onSelectionChange?.(this.getStats());
    this._attached?.onModeChange?.(this.cutTool || this.transformMode);
    return this;
  }

  setBoxSelectMode(on) {
    const next = Boolean(on);
    if (this.boxSelectMode === next) return this;
    this.boxSelectMode = next;
    if (!next && this.boxDrag) this.cancelBoxDrag();
    this._attached?.onModeChange?.(this.cutTool || this.transformMode);
    return this;
  }

  clearSelection({ exitMultiSelect = true } = {}) {
    this.selectedVertices.clear();
    this.selectedEdges.clear();
    this.selectedFaces.clear();
    if (exitMultiSelect) this.multiSelectMode = false;
    this._attached?.onSelectionChange?.(this.getStats());
  }

  selectAll() {
    const base = this.baseMesh;
    if (!base) return;
    const set = this.getActiveSelectionSet();
    const count =
      this.selectionMode === 'vertex'
        ? base.verts.length
        : this.selectionMode === 'edge'
        ? base.getEdges().length
        : base.faces.length;
    if (set.size === count && count > 0) {
      set.clear();
    } else {
      set.clear();
      for (let i = 0; i < count; i++) set.add(i);
    }
    this._attached?.onSelectionChange?.(this.getStats());
  }

  invertSelection() {
    const base = this.baseMesh;
    if (!base) return;
    const set = this.getActiveSelectionSet();
    const count =
      this.selectionMode === 'vertex'
        ? base.verts.length
        : this.selectionMode === 'edge'
        ? base.getEdges().length
        : base.faces.length;
    const next = new Set();
    for (let i = 0; i < count; i++) {
      if (!set.has(i)) next.add(i);
    }
    this.setActiveSelectionSet(next);
    this._attached?.onSelectionChange?.(this.getStats());
  }

  subdivideSelection(cuts = 1) {
    const mesh = this.mesh;
    const base = this.baseMesh;
    if (!mesh || !base) return { changed: false };

    const beforeState = snapshotMeshModelingState(mesh);
    const res = base.subdivideSelection(this.selectionMode, this.getActiveSelectionSet(), cuts);
    if (!res.changed) return res;

    this.setActiveSelectionSet(res.selected);
    syncMeshSubsurf(mesh);
    const afterState = snapshotMeshModelingState(mesh);

    this._attached?.onEditCommit?.({
      mesh,
      beforeState,
      afterState,
      label: 'Dividir geometría',
    });
    this._attached?.onSelectionChange?.(this.getStats());
    return { changed: true, stats: this.getStats() };
  }

  extrudeSelection(distance = 0.06) {
    const mesh = this.mesh;
    const base = this.baseMesh;
    if (!mesh || !base) return { changed: false };
    const sel = this.getActiveSelectionSet();
    if (!sel.size) return { changed: false, error: 'Selecciona primero caras, aristas o vértices para extruir.' };

    const beforeState = snapshotMeshModelingState(mesh);
    const res = base.extrudeSelection(this.selectionMode, sel, distance);
    if (!res.changed) return res;

    this.setActiveSelectionSet(res.selected);
    syncMeshSubsurf(mesh);
    const afterState = snapshotMeshModelingState(mesh);

    if (this.transformMode === 'select') {
      this.setTransformMode('translate');
    }

    this._attached?.onEditCommit?.({
      mesh,
      beforeState,
      afterState,
      label: 'Extruir selección',
    });
    this._attached?.onSelectionChange?.(this.getStats());
    return { changed: true, stats: this.getStats() };
  }

  deleteSelectedElements() {
    const mesh = this.mesh;
    const base = this.baseMesh;
    if (!mesh || !base) return { changed: false };
    const sel = this.getActiveSelectionSet();
    if (!sel.size) return { changed: false, error: 'No hay elementos seleccionados para eliminar.' };

    const beforeState = snapshotMeshModelingState(mesh);
    const res = base.deleteSelection(this.selectionMode, sel);
    if (!res.changed) return res;

    this.clearSelection();
    syncMeshSubsurf(mesh);
    const afterState = snapshotMeshModelingState(mesh);

    this._attached?.onEditCommit?.({
      mesh,
      beforeState,
      afterState,
      label: 'Eliminar elementos',
    });
    this._attached?.onSelectionChange?.(this.getStats());
    return { changed: true, stats: this.getStats() };
  }

  bevelSelection(width = 0.08, segments = 1) {
    const mesh = this.mesh;
    const base = this.baseMesh;
    if (!mesh || !base) return { changed: false };
    const sel = this.getActiveSelectionSet();
    if (!sel.size) return { changed: false, error: 'Selecciona caras, aristas o vértices para biselar.' };

    const beforeState = snapshotMeshModelingState(mesh);
    const res = base.bevelSelection(this.selectionMode, sel, width, segments);
    if (!res.changed) return res;

    this.setActiveSelectionSet(res.selected || new Set());
    syncMeshSubsurf(mesh);
    const afterState = snapshotMeshModelingState(mesh);

    this._attached?.onEditCommit?.({
      mesh,
      beforeState,
      afterState,
      label: 'Biselar selección',
    });
    this._attached?.onSelectionChange?.(this.getStats());
    return { changed: true, stats: this.getStats() };
  }

  fillOrBridgeSelection() {
    const mesh = this.mesh;
    const base = this.baseMesh;
    if (!mesh || !base) return { changed: false };
    const sel = this.getActiveSelectionSet();
    if (!sel.size) {
      return { changed: false, error: 'Selecciona un contorno abierto para rellenar o 2 bucles/caras para puente.' };
    }

    const beforeState = snapshotMeshModelingState(mesh);
    const res = base.fillOrBridge(this.selectionMode, sel);
    if (!res.changed) return res;

    if (res.selected && res.selected.size) {
      this.setActiveSelectionSet(res.selected);
    }
    syncMeshSubsurf(mesh);
    const afterState = snapshotMeshModelingState(mesh);

    this._attached?.onEditCommit?.({
      mesh,
      beforeState,
      afterState,
      label: res.op === 'bridge' ? 'Puente poligonal' : 'Rellenar hueco',
    });
    this._attached?.onSelectionChange?.(this.getStats());
    return { changed: true, op: res.op, createdFaces: res.createdFaces, stats: this.getStats() };
  }

  mergeByDistance(threshold = 0.005) {
    const mesh = this.mesh;
    const base = this.baseMesh;
    if (!mesh || !base) return { changed: false };
    const sel = this.getActiveSelectionSet();
    const selVerts = sel.size ? base.getSelectedVertexIndices(this.selectionMode, sel) : null;
    const targetVerts = selVerts && selVerts.size >= 2 ? selVerts : null;

    const beforeState = snapshotMeshModelingState(mesh);
    const res = base.mergeByDistance(threshold, targetVerts);
    if (!res.changed) {
      return { changed: false, error: 'No se encontraron vértices dentro de esa distancia para fusionar.' };
    }

    if (this.selectionMode === 'vertex' && res.selected?.size) {
      this.selectedVertices = res.selected;
    } else {
      this.clearSelection({ exitMultiSelect: false });
    }
    syncMeshSubsurf(mesh);
    const afterState = snapshotMeshModelingState(mesh);

    this._attached?.onEditCommit?.({
      mesh,
      beforeState,
      afterState,
      label: `Fusionar ${res.mergedCount} vértice(s)`,
    });
    this._attached?.onSelectionChange?.(this.getStats());
    return { changed: true, mergedCount: res.mergedCount, stats: this.getStats() };
  }

  setSelectionCrease(value) {
    const mesh = this.mesh;
    const base = this.baseMesh;
    if (!mesh || !base) return { changed: false };
    const sel = this.getActiveSelectionSet();
    if (!sel.size) return { changed: false, error: 'Selecciona aristas, caras o vértices primero.' };

    const beforeState = snapshotMeshModelingState(mesh);
    const res = base.setSelectionCrease(this.selectionMode, sel, value);
    if (!res.changed) return res;

    syncMeshSubsurf(mesh);
    const afterState = snapshotMeshModelingState(mesh);

    this._attached?.onEditCommit?.({
      mesh,
      beforeState,
      afterState,
      label: `Dureza de arista (${Math.round(res.value * 100)}%)`,
    });
    this._attached?.onSelectionChange?.(this.getStats());
    return { changed: true, count: res.count, value: res.value };
  }

  getSelectionAverageCrease() {
    const base = this.baseMesh;
    if (!base) return 0;
    return base.getSelectionAverageCrease(this.selectionMode, this.getActiveSelectionSet());
  }

  adjustVertexDensity(opts = {}) {
    const mesh = this.mesh;
    const base = this.baseMesh;
    if (!mesh || !base) return { changed: false, error: 'No hay malla activa para editar.' };

    const beforeState = snapshotMeshModelingState(mesh);
    const res = adjustMeshVertexDensity(base, opts);
    if (!res.changed) return res;

    this.clearSelection({ exitMultiSelect: false });
    syncMeshSubsurf(mesh);
    const afterState = snapshotMeshModelingState(mesh);

    this._attached?.onEditCommit?.({
      mesh,
      beforeState,
      afterState,
      label: `Ajustar densidad (${res.beforeVerts} → ${res.afterVerts} V)`,
    });
    this._attached?.onSelectionChange?.(this.getStats());
    return {
      changed: true,
      beforeVerts: res.beforeVerts,
      afterVerts: res.afterVerts,
      faceCount: res.faceCount,
      stats: this.getStats(),
    };
  }

  getSelectionCentroidLocal(out = new Vec3()) {
    const base = this.baseMesh;
    if (!base) return null;
    const selVerts = base.getSelectedVertexIndices(this.selectionMode, this.getActiveSelectionSet());
    if (!selVerts.size) return null;
    out.set(0, 0, 0);
    for (const vi of selVerts) {
      const v = base.verts[vi];
      if (!v) continue;
      out.x += v.x;
      out.y += v.y;
      out.z += v.z;
    }
    out.multiplyScalar(1 / selVerts.size);
    return out;
  }

  translateSelectionLocal(dx = 0, dy = 0, dz = 0) {
    const mesh = this.mesh;
    const base = this.baseMesh;
    if (!mesh || !base) return false;
    const selVerts = base.getSelectedVertexIndices(this.selectionMode, this.getActiveSelectionSet());
    if (!selVerts.size) return false;
    for (const vi of selVerts) {
      const v = base.verts[vi];
      if (!v) continue;
      v.x += dx;
      v.y += dy;
      v.z += dz;
    }
    base.invalidateTopology();
    syncMeshSubsurf(mesh);
    return true;
  }

  setSelectionCentroidAxis(axis, value) {
    if (axis !== 'x' && axis !== 'y' && axis !== 'z') return false;
    const val = Number(value);
    if (!Number.isFinite(val)) return false;
    const c = this.getSelectionCentroidLocal(_tmpVec);
    if (!c) return false;
    const delta = val - c[axis];
    return this.translateSelectionLocal(
      axis === 'x' ? delta : 0,
      axis === 'y' ? delta : 0,
      axis === 'z' ? delta : 0
    );
  }

  _getSelectionCentroidWorld(out = new Vec3()) {
    const mesh = this.mesh;
    const base = this.baseMesh;
    if (!mesh || !base) return null;
    const selVerts = base.getSelectedVertexIndices(this.selectionMode, this.getActiveSelectionSet());
    if (!selVerts.size) return null;
    mesh.updateWorldMatrix(true, false);
    out.set(0, 0, 0);
    for (const vi of selVerts) {
      const v = base.verts[vi];
      _tmpVec.set(v.x, v.y, v.z).applyMatrix4(mesh.matrixWorld);
      out.add(_tmpVec);
    }
    out.multiplyScalar(1 / selVerts.size);
    return out;
  }

  _localDirToWorld(lx, ly, lz, out = new Vec3()) {
    const e = this.mesh.matrixWorld.elements;
    out.set(
      e[0] * lx + e[4] * ly + e[8] * lz,
      e[1] * lx + e[5] * ly + e[9] * lz,
      e[2] * lx + e[6] * ly + e[10] * lz
    );
    const len = out.length();
    return len > 1e-8 ? out.multiplyScalar(1 / len) : null;
  }

  _localNormalToWorld(lx, ly, lz, out = new Vec3()) {
    const m = this._normalMat3;
    out.set(
      m[0] * lx + m[3] * ly + m[6] * lz,
      m[1] * lx + m[4] * ly + m[7] * lz,
      m[2] * lx + m[5] * ly + m[8] * lz
    );
    const len = out.length();
    return len > 1e-8 ? out.multiplyScalar(1 / len) : null;
  }

  getGizmoAxes() {
    if (!this.mesh) {
      return {
        x: new Vec3(1, 0, 0),
        y: new Vec3(0, 1, 0),
        z: new Vec3(0, 0, 1),
      };
    }

    this.mesh.updateWorldMatrix(true, false);
    const bq = new Quat();
    this.mesh.matrixWorld.decompose(_tmpPos, bq, _tmpScale);
    const objX = new Vec3(1, 0, 0).applyQuaternion(bq).normalize();
    const objY = new Vec3(0, 1, 0).applyQuaternion(bq).normalize();
    const objZ = new Vec3(0, 0, 1).applyQuaternion(bq).normalize();

    if (this.space !== 'local') {
      return {
        x: new Vec3(1, 0, 0),
        y: new Vec3(0, 1, 0),
        z: new Vec3(0, 0, 1),
      };
    }

    const base = this.baseMesh;
    if (!base) {
      return { x: objX, y: objY, z: objZ };
    }

    this.mesh.matrixWorld.normalMatrix(this._normalMat3);

    const orthoFrameFromNZ = (zAxis, tangentHint) => {
      const z = zAxis.clone().normalize();
      const x = new Vec3();
      const candidates = [];
      if (tangentHint) candidates.push(tangentHint);
      candidates.push(objX, objZ, new Vec3(1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 1, 0));
      let found = false;
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        if (!c) continue;
        x.copy(c).addScaledVector(z, -c.dot(z));
        if (x.lengthSq() > 1e-8) {
          x.normalize();
          found = true;
          break;
        }
      }
      if (!found) x.set(1, 0, 0);
      const y = new Vec3().crossVectors(z, x).normalize();
      return { x, y, z };
    };

    if (this.selectionMode === 'face' && this.selectedFaces.size > 0) {
      const sumN = new Vec3();
      let lastFi = -1;
      for (const fi of this.selectedFaces) {
        if (fi < 0 || fi >= base.faces.length) continue;
        base.computeFaceAreaNormal(fi, _tmpVec);
        sumN.add(_tmpVec);
        lastFi = fi;
      }
      const zAxis = sumN.lengthSq() > 1e-10
        ? this._localNormalToWorld(sumN.x, sumN.y, sumN.z, new Vec3())
        : null;
      if (zAxis) {
        let tanW = null;
        if (lastFi >= 0) {
          const f = base.faces[lastFi];
          if (f && f.length >= 2) {
            const va = base.verts[f[0]];
            const vb = base.verts[f[1]];
            tanW = this._localDirToWorld(vb.x - va.x, vb.y - va.y, vb.z - va.z, new Vec3());
          }
        }
        return orthoFrameFromNZ(zAxis, tanW);
      }
    } else if (this.selectionMode === 'edge' && this.selectedEdges.size > 0) {
      const edges = base.getEdges();
      const sumN = new Vec3();
      const faceSeen = new Set();
      let lastEdge = null;
      let edgeCount = 0;
      for (const ei of this.selectedEdges) {
        const edge = edges[ei];
        if (!edge) continue;
        lastEdge = edge;
        edgeCount++;
        if (edge.faces && edge.faces.length) {
          for (let i = 0; i < edge.faces.length; i++) {
            const fi = edge.faces[i];
            if (faceSeen.has(fi)) continue;
            faceSeen.add(fi);
            base.computeFaceAreaNormal(fi, _tmpVec);
            sumN.add(_tmpVec);
          }
        } else {
          base.computeVertexNormal(edge.a, _tmpVec);
          sumN.add(_tmpVec);
          base.computeVertexNormal(edge.b, _tmpVec);
          sumN.add(_tmpVec);
        }
      }

      const nWorld = sumN.lengthSq() > 1e-10
        ? this._localNormalToWorld(sumN.x, sumN.y, sumN.z, new Vec3())
        : null;
      const edgeDir = lastEdge
        ? this._localDirToWorld(
            base.verts[lastEdge.b].x - base.verts[lastEdge.a].x,
            base.verts[lastEdge.b].y - base.verts[lastEdge.a].y,
            base.verts[lastEdge.b].z - base.verts[lastEdge.a].z,
            new Vec3()
          )
        : null;

      if (edgeCount === 1 && edgeDir) {
        const x = edgeDir;
        const z = new Vec3();
        const refList = [nWorld, objZ, objY, new Vec3(0, 1, 0), new Vec3(0, 0, 1)];
        for (let i = 0; i < refList.length; i++) {
          const ref = refList[i];
          if (!ref) continue;
          z.copy(ref).addScaledVector(x, -ref.dot(x));
          if (z.lengthSq() > 1e-8) {
            z.normalize();
            const y = new Vec3().crossVectors(z, x).normalize();
            return { x, y, z };
          }
        }
      }
      if (nWorld) {
        return orthoFrameFromNZ(nWorld, edgeDir);
      }
    } else if (this.selectionMode === 'vertex' && this.selectedVertices.size > 0) {
      const sumN = new Vec3();
      for (const vi of this.selectedVertices) {
        if (vi < 0 || vi >= base.verts.length) continue;
        base.computeVertexNormal(vi, _tmpVec);
        sumN.add(_tmpVec);
      }
      const zAxis = sumN.lengthSq() > 1e-10
        ? this._localNormalToWorld(sumN.x, sumN.y, sumN.z, new Vec3())
        : null;
      if (zAxis) {
        return orthoFrameFromNZ(zAxis, null);
      }
    }

    return { x: objX, y: objY, z: objZ };
  }

  _buildProxyGizmoState(camera, W, H) {
    const P = this._getSelectionCentroidWorld(new Vec3());
    if (!P || !camera) return null;

    const ax = this.getGizmoAxes();

    camera.updateWorldMatrix(true, false);
    if (camera.updateViewMatrix) camera.updateViewMatrix();
    const e = camera.matrixWorld.elements;
    const cp = new Vec3(e[12], e[13], e[14]);
    const dist = Math.max(1e-3, cp.distanceTo(P));
    const px = this.size <= 1 ? this.size * H : this.size;
    const worldH = camera.fov
      ? 2 * dist * Math.tan((camera.fov * Math.PI) / 360)
      : Math.abs((camera.top ?? 1) - (camera.bottom ?? -1));

    const pr = this._renderer2d.project(camera, P, W, H);
    const frame = {
      P,
      ax,
      L: (px * worldH) / Math.max(1, H),
      view: new Vec3().copy(P).sub(cp).normalize(),
      vis: pr.w > 0.01,
      back: new Vec3(e[8], e[9], e[10]).normalize(),
      right: new Vec3(e[0], e[1], e[2]).normalize(),
      up: new Vec3(e[4], e[5], e[6]).normalize(),
      isPivotEdit: false,
    };

    const proxy = {
      _mode: this.transformMode,
      editPivot: false,
      _space: this.space,
      camera,
      W,
      H,
      size: this.size,
      look: this.look,
      show: this.show,
      hover: this.hoverGizmo,
      drag: this.drag,
    };

    return { proxy, frame };
  }

  _pickGizmo(camera, x, y, touch) {
    if (this.transformMode === 'select') return null;
    const state = this._buildProxyGizmoState(camera, this._W, this._H);
    if (!state || !state.frame.vis) return null;
    const ray = screenRay(camera, this._ray, x, y, this._W, this._H);
    const shapes = this._renderer2d.buildShapes(state.proxy, state.frame);
    const T = touch ? 18 : 12;
    let best = null;
    let bd = Infinity;
    for (let i = 0; i < shapes.length; i++) {
      const s = shapes[i];
      if (s.f < 0.25) continue;
      if (s.n && Math.abs(s.n.dot(ray.direction)) < 0.08) continue;
      let d = this._renderer2d.distToShape(s, x, y);
      if (d > (s.kind === 'dot' ? T / 2 : T)) continue;
      d -= s.kind === 'dot' ? 100 : s.kind === 'quad' ? 8 : 0;
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    return best ? { shape: best, frame: state.frame, ray } : null;
  }

  _pickElement(camera, x, y, touch) {
    const mesh = this.mesh;
    const base = this.baseMesh;
    if (!mesh || !base || !camera) return null;

    mesh.updateWorldMatrix(true, false);
    _invMat.copyInverse(mesh.matrixWorld);
    const ray = screenRay(camera, this._ray, x, y, this._W, this._H);
    const faceHit = base.raycastFace(ray, _invMat);

    if (this.selectionMode === 'face') {
      return faceHit ? { type: 'face', index: faceHit.faceIndex } : null;
    }

    const hitFaceVerts = new Set();
    const hitFaceEdgeKeys = new Set();
    if (faceHit) {
      const f = base.faces[faceHit.faceIndex];
      if (f) {
        for (let i = 0; i < f.length; i++) {
          const a = f[i], b = f[(i + 1) % f.length];
          hitFaceVerts.add(a);
          hitFaceEdgeKeys.add(a < b ? `${a}_${b}` : `${b}_${a}`);
        }
      }
    }

    if (this.selectionMode === 'vertex') {
      const tol = touch ? 20 : 13;
      let best = null;
      let bestScore = Infinity;
      for (let vi = 0; vi < base.verts.length; vi++) {
        const v = base.verts[vi];
        _tmpVec.set(v.x, v.y, v.z).applyMatrix4(mesh.matrixWorld);
        const p = this._renderer2d.project(camera, _tmpVec, this._W, this._H);
        if (p.w <= 0.01) continue;
        const dist2D = Math.hypot(x - p.x, y - p.y);
        if (dist2D > tol) continue;
        const onHitFace = hitFaceVerts.has(vi) ? 0 : 18;
        const score = dist2D + onHitFace + p.w * 0.05;
        if (score < bestScore) {
          bestScore = score;
          best = { type: 'vertex', index: vi };
        }
      }
      return best;
    }

    // selectionMode === 'edge'
    const tol = touch ? 17 : 11;
    const edges = base.getEdges();
    let best = null;
    let bestScore = Infinity;
    for (let ei = 0; ei < edges.length; ei++) {
      const e = edges[ei];
      const va = base.verts[e.a];
      const vb = base.verts[e.b];
      _tmpPos.set(va.x, va.y, va.z).applyMatrix4(mesh.matrixWorld);
      _tmpVec.set(vb.x, vb.y, vb.z).applyMatrix4(mesh.matrixWorld);
      const pa = this._renderer2d.project(camera, _tmpPos, this._W, this._H);
      const pb = this._renderer2d.project(camera, _tmpVec, this._W, this._H);
      if (pa.w <= 0.01 || pb.w <= 0.01) continue;
      const dist2D = distToSegment2D(x, y, pa.x, pa.y, pb.x, pb.y);
      if (dist2D > tol) continue;
      const onHitFace = hitFaceEdgeKeys.has(e.key) ? 0 : 16;
      const midW = (pa.w + pb.w) * 0.5;
      const score = dist2D + onHitFace + midW * 0.05;
      if (score < bestScore) {
        bestScore = score;
        best = { type: 'edge', index: ei };
      }
    }
    return best;
  }

  _snapVal(kind) {
    const on = this.snap !== this.shift;
    return on ? SNAP_DEFAULT[kind] : null;
  }

  _beginDrag(pickRes, x, y, e) {
    const base = this.baseMesh;
    const mesh = this.mesh;
    if (!base || !mesh) return null;

    const selVerts = base.getSelectedVertexIndices(this.selectionMode, this.getActiveSelectionSet());
    if (!selVerts.size) return null;

    mesh.updateWorldMatrix(true, false);
    const matWorld = mesh.matrixWorld.clone();
    const invWorld = new Mat4().copyInverse(matWorld);
    const beforeState = snapshotMeshModelingState(mesh);

    const startLocal = new Map();
    const startWorld = new Map();
    for (const vi of selVerts) {
      const v = base.verts[vi];
      const lv = new Vec3(v.x, v.y, v.z);
      const wv = lv.clone().applyMatrix4(matWorld);
      startLocal.set(vi, lv);
      startWorld.set(vi, wv);
    }

    const { shape, frame: F, ray } = pickRes;
    const key = shape.key;
    const m = this.transformMode;
    const axn = /^[xyz][+-]?$/.test(key) ? key[0] : null;
    const sg = key[1] === '-' ? -1 : 1;
    const A = axn ? new Vec3().copy(F.ax[axn]).multiplyScalar(sg) : null;

    const d = {
      key,
      axis: axn,
      sg,
      type: m,
      P0: F.P.clone(),
      L: F.L,
      ax: F.ax,
      x0: x,
      y0: y,
      clientX0: e.clientX,
      clientY0: e.clientY,
      id: e.pointerId,
      moved: false,
      text: '',
      raw: 0,
      acc: 0,
      accShown: 0,
      beforeState,
      startLocal,
      startWorld,
      matWorld,
      invWorld,
      ctrl: this._attached?.getControls?.()?.enabled ?? true,
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

  _updateDrag(d, ray, x, y) {
    const base = this.baseMesh;
    const mesh = this.mesh;
    if (!base || !mesh) return false;

    let text = '';
    let snapped = false;

    if (d.type === 'translate') {
      const sn = this._snapVal('translation');
      snapped = !!sn;
      const del = new Vec3();
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

      for (const [vi, w0] of d.startWorld.entries()) {
        _tmpVec.copy(w0).add(del).applyMatrix4(d.invWorld);
        base.verts[vi].x = _tmpVec.x;
        base.verts[vi].y = _tmpVec.y;
        base.verts[vi].z = _tmpVec.z;
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
      const sn = this._snapVal('rotation');
      snapped = !!sn;
      if (sn) a = Math.round(a / sn) * sn;
      d.accShown = a;
      const dq = _tmpQuat2.setFromAxisAngle(d.A, a);

      for (const [vi, w0] of d.startWorld.entries()) {
        _tmpVec.copy(w0).sub(d.P0).applyQuaternion(dq).add(d.P0).applyMatrix4(d.invWorld);
        base.verts[vi].x = _tmpVec.x;
        base.verts[vi].y = _tmpVec.y;
        base.verts[vi].z = _tmpVec.z;
      }
      text = `${((a * 180) / Math.PI).toFixed(1)}°`;
    } else if (d.type === 'scale') {
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
      const sn = this._snapVal('scale');
      snapped = !!sn;
      if (sn) f = Math.round(f / sn) * sn;
      f = Math.max(0.01, f);

      const scaleX = !d.axis && !d.axes ? f : (d.axis === 'x' || d.axes?.includes('x') ? f : 1);
      const scaleY = !d.axis && !d.axes ? f : (d.axis === 'y' || d.axes?.includes('y') ? f : 1);
      const scaleZ = !d.axis && !d.axes ? f : (d.axis === 'z' || d.axes?.includes('z') ? f : 1);

      for (const [vi, w0] of d.startWorld.entries()) {
        const rel = _tmpPos.copy(w0).sub(d.P0);
        const cx = rel.dot(d.ax.x) * scaleX;
        const cy = rel.dot(d.ax.y) * scaleY;
        const cz = rel.dot(d.ax.z) * scaleZ;
        _tmpVec
          .copy(d.P0)
          .addScaledVector(d.ax.x, cx)
          .addScaledVector(d.ax.y, cy)
          .addScaledVector(d.ax.z, cz)
          .applyMatrix4(d.invWorld);
        base.verts[vi].x = _tmpVec.x;
        base.verts[vi].y = _tmpVec.y;
        base.verts[vi].z = _tmpVec.z;
      }
      text = `×${f2(f)}`;
    }

    base.invalidateTopology();
    syncMeshSubsurf(mesh);

    d.text = text + (snapped ? '  · snap' : '');
    this.info = { mode: d.type, key: d.key, text: (LABEL[d.type] || d.type) + ' ' + d.text };
    this._attached?.onReadoutChange?.(this.info.text);
    return true;
  }

  cancelDrag() {
    const d = this.drag;
    if (!d) return false;
    restoreMeshModelingState(this.mesh, d.beforeState);
    this.drag = null;
    this.info = { mode: this.transformMode, key: null, text: '' };
    const ctrl = this._attached?.getControls?.();
    if (ctrl) ctrl.enabled = this._attached?.getControlsEnabled ? Boolean(this._attached.getControlsEnabled()) : d.ctrl;
    this._releasePointerCapture(d.id);
    this._attached?.onReadoutChange?.('');
    return true;
  }

  cancelCutDrag() {
    const cd = this.cutDrag;
    if (!cd) return false;
    this.cutDrag = null;
    const ctrl = this._attached?.getControls?.();
    if (ctrl) ctrl.enabled = this._attached?.getControlsEnabled ? Boolean(this._attached.getControlsEnabled()) : cd.ctrl;
    this._releasePointerCapture(cd.id);
    this._attached?.onReadoutChange?.('');
    return true;
  }

  cancelBoxDrag() {
    const bd = this.boxDrag;
    if (!bd) return false;
    this.boxDrag = null;
    const ctrl = this._attached?.getControls?.();
    if (ctrl) ctrl.enabled = this._attached?.getControlsEnabled ? Boolean(this._attached.getControlsEnabled()) : bd.ctrl;
    this._releasePointerCapture(bd.id);
    this._attached?.onReadoutChange?.('');
    return true;
  }

  _clearLongPress() {
    if (this._longPressTimer) {
      clearTimeout(this._longPressTimer);
      this._longPressTimer = null;
    }
  }

  _selectElementsInBox(camera, x0, y0, x1, y1, additive = false) {
    const mesh = this.mesh;
    const base = this.baseMesh;
    if (!mesh || !base || !camera) return 0;
    const minX = Math.min(x0, x1);
    const maxX = Math.max(x0, x1);
    const minY = Math.min(y0, y1);
    const maxY = Math.max(y0, y1);

    const pts = this._projectBaseVerts(camera, mesh, base, this._W, this._H);
    const set = this.getActiveSelectionSet();
    if (!additive) set.clear();

    const inBox = (p) => p && p.w > 0.01 && p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY;
    const segHitsBox = (ax, ay, bx, by) => {
      if (ax >= minX && ax <= maxX && ay >= minY && ay <= maxY) return true;
      if (bx >= minX && bx <= maxX && by >= minY && by <= maxY) return true;
      // Comprobar intersección contra los 4 lados del rectángulo
      const clipEdge = (xA, yA, xB, yB, cx0, cy0, cx1, cy1) => {
        const ddx = xB - xA, ddy = yB - yA;
        const edx = cx1 - cx0, edy = cy1 - cy0;
        const den = ddx * edy - ddy * edx;
        if (Math.abs(den) < 1e-8) return false;
        const t = ((cx0 - xA) * edy - (cy0 - yA) * edx) / den;
        const u = ((cx0 - xA) * ddy - (cy0 - yA) * ddx) / den;
        return t >= 0 && t <= 1 && u >= 0 && u <= 1;
      };
      return (
        clipEdge(ax, ay, bx, by, minX, minY, maxX, minY) ||
        clipEdge(ax, ay, bx, by, maxX, minY, maxX, maxY) ||
        clipEdge(ax, ay, bx, by, maxX, maxY, minX, maxY) ||
        clipEdge(ax, ay, bx, by, minX, maxY, minX, minY)
      );
    };

    let added = 0;
    if (this.selectionMode === 'vertex') {
      for (let vi = 0; vi < pts.length; vi++) {
        if (inBox(pts[vi])) {
          if (!set.has(vi)) added++;
          set.add(vi);
        }
      }
    } else if (this.selectionMode === 'edge') {
      const edges = base.getEdges();
      for (let ei = 0; ei < edges.length; ei++) {
        const pa = pts[edges[ei].a];
        const pb = pts[edges[ei].b];
        if (!pa || !pb || pa.w <= 0.01 || pb.w <= 0.01) continue;
        if (segHitsBox(pa.x, pa.y, pb.x, pb.y)) {
          if (!set.has(ei)) added++;
          set.add(ei);
        }
      }
    } else {
      // mode === 'face'
      for (let fi = 0; fi < base.faces.length; fi++) {
        const f = base.faces[fi];
        let cx = 0, cy = 0, ok = true, anyVertIn = false;
        for (let i = 0; i < f.length; i++) {
          const p = pts[f[i]];
          if (!p || p.w <= 0.01) { ok = false; break; }
          cx += p.x; cy += p.y;
          if (p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY) anyVertIn = true;
        }
        if (!ok || !f.length) continue;
        cx /= f.length; cy /= f.length;
        const centerIn = cx >= minX && cx <= maxX && cy >= minY && cy <= maxY;
        let edgeCross = false;
        if (!centerIn && !anyVertIn) {
          for (let i = 0; i < f.length; i++) {
            const pa = pts[f[i]], pb = pts[f[(i + 1) % f.length]];
            if (segHitsBox(pa.x, pa.y, pb.x, pb.y)) { edgeCross = true; break; }
          }
        }
        if (centerIn || anyVertIn || edgeCross) {
          if (!set.has(fi)) added++;
          set.add(fi);
        }
      }
    }

    this._attached?.onSelectionChange?.(this.getStats());
    return added;
  }

  setEnabled(on) {
    const next = Boolean(on);
    if (!next && this.drag) this.cancelDrag();
    if (!next && this.cutDrag) this.cancelCutDrag();
    if (!next && this.boxDrag) this.cancelBoxDrag();
    this._clearLongPress();
    this.enabled = next;
    if (!next) {
      this.cutTool = null;
      this.boxSelectMode = false;
      this.multiSelectMode = false;
      this._releasePointerCapture();
      this._pointers.clear();
      this._tap = null;
      this.hoverElement = null;
      this.hoverGizmo = null;
    }
    return this;
  }

  _syncOverlaySize(canvas, opts = {}) {
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
    this._W = cssW;
    this._H = cssH;
    this._dpr = dpr;
    return { cssW, cssH, dpr };
  }

  _buildCutContext(camera, x0, y0, x1, y1) {
    const mesh = this.mesh;
    const base = this.baseMesh;
    if (!mesh || !base || !camera) return null;

    mesh.updateWorldMatrix(true, false);
    camera.updateWorldMatrix(true, false);
    if (camera.updateViewMatrix) camera.updateViewMatrix();
    _invMat.copyInverse(mesh.matrixWorld);

    const projVerts = this._projectBaseVerts(camera, mesh, base, this._W, this._H);

    // Máscara de caras frontales en espacio mundo (o todas si material es double-sided)
    const allowBackfaces = mesh.material?.side === 'double';
    const ce = camera.matrixWorld.elements;
    const camPosW = new Vec3(ce[12], ce[13], ce[14]);
    const camBackW = new Vec3(ce[8], ce[9], ce[10]).normalize();
    const camRightW = new Vec3(ce[0], ce[1], ce[2]).normalize();
    const camUpW = new Vec3(ce[4], ce[5], ce[6]).normalize();

    const worldVerts = new Array(base.verts.length);
    for (let i = 0; i < base.verts.length; i++) {
      const v = base.verts[i];
      worldVerts[i] = new Vec3(v.x, v.y, v.z).applyMatrix4(mesh.matrixWorld);
    }

    const faceFrontMask = new Uint8Array(base.faces.length);
    for (let fi = 0; fi < base.faces.length; fi++) {
      if (allowBackfaces) {
        faceFrontMask[fi] = 1;
        continue;
      }
      const f = base.faces[fi];
      if (!f || f.length < 3) continue;
      let nx = 0, ny = 0, nz = 0;
      let cx = 0, cy = 0, cz = 0;
      for (let i = 0; i < f.length; i++) {
        const a = worldVerts[f[i]];
        const b = worldVerts[f[(i + 1) % f.length]];
        cx += a.x; cy += a.y; cz += a.z;
        nx += (a.y - b.y) * (a.z + b.z);
        ny += (a.z - b.z) * (a.x + b.x);
        nz += (a.x - b.x) * (a.y + b.y);
      }
      cx /= f.length; cy /= f.length; cz /= f.length;
      if (camera.fov) {
        const tx = camPosW.x - cx, ty = camPosW.y - cy, tz = camPosW.z - cz;
        faceFrontMask[fi] = nx * tx + ny * ty + nz * tz > 1e-6 ? 1 : 0;
      } else {
        faceFrontMask[fi] = nx * camBackW.x + ny * camBackW.y + nz * camBackW.z > 1e-6 ? 1 : 0;
      }
    }

    const r0 = screenRay(camera, _rayTmp0, x0, y0, this._W, this._H);
    const r1 = screenRay(camera, _rayTmp1, x1, y1, this._W, this._H);

    // Rayos en espacio local
    const toLocalRay = (wRay, outRay) => {
      outRay.origin.copy(wRay.origin).applyMatrix4(_invMat);
      _tmpVec.copy(wRay.origin).add(wRay.direction).applyMatrix4(_invMat);
      outRay.direction.copy(_tmpVec).sub(outRay.origin).normalize();
    };
    toLocalRay(r0, _rayLocal0);
    toLocalRay(r1, _rayLocal1);

    // Plano local de corte por línea (para Cuchillo)
    let planeNormalLocal = null;
    let planePointLocal = null;
    if (Math.hypot(x1 - x0, y1 - y0) >= 2) {
      const p0W = r0.origin;
      const p1W = _tmpVec2.copy(r0.origin).add(r0.direction);
      const p2W = camera.fov
        ? _tmpVec3.copy(r1.origin).add(r1.direction)
        : _tmpVec3.copy(r1.origin);
      const p0L = p0W.clone().applyMatrix4(_invMat);
      const p1L = p1W.clone().applyMatrix4(_invMat);
      const p2L = p2W.clone().applyMatrix4(_invMat);
      const e1 = p1L.clone().sub(p0L);
      const e2 = p2L.clone().sub(p0L);
      const nL = e1.cross(e2);
      if (nL.lengthSq() > 1e-12) {
        planePointLocal = p0L;
        planeNormalLocal = nL.normalize();
      }
    }

    return {
      projVerts,
      worldVerts,
      faceFrontMask,
      camRightW,
      camUpW,
      planePointLocal,
      planeNormalLocal,
      ray0Local: _rayLocal0,
      ray1Local: _rayLocal1,
    };
  }

  _buildLoopPlanFromDrag(camera, x0, y0, x1, y1, lockedVertical = null) {
    const base = this.baseMesh;
    const mesh = this.mesh;
    if (!base || !mesh || !camera) return null;
    const ctx = this._buildCutContext(camera, x0, y0, x1, y1);
    if (!ctx) return null;

    const dx = x1 - x0;
    const dy = y1 - y0;
    const isVerticalCut = typeof lockedVertical === 'boolean' ? lockedVertical : Math.abs(dx) >= Math.abs(dy);

    const tryPickFaceAt = (px, py) => {
      const r = screenRay(camera, this._ray, px, py, this._W, this._H);
      return base.raycastFace(r, _invMat);
    };

    let hit = tryPickFaceAt(x1, y1) || tryPickFaceAt((x0 + x1) * 0.5, (y0 + y1) * 0.5) || tryPickFaceAt(x0, y0);
    let anchorFace = hit ? hit.faceIndex : -1;
    let anchorLocal = hit ? hit.localPoint : null;

    if (anchorFace < 0) {
      // Buscar la cara frontal más cercana al punto actual del cursor/dedo
      let bestDist = Infinity;
      const mx = x1, my = y1;
      for (let fi = 0; fi < base.faces.length; fi++) {
        if (!ctx.faceFrontMask[fi]) continue;
        const f = base.faces[fi];
        let sx = 0, sy = 0, ok = true;
        for (let i = 0; i < f.length; i++) {
          const p = ctx.projVerts[f[i]];
          if (!p || p.w <= 0.01) { ok = false; break; }
          sx += p.x; sy += p.y;
        }
        if (!ok || !f.length) continue;
        const d = Math.hypot(sx / f.length - mx, sy / f.length - my);
        if (d < bestDist) {
          bestDist = d;
          anchorFace = fi;
        }
      }
      if (anchorFace >= 0) {
        anchorLocal = base.computeFaceCenter(anchorFace, new Vec3());
      }
    }

    // Plano local 360° de respaldo (perpendicular a derecha para corte vertical, arriba para corte horizontal)
    let fallbackPointL = anchorLocal ? anchorLocal.clone() : new Vec3(0, 0, 0);
    if (!anchorLocal && base.verts.length) {
      fallbackPointL.set(0, 0, 0);
      for (let i = 0; i < base.verts.length; i++) {
        fallbackPointL.x += base.verts[i].x;
        fallbackPointL.y += base.verts[i].y;
        fallbackPointL.z += base.verts[i].z;
      }
      fallbackPointL.multiplyScalar(1 / base.verts.length);
    }

    const fallbackPointW = fallbackPointL.clone().applyMatrix4(mesh.matrixWorld);
    const wAxis = isVerticalCut ? ctx.camRightW : ctx.camUpW;
    // Construir normal local robusta bajo escalado usando 2 tangentes ortogonales en el plano
    const tA = isVerticalCut ? ctx.camUpW : ctx.camRightW;
    const tB = new Vec3().crossVectors(wAxis, tA).normalize();
    const p0L = fallbackPointW.clone().applyMatrix4(_invMat);
    const p1L = fallbackPointW.clone().add(tA).applyMatrix4(_invMat).sub(p0L);
    const p2L = fallbackPointW.clone().add(tB).applyMatrix4(_invMat).sub(p0L);
    const planeNormalLocal = new Vec3().crossVectors(p1L, p2L).normalize();

    const plan = base.computeLoopCutPlan({
      projVerts: ctx.projVerts,
      faceFrontMask: ctx.faceFrontMask,
      anchorFace,
      anchorLocal,
      isVerticalCut,
      planePointLocal: p0L,
      planeNormalLocal,
    });
    if (plan) plan.isVerticalCut = isVerticalCut;
    return plan;
  }

  /**
   * Dibuja en el canvas 2D:
   * - Las jaulas originales de cualquier objeto con Subdivisión Suave únicamente cuando Modo Edición está activo (o `showPassiveCages: true`).
   * - En Modo Edición 3D: las caras, aristas, vértices, previsualización de corte y el gizmo de sub-selección.
   */
  drawOverlay(canvas, camera, cageMeshes = [], opts = {}) {
    if (!canvas || !camera) return false;
    const { cssW, cssH, dpr } = this._syncOverlaySize(canvas, opts);
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    // 1. Dibujar jaulas de control ("líneas de suavizado") únicamente en Modo Edición
    const showPassiveCages = opts.showPassiveCages !== undefined ? Boolean(opts.showPassiveCages) : this.enabled;
    if (showPassiveCages && Array.isArray(cageMeshes) && cageMeshes.length) {
      for (let m = 0; m < cageMeshes.length; m++) {
        const mesh = cageMeshes[m];
        if (!mesh || !mesh.visible || (this.enabled && mesh === this.mesh)) continue;
        const mod = mesh._subsurf;
        if (!mod || !mod.baseMesh) continue;
        const isSelected = Boolean(opts.selectedSet?.has(mesh));
        if (!mod.alwaysShowCage && !(isSelected && mod.showCage !== false)) continue;
        const isMulti = Boolean(opts.multiSelectSet?.has(mesh) || (isSelected && opts.isMultiSelect));
        this._drawPassiveCage(ctx, camera, mesh, mod.baseMesh, cssW, cssH, isSelected, isMulti);
      }
    }

    // 2. Si Modo Edición 3D está activo, dibujar elementos editables, recuadro/corte activo o gizmo
    if (this.enabled && this.mesh && this.baseMesh) {
      this._drawActiveEditMesh(ctx, camera, this.mesh, this.baseMesh, cssW, cssH);
      if (this.boxDrag && this.boxDrag.started) {
        this._drawBoxSelectRect(ctx, this.boxDrag);
      }
      if (this.cutDrag) {
        this._drawCutPreview(ctx, camera, this.mesh, this.cutDrag, cssW, cssH);
      } else if (!this.cutTool && !this.boxDrag?.started && this.transformMode !== 'select' && this.getSelectionCount() > 0) {
        const gState = this._buildProxyGizmoState(camera, cssW, cssH);
        if (gState && gState.frame.vis) {
          const { proxy, frame } = gState;
          const p0 = this._renderer2d.project(camera, frame.P, cssW, cssH);
          const act = this.drag ? this.drag.key : this.hoverGizmo;
          ctx.save();
          ctx.lineCap = ctx.lineJoin = 'round';
          const shapes = this._renderer2d.buildShapes(proxy, frame).sort((a, b) => b.z - a.z);
          for (let i = 0; i < shapes.length; i++) {
            const s = shapes[i];
            if (s.f >= 0.02) this._renderer2d.drawShape(ctx, proxy, s, s.key === act, this.drag);
          }
          ctx.shadowBlur = 0;
          ctx.globalAlpha = 1;
          if (this.drag && this.drag.moved) this._renderer2d.drawDrag(ctx, proxy, this.drag, p0);
          ctx.restore();
        }
      }
    }

    return true;
  }

  _drawBoxSelectRect(ctx, bd) {
    const x = Math.min(bd.x0, bd.x1);
    const y = Math.min(bd.y0, bd.y1);
    const w = Math.abs(bd.x1 - bd.x0);
    const h = Math.abs(bd.y1 - bd.y0);
    if (w < 2 && h < 2) return;
    const isYellow = this.multiSelectMode || bd.shift;
    ctx.save();
    ctx.fillStyle = isYellow ? 'rgba(250, 204, 21, 0.18)' : 'rgba(56, 189, 248, 0.16)';
    ctx.strokeStyle = isYellow ? '#facc15' : '#38bdf8';
    ctx.lineWidth = 1.6;
    ctx.setLineDash([5, 4]);
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }

  _drawCutPreview(ctx, camera, mesh, cd, W, H) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (cd.mode === 'loop' && cd.preview?.previewSegments?.length) {
      mesh.updateWorldMatrix(true, false);
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 2.6;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      for (const [a, b] of cd.preview.previewSegments) {
        _tmpPos.set(a.x, a.y, a.z).applyMatrix4(mesh.matrixWorld);
        _tmpVec.set(b.x, b.y, b.z).applyMatrix4(mesh.matrixWorld);
        const pa = this._renderer2d.project(camera, _tmpPos, W, H);
        const pb = this._renderer2d.project(camera, _tmpVec, W, H);
        if (!pa || !pb || pa.w <= 0.01 || pb.w <= 0.01) continue;
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
      }
      ctx.stroke();

      // Trazo guía sutil del gesto del usuario
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = 'rgba(251, 191, 36, 0.65)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cd.x0, cd.y0);
      ctx.lineTo(cd.x1, cd.y1);
      ctx.stroke();
    } else {
      // Línea de corte libre (Cuchillo)
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 2.4;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(cd.x0, cd.y0);
      ctx.lineTo(cd.x1, cd.y1);
      ctx.stroke();

      ctx.setLineDash([]);
      ctx.fillStyle = '#fbbf24';
      ctx.beginPath();
      ctx.arc(cd.x0, cd.y0, 4, 0, Math.PI * 2);
      ctx.arc(cd.x1, cd.y1, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  _projectBaseVerts(camera, mesh, base, W, H) {
    mesh.updateWorldMatrix(true, false);
    const pts = new Array(base.verts.length);
    for (let i = 0; i < base.verts.length; i++) {
      const v = base.verts[i];
      _tmpVec.set(v.x, v.y, v.z).applyMatrix4(mesh.matrixWorld);
      pts[i] = this._renderer2d.project(camera, _tmpVec, W, H);
    }
    return pts;
  }

  _drawPassiveCage(ctx, camera, mesh, base, W, H, isSelected, isMulti = false) {
    const pts = this._projectBaseVerts(camera, mesh, base, W, H);
    const edges = base.getEdges();

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = isMulti
      ? 'rgba(250, 204, 21, 0.96)'
      : isSelected
      ? 'rgba(251, 191, 36, 0.9)'
      : 'rgba(245, 158, 11, 0.45)';
    ctx.lineWidth = isMulti ? 1.85 : isSelected ? 1.55 : 1.1;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    for (let i = 0; i < edges.length; i++) {
      const pa = pts[edges[i].a];
      const pb = pts[edges[i].b];
      if (!pa || !pb || pa.w <= 0.01 || pb.w <= 0.01) continue;
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
    }
    ctx.stroke();

    if (isSelected) {
      ctx.setLineDash([]);
      ctx.fillStyle = isMulti ? 'rgba(253, 224, 71, 0.98)' : 'rgba(251, 191, 36, 0.92)';
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        if (!p || p.w <= 0.01) continue;
        ctx.beginPath();
        ctx.arc(p.x, p.y, isMulti ? 2.9 : 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  _drawActiveEditMesh(ctx, camera, mesh, base, W, H) {
    const pts = this._projectBaseVerts(camera, mesh, base, W, H);
    const edges = base.getEdges();
    const hov = this.hoverElement;
    const multi = this.multiSelectMode;

    // Paleta AMARILLA cuando selección múltiple por pulsación prolongada / modo multi-sel está activa
    const faceFillSel = multi ? 'rgba(250, 204, 21, 0.38)' : 'rgba(249, 115, 22, 0.28)';
    const faceStrokeSel = multi ? '#facc15' : 'rgba(251, 146, 60, 0.92)';
    const dotSel = multi ? '#fde047' : '#fb923c';
    const edgeSel = multi ? '#fde047' : '#fb923c';

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // 1. Caras seleccionadas / hover
    for (let fi = 0; fi < base.faces.length; fi++) {
      const isSel = this.selectionMode === 'face' && this.selectedFaces.has(fi);
      const isHov = this.selectionMode === 'face' && hov && hov.type === 'face' && hov.index === fi;
      if (!isSel && !isHov) continue;

      const f = base.faces[fi];
      let valid = true;
      for (let i = 0; i < f.length; i++) {
        if (!pts[f[i]] || pts[f[i]].w <= 0.01) { valid = false; break; }
      }
      if (!valid) continue;

      ctx.beginPath();
      for (let i = 0; i < f.length; i++) {
        const p = pts[f[i]];
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
      ctx.fillStyle = isSel ? faceFillSel : 'rgba(56, 189, 248, 0.16)';
      ctx.fill();
      if (isSel || isHov) {
        ctx.strokeStyle = isSel ? faceStrokeSel : 'rgba(125, 211, 252, 0.8)';
        ctx.lineWidth = isSel ? 2.0 : 1.3;
        ctx.stroke();
      }

      if (this.selectionMode === 'face') {
        let cx = 0, cy = 0;
        for (let i = 0; i < f.length; i++) { cx += pts[f[i]].x; cy += pts[f[i]].y; }
        cx /= f.length; cy /= f.length;
        ctx.fillStyle = isSel ? dotSel : '#7dd3fc';
        ctx.beginPath();
        ctx.arc(cx, cy, isSel ? 3.8 : 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 2. Aristas de la jaula base
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(245, 242, 237, 0.42)';
    ctx.lineWidth = 1.2;
    for (let ei = 0; ei < edges.length; ei++) {
      const e = edges[ei];
      if (this.selectionMode === 'edge' && (this.selectedEdges.has(ei) || (hov?.type === 'edge' && hov.index === ei))) {
        continue;
      }
      if (base.getEdgeCrease && base.getEdgeCrease(e.a, e.b) > 0.01) continue;
      const pa = pts[e.a], pb = pts[e.b];
      if (!pa || !pb || pa.w <= 0.01 || pb.w <= 0.01) continue;
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
    }
    ctx.stroke();

    // 2b. Aristas con dureza individual (Creases) en tono rosado/violeta
    if (base.creases && base.creases.size > 0) {
      for (let ei = 0; ei < edges.length; ei++) {
        const e = edges[ei];
        const cr = base.getEdgeCrease(e.a, e.b);
        if (cr <= 0.01) continue;
        if (this.selectionMode === 'edge' && this.selectedEdges.has(ei)) continue;
        const pa = pts[e.a], pb = pts[e.b];
        if (!pa || !pb || pa.w <= 0.01 || pb.w <= 0.01) continue;
        ctx.beginPath();
        ctx.strokeStyle = `rgba(244, 63, 94, ${0.45 + cr * 0.5})`;
        ctx.lineWidth = 1.5 + cr * 1.4;
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
        ctx.stroke();
      }
    }

    // Resaltar aristas seleccionadas / hover
    if (this.selectionMode === 'edge') {
      for (let ei = 0; ei < edges.length; ei++) {
        const isSel = this.selectedEdges.has(ei);
        const isHov = hov && hov.type === 'edge' && hov.index === ei;
        if (!isSel && !isHov) continue;
        const pa = pts[edges[ei].a], pb = pts[edges[ei].b];
        if (!pa || !pb || pa.w <= 0.01 || pb.w <= 0.01) continue;
        ctx.beginPath();
        ctx.strokeStyle = isSel ? edgeSel : '#38bdf8';
        ctx.lineWidth = isSel ? 3.2 : 2.2;
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
        ctx.stroke();
      }
    }

    // 3. Vértices (puntos siempre visibles suavemente; destacados en modo vértice)
    const isVertMode = this.selectionMode === 'vertex';
    for (let vi = 0; vi < pts.length; vi++) {
      const p = pts[vi];
      if (!p || p.w <= 0.01) continue;
      const isSel = isVertMode && this.selectedVertices.has(vi);
      const isHov = isVertMode && hov && hov.type === 'vertex' && hov.index === vi;
      if (!isVertMode && !isSel && !isHov) {
        ctx.fillStyle = 'rgba(245, 242, 237, 0.45)';
        ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
        continue;
      }

      const r = isSel ? 5.0 : isHov ? 4.4 : 3.2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = isSel ? dotSel : isHov ? '#38bdf8' : '#1c1917';
      ctx.fill();
      ctx.lineWidth = isSel || isHov ? 1.6 : 1.2;
      ctx.strokeStyle = isSel ? '#0f172a' : isHov ? '#e0f2fe' : '#e7e5e4';
      ctx.stroke();
    }

    // Puntos medios sutiles en modo cara para orientarse rápido
    if (this.selectionMode === 'face') {
      ctx.fillStyle = 'rgba(245, 242, 237, 0.35)';
      for (let fi = 0; fi < base.faces.length; fi++) {
        if (this.selectedFaces.has(fi)) continue;
        const f = base.faces[fi];
        let cx = 0, cy = 0, ok = true;
        for (let i = 0; i < f.length; i++) {
          const p = pts[f[i]];
          if (!p || p.w <= 0.01) { ok = false; break; }
          cx += p.x; cy += p.y;
        }
        if (!ok || !f.length) continue;
        ctx.fillRect(cx / f.length - 1.5, cy / f.length - 1.5, 3, 3);
      }
    }

    ctx.restore();
  }

  _releasePointerCapture(pointerId = null) {
    if (!this._captureEl) return;
    try {
      if (pointerId !== null && this._captureEl.hasPointerCapture?.(pointerId)) {
        this._captureEl.releasePointerCapture(pointerId);
      }
    } catch (_) {}
    this._captureEl = null;
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

    const toXY = (e) => {
      const rectEl = resolveTarget() || domElement;
      const rect = rectEl.getBoundingClientRect();
      return [
        ((e.clientX - rect.left) / Math.max(1, rect.width)) * this._W,
        ((e.clientY - rect.top) / Math.max(1, rect.height)) * this._H,
      ];
    };

    const onPointerDown = (e) => {
      const targetEl = resolveTarget();
      if (targetEl && e.target !== targetEl) return;
      this._pointers.add(e.pointerId);
      if (!this.enabled) return;

      if (this._pointers.size > 1) {
        this._clearLongPress();
        this._tap = null;
        if (this.drag) this.cancelDrag();
        if (this.cutDrag) this.cancelCutDrag();
        if (this.boxDrag) this.cancelBoxDrag();
        const ctrl = resolveControls();
        if (ctrl) ctrl.enabled = resolveControlsEnabled();
        return;
      }

      if (e.pointerType === 'mouse' && e.button !== 0) return;

      const cam = resolveCamera();
      if (!cam || !this.mesh) return;
      const [x, y] = toXY(e);
      const touch = e.pointerType !== 'mouse';

      // 0. Modo Corte interactivo (Línea libre o Bucle 360°)
      if (this.cutTool) {
        e.stopImmediatePropagation();
        e.preventDefault();
        const ctrl = resolveControls();
        this.cutDrag = {
          mode: this.cutTool,
          x0: x,
          y0: y,
          x1: x,
          y1: y,
          id: e.pointerId,
          ctrl: ctrl?.enabled ?? true,
          lockedVertical: null,
          preview: null,
        };
        if (ctrl) ctrl.enabled = false;
        this._captureEl = targetEl || domElement;
        try { this._captureEl.setPointerCapture(e.pointerId); } catch (_) {}
        this._attached?.onReadoutChange?.(
          this.cutTool === 'loop'
            ? 'Arrastra → corte vertical · Arrastra ↑↓ corte horizontal'
            : 'Traza una línea sobre las caras para cortar'
        );
        return;
      }

      // 1. Verificar primero si tocó un asa del gizmo de sub-selección
      const gPick = this._pickGizmo(cam, x, y, touch);
      if (gPick) {
        const d = this._beginDrag(gPick, x, y, e);
        if (d) {
          e.stopImmediatePropagation();
          e.preventDefault();
          this.drag = d;
          this._tap = null;
          this._clearLongPress();
          const ctrl = resolveControls();
          if (ctrl) ctrl.enabled = false;
          this._captureEl = targetEl || domElement;
          try { this._captureEl.setPointerCapture(e.pointerId); } catch (_) {}
          this.info = { mode: d.type, key: d.key, text: (LABEL[d.type] || d.type) + ' ' + d.key.toUpperCase() };
          this._attached?.onReadoutChange?.(this.info.text);
          return;
        }
      }

      // 2. Selección por recuadro (cuando Modo Recuadro o Cursor están activos)
      const useBoxDrag = this.boxSelectMode || this.transformMode === 'select';
      if (useBoxDrag) {
        e.stopImmediatePropagation();
        e.preventDefault();
        const ctrl = resolveControls();
        this.boxDrag = {
          x0: x,
          y0: y,
          x1: x,
          y1: y,
          clientX0: e.clientX,
          clientY0: e.clientY,
          id: e.pointerId,
          shift: !!e.shiftKey,
          touch,
          started: false,
          ctrl: ctrl?.enabled ?? true,
        };
        if (ctrl) ctrl.enabled = false;
        this._captureEl = targetEl || domElement;
        try { this._captureEl.setPointerCapture(e.pointerId); } catch (_) {}
      }

      // 3. Registrar posible tap y temporizador de pulsación prolongada (selección múltiple AMARILLA)
      this._tap = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId, shift: !!e.shiftKey };
      this._clearLongPress();
      const pointerId = e.pointerId;
      const startClientX = e.clientX;
      const startClientY = e.clientY;
      this._longPressTimer = setTimeout(() => {
        this._longPressTimer = null;
        if (!this.enabled || this.drag || this.cutDrag || this.boxDrag?.started) return;
        const activeTap = this._tap;
        if (!activeTap || activeTap.id !== pointerId) return;
        const activeCam = resolveCamera();
        if (!activeCam || !this.mesh) return;
        const rectEl = resolveTarget() || domElement;
        const rect = rectEl.getBoundingClientRect();
        const px = ((startClientX - rect.left) / Math.max(1, rect.width)) * this._W;
        const py = ((startClientY - rect.top) / Math.max(1, rect.height)) * this._H;
        const hit = this._pickElement(activeCam, px, py, touch);
        if (!hit) return;

        // Activar selección múltiple en AMARILLO y cancelar arrastre pendiente de OrbitControls
        this.multiSelectMode = true;
        this._tap = null;
        if (this.boxDrag && this.boxDrag.id === pointerId && !this.boxDrag.started) {
          this.cancelBoxDrag();
        }
        const ctrl = resolveControls();
        if (ctrl && typeof ctrl.cancelPointer === 'function') {
          ctrl.cancelPointer(pointerId);
        }
        const set = this.getActiveSelectionSet();
        set.add(hit.index);
        this._attached?.onSelectionChange?.(this.getStats());
        this._attached?.onModeChange?.(this.cutTool || this.transformMode);
        this._attached?.onReadoutChange?.('Selección múltiple activa (amarillo) · Toca más elementos');
      }, this.longPressMs);
    };

    const onPointerMove = (e) => {
      if (!this.enabled) return;
      this.shift = e.shiftKey;
      const cam = resolveCamera();
      if (!cam || !this.mesh) return;
      const [x, y] = toXY(e);

      if (this._tap && e.pointerId === this._tap.id) {
        const moveTol = e.pointerType !== 'mouse' ? 10 : 5;
        if (Math.hypot(e.clientX - this._tap.x, e.clientY - this._tap.y) > moveTol) {
          this._clearLongPress();
        }
      }

      if (this.cutDrag && e.pointerId === this.cutDrag.id) {
        this.cutDrag.x1 = x;
        this.cutDrag.y1 = y;
        const dist = Math.hypot(x - this.cutDrag.x0, y - this.cutDrag.y0);
        if (this.cutDrag.mode === 'loop' && dist >= 6) {
          if (this.cutDrag.lockedVertical === null && dist >= 8) {
            this.cutDrag.lockedVertical = Math.abs(x - this.cutDrag.x0) >= Math.abs(y - this.cutDrag.y0);
          }
          const plan = this._buildLoopPlanFromDrag(
            cam,
            this.cutDrag.x0,
            this.cutDrag.y0,
            x,
            y,
            this.cutDrag.lockedVertical
          );
          this.cutDrag.preview = plan;
          if (plan) {
            this._attached?.onReadoutChange?.(
              plan.isVerticalCut ? 'Bucle 360° · Corte VERTICAL (fijado)' : 'Bucle 360° · Corte HORIZONTAL (fijado)'
            );
          }
        } else if (this.cutDrag.mode === 'knife' && dist >= 6) {
          this._attached?.onReadoutChange?.(`Corte libre · ${Math.round(dist)} px`);
        }
        return;
      }

      if (this.boxDrag && e.pointerId === this.boxDrag.id) {
        this.boxDrag.x1 = x;
        this.boxDrag.y1 = y;
        const dist = Math.hypot(x - this.boxDrag.x0, y - this.boxDrag.y0);
        if (!this.boxDrag.started && dist >= 6) {
          this.boxDrag.started = true;
          this._clearLongPress();
          this._tap = null;
        }
        if (this.boxDrag.started) {
          const w = Math.abs(this.boxDrag.x1 - this.boxDrag.x0);
          const h = Math.abs(this.boxDrag.y1 - this.boxDrag.y0);
          this._attached?.onReadoutChange?.(`Recuadro · ${Math.round(w)}×${Math.round(h)} px`);
        }
        return;
      }

      if (this.drag && e.pointerId === this.drag.id) {
        if (!this.drag.moved && Math.hypot(x - this.drag.x0, y - this.drag.y0) < 3) return;
        this.drag.moved = true;
        const ray = screenRay(cam, this._ray, x, y, this._W, this._H);
        this._updateDrag(this.drag, ray, x, y);
        return;
      }

      if (e.pointerType === 'mouse') {
        if (this.cutTool || this.boxSelectMode) {
          const tEl = resolveTarget();
          if (tEl) tEl.style.cursor = 'crosshair';
          this.hoverElement = null;
          this.hoverGizmo = null;
          return;
        }
        const gPick = this._pickGizmo(cam, x, y, false);
        if (gPick) {
          this.hoverGizmo = gPick.shape.key;
          this.hoverElement = null;
          const tEl = resolveTarget();
          if (tEl) tEl.style.cursor = 'pointer';
          return;
        }
        this.hoverGizmo = null;
        const elPick = this._pickElement(cam, x, y, false);
        this.hoverElement = elPick;
        const tEl = resolveTarget();
        if (tEl) tEl.style.cursor = elPick ? 'pointer' : '';
      }
    };

    const onPointerUp = (e) => {
      this._pointers.delete(e.pointerId);
      this._clearLongPress();
      if (!this.enabled) return;

      const bd = this.boxDrag;
      if (bd && e.pointerId === bd.id) {
        this.boxDrag = null;
        this._releasePointerCapture(e.pointerId);
        const ctrl = resolveControls();
        if (ctrl) ctrl.enabled = resolveControlsEnabled();
        this._attached?.onReadoutChange?.('');

        if (bd.started) {
          this._tap = null;
          const cam = resolveCamera();
          if (cam && this.mesh && this.baseMesh) {
            this._selectElementsInBox(cam, bd.x0, bd.y0, bd.x1, bd.y1, this.multiSelectMode || bd.shift);
          }
          return;
        }
      }

      const cd = this.cutDrag;
      if (cd && e.pointerId === cd.id) {
        this.cutDrag = null;
        this._releasePointerCapture(e.pointerId);
        const ctrl = resolveControls();
        if (ctrl) ctrl.enabled = resolveControlsEnabled();
        this._attached?.onReadoutChange?.('');

        const cam = resolveCamera();
        const dist = Math.hypot(cd.x1 - cd.x0, cd.y1 - cd.y0);
        if (cam && this.mesh && this.baseMesh && dist >= 6) {
          const beforeState = snapshotMeshModelingState(this.mesh);
          let res = { changed: false };
          let label = 'Dividir caras';

          if (cd.mode === 'loop') {
            const plan = cd.preview || this._buildLoopPlanFromDrag(cam, cd.x0, cd.y0, cd.x1, cd.y1, cd.lockedVertical);
            res = this.baseMesh.loopCut(plan);
            label = plan?.isVerticalCut ? 'Corte en bucle vertical' : 'Corte en bucle horizontal';
          } else {
            const ctx = this._buildCutContext(cam, cd.x0, cd.y0, cd.x1, cd.y1);
            if (ctx && ctx.planePointLocal && ctx.planeNormalLocal) {
              res = this.baseMesh.knifeCut({
                projVerts: ctx.projVerts,
                faceFrontMask: ctx.faceFrontMask,
                planePointLocal: ctx.planePointLocal,
                planeNormalLocal: ctx.planeNormalLocal,
                ray0Local: ctx.ray0Local,
                ray1Local: ctx.ray1Local,
                x0: cd.x0,
                y0: cd.y0,
                x1: cd.x1,
                y1: cd.y1,
              });
              label = 'Corte libre de caras';
            }
          }

          if (res.changed) {
            if (this.selectionMode === 'edge' && res.selectedEdges?.size) {
              this.selectedEdges = res.selectedEdges;
            } else if (this.selectionMode === 'face' && res.selectedFaces?.size) {
              this.selectedFaces = res.selectedFaces;
            } else if (res.selectedEdges?.size) {
              this.selectedEdges = res.selectedEdges;
              if (this.selectionMode === 'vertex') {
                const edges = this.baseMesh.getEdges();
                const vs = new Set();
                for (const ei of res.selectedEdges) {
                  if (edges[ei]) { vs.add(edges[ei].a); vs.add(edges[ei].b); }
                }
                this.selectedVertices = vs;
              }
            }
            syncMeshSubsurf(this.mesh);
            const afterState = snapshotMeshModelingState(this.mesh);
            this._attached?.onEditCommit?.({
              mesh: this.mesh,
              beforeState,
              afterState,
              label,
            });
            this._attached?.onSelectionChange?.(this.getStats());
          }
        }
        return;
      }

      const d = this.drag;
      if (d && e.pointerId === d.id) {
        this.drag = null;
        this._releasePointerCapture(e.pointerId);
        const ctrl = resolveControls();
        if (ctrl) ctrl.enabled = resolveControlsEnabled();
        this._attached?.onReadoutChange?.('');

        if (d.moved) {
          const afterState = snapshotMeshModelingState(this.mesh);
          this._attached?.onEditCommit?.({
            mesh: this.mesh,
            beforeState: d.beforeState,
            afterState,
            label: `${LABEL[d.type] || d.type} ${this.selectionMode === 'vertex' ? 'vértices' : this.selectionMode === 'edge' ? 'aristas' : 'caras'}`,
          });
        } else if (d.key === 'free' || d.key === 'uni') {
          const now = performance.now();
          if (now - this._lastSpaceTap < 350) {
            const nextSpace = this.space === 'world' ? 'local' : 'world';
            this.setSpace(nextSpace);
            this._attached?.onSpaceChange?.(nextSpace);
            this._lastSpaceTap = 0;
          } else {
            this._lastSpaceTap = now;
          }
        }
        return;
      }

      const tp = this._tap;
      if (tp && e.pointerId === tp.id) {
        this._tap = null;
        const touch = e.pointerType !== 'mouse';
        const tol = touch ? 14 : 6;
        const dt = performance.now() - tp.t;
        if (Math.hypot(e.clientX - tp.x, e.clientY - tp.y) <= tol && dt < 1500) {
          const cam = resolveCamera();
          if (!cam) return;
          const [x, y] = toXY(e);
          const hit = this._pickElement(cam, x, y, touch);
          const set = this.getActiveSelectionSet();
          const additive = this.multiSelectMode || tp.shift;
          if (!hit) {
            if (!tp.shift && (set.size > 0 || this.multiSelectMode)) {
              const hadMulti = this.multiSelectMode;
              set.clear();
              this.multiSelectMode = false;
              this._attached?.onSelectionChange?.(this.getStats());
              if (hadMulti) this._attached?.onModeChange?.(this.cutTool || this.transformMode);
              this._attached?.onReadoutChange?.('');
            }
          } else if (dt < 650) {
            if (additive) {
              if (set.has(hit.index)) set.delete(hit.index);
              else set.add(hit.index);
              this._attached?.onSelectionChange?.(this.getStats());
            } else {
              set.clear();
              set.add(hit.index);
              this._attached?.onSelectionChange?.(this.getStats());
            }
          }
        }
      }
    };

    const onPointerLeave = () => {
      if (!this.drag && !this.cutDrag && !this.boxDrag) {
        this.hoverElement = null;
        this.hoverGizmo = null;
      }
    };

    const onKeyDown = (e) => {
      this.shift = e.shiftKey;
      if (!this.enabled) return;
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        this._clearLongPress();
        if (this.boxDrag) {
          this.cancelBoxDrag();
        } else if (this.cutDrag) {
          this.cancelCutDrag();
        } else if (this.cutTool) {
          this.setCutTool(null);
        } else if (this.drag) {
          this.cancelDrag();
        } else {
          opts.onExit?.();
        }
      }
    };

    const onKeyUp = (e) => {
      this.shift = e.shiftKey;
    };

    domElement.addEventListener('pointerdown', onPointerDown, { capture: true });
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    domElement.addEventListener('pointerleave', onPointerLeave);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    this._cleanup = () => {
      domElement.removeEventListener('pointerdown', onPointerDown, { capture: true });
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      domElement.removeEventListener('pointerleave', onPointerLeave);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };

    return this;
  }

  detach() {
    this._clearLongPress();
    if (this.drag) this.cancelDrag();
    if (this.cutDrag) this.cancelCutDrag();
    if (this.boxDrag) this.cancelBoxDrag();
    this._releasePointerCapture();
    this._pointers.clear();
    this._tap = null;
    if (this._cleanup) {
      this._cleanup();
      this._cleanup = null;
    }
    this._attached = null;
    return this;
  }
}
