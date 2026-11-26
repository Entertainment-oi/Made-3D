import { RAD2DEG, DEG2RAD, HistoryManager } from '../../made3d.module.js';
import { snapshotMeshModelingState } from '../../src/modules/modeling.js';
import { dom, bindDoubleTap } from '../dom.js';
import { viewport, sceneStore, cameraView, sculpt, edit, snapshotLocal } from '../store.js';
import { history } from '../history.js';
import {
  resetCamera,
  setGizmoStyle,
  setGizmoMode,
  setEditPivotMode,
  syncGizmoSpaceUI,
} from '../viewport.js';
import { runEditDelete } from '../editController.js';
import { duplicateSelected, deleteSelected } from '../sceneActions.js';
import { recordAutoKeyframeIfNeeded } from '../animationController.js';
import { closeAllPopovers, syncViewCameraQuickBtn } from './popovers.js';

export function syncGizmoXyzPanel() {
  if (!dom.gizmoXyzPanel) return;
  const mode = edit.active ? edit.editor.transformMode : (viewport.gizmo?.mode || 'select');
  const activeTransform = mode === 'translate' || mode === 'rotate' || mode === 'scale';
  if (!viewport.gizmoXyzOpen || !activeTransform || sculpt.active) {
    dom.gizmoXyzPanel.hidden = true;
    syncViewCameraQuickBtn();
    return;
  }

  const titles = { translate: 'Mover', rotate: 'Rotar', scale: 'Escalar' };
  if (dom.gizmoXyzTitle) dom.gizmoXyzTitle.textContent = titles[mode] || 'Transformar';
  dom.gizmoXyzPanel.hidden = false;
  syncViewCameraQuickBtn();

  const focused = document.activeElement?.closest('#gizmo-xyz-panel');
  if (focused) return;

  const step = mode === 'rotate' ? '1' : '0.1';
  [dom.gizmoValX, dom.gizmoValY, dom.gizmoValZ].forEach((inp) => {
    if (inp) inp.step = step;
  });

  if (edit.active && edit.editor.mesh && mode === 'translate') {
    const c = edit.editor.getSelectionCentroidLocal();
    if (c) {
      if (dom.gizmoValX) dom.gizmoValX.value = c.x.toFixed(2);
      if (dom.gizmoValY) dom.gizmoValY.value = c.y.toFixed(2);
      if (dom.gizmoValZ) dom.gizmoValZ.value = c.z.toFixed(2);
      return;
    }
  }

  const o = sceneStore.selected;
  if (!o) {
    if (dom.gizmoValX) dom.gizmoValX.value = '0.00';
    if (dom.gizmoValY) dom.gizmoValY.value = '0.00';
    if (dom.gizmoValZ) dom.gizmoValZ.value = '0.00';
    return;
  }

  if (mode === 'translate') {
    if (dom.gizmoValX) dom.gizmoValX.value = o.position.x.toFixed(2);
    if (dom.gizmoValY) dom.gizmoValY.value = o.position.y.toFixed(2);
    if (dom.gizmoValZ) dom.gizmoValZ.value = o.position.z.toFixed(2);
  } else if (mode === 'rotate') {
    if (dom.gizmoValX) dom.gizmoValX.value = String(Math.round(o.rotation.x * RAD2DEG));
    if (dom.gizmoValY) dom.gizmoValY.value = String(Math.round(o.rotation.y * RAD2DEG));
    if (dom.gizmoValZ) dom.gizmoValZ.value = String(Math.round(o.rotation.z * RAD2DEG));
  } else if (mode === 'scale') {
    if (dom.gizmoValX) dom.gizmoValX.value = o.scale.x.toFixed(2);
    if (dom.gizmoValY) dom.gizmoValY.value = o.scale.y.toFixed(2);
    if (dom.gizmoValZ) dom.gizmoValZ.value = o.scale.z.toFixed(2);
  }
}

export function syncTransformInputs() {
  syncGizmoXyzPanel();
}

