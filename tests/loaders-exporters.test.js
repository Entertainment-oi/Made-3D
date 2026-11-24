import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import {
  BoxGeometry,
  Geometry,
  Mesh,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
  StandardMaterial,
  Vec3,
  Frustum,
  Mat4,
} from '../made3d.module.js';
import { Bone, Skeleton, SkinnedMesh } from '../src/modules/rigging.js';
import { ChunkedInstances } from '../src/modules/helpers.js';
import {
  GLTFLoader,
  OBJLoader,
  KTX2Loader,
  DRACOLoader,
  encodeDraco,
  optimizeGeometry,
  getMadeOptimizeCapabilities,
  createSceneBvh,
  simplifyMesh,
  simplifyGeometry,
  buildMeshlets,
  MADE_TEXTURE_TARGET_FORMAT,
  hasMadeTextureBinary,
  getMadeTextureCapabilities,
} from '../src/modules/loaders.js';
import { chooseTargetFromCaps } from '../src/libs/made-texture/made_texture.js';
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

test('MadeOptimize: GLTFExporter (draco: true) y GLTFLoader/DRACOLoader realizan ida y vuelta con KHR_draco_mesh_compression', async () => {
  const scene = new Scene();
  const box = new BoxGeometry(2, 2, 2);
  const mesh = new Mesh(box, new StandardMaterial({ color: 0x4499ff, roughness: 0.4, metalness: 0.2 }));
  mesh.name = 'CajaDraco';
  scene.add(mesh);

  const exporter = new GLTFExporter();
  const gltfJson = await exporter.parse(scene, { binary: false, draco: true });
  assert.ok(gltfJson.extensionsUsed.includes('KHR_draco_mesh_compression'));
  assert.ok(gltfJson.extensionsRequired.includes('KHR_draco_mesh_compression'));
  const prim = gltfJson.meshes[0].primitives[0];
  assert.ok(prim.extensions?.KHR_draco_mesh_compression);
  assert.equal(gltfJson.accessors[prim.attributes.POSITION].bufferView, undefined);
  assert.ok(Array.isArray(gltfJson.accessors[prim.attributes.POSITION].min));
  assert.ok(Array.isArray(gltfJson.accessors[prim.attributes.POSITION].max));

  const glb = await exporter.parse(scene, { binary: true, draco: true });
  const loader = new GLTFLoader();
  const imported = await loader.parse(glb);
  const meshes = [];
  imported.scene.traverse((n) => {
    if (n && n.isMesh) meshes.push(n);
  });

  assert.equal(meshes.length, 1);
  const outGeo = meshes[0].geometry;
  assert.equal(outGeo.attributes.position.count, 24);
  assert.equal(outGeo.attributes.normal.count, 24);
  assert.equal(outGeo.attributes.uv.count, 24);
  assert.equal(outGeo.index.count, 36);

  // Verificar precisión dentro de la tolerancia de cuantización de 14 bits
  const srcPos = box.attributes.position.array;
  const dstPos = outGeo.attributes.position.array;
  for (let i = 0; i < srcPos.length; i++) {
    assert.ok(Math.abs(srcPos[i] - dstPos[i]) < 1e-3);
  }
});

