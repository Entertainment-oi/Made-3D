import {
  MeshEditor,
  ensureEditableBase,
  getMeshSubsurf,
  setMeshSubsurf,
  applyMeshSubsurf,
  snapshotMeshModelingState,
  isSubsurfSupported,
  canIncrementSubsurf,
  canIncreaseMeshDensity,
  canDecreaseMeshDensity,
  MIN_DENSITY_VERTS,
  MAX_DENSITY_VERTS,
} from '../src/modules/modeling.js';
import { drawLightsOverlay } from '../src/modules/gizmo.js';
import { dom, setStatus } from './dom.js';
import {
  viewport,
  sceneStore,
  cameraView,
  sculpt,
  edit,
} from './store.js';
import { history } from './history.js';
import { setSculptMode } from './sculptController.js';
import { exitCameraView } from './cameraView.js';
import { syncSelectedUI, syncAppModeUI, syncGizmoXyzPanel, renderObjectList } from './inspectorUI.js';

const mergeTargetMeshes = new Set();
let _lastMergePrimary = null;

function collectMergeableSceneMeshes() {
  const seen = new Set();
  const list = [];
  for (const root of sceneStore.userObjects) {
    if (!root) continue;
    const meshes = root.collectMeshes ? root.collectMeshes({ includeSelf: true }) : [root];
    for (const m of meshes) {
      if (!m || seen.has(m)) continue;
      if (m.isMesh && m.geometry && !m.isFloor && !m.isSkinnedMesh) {
        seen.add(m);
        list.push(m);
      }
    }
  }
  return list;
}

export function getSelectedMergeTargetMeshes() {
  const available = new Set(collectMergeableSceneMeshes());
  const out = [];
  for (const m of mergeTargetMeshes) {
    if (available.has(m)) out.push(m);
  }
  return out;
}

export function renderMergeTargetsList() {
  const container = dom.editMergeTargetsList;
  const available = collectMergeableSceneMeshes();
  const availSet = new Set(available);

  for (const m of [...mergeTargetMeshes]) {
    if (!availSet.has(m)) mergeTargetMeshes.delete(m);
  }

  const activePrimary = edit.active && edit.editor.mesh ? edit.editor.mesh : getEditablePrimaryMesh();
  if (activePrimary && availSet.has(activePrimary) && activePrimary !== _lastMergePrimary) {
    mergeTargetMeshes.add(activePrimary);
    _lastMergePrimary = activePrimary;
  }
  for (const sel of sceneStore.selectedList) {
    if (sel && availSet.has(sel) && sceneStore.selectedList.length > 1) {
      mergeTargetMeshes.add(sel);
    }
  }
  if (!mergeTargetMeshes.size && activePrimary && availSet.has(activePrimary)) {
    mergeTargetMeshes.add(activePrimary);
  }

  if (dom.btnEditMergeMeshes) {
    const checkedCount = getSelectedMergeTargetMeshes().length;
    dom.btnEditMergeMeshes.disabled = !edit.active || available.length < 2;
    dom.btnEditMergeMeshes.textContent = checkedCount >= 2 ? `Mallas (${checkedCount})` : 'Mallas';
  }

  if (!container) return;
  container.innerHTML = '';

  if (available.length < 2) {
    const note = document.createElement('div');
    note.className = 'meta-text';
    note.textContent = 'Agrega al menos 2 mallas en la escena para fusionarlas.';
    container.appendChild(note);
    return;
  }

  for (const mesh of available) {
    const checked = mergeTargetMeshes.has(mesh);
    const label = document.createElement('label');
    label.className = 'merge-target-item' + (checked ? ' is-checked' : '');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = checked;
    cb.addEventListener('change', () => {
      if (cb.checked) mergeTargetMeshes.add(mesh);
      else mergeTargetMeshes.delete(mesh);
      label.classList.toggle('is-checked', cb.checked);
      if (dom.btnEditMergeMeshes) {
        const count = getSelectedMergeTargetMeshes().length;
        dom.btnEditMergeMeshes.textContent = count >= 2 ? `Mallas (${count})` : 'Mallas';
      }
    });

    const nameSpan = document.createElement('span');
    nameSpan.className = 'merge-target-name';
    nameSpan.textContent = mesh === activePrimary
      ? `${mesh.name || `Malla #${mesh.id}`} (activa)`
      : (mesh.name || `Malla #${mesh.id}`);

    const faceCount = mesh._subsurf?.baseMesh
      ? mesh._subsurf.baseMesh.faces.length
      : Math.floor((mesh.geometry?.getStats?.().triangles) || 0);
    const countSpan = document.createElement('span');
    countSpan.className = 'merge-target-count';
    countSpan.textContent = `${faceCount}c`;

    label.append(cb, nameSpan, countSpan);
    container.appendChild(label);
  }
}

