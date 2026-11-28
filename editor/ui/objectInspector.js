import {
  Texture,
  HistoryManager,
  DEG2RAD,
  RAD2DEG,
  loadTextGeometry,
  loadVideoRecorder,
} from '../../made3d.module.js';
import { applyMaterialType } from '../../src/modules/stylized.js';
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
  getTexturePreset,
  duplicateSelected,
  deleteSelected,
  playAnimationClip,
} from '../sceneActions.js';
import { recordAutoKeyframeIfNeeded, bindAutoKeyframeControl } from '../animationController.js';
import { closeAllPopovers, syncViewCameraQuickBtn } from './popovers.js';
import { renderObjectList } from './outliner.js';
import { syncGizmoXyzPanel } from './gizmoPanel.js';
import { syncAllRanges, syncRangeVisual } from './rangeControls.js';

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

const PRESET_TEX_NAMES = {
  checker: 'Tablero',
  grid: 'Cuadrícula',
  stripes: 'Rayas',
  brick: 'Ladrillo',
  wood: 'Madera',
  noise: 'Piedra / Ruido',
  uv: 'Guía UV',
};

function syncMaterialTextureUI(mat) {
  const tex = mat?.map || null;
  const presetId = tex?.userData?.presetId;
  const isKnownPreset = Boolean(presetId && presetId in PRESET_TEX_NAMES);
  const value = !tex ? 'none' : isKnownPreset ? presetId : 'custom';

  if (dom.matTexturePreset && document.activeElement !== dom.matTexturePreset) {
    dom.matTexturePreset.value = value;
  }
  if (dom.matTextureState) {
    if (!tex) {
      dom.matTextureState.textContent = 'Sin textura';
    } else if (isKnownPreset) {
      dom.matTextureState.textContent = PRESET_TEX_NAMES[presetId];
    } else {
      dom.matTextureState.textContent = tex.userData?.customName || tex.name || 'Imagen cargada';
    }
  }
  if (dom.btnMatTextureClear) {
    dom.btnMatTextureClear.hidden = !tex;
  }
}

