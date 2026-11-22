import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BoxGeometry,
  SphereGeometry,
  PyramidGeometry,
  ConeGeometry,
  StandardMaterial,
  Mesh,
  Scene,
  PerspectiveCamera,
  PointLight,
  DirectionalLight,
  Mat4,
  Vec3,
  Quat,
} from '../made3d.module.js';
import {
  EditableMesh,
  MeshEditor,
  catmullClarkStep,
  catmullClark,
  edgeKey,
  ensureEditableBase,
  setMeshSubsurf,
} from '../src/modules/modeling.js';
import { Sculptor } from '../src/modules/sculpt.js';
import { drawLightsOverlay, SelectionOutline } from '../src/modules/gizmo.js';

function countNonFlatEdges(em) {
  return em.getEdges().filter((e) => e.faces.length !== 2).length;
}

test('EditableMesh.fromGeometry suelda cubo a 8 vértices, 12 aristas y 6 quads sin huecos', () => {
  const em = EditableMesh.fromGeometry(new BoxGeometry(2, 2, 2));
  assert.equal(em.verts.length, 8);
  assert.equal(em.faces.length, 6);
  assert.equal(em.getEdges().length, 12);
  assert.equal(countNonFlatEdges(em), 0);
});

test('Edge Crease: asignación, promedio, remapeo y división de normales duras en toGeometry', () => {
  const em = EditableMesh.fromGeometry(new BoxGeometry(2, 2, 2));
  const edges = em.getEdges();

  const res = em.setSelectionCrease('edge', new Set([0, 1]), 1.0);
  assert.equal(res.changed, true);
  assert.equal(res.count, 2);
  assert.equal(em.getEdgeCrease(edges[0].a, edges[0].b), 1.0);
  assert.equal(em.getSelectionAverageCrease('edge', new Set([0, 1])), 1.0);
  assert.equal(em.getSelectionAverageCrease('edge', new Set([0, 2])), 0.5);

  // Sin aristas duras -> vértices compartidos por normal suave (solo divididos por costuras UV: 20 < 24)
  const smoothMesh = EditableMesh.fromGeometry(new BoxGeometry(2, 2, 2));
  const smoothGeo = smoothMesh.toGeometry({ flatShading: false });
  assert.equal(smoothGeo.attributes.position.count, 20);

  // Todas las aristas marcadas como duras -> divide normales en todas las esquinas (24 vértices)
  const allEdgeIndices = new Set(em.getEdges().map((_, idx) => idx));
  em.setSelectionCrease('edge', allEdgeIndices, 1.0);
  const splitGeo = em.toGeometry({ flatShading: false, creaseThreshold: 0.5 });
  assert.equal(splitGeo.attributes.position.count, 24);
});

test('SubdivisionSurface Catmull-Clark respeta dureza crease=1 frente a aristas lisas crease=0', () => {
  const sharpBox = EditableMesh.fromGeometry(new BoxGeometry(2, 2, 2));
  const sharpAll = new Set(sharpBox.getEdges().map((_, i) => i));
  sharpBox.setSelectionCrease('edge', sharpAll, 1.0);
  const subSharp = catmullClarkStep(sharpBox, 1.0);

  // Las esquinas originales de un cubo con todos sus filos crease=1 conservan su radio original
  let maxDistSharp = 0;
  for (let i = 0; i < 8; i++) {
    const v = subSharp.verts[i];
    maxDistSharp = Math.max(maxDistSharp, Math.hypot(v.x, v.y, v.z));
  }
  assert.ok(Math.abs(maxDistSharp - Math.sqrt(3)) < 1e-4);

  // Cubo liso (crease=0) se encoge suavemente hacia esfera
  const smoothBox = EditableMesh.fromGeometry(new BoxGeometry(2, 2, 2));
  const subSmooth = catmullClark(smoothBox, 2, 10000, 1.0);
  let maxDistSmooth = 0;
  for (let i = 0; i < 8; i++) {
    const v = subSmooth.verts[i];
    maxDistSmooth = Math.max(maxDistSmooth, Math.hypot(v.x, v.y, v.z));
  }
  assert.ok(maxDistSmooth < Math.sqrt(3) - 0.15);
  assert.equal(subSmooth.faces.length, 6 * 16);
});

