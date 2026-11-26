import test from 'node:test';
import assert from 'node:assert/strict';
import * as MadeCore from '../made3d.module.js';
import {
  Object3D,
  Scene,
  PerspectiveCamera,
  BoxGeometry,
  Geometry,
  StandardMaterial,
  Mesh,
  Raycaster,
  Picker,
  Vec3,
  Quat,
  AVAILABLE_MODULES,
  getLoadedModules,
  loadModule,
  loadModules,
  loadGLTFLoader,
  loadGLTFExporter,
  loadModeling,
  loadAnimation,
  loadRigging,
} from '../made3d.module.js';
import { InstancedMesh } from '../src/objects/InstancedMesh.js';
import { ChunkedInstances } from '../src/objects/ChunkedInstances.js';
import { cloneSkinned } from '../src/modules/rigging.js';
import { ensureEditableBase, canIncrementSubsurf } from '../src/modules/modeling.js';
import { CameraHelper, drawCamerasOverlay } from '../src/modules/helpers.js';
import { GizmoBase } from '../src/modules/gizmo.js';
import {
  isCssLandscape90,
  getLogicalViewportSize,
  clientToViewportPoint,
  clientToLocalPointFromRect,
  isMobilePhoneDevice,
} from '../src/core/viewportCoords.js';

test('made3d.module.js mantiene núcleo ligero y carga submódulos pesados bajo demanda con import()', async () => {
  // 1. El punto de entrada principal no debe re-exportar clases pesadas síncronamente
  assert.equal('GLTFLoader' in MadeCore, false);
  assert.equal('GLTFExporter' in MadeCore, false);
  assert.equal('EditableMesh' in MadeCore, false);
  assert.equal('Sculptor' in MadeCore, false);
  assert.equal('VideoRecorder' in MadeCore, false);
  assert.equal('AnimationMixer' in MadeCore, false);
  assert.equal('TextGeometry' in MadeCore, false);
  assert.equal('createProceduralEnvironment' in MadeCore, false);

  // 2. El núcleo sí está presente y sin módulos pesados cacheados aún
  assert.equal(typeof Scene, 'function');
  assert.equal(typeof PerspectiveCamera, 'function');
  assert.equal(typeof Mesh, 'function');
  assert.deepEqual(getLoadedModules(), []);
  assert.ok(AVAILABLE_MODULES.includes('gltfLoader'));
  assert.ok(AVAILABLE_MODULES.includes('modeling'));
  assert.ok(AVAILABLE_MODULES.includes('animation'));

  assert.throws(() => loadModule('noExisteModulo'), /submódulo desconocido/i);

  // 3. Carga perezosa bajo demanda con caché de promesas
  const p1 = loadGLTFLoader();
  const p2 = loadGLTFLoader();
  assert.equal(p1, p2);

  const [{ GLTFLoader }, { GLTFExporter }, bundled] = await Promise.all([
    p1,
    loadGLTFExporter(),
    loadModules(['modeling', 'animation']),
  ]);

  assert.equal(typeof GLTFLoader, 'function');
  assert.equal(typeof GLTFExporter, 'function');
  assert.equal(typeof bundled.EditableMesh, 'function');
  assert.equal(typeof bundled.AnimationMixer, 'function');

  const loaded = getLoadedModules();
  assert.ok(loaded.includes('gltfLoader'));
  assert.ok(loaded.includes('gltfExporter'));
  assert.ok(loaded.includes('modeling'));
  assert.ok(loaded.includes('animation'));
  assert.equal(loaded.includes('video'), false);
  assert.equal(loaded.includes('sculpt'), false);
});

test('AnimationClip y AnimationMixer interpolan posición, rotación, pesos morph y modo once/repeat', async () => {
  const {
    AnimationClip,
    AnimationMixer,
    VectorKeyframeTrack,
    QuaternionKeyframeTrack,
    NumberArrayKeyframeTrack,
  } = await loadAnimation();

  const scene = new Scene();
  const node = new Mesh(new BoxGeometry(1, 1, 1), new StandardMaterial({ color: 0xffffff }));
  node.name = 'Actor';
  node.morphTargetInfluences = [0, 0];
  scene.add(node);

  const qStart = new Quat();
  const qEnd = new Quat().setFromAxisAngle(new Vec3(0, 1, 0), Math.PI * 0.5);

  const clip = new AnimationClip('Mover');
  clip.addTrack(new VectorKeyframeTrack('Actor.position', [0, 1], [0, 0, 0, 10, 0, 0]));
  clip.addTrack(
    new QuaternionKeyframeTrack(
      'Actor.quaternion',
      [0, 1],
      [qStart.x, qStart.y, qStart.z, qStart.w, qEnd.x, qEnd.y, qEnd.z, qEnd.w]
    )
  );
  clip.addTrack(new NumberArrayKeyframeTrack('Actor.weights', [0, 1], [0, 1, 1, 0], 2));

  const mixer = new AnimationMixer(scene);
  const action = mixer.clipAction(clip, 'once');
  action.play();

  mixer.update(0.5);
  assert.ok(Math.abs(node.position.x - 5) < 1e-4);
  assert.ok(Math.abs(node.morphTargetInfluences[0] - 0.5) < 1e-4);
  assert.ok(Math.abs(node.morphTargetInfluences[1] - 0.5) < 1e-4);

  const eulerHalf = new Quat().setFromAxisAngle(new Vec3(0, 1, 0), Math.PI * 0.25);
  assert.ok(Math.abs(Math.abs(node.quaternion.dot(eulerHalf)) - 1) < 1e-4);

  // Modo 'once': al superar la duración se detiene en t = duration
  mixer.update(1.0);
  assert.equal(action.playing, false);
  assert.ok(Math.abs(node.position.x - 10) < 1e-4);
  assert.ok(Math.abs(node.morphTargetInfluences[0] - 1) < 1e-4);
  assert.equal(mixer.findTracks(node).length, 3);
});