export function bindGizmoControls() {
  document.querySelectorAll('.seg-btn[data-mode]').forEach((btn) => {
    const mode = btn.dataset.mode;
    if (mode === 'select') {
      btn.addEventListener('click', () => {
        viewport.gizmoXyzOpen = false;
        setGizmoMode('select');
      });
    } else {
      bindDoubleTap(
        btn,
        () => setGizmoMode(mode),
        () => {
          setGizmoMode(mode);
          viewport.gizmoXyzOpen = true;
          syncGizmoXyzPanel();
        },
        { delayMs: 280, waitSingle: false }
      );
    }
  });

  dom.btnGizmoXyzClose?.addEventListener('click', () => {
    viewport.gizmoXyzOpen = false;
    syncGizmoXyzPanel();
  });

  let xyzTarget = null;
  let xyzBeforeObj = null;
  let xyzBeforeMesh = null;
  const xyzInputs = [dom.gizmoValX, dom.gizmoValY, dom.gizmoValZ];
  const axes = ['x', 'y', 'z'];

  xyzInputs.forEach((input, idx) => {
    if (!input) return;
    input.addEventListener('focus', () => {
      if (edit.active && edit.editor.mesh && edit.editor.transformMode === 'translate') {
        const c = edit.editor.getSelectionCentroidLocal();
        if (c) {
          xyzTarget = edit.editor.mesh;
          xyzBeforeMesh = snapshotMeshModelingState(edit.editor.mesh);
          xyzBeforeObj = null;
          return;
        }
      }
      if (sceneStore.selected) {
        xyzTarget = sceneStore.selected;
        xyzBeforeObj = snapshotLocal(sceneStore.selected);
        xyzBeforeMesh = null;
      }
    });

    input.addEventListener('input', () => {
      const val = parseFloat(input.value);
      if (!Number.isFinite(val)) return;

      if (edit.active && edit.editor.mesh && edit.editor.transformMode === 'translate') {
        if (edit.editor.setSelectionCentroidAxis(axes[idx], val)) {
          return;
        }
      }

      const o = sceneStore.selected;
      if (!o) return;
      const mode = viewport.gizmo?.mode || 'translate';
      if (mode === 'translate') {
        o.position[axes[idx]] = val;
      } else if (mode === 'rotate') {
        o.rotation[axes[idx]] = val * DEG2RAD;
      } else if (mode === 'scale') {
        o.scale[axes[idx]] = Math.max(0.05, val);
      }
      o.updateMatrixWorld();
      if (cameraView.activeSceneCam === o && !cameraView.camViewLocked) {
        if (mode === 'rotate') viewport.controls.syncTargetFromCamera(Math.max(0.5, viewport.controls.radius || 6));
        else viewport.controls.syncFromCamera();
      }
    });

    input.addEventListener('change', () => {
      if (xyzBeforeMesh && edit.active && edit.editor.mesh === xyzTarget) {
        const afterMesh = snapshotMeshModelingState(xyzTarget);
        if (afterMesh) {
          history.push({
            type: 'meshEdit',
            mesh: xyzTarget,
            beforeState: xyzBeforeMesh,
            afterState: afterMesh,
            label: 'Mover selección',
          });
        }
        xyzBeforeMesh = snapshotMeshModelingState(xyzTarget);
        syncGizmoXyzPanel();
        return;
      }

      const cur = sceneStore.selected;
      if (cur && xyzBeforeObj && xyzTarget === cur) {
        const afterState = snapshotLocal(cur);
        if (HistoryManager.hasTransformChanged(xyzBeforeObj, afterState, { includePivot: false })) {
          history.runGrouped('Transformar', () => {
            history.push({
              type: 'transform',
              os: [cur],
              before: [xyzBeforeObj],
              after: [afterState],
            });
            recordAutoKeyframeIfNeeded([cur], { beforeList: [xyzBeforeObj], afterList: [afterState] });
          });
        }
        xyzBeforeObj = afterState;
      }
      syncGizmoXyzPanel();
    });
  });

  dom.btnDockDuplicate?.addEventListener('click', duplicateSelected);
  dom.btnResetCam?.addEventListener('click', resetCamera);
  dom.btnUndo?.addEventListener('click', () => history.undo());
  dom.btnRedo?.addEventListener('click', () => history.redo());
  dom.btnToolbarDelete?.addEventListener('click', () => {
    if (edit.active) runEditDelete();
    else deleteSelected();
  });

  dom.gizmoStyleSelect?.addEventListener('change', (e) => setGizmoStyle(e.target.value));
  dom.btnSpace?.addEventListener('click', () => {
    const cur = viewport.gizmo ? viewport.gizmo.space : edit.editor.space;
    const next = cur === 'world' ? 'local' : 'world';
    if (viewport.gizmo) viewport.gizmo.setSpace(next);
    edit.editor.setSpace(next);
    syncGizmoSpaceUI(next);
  });

  dom.btnSnap?.addEventListener('click', () => {
    viewport.snapOn = !viewport.snapOn;
    if (viewport.gizmo) viewport.gizmo.setSnap(viewport.snapOn);
    edit.editor.setSnap(viewport.snapOn);
    dom.btnSnap.textContent = viewport.snapOn ? 'Snap: On' : 'Snap: Off';
    dom.btnSnap.classList.toggle('is-active', viewport.snapOn);
  });

  const toggleEditPivot = () => setEditPivotMode(!viewport.gizmo?.editPivot);
  dom.btnEditPivot?.addEventListener('click', toggleEditPivot);
  dom.btnInspectorEditPivot?.addEventListener('click', () => {
    toggleEditPivot();
    closeAllPopovers();
  });
}
