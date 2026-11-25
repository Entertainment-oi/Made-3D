function _projectWorld(wx, wy, wz, vMat, pMat, W, H) {
  const v = vMat?.elements;
  const p = pMat?.elements;
  if (!v || !p) return null;
  const vx = v[0] * wx + v[4] * wy + v[8] * wz + v[12];
  const vy = v[1] * wx + v[5] * wy + v[9] * wz + v[13];
  const vz = v[2] * wx + v[6] * wy + v[10] * wz + v[14];
  const vw = v[3] * wx + v[7] * wy + v[11] * wz + v[15];

  const cx = p[0] * vx + p[4] * vy + p[8] * vz + p[12] * vw;
  const cy = p[1] * vx + p[5] * vy + p[9] * vz + p[13] * vw;
  const cz = p[2] * vx + p[6] * vy + p[10] * vz + p[14] * vw;
  const cw = p[3] * vx + p[7] * vy + p[11] * vz + p[15] * vw;
  if (cw <= 1e-4) return null;
  const invW = 1 / cw;
  const ndcZ = cz * invW;
  if (ndcZ < -1 || ndcZ > 1.2) return null;
  return {
    x: (cx * invW * 0.5 + 0.5) * W,
    y: (0.5 - cy * invW * 0.5) * H,
    z: ndcZ,
  };
}

/**
 * Dibuja en canvas 2D un punto azul seleccionable para cada cámara visible de la escena
 * (equivalente al punto de luz para facilitar su selección directa en el visor).
 */
export function drawCamerasOverlay(ctx, camera, scene, W, H, options = {}) {
  if (!ctx || !camera || !scene) return;
  const opts = options instanceof Set ? { selectedSet: options } : (options || {});
  const selected = opts.selected || null;
  const selectedSet = opts.selectedSet || null;
  const multiSelectSet = opts.multiSelectSet || null;

  camera.updateWorldMatrix(true, false);
  const vMat = camera.viewMatrix;
  const pMat = camera.projectionMatrix;
  const cameras = [];
  scene.traverse((n) => {
    if (!n || !n.visible || !n.isCamera) return;
    const isSelf =
      n === camera ||
      n === camera.sourceCamera ||
      (camera.userData && n === camera.userData.sourceCamera);
    if (!isSelf) cameras.push(n);
  });
  if (!cameras.length) return;

  ctx.save();
  for (const cam of cameras) {
    cam.updateWorldMatrix(true, false);
    const mw = cam.matrixWorld?.elements;
    if (!mw) continue;
    const center = _projectWorld(mw[12], mw[13], mw[14], vMat, pMat, W, H);
    if (!center) continue;

    const isSel = Boolean(
      (selectedSet && selectedSet.has(cam)) ||
      (selected && selected === cam)
    );
    const isMulti = Boolean(isSel && multiSelectSet && multiSelectSet.size > 1);
    const ringColor = isMulti ? '#facc15' : isSel ? '#f59e0b' : '#38bdf8';

    ctx.globalAlpha = 0.96;
    ctx.fillStyle = '#3b82f6';
    ctx.beginPath();
    ctx.arc(center.x, center.y, isSel ? 6 : 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = isSel ? '#fde047' : '#0f172a';
    ctx.lineWidth = 1.6;
    ctx.stroke();

    ctx.strokeStyle = ringColor;
    ctx.lineWidth = isSel ? 1.8 : 1.3;
    ctx.beginPath();
    ctx.arc(center.x, center.y, isSel ? 12 : 9, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}