test('Raycaster y Picker ordenan impactos por distancia y enlazan pistas de animación', async () => {
  const { AnimationClip, AnimationMixer, VectorKeyframeTrack } = await loadAnimation();

  const scene = new Scene();
  const cam = new PerspectiveCamera(50, 1, 0.1, 100);
  cam.position.set(0, 0, 10);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld();
  cam.updateProjection();

  const nearBox = new Mesh(new BoxGeometry(1, 1, 1), new StandardMaterial({ color: 0x4f86f7 }));
  nearBox.name = 'Cerca';
  nearBox.position.set(0, 0, 4);

  const farBox = new Mesh(new BoxGeometry(2, 2, 2), new StandardMaterial({ color: 0xf59e0b }));
  farBox.name = 'Lejos';
  farBox.position.set(0, 0, -2);

  scene.add(farBox, nearBox);

  const ray = new Raycaster().setFromCamera({ x: 0, y: 0 }, cam);
  const hits = ray.intersectObject(scene, true);
  assert.ok(hits.length >= 2);
  assert.equal(hits[0].object, nearBox);
  assert.equal(hits[hits.length - 1].object, farBox);
  for (let i = 1; i < hits.length; i++) {
    assert.ok(hits[i - 1].distance <= hits[i].distance);
  }
  assert.ok(hits[0].distance < hits[hits.length - 1].distance);
  assert.ok(Math.abs(hits[0].point.z - 4.5) < 1e-3);

  const missHits = new Raycaster().setFromCamera({ x: 0.9, y: 0.9 }, cam).intersectObject(scene, true);
  assert.equal(missHits.length, 0);

  const clip = new AnimationClip('Slide');
  clip.addTrack(new VectorKeyframeTrack('Cerca.position', [0, 1], [0, 0, 4, 0, 1, 4]));
  const mixer = new AnimationMixer(scene);
  mixer.clipAction(clip).play();
  mixer.update(0.25);

  const picker = new Picker(null);
  picker.setSize(800, 600);
  picker.setMixer(mixer);
  const picked = picker.pickNdc(0, 0, cam, scene);
  assert.ok(picked);
  assert.equal(picked.type, 'mesh');
  assert.equal(picked.object, nearBox);
  assert.ok(picked.animation);
  assert.equal(picked.animation.clip.name, 'Slide');
});

test('Skeleton + SkinnedMesh deforman vértices y realizan ida y vuelta GLB con skins y animaciones', async () => {
  const [{ Bone, Skeleton, SkinnedMesh }, { AnimationClip, QuaternionKeyframeTrack }, { GLTFExporter }, { GLTFLoader }] =
    await Promise.all([loadRigging(), loadAnimation(), loadGLTFExporter(), loadGLTFLoader()]);

  const geo = new Geometry();
  geo.setAttribute('position', new Float32Array([
    0, 0, 0,
    0, 2, 0,
    1, 2, 0,
  ]), 3);
  geo.setAttribute('normal', new Float32Array([
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
  ]), 3);
  geo.setAttribute('skinIndex', new Float32Array([
    0, 0, 0, 0,
    1, 0, 0, 0,
    1, 0, 0, 0,
  ]), 4);
  geo.setAttribute('skinWeight', new Float32Array([
    1, 0, 0, 0,
    1, 0, 0, 0,
    1, 0, 0, 0,
  ]), 4);
  geo.setIndex([0, 1, 2]);

  const rootBone = new Bone();
  rootBone.name = 'RootBone';
  const tipBone = new Bone();
  tipBone.name = 'TipBone';
  tipBone.position.set(0, 1, 0);
  rootBone.add(tipBone);

  const mesh = new SkinnedMesh(geo, new StandardMaterial({ color: 0x38bdf8 }));
  mesh.name = 'RigMesh';
  mesh.add(rootBone);

  const skeleton = new Skeleton([rootBone, tipBone]);
  mesh.bind(skeleton);

  // Rotar TipBone 90° alrededor de +Z mueve el vértice (0, 2, 0) respecto a pivote (0, 1, 0) hacia (-1, 1, 0)
  tipBone.quaternion.setFromAxisAngle(new Vec3(0, 0, 1), Math.PI * 0.5);
  mesh.updateWorldMatrix(true, true);
  skeleton.update();

  const deformed = new Float32Array(9);
  mesh.computeSkinnedWorld(deformed, 3);
  assert.ok(Math.abs(deformed[3] - (-1)) < 1e-4);
  assert.ok(Math.abs(deformed[4] - 1) < 1e-4);

  // Restablecer pose neutra antes de exportar a GLB con animación
  tipBone.quaternion.set(0, 0, 0, 1);
  mesh.updateWorldMatrix(true, true);
  skeleton.update();

  const q0 = new Quat();
  const q1 = new Quat().setFromAxisAngle(new Vec3(0, 0, 1), Math.PI * 0.5);
  const clip = new AnimationClip('Bend');
  clip.addTrack(
    new QuaternionKeyframeTrack('TipBone.quaternion', [0, 1], [q0.x, q0.y, q0.z, q0.w, q1.x, q1.y, q1.z, q1.w])
  );

  const scene = new Scene();
  scene.add(mesh);

  const glb = await new GLTFExporter().parse(scene, { binary: true, animations: [clip] });
  const loaded = await new GLTFLoader().parse(glb);

  let importedSkinned = null;
  loaded.scene.traverse((n) => {
    if (n && n.isSkinnedMesh) importedSkinned = n;
  });

  assert.ok(importedSkinned, 'GLTFLoader debe reconstruir el SkinnedMesh');
  assert.ok(importedSkinned.skeleton && importedSkinned.skeleton.bones.length === 2);
  assert.equal(loaded.animations.length, 1);
  assert.equal(loaded.animations[0].name, 'Bend');
});

test('SubdivisionSurface protege la UI y evita reconstruir quads en mallas densas esculpidas', async () => {
  const { EditableMesh } = await loadModeling();

  // Crear geometría densa (> 27,000 triángulos simulando esfera esculpida; 28000*3 > MAX_SUBSURF_FACES)
  const triCount = 28000;
  const vertCount = triCount * 3;
  const pos = new Float32Array(vertCount * 3);
  const idx = new Uint32Array(vertCount);
  for (let t = 0; t < triCount; t++) {
    const b = t * 9;
    pos[b + 0] = t; pos[b + 1] = 0; pos[b + 2] = 0;
    pos[b + 3] = t + 0.5; pos[b + 4] = 0; pos[b + 5] = 0;
    pos[b + 6] = t; pos[b + 7] = 0.5; pos[b + 8] = 0;
    idx[t * 3 + 0] = t * 3 + 0;
    idx[t * 3 + 1] = t * 3 + 1;
    idx[t * 3 + 2] = t * 3 + 2;
  }
  const denseGeo = new Geometry();
  denseGeo.setAttribute('position', pos, 3);
  denseGeo.setIndex(idx);
  denseGeo._modifiedBySculpt = true;

  const mesh = new Mesh(denseGeo, new StandardMaterial({ color: 0xffffff }));
  // 28000*3 = 84000 > MAX_SUBSURF_FACES: canIncrementSubsurf debe rechazar al instante sin construir EditableMesh
  assert.equal(canIncrementSubsurf(mesh), false);
  assert.equal(mesh._subsurf, undefined);

  // ensureEditableBase en malla densa esculpida usa modo rápido (reconstructQuads: false -> conserva triángulos)
  const mod = ensureEditableBase(mesh);
  assert.ok(mod && mod.baseMesh instanceof EditableMesh);
  assert.equal(mod.baseMesh.faces.length, triCount);
  assert.equal(mod.baseMesh.faces[0].length, 3);
});

