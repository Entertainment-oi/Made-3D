import {
  Texture,
  Vec3,
  Quat,
  loadTextGeometry,
  loadVideoRecorder,
} from '../../made3d.module.js';
import { applyMaterialType } from '../../src/modules/stylized.js';
import { AnimationClip } from '../../src/modules/animation.js';
import { dom, setStatus } from '../dom.js';
import {
  viewport,
  sceneStore,
  lighting,
  cameraView,
  recorder,
  getCameraMeta,
  setCameraMeta,
  snapshotLocal,
} from '../store.js';
import { history } from '../history.js';
import { focusOnObject, syncShadowResolutionUI } from '../viewport.js';
import {
  getCameraResolution,
  updateViewfinderOverlay,
  updateSceneCameraProps,
  setCamViewLocked,
  enterCameraView,
  exitCameraView,
  renderCameraSnapshot,
  startCameraVideo,
  stopCameraVideo,
} from '../cameraView.js';
import { syncSculptUI } from '../sculptController.js';
import { syncSubsurfUI } from '../editController.js';
import {
  proceduralTexture,
  duplicateSelected,
  deleteSelected,
  playAnimationClip,
} from '../sceneActions.js';
import { recordAutoKeyframeIfNeeded } from '../animationController.js';
import { closeAllPopovers, syncViewCameraQuickBtn } from './popovers.js';
import { renderObjectList } from './outliner.js';
import { syncGizmoXyzPanel } from './gizmoPanel.js';
import { syncAllRanges } from './rangeControls.js';

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
    syncViewCameraQuickBtn();
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
  syncViewCameraQuickBtn();

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
  syncAllRanges(dom.objectEditor || document);
}

export function bindObjectInspector() {
  if (dom.sceneCamVideoFormat) {
    dom.sceneCamVideoFormat.addEventListener('pointerdown', ensureVideoFormatsPopulated);
    dom.sceneCamVideoFormat.addEventListener('focus', ensureVideoFormatsPopulated);
  }

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

  // Luz seleccionada
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

  // Animaciones importadas legado
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

  // Texto 3D
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

  // Cámara & Viewfinder
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
      history.runGrouped('Alinear cámara', () => {
        history.push({ type: 'transform', os: [cam], before: [beforeState], after: [afterState] });
        recordAutoKeyframeIfNeeded([cam], {
          properties: AnimationClip.detectChangedProperties(beforeState, afterState),
        });
      });
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

  // Materiales & Shaders
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
}