export function getEditablePrimaryMesh() {
  if (MeshEditor.isEditable(sceneStore.selected)) return sceneStore.selected;
  if (sceneStore.selected) {
    const parts = sceneStore.selected.collectMeshes({ includeSelf: true }).filter(MeshEditor.isEditable);
    if (parts.length) return parts[0];
  }
  for (const root of sceneStore.userObjects) {
    const parts = root.collectMeshes({ includeSelf: true }).filter(MeshEditor.isEditable);
    if (parts.length) return parts[0];
  }
  return null;
}

export function closeEditFlyouts(exceptId = null) {
  const flyouts = [
    dom.popEditExtrude,
    dom.popEditSubdivide,
    dom.popEditSmooth,
    dom.popEditMerge,
    dom.popEditMore,
  ];
  for (const f of flyouts) {
    if (f && f.id !== exceptId) f.hidden = true;
  }
  dom.btnEditSmoothToggle?.classList.toggle('is-active', Boolean(dom.popEditSmooth && !dom.popEditSmooth.hidden));
  dom.btnEditMergeToggle?.classList.toggle('is-active', Boolean(dom.popEditMerge && !dom.popEditMerge.hidden));
  dom.btnEditMore?.classList.toggle('is-active', Boolean(dom.popEditMore && !dom.popEditMore.hidden));
}

export function toggleEditFlyout(flyoutEl) {
  if (!flyoutEl) return;
  const willOpen = flyoutEl.hidden;
  closeEditFlyouts(willOpen ? flyoutEl.id : null);
  flyoutEl.hidden = !willOpen;
  if (willOpen && flyoutEl === dom.popEditMerge) {
    renderMergeTargetsList();
  }
  dom.btnEditSmoothToggle?.classList.toggle('is-active', Boolean(dom.popEditSmooth && !dom.popEditSmooth.hidden));
  dom.btnEditMergeToggle?.classList.toggle('is-active', Boolean(dom.popEditMerge && !dom.popEditMerge.hidden));
  dom.btnEditMore?.classList.toggle('is-active', Boolean(dom.popEditMore && !dom.popEditMore.hidden));
}

export function syncSubsurfUI() {
  const obj = sceneStore.selected;
  const supported = Boolean(obj && isSubsurfSupported(obj));
  if (dom.subsurfGroup) dom.subsurfGroup.hidden = !supported;
  if (!supported) return;

  const mod = getMeshSubsurf(obj);
  const level = mod ? mod.level : 0;
  const smoothnessPct = Math.round((mod?.smoothness ?? 1) * 100);
  const showCage = mod ? mod.showCage !== false : true;
  const alwaysShowCage = Boolean(mod && mod.alwaysShowCage);
  const smoothShading = mod ? mod.smoothShading !== false : true;
  const canInc = canIncrementSubsurf(obj);

  if (dom.btnSubsurfDec) dom.btnSubsurfDec.disabled = level <= 0;
  if (dom.btnSubsurfInc) dom.btnSubsurfInc.disabled = !canInc;
  if (dom.subsurfLevelVal) dom.subsurfLevelVal.textContent = `×${level}`;
  if (dom.subsurfLevelBadge) {
    dom.subsurfLevelBadge.textContent = level > 0 ? `Suave ×${level}` : 'Original';
  }
  if (dom.subsurfSmoothness && document.activeElement !== dom.subsurfSmoothness) {
    dom.subsurfSmoothness.value = String(smoothnessPct);
  }
  if (dom.subsurfSmoothnessNum && document.activeElement !== dom.subsurfSmoothnessNum) {
    dom.subsurfSmoothnessNum.value = String(smoothnessPct);
  }
  if (dom.subsurfShowCage) dom.subsurfShowCage.checked = showCage;
  if (dom.subsurfAlwaysCage) dom.subsurfAlwaysCage.checked = alwaysShowCage;
  if (dom.subsurfSmoothShading) dom.subsurfSmoothShading.checked = smoothShading;
  if (dom.btnSubsurfApply) dom.btnSubsurfApply.disabled = level <= 0;
}

