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
  PAINT_BRUSH_PRESETS,
  PAINT_SYMMETRIES,
  PAINT_MODES,
  PAINT_RESOLUTIONS,
  hasOverlappingOrMissingUVs,
  unwrapBoxAtlas,
  rgbToHex,
  rgbToHsv,
  hsvToRgb,
  hexToHsv,
  hsvToHex,
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

test('previewHoverAtCenter muestra el pincel al instante y resizePaintTexture interpola suavemente', () => {
  const scene = new Scene();
  const cam = createFrontCamera();
  const mesh = new Mesh(new BoxGeometry(1.6, 1.6, 1.6), new StandardMaterial({ color: 0xe2e8f0 }));
  scene.add(mesh);
  mesh.updateMatrixWorld(true);

  const painter = new Painter({
    tool: 'brush',
    color: '#2563eb',
    radius: 0.3,
    strength: 1.0,
    hardness: 0.6,
    resolution: 512,
  });

  // 1) Vista previa inmediata del pincel en el centro del modelo
  const initialHover = painter.previewHoverAtCenter(cam, [mesh]);
  assert.ok(initialHover && initialHover.mesh === mesh && painter.hover === initialHover);

  // 2) Trazo largo interpolado suavemente sin huecos entre puntos separados
  painter.beginStroke(mesh, initialHover, cam, { scene });
  const endHit = painter.stepStroke(cam, 0.22, 0.08);
  assert.ok(endHit);
  const res = painter.commitStroke();
  assert.ok(res && res.diff && res.diff.indices.length > 50);

  const midHit = painter.pickSurface(cam, 0.11, 0.04, [mesh]);
  assert.ok(midHit && midHit.uv);
  const midPx = readTexelAtUV(mesh.material.map, midHit.uv);
  assert.ok(midPx[2] > 180 && midPx[0] < 120, `Se esperaba azul continuo a mitad del trazo, obtenido ${midPx}`);

  // 3) Reescalado bilineal mantiene dimensiones y rango cromático válido
  const upscaled = Painter.resizePaintTexture(mesh, 1024, scene);
  assert.ok(upscaled && upscaled.mipmaps[0].width === 1024 && upscaled.mipmaps[0].height === 1024);
  const upPx = readTexelAtUV(upscaled, midHit.uv);
  assert.ok(upPx[2] > 170, `Textura reescalada conserva el color pintado, obtenido ${upPx}`);
});

test('Región sucia parcial (_dirtyRect), mipmaps diferidos y aceleración espacial 3D en malla densa', () => {
  const scene = new Scene();
  const cam = createFrontCamera();
  // Esfera densa (32x24 -> >1400 triángulos) para activar la cuadrícula espacial 3D
  const mesh = new Mesh(new SphereGeometry(1, 32, 24), new StandardMaterial({ color: 0xf1f5f9 }));
  scene.add(mesh);
  mesh.updateMatrixWorld(true);

  const painter = new Painter({
    tool: 'brush',
    color: '#ec4899',
    radius: 0.25,
    strength: 1.0,
    hardness: 0.8,
    isMobile: true,
  });
  assert.equal(painter.resolution, 512);

  const hit = painter.pickSurface(cam, 0, 0, [mesh]);
  assert.ok(hit && hit.uv && hit.faceIndex >= 0);

  const started = painter.beginStroke(mesh, hit, cam, { scene });
  assert.equal(started, true);

  const tex = mesh.material.map;
  assert.ok(tex._dirtyRect, 'Debe registrar un rectángulo sucio parcial tras el primer dab');
  assert.equal(tex._deferMipmaps, true, 'Debe diferir mipmaps durante el trazo activo');
  assert.ok(
    tex._dirtyRect.maxX - tex._dirtyRect.minX < 256,
    'El área sucia debe estar acotada alrededor del pincel y no cubrir toda la textura'
  );

  const prevRect = { ...tex._dirtyRect };
  const stepHit = painter.stepStroke(cam, 0.15, 0.08);
  assert.ok(stepHit && stepHit.uv);
  assert.ok(
    tex._dirtyRect.minX <= prevRect.minX && tex._dirtyRect.maxX >= prevRect.maxX,
    'Los dabs consecutivos amplían el rectángulo sucio acumulado'
  );

  const res = painter.commitStroke();
  assert.ok(res && res.diff && res.diff.indices.length > 20);
  assert.equal(tex._deferMipmaps, false, 'commitStroke debe restaurar la generación normal de mipmaps');
  assert.equal(tex._dirtyRect, null, 'commitStroke debe limpiar _dirtyRect tras disparar actualización completa');

  const endPx = readTexelAtUV(tex, stepHit.uv);
  assert.ok(endPx[0] > 200 && endPx[2] > 120, `Se esperaba rosa en el punto final, obtenido ${endPx}`);
});