test('cloneSkinned conserva InstancedMesh y SkinnedMesh.raycast invalida caché con cambios de geometría/bindMatrix', async () => {
  const { Bone, Skeleton, SkinnedMesh } = await loadRigging();

  // 1. cloneSkinned con InstancedMesh hijo
  const root = new Mesh(new BoxGeometry(1, 1, 1), new StandardMaterial({ color: 0xffffff }));
  const inst = new InstancedMesh(new BoxGeometry(0.5, 0.5, 0.5), new StandardMaterial({ color: 0xff0000 }), 4);
  inst.count = 2;
  inst.setTransformAt(0, new Vec3(2, 0, 0), new Quat(), new Vec3(1, 1, 1));
  inst.setTransformAt(1, new Vec3(-2, 0, 0), new Quat(), new Vec3(1, 1, 1));
  inst.commit();
  root.add(inst);

  const clonedRoot = cloneSkinned(root);
  const clonedInst = clonedRoot.children[0];
  assert.equal(clonedInst.isInstancedMesh, true);
  assert.equal(clonedInst.count, 2);
  assert.equal(clonedInst.instanceMatrix.array[12], 2);
  assert.equal(clonedInst.instanceMatrix.array[28], -2);

  // 2. SkinnedMesh.raycast actualiza cache tras cambiar bindMatrix o versión de posición
  const tri = new Geometry();
  tri.setAttribute('position', new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]), 3);
  tri.setAttribute('normal', new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3);
  tri.setAttribute('skinIndex', new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), 4);
  tri.setAttribute('skinWeight', new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), 4);
  const b = new Bone();
  const sk = new Skeleton([b]);
  const sm = new SkinnedMesh(tri, new StandardMaterial({ color: 0xffffff }));
  sm.add(b);
  sm.bind(sk);
  sm.updateWorldMatrix(true, true);
  sk.update();

  const rc = new Raycaster();
  rc.ray.origin.set(0, 0, 5);
  rc.ray.direction.set(0, 0, -1);
  const hits1 = [];
  sm.raycast(rc, hits1);
  assert.equal(hits1.length, 1);

  // Desplazar bindMatrix lejos sin tocar sk.version -> raycast debe recalcular y fallar el impacto en (0,0)
  sm.bindMatrix.compose(new Vec3(10, 0, 0), new Quat(), new Vec3(1, 1, 1));
  const hits2 = [];
  sm.raycast(rc, hits2);
  assert.equal(hits2.length, 0);

  // computeSkinnedWorldNormals
  sm.bindMatrix.identity();
  b.quaternion.setFromAxisAngle(new Vec3(0, 1, 0), Math.PI * 0.5);
  sm.updateWorldMatrix(true, true);
  sk.update();
  const wn = new Float32Array(9);
  sm.computeSkinnedWorldNormals(wn, 3);
  assert.ok(Math.abs(wn[0] - 1) < 1e-4 && Math.abs(wn[2]) < 1e-4);
});

test('VectorKeyframeTrack soporta easeIn, easeOut, smooth y step', async () => {
  const { VectorKeyframeTrack } = await loadAnimation();

  const easeIn = new VectorKeyframeTrack('Box.position', [0, 1], [0, 0, 0, 10, 0, 0], 'easeIn');
  const easeOut = new VectorKeyframeTrack('Box.position', [0, 1], [0, 0, 0, 10, 0, 0], 'easeOut');
  const smooth = new VectorKeyframeTrack('Box.position', [0, 1], [0, 0, 0, 10, 0, 0], 'smooth');
  const step = new VectorKeyframeTrack('Box.position', [0, 1], [0, 0, 0, 10, 0, 0], 'step');

  const outIn = easeIn.evaluate(0.5, new Vec3());
  const outOut = easeOut.evaluate(0.5, new Vec3());
  const outSmooth = smooth.evaluate(0.5, new Vec3());
  const outStep = step.evaluate(0.5, new Vec3());

  assert.ok(outIn.x < 3 && outIn.x > 0, `easeIn(0.5) debe ser menor a 3, fue ${outIn.x}`);
  assert.ok(outOut.x > 7 && outOut.x < 10, `easeOut(0.5) debe ser mayor a 7, fue ${outOut.x}`);
  assert.ok(Math.abs(outSmooth.x - 5) < 1e-5);
  assert.equal(outStep.x, 0);
});

test('CameraHelper solo dibuja líneas wireframe y Picker selecciona cámaras en escena', () => {
  const scene = new Scene();
  const viewCam = new PerspectiveCamera(50, 1, 0.1, 100);
  viewCam.position.set(0, 0, 8);
  viewCam.lookAt(0, 0, 0);
  viewCam.updateMatrixWorld();
  viewCam.updateProjection();

  const sceneCam = new PerspectiveCamera(45, 16 / 9, 0.2, 50);
  sceneCam.name = 'Cámara Principal';
  sceneCam.position.set(0, 0, 0);
  const helper = new CameraHelper(sceneCam);
  sceneCam.add(helper);
  scene.add(viewCam, sceneCam);
  scene.updateMatrixWorld(true);

  assert.ok(helper.linesMesh, 'CameraHelper debe tener linesMesh');
  assert.equal(helper.bodyMesh, undefined, 'CameraHelper no debe tener cuerpo 3D sólido');
  assert.equal(helper.children.length, 1);

  const picker = new Picker(null);
  picker.setSize(800, 600);
  const hit = picker.pickNdc(0, 0, viewCam, scene);
  assert.ok(hit, 'Picker debe detectar la cámara en el centro');
  assert.equal(hit.type, 'camera');
  assert.equal(hit.object, sceneCam);

  // drawCamerasOverlay debe dibujar un punto azul seleccionable en sceneCam (y omitir viewCam)
  const fills = [];
  const arcs = [];
  const mockCtx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    save() {},
    restore() {},
    beginPath() {},
    arc(x, y, r) { arcs.push({ x, y, r }); },
    fill() { fills.push(this.fillStyle); },
    stroke() {},
  };
  drawCamerasOverlay(mockCtx, viewCam, scene, 800, 600, { selected: null });
  assert.equal(fills.length, 1, 'Solo debe dibujar un punto azul para la cámara externa');
  assert.equal(fills[0], '#3b82f6', 'El punto de la cámara debe ser azul');
  assert.ok(Math.abs(arcs[0].x - 400) < 1 && Math.abs(arcs[0].y - 300) < 1);
});

