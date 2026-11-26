import { EventEmitter } from './EventEmitter.js';
import { Vec3 } from '../math/Vec3.js';

export function estimateCommandBytes(cmd) {
  if (!cmd || typeof cmd !== 'object') return 256;
  let bytes = 512;

  if ((cmd.type === 'sculpt' || cmd.type === 'paint') && cmd.diff) {
    const { indices, before, after, beforePos, afterPos, beforeNor, afterNor } = cmd.diff;
    if (indices) bytes += indices.byteLength || indices.length * 4;
    if (before) bytes += before.byteLength || before.length * 4;
    if (after) bytes += after.byteLength || after.length * 4;
    if (beforePos) bytes += beforePos.byteLength || beforePos.length * 4;
    if (afterPos) bytes += afterPos.byteLength || afterPos.length * 4;
    if (beforeNor) bytes += beforeNor.byteLength || beforeNor.length * 4;
    if (afterNor) bytes += afterNor.byteLength || afterNor.length * 4;
  } else if (cmd.type === 'subdivide' || cmd.type === 'geometry') {
    const countGeo = (geo) => {
      if (!geo || !geo.attributes) return 0;
      let total = 0;
      for (const attr of Object.values(geo.attributes)) {
        if (attr?.array?.byteLength) total += attr.array.byteLength;
      }
      if (geo.index?.array?.byteLength) total += geo.index.array.byteLength;
      return total;
    };
    bytes += countGeo(cmd.beforeGeo) + countGeo(cmd.afterGeo);
  } else if (cmd.type === 'meshEdit' || cmd.type === 'mergeMeshes') {
    const bMesh = cmd.beforeState?.baseMesh;
    const aMesh = cmd.afterState?.baseMesh;
    const vLen =
      (bMesh?.verts?.length || 0) +
      (aMesh?.verts?.length || 0) +
      (bMesh?._densityOrigin?.verts?.length || 0) +
      (aMesh?._densityOrigin?.verts?.length || 0);
    const fLen =
      (bMesh?.faces?.length || 0) +
      (aMesh?.faces?.length || 0) +
      (bMesh?._densityOrigin?.faces?.length || 0) +
      (aMesh?._densityOrigin?.faces?.length || 0);
    bytes += vLen * 32 + fLen * 48 + (cmd.removals ? cmd.removals.length * 256 : 0);
  } else if (cmd.type === 'animClip') {
    const countTracks = (snap) => {
      if (!snap?.tracks) return 0;
      let total = 0;
      for (const tr of snap.tracks) {
        total += (tr.times?.byteLength || 0) + (tr.values?.byteLength || 0) + 64;
      }
      return total;
    };
    bytes += countTracks(cmd.before) + countTracks(cmd.after);
  } else if (cmd.type === 'animState') {
    bytes += ((cmd.before?.allClips?.length || 0) + (cmd.after?.allClips?.length || 0)) * 64 + 256;
  } else if (cmd.type === 'batch' && Array.isArray(cmd.commands)) {
    for (const sub of cmd.commands) bytes += estimateCommandBytes(sub);
  } else if (cmd.type === 'transform') {
    bytes += (cmd.os ? cmd.os.length : 1) * 192;
  } else if (cmd.type === 'delete') {
    bytes += (cmd.removals ? cmd.removals.length : 1) * 256;
    if (cmd.skeletonPatches) {
      for (const p of cmd.skeletonPatches) {
        bytes += (p.beforeBones ? p.beforeBones.length : 0) * 128;
        if (p.geoPatches) {
          for (const gp of p.geoPatches) {
            bytes += (gp.beforeIndex?.byteLength || 0) * 2;
            bytes += (gp.beforeWeight?.byteLength || 0) * 2;
          }
        }
      }
    }
  }
  return Math.max(256, bytes);
}

/**
 * Motor nativo de Deshacer/Rehacer de Made3D.
 * Sin dependencias del DOM: gestiona pilas de comandos, agrupación atómica (`runGrouped`),
 * presupuesto de memoria con liberación de geometrías huérfanas, transformaciones,
 * jerarquía de escena, animación, esqueletos, esculpido y modelado poligonal.
 */
