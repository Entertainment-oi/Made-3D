import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BoxGeometry,
  Mesh,
  Scene,
  StandardMaterial,
} from '../made3d.module.js';
import { GLTFLoader, OBJLoader } from '../src/modules/loaders.js';
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
