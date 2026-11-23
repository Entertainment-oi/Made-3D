import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BoxGeometry,
  SphereGeometry,
  CylinderGeometry,
  CapsuleGeometry,
  PyramidGeometry,
  ConeGeometry,
  TorusGeometry,
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
  restoreMeshModelingState,
  computeFaceShellIds,
  performVolumetricUnionIfNeeded,
  decimateMeshQEM,
  adjustMeshVertexDensity,
  canIncreaseMeshDensity,
  canDecreaseMeshDensity,
} from '../src/modules/modeling.js';
import { Sculptor, SCULPT_TOOLS } from '../src/modules/sculpt.js';
import { drawLightsOverlay, SelectionOutline, GizmoRenderer2D, beginDrag } from '../src/modules/gizmo.js';

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

test('bevelSelection vertex remapea índices tras podar vértices y extrudeSelection no duplica looseEdges puenteadas', () => {
  const emBevel = EditableMesh.fromGeometry(new BoxGeometry(2, 2, 2));
  const bv = emBevel.bevelSelection('vertex', new Set([0, 3]), 0.25, 1);
  assert.equal(bv.changed, true);
  assert.equal(bv.selected.size, 6);
  for (const vi of bv.selected) {
    assert.ok(vi >= 0 && vi < emBevel.verts.length);
  }
  assert.equal(countNonFlatEdges(emBevel), 0);

  const emExtrude = new EditableMesh(
    [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 1, y: 1, z: 0 },
      { x: 0, y: 1, z: 0 },
    ],
    [[0, 1, 2, 3]]
  );
  // 0-1 forman arista puente; comprobar que no quedan en looseEdges
  const ex1 = emExtrude.extrudeSelection('vertex', new Set([0, 1]), 0.5);
  assert.equal(ex1.changed, true);
  assert.equal(emExtrude.faces.length, 2);
  assert.equal(emExtrude.looseEdges.length, 0);

  // Vértice aislado sin arista compartida con otro seleccionado sí genera arista suelta
  const ex2 = emExtrude.extrudeSelection('vertex', new Set([2]), 0.5);
  assert.equal(ex2.changed, true);
  assert.equal(emExtrude.looseEdges.length, 1);
});

test('catmullClarkStep escala smoothness linealmente en vértices con 2 aristas crease y Sculptor guarda snapshot subsurf', () => {
  const base = EditableMesh.fromGeometry(new BoxGeometry(2, 2, 2));
  const edges = base.getEdges();
  // Seleccionar exactamente 2 aristas crease incidentes en el vértice 0
  const inc = [];
  for (const e of edges) {
    if (e.a === 0 || e.b === 0) inc.push(e);
    if (inc.length === 2) break;
  }
  base.setEdgeCrease(inc[0].a, inc[0].b, 1.0);
  base.setEdgeCrease(inc[1].a, inc[1].b, 1.0);

  const s0 = catmullClarkStep(base, 0.0).verts[0];
  const sHalf = catmullClarkStep(base, 0.5).verts[0];
  const s1 = catmullClarkStep(base, 1.0).verts[0];
  assert.ok(Math.abs(sHalf.x - (s0.x + s1.x) * 0.5) < 1e-6);
  assert.ok(Math.abs(sHalf.y - (s0.y + s1.y) * 0.5) < 1e-6);
  assert.ok(Math.abs(sHalf.z - (s0.z + s1.z) * 0.5) < 1e-6);

  // Verificar snapshot beforeState / afterState en Sculptor
  const mesh = new Mesh(new SphereGeometry(1, 10, 6), new StandardMaterial({ color: 0xffffff }));
  mesh.updateMatrixWorld();
  setMeshSubsurf(mesh, { level: 1 });
  const sculptor = new Sculptor({ tool: 'draw', radius: 0.6, strength: 0.8, frontFacesOnly: false });
  const cam = new PerspectiveCamera(50, 1, 0.1, 100);
  cam.position.set(0, 0, 5);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld();
  const hit = sculptor.pickSurface(cam, 0, 0, mesh);
  assert.ok(sculptor.beginStroke(mesh, hit, cam));
  const strokeRes = sculptor.endStroke();
  assert.equal(strokeRes.beforeState.subsurf.level, 1);
  assert.equal(strokeRes.afterState.subsurf.level, 0);

  // Verificar re-exportaciones en modules/modeling.js y modules/gizmo.js
  assert.equal(typeof computeFaceShellIds, 'function');
  assert.equal(typeof performVolumetricUnionIfNeeded, 'function');
  assert.equal(typeof GizmoRenderer2D, 'function');
  assert.equal(typeof beginDrag, 'function');
});

