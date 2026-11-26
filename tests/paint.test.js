import test from 'node:test';
import assert from 'node:assert/strict';
import * as MadeCore from '../made3d.module.js';
import {
  BoxGeometry,
  SphereGeometry,
  CylinderGeometry,
  StandardMaterial,
  Mesh,
  PerspectiveCamera,
  Scene,
  HistoryManager,
} from '../made3d.module.js';
import {
  SkinnedMesh,
  Bone,
  Skeleton,
} from '../src/modules/rigging.js';
import {
  Painter,
  PAINT_TOOLS,
  PAINT_SYMMETRIES,
  PAINT_MODES,
  PAINT_RESOLUTIONS,
  hasOverlappingOrMissingUVs,
  unwrapBoxAtlas,
  rgbToHex,
} from '../src/modules/paint.js';

function createFrontCamera() {
  const cam = new PerspectiveCamera(50, 1, 0.1, 100);
  cam.position.set(0, 0, 4);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  return cam;
}

function readTexelAtUV(tex, uv) {
  const mip = tex.mipmaps[0];
  const u = ((uv.x % 1) + 1) % 1;
  const v = ((uv.y % 1) + 1) % 1;
  const x = Math.max(0, Math.min(mip.width - 1, Math.floor(u * mip.width)));
  const y = Math.max(0, Math.min(mip.height - 1, Math.floor(v * mip.height)));
  const o = (y * mip.width + x) * 4;
  return [mip.data[o], mip.data[o + 1], mip.data[o + 2], mip.data[o + 3]];
}

test('Painter queda fuera del bundle core y se carga de forma perezosa mediante loadPaint()', async () => {
  assert.equal('Painter' in MadeCore, false);
  assert.equal(MadeCore.AVAILABLE_MODULES.includes('paint'), true);
  const mod = await MadeCore.loadPaint();
  assert.equal(mod.Painter, Painter);
  assert.ok(PAINT_TOOLS.includes('brush'));
  assert.ok(PAINT_TOOLS.includes('picker'));
  assert.ok(PAINT_SYMMETRIES.includes('x'));
  assert.ok(PAINT_MODES.includes('texture'));
  assert.ok(PAINT_MODES.includes('vertex'));
  assert.ok(PAINT_RESOLUTIONS.includes(512));
});

test('hasOverlappingOrMissingUVs y unwrapBoxAtlas corrigen BoxGeometry/CylinderGeometry sin alterar SphereGeometry', () => {
  const boxGeo = new BoxGeometry(2, 2, 2);
  assert.equal(hasOverlappingOrMissingUVs(boxGeo), true);
  unwrapBoxAtlas(boxGeo);
  assert.equal(hasOverlappingOrMissingUVs(boxGeo), false);

  const cylGeo = new CylinderGeometry(1, 1, 2, 16);
  assert.equal(hasOverlappingOrMissingUVs(cylGeo), true);
  unwrapBoxAtlas(cylGeo);
  assert.equal(hasOverlappingOrMissingUVs(cylGeo), false);

  const sphereGeo = new SphereGeometry(1, 16, 12);
  assert.equal(hasOverlappingOrMissingUVs(sphereGeo), false);
});

test('Trazo de pincel en modo textura hornea el color base del material y pinta texels exactamente en el punto de impacto', () => {
  const scene = new Scene();
  const cam = createFrontCamera();
  const mat = new StandardMaterial({ color: 0x3b82f6 });
  const mesh = new Mesh(new BoxGeometry(1.6, 1.6, 1.6), mat);
  scene.add(mesh);
  mesh.updateMatrixWorld(true);

  const painter = new Painter({
    tool: 'brush',
    color: '#ef4444',
    radius: 0.35,
    strength: 1.0,
    hardness: 0.9,
    resolution: 512,
  });

  const hit = painter.pickSurface(cam, 0, 0, [mesh]);
  assert.ok(hit && hit.uv);

  const started = painter.beginStroke(mesh, hit, cam, { scene });
  assert.equal(started, true);
  const res = painter.commitStroke();
  assert.ok(res && res.diff);
  assert.equal(res.diff.mode, 'texture');
  assert.ok(res.diff.indices.length > 10);

  // Material base baked into texture & color reset to white to avoid dark tint multiplication
  assert.equal(mesh.material.color.getHex(), 0xffffff);
  assert.ok(mesh.material.map?.userData?.isPaintTexture);
  assert.equal(mesh.material.map.flipY, false);

  const afterHit = painter.pickSurface(cam, 0, 0, [mesh]);
  assert.ok(afterHit && afterHit.uv);
  const painted = readTexelAtUV(mesh.material.map, afterHit.uv);
  assert.ok(painted[0] > 210 && painted[1] < 95 && painted[2] < 95, `Se esperaba rojo, obtenido ${painted}`);

  // Un píxel en una cara lateral fuera del radio mantiene el azul base horneado (#3b82f6 = 59, 130, 246)
  const sideHit = painter.pickSurface(cam, 0.35, 0.35, [mesh]);
  assert.ok(sideHit);
  const untouched = readTexelAtUV(mesh.material.map, sideHit.uv);
  assert.ok(untouched[2] > 200 && untouched[0] < 90, `Se esperaba azul base, obtenido ${untouched}`);
});