export class HistoryManager extends EventEmitter {
  static _handlers = {
    Sculptor: null,
    Painter: null,
    Skeleton: null,
    restoreMeshModelingState: null,
    syncEditableBaseFromGeometry: null,
  };

  /**
   * Registra adaptadores opcionales (sculpt, modeling, rigging) sin acoplar
   * estáticamente módulos pesados al núcleo ligero `made3d.module.js`.
   */
  static registerHandlers(handlers = {}) {
    if (!handlers || typeof handlers !== 'object') return this._handlers;
    for (const [k, v] of Object.entries(handlers)) {
      if (v) this._handlers[k] = v;
    }
    return this._handlers;
  }

  static get registeredHandlers() {
    return { ...this._handlers };
  }

  static isInScene(obj, scene) {
    if (!obj || !scene) return false;
    let cur = obj;
    while (cur) {
      if (cur === scene) return true;
      cur = cur.parent;
    }
    return false;
  }

  static isDescendantOrSelf(node, ancestor) {
    let cur = node;
    while (cur) {
      if (cur === ancestor) return true;
      cur = cur.parent;
    }
    return false;
  }

  static snapshotTransform(o) {
    return {
      p: o.position.clone(),
      q: o.quaternion.clone(),
      s: o.scale.clone(),
      pv: o.pivot ? o.pivot.clone() : new Vec3(),
    };
  }

  static hasTransformChanged(before, after, { includePivot = true, eps = 1e-5 } = {}) {
    if (!before || !after) return false;
    const bp = before.p || before.position;
    const ap = after.p || after.position;
    if (bp && ap && bp.distanceTo(ap) > eps) return true;

    const bs = before.s || before.scale;
    const as = after.s || after.scale;
    if (bs && as && bs.distanceTo(as) > eps) return true;

    const bq = before.q || before.quaternion;
    const aq = after.q || after.quaternion;
    if (bq && aq && Math.abs(bq.dot(aq)) < 1 - eps * 0.1) return true;

    if (includePivot && before.pv && after.pv && before.pv.distanceTo(after.pv) > eps) {
      return true;
    }
    return false;
  }

  static cloneTransform(st) {
    return {
      p: st.p.clone(),
      q: st.q.clone(),
      s: st.s.clone(),
      pv: st.pv ? st.pv.clone() : new Vec3(),
    };
  }

  static restoreTransform(o, st) {
    if (!o || !st) return;
    o.position.copy(st.p);
    o.quaternion.copy(st.q);
    o.scale.copy(st.s);
    if (o.pivot && st.pv) o.pivot.copy(st.pv);
    if (typeof o.updateMatrixWorld === 'function') o.updateMatrixWorld();
  }

  static captureSubsurfSnapshot(mesh) {
    if (!mesh) return null;
    const geo = mesh.geometry || null;
    return {
      subsurf: mesh._subsurf
        ? {
            level: mesh._subsurf.level | 0,
            smoothness: mesh._subsurf.smoothness ?? 1,
            smoothShading: Boolean(mesh._subsurf.smoothShading),
            showCage: Boolean(mesh._subsurf.showCage),
            alwaysShowCage: Boolean(mesh._subsurf.alwaysShowCage),
            baseMesh: mesh._subsurf.baseMesh ? mesh._subsurf.baseMesh.clone() : null,
          }
        : null,
      dirty: Boolean(mesh._subsurfDirtyFromGeometry),
      modFlag: Boolean(geo?._modifiedBySculpt),
      genFlag: Boolean(geo?._isGeneratedSubsurf),
    };
  }

