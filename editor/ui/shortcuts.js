import { SCULPT_SYMMETRIES, SCULPT_FALLOFFS } from '../../src/modules/sculpt.js';
import { snapshotMeshModelingState } from '../../src/modules/modeling.js';
import { dom, setStatus, bindDoubleTap } from '../dom.js';
import { viewport, sceneStore, cameraView, sculpt, edit, rig } from '../store.js';
import { history } from '../history.js';
import { focusOnObject, setGizmoMode, setEditPivotMode, syncGizmoSpaceUI } from '../viewport.js';
import { exitCameraView } from '../cameraView.js';
import {
  syncSculptUI,
  setSculptMode,
  addClaySphere,
  subdivideSelectedMesh,
  applyClayMaterialToSelected,
  getSculptTargets,
} from '../sculptController.js';
import {
  getEditablePrimaryMesh,
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
  updateEditDensityPreview,
  runEditDensityStep,
  runEditDensityScale,
  getSelectedMergeTargetMeshes,
} from '../editController.js';
import { deleteSelected } from '../sceneActions.js';
import { mergeSelectedObjects } from '../meshMerge.js';
import { toggleTimelinePlayback } from '../animationController.js';
import { closeAllPopovers } from './popovers.js';
import { renderObjectList } from './outliner.js';
import { syncSelectedUI } from './objectInspector.js';

export function bindShortcutsAndModes() {
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

  // Modo Edición
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

  const readWeldSeamSmooth = () => {
    const raw = Number(dom.editWeldSeamSmoothNum?.value ?? dom.editWeldSeamSmooth?.value ?? 50);
    const pct = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 50;
    return pct / 100;
  };
  const syncWeldSeamSmoothInputs = (val, sourceEl) => {
    const pct = Number(val);
    if (!Number.isFinite(pct)) return;
    const clamped = String(Math.round(Math.max(0, Math.min(100, pct))));
    if (dom.editWeldSeamSmooth && dom.editWeldSeamSmooth !== sourceEl) dom.editWeldSeamSmooth.value = clamped;
    if (dom.editWeldSeamSmoothNum && dom.editWeldSeamSmoothNum !== sourceEl) dom.editWeldSeamSmoothNum.value = clamped;
  };
  dom.editWeldSeamSmooth?.addEventListener('input', (e) => syncWeldSeamSmoothInputs(e.target.value, dom.editWeldSeamSmooth));
  dom.editWeldSeamSmoothNum?.addEventListener('input', (e) => syncWeldSeamSmoothInputs(e.target.value, dom.editWeldSeamSmoothNum));
  dom.editWeldSeamSmoothNum?.addEventListener('change', (e) => syncWeldSeamSmoothInputs(e.target.value, null));

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
      remeshOrganic: dom.editWeldRemesh ? dom.editWeldRemesh.checked : true,
      solidity: readWeldSolidity(),
      seamSmooth: readWeldSeamSmooth(),
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

  // Densidad de vértices
  dom.btnEditDensityDec?.addEventListener('click', () => runEditDensityStep(-1));
  dom.btnEditDensityInc?.addEventListener('click', () => runEditDensityStep(1));
  {
    const syncDensityInputs = (val, sourceEl) => {
      const num = Number(val);
      if (!Number.isFinite(num)) return;
      const maxPct = Math.max(400, Number(dom.editDensityScale?.max) || 400);
      const clamped = String(Math.round(Math.max(1, Math.min(maxPct, num))));
      if (dom.editDensityScale && dom.editDensityScale !== sourceEl) dom.editDensityScale.value = clamped;
      if (dom.editDensityScaleNum && dom.editDensityScaleNum !== sourceEl) dom.editDensityScaleNum.value = clamped;
      updateEditDensityPreview();
    };
    dom.editDensityScale?.addEventListener('input', (e) => syncDensityInputs(e.target.value, dom.editDensityScale));
    dom.editDensityScaleNum?.addEventListener('input', (e) => syncDensityInputs(e.target.value, dom.editDensityScaleNum));
    dom.editDensityScaleNum?.addEventListener('change', (e) => syncDensityInputs(e.target.value, null));
    dom.btnEditDensityApply?.addEventListener('click', () => {
      const pct = dom.editDensityScaleNum?.value ?? dom.editDensityScale?.value ?? 100;
      runEditDensityScale(pct);
    });
  }

  // Alisar (Subsurf)
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

  // Modo Modelar (Esculpido)
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

  // Atajos de teclado
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented) {
      if (viewport.openPopover) {
        e.preventDefault();
        closeAllPopovers();
        return;
      }
      if (!sculpt.active && !rig.active && cameraView.activeSceneCam) {
        e.preventDefault();
        exitCameraView();
        return;
      }
      if (rig.active && (rig.rigger.boneTool || rig.rigger.weightPaint)) {
        e.preventDefault();
        rig.rigger.boneTool = false;
        rig.rigger.weightPaint = false;
        rig.rigger.hover = null;
        history._hooks.ensureRigWeightPaintRestored?.();
        history._hooks.syncRigUI?.();
        return;
      }
    }

    const activeEl = document.activeElement;
    const tag = activeEl?.tagName;
    if (
      activeEl?.isContentEditable ||
      tag === 'SELECT' ||
      tag === 'TEXTAREA' ||
      (tag === 'INPUT' && !['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'color'].includes((activeEl.type || 'text').toLowerCase()))
    ) return;

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

    if (e.code === 'Space' && viewport.appMode === 'animacion' && !edit.active && !sculpt.active && !rig.active) {
      e.preventDefault();
      toggleTimelinePlayback();
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

  // Enlace de MeshEditor & Sculptor
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
    onReadoutChange: () => {
      if (!dom.gizmoReadout) return;
      dom.gizmoReadout.hidden = true;
      dom.gizmoReadout.textContent = '';
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