test('MadeOptimize: optimizeGeometry deduplica vértices en sopa de triángulos y conserva costuras de BoxGeometry', async () => {
  const quad = new Geometry();
  quad.setAttribute(
    'position',
    new Float32Array([
      0, 0, 0, 1, 0, 0, 1, 1, 0,
      0, 0, 0, 1, 1, 0, 0, 1, 0,
    ]),
    3
  );
  quad.setAttribute(
    'normal',
    new Float32Array([
      0, 0, 1, 0, 0, 1, 0, 0, 1,
      0, 0, 1, 0, 0, 1, 0, 0, 1,
    ]),
    3
  );

  const optimized = await optimizeGeometry(quad, { inPlace: false });
  assert.equal(optimized.attributes.position.count, 4);
  assert.equal(optimized.attributes.normal.count, 4);
  assert.equal(optimized.index.count, 6);

  // BoxGeometry tiene 24 vértices con normales distintas en cada esquina: optimize: true no debe colapsarlos a 8
  const scene = new Scene();
  scene.add(new Mesh(new BoxGeometry(1, 1, 1), new StandardMaterial({ color: 0xffffff })));
  const glbOpt = await new GLTFExporter().parse(scene, { binary: true, optimize: true });
  const reloaded = await new GLTFLoader().parse(glbOpt);
  let outBox = null;
  reloaded.scene.traverse((n) => {
    if (n && n.isMesh) outBox = n;
  });
  assert.equal(outBox.geometry.attributes.position.count, 24);

  // DRACOLoader sin attributeMap (modo .drc) y manejo de errores sin fallback clásico
  const drcBytes = await encodeDraco({
    numPoints: 4,
    indices: [0, 1, 2, 0, 2, 3],
    attributes: [
      {
        attributeType: 0,
        numComponents: 3,
        uniqueId: 0,
        quantizationBits: 14,
        values: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
      },
    ],
  });
  const dracoLoader = new DRACOLoader({ useLegacyFallback: false });
  const decodedGeo = await dracoLoader.decodeGeometry(drcBytes);
  assert.equal(decodedGeo.attributes.position.count, 4);
  assert.equal(decodedGeo.index.count, 6);
  await assert.rejects(dracoLoader.decodeGeometry(new Uint8Array([1, 2, 3, 4])), /MadeOptimize/);
});

test('MadeOptimize: SceneBvh, simplifyGeometry, buildMeshlets y ChunkedInstances con culling BVH', async () => {
  // 1. SceneBvh: frustum culling + LOD + refit
  const spheres = new Float32Array([
    0, 0, -10, 1,     // visible LOD 0
    0, 0, -60, 1,     // visible LOD 1
    0, 0, -130, 1,    // visible LOD 2
    100, 0, -10, 1,   // fuera del frustum
    0, 100, -10, 1,   // fuera del frustum
    0, 0, 20, 1,      // detrás de la cámara
  ]);
  const bvh = await createSceneBvh(spheres);
  assert.equal(bvh.backend, 'wasm');
  assert.deepEqual(getMadeOptimizeCapabilities(), {
    loaded: true,
    bvh: true,
    lod: true,
    meshlets: true,
    optimizeAttrs: true,
  });

  const cam = new PerspectiveCamera(60, 1, 1, 200);
  cam.position.set(0, 0, 0);
  cam.updateMatrixWorld();
  cam.updateViewMatrix();
  const vp = new Mat4().multiplyMatrices(cam.projectionMatrix, cam.viewMatrix);
  const frustum = new Frustum().setFromMatrix(vp);
  const planes = Float32Array.from(frustum.p);

  const q1 = bvh.queryFrustum(planes, [0, 0, 0], [0, 40, 100]);
  assert.equal(q1.backend, 'wasm');
  assert.equal(q1.count, 3);
  const visPairs = Array.from({ length: q1.count }, (_, i) => [q1.indices[i], q1.lods[i]]).sort((a, b) => a[0] - b[0]);
  assert.deepEqual(visPairs, [[0, 0], [1, 1], [2, 2]]);

  // Mover el ítem 3 al frente y refit
  assert.equal(bvh.updateItem(3, 0, 0, -15, 1), true);
  bvh.refit();
  const q2 = bvh.queryFrustum(planes, [0, 0, 0], [0, 40, 100]);
  assert.equal(q2.count, 4);
  bvh.dispose();

  // 2. simplifyMesh, simplifyGeometry y buildMeshlets sobre SphereGeometry en ruta nativa WASM
  const sphere = new SphereGeometry(1, 24, 16);
  const origTris = sphere.index.count / 3;
  const lodRaw = await simplifyMesh(sphere.attributes.position.array, sphere.index.array, { ratio: 0.35 });
  assert.equal(lodRaw.backend, 'wasm');
  assert.ok(lodRaw.indices.length / 3 < origTris);
  const lod = await simplifyGeometry(sphere, { ratio: 0.35 });
  assert.ok(lod.index.count / 3 < origTris);
  assert.ok(lod.attributes.normal.count === lod.attributes.position.count);

  const meshlets = await buildMeshlets(sphere, { maxVertices: 64, maxTriangles: 64 });
  assert.equal(meshlets.backend, 'wasm');
  assert.ok(meshlets.count >= 4);
  assert.equal(meshlets.indices.length, sphere.index.count);
  assert.equal(meshlets.bounds.length, meshlets.count * 4);
  assert.equal(meshlets.cones.length, meshlets.count * 4);
  assert.equal(meshlets.ranges.length, meshlets.count * 4);

  // 3. ChunkedInstances con BVH activado (>= 8 chunks)
  const mat = new StandardMaterial({ color: 0xffffff });
  const world = new ChunkedInstances(new BoxGeometry(1, 1, 1), mat, {
    chunkSize: 10,
    lod: [{ distance: 50, geometry: lod }],
  });
  for (let i = 0; i < 12; i++) {
    world.addInstance(new Vec3((i - 6) * 15, 0, -15));
  }
  world.build();
  assert.ok(world.chunkCount >= 8);
  world.updateMatrixWorld();
  world.onBeforeRender({ _viewProj: vp, _frustum: frustum }, cam);
  const visibleMeshes = world.children.filter((m) => m.visible);
  assert.ok(visibleMeshes.length > 0 && visibleMeshes.length < world.chunkCount);
  world.dispose();
});

