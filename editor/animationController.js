import { AnimationClip, AnimationMixer } from '../src/modules/animation.js';
import { dom, setStatus } from './dom.js';
import { viewport, sceneStore, cameraView, animState, edit } from './store.js';
import { history } from './history.js';

const KEYFRAME_HIT_EPS = 0.035;
const MIN_PX_PER_SEC = 28;
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
let _pingPongDir = 1;
let _bound = false;
let _ro = null;

export function setAnimationHooks(hooks = {}) {
  Object.assign(_animHooks, hooks);
}

// ============================================================
// UTILIDADES DE CLIP Y PROPIEDADES POR HERRAMIENTA
// ============================================================

export function snapTimelineTime(t) {
  const clamped = Math.max(0, t);
  if (!animState.snap) return Math.round(clamped * 1000) / 1000;
  const step = animState.snapStep || 0.05;
  return Math.round(Math.round(clamped / step) * step * 1000) / 1000;
}

export function getActiveToolKeyframeProperties() {
  if (edit.active) return null;
  const mode = viewport.gizmo?.mode || 'select';
  if (mode === 'translate') return ['position'];
  if (mode === 'rotate') return ['quaternion'];
  if (mode === 'scale') return ['scale'];
  return null;
}

function getClipListForObject(obj) {
  if (!obj) return [];
  let list = animState.objectClips.get(obj);
  if (!list) {
    list = [];
    animState.objectClips.set(obj, list);
  }
  return list;
}

export function getObjectClips(obj) {
  return obj ? getClipListForObject(obj).slice() : [];
}

export function getActiveClipForObject(obj) {
  if (!obj) return null;
  const active = animState.activeClipByObject.get(obj);
  if (active && animState.allClips.includes(active)) return active;
  const list = getClipListForObject(obj);
  return list[0] || null;
}

export function getClipOwner(clip) {
  return clip ? animState.clipOwners.get(clip) || null : null;
}

export function getAllSceneClips() {
  const out = [];
  const seen = new Set();
  for (const clip of animState.allClips) {
    if (clip && !seen.has(clip)) {
      seen.add(clip);
      out.push(clip);
    }
  }
  if (Array.isArray(sceneStore.animations)) {
    for (const clip of sceneStore.animations) {
      if (clip && !seen.has(clip)) {
        seen.add(clip);
        out.push(clip);
      }
    }
  }
  return out;
}

export function syncSceneClipListToStore() {
  sceneStore.animations = getAllSceneClips();
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
}

export function createClipForObject(obj, name = '', { duration = 3.0, select = true } = {}) {
  const owner = obj || sceneStore.selected || null;
  const list = owner ? getClipListForObject(owner) : [];
  const nextIndex = (owner ? list.length : animState.allClips.length) + 1;
  const clipName = String(name || '').trim() || `Animación ${nextIndex}`;
  const clip = new AnimationClip(clipName, Math.max(0.2, Number(duration) || 3.0));

  if (owner) {
    list.push(clip);
    animState.activeClipByObject.set(owner, clip);
    animState.clipOwners.set(clip, owner);
  }
  animState.allClips.push(clip);
  syncSceneClipListToStore();
  if (select) {
    animState.currentClip = clip;
    animState.currentTime = Math.min(animState.currentTime, clip.duration);
  }
  syncAnimationUI();
  return clip;
}

export function selectClip(clip) {
  if (!clip) {
    animState.currentClip = null;
    syncAnimationUI();
    return;
  }
  animState.currentClip = clip;
  const owner = animState.clipOwners.get(clip);
  if (owner) {
    animState.activeClipByObject.set(owner, clip);
  }
  const dur = Math.max(0.2, clip.duration > 0 ? clip.duration : 3.0);
  if (animState.currentTime > dur) animState.currentTime = dur;
  evaluateActiveAnimationsAt(animState.currentTime);
  syncAnimationUI();
}

export function renameClip(clip, newName) {
  if (!clip) return;
  const trimmed = String(newName || '').trim();
  if (!trimmed) return;
  clip.name = trimmed;
  syncSceneClipListToStore();
  syncAnimationUI();
}

export function deleteClip(clip) {
  if (!clip) return;
  const owner = animState.clipOwners.get(clip);
  if (owner) {
    const list = getClipListForObject(owner).filter((c) => c !== clip);
    animState.objectClips.set(owner, list);
    if (animState.activeClipByObject.get(owner) === clip) {
      if (list.length) animState.activeClipByObject.set(owner, list[0]);
      else animState.activeClipByObject.delete(owner);
    }
  }
  animState.allClips = animState.allClips.filter((c) => c !== clip);
  animState.clipOwners.delete(clip);

  if (Array.isArray(sceneStore.animations)) {
    sceneStore.animations = sceneStore.animations.filter((c) => c !== clip);
  }
  if (animState.currentClip === clip) {
    animState.currentClip =
      (sceneStore.selected && getActiveClipForObject(sceneStore.selected)) ||
      animState.allClips[0] ||
      sceneStore.animations[0] ||
      null;
  }
  syncSceneClipListToStore();
  syncAnimationUI();
}

