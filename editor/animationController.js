import { AnimationMixer } from '../src/modules/animation.js';
import {
  isCssLandscape90,
  clientToLocalPoint,
  clientToViewportPoint,
  getLogicalViewportSize,
} from '../src/core/viewportCoords.js';
import { dom, setStatus } from './dom.js';
import { viewport, sceneStore, cameraView, timeline, animState, edit } from './store.js';
import { history } from './history.js';
import { syncRangeVisual } from './ui/rangeControls.js';

const MIN_PX_PER_SEC = 4;
const MAX_PX_PER_SEC = 480;
const LONG_PRESS_MS = 460;
const LONG_PRESS_MOVE_PX = 6;
const INTERP_LABELS = {
  linear: 'Normal',
  smooth: 'Suave',
  easeIn: 'Entrada suave',
  easeOut: 'Salida suave',
  step: 'Escalón',
};
const PROP_LABELS = {
  position: 'Posición',
  quaternion: 'Rotación',
  scale: 'Escala',
};

const _animHooks = {
  syncTransformInputs: null,
  updateViewfinderOverlay: null,
  syncCameraHelperSelection: null,
};

let _tlCtx = null;
let _tlWidth = 0;
let _tlHeight = 0;
let _tlDpr = 1;
let _tlHoverZone = null; // 'duration' | 'keyframe' | null
let _bound = false;
let _ro = null;
let _lastSyncedSelection = undefined;

export function setAnimationHooks(hooks = {}) {
  Object.assign(_animHooks, hooks);
}

// ============================================================
// UTILIDADES DE PROPIEDADES POR HERRAMIENTA (UI <-> LIBRERÍA)
// ============================================================

export function snapTimelineTime(t) {
  return timeline.snapTime(t);
}

const UNIFIED_TRANSFORM_PROPS = ['position', 'quaternion', 'scale'];

export function getActiveToolKeyframeProperties() {
  if (edit.active) return null;
  return UNIFIED_TRANSFORM_PROPS.slice();
}

export function getObjectClips(obj) {
  return timeline.getObjectClips(obj);
}

export function getActiveClipForObject(obj) {
  return timeline.getActiveClipForObject(obj);
}

export function getClipOwner(clip) {
  return timeline.getClipOwner(clip);
}

export function getAllSceneClips() {
  return timeline.getAllClips(sceneStore.animations);
}

function getEffectiveClipContext() {
  if (sceneStore.selected) {
    const resolved = timeline.resolveClipContext(sceneStore.selected);
    if (resolved.clip === timeline.currentClip) return resolved;
  }
  return {
    clip: timeline.currentClip,
    owner: timeline.getClipOwner(timeline.currentClip),
    filterTarget: null,
  };
}

export function syncSceneClipListToStore() {
  sceneStore.animations = timeline.getAllClips();
  if (dom.animSelect) {
    dom.animSelect.innerHTML = '';
    sceneStore.animations.forEach((clip, idx) => {
      const opt = document.createElement('option');
      opt.value = String(idx);
      opt.textContent = clip.name || `Clip ${idx + 1}`;
      dom.animSelect.appendChild(opt);
    });
  }
}

export function snapshotClipState(clip) {
  return clip ? clip.captureSnapshot() : null;
}

export function restoreClipState(clip, snap) {
  if (!clip || !snap) return;
  clip.restoreSnapshot(snap);
  evaluateActiveAnimationsAt(timeline.currentTime);
}

export function createClipForObject(obj, name = '', { duration = timeline.defaultDuration || 3.0, select = true } = {}) {
  const owner = obj || sceneStore.selected || null;
  const clip = timeline.createClip(owner, name, { duration, select });
  syncSceneClipListToStore();
  syncAnimationUI();
  return clip;
}

export function selectClip(clip) {
  timeline.selectClip(clip, { roots: sceneStore.userObjects, fallbackRoot: viewport.scene });
  _animHooks.syncTransformInputs?.();
  _animHooks.syncCameraHelperSelection?.();
  syncAnimationUI();
}

export function renameClip(clip, newName) {
  if (!timeline.renameClip(clip, newName)) return;
  syncSceneClipListToStore();
  syncAnimationUI();
}

export function deleteClip(clip) {
  if (!timeline.deleteClip(clip, sceneStore.selected)) return;
  if (Array.isArray(sceneStore.animations)) {
    sceneStore.animations = sceneStore.animations.filter((c) => c !== clip);
  }
  syncSceneClipListToStore();
  syncAnimationUI();
}

export function cleanupClipsForObject(obj) {
  timeline.cleanupClipsForObject(obj, sceneStore.selected);
  syncSceneClipListToStore();
  syncAnimationUI();
}

export function clearAllCustomClips() {
  timeline.clearAllClips();
  _lastSyncedSelection = undefined;
  syncSceneClipListToStore();
  syncAnimationUI();
}

export function captureAnimStateSnapshot() {
  return timeline.captureStateSnapshot();
}

export function restoreAnimStateSnapshot(snap) {
  timeline.restoreStateSnapshot(snap, sceneStore.selected);
  _lastSyncedSelection = sceneStore.selected;
  syncSceneClipListToStore();
  syncAnimationUI();
}

export function registerImportedClips(root, clips = []) {
  timeline.registerImportedClips(root, clips);
  syncSceneClipListToStore();
  syncAnimationUI();
}

// ============================================================
// EVALUACIÓN DE CLIPS CONSUMIENDO LA LIBRERÍA
// ============================================================

export function evaluateClipAt(clip, time) {
  const updatedObjects = timeline.evaluateClipAt(clip, time, viewport.scene);
  if (
    cameraView.activeSceneCam &&
    viewport.controls &&
    updatedObjects.includes(cameraView.activeSceneCam)
  ) {
    viewport.controls.syncFromCamera();
    _animHooks.updateViewfinderOverlay?.();
  }
}

export function evaluateActiveAnimationsAt(time) {
  const updatedObjects = timeline.evaluateAt(time, sceneStore.userObjects, viewport.scene);
  if (
    cameraView.activeSceneCam &&
    viewport.controls &&
    updatedObjects.includes(cameraView.activeSceneCam)
  ) {
    viewport.controls.syncFromCamera();
    _animHooks.updateViewfinderOverlay?.();
  }
  _animHooks.syncTransformInputs?.();
  _animHooks.syncCameraHelperSelection?.();
}

// ============================================================
// KEYFRAMES (DELEGADO EN AnimationTimeline / AnimationClip)
// ============================================================

export function getClipKeyframeTimes(clip, property = null, target = null, owner = null) {
  return clip ? clip.getKeyframeTimes({ property, target, owner }) : [];
}

export function isPlayheadOnKeyframe(
  clip = timeline.currentClip,
  time = timeline.currentTime,
  properties = null
) {
  if (!clip) return false;
  const ctx = getEffectiveClipContext();
  if (clip === ctx.clip && ctx.filterTarget) {
    return clip.hasKeyframeAt(time, {
      properties,
      target: ctx.filterTarget,
      owner: ctx.owner,
      eps: timeline.keyframeHitEps,
    });
  }
  return clip.hasKeyframeAt(time, { properties, eps: timeline.keyframeHitEps });
}

export function getClipInterpolation(clip = timeline.currentClip) {
  return clip ? clip.getInterpolation() : 'linear';
}

