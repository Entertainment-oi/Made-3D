import { Vec3 } from '../math/Vec3.js';

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

function _draw3DCircle(ctx, cx, cy, cz, r, plane, vMat, pMat, W, H) {
  const steps = 40;
  ctx.beginPath();
  let started = false;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const ca = Math.cos(a) * r;
    const sa = Math.sin(a) * r;
    let x = cx, y = cy, z = cz;
    if (plane === 'xy') { x += ca; y += sa; }
    else if (plane === 'yz') { y += ca; z += sa; }
    else { x += ca; z += sa; }
    const pt = _projectWorld(x, y, z, vMat, pMat, W, H);
    if (!pt) {
      started = false;
      continue;
    }
    if (!started) {
      ctx.moveTo(pt.x, pt.y);
      started = true;
    } else {
      ctx.lineTo(pt.x, pt.y);
    }
  }
  ctx.stroke();
}

/**
 * Dibuja en canvas 2D la visualización de luces de escena:
 * - PointLight: dos círculos ortogonales cruzados como cruz mostrando su rango y bombilla central.
 * - DirectionalLight: icono solar y línea punteada hacia su punto objetivo.
 */
export function drawLightsOverlay(ctx, camera, scene, W, H, options = {}) {
  if (!ctx || !camera || !scene) return;
  const opts = options instanceof Set ? { selectedSet: options } : (options || {});
  const selected = opts.selected || null;
  const selectedSet = opts.selectedSet || null;
  const multiSelectSet = opts.multiSelectSet || null;

  camera.updateWorldMatrix(true, false);
  const vMat = camera.viewMatrix;
  const pMat = camera.projectionMatrix;
  const lights = [];
  scene.traverse((n) => {
    if (n && n.visible && (n.isPointLight || n.isDirectionalLight)) lights.push(n);
  });
  if (!lights.length) return;

  ctx.save();
  for (const light of lights) {
    light.updateWorldMatrix(true, false);
    const mw = light.matrixWorld?.elements;
    if (!mw) continue;
    const lx = mw[12], ly = mw[13], lz = mw[14];
    const center = _projectWorld(lx, ly, lz, vMat, pMat, W, H);
    const isSel = Boolean(
      (selectedSet && selectedSet.has(light)) ||
      (selected && selected === light)
    );
    const isMulti = Boolean(isSel && multiSelectSet && multiSelectSet.size > 1);
    const col = light.color ? light.color.getStyle() : '#fde047';
    const strokeCol = isMulti ? '#facc15' : isSel ? '#f59e0b' : col;

    if (light.isPointLight) {
      const range = light.distance > 0 ? Math.min(40, light.distance) : 3.5;
      // Dos círculos ortogonales cruzados como cruz que muestran el rango de la luz puntual
      ctx.strokeStyle = strokeCol;
      ctx.globalAlpha = isSel ? 0.9 : 0.42;
      ctx.lineWidth = isSel ? 1.8 : 1.15;
      ctx.setLineDash([5, 4]);
      _draw3DCircle(ctx, lx, ly, lz, range, 'xy', vMat, pMat, W, H);
      _draw3DCircle(ctx, lx, ly, lz, range, 'yz', vMat, pMat, W, H);
      ctx.setLineDash([]);

      if (center) {
        ctx.globalAlpha = 0.95;
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(center.x, center.y, isSel ? 6 : 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = isSel ? '#fde047' : '#111215';
        ctx.lineWidth = 1.6;
        ctx.stroke();

        // Pequeño halo de bombilla
        ctx.strokeStyle = strokeCol;
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.arc(center.x, center.y, isSel ? 12 : 9, 0, Math.PI * 2);
        ctx.stroke();
      }
    } else if (light.isDirectionalLight) {
      const tgt = light.target || new Vec3();
      const ptTgt = _projectWorld(tgt.x, tgt.y, tgt.z, vMat, pMat, W, H);
      if (center) {
        if (ptTgt) {
          ctx.strokeStyle = strokeCol;
          ctx.globalAlpha = isSel ? 0.85 : 0.38;
          ctx.lineWidth = isSel ? 1.7 : 1.2;
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.moveTo(center.x, center.y);
          ctx.lineTo(ptTgt.x, ptTgt.y);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        ctx.globalAlpha = 0.95;
        ctx.strokeStyle = strokeCol;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(center.x, center.y, 7, 0, Math.PI * 2);
        ctx.stroke();
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          ctx.beginPath();
          ctx.moveTo(center.x + Math.cos(a) * 9, center.y + Math.sin(a) * 9);
          ctx.lineTo(center.x + Math.cos(a) * 13, center.y + Math.sin(a) * 13);
          ctx.stroke();
        }
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(center.x, center.y, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.restore();
}