export function syncEditUI() {
  const active = Boolean(edit.active);
  const cutActive = active && Boolean(edit.editor.cutTool);

  if (dom.editSelBar) dom.editSelBar.hidden = !active;
  if (dom.editToolBar) dom.editToolBar.hidden = !active;
  if (!active) closeEditFlyouts();

  document.querySelectorAll('[data-edit-sel]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.editSel === edit.editor.selectionMode);
  });

  if (active) {
    document.querySelectorAll('.seg-btn[data-mode]').forEach((btn) => {
      btn.classList.toggle('is-active', !cutActive && btn.dataset.mode === edit.editor.transformMode);
    });
  }

  const targetMesh = active ? edit.editor.mesh : getEditablePrimaryMesh();
  const stats = active && edit.editor.mesh === targetMesh ? edit.editor.getStats() : null;
  const hasMesh = Boolean(targetMesh);
  const hasSelection = Boolean(stats && stats.selectedCount > 0);
  const multiActive = Boolean(active && edit.editor.multiSelectMode);

  if (dom.btnEditMultiSelect) {
    dom.btnEditMultiSelect.disabled = !hasMesh;
    dom.btnEditMultiSelect.classList.toggle('is-active', multiActive);
    dom.btnEditMultiSelect.classList.toggle('is-yellow-active', multiActive);
  }
  if (dom.btnEditBoxSelect) {
    dom.btnEditBoxSelect.disabled = !hasMesh;
    dom.btnEditBoxSelect.classList.toggle('is-active', Boolean(active && edit.editor.boxSelectMode));
  }

  if (dom.btnEditExtrude) dom.btnEditExtrude.disabled = !hasMesh || (active && !hasSelection);
  if (dom.btnEditBevel) dom.btnEditBevel.disabled = !hasMesh || !active || !hasSelection;
  if (dom.btnEditBridgeFill) dom.btnEditBridgeFill.disabled = !hasMesh || !active || !hasSelection;
  if (dom.btnEditMerge) dom.btnEditMerge.disabled = !hasMesh || !active;

  const avgCrease = active && hasSelection ? edit.editor.getSelectionAverageCrease() : 0;
  const creasePct = Math.round(avgCrease * 100);
  if (dom.editCreaseRange) {
    dom.editCreaseRange.disabled = !active || !hasSelection;
    if (document.activeElement !== dom.editCreaseRange) {
      dom.editCreaseRange.value = String(creasePct);
    }
  }
  if (dom.editCreaseVal) dom.editCreaseVal.textContent = `${creasePct}%`;
  document.querySelectorAll('[data-edit-crease]').forEach((btn) => {
    btn.disabled = !active || !hasSelection;
  });

  if (dom.btnEditCutToggle) {
    dom.btnEditCutToggle.disabled = !hasMesh;
    dom.btnEditCutToggle.classList.toggle('is-active', cutActive);
  }
  if (dom.editCutSubbar) {
    dom.editCutSubbar.hidden = !cutActive;
  }
  document.querySelectorAll('[data-edit-cut-mode]').forEach((btn) => {
    btn.disabled = !hasMesh;
    btn.classList.toggle('is-active', cutActive && btn.dataset.editCutMode === edit.editor.cutTool);
  });

  if (dom.btnEditSubdivide) dom.btnEditSubdivide.disabled = !hasMesh;
  if (dom.btnEditDelete) dom.btnEditDelete.disabled = !active || !hasSelection;
  if (dom.btnToolbarDelete) dom.btnToolbarDelete.disabled = active ? !hasSelection : !sceneStore.selected;
  if (dom.btnEditSelectAll) dom.btnEditSelectAll.disabled = !active;
  if (dom.btnEditInvert) dom.btnEditInvert.disabled = !active;
  if (dom.btnEditClearSel) dom.btnEditClearSel.disabled = !active || !hasSelection;
  renderMergeTargetsList();

  if (dom.editMeshInfo) {
    if (active && stats && targetMesh) {
      const unitLabel =
        edit.editor.selectionMode === 'vertex'
          ? 'vértice(s)'
          : edit.editor.selectionMode === 'edge'
          ? 'arista(s)'
          : 'cara(s)';
      dom.editMeshInfo.innerHTML =
        `<strong>${targetMesh.name || `Malla #${targetMesh.id}`}</strong><br>` +
        `${stats.verts} V · ${stats.edges} A · ${stats.faces} C · Sel: ${stats.selectedCount} ${unitLabel}`;
    } else {
      dom.editMeshInfo.textContent = '';
    }
  }

  const mod = targetMesh ? getMeshSubsurf(targetMesh) : null;
  const level = mod ? mod.level : 0;
  const smoothnessPct = Math.round((mod?.smoothness ?? 1) * 100);
  const canInc = Boolean(targetMesh && canIncrementSubsurf(targetMesh));
  if (dom.btnEditSubsurfDec) dom.btnEditSubsurfDec.disabled = !hasMesh || level <= 0;
  if (dom.btnEditSubsurfInc) dom.btnEditSubsurfInc.disabled = !hasMesh || !canInc;
  if (dom.editSubsurfVal) dom.editSubsurfVal.textContent = `×${level}`;
  if (dom.editSubsurfBadge) {
    dom.editSubsurfBadge.textContent = level > 0 ? `Suave ×${level}` : 'Original';
  }
  if (dom.editSubsurfSmoothness) {
    dom.editSubsurfSmoothness.disabled = !hasMesh;
    if (document.activeElement !== dom.editSubsurfSmoothness) {
      dom.editSubsurfSmoothness.value = String(smoothnessPct);
    }
  }
  if (dom.editSubsurfSmoothnessNum) {
    dom.editSubsurfSmoothnessNum.disabled = !hasMesh;
    if (document.activeElement !== dom.editSubsurfSmoothnessNum) {
      dom.editSubsurfSmoothnessNum.value = String(smoothnessPct);
    }
  }
  if (dom.editSubsurfCage) {
    dom.editSubsurfCage.disabled = !hasMesh;
    dom.editSubsurfCage.checked = mod ? mod.showCage !== false : true;
  }
  if (dom.editSubsurfAlwaysCage) {
    dom.editSubsurfAlwaysCage.disabled = !hasMesh;
    dom.editSubsurfAlwaysCage.checked = Boolean(mod && mod.alwaysShowCage);
  }

  updateEditDensityPreview(targetMesh, { syncInputs: true });

  syncSubsurfUI();
  syncGizmoXyzPanel();
}

