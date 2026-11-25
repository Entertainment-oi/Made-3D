import {
  Scene,
  Fog,
  PerspectiveCamera,
  OrthographicCamera,
  Renderer,
  OrbitControls,
  PlaneGeometry,
  StandardMaterial,
  Mesh,
  AmbientLight,
  DirectionalLight,
  PointLight,
  Picker,
  Vec3,
  Color,
  computeBounds,
} from '../made3d.module.js';
import { GridHelper } from '../src/modules/helpers.js';
import { GizmoMade3d, GizmoClassic } from '../src/modules/gizmo.js';
import { MeshEditor } from '../src/modules/modeling.js';
import {
  dom,
  setStatus,
  showFallback,
  hideFallback,
  updateReadout,
} from './dom.js';
import {
  viewport,
  sceneStore,
  lighting,
  cameraView,
  sculpt,
  edit,
  cloneLocalState,
} from './store.js';
import { history } from './history.js';
import { updateViewfinderOverlay, exitCameraView } from './cameraView.js';
import { syncSculptUI, setSculptMode } from './sculptController.js';
import { setEditMode, syncEditUI } from './editController.js';
import { syncSelectedUI, syncGizmoXyzPanel, syncViewCameraQuickBtn, renderObjectList } from './inspectorUI.js';
import { recordAutoKeyframeIfNeeded, syncAnimationUI, syncAnimationHeader } from './animationController.js';

export function resizeRenderer() {
  if (!viewport.renderer || !dom.viewportWrap) return;
  const rect = dom.viewportWrap.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width));
  const h = Math.max(1, Math.floor(rect.height));
  viewport.renderer.setSize(w, h, false);
  const aspect = w / h;
  if (viewport.perspCam) {
    viewport.perspCam.aspect = aspect;
    viewport.perspCam.updateProjection();
  }
  if (viewport.orthoCam) {
    const hh = Math.max(0.05, (viewport.orthoCam.top - viewport.orthoCam.bottom) * 0.5 || viewport.orthoHalfH);
    viewport.orthoCam.left = -hh * aspect;
    viewport.orthoCam.right = hh * aspect;
    viewport.orthoCam.top = hh;
    viewport.orthoCam.bottom = -hh;
    viewport.orthoCam.updateProjection();
  }
  if (cameraView.activeSceneCam) {
    updateViewfinderOverlay();
  }
}

export function syncShadowResolutionUI() {
  if (!lighting.dirLight || !viewport.renderer || !dom.dirShadowRes) return;
  const enabled = Boolean(lighting.dirLight.castShadow);
  const eff = enabled ? viewport.renderer.getShadowMapSize(lighting.dirLight) : 0;
  if (dom.dirShadowResVal) {
    dom.dirShadowResVal.textContent = enabled ? `${eff} px` : 'Off';
  }
  dom.dirShadowRes.disabled = !enabled;
  if (dom.dirShadowSoft) dom.dirShadowSoft.disabled = !enabled;
}

export function syncCameraHelperSelection() {
  if (!viewport.scene) return;
  viewport.scene.traverse((n) => {
    if (n.isCameraHelper && typeof n.setSelected === 'function') {
      n.setSelected(Boolean(sceneStore.selected && n.camera === sceneStore.selected));
    }
  });
}

export function selectObject(obj) {
  if (dom.gizmoReadout) dom.gizmoReadout.hidden = true;
  sceneStore.selected = obj || null;
  sceneStore.selectedList = obj ? [obj] : [];
  if (edit.active) {
    if (obj && MeshEditor.isEditable(obj)) {
      if (edit.editor.mesh !== obj) edit.editor.setMesh(obj);
    } else {
      setEditMode(false);
    }
  }
  if (viewport.gizmo) {
    viewport.gizmo.setMultiSelectMode?.(false);
    viewport.gizmo.attach(obj || null);
    viewport.gizmo.visible = !sculpt.active && !edit.active && !(cameraView.activeSceneCam && obj === cameraView.activeSceneCam);
  }
  syncCameraHelperSelection();
  syncSelectedUI();
  syncSculptUI();
  syncEditUI();
  syncGizmoXyzPanel();
  syncViewCameraQuickBtn();
  syncAnimationUI();
  renderObjectList();
}

export function resetCamera() {
  if (cameraView.activeSceneCam) {
    exitCameraView({ restoreSnapshot: false });
  }
  viewport.camera.position.set(6.5, 4.8, 8.2);
  viewport.controls.target.set(0, 0.8, 0);
  viewport.controls.syncFromCamera();
}

