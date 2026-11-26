import {
  Painter,
  PAINT_BRUSH_PRESETS,
  PAINT_SYMMETRIES,
  PAINT_MODES,
  PAINT_RESOLUTIONS,
  PAINT_DEFAULT_PALETTE,
  parseHexColor,
  rgbToHex,
  hexToHsv,
  hsvToRgb,
  hsvToHex,
} from '../src/modules/paint.js';
import { dom, setStatus, downloadBlob } from './dom.js';
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
import { syncRangeVisual, syncAllRanges } from './ui/rangeControls.js';

let _bound = false;
let _uvRaf = 0;
let _uvTimer = 0;
let _lastUvDrawMs = 0;
const UV_STROKE_MIN_INTERVAL_MS = 260;

const SYMMETRY_LABELS = { none: 'Ninguna', x: 'Eje X', y: 'Eje Y', z: 'Eje Z' };
const MODE_LABELS = { texture: 'Textura (UV)', vertex: 'Vértices' };
const PRESET_LABELS = {
  round: 'Redondo',
  hard: 'Duro',
  soft: 'Suave',
  chisel: 'Biselado',
  stipple: 'Tiza',
  splatter: 'Salpicar',
  pixel: 'Píxel',
  rake: 'Cerdas',
};

const _wheelHsv = { h: 0, s: 0.71, v: 0.94 };
let _baseWheelCanvas = null;
let _baseWheelSize = 0;

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

export function closePaintFlyouts(exceptId = null) {
  const flyouts = [dom.popPaintBrushes, dom.popPaintColor, dom.popPaintMore];
  for (const f of flyouts) {
    if (f && f.id !== exceptId) f.hidden = true;
  }
  const colorOpen = Boolean(dom.popPaintColor && !dom.popPaintColor.hidden);
  const moreOpen = Boolean(dom.popPaintMore && !dom.popPaintMore.hidden);
  dom.btnPaintColor?.classList.toggle('is-active', colorOpen);
  dom.btnPaintColor?.setAttribute('aria-expanded', colorOpen ? 'true' : 'false');
  dom.btnPaintMore?.classList.toggle('is-active', moreOpen);
}

function positionPaintBrushFlyout() {
  const flyout = dom.popPaintBrushes;
  const wrap = dom.viewportWrap;
  const btn = dom.btnPaintBrush || dom.paintBrushBar;
  if (!flyout || !wrap || !btn) return;
  const wrapRect = wrap.getBoundingClientRect();
  const btnRect = btn.getBoundingClientRect();
  if (!wrapRect.width || !wrapRect.height || !btnRect.height) return;
  const centerY = btnRect.top + btnRect.height * 0.5 - wrapRect.top;
  const estH = flyout.offsetHeight || 240;
  const minCenter = estH * 0.5 + 10;
  const maxCenter = Math.max(minCenter, wrapRect.height - estH * 0.5 - 66);
  const clamped = Math.max(minCenter, Math.min(maxCenter, centerY));
  flyout.style.top = `${Math.round(clamped)}px`;
  flyout.style.transform = 'translateY(-50%)';
}

function openPaintBrushFlyout() {
  if (!dom.popPaintBrushes) return;
  closePaintFlyouts(dom.popPaintBrushes.id);
  dom.popPaintBrushes.hidden = false;
  syncPaintUI();
  requestAnimationFrame(() => positionPaintBrushFlyout());
}