test('MeshEditor alinea el gizmo en espacio local a caras, aristas y vértices frente al modo mundo', () => {
  const mesh = new Mesh(new BoxGeometry(2, 2, 2), new StandardMaterial({ color: 0xffffff }));
  mesh.updateMatrixWorld();

  const editor = new MeshEditor();
  editor.setMesh(mesh);
  const base = editor.baseMesh;

  // Buscar la cara +X del cubo (normal (1, 0, 0))
  const facePosX = base.faces.findIndex((_, fi) => base.computeFaceNormal(fi).x > 0.9);
  assert.ok(facePosX >= 0);

  editor.setSelectionMode('face');
  editor.setActiveSelectionSet(new Set([facePosX]));

  // En modo mundo, los ejes coinciden con (1,0,0), (0,1,0), (0,0,1)
  editor.setSpace('world');
  const worldAx = editor.getGizmoAxes();
  assert.ok(worldAx.x.distanceTo(new Vec3(1, 0, 0)) < 1e-5);
  assert.ok(worldAx.y.distanceTo(new Vec3(0, 1, 0)) < 1e-5);
  assert.ok(worldAx.z.distanceTo(new Vec3(0, 0, 1)) < 1e-5);

  // En modo local sin rotar el objeto, el eje Z del gizmo debe apuntar a la normal de la cara (+X)
  editor.setSpace('local');
  const localFaceAx = editor.getGizmoAxes();
  assert.ok(localFaceAx.z.distanceTo(new Vec3(1, 0, 0)) < 1e-5);
  assert.ok(Math.abs(localFaceAx.x.dot(localFaceAx.y)) < 1e-5);
  assert.ok(Math.abs(localFaceAx.x.dot(localFaceAx.z)) < 1e-5);
  assert.ok(new Vec3().crossVectors(localFaceAx.x, localFaceAx.y).distanceTo(localFaceAx.z) < 1e-5);

  // Con el objeto rotado 90° en Y, la normal +X pasa a apuntar a -Z en mundo
  mesh.rotation.y = Math.PI / 2;
  mesh.updateMatrixWorld();
  const rotFaceAx = editor.getGizmoAxes();
  assert.ok(rotFaceAx.z.distanceTo(new Vec3(0, 0, -1)) < 1e-5);

  // Arista individual: X debe seguir la dirección de la arista en mundo
  mesh.rotation.y = 0;
  mesh.updateMatrixWorld();
  const edges = base.getEdges();
  const edgeYIdx = edges.findIndex((e) => {
    const a = base.verts[e.a];
    const b = base.verts[e.b];
    return Math.abs(a.x - b.x) < 1e-4 && Math.abs(a.z - b.z) < 1e-4 && Math.abs(a.y - b.y) > 1.5;
  });
  assert.ok(edgeYIdx >= 0);
  editor.setSelectionMode('edge');
  editor.setActiveSelectionSet(new Set([edgeYIdx]));
  const localEdgeAx = editor.getGizmoAxes();
  assert.ok(Math.abs(Math.abs(localEdgeAx.x.y) - 1) < 1e-5);
  assert.ok(Math.abs(localEdgeAx.x.dot(localEdgeAx.z)) < 1e-5);
  assert.ok(new Vec3().crossVectors(localEdgeAx.x, localEdgeAx.y).distanceTo(localEdgeAx.z) < 1e-5);

  // Vértice individual: Z apunta a la normal del vértice en esquina (+1,+1,+1)/sqrt(3)
  const cornerIdx = base.verts.findIndex((v) => v.x > 0.5 && v.y > 0.5 && v.z > 0.5);
  assert.ok(cornerIdx >= 0);
  editor.setSelectionMode('vertex');
  editor.setActiveSelectionSet(new Set([cornerIdx]));
  const localVertAx = editor.getGizmoAxes();
  const expectedCornerN = new Vec3(1, 1, 1).normalize();
  assert.ok(localVertAx.z.distanceTo(expectedCornerN) < 1e-5);
});

test('Sculptor incluye pinceles dedicados para hundir la malla (carve, crease, deflate) e inversión Alt', () => {
  assert.ok(SCULPT_TOOLS.includes('carve'));
  assert.ok(SCULPT_TOOLS.includes('crease'));
  assert.ok(SCULPT_TOOLS.includes('deflate'));

  const cam = new PerspectiveCamera(50, 1, 0.1, 100);
  cam.position.set(0, 0, 5);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld();

  for (const tool of ['carve', 'crease', 'deflate']) {
    const mesh = new Mesh(new SphereGeometry(1, 16, 12), new StandardMaterial({ color: 0xffffff }));
    mesh.updateMatrixWorld();
    const sculptor = new Sculptor({ tool, radius: 0.65, strength: 0.9, symmetry: 'none', frontFacesOnly: false });

    const hit = sculptor.pickSurface(cam, 0, 0, mesh);
    assert.ok(hit, `${tool}: debe impactar la esfera`);
    assert.equal(sculptor.beginStroke(mesh, hit, cam), true);
    sculptor.stepStroke(cam, 0.03, 0.02);
    const res = sculptor.endStroke();
    assert.ok(res && res.diff.indices.length > 0, `${tool}: debe modificar vértices`);

    const pos = mesh.geometry.attributes.position.array;
    let minFrontR = Infinity;
    for (let i = 0; i < pos.length; i += 3) {
      if (pos[i + 2] > 0.4) {
        minFrontR = Math.min(minFrontR, Math.hypot(pos[i], pos[i + 1], pos[i + 2]));
      }
    }
    assert.ok(minFrontR < 0.95, `${tool}: debe hundir la malla hacia el interior (minR=${minFrontR})`);

    // Con invert=true debe empujar hacia afuera en sentido opuesto
    const meshInv = new Mesh(new SphereGeometry(1, 16, 12), new StandardMaterial({ color: 0xffffff }));
    meshInv.updateMatrixWorld();
    const scInv = new Sculptor({ tool, radius: 0.65, strength: 0.9, invert: true, symmetry: 'none', frontFacesOnly: false });
    const hitInv = scInv.pickSurface(cam, 0, 0, meshInv);
    assert.ok(scInv.beginStroke(meshInv, hitInv, cam));
    scInv.stepStroke(cam, 0.03, 0.02);
    scInv.endStroke();
    const posInv = meshInv.geometry.attributes.position.array;
    let maxFrontR = 0;
    for (let i = 0; i < posInv.length; i += 3) {
      if (posInv[i + 2] > 0.4) {
        maxFrontR = Math.max(maxFrontR, Math.hypot(posInv[i], posInv[i + 1], posInv[i + 2]));
      }
    }
    assert.ok(maxFrontR > 1.04, `${tool} invertido: debe elevar la malla hacia afuera (maxR=${maxFrontR})`);
  }
});

