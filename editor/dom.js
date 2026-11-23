export const el = (id) => (typeof document !== 'undefined' ? document.getElementById(id) : null);

export const DEFAULT_HUD_HINT = '';
export const PIVOT_HUD_HINT = '';
export const SCULPT_HUD_HINT = '';
export const EDIT_HUD_HINT = '';
export const EDIT_CUT_KNIFE_HINT = '';
export const EDIT_CUT_LOOP_HINT = '';

export const dom = {
  viewportWrap: el('viewport-wrap'),
  canvas: el('viewport'),
  editOverlay: el('edit-overlay'),
  sculptOverlay: el('sculpt-overlay'),

  // Topbar & Popovers
  btnNavScene: el('btn-nav-scene'),
  btnNavObject: el('btn-nav-object'),
  btnNavMode: el('btn-nav-mode'),
  modeBtnLabel: el('mode-btn-label'),
  btnNavSettings: el('btn-nav-settings'),
  btnNavOutliner: el('btn-nav-outliner'),
  popoverBackdrop: el('popover-backdrop'),
  menuScene: el('menu-scene'),
  menuObject: el('menu-object'),
  menuMode: el('menu-mode'),
  menuSettings: el('menu-settings'),
  menuOutliner: el('menu-outliner'),
  btnCloseOutliner: el('btn-close-outliner'),
  btnExportSubToggle: el('btn-export-sub-toggle'),
  exportSubmenu: el('export-submenu'),

  // Edit Mode floating UI
  editSelBar: el('edit-sel-bar'),
  editToolBar: el('edit-tool-bar'),
  popEditExtrude: el('pop-edit-extrude'),
  btnEditExtrudeApply: el('btn-edit-extrude-apply'),
  editCutSubbar: el('edit-cut-subbar'),
  popEditSubdivide: el('pop-edit-subdivide'),
  btnEditSubdivideApply: el('btn-edit-subdivide-apply'),
  btnEditSmoothToggle: el('btn-edit-smooth-toggle'),
  popEditSmooth: el('pop-edit-smooth'),
  btnEditMergeToggle: el('btn-edit-merge-toggle'),
  popEditMerge: el('pop-edit-merge'),
  btnEditMergeMeshes: el('btn-edit-merge-meshes'),
  editMergeTargetsList: el('edit-merge-targets-list'),
  editWeldInterior: el('edit-weld-interior'),
  editWeldStitch: el('edit-weld-stitch'),
  editWeldRemesh: el('edit-weld-remesh'),
  editWeldSolidity: el('edit-weld-solidity'),
  editWeldSolidityNum: el('edit-weld-solidity-num'),
  editWeldSeamSmooth: el('edit-weld-seam-smooth'),
  editWeldSeamSmoothNum: el('edit-weld-seam-smooth-num'),
  btnEditMore: el('btn-edit-more'),
  popEditMore: el('pop-edit-more'),

  // Sculpt Mode floating UI
  sculptBrushBar: el('sculpt-brush-bar'),
  sculptParamsBar: el('sculpt-params-bar'),
  btnSculptMore: el('btn-sculpt-more'),
  popSculptMore: el('pop-sculpt-more'),
  undoRedoBar: el('undo-redo-bar'),

  // Gizmo XYZ mini-panel & Bottom Dock
  gizmoXyzPanel: el('gizmo-xyz-panel'),
  gizmoXyzTitle: el('gizmo-xyz-title'),
  btnGizmoXyzClose: el('btn-gizmo-xyz-close'),
  gizmoValX: el('gizmo-val-x'),
  gizmoValY: el('gizmo-val-y'),
  gizmoValZ: el('gizmo-val-z'),
  btnDockDuplicate: el('btn-dock-duplicate'),

  btnResetCam: el('btn-reset-camera'),
  btnImportModel: el('btn-import-model'),
  fileInput: el('model-file-input'),
  dropOverlay: el('drop-overlay'),
  webglFallback: el('webgl-fallback'),
  webglFallbackMsg: el('webgl-fallback-msg'),
  btnRetryWebgl: el('btn-retry-webgl'),
  gizmoReadout: el('gizmo-readout'),

  btnSpace: el('btn-space'),
  btnSnap: el('btn-snap'),
  btnEditPivot: el('btn-edit-pivot'),
  btnUndo: el('btn-undo'),
  btnRedo: el('btn-redo'),
  btnToolbarDelete: el('btn-toolbar-delete'),

  sculptMeshInfo: el('sculpt-mesh-info'),
  btnSculptNewClay: el('btn-sculpt-new-clay'),
  btnSculptSubdivide: el('btn-sculpt-subdivide'),
  btnSculptClayMat: el('btn-sculpt-clay-mat'),
  sculptRadius: el('sculpt-radius'),
  sculptRadiusVal: el('sculpt-radius-val'),
  sculptStrength: el('sculpt-strength'),
  sculptStrengthVal: el('sculpt-strength-val'),
  sculptFalloff: el('sculpt-falloff'),
  sculptSymmetry: el('sculpt-symmetry'),
  sculptInvert: el('sculpt-invert'),
  sculptFrontOnly: el('sculpt-front-only'),

  objectList: el('object-list'),
  btnClearScene: el('btn-clear-scene'),
  exportScope: el('export-scope'),
  btnExportGlb: el('btn-export-glb'),
  btnExportGltf: el('btn-export-gltf'),
  btnExportObj: el('btn-export-obj'),
  btnExportMtl: el('btn-export-mtl'),
  loaderStatus: el('loader-status'),

  animGroup: el('animation-group'),
  animSelect: el('anim-clip-select'),
  btnAnimPlay: el('btn-anim-play'),
  btnAnimReset: el('btn-anim-reset'),

  objectEmpty: el('object-empty'),
  objectEditor: el('object-editor'),
  selectedName: el('selected-name'),
  selectedType: el('selected-type'),
  gizmoStyleSelect: el('gizmo-style-select'),
  btnFocusObj: el('btn-focus-obj'),
  btnDuplicateObj: el('btn-duplicate-obj'),
  btnDeleteObj: el('btn-delete-obj'),

  btnInspectorEditPivot: el('btn-inspector-edit-pivot'),
  btnPivotCenter: el('btn-pivot-center'),
  btnPivotBase: el('btn-pivot-base'),
  btnPivotReset: el('btn-pivot-reset'),

  subsurfGroup: el('subsurf-group'),
  btnSubsurfDec: el('btn-subsurf-dec'),
  btnSubsurfInc: el('btn-subsurf-inc'),
  subsurfLevelVal: el('subsurf-level-val'),
  subsurfLevelBadge: el('subsurf-level-badge'),
  subsurfSmoothness: el('subsurf-smoothness'),
  subsurfSmoothnessNum: el('subsurf-smoothness-num'),
  subsurfShowCage: el('subsurf-show-cage'),
  subsurfAlwaysCage: el('subsurf-always-cage'),
  subsurfSmoothShading: el('subsurf-smooth-shading'),
  btnObjEnterEdit: el('btn-obj-enter-edit'),
  btnSubsurfApply: el('btn-subsurf-apply'),

  editMeshInfo: el('edit-mesh-info'),
  btnEditSelectAll: el('btn-edit-select-all'),
  btnEditInvert: el('btn-edit-invert'),
  btnEditClearSel: el('btn-edit-clear-sel'),
  btnEditMultiSelect: el('btn-edit-multi-select'),
  btnEditBoxSelect: el('btn-edit-box-select'),
  btnEditExtrude: el('btn-edit-extrude'),
  editExtrudeDist: el('edit-extrude-dist'),
  btnEditBevel: el('btn-edit-bevel'),
  editBevelWidth: el('edit-bevel-width'),
  editBevelSegments: el('edit-bevel-segments'),
  btnEditBridgeFill: el('btn-edit-bridge-fill'),
  btnEditMerge: el('btn-edit-merge'),
  editMergeDist: el('edit-merge-dist'),
  editCreaseRange: el('edit-crease-range'),
  editCreaseVal: el('edit-crease-val'),
  btnEditCutToggle: el('btn-edit-cut-toggle'),
  btnEditSubdivide: el('btn-edit-subdivide'),
  editSubdivideCuts: el('edit-subdivide-cuts'),
  btnEditDelete: el('btn-edit-delete'),
  btnEditSubsurfDec: el('btn-edit-subsurf-dec'),
  btnEditSubsurfInc: el('btn-edit-subsurf-inc'),
  editSubsurfVal: el('edit-subsurf-val'),
  editSubsurfBadge: el('edit-subsurf-badge'),
  editSubsurfSmoothness: el('edit-subsurf-smoothness'),
  editSubsurfSmoothnessNum: el('edit-subsurf-smoothness-num'),
  editSubsurfCage: el('edit-subsurf-cage'),
  editSubsurfAlwaysCage: el('edit-subsurf-always-cage'),
  editDensityBadge: el('edit-density-badge'),
  btnEditDensityDec: el('btn-edit-density-dec'),
  editDensityVal: el('edit-density-val'),
  btnEditDensityInc: el('btn-edit-density-inc'),
  editDensityScale: el('edit-density-scale'),
  editDensityScaleNum: el('edit-density-scale-num'),
  btnEditDensityApply: el('btn-edit-density-apply'),

  textGroup: el('text-group'),
  textContent: el('text-content'),
  textFont: el('text-font'),
  textBold: el('text-bold'),
  textItalic: el('text-italic'),
  textAlign: el('text-align'),
  textSize: el('text-size'),
  textSizeVal: el('text-size-val'),
  textDepth: el('text-depth'),
  textDepthVal: el('text-depth-val'),
  textSpacing: el('text-spacing'),
  textSpacingVal: el('text-spacing-val'),

  materialGroup: el('material-group'),
  matShaderType: el('mat-shader-type'),
  matColor: el('mat-color'),
  rowMatShininess: el('row-mat-shininess'),
  matShininess: el('mat-shininess'),
  matShininessVal: el('mat-shininess-val'),
  matPbrBlock: el('mat-pbr-block'),
  matPbr: el('mat-pbr'),
  matPbrControls: el('mat-pbr-controls'),
  matRoughness: el('mat-roughness'),
  matRoughnessVal: el('mat-roughness-val'),
  matMetalness: el('mat-metalness'),
  matMetalnessVal: el('mat-metalness-val'),
  matNormalScale: el('mat-normal-scale'),
  matNormalScaleVal: el('mat-normal-scale-val'),
  matAoIntensity: el('mat-ao-intensity'),
  matAoIntensityVal: el('mat-ao-intensity-val'),
  matEnvIntensity: el('mat-env-intensity'),
  matEnvIntensityVal: el('mat-env-intensity-val'),
  matMapsSection: el('mat-maps-section'),
  matMapFileInput: el('mat-map-file-input'),
  matOpacity: el('mat-opacity'),
  matOpacityVal: el('mat-opacity-val'),
  matTexture: el('mat-texture'),
  matWireframe: el('mat-wireframe'),
  objCastShadow: el('obj-cast-shadow'),
  objAutoSpin: el('obj-auto-spin'),
  shaderParams: el('shader-params'),
  matToonSteps: el('mat-toon-steps'),
  matToonStepsVal: el('mat-toon-steps-val'),
  matToonInk: el('mat-toon-ink'),
  matToonInkVal: el('mat-toon-ink-val'),
  matToonRim: el('mat-toon-rim'),
  matToonRimVal: el('mat-toon-rim-val'),
  matToonShadow: el('mat-toon-shadow'),
  matHoloDensity: el('mat-holo-density'),
  matHoloDensityVal: el('mat-holo-density-val'),
  matHoloGlitch: el('mat-holo-glitch'),
  matHoloGlitchVal: el('mat-holo-glitch-val'),
  matMatcapGloss: el('mat-matcap-gloss'),
  matMatcapGlossVal: el('mat-matcap-gloss-val'),
  matMatcapMetal: el('mat-matcap-metal'),
  matMatcapMetalVal: el('mat-matcap-metal-val'),
  matFresnelIntensity: el('mat-fresnel-intensity'),
  matFresnelIntensityVal: el('mat-fresnel-intensity-val'),
  matFresnelIrid: el('mat-fresnel-irid'),
  matFresnelIridVal: el('mat-fresnel-irid-val'),
  matFresnelRim: el('mat-fresnel-rim'),
  matDissolveAuto: el('mat-dissolve-auto'),
  rowDissolveProgress: el('row-dissolve-progress'),
  matDissolveProgress: el('mat-dissolve-progress'),
  matDissolveProgressVal: el('mat-dissolve-progress-val'),
  matDissolveEdge: el('mat-dissolve-edge'),

  lightObjGroup: el('light-obj-group'),
  selLightColor: el('sel-light-color'),
  selLightIntensity: el('sel-light-intensity'),
  selLightIntensityVal: el('sel-light-intensity-val'),
  selLightPointFields: el('sel-light-point-fields'),
  selLightDistance: el('sel-light-distance'),
  selLightDistanceVal: el('sel-light-distance-val'),
  selLightDecay: el('sel-light-decay'),
  selLightDecayVal: el('sel-light-decay-val'),
  selLightDirFields: el('sel-light-dir-fields'),
  selLightShadows: el('sel-light-shadows'),
  selLightShadowSoft: el('sel-light-shadow-soft'),
  selLightShadowSoftVal: el('sel-light-shadow-soft-val'),

  envPreset: el('env-preset'),
  envIntensity: el('env-intensity'),
  envIntensityVal: el('env-intensity-val'),
  btnEnvUpload: el('btn-env-upload'),
  btnEnvClear: el('btn-env-clear'),
  envFileInput: el('env-file-input'),

  dirIntensity: el('dir-intensity'),
  dirIntensityVal: el('dir-intensity-val'),
  dirColor: el('dir-color'),
  dirShadows: el('dir-shadows'),
  dirShadowRes: el('dir-shadow-res'),
  dirShadowResVal: el('dir-shadow-res-val'),
  dirShadowSoft: el('dir-shadow-soft'),
  dirShadowSoftVal: el('dir-shadow-soft-val'),
  dirOrbit: el('dir-orbit'),
  pointIntensity: el('point-intensity'),
  pointIntensityVal: el('point-intensity-val'),
  pointColor: el('point-color'),
  ambIntensity: el('amb-intensity'),
  ambIntensityVal: el('amb-intensity-val'),
  fogEnabled: el('fog-enabled'),
  fogFar: el('fog-far'),
  fogFarVal: el('fog-far-val'),
  bgColor: el('bg-color'),
  gridVisible: el('grid-visible'),
  floorVisible: el('floor-visible'),
  cameraType: el('camera-type'),
  fovRow: el('fov-row'),
  cameraFov: el('camera-fov'),
  cameraFovVal: el('camera-fov-val'),
  renderQuality: el('render-quality'),
  renderBackend: el('render-backend'),

  cameraViewfinder: el('camera-viewfinder'),
  vfMaskTop: el('vf-mask-top'),
  vfMaskBottom: el('vf-mask-bottom'),
  vfMaskLeft: el('vf-mask-left'),
  vfMaskRight: el('vf-mask-right'),
  vfFrame: el('vf-frame'),
  vfThirds: el('vf-thirds'),
  vfLabel: el('vf-label'),
  btnVfRender: el('btn-vf-render'),
  btnVfVideo: el('btn-vf-video'),
  btnVfLock: el('btn-vf-lock'),
  btnVfExit: el('btn-vf-exit'),
  recIndicator: el('rec-indicator'),
  recIndicatorText: el('rec-indicator-text'),

  cameraGroup: el('camera-group'),
  btnCamEnter: el('btn-cam-enter'),
  btnCamAlign: el('btn-cam-align'),
  sceneCamFov: el('scene-cam-fov'),
  sceneCamFovVal: el('scene-cam-fov-val'),
  sceneCamPreset: el('scene-cam-preset'),
  sceneCamWidth: el('scene-cam-width'),
  sceneCamHeight: el('scene-cam-height'),
  sceneCamFormat: el('scene-cam-format'),
  sceneCamThirds: el('scene-cam-thirds'),
  sceneCamIncludeGrid: el('scene-cam-include-grid'),
  sceneCamLock: el('scene-cam-lock'),
  btnCamRender: el('btn-cam-render'),
  sceneCamFps: el('scene-cam-fps'),
  sceneCamDuration: el('scene-cam-duration'),
  sceneCamVideoFormat: el('scene-cam-video-format'),
  sceneCamVideoMode: el('scene-cam-video-mode'),
  btnCamVideo: el('btn-cam-video'),
};

