import {
  Painter,
  PAINT_SYMMETRIES,
  PAINT_MODES,
  PAINT_RESOLUTIONS,
  PAINT_DEFAULT_PALETTE,
  parseHexColor,
  rgbToHex,
} from '../src/modules/paint.js';
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
import { exitCameraView } from './cameraView.js';
import { setSculptMode } from './sculptController.js';
import { setEditMode } from './editController.js';
import { syncSelectedUI, syncAppModeUI, syncGizmoXyzPanel, renderObjectList } from './inspectorUI.js';
import { syncRangeVisual } from './ui/rangeControls.js';

let _bound = false;

const SYMMETRY_LABELS = { none: 'Ninguna', x: 'Eje X', y: 'Eje Y', z: 'Eje Z' };
const MODE_LABELS = { texture: 'Textura (UV)', vertex: 'Vértices' };

export function getPaintTargets() {
  if (Painter.isPaintable(sceneStore.selected)) return [sceneStore.selected];
  if (sceneStore.selected) {
    const parts = Painter.collectTargets(sceneStore.selected);
    if (parts.length) return parts;
  }
  return Painter.collectTargets(sceneStore.userObjects);
}

export function getPaintPrimaryMesh() {
  if (Painter.isPaintable(sceneStore.selected)) return sceneStore.selected;
  if (sceneStore.selected) {
    const parts = Painter.collectTargets(sceneStore.selected);
    if (parts.length) return parts[0];
  }
  const all = getPaintTargets();
  return all.length ? all[0] : null;
}

function updateColorControls(hex) {
  const normalized = paint.painter.setColor(hex);
  if (dom.paintColor) dom.paintColor.value = normalized;
  if (dom.paintColorPreview) dom.paintColorPreview.style.background = normalized;
  if (dom.paintHexInput && document.activeElement !== dom.paintHexInput) {
    dom.paintHexInput.value = normalized.toUpperCase();
  }
  dom.paintPaletteGrid?.querySelectorAll('[data-paint-swatch]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.paintSwatch.toLowerCase() === normalized.toLowerCase());
  });
}

function renderPaletteSwatches() {
  const grid = dom.paintPaletteGrid;
  if (!grid) return;
  grid.innerHTML = '';
  const colors = paint.painter.palette || PAINT_DEFAULT_PALETTE;
  for (const hex of colors) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'paint-palette-swatch';
    btn.dataset.paintSwatch = hex;
    btn.style.background = hex;
    btn.title = hex.toUpperCase();
    btn.setAttribute('aria-label', `Color ${hex.toUpperCase()}`);
    btn.addEventListener('click', () => {
      updateColorControls(hex);
      if (paint.painter.tool === 'eraser' || paint.painter.tool === 'picker') {
        paint.painter.tool = 'brush';
        syncPaintUI();
      }
    });
    grid.appendChild(btn);
  }
}

export function syncPaintUI() {
  const active = Boolean(paint.active);
  const painter = paint.painter;

  if (dom.paintBrushBar) dom.paintBrushBar.hidden = !active;
  if (dom.paintParamsBar) dom.paintParamsBar.hidden = !active;
  if (!active && dom.popPaintMore) {
    dom.popPaintMore.hidden = true;
    dom.btnPaintMore?.classList.remove('is-active');
  }

  document.querySelectorAll('[data-paint-tool]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.paintTool === painter.tool);
  });

  updateColorControls(painter.color);

  if (dom.paintRadius) {
    dom.paintRadius.value = String(painter.radius);
    syncRangeVisual(dom.paintRadius);
    if (dom.paintRadiusVal) dom.paintRadiusVal.textContent = painter.radius.toFixed(2);
  }
  if (dom.paintStrength) {
    dom.paintStrength.value = String(painter.strength);
    syncRangeVisual(dom.paintStrength);
    if (dom.paintStrengthVal) dom.paintStrengthVal.textContent = painter.strength.toFixed(2);
  }
  if (dom.paintHardness) {
    dom.paintHardness.value = String(painter.hardness);
    syncRangeVisual(dom.paintHardness);
    if (dom.paintHardnessVal) dom.paintHardnessVal.textContent = painter.hardness.toFixed(2);
  }
  if (dom.paintSymmetry) dom.paintSymmetry.value = painter.symmetry;
  if (dom.paintMode) dom.paintMode.value = painter.paintMode;
  if (dom.paintResolution) {
    dom.paintResolution.value = String(painter.resolution);
    dom.paintResolution.disabled = painter.paintMode === 'vertex';
  }
  if (dom.paintFrontOnly) dom.paintFrontOnly.checked = Boolean(painter.frontFacesOnly);

  const targetMesh = getPaintPrimaryMesh();
  if (dom.btnPaintFillAll) dom.btnPaintFillAll.disabled = !targetMesh;
  if (dom.btnPaintClear) dom.btnPaintClear.disabled = !targetMesh;

  if (dom.paintMeshInfo) {
    if (targetMesh) {
      const tex = targetMesh.material?.map;
      const isPaintTex = Boolean(tex?.userData?.isPaintTexture && tex?.mipmaps?.[0]);
      const detail =
        painter.paintMode === 'vertex'
          ? `${(targetMesh.geometry?.attributes?.position?.count || 0).toLocaleString('es-ES')} vértices`
          : isPaintTex
          ? `Textura ${tex.mipmaps[0].width}×${tex.mipmaps[0].height} px`
          : `Textura lista (${painter.resolution} px)`;
      dom.paintMeshInfo.innerHTML =
        `<strong>${targetMesh.name || `Malla #${targetMesh.id}`}</strong><br>${detail}`;
    } else {
      dom.paintMeshInfo.textContent = 'Selecciona o crea una malla para pintar.';
    }
  }
}

