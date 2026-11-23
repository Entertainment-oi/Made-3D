import {
  Renderer,
  Fog,
  Texture,
  SHADOW_RESOLUTIONS,
  SHADOW_QUALITY,
  Vec3,
  Quat,
  Color,
  RAD2DEG,
  DEG2RAD,
  loadGLTFExporter,
  loadOBJExporter,
  loadZipLoader,
  loadTextGeometry,
  loadVideoRecorder,
} from '../made3d.module.js';
import { applyMaterialType } from '../src/modules/stylized.js';
import { SCULPT_SYMMETRIES, SCULPT_FALLOFFS } from '../src/modules/sculpt.js';
import { snapshotMeshModelingState } from '../src/modules/modeling.js';
import { dom, setStatus, downloadBlob, bindDoubleTap } from './dom.js';
import {
  viewport,
  sceneStore,
  lighting,
  cameraView,
  recorder,
  sculpt,
  edit,
  getCameraMeta,
  setCameraMeta,
  isDescendantOrSelf,
  snapshotLocal,
} from './store.js';
import { history } from './history.js';
import {
  resizeRenderer,
  syncShadowResolutionUI,
  selectObject,
  resetCamera,
  focusOnObject,
  setGizmoStyle,
  setGizmoMode,
  setEditPivotMode,
  syncGizmoSpaceUI,
  switchRenderBackend,
} from './viewport.js';
import {
  getCameraResolution,
  addSceneCamera,
  updateViewfinderOverlay,
  updateSceneCameraProps,
  setCamViewLocked,
  enterCameraView,
  exitCameraView,
  renderCameraSnapshot,
  startCameraVideo,
  stopCameraVideo,
} from './cameraView.js';
import {
  syncSculptUI,
  setSculptMode,
  addClaySphere,
  subdivideSelectedMesh,
  applyClayMaterialToSelected,
  getSculptTargets,
} from './sculptController.js';
import {
  getEditablePrimaryMesh,
  syncSubsurfUI,
  syncEditUI,
  setEditMode,
  closeEditFlyouts,
  toggleEditFlyout,
  toggleEditCutTool,
  setEditCutMode,
  setSelectedSubsurfOptions,
  stepSelectedSubsurf,
  applySelectedSubsurf,
  runEditExtrude,
  runEditSubdivide,
  runEditDelete,
  toggleEditMultiSelect,
  toggleEditBoxSelect,
  runEditBevel,
  runEditBridgeFill,
  runEditMerge,
  runEditCrease,
  getSelectedMergeTargetMeshes,
} from './editController.js';
import {
  proceduralTexture,
  clearUserObjects,
  duplicateSelected,
  deleteSelected,
  mergeSelectedObjects,
  addPrimitive,
  addText3D,
  addSceneLight,
  addTestRig,
  playAnimationClip,
  buildExportTarget,
  handleModelFiles,
  applyEnvironmentPreset,
  loadEnvironmentFile,
} from './sceneActions.js';

const forEachMat = (fn) => sceneStore.selected?.collectMaterials?.().forEach(fn);

let _videoFormatsPopulated = false;
function ensureVideoFormatsPopulated() {
  if (_videoFormatsPopulated || !dom.sceneCamVideoFormat) return;
  _videoFormatsPopulated = true;
  loadVideoRecorder()
    .then(({ getSupportedVideoFormats }) => {
      if (!dom.sceneCamVideoFormat) return;
      const prev = dom.sceneCamVideoFormat.value || 'auto';
      const vfSupport = getSupportedVideoFormats();
      const hasMp4 = vfSupport.webcodecs || vfSupport.formats.some((m) => m.includes('mp4'));
      const hasWebm = vfSupport.webcodecs || vfSupport.formats.some((m) => m.includes('webm'));
      dom.sceneCamVideoFormat.innerHTML = '';
      const opts = [
        { value: 'auto', label: 'Automático (MP4/WebM)', disabled: !vfSupport.supported },
        { value: 'mp4', label: hasMp4 ? 'MP4 (H.264)' : 'MP4 (no soportado)', disabled: !hasMp4 },
        { value: 'webm', label: hasWebm ? 'WebM (VP8/VP9)' : 'WebM (no soportado)', disabled: !hasWebm },
      ];
      opts.forEach((item) => {
        const opt = document.createElement('option');
        opt.value = item.value;
        opt.textContent = item.label;
        opt.disabled = item.disabled;
        if (item.value === prev && !item.disabled) opt.selected = true;
        dom.sceneCamVideoFormat.appendChild(opt);
      });
    })
    .catch(() => {
      _videoFormatsPopulated = false;
    });
}

let _CachedTextGeometry = null;
async function ensureTextGeometryCtor() {
  if (!_CachedTextGeometry) {
    const mod = await loadTextGeometry();
    _CachedTextGeometry = mod.TextGeometry;
  }
  return _CachedTextGeometry;
}

// ============================================================
// GESTIÓN DE POPOVERS SUPERIORES Y DRAWER OUTLINER
// ============================================================
const POPOVER_IDS = ['menu-scene', 'menu-object', 'menu-mode', 'menu-settings', 'menu-outliner'];
const POPOVER_BTNS = {
  'menu-scene': () => dom.btnNavScene,
  'menu-object': () => dom.btnNavObject,
  'menu-mode': () => dom.btnNavMode,
  'menu-settings': () => dom.btnNavSettings,
  'menu-outliner': () => dom.btnNavOutliner,
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

// ============================================================
// MODO DE TRABAJO: POSE | MODELAR | EDICIÓN
// ============================================================
const APP_MODE_LABELS = { pose: 'Pose', modelar: 'Modelar', edicion: 'Edición' };

export function syncAppModeUI(mode = null) {
  const activeMode = mode || (sculpt.active ? 'modelar' : edit.active ? 'edicion' : 'pose');
  viewport.appMode = activeMode;
  if (dom.modeBtnLabel) {
    dom.modeBtnLabel.textContent = APP_MODE_LABELS[activeMode] || 'Pose';
  }
  document.querySelectorAll('#menu-mode [data-app-mode]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.appMode === activeMode);
  });
}

// ============================================================
// MINI-PANEL XYZ SOBRE EL DOCK (DOBLE CLIC EN MOVER/ROTAR/ESCALAR)
// ============================================================

export function syncGizmoXyzPanel() {
  if (!dom.gizmoXyzPanel) return;
  const mode = edit.active ? edit.editor.transformMode : (viewport.gizmo?.mode || 'select');
  const activeTransform = mode === 'translate' || mode === 'rotate' || mode === 'scale';
  if (!viewport.gizmoXyzOpen || !activeTransform || sculpt.active) {
    dom.gizmoXyzPanel.hidden = true;
    return;
  }

  const titles = { translate: 'Mover', rotate: 'Rotar', scale: 'Escalar' };
  if (dom.gizmoXyzTitle) dom.gizmoXyzTitle.textContent = titles[mode] || 'Transformar';
  dom.gizmoXyzPanel.hidden = false;

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

// ============================================================
// SUBMENÚS DE OBJETO Y SINCRONIZACIÓN DE SELECCIÓN
// ============================================================
let _activeObjSub = 'material';

export function switchObjectSubtab(subName) {
  _activeObjSub = subName;
  document.querySelectorAll('#object-subtabs [data-obj-sub]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.objSub === subName);
  });
  document.querySelectorAll('#menu-object [data-obj-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.objPanel !== subName;
  });
}

function syncLightInspectorControls(light) {
  if (!light || !dom.lightObjGroup) return;
  if (dom.selLightColor && light.color) dom.selLightColor.value = light.color.getStyle();
  if (dom.selLightIntensity) {
    dom.selLightIntensity.value = String(light.intensity ?? 1);
    if (dom.selLightIntensityVal) dom.selLightIntensityVal.textContent = (light.intensity ?? 1).toFixed(1);
  }
  const isPoint = Boolean(light.isPointLight);
  const isDir = Boolean(light.isDirectionalLight);
  if (dom.selLightPointFields) dom.selLightPointFields.hidden = !isPoint;
  if (dom.selLightDirFields) dom.selLightDirFields.hidden = !isDir;
  if (isPoint) {
    const dist = light.distance ?? 0;
    const decay = light.decay ?? 2;
    if (dom.selLightDistance) dom.selLightDistance.value = String(dist);
    if (dom.selLightDistanceVal) dom.selLightDistanceVal.textContent = dist > 0 ? dist.toFixed(1) : '∞ (3.5)';
    if (dom.selLightDecay) dom.selLightDecay.value = String(decay);
    if (dom.selLightDecayVal) dom.selLightDecayVal.textContent = decay.toFixed(1);
  }
  if (isDir) {
    if (dom.selLightShadows) dom.selLightShadows.checked = Boolean(light.castShadow);
    const soft = light.shadow?.radius ?? 1.25;
    if (dom.selLightShadowSoft) {
      dom.selLightShadowSoft.value = String(soft);
      dom.selLightShadowSoft.disabled = !light.castShadow;
    }
    if (dom.selLightShadowSoftVal) dom.selLightShadowSoftVal.textContent = soft.toFixed(2);
  }
}

