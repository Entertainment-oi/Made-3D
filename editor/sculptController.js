import { SphereGeometry, Mesh, HistoryManager } from '../made3d.module.js';
import { MatcapMaterial } from '../src/modules/stylized.js';
import { Sculptor, subdivideGeometry } from '../src/modules/sculpt.js';
import { dom, setStatus } from './dom.js';
import {
  viewport,
  sceneStore,
  cameraView,
  sculpt,
  edit,
  rig,
  paint,
} from './store.js';
import { history } from './history.js';
import { selectObject, focusOnObject } from './viewport.js';
import { exitCameraView } from './cameraView.js';
import { registerUserObject } from './sceneActions.js';
import { syncSelectedUI, syncAppModeUI, syncGizmoXyzPanel, renderObjectList } from './inspectorUI.js';
import { setEditMode, syncEditUI } from './editController.js';
import { syncRangeVisual } from './ui/rangeControls.js';

export function getSculptTargets() {
  if (Sculptor.isSculptable(sceneStore.selected)) return [sceneStore.selected];
  if (sceneStore.selected) {
    const parts = sceneStore.selected.collectMeshes({ includeSelf: true }).filter(Sculptor.isSculptable);
    if (parts.length) return parts;
  }
  const all = [];
  for (const root of sceneStore.userObjects) {
    all.push(...root.collectMeshes({ includeSelf: true }).filter(Sculptor.isSculptable));
  }
  return all;
}

export function getSculptPrimaryMesh() {
  if (Sculptor.isSculptable(sceneStore.selected)) return sceneStore.selected;
  if (sceneStore.selected) {
    const parts = sceneStore.selected.collectMeshes({ includeSelf: true }).filter(Sculptor.isSculptable);
    if (parts.length) return parts[0];
  }
  const all = getSculptTargets();
  return all.length ? all[0] : null;
}

export function syncSculptUI() {
  const active = Boolean(sculpt.active);
  if (dom.sculptBrushBar) dom.sculptBrushBar.hidden = !active;
  if (dom.sculptParamsBar) dom.sculptParamsBar.hidden = !active;
  if (!active && dom.popSculptMore) {
    dom.popSculptMore.hidden = true;
    dom.btnSculptMore?.classList.remove('is-active');
  }

  document.querySelectorAll('[data-sculpt-tool]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.sculptTool === sculpt.sculptor.tool);
  });

  if (dom.sculptRadius) {
    dom.sculptRadius.value = sculpt.sculptor.radius;
    syncRangeVisual(dom.sculptRadius);
    if (dom.sculptRadiusVal) dom.sculptRadiusVal.textContent = sculpt.sculptor.radius.toFixed(2);
  }
  if (dom.sculptStrength) {
    dom.sculptStrength.value = sculpt.sculptor.strength;
    syncRangeVisual(dom.sculptStrength);
    if (dom.sculptStrengthVal) dom.sculptStrengthVal.textContent = sculpt.sculptor.strength.toFixed(2);
  }
  if (dom.sculptFalloff) dom.sculptFalloff.value = sculpt.sculptor.falloff;
  if (dom.sculptSymmetry) dom.sculptSymmetry.value = sculpt.sculptor.symmetry;
  if (dom.sculptInvert) dom.sculptInvert.checked = sculpt.sculptor.invert;
  if (dom.sculptFrontOnly) dom.sculptFrontOnly.checked = sculpt.sculptor.frontFacesOnly;

  const targetMesh = getSculptPrimaryMesh();
  if (dom.btnSculptSubdivide) dom.btnSculptSubdivide.disabled = !targetMesh;
  if (dom.btnSculptClayMat) dom.btnSculptClayMat.disabled = !targetMesh;

  if (dom.sculptMeshInfo) {
    if (targetMesh && targetMesh.geometry?.attributes?.position) {
      const { vertices: verts, triangles: tris } = targetMesh.geometry.getStats();
      dom.sculptMeshInfo.innerHTML =
        `<strong>${targetMesh.name || `Malla #${targetMesh.id}`}</strong><br>` +
        `${verts.toLocaleString('es-ES')} vértices · ${tris.toLocaleString('es-ES')} triángulos`;
    } else {
      dom.sculptMeshInfo.textContent = 'Pulsa "+ Esfera" para esculpir.';
    }
  }
}

export function commitSculptStroke() {
  return sculpt.sculptor.commitStroke();
}