test('EditableMesh.mergeMeshes genera fusión limpia sin diagonales falsas ni exceso de vértices/aristas', () => {
  // 1. Cubos coplanares alineados solapados -> un único prisma rectangular limpio (8 vértices, 12 aristas, 6 quads)
  const aligned = EditableMesh.mergeMeshes([
    { geometry: new BoxGeometry(1, 1, 1), matrixWorld: new Mat4() },
    { geometry: new BoxGeometry(1, 1, 1), matrixWorld: new Mat4().compose(new Vec3(0.5, 0, 0), new Quat(), new Vec3(1, 1, 1)) },
  ], { threshold: 0.015 });
  assert.equal(countNonFlatEdges(aligned.mesh), 0);
  assert.equal(aligned.mesh.verts.length, 8);
  assert.equal(aligned.mesh.getTopology().edges.length, 12);
  assert.equal(aligned.mesh.faces.length, 6);
  assert.ok(aligned.mesh.faces.every((f) => f.length === 4));

  // 2. Cubos solapados en XY con tapas coplanares -> conserva quads sin cortes en X ni triángulos redundantes
  const offsetXY = EditableMesh.mergeMeshes([
    { geometry: new BoxGeometry(1, 1, 1), matrixWorld: new Mat4() },
    { geometry: new BoxGeometry(1, 1, 1), matrixWorld: new Mat4().compose(new Vec3(0.4, 0.25, 0), new Quat(), new Vec3(1, 1, 1)) },
  ], { threshold: 0.015 });
  assert.equal(countNonFlatEdges(offsetXY.mesh), 0);
  assert.ok(offsetXY.mesh.verts.length <= 18);
  assert.ok(offsetXY.mesh.getTopology().edges.length <= 32);
  assert.equal(offsetXY.mesh.faces.filter((f) => f.length === 3).length, 0);

  // 3. Cubos solapados en los 3 ejes -> 20 vértices exactos y 18 quads limpios
  const cross3D = EditableMesh.mergeMeshes([
    { geometry: new BoxGeometry(1, 1, 1), matrixWorld: new Mat4() },
    { geometry: new BoxGeometry(1, 1, 1), matrixWorld: new Mat4().compose(new Vec3(0.4, 0.4, 0.4), new Quat(), new Vec3(1, 1, 1)) },
  ], { threshold: 0.015 });
  assert.equal(countNonFlatEdges(cross3D.mesh), 0);
  assert.equal(cross3D.mesh.verts.length, 20);
  assert.equal(cross3D.mesh.getTopology().edges.length, 36);
  assert.equal(cross3D.mesh.faces.length, 18);
  assert.ok(cross3D.mesh.faces.every((f) => f.length === 4));

  // 4. Cilindro atravesando caja -> sin cortes en las diagonales de pared y compatible con Catmull-Clark
  const cylBox = EditableMesh.mergeMeshes([
    { geometry: new BoxGeometry(1.2, 0.6, 1.2), matrixWorld: new Mat4() },
    { geometry: new CylinderGeometry(0.4, 0.4, 1.6, 16), matrixWorld: new Mat4().compose(new Vec3(0, 0.3, 0), new Quat(), new Vec3(1, 1, 1)) },
  ], { threshold: 0.015 });
  assert.equal(countNonFlatEdges(cylBox.mesh), 0);
  assert.ok(cylBox.mesh.verts.length <= 76);
  assert.ok(cylBox.mesh.getTopology().edges.length <= 160);
  assert.ok(cylBox.mesh.faces.filter((f) => f.length === 4).length >= 56);
  const cylSub = catmullClarkStep(cylBox.mesh, 1.0);
  assert.equal(countNonFlatEdges(cylSub), 0);

  // 5. Esferas solapadas -> conserva quads intactos fuera del anillo de intersección
  const spheres = EditableMesh.mergeMeshes([
    { geometry: new SphereGeometry(1, 10, 8), matrixWorld: new Mat4() },
    { geometry: new SphereGeometry(1, 10, 8), matrixWorld: new Mat4().compose(new Vec3(0.75, 0, 0), new Quat(), new Vec3(1, 1, 1)) },
  ], { threshold: 0.015 });
  assert.equal(countNonFlatEdges(spheres.mesh), 0);
  assert.ok(spheres.mesh.faces.filter((f) => f.length === 4).length >= 80);

  // 6. Control de solidez (0 = sin simplificación post-unión, 0.25 = conserva costuras entre mallas, 0.8/1 = fusión total)
  const solidPair = [
    { geometry: new BoxGeometry(1, 1, 1), matrixWorld: new Mat4() },
    { geometry: new BoxGeometry(1, 1, 1), matrixWorld: new Mat4().compose(new Vec3(0.5, 0, 0), new Quat(), new Vec3(1, 1, 1)) },
  ];
  const s0 = EditableMesh.mergeMeshes(solidPair, { threshold: 0.015, solidity: 0 });
  const s25 = EditableMesh.mergeMeshes(solidPair, { threshold: 0.015, solidity: 0.25 });
  const s80 = EditableMesh.mergeMeshes(solidPair, { threshold: 0.015, solidity: 0.8 });
  const s100 = EditableMesh.mergeMeshes(solidPair, { threshold: 0.015, solidity: 1.0 });

  assert.equal(countNonFlatEdges(s0.mesh), 0);
  assert.equal(countNonFlatEdges(s25.mesh), 0);
  assert.equal(countNonFlatEdges(s80.mesh), 0);
  assert.equal(countNonFlatEdges(s100.mesh), 0);

  assert.ok(s0.mesh.faces.length > s25.mesh.faces.length);
  assert.ok(s25.mesh.faces.length > s80.mesh.faces.length);
  assert.equal(s80.mesh.faces.length, 6);
  assert.equal(s100.mesh.faces.length, 6);
});