export function cleanupClipsForObject(obj) {
  if (!obj) return;
  const toDelete = [];
  for (const clip of animState.allClips) {
    const owner = animState.clipOwners.get(clip);
    if (owner && (owner === obj || _isDescendant(owner, obj))) {
      toDelete.push(clip);
    }
  }
  for (const clip of toDelete) {
    deleteClip(clip);
  }
}

export function clearAllCustomClips() {
  animState.objectClips = new WeakMap();
  animState.activeClipByObject = new WeakMap();
  animState.clipOwners = new WeakMap();
  animState.allClips = [];
  animState.currentClip = null;
  animState.currentTime = 0;
  animState.playing = false;
  syncAnimationUI();
}

export function captureAnimStateSnapshot() {
  return {
    allClips: animState.allClips.slice(),
    owners: animState.allClips.map((c) => [c, animState.clipOwners.get(c) || null]),
    currentClip: animState.currentClip,
  };
}

export function restoreAnimStateSnapshot(snap) {
  if (!snap) return;
  animState.objectClips = new WeakMap();
  animState.activeClipByObject = new WeakMap();
  animState.clipOwners = new WeakMap();
  animState.allClips = (snap.allClips || []).slice();
  for (const [clip, owner] of snap.owners || []) {
    if (!clip) continue;
    if (owner) {
      animState.clipOwners.set(clip, owner);
      const list = getClipListForObject(owner);
      if (!list.includes(clip)) list.push(clip);
      if (!animState.activeClipByObject.get(owner)) {
        animState.activeClipByObject.set(owner, clip);
      }
    }
  }
  animState.currentClip = snap.currentClip || animState.allClips[0] || null;
  syncSceneClipListToStore();
  syncAnimationUI();
}

export function registerImportedClips(root, clips = []) {
  if (!root || !Array.isArray(clips) || !clips.length) return;
  const list = getClipListForObject(root);
  for (const clip of clips) {
    if (!clip) continue;
    if (!(clip.duration > 0)) clip.duration = 3.0;
    if (!list.includes(clip)) list.push(clip);
    if (!animState.allClips.includes(clip)) animState.allClips.push(clip);
    animState.clipOwners.set(clip, root);
  }
  if (!animState.activeClipByObject.get(root) && list[0]) {
    animState.activeClipByObject.set(root, list[0]);
  }
  if (!animState.currentClip && list[0]) {
    animState.currentClip = list[0];
  }
  syncAnimationUI();
}

function _isDescendant(node, ancestor) {
  let cur = node;
  while (cur) {
    if (cur === ancestor) return true;
    cur = cur.parent;
  }
  return false;
}

// ============================================================
// EVALUACIÓN DE CLIPS CONSUMIENDO LA LIBRERÍA
// ============================================================

function collectEvaluableClips() {
  const activeClips = [];
  const seen = new Set();

  for (const root of sceneStore.userObjects) {
    const clip = getActiveClipForObject(root);
    if (clip && !seen.has(clip)) {
      seen.add(clip);
      activeClips.push(clip);
    }
    if (typeof root.traverse === 'function') {
      root.traverse((child) => {
        if (child === root) return;
        const c = getActiveClipForObject(child);
        if (c && !seen.has(c)) {
          seen.add(c);
          activeClips.push(c);
        }
      });
    }
  }

  if (animState.currentClip && !seen.has(animState.currentClip)) {
    seen.add(animState.currentClip);
    activeClips.push(animState.currentClip);
  }

  return activeClips;
}

export function evaluateClipAt(clip, time) {
  if (!clip || !clip.tracks.length) return;
  const owner = animState.clipOwners.get(clip) || viewport.scene;
  const updatedObjects = clip.evaluateAt(time, owner);
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
  const clips = collectEvaluableClips();
  for (const clip of clips) {
    evaluateClipAt(clip, time);
  }
  _animHooks.syncTransformInputs?.();
  _animHooks.syncCameraHelperSelection?.();
}

// ============================================================
// KEYFRAMES (CONSUMO DE API DE AnimationClip)
// ============================================================

export function getClipKeyframeTimes(clip, property = null) {
  return clip ? clip.getKeyframeTimes(property) : [];
}

export function isPlayheadOnKeyframe(
  clip = animState.currentClip,
  time = animState.currentTime,
  properties = null
) {
  if (!clip) return false;
  return clip.hasKeyframeAt(time, { properties, eps: KEYFRAME_HIT_EPS });
}

export function getClipInterpolation(clip = animState.currentClip) {
  return clip ? clip.getInterpolation() : 'linear';
}

