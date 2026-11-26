import {
  BoxGeometry,
  SphereGeometry,
  PlaneGeometry,
  CylinderGeometry,
  ConeGeometry,
  CapsuleGeometry,
  TorusGeometry,
  TorusKnotGeometry,
  CircleGeometry,
  RingGeometry,
  PyramidGeometry,
  TetrahedronGeometry,
  OctahedronGeometry,
  DodecahedronGeometry,
  IcosahedronGeometry,
  StandardMaterial,
  Texture,
  Mesh,
  DirectionalLight,
  PointLight,
  autoScaleObject,
  loadTextGeometry,
} from '../made3d.module.js';
import {
  Rigger,
  SkeletonHelper,
  cloneObject,
} from '../src/modules/rigging.js';
import {
  createProceduralEnvironment,
  loadEnvironmentFromFile,
} from '../src/modules/environment.js';
import { dom, setStatus } from './dom.js';
import {
  viewport,
  sceneStore,
  lighting,
  sculpt,
  edit,
  rig,
  getCameraMeta,
  setCameraMeta,
  isInScene,
  findOwningUserRoot,
} from './store.js';
import { history } from './history.js';
import {
  syncCameraHelperSelection,
  selectObject,
  resetCamera,
  setGizmoMode,
} from './viewport.js';
import {
  exitCameraView,
  stopCameraVideo,
} from './cameraView.js';
import {
  setSculptMode,
  syncSculptUI,
} from './sculptController.js';
import {
  setEditMode,
  syncEditUI,
} from './editController.js';
import {
  syncSelectedUI,
  syncAppModeUI,
  renderObjectList,
} from './inspectorUI.js';
import {
  cleanupClipsForObject,
  clearAllCustomClips,
  syncAnimationUI,
} from './animationController.js';

export { mergeSelectedObjects } from './meshMerge.js';
export { buildExportTarget, handleModelFiles, exportSceneFormat } from './ioActions.js';

export const proceduralTexture = Texture.checkerboard();

export function clearUserObjects({ dispose = false, keepSceneLights = false } = {}) {
  if (viewport.gizmo?.drag) viewport.gizmo.cancel();
  if (stopCameraVideo) stopCameraVideo({ cancel: true });
  exitCameraView({ restoreSnapshot: false });
  if (dom.gizmoReadout) dom.gizmoReadout.hidden = true;
  if (viewport.gizmo) {
    viewport.gizmo.setMultiSelectMode?.(false);
    viewport.gizmo.detach();
  }
  const kept = [];
  for (const obj of sceneStore.userObjects) {
    if (keepSceneLights && obj.isLight) {
      kept.push(obj);
      continue;
    }
    obj.removeFromParent();
    if (dispose && !obj.isLight) viewport.renderer?.disposeObject(obj);
  }
  sceneStore.userObjects = kept;
  sceneStore.spinObjects.clear();
  sceneStore.selected = null;
  sceneStore.selectedList = [];
  sceneStore.cameraCounter = 0;
  sceneStore.mixer = null;
  sceneStore.animations = [];
  sceneStore.activeAction = null;
  sceneStore.activeClipIndex = 0;
  clearAllCustomClips();
  if (dom.animGroup) dom.animGroup.hidden = true;
  if (dom.animSelect) dom.animSelect.innerHTML = '';
  if (viewport.picker) viewport.picker.setMixer(null);
  if (edit.active) setEditMode(false);
  if (sculpt.active) setSculptMode(false);
  if (rig.active) history._hooks.setRigMode?.(false);
  rig.rigger.activeTipBone = null;
  rig.rigger.selectedBone = null;
  rig.rigger.hover = null;
  syncAppModeUI('pose');
  syncCameraHelperSelection();
  syncSelectedUI();
  syncSculptUI();
  syncEditUI();
  history._hooks.syncRigUI?.();
  syncAnimationUI();
  renderObjectList();
}