test('EditableMesh.mergeMeshes mantiene cierre 2-manifold en primitivas curvas/densas y seamSmooth suaviza el pegue', () => {
  const I = new Mat4();
  const tx = (x, y = 0, z = 0) => new Mat4().compose(new Vec3(x, y, z), new Quat(), new Vec3(1, 1, 1));
  const countSharpEdges = (em) => {
    const topo = em.getTopology();
    const fn = (fi) => {
      const f = em.faces[fi];
      const p0 = em.verts[f[0]], p1 = em.verts[f[1]], p2 = em.verts[f[2]];
      const e1 = [p1.x - p0.x, p1.y - p0.y, p1.z - p0.z];
      const e2 = [p2.x - p0.x, p2.y - p0.y, p2.z - p0.z];
      const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const l = Math.hypot(...n) || 1;
      return [n[0] / l, n[1] / l, n[2] / l];
    };
    let sharp = 0;
    for (const e of topo.edges) {
      if (e.faces.length !== 2) continue;
      const n0 = fn(e.faces[0]);
      const n1 = fn(e.faces[1]);
      if (n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2] < 0.7) sharp++;
    }
    return sharp;
  };

  const cases = [
    ['Esferas 28x20', new SphereGeometry(0.75, 28, 20), I, new SphereGeometry(0.75, 28, 20), tx(0.8)],
    ['Esferas 16x12', new SphereGeometry(1, 16, 12), I, new SphereGeometry(1, 16, 12), tx(0.7)],
    ['Esfera + Cilindro', new SphereGeometry(0.75, 28, 20), I, new CylinderGeometry(0.55, 0.55, 1.4, 28, 1), tx(0.65, 0.2)],
    ['Cápsula + Esfera', new CapsuleGeometry(0.42, 0.85, 8, 24), I, new SphereGeometry(0.75, 28, 20), tx(0.6, 0.1)],
    ['Esferas Arcilla 64x48', new SphereGeometry(0.95, 64, 48), I, new SphereGeometry(0.95, 64, 48), tx(0.9)],
  ];

  for (const [label, gA, mA, gB, mB] of cases) {
    const hard = EditableMesh.mergeMeshes([
      { geometry: gA, matrixWorld: mA },
      { geometry: gB, matrixWorld: mB },
    ], { targetMatrixWorld: mA, seamSmooth: 0 });
    assert.equal(countNonFlatEdges(hard.mesh), 0, `${label} seamSmooth=0 debe ser 2-manifold cerrado`);

    const smooth = EditableMesh.mergeMeshes([
      { geometry: gA, matrixWorld: mA },
      { geometry: gB, matrixWorld: mB },
    ], { targetMatrixWorld: mA, seamSmooth: 0.5 });
    assert.equal(countNonFlatEdges(smooth.mesh), 0, `${label} seamSmooth=0.5 debe ser 2-manifold cerrado`);

    const geo = smooth.mesh.toGeometry({ flatShading: false });
    const nrm = geo.attributes.normal.array;
    for (let i = 0; i < nrm.length; i++) {
      assert.ok(Number.isFinite(nrm[i]), `${label} normal[${i}] debe ser finita`);
    }
  }

  // Verificar reducción drástica de aristas agudas en costura de esferas con seamSmooth
  const hardSph = EditableMesh.mergeMeshes([
    { geometry: new SphereGeometry(0.75, 28, 20), matrixWorld: I },
    { geometry: new SphereGeometry(0.75, 28, 20), matrixWorld: tx(0.8) },
  ], { seamSmooth: 0 });
  const smoothSph = EditableMesh.mergeMeshes([
    { geometry: new SphereGeometry(0.75, 28, 20), matrixWorld: I },
    { geometry: new SphereGeometry(0.75, 28, 20), matrixWorld: tx(0.8) },
  ], { seamSmooth: 0.5 });
  assert.ok(countSharpEdges(smoothSph.mesh) < countSharpEdges(hardSph.mesh) * 0.5);

  // Cubos subdivididos Catmull-Clark horneados mantienen unión cerrada
  const subA = catmullClark(EditableMesh.fromGeometry(new BoxGeometry(1.2, 1.2, 1.2)), 2, 10000, 1);
  const subB = catmullClark(EditableMesh.fromGeometry(new BoxGeometry(1.2, 1.2, 1.2)), 2, 10000, 1);
  const subMerged = EditableMesh.mergeMeshes([
    { editableMesh: subA, matrixWorld: I },
    { editableMesh: subB, matrixWorld: tx(0.7, 0.2) },
  ], { targetMatrixWorld: I, seamSmooth: 0.5 });
  assert.equal(countNonFlatEdges(subMerged.mesh), 0);

  // toGeometry sobre N-gonos curvos no debe inyectar vértices sintéticos de centroide
  const pentagon = new EditableMesh([
    { x: 0, y: 0, z: 0 },
    { x: 1, y: 0, z: 0.05 },
    { x: 1.2, y: 0.9, z: 0 },
    { x: 0.5, y: 1.4, z: 0.08 },
    { x: -0.2, y: 0.8, z: 0 },
  ], [[0, 1, 2, 3, 4]]);
  const pGeo = pentagon.toGeometry({ flatShading: false });
  assert.equal(pGeo.attributes.position.count, 5);
});

