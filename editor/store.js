import { Clock, HistoryManager } from '../made3d.module.js';
import { AnimationTimeline } from '../src/modules/animation.js';
import { Sculptor } from '../src/modules/sculpt.js';
import { MeshEditor } from '../src/modules/modeling.js';
import { Rigger } from '../src/modules/rigging.js';
import { Painter } from '../src/modules/paint.js';

export const clock = new Clock();

export const viewport = {
  renderer: null,
  scene: null,
  perspCam: null,
  orthoCam: null,
  camera: null,
  controls: null,
  picker: null,
  gizmo: null,
  gizmoStyle: 'made3d',
  snapOn: false,
  orthoHalfH: 5.5,
  ktx2Loader: null,
  dracoLoader: null,
  appMode: 'pose', // 'pose' | 'modelar' | 'edicion' | 'pintar' | 'esqueleto' | 'animacion'
  gizmoXyzOpen: false,
  openPopover: null,
  scheduler: null,
};

export const sceneStore = {
  grid: null,
  floor: null,
  userObjects: [],
  spinObjects: new Set(),
  selected: null,
  selectedList: [],
  mixer: null,
  animations: [],
  activeAction: null,
  activeClipIndex: 0,
  animPlaying: true,
  objectCounter: 0,
  cameraCounter: 0,
  lightCounter: 0,
};

export const lighting = {
  ambientLight: null,
  dirLight: null,
  pointLight: null,
  fogColorHex: '#121110',
  fogEnabled: true,
  fogFar: 38,
  orbitLight: false,
};

export const cameraView = {
  activeSceneCam: null,
  viewCam: null,
  camViewLocked: false,
  editorViewSnapshot: null,
};

export const recorder = {
  instance: null,
  camera: null,
  duration: 0,
  stopping: false,
  starting: false,
  mode: 'fixed',
  autoAnimStop: false,
  targetAnimDuration: 0,
  recordElapsed: 0,
};

export const timeline = new AnimationTimeline();

export const animState = {
  pxPerSec: 120,
  timelineHeight: 148,
  mobileTimelineHeight: 90,
};

export const sculpt = {
  active: false,
  sculptor: new Sculptor(),
};

export const edit = {
  active: false,
  subtab: 'sculpt',
  editor: new MeshEditor(),
};

export const rig = {
  active: false,
  rigger: new Rigger(),
};

export const paint = {
  active: false,
  painter: new Painter(),
};

export const debug = {
  timers: {},
  hudTimer: 0,
  hudInterval: 0.2,
};

// Metadatos del editor por objeto sin contaminar `obj.userData`
const _cameraMeta = new WeakMap();

export function getCameraMeta(cam) {
  if (!cam) return { showThirds: true, includeGrid: false, helper: null };
  let meta = _cameraMeta.get(cam);
  if (!meta) {
    meta = { showThirds: true, includeGrid: false, helper: null };
    _cameraMeta.set(cam, meta);
  }
  return meta;
}

export function setCameraMeta(cam, patch) {
  if (!cam) return null;
  const meta = getCameraMeta(cam);
  Object.assign(meta, patch);
  return meta;
}

export function isInScene(obj) {
  let cur = obj;
  while (cur) {
    if (cur === viewport.scene) return true;
    cur = cur.parent;
  }
  return false;
}

export function isDescendantOrSelf(node, ancestor) {
  let cur = node;
  while (cur) {
    if (cur === ancestor) return true;
    cur = cur.parent;
  }
  return false;
}

export function snapshotLocal(o) {
  return HistoryManager.snapshotTransform(o);
}

export function cloneLocalState(s) {
  return HistoryManager.cloneTransform(s);
}

export function restoreLocal(o, st) {
  HistoryManager.restoreTransform(o, st);
}

export function findOwningUserRoot(obj) {
  let cur = obj;
  while (cur && cur !== viewport.scene) {
    if (sceneStore.userObjects.includes(cur)) return cur;
    cur = cur.parent;
  }
  return null;
}