export function registerUserObject(obj, name, recordHistory = false) {
  const prevSelected = sceneStore.selected;
  sceneStore.objectCounter++;
  obj.name = name || obj.name || `Objeto ${sceneStore.objectCounter}`;
  if (obj.parent !== viewport.scene) {
    viewport.scene.add(obj);
  }
  if (!sceneStore.userObjects.includes(obj)) {
    sceneStore.userObjects.push(obj);
  }
  let cmd = null;
  if (recordHistory) {
    cmd = {
      type: 'add',
      obj,
      parent: viewport.scene,
      index: viewport.scene.children.indexOf(obj),
      wasUserObject: true,
      userIndex: sceneStore.userObjects.length - 1,
      prevSelected,
    };
    history.push(cmd);
  }
  renderObjectList();
  return cmd ? { obj, cmd } : obj;
}

export function addSceneLight(kind = 'point', opts = {}) {
  sceneStore.lightCounter++;
  const n = sceneStore.lightCounter;
  let light;
  if (kind === 'directional') {
    let dirCount = 0;
    viewport.scene?.traverse((node) => { if (node.isDirectionalLight) dirCount++; });
    if (dirCount >= 4) {
      setStatus('Aviso: el motor renderiza hasta 4 luces direccionales activas simultáneamente.');
    }
    light = new DirectionalLight(opts.color ?? 0xfff5e4, opts.intensity ?? 1.1);
    light.position.set(opts.x ?? 0, opts.y ?? 0, opts.z ?? 0);
    light.target.set(0, -1, 0);
    light.castShadow = false;
    light.name = opts.name || `Luz direccional ${n + 1}`;
    if (!lighting.dirLight) lighting.dirLight = light;
  } else {
    let ptCount = 0;
    viewport.scene?.traverse((node) => { if (node.isPointLight) ptCount++; });
    if (ptCount >= 4) {
      setStatus('Aviso: el motor renderiza hasta 4 luces puntuales activas simultáneamente.');
    }
    light = new PointLight(opts.color ?? 0xffe4b5, opts.intensity ?? 8, opts.distance ?? 10, opts.decay ?? 2);
    light.position.set(opts.x ?? 0, opts.y ?? 0, opts.z ?? 0);
    light.name = opts.name || `Luz puntual ${n + 1}`;
    if (!lighting.pointLight) lighting.pointLight = light;
  }

  registerUserObject(light, light.name, opts.recordHistory !== false);
  selectObject(light);
  setStatus(`${light.name} añadida. Toca "Objeto → Luz" para editar color, alcance e intensidad.`);
  return light;
}

export function duplicateSelected() {
  const o = sceneStore.selected;
  if (!o || o.isBone || o.isInstancedMesh) return;
  const prevSelected = o;
  const copy = cloneObject(o, { cloneMaterial: true, scene: viewport.scene });

  if (!copy) return;

  if (o.isCamera) {
    const meta = getCameraMeta(o);
    const helper = copy.children.find((c) => c.isCameraHelper) || null;
    setCameraMeta(copy, { showThirds: meta.showThirds, includeGrid: meta.includeGrid, helper });
    sceneStore.cameraCounter++;
  }

  const isTopLevel = !o.parent || o.parent === viewport.scene;
  copy.name = `${o.name || 'Objeto'} copia`;
  copy.position.copy(o.position);

  if (isTopLevel) {
    const reg = registerUserObject(copy, copy.name, true);
    if (reg?.cmd) reg.cmd.prevSelected = prevSelected;
  } else {
    o.parent.add(copy);
    copy.updateMatrixWorld();
    history.push({
      type: 'add',
      obj: copy,
      parent: o.parent,
      index: o.parent.children.indexOf(copy),
      wasUserObject: false,
      userIndex: -1,
      prevSelected,
    });
    renderObjectList();
  }
  selectObject(copy);
  setStatus(`Duplicado: ${copy.name}`);
}