function syncMaterialPbrMapsUI(mat) {
  if (!mat || mat.type !== 'standard') return;
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

function syncLightInspectorControls(light, { respectFocus = false } = {}) {
  if (!light || !dom.lightObjGroup) return;
  if (dom.selLightColor && light.color && (!respectFocus || document.activeElement !== dom.selLightColor)) {
    dom.selLightColor.value = light.color.getStyle();
  }
  if (dom.selLightIntensity) {
    if (!respectFocus || document.activeElement !== dom.selLightIntensity) {
      dom.selLightIntensity.value = String(light.intensity ?? 1);
      syncRangeVisual(dom.selLightIntensity);
    }
    if (dom.selLightIntensityVal) dom.selLightIntensityVal.textContent = (light.intensity ?? 1).toFixed(1);
  }
  const isPoint = Boolean(light.isPointLight);
  const isSpot = Boolean(light.isSpotLight);
  const isDir = Boolean(light.isDirectionalLight);
  if (dom.selLightPointFields) dom.selLightPointFields.hidden = !(isPoint || isSpot);
  if (dom.selLightSpotFields) dom.selLightSpotFields.hidden = !isSpot;
  if (dom.selLightDirFields) dom.selLightDirFields.hidden = !isDir;
  if (isPoint || isSpot) {
    const dist = light.distance ?? 0;
    const decay = light.decay ?? 2;
    if (dom.selLightDistance) {
      if (!respectFocus || document.activeElement !== dom.selLightDistance) {
        dom.selLightDistance.value = String(dist);
        syncRangeVisual(dom.selLightDistance);
      }
    }
    if (dom.selLightDistanceVal) dom.selLightDistanceVal.textContent = dist > 0 ? dist.toFixed(1) : '∞ (3.5)';
    if (dom.selLightDecay) {
      if (!respectFocus || document.activeElement !== dom.selLightDecay) {
        dom.selLightDecay.value = String(decay);
        syncRangeVisual(dom.selLightDecay);
      }
    }
    if (dom.selLightDecayVal) dom.selLightDecayVal.textContent = decay.toFixed(1);
  }
  if (isSpot) {
    const deg = Math.round((light.angle ?? Math.PI / 6) * RAD2DEG);
    const pen = light.penumbra ?? 0.3;
    if (dom.selLightAngle) {
      if (!respectFocus || document.activeElement !== dom.selLightAngle) {
        dom.selLightAngle.value = String(deg);
        syncRangeVisual(dom.selLightAngle);
      }
    }
    if (dom.selLightAngleVal) dom.selLightAngleVal.textContent = `${deg}°`;
    if (dom.selLightPenumbra) {
      if (!respectFocus || document.activeElement !== dom.selLightPenumbra) {
        dom.selLightPenumbra.value = String(pen);
        syncRangeVisual(dom.selLightPenumbra);
      }
    }
    if (dom.selLightPenumbraVal) dom.selLightPenumbraVal.textContent = pen.toFixed(2);
  }
  if (isDir) {
    if (dom.selLightShadows && (!respectFocus || document.activeElement !== dom.selLightShadows)) {
      dom.selLightShadows.checked = Boolean(light.castShadow);
    }
    const soft = light.shadow?.radius ?? 1.25;
    if (dom.selLightShadowSoft) {
      if (!respectFocus || document.activeElement !== dom.selLightShadowSoft) {
        dom.selLightShadowSoft.value = String(soft);
        syncRangeVisual(dom.selLightShadowSoft);
      }
      dom.selLightShadowSoft.disabled = !light.castShadow;
    }
    if (dom.selLightShadowSoftVal) dom.selLightShadowSoftVal.textContent = soft.toFixed(2);
  }
}

export function syncAnimatedInspectorValues() {
  const o = sceneStore.selected;
  if (!o) return;

  if (dom.objVisible && document.activeElement !== dom.objVisible) {
    dom.objVisible.checked = o.visible !== false;
  }
  if (dom.objCastShadow && document.activeElement !== dom.objCastShadow) {
    dom.objCastShadow.checked = o.hasShadowCaster();
  }

  if (o.isLight) {
    syncLightInspectorControls(o, { respectFocus: true });
    return;
  }

  if (o.isCamera) {
    const fov = Math.round(o.fov || 50);
    if (dom.sceneCamFov && document.activeElement !== dom.sceneCamFov) {
      dom.sceneCamFov.value = String(fov);
      syncRangeVisual(dom.sceneCamFov);
    }
    if (dom.sceneCamFovVal) dom.sceneCamFovVal.textContent = `${fov}°`;
    return;
  }

  const mat = o.getPrimaryMaterial?.();
  if (!mat) return;

  const shaderType = mat.type || 'standard';
  if (mat.color && dom.matColor && document.activeElement !== dom.matColor) {
    dom.matColor.value = mat.color.getStyle();
  }
  syncMaterialTextureUI(mat);

  const displayShininess = typeof mat.getShininess === 'function' ? mat.getShininess() : (mat.shininess ?? 0);
  if (dom.matShininess && document.activeElement !== dom.matShininess) {
    dom.matShininess.value = String(displayShininess);
    syncRangeVisual(dom.matShininess);
  }
  if (dom.matShininessVal) dom.matShininessVal.textContent = String(Math.round(displayShininess));

  if (shaderType === 'standard') {
    const rVal = mat.roughness ?? 1;
    const mVal = mat.metalness ?? 0;
    const nVal = mat.normalScale?.x ?? 1;
    const aoVal = mat.aoMapIntensity ?? 1;
    const envVal = mat.envMapIntensity ?? 1;
    if (dom.matRoughness && document.activeElement !== dom.matRoughness) {
      dom.matRoughness.value = String(rVal);
      syncRangeVisual(dom.matRoughness);
    }
    if (dom.matRoughnessVal) dom.matRoughnessVal.textContent = rVal.toFixed(2);
    if (dom.matMetalness && document.activeElement !== dom.matMetalness) {
      dom.matMetalness.value = String(mVal);
      syncRangeVisual(dom.matMetalness);
    }
    if (dom.matMetalnessVal) dom.matMetalnessVal.textContent = mVal.toFixed(2);
    if (dom.matNormalScale && document.activeElement !== dom.matNormalScale) {
      dom.matNormalScale.value = String(nVal);
      syncRangeVisual(dom.matNormalScale);
    }
    if (dom.matNormalScaleVal) dom.matNormalScaleVal.textContent = nVal.toFixed(2);
    if (dom.matAoIntensity && document.activeElement !== dom.matAoIntensity) {
      dom.matAoIntensity.value = String(aoVal);
      syncRangeVisual(dom.matAoIntensity);
    }
    if (dom.matAoIntensityVal) dom.matAoIntensityVal.textContent = aoVal.toFixed(2);
    if (dom.matEnvIntensity && document.activeElement !== dom.matEnvIntensity) {
      dom.matEnvIntensity.value = String(envVal);
      syncRangeVisual(dom.matEnvIntensity);
    }
    if (dom.matEnvIntensityVal) dom.matEnvIntensityVal.textContent = envVal.toFixed(2);
    syncMaterialPbrMapsUI(mat);
  }

  const op = mat.opacity ?? 1;
  if (dom.matOpacity && document.activeElement !== dom.matOpacity) {
    dom.matOpacity.value = String(op);
    syncRangeVisual(dom.matOpacity);
  }
  if (dom.matOpacityVal) dom.matOpacityVal.textContent = op.toFixed(2);
  if (dom.matWireframe && document.activeElement !== dom.matWireframe) {
    dom.matWireframe.checked = Boolean(mat.wireframe);
  }

  if (shaderType === 'toon') {
    const st = mat.steps ?? 3;
    const ink = mat.inkWidth ?? 0.22;
    const rim = mat.rimStrength ?? 0.7;
    if (dom.matToonSteps && document.activeElement !== dom.matToonSteps) {
      dom.matToonSteps.value = String(st);
      syncRangeVisual(dom.matToonSteps);
    }
    if (dom.matToonStepsVal) dom.matToonStepsVal.textContent = String(Math.round(st));
    if (dom.matToonInk && document.activeElement !== dom.matToonInk) {
      dom.matToonInk.value = String(ink);
      syncRangeVisual(dom.matToonInk);
    }
    if (dom.matToonInkVal) dom.matToonInkVal.textContent = ink.toFixed(2);
    if (dom.matToonRim && document.activeElement !== dom.matToonRim) {
      dom.matToonRim.value = String(rim);
      syncRangeVisual(dom.matToonRim);
    }
    if (dom.matToonRimVal) dom.matToonRimVal.textContent = rim.toFixed(2);
    if (mat.shadowColor && dom.matToonShadow && document.activeElement !== dom.matToonShadow) {
      dom.matToonShadow.value = mat.shadowColor.getStyle();
    }
  } else if (shaderType === 'hologram') {
    const den = mat.scanlineDensity ?? 18;
    const gl = mat.glitchStrength ?? 0.35;
    if (dom.matHoloDensity && document.activeElement !== dom.matHoloDensity) {
      dom.matHoloDensity.value = String(den);
      syncRangeVisual(dom.matHoloDensity);
    }
    if (dom.matHoloDensityVal) dom.matHoloDensityVal.textContent = String(Math.round(den));
    if (dom.matHoloGlitch && document.activeElement !== dom.matHoloGlitch) {
      dom.matHoloGlitch.value = String(gl);
      syncRangeVisual(dom.matHoloGlitch);
    }
    if (dom.matHoloGlitchVal) dom.matHoloGlitchVal.textContent = gl.toFixed(2);
  } else if (shaderType === 'matcap') {
    const gloss = mat.glossiness ?? 0.55;
    const metal = mat.metalness ?? 0.25;
    if (dom.matMatcapGloss && document.activeElement !== dom.matMatcapGloss) {
      dom.matMatcapGloss.value = String(gloss);
      syncRangeVisual(dom.matMatcapGloss);
    }
    if (dom.matMatcapGlossVal) dom.matMatcapGlossVal.textContent = gloss.toFixed(2);
    if (dom.matMatcapMetal && document.activeElement !== dom.matMatcapMetal) {
      dom.matMatcapMetal.value = String(metal);
      syncRangeVisual(dom.matMatcapMetal);
    }
    if (dom.matMatcapMetalVal) dom.matMatcapMetalVal.textContent = metal.toFixed(2);
  } else if (shaderType === 'fresnel') {
    const fi = mat.fresnelIntensity ?? 1.6;
    const ir = mat.iridescence ?? 0.55;
    if (dom.matFresnelIntensity && document.activeElement !== dom.matFresnelIntensity) {
      dom.matFresnelIntensity.value = String(fi);
      syncRangeVisual(dom.matFresnelIntensity);
    }
    if (dom.matFresnelIntensityVal) dom.matFresnelIntensityVal.textContent = fi.toFixed(2);
    if (dom.matFresnelIrid && document.activeElement !== dom.matFresnelIrid) {
      dom.matFresnelIrid.value = String(ir);
      syncRangeVisual(dom.matFresnelIrid);
    }
    if (dom.matFresnelIridVal) dom.matFresnelIridVal.textContent = ir.toFixed(2);
    if (mat.rimColor && dom.matFresnelRim && document.activeElement !== dom.matFresnelRim) {
      dom.matFresnelRim.value = mat.rimColor.getStyle();
    }
  } else if (shaderType === 'dissolve') {
    const autoAnim = mat.autoAnimate !== false;
    if (dom.matDissolveAuto && document.activeElement !== dom.matDissolveAuto) {
      dom.matDissolveAuto.checked = autoAnim;
    }
    if (dom.rowDissolveProgress) dom.rowDissolveProgress.hidden = autoAnim;
    const prog = mat.progress ?? 0.35;
    if (dom.matDissolveProgress && document.activeElement !== dom.matDissolveProgress) {
      dom.matDissolveProgress.value = String(prog);
      syncRangeVisual(dom.matDissolveProgress);
    }
    if (dom.matDissolveProgressVal) dom.matDissolveProgressVal.textContent = prog.toFixed(2);
    if (mat.edgeColor && dom.matDissolveEdge && document.activeElement !== dom.matDissolveEdge) {
      dom.matDissolveEdge.value = mat.edgeColor.getStyle();
    }
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
      : o.isSpotLight
      ? 'Luz direccional'
      : o.isDirectionalLight
      ? 'Sol'
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

  if (dom.objVisible) dom.objVisible.checked = o.visible !== false;

  syncSubsurfUI();
  syncGizmoXyzPanel();
  syncViewCameraQuickBtn();

  if (isLight) {
    syncLightInspectorControls(o);
    syncAllRanges(dom.objectEditor || document);
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

      syncMaterialPbrMapsUI(mat);
    }

    dom.matOpacity.value = mat.opacity ?? 1;
    dom.matOpacityVal.textContent = (mat.opacity ?? 1).toFixed(2);
    syncMaterialTextureUI(mat);
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

  if (dom.objCastShadow) dom.objCastShadow.checked = o.hasShadowCaster();
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
    if (HistoryManager.hasTransformChanged(before, after, { includePivot: true })) {
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

  dom.objVisible?.addEventListener('change', (e) => {
    const o = sceneStore.selected;
    if (!o) return;
    o.visible = e.target.checked;
    renderObjectList();
    recordAutoKeyframeIfNeeded([o], { properties: ['visible'] });
  });

  // Luz seleccionada
  const getSelected = () => sceneStore.selected;
  dom.selLightColor?.addEventListener('input', (e) => {
    const l = sceneStore.selected;
    if (!l || !l.isLight || !l.color) return;
    l.color.set(e.target.value);
    if (l === lighting.dirLight && dom.dirColor) dom.dirColor.value = e.target.value;
    if (l === lighting.pointLight && dom.pointColor) dom.pointColor.value = e.target.value;
  });
  bindAutoKeyframeControl(dom.selLightColor, getSelected, 'color');

  dom.selLightIntensity?.addEventListener('input', (e) => {
    const l = sceneStore.selected;
    if (!l || !l.isLight) return;
    const v = Number(e.target.value);
    l.intensity = v;
    if (dom.selLightIntensityVal) dom.selLightIntensityVal.textContent = v.toFixed(1);
    if (l === lighting.dirLight && dom.dirIntensity) {
      dom.dirIntensity.value = String(v);
      syncRangeVisual(dom.dirIntensity);
      if (dom.dirIntensityVal) dom.dirIntensityVal.textContent = v.toFixed(1);
    }
    if (l === lighting.pointLight && dom.pointIntensity) {
      dom.pointIntensity.value = String(v);
      syncRangeVisual(dom.pointIntensity);
      if (dom.pointIntensityVal) dom.pointIntensityVal.textContent = v.toFixed(1);
    }
  });
  bindAutoKeyframeControl(dom.selLightIntensity, getSelected, 'intensity');

  dom.selLightDistance?.addEventListener('input', (e) => {
    const l = sceneStore.selected;
    if (!l || (!l.isPointLight && !l.isSpotLight)) return;
    const v = Number(e.target.value);
    l.distance = v;
    if (dom.selLightDistanceVal) dom.selLightDistanceVal.textContent = v > 0 ? v.toFixed(1) : '∞ (3.5)';
  });
  bindAutoKeyframeControl(dom.selLightDistance, getSelected, 'distance');

  dom.selLightDecay?.addEventListener('input', (e) => {
    const l = sceneStore.selected;
    if (!l || (!l.isPointLight && !l.isSpotLight)) return;
    const v = Number(e.target.value);
    l.decay = v;
    if (dom.selLightDecayVal) dom.selLightDecayVal.textContent = v.toFixed(1);
  });
  bindAutoKeyframeControl(dom.selLightDecay, getSelected, 'decay');

  dom.selLightAngle?.addEventListener('input', (e) => {
    const l = sceneStore.selected;
    if (!l || !l.isSpotLight) return;
    const deg = Number(e.target.value);
    l.angle = deg * DEG2RAD;
    if (dom.selLightAngleVal) dom.selLightAngleVal.textContent = `${Math.round(deg)}°`;
  });
  bindAutoKeyframeControl(dom.selLightAngle, getSelected, 'angle');

  dom.selLightPenumbra?.addEventListener('input', (e) => {
    const l = sceneStore.selected;
    if (!l || !l.isSpotLight) return;
    const v = Number(e.target.value);
    l.penumbra = v;
    if (dom.selLightPenumbraVal) dom.selLightPenumbraVal.textContent = v.toFixed(2);
  });
  bindAutoKeyframeControl(dom.selLightPenumbra, getSelected, 'penumbra');

  dom.selLightShadows?.addEventListener('change', (e) => {
    const l = sceneStore.selected;
    if (!l || !l.isDirectionalLight) return;
    l.castShadow = e.target.checked;
    if (dom.selLightShadowSoft) dom.selLightShadowSoft.disabled = !l.castShadow;
    if (l === lighting.dirLight && dom.dirShadows) {
      dom.dirShadows.checked = l.castShadow;
      syncShadowResolutionUI();
    }
    recordAutoKeyframeIfNeeded([l], { properties: ['castShadow'] });
  });
  dom.selLightShadowSoft?.addEventListener('input', (e) => {
    const l = sceneStore.selected;
    if (!l || !l.isDirectionalLight || !l.shadow) return;
    const v = Number(e.target.value);
    l.shadow.radius = v;
    if (dom.selLightShadowSoftVal) dom.selLightShadowSoftVal.textContent = v.toFixed(2);
    if (l === lighting.dirLight && dom.dirShadowSoft) {
      dom.dirShadowSoft.value = String(v);
      syncRangeVisual(dom.dirShadowSoft);
      if (dom.dirShadowSoftVal) dom.dirShadowSoftVal.textContent = v.toFixed(2);
    }
  });
  bindAutoKeyframeControl(dom.selLightShadowSoft, getSelected, 'shadow.radius');

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
    cam.copyWorldTransformFrom(refCam);
    const afterState = snapshotLocal(cam);
    if (HistoryManager.hasTransformChanged(beforeState, afterState, { includePivot: false })) {
      history.runGrouped('Alinear cámara', () => {
        history.push({ type: 'transform', os: [cam], before: [beforeState], after: [afterState] });
        recordAutoKeyframeIfNeeded([cam], { beforeList: [beforeState], afterList: [afterState] });
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
  bindAutoKeyframeControl(dom.sceneCamFov, getSelected, 'fov');

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
  bindAutoKeyframeControl(dom.matColor, getSelected, 'material.color');

  dom.matShininess?.addEventListener('input', (e) => {
    const val = Number(e.target.value);
    dom.matShininessVal.textContent = String(val);
    forEachMat((mat) => {
      if (typeof mat.setShininess === 'function') mat.setShininess(val);
      else mat.shininess = val;
    });
  });
  bindAutoKeyframeControl(dom.matShininess, getSelected, 'material.shininess');

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
  bindAutoKeyframeControl(dom.matRoughness, getSelected, 'material.roughness');

  dom.matMetalness?.addEventListener('input', (e) => {
    const val = Number(e.target.value);
    if (dom.matMetalnessVal) dom.matMetalnessVal.textContent = val.toFixed(2);
    forEachMat((mat) => { if (mat.type === 'standard') mat.metalness = val; });
  });
  bindAutoKeyframeControl(dom.matMetalness, getSelected, 'material.metalness');

  dom.matNormalScale?.addEventListener('input', (e) => {
    const val = Number(e.target.value);
    if (dom.matNormalScaleVal) dom.matNormalScaleVal.textContent = val.toFixed(2);
    forEachMat((mat) => { if (mat.type === 'standard' && mat.normalScale) mat.normalScale.set(val, val); });
  });
  bindAutoKeyframeControl(dom.matNormalScale, getSelected, 'material.normalScale');

  dom.matAoIntensity?.addEventListener('input', (e) => {
    const val = Number(e.target.value);
    if (dom.matAoIntensityVal) dom.matAoIntensityVal.textContent = val.toFixed(2);
    forEachMat((mat) => { if (mat.type === 'standard') mat.aoMapIntensity = val; });
  });
  bindAutoKeyframeControl(dom.matAoIntensity, getSelected, 'material.aoMapIntensity');

  dom.matEnvIntensity?.addEventListener('input', (e) => {
    const val = Number(e.target.value);
    if (dom.matEnvIntensityVal) dom.matEnvIntensityVal.textContent = val.toFixed(2);
    forEachMat((mat) => { if (mat.type === 'standard') mat.envMapIntensity = val; });
  });
  bindAutoKeyframeControl(dom.matEnvIntensity, getSelected, 'material.envMapIntensity');

  {
    let pendingMapSlot = 'map';

    dom.matTexturePreset?.addEventListener('change', (e) => {
      const val = e.target.value;
      const target = sceneStore.selected;
      if (!target || val === 'custom') return;
      const tex = val === 'none' ? null : getTexturePreset(val);
      forEachMat((mat) => {
        if ('map' in mat) mat.map = tex;
      });
      syncSelectedUI();
      recordAutoKeyframeIfNeeded([target], { properties: ['material.map'] });
      setStatus(tex ? `Textura "${PRESET_TEX_NAMES[val] || val}" aplicada.` : 'Textura eliminada.');
    });

    dom.btnMatTextureUpload?.addEventListener('click', () => {
      if (!sceneStore.selected) return;
      pendingMapSlot = 'map';
      dom.matMapFileInput?.click();
    });

    dom.btnMatTextureClear?.addEventListener('click', () => {
      const target = sceneStore.selected;
      if (!target) return;
      forEachMat((mat) => {
        if ('map' in mat) mat.map = null;
      });
      syncSelectedUI();
      recordAutoKeyframeIfNeeded([target], { properties: ['material.map'] });
      setStatus('Textura eliminada.');
    });

    document.querySelectorAll('[data-mat-map]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!sceneStore.selected) return;
        pendingMapSlot = btn.dataset.matMap;
        dom.matMapFileInput?.click();
      });
    });
    document.querySelectorAll('[data-mat-map-clear]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = sceneStore.selected;
        if (!target) return;
        const slot = btn.dataset.matMapClear;
        forEachMat((mat) => {
          if (slot in mat && (mat.type === 'standard' || slot === 'map')) {
            mat[slot] = null;
          }
        });
        syncSelectedUI();
        recordAutoKeyframeIfNeeded([target], { properties: [`material.${slot}`] });
        setStatus(`Mapa "${slot}" eliminado.`);
      });
    });
    dom.matMapFileInput?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      const target = sceneStore.selected;
      if (!file || !target) return;
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
            name: file.name,
            userData: { customName: file.name },
          });
          tex.needsUpdate = true;
          target.collectMaterials?.().forEach((mat) => {
            if (slot in mat && (mat.type === 'standard' || slot === 'map')) {
              mat[slot] = tex;
              if (mat.type === 'standard' && slot !== 'map' && slot !== 'emissiveMap' && typeof mat.setHasPbr === 'function' && !mat.hasPbr) {
                mat.setHasPbr(true);
              }
              if (slot === 'emissiveMap' && mat.emissive && mat.emissive.r === 0 && mat.emissive.g === 0 && mat.emissive.b === 0) {
                mat.emissive.set(0xffffff);
              }
            }
          });
          if (sceneStore.selected === target) syncSelectedUI();
          recordAutoKeyframeIfNeeded([target], { properties: [`material.${slot}`] });
          setStatus(`Textura "${file.name}" aplicada${slot === 'map' ? '' : ` a ${slot}`}.`);
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
  bindAutoKeyframeControl(dom.matOpacity, getSelected, 'material.opacity');

  dom.matWireframe?.addEventListener('change', (e) => {
    const target = sceneStore.selected;
    if (!target) return;
    forEachMat((mat) => { mat.wireframe = e.target.checked; });
    recordAutoKeyframeIfNeeded([target], { properties: ['material.wireframe'] });
  });
  dom.objCastShadow?.addEventListener('change', (e) => {
    const target = sceneStore.selected;
    if (!target) return;
    target.setCastShadowRecursive(e.target.checked);
    recordAutoKeyframeIfNeeded([target], { properties: ['castShadow'] });
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
  bindAutoKeyframeControl(dom.matToonSteps, getSelected, 'material.steps');

  dom.matToonInk?.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    dom.matToonInkVal.textContent = v.toFixed(2);
    forEachMat((mat) => { if (mat.type === 'toon') mat.inkWidth = v; });
  });
  bindAutoKeyframeControl(dom.matToonInk, getSelected, 'material.inkWidth');

  dom.matToonRim?.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    dom.matToonRimVal.textContent = v.toFixed(2);
    forEachMat((mat) => { if (mat.type === 'toon') mat.rimStrength = v; });
  });
  bindAutoKeyframeControl(dom.matToonRim, getSelected, 'material.rimStrength');

  dom.matToonShadow?.addEventListener('input', (e) => {
    forEachMat((mat) => { if (mat.type === 'toon' && mat.shadowColor) mat.shadowColor.set(e.target.value); });
  });
  bindAutoKeyframeControl(dom.matToonShadow, getSelected, 'material.shadowColor');

  dom.matHoloDensity?.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    dom.matHoloDensityVal.textContent = String(v);
    forEachMat((mat) => { if (mat.type === 'hologram') mat.scanlineDensity = v; });
  });
  bindAutoKeyframeControl(dom.matHoloDensity, getSelected, 'material.scanlineDensity');

  dom.matHoloGlitch?.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    dom.matHoloGlitchVal.textContent = v.toFixed(2);
    forEachMat((mat) => { if (mat.type === 'hologram') mat.glitchStrength = v; });
  });
  bindAutoKeyframeControl(dom.matHoloGlitch, getSelected, 'material.glitchStrength');

  dom.matMatcapGloss?.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    dom.matMatcapGlossVal.textContent = v.toFixed(2);
    forEachMat((mat) => { if (mat.type === 'matcap') mat.glossiness = v; });
  });
  bindAutoKeyframeControl(dom.matMatcapGloss, getSelected, 'material.glossiness');

  dom.matMatcapMetal?.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    dom.matMatcapMetalVal.textContent = v.toFixed(2);
    forEachMat((mat) => { if (mat.type === 'matcap') mat.metalness = v; });
  });
  bindAutoKeyframeControl(dom.matMatcapMetal, getSelected, 'material.metalness');

  dom.matFresnelIntensity?.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    dom.matFresnelIntensityVal.textContent = v.toFixed(2);
    forEachMat((mat) => { if (mat.type === 'fresnel') mat.fresnelIntensity = v; });
  });
  bindAutoKeyframeControl(dom.matFresnelIntensity, getSelected, 'material.fresnelIntensity');

  dom.matFresnelIrid?.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    dom.matFresnelIridVal.textContent = v.toFixed(2);
    forEachMat((mat) => { if (mat.type === 'fresnel') mat.iridescence = v; });
  });
  bindAutoKeyframeControl(dom.matFresnelIrid, getSelected, 'material.iridescence');

  dom.matFresnelRim?.addEventListener('input', (e) => {
    forEachMat((mat) => { if (mat.type === 'fresnel' && mat.rimColor) mat.rimColor.set(e.target.value); });
  });
  bindAutoKeyframeControl(dom.matFresnelRim, getSelected, 'material.rimColor');

  dom.matDissolveAuto?.addEventListener('change', (e) => {
    const target = sceneStore.selected;
    const checked = e.target.checked;
    dom.rowDissolveProgress.hidden = checked;
    forEachMat((mat) => { if (mat.type === 'dissolve') mat.autoAnimate = checked; });
    if (target) recordAutoKeyframeIfNeeded([target], { properties: ['material.autoAnimate'] });
  });
  dom.matDissolveProgress?.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    dom.matDissolveProgressVal.textContent = v.toFixed(2);
    forEachMat((mat) => { if (mat.type === 'dissolve') mat.progress = v; });
  });
  bindAutoKeyframeControl(dom.matDissolveProgress, getSelected, 'material.progress');

  dom.matDissolveEdge?.addEventListener('input', (e) => {
    forEachMat((mat) => { if (mat.type === 'dissolve' && mat.edgeColor) mat.edgeColor.set(e.target.value); });
  });
  bindAutoKeyframeControl(dom.matDissolveEdge, getSelected, 'material.edgeColor');
}