export function applyInterpolation(interp) {
  const clip = timeline.currentClip;
  if (!clip) return;
  const before = clip.captureSnapshot();
  clip.setInterpolation(interp);
  const after = clip.captureSnapshot();
  history.push({
    type: 'animClip',
    clip,
    owner: getClipOwner(clip),
    before,
    after,
    label: `Curva: ${INTERP_LABELS[interp] || interp}`,
  });
  evaluateActiveAnimationsAt(timeline.currentTime);
  syncAnimationUI();
}

export function insertKeyframeAt(
  obj,
  time = timeline.currentTime,
  { properties = null, recordHistory = true } = {}
) {
  if (!obj) {
    setStatus('Selecciona un objeto para agregar un keyframe.', true);
    return false;
  }
  const props =
    Array.isArray(properties) && properties.length
      ? properties
      : getActiveToolKeyframeProperties() || ['position', 'quaternion', 'scale'];

  const res = timeline.insertKeyframe(obj, time, { properties: props });
  if (!res.ok) return false;

  if (recordHistory) {
    const propLabel = props.length === 1 ? (PROP_LABELS[props[0]] || props[0]) : 'Transformación';
    const pushEntries = () => {
      if (res.createdNewClip && res.beforeState && res.afterState) {
        history.push({
          type: 'animState',
          before: res.beforeState,
          after: res.afterState,
          label: 'Crear clip',
        });
      }
      history.push({
        type: 'animClip',
        clip: res.clip,
        owner: res.target,
        before: res.beforeClip,
        after: res.afterClip,
        label: `Keyframe ${propLabel} en ${res.time.toFixed(2)}s`,
      });
    };
    if (res.createdNewClip) {
      history.runGrouped(`Keyframe ${propLabel} en ${res.time.toFixed(2)}s`, pushEntries);
    } else {
      pushEntries();
    }
  }
  syncSceneClipListToStore();
  syncAnimationUI();
  return true;
}

export function removeKeyframeAt(
  clip = timeline.currentClip,
  time = timeline.currentTime,
  { properties = null } = {}
) {
  if (!clip) return false;
  const ctx = getEffectiveClipContext();
  const target = clip === ctx.clip ? ctx.filterTarget : null;
  const owner = clip === ctx.clip ? ctx.owner : getClipOwner(clip);

  const before = clip.captureSnapshot();
  const anyRemoved = clip.removeKeyframeAt(time, {
    properties,
    target,
    owner,
    eps: timeline.keyframeHitEps,
  });
  if (!anyRemoved) return false;

  const after = clip.captureSnapshot();
  history.push({
    type: 'animClip',
    clip,
    owner: getClipOwner(clip),
    before,
    after,
    label: 'Quitar keyframe',
  });
  evaluateActiveAnimationsAt(timeline.currentTime);
  syncAnimationUI();
  return true;
}

export function toggleKeyframeAtCurrentTime() {
  const ctx = getEffectiveClipContext();
  if (ctx.clip && timeline.hasKeyframeAtSelection(sceneStore.selected, timeline.currentTime, null)) {
    removeKeyframeAt(ctx.clip, timeline.currentTime, { properties: null });
    setStatus(`Keyframe eliminado en ${timeline.currentTime.toFixed(2)}s`);
    return;
  }
  const target = sceneStore.selected || getClipOwner(ctx.clip);
  if (!target) {
    setStatus('Selecciona un objeto para insertar un keyframe.', true);
    return;
  }
  if (insertKeyframeAt(target, timeline.currentTime, { properties: UNIFIED_TRANSFORM_PROPS, recordHistory: true })) {
    setStatus(`Keyframe guardado en ${timeline.currentTime.toFixed(2)}s (posición, rotación y escala)`);
  }
}

export function recordAutoKeyframeIfNeeded(targets = [], opts = {}) {
  if (viewport.appMode !== 'animacion' || !timeline.autoKeyframe || timeline.playing) return;
  const list = Array.isArray(targets) && targets.length ? targets : sceneStore.selected ? [sceneStore.selected] : [];

  const recorded = timeline.recordAutoKeyframe(list, {
    beforeList: opts.beforeList || null,
    afterList: opts.afterList || null,
    properties: opts.properties || null,
    unified: true,
    time: timeline.currentTime,
  });
  if (!recorded.length) return;

  for (const res of recorded) {
    const propLabel = res.properties.length === 1
      ? (PROP_LABELS[res.properties[0]] || res.properties[0])
      : 'Transformación';
    const pushEntries = () => {
      if (res.createdNewClip && res.beforeState && res.afterState) {
        history.push({
          type: 'animState',
          before: res.beforeState,
          after: res.afterState,
          label: 'Crear clip',
        });
      }
      history.push({
        type: 'animClip',
        clip: res.clip,
        owner: res.target,
        before: res.beforeClip,
        after: res.afterClip,
        label: `Keyframe ${propLabel} en ${res.time.toFixed(2)}s`,
      });
    };
    if (res.createdNewClip) {
      history.runGrouped(`Keyframe ${propLabel} en ${res.time.toFixed(2)}s`, pushEntries);
    } else {
      pushEntries();
    }
  }
  syncSceneClipListToStore();
  syncAnimationUI();
}

// ============================================================
// COPIAR Y PEGAR KEYFRAMES (MANTENER PRESIONADO)
// ============================================================

export function copyKeyframeFromTimeline(clip, time, properties = null) {
  if (!clip) return false;
  const ctx = getEffectiveClipContext();
  const data = clip.extractKeyframeData(time, {
    properties,
    target: clip === ctx.clip ? ctx.filterTarget : null,
    owner: clip === ctx.clip ? ctx.owner : getClipOwner(clip),
    eps: timeline.keyframeHitEps,
  });
  if (!data) {
    setStatus('No hay keyframe en ese punto para copiar.', true);
    return false;
  }
  timeline.copiedKeyframe = data;
  const names = Object.keys(data.properties).map((p) => PROP_LABELS[p] || p).join(', ');
  setStatus(`Keyframe copiado (${names}) de ${data.sourceTime.toFixed(2)}s.`);
  return true;
}

export function pasteKeyframeAtCurrentTime(targetObj = null, time = timeline.currentTime) {
  const obj = targetObj || sceneStore.selected || getClipOwner(timeline.currentClip);
  const res = timeline.pasteKeyframe(obj, time, {
    roots: sceneStore.userObjects,
    fallbackRoot: viewport.scene,
  });
  if (!res.ok) {
    if (res.reason === 'empty-clipboard') {
      setStatus('No has copiado ningún keyframe todavía. Mantén presionado un keyframe para copiarlo.', true);
    } else if (res.reason === 'no-target') {
      setStatus('Selecciona un objeto para pegar el keyframe.', true);
    }
    return false;
  }

  const pushEntries = () => {
    if (res.createdNewClip && res.beforeState && res.afterState) {
      history.push({
        type: 'animState',
        before: res.beforeState,
        after: res.afterState,
        label: 'Crear clip',
      });
    }
    history.push({
      type: 'animClip',
      clip: res.clip,
      owner: res.owner,
      before: res.beforeClip,
      after: res.afterClip,
      label: `Pegar keyframe en ${res.time.toFixed(2)}s`,
    });
  };
  if (res.createdNewClip) {
    history.runGrouped(`Pegar keyframe en ${res.time.toFixed(2)}s`, pushEntries);
  } else {
    pushEntries();
  }

  _animHooks.syncTransformInputs?.();
  _animHooks.syncCameraHelperSelection?.();
  syncSceneClipListToStore();
  syncAnimationUI();
  const names = res.pasted.map((p) => PROP_LABELS[p] || p).join(', ');
  setStatus(`Keyframe pegado (${names}) en ${res.time.toFixed(2)}s.`);
  return true;
}