export function deleteSelected(explicitTarget = null) {
  if (viewport.gizmo?.drag) viewport.gizmo.cancel();

  const targets = explicitTarget
    ? [explicitTarget]
    : viewport.gizmo && viewport.gizmo.objects.length > 1
    ? viewport.gizmo.objects.slice()
    : sceneStore.selected
    ? [sceneStore.selected]
    : [];

  if (!targets.length) return;

  history._hooks.ensureRigWeightPaintRestored?.();
  const sceneMeta = history.captureSceneMeta();
  const skeletonPatches = [];
  const removals = [];
  let nextOwner = null;

  for (const o of targets) {
    if (!isInScene(o)) continue;
    const isBone = Boolean(o.isBone);
    if (isBone && !nextOwner) {
      nextOwner = findOwningUserRoot(o.parent) || (o.parent && o.parent !== viewport.scene ? o.parent : null);
    }
    skeletonPatches.push(...Skeleton.collectRemovalPatches(viewport.scene, o));
    const mainRec = history.buildRemovalRecord(o);
    history.applyRemoval(mainRec);
    removals.push(mainRec);
    cleanupClipsForObject(o);

    if (!isBone && !mainRec.wasUserObject && mainRec.parent) {
      const owner = findOwningUserRoot(mainRec.parent);
      if (owner && !owner.hasMeshDescendant()) {
        const ownerRec = history.buildRemovalRecord(owner);
        history.applyRemoval(ownerRec);
        removals.push(ownerRec);
        cleanupClipsForObject(owner);
      }
    }
    if (o === lighting.dirLight) lighting.dirLight = null;
    if (o === lighting.pointLight) lighting.pointLight = null;
  }

  if (!removals.length) return;

  history.applySkeletonPatches(skeletonPatches, true);
  SkeletonHelper.invalidateScene(viewport.scene, {
    gizmo: viewport.gizmo,
    picker: viewport.picker,
    mixer: sceneStore.mixer,
  });

  if (sceneStore.mixer && sceneStore.mixer.root && !isInScene(sceneStore.mixer.root)) {
    sceneStore.mixer = null;
    sceneStore.animations = [];
    sceneStore.activeAction = null;
    sceneStore.activeClipIndex = 0;
    if (viewport.picker) viewport.picker.setMixer(null);
    if (dom.animSelect) dom.animSelect.innerHTML = '';
    if (dom.animGroup) dom.animGroup.hidden = true;
  }

  const afterSelected = nextOwner && isInScene(nextOwner) ? nextOwner : null;
  if (afterSelected) {
    selectObject(afterSelected);
  } else {
    syncSelectedUI();
    syncSculptUI();
    syncEditUI();
    history._hooks.syncRigUI?.();
    syncAnimationUI();
    renderObjectList();
  }

  const afterSceneMeta = history.captureSceneMeta();
  history.push({
    type: 'delete',
    removals,
    skeletonPatches,
    prevSelected: targets[targets.length - 1],
    afterSelected,
    sceneMeta,
    afterSceneMeta,
  });
  const label =
    targets.length > 1
      ? `${targets.length} objetos`
      : targets[0].name || (targets[0].isBone ? 'Hueso' : 'Objeto');
  setStatus(`Eliminado: ${label} (Ctrl+Z para deshacer)`);
}