export function focusOnObject(obj) {
  if (!obj) return;
  if (cameraView.activeSceneCam) {
    exitCameraView({ restoreSnapshot: false });
  }
  obj.updateWorldMatrix(true, true);
  const bounds = obj.isCamera || obj.isLight ? null : computeBounds(obj);
  const center = bounds && !bounds.empty ? bounds.center : obj.getWorldPosition(new Vec3());
  const radius = bounds && !bounds.empty ? Math.max(0.8, bounds.radius) : 1.4;
  viewport.controls.target.copy(center);
  const dir = new Vec3().copy(viewport.camera.position).sub(center);
  if (dir.lengthSq() < 1e-4) dir.set(1, 0.7, 1);
  dir.normalize().multiplyScalar(radius * 2.8);
  viewport.camera.position.copy(center).add(dir);
  viewport.controls.syncFromCamera();
}

export function syncEditPivotUI() {
  const on = Boolean(viewport.gizmo && viewport.gizmo.editPivot);
  if (dom.btnEditPivot) {
    dom.btnEditPivot.textContent = on ? 'Pivote: On' : 'Pivote: Off';
    dom.btnEditPivot.classList.toggle('is-active', on);
  }
  if (dom.btnInspectorEditPivot) {
    dom.btnInspectorEditPivot.classList.toggle('is-active', on);
    dom.btnInspectorEditPivot.textContent = on ? 'Salir editar pivote' : 'Editar pivote en visor';
  }
}

export function syncGizmoSpaceUI(space = viewport.gizmo?.space || edit.editor?.space || 'world') {
  const normalized = space === 'local' ? 'local' : 'world';
  if (dom.btnSpace) {
    dom.btnSpace.textContent = normalized === 'world' ? 'Espacio: Mundo' : 'Espacio: Local';
    dom.btnSpace.classList.toggle('is-active', normalized === 'local');
  }
  return normalized;
}

export function buildGizmo(style) {
  const prevMode = viewport.gizmo ? viewport.gizmo.mode : 'translate';
  const prevSpace = viewport.gizmo ? viewport.gizmo.space : 'world';
  const prevEditPivot = viewport.gizmo ? viewport.gizmo.editPivot : false;
  const prevAttached = viewport.gizmo ? viewport.gizmo.objects.slice() : [];
  if (viewport.gizmo) {
    viewport.gizmo.dispose();
  }

  const GizmoCtor = style === 'classic' ? GizmoClassic : GizmoMade3d;
  const gizmo = new GizmoCtor(viewport.camera, viewport.renderer.domElement, {
    controls: viewport.controls,
    picker: viewport.picker,
    selectionRoot: viewport.scene,
    mode: prevMode,
    space: prevSpace,
    editPivot: prevEditPivot,
    trackHistory: false,
  });
  gizmo.setSnap(viewport.snapOn);

  gizmo.addEventListener('editPivotChange', () => {
    syncEditPivotUI();
  });

  gizmo.addEventListener('spaceChange', ({ value }) => {
    edit.editor.setSpace(value);
    syncGizmoSpaceUI(value);
  });

  gizmo.addEventListener('multiSelectChange', (e) => {
    if (e?.value ?? e?.enabled) {
      setStatus('Multi-selección activa (amarillo). Toca más objetos o el vacío para salir.');
    }
    syncSelectedUI();
    renderObjectList();
  });

  gizmo.addEventListener('select', (e) => {
    const list = gizmo.objects ? gizmo.objects.slice() : [];
    sceneStore.selectedList = list;
    sceneStore.selected = e.object || (list.length ? list[list.length - 1] : null);
    if (cameraView.activeSceneCam) {
      gizmo.visible = sceneStore.selected !== cameraView.activeSceneCam;
    } else {
      gizmo.visible = true;
    }
    syncCameraHelperSelection();
    syncSelectedUI();
    syncEditUI();
    syncGizmoXyzPanel();
    syncViewCameraQuickBtn();
    syncAnimationUI();
    renderObjectList();
  });

  gizmo.addEventListener('pick', (e) => {
    const hit = e.hit;
    if (!hit) return;
    if (hit.type === 'bone' && hit.bone) {
      const cands = hit.candidates || [hit.bone];
      const name = hit.bone.name || `Hueso #${hit.bone.id}`;
      if (cands.length > 1) {
        const idx = cands.indexOf(hit.bone) + 1;
        setStatus(`Hueso: ${name} (${idx}/${cands.length} superpuestos)`);
      } else {
        setStatus(`Hueso seleccionado: ${name}`);
      }
    } else if (hit.type === 'light' && hit.object) {
      setStatus(`Luz seleccionada: ${hit.object.name || 'Luz'}`);
    } else if (hit.type === 'camera' && hit.object) {
      setStatus(`Cámara seleccionada: ${hit.object.name || 'Cámara'}`);
    }
  });

  gizmo.addEventListener('objectChange', () => {
    syncGizmoXyzPanel();
  });

  gizmo.addEventListener('dragstart', () => {
    updateReadout(gizmo);
  });

  gizmo.addEventListener('drag', () => {
    updateReadout(gizmo);
  });

  gizmo.addEventListener('dragend', (e) => {
    if (dom.gizmoReadout) dom.gizmoReadout.hidden = true;
    if (e && e.os && e.before && e.after) {
      history.runGrouped('Transformar', () => {
        history.push({
          type: 'transform',
          os: e.os.slice(),
          before: e.before.map(cloneLocalState),
          after: e.after.map(cloneLocalState),
        });
        recordAutoKeyframeIfNeeded(e.os, { beforeList: e.before, afterList: e.after });
      });
    }
    history.updateButtons();
  });

  viewport.gizmo = gizmo;
  viewport.gizmoStyle = style;
  viewport.scene.add(gizmo);
  if (cameraView.activeSceneCam && cameraView.viewCam) {
    gizmo.camera = cameraView.viewCam;
  }
  if (prevAttached.length) {
    gizmo.attach(prevAttached);
    sceneStore.selectedList = prevAttached.slice();
  }
  if (cameraView.activeSceneCam) {
    gizmo.visible = sceneStore.selected !== cameraView.activeSceneCam;
    gizmo.deselectOnEscape = false;
  }
  if (sculpt.active || edit.active) {
    gizmo.enabled = false;
    gizmo.visible = false;
  }
  const activeMode = edit.active ? edit.editor.transformMode : gizmo.mode;
  document.querySelectorAll('.seg-btn[data-mode]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.mode === activeMode);
  });
  syncEditPivotUI();
  syncGizmoSpaceUI(gizmo.space);
  history.updateButtons();
}