// ============================================================
// NAVEGACIÓN, REPRODUCCIÓN Y LÍNEA DE TIEMPO
// ============================================================

export function setTimelineTime(t) {
  const updatedObjects = timeline.setCurrentTime(t, sceneStore.userObjects, viewport.scene);
  if (
    cameraView.activeSceneCam &&
    viewport.controls &&
    updatedObjects.includes(cameraView.activeSceneCam)
  ) {
    viewport.controls.syncFromCamera();
    _animHooks.updateViewfinderOverlay?.();
  }
  _animHooks.syncTransformInputs?.();
  _animHooks.syncCameraHelperSelection?.();
  syncAnimationHeader();
  drawTimelineCanvas();
}

export function getActiveClipDuration() {
  return timeline.getActiveDuration();
}

export function jumpToZeroTime() {
  if (timeline.playing) setTimelinePlaying(false);
  setTimelineTime(0);
}

export function jumpPrevKeyframe() {
  const kfs = timeline.getKeyframeTimesForSelection(sceneStore.selected);
  if (!kfs.length) return;
  const cur = timeline.currentTime;
  for (let i = kfs.length - 1; i >= 0; i--) {
    if (kfs[i] < cur - 0.015) {
      setTimelineTime(kfs[i]);
      return;
    }
  }
  setTimelineTime(kfs[0]);
}

export function jumpNextKeyframe() {
  const kfs = timeline.getKeyframeTimesForSelection(sceneStore.selected);
  if (!kfs.length) return;
  const cur = timeline.currentTime;
  for (let i = 0; i < kfs.length; i++) {
    if (kfs[i] > cur + 0.015) {
      setTimelineTime(kfs[i]);
      return;
    }
  }
  setTimelineTime(kfs[kfs.length - 1]);
}

export function setTimelinePlaying(play) {
  const res = timeline.setPlaying(play, sceneStore.userObjects, sceneStore.animations);
  if (play && res.empty) {
    setStatus('Agrega al menos 2 keyframes para reproducir la animación.');
  }
  syncAnimationHeader();
}

export function toggleTimelinePlayback() {
  setTimelinePlaying(!timeline.playing);
}

export function getTimelinePlaybackDuration() {
  return timeline.getPlaybackDuration(sceneStore.userObjects, sceneStore.animations);
}

export function stepAnimationTimeline(dt) {
  const stepRes = timeline.step(dt, sceneStore.userObjects, sceneStore.animations, viewport.scene);
  if (
    cameraView.activeSceneCam &&
    viewport.controls &&
    stepRes.updatedObjects.includes(cameraView.activeSceneCam)
  ) {
    viewport.controls.syncFromCamera();
    _animHooks.updateViewfinderOverlay?.();
  }
  _animHooks.syncTransformInputs?.();
  _animHooks.syncCameraHelperSelection?.();
  if (viewport.appMode === 'animacion') {
    syncAnimationHeader();
    drawTimelineCanvas();
  }
}

// ============================================================
// INTEGRACIÓN CON GRABACIÓN DE VIDEO DE CÁMARA
// ============================================================

export function getMaxSceneAnimationDuration() {
  return timeline.getMaxDuration(sceneStore.userObjects, sceneStore.animations);
}

export function beginCameraTimelinePlayback() {
  timeline.playing = false;
  timeline.currentTime = 0;
  evaluateActiveAnimationsAt(0);

  if (sceneStore.mixer && sceneStore.animations.length) {
    sceneStore.mixer.stopAllAction();
    for (const clip of sceneStore.animations) {
      const act = sceneStore.mixer.clipAction(clip, 'once');
      act.reset();
      act.setLoop('once');
      act.play();
    }
    sceneStore.animPlaying = true;
  }

  if (viewport.appMode === 'animacion') {
    syncAnimationHeader();
    drawTimelineCanvas();
  }
}

export function stepCameraTimelinePlayback(dt) {
  const speed = timeline.speed > 0 ? timeline.speed : 1;
  timeline.currentTime += dt * speed;
  evaluateActiveAnimationsAt(timeline.currentTime);
  if (sceneStore.mixer && sceneStore.animPlaying) {
    sceneStore.mixer.update(dt * speed);
  }
  if (viewport.appMode === 'animacion') {
    syncAnimationHeader();
    drawTimelineCanvas();
  }
}

// ============================================================
// RENDERIZADO DEL CANVAS DE LÍNEA DE TIEMPO Y HIT-TESTING
// ============================================================

const RULER_H = 24;

function getTimelineRows(canvasHeight) {
  const bodyH = Math.max(30, canvasHeight - RULER_H);
  const rows = [{ label: 'Keyframes', filter: null }];
  return { rows, rowH: bodyH };
}

function formatTickNumber(val) {
  const rounded = Math.round(val * 100) / 100;
  if (Object.is(rounded, -0) || rounded === 0) return '0';
  return String(rounded);
}

function chooseTickStep(pxPerSec) {
  const candidates = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  for (const step of candidates) {
    if (step * pxPerSec >= 46) return step;
  }
  return 600;
}

function timeToX(t) {
  return _tlWidth * 0.5 + (t - timeline.currentTime) * animState.pxPerSec;
}

function xToTime(x) {
  return timeline.currentTime + (x - _tlWidth * 0.5) / animState.pxPerSec;
}

function hitTestTimelineKeyframe(clip, x, y, hitTol = 13) {
  if (!clip || y <= RULER_H) return null;
  const ctx = getEffectiveClipContext();
  const target = clip === ctx.clip ? ctx.filterTarget : null;
  const owner = clip === ctx.clip ? ctx.owner : getClipOwner(clip);
  const { rows, rowH } = getTimelineRows(_tlHeight);
  const rowIndex = Math.max(0, Math.min(rows.length - 1, Math.floor((y - RULER_H) / rowH)));
  const row = rows[rowIndex];
  const times = clip.getKeyframeTimes({ property: row.filter, target, owner });
  let bestT = null;
  let bestDist = hitTol;
  for (const kt of times) {
    const d = Math.abs(timeToX(kt) - x);
    if (d < bestDist) {
      bestDist = d;
      bestT = kt;
    }
  }
  if (bestT === null) return null;
  return { time: bestT, filter: row.filter, label: row.label, rowIndex };
}

