import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BoxGeometry,
  Geometry,
  Mesh,
  Scene,
  StandardMaterial,
  Vec3,
} from '../made3d.module.js';
import { Bone, Skeleton, SkinnedMesh } from '../src/modules/rigging.js';
import { GLTFLoader, OBJLoader, KTX2Loader } from '../src/modules/loaders.js';
import { GLTFExporter, OBJExporter } from '../src/modules/exporters.js';

test('GLTFExporter y GLTFLoader realizan ida y vuelta GLB binaria preservando geometría y PBR', async () => {
  const scene = new Scene();
  const mat = new StandardMaterial({
    color: 0xff8800,
    hasPbr: true,
    roughness: 0.25,
    metalness: 0.85,
    envMapIntensity: 1.4,
    emissive: 0x112233,
  });
  const mesh = new Mesh(new BoxGeometry(1, 2, 3), mat);
  mesh.name = 'CajaPBR';
  mesh.position.set(1.5, 2.5, -0.5);
  scene.add(mesh);

  const exporter = new GLTFExporter();
  const glb = await exporter.parse(scene, { binary: true });
  assert.ok(glb instanceof ArrayBuffer);
  assert.ok(glb.byteLength > 100);

  // Verificar cabecera mágica glTF ("glTF" = 0x46546c67)
  const magic = new DataView(glb).getUint32(0, true);
  assert.equal(magic, 0x46546c67);

  const loader = new GLTFLoader();
  const imported = await loader.parse(glb);
  const meshes = [];
  imported.scene.traverse((n) => {
    if (n && n.isMesh) meshes.push(n);
  });

  assert.equal(meshes.length, 1);
  const outMesh = meshes[0];
  assert.equal(outMesh.geometry.attributes.position.count, 24);
  assert.ok(outMesh.material.hasPbr);
  assert.ok(Math.abs(outMesh.material.roughness - 0.25) < 1e-3);
  assert.ok(Math.abs(outMesh.material.metalness - 0.85) < 1e-3);
});

test('OBJExporter y OBJLoader realizan ida y vuelta de geometría y materiales MTL', () => {
  const mat = new StandardMaterial({ color: 0x33aa55, shininess: 64 });
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), mat);
  mesh.name = 'CuboOBJ';

  const exporter = new OBJExporter();
  const { obj, mtl } = exporter.parseWithMaterials(mesh, { mtlFilename: 'test.mtl' });
  assert.ok(obj.includes('mtllib test.mtl'));
  assert.ok(obj.includes('v '));
  assert.ok(obj.includes('f '));
  assert.ok(mtl.includes('newmtl '));
  assert.ok(mtl.includes('Kd '));

  const loader = new OBJLoader();
  const parsed = loader.parse(obj, { mtl });
  const meshes = [];
  parsed.traverse((n) => {
    if (n && n.isMesh) meshes.push(n);
  });

  assert.equal(meshes.length, 1);
  assert.equal(meshes[0].geometry.attributes.position.count, 24);
  assert.equal(meshes[0].geometry.index.count, 36);
  assert.ok(meshes[0].material.color.g > 0.5);
});

