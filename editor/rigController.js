import { Rigger } from '../src/modules/rigging.js';
import { dom, setStatus } from './dom.js';
import {
  viewport,
  sceneStore,
  cameraView,
  sculpt,
  edit,
  rig,
  isInScene,
  findOwningUserRoot,
} from './store.js';
import { history } from './history.js';
import { exitCameraView } from './cameraView.js';
import { setSculptMode, syncSculptUI } from './sculptController.js';
import { setEditMode, syncEditUI } from './editController.js';
import { syncSelectedUI, syncAppModeUI, syncGizmoXyzPanel, renderObjectList } from './inspectorUI.js';
import { syncRangeVisual } from './ui/rangeControls.js';

let _bound = false;

export function getRigContext() {
  const sel = sceneStore.selected;
  let root = null;

  if (sel && isInScene(sel)) {
    if (sel.isBone) {
      let owningSkinned = null;
      viewport.scene?.traverse((n) => {
        if (!owningSkinned && n.isSkinnedMesh && n.skeleton?.bones?.includes(sel)) {
          owningSkinned = n;
        }
      });
      if (owningSkinned) {
        root = findOwningUserRoot(owningSkinned) || owningSkinned;
      } else {
        let p = sel.parent;
        while (p && p.isBone) p = p.parent;
        if (p && p !== viewport.scene) root = findOwningUserRoot(p) || p;
      }
    } else if (Rigger.isRigMesh(sel) || Rigger.collectMeshes(sel).length > 0) {
      root = findOwningUserRoot(sel) || sel;
    }
  }

  if (!root) {
    for (const uo of sceneStore.userObjects) {
      if (uo && isInScene(uo) && Rigger.collectMeshes(uo).length > 0) {
        root = uo;
        break;
      }
    }
  }

  return Rigger.collectContext(root, sel, isInScene);
}

function handleReplaceMeshInStore(oldObj, newObj) {
  const uIdx = sceneStore.userObjects.indexOf(oldObj);
  if (uIdx >= 0) sceneStore.userObjects[uIdx] = newObj;
  if (sceneStore.spinObjects.has(oldObj)) {
    sceneStore.spinObjects.delete(oldObj);
    sceneStore.spinObjects.add(newObj);
  }
}

export function ensureRigWeightPaintRestored() {
  rig.rigger.restoreWeightPaint(viewport.scene);
}

export function bindRigToMesh() {
  const ctx = getRigContext();
  const prevSelected = sceneStore.selected;
  const res = rig.rigger.bindRig(ctx, {
    scene: viewport.scene,
    gizmo: viewport.gizmo,
    picker: viewport.picker,
    mixer: sceneStore.mixer,
    onReplaceMesh: handleReplaceMeshInStore,
  });

  if (!res.ok) {
    setStatus(res.message, true);
    return false;
  }

  const nextSelected = res.primarySkinned || ctx.root;
  const replaceMap = res.replaceMap;

  if (sceneStore.selected && replaceMap.has(sceneStore.selected)) {
    sceneStore.selected = replaceMap.get(sceneStore.selected);
  } else if (!sceneStore.selected) {
    sceneStore.selected = nextSelected;
  }
  sceneStore.selectedList = sceneStore.selectedList.map((o) => replaceMap.get(o) || o);
  if (!sceneStore.selectedList.length && sceneStore.selected) {
    sceneStore.selectedList = [sceneStore.selected];
  }
  if (viewport.gizmo) {
    viewport.gizmo.attach(sceneStore.selectedList.length ? sceneStore.selectedList : sceneStore.selected);
    if (viewport.gizmo.mode === 'translate') {
      viewport.gizmo.setMode('rotate');
      document.querySelectorAll('.seg-btn[data-mode]').forEach((btn) => {
        btn.classList.toggle('is-active', btn.dataset.mode === 'rotate');
      });
    }
  }

  history.push({
    type: 'rigBind',
    label: 'Fijar esqueleto',
    undo: () => {
      const undoMap = res.undo();
      if (prevSelected && isInScene(prevSelected)) {
        sceneStore.selected = prevSelected;
        sceneStore.selectedList = [prevSelected];
      } else {
        sceneStore.selectedList = sceneStore.selectedList.map((o) => undoMap.get(o) || o).filter(isInScene);
        if (sceneStore.selected && undoMap.has(sceneStore.selected)) sceneStore.selected = undoMap.get(sceneStore.selected);
      }
      if (viewport.gizmo) {
        viewport.gizmo.attach(sceneStore.selectedList.length ? sceneStore.selectedList : sceneStore.selected);
      }
      syncRigUI();
    },
    redo: () => {
      res.redo();
      if (nextSelected && isInScene(nextSelected)) {
        sceneStore.selected = nextSelected;
        sceneStore.selectedList = [nextSelected];
      } else {
        sceneStore.selectedList = sceneStore.selectedList.map((o) => replaceMap.get(o) || o).filter(isInScene);
        if (sceneStore.selected && replaceMap.has(sceneStore.selected)) sceneStore.selected = replaceMap.get(sceneStore.selected);
      }
      if (viewport.gizmo) {
        viewport.gizmo.attach(sceneStore.selectedList.length ? sceneStore.selectedList : sceneStore.selected);
      }
      syncRigUI();
    },
  });

  syncSelectedUI();
  syncRigUI();
  syncGizmoXyzPanel();
  renderObjectList();
  setStatus(res.message);
  return true;
}