export function drawTimelineCanvas() {
  const canvas = dom.animTlCanvas;
  const wrap = dom.animTlTrackWrap;
  if (!canvas || !wrap || viewport.appMode !== 'animacion') return;

  const cw = wrap.clientWidth || 0;
  const ch = wrap.clientHeight || 0;
  const rect = cw > 0 && ch > 0 ? null : wrap.getBoundingClientRect();
  const w = Math.max(100, Math.floor(cw > 0 ? cw : rect.width));
  const h = Math.max(36, Math.floor(ch > 0 ? ch : rect.height));
  const dpr = Math.min(2, window.devicePixelRatio || 1);

  if (w !== _tlWidth || h !== _tlHeight || dpr !== _tlDpr) {
    _tlWidth = w;
    _tlHeight = h;
    _tlDpr = dpr;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
  }

  const ctx = _tlCtx || canvas.getContext('2d');
  if (!ctx) return;
  _tlCtx = ctx;

  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const dur = getActiveClipDuration();
  const pxPerSec = animState.pxPerSec;
  const centerX = w * 0.5;

  // Fondo regla y zonas fuera de rango [0, dur]
  const xZero = timeToX(0);
  const xDur = timeToX(dur);

  ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
  if (xZero > 0) ctx.fillRect(0, RULER_H, Math.min(w, xZero), h - RULER_H);
  if (xDur < w) ctx.fillRect(Math.max(0, xDur), RULER_H, w - Math.max(0, xDur), h - RULER_H);

  ctx.fillStyle = 'rgba(255, 255, 255, 0.035)';
  ctx.fillRect(0, 0, w, RULER_H);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, RULER_H);
  ctx.lineTo(w, RULER_H);
  ctx.stroke();

  // Ticks y números de tiempo adaptativos
  const step = chooseTickStep(pxPerSec);
  const subStep = step >= 0.25 ? step * 0.25 : step * 0.5;
  const tMin = Math.max(0, xToTime(0) - step);
  const tMax = Math.max(dur + step, xToTime(w) + step);

  ctx.font = '500 10.5px "JetBrains Mono", monospace';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';

  const startSub = Math.floor(tMin / subStep) * subStep;
  for (let t = Math.max(0, startSub); t <= tMax; t += subStep) {
    const x = timeToX(t);
    if (x < -30 || x > w + 30) continue;
    const isMajor = Math.abs(Math.round(t / step) * step - t) < 1e-4;
    if (isMajor) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
      ctx.beginPath();
      ctx.moveTo(x, RULER_H);
      ctx.lineTo(x, h);
      ctx.stroke();

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
      ctx.beginPath();
      ctx.moveTo(x, RULER_H - 6);
      ctx.lineTo(x, RULER_H);
      ctx.stroke();

      ctx.fillStyle = '#9ca3af';
      ctx.fillText(formatTickNumber(t), x, 10);
    } else {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
      ctx.beginPath();
      ctx.moveTo(x, RULER_H - 3.5);
      ctx.lineTo(x, RULER_H);
      ctx.stroke();
    }
  }

  // Filas de pistas aisladas al objeto/hueso seleccionado
  const { rows, rowH } = getTimelineRows(h);
  const clipCtx = getEffectiveClipContext();
  const clip = clipCtx.clip;

  rows.forEach((row, rIdx) => {
    const yTop = RULER_H + rIdx * rowH;
    const yMid = yTop + rowH * 0.5;

    if (rIdx > 0) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
      ctx.beginPath();
      ctx.moveTo(0, yTop);
      ctx.lineTo(w, yTop);
      ctx.stroke();
    }

    ctx.font = '600 10px "Plus Jakarta Sans", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = rIdx === 0 ? '#d4d4d8' : '#71717a';
    ctx.fillText(row.label, 8, yMid);

    if (!clip) return;
    const times = clip.getKeyframeTimes({
      property: row.filter,
      target: clipCtx.filterTarget,
      owner: clipCtx.owner,
    });

    for (const kt of times) {
      const kx = timeToX(kt);
      if (kx < -14 || kx > w + 14) continue;
      const isAtHead = Math.abs(kt - timeline.currentTime) <= timeline.keyframeHitEps;
      const r = 6;

      ctx.save();
      ctx.translate(kx, yMid);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = isAtHead ? '#60a5fa' : '#f59e0b';
      ctx.strokeStyle = isAtHead ? '#eff6ff' : '#fde68a';
      ctx.lineWidth = isAtHead ? 1.6 : 1.1;
      ctx.fillRect(-r, -r, r * 2, r * 2);
      ctx.strokeRect(-r, -r, r * 2, r * 2);
      ctx.restore();
    }
  });

  // Línea amarilla de duración
  if (xDur >= -24 && xDur <= w + 24) {
    ctx.strokeStyle = '#facc15';
    ctx.lineWidth = _tlHoverZone === 'duration' ? 2.5 : 2;
    ctx.beginPath();
    ctx.moveTo(xDur, 0);
    ctx.lineTo(xDur, h);
    ctx.stroke();

    const tagText = `${dur.toFixed(1)}s`;
    ctx.font = '700 10px "JetBrains Mono", monospace';
    const tagW = Math.max(36, ctx.measureText(tagText).width + 12);
    const pillX = Math.max(2, Math.min(w - tagW - 2, xDur - tagW * 0.5));
    ctx.fillStyle = _tlHoverZone === 'duration' ? '#fef08a' : '#facc15';
    ctx.beginPath();
    ctx.roundRect(pillX, 2, tagW, 19, 4);
    ctx.fill();
    ctx.fillStyle = '#111215';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(tagText, pillX + tagW * 0.5, 11.5);
  } else if (xDur > w + 24) {
    const cueText = `→ ${dur.toFixed(1)}s`;
    ctx.font = '700 10px "JetBrains Mono", monospace';
    const cueW = Math.max(46, ctx.measureText(cueText).width + 10);
    ctx.fillStyle = 'rgba(250, 204, 21, 0.9)';
    ctx.beginPath();
    ctx.roundRect(w - cueW - 4, 2, cueW, 19, 4);
    ctx.fill();
    ctx.fillStyle = '#111215';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(cueText, w - cueW * 0.5 - 4, 11.5);
  }

  // Línea azul centrada del tiempo actual
  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(centerX, 0);
  ctx.lineTo(centerX, h);
  ctx.stroke();

  ctx.fillStyle = '#3b82f6';
  ctx.beginPath();
  ctx.moveTo(centerX - 6, 0);
  ctx.lineTo(centerX + 6, 0);
  ctx.lineTo(centerX + 6, 7);
  ctx.lineTo(centerX, 13);
  ctx.lineTo(centerX - 6, 7);
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}

// ============================================================
// SINCRONIZACIÓN DE INTERFAZ Y MENÚ HAMBURGUESA
// ============================================================