export function setSculptMode(enabled) {
  const next = Boolean(enabled);
  const wasActive = sculpt.active;
  if (next && cameraView.activeSceneCam) {
    exitCameraView();
  }
  if (next && edit.active) {
    setEditMode(false);
  }
  if (next && rig.active) {
    history._hooks.setRigMode?.(false);
  }
  if (next && paint.active) {
    history._hooks.setPaintMode?.(false);
  }
  if (viewport.gizmo?.drag) {
    viewport.gizmo.cancel();
    if (dom.gizmoReadout) dom.gizmoReadout.hidden = true;
  }

  if (next && !Sculptor.isSculptable(sceneStore.selected)) {
    const candidate = getSculptPrimaryMesh();
    if (candidate) {
      sceneStore.selected = candidate;
      sceneStore.selectedList = [candidate];
      if (viewport.gizmo) viewport.gizmo.attach(candidate);
      renderObjectList();
      syncSelectedUI();
    }
  }

  sculpt.active = next;
  sculpt.sculptor.setEnabled(next);

  if (viewport.controls) {
    viewport.controls.enabled = !(cameraView.activeSceneCam && cameraView.camViewLocked);
  }
  if (viewport.gizmo) {
    const rigHidingGizmo = rig.active && (rig.rigger.boneTool || rig.rigger.weightPaint);
    viewport.gizmo.enabled = !next && !edit.active && !paint.active && !rigHidingGizmo;
    viewport.gizmo.visible = !next && !edit.active && !paint.active && !rigHidingGizmo && !(cameraView.activeSceneCam && sceneStore.selected === cameraView.activeSceneCam);
  }

  if (dom.sculptOverlay) {
    dom.sculptOverlay.hidden = !next;
    if (!next) {
      const ctx = dom.sculptOverlay.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, dom.sculptOverlay.width, dom.sculptOverlay.height);
    }
  }
  dom.viewportWrap?.classList.toggle('is-sculpt-cursor', next);

  const nextMode = next
    ? 'modelar'
    : edit.active
    ? 'edicion'
    : paint.active
    ? 'pintar'
    : rig.active
    ? 'esqueleto'
    : !wasActive && viewport.appMode === 'animacion'
    ? 'animacion'
    : 'pose';
  syncAppModeUI(nextMode);
  syncSculptUI();
  syncGizmoXyzPanel();
}

export function addClaySphere(opts = {}) {
  const geo = new SphereGeometry(0.95, 64, 48);
  const mat = new MatcapMaterial({
    color: opts.color ?? 0xd97757,
    glossiness: 0.48,
    metalness: 0.12,
  });
  const mesh = new Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  if (opts.position) {
    mesh.position.set(opts.position[0], opts.position[1], opts.position[2]);
  } else {
    mesh.position.set(0, 0, 0);
  }

  const name = opts.name || `Arcilla ${sceneStore.objectCounter + 1}`;
  registerUserObject(mesh, name, opts.recordHistory !== false);
  selectObject(mesh);
  focusOnObject(mesh);
  if (opts.enterSculpt !== false) {
    setSculptMode(true);
  }
  setStatus(`Esfera de arcilla creada (${geo.attributes.position.count.toLocaleString('es-ES')} vértices).`);
  return mesh;
}

export function subdivideSelectedMesh() {
  const mesh = getSculptPrimaryMesh();
  if (!mesh || !mesh.geometry) {
    setStatus('Selecciona o crea una malla para subdividirla.', true);
    return;
  }
  if (sculpt.sculptor.isStroking) commitSculptStroke();

  Sculptor.ensureUniqueGeometry(mesh, viewport.scene);
  const beforeGeo = mesh.geometry;
  const beforeSubsurf = HistoryManager.captureSubsurfSnapshot(mesh);
  if (mesh._subsurf) {
    mesh._subsurf = null;
  }
  mesh._subsurfDirtyFromGeometry = false;
  try {
    const afterGeo = subdivideGeometry(beforeGeo, 1);
    afterGeo._modifiedBySculpt = true;
    afterGeo._isGeneratedSubsurf = false;
    if (typeof mesh.setGeometry === 'function') mesh.setGeometry(afterGeo);
    else mesh.geometry = afterGeo;
    history.push({ type: 'subdivide', mesh, beforeGeo, afterGeo, beforeSubsurf });
    syncSculptUI();
    syncEditUI();
    const { triangles: tris } = afterGeo.getStats();
    setStatus(`Malla subdividida: ${tris.toLocaleString('es-ES')} triángulos.`);
  } catch (err) {
    setStatus(err && err.message ? err.message : 'No se pudo subdividir la malla.', true);
  }
}

export function applyClayMaterialToSelected() {
  const target = getSculptPrimaryMesh() || sceneStore.selected;
  if (!target) {
    setStatus('Selecciona una malla primero.', true);
    return;
  }
  target.traverse((node) => {
    if (!Sculptor.isSculptable(node)) return;
    node.material = new MatcapMaterial({
      color: 0xd97757,
      glossiness: 0.48,
      metalness: 0.12,
    });
  });
  syncSelectedUI();
  syncSculptUI();
  setStatus(`Material Arcilla aplicado a "${target.name || 'malla'}".`);
}

export function renderSculptOverlay(camera) {
  if (!sculpt.active || !camera) return;
  sculpt.sculptor.drawAttachedOverlay(camera);
}