test('AnimationClip inserta keyframes por herramienta, mueve sin comer otros, fusiona, copia/pega y evalúa', async () => {
  const { AnimationClip } = await loadAnimation();
  const obj = new Object3D();
  obj.name = 'CuboAnim';
  const clip = new AnimationClip('ClipPrueba', 3.0);

  // 1. Solo posición en t=0 y t=1 (no debe crear rotación ni escala)
  obj.position.set(0, 0, 0);
  clip.setObjectKeyframe(obj, 0, ['position']);
  obj.position.set(4, 0, 0);
  clip.setObjectKeyframe(obj, 1.0, ['position']);
  obj.position.set(8, 0, 0);
  clip.setObjectKeyframe(obj, 2.0, ['position']);

  assert.equal(clip.tracks.length, 1);
  assert.equal(clip.tracks[0].property, 'position');
  assert.equal(clip.hasKeyframeAt(1.0, { properties: ['position'] }), true);
  assert.equal(clip.hasKeyframeAt(1.0, { properties: ['quaternion'] }), false);

  // Rotación separada en t=0.5 y resumen unificado
  obj.rotation.set(0, Math.PI * 0.5, 0);
  clip.setObjectKeyframe(obj, 0.5, ['quaternion']);
  assert.equal(clip.tracks.length, 2);
  assert.deepEqual(Array.from(clip.getKeyframeTimes('quaternion')), [0.5]);
  assert.deepEqual(
    Array.from(clip.getKeyframeTimes()),
    [0, 0.5, 1, 2]
  );

  // 2. Arrastrar keyframe de position en 0.0 -> 1.0 (cruzando) -> 1.5 NO debe comerse el de 1.0
  const beforeDrag = clip.captureSnapshot();
  clip.previewMoveKeyframe(beforeDrag, 0, 1.0, { properties: ['position'] });
  clip.previewMoveKeyframe(beforeDrag, 0, 1.5, { properties: ['position'] });
  clip.commitMoveKeyframe(beforeDrag, 0, 1.5, { properties: ['position'] });
  assert.deepEqual(Array.from(clip.getKeyframeTimes('position')), [1, 1.5, 2]);

  // 3. Soltar intencionalmente en la misma posición (1.0 -> 2.0) los fusiona limpiamente
  const beforeMerge = clip.captureSnapshot();
  clip.commitMoveKeyframe(beforeMerge, 1.0, 2.0, { properties: ['position'], mergeEps: 0.025 });
  assert.deepEqual(Array.from(clip.getKeyframeTimes('position')), [1.5, 2]);

  // 4. Copiar keyframe en 1.5 y pegar en 2.5
  const copied = clip.extractKeyframeData(1.5, { properties: ['position'] });
  assert.ok(copied && copied.properties.position);
  assert.deepEqual(copied.properties.position.values, [0, 0, 0]);

  const pasted = clip.applyKeyframeData(obj, copied, 2.5);
  assert.deepEqual(pasted, ['position']);
  assert.deepEqual(Array.from(clip.getKeyframeTimes('position')), [1.5, 2, 2.5]);

  // 5. Evaluar el clip mueve el objeto correctamente
  clip.evaluateAt(2.0, obj);
  assert.ok(Math.abs(obj.position.x - 4) < 1e-4);
  clip.evaluateAt(2.5, obj);
  assert.ok(Math.abs(obj.position.x - 0) < 1e-4);

  // 6. Detección de objeto exportable y cambio parcial
  assert.equal(clip.targetsObject(obj, obj), true);
  const changed = AnimationClip.detectChangedProperties(
    { p: new Vec3(0, 0, 0), q: new Quat(), s: new Vec3(1, 1, 1) },
    { p: new Vec3(2, 0, 0), q: new Quat(), s: new Vec3(1, 1, 1) }
  );
  assert.deepEqual(changed, ['position']);
});

