import { loadZipLoader } from '../../made3d.module.js';
import { dom } from '../dom.js';
import { viewport, sceneStore, cameraView, sculpt, edit, rig } from '../store.js';
import { history } from '../history.js';
import { enterCameraView, addSceneCamera } from '../cameraView.js';
import { setSculptMode, addClaySphere } from '../sculptController.js';
import { setEditMode } from '../editController.js';
import {
  addPrimitive,
  addText3D,
  addSceneLight,
  addTestRig,
} from '../sceneActions.js';
import { exportSceneFormat, handleModelFiles } from '../ioActions.js';
import {
  setTimelinePlaying,
  syncAnimationUI,
  drawTimelineCanvas,
} from '../animationController.js';
import { syncGizmoXyzPanel } from './gizmoPanel.js';
import { switchObjectSubtab } from './objectInspector.js';
import { syncAllRanges } from './rangeControls.js';

const POPOVER_IDS = ['menu-scene', 'menu-object', 'menu-mode', 'menu-settings', 'menu-outliner'];
const POPOVER_BTNS = {
  'menu-scene': () => dom.btnNavScene,
  'menu-object': () => dom.btnNavObject,
  'menu-mode': () => dom.btnNavMode,
  'menu-settings': () => dom.btnNavSettings,
  'menu-outliner': () => dom.btnNavOutliner,
};

const APP_MODE_LABELS = {
  pose: 'Pose',
  modelar: 'Modelar',
  edicion: 'Edición',
  esqueleto: 'Esqueleto',
  animacion: 'Animación',
};

export function closeAllPopovers() {
  viewport.openPopover = null;
  for (const id of POPOVER_IDS) {
    const panel = document.getElementById(id);
    if (panel) panel.hidden = true;
    const btn = POPOVER_BTNS[id]?.();
    if (btn) {
      btn.classList.remove('is-active');
      btn.setAttribute('aria-expanded', 'false');
    }
  }
  if (dom.popoverBackdrop) dom.popoverBackdrop.hidden = true;
}

export function openPopover(id, toggle = true) {
  const target = document.getElementById(id);
  if (!target) return;
  const alreadyOpen = !target.hidden;
  if (toggle && alreadyOpen) {
    closeAllPopovers();
    return;
  }
  closeAllPopovers();
  target.hidden = false;
  syncAllRanges(target);
  viewport.openPopover = id;
  const btn = POPOVER_BTNS[id]?.();
  if (btn) {
    btn.classList.add('is-active');
    btn.setAttribute('aria-expanded', 'true');
  }
  if (dom.popoverBackdrop) dom.popoverBackdrop.hidden = false;
}

export function switchTab(tabName) {
  if (tabName === 'object') openPopover('menu-object', false);
  else if (tabName === 'scene') openPopover('menu-scene', false);
  else if (tabName === 'env') openPopover('menu-settings', false);
}

export function syncViewCameraQuickBtn() {
  const activeMode = viewport.appMode || 'pose';
  const isCamSelected = Boolean(sceneStore.selected && sceneStore.selected.isCamera);
  const inCamView = Boolean(cameraView.activeSceneCam);
  const allowedMode = (activeMode === 'pose' || activeMode === 'animacion') && !sculpt.active && !edit.active && !rig.active;
  const show = allowedMode && isCamSelected && !inCamView;

  if (dom.btnViewCameraQuick) {
    dom.btnViewCameraQuick.hidden = !show;
    dom.btnViewCameraQuick.classList.toggle('is-pose', show && activeMode === 'pose');
    dom.btnViewCameraQuick.classList.toggle('is-anim', show && activeMode === 'animacion');
  }

  if (dom.viewportWrap) {
    dom.viewportWrap.classList.toggle('has-anim-cam-btn', show && activeMode === 'animacion');
    const xyzOpen = activeMode === 'pose' && Boolean(viewport.gizmoXyzOpen) && Boolean(dom.gizmoXyzPanel && !dom.gizmoXyzPanel.hidden);
    dom.viewportWrap.classList.toggle('has-xyz-open', xyzOpen);
  }
}

export function syncAppModeUI(mode = null) {
  const activeMode =
    mode ||
    (sculpt.active
      ? 'modelar'
      : edit.active
      ? 'edicion'
      : rig.active
      ? 'esqueleto'
      : viewport.appMode === 'animacion'
      ? 'animacion'
      : 'pose');

  const prevMode = viewport.appMode;
  viewport.appMode = activeMode;
  const isAnim = activeMode === 'animacion';

  if (prevMode === 'animacion' && !isAnim) {
    setTimelinePlaying(false);
  }

  if (dom.modeBtnLabel) {
    dom.modeBtnLabel.textContent = APP_MODE_LABELS[activeMode] || 'Pose';
  }
  document.querySelectorAll('#menu-mode [data-app-mode]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.appMode === activeMode);
  });

  if (dom.viewportWrap) {
    dom.viewportWrap.classList.toggle('is-anim-mode', isAnim);
  }
  if (dom.animTopLeft) dom.animTopLeft.hidden = !isAnim;
  if (dom.animTimeline) dom.animTimeline.hidden = !isAnim;
  if (dom.undoRedoBar) dom.undoRedoBar.classList.toggle('is-top-left', isAnim);

  if (!isAnim && dom.animManagerPopover) {
    dom.animManagerPopover.hidden = true;
    dom.btnAnimMenu?.classList.remove('is-active');
    dom.btnAnimMenu?.setAttribute('aria-expanded', 'false');
  }

  syncAnimationUI();
  syncGizmoXyzPanel();
  syncViewCameraQuickBtn();
  if (isAnim) {
    requestAnimationFrame(() => drawTimelineCanvas());
  }
}