test('GLTFExporter omite JOINTS_0/WEIGHTS_0 si algún hueso es invisible y GLTFLoader aísla vertexColors', async () => {
  const geo = new Geometry();
  geo.setAttribute('position', new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3);
  geo.setAttribute('normal', new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3);
  geo.setAttribute('skinIndex', new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), 4);
  geo.setAttribute('skinWeight', new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), 4);

  const b0 = new Bone();
  b0.visible = false; // hueso oculto -> no se exporta el skin
  const sk = new Skeleton([b0]);
  const skinned = new SkinnedMesh(geo, new StandardMaterial({ color: 0xffffff }));
  skinned.add(b0);
  skinned.bind(sk);

  const scene = new Scene();
  scene.add(skinned);
  const gltf = await new GLTFExporter().parse(scene, { binary: false, onlyVisible: true });
  const primAttrs = gltf.meshes[0].primitives[0].attributes;
  assert.equal('JOINTS_0' in primAttrs, false);
  assert.equal('WEIGHTS_0' in primAttrs, false);
  assert.equal(Boolean(gltf.skins && gltf.skins.length), false);

  // Material compartido en GLTFLoader: una primitiva sin COLOR_0 y otra con COLOR_0 no deben mutarse
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const col = new Float32Array([1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1]);
  const bin = new Uint8Array(pos.byteLength + col.byteLength);
  bin.set(new Uint8Array(pos.buffer), 0);
  bin.set(new Uint8Array(col.buffer), pos.byteLength);
  const dataUri = 'data:application/octet-stream;base64,' + Buffer.from(bin).toString('base64');
  const gltfJson = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    materials: [{ name: 'SharedMat' }],
    buffers: [{ uri: dataUri, byteLength: bin.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: pos.byteLength },
      { buffer: 0, byteOffset: pos.byteLength, byteLength: col.byteLength },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC4' },
    ],
    meshes: [{
      primitives: [
        { attributes: { POSITION: 0 }, material: 0 },
        { attributes: { POSITION: 0, COLOR_0: 1 }, material: 0 },
      ],
    }],
  };
  const loaded = await new GLTFLoader().parse(gltfJson);
  const outMeshes = [];
  loaded.scene.traverse((n) => { if (n.isMesh) outMeshes.push(n); });
  assert.equal(outMeshes.length, 2);
  assert.equal(outMeshes[0].material.vertexColors, false);
  assert.equal(outMeshes[1].material.vertexColors, true);
  assert.notEqual(outMeshes[0].material, outMeshes[1].material);
});

test('OBJLoader conserva vn parciales, OBJExporter conserva normales con skinning y KTX2Loader.dispose rechaza pendientes', async () => {
  const objSrc = [
    'v 0 0 0',
    'v 1 0 0',
    'v 0 1 0',
    'v 1 1 0',
    'vn 0 0 -1',
    'f 1//1 2//1 3',
    'f 2 4 3',
  ].join('\n');
  const loadedObj = new OBJLoader().parse(objSrc);
  const parsedMesh = loadedObj.children[0];
  const nArr = parsedMesh.geometry.attributes.normal.array;
  // Primeros dos vértices deben conservar exactamente la normal explícita (0, 0, -1)
  assert.ok(Math.abs(nArr[2] - (-1)) < 1e-5);
  assert.ok(Math.abs(nArr[5] - (-1)) < 1e-5);

  // OBJExporter con SkinnedMesh rotado 90 grados en Z: una normal explícita +X debe exportarse rotada hacia +Y
  const skGeo = new Geometry();
  skGeo.setAttribute('position', new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3);
  skGeo.setAttribute('normal', new Float32Array([1, 0, 0, 1, 0, 0, 1, 0, 0]), 3);
  skGeo.setAttribute('skinIndex', new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), 4);
  skGeo.setAttribute('skinWeight', new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), 4);
  const bone = new Bone();
  const sk = new Skeleton([bone]);
  const skMesh = new SkinnedMesh(skGeo, new StandardMaterial({ color: 0xffffff }));
  skMesh.add(bone);
  skMesh.bind(sk);
  bone.quaternion.setFromAxisAngle(new Vec3(0, 0, 1), Math.PI * 0.5);
  skMesh.updateWorldMatrix(true, true);
  sk.update();
  const exportedObj = new OBJExporter().parse(skMesh);
  assert.ok(exportedObj.includes('vn 0.000000 1.000000 0.000000'));

  // KTX2Loader.dispose debe rechazar promesas en cola
  const ktx2 = new KTX2Loader({ useWorker: true });
  const pendingPromise = new Promise((resolve, reject) => {
    ktx2._queue.push({ bytes: new Uint8Array(4), caps: {}, colorSpace: 'srgb', forceRgba: false, resolve, reject });
  });
  ktx2.dispose();
  await assert.rejects(pendingPromise, /liberado/i);
});