export function addPrimitive(kind, opts = {}) {
  const num = sceneStore.objectCounter + 1;
  let geo;
  let defaultName;
  let doubleSided = false;

  switch (kind) {
    case 'sphere':
      geo = new SphereGeometry(0.75, 28, 20);
      defaultName = `Esfera ${num}`;
      break;
    case 'plane':
      geo = new PlaneGeometry(2.2, 2.2);
      defaultName = `Plano ${num}`;
      doubleSided = true;
      break;
    case 'cylinder':
      geo = new CylinderGeometry(0.55, 0.55, 1.4, 28, 1);
      defaultName = `Cilindro ${num}`;
      break;
    case 'cone':
      geo = new ConeGeometry(0.65, 1.4, 28, 1);
      defaultName = `Cono ${num}`;
      break;
    case 'capsule':
      geo = new CapsuleGeometry(0.42, 0.85, 8, 24);
      defaultName = `Cápsula ${num}`;
      break;
    case 'torus':
      geo = new TorusGeometry(0.65, 0.22, 18, 40);
      defaultName = `Toroide ${num}`;
      break;
    case 'torusKnot':
      geo = new TorusKnotGeometry(0.52, 0.16, 80, 14, 2, 3);
      defaultName = `Nudo ${num}`;
      break;
    case 'circle':
      geo = new CircleGeometry(0.85, 32);
      defaultName = `Círculo ${num}`;
      doubleSided = true;
      break;
    case 'ring':
      geo = new RingGeometry(0.42, 0.9, 32, 1);
      defaultName = `Anillo ${num}`;
      doubleSided = true;
      break;
    case 'pyramid':
      geo = new PyramidGeometry(1.3, 1.3, 1.3);
      defaultName = `Pirámide ${num}`;
      break;
    case 'tetrahedron':
      geo = new TetrahedronGeometry(0.82, 0);
      defaultName = `Tetraedro ${num}`;
      break;
    case 'octahedron':
      geo = new OctahedronGeometry(0.82, 0);
      defaultName = `Octaedro ${num}`;
      break;
    case 'dodecahedron':
      geo = new DodecahedronGeometry(0.82, 0);
      defaultName = `Dodecaedro ${num}`;
      break;
    case 'icosahedron':
      geo = new IcosahedronGeometry(0.82, 0);
      defaultName = `Icosaedro ${num}`;
      break;
    default:
      geo = new BoxGeometry(1.3, 1.3, 1.3);
      defaultName = `Cubo ${num}`;
      break;
  }

  const palette = [0x4f86f7, 0xf59e0b, 0x10b981, 0xec4899, 0x8b5cf6, 0x06b6d4];
  const color = opts.color ?? palette[sceneStore.objectCounter % palette.length];

  const mat = new StandardMaterial({
    color,
    shininess: opts.shininess ?? 36,
    side: doubleSided ? 'double' : 'front',
    map: opts.textured ? proceduralTexture : null,
    ...(opts.hasPbr
      ? {
          hasPbr: true,
          roughness: opts.roughness ?? 0.5,
          metalness: opts.metalness ?? 0,
        }
      : {}),
  });

  const mesh = new Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  if (opts.position) {
    mesh.position.set(opts.position[0], opts.position[1], opts.position[2]);
  } else {
    mesh.position.set(0, 0, 0);
  }
  if (opts.rotation) {
    mesh.rotation.set(opts.rotation[0], opts.rotation[1], opts.rotation[2]);
  }

  registerUserObject(mesh, opts.name || defaultName, Boolean(opts.recordHistory));
  if (opts.spin) sceneStore.spinObjects.add(mesh);
  if (opts.select !== false) selectObject(mesh);
  return mesh;
}

export async function addText3D(opts = {}) {
  const text = opts.text ?? 'Made3D';
  const { TextGeometry } = await loadTextGeometry();
  const geo = new TextGeometry({
    text,
    size: opts.size ?? 0.72,
    depth: opts.depth ?? 0.18,
    fontFamily: opts.fontFamily ?? 'Plus Jakarta Sans, system-ui, -apple-system, sans-serif',
    fontWeight: opts.fontWeight ?? '700',
    fontStyle: opts.fontStyle ?? 'normal',
    align: opts.align ?? 'center',
    letterSpacing: opts.letterSpacing ?? 0,
  });

  const palette = [0x4f86f7, 0xf59e0b, 0x10b981, 0xec4899, 0x8b5cf6, 0x06b6d4];
  const color = opts.color ?? palette[sceneStore.objectCounter % palette.length];
  const mat = new StandardMaterial({
    color,
    shininess: opts.shininess ?? 44,
  });

  const mesh = new Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  if (opts.position) {
    mesh.position.set(opts.position[0], opts.position[1], opts.position[2]);
  } else {
    mesh.position.set(0, 0, 0);
  }
  if (opts.rotation) {
    mesh.rotation.set(opts.rotation[0], opts.rotation[1], opts.rotation[2]);
  }

  const short = String(text).replace(/\s+/g, ' ').trim().slice(0, 16) || 'Vacío';
  registerUserObject(mesh, opts.name || `Texto: ${short}`, Boolean(opts.recordHistory));
  if (opts.select !== false) selectObject(mesh);
  setStatus('Texto 3D creado.');
  return mesh;
}