export function setPaintMode(enabled) {
  const next = Boolean(enabled);
  const wasActive = paint.active;

  if (next && cameraView.activeSceneCam) exitCameraView();
  if (next && edit.active) setEditMode(false);
  if (next && sculpt.active) setSculptMode(false);
  if (next && rig.active) history._hooks.setRigMode?.(false);

  if (viewport.gizmo?.drag) {
    viewport.gizmo.cancel();
    if (dom.gizmoReadout) dom.gizmoReadout.hidden = true;
  }

  if (next && !Painter.isPaintable(sceneStore.selected)) {
    const candidate = getPaintPrimaryMesh();
    if (candidate) {
      sceneStore.selected = candidate;
      sceneStore.selectedList = [candidate];
      if (viewport.gizmo) viewport.gizmo.attach(candidate);
      renderObjectList();
      syncSelectedUI();
    }
  }

  paint.active = next;
  paint.painter.setEnabled(next);

  if (viewport.controls) {
    viewport.controls.enabled = !(cameraView.activeSceneCam && cameraView.camViewLocked);
  }
  if (viewport.gizmo) {
    const rigHidingGizmo = rig.active && (rig.rigger.boneTool || rig.rigger.weightPaint);
    viewport.gizmo.enabled = !next && !sculpt.active && !edit.active && !rigHidingGizmo;
    viewport.gizmo.visible =
      !next &&
      !sculpt.active &&
      !edit.active &&
      !rigHidingGizmo &&
      !(cameraView.activeSceneCam && sceneStore.selected === cameraView.activeSceneCam);
  }

  if (dom.paintOverlay) {
    dom.paintOverlay.hidden = !next;
    if (!next) {
      const ctx = dom.paintOverlay.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, dom.paintOverlay.width, dom.paintOverlay.height);
    }
  }
  dom.viewportWrap?.classList.toggle('is-paint-cursor', next);

  const nextMode = next
    ? 'pintar'
    : sculpt.active
    ? 'modelar'
    : edit.active
    ? 'edicion'
    : rig.active
    ? 'esqueleto'
    : !wasActive && viewport.appMode === 'animacion'
    ? 'animacion'
    : 'pose';

  syncAppModeUI(nextMode);
  syncPaintUI();
  syncGizmoXyzPanel();
}

export function renderPaintOverlay(camera) {
  if (!paint.active || !camera) return;
  paint.painter.drawAttachedOverlay(camera);
}

export function fillPaintTargetAll() {
  const mesh = getPaintPrimaryMesh();
  if (!mesh) {
    setStatus('Selecciona una malla para rellenar.', true);
    return;
  }
  if (paint.painter.isStroking) paint.painter.commitStroke();
  const res = paint.painter.fillAll(mesh, paint.painter.color, viewport.scene);
  if (res && res.diff) {
    history.push({
      type: 'paint',
      label: 'Relleno total',
      mesh: res.mesh,
      geometry: res.geometry,
      texture: res.texture,
      diff: res.diff,
    });
    syncSelectedUI();
    syncPaintUI();
    setStatus(`Color ${paint.painter.color.toUpperCase()} aplicado a "${mesh.name || 'malla'}".`);
  }
}

export function clearPaintTarget() {
  const mesh = getPaintPrimaryMesh();
  if (!mesh) {
    setStatus('Selecciona una malla para limpiar.', true);
    return;
  }
  if (paint.painter.isStroking) paint.painter.commitStroke();
  const res = paint.painter.clearPaint(mesh, viewport.scene);
  if (res && res.diff) {
    history.push({
      type: 'paint',
      label: 'Limpiar pintura',
      mesh: res.mesh,
      geometry: res.geometry,
      texture: res.texture,
      diff: res.diff,
    });
    syncSelectedUI();
    syncPaintUI();
    setStatus(`Pintura limpiada en "${mesh.name || 'malla'}".`);
  } else {
    setStatus('La malla ya se encuentra en su color base.');
  }
}