export function bindPopoverNav() {
  document.querySelectorAll('[data-popover-target]').forEach((btn) => {
    btn.addEventListener('click', () => openPopover(btn.dataset.popoverTarget, true));
  });
  dom.popoverBackdrop?.addEventListener('click', closeAllPopovers);
  dom.btnCloseOutliner?.addEventListener('click', closeAllPopovers);

  // Menú Escena: Modelos / Malla (Primitivas / Agregar)
  document.querySelectorAll('[data-scene-sec]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sec = btn.dataset.sceneSec;
      document.querySelectorAll('[data-scene-sec]').forEach((b) => b.classList.toggle('is-active', b === btn));
      const secModelos = document.getElementById('scene-sec-modelos');
      const secMalla = document.getElementById('scene-sec-malla');
      if (secModelos) secModelos.hidden = sec !== 'modelos';
      if (secMalla) secMalla.hidden = sec !== 'malla';
    });
  });

  document.querySelectorAll('[data-malla-sub]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sub = btn.dataset.mallaSub;
      document.querySelectorAll('[data-malla-sub]').forEach((b) => b.classList.toggle('is-active', b === btn));
      const subPrim = document.getElementById('malla-sub-primitivas');
      const subAdd = document.getElementById('malla-sub-agregar');
      if (subPrim) subPrim.hidden = sub !== 'primitivas';
      if (subAdd) subAdd.hidden = sub !== 'agregar';
    });
  });

  dom.btnExportSubToggle?.addEventListener('click', () => {
    if (dom.exportSubmenu) dom.exportSubmenu.hidden = !dom.exportSubmenu.hidden;
  });

  // Subtabs Objeto & Ajustes
  document.querySelectorAll('[data-obj-sub]').forEach((btn) => {
    btn.addEventListener('click', () => switchObjectSubtab(btn.dataset.objSub));
  });

  document.querySelectorAll('[data-set-sub]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sub = btn.dataset.setSub;
      document.querySelectorAll('[data-set-sub]').forEach((b) => b.classList.toggle('is-active', b === btn));
      document.querySelectorAll('[data-set-panel]').forEach((p) => { p.hidden = p.dataset.setPanel !== sub; });
    });
  });

  // Selector de Modo: Pose / Modelar / Edición / Esqueleto / Animación
  document.querySelectorAll('#menu-mode [data-app-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.appMode;
      closeAllPopovers();
      if (mode === 'pose') {
        if (edit.active) setEditMode(false);
        if (sculpt.active) setSculptMode(false);
        if (rig.active) history._hooks.setRigMode?.(false);
        syncAppModeUI('pose');
      } else if (mode === 'animacion') {
        if (edit.active) setEditMode(false);
        if (sculpt.active) setSculptMode(false);
        if (rig.active) history._hooks.setRigMode?.(false);
        syncAppModeUI('animacion');
      } else if (mode === 'modelar') {
        setSculptMode(true);
      } else if (mode === 'edicion') {
        setEditMode(true);
      } else if (mode === 'esqueleto') {
        history._hooks.setRigMode?.(true);
      }
    });
  });

  // Botón rápido "ver cámara"
  dom.btnViewCameraQuick?.addEventListener('click', () => {
    const cam = sceneStore.selected;
    if (cam && cam.isCamera) {
      closeAllPopovers();
      enterCameraView(cam);
    }
  });

  // Importar & Drag-Drop
  dom.btnImportModel?.addEventListener('click', () => {
    closeAllPopovers();
    dom.fileInput?.click();
  });
  dom.fileInput?.addEventListener('change', (e) => {
    handleModelFiles(e.target.files);
    e.target.value = '';
  });

  let dragDepth = 0;
  dom.viewportWrap?.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    if (dom.dropOverlay) dom.dropOverlay.hidden = false;
  });
  dom.viewportWrap?.addEventListener('dragover', (e) => e.preventDefault());
  dom.viewportWrap?.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0 && dom.dropOverlay) dom.dropOverlay.hidden = true;
  });
  dom.viewportWrap?.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    if (dom.dropOverlay) dom.dropOverlay.hidden = true;
    const { ZipLoader } = await loadZipLoader();
    const files = await ZipLoader.fromDataTransfer(e.dataTransfer);
    handleModelFiles(files);
  });

  // Primitivas y Agregar
  document.querySelectorAll('.action-btn[data-add]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.add;
      closeAllPopovers();
      if (kind === 'dirLight') addSceneLight('directional', { recordHistory: true });
      else if (kind === 'pointLight') addSceneLight('point', { recordHistory: true });
      else if (kind === 'rig') addTestRig({ recordHistory: true });
      else if (kind === 'camera') addSceneCamera({ recordHistory: true });
      else if (kind === 'clay') addClaySphere({ recordHistory: true, enterSculpt: true });
      else if (kind === 'text') addText3D({ recordHistory: true });
      else addPrimitive(kind, { recordHistory: true });
    });
  });

  // Exportar con detección de animaciones
  dom.btnExportGlb?.addEventListener('click', () => { closeAllPopovers(); void exportSceneFormat('glb'); });
  dom.btnExportGltf?.addEventListener('click', () => { closeAllPopovers(); void exportSceneFormat('gltf'); });
  dom.btnExportObj?.addEventListener('click', () => { closeAllPopovers(); void exportSceneFormat('obj'); });
  dom.btnExportMtl?.addEventListener('click', () => { closeAllPopovers(); void exportSceneFormat('mtl'); });
}