  static restoreSubsurfSnapshot(mesh, snap, fallbackGeo = null) {
    if (!mesh || !snap) return;
    const s = snap.subsurf;
    mesh._subsurf = s
      ? {
          level: s.level | 0,
          smoothness: s.smoothness ?? 1,
          smoothShading: Boolean(s.smoothShading),
          showCage: Boolean(s.showCage),
          alwaysShowCage: Boolean(s.alwaysShowCage),
          baseMesh: s.baseMesh ? s.baseMesh.clone() : null,
        }
      : null;
    mesh._subsurfDirtyFromGeometry = Boolean(snap.dirty);
    const geo = fallbackGeo || mesh.geometry;
    if (geo) {
      geo._modifiedBySculpt = Boolean(snap.modFlag);
      geo._isGeneratedSubsurf = Boolean(snap.genFlag);
    }
  }

  constructor(opts = {}) {
    super();
    this.undoStack = [];
    this.redoStack = [];
    this.maxBytes = opts.maxBytes ?? 64 * 1024 * 1024;
    this.minEntries = opts.minEntries ?? 8;
    this.totalBytes = 0;
    this.scene = opts.scene || null;
    this._getScene = typeof opts.getScene === 'function' ? opts.getScene : null;
    this._handlers = { ...(opts.handlers || {}) };
    this._hooks = { ...(opts.hooks || {}) };
    this._groupStack = [];
  }

  setScene(scene) {
    this.scene = scene || null;
    return this;
  }

  getScene() {
    return this._getScene ? this._getScene() : this.scene;
  }

  setHooks(hooks = {}) {
    this._hooks = { ...this._hooks, ...hooks };
    return this;
  }

  registerHandlers(handlers = {}) {
    if (!handlers || typeof handlers !== 'object') return this;
    for (const [k, v] of Object.entries(handlers)) {
      if (v) this._handlers[k] = v;
    }
    return this;
  }

  _getHandler(name) {
    return this._handlers[name] || HistoryManager._handlers[name] || null;
  }

  get undoLength() { return this.undoStack.length; }
  get redoLength() { return this.redoStack.length; }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  _emitChange(action, command = null) {
    this.emit('change', {
      action,
      command,
      canUndo: this.canUndo,
      canRedo: this.canRedo,
      undoLength: this.undoLength,
      redoLength: this.redoLength,
    });
  }

  _emitStatus(message, command = null, action = '') {
    if (!message) return;
    this.emit('status', { message, command, action });
    this._hooks.onStatus?.(message, command, action);
  }

  _isInScene(obj) {
    return HistoryManager.isInScene(obj, this.getScene());
  }

  _recomputeTotalBytes() {
    let total = 0;
    for (const c of this.undoStack) total += c._bytes || 0;
    for (const c of this.redoStack) total += c._bytes || 0;
    this.totalBytes = total;
  }

  _collectReferencedGeometries() {
    const active = new Set();
    const scene = this.getScene();
    if (scene && typeof scene.traverse === 'function') {
      scene.traverse((n) => {
        if (n && n.geometry) active.add(n.geometry);
      });
    }
    const scanCmd = (cmd) => {
      if (!cmd) return;
      if (cmd.type === 'batch' && Array.isArray(cmd.commands)) {
        for (const sub of cmd.commands) scanCmd(sub);
        return;
      }
      if (cmd.beforeGeo) active.add(cmd.beforeGeo);
      if (cmd.afterGeo) active.add(cmd.afterGeo);
      if (cmd.geo) active.add(cmd.geo);
      if (cmd.obj && typeof cmd.obj.traverse === 'function') {
        cmd.obj.traverse((n) => { if (n?.geometry) active.add(n.geometry); });
      }
      if (cmd.removals) {
        for (const r of cmd.removals) {
          if (r?.obj && typeof r.obj.traverse === 'function') {
            r.obj.traverse((n) => { if (n?.geometry) active.add(n.geometry); });
          }
        }
      }
    };
    for (const c of this.undoStack) scanCmd(c);
    for (const c of this.redoStack) scanCmd(c);
    return active;
  }