export function syncRigUI() {
  const active = Boolean(rig.active);
  const ed = rig.rigger;

  if (ed.activeTipBone && !isInScene(ed.activeTipBone)) {
    ed.activeTipBone = null;
    ed.activeTipAttach = 'tail';
  }
  if (ed.selectedBone && !isInScene(ed.selectedBone)) {
    ed.selectedBone = null;
  }

  const ctx = getRigContext();

  if (ed.weightPaint && !ctx.hasSkinnedWeights) {
    ed.setWeightPaint(false, ctx, viewport.scene);
  } else if (ed.weightPaint && ctx.hasSkinnedWeights) {
    ed.enterWeightPaint(ctx);
  }

  if (dom.rigToolBar) dom.rigToolBar.hidden = !active;
  if (dom.rigWeightsBar) dom.rigWeightsBar.hidden = !(active && ed.weightPaint);

  if (dom.btnRigBone) dom.btnRigBone.classList.toggle('is-active', active && ed.boneTool);
  if (dom.btnRigMirror) dom.btnRigMirror.classList.toggle('is-active', ed.mirror);
  if (dom.btnRigMagnet) dom.btnRigMagnet.classList.toggle('is-active', ed.magnet);
  if (dom.btnRigBind) dom.btnRigBind.disabled = !ctx.mesh || ctx.allBones.length === 0;
  if (dom.btnRigWeights) {
    dom.btnRigWeights.disabled = !ctx.hasSkinnedWeights;
    dom.btnRigWeights.classList.toggle('is-active', active && ed.weightPaint);
  }
  if (dom.btnRigEraser) dom.btnRigEraser.classList.toggle('is-active', ed.eraser);

  if (dom.rigBrushSize) {
    dom.rigBrushSize.value = String(ed.brushSize);
    syncRangeVisual(dom.rigBrushSize);
  }
  if (dom.rigBrushSizeVal) {
    dom.rigBrushSizeVal.textContent = ed.brushSize.toFixed(2);
  }

  const interactiveOverlay = active && (ed.boneTool || ed.weightPaint);
  if (dom.rigOverlay) {
    dom.rigOverlay.hidden = !active;
    if (!active) {
      const c = dom.rigOverlay.getContext('2d');
      if (c) c.clearRect(0, 0, dom.rigOverlay.width, dom.rigOverlay.height);
    }
  }
  if (viewport.gizmo) {
    const showGizmo = !active
      ? !sculpt.active && !edit.active && !(cameraView.activeSceneCam && sceneStore.selected === cameraView.activeSceneCam)
      : !interactiveOverlay;
    viewport.gizmo.enabled = showGizmo;
    viewport.gizmo.visible = showGizmo;
  }
  dom.viewportWrap?.classList.toggle('is-sculpt-cursor', active && ed.weightPaint);
}