test('Herramientas airbrush, eraser, smudge, blur, fill y picker funcionan en modo textura', () => {
  const scene = new Scene();
  const cam = createFrontCamera();
  const mesh = new Mesh(new SphereGeometry(1, 24, 18), new StandardMaterial({ color: 0xe2e8f0 }));
  scene.add(mesh);
  mesh.updateMatrixWorld(true);

  const painter = new Painter({
    tool: 'brush',
    color: '#22c55e',
    radius: 0.4,
    strength: 1.0,
    hardness: 0.9,
    resolution: 512,
  });

  const hitCenter = painter.pickSurface(cam, 0, 0, [mesh]);
  assert.ok(hitCenter);
  painter.beginStroke(mesh, hitCenter, cam, { scene });
  painter.commitStroke();

  // Gotero lee el verde pintado
  painter.tool = 'picker';
  let pickedHex = null;
  painter.beginStroke(mesh, hitCenter, cam, {
    scene,
    onColorPick: (hex) => { pickedHex = hex; },
  });
  assert.ok(pickedHex);
  assert.equal(pickedHex, painter.color);
  const greenVal = parseInt(pickedHex.slice(3, 5), 16);
  const redVal = parseInt(pickedHex.slice(1, 3), 16);
  assert.ok(greenVal > 180 && redVal < 60, `Gotero leyó ${pickedHex}`);

  // Borrador restaura hacia el color base
  painter.tool = 'eraser';
  painter.beginStroke(mesh, hitCenter, cam, { scene });
  const eraseRes = painter.commitStroke();
  assert.ok(eraseRes && eraseRes.diff.indices.length > 0);
  const afterErase = readTexelAtUV(mesh.material.map, hitCenter.uv);
  assert.ok(afterErase[0] > 200 && afterErase[1] > 200 && afterErase[2] > 200, `Después de borrar: ${afterErase}`);

  // Spray, Mezclar y Difuminar modifican píxeles sin error
  for (const tool of ['airbrush', 'smudge', 'blur']) {
    painter.tool = tool;
    painter.setColor('#a855f7');
    assert.equal(painter.beginStroke(mesh, hitCenter, cam, { scene }), true);
    painter.stepStroke(cam, 0.08, 0.05);
    painter.commitStroke();
  }

  // Relleno de cubeta acotado
  painter.tool = 'fill';
  painter.setColor('#f59e0b');
  painter.beginStroke(mesh, hitCenter, cam, { scene });
  const fillRes = painter.commitStroke();
  assert.ok(fillRes && fillRes.diff.indices.length > 100);
});

test('Simetría en eje X pinta simultáneamente ambos lados de la esfera', () => {
  const scene = new Scene();
  const cam = createFrontCamera();
  const mesh = new Mesh(new SphereGeometry(1, 24, 18), new StandardMaterial({ color: 0xffffff }));
  scene.add(mesh);
  mesh.updateMatrixWorld(true);

  const painter = new Painter({
    tool: 'brush',
    color: '#ef4444',
    radius: 0.35,
    strength: 1.0,
    hardness: 0.9,
    symmetry: 'x',
    resolution: 512,
  });

  const rightHit = painter.pickSurface(cam, 0.25, 0, [mesh]);
  const leftHit = painter.pickSurface(cam, -0.25, 0, [mesh]);
  assert.ok(rightHit && leftHit);

  painter.beginStroke(mesh, rightHit, cam, { scene });
  painter.commitStroke();

  const rightPx = readTexelAtUV(mesh.material.map, rightHit.uv);
  const leftPx = readTexelAtUV(mesh.material.map, leftHit.uv);
  assert.ok(rightPx[0] > 200 && rightPx[1] < 90, `Lado derecho esperado rojo, obtenido ${rightPx}`);
  assert.ok(leftPx[0] > 200 && leftPx[1] < 90, `Lado simétrico izquierdo esperado rojo, obtenido ${leftPx}`);
});