  _disposeOrphanedFromCommands(droppedCmds) {
    if (!droppedCmds || !droppedCmds.length) return;
    const active = this._collectReferencedGeometries();
    const disposeGeo = (geo) => {
      if (geo && !active.has(geo) && typeof geo.dispose === 'function') {
        active.add(geo);
        geo.dispose();
      }
    };
    const disposeCmd = (cmd) => {
      if (!cmd) return;
      if (cmd.type === 'batch' && Array.isArray(cmd.commands)) {
        for (const sub of cmd.commands) disposeCmd(sub);
        return;
      }
      if (cmd.beforeGeo) disposeGeo(cmd.beforeGeo);
      if (cmd.afterGeo) disposeGeo(cmd.afterGeo);
      if (cmd.obj && typeof cmd.obj.traverse === 'function') {
        cmd.obj.traverse((n) => { if (n?.geometry) disposeGeo(n.geometry); });
      }
      if (cmd.removals) {
        for (const r of cmd.removals) {
          if (r?.obj && typeof r.obj.traverse === 'function') {
            r.obj.traverse((n) => { if (n?.geometry) disposeGeo(n.geometry); });
          }
        }
      }
    };
    for (const cmd of droppedCmds) disposeCmd(cmd);
  }

  _enforceBudget() {
    const dropped = [];
    while (this.totalBytes > this.maxBytes && this.undoStack.length > this.minEntries) {
      const item = this.undoStack.shift();
      this.totalBytes -= item?._bytes || 0;
      if (item) dropped.push(item);
    }
    while (
      this.totalBytes > this.maxBytes &&
      this.redoStack.length > 0 &&
      (this.undoStack.length + this.redoStack.length) > this.minEntries
    ) {
      const item = this.redoStack.shift();
      this.totalBytes -= item?._bytes || 0;
      if (item) dropped.push(item);
    }
    if (dropped.length) this._disposeOrphanedFromCommands(dropped);
  }

  runGrouped(label, fn) {
    if (typeof fn !== 'function') return undefined;
    const bucket = { label: label || 'Acción', commands: [] };
    this._groupStack.push(bucket);
    let ok = false;
    let res;
    try {
      res = fn();
      ok = true;
    } finally {
      this._groupStack.pop();
      if (ok && bucket.commands.length) {
        if (bucket.commands.length === 1) {
          this.push(bucket.commands[0]);
        } else {
          this.push({ type: 'batch', label: bucket.label, commands: bucket.commands });
        }
      }
    }
    return res;
  }

  push(cmd) {
    if (!cmd) return;
    if (this._groupStack.length > 0) {
      const top = this._groupStack[this._groupStack.length - 1];
      if (cmd.type === 'batch' && Array.isArray(cmd.commands)) {
        top.commands.push(...cmd.commands);
      } else {
        top.commands.push(cmd);
      }
      return;
    }
    cmd._bytes = estimateCommandBytes(cmd);
    this.undoStack.push(cmd);
    const clearedRedo = this.redoStack.length ? this.redoStack.splice(0, this.redoStack.length) : null;
    if (clearedRedo) this._disposeOrphanedFromCommands(clearedRedo);
    this._recomputeTotalBytes();
    this._enforceBudget();
    this.emit('push', { command: cmd });
    this._emitChange('push', cmd);
  }

  clear() {
    this._groupStack.length = 0;
    const prevUndo = this.undoStack.splice(0, this.undoStack.length);
    const prevRedo = this.redoStack.splice(0, this.redoStack.length);
    this.totalBytes = 0;
    this._disposeOrphanedFromCommands([...prevUndo, ...prevRedo]);
    this.emit('clear');
    this._emitChange('clear', null);
  }

  captureSceneMeta() {
    if (typeof this._hooks.captureSceneMeta === 'function') {
      return this._hooks.captureSceneMeta();
    }
    return this._hooks.captureAnimState ? { animSnapshot: this._hooks.captureAnimState() } : null;
  }

  applySceneMeta(meta) {
    if (!meta) return;
    if (typeof this._hooks.applySceneMeta === 'function') {
      this._hooks.applySceneMeta(meta);
    } else if (meta.animSnapshot && typeof this._hooks.restoreAnimState === 'function') {
      this._hooks.restoreAnimState(meta.animSnapshot);
    }
  }

