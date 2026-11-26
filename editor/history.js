import { HistoryManager, estimateCommandBytes } from '../made3d.module.js';
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
  rig,
  isInScene,
  isDescendantOrSelf,
} from './store.js';

export { HistoryManager, estimateCommandBytes };

// Asegurar manejadores nativos registrados para sculpt, modeling y rigging en el editor
HistoryManager.registerHandlers({
  Sculptor,
  Skeleton,
  restoreMeshModelingState,
  syncEditableBaseFromGeometry,
});

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

function detachEditorToolsIfInside(target) {
  if (recorder.camera && isDescendantOrSelf(recorder.camera, target)) {
    history._hooks.stopCameraVideo?.({ cancel: true });
  }
  if (cameraView.activeSceneCam && isDescendantOrSelf(cameraView.activeSceneCam, target)) {
    history._hooks.exitCameraView?.();
  }
  if (edit.active && edit.editor.mesh && isDescendantOrSelf(edit.editor.mesh, target)) {
    history._hooks.setEditMode?.(false);
  }
  if (sculpt.sculptor?._stroke?.mesh && isDescendantOrSelf(sculpt.sculptor._stroke.mesh, target)) {
    sculpt.sculptor.cancelStroke();
  }
  if (sculpt.sculptor?.hover?.mesh && isDescendantOrSelf(sculpt.sculptor.hover.mesh, target)) {
    sculpt.sculptor.hover = null;
  }
  if (rig.rigger.activeTipBone && isDescendantOrSelf(rig.rigger.activeTipBone, target)) {
    rig.rigger.activeTipBone = null;
    rig.rigger.activeTipAttach = 'tail';
  }
  if (rig.rigger.selectedBone && isDescendantOrSelf(rig.rigger.selectedBone, target)) {
    rig.rigger.selectedBone = null;
  }
  if (rig.rigger.hover?.mesh && isDescendantOrSelf(rig.rigger.hover.mesh, target)) {
    rig.rigger.hover = null;
  }
  if (viewport.gizmo && viewport.gizmo.objects.some((item) => isDescendantOrSelf(item, target))) {
    viewport.gizmo.detach();
  }
  if (sceneStore.selected && isDescendantOrSelf(sceneStore.selected, target)) {
    sceneStore.selected = null;
  }
  sceneStore.selectedList = sceneStore.selectedList.filter((item) => !isDescendantOrSelf(item, target));
}

function cancelActiveGizmoDrag() {
  if (viewport.gizmo?.drag) viewport.gizmo.cancel();
  if (dom.gizmoReadout) dom.gizmoReadout.hidden = true;
}

export const history = new HistoryManager({
  getScene: () => viewport.scene,
  hooks: {
    onStatus: (message) => setStatus(message),
    onBeforeUndo: cancelActiveGizmoDrag,
    onBeforeRedo: cancelActiveGizmoDrag,

    captureSceneMeta: () => ({
      mixer: sceneStore.mixer,
      animations: sceneStore.animations.slice(),
      activeAction: sceneStore.activeAction,
      animPlaying: sceneStore.animPlaying,
      activeClipIndex: sceneStore.activeClipIndex ?? (dom.animSelect ? Number(dom.animSelect.value || 0) : 0),
      cameraCounter: sceneStore.cameraCounter,
      animSnapshot: history._hooks.captureAnimState ? history._hooks.captureAnimState() : null,
    }),

    applySceneMeta: (meta) => {
      if (!meta) return;
      if (meta.cameraCounter !== undefined) sceneStore.cameraCounter = meta.cameraCounter;
      sceneStore.mixer = meta.mixer || null;
      sceneStore.animations = meta.animations ? meta.animations.slice() : [];
      sceneStore.activeAction = meta.activeAction || null;
      sceneStore.activeClipIndex = meta.activeClipIndex ?? 0;
      sceneStore.animPlaying = meta.animPlaying !== undefined ? meta.animPlaying : true;
      if (meta.animSnapshot && history._hooks.restoreAnimState) {
        history._hooks.restoreAnimState(meta.animSnapshot);
      }
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
    },

    onBuildRemovalRecord: (obj, rec) => {
      const spinNodes = [];
      obj.traverse((n) => {
        if (sceneStore.spinObjects.has(n)) spinNodes.push(n);
      });
      rec.wasUserObject = sceneStore.userObjects.includes(obj);
      rec.userIndex = sceneStore.userObjects.indexOf(obj);
      rec.spinNodes = spinNodes;
    },

    onBeforeRemoval: (obj) => {
      detachEditorToolsIfInside(obj);
    },

    onApplyRemoval: (rec) => {
      for (const sn of rec.spinNodes || []) sceneStore.spinObjects.delete(sn);
      if (rec.wasUserObject) {
        sceneStore.userObjects = sceneStore.userObjects.filter((item) => item !== rec.obj);
      }
    },

    onUndoRemoval: (rec) => {
      if (rec.wasUserObject && !sceneStore.userObjects.includes(rec.obj)) {
        const uIdx = rec.userIndex >= 0 ? Math.min(rec.userIndex, sceneStore.userObjects.length) : sceneStore.userObjects.length;
        sceneStore.userObjects.splice(uIdx, 0, rec.obj);
      }
      for (const sn of rec.spinNodes || []) sceneStore.spinObjects.add(sn);
      if (sceneStore.mixer?.invalidateCache) sceneStore.mixer.invalidateCache();
    },

    onTransformRestored: (cmd, valid) => {
      if (valid.length) {
        sceneStore.selected = valid[valid.length - 1];
        sceneStore.selectedList = valid.slice();
        if (viewport.gizmo) {
          viewport.gizmo.attach(valid);
          viewport.gizmo.visible = !(cameraView.activeSceneCam && sceneStore.selected === cameraView.activeSceneCam);
        }
      }
      if (cameraView.activeSceneCam && cmd.os.includes(cameraView.activeSceneCam) && viewport.controls) {
        viewport.controls.syncFromCamera();
      }
      history._hooks.syncTransformInputs?.();
    },

    onGeometryRestored: (mesh) => {
      sculpt.sculptor.hover = null;
      if (edit.active && edit.editor.mesh === mesh) edit.editor.setMesh(mesh);
    },

    onMeshEditRestored: (mesh) => {
      if (edit.editor.mesh === mesh) edit.editor.clearSelection();
    },

    onMergeRestored: (cmd, isRedo) => {
      if (!isRedo && cmd.prevSelection?.length) {
        const alive = cmd.prevSelection.filter((item) => isInScene(item));
        if (alive.length > 1 && viewport.gizmo) {
          viewport.gizmo.attach(alive);
          sceneStore.selectedList = alive;
          sceneStore.selected = alive[alive.length - 1];
        } else if (alive[0]) {
          history._hooks.selectObject?.(alive[0]);
        }
      }
    },

    onAfterHistory: () => {
      syncPrimaryLightRefs();
      history._hooks.syncCameraHelperSelection?.();
      history._hooks.syncSelectedUI?.();
      history._hooks.syncSculptUI?.();
      history._hooks.syncEditUI?.();
      history._hooks.syncRigUI?.();
      history._hooks.syncAnimationUI?.();
      history._hooks.renderObjectList?.();
    },
  },
});

history.updateButtons = () => {
  if (dom.btnUndo) dom.btnUndo.disabled = !history.canUndo;
  if (dom.btnRedo) dom.btnRedo.disabled = !history.canRedo;
};

history.on('change', () => history.updateButtons());