test('GLTFLoader decodifica EXT_meshopt_compression usando MadeOptimize sin meshopt_decoder.module.js', async () => {
  // Buffer de posiciones sin comprimir + índices comprimidos con EXT_meshopt_compression (INDICES: [0, 1, 2])
  const posF32 = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const posBytes = new Uint8Array(posF32.buffer);
  const idxCompressed = new Uint8Array([0xd0, 0x00, 0x02, 0x02]); // 0 -> 0, +1 -> 1, +1 -> 2
  const binLen = Math.ceil((posBytes.byteLength + idxCompressed.byteLength) / 4) * 4;
  const bin = new Uint8Array(binLen);
  bin.set(posBytes, 0);
  bin.set(idxCompressed, posBytes.byteLength);

  const gltfJson = {
    asset: { version: '2.0' },
    extensionsUsed: ['EXT_meshopt_compression'],
    extensionsRequired: ['EXT_meshopt_compression'],
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: binLen }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBytes.byteLength },
      {
        buffer: 0,
        byteOffset: posBytes.byteLength,
        byteLength: idxCompressed.byteLength,
        extensions: {
          EXT_meshopt_compression: {
            buffer: 0,
            byteOffset: posBytes.byteLength,
            byteLength: idxCompressed.byteLength,
            byteStride: 2,
            count: 3,
            mode: 'INDICES',
            filter: 'NONE',
          },
        },
      },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
  };

  const jsonBytes = new TextEncoder().encode(JSON.stringify(gltfJson));
  const jsonPad = Math.ceil(jsonBytes.length / 4) * 4;
  const totalLen = 12 + 8 + jsonPad + 8 + binLen;
  const glb = new ArrayBuffer(totalLen);
  const dv = new DataView(glb);
  const u8 = new Uint8Array(glb);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, totalLen, true);
  dv.setUint32(12, jsonPad, true);
  dv.setUint32(16, 0x4e4f534a, true);
  u8.set(jsonBytes, 20);
  for (let i = jsonBytes.length; i < jsonPad; i++) u8[20 + i] = 0x20;
  const binChunkOff = 20 + jsonPad;
  dv.setUint32(binChunkOff, binLen, true);
  dv.setUint32(binChunkOff + 4, 0x004e4942, true);
  u8.set(bin, binChunkOff + 8);

  const loaded = await new GLTFLoader().parse(glb);
  let loadedMesh = null;
  loaded.scene.traverse((n) => { if (n && n.isMesh) loadedMesh = n; });
  assert.ok(loadedMesh);
  assert.deepEqual(Array.from(loadedMesh.geometry.index.array), [0, 1, 2]);
});