test('Todos los tipos de pincel (PAINT_BRUSH_PRESETS) pintan con geometrías distintas y conversiones HSV precisas', () => {
  assert.ok(PAINT_BRUSH_PRESETS.includes('round'));
  assert.ok(PAINT_BRUSH_PRESETS.includes('hard'));
  assert.ok(PAINT_BRUSH_PRESETS.includes('soft'));
  assert.ok(PAINT_BRUSH_PRESETS.includes('chisel'));
  assert.ok(PAINT_BRUSH_PRESETS.includes('stipple'));
  assert.ok(PAINT_BRUSH_PRESETS.includes('splatter'));
  assert.ok(PAINT_BRUSH_PRESETS.includes('pixel'));
  assert.ok(PAINT_BRUSH_PRESETS.includes('rake'));

  // HSV round-trip
  for (const hex of ['#ef4444', '#22c55e', '#3b82f6', '#f59e0b', '#ffffff', '#000000', '#7c3aed']) {
    const hsv = hexToHsv(hex);
    const out = hsvToHex(hsv.h, hsv.s, hsv.v);
    assert.equal(out, hex, `HSV round-trip falló para ${hex}: ${out}`);
  }
  const [r, g, b] = hsvToRgb(240, 1, 1);
  assert.deepEqual([r, g, b], [0, 0, 255]);
  assert.equal(Math.round(rgbToHsv(0, 0, 255).h), 240);

  const scene = new Scene();
  const cam = createFrontCamera();
  const counts = {};

  for (const preset of PAINT_BRUSH_PRESETS) {
    const mesh = new Mesh(new BoxGeometry(1.6, 1.6, 1.6), new StandardMaterial({ color: 0xffffff }));
    scene.add(mesh);
    mesh.updateMatrixWorld(true);

    const painter = new Painter({
      tool: 'brush',
      brushPreset: preset,
      color: '#ef4444',
      radius: 0.35,
      strength: 1.0,
      hardness: 0.5,
      resolution: 512,
    });
    assert.equal(painter.brushPreset, preset);
    const hit = painter.pickSurface(cam, 0, 0, [mesh]);
    assert.ok(hit);
    assert.equal(painter.beginStroke(mesh, hit, cam, { scene }), true);
    painter.stepStroke(cam, 0.12, 0.05);
    const res = painter.commitStroke();
    assert.ok(res && res.diff && res.diff.indices.length > 10, `Preset ${preset} debe modificar texels`);
    counts[preset] = res.diff.indices.length;
  }

  // El pincel biselado / salpicadura / cerdas cubren menos área llena que el cuadrado píxel
  assert.ok(counts.pixel > counts.chisel, `pixel (${counts.pixel}) debe cubrir más que chisel (${counts.chisel})`);
  assert.ok(counts.hard > counts.splatter, `hard (${counts.hard}) debe cubrir más que splatter (${counts.splatter})`);

  // También funciona en modo vértices
  const vMesh = new Mesh(new SphereGeometry(1, 20, 16), new StandardMaterial({ color: 0xffffff }));
  scene.add(vMesh);
  vMesh.updateMatrixWorld(true);
  const vPainter = new Painter({ paintMode: 'vertex', tool: 'brush', brushPreset: 'rake', radius: 0.6, strength: 1 });
  const vHit = vPainter.pickSurface(cam, 0, 0, [vMesh]);
  assert.ok(vHit);
  vPainter.beginStroke(vMesh, vHit, cam, { scene });
  vPainter.stepStroke(cam, 0.15, 0.0);
  const vRes = vPainter.commitStroke();
  assert.ok(vRes && vRes.diff.indices.length > 0);
});