export function syncSelectedUI() {
  const o = sceneStore.selected;
  const multiCount = sceneStore.selectedList.length;
  const hasSelection = Boolean(o);
  const isBone = Boolean(o && o.isBone);
  const isCam = Boolean(o && o.isCamera);
  const isLight = Boolean(o && o.isLight);
  const canDup = hasSelection && !isBone && !o.isInstancedMesh;

  if (dom.btnToolbarDelete) dom.btnToolbarDelete.disabled = !hasSelection;
  if (dom.btnDockDuplicate) dom.btnDockDuplicate.disabled = !canDup;
  if (dom.btnDeleteObj) dom.btnDeleteObj.disabled = !hasSelection;
  if (dom.btnDuplicateObj) dom.btnDuplicateObj.disabled = !canDup;
  if (dom.btnFocusObj) dom.btnFocusObj.disabled = !hasSelection;

  if (!o) {
    if (dom.objectEmpty) dom.objectEmpty.hidden = false;
    if (dom.objectEditor) dom.objectEditor.hidden = true;
    return;
  }

  if (dom.objectEmpty) dom.objectEmpty.hidden = true;
  if (dom.objectEditor) dom.objectEditor.hidden = false;
  if (dom.selectedName) {
    dom.selectedName.textContent =
      multiCount > 1 ? `${o.name || 'Objeto'} (+${multiCount - 1})` : o.name || `Objeto #${o.id}`;
  }
  if (dom.selectedType) {
    dom.selectedType.textContent = isBone
      ? 'Hueso (Bone)'
      : isCam
      ? 'Cámara'
      : o.isPointLight
      ? 'Luz puntual'
      : o.isDirectionalLight
      ? 'Luz direccional'
      : o.isSkinnedMesh
      ? 'SkinnedMesh'
      : o.geometry?.isTextGeometry
      ? 'Texto 3D'
      : o.isMesh
      ? 'Malla'
      : 'Objeto 3D';
  }

  const mat = !isCam && !isLight ? o.getPrimaryMaterial?.() : null;
  const isTextMesh = Boolean(o.isMesh && o.geometry?.isTextGeometry);
  const hasSubsurf = Boolean(!isCam && !isLight && o.isMesh);

  const tabMat = document.getElementById('tab-btn-obj-material');
  const tabSub = document.getElementById('tab-btn-obj-subsurf');
  const tabTxt = document.getElementById('tab-btn-obj-text');
  const tabCam = document.getElementById('tab-btn-obj-camera');
  const tabLight = document.getElementById('tab-btn-obj-light');
  const tabPiv = document.getElementById('tab-btn-obj-pivot');

  if (tabMat) tabMat.hidden = !mat;
  if (tabSub) tabSub.hidden = !hasSubsurf;
  if (tabTxt) tabTxt.hidden = !isTextMesh;
  if (tabCam) tabCam.hidden = !isCam;
  if (tabLight) tabLight.hidden = !isLight;
  if (tabPiv) tabPiv.hidden = isBone;

  // Elegir subpestaña válida automáticamente según el tipo de objeto
  const validSubs = [];
  if (mat) validSubs.push('material');
  if (hasSubsurf) validSubs.push('subsurf');
  if (isTextMesh) validSubs.push('text');
  if (isCam) validSubs.push('camera');
  if (isLight) validSubs.push('light');
  if (!isBone) validSubs.push('pivot');

  if (!validSubs.includes(_activeObjSub)) {
    switchObjectSubtab(validSubs[0] || 'pivot');
  } else {
    switchObjectSubtab(_activeObjSub);
  }

  syncSubsurfUI();
  syncGizmoXyzPanel();

  if (isLight) {
    syncLightInspectorControls(o);
    return;
  }

  if (isCam) {
    ensureVideoFormatsPopulated();
    const isActiveCam = cameraView.activeSceneCam === o;
    dom.btnCamEnter.textContent = isActiveCam ? 'Salir vista cámara' : 'Entrar a cámara';
    dom.btnCamEnter.classList.toggle('is-active', isActiveCam);
    if (dom.btnCamAlign) dom.btnCamAlign.disabled = isActiveCam;
    const fov = Math.round(o.fov || 50);
    dom.sceneCamFov.value = fov;
    dom.sceneCamFovVal.textContent = `${fov}°`;

    const { w, h } = getCameraResolution(o);
    dom.sceneCamWidth.value = w;
    dom.sceneCamHeight.value = h;
    const presetKey = `${w}x${h}`;
    const hasPreset = [...dom.sceneCamPreset.options].some((opt) => opt.value === presetKey);
    dom.sceneCamPreset.value = hasPreset ? presetKey : 'custom';

    const meta = getCameraMeta(o);
    dom.sceneCamThirds.checked = meta.showThirds !== false;
    dom.sceneCamIncludeGrid.checked = Boolean(meta.includeGrid);
    dom.sceneCamLock.checked = cameraView.camViewLocked;
    return;
  }

  if (isTextMesh) {
    void ensureTextGeometryCtor();
    const opts = o.geometry.textOptions || {};
    if (dom.textContent && document.activeElement !== dom.textContent) {
      dom.textContent.value = opts.text ?? '';
    }
    if (dom.textFont) {
      const ff = opts.fontFamily || 'Plus Jakarta Sans, system-ui, -apple-system, sans-serif';
      const hasOpt = [...dom.textFont.options].some((opt) => opt.value === ff);
      dom.textFont.value = hasOpt ? ff : dom.textFont.options[0].value;
    }
    if (dom.textBold) {
      dom.textBold.checked = opts.fontWeight === '700' || opts.fontWeight === 'bold' || Number(opts.fontWeight) >= 600;
    }
    if (dom.textItalic) dom.textItalic.checked = opts.fontStyle === 'italic';
    if (dom.textAlign) dom.textAlign.value = opts.align || 'center';
    if (dom.textSize) {
      const sz = Number(opts.size ?? 0.72);
      dom.textSize.value = sz;
      if (dom.textSizeVal) dom.textSizeVal.textContent = sz.toFixed(2);
    }
    if (dom.textDepth) {
      const dp = Number(opts.depth ?? 0.18);
      dom.textDepth.value = dp;
      if (dom.textDepthVal) dom.textDepthVal.textContent = dp.toFixed(2);
    }
    if (dom.textSpacing) {
      const sp = Number(opts.letterSpacing ?? 0);
      dom.textSpacing.value = sp;
      if (dom.textSpacingVal) dom.textSpacingVal.textContent = sp.toFixed(2);
    }
  }

  if (mat) {
    const shaderType = mat.type || 'standard';
    dom.matShaderType.value = [...dom.matShaderType.options].some((opt) => opt.value === shaderType)
      ? shaderType
      : 'standard';
    if (mat.color) dom.matColor.value = mat.color.getStyle();

    const isStandard = shaderType === 'standard';
    const hasPbr = isStandard && Boolean(mat.hasPbr);
    const showShininess = (isStandard && !hasPbr) || shaderType === 'toon' || shaderType === 'dissolve';
    dom.rowMatShininess.hidden = !showShininess;
    const displayShininess = typeof mat.getShininess === 'function' ? mat.getShininess() : (mat.shininess ?? 0);
    dom.matShininess.value = displayShininess;
    dom.matShininessVal.textContent = String(Math.round(displayShininess));

    if (dom.matPbrBlock) dom.matPbrBlock.hidden = !isStandard;
    if (isStandard) {
      if (dom.matPbr) dom.matPbr.checked = hasPbr;
      if (dom.matPbrControls) dom.matPbrControls.hidden = !hasPbr;
      const rVal = mat.roughness ?? 1;
      const mVal = mat.metalness ?? 0;
      const nVal = mat.normalScale?.x ?? 1;
      const aoVal = mat.aoMapIntensity ?? 1;
      const envVal = mat.envMapIntensity ?? 1;
      if (dom.matRoughness) dom.matRoughness.value = rVal;
      if (dom.matRoughnessVal) dom.matRoughnessVal.textContent = rVal.toFixed(2);
      if (dom.matMetalness) dom.matMetalness.value = mVal;
      if (dom.matMetalnessVal) dom.matMetalnessVal.textContent = mVal.toFixed(2);
      if (dom.matNormalScale) dom.matNormalScale.value = nVal;
      if (dom.matNormalScaleVal) dom.matNormalScaleVal.textContent = nVal.toFixed(2);
      if (dom.matAoIntensity) dom.matAoIntensity.value = aoVal;
      if (dom.matAoIntensityVal) dom.matAoIntensityVal.textContent = aoVal.toFixed(2);
      if (dom.matEnvIntensity) dom.matEnvIntensity.value = envVal;
      if (dom.matEnvIntensityVal) dom.matEnvIntensityVal.textContent = envVal.toFixed(2);

      const slots = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap'];
      for (const slot of slots) {
        const chip = document.querySelector(`[data-mat-map="${slot}"]`);
        const stateEl = document.querySelector(`[data-map-state="${slot}"]`);
        const clearBtn = document.querySelector(`[data-mat-map-clear="${slot}"]`);
        const directTex = mat[slot];
        const packedOrm = !directTex && (slot === 'roughnessMap' || slot === 'metalnessMap') ? mat.metallicRoughnessMap : null;
        const active = Boolean(directTex || packedOrm);
        if (chip) chip.classList.toggle('has-map', active);
        if (stateEl) stateEl.textContent = directTex ? 'OK' : packedOrm ? 'ORM' : '—';
        if (clearBtn) clearBtn.hidden = !directTex;
      }
    }

    dom.matOpacity.value = mat.opacity ?? 1;
    dom.matOpacityVal.textContent = (mat.opacity ?? 1).toFixed(2);
    dom.matTexture.checked = Boolean(mat.map);
    dom.matWireframe.checked = Boolean(mat.wireframe);

    const groups = dom.shaderParams.querySelectorAll('.shader-param-group');
    let hasGroup = false;
    groups.forEach((g) => {
      const active = g.dataset.shaderGroup === shaderType;
      g.hidden = !active;
      if (active) hasGroup = true;
    });
    dom.shaderParams.hidden = !hasGroup;

    if (shaderType === 'toon') {
      dom.matToonSteps.value = mat.steps ?? 3;
      dom.matToonStepsVal.textContent = String(Math.round(mat.steps ?? 3));
      dom.matToonInk.value = mat.inkWidth ?? 0.22;
      dom.matToonInkVal.textContent = (mat.inkWidth ?? 0.22).toFixed(2);
      dom.matToonRim.value = mat.rimStrength ?? 0.7;
      dom.matToonRimVal.textContent = (mat.rimStrength ?? 0.7).toFixed(2);
      if (mat.shadowColor) dom.matToonShadow.value = mat.shadowColor.getStyle();
    } else if (shaderType === 'hologram') {
      dom.matHoloDensity.value = mat.scanlineDensity ?? 18;
      dom.matHoloDensityVal.textContent = String(Math.round(mat.scanlineDensity ?? 18));
      dom.matHoloGlitch.value = mat.glitchStrength ?? 0.35;
      dom.matHoloGlitchVal.textContent = (mat.glitchStrength ?? 0.35).toFixed(2);
    } else if (shaderType === 'matcap') {
      dom.matMatcapGloss.value = mat.glossiness ?? 0.55;
      dom.matMatcapGlossVal.textContent = (mat.glossiness ?? 0.55).toFixed(2);
      dom.matMatcapMetal.value = mat.metalness ?? 0.25;
      dom.matMatcapMetalVal.textContent = (mat.metalness ?? 0.25).toFixed(2);
    } else if (shaderType === 'fresnel') {
      dom.matFresnelIntensity.value = mat.fresnelIntensity ?? 1.6;
      dom.matFresnelIntensityVal.textContent = (mat.fresnelIntensity ?? 1.6).toFixed(2);
      dom.matFresnelIrid.value = mat.iridescence ?? 0.55;
      dom.matFresnelIridVal.textContent = (mat.iridescence ?? 0.55).toFixed(2);
      if (mat.rimColor) dom.matFresnelRim.value = mat.rimColor.getStyle();
    } else if (shaderType === 'dissolve') {
      const autoAnim = mat.autoAnimate !== false;
      dom.matDissolveAuto.checked = autoAnim;
      dom.rowDissolveProgress.hidden = autoAnim;
      dom.matDissolveProgress.value = mat.progress ?? 0.35;
      dom.matDissolveProgressVal.textContent = (mat.progress ?? 0.35).toFixed(2);
      if (mat.edgeColor) dom.matDissolveEdge.value = mat.edgeColor.getStyle();
    }
  }

  let castShadow = Boolean(o.castShadow);
  if (!o.isMesh && o.collectMeshes) {
    for (const part of o.collectMeshes()) {
      if (part.castShadow) {
        castShadow = true;
        break;
      }
    }
  }
  if (dom.objCastShadow) dom.objCastShadow.checked = castShadow;
  if (dom.objAutoSpin) dom.objAutoSpin.checked = sceneStore.spinObjects.has(o);
}