export function updateEditDensityPreview(meshOverride = null, { syncInputs = false, forceSyncInputs = false } = {}) {
  const active = Boolean(edit.active);
  const targetMesh = meshOverride || (active ? edit.editor.mesh : getEditablePrimaryMesh());
  const mod = targetMesh ? (targetMesh._subsurf?.baseMesh ? targetMesh._subsurf : ensureEditableBase(targetMesh)) : null;
  const base = active && edit.editor.mesh === targetMesh ? edit.editor.baseMesh : (mod?.baseMesh || null);
  const baseVerts = base ? base.verts.length : 0;
  const originVerts = base ? (base._densityOrigin ? base._densityOrigin.verts.length : baseVerts) : 0;
  const currentPct = originVerts > 0 ? Math.max(1, Math.round((baseVerts / originVerts) * 100)) : 100;
  const maxPct = Math.max(400, currentPct);

  if (dom.editDensityScale) dom.editDensityScale.max = String(maxPct);
  if (dom.editDensityScaleNum) dom.editDensityScaleNum.max = String(maxPct);

  const isEditingScaleInput =
    document.activeElement === dom.editDensityScale ||
    document.activeElement === dom.editDensityScaleNum;

  if (syncInputs && (forceSyncInputs || !isEditingScaleInput)) {
    const syncVal = String(currentPct);
    if (dom.editDensityScale) dom.editDensityScale.value = syncVal;
    if (dom.editDensityScaleNum) dom.editDensityScaleNum.value = syncVal;
  }

  const rawPct = Number(dom.editDensityScaleNum?.value ?? dom.editDensityScale?.value ?? currentPct);
  const pct = Number.isFinite(rawPct) ? Math.round(Math.max(1, Math.min(maxPct, rawPct))) : currentPct;
  const effectiveMaxVerts = Math.max(MAX_DENSITY_VERTS, originVerts);
  const estTarget = originVerts
    ? Math.max(MIN_DENSITY_VERTS, Math.min(effectiveMaxVerts, Math.round(originVerts * (pct / 100))))
    : 0;

  const canDec = Boolean(active && base && canDecreaseMeshDensity(base));
  const canInc = Boolean(active && base && canIncreaseMeshDensity(base));
  const canScale = Boolean(
    active &&
    base &&
    estTarget !== baseVerts &&
    ((estTarget < baseVerts && canDecreaseMeshDensity(base)) ||
      (estTarget > baseVerts && (estTarget <= originVerts || canIncreaseMeshDensity(base._densityOrigin || base))))
  );

  if (dom.editDensityBadge) {
    dom.editDensityBadge.textContent =
      originVerts && originVerts !== baseVerts
        ? `${baseVerts} / ${originVerts} V`
        : `${baseVerts} V`;
  }
  if (dom.editDensityVal) {
    dom.editDensityVal.textContent = !baseVerts || estTarget === baseVerts
      ? `${baseVerts} V`
      : `${baseVerts} → ${estTarget === originVerts ? originVerts : `~${estTarget}`} V`;
  }
  if (dom.btnEditDensityDec) dom.btnEditDensityDec.disabled = !canDec;
  if (dom.btnEditDensityInc) dom.btnEditDensityInc.disabled = !canInc;
  if (dom.editDensityScale) dom.editDensityScale.disabled = !active || !base;
  if (dom.editDensityScaleNum) dom.editDensityScaleNum.disabled = !active || !base;
  if (dom.btnEditDensityApply) dom.btnEditDensityApply.disabled = !canScale;
}