export function bindPaintControls() {
  if (_bound) return;
  _bound = true;

  if (dom.paintSymmetry) {
    dom.paintSymmetry.innerHTML = '';
    for (const sym of PAINT_SYMMETRIES) {
      const opt = document.createElement('option');
      opt.value = sym;
      opt.textContent = SYMMETRY_LABELS[sym] || sym;
      opt.selected = sym === paint.painter.symmetry;
      dom.paintSymmetry.appendChild(opt);
    }
  }

  if (dom.paintMode) {
    dom.paintMode.innerHTML = '';
    for (const m of PAINT_MODES) {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = MODE_LABELS[m] || m;
      opt.selected = m === paint.painter.paintMode;
      dom.paintMode.appendChild(opt);
    }
  }

  if (dom.paintResolution) {
    dom.paintResolution.innerHTML = '';
    for (const res of PAINT_RESOLUTIONS) {
      const opt = document.createElement('option');
      opt.value = String(res);
      opt.textContent = `${res} px`;
      opt.selected = res === paint.painter.resolution;
      dom.paintResolution.appendChild(opt);
    }
  }

  renderPaletteSwatches();

  document.querySelectorAll('[data-paint-tool]').forEach((btn) => {
    btn.addEventListener('click', () => {
      paint.painter.tool = btn.dataset.paintTool;
      if (!paint.active) setPaintMode(true);
      else syncPaintUI();
    });
  });

  dom.paintColor?.addEventListener('input', (e) => {
    updateColorControls(e.target.value);
    if (paint.painter.tool === 'eraser' || paint.painter.tool === 'picker') {
      paint.painter.tool = 'brush';
      syncPaintUI();
    }
  });

  dom.paintHexInput?.addEventListener('change', (e) => {
    const raw = String(e.target.value || '').trim();
    const cleaned = raw.startsWith('#') ? raw : `#${raw}`;
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(cleaned)) {
      const [r, g, b] = parseHexColor(cleaned);
      updateColorControls(rgbToHex(r, g, b));
    } else {
      e.target.value = paint.painter.color.toUpperCase();
    }
  });

  dom.paintRadius?.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    paint.painter.radius = v;
    if (dom.paintRadiusVal) dom.paintRadiusVal.textContent = v.toFixed(2);
  });

  dom.paintStrength?.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    paint.painter.strength = v;
    if (dom.paintStrengthVal) dom.paintStrengthVal.textContent = v.toFixed(2);
  });

  dom.paintHardness?.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    paint.painter.hardness = v;
    if (dom.paintHardnessVal) dom.paintHardnessVal.textContent = v.toFixed(2);
  });

  dom.btnPaintMore?.addEventListener('click', () => {
    if (!dom.popPaintMore) return;
    const willOpen = dom.popPaintMore.hidden;
    dom.popPaintMore.hidden = !willOpen;
    dom.btnPaintMore.classList.toggle('is-active', willOpen);
    if (willOpen) syncPaintUI();
  });

  dom.paintSymmetry?.addEventListener('change', (e) => {
    paint.painter.symmetry = e.target.value;
    paint.painter.hover = null;
  });

  dom.paintMode?.addEventListener('change', (e) => {
    paint.painter.paintMode = e.target.value;
    syncPaintUI();
    syncSelectedUI();
  });

  dom.paintResolution?.addEventListener('change', (e) => {
    const nextRes = Number(e.target.value) || 1024;
    paint.painter.resolution = nextRes;
    const mesh = getPaintPrimaryMesh();
    if (mesh && paint.painter.paintMode === 'texture' && mesh.material?.map?.userData?.isPaintTexture) {
      Painter.resizePaintTexture(mesh, nextRes, viewport.scene);
      setStatus(`Resolución de textura ajustada a ${nextRes}×${nextRes} px.`);
    }
    syncPaintUI();
  });

  dom.paintFrontOnly?.addEventListener('change', (e) => {
    paint.painter.frontFacesOnly = e.target.checked;
  });

  dom.btnPaintFillAll?.addEventListener('click', fillPaintTargetAll);
  dom.btnPaintClear?.addEventListener('click', clearPaintTarget);

  paint.painter.attach({
    domElement: dom.viewportWrap,
    pointerDownTarget: () => dom.canvas,
    overlay: dom.paintOverlay,
    getCamera: () => viewport.camera,
    getControls: () => viewport.controls,
    getScene: () => viewport.scene,
    getTargets: getPaintTargets,
    getControlsEnabled: () => !(cameraView.activeSceneCam && cameraView.camViewLocked),
    onSelect: (mesh) => {
      if (mesh !== sceneStore.selected) {
        sceneStore.selected = mesh;
        sceneStore.selectedList = mesh ? [mesh] : [];
        if (viewport.gizmo) viewport.gizmo.attach(mesh);
        syncSelectedUI();
        renderObjectList();
        syncPaintUI();
      }
    },
    onColorPick: (pickedHex) => {
      updateColorControls(pickedHex);
      paint.painter.tool = 'brush';
      syncPaintUI();
      setStatus(`Color capturado: ${pickedHex.toUpperCase()}`);
    },
    onStrokeEnd: (res) => {
      if (res && res.diff) {
        history.push({
          type: 'paint',
          label: 'Trazo de pintura',
          mesh: res.mesh,
          geometry: res.geometry,
          texture: res.texture,
          diff: res.diff,
        });
        syncSelectedUI();
        syncPaintUI();
      }
    },
    onStrokeCancel: () => setStatus('Trazo cancelado.'),
    onRadiusChange: () => syncPaintUI(),
    onExit: () => setPaintMode(false),
  });
}
