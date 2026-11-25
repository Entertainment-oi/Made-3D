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
import { cloneSkinned } from '../src/modules/rigging.js';
import { ensureEditableBase, canIncrementSubsurf } from '../src/modules/modeling.js';
import { CameraHelper, drawCamerasOverlay } from '../src/modules/helpers.js';

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