function syncDensityScaleInputsToCurrent() {
  updateEditDensityPreview(null, { syncInputs: true, forceSyncInputs: true });
}

export function runEditDensityStep(delta) {
  if (!edit.active && !setEditMode(true)) return;
  const mode = delta > 0 ? 'inc' : 'dec';
  const res = edit.editor.adjustVertexDensity({ mode });
  if (!res.changed) {
    syncDensityScaleInputsToCurrent();
    setStatus(res.error || 'No se pudo modificar la densidad de vértices.', true);
    syncEditUI();
    return;
  }
  syncEditUI();
  syncDensityScaleInputsToCurrent();
  syncSelectedUI();
  setStatus(
    `Densidad ${delta > 0 ? 'aumentada' : 'disminuida'}: ${res.beforeVerts} → ${res.afterVerts} vértices.`
  );
}

export function runEditDensityScale(rawPct) {
  if (!edit.active && !setEditMode(true)) return;
  const parsed = Number(rawPct);
  const maxPct = Math.max(400, Number(dom.editDensityScale?.max) || 400);
  const pct = Number.isFinite(parsed) ? Math.round(Math.max(1, Math.min(maxPct, parsed))) : 100;
  const res = edit.editor.adjustVertexDensity({ mode: 'scale', factor: pct / 100, reference: 'origin' });
  if (!res.changed) {
    syncDensityScaleInputsToCurrent();
    setStatus(res.error || 'No se pudo ajustar la densidad de vértices.', true);
    syncEditUI();
    return;
  }
  syncEditUI();
  syncDensityScaleInputsToCurrent();
  syncSelectedUI();
  setStatus(`Densidad ajustada (${pct}%): ${res.beforeVerts} → ${res.afterVerts} vértices.`);
}

