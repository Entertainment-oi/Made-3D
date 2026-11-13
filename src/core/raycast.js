// Ayudas de intersección que usan el picking de mallas, huesos y mallas con esqueleto.
// Los bucles usan números sueltos (x, y, z) para no crear objetos por vértice.

import { Vec3 } from '../math/Vec3.js';
import { Vec2 } from '../math/Vec2.js';

/**
 * Intersección rayo-triángulo (Möller–Trumbore). Devuelve { t, u, v } o null.
 * `cull`: 'front' (solo caras delanteras), 'back' (solo traseras) o 'double' (todas).
 * El convenio de giro es antihorario (CCW): la normal de la cara es (b-a) × (c-a).
 */
export function rayTriangle(ox, oy, oz, dx, dy, dz, ax, ay, az, bx, by, bz, cx, cy, cz, cull) {
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (det > -1e-12 && det < 1e-12) return null;      // rayo paralelo al plano del triángulo
  if (cull === 'front' && det < 0) return null;      // cara trasera
  if (cull === 'back' && det > 0) return null;       // cara delantera
  const inv = 1 / det;
  const tx = ox - ax, ty = oy - ay, tz = oz - az;
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < -1e-6 || u > 1 + 1e-6) return null;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < -1e-6 || u + v > 1 + 1e-6) return null;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  if (t < 0) return null;                             // el triángulo está detrás del origen del rayo
  return { t, u, v };
}

// Rayo contra esfera. Devuelve la distancia al primer impacto (o null si no hay).
export function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
  const mx = ox - cx, my = oy - cy, mz = oz - cz;
  const b = mx * dx + my * dy + mz * dz;
  const c = mx * mx + my * my + mz * mz - r * r;
  if (c > 0 && b > 0) return null;                    // la esfera está detrás del rayo
  const disc = b * b - c;
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  let t = -b - s;
  if (t < 0) t = -b + s;
  return t < 0 ? null : t;
}