export function syncAnimationHeader() {
  const ctx = getEffectiveClipContext();
  const clip = ctx.clip;
  const dur = getActiveClipDuration();

  if (dom.animTlClipLabel) {
    if (clip) {
      const displayNode = ctx.filterTarget || ctx.owner;
      const ownerPrefix = displayNode?.name ? `${displayNode.name} · ` : '';
      dom.animTlClipLabel.textContent = `${ownerPrefix}${clip.name || 'Animación'}`;
    } else if (sceneStore.selected) {
      dom.animTlClipLabel.textContent = `${sceneStore.selected.name || 'Objeto'} · Sin clip`;
    } else {
      dom.animTlClipLabel.textContent = 'Sin animación';
    }
  }

  const onKf = isPlayheadOnKeyframe(clip, timeline.currentTime, null);
  if (dom.btnTlKeyframe) {
    dom.btnTlKeyframe.classList.toggle('has-keyframe', onKf);
    dom.btnTlKeyframe.title = onKf
      ? 'Quitar keyframe en el tiempo actual'
      : 'Insertar keyframe (posición, rotación y escala) en el tiempo actual';
  }

  if (dom.btnTlPlay) {
    dom.btnTlPlay.classList.toggle('is-playing', timeline.playing);
    dom.btnTlPlay.setAttribute('aria-pressed', String(timeline.playing));
    dom.btnTlPlay.title = timeline.playing ? 'Pausar animación (Espacio)' : 'Reproducir animación (Espacio)';
    const playIcon = dom.btnTlPlay.querySelector('.icon-play');
    const pauseIcon = dom.btnTlPlay.querySelector('.icon-pause') || dom.btnTlPlay.querySelector('.icon-stop');
    if (playIcon) {
      playIcon.removeAttribute('hidden');
      playIcon.style.display = timeline.playing ? 'none' : 'block';
    }
    if (pauseIcon) {
      pauseIcon.removeAttribute('hidden');
      pauseIcon.style.display = timeline.playing ? 'block' : 'none';
    }
  }

  const activeInterp = getClipInterpolation(clip);
  document.querySelectorAll('#anim-curve-popover [data-anim-interp]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.animInterp === activeInterp);
  });

  if (dom.animSetSpeed) {
    if (document.activeElement !== dom.animSetSpeed) {
      dom.animSetSpeed.value = String(timeline.speed);
    }
    syncRangeVisual(dom.animSetSpeed);
  }
  if (dom.animSetSpeedVal) {
    dom.animSetSpeedVal.textContent = `${timeline.speed.toFixed(2)}×`;
  }
  if (dom.animSetDuration && document.activeElement !== dom.animSetDuration) {
    dom.animSetDuration.value = dur.toFixed(1);
  }
  if (dom.animSetLoop) dom.animSetLoop.value = timeline.loopMode;
  if (dom.animSetAutokey) dom.animSetAutokey.checked = timeline.autoKeyframe;
  if (dom.animSetSnap) dom.animSetSnap.checked = timeline.snap;
}

const PENCIL_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`;
const TRASH_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>`;

function startInlineClipRename(clip, nameSpan) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'object-rename-input';
  input.value = clip.name || 'Animación';
  nameSpan.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const commit = (save) => {
    if (done) return;
    done = true;
    if (save) renameClip(clip, input.value);
    else renderAnimationManagerList();
  };
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  });
  input.addEventListener('blur', () => commit(true));
}

export function renderAnimationManagerList() {
  const listEl = dom.animManagerList;
  if (!listEl) return;
  const selected = sceneStore.selected;

  if (dom.animMgrOwner) {
    dom.animMgrOwner.textContent = selected ? `Objeto: ${selected.name || `#${selected.id}`}` : 'Sin objeto seleccionado';
  }
  if (dom.btnAnimCreate) {
    dom.btnAnimCreate.disabled = !selected && !sceneStore.userObjects.length;
  }

  listEl.innerHTML = '';
  const selectedClips = selected ? getObjectClips(selected) : [];
  const otherClips = getAllSceneClips().filter((c) => !selectedClips.includes(c));

  if (!selectedClips.length && !otherClips.length) {
    const empty = document.createElement('div');
    empty.className = 'helper-text';
    empty.textContent = selected
      ? 'Este objeto aún no tiene animaciones. Pulsa "+ Nueva" o mueve el objeto.'
      : 'Selecciona un objeto y pulsa "+ Nueva" para crear su animación.';
    listEl.appendChild(empty);
    return;
  }

  const appendSection = (title, clips) => {
    if (!clips.length) return;
    const lbl = document.createElement('div');
    lbl.className = 'anim-mgr-section-label';
    lbl.textContent = title;
    listEl.appendChild(lbl);

    for (const clip of clips) {
      const owner = getClipOwner(clip);
      const isActive = timeline.currentClip === clip;
      const item = document.createElement('div');
      item.className = 'anim-mgr-item' + (isActive ? ' is-active' : '');

      const main = document.createElement('div');
      main.className = 'anim-mgr-item-main';
      const nameSpan = document.createElement('span');
      nameSpan.className = 'anim-mgr-item-name';
      nameSpan.textContent = clip.name || 'Animación';

      const kfCount = getClipKeyframeTimes(clip).length;
      const dur = clip.duration > 0 ? clip.duration.toFixed(1) : '3.0';
      const metaSpan = document.createElement('span');
      metaSpan.className = 'anim-mgr-item-meta';
      metaSpan.textContent = `${owner?.name || 'Escena'} · ${dur}s · ${kfCount} kf`;

      main.append(nameSpan, metaSpan);
      main.addEventListener('click', () => {
        if (owner && owner !== sceneStore.selected) {
          timeline.activeClipByObject.set(owner, clip);
        }
        selectClip(clip);
      });

      const actions = document.createElement('div');
      actions.className = 'anim-mgr-item-actions';

      const renBtn = document.createElement('button');
      renBtn.type = 'button';
      renBtn.className = 'outliner-icon-btn';
      renBtn.title = 'Renombrar animación';
      renBtn.innerHTML = PENCIL_SVG;
      renBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        startInlineClipRename(clip, nameSpan);
      });

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'outliner-icon-btn is-danger';
      delBtn.title = 'Borrar animación';
      delBtn.innerHTML = TRASH_SVG;
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteClip(clip);
      });

      actions.append(renBtn, delBtn);
      item.append(main, actions);
      listEl.appendChild(item);
    }
  };

  if (selected && selectedClips.length) {
    appendSection(`Animaciones de ${selected.name || 'selección'}`, selectedClips);
  }
  if (otherClips.length) {
    appendSection(selected ? 'Otras animaciones en escena' : 'Animaciones en escena', otherClips);
  }
}

export function syncAnimationUI() {
  if (sceneStore.selected !== _lastSyncedSelection) {
    _lastSyncedSelection = sceneStore.selected;
    timeline.syncForSelection(sceneStore.selected);
  } else if (viewport.appMode === 'animacion' && sceneStore.selected) {
    const resolved = timeline.resolveClipContext(sceneStore.selected);
    const curOwner = getClipOwner(timeline.currentClip);
    if (resolved.clip && curOwner !== sceneStore.selected && resolved.owner !== curOwner) {
      timeline.currentClip = resolved.clip;
    } else if (!resolved.clip && timeline.currentClip && curOwner !== sceneStore.selected) {
      timeline.currentClip = null;
    }
  }

  if (dom.animTimeline) {
    const isMob90 = isCssLandscape90();
    const { height: vpH } = getLogicalViewportSize();
    const h = isMob90
      ? Math.max(74, Math.min(Math.max(96, vpH - 150), animState.mobileTimelineHeight ?? 90))
      : animState.timelineHeight;
    dom.animTimeline.style.setProperty('--anim-tl-height', `${h}px`);
  }
  syncAnimationHeader();
  renderAnimationManagerList();
  if (viewport.appMode === 'animacion') {
    requestAnimationFrame(drawTimelineCanvas);
  }
}

export function closeKeyframeContextMenu() {
  if (dom.animKfMenu) {
    dom.animKfMenu.hidden = true;
    dom.animKfMenu.innerHTML = '';
  }
}