test('MadeTexture: selección de formatos objetivo y detección segura de backend en KTX2Loader', async () => {
  assert.equal(chooseTargetFromCaps({ astc: true }, 16, 16, true, 'srgb').basisFormat, MADE_TEXTURE_TARGET_FORMAT.ASTC_4x4_RGBA);
  assert.equal(chooseTargetFromCaps({ bptc: true }, 16, 16, true, 'srgb').basisFormat, MADE_TEXTURE_TARGET_FORMAT.BC7_RGBA);
  assert.equal(chooseTargetFromCaps({ etc: true }, 16, 16, true, 'linear').basisFormat, MADE_TEXTURE_TARGET_FORMAT.ETC2_RGBA);
  assert.equal(chooseTargetFromCaps({ etc: true }, 16, 16, false, 'linear').basisFormat, MADE_TEXTURE_TARGET_FORMAT.ETC1_RGB);
  assert.equal(chooseTargetFromCaps({ s3tc: true, s3tcSrgb: true }, 16, 16, true, 'srgb').basisFormat, MADE_TEXTURE_TARGET_FORMAT.BC3_RGBA);
  assert.equal(chooseTargetFromCaps({ s3tc: true }, 16, 16, false, 'linear').basisFormat, MADE_TEXTURE_TARGET_FORMAT.BC1_RGB);
  assert.equal(chooseTargetFromCaps({}, 16, 16, false, 'linear').basisFormat, MADE_TEXTURE_TARGET_FORMAT.RGBA32);

  const hasBin = await hasMadeTextureBinary();
  assert.equal(hasBin, true);

  const ktx2 = new KTX2Loader({ useWorker: false });
  const backend = await ktx2.getActiveBackend();
  assert.equal(backend, 'made-texture');

  // Helper para construir DFD + KTX2 v2 mínimos
  const buildMinimalDfd = (colorModel, transfer, bytesPlane0, withAlphaSample) => {
    const sampleCount = withAlphaSample ? 2 : 1;
    const blockSize = 24 + sampleCount * 16;
    const totalSize = 4 + blockSize;
    const buf = new ArrayBuffer(totalSize);
    const dv = new DataView(buf);
    dv.setUint32(0, totalSize, true);
    dv.setUint16(4, 0, true);
    dv.setUint16(6, 2, true);
    dv.setUint16(8, 2, true);
    dv.setUint16(10, blockSize, true);
    dv.setUint8(12, colorModel);
    dv.setUint8(13, 1); // BT709
    dv.setUint8(14, transfer);
    dv.setUint8(15, 0);
    dv.setUint8(16, 3); // 4x4
    dv.setUint8(17, 3);
    dv.setUint8(18, 0);
    dv.setUint8(19, 0);
    dv.setUint8(20, bytesPlane0);

    const writeSample = (off, bitLen, channelType) => {
      dv.setUint16(off, 0, true);
      dv.setUint8(off + 2, bitLen);
      dv.setUint8(off + 3, channelType);
      dv.setUint32(off + 8, 0, true);
      dv.setUint32(off + 12, 255, true);
    };
    writeSample(28, 63, 0);
    if (withAlphaSample) {
      writeSample(44, 63, 15);
    }
    return new Uint8Array(buf);
  };

  const buildKtx2SingleLevel = (w, h, ss, dfd, sgd, levelData, uncompressedLen) => {
    const magic = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
    const dfdOff = 80 + 24;
    const sgdOff = dfdOff + dfd.length;
    const lvlOff = sgdOff + sgd.length;
    const out = new Uint8Array(lvlOff + levelData.length);
    const dv = new DataView(out.buffer);
    out.set(magic, 0);
    dv.setUint32(12, 0, true); // vkFormat=0
    dv.setUint32(16, 1, true); // typeSize=1
    dv.setUint32(20, w, true);
    dv.setUint32(24, h, true);
    dv.setUint32(36, 1, true); // faces
    dv.setUint32(40, 1, true); // levels
    dv.setUint32(44, ss, true);
    dv.setUint32(48, dfdOff, true);
    dv.setUint32(52, dfd.length, true);
    if (sgd.length > 0) {
      dv.setBigUint64(64, BigInt(sgdOff), true);
      dv.setBigUint64(72, BigInt(sgd.length), true);
    }
    dv.setBigUint64(80, BigInt(lvlOff), true);
    dv.setBigUint64(88, BigInt(levelData.length), true);
    dv.setBigUint64(96, BigInt(uncompressedLen), true);
    out.set(dfd, dfdOff);
    if (sgd.length > 0) out.set(sgd, sgdOff);
    out.set(levelData, lvlOff);
    return out;
  };

  // 1. KTX2 UASTC Mode 8 (sólido R=10, G=200, B=40, A=255) comprimido con Zlib (sRGB)
  let uastcVal = 23n; // UASTC_HUFF_MODES[23] == 8
  uastcVal |= 10n << 5n;
  uastcVal |= 200n << 13n;
  uastcVal |= 40n << 21n;
  uastcVal |= 255n << 29n;
  const uastcBlock = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    uastcBlock[i] = Number((uastcVal >> BigInt(i * 8)) & 0xffn);
  }
  const uastcZlib = new Uint8Array(deflateSync(uastcBlock));
  const uastcDfd = buildMinimalDfd(166 /* UASTC */, 2 /* sRGB */, 16, false);
  const uastcKtx2 = buildKtx2SingleLevel(4, 4, 3 /* Zlib */, uastcDfd, new Uint8Array(0), uastcZlib, 16);

  const uastcRgbaTex = await ktx2.parse(uastcKtx2);
  assert.equal(uastcRgbaTex.width, 4);
  assert.equal(uastcRgbaTex.height, 4);
  assert.equal(uastcRgbaTex.colorSpace, 'srgb');
  assert.equal(uastcRgbaTex.compressed, false);
  assert.equal(uastcRgbaTex.mipmaps.length, 1);
  assert.deepEqual(Array.from(uastcRgbaTex.mipmaps[0].data.slice(0, 4)), [10, 200, 40, 255]);

  // Transcodificación directa a formato GPU comprimido (ASTC 4x4) + fallback RGBA nivel 0
  ktx2._caps = { astc: true, enums: { astcRgba: 0x93b0, astcSrgb: 0x93d0 } };
  const uastcAstcTex = await ktx2.parse(uastcKtx2);
  assert.equal(uastcAstcTex.compressed, true);
  assert.equal(uastcAstcTex.formatId, 'astc-4x4');
  assert.deepEqual(
    Array.from(uastcAstcTex.mipmaps[0].data),
    [0xfc, 0xfd, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 10, 10, 200, 200, 40, 40, 255, 255]
  );
  const decodedLvl0 = await uastcAstcTex._decodeRgbaLevel0();
  assert.deepEqual(Array.from(decodedLvl0.data.slice(0, 4)), [10, 200, 40, 255]);

  // 2. KTX2 BasisLZ / ETC1S con canal Alpha (linear)
  const makeBitWriter = () => {
    const bytes = [];
    let cur = 0;
    let bitPos = 0;
    const writeBits = (val, n) => {
      for (let i = 0; i < n; i++) {
        if ((val >>> i) & 1) cur |= 1 << bitPos;
        bitPos++;
        if (bitPos === 8) {
          bytes.push(cur);
          cur = 0;
          bitPos = 0;
        }
      }
    };
    const writeSingleSymHuffman = (sym) => {
      const total = sym + 1;
      writeBits(total, 14);
      writeBits(19, 5);
      for (let slot = 0; slot < 19; slot++) {
        const cl = slot === 0 || slot === 1 || slot === 4 || slot === 18 ? 2 : 0;
        writeBits(cl, 3);
      }
      let left = sym;
      while (left > 0) {
        if (left >= 11) {
          const run = Math.min(left, 138);
          writeBits(0b11, 2);
          writeBits(run - 11, 7);
          left -= run;
        } else if (left >= 3) {
          const run = Math.min(left, 10);
          writeBits(0b01, 2);
          writeBits(run - 3, 3);
          left -= run;
        } else {
          writeBits(0b00, 2);
          left -= 1;
        }
      }
      writeBits(0b10, 2);
    };
    const finish = () => {
      if (bitPos > 0) bytes.push(cur);
      return new Uint8Array(bytes);
    };
    return { writeBits, writeSingleSymHuffman, finish };
  };

  const epW = makeBitWriter();
  for (let i = 0; i < 4; i++) epW.writeSingleSymHuffman(0);
  epW.writeBits(0, 1);
  epW.writeBits(0, 4);
  const epBytes = epW.finish();

  const selW = makeBitWriter();
  selW.writeBits(0, 1);
  selW.writeBits(0, 1);
  selW.writeBits(1, 1);
  for (let i = 0; i < 4; i++) selW.writeBits(0xaa, 8);
  const selBytes = selW.finish();

  const tblW = makeBitWriter();
  tblW.writeSingleSymHuffman(0xff);
  tblW.writeSingleSymHuffman(0);
  tblW.writeSingleSymHuffman(0);
  tblW.writeSingleSymHuffman(0);
  tblW.writeBits(64, 13);
  const tblBytes = tblW.finish();

  const slice = new Uint8Array([0, 0]);
  const levelBlob = new Uint8Array(4);
  levelBlob.set(slice, 0);
  levelBlob.set(slice, 2);

  const sgd = new Uint8Array(20 + 20 + epBytes.length + selBytes.length + tblBytes.length);
  const sgdDv = new DataView(sgd.buffer);
  sgdDv.setUint16(0, 1, true); // endpointCount
  sgdDv.setUint16(2, 1, true); // selectorCount
  sgdDv.setUint32(4, epBytes.length, true);
  sgdDv.setUint32(8, selBytes.length, true);
  sgdDv.setUint32(12, tblBytes.length, true);
  sgdDv.setUint32(16, 0, true); // extendedByteLength
  sgdDv.setUint32(20, 0, true); // flags
  sgdDv.setUint32(24, 0, true); // rgbSliceByteOffset
  sgdDv.setUint32(28, 2, true); // rgbSliceByteLength
  sgdDv.setUint32(32, 2, true); // alphaSliceByteOffset
  sgdDv.setUint32(36, 2, true); // alphaSliceByteLength
  let sgdCursor = 40;
  sgd.set(epBytes, sgdCursor); sgdCursor += epBytes.length;
  sgd.set(selBytes, sgdCursor); sgdCursor += selBytes.length;
  sgd.set(tblBytes, sgdCursor);

  const etc1sDfd = buildMinimalDfd(163 /* ETC1S */, 1 /* Linear */, 0, true);
  const etc1sKtx2 = buildKtx2SingleLevel(4, 4, 1 /* BasisLZ */, etc1sDfd, sgd, levelBlob, 0);

  ktx2._caps = { enums: {} };
  const etc1sRgbaTex = await ktx2.parse(etc1sKtx2);
  assert.equal(etc1sRgbaTex.colorSpace, 'linear');
  assert.equal(etc1sRgbaTex.compressed, false);
  assert.deepEqual(Array.from(etc1sRgbaTex.mipmaps[0].data.slice(0, 4)), [134, 134, 134, 134]);

  ktx2._caps = { etc: true, enums: { etc2Rgba: 0x9278, etc2SrgbRgba: 0x9279 } };
  const etc1sEtc2Tex = await ktx2.parse(etc1sKtx2);
  assert.equal(etc1sEtc2Tex.compressed, true);
  assert.equal(etc1sEtc2Tex.formatId, 'etc2-rgba');
  assert.equal(etc1sEtc2Tex.mipmaps[0].data[0], 134);
  assert.equal(etc1sEtc2Tex.mipmaps[0].data[8], 16 << 3);

  assert.equal(getMadeTextureCapabilities().loaded, true);
  await assert.rejects(ktx2.parse(new Uint8Array([0xab, 0x4b, 0x54, 0x58])), /KTX2|truncado|inválido|MadeTexture/i);
  ktx2.dispose();
});