  buildRemovalRecord(obj) {
    const rec = {
      obj,
      parent: obj?.parent || null,
      index: obj?.parent ? obj.parent.children.indexOf(obj) : -1,
    };
    this._hooks.onBuildRemovalRecord?.(obj, rec);
    return rec;
  }

  applyRemoval(rec) {
    if (!rec || !rec.obj) return;
    this._hooks.onBeforeRemoval?.(rec.obj, rec);
    if (typeof rec.obj.removeFromParent === 'function') {
      rec.obj.removeFromParent();
    } else if (rec.obj.parent && Array.isArray(rec.obj.parent.children)) {
      const idx = rec.obj.parent.children.indexOf(rec.obj);
      if (idx >= 0) rec.obj.parent.children.splice(idx, 1);
      rec.obj.parent = null;
    }
    this._hooks.onApplyRemoval?.(rec);
  }

  undoRemoval(rec) {
    if (!rec || !rec.obj) return;
    if (rec.parent) {
      const idx = rec.index >= 0 ? Math.min(rec.index, rec.parent.children.length) : rec.parent.children.length;
      if (!rec.parent.children.includes(rec.obj)) {
        rec.parent.children.splice(idx, 0, rec.obj);
      }
      rec.obj.parent = rec.parent;
      if (typeof rec.obj.updateMatrixWorld === 'function') rec.obj.updateMatrixWorld();
    }
    this._hooks.onUndoRemoval?.(rec);
  }

  applySkeletonPatches(patches, useAfter) {
    if (!patches || !patches.length) return;
    const SkeletonCls = this._getHandler('Skeleton');
    if (!SkeletonCls || typeof SkeletonCls.applyBonePatch !== 'function') return;
    for (const patch of patches) {
      SkeletonCls.applyBonePatch(patch, useAfter);
    }
  }

  _selectIfPresent(obj) {
    if (obj && (this._isInScene(obj) || !this.getScene())) {
      this._hooks.selectObject?.(obj);
    }
  }