test('HistoryManager nativo de la librería deshace y rehace transform + auto-keyframe, escena, esculpido y modelado sin depender del editor', async () => {
  const { HistoryManager, loadSculpt } = MadeCore;
  const { AnimationClip } = await loadAnimation();
  await loadSculpt();
  const { ensureEditableBase: ensureBase, snapshotMeshModelingState } = await loadModeling();

  const scene = new Scene();
  const obj = new Mesh(new BoxGeometry(1, 1, 1), new StandardMaterial({ color: 0xffffff }));
  obj.name = 'CuboUnPaso';
  obj.position.set(0, 0, 0);
  scene.add(obj);

  const clip = new AnimationClip('Movimiento', 3.0);
  let activeClipRef = null;
  const events = [];

  const hm = new HistoryManager({ scene });
  hm.on('change', (e) => events.push(e.action));
  hm.setHooks({
    restoreAnimState: (snap) => {
      activeClipRef = snap.hasClip ? clip : null;
    },
  });

  // 1. runGrouped agrupa transform + animState + animClip (usando restoreSnapshot nativo del clip)
  const beforeLocal = HistoryManager.snapshotTransform(obj);
  obj.position.set(6, 0, 0);
  const afterLocal = HistoryManager.snapshotTransform(obj);

  hm.runGrouped('Transformar', () => {
    hm.push({ type: 'transform', os: [obj], before: [beforeLocal], after: [afterLocal] });
    const beforeState = { hasClip: Boolean(activeClipRef) };
    activeClipRef = clip;
    const beforeClip = clip.captureSnapshot();
    clip.setObjectKeyframe(obj, 1.0, ['position']);
    const afterClip = clip.captureSnapshot();
    hm.push({ type: 'animState', before: beforeState, after: { hasClip: true } });
    hm.push({ type: 'animClip', clip, owner: obj, before: beforeClip, after: afterClip });
  });

  assert.equal(hm.undoLength, 1, 'Transformar + auto-keyframe debe ocupar 1 sola entrada en el historial');
  assert.equal(clip.hasKeyframeAt(1.0), true);
  assert.equal(activeClipRef, clip);
  assert.equal(obj.position.x, 6);

  hm.undo();
  assert.equal(hm.undoLength, 0);
  assert.equal(hm.redoLength, 1);
  assert.equal(clip.hasKeyframeAt(1.0), false);
  assert.equal(activeClipRef, null);
  assert.equal(obj.position.x, 0);

  hm.redo();
  assert.equal(hm.undoLength, 1);
  assert.equal(hm.redoLength, 0);
  assert.equal(clip.hasKeyframeAt(1.0), true);
  assert.equal(activeClipRef, clip);
  assert.equal(obj.position.x, 6);

  // 2. Comando de eliminación nativo (delete)
  const rec = hm.buildRemovalRecord(obj);
  hm.applyRemoval(rec);
  hm.push({ type: 'delete', removals: [rec] });
  assert.equal(scene.children.includes(obj), false);
  hm.undo();
  assert.equal(scene.children.includes(obj), true);
  hm.redo();
  assert.equal(scene.children.includes(obj), false);
  hm.undo();
  assert.equal(scene.children.includes(obj), true);

  // 3. Trazo de esculpido nativo auto-registrado por src/modules/sculpt.js
  const posArr = obj.geometry.attributes.position.array;
  const beforeY = posArr[1];
  const afterY = beforeY + 2.5;
  posArr[1] = afterY;
  hm.push({
    type: 'sculpt',
    mesh: obj,
    geo: obj.geometry,
    diff: {
      indices: new Uint32Array([1]),
      before: new Float32Array([beforeY]),
      after: new Float32Array([afterY]),
    },
  });
  assert.ok(Math.abs(obj.geometry.attributes.position.array[1] - afterY) < 1e-5);
  hm.undo();
  assert.ok(Math.abs(obj.geometry.attributes.position.array[1] - beforeY) < 1e-5);
  hm.redo();
  assert.ok(Math.abs(obj.geometry.attributes.position.array[1] - afterY) < 1e-5);

  // 4. Edición poligonal nativa auto-registrada por src/modules/modeling.js
  ensureBase(obj);
  const beforeModelState = snapshotMeshModelingState(obj);
  obj.geometry.attributes.position.array[0] += 1.25;
  const afterModelState = snapshotMeshModelingState(obj);
  hm.push({ type: 'meshEdit', mesh: obj, beforeState: beforeModelState, afterState: afterModelState, label: 'Mover vértice' });
  hm.undo();
  assert.equal(hm.canUndo, true);
  hm.redo();

  // 5. Comando custom nativo { undo, redo } + eventos emitidos
  let customFlag = 0;
  hm.push({
    label: 'Custom',
    undo: () => { customFlag = 0; },
    redo: () => { customFlag = 42; },
  });
  customFlag = 42;
  hm.undo();
  assert.equal(customFlag, 0);
  hm.redo();
  assert.equal(customFlag, 42);
  assert.ok(events.includes('push') && events.includes('undo') && events.includes('redo'));
});