function openKeyframeContextMenu({ x, y, hit, clip }) {
  const menu = dom.animKfMenu;
  const wrap = dom.animTlTrackWrap;
  if (!menu || !wrap) return;

  menu.innerHTML = '';

  if (hit && clip) {
    const props = hit.filter ? [hit.filter] : null;
    const title = document.createElement('div');
    title.className = 'anim-kf-menu-title';
    title.textContent = `${hit.filter ? hit.label : 'Keyframe'} · ${hit.time.toFixed(2)}s`;
    menu.appendChild(title);

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'anim-kf-menu-btn';
    copyBtn.textContent = 'Copiar keyframe';
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      copyKeyframeFromTimeline(clip, hit.time, props);
      closeKeyframeContextMenu();
    });
    menu.appendChild(copyBtn);

    if (timeline.copiedKeyframe) {
      const pasteBtn = document.createElement('button');
      pasteBtn.type = 'button';
      pasteBtn.className = 'anim-kf-menu-btn';
      pasteBtn.textContent = `Pegar keyframe en ${hit.time.toFixed(2)}s`;
      pasteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        pasteKeyframeAtCurrentTime(null, hit.time);
        closeKeyframeContextMenu();
      });
      menu.appendChild(pasteBtn);
    }

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'anim-kf-menu-btn is-danger';
    delBtn.textContent = 'Eliminar keyframe';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeKeyframeAt(clip, hit.time, { properties: props });
      setStatus(`Keyframe eliminado en ${hit.time.toFixed(2)}s.`);
      closeKeyframeContextMenu();
    });
    menu.appendChild(delBtn);
  } else {
    if (!timeline.copiedKeyframe) {
      closeKeyframeContextMenu();
      setStatus('No hay ningún keyframe copiado para pegar. Mantén presionado un keyframe para copiarlo.', true);
      return;
    }
    const targetT = snapTimelineTime(timeline.currentTime);
    const title = document.createElement('div');
    title.className = 'anim-kf-menu-title';
    title.textContent = `Línea azul · ${targetT.toFixed(2)}s`;
    menu.appendChild(title);

    const pasteBtn = document.createElement('button');
    pasteBtn.type = 'button';
    pasteBtn.className = 'anim-kf-menu-btn';
    pasteBtn.textContent = `Pegar keyframe en ${targetT.toFixed(2)}s`;
    pasteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      pasteKeyframeAtCurrentTime(null, targetT);
      closeKeyframeContextMenu();
    });
    menu.appendChild(pasteBtn);
  }

  menu.hidden = false;
  const menuW = menu.offsetWidth || 176;
  const menuH = menu.offsetHeight || 72;
  const maxLeft = Math.max(6, wrap.clientWidth - menuW - 6);
  const left = Math.max(6, Math.min(maxLeft, x - menuW * 0.5));
  const rawTop = y - menuH - 8;
  const minTop = -(wrap.offsetTop + 140);
  const maxTop = Math.max(minTop, wrap.clientHeight - menuH - 4);
  menu.style.left = `${left}px`;
  menu.style.top = `${Math.max(minTop, Math.min(maxTop, rawTop))}px`;
}

export function closeTimelineSubpopovers(exceptId = null) {
  closeKeyframeContextMenu();
  if (dom.animCurvePopover && exceptId !== 'anim-curve-popover') dom.animCurvePopover.hidden = true;
  if (dom.animSettingsPopover && exceptId !== 'anim-settings-popover') dom.animSettingsPopover.hidden = true;
  if (dom.animManagerPopover && exceptId !== 'anim-manager-popover') {
    dom.animManagerPopover.hidden = true;
    dom.btnAnimMenu?.classList.remove('is-active');
    dom.btnAnimMenu?.setAttribute('aria-expanded', 'false');
  }
  dom.btnTlCurve?.classList.toggle('is-active', Boolean(dom.animCurvePopover && !dom.animCurvePopover.hidden));
  dom.btnTlMore?.classList.toggle('is-active', Boolean(dom.animSettingsPopover && !dom.animSettingsPopover.hidden));
}

// ============================================================
// ENLACE DE EVENTOS DE LÍNEA DE TIEMPO Y MENÚ ANIMACIÓN
// ============================================================