  _applyUndo(cmd) {
    if (!cmd) return;
    if (cmd.type === 'batch' && Array.isArray(cmd.commands)) {
      for (let i = cmd.commands.length - 1; i >= 0; i--) {
        this._applyUndo(cmd.commands[i]);
      }
      if (cmd.label) this._emitStatus(`${cmd.label} deshecha.`, cmd, 'undo');
      return;
    }

    if (cmd.type === 'transform') {
      const valid = [];
      const scene = this.getScene();
      (cmd.os || []).forEach((o, i) => {
        HistoryManager.restoreTransform(o, cmd.before?.[i]);
        if (!scene || HistoryManager.isInScene(o, scene)) valid.push(o);
      });
      this._hooks.onTransformRestored?.(cmd, valid, 'undo');
      return;
    }

    if (cmd.type === 'delete') {
      const removals = cmd.removals || [];
      for (let i = removals.length - 1; i >= 0; i--) {
        this.undoRemoval(removals[i]);
      }
      this.applySkeletonPatches(cmd.skeletonPatches, false);
      if (cmd.sceneMeta) this.applySceneMeta(cmd.sceneMeta);
      this._hooks.invalidateRigHelpers?.();
      this._selectIfPresent(cmd.prevSelected);
      this._emitStatus('Eliminación deshecha.', cmd, 'undo');
      return;
    }

    if (cmd.type === 'add') {
      const rec = this.buildRemovalRecord(cmd.obj);
      if (rec.spinNodes) cmd.spinNodes = rec.spinNodes;
      this.applyRemoval(rec);
      if (cmd.beforeSceneMeta) {
        this.applySceneMeta(cmd.beforeSceneMeta);
      } else if (cmd.afterSceneMeta) {
        this.applySceneMeta({
          mixer: null,
          animations: [],
          activeAction: null,
          animPlaying: true,
          activeClipIndex: 0,
        });
      }
      this._hooks.invalidateRigHelpers?.();
      this._selectIfPresent(cmd.prevSelected);
      this._emitStatus('Creación deshecha.', cmd, 'undo');
      return;
    }

    if (cmd.type === 'sculpt') {
      const SculptorCls = this._getHandler('Sculptor');
      if (SculptorCls && typeof SculptorCls.applyDiff === 'function') {
        if (cmd.beforeState) {
          SculptorCls.applyDiff(cmd.geo, cmd.diff, false, null);
          if (cmd.mesh && cmd.mesh.geometry !== cmd.geo) {
            if (typeof cmd.mesh.setGeometry === 'function') cmd.mesh.setGeometry(cmd.geo);
            else cmd.mesh.geometry = cmd.geo;
          }
          HistoryManager.restoreSubsurfSnapshot(cmd.mesh, cmd.beforeState, cmd.geo);
        } else {
          SculptorCls.applyDiff(cmd.geo, cmd.diff, false, cmd.mesh);
        }
      }
      this._hooks.onGeometryRestored?.(cmd.mesh, cmd, 'undo');
      this._selectIfPresent(cmd.mesh);
      this._emitStatus('Trazo de modelado deshecho.', cmd, 'undo');
      return;
    }

    if (cmd.type === 'paint') {
      const PainterCls = this._getHandler('Painter');
      if (PainterCls && typeof PainterCls.applyDiff === 'function') {
        PainterCls.applyDiff(cmd, false);
      }
      this._selectIfPresent(cmd.mesh);
      this._emitStatus(cmd.label ? `${cmd.label} deshecho.` : 'Trazo de pintura deshecho.', cmd, 'undo');
      return;
    }

    if (cmd.type === 'subdivide' || cmd.type === 'geometry') {
      if (cmd.mesh) {
        if (typeof cmd.mesh.setGeometry === 'function') cmd.mesh.setGeometry(cmd.beforeGeo);
        else cmd.mesh.geometry = cmd.beforeGeo;
        if ('beforeSubsurf' in cmd) {
          HistoryManager.restoreSubsurfSnapshot(cmd.mesh, cmd.beforeSubsurf, cmd.beforeGeo);
        } else if (cmd.mesh._subsurf) {
          this._getHandler('syncEditableBaseFromGeometry')?.(cmd.mesh);
        } else {
          cmd.mesh._subsurfDirtyFromGeometry = false;
        }
        if (cmd.beforeName !== undefined) cmd.mesh.name = cmd.beforeName;
        this._hooks.onGeometryRestored?.(cmd.mesh, cmd, 'undo');
        this._selectIfPresent(cmd.mesh);
      }
      this._emitStatus(
        cmd.type === 'geometry' ? 'Cambio de texto 3D deshecho.' : 'Subdivisión deshecha.',
        cmd,
        'undo'
      );
      return;
    }

    if (cmd.type === 'meshEdit') {
      if (cmd.mesh && cmd.beforeState) {
        this._getHandler('restoreMeshModelingState')?.(cmd.mesh, cmd.beforeState);
        this._hooks.onMeshEditRestored?.(cmd.mesh, cmd, 'undo');
        this._selectIfPresent(cmd.mesh);
      }
      this._emitStatus(`${cmd.label || 'Edición 3D'} deshecha.`, cmd, 'undo');
      return;
    }

    if (cmd.type === 'mergeMeshes') {
      if (cmd.mesh && cmd.beforeState) {
        this._getHandler('restoreMeshModelingState')?.(cmd.mesh, cmd.beforeState);
      }
      const removals = cmd.removals || [];
      for (let i = removals.length - 1; i >= 0; i--) {
        this.undoRemoval(removals[i]);
      }
      this._hooks.onMergeRestored?.(cmd, false);
      this._emitStatus('Fusión de mallas deshecha.', cmd, 'undo');
      return;
    }

    if (cmd.type === 'animClip') {
      if (cmd.clip && cmd.before) {
        if (typeof this._hooks.restoreAnimClip === 'function') {
          this._hooks.restoreAnimClip(cmd.clip, cmd.before);
        } else if (typeof cmd.clip.restoreSnapshot === 'function') {
          cmd.clip.restoreSnapshot(cmd.before);
        }
      }
      this._emitStatus(`${cmd.label || 'Animación'} deshecha.`, cmd, 'undo');
      return;
    }

    if (cmd.type === 'animState') {
      if (cmd.before) {
        this._hooks.restoreAnimState?.(cmd.before);
      }
      return;
    }

    if (typeof cmd.undo === 'function') {
      cmd.undo(this);
      if (cmd.label) this._emitStatus(`${cmd.label} deshecha.`, cmd, 'undo');
    }
  }