export function applyInterpolation(interp) {
  const clip = animState.currentClip;
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
  evaluateActiveAnimationsAt(animState.currentTime);
  syncAnimationUI();
}

export function insertKeyframeAt(
  obj,
  time = animState.currentTime,
  { properties = null, recordHistory = true } = {}
) {
  if (!obj) {
    setStatus('Selecciona un objeto para agregar un keyframe.', true);
    return false;
  }
  let clip =
    animState.currentClip && getClipOwner(animState.currentClip) === obj
      ? animState.currentClip
      : getActiveClipForObject(obj);
  if (!clip) {
    clip = createClipForObject(obj, '', { duration: Math.max(3.0, Math.ceil(time + 0.5)), select: true });
  }
  animState.currentClip = clip;

  const props =
    Array.isArray(properties) && properties.length
      ? properties
      : getActiveToolKeyframeProperties() || ['position', 'quaternion', 'scale'];

  const t = snapTimelineTime(time);
  const before = clip.captureSnapshot();
  const updated = clip.setObjectKeyframe(obj, t, props, { mergeEps: KEYFRAME_HIT_EPS, autoExpand: true });
  if (!updated) return false;

  const after = clip.captureSnapshot();
  if (recordHistory) {
    const propLabel = props.length === 1 ? (PROP_LABELS[props[0]] || props[0]) : 'Transformación';
    history.push({
      type: 'animClip',
      clip,
      owner: obj,
      before,
      after,
      label: `Keyframe ${propLabel} en ${t.toFixed(2)}s`,
    });
  }
  syncSceneClipListToStore();
  syncAnimationUI();
  return true;
}

export function removeKeyframeAt(
  clip = animState.currentClip,
  time = animState.currentTime,
  { properties = null } = {}
) {
  if (!clip) return false;
  const before = clip.captureSnapshot();
  const anyRemoved = clip.removeKeyframeAt(time, { properties, eps: KEYFRAME_HIT_EPS });
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
  evaluateActiveAnimationsAt(animState.currentTime);
  syncAnimationUI();
  return true;
}

export function toggleKeyframeAtCurrentTime() {
  const clip = animState.currentClip;
  const activeProps = getActiveToolKeyframeProperties();
  if (clip && isPlayheadOnKeyframe(clip, animState.currentTime, activeProps)) {
    removeKeyframeAt(clip, animState.currentTime, { properties: activeProps });
    const tag = activeProps?.length === 1 ? ` (${PROP_LABELS[activeProps[0]] || activeProps[0]})` : '';
    setStatus(`Keyframe${tag} eliminado en ${animState.currentTime.toFixed(2)}s`);
    return;
  }
  const target = sceneStore.selected || getClipOwner(clip);
  if (!target) {
    setStatus('Selecciona un objeto para insertar un keyframe.', true);
    return;
  }
  const insertProps = activeProps || ['position', 'quaternion', 'scale'];
  if (insertKeyframeAt(target, animState.currentTime, { properties: insertProps, recordHistory: true })) {
    const tag = insertProps.length === 1 ? ` (${PROP_LABELS[insertProps[0]] || insertProps[0]})` : '';
    setStatus(`Keyframe${tag} guardado en ${animState.currentTime.toFixed(2)}s`);
  }
}

export function recordAutoKeyframeIfNeeded(targets = [], opts = {}) {
  if (viewport.appMode !== 'animacion' || !animState.autoKeyframe || animState.playing) return;
  const list = Array.isArray(targets) && targets.length ? targets : sceneStore.selected ? [sceneStore.selected] : [];
  const { beforeList = null, afterList = null, properties = null } = opts;

  list.forEach((obj, idx) => {
    if (!obj) return;
    let props = properties;
    if (!props && Array.isArray(beforeList) && Array.isArray(afterList) && beforeList[idx] && afterList[idx]) {
      const changed = AnimationClip.detectChangedProperties(beforeList[idx], afterList[idx]);
      const toolProps = getActiveToolKeyframeProperties();
      if (toolProps && toolProps.length === 1 && !viewport.gizmo?.editPivot) {
        props = changed.includes(toolProps[0]) ? toolProps : changed;
      } else {
        props = changed;
      }
    } else if (!props) {
      props = getActiveToolKeyframeProperties() || ['position', 'quaternion', 'scale'];
    }
    if (!props || !props.length) return;
    insertKeyframeAt(obj, animState.currentTime, { properties: props, recordHistory: true });
  });
}

// ============================================================
// COPIAR Y PEGAR KEYFRAMES (MANTENER PRESIONADO)
// ============================================================

export function copyKeyframeFromTimeline(clip, time, properties = null) {
  if (!clip) return false;
  const data = clip.extractKeyframeData(time, { properties, eps: KEYFRAME_HIT_EPS });
  if (!data) {
    setStatus('No hay keyframe en ese punto para copiar.', true);
    return false;
  }
  animState.copiedKeyframe = data;
  const names = Object.keys(data.properties).map((p) => PROP_LABELS[p] || p).join(', ');
  setStatus(`Keyframe copiado (${names}) de ${data.sourceTime.toFixed(2)}s.`);
  return true;
}