test('bevelSelection crea bisel limpio en vértice, arista y cara con múltiples segmentos', () => {
  // 1. Bisel de arista con 2 segmentos
  const emEdge = EditableMesh.fromGeometry(new BoxGeometry(2, 2, 2));
  const resEdge = emEdge.bevelSelection('edge', new Set([0]), 0.15, 2);
  assert.equal(resEdge.changed, true);
  assert.ok(emEdge.faces.length > 6);
  assert.equal(countNonFlatEdges(emEdge), 0);

  // 2. Bisel de cara
  const emFace = EditableMesh.fromGeometry(new BoxGeometry(2, 2, 2));
  const resFace = emFace.bevelSelection('face', new Set([0]), 0.12, 1);
  assert.equal(resFace.changed, true);
  assert.ok(emFace.faces.length >= 10);
  assert.equal(countNonFlatEdges(emFace), 0);

  // 3. Bisel de vértice (chamfer corner)
  const emVert = EditableMesh.fromGeometry(new BoxGeometry(2, 2, 2));
  const resVert = emVert.bevelSelection('vertex', new Set([0]), 0.2, 1);
  assert.equal(resVert.changed, true);
  assert.equal(emVert.faces.length, 7);
  assert.equal(countNonFlatEdges(emVert), 0);
});

test('fillOrBridge rellena huecos abiertos y construye puente entre dos bucles', () => {
  // Relleno de hueco: quitar una cara de un cubo (queda 1 bucle abierto de 4 aristas) y rellenar
  const emFill = EditableMesh.fromGeometry(new BoxGeometry(2, 2, 2));
  emFill.faces.pop();
  emFill.faceUvs.pop();
  emFill.invalidateTopology();
  const boundaryEdgeIndices = new Set();
  emFill.getEdges().forEach((e, idx) => {
    if (e.faces.length === 1) boundaryEdgeIndices.add(idx);
  });
  assert.equal(boundaryEdgeIndices.size, 4);
  const fillRes = emFill.fillOrBridge('edge', boundaryEdgeIndices);
  assert.equal(fillRes.changed, true);
  assert.equal(fillRes.op, 'fill');
  assert.equal(emFill.faces.length, 6);
  assert.equal(countNonFlatEdges(emFill), 0);

  // Puente entre 2 quads enfrentados
  const verts = [
    { x: -1, y: -1, z: -1 }, { x: 1, y: -1, z: -1 }, { x: 1, y: 1, z: -1 }, { x: -1, y: 1, z: -1 },
    { x: -1, y: -1, z: 1 }, { x: 1, y: -1, z: 1 }, { x: 1, y: 1, z: 1 }, { x: -1, y: 1, z: 1 },
  ];
  const emBridge = new EditableMesh(verts, [[0, 1, 2, 3], [4, 7, 6, 5]]);
  const bridgeRes = emBridge.fillOrBridge('face', new Set([0, 1]));
  assert.equal(bridgeRes.changed, true);
  assert.equal(bridgeRes.op, 'bridge');
  assert.equal(bridgeRes.createdFaces, 4);
  assert.equal(emBridge.faces.length, 4);
});

test('mergeByDistance fusiona vértices duplicados y conserva/remapea dureza', () => {
  const verts = [
    { x: 0, y: 0, z: 0 },
    { x: 1, y: 0, z: 0 },
    { x: 1, y: 1, z: 0 },
    { x: 0, y: 1, z: 0 },
    { x: 1.001, y: 0, z: 0 }, // casi coincidente con v1
    { x: 2, y: 0, z: 0 },
    { x: 2, y: 1, z: 0 },
    { x: 1.001, y: 1, z: 0 }, // casi coincidente con v2
  ];
  const em = new EditableMesh(verts, [[0, 1, 2, 3], [4, 5, 6, 7]]);
  em.setEdgeCrease(1, 2, 0.8);
  const res = em.mergeByDistance(0.01);
  assert.equal(res.changed, true);
  assert.equal(res.mergedCount, 2);
  assert.equal(em.verts.length, 6);
  assert.equal(em.faces.length, 2);
  assert.ok(em.creases.has(edgeKey(1, 2)));
});

