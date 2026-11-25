import {
  EditableMesh,
  MAX_SUBSURF_FACES,
  catmullClark,
  computeFaceShellIds,
  ensureEditableBase,
  setMeshSubsurf,
  snapshotMeshModelingState,
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
    const primary = activeEditMesh && candidates.includes(activeEditMesh)
      ? activeEditMesh
      : candidates[candidates.length - 1];
    const others = candidates.filter((c) => c !== primary);
    const prevSelection = candidates.slice();
    primary.updateWorldMatrix(true, false);
    const beforeState = snapshotMeshModelingState(primary);

    let anyBakedSubsurf = false;
    let anySmoothShading = false;
    const items = candidates.map((m) => {
      m.updateWorldMatrix(true, false);
      if (m._subsurfDirtyFromGeometry || (m.geometry && m.geometry._modifiedBySculpt && !m.geometry._isGeneratedSubsurf)) {
        ensureEditableBase(m);
      }
      let editableMesh = m._subsurf?.baseMesh || null;
      if (m._subsurf && m._subsurf.level > 0 && editableMesh) {
        editableMesh = catmullClark(editableMesh, m._subsurf.level, MAX_SUBSURF_FACES, m._subsurf.smoothness ?? 1);
        anyBakedSubsurf = true;
        if (m._subsurf.smoothShading !== false) anySmoothShading = true;
      } else if (m._subsurf?.smoothShading) {
        anySmoothShading = true;
      }
      return {
        editableMesh,
        geometry: m.geometry,
        matrixWorld: m.matrixWorld,
      };
    });

    const mergeRes = EditableMesh.mergeMeshes(items, {
      targetMatrixWorld: primary.matrixWorld,
      threshold,
      removeInteriorFaces,
      stitchTJunctions,
      solidity,
      seamSmooth,
      remeshOrganic,
    });
    const merged = mergeRes && mergeRes.mesh ? mergeRes.mesh : null;
    if (!merged || !merged.verts.length) {
      setStatus('No se pudieron fusionar las mallas seleccionadas.', true);
      return false;
    }

    const prevMod = primary._subsurf;
    const prevLevel = anyBakedSubsurf ? 0 : (prevMod?.level ?? 0);
    const prevSmoothness = prevMod?.smoothness ?? 1.0;
    const prevShading = anyBakedSubsurf
      ? (anySmoothShading || prevMod?.smoothShading !== false)
      : (prevMod?.smoothShading ?? Boolean(primary.geometry?.attributes?.normal));
    const prevShowCage = prevMod ? prevMod.showCage !== false : true;
    const prevAlwaysCage = Boolean(prevMod && prevMod.alwaysShowCage);

    primary._subsurf = null;
    setMeshSubsurf(primary, {
      baseMesh: merged,
      level: prevLevel,
      smoothness: prevSmoothness,
      smoothShading: prevShading,
      showCage: prevShowCage,
      alwaysShowCage: prevAlwaysCage,
    });
    if (!prevLevel) {
      const geo = merged.toGeometry({ flatShading: !prevShading });
      if (typeof primary.setGeometry === 'function') primary.setGeometry(geo);
      else primary.geometry = geo;
    }

    const removals = [];
    for (const o of others) {
      const rec = history.buildRemovalRecord(o);
      history.applyRemoval(rec);
      removals.push(rec);
    }

    const afterState = snapshotMeshModelingState(primary);
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
    setStatus(`${candidates.length} mallas soldadas en "${primary.name || 'Malla'}".`);
    return true;
  }

  const single = edit.active && edit.editor.mesh ? edit.editor.mesh : candidates[0];
  if (!single) {
    setStatus('Mantén presionado para seleccionar 2 o más mallas, o selecciona 1 malla para soldar sus partes.', true);
    return false;
  }

  const beforeState = snapshotMeshModelingState(single);
  if (single._subsurfDirtyFromGeometry || (single.geometry && single.geometry._modifiedBySculpt && !single.geometry._isGeneratedSubsurf)) {
    ensureEditableBase(single);
  }
  const prevMod = single._subsurf;
  let bakedSingleSubsurf = false;
  let em = single._subsurf?.baseMesh ? single._subsurf.baseMesh.clone() : EditableMesh.fromGeometry(single.geometry);
  if (!em) return false;
  if (prevMod && prevMod.level > 0 && single._subsurf?.baseMesh && computeFaceShellIds(em).shellCount >= 2) {
    em = catmullClark(em, prevMod.level, MAX_SUBSURF_FACES, prevMod.smoothness ?? 1);
    bakedSingleSubsurf = true;
  }
  const weldRes = em.weldShells({
    threshold,
    removeInteriorFaces,
    stitchTJunctions,
    solidity,
    seamSmooth,
    remeshOrganic,
  });
  if (!weldRes.changed) {
    setStatus('No había vértices o costuras cercanas que soldar con esa tolerancia.');
    return false;
  }

  const nextLevel = bakedSingleSubsurf ? 0 : (prevMod?.level ?? 0);
  single._subsurf = null;
  setMeshSubsurf(single, {
    baseMesh: em,
    level: nextLevel,
    smoothness: prevMod?.smoothness ?? 1.0,
    smoothShading: prevMod?.smoothShading ?? true,
    showCage: prevMod ? prevMod.showCage !== false : true,
    alwaysShowCage: Boolean(prevMod && prevMod.alwaysShowCage),
  });
  if (!(nextLevel > 0)) {
    const geo = em.toGeometry({ flatShading: prevMod ? !prevMod.smoothShading : false });
    if (typeof single.setGeometry === 'function') single.setGeometry(geo);
    else single.geometry = geo;
  }

  const afterState = snapshotMeshModelingState(single);
  if (beforeState && afterState) {
    restoreMeshModelingState(single, afterState);
    history.push({
      type: 'meshEdit',
      mesh: single,
      beforeState,
      afterState,
      label: 'Soldar mallas',
    });
  }
  if (edit.active && edit.editor.mesh === single) {
    edit.editor.clearSelection();
  }
  syncEditUI();
  syncSelectedUI();
  setStatus(
    `Malla soldada: ${weldRes.mergedVertices ?? 0} vértices unidos, ${weldRes.removedInteriorFaces ?? 0} caras internas quitadas.`
  );
  return true;
}