export function setEditMode(enabled) {
  const next = Boolean(enabled);

  if (next) {
    if (cameraView.activeSceneCam) exitCameraView();
    if (sculpt.active) setSculptMode(false);
    if (viewport.gizmo?.drag) {
      viewport.gizmo.cancel();
      if (dom.gizmoReadout) dom.gizmoReadout.hidden = true;
    }

    const candidate = getEditablePrimaryMesh();
    if (!candidate) {
      setStatus('Selecciona o crea una malla editable primero.', true);
      syncAppModeUI(sculpt.active ? 'modelar' : 'pose');
      return false;
    }

    if (sceneStore.selected !== candidate) {
      sceneStore.selected = candidate;
      sceneStore.selectedList = [candidate];
      if (viewport.gizmo) viewport.gizmo.attach(candidate);
      renderObjectList();
      syncSelectedUI();
    }

    edit.editor.setMesh(candidate);
    if (viewport.gizmo) {
      edit.editor.setSpace(viewport.gizmo.space);
      edit.editor.setSnap(viewport.snapOn);
    }
  } else {
    edit.editor.setMesh(null);
    if (dom.gizmoReadout) dom.gizmoReadout.hidden = true;
    closeEditFlyouts();
  }

  edit.active = next;
  edit.editor.setEnabled(next);

  if (viewport.controls) {
    viewport.controls.enabled = !(cameraView.activeSceneCam && cameraView.camViewLocked);
  }
  if (viewport.gizmo) {
    viewport.gizmo.enabled = !next && !sculpt.active;
    viewport.gizmo.visible = !next && !sculpt.active && !(cameraView.activeSceneCam && sceneStore.selected === cameraView.activeSceneCam);
    if (!next) {
      document.querySelectorAll('.seg-btn[data-mode]').forEach((btn) => {
        btn.classList.toggle('is-active', btn.dataset.mode === viewport.gizmo.mode);
      });
    }
  }

  syncAppModeUI(next ? 'edicion' : sculpt.active ? 'modelar' : 'pose');
  syncEditUI();
  return true;
}

export function toggleEditCutTool(mode = null) {
  if (!edit.active && !setEditMode(true)) return;
  if (mode) {
    edit.editor.setCutTool(edit.editor.cutTool === mode ? null : mode);
  } else {
    edit.editor.setCutTool(edit.editor.cutTool ? null : (edit.editor.cutMode || 'knife'));
  }
  syncEditUI();
  if (edit.editor.cutTool) {
    setStatus(
      edit.editor.cutTool === 'loop'
        ? 'Corte 360° activo: arrastra sobre el objeto para dividir alrededor.'
        : 'Corte por línea activo: traza sobre las caras del modelo.'
    );
  }
}

export function setEditCutMode(mode) {
  edit.editor.setCutMode(mode);
  if (!edit.active && !setEditMode(true)) return;
  edit.editor.setCutTool(mode);
  syncEditUI();
  setStatus(
    mode === 'loop'
      ? 'Modo Bucle 360° activo: arrastra horizontal o verticalmente sobre la malla.'
      : 'Modo Línea libre activo: traza sobre las caras que quieras cortar.'
  );
}

export function setSelectedSubsurfOptions(opts, { commitHistory = true, beforeState: externalBefore = null } = {}) {
  const target = edit.active && edit.editor.mesh ? edit.editor.mesh : getEditablePrimaryMesh();
  if (!target || !isSubsurfSupported(target)) return;

  const beforeState = externalBefore || (commitHistory ? snapshotMeshModelingState(target) : null);
  const mod = setMeshSubsurf(target, opts);
  if (!mod) return;

  if (commitHistory) {
    const afterState = snapshotMeshModelingState(target);
    if (
      beforeState &&
      afterState &&
      (beforeState.level !== afterState.level ||
        Math.abs((beforeState.smoothness ?? 1) - (afterState.smoothness ?? 1)) > 1e-4 ||
        beforeState.smoothShading !== afterState.smoothShading ||
        beforeState.showCage !== afterState.showCage ||
        Boolean(beforeState.alwaysShowCage) !== Boolean(afterState.alwaysShowCage))
    ) {
      history.push({
        type: 'meshEdit',
        mesh: target,
        beforeState,
        afterState,
        label: 'Alisar objeto',
      });
    }
  }

  syncEditUI();
  syncSelectedUI();
  if (opts.level !== undefined) {
    setStatus(
      mod.level > 0
        ? `Alisado ×${mod.level} aplicado sobre la jaula original.`
        : 'Alisado desactivado (malla original visible).'
    );
  }
}