test('smoothUnionSeam no pliega triángulos hacia atrás y performOrganicSdfUnion unifica en una sola malla todo-quads natural', () => {
  const I = new Mat4();
  const tx = (x, y = 0, z = 0) => new Mat4().compose(new Vec3(x, y, z), new Quat(), new Vec3(1, 1, 1));

  const minDihedralDot = (em) => {
    const topo = em.getTopology();
    const fn = (fi) => {
      const f = em.faces[fi];
      const p0 = em.verts[f[0]], p1 = em.verts[f[1]], p2 = em.verts[f[2]];
      const e1x = p1.x - p0.x, e1y = p1.y - p0.y, e1z = p1.z - p0.z;
      const e2x = p2.x - p0.x, e2y = p2.y - p0.y, e2z = p2.z - p0.z;
      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;
      const l = Math.hypot(nx, ny, nz) || 1;
      return [nx / l, ny / l, nz / l];
    };
    let minD = 1;
    for (const e of topo.edges) {
      if (e.faces.length !== 2) continue;
      const a = fn(e.faces[0]);
      const b = fn(e.faces[1]);
      const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      if (d < minD) minD = d;
    }
    return minD;
  };

  // 1. Ruta booleana con seamSmooth=0.5 y 1.0 no debe plegar caras hacia atrás (minDot > -0.25)
  const sphCyl = EditableMesh.mergeMeshes([
    { geometry: new SphereGeometry(0.75, 28, 20), matrixWorld: I },
    { geometry: new CylinderGeometry(0.55, 0.55, 1.4, 28, 1), matrixWorld: tx(0.65, 0.2) },
  ], { seamSmooth: 0.5, remeshOrganic: false });
  assert.equal(countNonFlatEdges(sphCyl.mesh), 0);
  assert.ok(minDihedralDot(sphCyl.mesh) > -0.25, `Sph+Cyl no debe tener pliegues invertidos (minDot=${minDihedralDot(sphCyl.mesh)})`);

  const boxesSmooth = EditableMesh.mergeMeshes([
    { geometry: new BoxGeometry(1, 1, 1), matrixWorld: I },
    { geometry: new BoxGeometry(1, 1, 1), matrixWorld: tx(0.4, 0.4, 0.4) },
  ], { seamSmooth: 0.8, remeshOrganic: false });
  assert.equal(countNonFlatEdges(boxesSmooth.mesh), 0);
  assert.ok(minDihedralDot(boxesSmooth.mesh) > -0.25, `Boxes3D no debe plegarse (minDot=${minDihedralDot(boxesSmooth.mesh)})`);

  // 2. Unión Orgánica SDF (remeshOrganic: true): limpia, 2-manifold cerrada, mayoría quads y sin miles de vértices redundantes
  const orgSpheres = EditableMesh.mergeMeshes([
    { geometry: new SphereGeometry(0.8, 28, 20), matrixWorld: I },
    { geometry: new SphereGeometry(0.8, 28, 20), matrixWorld: tx(0.85, 0, 0) },
  ], { seamSmooth: 0.5, remeshOrganic: true });
  assert.equal(countNonFlatEdges(orgSpheres.mesh), 0);
  assert.ok(orgSpheres.mesh.verts.length < 1500, `Debe reducir miles de vértices extra (actual=${orgSpheres.mesh.verts.length})`);
  assert.ok(orgSpheres.mesh.faces.length > 300);
  assert.ok(orgSpheres.mesh.faces.every((f) => f.length === 3 || f.length === 4), 'Unión orgánica simplificada debe contener solo tris y quads');
  const sphQuads = orgSpheres.mesh.faces.filter((f) => f.length === 4).length;
  assert.ok(sphQuads > orgSpheres.mesh.faces.length * 0.5, 'Unión orgánica simplificada debe mantener mayoría quads');
  assert.ok(minDihedralDot(orgSpheres.mesh) > 0.85, `Unión orgánica de esferas debe mantenerse suave (minDot=${minDihedralDot(orgSpheres.mesh)})`);

  // Con solidity=0 conserva la malla Surface Nets completa 100% quads
  const orgSpheresDense = EditableMesh.mergeMeshes([
    { geometry: new SphereGeometry(0.8, 28, 20), matrixWorld: I },
    { geometry: new SphereGeometry(0.8, 28, 20), matrixWorld: tx(0.85, 0, 0) },
  ], { seamSmooth: 0.5, remeshOrganic: true, solidity: 0 });
  assert.equal(countNonFlatEdges(orgSpheresDense.mesh), 0);
  assert.ok(orgSpheresDense.mesh.verts.length > 2500);
  assert.ok(orgSpheresDense.mesh.faces.every((f) => f.length === 4), 'solidity=0 debe generar malla 100% quads');

  const orgGeo = orgSpheres.mesh.toGeometry({ flatShading: false });
  const orgUv = orgGeo.attributes.uv.array;
  const orgNrm = orgGeo.attributes.normal.array;
  for (let i = 0; i < orgUv.length; i++) assert.ok(Number.isFinite(orgUv[i]));
  for (let i = 0; i < orgNrm.length; i++) assert.ok(Number.isFinite(orgNrm[i]));

  const orgSphCyl = EditableMesh.mergeMeshes([
    { geometry: new SphereGeometry(0.75, 28, 20), matrixWorld: I },
    { geometry: new CylinderGeometry(0.55, 0.55, 1.4, 28, 1), matrixWorld: tx(0.65, 0.2) },
  ], { seamSmooth: 0.5, remeshOrganic: true });
  assert.equal(countNonFlatEdges(orgSphCyl.mesh), 0);
  assert.ok(orgSphCyl.mesh.verts.length < 1500);
  assert.ok(orgSphCyl.mesh.faces.every((f) => f.length === 3 || f.length === 4));
  assert.ok(minDihedralDot(orgSphCyl.mesh) > 0.02, `Sph+Cyl orgánica sin pliegues (minDot=${minDihedralDot(orgSphCyl.mesh)})`);

  const orgCap = EditableMesh.mergeMeshes([
    { geometry: new CapsuleGeometry(0.42, 0.85, 8, 24), matrixWorld: I },
    { geometry: new SphereGeometry(0.75, 28, 20), matrixWorld: tx(0.6, 0.1) },
  ], { seamSmooth: 0.6, remeshOrganic: true });
  assert.equal(countNonFlatEdges(orgCap.mesh), 0);
  assert.ok(orgCap.mesh.verts.length < 1500);
  assert.ok(orgCap.mesh.faces.every((f) => f.length === 3 || f.length === 4));

  // 3. Planos abiertos con remeshOrganic=true hacen fallback seguro sin fallar ni vaciar la malla
  const openPlaneA = new EditableMesh(
    [{ x: -1, y: 0, z: -1 }, { x: 1, y: 0, z: -1 }, { x: 1, y: 0, z: 1 }, { x: -1, y: 0, z: 1 }],
    [[0, 1, 2, 3]]
  );
  const openPlaneB = new EditableMesh(
    [{ x: 0.5, y: 0, z: -1 }, { x: 2.5, y: 0, z: -1 }, { x: 2.5, y: 0, z: 1 }, { x: 0.5, y: 0, z: 1 }],
    [[0, 1, 2, 3]]
  );
  const fallbackRes = EditableMesh.mergeMeshes([
    { editableMesh: openPlaneA, matrixWorld: I },
    { editableMesh: openPlaneB, matrixWorld: I },
  ], { seamSmooth: 0.5, remeshOrganic: true });
  assert.ok(fallbackRes.mesh.faces.length >= 2);
});