let _statusTimer = 0;
export function setStatus(msg, isError = false) {
  if (!dom.loaderStatus) return;
  clearTimeout(_statusTimer);
  if (!msg) {
    dom.loaderStatus.hidden = true;
    dom.loaderStatus.textContent = '';
    return;
  }
  dom.loaderStatus.hidden = false;
  dom.loaderStatus.textContent = msg;
  dom.loaderStatus.style.color = isError ? '#fca5a5' : '#fde68a';
  _statusTimer = setTimeout(() => {
    if (dom.loaderStatus) {
      dom.loaderStatus.hidden = true;
    }
  }, isError ? 5200 : 3800);
}

/**
 * Une clic simple + doble tap (ratón y táctil) sin disparos dobles.
 * Si waitSingle = true, espera a descartar el segundo tap antes de ejecutar onSingle.
 */
export function bindDoubleTap(button, onSingle, onDouble, { delayMs = 270, waitSingle = false, beforeTap = null } = {}) {
  if (!button) return;
  let lastTapAt = 0;
  let singleTimer = 0;
  button.addEventListener('click', (e) => {
    if (beforeTap && beforeTap(e) === true) {
      lastTapAt = 0;
      clearTimeout(singleTimer);
      return;
    }
    const now = performance.now();
    const isDouble = now - lastTapAt <= delayMs;
    if (isDouble) {
      lastTapAt = 0;
      clearTimeout(singleTimer);
      onDouble?.(e);
      return;
    }
    lastTapAt = now;
    if (waitSingle) {
      clearTimeout(singleTimer);
      singleTimer = setTimeout(() => {
        onSingle?.(e);
      }, delayMs);
    } else {
      onSingle?.(e);
    }
  });
}

export function showFallback(message) {
  if (dom.webglFallbackMsg) dom.webglFallbackMsg.textContent = message;
  if (dom.webglFallback) dom.webglFallback.hidden = false;
}

export function hideFallback() {
  if (dom.webglFallback) dom.webglFallback.hidden = true;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function updateReadout(gizmo) {
  if (!dom.gizmoReadout) return;
  if (!gizmo || !gizmo.drag || !gizmo.info.text) {
    dom.gizmoReadout.hidden = true;
    return;
  }
  dom.gizmoReadout.hidden = false;
  dom.gizmoReadout.textContent = gizmo.info.text;
}