export function addTestRig(opts = {}) {
  const skinned = Rigger.createSampleRig({
    color: opts.color ?? 0x38bdf8,
    shininess: opts.shininess ?? 42,
    position: opts.position ?? null,
  });
  registerUserObject(skinned, 'Rig prueba', Boolean(opts.recordHistory));
  selectObject(skinned);
  setGizmoMode('rotate');
  setStatus('Rig de prueba añadido con huesos.');
  return skinned;
}

export function applyEnvironmentPreset(preset = 'studio', opts = {}) {
  const scene = viewport.scene;
  if (!scene) return null;
  const prev = scene.environment;
  if (preset === 'none' || !preset) {
    scene.environment = null;
    scene.environmentPreset = 'none';
    if (opts.intensity !== undefined) scene.environmentIntensity = opts.intensity;
  } else {
    const tex = createProceduralEnvironment(preset, 128, 64);
    scene.environment = tex;
    scene.environmentPreset = preset;
    scene.environmentIntensity =
      opts.intensity ?? (scene.environmentIntensity > 0 ? scene.environmentIntensity : 0.65);
  }
  if (prev && prev !== scene.environment && typeof prev.dispose === 'function') {
    prev.dispose();
  }
  if (dom.envPreset) {
    const customOpt = dom.envPreset.querySelector('option[value="custom"]');
    if (customOpt) customOpt.hidden = scene.environmentPreset !== 'custom';
    dom.envPreset.value = scene.environmentPreset || 'none';
  }
  if (dom.envIntensity) dom.envIntensity.value = String(scene.environmentIntensity);
  if (dom.envIntensityVal) dom.envIntensityVal.textContent = (scene.environmentIntensity ?? 0.65).toFixed(2);
  return scene.environment;
}

export async function loadEnvironmentFile(file) {
  if (!file || !viewport.scene) return null;
  setStatus(`Cargando mapa de entorno ${file.name}...`);
  const tex = await loadEnvironmentFromFile(file);
  const prev = viewport.scene.environment;
  viewport.scene.environment = tex;
  viewport.scene.environmentPreset = 'custom';
  if (!(viewport.scene.environmentIntensity > 0)) {
    viewport.scene.environmentIntensity = 1.0;
  }
  if (prev && prev !== tex && typeof prev.dispose === 'function') {
    prev.dispose();
  }
  if (dom.envPreset) {
    const customOpt = dom.envPreset.querySelector('option[value="custom"]');
    if (customOpt) {
      customOpt.hidden = false;
      customOpt.textContent = `Archivo: ${file.name.slice(0, 22)}`;
    }
    dom.envPreset.value = 'custom';
  }
  if (dom.envIntensity) dom.envIntensity.value = String(viewport.scene.environmentIntensity);
  if (dom.envIntensityVal) dom.envIntensityVal.textContent = viewport.scene.environmentIntensity.toFixed(2);
  setStatus(`Entorno HDRI/IBL cargado: ${file.name}`);
  return tex;
}

export function initDefaultScene() {
  clearUserObjects({ dispose: true });
  history.clear();
  sceneStore.objectCounter = 0;
  setStatus('');

  applyEnvironmentPreset('studio', { intensity: 0.65 });

  selectObject(null);
  resetCamera();
}

export function playAnimationClip(index) {
  if (!sceneStore.mixer || !sceneStore.animations[index]) return;
  if (sceneStore.activeAction) sceneStore.activeAction.stop();
  const action = sceneStore.mixer.clipAction(sceneStore.animations[index], 'repeat');
  action.play();
  sceneStore.activeAction = action;
  sceneStore.activeClipIndex = index;
  sceneStore.animPlaying = true;
  if (dom.btnAnimPlay) dom.btnAnimPlay.textContent = 'Pausar';
}