function ensureBaseColorWheel(pxSize) {
  if (typeof document === 'undefined') return null;
  if (_baseWheelCanvas && _baseWheelSize === pxSize) return _baseWheelCanvas;
  const cv = document.createElement('canvas');
  cv.width = pxSize;
  cv.height = pxSize;
  const ctx = cv.getContext('2d');
  if (!ctx) return null;

  const img = ctx.createImageData(pxSize, pxSize);
  const d = img.data;
  const half = pxSize * 0.5;
  const radius = Math.max(1, half - 2);

  for (let y = 0; y < pxSize; y++) {
    const dy = y + 0.5 - half;
    for (let x = 0; x < pxSize; x++) {
      const dx = x + 0.5 - half;
      const dist = Math.hypot(dx, dy);
      const o = (y * pxSize + x) * 4;
      if (dist > radius + 1.2) {
        d[o + 3] = 0;
        continue;
      }
      const sat = Math.min(1, dist / radius);
      const hue = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
      const [r, g, b] = hsvToRgb(hue, sat, 1);
      const edgeAlpha = dist <= radius ? 255 : Math.max(0, Math.min(255, Math.round((1 - (dist - radius) / 1.2) * 255)));
      d[o] = r;
      d[o + 1] = g;
      d[o + 2] = b;
      d[o + 3] = edgeAlpha;
    }
  }

  ctx.putImageData(img, 0, 0);
  _baseWheelCanvas = cv;
  _baseWheelSize = pxSize;
  return cv;
}

