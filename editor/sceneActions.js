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
  Vec3,
  autoScaleObject,
  computeBounds,
  loadGLTFLoader,
  loadOBJLoader,
  loadZipLoader,
  loadKTX2Loader,
  loadTextGeometry,
  loadAnimation,
} from '../made3d.module.js';
import {
  Bone,
  Skeleton,
  SkeletonHelper,
  SkinnedMesh,
  cloneObject,
} from '../src/modules/rigging.js';
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
  focusOnObject,
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
  if (dom.animGroup) dom.animGroup.hidden = true;
  if (dom.animSelect) dom.animSelect.innerHTML = '';
  if (viewport.picker) viewport.picker.setMixer(null);
  if (edit.active) setEditMode(false);
  if (sculpt.active) setSculptMode(false);
  syncAppModeUI('pose');
  syncCameraHelperSelection();
  syncSelectedUI();
  syncSculptUI();
  syncEditUI();
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
    light.position.set(opts.x ?? -5 + (n % 4) * 2.5, opts.y ?? 8, opts.z ?? 5);
    light.target.set(0, 0, 0);
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
    const spread = ((sceneStore.objectCounter % 5) - 2) * 1.1;
    light.position.set(opts.x ?? spread, opts.y ?? 2.6, opts.z ?? 1.2);
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
  const bounds = o.isLight || o.isCamera ? null : computeBounds(o);
  const step = bounds && !bounds.empty ? Math.max(0.25, bounds.size.x * 0.65) : 0.8;
  copy.name = `${o.name || 'Objeto'} copia`;

  if (isTopLevel) {
    copy.position.x += step;
    const reg = registerUserObject(copy, copy.name, true);
    if (reg?.cmd) reg.cmd.prevSelected = prevSelected;
  } else {
    o.parent.updateWorldMatrix(true, false);
    const pScale = o.parent.matrixWorld.getMaxScale() || 1;
    copy.position.x += step / pScale;
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

    if (!isBone && !mainRec.wasUserObject && mainRec.parent) {
      const owner = findOwningUserRoot(mainRec.parent);
      if (owner && !owner.hasMeshDescendant()) {
        const ownerRec = history.buildRemovalRecord(owner);
        history.applyRemoval(ownerRec);
        removals.push(ownerRec);
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
    // Usar el objeto activo en modo Edición o el último seleccionado como malla destino
    const activeEditMesh = edit.active && edit.editor.mesh ? edit.editor.mesh : null;
    let primary = activeEditMesh && candidates.includes(activeEditMesh)
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

  // Un solo objeto -> soldar islas internas / vértices cercanos sobre sí mismo
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

export function addPrimitive(kind, opts = {}) {
  const num = sceneStore.objectCounter + 1;
  let geo;
  let defaultName;
  let doubleSided = false;
  let defaultY = 0.85;

  switch (kind) {
    case 'sphere':
      geo = new SphereGeometry(0.75, 28, 20);
      defaultName = `Esfera ${num}`;
      break;
    case 'plane':
      geo = new PlaneGeometry(2.2, 2.2);
      defaultName = `Plano ${num}`;
      doubleSided = true;
      defaultY = 1.1;
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
      defaultY = 1.0;
      break;
    case 'torusKnot':
      geo = new TorusKnotGeometry(0.52, 0.16, 80, 14, 2, 3);
      defaultName = `Nudo ${num}`;
      defaultY = 1.05;
      break;
    case 'circle':
      geo = new CircleGeometry(0.85, 32);
      defaultName = `Círculo ${num}`;
      doubleSided = true;
      defaultY = 1.0;
      break;
    case 'ring':
      geo = new RingGeometry(0.42, 0.9, 32, 1);
      defaultName = `Anillo ${num}`;
      doubleSided = true;
      defaultY = 1.0;
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
    const spread = ((sceneStore.objectCounter % 5) - 2) * 1.3;
    mesh.position.set(spread, defaultY, 0);
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
    const spread = ((sceneStore.objectCounter % 5) - 2) * 0.45;
    mesh.position.set(spread, 0.9, 0);
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
  const geo = new SphereGeometry(0.85, 24, 18);
  const posAttr = geo.attributes.position;
  const arr = posAttr.array;
  const count = posAttr.count;
  const skinIndex = new Float32Array(count * 4);
  const skinWeight = new Float32Array(count * 4);

  for (let i = 0; i < count; i++) {
    const x = arr[i * 3] * 0.72;
    const y = (arr[i * 3 + 1] + 0.85) * 1.45;
    const z = arr[i * 3 + 2] * 0.72;
    arr[i * 3] = x;
    arr[i * 3 + 1] = y;
    arr[i * 3 + 2] = z;

    if (y < 0.95) {
      skinIndex[i * 4] = 2;
      skinWeight[i * 4] = 1;
    } else if (y < 1.75) {
      const t = (y - 0.95) / 0.8;
      skinIndex[i * 4] = 2;
      skinIndex[i * 4 + 1] = 3;
      skinWeight[i * 4] = 1 - t;
      skinWeight[i * 4 + 1] = t;
    } else {
      const t = Math.min(1, (y - 1.75) / 0.7);
      skinIndex[i * 4] = 3;
      skinIndex[i * 4 + 1] = 4;
      skinWeight[i * 4] = 1 - t;
      skinWeight[i * 4 + 1] = t;
    }
  }
  posAttr.needsUpdate = true;
  geo.setAttribute('skinIndex', skinIndex, 4);
  geo.setAttribute('skinWeight', skinWeight, 4);

  const mat = new StandardMaterial({ color: 0x38bdf8, shininess: 42 });
  const skinned = new SkinnedMesh(geo, mat);
  skinned.castShadow = true;
  skinned.receiveShadow = true;

  const boneRaiz = new Bone();
  boneRaiz.name = 'Raiz';
  boneRaiz.position.set(0, 0.4, 0);

  const boneCadera = new Bone();
  boneCadera.name = 'Cadera';
  boneCadera.position.set(0, 0, 0);

  const boneBaseFK = new Bone();
  boneBaseFK.name = 'Base_FK';
  boneBaseFK.position.set(0, 0, 0);

  const boneTorso = new Bone();
  boneTorso.name = 'Torso';
  boneTorso.position.set(0, 0.95, 0);

  const boneCabeza = new Bone();
  boneCabeza.name = 'Cabeza';
  boneCabeza.position.set(0, 0.8, 0);
  boneCabeza.length = 0.45;

  boneRaiz.add(boneCadera);
  boneCadera.add(boneBaseFK);
  boneBaseFK.add(boneTorso);
  boneTorso.add(boneCabeza);

  skinned.add(boneRaiz);
  const spread = sceneStore.userObjects.length ? ((sceneStore.objectCounter % 5) - 2) * 1.6 : 0;
  skinned.position.set(spread, 0, 0);
  skinned.bind(new Skeleton([boneRaiz, boneCadera, boneBaseFK, boneTorso, boneCabeza]));

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

  const box = addPrimitive('box', {
    name: 'Cubo principal',
    color: 0x4f86f7,
    shininess: 48,
    position: [0, 0.85, 0],
    select: false,
  });
  box.rotation.set(0.18, 0.55, 0);

  addPrimitive('sphere', {
    name: 'Esfera metálica',
    color: 0xf59e0b,
    hasPbr: true,
    roughness: 0.14,
    metalness: 0.92,
    position: [-2.4, 0.95, 0.6],
    select: false,
  });

  addPrimitive('box', {
    name: 'Cubo con textura',
    color: 0xffffff,
    textured: true,
    shininess: 20,
    position: [2.4, 0.75, -0.5],
    select: false,
  });

  // Incluir las luces iniciales de escena en la lista (Outliner) para poder ocultarlas, renombrarlas o editarlas
  if (lighting.dirLight && !sceneStore.userObjects.includes(lighting.dirLight)) {
    sceneStore.userObjects.push(lighting.dirLight);
  }
  if (lighting.pointLight && !sceneStore.userObjects.includes(lighting.pointLight)) {
    sceneStore.userObjects.push(lighting.pointLight);
  }

  selectObject(box);
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

export function buildExportTarget() {
  const scope = dom.exportScope?.value;
  if (scope === 'selected') {
    if (!sceneStore.selected) {
      setStatus('Selecciona un objeto para exportarlo.', true);
      return null;
    }
    return { target: sceneStore.selected, baseName: (sceneStore.selected.name || 'modelo').replace(/\s+/g, '_') };
  }
  const exportables = viewport.scene.getExportables({ recursive: false });
  if (!sceneStore.userObjects.length || !exportables.length) {
    setStatus('No hay objetos exportables en la escena.', true);
    return null;
  }
  return { target: viewport.scene, baseName: 'escena_made3d' };
}

export async function handleModelFiles(fileList) {
  let files = Array.from(fileList || []);
  if (!files.length) return;

  const zipFiles = files.filter((f) => /\.zip$/i.test(f.name));
  if (zipFiles.length) {
    setStatus(`Descomprimiendo ${zipFiles[0].name}...`);
    try {
      const { ZipLoader } = await loadZipLoader();
      const zipLoader = new ZipLoader();
      const nonZip = files.filter((f) => !/\.zip$/i.test(f.name));
      for (const zf of zipFiles) {
        const extracted = await zipLoader.loadFile(zf);
        nonZip.push(...extracted);
      }
      files = nonZip;
    } catch (err) {
      setStatus(`Error al descomprimir ZIP: ${err.message}`, true);
      return;
    }
  }

  const mainModel =
    files.find((f) => /\.(glb|gltf)$/i.test(f.name)) ||
    files.find((f) => /\.obj$/i.test(f.name)) ||
    null;
  const ktx2File = !mainModel ? files.find((f) => /\.ktx2$/i.test(f.name)) : null;

  if (!mainModel && ktx2File) {
    setStatus(`Transcodificando textura KTX2: ${ktx2File.name}...`);
    try {
      if (!viewport.ktx2Loader) {
        const { KTX2Loader } = await loadKTX2Loader();
        viewport.ktx2Loader = new KTX2Loader().detectSupport(viewport.renderer);
      }
      const tex = await viewport.ktx2Loader.loadFile(ktx2File, { colorSpace: 'srgb' });
      const mat = sceneStore.selected?.getPrimaryMaterial?.() || null;
      const dims = `${tex.width || 0}x${tex.height || 0}`;
      const fmtTag = tex.compressed ? 'comprimida GPU' : 'RGBA32';
      if (mat) {
        mat.map = tex;
        if (mat.color) mat.color.set(0xffffff);
        syncSelectedUI();
        setStatus(`Textura KTX2 aplicada a ${sceneStore.selected.name || 'selección'}: ${ktx2File.name} (${dims}, ${fmtTag})`);
      } else {
        const mesh = addPrimitive('box', {
          name: ktx2File.name.replace(/\.ktx2$/i, '') || 'Cubo KTX2',
          color: 0xffffff,
          shininess: 24,
          recordHistory: true,
        });
        mesh.material.map = tex;
        syncSelectedUI();
        focusOnObject(mesh);
        setStatus(`Cubo creado con textura KTX2: ${ktx2File.name} (${dims}, ${fmtTag})`);
      }
    } catch (err) {
      setStatus(`Error al cargar KTX2: ${err.message}`, true);
    }
    return;
  }

  if (!mainModel) {
    setStatus('Selecciona un archivo .glb, .gltf, .obj, .zip o .ktx2.', true);
    return;
  }

  const extras = files.filter((f) => f !== mainModel);
  setStatus(`Cargando ${mainModel.name}...`);

  try {
    let root = null;
    let clips = [];

    if (/\.obj$/i.test(mainModel.name)) {
      const { OBJLoader } = await loadOBJLoader();
      const loader = new OBJLoader();
      root = await loader.loadFile(mainModel, extras);
    } else {
      const { GLTFLoader } = await loadGLTFLoader();
      const loader = new GLTFLoader({
        ktx2Loader: viewport.ktx2Loader,
        dracoLoader: viewport.dracoLoader,
        renderer: viewport.renderer,
      });
      const gltf = await loader.loadFile(mainModel, extras);
      if (loader.ktx2Loader && !viewport.ktx2Loader) viewport.ktx2Loader = loader.ktx2Loader;
      if (loader.dracoLoader && !viewport.dracoLoader) viewport.dracoLoader = loader.dracoLoader;
      root = gltf.scene;
      clips = gltf.animations || [];
    }

    if (!root) throw new Error('El archivo no contiene geometría.');

    autoScaleObject(root, { targetSize: 2.8, centerXZ: true, alignBottom: true });
    root.traverse((node) => {
      if (node.isMesh) {
        node.castShadow = true;
        node.receiveShadow = true;
      }
    });

    const beforeSceneMeta = history.captureSceneMeta();
    const { cmd } = registerUserObject(root, mainModel.name, true);
    selectObject(root);
    focusOnObject(root);

    if (clips.length) {
      const { AnimationMixer } = await loadAnimation();
      sceneStore.mixer = new AnimationMixer(root);
      sceneStore.animations = clips;
      viewport.picker.setMixer(sceneStore.mixer);
      if (dom.animSelect) dom.animSelect.innerHTML = '';
      clips.forEach((clip, idx) => {
        const opt = document.createElement('option');
        opt.value = String(idx);
        opt.textContent = clip.name || `Clip ${idx + 1}`;
        dom.animSelect?.appendChild(opt);
      });
      playAnimationClip(0);
      if (dom.animGroup) dom.animGroup.hidden = false;
    } else {
      sceneStore.mixer = null;
      sceneStore.animations = [];
      sceneStore.activeAction = null;
      sceneStore.activeClipIndex = 0;
      if (viewport.picker) viewport.picker.setMixer(null);
      if (dom.animSelect) dom.animSelect.innerHTML = '';
      if (dom.animGroup) dom.animGroup.hidden = true;
    }

    if (cmd) {
      cmd.beforeSceneMeta = beforeSceneMeta;
      cmd.afterSceneMeta = history.captureSceneMeta();
    }

    setStatus(`Modelo cargado: ${mainModel.name}${clips.length ? ` (${clips.length} animaciones)` : ''}`);
  } catch (err) {
    setStatus(`Error al cargar: ${err.message}`, true);
  }
}