export function bindAnimationUI() {
  if (_bound) return;
  _bound = true;

  dom.btnAnimMenu?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!dom.animManagerPopover) return;
    const willOpen = dom.animManagerPopover.hidden;
    closeTimelineSubpopovers(willOpen ? 'anim-manager-popover' : null);
    dom.animManagerPopover.hidden = !willOpen;
    dom.btnAnimMenu.classList.toggle('is-active', willOpen);
    dom.btnAnimMenu.setAttribute('aria-expanded', String(willOpen));
    if (willOpen) renderAnimationManagerList();
  });

  dom.btnAnimMgrClose?.addEventListener('click', () => closeTimelineSubpopovers());

  dom.btnAnimCreate?.addEventListener('click', () => {
    const owner = sceneStore.selected || sceneStore.userObjects[0];
    if (!owner) {
      setStatus('Agrega o selecciona un objeto primero.', true);
      return;
    }
    const clip = createClipForObject(owner, '', { duration: 3.0, select: true });
    setStatus(`Animación "${clip.name}" creada para ${owner.name || 'objeto'}.`);
  });

  dom.btnTlKeyframe?.addEventListener('click', toggleKeyframeAtCurrentTime);
  dom.btnTlZoomIn?.addEventListener('click', () => {
    animState.pxPerSec = Math.min(MAX_PX_PER_SEC, Math.round(animState.pxPerSec * 1.35));
    drawTimelineCanvas();
  });
  dom.btnTlZoomOut?.addEventListener('click', () => {
    animState.pxPerSec = Math.max(MIN_PX_PER_SEC, Math.round(animState.pxPerSec / 1.35));
    drawTimelineCanvas();
  });
  dom.btnTlZero?.addEventListener('click', jumpToZeroTime);
  dom.btnTlPrevKf?.addEventListener('click', jumpPrevKeyframe);
  dom.btnTlPlay?.addEventListener('click', toggleTimelinePlayback);
  dom.btnTlNextKf?.addEventListener('click', jumpNextKeyframe);

  dom.btnTlCurve?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!dom.animCurvePopover) return;
    const willOpen = dom.animCurvePopover.hidden;
    closeTimelineSubpopovers(willOpen ? 'anim-curve-popover' : null);
    dom.animCurvePopover.hidden = !willOpen;
    dom.btnTlCurve.classList.toggle('is-active', willOpen);
  });

  document.querySelectorAll('#anim-curve-popover [data-anim-interp]').forEach((btn) => {
    btn.addEventListener('click', () => {
      applyInterpolation(btn.dataset.animInterp);
      closeTimelineSubpopovers();
    });
  });

  dom.btnTlMore?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!dom.animSettingsPopover) return;
    const willOpen = dom.animSettingsPopover.hidden;
    closeTimelineSubpopovers(willOpen ? 'anim-settings-popover' : null);
    dom.animSettingsPopover.hidden = !willOpen;
    dom.btnTlMore.classList.toggle('is-active', willOpen);
  });

  dom.animSetSpeed?.addEventListener('input', (e) => {
    timeline.speed = Math.max(0.1, Math.min(3, Number(e.target.value) || 1));
    if (dom.animSetSpeedVal) dom.animSetSpeedVal.textContent = `${timeline.speed.toFixed(2)}×`;
  });

  dom.animSetDuration?.addEventListener('change', (e) => {
    const nextDur = Math.max(0.2, Number(e.target.value) || 3);
    const clip = timeline.currentClip;
    if (!clip) {
      timeline.defaultDuration = nextDur;
      if (timeline.currentTime > nextDur) timeline.currentTime = nextDur;
      syncAnimationHeader();
      drawTimelineCanvas();
      return;
    }
    const before = clip.captureSnapshot();
    clip.duration = nextDur;
    if (timeline.currentTime > nextDur) timeline.currentTime = nextDur;
    const after = clip.captureSnapshot();
    history.push({ type: 'animClip', clip, owner: getClipOwner(clip), before, after, label: 'Duración' });
    syncAnimationHeader();
    drawTimelineCanvas();
  });

  dom.animSetLoop?.addEventListener('change', (e) => {
    timeline.loopMode = e.target.value || 'repeat';
  });
  dom.animSetAutokey?.addEventListener('change', (e) => {
    timeline.autoKeyframe = e.target.checked;
  });
  dom.animSetSnap?.addEventListener('change', (e) => {
    timeline.snap = e.target.checked;
  });

  document.addEventListener('pointerdown', (e) => {
    if (viewport.appMode !== 'animacion') return;
    if (!e.target.closest('#anim-kf-menu')) {
      closeKeyframeContextMenu();
    }
    const inside =
      e.target.closest('#anim-kf-menu') ||
      e.target.closest('#anim-manager-popover') ||
      e.target.closest('#btn-anim-menu') ||
      e.target.closest('#anim-curve-popover') ||
      e.target.closest('#btn-tl-curve') ||
      e.target.closest('#anim-settings-popover') ||
      e.target.closest('#btn-tl-more');
    if (!inside) closeTimelineSubpopovers();
  });

  dom.animKfMenu?.addEventListener('contextmenu', (e) => e.preventDefault());

  if (dom.animTlResize && dom.animTimeline) {
    let resizeDrag = null;
    dom.animTlResize.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      dom.animTlResize.setPointerCapture(e.pointerId);
      const pt = clientToViewportPoint(e);
      const isMob90 = isCssLandscape90();
      const startH = isMob90 ? (animState.mobileTimelineHeight ?? 90) : animState.timelineHeight;
      resizeDrag = { pointerId: e.pointerId, startY: pt.y, startH, isMob90 };
    });
    dom.animTlResize.addEventListener('pointermove', (e) => {
      if (!resizeDrag || e.pointerId !== resizeDrag.pointerId) return;
      const pt = clientToViewportPoint(e);
      const dy = resizeDrag.startY - pt.y;
      const { height: vpH } = getLogicalViewportSize();
      const minH = resizeDrag.isMob90 ? 74 : 110;
      const maxH = resizeDrag.isMob90
        ? Math.max(96, Math.min(220, vpH - 140))
        : Math.max(160, Math.min(420, vpH - 190));
      const nextH = Math.round(Math.max(minH, Math.min(maxH, resizeDrag.startH + dy)));
      if (resizeDrag.isMob90) animState.mobileTimelineHeight = nextH;
      else animState.timelineHeight = nextH;
      dom.animTimeline.style.setProperty('--anim-tl-height', `${nextH}px`);
      drawTimelineCanvas();
    });
    const endResize = (e) => {
      if (resizeDrag && e.pointerId === resizeDrag.pointerId) {
        resizeDrag = null;
      }
    };
    dom.animTlResize.addEventListener('pointerup', endResize);
    dom.animTlResize.addEventListener('pointercancel', endResize);
  }

  if (dom.animTlCanvas) {
    let tlDrag = null;
    let holdTimer = 0;
    let lastHoldOpenedAt = 0;
    const activePointers = new Map();
    let pinchState = null;

    const clearHoldTimer = () => {
      if (holdTimer) {
        clearTimeout(holdTimer);
        holdTimer = 0;
      }
    };

    dom.animTlCanvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      clearHoldTimer();
      if (tlDrag?.holdTriggered || performance.now() - lastHoldOpenedAt < 650) {
        return;
      }
      const [x, y] = clientToLocalPoint(dom.animTlCanvas, e);
      const isTouchCtx = Boolean(e.pointerType && e.pointerType !== 'mouse') || Boolean(e.sourceCapabilities?.firesTouchEvents);
      const clip = getEffectiveClipContext().clip;
      const hit = hitTestTimelineKeyframe(clip, x, y, isTouchCtx ? 22 : 16);
      openKeyframeContextMenu({ x, y, hit, clip });
    });

    dom.animTlCanvas.addEventListener('pointerdown', (e) => {
      if (e.button === 2) return;
      e.preventDefault();
      closeTimelineSubpopovers();
      clearHoldTimer();

      const [x, y] = clientToLocalPoint(dom.animTlCanvas, e);
      activePointers.set(e.pointerId, { x, y });

      try {
        dom.animTlCanvas.setPointerCapture(e.pointerId);
      } catch {}

      if (activePointers.size >= 2) {
        const pts = Array.from(activePointers.values());
        const dist = Math.max(12, Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y));
        pinchState = { startDist: dist, startPxPerSec: animState.pxPerSec };
        tlDrag = null;
        return;
      }

      const isTouch = e.pointerType && e.pointerType !== 'mouse';
      const durHitTol = isTouch ? 24 : 14;
      const kfHitTol = isTouch ? 22 : 13;
      const dur = getActiveClipDuration();
      const xDur = timeToX(dur);
      const clipCtx = getEffectiveClipContext();
      const clip = clipCtx.clip;

      if (timeline.playing) setTimelinePlaying(false);

      if (xDur > _tlWidth + 24 && x >= _tlWidth - 62 && y <= RULER_H + 6) {
        setTimelineTime(dur);
        return;
      }

      const inDurBadge = y <= RULER_H + 4 && Math.abs(x - xDur) <= Math.max(durHitTol, 28);
      if (Math.abs(x - xDur) <= durHitTol || inDurBadge) {
        tlDrag = {
          mode: 'duration',
          pointerId: e.pointerId,
          startX: x,
          startY: y,
          startDur: dur,
          before: clip ? clip.captureSnapshot() : null,
          holdTriggered: false,
        };
        return;
      }

      const hit = hitTestTimelineKeyframe(clip, x, y, kfHitTol);
      if (hit && clip) {
        tlDrag = {
          mode: 'keyframe',
          pointerId: e.pointerId,
          pointerType: e.pointerType,
          startX: x,
          startY: y,
          origTime: hit.time,
          curTime: hit.time,
          properties: hit.filter ? [hit.filter] : null,
          target: clipCtx.filterTarget,
          owner: clipCtx.owner,
          clip,
          hit,
          moved: false,
          holdTriggered: false,
          before: clip.captureSnapshot(),
        };
        holdTimer = setTimeout(() => {
          if (!tlDrag || tlDrag.pointerId !== e.pointerId || tlDrag.moved) return;
          tlDrag.holdTriggered = true;
          lastHoldOpenedAt = performance.now();
          openKeyframeContextMenu({ x, y, hit: tlDrag.hit, clip: tlDrag.clip });
        }, LONG_PRESS_MS);
        return;
      }

      tlDrag = {
        mode: 'scrub',
        pointerId: e.pointerId,
        pointerType: e.pointerType,
        startX: x,
        startY: y,
        startTime: timeline.currentTime,
        moved: false,
        holdTriggered: false,
      };
      holdTimer = setTimeout(() => {
        if (!tlDrag || tlDrag.pointerId !== e.pointerId || tlDrag.moved) return;
        tlDrag.holdTriggered = true;
        lastHoldOpenedAt = performance.now();
        openKeyframeContextMenu({ x, y, hit: null, clip });
      }, LONG_PRESS_MS);
    });

    dom.animTlCanvas.addEventListener('pointermove', (e) => {
      const [x, y] = clientToLocalPoint(dom.animTlCanvas, e);

      if (activePointers.has(e.pointerId)) {
        activePointers.set(e.pointerId, { x, y });
      }
      if (pinchState && activePointers.size >= 2) {
        const pts = Array.from(activePointers.values());
        const dist = Math.max(12, Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y));
        const nextPx = pinchState.startPxPerSec * (dist / pinchState.startDist);
        animState.pxPerSec = Math.max(MIN_PX_PER_SEC, Math.min(MAX_PX_PER_SEC, nextPx));
        drawTimelineCanvas();
        return;
      }

      if (!tlDrag) {
        const dur = getActiveClipDuration();
        const xDur = timeToX(dur);
        const overDurBadge = y <= RULER_H + 4 && Math.abs(x - xDur) <= 24;
        const overDur = Math.abs(x - xDur) <= 14 || overDurBadge;
        const clip = getEffectiveClipContext().clip;
        const overKf = !overDur && Boolean(hitTestTimelineKeyframe(clip, x, y, 14));
        const nextZone = overDur ? 'duration' : overKf ? 'keyframe' : null;
        if (nextZone !== _tlHoverZone) {
          _tlHoverZone = nextZone;
          dom.animTlCanvas.style.cursor = overDur ? 'ew-resize' : overKf ? 'pointer' : 'grab';
          drawTimelineCanvas();
        }
        return;
      }

      if (e.pointerId !== tlDrag.pointerId || tlDrag.holdTriggered) return;
      const dx = x - tlDrag.startX;
      const dy = y - tlDrag.startY;
      const moveTol = (tlDrag.pointerType || e.pointerType) === 'mouse' ? LONG_PRESS_MOVE_PX : 14;
      if (Math.hypot(dx, dy) > moveTol) {
        tlDrag.moved = true;
        clearHoldTimer();
      }

      if (tlDrag.mode === 'duration') {
        const rawDur = tlDrag.startDur + dx / animState.pxPerSec;
        const snapped = Math.max(0.2, Math.round(rawDur * 20) / 20);
        if (timeline.currentClip) {
          timeline.currentClip.duration = snapped;
        } else {
          timeline.defaultDuration = snapped;
        }
        syncAnimationHeader();
        drawTimelineCanvas();
      } else if (tlDrag.mode === 'keyframe' && tlDrag.clip) {
        if (!tlDrag.moved) return;
        const rawT = tlDrag.origTime + dx / animState.pxPerSec;
        const nextT = Math.min(Math.max(0, getActiveClipDuration()), snapTimelineTime(rawT));
        if (Math.abs(nextT - tlDrag.curTime) > 1e-4) {
          tlDrag.clip.previewMoveKeyframe(tlDrag.before, tlDrag.origTime, nextT, {
            properties: tlDrag.properties,
            target: tlDrag.target,
            owner: tlDrag.owner,
            eps: timeline.keyframeHitEps,
          });
          tlDrag.curTime = nextT;
          evaluateActiveAnimationsAt(timeline.currentTime);
          syncAnimationHeader();
          drawTimelineCanvas();
        }
      } else if (tlDrag.mode === 'scrub') {
        if (!tlDrag.moved) return;
        const rawT = tlDrag.startTime - dx / animState.pxPerSec;
        setTimelineTime(Math.max(0, rawT));
      }
    });

    const endTlDrag = (e) => {
      activePointers.delete(e.pointerId);
      if (activePointers.size < 2) pinchState = null;

      if (!tlDrag || e.pointerId !== tlDrag.pointerId) return;
      clearHoldTimer();
      const finished = tlDrag;
      tlDrag = null;

      if (finished.holdTriggered) return;

      if (finished.mode === 'duration') {
        const finalDur = getActiveClipDuration();
        if (timeline.currentTime > finalDur) {
          timeline.currentTime = finalDur;
          evaluateActiveAnimationsAt(timeline.currentTime);
        }
        if (timeline.currentClip && finished.before && Math.abs(finalDur - finished.startDur) > 1e-3) {
          history.push({
            type: 'animClip',
            clip: timeline.currentClip,
            owner: getClipOwner(timeline.currentClip),
            before: finished.before,
            after: timeline.currentClip.captureSnapshot(),
            label: 'Duración animación',
          });
        }
        syncAnimationHeader();
        drawTimelineCanvas();
      } else if (finished.mode === 'keyframe' && finished.clip && finished.before) {
        if (!finished.moved) {
          setTimelineTime(finished.origTime);
        } else if (Math.abs(finished.curTime - finished.origTime) > 1e-3) {
          finished.clip.commitMoveKeyframe(
            finished.before,
            finished.origTime,
            finished.curTime,
            {
              properties: finished.properties,
              target: finished.target,
              owner: finished.owner,
              eps: timeline.keyframeHitEps,
              mergeEps: 0.025,
            }
          );
          evaluateActiveAnimationsAt(timeline.currentTime);
          syncAnimationHeader();
          drawTimelineCanvas();
          history.push({
            type: 'animClip',
            clip: finished.clip,
            owner: getClipOwner(finished.clip),
            before: finished.before,
            after: finished.clip.captureSnapshot(),
            label: 'Mover keyframe',
          });
        } else {
          finished.clip.restoreSnapshot(finished.before);
          evaluateActiveAnimationsAt(timeline.currentTime);
          drawTimelineCanvas();
        }
      }
      renderAnimationManagerList();
    };

    dom.animTlCanvas.addEventListener('pointerup', endTlDrag);
    dom.animTlCanvas.addEventListener('pointercancel', endTlDrag);

    dom.animTlCanvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        closeKeyframeContextMenu();
        if (e.ctrlKey || e.metaKey) {
          const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
          animState.pxPerSec = Math.max(MIN_PX_PER_SEC, Math.min(MAX_PX_PER_SEC, animState.pxPerSec * factor));
          drawTimelineCanvas();
        } else {
          const deltaSec = (e.deltaX || e.deltaY) / animState.pxPerSec;
          setTimelineTime(timeline.currentTime + deltaSec);
        }
      },
      { passive: false }
    );
  }

  if (dom.animTlTrackWrap && typeof ResizeObserver !== 'undefined') {
    _ro = new ResizeObserver(() => {
      if (viewport.appMode === 'animacion') drawTimelineCanvas();
    });
    _ro.observe(dom.animTlTrackWrap);
  }

  if (viewport.scene && !sceneStore.mixer) {
    sceneStore.mixer = new AnimationMixer(viewport.scene);
  }
}