// Distancia en pantalla (2D) de un punto al segmento (a, b).
// Devuelve { t, d }: t es la posición dentro del segmento (0..1) y d la distancia en píxeles.
export function pointSegment2D(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const len2 = vx * vx + vy * vy;
  let t = len2 > 0 ? ((px - ax) * vx + (py - ay) * vy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - (ax + vx * t), dy = py - (ay + vy * t);
  return { t, d: Math.hypot(dx, dy) };
}

/**
 * Lanza el rayo contra los triángulos de una geometría y añade los impactos a `intersects`.
 * `worldMatrix` coloca la geometría en el mundo (la de la malla, o la de una instancia).
 * `worldPositions` (opcional) sustituye a la geometría: un Float32Array con las posiciones ya
 * deformadas en el mundo (es lo que usa el picking de las mallas con esqueleto).
 * `extra` se copia en cada impacto (por ejemplo { instanceId: 3 }).
 */
export function intersectGeometry(raycaster, intersects, geo, worldMatrix, object, extra, worldPositions) {
  if (!geo || !geo.attributes.position) return;
  const pos = geo.attributes.position, arr = pos.array;
  const idx = geo.index ? geo.index.array : null;
  const tris = idx ? (idx.length / 3) | 0 : (pos.count / 3) | 0;
  if (!tris) return;

  const r = raycaster.ray;
  const ox = r.origin.x, oy = r.origin.y, oz = r.origin.z;
  const dx = r.direction.x, dy = r.direction.y, dz = r.direction.z;

  const mat = object.material;
  const side = mat ? mat.side : 'front';
  const cull = side === 'double' ? 'double' : side === 'back' ? 'back' : 'front';
  const uvAttr = geo.attributes.uv;
  const we = worldMatrix.elements;
  const near = raycaster.near, far = raycaster.far;

  for (let t = 0; t < tris; t++) {
    const ia = idx ? idx[t * 3] : t * 3, ib = idx ? idx[t * 3 + 1] : t * 3 + 1, ic = idx ? idx[t * 3 + 2] : t * 3 + 2;
    let ax, ay, az, bx, by, bz, cx, cy, cz;
    let lax = 0, lay = 0, laz = 0, lbx = 0, lby = 0, lbz = 0, lcx = 0, lcy = 0, lcz = 0;
    if (worldPositions) {
      ax = worldPositions[ia * 3]; ay = worldPositions[ia * 3 + 1]; az = worldPositions[ia * 3 + 2];
      bx = worldPositions[ib * 3]; by = worldPositions[ib * 3 + 1]; bz = worldPositions[ib * 3 + 2];
      cx = worldPositions[ic * 3]; cy = worldPositions[ic * 3 + 1]; cz = worldPositions[ic * 3 + 2];
    } else {
      lax = arr[ia * 3]; lay = arr[ia * 3 + 1]; laz = arr[ia * 3 + 2];
      lbx = arr[ib * 3]; lby = arr[ib * 3 + 1]; lbz = arr[ib * 3 + 2];
      lcx = arr[ic * 3]; lcy = arr[ic * 3 + 1]; lcz = arr[ic * 3 + 2];
      ax = we[0] * lax + we[4] * lay + we[8] * laz + we[12];
      ay = we[1] * lax + we[5] * lay + we[9] * laz + we[13];
      az = we[2] * lax + we[6] * lay + we[10] * laz + we[14];
      bx = we[0] * lbx + we[4] * lby + we[8] * lbz + we[12];
      by = we[1] * lbx + we[5] * lby + we[9] * lbz + we[13];
      bz = we[2] * lbx + we[6] * lby + we[10] * lbz + we[14];
      cx = we[0] * lcx + we[4] * lcy + we[8] * lcz + we[12];
      cy = we[1] * lcx + we[5] * lcy + we[9] * lcz + we[13];
      cz = we[2] * lcx + we[6] * lcy + we[10] * lcz + we[14];
    }
    const hit = rayTriangle(ox, oy, oz, dx, dy, dz, ax, ay, az, bx, by, bz, cx, cy, cz, cull);
    if (!hit) continue;

    // Punto impactado y distancia a lo largo del rayo.
    const u = hit.u, v = hit.v, w = 1 - u - v;
    const wx = ax * w + bx * u + cx * v, wy = ay * w + by * u + cy * v, wz = az * w + bz * u + cz * v;
    const distance = (wx - ox) * dx + (wy - oy) * dy + (wz - oz) * dz;
    if (distance < near || distance > far) continue;

    // Normal de la cara (en mundo porque ax..cz ya están en espacio mundial).
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    let wnx = e1y * e2z - e1z * e2y, wny = e1z * e2x - e1x * e2z, wnz = e1x * e2y - e1y * e2x;
    const wnl = Math.hypot(wnx, wny, wnz) || 1;
    wnx /= wnl; wny /= wnl; wnz /= wnl;

    let fnx = wnx, fny = wny, fnz = wnz;
    if (!worldPositions) {
      const le1x = lbx - lax, le1y = lby - lay, le1z = lbz - laz;
      const le2x = lcx - lax, le2y = lcy - lay, le2z = lcz - laz;
      fnx = le1y * le2z - le1z * le2y; fny = le1z * le2x - le1x * le2z; fnz = le1x * le2y - le1y * le2x;
      const fnl = Math.hypot(fnx, fny, fnz) || 1;
      fnx /= fnl; fny /= fnl; fnz /= fnl;
    }

    let uv = null;
    if (uvAttr) {
      const ua = uvAttr.array;
      uv = new Vec2(
        ua[ia * 2] * w + ua[ib * 2] * u + ua[ic * 2] * v,
        ua[ia * 2 + 1] * w + ua[ib * 2 + 1] * u + ua[ic * 2 + 1] * v);
    }

    const res = {
      object,
      distance,
      point: new Vec3(wx, wy, wz),
      normal: new Vec3(wnx, wny, wnz),
      face: { a: ia, b: ib, c: ic, normal: new Vec3(fnx, fny, fnz), materialIndex: 0 },
      faceIndex: t,
      uv,
    };
    if (extra) Object.assign(res, extra);
    intersects.push(res);
  }
}