// ============================================================
// OUTLINER (☰) CON RENOMBRAR, OCULTAR/MOSTRAR Y ELIMINAR
// ============================================================
function makeEyeSvg(visible) {
  return visible
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-11-7-11-7a21.77 21.77 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 7 11 7a21.8 21.8 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
}

const PENCIL_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`;
const TRASH_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>`;

function startInlineRename(obj, nameSpan) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'object-rename-input';
  input.value = obj.name || `Objeto #${obj.id}`;
  nameSpan.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const commit = (save) => {
    if (done) return;
    done = true;
    if (save) {
      const next = input.value.trim();
      if (next) obj.name = next;
    }
    syncSelectedUI();
    renderObjectList();
  };
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  });
  input.addEventListener('blur', () => commit(true));
}

export function renderObjectList() {
  if (!dom.objectList) return;
  dom.objectList.innerHTML = '';
  if (!sceneStore.userObjects.length) {
    const li = document.createElement('li');
    li.className = 'helper-text';
    li.textContent = 'No hay objetos en la escena.';
    dom.objectList.appendChild(li);
    return;
  }

  const isMulti = sceneStore.selectedList.length > 1 || Boolean(viewport.gizmo?.multiSelectMode);

  for (const obj of sceneStore.userObjects) {
    const isSel = obj === sceneStore.selected || sceneStore.selectedList.includes(obj);
    const li = document.createElement('li');
    li.className =
      'object-item' +
      (isSel ? (isMulti ? ' is-multi' : ' is-selected') : '') +
      (!obj.visible ? ' is-hidden-obj' : '');

    const mainBtn = document.createElement('div');
    mainBtn.className = 'object-item-main';

    const dot = document.createElement('span');
    dot.className =
      'object-item-dot' +
      (obj.isLight ? ' is-light' : obj.isCamera ? ' is-camera' : '');

    const nameSpan = document.createElement('span');
    nameSpan.className = 'object-item-name';
    nameSpan.textContent = obj.name || `Objeto #${obj.id}`;

    mainBtn.append(dot, nameSpan);
    mainBtn.addEventListener('click', () => selectObject(obj));

    const meta = document.createElement('span');
    meta.className = 'object-item-meta';

    if (obj.isCamera) {
      const jumpBtn = document.createElement('button');
      jumpBtn.type = 'button';
      const isViewing = cameraView.activeSceneCam === obj;
      jumpBtn.className = 'cam-jump-btn' + (isViewing ? ' is-active' : '');
      jumpBtn.textContent = isViewing ? 'Activa' : 'Ver';
      jumpBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (cameraView.activeSceneCam === obj) exitCameraView();
        else {
          selectObject(obj);
          enterCameraView(obj);
          closeAllPopovers();
        }
      });
      meta.appendChild(jumpBtn);
    }

    const eyeBtn = document.createElement('button');
    eyeBtn.type = 'button';
    eyeBtn.className = 'outliner-icon-btn';
    eyeBtn.title = obj.visible ? 'Ocultar' : 'Mostrar';
    eyeBtn.innerHTML = makeEyeSvg(obj.visible !== false);
    eyeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      obj.visible = !obj.visible;
      renderObjectList();
    });

    const renameBtn = document.createElement('button');
    renameBtn.type = 'button';
    renameBtn.className = 'outliner-icon-btn';
    renameBtn.title = 'Renombrar';
    renameBtn.innerHTML = PENCIL_SVG;
    renameBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      startInlineRename(obj, nameSpan);
    });

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'outliner-icon-btn is-danger';
    delBtn.title = 'Eliminar';
    delBtn.innerHTML = TRASH_SVG;
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteSelected(obj);
    });

    meta.append(eyeBtn, renameBtn, delBtn);
    li.append(mainBtn, meta);
    dom.objectList.appendChild(li);

    const parts = obj.collectMeshes ? obj.collectMeshes() : [];
    for (const part of parts) {
      const pli = document.createElement('li');
      pli.className =
        'object-item is-child' +
        (part === sceneStore.selected ? ' is-selected' : '') +
        (!part.visible ? ' is-hidden-obj' : '');
      const pName = document.createElement('span');
      pName.className = 'object-item-name';
      pName.textContent = '↳ ' + (part.name || `Parte #${part.id}`);
      const pEye = document.createElement('button');
      pEye.type = 'button';
      pEye.className = 'outliner-icon-btn';
      pEye.innerHTML = makeEyeSvg(part.visible !== false);
      pEye.addEventListener('click', (e) => {
        e.stopPropagation();
        part.visible = !part.visible;
        renderObjectList();
      });
      pli.append(pName, pEye);
      pli.addEventListener('click', () => selectObject(part));
      dom.objectList.appendChild(pli);
    }

    if (sceneStore.selected && sceneStore.selected.isBone && isDescendantOrSelf(sceneStore.selected, obj)) {
      const bli = document.createElement('li');
      bli.className = 'object-item is-child is-selected';
      const bName = document.createElement('span');
      bName.className = 'object-item-name';
      bName.textContent = '↳ ' + (sceneStore.selected.name || `Hueso #${sceneStore.selected.id}`);
      bli.append(bName);
      dom.objectList.appendChild(bli);
    }
  }
}