  _applyRedo(cmd) {
    if (!cmd) return;
    if (cmd.type === 'batch' && Array.isArray(cmd.commands)) {
      for (let i = 0; i < cmd.commands.length; i++) {
        this._applyRedo(cmd.commands[i]);
      }
      if (cmd.label) this._emitStatus(`${cmd.label} rehecha.`, cmd, 'redo');
      return;
    }

    if (cmd.type === 'transform') {
      const valid = [];
      const scene = this.getScene();
      (cmd.os || []).forEach((o, i) => {
        HistoryManager.restoreTransform(o, cmd.after?.[i]);
        if (!scene || HistoryManager.isInScene(o, scene)) valid.push(o);
      });
      this._hooks.onTransformRestored?.(cmd, valid, 'redo');
      return;
    }

    if (cmd.type === 'delete') {
      for (const rec of cmd.removals || []) {
        this.applyRemoval(rec);
      }
      this.applySkeletonPatches(cmd.skeletonPatches, true);
      if (cmd.afterSceneMeta) {
        this.applySceneMeta(cmd.afterSceneMeta);
      } else if (cmd.sceneMeta) {
        this.applySceneMeta({
          mixer: null,
          animations: [],
          activeAction: null,
          animPlaying: true,
          activeClipIndex: 0,
          cameraCounter: 0,
        });
      }
      this._hooks.invalidateRigHelpers?.();
      this._selectIfPresent(cmd.afterSelected);
      this._emitStatus('Eliminación rehecha.', cmd, 'redo');
      return;
    }

    if (cmd.type === 'add') {
      this.undoRemoval({
        obj: cmd.obj,
        parent: cmd.parent,
        index: cmd.index,
        wasUserObject: cmd.wasUserObject,
        userIndex: cmd.userIndex,
        spinNodes: cmd.spinNodes || [],
      });
      if (cmd.afterSceneMeta) this.applySceneMeta(cmd.afterSceneMeta);
      this._hooks.invalidateRigHelpers?.();
      this._selectIfPresent(cmd.obj);
      this._emitStatus('Creación rehecha.', cmd, 'redo');
      return;
    }

    if (cmd.type === 'sculpt') {
      const SculptorCls = this._getHandler('Sculptor');
      if (SculptorCls && typeof SculptorCls.applyDiff === 'function') {
        if (cmd.afterState) {
          SculptorCls.applyDiff(cmd.geo, cmd.diff, true, null);
          if (cmd.mesh && cmd.mesh.geometry !== cmd.geo) {
            if (typeof cmd.mesh.setGeometry === 'function') cmd.mesh.setGeometry(cmd.geo);
            else cmd.mesh.geometry = cmd.geo;
          }
          HistoryManager.restoreSubsurfSnapshot(cmd.mesh, cmd.afterState, cmd.geo);
        } else {
          SculptorCls.applyDiff(cmd.geo, cmd.diff, true, cmd.mesh);
        }
      }
      this._hooks.onGeometryRestored?.(cmd.mesh, cmd, 'redo');
      this._selectIfPresent(cmd.mesh);
      this._emitStatus('Trazo de modelado rehecho.', cmd, 'redo');
      return;
    }

    if (cmd.type === 'paint') {
      const PainterCls = this._getHandler('Painter');
      if (PainterCls && typeof PainterCls.applyDiff === 'function') {
        PainterCls.applyDiff(cmd, true);
      }
      this._selectIfPresent(cmd.mesh);
      this._emitStatus(cmd.label ? `${cmd.label} rehecho.` : 'Trazo de pintura rehecho.', cmd, 'redo');
      return;
    }

    if (cmd.type === 'subdivide' || cmd.type === 'geometry') {
      if (cmd.mesh) {
        if (typeof cmd.mesh.setGeometry === 'function') cmd.mesh.setGeometry(cmd.afterGeo);
        else cmd.mesh.geometry = cmd.afterGeo;
        if ('beforeSubsurf' in cmd) {
          cmd.mesh._subsurf = null;
          cmd.mesh._subsurfDirtyFromGeometry = false;
        } else if (cmd.mesh._subsurf) {
          this._getHandler('syncEditableBaseFromGeometry')?.(cmd.mesh);
        } else {
          cmd.mesh._subsurfDirtyFromGeometry = false;
        }
        if (cmd.afterName !== undefined) cmd.mesh.name = cmd.afterName;
        this._hooks.onGeometryRestored?.(cmd.mesh, cmd, 'redo');
        this._selectIfPresent(cmd.mesh);
      }
      this._emitStatus(
        cmd.type === 'geometry' ? 'Cambio de texto 3D rehecho.' : 'Subdivisión rehecha.',
        cmd,
        'redo'
      );
      return;
    }

    if (cmd.type === 'meshEdit') {
      if (cmd.mesh && cmd.afterState) {
        this._getHandler('restoreMeshModelingState')?.(cmd.mesh, cmd.afterState);
        this._hooks.onMeshEditRestored?.(cmd.mesh, cmd, 'redo');
        this._selectIfPresent(cmd.mesh);
      }
      this._emitStatus(`${cmd.label || 'Edición 3D'} rehecha.`, cmd, 'redo');
      return;
    }

    if (cmd.type === 'mergeMeshes') {
      for (const rec of cmd.removals || []) {
        this.applyRemoval(rec);
      }
      if (cmd.mesh && cmd.afterState) {
        this._getHandler('restoreMeshModelingState')?.(cmd.mesh, cmd.afterState);
        this._selectIfPresent(cmd.mesh);
      }
      this._hooks.onMergeRestored?.(cmd, true);
      this._emitStatus('Fusión de mallas rehecha.', cmd, 'redo');
      return;
    }

    if (cmd.type === 'animClip') {
      if (cmd.clip && cmd.after) {
        if (typeof this._hooks.restoreAnimClip === 'function') {
          this._hooks.restoreAnimClip(cmd.clip, cmd.after);
        } else if (typeof cmd.clip.restoreSnapshot === 'function') {
          cmd.clip.restoreSnapshot(cmd.after);
        }
      }
      this._emitStatus(`${cmd.label || 'Animación'} rehecha.`, cmd, 'redo');
      return;
    }

    if (cmd.type === 'animState') {
      if (cmd.after) {
        this._hooks.restoreAnimState?.(cmd.after);
      }
      return;
    }

    if (typeof cmd.redo === 'function') {
      cmd.redo(this);
      if (cmd.label) this._emitStatus(`${cmd.label} rehecha.`, cmd, 'redo');
    }
  }

  undo() {
    if (!this.undoStack.length) return null;
    this._hooks.onBeforeUndo?.();
    const cmd = this.undoStack.pop();
    if (!cmd) return null;
    this.redoStack.push(cmd);

    this._applyUndo(cmd);

    this._hooks.onAfterHistory?.('undo', cmd);
    this.emit('undo', { command: cmd });
    this._emitChange('undo', cmd);
    return cmd;
  }

  redo() {
    if (!this.redoStack.length) return null;
    this._hooks.onBeforeRedo?.();
    const cmd = this.redoStack.pop();
    if (!cmd) return null;
    this.undoStack.push(cmd);

    this._applyRedo(cmd);

    this._hooks.onAfterHistory?.('redo', cmd);
    this.emit('redo', { command: cmd });
    this._emitChange('redo', cmd);
    return cmd;
  }
}