test('decimateMeshQEM y MeshEditor.adjustVertexDensity agrandan y disminuyen la densidad conservando topología, UVs, bordes y Undo', () => {
  // 1. Malla abierta con UVs y crease -> decimateMeshQEM conserva bordes abiertos, UVs y durezas
  const grid = new EditableMesh(
    [
      { x: -1, y: 0, z: -1 }, { x: 0, y: 0, z: -1 }, { x: 1, y: 0, z: -1 },
      { x: -1, y: 0, z: 0 }, { x: 0, y: 0.15, z: 0 }, { x: 1, y: 0, z: 0 },
      { x: -1, y: 0, z: 1 }, { x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 1 },
    ],
    [
      [0, 3, 4, 1],
      [1, 4, 5, 2],
      [3, 6, 7, 4],
      [4, 7, 8, 5],
    ],
    [
      [[0, 0], [0, 0.5], [0.5, 0.5], [0.5, 0]],
      [[0.5, 0], [0.5, 0.5], [1, 0.5], [1, 0]],
      [[0, 0.5], [0, 1], [0.5, 1], [0.5, 0.5]],
      [[0.5, 0.5], [0.5, 1], [1, 1], [1, 0.5]],
    ]
  );
  const denseOpen = catmullClark(grid, 1, 10000, 0);
  const denseOpenBoundaryLen = denseOpen.getEdges().filter((e) => e.faces.length === 1).length;
  assert.ok(denseOpen.verts.length >= 25);
  assert.ok(denseOpenBoundaryLen >= 16);

  const openDec = decimateMeshQEM(denseOpen, 14, {
    preserveUvs: true,
    preserveCreases: true,
    protectBoundaries: true,
  });
  assert.equal(openDec.changed, true);
  assert.ok(denseOpen.verts.length < 25);
  assert.equal(denseOpen.getEdges().filter((e) => e.faces.length > 2).length, 0);
  assert.equal(denseOpen.faceUvs.length, denseOpen.faces.length);
  for (const fUv of denseOpen.faceUvs) {
    for (const uv of fUv) {
      assert.ok(Number.isFinite(uv[0]) && Number.isFinite(uv[1]));
    }
  }

  // 2. MeshEditor.adjustVertexDensity sobre cubo y esfera con Undo/Redo
  const sphereMesh = new Mesh(new SphereGeometry(1, 16, 12), new StandardMaterial({ color: 0xffffff }));
  const editor = new MeshEditor({ enabled: true });
  const commits = [];
  editor._attached = {
    onEditCommit: (rec) => commits.push(rec),
    onSelectionChange: () => {},
  };
  editor.setMesh(sphereMesh);

  const initVerts = editor.baseMesh.verts.length;
  assert.equal(canIncreaseMeshDensity(editor.baseMesh), true);
  assert.equal(canDecreaseMeshDensity(editor.baseMesh), true);

  // Disminuir densidad (-)
  const decRes = editor.adjustVertexDensity({ mode: 'dec' });
  assert.equal(decRes.changed, true);
  assert.ok(decRes.afterVerts < initVerts);
  assert.equal(countNonFlatEdges(editor.baseMesh), 0);

  // Agrandar densidad (+) desde estado reducido: recupera el objeto original recordado
  const incRestoreRes = editor.adjustVertexDensity({ mode: 'inc' });
  assert.equal(incRestoreRes.changed, true);
  assert.equal(incRestoreRes.afterVerts, initVerts);
  assert.equal(countNonFlatEdges(editor.baseMesh), 0);

  // Agrandar densidad (+) desde el original: subdivide en 100% quads
  const incAboveRes = editor.adjustVertexDensity({ mode: 'inc' });
  assert.equal(incAboveRes.changed, true);
  assert.ok(incAboveRes.afterVerts > initVerts);
  assert.equal(countNonFlatEdges(editor.baseMesh), 0);
  assert.ok(editor.baseMesh.faces.every((f) => f.length === 4), 'Incrementar densidad por encima del original debe producir 100% quads');

  // Escalado porcentual intermedio (~150% desde base reducida o actual)
  const preScaleVerts = editor.baseMesh.verts.length;
  const scaleDownRes = editor.adjustVertexDensity({ mode: 'scale', factor: 0.45 });
  assert.equal(scaleDownRes.changed, true);
  assert.ok(scaleDownRes.afterVerts < preScaleVerts);
  assert.equal(countNonFlatEdges(editor.baseMesh), 0);

  const scaleUpRes = editor.adjustVertexDensity({ mode: 'scale', factor: 1.5 });
  assert.equal(scaleUpRes.changed, true);
  assert.ok(scaleUpRes.afterVerts > scaleDownRes.afterVerts);
  assert.equal(countNonFlatEdges(editor.baseMesh), 0);

  // Verificar geometría de renderizado válida y compatibilidad Undo/Redo
  const geo = sphereMesh.geometry;
  const nrm = geo.attributes.normal.array;
  const uvs = geo.attributes.uv.array;
  for (let i = 0; i < nrm.length; i++) assert.ok(Number.isFinite(nrm[i]));
  for (let i = 0; i < uvs.length; i++) assert.ok(Number.isFinite(uvs[i]));

  assert.equal(commits.length, 5);
  restoreMeshModelingState(sphereMesh, commits[0].beforeState);
  assert.equal(editor.baseMesh.verts.length, initVerts);
  restoreMeshModelingState(sphereMesh, commits[4].afterState);
  assert.equal(editor.baseMesh.verts.length, scaleUpRes.afterVerts);

  // 3. Cubo pequeño: incrementar densidad con smoothness=0 conserva geometría exacta del cubo y sus creases
  const boxEm = EditableMesh.fromGeometry(new BoxGeometry(2, 2, 2));
  assert.equal(canDecreaseMeshDensity(boxEm), true);
  boxEm.setSelectionCrease('edge', new Set([0]), 1);
  const boxInc = adjustMeshVertexDensity(boxEm, { mode: 'inc' });
  assert.equal(boxInc.changed, true);
  assert.equal(boxEm.verts.length, 26);
  assert.equal(boxEm.faces.length, 24);
  assert.ok(boxEm.creases.size >= 2);
  for (const v of boxEm.verts) {
    assert.ok(Math.abs(v.x) <= 1.0001 && Math.abs(v.y) <= 1.0001 && Math.abs(v.z) <= 1.0001);
  }
});