test('toGeometry mantiene diagonal estable al mover aristas de un cubo y corrige quads cóncavos', () => {
  const base = EditableMesh.fromGeometry(new BoxGeometry(1, 1, 1));
  const edge = base.getEdges().find((e) => {
    const a = base.verts[e.a];
    const b = base.verts[e.b];
    return Math.abs(a.y - 0.5) < 1e-4 && Math.abs(b.y - 0.5) < 1e-4 && Math.abs(a.z - 0.5) < 1e-4 && Math.abs(b.z - 0.5) < 1e-4;
  });
  assert.ok(edge);

  // Al mover una arista alrededor del vértice sin invertir el quad, la diagonal de las caras laterales no debe saltar
  const signatures = new Set();
  for (let angle = 0; angle < 360; angle += 45) {
    const rad = (angle * Math.PI) / 180;
    const dx = 0.22 * Math.cos(rad);
    const dy = 0.22 * Math.sin(rad);
    const dz = 0.12 * Math.sin(rad * 2);
    const clone = base.clone();
    clone.verts[edge.a].x += dx; clone.verts[edge.a].y += dy; clone.verts[edge.a].z += dz;
    clone.verts[edge.b].x += dx; clone.verts[edge.b].y += dy; clone.verts[edge.b].z += dz;
    const geo = clone.toGeometry({ flatShading: true });
    const pos = geo.attributes.position.array;
    const idx = geo.index.array;
    // Registrar qué vértice esquina se repite en los dos primeros triángulos (indica la diagonal)
    const tri0 = [idx[0], idx[1], idx[2]].map((i) => `${pos[i * 3].toFixed(2)},${pos[i * 3 + 1].toFixed(2)},${pos[i * 3 + 2].toFixed(2)}`);
    const tri1 = [idx[3], idx[4], idx[5]].map((i) => `${pos[i * 3].toFixed(2)},${pos[i * 3 + 1].toFixed(2)},${pos[i * 3 + 2].toFixed(2)}`);
    const shared = tri0.filter((k) => tri1.includes(k)).sort().join('|');
    assert.ok(shared.length > 0);
    signatures.add(tri0[0]);
  }
  assert.equal(signatures.size, 1);

  // Si un quad plano se deforma en forma cóncava (vértice 3 cruzando la diagonal 0-2), debe elegir la diagonal 1-3 válida
  const concave = new EditableMesh(
    [
      { x: 0, y: 0, z: 0 },
      { x: 2, y: 0, z: 0 },
      { x: 0, y: 2, z: 0 },
      { x: 0.4, y: 0.4, z: 0 },
    ],
    [[0, 1, 2, 3]]
  );
  const cGeo = concave.toGeometry({ flatShading: true });
  const cPos = cGeo.attributes.position.array;
  const cIdx = cGeo.index.array;
  for (let t = 0; t < cIdx.length; t += 3) {
    const a = cIdx[t] * 3, b = cIdx[t + 1] * 3, c = cIdx[t + 2] * 3;
    const nz = (cPos[b] - cPos[a]) * (cPos[c + 1] - cPos[a + 1]) - (cPos[b + 1] - cPos[a + 1]) * (cPos[c] - cPos[a]);
    assert.ok(nz > 0, `Triángulo ${t / 3} no debe invertir normal en quad cóncavo`);
  }
});

test('EditableMesh.mergeMeshes une cubos adyacentes eliminando caras interiores y dejando malla cerrada', () => {
  const cubeA = EditableMesh.fromGeometry(new BoxGeometry(1, 1, 1));
  const cubeB = EditableMesh.fromGeometry(new BoxGeometry(1, 1, 1));

  // Cubo A centrado en x=0 ([-0.5..0.5]) y Cubo B centrado en x=1 ([0.5..1.5])
  const matA = new Mat4().compose(new Vec3(0, 0, 0), new Quat(), new Vec3(1, 1, 1));
  const matB = new Mat4().compose(new Vec3(1, 0, 0), new Quat(), new Vec3(1, 1, 1));

  const res = EditableMesh.mergeMeshes([
    { editableMesh: cubeA, matrixWorld: matA },
    { editableMesh: cubeB, matrixWorld: matB },
  ], { targetMatrixWorld: matA, threshold: 0.01 });

  assert.equal(res.mergedVertices, 4);
  assert.equal(res.removedInteriorFaces, 2);
  assert.equal(res.mesh.verts.length, 12);
  assert.equal(res.mesh.faces.length, 10);
  assert.equal(countNonFlatEdges(res.mesh), 0);
});