export function stepSelectedSubsurf(delta) {
  const target = edit.active && edit.editor.mesh ? edit.editor.mesh : getEditablePrimaryMesh();
  if (!target || !isSubsurfSupported(target)) return;
  const current = getMeshSubsurf(target)?.level ?? 0;
  if (delta > 0) {
    if (!canIncrementSubsurf(target)) {
      setStatus('Se alcanzó el límite seguro de densidad de malla.', true);
      return;
    }
    setSelectedSubsurfOptions({ level: current + 1 });
  } else if (delta < 0) {
    if (current <= 0) return;
    setSelectedSubsurfOptions({ level: current - 1 });
  }
}

export function applySelectedSubsurf() {
  const target = edit.active && edit.editor.mesh ? edit.editor.mesh : getEditablePrimaryMesh();
  if (!target) return;
  const mod = getMeshSubsurf(target);
  if (!mod || mod.level <= 0) return;

  const beforeState = snapshotMeshModelingState(target);
  if (applyMeshSubsurf(target)) {
    if (edit.active && edit.editor.mesh === target) {
      edit.editor.clearSelection();
    }
    const afterState = snapshotMeshModelingState(target);
    history.push({
      type: 'meshEdit',
      mesh: target,
      beforeState,
      afterState,
      label: 'Aplicar alisado',
    });
    syncEditUI();
    syncSelectedUI();
    setStatus('Alisado horneado permanentemente en la geometría.');
  }
}

export function runEditExtrude() {
  if (!edit.active && !setEditMode(true)) return;
  const raw = Number(dom.editExtrudeDist?.value);
  const dist = Number.isFinite(raw) ? raw : 0.25;
  const res = edit.editor.extrudeSelection(dist);
  if (!res.changed) {
    setStatus(res.error || 'Selecciona caras, aristas o vértices para extruir.', true);
    return;
  }
  syncEditUI();
  setStatus(`Extrusión aplicada (${dist.toFixed(2)}).`);
}

export function runEditSubdivide() {
  if (!edit.active && !setEditMode(true)) return;
  const cuts = Math.max(1, Math.min(4, parseInt(dom.editSubdivideCuts?.value ?? '1', 10) || 1));
  const res = edit.editor.subdivideSelection(cuts);
  if (!res.changed) {
    setStatus('No se pudo dividir la selección.', true);
    return;
  }
  syncEditUI();
  setStatus(`Malla dividida (${cuts} corte${cuts > 1 ? 's' : ''}).`);
}

export function toggleEditMultiSelect(force = null) {
  if (!edit.active && !setEditMode(true)) return;
  const next = force !== null ? Boolean(force) : !edit.editor.multiSelectMode;
  edit.editor.setMultiSelectMode(next);
  syncEditUI();
  setStatus(
    next
      ? 'Selección múltiple activa (amarillo).'
      : 'Selección múltiple desactivada.'
  );
}

export function toggleEditBoxSelect(force = null) {
  if (!edit.active && !setEditMode(true)) return;
  const next = force !== null ? Boolean(force) : !edit.editor.boxSelectMode;
  edit.editor.setBoxSelectMode(next);
  syncEditUI();
  setStatus(
    next
      ? 'Recuadro activo: arrastra para seleccionar elementos.'
      : 'Recuadro desactivado.'
  );
}

export function runEditBevel() {
  if (!edit.active && !setEditMode(true)) return;
  const rawW = Number(dom.editBevelWidth?.value);
  const width = Number.isFinite(rawW) && rawW > 0 ? rawW : 0.08;
  const rawSeg = parseInt(dom.editBevelSegments?.value ?? '1', 10);
  const segments = Number.isFinite(rawSeg) ? Math.max(1, Math.min(4, rawSeg)) : 1;
  const res = edit.editor.bevelSelection(width, segments);
  if (!res.changed) {
    setStatus(res.error || 'Selecciona caras, aristas o vértices para biselar.', true);
    return;
  }
  syncEditUI();
  setStatus(`Biselado aplicado (${width.toFixed(2)}, ${segments} seg.).`);
}

