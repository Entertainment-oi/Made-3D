import { Skeleton } from '../src/modules/rigging.js';
import { Sculptor } from '../src/modules/sculpt.js';
import { restoreMeshModelingState, syncEditableBaseFromGeometry } from '../src/modules/modeling.js';
import { dom, setStatus } from './dom.js';
import {
  viewport,
  sceneStore,
  lighting,
  cameraView,
  recorder,
  sculpt,
  edit,
  isInScene,
  isDescendantOrSelf,
  restoreLocal,
} from './store.js';

export function estimateCommandBytes(cmd) {
  if (!cmd || typeof cmd !== 'object') return 256;
  let bytes = 512;

  if (cmd.type === 'sculpt' && cmd.diff) {
    const { indices, beforePos, afterPos, beforeNor, afterNor } = cmd.diff;
    if (indices) bytes += indices.byteLength || indices.length * 4;
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
    const vLen = (cmd.beforeState?.baseMesh?.verts?.length || 0) + (cmd.afterState?.baseMesh?.verts?.length || 0);
    const fLen = (cmd.beforeState?.baseMesh?.faces?.length || 0) + (cmd.afterState?.baseMesh?.faces?.length || 0);
    bytes += vLen * 32 + fLen * 48 + (cmd.removals ? cmd.removals.length * 256 : 0);
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

function syncPrimaryLightRefs() {
  if (!viewport.scene) return;
  if (lighting.dirLight && !isInScene(lighting.dirLight)) {
    let foundDir = null;
    viewport.scene.traverse((n) => { if (!foundDir && n.isDirectionalLight) foundDir = n; });
    lighting.dirLight = foundDir;
  }
  if (lighting.pointLight && !isInScene(lighting.pointLight)) {
    let foundPoint = null;
    viewport.scene.traverse((n) => { if (!foundPoint && n.isPointLight) foundPoint = n; });
    lighting.pointLight = foundPoint;
  }
}

export class HistoryManager {
  constructor(opts = {}) {
    this.undoStack = [];
    this.redoStack = [];
    this.maxBytes = opts.maxBytes ?? 64 * 1024 * 1024;
    this.minEntries = opts.minEntries ?? 8;
    this.totalBytes = 0;
    this._hooks = {};
  }

  setHooks(hooks = {}) {
    this._hooks = { ...this._hooks, ...hooks };
  }

  get undoLength() { return this.undoStack.length; }
  get redoLength() { return this.redoStack.length; }

  updateButtons() {
    if (dom.btnUndo) dom.btnUndo.disabled = this.undoStack.length === 0;
    if (dom.btnRedo) dom.btnRedo.disabled = this.redoStack.length === 0;
  }

  _recomputeTotalBytes() {
    let total = 0;
    for (const c of this.undoStack) total += c._bytes || 0;
    for (const c of this.redoStack) total += c._bytes || 0;
    this.totalBytes = total;
  }

  _collectReferencedGeometries() {
    const active = new Set();
    if (viewport.scene && typeof viewport.scene.traverse === 'function') {
      viewport.scene.traverse((n) => {
        if (n && n.geometry) active.add(n.geometry);
      });
    }
    const scanCmd = (cmd) => {
      if (!cmd) return;
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
    for (const cmd of droppedCmds) {
      if (!cmd) continue;
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
    }
  }

  _enforceBudget() {
    const dropped = [];
    while (this.totalBytes > this.maxBytes && this.undoStack.length > this.minEntries) {
      const item = this.undoStack.shift();
      this.totalBytes -= item?._bytes || 0;
      if (item) dropped.push(item);
    }
    while (this.totalBytes > this.maxBytes && this.redoStack.length > 0 && (this.undoStack.length + this.redoStack.length) > this.minEntries) {
      const item = this.redoStack.shift();
      this.totalBytes -= item?._bytes || 0;
      if (item) dropped.push(item);
    }
    if (dropped.length) this._disposeOrphanedFromCommands(dropped);
  }

  push(cmd) {
    if (!cmd) return;
    cmd._bytes = estimateCommandBytes(cmd);
    this.undoStack.push(cmd);
    const clearedRedo = this.redoStack.length ? this.redoStack.splice(0, this.redoStack.length) : null;
    if (clearedRedo) this._disposeOrphanedFromCommands(clearedRedo);
    this._recomputeTotalBytes();
    this._enforceBudget();
    this.updateButtons();
  }

  clear() {
    const prevUndo = this.undoStack.splice(0, this.undoStack.length);
    const prevRedo = this.redoStack.splice(0, this.redoStack.length);
    this.totalBytes = 0;
    this._disposeOrphanedFromCommands([...prevUndo, ...prevRedo]);
    this.updateButtons();
  }

  captureSceneMeta() {
    return {
      mixer: sceneStore.mixer,
      animations: sceneStore.animations.slice(),
      activeAction: sceneStore.activeAction,
      animPlaying: sceneStore.animPlaying,
      activeClipIndex: sceneStore.activeClipIndex ?? (dom.animSelect ? Number(dom.animSelect.value || 0) : 0),
      cameraCounter: sceneStore.cameraCounter,
    };
  }

  applySceneMeta(meta) {
    if (!meta) return;
    if (meta.cameraCounter !== undefined) sceneStore.cameraCounter = meta.cameraCounter;
    sceneStore.mixer = meta.mixer || null;
    sceneStore.animations = meta.animations ? meta.animations.slice() : [];
    sceneStore.activeAction = meta.activeAction || null;
    sceneStore.activeClipIndex = meta.activeClipIndex ?? 0;
    sceneStore.animPlaying = meta.animPlaying !== undefined ? meta.animPlaying : true;
    if (viewport.picker) viewport.picker.setMixer(sceneStore.mixer);
    if (dom.animSelect) dom.animSelect.innerHTML = '';
    if (sceneStore.animations.length && sceneStore.mixer) {
      if (dom.animSelect) {
        sceneStore.animations.forEach((clip, idx) => {
          const opt = document.createElement('option');
          opt.value = String(idx);
          opt.textContent = clip.name || `Clip ${idx + 1}`;
          dom.animSelect.appendChild(opt);
        });
        if (meta.activeClipIndex >= 0 && meta.activeClipIndex < sceneStore.animations.length) {
          dom.animSelect.value = String(meta.activeClipIndex);
        }
      }
      if (dom.btnAnimPlay) dom.btnAnimPlay.textContent = sceneStore.animPlaying ? 'Pausar' : 'Reproducir';
      if (dom.animGroup) dom.animGroup.hidden = false;
      if (typeof sceneStore.mixer.invalidateCache === 'function') sceneStore.mixer.invalidateCache();
    } else if (dom.animGroup) {
      dom.animGroup.hidden = true;
    }
  }

  detachIfInside(target) {
    if (recorder.camera && isDescendantOrSelf(recorder.camera, target)) {
      this._hooks.stopCameraVideo?.({ cancel: true });
    }
    if (cameraView.activeSceneCam && isDescendantOrSelf(cameraView.activeSceneCam, target)) {
      this._hooks.exitCameraView?.();
    }
    if (edit.active && edit.editor.mesh && isDescendantOrSelf(edit.editor.mesh, target)) {
      this._hooks.setEditMode?.(false);
    }
    if (viewport.gizmo && viewport.gizmo.objects.some((item) => isDescendantOrSelf(item, target))) {
      viewport.gizmo.detach();
    }
    if (sceneStore.selected && isDescendantOrSelf(sceneStore.selected, target)) {
      sceneStore.selected = null;
    }
    sceneStore.selectedList = sceneStore.selectedList.filter((item) => !isDescendantOrSelf(item, target));
  }

  buildRemovalRecord(obj) {
    const spinNodes = [];
    obj.traverse((n) => {
      if (sceneStore.spinObjects.has(n)) spinNodes.push(n);
    });
    return {
      obj,
      parent: obj.parent,
      index: obj.parent ? obj.parent.children.indexOf(obj) : -1,
      wasUserObject: sceneStore.userObjects.includes(obj),
      userIndex: sceneStore.userObjects.indexOf(obj),
      spinNodes,
    };
  }

  applyRemoval(rec) {
    this.detachIfInside(rec.obj);
    rec.obj.removeFromParent();
    for (const sn of rec.spinNodes) sceneStore.spinObjects.delete(sn);
    if (rec.wasUserObject) {
      sceneStore.userObjects = sceneStore.userObjects.filter((item) => item !== rec.obj);
    }
  }

  undoRemoval(rec) {
    if (rec.parent) {
      const idx = rec.index >= 0 ? Math.min(rec.index, rec.parent.children.length) : rec.parent.children.length;
      rec.parent.children.splice(idx, 0, rec.obj);
      rec.obj.parent = rec.parent;
      rec.obj.updateMatrixWorld();
    }
    if (rec.wasUserObject && !sceneStore.userObjects.includes(rec.obj)) {
      const uIdx = rec.userIndex >= 0 ? Math.min(rec.userIndex, sceneStore.userObjects.length) : sceneStore.userObjects.length;
      sceneStore.userObjects.splice(uIdx, 0, rec.obj);
    }
    for (const sn of rec.spinNodes) sceneStore.spinObjects.add(sn);
    if (sceneStore.mixer?.invalidateCache) sceneStore.mixer.invalidateCache();
  }

  applySkeletonPatches(patches, useAfter) {
    if (!patches || !patches.length) return;
    for (const patch of patches) {
      Skeleton.applyBonePatch(patch, useAfter);
    }
  }

  undo() {
    if (viewport.gizmo?.drag) viewport.gizmo.cancel();
    if (dom.gizmoReadout) dom.gizmoReadout.hidden = true;
    const cmd = this.undoStack.pop();
    if (!cmd) return;
    this.redoStack.push(cmd);

    if (cmd.type === 'transform') {
      const valid = [];
      cmd.os.forEach((o, i) => {
        restoreLocal(o, cmd.before[i]);
        if (isInScene(o)) valid.push(o);
      });
      if (valid.length) {
        sceneStore.selected = valid[valid.length - 1];
        sceneStore.selectedList = valid.slice();
        if (viewport.gizmo) {
          viewport.gizmo.attach(valid);
          viewport.gizmo.visible = !(cameraView.activeSceneCam && sceneStore.selected === cameraView.activeSceneCam);
        }
      }
      if (cameraView.activeSceneCam && cmd.os.includes(cameraView.activeSceneCam)) {
        viewport.controls.syncFromCamera();
      }
      this._hooks.syncTransformInputs?.();
    } else if (cmd.type === 'delete') {
      for (let i = cmd.removals.length - 1; i >= 0; i--) {
        this.undoRemoval(cmd.removals[i]);
      }
      this.applySkeletonPatches(cmd.skeletonPatches, false);
      if (cmd.sceneMeta) this.applySceneMeta(cmd.sceneMeta);
      this._hooks.invalidateRigHelpers?.();
      if (cmd.prevSelected && isInScene(cmd.prevSelected)) {
        this._hooks.selectObject?.(cmd.prevSelected);
      }
      setStatus('Eliminación deshecha.');
    } else if (cmd.type === 'add') {
      const rec = this.buildRemovalRecord(cmd.obj);
      cmd.spinNodes = rec.spinNodes;
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
      if (cmd.prevSelected && isInScene(cmd.prevSelected)) {
        this._hooks.selectObject?.(cmd.prevSelected);
      }
      setStatus('Creación deshecha.');
    } else if (cmd.type === 'sculpt') {
      Sculptor.applyDiff(cmd.geo, cmd.diff, false, cmd.mesh);
      sculpt.sculptor.hover = null;
      if (edit.active && edit.editor.mesh === cmd.mesh) edit.editor.setMesh(cmd.mesh);
      if (cmd.mesh && isInScene(cmd.mesh)) this._hooks.selectObject?.(cmd.mesh);
      setStatus('Trazo de modelado deshecho.');
    } else if (cmd.type === 'subdivide' || cmd.type === 'geometry') {
      if (cmd.mesh) {
        if (cmd.mesh.setGeometry) cmd.mesh.setGeometry(cmd.beforeGeo);
        else cmd.mesh.geometry = cmd.beforeGeo;
        if (cmd.mesh._subsurf) syncEditableBaseFromGeometry(cmd.mesh);
        else cmd.mesh._subsurfDirtyFromGeometry = false;
        if (edit.active && edit.editor.mesh === cmd.mesh) edit.editor.setMesh(cmd.mesh);
        if (cmd.beforeName !== undefined) cmd.mesh.name = cmd.beforeName;
        if (isInScene(cmd.mesh)) this._hooks.selectObject?.(cmd.mesh);
      }
      setStatus(cmd.type === 'geometry' ? 'Cambio de texto 3D deshecho.' : 'Subdivisión deshecha.');
    } else if (cmd.type === 'meshEdit') {
      if (cmd.mesh && cmd.beforeState) {
        restoreMeshModelingState(cmd.mesh, cmd.beforeState);
        if (edit.editor.mesh === cmd.mesh) edit.editor.clearSelection();
        if (isInScene(cmd.mesh)) this._hooks.selectObject?.(cmd.mesh);
      }
      setStatus(`${cmd.label || 'Edición 3D'} deshecha.`);
    } else if (cmd.type === 'mergeMeshes') {
      if (cmd.mesh && cmd.beforeState) {
        restoreMeshModelingState(cmd.mesh, cmd.beforeState);
      }
      for (let i = cmd.removals.length - 1; i >= 0; i--) {
        this.undoRemoval(cmd.removals[i]);
      }
      if (cmd.prevSelection?.length) {
        const alive = cmd.prevSelection.filter((item) => isInScene(item));
        if (alive.length > 1 && viewport.gizmo) {
          viewport.gizmo.attach(alive);
          sceneStore.selectedList = alive;
          sceneStore.selected = alive[alive.length - 1];
        } else if (alive[0]) {
          this._hooks.selectObject?.(alive[0]);
        }
      }
      setStatus('Fusión de mallas deshecha.');
    }

    syncPrimaryLightRefs();
    this._hooks.syncCameraHelperSelection?.();
    this._hooks.syncSelectedUI?.();
    this._hooks.syncSculptUI?.();
    this._hooks.syncEditUI?.();
    this._hooks.renderObjectList?.();
    this.updateButtons();
  }

  redo() {
    if (viewport.gizmo?.drag) viewport.gizmo.cancel();
    if (dom.gizmoReadout) dom.gizmoReadout.hidden = true;
    const cmd = this.redoStack.pop();
    if (!cmd) return;
    this.undoStack.push(cmd);

    if (cmd.type === 'transform') {
      const valid = [];
      cmd.os.forEach((o, i) => {
        restoreLocal(o, cmd.after[i]);
        if (isInScene(o)) valid.push(o);
      });
      if (valid.length) {
        sceneStore.selected = valid[valid.length - 1];
        sceneStore.selectedList = valid.slice();
        if (viewport.gizmo) {
          viewport.gizmo.attach(valid);
          viewport.gizmo.visible = !(cameraView.activeSceneCam && sceneStore.selected === cameraView.activeSceneCam);
        }
      }
      if (cameraView.activeSceneCam && cmd.os.includes(cameraView.activeSceneCam)) {
        viewport.controls.syncFromCamera();
      }
      this._hooks.syncTransformInputs?.();
    } else if (cmd.type === 'delete') {
      for (const rec of cmd.removals) {
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
      if (cmd.afterSelected && isInScene(cmd.afterSelected)) {
        this._hooks.selectObject?.(cmd.afterSelected);
      }
      setStatus('Eliminación rehecha.');
    } else if (cmd.type === 'add') {
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
      if (isInScene(cmd.obj)) this._hooks.selectObject?.(cmd.obj);
      setStatus('Creación rehecha.');
    } else if (cmd.type === 'sculpt') {
      Sculptor.applyDiff(cmd.geo, cmd.diff, true, cmd.mesh);
      sculpt.sculptor.hover = null;
      if (edit.active && edit.editor.mesh === cmd.mesh) edit.editor.setMesh(cmd.mesh);
      if (cmd.mesh && isInScene(cmd.mesh)) this._hooks.selectObject?.(cmd.mesh);
      setStatus('Trazo de modelado rehecho.');
    } else if (cmd.type === 'subdivide' || cmd.type === 'geometry') {
      if (cmd.mesh) {
        if (cmd.mesh.setGeometry) cmd.mesh.setGeometry(cmd.afterGeo);
        else cmd.mesh.geometry = cmd.afterGeo;
        if (cmd.mesh._subsurf) syncEditableBaseFromGeometry(cmd.mesh);
        else cmd.mesh._subsurfDirtyFromGeometry = false;
        if (edit.active && edit.editor.mesh === cmd.mesh) edit.editor.setMesh(cmd.mesh);
        if (cmd.afterName !== undefined) cmd.mesh.name = cmd.afterName;
        if (isInScene(cmd.mesh)) this._hooks.selectObject?.(cmd.mesh);
      }
      setStatus(cmd.type === 'geometry' ? 'Cambio de texto 3D rehecho.' : 'Subdivisión rehecha.');
    } else if (cmd.type === 'meshEdit') {
      if (cmd.mesh && cmd.afterState) {
        restoreMeshModelingState(cmd.mesh, cmd.afterState);
        if (edit.editor.mesh === cmd.mesh) edit.editor.clearSelection();
        if (isInScene(cmd.mesh)) this._hooks.selectObject?.(cmd.mesh);
      }
      setStatus(`${cmd.label || 'Edición 3D'} rehecha.`);
    } else if (cmd.type === 'mergeMeshes') {
      for (const rec of cmd.removals) {
        this.applyRemoval(rec);
      }
      if (cmd.mesh && cmd.afterState) {
        restoreMeshModelingState(cmd.mesh, cmd.afterState);
        if (isInScene(cmd.mesh)) this._hooks.selectObject?.(cmd.mesh);
      }
      setStatus('Fusión de mallas rehecha.');
    }

    syncPrimaryLightRefs();
    this._hooks.syncCameraHelperSelection?.();
    this._hooks.syncSelectedUI?.();
    this._hooks.syncSculptUI?.();
    this._hooks.syncEditUI?.();
    this._hooks.renderObjectList?.();
    this.updateButtons();
  }
}

export const history = new HistoryManager();