test('weldShells cose uniones en T entre una cara grande y aristas partidas adyacentes', () => {
  // Quad grande en z=0 ([0..2] x [0..1]) junto a dos quads pequeños adyacentes sobre el borde superior ([0..1] y [1..2] en y=1..2)
  const verts = [
    { x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, { x: 2, y: 1, z: 0 }, { x: 0, y: 1, z: 0 },
    { x: 0, y: 1, z: 0 }, { x: 1, y: 1, z: 0 }, { x: 1, y: 2, z: 0 }, { x: 0, y: 2, z: 0 },
    { x: 1, y: 1, z: 0 }, { x: 2, y: 1, z: 0 }, { x: 2, y: 2, z: 0 }, { x: 1, y: 2, z: 0 },
  ];
  const em = new EditableMesh(verts, [
    [0, 1, 2, 3],
    [4, 5, 6, 7],
    [8, 9, 10, 11],
  ]);
  const res = em.weldShells({ threshold: 0.01, removeInteriorFaces: true, stitchTJunctions: true });
  assert.equal(res.changed, true);
  assert.ok(res.mergedVertices >= 4);
  assert.ok(res.stitchedEdges >= 1);
  // La cara inferior [0,1,2,3] debe haber recibido el vértice medio (1,1,0) quedando con 5 vértices
  assert.equal(em.faces[0].length, 5);
});

test('extrudeSelection mantiene aristas conectadas sin fallar al subdividir Catmull-Clark', () => {
  // 1. Extrusión de cara
  const boxFace = EditableMesh.fromGeometry(new BoxGeometry(1, 1, 1));
  const fRes = boxFace.extrudeSelection('face', new Set([0]), 0.35);
  assert.equal(fRes.changed, true);
  assert.equal(countNonFlatEdges(boxFace), 0);
  const sub1 = catmullClark(boxFace, 2, 10000, 1.0);
  assert.ok(sub1.faces.length > 0);
  assert.equal(countNonFlatEdges(sub1), 0);

  // 2. Extrusión de arista individual
  const boxEdge = EditableMesh.fromGeometry(new BoxGeometry(1, 1, 1));
  const eRes = boxEdge.extrudeSelection('edge', new Set([0]), 0.25);
  assert.equal(eRes.changed, true);
  assert.ok(boxEdge.getEdges().length > 12);
  const sub2 = catmullClark(boxEdge, 1, 10000, 1.0);
  assert.ok(sub2.faces.length > 0);

  // 3. Extrusión de vértice
  const boxVert = EditableMesh.fromGeometry(new BoxGeometry(1, 1, 1));
  const vRes = boxVert.extrudeSelection('vertex', new Set([0]), 0.2);
  assert.equal(vRes.changed, true);
  assert.ok(boxVert.getEdges().length > 12);
  const sub3 = catmullClark(boxVert, 1, 10000, 1.0);
  assert.ok(sub3.verts.length > 8);
});

test('subdivideSelection no colapsa vértices a verts[0] en cortes 1..4 ni en primitivas mixtas/N-gonos', () => {
  const verifyIntegrity = (em, label) => {
    for (const v of em.verts) {
      assert.ok(Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z), `${label}: vértice no finito`);
    }
    for (let fi = 0; fi < em.faces.length; fi++) {
      const f = em.faces[fi];
      assert.ok(f.length >= 3, `${label}: cara ${fi} degenerada`);
      const uniq = new Set(f);
      assert.equal(uniq.size, f.length, `${label}: cara ${fi} tiene vértices repetidos/colapsados`);
      const pts = f.map((vi) => em.verts[vi]);
      let maxEdgeSq = 0;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        maxEdgeSq = Math.max(maxEdgeSq, (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
      }
      assert.ok(maxEdgeSq > 1e-8, `${label}: cara ${fi} colapsada a un solo punto`);
    }
  };

  // Cubo con cortes 1..4
  for (let cuts = 1; cuts <= 4; cuts++) {
    const em = EditableMesh.fromGeometry(new BoxGeometry(2, 2, 2));
    const allFaces = new Set(em.faces.map((_, i) => i));
    const res = em.subdivideSelection('face', allFaces, cuts);
    assert.equal(res.changed, true);
    assert.equal(em.faces.length, 6 * (cuts + 1) * (cuts + 1));
    assert.equal(countNonFlatEdges(em), 0);
    verifyIntegrity(em, `cubo cortes=${cuts}`);
  }

  // Subdivisión parcial creando N-gonos en caras vecinas seguida de cuts=2
  const partial = EditableMesh.fromGeometry(new BoxGeometry(2, 2, 2));
  partial.subdivideSelection('face', new Set([0]), 2);
  verifyIntegrity(partial, 'cubo parcial cortes=2');
  const allPartial = new Set(partial.faces.map((_, i) => i));
  partial.subdivideSelection('face', allPartial, 2);
  verifyIntegrity(partial, 'cubo N-gono cortes=2');
  assert.equal(countNonFlatEdges(partial), 0);

  // Primitivas con triángulos y quads (Pirámide, Cono, Esfera)
  for (const [name, geo] of [
    ['pirámide', new PyramidGeometry(1.5, 1.5, 1.5)],
    ['cono', new ConeGeometry(1, 2, 12)],
    ['esfera', new SphereGeometry(1, 10, 8)],
  ]) {
    const em = EditableMesh.fromGeometry(geo);
    const allF = new Set(em.faces.map((_, i) => i));
    const res = em.subdivideSelection('face', allF, 2);
    assert.equal(res.changed, true);
    verifyIntegrity(em, `${name} cortes=2`);
  }
});

test('MeshEditor expone API de centroide local y actualización por eje', () => {
  const mesh = new Mesh(new BoxGeometry(2, 2, 2), new StandardMaterial({ color: 0xffffff }));
  const editor = new MeshEditor();
  editor.setMesh(mesh);
  editor.setSelectionMode('face');
  editor.setActiveSelectionSet(new Set([0]));

  const before = editor.getSelectionCentroidLocal();
  assert.ok(before);
  const targetX = before.x + 1.5;
  const ok = editor.setSelectionCentroidAxis('x', targetX);
  assert.equal(ok, true);
  const after = editor.getSelectionCentroidLocal();
  assert.ok(Math.abs(after.x - targetX) < 1e-5);
  assert.ok(Math.abs(after.y - before.y) < 1e-5);
});

test('drawLightsOverlay dibuja círculos cruzados para PointLight y rayos para DirectionalLight sin errores', () => {
  const scene = new Scene();
  const pt = new PointLight(0x5ea3ff, 5, 8, 2);
  pt.position.set(1, 2, 3);
  const dir = new DirectionalLight(0xffffff, 1);
  dir.position.set(-4, 6, 4);
  scene.add(pt, dir);

  const cam = new PerspectiveCamera(50, 16 / 9, 0.1, 100);
  cam.position.set(0, 2, 8);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld();

  let arcCount = 0;
  let strokeCount = 0;
  const noop = () => {};
  const mockCtx = {
    save: noop,
    restore: noop,
    beginPath: noop,
    moveTo: noop,
    lineTo: noop,
    arc: () => { arcCount++; },
    stroke: () => { strokeCount++; },
    fill: noop,
    setLineDash: noop,
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
  };

  drawLightsOverlay(mockCtx, cam, scene, 800, 450, { selected: pt });
  assert.ok(arcCount >= 2);
  assert.ok(strokeCount >= 4);
});

test('EditableMesh.mergeMeshes elimina caras y vértices interiores en mallas solapadas y fusiona vértices apilados', () => {
  const matA = new Mat4();
  const matB = new Mat4().compose(new Vec3(0.4, 0.25, 0), new Quat(), new Vec3(1, 1, 1));
  const resBoxes = EditableMesh.mergeMeshes(
    [
      { geometry: new BoxGeometry(1, 1, 1), matrixWorld: matA },
      { geometry: new BoxGeometry(1, 1, 1), matrixWorld: matB },
    ],
    { threshold: 0.015 }
  );
  assert.ok(resBoxes.mesh.faces.length > 0);
  assert.equal(countNonFlatEdges(resBoxes.mesh), 0);
  assert.ok(resBoxes.removedInteriorFaces > 0);

  // Ningún centroide de cara debe quedar estrictamente dentro de AMBOS cubos originales
  const strictlyInsideBothBoxes = (x, y, z) =>
    Math.abs(x) < 0.48 && Math.abs(y) < 0.48 && Math.abs(z) < 0.48 &&
    Math.abs(x - 0.4) < 0.48 && Math.abs(y - 0.25) < 0.48 && Math.abs(z) < 0.48;

  for (const f of resBoxes.mesh.faces) {
    let cx = 0, cy = 0, cz = 0;
    for (const vi of f) {
      const v = resBoxes.mesh.verts[vi];
      cx += v.x; cy += v.y; cz += v.z;
    }
    cx /= f.length; cy /= f.length; cz /= f.length;
    assert.equal(strictlyInsideBothBoxes(cx, cy, cz), false, 'No deben quedar caras interiores tras fusionar cubos solapados');
  }

  for (const v of resBoxes.mesh.verts) {
    assert.equal(strictlyInsideBothBoxes(v.x, v.y, v.z), false, 'No deben quedar vértices atrapados en el núcleo interior');
  }

  // Esferas solapadas
  const sphereMatB = new Mat4().compose(new Vec3(0.75, 0, 0), new Quat(), new Vec3(1, 1, 1));
  const resSpheres = EditableMesh.mergeMeshes(
    [
      { geometry: new SphereGeometry(1, 10, 8), matrixWorld: new Mat4() },
      { geometry: new SphereGeometry(1, 10, 8), matrixWorld: sphereMatB },
    ],
    { threshold: 0.015 }
  );
  assert.ok(resSpheres.mesh.faces.length > 0);
  assert.equal(countNonFlatEdges(resSpheres.mesh), 0);
  assert.ok(resSpheres.removedInteriorFaces > 0);

  // Fusión iterativa de múltiples vértices apilados en una misma esquina + encadenados dentro del umbral
  const stacked = new EditableMesh(
    [
      { x: 0, y: 0, z: 0 },        // 0: esquina base
      { x: 1, y: 0, z: 0 },        // 1
      { x: 1, y: 1, z: 0 },        // 2
      { x: 0, y: 1, z: 0 },        // 3
      { x: 0.002, y: 0, z: 0 },    // 4: apilado en (0,0,0)
      { x: 0.004, y: 0.002, z: 0 },// 5: encadenado
      { x: 0, y: 0.001, z: 0 },    // 6: apilado
      { x: 0, y: 0, z: 1 },        // 7
      { x: 0.001, y: 0, z: 0 },    // 8: vértice huérfano apilado
    ],
    [
      [0, 1, 2, 3],
      [4, 3, 7],
      [5, 6, 1],
    ]
  );
  const wRes = stacked.weldShells({ threshold: 0.01 });
  assert.ok(wRes.mergedVertices >= 4);
  assert.equal(stacked.verts.length, 5, 'Los vértices apilados y huérfanos deben colapsarse a los 5 vértices únicos');
});

test('Sculptor sincroniza la malla base al entrar a MeshEditor, al transformar caras y con Undo/Redo', () => {
  const mesh = new Mesh(new SphereGeometry(1, 12, 8), new StandardMaterial({ color: 0xffffff }));
  mesh.updateMatrixWorld();

  // Simula malla con subdivisiones previas antes de esculpir
  ensureEditableBase(mesh);
  setMeshSubsurf(mesh, { level: 1 });
  const beforeCount = mesh.geometry.attributes.position.count;
  assert.ok(beforeCount > 0);

  const sculptor = new Sculptor({ tool: 'draw', radius: 0.65, strength: 0.9, symmetry: 'none', frontFacesOnly: false });
  const cam = new PerspectiveCamera(50, 1, 0.1, 100);
  cam.position.set(0, 0, 5);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld();

  const hit = sculptor.pickSurface(cam, 0, 0, mesh);
  assert.ok(hit, 'Debe impactar la esfera');
  assert.equal(sculptor.beginStroke(mesh, hit, cam), true);
  sculptor.stepStroke(cam, 0.05, 0.04);
  assert.equal(mesh.geometry._modifiedBySculpt, true);
  assert.equal(mesh.geometry._isGeneratedSubsurf, false);
  sculptor.stepStroke(cam, 0.08, 0.06);
  const strokeRes = sculptor.endStroke();
  assert.ok(strokeRes && strokeRes.diff.indices.length > 0);
  assert.equal(mesh.geometry._isGeneratedSubsurf, false);

  // Entrar en modo edición y mover una cara lejana en el lado opuesto (-Z)
  const editor = new MeshEditor();
  editor.setMesh(mesh);
  const base = editor.baseMesh;
  assert.equal(mesh._subsurf.level, 0);

  // Verificar que los vértices frontales (+Z) conservan la deformación esculpida (radio > 1.08)
  const maxFrontRadiusBeforeEdit = base.verts.reduce((mx, v) => (v.z > 0.3 ? Math.max(mx, Math.hypot(v.x, v.y, v.z)) : mx), 0);
  assert.ok(maxFrontRadiusBeforeEdit > 1.05, `Esperado radio esculpido > 1.05, actual=${maxFrontRadiusBeforeEdit}`);

  // Seleccionar una cara trasera (-Z) y moverla: NO debe reiniciar la parte frontal esculpida
  const backFaceIdx = base.faces.findIndex((f) => f.every((vi) => base.verts[vi].z < -0.2));
  assert.ok(backFaceIdx >= 0);
  editor.setSelectionMode('face');
  editor.setActiveSelectionSet(new Set([backFaceIdx]));
  editor.translateSelectionLocal(0, 0, -0.25);

  const maxFrontRadiusAfterEdit = editor.baseMesh.verts.reduce((mx, v) => (v.z > 0.3 ? Math.max(mx, Math.hypot(v.x, v.y, v.z)) : mx), 0);
  assert.ok(
    Math.abs(maxFrontRadiusAfterEdit - maxFrontRadiusBeforeEdit) < 1e-4,
    'Mover una cara en Edición no debe reiniciar ni borrar la deformación esculpida'
  );

  // Undo y Redo del trazo manteniendo sincronizada baseMesh
  Sculptor.applyDiff(strokeRes.geometry, strokeRes.diff, false, mesh);
  const radiusAfterUndo = mesh._subsurf.baseMesh.verts.reduce((mx, v) => (v.z > 0.3 ? Math.max(mx, Math.hypot(v.x, v.y, v.z)) : mx), 0);
  assert.ok(radiusAfterUndo < maxFrontRadiusBeforeEdit - 0.03);

  Sculptor.applyDiff(strokeRes.geometry, strokeRes.diff, true, mesh);
  const radiusAfterRedo = mesh._subsurf.baseMesh.verts.reduce((mx, v) => (v.z > 0.3 ? Math.max(mx, Math.hypot(v.x, v.y, v.z)) : mx), 0);
  assert.ok(Math.abs(radiusAfterRedo - maxFrontRadiusBeforeEdit) < 0.02);
});

test('SelectionOutline.drawCanvas dibuja únicamente aristas de silueta exterior en Canvas 2D', () => {
  const outliner = new SelectionOutline();
  assert.equal(outliner.mode, 'canvas');

  const cam = new PerspectiveCamera(50, 16 / 9, 0.1, 100);
  cam.position.set(4, 3, 5);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld();

  const createMockCtx = () => {
    const strokes = [];
    let currentLines = 0;
    const noop = () => {};
    return {
      strokes,
      strokeStyle: '',
      lineWidth: 1,
      lineCap: 'butt',
      lineJoin: 'miter',
      globalAlpha: 1,
      shadowBlur: 0,
      save: noop,
      restore: noop,
      setLineDash: noop,
      beginPath: () => { currentLines = 0; },
      moveTo: noop,
      lineTo: () => { currentLines++; },
      stroke() { strokes.push({ color: this.strokeStyle, lines: currentLines }); },
    };
  };

  // Cubo en vista oblicua: exactamente 6 aristas forman el contorno exterior (sin diagonales de quads)
  const box = new Mesh(new BoxGeometry(2, 2, 2), new StandardMaterial({ color: 0xffffff }));
  box.updateMatrixWorld();

  const ctxSingle = createMockCtx();
  outliner.drawCanvas(ctxSingle, cam, [box], 800, 450);
  assert.equal(ctxSingle.strokes.length, 1);
  assert.equal(ctxSingle.strokes[0].color, '#f59e0b');
  assert.equal(ctxSingle.strokes[0].lines, 6, 'Un cubo visto en oblicuo debe dibujar exactamente 6 aristas de borde exterior');

  const ctxMulti = createMockCtx();
  outliner.drawCanvas(ctxMulti, cam, [box], 800, 450, { multiSelect: true });
  assert.equal(ctxMulti.strokes[0].color, '#facc15');

  // Esfera: debe trazar el aro exterior sin dibujar toda la malla interna ni costuras UV
  const sphere = new Mesh(new SphereGeometry(1, 16, 12), new StandardMaterial({ color: 0xffffff }));
  sphere.updateMatrixWorld();
  const ctxSphere = createMockCtx();
  outliner.drawCanvas(ctxSphere, cam, [sphere], 800, 450);
  assert.equal(ctxSphere.strokes.length, 1);
  assert.ok(ctxSphere.strokes[0].lines >= 12 && ctxSphere.strokes[0].lines < 120);
});