export function setGizmoStyle(style) {
  if (dom.gizmoReadout) dom.gizmoReadout.hidden = true;
  buildGizmo(style);
  if (dom.gizmoStyleSelect) dom.gizmoStyleSelect.value = style;
}

export function setGizmoMode(mode) {
  if (sculpt.active) setSculptMode(false);
  if (edit.active) {
    edit.editor.setTransformMode(mode);
    document.querySelectorAll('.seg-btn[data-mode]').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.mode === mode);
    });
    syncEditUI();
    syncGizmoXyzPanel();
    return;
  }
  if (viewport.gizmo) {
    if (viewport.gizmo.editPivot) viewport.gizmo.setEditPivot(false);
    viewport.gizmo.setMode(mode);
  }
  document.querySelectorAll('.seg-btn[data-mode]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.mode === mode);
  });
  syncEditPivotUI();
  syncGizmoXyzPanel();
  syncAnimationHeader();
}

export function setEditPivotMode(on) {
  if (sculpt.active && on) setSculptMode(false);
  if (edit.active && on) setEditMode(false);
  const next = Boolean(on);
  if (viewport.gizmo) viewport.gizmo.setEditPivot(next);
  syncEditPivotUI();
}

export async function initEngine(backendPref = 'auto') {
  try {
    const renderer = await Renderer.create({
      canvas: dom.canvas,
      backend: backendPref,
      quality: 'auto',
      antialias: true,
    });
    renderer.onContextLost = () => {
      showFallback('Se perdió el contexto gráfico. Puedes reintentar o recargar la página.');
    };
    renderer.onContextRestored = () => {
      hideFallback();
    };
    viewport.renderer = renderer;
    viewport.ktx2Loader = null;
    viewport.dracoLoader = null;
  } catch (err) {
    showFallback(err && err.message ? err.message : 'No se pudo crear el contexto gráfico (WebGPU / WebGL2).');
    return false;
  }

  const scene = new Scene();
  scene.background = new Color(lighting.fogColorHex);
  scene.fog = new Fog(lighting.fogColorHex, 10, lighting.fogFar);
  viewport.scene = scene;

  const rect = dom.viewportWrap.getBoundingClientRect();
  const aspect = Math.max(1, rect.width) / Math.max(1, rect.height);
  viewport.perspCam = new PerspectiveCamera(50, aspect, 0.05, 800);
  viewport.perspCam.position.set(6.5, 4.8, 8.2);

  viewport.orthoCam = new OrthographicCamera(
    -viewport.orthoHalfH * aspect,
    viewport.orthoHalfH * aspect,
    viewport.orthoHalfH,
    -viewport.orthoHalfH,
    0.05,
    800
  );
  viewport.orthoCam.position.copy(viewport.perspCam.position);

  viewport.camera = viewport.perspCam;

  const controls = new OrbitControls(viewport.camera, viewport.renderer.domElement);
  controls.target.set(0, 0.8, 0);
  controls.minDistance = 0.05;
  controls.maxDistance = 400;
  controls.zoomSpeed = 1.8;
  controls.rotateSpeed = 1.15;
  controls.panSpeed = 1.15;
  controls.dampingFactor = 0.18;
  controls.update();
  viewport.controls = controls;

  const picker = new Picker(viewport.renderer.domElement);
  viewport.picker = picker;

  const grid = new GridHelper(28, 28, 0x575049, 0x2a2621, { opacity: 0.7 });
  grid.position.y = 0.002;
  grid.pickable = false;
  grid.exportable = false;
  scene.add(grid);
  sceneStore.grid = grid;

  const floorGeo = new PlaneGeometry(40, 40);
  const floorMat = new StandardMaterial({ color: 0x1c1a17, shininess: 8 });
  const floor = new Mesh(floorGeo, floorMat);
  floor.name = 'Piso';
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  floor.castShadow = false;
  floor.pickable = false;
  floor.exportable = false;
  floor.isFloor = true;
  scene.add(floor);
  sceneStore.floor = floor;

  const ambient = new AmbientLight(0xb8c7e0, 0.35);
  scene.add(ambient);
  lighting.ambientLight = ambient;

  const dir = new DirectionalLight(0xfff3df, 1.2);
  dir.name = 'Luz direccional 1';
  dir.position.set(7, 10, 6);
  dir.target.set(0, 0, 0);
  dir.castShadow = true;
  dir.shadow.mapSize = 1024;
  dir.shadow.bias = 0.002;
  dir.shadow.radius = 1.25;
  dir.shadow.camera = { left: -9, right: 9, top: 9, bottom: -9, near: 0.5, far: 36 };
  scene.add(dir);
  lighting.dirLight = dir;

  const point = new PointLight(0x5ea3ff, 6, 12, 2);
  point.name = 'Luz puntual 1';
  point.position.set(-4.5, 3.2, -3.5);
  scene.add(point);
  lighting.pointLight = point;

  buildGizmo('made3d');
  resizeRenderer();
  syncShadowResolutionUI();

  const ro = new ResizeObserver(() => resizeRenderer());
  ro.observe(dom.viewportWrap);
  window.addEventListener('resize', resizeRenderer);

  return true;
}