test('adjustMeshVertexDensity recuerda el objeto inicial tras bajar densidad abismalmente y recuperarla', () => {
  // Malla detallada con relieve fino en superficie que se pierde al reducir drásticamente los vértices
  const detailed = catmullClark(EditableMesh.fromGeometry(new SphereGeometry(1, 12, 8)), 1, 10000, 1);
  for (let i = 0; i < detailed.verts.length; i++) {
    const v = detailed.verts[i];
    const bump = 1 + 0.12 * Math.sin(v.x * 6) * Math.cos(v.z * 6);
    v.x *= bump;
    v.y *= bump;
    v.z *= bump;
  }
  detailed.invalidateTopology();

  const origVerts = detailed.verts.length;
  const origFaces = detailed.faces.length;
  const origSnapshot = detailed.verts.map((v) => ({ x: v.x, y: v.y, z: v.z }));

  // Bajar densidad abismalmente en pasos (< 10% de los vértices originales)
  let decGuard = 0;
  while (detailed.verts.length > 8 && decGuard++ < 15) {
    const step = adjustMeshVertexDensity(detailed, { mode: 'dec' });
    if (!step.changed) break;
  }
  assert.ok(detailed.verts.length < origVerts * 0.1, `Se esperaba < 10% de ${origVerts} vértices, obtenido ${detailed.verts.length}`);
  assert.ok(detailed._densityOrigin);
  assert.equal(detailed._densityOrigin.verts.length, origVerts);

  // Subir gradualmente con mode='inc' debe reconstruir desde el origen (no subdividir la malla ultra baja)
  let guard = 0;
  while (detailed.verts.length < origVerts && guard++ < 25) {
    const step = adjustMeshVertexDensity(detailed, { mode: 'inc' });
    assert.equal(step.changed, true);
    assert.ok(step.afterVerts > step.beforeVerts);
  }
  assert.equal(detailed.verts.length, origVerts);
  assert.equal(detailed.faces.length, origFaces);
  for (let i = 0; i < origVerts; i++) {
    const d = Math.hypot(
      detailed.verts[i].x - origSnapshot[i].x,
      detailed.verts[i].y - origSnapshot[i].y,
      detailed.verts[i].z - origSnapshot[i].z
    );
    assert.ok(d < 1e-6, `Vértice ${i} debe restaurarse exactamente (diff=${d})`);
  }

  // Volver a bajar abismalmente y saltar directo a >100% y luego 100% con reference='origin'
  adjustMeshVertexDensity(detailed, { mode: 'scale', factor: 0.05, reference: 'origin' });
  assert.ok(detailed.verts.length < origVerts * 0.25);

  const overRes = adjustMeshVertexDensity(detailed, { mode: 'scale', factor: 1.5, reference: 'origin' });
  assert.equal(overRes.changed, true);
  assert.ok(detailed.verts.length > origVerts);

  const back100 = adjustMeshVertexDensity(detailed, { mode: 'scale', factor: 1.0, reference: 'origin' });
  assert.equal(back100.changed, true);
  assert.equal(detailed.verts.length, origVerts);
  assert.equal(detailed.faces.length, origFaces);

  // Si el usuario edita manualmente después de reducir densidad, el nuevo estado editado reemplaza el origen
  adjustMeshVertexDensity(detailed, { mode: 'target', targetVerts: 14 });
  assert.ok(detailed._densityOrigin);
  detailed.verts[0].x += 0.5;
  detailed.invalidateTopology();
  assert.equal(detailed._densityOrigin, null);
});