test('Modo Vértices, fillAll, clearPaint, SkinnedMesh y HistoryManager undo/redo', () => {
  const scene = new Scene();
  const cam = createFrontCamera();
  const geo = new SphereGeometry(1, 20, 16);
  const root = new Bone('Root');
  const skel = new Skeleton([root]);
  const skinned = new SkinnedMesh(geo, new StandardMaterial({ color: 0x94a3b8 }));
  skinned.add(root);
  skinned.bind(skel);
  scene.add(skinned);
  skinned.updateMatrixWorld(true);

  const history = new HistoryManager();
  history.registerHandlers({ Painter });

  // 1) Pintura por vértices + Undo/Redo
  const painter = new Painter({
    paintMode: 'vertex',
    tool: 'brush',
    color: '#3b82f6',
    radius: 0.6,
    strength: 1.0,
    hardness: 0.9,
  });

  const hit = painter.pickSurface(cam, 0, 0, [skinned]);
  assert.ok(hit);
  painter.beginStroke(skinned, hit, cam, { scene });
  const vRes = painter.commitStroke();
  assert.ok(vRes && vRes.diff.mode === 'vertex');
  assert.ok(skinned.geometry.attributes.color);

  const colArr = skinned.geometry.attributes.color.array;
  const idx = vRes.diff.indices[0];
  const paintedHex = rgbToHex(colArr[idx * 4] * 255, colArr[idx * 4 + 1] * 255, colArr[idx * 4 + 2] * 255);
  assert.notEqual(paintedHex, '#94a3b8');

  history.push({
    type: 'paint',
    label: 'Pintar vértices',
    mesh: vRes.mesh,
    geometry: vRes.geometry,
    diff: vRes.diff,
  });

  assert.ok(history.undo());
  const undoneHex = rgbToHex(colArr[idx * 4] * 255, colArr[idx * 4 + 1] * 255, colArr[idx * 4 + 2] * 255);
  assert.equal(undoneHex, '#94a3b8');

  assert.ok(history.redo());
  const redoneHex = rgbToHex(colArr[idx * 4] * 255, colArr[idx * 4 + 1] * 255, colArr[idx * 4 + 2] * 255);
  assert.equal(redoneHex, paintedHex);

  // 2) Modo textura fillAll, resizePaintTexture y clearPaint en SkinnedMesh con color base del material
  const skelTexGeo = new SphereGeometry(1, 20, 16);
  const skinnedTex = new SkinnedMesh(skelTexGeo, new StandardMaterial({ color: 0x94a3b8 }));
  const rootTex = new Bone('RootTex');
  const skelTex = new Skeleton([rootTex]);
  skinnedTex.add(rootTex);
  skinnedTex.bind(skelTex);
  scene.add(skinnedTex);
  skinnedTex.updateMatrixWorld(true);

  painter.paintMode = 'texture';
  painter.resolution = 512;
  const fillRes = painter.fillAll(skinnedTex, '#22c55e', scene);
  assert.ok(fillRes && fillRes.diff.mode === 'texture');
  assert.equal(fillRes.texture.mipmaps[0].data[1], 197);

  history.push({
    type: 'paint',
    label: 'Relleno total',
    mesh: fillRes.mesh,
    geometry: fillRes.geometry,
    texture: fillRes.texture,
    diff: fillRes.diff,
  });

  const clearRes = painter.clearPaint(skinnedTex, scene);
  assert.ok(clearRes);
  assert.equal(clearRes.texture.mipmaps[0].data[0], 148); // #94a3b8 -> R=148

  const resized = Painter.resizePaintTexture(skinnedTex, 1024, scene);
  assert.ok(resized && resized.mipmaps[0].width === 1024 && resized.mipmaps[0].height === 1024);
});