export function pasteKeyframeAtCurrentTime(targetObj = null, time = animState.currentTime) {
  const data = animState.copiedKeyframe;
  if (!data) {
    setStatus('No has copiado ningún keyframe todavía. Mantén presionado un keyframe para copiarlo.', true);
    return false;
  }
  const obj = targetObj || sceneStore.selected || getClipOwner(animState.currentClip);
  if (!obj) {
    setStatus('Selecciona un objeto para pegar el keyframe.', true);
    return false;
  }
  let clip =
    animState.currentClip && getClipOwner(animState.currentClip) === obj
      ? animState.currentClip
      : getActiveClipForObject(obj);
  if (!clip) {
    clip = createClipForObject(obj, '', { duration: Math.max(3.0, Math.ceil(time + 0.5)), select: true });
  }
  animState.currentClip = clip;

  const t = snapTimelineTime(time);
  const before = clip.captureSnapshot();
  const pasted = clip.applyKeyframeData(obj, data, t, { mergeEps: KEYFRAME_HIT_EPS, autoExpand: true });
  if (!pasted.length) return false;

  const after = clip.captureSnapshot();
  history.push({
    type: 'animClip',
    clip,
    owner: obj,
    before,
    after,
    label: `Pegar keyframe en ${t.toFixed(2)}s`,
  });

  evaluateActiveAnimationsAt(animState.currentTime);
  syncSceneClipListToStore();
  syncAnimationUI();
  const names = pasted.map((p) => PROP_LABELS[p] || p).join(', ');
  setStatus(`Keyframe pegado (${names}) en ${t.toFixed(2)}s.`);
  return true;
}

// ============================================================
// NAVEGACIÓN, REPRODUCCIÓN Y LÍNEA DE TIEMPO
// ============================================================

export function setTimelineTime(t) {
  const dur = getActiveClipDuration();
  animState.currentTime = Math.max(0, Math.min(Math.max(dur, 120), t));
  evaluateActiveAnimationsAt(animState.currentTime);
  syncAnimationHeader();
  drawTimelineCanvas();
}

export function getActiveClipDuration() {
  if (animState.currentClip && animState.currentClip.duration > 0) {
    return animState.currentClip.duration;
  }
  return 3.0;
}

export function jumpToZeroTime() {
  if (animState.playing) setTimelinePlaying(false);
  setTimelineTime(0);
}

export function jumpPrevKeyframe() {
  const kfs = getClipKeyframeTimes(animState.currentClip);
  if (!kfs.length) return;
  const cur = animState.currentTime;
  for (let i = kfs.length - 1; i >= 0; i--) {
    if (kfs[i] < cur - 0.015) {
      setTimelineTime(kfs[i]);
      return;
    }
  }
  setTimelineTime(kfs[0]);
}

export function jumpNextKeyframe() {
  const kfs = getClipKeyframeTimes(animState.currentClip);
  if (!kfs.length) return;
  const cur = animState.currentTime;
  for (let i = 0; i < kfs.length; i++) {
    if (kfs[i] > cur + 0.015) {
      setTimelineTime(kfs[i]);
      return;
    }
  }
  setTimelineTime(kfs[kfs.length - 1]);
}

export function setTimelinePlaying(play) {
  const next = Boolean(play);
  if (next) {
    const clips = collectEvaluableClips();
    const hasAnyKey = clips.some((c) => c.tracks.some((tr) => tr.times.length > 0));
    if (!hasAnyKey) {
      setStatus('Agrega al menos 2 keyframes para reproducir la animación.');
      animState.playing = false;
      syncAnimationHeader();
      return;
    }
    const dur = Math.max(0.2, getTimelinePlaybackDuration());
    if (animState.loopMode === 'once' && animState.currentTime >= dur - 0.005) {
      animState.currentTime = 0;
    }
    _pingPongDir = 1;
  }
  animState.playing = next;
  syncAnimationHeader();
}

export function toggleTimelinePlayback() {
  setTimelinePlaying(!animState.playing);
}

export function getTimelinePlaybackDuration() {
  if (animState.currentClip && animState.currentClip.duration > 0) {
    return animState.currentClip.duration;
  }
  return getMaxSceneAnimationDuration() || 3.0;
}