test('mergeMeshes no orgánico (remeshOrganic=false) produce topología limpia, sin esquirlas extremas y normales nítidas', () => {
  const I = new Mat4();
  const tx = (x, y = 0, z = 0) => new Mat4().compose(new Vec3(x, y, z), new Quat(), new Vec3(1, 1, 1));

  const inspectRenderStats = (mesh) => {
    const topo = mesh.getTopology();
    const fNormals = mesh.faces.map((f) => {
      let nx = 0, ny = 0, nz = 0;
      for (let k = 0; k < f.length; k++) {
        const a = mesh.verts[f[k]];
        const b = mesh.verts[f[(k + 1) % f.length]];
        nx += (a.y - b.y) * (a.z + b.z);
        ny += (a.z - b.z) * (a.x + b.x);
        nz += (a.x - b.x) * (a.y + b.y);
      }
      const l = Math.hypot(nx, ny, nz) || 1;
      return [nx / l, ny / l, nz / l];
    });
    let minDihedralDot = 1;
    for (const e of topo.edges) {
      if (e.faces.length !== 2) continue;
      const a = fNormals[e.faces[0]];
      const b = fNormals[e.faces[1]];
      const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      if (d < minDihedralDot) minDihedralDot = d;
    }

    const geo = mesh.toGeometry({ flatShading: false });
    const pos = geo.attributes.position.array;
    const nrm = geo.attributes.normal.array;
    const idx = geo.index.array;
    let maxAspect = 0;
    let maxNormErrDeg = 0;
    let normErrGt30 = 0;
    for (let t = 0; t < idx.length; t += 3) {
      const ia = idx[t], ib = idx[t + 1], ic = idx[t + 2];
      const ax = pos[ia * 3], ay = pos[ia * 3 + 1], az = pos[ia * 3 + 2];
      const bx = pos[ib * 3], by = pos[ib * 3 + 1], bz = pos[ib * 3 + 2];
      const cx = pos[ic * 3], cy = pos[ic * 3 + 1], cz = pos[ic * 3 + 2];
      const la = Math.hypot(bx - ax, by - ay, bz - az);
      const lb = Math.hypot(cx - bx, cy - by, cz - bz);
      const lc = Math.hypot(ax - cx, ay - cy, az - cz);
      const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
      const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;
      const area2 = Math.hypot(nx, ny, nz);
      const maxL = Math.max(la, lb, lc);
      const asp = area2 > 1e-12 ? (maxL * maxL) / area2 : 99999;
      if (asp > maxAspect) maxAspect = asp;
      const unx = area2 > 1e-12 ? nx / area2 : 0;
      const uny = area2 > 1e-12 ? ny / area2 : 1;
      const unz = area2 > 1e-12 ? nz / area2 : 0;
      for (const iv of [ia, ib, ic]) {
        const vx = nrm[iv * 3], vy = nrm[iv * 3 + 1], vz = nrm[iv * 3 + 2];
        assert.ok(Number.isFinite(vx) && Number.isFinite(vy) && Number.isFinite(vz), 'Normal debe ser finita');
        const dot = Math.max(-1, Math.min(1, vx * unx + vy * uny + vz * unz));
        const deg = (Math.acos(dot) * 180) / Math.PI;
        if (deg > maxNormErrDeg) maxNormErrDeg = deg;
        if (deg > 30) normErrGt30++;
      }
    }
    return { minDihedralDot, maxAspect, maxNormErrDeg, normErrGt30 };
  };

  // 1. Cubos ortogonales con seamSmooth=0 y 0.5: caras planas nítidas en ss=0, bisel suave sin abultamientos ni pliegues en ss=0.5
  const boxesHard = EditableMesh.mergeMeshes([
    { geometry: new BoxGeometry(1.5, 1.5, 1.5), matrixWorld: I },
    { geometry: new BoxGeometry(1.5, 1.5, 1.5), matrixWorld: tx(0.7, 0.4, 0.5) },
  ], { remeshOrganic: false, seamSmooth: 0 });
  assert.equal(countNonFlatEdges(boxesHard.mesh), 0);
  const stBoxesHard = inspectRenderStats(boxesHard.mesh);
  assert.ok(stBoxesHard.maxNormErrDeg < 1e-3, `Box+Box ss=0 debe conservar esquinas planas nítidas (err=${stBoxesHard.maxNormErrDeg})`);
  assert.ok(stBoxesHard.maxAspect < 10);

  const boxesSmooth = EditableMesh.mergeMeshes([
    { geometry: new BoxGeometry(1.5, 1.5, 1.5), matrixWorld: I },
    { geometry: new BoxGeometry(1.5, 1.5, 1.5), matrixWorld: tx(0.7, 0.4, 0.5) },
  ], { remeshOrganic: false, seamSmooth: 0.5 });
  assert.equal(countNonFlatEdges(boxesSmooth.mesh), 0);
  const stBoxesSmooth = inspectRenderStats(boxesSmooth.mesh);
  assert.ok(stBoxesSmooth.minDihedralDot > -0.15, `Box+Box ss=0.5 sin pliegues (minDot=${stBoxesSmooth.minDihedralDot})`);
  assert.ok(stBoxesSmooth.maxAspect < 100, `Box+Box ss=0.5 sin agujas largas (maxAsp=${stBoxesSmooth.maxAspect})`);

  // 2. Caja + Esfera (hard-surface + curva): sin picos de ear-clipping ni sangrado de normales de bisel
  for (const ss of [0, 0.5]) {
    const boxSph = EditableMesh.mergeMeshes([
      { geometry: new BoxGeometry(1.6, 1.6, 1.6), matrixWorld: I },
      { geometry: new SphereGeometry(1, 24, 16), matrixWorld: tx(0.8, 0.4, 0.3) },
    ], { remeshOrganic: false, seamSmooth: ss });
    assert.equal(countNonFlatEdges(boxSph.mesh), 0);
    const st = inspectRenderStats(boxSph.mesh);
    assert.ok(st.minDihedralDot > -0.25, `Box+Sph ss=${ss} sin pliegues`);
    assert.ok(st.maxAspect < 60, `Box+Sph ss=${ss} aspect limpio (${st.maxAspect})`);
    if (ss === 0) {
      assert.equal(st.normErrGt30, 0, 'Box+Sph ss=0 sin picos normales > 30°');
    }
  }

  // 3. Primitivas curvas/cilíndricas con seamSmooth=0.5: sin tiras gigantes estiradas
  const mCyl = new Mat4().compose(new Vec3(0.6, 0, 0), new Quat().setFromAxisAngle(new Vec3(0, 0, 1), 0.4), new Vec3(1, 1, 1));
  const sphCyl = EditableMesh.mergeMeshes([
    { geometry: new SphereGeometry(1, 24, 16), matrixWorld: I },
    { geometry: new CylinderGeometry(0.6, 0.6, 2.2, 20), matrixWorld: mCyl },
  ], { remeshOrganic: false, seamSmooth: 0.5 });
  assert.equal(countNonFlatEdges(sphCyl.mesh), 0);
  const stSphCyl = inspectRenderStats(sphCyl.mesh);
  assert.ok(stSphCyl.minDihedralDot > -0.25);
  assert.ok(stSphCyl.maxAspect < 350, `Sph+Cyl ss=0.5 sin tiras extremas (maxAsp=${stSphCyl.maxAspect})`);

  const mCylB = new Mat4().compose(new Vec3(0.3, 0.2, 0), new Quat().setFromAxisAngle(new Vec3(1, 0, 0), Math.PI / 2), new Vec3(1, 1, 1));
  const cylT = EditableMesh.mergeMeshes([
    { geometry: new CylinderGeometry(0.6, 0.6, 2.2, 20), matrixWorld: I },
    { geometry: new CylinderGeometry(0.5, 0.5, 2.0, 20), matrixWorld: mCylB },
  ], { remeshOrganic: false, seamSmooth: 0.5 });
  assert.equal(countNonFlatEdges(cylT.mesh), 0);
  const stCylT = inspectRenderStats(cylT.mesh);
  assert.ok(stCylT.minDihedralDot > -0.15);
  assert.ok(stCylT.maxAspect < 250, `Cyl+CylT ss=0.5 sin agujas (maxAsp=${stCylT.maxAspect})`);

  const torSph = EditableMesh.mergeMeshes([
    { geometry: new TorusGeometry(0.9, 0.35, 16, 24), matrixWorld: I },
    { geometry: new SphereGeometry(0.7, 20, 14), matrixWorld: tx(0.6, 0, 0) },
  ], { remeshOrganic: false, seamSmooth: 0.5 });
  assert.equal(countNonFlatEdges(torSph.mesh), 0);
  const stTorSph = inspectRenderStats(torSph.mesh);
  assert.ok(stTorSph.minDihedralDot > -0.1);
  assert.ok(stTorSph.maxAspect < 40);
});