export async function switchRenderBackend(backendPref = 'auto') {
  if (!dom.viewportWrap || !dom.canvas) return null;
  const oldRenderer = viewport.renderer;
  const oldCanvas = dom.canvas;
  const nextCanvas = document.createElement('canvas');
  nextCanvas.id = oldCanvas.id || 'viewport';
  nextCanvas.tabIndex = oldCanvas.tabIndex;

  const quality = oldRenderer ? oldRenderer.quality : 'auto';
  const clearColor = oldRenderer ? oldRenderer.clearColor.slice() : [0.05, 0.05, 0.07];
  const colorSpace = oldRenderer ? oldRenderer.colorSpace : 'srgb';

  const rect = dom.viewportWrap.getBoundingClientRect();
  nextCanvas.width = Math.max(1, Math.floor(rect.width));
  nextCanvas.height = Math.max(1, Math.floor(rect.height));

  const nextRenderer = await Renderer.create({
    canvas: nextCanvas,
    backend: backendPref,
    quality,
    colorSpace,
    antialias: true,
  });
  nextRenderer.clearColor = clearColor;
  nextRenderer.onContextLost = () => {
    showFallback('Se perdió el contexto gráfico. Puedes reintentar o recargar la página.');
  };
  nextRenderer.onContextRestored = () => {
    hideFallback();
  };

  const prevCtrl = viewport.controls;
  const ctrlCam = prevCtrl?.camera || viewport.camera;
  if (prevCtrl) prevCtrl.dispose();
  if (viewport.gizmo) viewport.gizmo.dispose();
  if (oldRenderer) oldRenderer.dispose();

  oldCanvas.replaceWith(nextCanvas);
  dom.canvas = nextCanvas;
  viewport.renderer = nextRenderer;
  if (viewport.ktx2Loader) {
    viewport.ktx2Loader.detectSupport(nextRenderer);
  }

  const nextCtrl = new OrbitControls(ctrlCam, nextCanvas);
  if (prevCtrl) nextCtrl.copySettingsFrom(prevCtrl);
  nextCtrl.enabled = !(cameraView.activeSceneCam && cameraView.camViewLocked);
  nextCtrl.update();
  viewport.controls = nextCtrl;

  if (viewport.picker) viewport.picker.dom = nextCanvas;
  viewport.scene?.invalidateMaterials();

  buildGizmo(viewport.gizmoStyle || 'made3d');
  resizeRenderer();
  syncShadowResolutionUI();
  hideFallback();
  return nextRenderer;
}