// ============================================================
// ENLACE DE TODA LA INTERFAZ
// ============================================================
export function bindUI() {
  const SCULPT_FALLOFF_LABELS = { smooth: 'Suave', sphere: 'Esférica', tip: 'Punta fina' };
  const SCULPT_SYMMETRY_LABELS = { none: 'Ninguna', x: 'Eje X', y: 'Eje Y', z: 'Eje Z' };

  if (dom.sculptFalloff) {
    dom.sculptFalloff.innerHTML = '';
    SCULPT_FALLOFFS.forEach((falloff) => {
      const opt = document.createElement('option');
      opt.value = falloff;
      opt.textContent = SCULPT_FALLOFF_LABELS[falloff] || falloff;
      opt.selected = falloff === sculpt.sculptor.falloff;
      dom.sculptFalloff.appendChild(opt);
    });
  }

  if (dom.sculptSymmetry) {
    dom.sculptSymmetry.innerHTML = '';
    SCULPT_SYMMETRIES.forEach((sym) => {
      const opt = document.createElement('option');
      opt.value = sym;
      opt.textContent = SCULPT_SYMMETRY_LABELS[sym] || sym;
      opt.selected = sym === sculpt.sculptor.symmetry;
      dom.sculptSymmetry.appendChild(opt);
    });
  }

  if (dom.dirShadowRes) {
    const qualityTags = {};
    const qualityLabels = { low: 'Baja', medium: 'Media', high: 'Alta', ultra: 'Ultra' };
    for (const [k, sz] of Object.entries(SHADOW_QUALITY)) {
      if (!qualityTags[sz]) qualityTags[sz] = qualityLabels[k] || k;
    }
    dom.dirShadowRes.innerHTML = '';
    const autoOpt = document.createElement('option');
    autoOpt.value = 'auto';
    autoOpt.textContent = 'Automática';
    autoOpt.selected = true;
    dom.dirShadowRes.appendChild(autoOpt);
    SHADOW_RESOLUTIONS.forEach((res) => {
      const opt = document.createElement('option');
      opt.value = String(res);
      const tag = res === 256 ? 'Mínima' : (qualityTags[res] || '');
      opt.textContent = tag ? `${res} px (${tag})` : `${res} px`;
      dom.dirShadowRes.appendChild(opt);
    });
  }

  if (dom.sceneCamVideoFormat) {
    dom.sceneCamVideoFormat.addEventListener('pointerdown', ensureVideoFormatsPopulated);
    dom.sceneCamVideoFormat.addEventListener('focus', ensureVideoFormatsPopulated);
  }

  if (dom.renderBackend) {
    const webgpuOk = Renderer.isWebGPUSupported();
    const webgpuOpt = dom.renderBackend.querySelector('option[value="webgpu"]');
    if (webgpuOpt) {
      webgpuOpt.disabled = !webgpuOk;
      webgpuOpt.textContent = webgpuOk ? 'WebGPU' : 'WebGPU (no soportado)';
    }
  }

  // ---- Topbar triggers & backdrop ----
  document.querySelectorAll('[data-popover-target]').forEach((btn) => {
    btn.addEventListener('click', () => openPopover(btn.dataset.popoverTarget, true));
  });
  dom.popoverBackdrop?.addEventListener('click', closeAllPopovers);
  dom.btnCloseOutliner?.addEventListener('click', closeAllPopovers);

  // ---- Menú Escena: Modelos / Malla (Primitivas / Agregar) ----
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

  // ---- Menú Objeto subtabs & Ajustes subtabs ----
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

  // ---- Selector de Modo: Pose / Modelar / Edición ----
  document.querySelectorAll('#menu-mode [data-app-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.appMode;
      closeAllPopovers();
      if (mode === 'pose') {
        if (edit.active) setEditMode(false);
        if (sculpt.active) setSculptMode(false);
        syncAppModeUI('pose');
      } else if (mode === 'modelar') {
        setSculptMode(true);
      } else if (mode === 'edicion') {
        setEditMode(true);
      }
    });
  });

  // ---- Importar & Drag-Drop ----
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

  // ---- Primitivas y Agregar (Luces, Cámara, Rig) ----
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

  // ---- Bottom Dock & Doble Clic Gizmo XYZ ----
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

  // Edición en tiempo real del mini-panel XYZ (Pose y Edición)
  {
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
          const moved =
            xyzBeforeObj.p.distanceTo(afterState.p) > 1e-5 ||
            xyzBeforeObj.s.distanceTo(afterState.s) > 1e-5 ||
            Math.abs(xyzBeforeObj.q.dot(afterState.q)) < 0.999999;
          if (moved) {
            history.push({
              type: 'transform',
              os: [cur],
              before: [xyzBeforeObj],
              after: [afterState],
            });
          }
          xyzBeforeObj = afterState;
        }
        syncGizmoXyzPanel();
      });
    });
  }

  dom.btnDockDuplicate?.addEventListener('click', duplicateSelected);
  dom.btnResetCam?.addEventListener('click', resetCamera);
  dom.btnUndo?.addEventListener('click', () => history.undo());
  dom.btnRedo?.addEventListener('click', () => history.redo());
  dom.btnToolbarDelete?.addEventListener('click', () => {
    if (edit.active) runEditDelete();
    else deleteSelected();
  });

  // ---- Visor / Gizmo ajustes ----
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

  // ---- Modo Edición: 3 cubos + barra herramientas + submenús ----
  document.querySelectorAll('[data-edit-sel]').forEach((btn) => {
    btn.addEventListener('click', () => {
      edit.editor.setSelectionMode(btn.dataset.editSel);
      if (!edit.active) setEditMode(true);
      else syncEditUI();
    });
  });

  bindDoubleTap(
    dom.btnEditExtrude,
    () => runEditExtrude(),
    () => toggleEditFlyout(dom.popEditExtrude),
    {
      delayMs: 250,
      waitSingle: true,
      beforeTap: () => {
        if (dom.popEditExtrude && !dom.popEditExtrude.hidden) {
          closeEditFlyouts();
          return true;
        }
        return false;
      },
    }
  );
  dom.btnEditExtrudeApply?.addEventListener('click', () => {
    runEditExtrude();
    closeEditFlyouts();
  });

  dom.btnEditCutToggle?.addEventListener('click', () => {
    closeEditFlyouts();
    toggleEditCutTool();
  });
  document.querySelectorAll('[data-edit-cut-mode]').forEach((btn) => {
    btn.addEventListener('click', () => setEditCutMode(btn.dataset.editCutMode));
  });

  bindDoubleTap(
    dom.btnEditSubdivide,
    () => runEditSubdivide(),
    () => toggleEditFlyout(dom.popEditSubdivide),
    {
      delayMs: 250,
      waitSingle: true,
      beforeTap: () => {
        if (dom.popEditSubdivide && !dom.popEditSubdivide.hidden) {
          closeEditFlyouts();
          return true;
        }
        return false;
      },
    }
  );
  dom.btnEditSubdivideApply?.addEventListener('click', () => {
    runEditSubdivide();
    closeEditFlyouts();
  });

  dom.btnEditSmoothToggle?.addEventListener('click', () => toggleEditFlyout(dom.popEditSmooth));
  dom.btnEditMergeToggle?.addEventListener('click', () => toggleEditFlyout(dom.popEditMerge));
  dom.btnEditMore?.addEventListener('click', () => toggleEditFlyout(dom.popEditMore));

  document.querySelectorAll('[data-close-flyout]').forEach((btn) => {
    btn.addEventListener('click', () => {
      closeEditFlyouts();
      if (dom.popSculptMore) dom.popSculptMore.hidden = true;
      dom.btnSculptMore?.classList.remove('is-active');
    });
  });

  dom.viewportWrap?.addEventListener('pointerdown', (e) => {
    if (e.target !== dom.canvas) return;
    closeEditFlyouts();
    if (dom.popSculptMore) dom.popSculptMore.hidden = true;
    dom.btnSculptMore?.classList.remove('is-active');
  });

  const readWeldSolidity = () => {
    const raw = Number(dom.editWeldSolidityNum?.value ?? dom.editWeldSolidity?.value ?? 80);
    const pct = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 80;
    return pct / 100;
  };
  const syncWeldSolidityInputs = (val, sourceEl) => {
    const pct = Number(val);
    if (!Number.isFinite(pct)) return;
    const clamped = String(Math.round(Math.max(0, Math.min(100, pct))));
    if (dom.editWeldSolidity && dom.editWeldSolidity !== sourceEl) dom.editWeldSolidity.value = clamped;
    if (dom.editWeldSolidityNum && dom.editWeldSolidityNum !== sourceEl) dom.editWeldSolidityNum.value = clamped;
  };
  dom.editWeldSolidity?.addEventListener('input', (e) => syncWeldSolidityInputs(e.target.value, dom.editWeldSolidity));
  dom.editWeldSolidityNum?.addEventListener('input', (e) => syncWeldSolidityInputs(e.target.value, dom.editWeldSolidityNum));
  dom.editWeldSolidityNum?.addEventListener('change', (e) => syncWeldSolidityInputs(e.target.value, null));

  dom.btnEditMerge?.addEventListener('click', runEditMerge);
  dom.btnEditMergeMeshes?.addEventListener('click', () => {
    const targets = getSelectedMergeTargetMeshes();
    if (targets.length < 2) {
      setStatus('Marca al menos 2 mallas en la lista para fusionarlas.', true);
      return;
    }
    const ok = mergeSelectedObjects({
      targets,
      threshold: Math.max(0.0001, Number(dom.editMergeDist?.value) || 0.015),
      removeInteriorFaces: dom.editWeldInterior ? dom.editWeldInterior.checked : true,
      stitchTJunctions: dom.editWeldStitch ? dom.editWeldStitch.checked : true,
      solidity: readWeldSolidity(),
    });
    if (ok) closeEditFlyouts();
  });

  dom.btnEditSelectAll?.addEventListener('click', () => { edit.editor.selectAll(); syncEditUI(); });
  dom.btnEditInvert?.addEventListener('click', () => { edit.editor.invertSelection(); syncEditUI(); });
  dom.btnEditClearSel?.addEventListener('click', () => { edit.editor.clearSelection(); syncEditUI(); });
  dom.btnEditMultiSelect?.addEventListener('click', () => toggleEditMultiSelect());
  dom.btnEditBoxSelect?.addEventListener('click', () => toggleEditBoxSelect());
  dom.btnEditBevel?.addEventListener('click', runEditBevel);
  dom.btnEditBridgeFill?.addEventListener('click', runEditBridgeFill);
  dom.btnEditDelete?.addEventListener('click', runEditDelete);
  dom.editCreaseRange?.addEventListener('input', (e) => {
    if (dom.editCreaseVal) dom.editCreaseVal.textContent = `${e.target.value}%`;
  });
  dom.editCreaseRange?.addEventListener('change', (e) => runEditCrease(Number(e.target.value) / 100));
  document.querySelectorAll('[data-edit-crease]').forEach((btn) => {
    btn.addEventListener('click', () => runEditCrease(Number(btn.dataset.editCrease)));
  });

  // ---- Alisar (Subdivisión suave) compartido Objeto & Edición ----
  dom.btnSubsurfDec?.addEventListener('click', () => stepSelectedSubsurf(-1));
  dom.btnSubsurfInc?.addEventListener('click', () => stepSelectedSubsurf(1));
  dom.btnEditSubsurfDec?.addEventListener('click', () => stepSelectedSubsurf(-1));
  dom.btnEditSubsurfInc?.addEventListener('click', () => stepSelectedSubsurf(1));
  dom.btnObjEnterEdit?.addEventListener('click', () => {
    closeAllPopovers();
    setEditMode(true);
  });
  dom.btnSubsurfApply?.addEventListener('click', applySelectedSubsurf);

  {
    let smoothBefore = null;
    let smoothTarget = null;
    const parseSmoothness = (rawVal) => {
      const pct = Number(rawVal);
      if (!Number.isFinite(pct)) return null;
      return Math.max(1, Math.min(100, pct)) / 100;
    };
    const onSmoothInput = (rawVal, sourceEl) => {
      const target = edit.active && edit.editor.mesh ? edit.editor.mesh : getEditablePrimaryMesh();
      if (!target) return;
      const s = parseSmoothness(rawVal);
      if (s === null) return;
      if (!smoothBefore || smoothTarget !== target) {
        smoothBefore = snapshotMeshModelingState(target);
        smoothTarget = target;
      }
      setSelectedSubsurfOptions({ smoothness: s }, { commitHistory: false });
      const pctStr = String(Math.round(s * 100));
      [dom.subsurfSmoothness, dom.subsurfSmoothnessNum, dom.editSubsurfSmoothness, dom.editSubsurfSmoothnessNum].forEach((elInput) => {
        if (elInput && elInput !== sourceEl) elInput.value = pctStr;
      });
    };
    const onSmoothCommit = (rawVal) => {
      const target = edit.active && edit.editor.mesh ? edit.editor.mesh : getEditablePrimaryMesh();
      const s = parseSmoothness(rawVal);
      const before = smoothTarget === target ? smoothBefore : null;
      smoothBefore = null;
      smoothTarget = null;
      if (s === null) { syncEditUI(); return; }
      setSelectedSubsurfOptions({ smoothness: s }, { commitHistory: true, beforeState: before });
    };
    [dom.subsurfSmoothness, dom.subsurfSmoothnessNum, dom.editSubsurfSmoothness, dom.editSubsurfSmoothnessNum].forEach((elInput) => {
      if (!elInput) return;
      elInput.addEventListener('input', (e) => onSmoothInput(e.target.value, elInput));
      elInput.addEventListener('change', (e) => onSmoothCommit(e.target.value));
    });
  }

  dom.subsurfShowCage?.addEventListener('change', (e) => setSelectedSubsurfOptions({ showCage: e.target.checked }));
  dom.editSubsurfCage?.addEventListener('change', (e) => setSelectedSubsurfOptions({ showCage: e.target.checked }));
  dom.subsurfAlwaysCage?.addEventListener('change', (e) => setSelectedSubsurfOptions({ alwaysShowCage: e.target.checked }));
  dom.editSubsurfAlwaysCage?.addEventListener('change', (e) => setSelectedSubsurfOptions({ alwaysShowCage: e.target.checked }));
  dom.subsurfSmoothShading?.addEventListener('change', (e) => setSelectedSubsurfOptions({ smoothShading: e.target.checked }));

  // ---- Modo Modelar (Esculpido): pinceles izquierda, barras derecha, submenú ⋯ ----
  document.querySelectorAll('[data-sculpt-tool]').forEach((btn) => {
    btn.addEventListener('click', () => {
      sculpt.sculptor.tool = btn.dataset.sculptTool;
      if (!sculpt.active) setSculptMode(true);
      else syncSculptUI();
    });
  });

  dom.sculptRadius?.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    sculpt.sculptor.radius = v;
    if (dom.sculptRadiusVal) dom.sculptRadiusVal.textContent = v.toFixed(2);
  });
  dom.sculptStrength?.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    sculpt.sculptor.strength = v;
    if (dom.sculptStrengthVal) dom.sculptStrengthVal.textContent = v.toFixed(2);
  });

  dom.btnSculptMore?.addEventListener('click', () => {
    if (!dom.popSculptMore) return;
    const willOpen = dom.popSculptMore.hidden;
    dom.popSculptMore.hidden = !willOpen;
    dom.btnSculptMore.classList.toggle('is-active', willOpen);
  });
  dom.btnSculptSubdivide?.addEventListener('click', subdivideSelectedMesh);
  dom.sculptFalloff?.addEventListener('change', (e) => { sculpt.sculptor.falloff = e.target.value; });
  dom.sculptSymmetry?.addEventListener('change', (e) => {
    sculpt.sculptor.symmetry = e.target.value;
    sculpt.sculptor.hover = null;
  });
  dom.sculptInvert?.addEventListener('change', (e) => { sculpt.sculptor.invert = e.target.checked; });
  dom.sculptFrontOnly?.addEventListener('change', (e) => { sculpt.sculptor.frontFacesOnly = e.target.checked; });
  dom.btnSculptClayMat?.addEventListener('click', applyClayMaterialToSelected);
  dom.btnSculptNewClay?.addEventListener('click', () => {
    if (dom.popSculptMore) dom.popSculptMore.hidden = true;
    addClaySphere({ recordHistory: true, enterSculpt: true });
  });

  // ---- Exportación y Limpiar escena ----
  dom.btnClearScene?.addEventListener('click', () => {
    if (!sceneStore.userObjects.length) return;
    const prevSelected = sceneStore.selected;
    const removals = sceneStore.userObjects.map((u) => history.buildRemovalRecord(u));
    const sceneMeta = history.captureSceneMeta();
    clearUserObjects();
    const afterSceneMeta = history.captureSceneMeta();
    history.push({ type: 'delete', removals, prevSelected, sceneMeta, afterSceneMeta });
    setStatus('Escena limpiada (Ctrl+Z para deshacer).');
  });

  dom.btnExportGlb?.addEventListener('click', async () => {
    const info = buildExportTarget();
    if (!info) return;
    try {
      setStatus('Generando archivo .glb...');
      const { GLTFExporter } = await loadGLTFExporter();
      const exporter = new GLTFExporter();
      const buffer = await exporter.parse(info.target, { binary: true, animations: sceneStore.animations });
      downloadBlob(new Blob([buffer], { type: 'model/gltf-binary' }), `${info.baseName}.glb`);
      setStatus(`Exportado: ${info.baseName}.glb (${(buffer.byteLength / 1024).toFixed(1)} KB)`);
    } catch (err) {
      setStatus(`Error al exportar GLB: ${err.message}`, true);
    }
  });

  dom.btnExportGltf?.addEventListener('click', async () => {
    const info = buildExportTarget();
    if (!info) return;
    try {
      setStatus('Generando archivo .gltf...');
      const { GLTFExporter } = await loadGLTFExporter();
      const exporter = new GLTFExporter();
      const json = await exporter.parse(info.target, { binary: false, animations: sceneStore.animations });
      const text = JSON.stringify(json, null, 2);
      downloadBlob(new Blob([text], { type: 'model/gltf+json' }), `${info.baseName}.gltf`);
      setStatus(`Exportado: ${info.baseName}.gltf (${(text.length / 1024).toFixed(1)} KB)`);
    } catch (err) {
      setStatus(`Error al exportar glTF: ${err.message}`, true);
    }
  });

  dom.btnExportObj?.addEventListener('click', async () => {
    const info = buildExportTarget();
    if (!info) return;
    try {
      const { OBJExporter } = await loadOBJExporter();
      const exporter = new OBJExporter();
      const { obj } = exporter.parseWithMaterials(info.target, { mtlFilename: `${info.baseName}.mtl` });
      downloadBlob(new Blob([obj], { type: 'text/plain;charset=utf-8' }), `${info.baseName}.obj`);
      setStatus(`Exportado: ${info.baseName}.obj (${(obj.length / 1024).toFixed(1)} KB)`);
    } catch (err) {
      setStatus(`Error al exportar OBJ: ${err.message}`, true);
    }
  });

  dom.btnExportMtl?.addEventListener('click', async () => {
    const info = buildExportTarget();
    if (!info) return;
    try {
      const { OBJExporter } = await loadOBJExporter();
      const exporter = new OBJExporter();
      const { mtl } = exporter.parseWithMaterials(info.target, { mtlFilename: `${info.baseName}.mtl` });
      if (!mtl) {
        setStatus('La selección no tiene materiales para exportar .mtl.', true);
        return;
      }
      downloadBlob(new Blob([mtl], { type: 'text/plain;charset=utf-8' }), `${info.baseName}.mtl`);
      setStatus(`Exportado: ${info.baseName}.mtl`);
    } catch (err) {
      setStatus(`Error al exportar MTL: ${err.message}`, true);
    }
  });

  // ---- Acciones Objeto ----
  dom.btnFocusObj?.addEventListener('click', () => { focusOnObject(sceneStore.selected); closeAllPopovers(); });
  dom.btnDuplicateObj?.addEventListener('click', duplicateSelected);
  dom.btnDeleteObj?.addEventListener('click', () => deleteSelected());

  const applyPivotPreset = (action, label) => {
    const o = sceneStore.selected;
    if (!o || !o.pivot) return;
    const before = snapshotLocal(o);
    action(o);
    const after = snapshotLocal(o);
    const moved =
      before.p.distanceTo(after.p) > 1e-5 ||
      (before.pv && after.pv && before.pv.distanceTo(after.pv) > 1e-5);
    if (moved) {
      history.push({ type: 'transform', os: [o], before: [before], after: [after] });
    }
    syncGizmoXyzPanel();
    setStatus(label);
  };
  dom.btnPivotCenter?.addEventListener('click', () =>
    applyPivotPreset((o) => o.centerPivot({ yAlign: 'center', keepWorld: true }), 'Pivote centrado.')
  );
  dom.btnPivotBase?.addEventListener('click', () =>
    applyPivotPreset((o) => o.centerPivot({ yAlign: 'bottom', keepWorld: true }), 'Pivote en la base.')
  );
  dom.btnPivotReset?.addEventListener('click', () =>
    applyPivotPreset((o) => o.resetPivot(true), 'Pivote restablecido.')
  );

  // ---- Inspector de Luz seleccionada (Objeto -> Luz) ----
  dom.selLightColor?.addEventListener('input', (e) => {
    const l = sceneStore.selected;
    if (!l || !l.isLight || !l.color) return;
    l.color.set(e.target.value);
    if (l === lighting.dirLight && dom.dirColor) dom.dirColor.value = e.target.value;
    if (l === lighting.pointLight && dom.pointColor) dom.pointColor.value = e.target.value;
  });
  dom.selLightIntensity?.addEventListener('input', (e) => {
    const l = sceneStore.selected;
    if (!l || !l.isLight) return;
    const v = Number(e.target.value);
    l.intensity = v;
    if (dom.selLightIntensityVal) dom.selLightIntensityVal.textContent = v.toFixed(1);
    if (l === lighting.dirLight && dom.dirIntensity) {
      dom.dirIntensity.value = String(v);
      if (dom.dirIntensityVal) dom.dirIntensityVal.textContent = v.toFixed(1);
    }
    if (l === lighting.pointLight && dom.pointIntensity) {
      dom.pointIntensity.value = String(v);
      if (dom.pointIntensityVal) dom.pointIntensityVal.textContent = v.toFixed(1);
    }
  });
  dom.selLightDistance?.addEventListener('input', (e) => {
    const l = sceneStore.selected;
    if (!l || !l.isPointLight) return;
    const v = Number(e.target.value);
    l.distance = v;
    if (dom.selLightDistanceVal) dom.selLightDistanceVal.textContent = v > 0 ? v.toFixed(1) : '∞ (3.5)';
  });
  dom.selLightDecay?.addEventListener('input', (e) => {
    const l = sceneStore.selected;
    if (!l || !l.isPointLight) return;
    const v = Number(e.target.value);
    l.decay = v;
    if (dom.selLightDecayVal) dom.selLightDecayVal.textContent = v.toFixed(1);
  });
  dom.selLightShadows?.addEventListener('change', (e) => {
    const l = sceneStore.selected;
    if (!l || !l.isDirectionalLight) return;
    l.castShadow = e.target.checked;
    if (dom.selLightShadowSoft) dom.selLightShadowSoft.disabled = !l.castShadow;
    if (l === lighting.dirLight && dom.dirShadows) {
      dom.dirShadows.checked = l.castShadow;
      syncShadowResolutionUI();
    }
  });
  dom.selLightShadowSoft?.addEventListener('input', (e) => {
    const l = sceneStore.selected;
    if (!l || !l.isDirectionalLight || !l.shadow) return;
    const v = Number(e.target.value);
    l.shadow.radius = v;
    if (dom.selLightShadowSoftVal) dom.selLightShadowSoftVal.textContent = v.toFixed(2);
    if (l === lighting.dirLight && dom.dirShadowSoft) {
      dom.dirShadowSoft.value = String(v);
      if (dom.dirShadowSoftVal) dom.dirShadowSoftVal.textContent = v.toFixed(2);
    }
  });

  // ---- Animaciones ----
  dom.animSelect?.addEventListener('change', (e) => playAnimationClip(Number(e.target.value)));
  dom.btnAnimPlay?.addEventListener('click', () => {
    if (!sceneStore.activeAction) return;
    sceneStore.animPlaying = !sceneStore.animPlaying;
    if (sceneStore.animPlaying) sceneStore.activeAction.play();
    else sceneStore.activeAction.pause();
    dom.btnAnimPlay.textContent = sceneStore.animPlaying ? 'Pausar' : 'Reproducir';
  });
  dom.btnAnimReset?.addEventListener('click', () => {
    if (!sceneStore.activeAction) return;
    sceneStore.activeAction.reset();
    sceneStore.activeAction.play();
    sceneStore.animPlaying = true;
    dom.btnAnimPlay.textContent = 'Pausar';
  });

  // ---- Texto 3D ----
  {
    let textSession = null;
    const readTextFormOptions = (baseOpts = {}) => ({
      ...baseOpts,
      text: dom.textContent ? dom.textContent.value : (baseOpts.text ?? 'Made3D'),
      fontFamily: dom.textFont ? dom.textFont.value : baseOpts.fontFamily,
      fontWeight: dom.textBold?.checked ? '700' : '400',
      fontStyle: dom.textItalic?.checked ? 'italic' : 'normal',
      align: dom.textAlign ? dom.textAlign.value : (baseOpts.align ?? 'center'),
      size: dom.textSize ? Number(dom.textSize.value) : (baseOpts.size ?? 0.72),
      depth: dom.textDepth ? Number(dom.textDepth.value) : (baseOpts.depth ?? 0.18),
      letterSpacing: dom.textSpacing ? Number(dom.textSpacing.value) : (baseOpts.letterSpacing ?? 0),
    });

    const beginTextSession = (mesh) => {
      if (!mesh || !mesh.isMesh || !mesh.geometry?.isTextGeometry) return null;
      if (!textSession || textSession.mesh !== mesh) {
        textSession = { mesh, beforeGeo: mesh.geometry, beforeName: mesh.name };
      }
      return textSession;
    };

    const applyTextUpdateSync = (mesh, TextGeoCtor) => {
      if (!mesh || !mesh.isMesh || !mesh.geometry?.isTextGeometry) return;
      const nextOpts = readTextFormOptions(mesh.geometry.textOptions);
      if (dom.textSizeVal) dom.textSizeVal.textContent = nextOpts.size.toFixed(2);
      if (dom.textDepthVal) dom.textDepthVal.textContent = nextOpts.depth.toFixed(2);
      if (dom.textSpacingVal) dom.textSpacingVal.textContent = nextOpts.letterSpacing.toFixed(2);

      const prevGeo = mesh.geometry;
      const nextGeo = new TextGeoCtor(nextOpts);
      if (mesh.setGeometry) mesh.setGeometry(nextGeo);
      else mesh.geometry = nextGeo;
      if (prevGeo && prevGeo !== textSession?.beforeGeo && prevGeo !== nextGeo && typeof prevGeo.dispose === 'function') {
        prevGeo.dispose();
      }
      if (mesh.name && mesh.name.startsWith('Texto:')) {
        const short = String(nextOpts.text).replace(/\s+/g, ' ').trim().slice(0, 16) || 'Vacío';
        mesh.name = `Texto: ${short}`;
        if (dom.selectedName && sceneStore.selected === mesh) dom.selectedName.textContent = mesh.name;
        renderObjectList();
      }
      syncSculptUI();
    };

    const applyTextUpdate = (mesh) => {
      if (_CachedTextGeometry) {
        applyTextUpdateSync(mesh, _CachedTextGeometry);
        return Promise.resolve();
      }
      return ensureTextGeometryCtor().then((TextGeoCtor) => applyTextUpdateSync(mesh, TextGeoCtor));
    };

    const commitTextSession = () => {
      if (!textSession) return;
      const { mesh, beforeGeo, beforeName } = textSession;
      textSession = null;
      if (!mesh || !mesh.geometry || mesh.geometry === beforeGeo) return;
      history.push({
        type: 'geometry',
        mesh,
        beforeGeo,
        afterGeo: mesh.geometry,
        beforeName,
        afterName: mesh.name,
      });
    };

    [dom.textContent, dom.textSize, dom.textDepth, dom.textSpacing].forEach((elInput) => {
      if (!elInput) return;
      elInput.addEventListener('focus', () => beginTextSession(sceneStore.selected));
      elInput.addEventListener('pointerdown', () => beginTextSession(sceneStore.selected));
      elInput.addEventListener('input', () => {
        const o = sceneStore.selected;
        if (beginTextSession(o)) void applyTextUpdate(o);
      });
      elInput.addEventListener('change', commitTextSession);
      elInput.addEventListener('blur', commitTextSession);
    });

    [dom.textFont, dom.textBold, dom.textItalic, dom.textAlign].forEach((elInput) => {
      if (!elInput) return;
      elInput.addEventListener('change', async () => {
        const o = sceneStore.selected;
        if (!beginTextSession(o)) return;
        await applyTextUpdate(o);
        commitTextSession();
      });
    });
  }

  // ---- Cámara & Viewfinder ----
  dom.btnCamEnter?.addEventListener('click', () => {
    if (!sceneStore.selected || !sceneStore.selected.isCamera) return;
    closeAllPopovers();
    if (cameraView.activeSceneCam === sceneStore.selected) exitCameraView();
    else enterCameraView(sceneStore.selected);
  });

  dom.btnCamAlign?.addEventListener('click', () => {
    const cam = sceneStore.selected;
    if (!cam || !cam.isCamera || cameraView.activeSceneCam === cam) return;
    const beforeState = snapshotLocal(cam);
    const refCam = cameraView.activeSceneCam || viewport.camera;
    refCam.updateWorldMatrix(true, false);
    cam.position.copy(refCam.getWorldPosition(new Vec3()));
    cam.quaternion.copy(refCam.getWorldQuaternion(new Quat()));
    cam.updateMatrixWorld();
    const afterState = snapshotLocal(cam);
    if (beforeState.p.distanceTo(afterState.p) > 1e-5 || Math.abs(beforeState.q.dot(afterState.q)) < 0.999999) {
      history.push({ type: 'transform', os: [cam], before: [beforeState], after: [afterState] });
    }
    syncGizmoXyzPanel();
    setStatus(`"${cam.name || 'Cámara'}" alineada con la vista actual.`);
  });

  dom.sceneCamFov?.addEventListener('input', (e) => {
    const cam = sceneStore.selected;
    if (!cam || !cam.isCamera) return;
    const fov = Number(e.target.value);
    cam.fov = fov;
    dom.sceneCamFovVal.textContent = `${fov}°`;
    updateSceneCameraProps(cam);
  });

  dom.sceneCamPreset?.addEventListener('change', (e) => {
    const cam = sceneStore.selected;
    if (!cam || !cam.isCamera || e.target.value === 'custom') return;
    const [rw, rh] = e.target.value.split('x').map((n) => parseInt(n, 10));
    if (!rw || !rh) return;
    const clamped = getCameraResolution({ renderWidth: rw, renderHeight: rh });
    cam.renderWidth = clamped.w;
    cam.renderHeight = clamped.h;
    cam.aspect = clamped.w / clamped.h;
    dom.sceneCamWidth.value = clamped.w;
    dom.sceneCamHeight.value = clamped.h;
    updateSceneCameraProps(cam);
  });

  const applyCustomCameraRes = () => {
    const cam = sceneStore.selected;
    if (!cam || !cam.isCamera) return;
    const rawW = Math.max(64, Math.min(7680, Math.round(parseFloat(dom.sceneCamWidth.value) || 1920)));
    const rawH = Math.max(64, Math.min(7680, Math.round(parseFloat(dom.sceneCamHeight.value) || 1080)));
    const clamped = getCameraResolution({ renderWidth: rawW, renderHeight: rawH });
    cam.renderWidth = clamped.w;
    cam.renderHeight = clamped.h;
    cam.aspect = clamped.w / clamped.h;
    const key = `${clamped.w}x${clamped.h}`;
    dom.sceneCamPreset.value = [...dom.sceneCamPreset.options].some((opt) => opt.value === key) ? key : 'custom';
    updateSceneCameraProps(cam);
  };
  dom.sceneCamWidth?.addEventListener('input', applyCustomCameraRes);
  dom.sceneCamHeight?.addEventListener('input', applyCustomCameraRes);
  dom.sceneCamThirds?.addEventListener('change', (e) => {
    const cam = sceneStore.selected;
    if (!cam || !cam.isCamera) return;
    setCameraMeta(cam, { showThirds: e.target.checked });
    if (cameraView.activeSceneCam === cam) updateViewfinderOverlay();
  });
  dom.sceneCamIncludeGrid?.addEventListener('change', (e) => {
    const cam = sceneStore.selected;
    if (cam && cam.isCamera) setCameraMeta(cam, { includeGrid: e.target.checked });
  });
  dom.sceneCamLock?.addEventListener('change', (e) => setCamViewLocked(e.target.checked));
  dom.btnVfLock?.addEventListener('click', () => setCamViewLocked(!cameraView.camViewLocked));
  dom.btnCamRender?.addEventListener('click', () => {
    const cam = sceneStore.selected?.isCamera ? sceneStore.selected : cameraView.activeSceneCam;
    if (cam) renderCameraSnapshot(cam);
  });
  dom.btnVfRender?.addEventListener('click', () => {
    const cam = cameraView.activeSceneCam || (sceneStore.selected?.isCamera ? sceneStore.selected : null);
    if (cam) renderCameraSnapshot(cam);
  });
  dom.btnCamVideo?.addEventListener('click', () => {
    if (recorder.instance) { stopCameraVideo(); return; }
    const cam = sceneStore.selected?.isCamera ? sceneStore.selected : cameraView.activeSceneCam;
    if (cam) startCameraVideo(cam);
  });
  dom.btnVfVideo?.addEventListener('click', () => {
    if (recorder.instance) { stopCameraVideo(); return; }
    const cam = cameraView.activeSceneCam || (sceneStore.selected?.isCamera ? sceneStore.selected : null);
    if (cam) startCameraVideo(cam);
  });
  dom.btnVfExit?.addEventListener('click', () => exitCameraView());

  // ---- Materiales y Shaders ----
  dom.matShaderType?.addEventListener('change', (e) => {
    if (!sceneStore.selected) return;
    applyMaterialType(sceneStore.selected, e.target.value);
    syncSelectedUI();
  });
  dom.matColor?.addEventListener('input', (e) => forEachMat((mat) => { if (mat.color) mat.color.set(e.target.value); }));
  dom.matShininess?.addEventListener('input', (e) => {
    const val = Number(e.target.value);
    dom.matShininessVal.textContent = String(val);
    forEachMat((mat) => {
      if (typeof mat.setShininess === 'function') mat.setShininess(val);
      else mat.shininess = val;
    });
  });
  dom.matPbr?.addEventListener('change', (e) => {
    const enabled = e.target.checked;
    forEachMat((mat) => { if (typeof mat.setHasPbr === 'function') mat.setHasPbr(enabled); });
    syncSelectedUI();
  });
  dom.matRoughness?.addEventListener('input', (e) => {
    const val = Number(e.target.value);
    if (dom.matRoughnessVal) dom.matRoughnessVal.textContent = val.toFixed(2);
    forEachMat((mat) => { if (mat.type === 'standard') mat.roughness = val; });
  });
  dom.matMetalness?.addEventListener('input', (e) => {
    const val = Number(e.target.value);
    if (dom.matMetalnessVal) dom.matMetalnessVal.textContent = val.toFixed(2);
    forEachMat((mat) => { if (mat.type === 'standard') mat.metalness = val; });
  });
  dom.matNormalScale?.addEventListener('input', (e) => {
    const val = Number(e.target.value);
    if (dom.matNormalScaleVal) dom.matNormalScaleVal.textContent = val.toFixed(2);
    forEachMat((mat) => { if (mat.type === 'standard' && mat.normalScale) mat.normalScale.set(val, val); });
  });
  dom.matAoIntensity?.addEventListener('input', (e) => {
    const val = Number(e.target.value);
    if (dom.matAoIntensityVal) dom.matAoIntensityVal.textContent = val.toFixed(2);
    forEachMat((mat) => { if (mat.type === 'standard') mat.aoMapIntensity = val; });
  });
  dom.matEnvIntensity?.addEventListener('input', (e) => {
    const val = Number(e.target.value);
    if (dom.matEnvIntensityVal) dom.matEnvIntensityVal.textContent = val.toFixed(2);
    forEachMat((mat) => { if (mat.type === 'standard') mat.envMapIntensity = val; });
  });

  {
    let pendingMapSlot = 'map';
    document.querySelectorAll('[data-mat-map]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!sceneStore.selected) return;
        pendingMapSlot = btn.dataset.matMap;
        dom.matMapFileInput?.click();
      });
    });
    document.querySelectorAll('[data-mat-map-clear]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const slot = btn.dataset.matMapClear;
        forEachMat((mat) => {
          if (mat.type === 'standard' && slot in mat) {
            const old = mat[slot];
            mat[slot] = null;
            if (old && old !== proceduralTexture && typeof old.dispose === 'function') old.dispose();
          }
        });
        syncSelectedUI();
        setStatus(`Mapa "${slot}" eliminado.`);
      });
    });
    dom.matMapFileInput?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file || !sceneStore.selected) return;
      const slot = pendingMapSlot || 'map';
      const colorSpace = slot === 'map' || slot === 'emissiveMap' ? 'srgb' : 'linear';
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const tex = new Texture(img, {
            width: img.naturalWidth || img.width,
            height: img.naturalHeight || img.height,
            colorSpace,
          });
          tex.needsUpdate = true;
          forEachMat((mat) => {
            if (mat.type === 'standard' && slot in mat) {
              mat[slot] = tex;
              if (slot !== 'map' && slot !== 'emissiveMap' && typeof mat.setHasPbr === 'function' && !mat.hasPbr) {
                mat.setHasPbr(true);
              }
              if (slot === 'emissiveMap' && mat.emissive && mat.emissive.r === 0 && mat.emissive.g === 0 && mat.emissive.b === 0) {
                mat.emissive.set(0xffffff);
              }
            }
          });
          syncSelectedUI();
          setStatus(`Textura "${file.name}" aplicada a ${slot}.`);
        };
        img.onerror = () => setStatus(`No se pudo decodificar la imagen "${file.name}".`, true);
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  dom.matOpacity?.addEventListener('input', (e) => {
    const val = Number(e.target.value);
    dom.matOpacityVal.textContent = val.toFixed(2);
    forEachMat((mat) => {
      if (typeof mat.setOpacity === 'function') mat.setOpacity(val);
      else {
        mat.opacity = val;
        mat.transparent = val < 0.999;
      }
    });
  });
  dom.matTexture?.addEventListener('change', (e) => {
    forEachMat((mat) => { mat.map = e.target.checked ? proceduralTexture : null; });
    syncSelectedUI();
  });
  dom.matWireframe?.addEventListener('change', (e) => {
    forEachMat((mat) => { mat.wireframe = e.target.checked; });
  });
  dom.objCastShadow?.addEventListener('change', (e) => {
    if (!sceneStore.selected) return;
    sceneStore.selected.castShadow = e.target.checked;
    sceneStore.selected.traverse((node) => { if (node.isMesh) node.castShadow = e.target.checked; });
  });
  dom.objAutoSpin?.addEventListener('change', (e) => {
    if (!sceneStore.selected) return;
    if (e.target.checked) sceneStore.spinObjects.add(sceneStore.selected);
    else sceneStore.spinObjects.delete(sceneStore.selected);
  });

  dom.matToonSteps?.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    dom.matToonStepsVal.textContent = String(v);
    forEachMat((mat) => { if (mat.type === 'toon') mat.steps = v; });
  });
  dom.matToonInk?.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    dom.matToonInkVal.textContent = v.toFixed(2);
    forEachMat((mat) => { if (mat.type === 'toon') mat.inkWidth = v; });
  });
  dom.matToonRim?.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    dom.matToonRimVal.textContent = v.toFixed(2);
    forEachMat((mat) => { if (mat.type === 'toon') mat.rimStrength = v; });
  });
  dom.matToonShadow?.addEventListener('input', (e) => {
    forEachMat((mat) => { if (mat.type === 'toon' && mat.shadowColor) mat.shadowColor.set(e.target.value); });
  });
  dom.matHoloDensity?.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    dom.matHoloDensityVal.textContent = String(v);
    forEachMat((mat) => { if (mat.type === 'hologram') mat.scanlineDensity = v; });
  });
  dom.matHoloGlitch?.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    dom.matHoloGlitchVal.textContent = v.toFixed(2);
    forEachMat((mat) => { if (mat.type === 'hologram') mat.glitchStrength = v; });
  });
  dom.matMatcapGloss?.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    dom.matMatcapGlossVal.textContent = v.toFixed(2);
    forEachMat((mat) => { if (mat.type === 'matcap') mat.glossiness = v; });
  });
  dom.matMatcapMetal?.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    dom.matMatcapMetalVal.textContent = v.toFixed(2);
    forEachMat((mat) => { if (mat.type === 'matcap') mat.metalness = v; });
  });
  dom.matFresnelIntensity?.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    dom.matFresnelIntensityVal.textContent = v.toFixed(2);
    forEachMat((mat) => { if (mat.type === 'fresnel') mat.fresnelIntensity = v; });
  });
  dom.matFresnelIrid?.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    dom.matFresnelIridVal.textContent = v.toFixed(2);
    forEachMat((mat) => { if (mat.type === 'fresnel') mat.iridescence = v; });
  });
  dom.matFresnelRim?.addEventListener('input', (e) => {
    forEachMat((mat) => { if (mat.type === 'fresnel' && mat.rimColor) mat.rimColor.set(e.target.value); });
  });
  dom.matDissolveAuto?.addEventListener('change', (e) => {
    const checked = e.target.checked;
    dom.rowDissolveProgress.hidden = checked;
    forEachMat((mat) => { if (mat.type === 'dissolve') mat.autoAnimate = checked; });
  });
  dom.matDissolveProgress?.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    dom.matDissolveProgressVal.textContent = v.toFixed(2);
    forEachMat((mat) => { if (mat.type === 'dissolve') mat.progress = v; });
  });
  dom.matDissolveEdge?.addEventListener('input', (e) => {
    forEachMat((mat) => { if (mat.type === 'dissolve' && mat.edgeColor) mat.edgeColor.set(e.target.value); });
  });

  // ---- Entorno HDRI / Luces / Escenario / Visor ----
  dom.envPreset?.addEventListener('change', (e) => {
    const val = e.target.value;
    if (val === 'custom') return;
    applyEnvironmentPreset(val);
    setStatus(val === 'none' ? 'HDRI/IBL desactivado.' : `Entorno IBL: ${e.target.selectedOptions?.[0]?.textContent || val}`);
  });
  dom.envIntensity?.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    if (dom.envIntensityVal) dom.envIntensityVal.textContent = v.toFixed(2);
    if (viewport.scene) viewport.scene.environmentIntensity = v;
  });
  dom.btnEnvUpload?.addEventListener('click', () => dom.envFileInput?.click());
  dom.envFileInput?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try { await loadEnvironmentFile(file); }
    catch (err) { setStatus(`Error cargando HDRI: ${err.message}`, true); }
  });
  dom.btnEnvClear?.addEventListener('click', () => {
    applyEnvironmentPreset('none');
    setStatus('HDRI/IBL quitado.');
  });

  dom.dirIntensity?.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    dom.dirIntensityVal.textContent = v.toFixed(1);
    if (lighting.dirLight) lighting.dirLight.intensity = v;
  });
  dom.dirColor?.addEventListener('input', (e) => {
    if (lighting.dirLight) lighting.dirLight.color.set(e.target.value);
  });
  dom.dirShadows?.addEventListener('change', (e) => {
    if (!lighting.dirLight) return;
    lighting.dirLight.castShadow = e.target.checked;
    syncShadowResolutionUI();
  });
  dom.dirShadowRes?.addEventListener('change', (e) => {
    if (!lighting.dirLight) return;
    const val = e.target.value;
    if (val === 'auto') {
      lighting.dirLight.shadow.mapSize = 1024;
      lighting.dirLight.shadow.autoQuality = true;
    } else {
      const size = Math.max(64, parseInt(val, 10) || 1024);
      lighting.dirLight.shadow.mapSize = size;
      lighting.dirLight.shadow.autoQuality = false;
    }
    syncShadowResolutionUI();
  });
  dom.dirShadowSoft?.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    dom.dirShadowSoftVal.textContent = v.toFixed(2);
    if (lighting.dirLight?.shadow) lighting.dirLight.shadow.radius = v;
  });
  dom.dirOrbit?.addEventListener('change', (e) => { lighting.orbitLight = e.target.checked; });

  dom.pointIntensity?.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    dom.pointIntensityVal.textContent = v.toFixed(1);
    if (lighting.pointLight) lighting.pointLight.intensity = v;
  });
  dom.pointColor?.addEventListener('input', (e) => {
    if (lighting.pointLight) lighting.pointLight.color.set(e.target.value);
  });
  dom.ambIntensity?.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    dom.ambIntensityVal.textContent = v.toFixed(2);
    if (lighting.ambientLight) lighting.ambientLight.intensity = v;
  });

  const applyFog = () => {
    viewport.scene.fog = lighting.fogEnabled ? new Fog(lighting.fogColorHex, 8, lighting.fogFar) : null;
  };
  dom.fogEnabled?.addEventListener('change', (e) => { lighting.fogEnabled = e.target.checked; applyFog(); });
  dom.fogFar?.addEventListener('input', (e) => {
    lighting.fogFar = Number(e.target.value);
    dom.fogFarVal.textContent = String(lighting.fogFar);
    applyFog();
  });
  dom.bgColor?.addEventListener('input', (e) => {
    lighting.fogColorHex = e.target.value;
    viewport.scene.background = new Color(lighting.fogColorHex);
    applyFog();
  });
  dom.gridVisible?.addEventListener('change', (e) => { sceneStore.grid.visible = e.target.checked; });
  dom.floorVisible?.addEventListener('change', (e) => { sceneStore.floor.visible = e.target.checked; });

  dom.cameraType?.addEventListener('change', (e) => {
    if (cameraView.activeSceneCam) exitCameraView({ restoreSnapshot: false });
    const useOrtho = e.target.value === 'orthographic';
    const prevCam = viewport.camera;
    const nextCam = useOrtho ? viewport.orthoCam : viewport.perspCam;
    nextCam.position.copy(prevCam.position);
    viewport.camera = nextCam;
    viewport.controls.camera = nextCam;
    viewport.controls.syncFromCamera();
    if (viewport.gizmo) viewport.gizmo.camera = nextCam;
    dom.fovRow.hidden = useOrtho;
    resizeRenderer();
  });
  dom.cameraFov?.addEventListener('input', (e) => {
    const fov = Number(e.target.value);
    dom.cameraFovVal.textContent = `${fov}°`;
    viewport.perspCam.fov = fov;
    viewport.perspCam.updateProjection();
  });
  dom.renderQuality?.addEventListener('change', (e) => {
    viewport.renderer.setQuality(e.target.value);
    resizeRenderer();
    syncShadowResolutionUI();
  });
  dom.renderBackend?.addEventListener('change', async (e) => {
    const pref = e.target.value;
    const prevBackend = viewport.renderer ? viewport.renderer.backendType : 'webgl2';
    try {
      setStatus(`Cambiando motor gráfico a ${pref.toUpperCase()}...`);
      const next = await switchRenderBackend(pref);
      if (next) setStatus(`Motor activo: ${next.isWebGPU ? 'WebGPU' : 'WebGL2'}.`);
    } catch (err) {
      if (dom.renderBackend) dom.renderBackend.value = prevBackend;
      setStatus(err && err.message ? err.message : 'No se pudo cambiar de motor gráfico.', true);
    }
  });
  dom.btnRetryWebgl?.addEventListener('click', () => window.location.reload());

  // ---- Atajos de teclado ----
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented) {
      if (viewport.openPopover) {
        e.preventDefault();
        closeAllPopovers();
        return;
      }
      if (!sculpt.active && cameraView.activeSceneCam) {
        e.preventDefault();
        exitCameraView();
        return;
      }
    }

    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) history.redo();
      else history.undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      history.redo();
      return;
    }

    const k = e.key.toLowerCase();
    if (e.key === 'Tab') {
      e.preventDefault();
      setEditMode(!edit.active);
      return;
    }
    if (k === 'b') {
      e.preventDefault();
      setSculptMode(!sculpt.active);
      return;
    }
    if (sculpt.active && (e.key === '[' || e.key === ']')) return;

    if (edit.active) {
      if (k === '1') { edit.editor.setSelectionMode('vertex'); syncEditUI(); return; }
      if (k === '2') { edit.editor.setSelectionMode('edge'); syncEditUI(); return; }
      if (k === '3') { edit.editor.setSelectionMode('face'); syncEditUI(); return; }
      if (k === 'k') { e.preventDefault(); toggleEditCutTool(); return; }
      if (k === 'a' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        edit.editor.selectAll();
        syncEditUI();
        return;
      }
    }

    if (k === 'q') { viewport.gizmoXyzOpen = false; setGizmoMode('select'); }
    else if (k === 'w') setGizmoMode('translate');
    else if (k === 'e') setGizmoMode('rotate');
    else if (k === 'r') setGizmoMode('scale');
    else if (k === 'p') {
      e.preventDefault();
      setEditPivotMode(!viewport.gizmo?.editPivot);
    } else if (k === 'delete' || k === 'backspace') {
      e.preventDefault();
      if (edit.active) runEditDelete();
      else deleteSelected();
    } else if (k === 'f') focusOnObject(sceneStore.selected);
  });

  // ---- Enlace de MeshEditor & Sculptor al visor ----
  edit.editor.attach({
    domElement: dom.viewportWrap,
    pointerDownTarget: () => dom.canvas,
    getCamera: () => viewport.camera,
    getControls: () => viewport.controls,
    getControlsEnabled: () => !(cameraView.activeSceneCam && cameraView.camViewLocked),
    onSelectionChange: () => syncEditUI(),
    onModeChange: () => syncEditUI(),
    onSpaceChange: (nextSpace) => {
      if (viewport.gizmo) viewport.gizmo.setSpace(nextSpace);
      syncGizmoSpaceUI(nextSpace);
      setStatus(nextSpace === 'local' ? 'Espacio del gizmo: Local' : 'Espacio del gizmo: Mundo');
    },
    onReadoutChange: (text) => {
      if (!dom.gizmoReadout) return;
      if (!text) dom.gizmoReadout.hidden = true;
      else {
        dom.gizmoReadout.hidden = false;
        dom.gizmoReadout.textContent = text;
      }
    },
    onEditCommit: (ev) => {
      if (ev && ev.beforeState && ev.afterState) {
        history.push({
          type: 'meshEdit',
          mesh: ev.mesh,
          beforeState: ev.beforeState,
          afterState: ev.afterState,
          label: ev.label || 'Edición 3D',
        });
      }
      syncEditUI();
    },
    onExit: () => setEditMode(false),
  });

  sculpt.sculptor.attach({
    domElement: dom.viewportWrap,
    pointerDownTarget: () => dom.canvas,
    overlay: dom.sculptOverlay,
    getCamera: () => viewport.camera,
    getControls: () => viewport.controls,
    getScene: () => viewport.scene,
    getTargets: getSculptTargets,
    getControlsEnabled: () => !(cameraView.activeSceneCam && cameraView.camViewLocked),
    onSelect: (mesh) => {
      if (mesh !== sceneStore.selected) {
        sceneStore.selected = mesh;
        sceneStore.selectedList = mesh ? [mesh] : [];
        if (viewport.gizmo) viewport.gizmo.attach(mesh);
        syncSelectedUI();
        renderObjectList();
      }
    },
    onStrokeEnd: (res) => {
      if (res && res.diff) {
        history.push({
          type: 'sculpt',
          mesh: res.mesh,
          geo: res.geometry,
          diff: res.diff,
          beforeState: res.beforeState,
          afterState: res.afterState,
        });
        syncSculptUI();
      }
    },
    onStrokeCancel: () => setStatus('Trazo cancelado.'),
    onRadiusChange: () => syncSculptUI(),
    onExit: () => setSculptMode(false),
  });
}