test('Segmentos cápsula continuos, buffer pool reutilizable en trazos consecutivos, cancelStroke y filtro suave', () => {
  const scene = new Scene();
  const cam = createFrontCamera();
  const mesh = new Mesh(new SphereGeometry(1, 32, 24), new StandardMaterial({ color: 0xffffff }));
  scene.add(mesh);
  mesh.updateMatrixWorld(true);

  const history = new HistoryManager();
  history.registerHandlers({ Painter });

  const painter = new Painter({
    tool: 'brush',
    brushPreset: 'round',
    color: '#ef4444',
    radius: 0.22,
    strength: 1.0,
    hardness: 0.75,
    isMobile: true,
  });

  // 1) Trazo rápido curvo por segmentos cápsula: todo punto intermedio recibe pigmento continuo sin huecos
  const startHit = painter.pickSurface(cam, -0.25, -0.1, [mesh]);
  assert.ok(startHit);
  assert.equal(painter.beginStroke(mesh, startHit, cam, { scene }), true);
  painter.stepStroke(cam, 0.0, 0.18);
  painter.stepStroke(cam, 0.25, -0.05);
  const res1 = painter.commitStroke();
  assert.ok(res1 && res1.diff && res1.diff.indices.length > 40);
  history.push({ type: 'paint', label: 'Trazo 1', mesh: res1.mesh, geometry: res1.geometry, texture: res1.texture, diff: res1.diff });

  for (const [nx, ny] of [[-0.12, 0.04], [0.0, 0.18], [0.12, 0.06]]) {
    const checkHit = painter.pickSurface(cam, nx, ny, [mesh]);
    assert.ok(checkHit && checkHit.uv);
    const px = readTexelAtUV(mesh.material.map, checkHit.uv);
    assert.ok(px[0] > 210 && px[1] < 100 && px[2] < 100, `Trazo continuo esperado rojo en (${nx},${ny}), obtenido ${px}`);
  }

  // 2) Segundo trazo con otro color reutilizando el pool de buffers + undo/redo exacto
  painter.setColor('#3b82f6');
  const h2 = painter.pickSurface(cam, 0.0, 0.18, [mesh]);
  assert.ok(h2);
  painter.beginStroke(mesh, h2, cam, { scene });
  painter.stepStroke(cam, 0.2, 0.2);
  const res2 = painter.commitStroke();
  assert.ok(res2 && res2.diff);
  history.push({ type: 'paint', label: 'Trazo 2', mesh: res2.mesh, geometry: res2.geometry, texture: res2.texture, diff: res2.diff });

  const bluePx = readTexelAtUV(mesh.material.map, h2.uv);
  assert.ok(bluePx[2] > 200 && bluePx[0] < 90, `Esperado azul antes de undo, obtenido ${bluePx}`);

  assert.ok(history.undo());
  const restoredRed = readTexelAtUV(mesh.material.map, h2.uv);
  assert.ok(restoredRed[0] > 210 && restoredRed[2] < 95, `Undo debe restaurar rojo previo, obtenido ${restoredRed}`);

  assert.ok(history.redo());
  const restoredBlue = readTexelAtUV(mesh.material.map, h2.uv);
  assert.ok(restoredBlue[2] > 200 && restoredBlue[0] < 90, `Redo debe restaurar azul, obtenido ${restoredBlue}`);

  // 3) cancelStroke revierte únicamente los texels modificados manteniendo trazos anteriores intactos
  painter.setColor('#22c55e');
  painter.beginStroke(mesh, h2, cam, { scene });
  painter.stepStroke(cam, -0.1, 0.15);
  assert.equal(painter.cancelStroke(), true);
  const afterCancel = readTexelAtUV(mesh.material.map, h2.uv);
  assert.ok(afterCancel[2] > 200 && afterCancel[0] < 90, `cancelStroke debe devolver el azul previo, obtenido ${afterCancel}`);

  // 4) Filtro adaptativo 1-Euro atenúa jitter a baja velocidad y sigue rápido a alta velocidad
  painter._smoothFilter = { x: 0, y: 0, t: 1000 };
  const slow = painter._filterStrokePoint(0.02, 0.02, 1100);
  assert.ok(slow.x > 0 && slow.x < 0.015, `A baja velocidad debe suavizar jitter: ${slow.x}`);
  painter._smoothFilter = { x: 0, y: 0, t: 1000 };
  const fast = painter._filterStrokePoint(0.5, 0.0, 1016);
  assert.ok(fast.x > 0.4, `A alta velocidad debe responder casi inmediato: ${fast.x}`);
});