test('Regresión: Geometry.setIndex(null), HistoryManager vacío, ChunkedInstances BVH/fallback, SkinnedMesh CPU/unbound, Skeleton, morph tracks y GizmoBase cleanup', async () => {
  const { Bone, Skeleton, SkinnedMesh } = await loadRigging();
  const { AnimationClip, NumberArrayKeyframeTrack } = await loadAnimation();
  const { HistoryManager } = MadeCore;

  // 1. Geometry.setIndex(null) limpia índice sin lanzar excepción
  const boxGeo = new BoxGeometry(1, 1, 1);
  assert.ok(boxGeo.index);
  assert.equal(boxGeo.setIndex(null), boxGeo);
  assert.equal(boxGeo.index, null);

  // 2. HistoryManager no dispara onBeforeUndo/onBeforeRedo cuando la pila está vacía
  let beforeUndoCalls = 0;
  let beforeRedoCalls = 0;
  const hm = new HistoryManager();
  hm.setHooks({
    onBeforeUndo: () => { beforeUndoCalls++; },
    onBeforeRedo: () => { beforeRedoCalls++; },
  });
  assert.equal(hm.undo(), null);
  assert.equal(hm.redo(), null);
  assert.equal(beforeUndoCalls, 0);
  assert.equal(beforeRedoCalls, 0);

  // 3. ChunkedInstances sincroniza _visibleChunks al alternar entre ruta fallback y ruta BVH
  await MadeCore.loadMadeOptimizeModule();
  const chunked = new ChunkedInstances(new BoxGeometry(1, 1, 1), new StandardMaterial(), { chunkSize: 10 });
  for (let i = 0; i < 8; i++) {
    chunked.addInstance(new Vec3(i * 20, 0, 0), new Quat(), new Vec3(1, 1, 1));
  }
  chunked.build();
  chunked.updateMatrixWorld();

  const cam = new PerspectiveCamera(50, 1, 0.1, 100);
  cam.position.set(0, 0, 10);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld();
  cam.updateProjection();

  const farChunk = chunked.chunks.get(chunked._key(14, 0, 0));
  assert.ok(farChunk);

  // Ruta fallback (sin _viewProj): marca visibles todos los chunks y debe registrarlos en _visibleChunks
  chunked.onBeforeRender({}, cam);
  assert.equal(chunked._visibleChunks.length, 8);
  assert.equal(farChunk.meshes[0].visible, true);

  // Ruta BVH (con _viewProj): los chunks fuera del frustum deben ocultarse
  const viewProj = cam.projectionMatrix.clone().multiply(cam.matrixWorldInverse);
  chunked.onBeforeRender({ _viewProj: viewProj }, cam);
  assert.equal(farChunk.meshes[0].visible, false);

  // 4. SkinnedMesh sin esqueleto hace fallback a super.raycast y copy/cloneSkinned preservan _bind en CPU skinning
  const unboundGeo = new BoxGeometry(1, 1, 1);
  const unboundSkinned = new SkinnedMesh(unboundGeo, new StandardMaterial());
  unboundSkinned.updateMatrixWorld();
  const rc = new Raycaster().set(new Vec3(0, 0, 5), new Vec3(0, 0, -1));
  const unboundHits = [];
  unboundSkinned.raycast(rc, unboundHits);
  assert.ok(unboundHits.length > 0);

  const skinGeo = new Geometry();
  skinGeo.setAttribute('position', new Float32Array([0, 0, 0, 0, 2, 0, 1, 2, 0]), 3);
  skinGeo.setAttribute('normal', new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3);
  skinGeo.setAttribute('skinIndex', new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), 4);
  skinGeo.setAttribute('skinWeight', new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), 4);
  const bone = new Bone();
  const skel = new Skeleton([bone]);
  const cpuSkinned = new SkinnedMesh(skinGeo, new StandardMaterial());
  cpuSkinned.gpuSkinning = false;
  cpuSkinned.add(bone);
  cpuSkinned.bind(skel);
  bone.position.set(5, 0, 0);
  cpuSkinned.updateWorldMatrix(true, true);
  skel.update();
  cpuSkinned.updateSkinnedVertices();
  assert.equal(cpuSkinned.geometry.attributes.position.array[0], 5);

  const copiedCpu = new SkinnedMesh(cpuSkinned.geometry.clone(), cpuSkinned.material).copy(cpuSkinned, false);
  assert.equal(copiedCpu._bind[0], 0);
  const clonedRoot = cloneSkinned(cpuSkinned, { copyGeometry: true });
  assert.equal(clonedRoot._bind[0], 0);

  // 5. Skeleton.update tolera huecos en bones / boneInverses
  const sparseSkel = new Skeleton([bone, null], [skel.boneInverses[0].clone()]);
  sparseSkel.update();
  assert.equal(sparseSkel.boneMatrices[16], 1);

  // 6. AnimationClip.getOrCreateTrack/setObjectKeyframe crea NumberArrayKeyframeTrack para morphTargetInfluences/weights
  const morphMesh = new Mesh(new BoxGeometry(1, 1, 1), new StandardMaterial());
  morphMesh.name = 'CaraMorph';
  morphMesh.morphTargetInfluences = [0.25, 0.75];
  const morphClip = new AnimationClip('Morphs', 2.0);
  morphClip.setObjectKeyframe(morphMesh, 0, ['morphTargetInfluences']);
  const morphTrack = morphClip.getTrackByTarget(morphMesh, 'morphTargetInfluences');
  assert.ok(morphTrack instanceof NumberArrayKeyframeTrack);
  assert.equal(morphTrack.valueSize, 2);
  const morphSnap = morphTrack.captureSnapshot();
  morphTrack.valueSize = 99;
  morphTrack.restoreSnapshot(morphSnap);
  assert.equal(morphTrack.valueSize, 2);

  // 7. GizmoBase.dispose limpia temporizador de long-press pendiente
  const noop = () => {};
  const mockDom = { addEventListener: noop, removeEventListener: noop, getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) };
  const mockOverlay = { width: 100, height: 100, style: {}, getContext: () => ({}) };
  const gizmo = new GizmoBase(cam, mockDom, { overlay: mockOverlay });
  let timerFired = false;
  gizmo._longPressTimer = setTimeout(() => { timerFired = true; }, 10);
  gizmo.dispose();
  assert.equal(gizmo._longPressTimer, 0);
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(timerFired, false);
});

test('viewportCoords detecta teléfonos móviles y transforma punteros en modo horizontal 90°', () => {
  // 1. Detección de teléfono vs escritorio/tablet
  assert.equal(
    isMobilePhoneDevice({
      navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148' },
      window: { innerWidth: 390, innerHeight: 844, screen: { width: 390, height: 844 } },
    }),
    true
  );
  assert.equal(
    isMobilePhoneDevice({
      navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Mobile Safari/537.36' },
      window: { innerWidth: 412, innerHeight: 915, screen: { width: 412, height: 915 } },
    }),
    true
  );
  assert.equal(
    isMobilePhoneDevice({
      navigator: {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
        userAgentData: { mobile: false },
        maxTouchPoints: 0,
      },
      window: {
        innerWidth: 380,
        innerHeight: 700,
        screen: { width: 1920, height: 1080 },
        matchMedia: () => ({ matches: false }),
      },
    }),
    false
  );
  assert.equal(
    isMobilePhoneDevice({
      navigator: {
        userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
        maxTouchPoints: 5,
      },
      window: {
        innerWidth: 820,
        innerHeight: 1180,
        screen: { width: 820, height: 1180 },
        matchMedia: () => ({ matches: true }),
      },
    }),
    false
  );

  // 2. Transformación de coordenadas y tamaño lógico en rotación CSS de 90°
  const fakeWin = { innerWidth: 400, innerHeight: 800 };
  const fakeDocOff = { documentElement: { classList: { contains: () => false } } };
  const fakeDocOn = { documentElement: { classList: { contains: (c) => c === 'is-mobile-landscape-90' } } };

  assert.equal(isCssLandscape90(fakeDocOff), false);
  assert.equal(isCssLandscape90(fakeDocOn), true);
  assert.deepEqual(getLogicalViewportSize(fakeWin, fakeDocOff), { width: 400, height: 800 });
  assert.deepEqual(getLogicalViewportSize(fakeWin, fakeDocOn), { width: 800, height: 400 });

  // Con rotate(90deg) + translateX(100vw):
  // Esquina superior derecha de pantalla (clientX=400, clientY=0) -> origen local (0, 0)
  assert.deepEqual(clientToViewportPoint({ clientX: 400, clientY: 0 }, fakeWin, fakeDocOn), { x: 0, y: 0 });
  // Esquina inferior izquierda de pantalla (clientX=0, clientY=800) -> esquina opuesta local (800, 400)
  assert.deepEqual(clientToViewportPoint({ clientX: 0, clientY: 800 }, fakeWin, fakeDocOn), { x: 800, y: 400 });

  // Rectángulo del visor en pantalla vertical (42px de barra superior en lado derecho de pantalla):
  // En local sin rotar: topbar = 42px -> viewport tiene x0=42..800 (W=758), y0=0..400 (H=400).
  // En pantalla rotada: left=0, right=400 (width=400), top=42, bottom=800 (height=758).
  const rotRect = { left: 0, right: 400, top: 42, bottom: 800, width: 400, height: 758 };
  assert.deepEqual(clientToLocalPointFromRect(rotRect, { clientX: 400, clientY: 42 }, 758, 400, fakeDocOn), [0, 0]);
  assert.deepEqual(clientToLocalPointFromRect(rotRect, { clientX: 0, clientY: 800 }, 758, 400, fakeDocOn), [758, 400]);
  assert.deepEqual(clientToLocalPointFromRect(rotRect, { clientX: 200, clientY: 421 }, 758, 400, fakeDocOn), [379, 200]);
});