export function stepAnimationTimeline(dt) {
  if (!animState.playing) return;
  const dur = Math.max(0.2, getTimelinePlaybackDuration());
  const step = dt * (animState.speed || 1);
  let t = animState.currentTime;

  if (animState.loopMode === 'pingpong') {
    t += step * _pingPongDir;
    if (t >= dur) {
      t = dur - Math.max(0, t - dur);
      _pingPongDir = -1;
    } else if (t <= 0) {
      t = Math.abs(t);
      _pingPongDir = 1;
    }
  } else if (animState.loopMode === 'once') {
    t += step;
    if (t >= dur) {
      t = dur;
      animState.playing = false;
    }
  } else {
    t = (t + step) % dur;
  }

  animState.currentTime = Math.max(0, Math.min(dur, t));
  evaluateActiveAnimationsAt(animState.currentTime);
  if (viewport.appMode === 'animacion') {
    syncAnimationHeader();
    drawTimelineCanvas();
  }
}

// ============================================================
// INTEGRACIÓN CON GRABACIÓN DE VIDEO DE CÁMARA
// ============================================================

export function getMaxSceneAnimationDuration() {
  const clips = collectEvaluableClips();
  const extra = Array.isArray(sceneStore.animations) ? sceneStore.animations : [];
  const maxDur = AnimationClip.getMaxDuration([...clips, ...extra]);
  const speed = animState.speed > 0 ? animState.speed : 1;
  return maxDur > 0 ? maxDur / speed : 0;
}

export function beginCameraTimelinePlayback() {
  animState.playing = false;
  animState.currentTime = 0;
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
  const speed = animState.speed > 0 ? animState.speed : 1;
  animState.currentTime += dt * speed;
  evaluateActiveAnimationsAt(animState.currentTime);
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
  const showDetailRows = bodyH >= 92;
  const rows = showDetailRows
    ? [
        { label: 'Resumen', filter: null },
        { label: 'Posición', filter: 'position' },
        { label: 'Rotación', filter: 'quaternion' },
        { label: 'Escala', filter: 'scale' },
      ]
    : [{ label: 'Keyframes', filter: null }];
  return { rows, rowH: bodyH / rows.length };
}

function formatTickNumber(val) {
  const rounded = Math.round(val * 100) / 100;
  if (Object.is(rounded, -0) || rounded === 0) return '0';
  return String(rounded);
}

function chooseTickStep(pxPerSec) {
  const candidates = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30];
  for (const step of candidates) {
    if (step * pxPerSec >= 46) return step;
  }
  return 30;
}

function timeToX(t) {
  return _tlWidth * 0.5 + (t - animState.currentTime) * animState.pxPerSec;
}

function xToTime(x) {
  return animState.currentTime + (x - _tlWidth * 0.5) / animState.pxPerSec;
}