function renderColorWheel() {
  const cv = dom.paintColorWheel;
  const wrap = dom.paintColorWheelWrap;
  if (!cv || !wrap) return;
  const cssSize = Math.max(120, Math.round(wrap.clientWidth || cv.clientWidth || 176));
  const dpr = Math.min((typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1, 2);
  const pxSize = Math.round(cssSize * dpr);
  if (cv.width !== pxSize || cv.height !== pxSize) {
    cv.width = pxSize;
    cv.height = pxSize;
  }
  const ctx = cv.getContext('2d');
  if (!ctx) return;

  const base = ensureBaseColorWheel(pxSize);
  ctx.clearRect(0, 0, pxSize, pxSize);
  ctx.save();
  ctx.beginPath();
  ctx.arc(pxSize * 0.5, pxSize * 0.5, Math.max(1, pxSize * 0.5 - 2 * dpr), 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, pxSize, pxSize);
  if (base) {
    ctx.globalAlpha = Math.max(0, Math.min(1, _wheelHsv.v));
    ctx.drawImage(base, 0, 0, pxSize, pxSize);
  }
  ctx.restore();

  const rad = (_wheelHsv.h * Math.PI) / 180;
  const maxR = Math.max(4, cssSize * 0.5 - 3);
  const rPx = Math.max(0, Math.min(1, _wheelHsv.s)) * maxR;
  const cx = cssSize * 0.5 + Math.cos(rad) * rPx;
  const cy = cssSize * 0.5 + Math.sin(rad) * rPx;
  const currentHex = hsvToHex(_wheelHsv.h, _wheelHsv.s, _wheelHsv.v);
  if (dom.paintWheelCursor) {
    dom.paintWheelCursor.style.left = `${cx.toFixed(1)}px`;
    dom.paintWheelCursor.style.top = `${cy.toFixed(1)}px`;
    dom.paintWheelCursor.style.background = currentHex;
  }
  if (dom.paintColorValue) {
    const fullBrightHex = hsvToHex(_wheelHsv.h, _wheelHsv.s, 1);
    dom.paintColorValue.style.setProperty('--val-full-color', fullBrightHex);
  }
}

function updateColorControls(hex, { syncHsvFromHex = true } = {}) {
  const normalized = paint.painter.setColor(hex);
  if (syncHsvFromHex) {
    const nextHsv = hexToHsv(normalized);
    if (nextHsv.s > 0.01 && nextHsv.v > 0.01) _wheelHsv.h = nextHsv.h;
    if (nextHsv.v > 0.01) _wheelHsv.s = nextHsv.s;
    _wheelHsv.v = nextHsv.v;
  }

  const upper = normalized.toUpperCase();
  if (dom.paintColor) dom.paintColor.value = normalized;
  if (dom.paintColorPreview) dom.paintColorPreview.style.background = normalized;
  if (dom.paintWheelSwatch) dom.paintWheelSwatch.style.background = normalized;
  if (dom.paintColorHexBadge) dom.paintColorHexBadge.textContent = upper;
  if (dom.paintHexInput && document.activeElement !== dom.paintHexInput) {
    dom.paintHexInput.value = upper;
  }
  if (dom.paintColorValue) {
    const vPct = Math.round(_wheelHsv.v * 100);
    if (document.activeElement !== dom.paintColorValue) {
      dom.paintColorValue.value = String(vPct);
    }
    if (dom.paintColorValueNum) dom.paintColorValueNum.textContent = `${vPct}%`;
  }
  if (dom.popPaintColor && !dom.popPaintColor.hidden) {
    renderColorWheel();
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

function updatePaintUvPreview({ includeLarge = false } = {}) {
  const mesh = getPaintPrimaryMesh();
  if (dom.paintUvMiniCanvas) {
    Painter.renderUvPreview(dom.paintUvMiniCanvas, mesh, {
      width: 128,
      height: 128,
      showWireframe: true,
      lineWidth: 0.75,
    });
  }
  const modalOpen = Boolean(dom.paintUvModal && !dom.paintUvModal.hidden);
  if ((includeLarge || modalOpen) && dom.paintUvLargeCanvas) {
    const showWire = dom.paintUvWireframe ? Boolean(dom.paintUvWireframe.checked) : true;
    Painter.renderUvPreview(dom.paintUvLargeCanvas, mesh, {
      width: 512,
      height: 512,
      showWireframe: showWire,
      lineWidth: 1.15,
    });
    if (dom.paintUvMeta) {
      if (mesh) {
        const tex = mesh.material?.map;
        const isPaintTex = Boolean(tex?.userData?.isPaintTexture && tex?.mipmaps?.[0]);
        const resLabel = isPaintTex
          ? `${tex.mipmaps[0].width}×${tex.mipmaps[0].height} px`
          : tex?.image?.width
          ? `${tex.image.width}×${tex.image.height} px`
          : `Base ${paint.painter.resolution} px`;
        const geo = mesh.geometry;
        const triCount = geo?.index
          ? (geo.index.count / 3) | 0
          : ((geo?.attributes?.position?.count || 0) / 3) | 0;
        dom.paintUvMeta.textContent = `${mesh.name || `Malla #${mesh.id}`} · ${resLabel} · ${triCount} tris`;
      } else {
        dom.paintUvMeta.textContent = 'Sin modelo seleccionado';
      }
    }
    if (dom.btnPaintUvDownload) dom.btnPaintUvDownload.disabled = !mesh;
  }
  _lastUvDrawMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function scheduleUvPreviewUpdate() {
  if (paint.painter.isStroking && paint.painter._isMobile) {
    return;
  }
  if (_uvRaf || _uvTimer) return;
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const elapsed = now - _lastUvDrawMs;
  if (elapsed >= UV_STROKE_MIN_INTERVAL_MS) {
    _uvRaf = requestAnimationFrame(() => {
      _uvRaf = 0;
      if (paint.active) updatePaintUvPreview();
    });
  } else {
    _uvTimer = setTimeout(() => {
      _uvTimer = 0;
      if (_uvRaf) return;
      _uvRaf = requestAnimationFrame(() => {
        _uvRaf = 0;
        if (paint.active) updatePaintUvPreview();
      });
    }, Math.max(16, UV_STROKE_MIN_INTERVAL_MS - elapsed));
  }
}

function openPaintUvModal() {
  if (!dom.paintUvModal) return;
  dom.paintUvModal.hidden = false;
  updatePaintUvPreview({ includeLarge: true });
}

function closePaintUvModal() {
  if (!dom.paintUvModal) return;
  dom.paintUvModal.hidden = true;
}

export function syncPaintUI() {
  const active = Boolean(paint.active);
  const painter = paint.painter;

  if (dom.paintBrushBar) dom.paintBrushBar.hidden = !active;
  if (dom.paintParamsBar) dom.paintParamsBar.hidden = !active;
  if (dom.paintUvCard) dom.paintUvCard.hidden = !active;
  if (!active) {
    closePaintFlyouts();
    closePaintUvModal();
  }

  document.querySelectorAll('[data-paint-tool]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.paintTool === painter.tool);
  });

  const activePreset = PAINT_BRUSH_PRESETS.includes(painter.brushPreset) ? painter.brushPreset : 'round';
  const presetLabel = PRESET_LABELS[activePreset] || 'Redondo';
  document.querySelectorAll('[data-paint-brush-preset]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.paintBrushPreset === activePreset);
  });
  if (dom.paintBrushPresetBadge) dom.paintBrushPresetBadge.textContent = presetLabel;
  if (dom.btnPaintBrush) {
    dom.btnPaintBrush.title = `Pincel · ${presetLabel} (2× clic para cambiar tipo)`;
  }

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

  if (active) {
    updatePaintUvPreview();
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
  if (next) {
    paint.painter.previewHoverAtCenter?.(viewport.camera, getPaintTargets());
  } else {
    if (_uvTimer) { clearTimeout(_uvTimer); _uvTimer = 0; }
    if (_uvRaf) { cancelAnimationFrame(_uvRaf); _uvRaf = 0; }
  }

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

  let lastBrushTapAt = 0;
  let brushSecondTapTimer = 0;
  document.querySelectorAll('[data-paint-tool]').forEach((btn) => {
    const tool = btn.dataset.paintTool;
    if (tool === 'brush') {
      btn.addEventListener('click', () => {
        if (dom.popPaintBrushes && !dom.popPaintBrushes.hidden) {
          clearTimeout(brushSecondTapTimer);
          lastBrushTapAt = 0;
          closePaintFlyouts();
          return;
        }
        const wasAlreadyBrush = paint.active && paint.painter.tool === 'brush';
        if (!wasAlreadyBrush) {
          paint.painter.tool = 'brush';
          lastBrushTapAt = performance.now();
          if (!paint.active) setPaintMode(true);
          else syncPaintUI();
          return;
        }
        const now = performance.now();
        if (now - lastBrushTapAt <= 380) {
          clearTimeout(brushSecondTapTimer);
          lastBrushTapAt = 0;
          openPaintBrushFlyout();
          return;
        }
        lastBrushTapAt = now;
        clearTimeout(brushSecondTapTimer);
        brushSecondTapTimer = setTimeout(() => {
          lastBrushTapAt = 0;
          openPaintBrushFlyout();
        }, 310);
      });
    } else {
      btn.addEventListener('click', () => {
        clearTimeout(brushSecondTapTimer);
        lastBrushTapAt = 0;
        if (dom.popPaintBrushes) dom.popPaintBrushes.hidden = true;
        paint.painter.tool = tool;
        if (!paint.active) setPaintMode(true);
        else syncPaintUI();
      });
    }
  });

  document.querySelectorAll('[data-paint-brush-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const preset = btn.dataset.paintBrushPreset;
      paint.painter.setBrushPreset(preset);
      paint.painter.tool = 'brush';
      closePaintFlyouts();
      if (!paint.active) setPaintMode(true);
      else syncPaintUI();
      setStatus(`Pincel: ${PRESET_LABELS[paint.painter.brushPreset] || paint.painter.brushPreset}`);
    });
  });

  dom.btnPaintColor?.addEventListener('click', () => {
    if (!dom.popPaintColor) return;
    const willOpen = dom.popPaintColor.hidden;
    closePaintFlyouts(willOpen ? dom.popPaintColor.id : null);
    dom.popPaintColor.hidden = !willOpen;
    dom.btnPaintColor.classList.toggle('is-active', willOpen);
    dom.btnPaintColor.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    if (willOpen) {
      syncAllRanges(dom.popPaintColor);
      updateColorControls(paint.painter.color);
      requestAnimationFrame(() => renderColorWheel());
    }
  });

  // Interacción táctil y con ratón sobre el círculo cromático HSV
  if (dom.paintColorWheelWrap) {
    let wheelPointerId = null;
    const pickFromWheelEvent = (e) => {
      const rect = dom.paintColorWheelWrap.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const cx = rect.left + rect.width * 0.5;
      const cy = rect.top + rect.height * 0.5;
      const dx = e.clientX - cx;
      const dy = e.clientY - cy;
      const maxR = Math.max(4, rect.width * 0.5 - 3);
      const dist = Math.hypot(dx, dy);
      _wheelHsv.h = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
      _wheelHsv.s = Math.max(0, Math.min(1, dist / maxR));
      if (_wheelHsv.v < 0.02) _wheelHsv.v = 1;
      const nextHex = hsvToHex(_wheelHsv.h, _wheelHsv.s, _wheelHsv.v);
      updateColorControls(nextHex, { syncHsvFromHex: false });
      if (paint.painter.tool === 'eraser' || paint.painter.tool === 'picker') {
        paint.painter.tool = 'brush';
        syncPaintUI();
      }
    };

    dom.paintColorWheelWrap.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      wheelPointerId = e.pointerId;
      try { dom.paintColorWheelWrap.setPointerCapture(e.pointerId); } catch (_) {}
      pickFromWheelEvent(e);
    });
    dom.paintColorWheelWrap.addEventListener('pointermove', (e) => {
      if (wheelPointerId !== e.pointerId) return;
      pickFromWheelEvent(e);
    });
    const endWheelDrag = (e) => {
      if (wheelPointerId !== e.pointerId) return;
      wheelPointerId = null;
      try {
        if (dom.paintColorWheelWrap.hasPointerCapture?.(e.pointerId)) {
          dom.paintColorWheelWrap.releasePointerCapture(e.pointerId);
        }
      } catch (_) {}
    };
    dom.paintColorWheelWrap.addEventListener('pointerup', endWheelDrag);
    dom.paintColorWheelWrap.addEventListener('pointercancel', endWheelDrag);
  }

  dom.paintColorValue?.addEventListener('input', (e) => {
    const pct = Math.max(0, Math.min(100, Number(e.target.value) || 0));
    _wheelHsv.v = pct / 100;
    const nextHex = hsvToHex(_wheelHsv.h, _wheelHsv.s, _wheelHsv.v);
    updateColorControls(nextHex, { syncHsvFromHex: false });
    if (paint.painter.tool === 'eraser' || paint.painter.tool === 'picker') {
      paint.painter.tool = 'brush';
      syncPaintUI();
    }
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
    closePaintFlyouts(willOpen ? dom.popPaintMore.id : null);
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

  dom.paintUvCard?.addEventListener('click', () => {
    if (paint.active) openPaintUvModal();
  });
  dom.btnPaintUvX?.addEventListener('click', closePaintUvModal);
  dom.btnPaintUvClose?.addEventListener('click', closePaintUvModal);
  dom.paintUvModal?.addEventListener('click', (e) => {
    if (e.target === dom.paintUvModal) closePaintUvModal();
  });
  dom.paintUvWireframe?.addEventListener('change', () => {
    updatePaintUvPreview({ includeLarge: true });
  });
  dom.btnPaintUvDownload?.addEventListener('click', async () => {
    const mesh = getPaintPrimaryMesh();
    if (!mesh) return;
    const blob = await Painter.exportUvTextureBlob(mesh, {
      includeWireframe: Boolean(dom.paintUvWireframe?.checked),
    });
    if (!blob) {
      setStatus('No se pudo exportar la imagen de textura UV.', true);
      return;
    }
    const safeName = (mesh.name || 'textura_uv').replace(/\s+/g, '_');
    downloadBlob(blob, `${safeName}_uv.png`);
    setStatus(`Textura UV descargada: ${safeName}_uv.png`);
  });

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
    onStrokeStep: () => {
      scheduleUvPreviewUpdate();
    },
    onStrokeEnd: (res) => {
      if (_uvTimer) { clearTimeout(_uvTimer); _uvTimer = 0; }
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
      } else if (paint.active) {
        updatePaintUvPreview();
      }
    },
    onStrokeCancel: () => {
      if (_uvTimer) { clearTimeout(_uvTimer); _uvTimer = 0; }
      if (paint.active) updatePaintUvPreview();
      setStatus('Trazo cancelado.');
    },
    onRadiusChange: () => syncPaintUI(),
    onExit: () => setPaintMode(false),
  });
}