test('Librería rigging: Rigger, pesos automáticos, pincel/borrador, espejo, imán y fijado con undo/redo', async () => {
  const {
    Bone,
    Skeleton,
    SkeletonHelper,
    SkinnedMesh,
    Rigger,
    computeAutoSkinWeights,
    applyWeightBrushAt,
    bindMeshesToSkeleton,
  } = await loadRigging();

  const geo = new Geometry();
  // Dos triángulos simples en Y=0 y Y=2
  geo.setAttribute('position', new Float32Array([
    -0.2, 0, 0,
     0.2, 0, 0,
     0.0, 1, 0,
    -0.2, 2, 0,
     0.2, 2, 0,
  ]), 3);
  geo.setAttribute('normal', new Float32Array([
    0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
  ]), 3);
  geo.setIndex([0, 1, 2, 2, 3, 4]);

  const bRoot = new Bone();
  bRoot.name = 'Base';
  bRoot.length = 1.0;

  const bTop = new Bone();
  bTop.name = 'Punta';
  bTop.position.set(0, 1, 0);
  bTop.length = 1.0;
  bRoot.add(bTop);

  const skinned = new SkinnedMesh(geo, new StandardMaterial({ color: 0xffffff, vertexColors: true }));
  skinned.position.set(2, 0, 0);
  skinned.add(bRoot);
  skinned.updateWorldMatrix(true, true);

  const bones = [bRoot, bTop];
  const { skinIndex, skinWeight } = computeAutoSkinWeights(geo, skinned.matrixWorld, bones);
  geo.setAttribute('skinIndex', skinIndex, 4);
  geo.setAttribute('skinWeight', skinWeight, 4);
  skinned.bind(new Skeleton(bones), skinned.matrixWorld.clone());

  // Cada vértice debe sumar ~1.0 en sus pesos
  for (let v = 0; v < 5; v++) {
    const sum = skinWeight[v * 4] + skinWeight[v * 4 + 1] + skinWeight[v * 4 + 2] + skinWeight[v * 4 + 3];
    assert.ok(Math.abs(sum - 1) < 1e-4, `peso vértice ${v} = ${sum}`);
  }
  // Vértice inferior (y=0) debe estar dominado por bRoot (índice 0); vértice superior (y=2) por bTop (índice 1)
  assert.equal(Math.round(skinIndex[0]), 0);
  assert.equal(Math.round(skinIndex[3 * 4]), 1);

  // Pintar influencia de bTop cerca del vértice inferior (2, 0, 0)
  const changedPaint = applyWeightBrushAt(skinned, new Vec3(2, 0, 0), bTop, 0.6, 0.85, false);
  assert.equal(changedPaint, true);
  assert.ok(geo.attributes.color, 'heatmap color attribute creado');

  // Borrar pesos de bTop cerca de (2, 2, 0)
  const changedErase = applyWeightBrushAt(skinned, new Vec3(2, 2, 0), bTop, 0.6, 0.9, true);
  assert.equal(changedErase, true);

  // Verificar deformación tras rotar bTop 90°
  bTop.quaternion.setFromAxisAngle(new Vec3(0, 0, 1), Math.PI * 0.5);
  skinned.updateWorldMatrix(true, true);
  skinned.skeleton.update();
  const out = new Float32Array(15);
  skinned.computeSkinnedWorld(out, 5);
  assert.ok(Number.isFinite(out[9]) && Number.isFinite(out[10]));

  // En un cubo ancho (1.3x1.3x1.3) con 2 huesos, la parte inferior (y=-0.5) y las esquinas de la punta (y=+0.65)
  // deben quedar aisladas al 100% en su hueso respectivo sin fugas ni pellizcos en la punta
  const cubeGeo = new BoxGeometry(1.3, 1.3, 1.3, 8, 8, 8);
  const cRoot = new Bone();
  cRoot.position.set(0, -0.5, 0);
  cRoot.length = 0.5;
  const cTop = new Bone();
  cTop.position.set(0, 0.5, 0);
  cTop.length = 0.5;
  cRoot.add(cTop);
  const cubeMesh = new SkinnedMesh(cubeGeo, new StandardMaterial());
  cubeMesh.add(cRoot);
  cubeMesh.updateWorldMatrix(true, true);

  const { skinIndex: cIdx, skinWeight: cWt } = computeAutoSkinWeights(cubeGeo, cubeMesh.matrixWorld, [cRoot, cTop]);
  const cPos = cubeGeo.attributes.position.array;
  const weightOf = (vi, boneIdx) => {
    let w = 0;
    for (let j = 0; j < 4; j++) {
      if (cWt[vi * 4 + j] > 0 && Math.round(cIdx[vi * 4 + j]) === boneIdx) w += cWt[vi * 4 + j];
    }
    return w;
  };
  let checkedBottom = 0, checkedTopCorner = 0, checkedJoint = 0;
  for (let vi = 0; vi < cubeGeo.attributes.position.count; vi++) {
    const x = cPos[vi * 3], y = cPos[vi * 3 + 1], z = cPos[vi * 3 + 2];
    if (y <= -0.35) {
      assert.ok(weightOf(vi, 1) < 0.01, `parte inferior y=${y} no debe deformarse con hueso superior`);
      checkedBottom++;
    } else if (y >= 0.45 && Math.abs(x) > 0.5 && Math.abs(z) > 0.5) {
      assert.ok(weightOf(vi, 1) > 0.99, `esquina superior y=${y} debe moverse 100% con la punta`);
      checkedTopCorner++;
    } else if (Math.abs(y) < 0.01) {
      const w0 = weightOf(vi, 0);
      const w1 = weightOf(vi, 1);
      assert.ok(Math.abs(w0 - 0.5) < 0.05 && Math.abs(w1 - 0.5) < 0.05);
      checkedJoint++;
    }
  }
  assert.ok(checkedBottom > 0 && checkedTopCorner > 0 && checkedJoint > 0);

  // SkeletonHelper.pickScreen permite tocar la punta (tail) del último hueso
  const helper = new SkeletonHelper(cubeMesh);
  const testCam = new PerspectiveCamera(50, 1, 0.1, 100);
  testCam.position.set(0, 0, 5);
  testCam.lookAt(0, 0, 0);
  testCam.updateMatrixWorld();
  testCam.updateProjection();

  const noop = () => {};
  const fakeCtx = {
    save: noop, restore: noop, beginPath: noop, moveTo: noop, lineTo: noop,
    closePath: noop, fill: noop, stroke: noop, arc: noop, setLineDash: noop,
  };
  helper.draw2D(fakeCtx, testCam, 400, 400, { sceneRoot: cubeMesh });
  const tailScreen = helper._rigScreens?.tails?.[0];
  assert.ok(tailScreen && tailScreen.bone === cTop);
  const pickedTip = helper.pickScreen(tailScreen.x + 8, tailScreen.y, true);
  assert.ok(pickedTip && pickedTip.bone === cTop, 'tocar la punta del último hueso debe seleccionarlo');
  assert.equal(pickedTip.hitKind, 'tail');

  // Flujo completo de Rigger desde la librería (imán + espejo + cadena + fijado + undo/redo)
  const scene = new Scene();
  const rawMesh = new Mesh(new BoxGeometry(1.4, 2.0, 1.0, 2, 4, 2), new StandardMaterial());
  scene.add(rawMesh);
  scene.updateMatrixWorld(true, true);

  const rigEditor = new Rigger({ boneTool: true, mirror: true, magnet: true });
  rigEditor.setEnabled(true);

  const r1 = rigEditor.tapBoneTool(165, 260, 400, 400, testCam, Rigger.collectContext(rawMesh), { scene });
  assert.equal(r1.action, 'startRoot');
  assert.ok(r1.bone && r1.mirrorBone, 'espejo debe crear hueso izquierdo y derecho');
  assert.ok(Math.abs(r1.bone.position.z) < 1e-3, 'imán debe centrar el hueso en Z=0');

  const r2 = rigEditor.tapBoneTool(165, 200, 400, 400, testCam, Rigger.collectContext(rawMesh), { scene });
  assert.equal(r2.action, 'extendRoot');
  assert.ok(r2.bone.length > 0.2);

  const r3 = rigEditor.tapBoneTool(165, 140, 400, 400, testCam, Rigger.collectContext(rawMesh), { scene });
  assert.equal(r3.action, 'chainChild');
  assert.ok(r3.bone.parent === r1.bone && r3.mirrorBone.parent === r1.mirrorBone);

  const bindRes = rigEditor.bindRig(Rigger.collectContext(rawMesh), { scene });
  assert.equal(bindRes.ok, true);
  assert.ok(bindRes.primarySkinned.isSkinnedMesh);
  assert.equal(scene.children.includes(bindRes.primarySkinned), true);
  assert.equal(scene.children.includes(rawMesh), false);

  bindRes.undo();
  assert.equal(scene.children.includes(rawMesh), true);
  bindRes.redo();
  assert.equal(scene.children.includes(bindRes.primarySkinned), true);

  // bindMeshesToSkeleton standalone
  const plain = new Mesh(new BoxGeometry(1, 1, 1), new StandardMaterial());
  const soloBone = new Bone();
  soloBone.length = 0.8;
  plain.add(soloBone);
  const directBind = bindMeshesToSkeleton([plain], [soloBone]);
  assert.equal(directBind.ok, true);
  assert.equal(directBind.primarySkinned.isSkinnedMesh, true);

  // GizmoBase: seleccionar y arrastrar directamente la cabecita/punta del último hueso
  const gizmoCtx = {
    setTransform: noop, clearRect: noop, save: noop, restore: noop,
    beginPath: noop, moveTo: noop, lineTo: noop, closePath: noop,
    fill: noop, stroke: noop, arc: noop, setLineDash: noop,
    fillRect: noop, measureText: () => ({ width: 20 }), fillText: noop, roundRect: noop,
  };
  const gizmoDom = {
    clientWidth: 400,
    clientHeight: 400,
    style: {},
    addEventListener: noop,
    removeEventListener: noop,
    setPointerCapture: noop,
    releasePointerCapture: noop,
    hasPointerCapture: () => false,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 400 }),
  };
  const gizmoOverlay = { width: 400, height: 400, style: {}, getContext: () => gizmoCtx };
  const rigGizmo = new GizmoBase(testCam, gizmoDom, { overlay: gizmoOverlay, mode: 'rotate' });
  rigGizmo.attach(bindRes.primarySkinned);
  rigGizmo._draw2D(true);
  const rigHelper = rigGizmo._getRigHelper();
  const lastTipScreen = rigHelper._rigScreens?.tails?.[0];
  assert.ok(lastTipScreen, 'el último hueso debe proyectar su punta en GizmoBase');
  const tipBone = lastTipScreen.bone;
  const beforeTailWorld = tipBone.getWorldTail().clone();

  rigGizmo._down({
    pointerId: 7,
    pointerType: 'mouse',
    button: 0,
    clientX: lastTipScreen.x,
    clientY: lastTipScreen.y,
    shiftKey: false,
    stopImmediatePropagation: noop,
    preventDefault: noop,
  });
  assert.equal(rigGizmo.object, tipBone, 'tocar la punta debe seleccionar el último hueso');
  assert.equal(rigGizmo.drag?.key, 'boneTail', 'arrastrar la punta debe iniciar modo boneTail');

  rigGizmo._move({
    pointerId: 7,
    pointerType: 'mouse',
    clientX: lastTipScreen.x + 48,
    clientY: lastTipScreen.y + 12,
  });
  assert.equal(rigGizmo.drag?.moved, true);
  rigGizmo._up({
    pointerId: 7,
    pointerType: 'mouse',
    clientX: lastTipScreen.x + 48,
    clientY: lastTipScreen.y + 12,
  });
  const afterTailWorld = tipBone.getWorldTail();
  assert.ok(afterTailWorld.distanceTo(beforeTailWorld) > 0.1, 'arrastrar la punta debe rotar/mover el último hueso');
  rigGizmo.dispose();
});