function hitTestTimelineKeyframe(clip, x, y) {
  if (!clip || y <= RULER_H) return null;
  const { rows, rowH } = getTimelineRows(_tlHeight);
  const rowIndex = Math.max(0, Math.min(rows.length - 1, Math.floor((y - RULER_H) / rowH)));
  const row = rows[rowIndex];
  const times = clip.getKeyframeTimes(row.filter);
  let bestT = null;
  let bestDist = 13;
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

  const rect = wrap.getBoundingClientRect();
  const w = Math.max(100, Math.floor(rect.width));
  const h = Math.max(60, Math.floor(rect.height));
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

  // Filas de pistas
  const { rows, rowH } = getTimelineRows(h);
  const clip = animState.currentClip;

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
    const times = clip.getKeyframeTimes(row.filter);

    for (const kt of times) {
      const kx = timeToX(kt);
      if (kx < -14 || kx > w + 14) continue;
      const isAtHead = Math.abs(kt - animState.currentTime) <= KEYFRAME_HIT_EPS;
      const r = rIdx === 0 ? 5.5 : 4.2;

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
  if (xDur >= -20 && xDur <= w + 20) {
    ctx.strokeStyle = '#facc15';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(xDur, 0);
    ctx.lineTo(xDur, h);
    ctx.stroke();

    const tagText = `${dur.toFixed(1)}s`;
    ctx.font = '700 10px "JetBrains Mono", monospace';
    const tagW = Math.max(32, ctx.measureText(tagText).width + 10);
    ctx.fillStyle = _tlHoverZone === 'duration' ? '#fef08a' : '#facc15';
    ctx.beginPath();
    ctx.roundRect(xDur - tagW * 0.5, 2, tagW, 17, 4);
    ctx.fill();
    ctx.fillStyle = '#111215';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(tagText, xDur, 10.5);
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
  const clip = animState.currentClip;
  const dur = getActiveClipDuration();

  if (dom.animTlClipLabel) {
    if (clip) {
      const owner = getClipOwner(clip);
      const ownerPrefix = owner?.name ? `${owner.name} · ` : '';
      dom.animTlClipLabel.textContent = `${ownerPrefix}${clip.name || 'Animación'}`;
    } else if (sceneStore.selected) {
      dom.animTlClipLabel.textContent = `${sceneStore.selected.name || 'Objeto'} · Sin clip`;
    } else {
      dom.animTlClipLabel.textContent = 'Sin animación';
    }
  }

  // Keyframe bajo línea azul (según herramienta activa o cualquier pista en modo selección)
  const activeProps = getActiveToolKeyframeProperties();
  const onKf = isPlayheadOnKeyframe(clip, animState.currentTime, activeProps);
  if (dom.btnTlKeyframe) {
    dom.btnTlKeyframe.classList.toggle('has-keyframe', onKf);
    const propTag = activeProps?.length === 1 ? ` (${PROP_LABELS[activeProps[0]] || activeProps[0]})` : '';
    dom.btnTlKeyframe.title = onKf
      ? `Quitar keyframe${propTag} en el tiempo actual`
      : `Insertar keyframe${propTag} en el tiempo actual`;
  }

  // Botón Play / Stop
  if (dom.btnTlPlay) {
    dom.btnTlPlay.classList.toggle('is-playing', animState.playing);
    const playIcon = dom.btnTlPlay.querySelector('.icon-play');
    const stopIcon = dom.btnTlPlay.querySelector('.icon-stop');
    if (playIcon) playIcon.hidden = animState.playing;
    if (stopIcon) stopIcon.hidden = !animState.playing;
  }

  // Curva activa en popover
  const activeInterp = getClipInterpolation(clip);
  document.querySelectorAll('#anim-curve-popover [data-anim-interp]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.animInterp === activeInterp);
  });

  // Ajustes •••
  if (dom.animSetSpeed && document.activeElement !== dom.animSetSpeed) {
    dom.animSetSpeed.value = String(animState.speed);
  }
  if (dom.animSetSpeedVal) {
    dom.animSetSpeedVal.textContent = `${animState.speed.toFixed(2)}×`;
  }
  if (dom.animSetDuration && document.activeElement !== dom.animSetDuration) {
    dom.animSetDuration.value = dur.toFixed(1);
  }
  if (dom.animSetLoop) dom.animSetLoop.value = animState.loopMode;
  if (dom.animSetAutokey) dom.animSetAutokey.checked = animState.autoKeyframe;
  if (dom.animSetSnap) dom.animSetSnap.checked = animState.snap;
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
      const isActive = animState.currentClip === clip;
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
          animState.activeClipByObject.set(owner, clip);
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
  if (viewport.appMode === 'animacion') {
    const sel = sceneStore.selected;
    if (sel) {
      const objActive = getActiveClipForObject(sel);
      if (objActive && animState.currentClip !== objActive && getClipOwner(animState.currentClip) !== sel) {
        animState.currentClip = objActive;
      }
    }
    if (!animState.currentClip) {
      animState.currentClip =
        (sel && getActiveClipForObject(sel)) || getAllSceneClips()[0] || null;
    }
  }
  if (dom.animTimeline) {
    dom.animTimeline.style.setProperty('--anim-tl-height', `${animState.timelineHeight}px`);
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
    copyBtn.addEventListener('click', () => {
      copyKeyframeFromTimeline(clip, hit.time, props);
      closeKeyframeContextMenu();
    });
    menu.appendChild(copyBtn);

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'anim-kf-menu-btn is-danger';
    delBtn.textContent = 'Eliminar keyframe';
    delBtn.addEventListener('click', () => {
      removeKeyframeAt(clip, hit.time, { properties: props });
      setStatus(`Keyframe eliminado en ${hit.time.toFixed(2)}s.`);
      closeKeyframeContextMenu();
    });
    menu.appendChild(delBtn);
  } else {
    if (!animState.copiedKeyframe) {
      closeKeyframeContextMenu();
      setStatus('No hay ningún keyframe copiado para pegar. Mantén presionado un keyframe para copiarlo.', true);
      return;
    }
    const targetT = snapTimelineTime(animState.currentTime);
    const title = document.createElement('div');
    title.className = 'anim-kf-menu-title';
    title.textContent = `Línea azul · ${targetT.toFixed(2)}s`;
    menu.appendChild(title);

    const pasteBtn = document.createElement('button');
    pasteBtn.type = 'button';
    pasteBtn.className = 'anim-kf-menu-btn';
    pasteBtn.textContent = `Pegar keyframe en ${targetT.toFixed(2)}s`;
    pasteBtn.addEventListener('click', () => {
      pasteKeyframeAtCurrentTime(null, targetT);
      closeKeyframeContextMenu();
    });
    menu.appendChild(pasteBtn);
  }

  menu.hidden = false;
  const maxLeft = Math.max(6, wrap.clientWidth - menu.offsetWidth - 6);
  const maxTop = Math.max(6, wrap.clientHeight - menu.offsetHeight - 6);
  menu.style.left = `${Math.max(6, Math.min(maxLeft, x - menu.offsetWidth * 0.5))}px`;
  menu.style.top = `${Math.max(6, Math.min(maxTop, y - menu.offsetHeight - 8))}px`;
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

  // Menú hamburguesa superior izquierdo
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

  // Botonera derecha del timeline: Keyframe, Zoom+, Zoom-, 0s, <, Play/Stop, >, Curva, •••
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

  // Botón de curva
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

  // Botón ••• de ajustes
  dom.btnTlMore?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!dom.animSettingsPopover) return;
    const willOpen = dom.animSettingsPopover.hidden;
    closeTimelineSubpopovers(willOpen ? 'anim-settings-popover' : null);
    dom.animSettingsPopover.hidden = !willOpen;
    dom.btnTlMore.classList.toggle('is-active', willOpen);
  });

  dom.animSetSpeed?.addEventListener('input', (e) => {
    animState.speed = Math.max(0.1, Math.min(3, Number(e.target.value) || 1));
    if (dom.animSetSpeedVal) dom.animSetSpeedVal.textContent = `${animState.speed.toFixed(2)}×`;
  });

  dom.animSetDuration?.addEventListener('change', (e) => {
    const clip = animState.currentClip;
    if (!clip) return;
    const before = clip.captureSnapshot();
    const nextDur = Math.max(0.2, Math.min(120, Number(e.target.value) || 3));
    clip.duration = nextDur;
    if (animState.currentTime > nextDur) animState.currentTime = nextDur;
    const after = clip.captureSnapshot();
    history.push({ type: 'animClip', clip, owner: getClipOwner(clip), before, after, label: 'Duración' });
    syncAnimationHeader();
    drawTimelineCanvas();
  });

  dom.animSetLoop?.addEventListener('change', (e) => {
    animState.loopMode = e.target.value || 'repeat';
  });
  dom.animSetAutokey?.addEventListener('change', (e) => {
    animState.autoKeyframe = e.target.checked;
  });
  dom.animSetSnap?.addEventListener('change', (e) => {
    animState.snap = e.target.checked;
  });

  // Cerrar subpopovers y menú contextual al hacer clic fuera
  document.addEventListener('pointerdown', (e) => {
    if (viewport.appMode !== 'animacion') return;
    if (!e.target.closest('#anim-kf-menu')) {
      closeKeyframeContextMenu();
    }
    const inside =
      e.target.closest('#anim-manager-popover') ||
      e.target.closest('#btn-anim-menu') ||
      e.target.closest('#anim-curve-popover') ||
      e.target.closest('#btn-tl-curve') ||
      e.target.closest('#anim-settings-popover') ||
      e.target.closest('#btn-tl-more');
    if (!inside) closeTimelineSubpopovers();
  });

  // Barra superior de redimensionamiento vertical del timeline
  if (dom.animTlResize && dom.animTimeline) {
    let resizeDrag = null;
    dom.animTlResize.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      dom.animTlResize.setPointerCapture(e.pointerId);
      resizeDrag = { pointerId: e.pointerId, startY: e.clientY, startH: animState.timelineHeight };
    });
    dom.animTlResize.addEventListener('pointermove', (e) => {
      if (!resizeDrag || e.pointerId !== resizeDrag.pointerId) return;
      const dy = resizeDrag.startY - e.clientY;
      const maxH = Math.max(160, Math.min(420, window.innerHeight - 190));
      animState.timelineHeight = Math.round(Math.max(110, Math.min(maxH, resizeDrag.startH + dy)));
      dom.animTimeline.style.setProperty('--anim-tl-height', `${animState.timelineHeight}px`);
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

  // Interacción sobre el canvas de la línea de tiempo (drag + mantener presionado copiar/pegar)
  if (dom.animTlCanvas) {
    let tlDrag = null;
    let holdTimer = 0;

    const clearHoldTimer = () => {
      if (holdTimer) {
        clearTimeout(holdTimer);
        holdTimer = 0;
      }
    };

    dom.animTlCanvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      clearHoldTimer();
      const rect = dom.animTlCanvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const hit = hitTestTimelineKeyframe(animState.currentClip, x, y);
      openKeyframeContextMenu({ x, y, hit, clip: animState.currentClip });
    });

    dom.animTlCanvas.addEventListener('pointerdown', (e) => {
      if (e.button === 2) return;
      e.preventDefault();
      closeTimelineSubpopovers();
      clearHoldTimer();

      const rect = dom.animTlCanvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const dur = getActiveClipDuration();
      const xDur = timeToX(dur);

      dom.animTlCanvas.setPointerCapture(e.pointerId);
      if (animState.playing) setTimelinePlaying(false);

      // 1. Arrastrar línea amarilla de duración
      if (animState.currentClip && Math.abs(x - xDur) <= 10) {
        tlDrag = {
          mode: 'duration',
          pointerId: e.pointerId,
          startX: x,
          startY: y,
          startDur: dur,
          before: animState.currentClip.captureSnapshot(),
          holdTriggered: false,
        };
        return;
      }

      // 2. Keyframe en fila (Resumen / Posición / Rotación / Escala)
      const hit = hitTestTimelineKeyframe(animState.currentClip, x, y);
      if (hit) {
        tlDrag = {
          mode: 'keyframe',
          pointerId: e.pointerId,
          startX: x,
          startY: y,
          origTime: hit.time,
          curTime: hit.time,
          properties: hit.filter ? [hit.filter] : null,
          hit,
          moved: false,
          holdTriggered: false,
          before: animState.currentClip.captureSnapshot(),
        };
        holdTimer = setTimeout(() => {
          if (!tlDrag || tlDrag.pointerId !== e.pointerId || tlDrag.moved) return;
          tlDrag.holdTriggered = true;
          openKeyframeContextMenu({ x, y, hit: tlDrag.hit, clip: animState.currentClip });
        }, LONG_PRESS_MS);
        return;
      }

      // 3. Arrastrar tiempo o mantener presionado en lugar vacío (para pegar en la línea azul)
      tlDrag = {
        mode: 'scrub',
        pointerId: e.pointerId,
        startX: x,
        startY: y,
        startTime: animState.currentTime,
        moved: false,
        holdTriggered: false,
      };
      holdTimer = setTimeout(() => {
        if (!tlDrag || tlDrag.pointerId !== e.pointerId || tlDrag.moved) return;
        tlDrag.holdTriggered = true;
        openKeyframeContextMenu({ x, y, hit: null, clip: animState.currentClip });
      }, LONG_PRESS_MS);
    });

    dom.animTlCanvas.addEventListener('pointermove', (e) => {
      const rect = dom.animTlCanvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      if (!tlDrag) {
        const dur = getActiveClipDuration();
        const overDur = animState.currentClip && Math.abs(x - timeToX(dur)) <= 10;
        const overKf = !overDur && Boolean(hitTestTimelineKeyframe(animState.currentClip, x, y));
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
      if (Math.hypot(dx, dy) > LONG_PRESS_MOVE_PX) {
        tlDrag.moved = true;
        clearHoldTimer();
      }

      if (tlDrag.mode === 'duration') {
        const rawDur = tlDrag.startDur + dx / animState.pxPerSec;
        const snapped = Math.max(0.2, Math.min(120, Math.round(rawDur * 20) / 20));
        if (animState.currentClip) {
          animState.currentClip.duration = snapped;
          if (animState.currentTime > snapped) animState.currentTime = snapped;
          syncAnimationHeader();
          drawTimelineCanvas();
        }
      } else if (tlDrag.mode === 'keyframe' && animState.currentClip) {
        if (!tlDrag.moved) return;
        const rawT = tlDrag.origTime + dx / animState.pxPerSec;
        const nextT = Math.min(Math.max(0, getActiveClipDuration()), snapTimelineTime(rawT));
        if (Math.abs(nextT - tlDrag.curTime) > 1e-4) {
          // Vista previa desde el snapshot original: jamás arrastra ni se come keyframes intermedios
          animState.currentClip.previewMoveKeyframe(tlDrag.before, tlDrag.origTime, nextT, {
            properties: tlDrag.properties,
            eps: KEYFRAME_HIT_EPS,
          });
          tlDrag.curTime = nextT;
          evaluateActiveAnimationsAt(animState.currentTime);
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
      if (!tlDrag || e.pointerId !== tlDrag.pointerId) return;
      clearHoldTimer();
      const finished = tlDrag;
      tlDrag = null;

      if (finished.holdTriggered) return;

      if (finished.mode === 'duration' && animState.currentClip && finished.before) {
        if (Math.abs(animState.currentClip.duration - finished.startDur) > 1e-3) {
          history.push({
            type: 'animClip',
            clip: animState.currentClip,
            owner: getClipOwner(animState.currentClip),
            before: finished.before,
            after: animState.currentClip.captureSnapshot(),
            label: 'Duración animación',
          });
        }
      } else if (finished.mode === 'keyframe' && animState.currentClip && finished.before) {
        if (!finished.moved) {
          setTimelineTime(finished.origTime);
        } else if (Math.abs(finished.curTime - finished.origTime) > 1e-3) {
          // Confirmar movimiento con fusión únicamente si se soltó intencionalmente sobre otro keyframe
          animState.currentClip.commitMoveKeyframe(
            finished.before,
            finished.origTime,
            finished.curTime,
            {
              properties: finished.properties,
              eps: KEYFRAME_HIT_EPS,
              mergeEps: 0.025,
            }
          );
          evaluateActiveAnimationsAt(animState.currentTime);
          syncAnimationHeader();
          drawTimelineCanvas();
          history.push({
            type: 'animClip',
            clip: animState.currentClip,
            owner: getClipOwner(animState.currentClip),
            before: finished.before,
            after: animState.currentClip.captureSnapshot(),
            label: 'Mover keyframe',
          });
        } else {
          animState.currentClip.restoreSnapshot(finished.before);
          evaluateActiveAnimationsAt(animState.currentTime);
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
          setTimelineTime(animState.currentTime + deltaSec);
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