export function setRigMode(enabled) {
  const next = Boolean(enabled);
  const wasActive = rig.active;

  if (next && cameraView.activeSceneCam) exitCameraView();
  if (next && edit.active) setEditMode(false);
  if (next && sculpt.active) setSculptMode(false);
  if (viewport.gizmo?.drag) {
    viewport.gizmo.cancel();
    if (dom.gizmoReadout) dom.gizmoReadout.hidden = true;
  }

  if (next) {
    const ctx = getRigContext();
    if (ctx.root && (!sceneStore.selected || !isInScene(sceneStore.selected))) {
      sceneStore.selected = ctx.mesh || ctx.root;
      sceneStore.selectedList = [sceneStore.selected];
      if (viewport.gizmo) viewport.gizmo.attach(sceneStore.selected);
      renderObjectList();
      syncSelectedUI();
    }
  }

  rig.active = next;
  rig.rigger.setEnabled(next);

  if (viewport.controls) {
    viewport.controls.enabled = !(cameraView.activeSceneCam && cameraView.camViewLocked);
  }

  const nextMode = next
    ? 'esqueleto'
    : edit.active
    ? 'edicion'
    : sculpt.active
    ? 'modelar'
    : !wasActive && viewport.appMode === 'animacion'
    ? 'animacion'
    : 'pose';

  syncAppModeUI(nextMode);
  syncRigUI();
  syncGizmoXyzPanel();
}

export function renderRigOverlay(camera) {
  rig.rigger.drawAttachedOverlay(camera);
}

export function bindRigControls() {
  if (_bound) return;
  _bound = true;

  const ed = rig.rigger;

  ed.attach({
    domElement: dom.viewportWrap,
    pointerDownTarget: () => dom.canvas,
    referenceElement: dom.viewportWrap,
    overlay: dom.rigOverlay,
    getCamera: () => (cameraView.activeSceneCam ? (cameraView.viewCam || cameraView.activeSceneCam) : viewport.camera),
    getControls: () => viewport.controls,
    getControlsEnabled: () => !(cameraView.activeSceneCam && cameraView.camViewLocked),
    getScene: () => viewport.scene,
    getGizmo: () => viewport.gizmo,
    getPicker: () => viewport.picker,
    getMixer: () => sceneStore.mixer,
    getContext: getRigContext,
    isNodeAlive: isInScene,
    onHistoryCommand: (cmd) => history.push(cmd),
    onStatus: (msg, warn) => setStatus(msg, warn),
    onStateChange: syncRigUI,
  });

  dom.btnRigBone?.addEventListener('click', () => {
    const next = ed.setBoneTool(!ed.boneTool, viewport.scene);
    setStatus(next ? 'Hueso activo: toca sobre la malla o una punta para crear huesos.' : 'Hueso desactivado.');
    syncRigUI();
  });

  dom.btnRigMirror?.addEventListener('click', () => {
    const on = ed.setMirror(!ed.mirror);
    setStatus(on ? 'Espejo activado: clonará los huesos en ambos lados.' : 'Espejo desactivado.');
    syncRigUI();
  });

  dom.btnRigMagnet?.addEventListener('click', () => {
    const on = ed.setMagnet(!ed.magnet);
    setStatus(on ? 'Imán activado: centrará los huesos dentro de la malla.' : 'Imán desactivado.');
    syncRigUI();
  });

  dom.btnRigBind?.addEventListener('click', () => {
    bindRigToMesh();
  });

  dom.btnRigWeights?.addEventListener('click', () => {
    const ctx = getRigContext();
    const res = ed.setWeightPaint(!ed.weightPaint, ctx, viewport.scene);
    setStatus(res.message, !res.ok);
    syncRigUI();
  });

  dom.rigBrushSize?.addEventListener('input', (e) => {
    const v = ed.setBrushSize(e.target.value);
    if (dom.rigBrushSizeVal) dom.rigBrushSizeVal.textContent = v.toFixed(2);
  });

  dom.btnRigEraser?.addEventListener('click', () => {
    const on = ed.setEraser(!ed.eraser);
    setStatus(on ? 'Borrador de pesos activado.' : 'Borrador de pesos desactivado (modo pintar).');
    syncRigUI();
  });
}
