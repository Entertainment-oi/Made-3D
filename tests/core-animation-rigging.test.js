import test from 'node:test';
import assert from 'node:assert/strict';
import * as MadeCore from '../made3d.module.js';
import {
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
import { ensureEditableBase, canIncrementSubsurf } from '../src/modules/modeling.js';

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