export function runEditBridgeFill() {
  if (!edit.active && !setEditMode(true)) return;
  const res = edit.editor.fillOrBridgeSelection();
  if (!res.changed) {
    setStatus(res.error || 'Selecciona un borde abierto para rellenar o 2 caras para puente.', true);
    return;
  }
  syncEditUI();
  setStatus(
    res.op === 'bridge'
      ? `Puente creado (${res.createdFaces} caras).`
      : 'Hueco rellenado.'
  );
}

export function runEditMerge() {
  if (!edit.active && !setEditMode(true)) return;
  const rawD = Number(dom.editMergeDist?.value);
  const dist = Number.isFinite(rawD) && rawD > 0 ? rawD : 0.015;
  const res = edit.editor.mergeByDistance(dist);
  if (!res.changed) {
    setStatus(res.error || 'No hay vértices cercanos dentro de esa distancia.', true);
    return;
  }
  syncEditUI();
  setStatus(`${res.mergedCount} vértice(s) fusionados.`);
}

export function runEditCrease(value) {
  if (!edit.active && !setEditMode(true)) return;
  const v = Math.max(0, Math.min(1, Number(value) || 0));
  const res = edit.editor.setSelectionCrease(v);
  if (!res.changed) {
    setStatus(res.error || 'Selecciona aristas, caras o vértices primero.', true);
    return;
  }
  syncEditUI();
  setStatus(`Dureza aplicada: ${Math.round(res.value * 100)}%.`);
}

export function runEditDelete() {
  if (!edit.active) return;
  const res = edit.editor.deleteSelectedElements();
  if (!res.changed) {
    setStatus(res.error || 'Selecciona elementos válidos para eliminar.', true);
    return;
  }
  syncEditUI();
  setStatus('Elementos seleccionados eliminados.');
}

export function renderEditOverlay(camera) {
  if (!dom.editOverlay || !camera || !viewport.scene) return;
  const cageMeshes = [];
  const selectedSet = new Set();
  if (sceneStore.selected) selectedSet.add(sceneStore.selected);
  for (const s of sceneStore.selectedList) selectedSet.add(s);

  if (edit.active) {
    viewport.scene.traverse((n) => {
      if (!n || !n.isMesh) return;
      if (n._subsurf && (n._subsurfDirtyFromGeometry || (n.geometry && n.geometry._modifiedBySculpt && !n.geometry._isGeneratedSubsurf))) {
        ensureEditableBase(n);
      }
      if (!n._subsurf || !n._subsurf.baseMesh) return;
      const mod = n._subsurf;
      const isSel = selectedSet.has(n);
      if (mod.alwaysShowCage || (isSel && mod.showCage !== false)) {
        cageMeshes.push(n);
      }
    });
  }

  const multiSelectSet = new Set();
  if (viewport.gizmo?.multiSelectMode || sceneStore.selectedList.length > 1) {
    for (const s of sceneStore.selectedList) multiSelectSet.add(s);
  }

  edit.editor.drawOverlay(dom.editOverlay, camera, cageMeshes, {
    referenceElement: dom.canvas,
    selectedSet,
    multiSelectSet,
    showPassiveCages: Boolean(edit.active),
  });

  // Dibujar círculos cruzados de PointLights, rayos de DirectionalLights y silueta 2D cuando el gizmo está oculto (p. ej. Modelar)
  const ctx = dom.editOverlay.getContext('2d');
  if (ctx) {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const W = dom.editOverlay.width / dpr;
    const H = dom.editOverlay.height / dpr;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!edit.active && viewport.gizmo && !viewport.gizmo._vis && viewport.gizmo.outline && sceneStore.selectedList.length) {
      const multiSelect = Boolean(viewport.gizmo.multiSelectMode || sceneStore.selectedList.length > 1);
      viewport.gizmo.outliner.drawCanvas(ctx, camera, sceneStore.selectedList, W, H, {
        multiSelect,
      });
    }
    drawLightsOverlay(
      ctx,
      camera,
      viewport.scene,
      W,
      H,
      {
        selected: sceneStore.selected,
        selectedSet,
        multiSelectSet,
      }
    );
    ctx.restore();
  }
}
