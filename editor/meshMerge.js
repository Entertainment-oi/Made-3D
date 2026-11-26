import {
  mergeObjectMeshes,
  weldObjectMesh,
  restoreMeshModelingState,
} from '../src/modules/modeling.js';
import { setStatus } from './dom.js';
import { viewport, sceneStore, edit } from './store.js';
import { history } from './history.js';
import { selectObject } from './viewport.js';
import { syncEditUI } from './editController.js';
import { syncSelectedUI } from './inspectorUI.js';

export function mergeSelectedObjects({
  targets = null,
  threshold = 0.015,
  removeInteriorFaces = true,
  stitchTJunctions = true,
  solidity = 0.8,
  seamSmooth = 0.5,
  remeshOrganic = true,
} = {}) {
  const rawList = Array.isArray(targets) && targets.length
    ? targets
    : (viewport.gizmo?.objects?.length ? viewport.gizmo.objects : [sceneStore.selected]);
  const seen = new Set();
  const candidates = [];
  for (const o of rawList) {
    if (!o || seen.has(o)) continue;
    if (o.isMesh && o.geometry && !o.isFloor && !o.isSkinnedMesh) {
      seen.add(o);
      candidates.push(o);
    }
  }

  if (candidates.length >= 2) {
    const activeEditMesh = edit.active && edit.editor.mesh ? edit.editor.mesh : null;
    const prevSelection = candidates.slice();
    const mergeRes = mergeObjectMeshes(candidates, {
      primary: activeEditMesh,
      threshold,
      removeInteriorFaces,
      stitchTJunctions,
      solidity,
      seamSmooth,
      remeshOrganic,
    });
    if (!mergeRes.ok) {
      setStatus('No se pudieron fusionar las mallas seleccionadas.', true);
      return false;
    }

    const { primary, others, mergedCount, beforeState, afterState } = mergeRes;
    const removals = [];
    for (const o of others) {
      const rec = history.buildRemovalRecord(o);
      history.applyRemoval(rec);
      removals.push(rec);
    }

    history.push({
      type: 'mergeMeshes',
      mesh: primary,
      beforeState,
      afterState,
      removals,
      prevSelection,
    });

    selectObject(primary);
    if (edit.active) {
      edit.editor.setMesh(primary);
      syncEditUI();
    }
    setStatus(`${mergedCount} mallas soldadas en "${primary.name || 'Malla'}".`);
    return true;
  }

  const single = edit.active && edit.editor.mesh ? edit.editor.mesh : candidates[0];
  if (!single) {
    setStatus('Mantén presionado para seleccionar 2 o más mallas, o selecciona 1 malla para soldar sus partes.', true);
    return false;
  }

  const weldRes = weldObjectMesh(single, {
    threshold,
    removeInteriorFaces,
    stitchTJunctions,
    solidity,
    seamSmooth,
    remeshOrganic,
  });
  if (!weldRes.ok) {
    if (weldRes.reason === 'no-weld-target') {
      setStatus('No había vértices o costuras cercanas que soldar con esa tolerancia.');
    }
    return false;
  }

  if (weldRes.beforeState && weldRes.afterState) {
    restoreMeshModelingState(single, weldRes.afterState);
    history.push({
      type: 'meshEdit',
      mesh: single,
      beforeState: weldRes.beforeState,
      afterState: weldRes.afterState,
      label: 'Soldar mallas',
    });
  }
  if (edit.active && edit.editor.mesh === single) {
    edit.editor.clearSelection();
  }
  syncEditUI();
  syncSelectedUI();
  setStatus(
    `Malla soldada: ${weldRes.mergedVertices} vértices unidos, ${weldRes.removedInteriorFaces} caras internas quitadas.`
  );
  return true;
}
