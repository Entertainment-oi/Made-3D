// Ayudas de intersección que usan el picking de mallas, huesos y mallas con esqueleto.
// Los bucles usan números sueltos (x, y, z) para no crear objetos por vértice.

import { Vec3 } from '../math/Vec3.js';
import { Vec2 } from '../math/Vec2.js';
import { Mat4 } from '../math/Mat4.js';

const _invMat = new Mat4();

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

// Rayo contra caja alineada con los ejes (AABB). Devuelve true si el rayo la atraviesa.
export function rayBox(ox, oy, oz, dx, dy, dz, minX, minY, minZ, maxX, maxY, maxZ) {
  let tmin, tmax;
  if (dx >= 0) {
    const inv = 1 / (dx || 1e-20);
    tmin = (minX - ox) * inv;
    tmax = (maxX - ox) * inv;
  } else {
    const inv = 1 / dx;
    tmin = (maxX - ox) * inv;
    tmax = (minX - ox) * inv;
  }

  let tymin, tymax;
  if (dy >= 0) {
    const inv = 1 / (dy || 1e-20);
    tymin = (minY - oy) * inv;
    tymax = (maxY - oy) * inv;
  } else {
    const inv = 1 / dy;
    tymin = (maxY - oy) * inv;
    tymax = (minY - oy) * inv;
  }

  if (tmin > tymax || tymin > tmax) return false;
  if (tymin > tmin) tmin = tymin;
  if (tymax < tmax) tmax = tymax;

  let tzmin, tzmax;
  if (dz >= 0) {
    const inv = 1 / (dz || 1e-20);
    tzmin = (minZ - oz) * inv;
    tzmax = (maxZ - oz) * inv;
  } else {
    const inv = 1 / dz;
    tzmin = (maxZ - oz) * inv;
    tzmax = (minZ - oz) * inv;
  }

  if (tmin > tzmax || tzmin > tmax) return false;
  if (tzmax < tmax) tmax = tzmax;
  return tmax >= 0;
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
 * Optimizado estilo Three.js:
 * - Si no hay `worldPositions`, transforma el rayo UNA vez a espacio local, descarta contra el AABB
 *   local de la geometría y recorre triángulos sin multiplicar matrices por vértice.
 */
export function intersectGeometry(raycaster, intersects, geo, worldMatrix, object, extra, worldPositions) {
  if (!geo || !geo.attributes.position) return;
  const pos = geo.attributes.position, arr = pos.array;
  const idx = geo.index ? geo.index.array : null;
  const tris = idx ? (idx.length / 3) | 0 : (pos.count / 3) | 0;
  if (!tris) return;

  const r = raycaster.ray;
  const rox = r.origin.x, roy = r.origin.y, roz = r.origin.z;
  const rdx = r.direction.x, rdy = r.direction.y, rdz = r.direction.z;

  const mat = object.material;
  const side = mat ? mat.side : 'front';
  let cull = side === 'double' ? 'double' : side === 'back' ? 'back' : 'front';
  const uvAttr = geo.attributes.uv;
  const we = worldMatrix.elements;
  const near = raycaster.near, far = raycaster.far;

  if (!worldPositions) {
    // Transformar el rayo al espacio local de la malla UNA sola vez (evita N*3 productos de matriz).
    _invMat.copyInverse(worldMatrix);
    const ie = _invMat.elements;
    const ox = ie[0] * rox + ie[4] * roy + ie[8] * roz + ie[12];
    const oy = ie[1] * rox + ie[5] * roy + ie[9] * roz + ie[13];
    const oz = ie[2] * rox + ie[6] * roy + ie[10] * roz + ie[14];
    const dx = ie[0] * rdx + ie[4] * rdy + ie[8] * rdz;
    const dy = ie[1] * rdx + ie[5] * rdy + ie[9] * rdz;
    const dz = ie[2] * rdx + ie[6] * rdy + ie[10] * rdz;

    // Descarte rápido por AABB local antes de probar triángulos.
    const bb = geo.getBoundingBox ? geo.getBoundingBox() : null;
    if (bb && !rayBox(ox, oy, oz, dx, dy, dz, bb.min.x - 1e-4, bb.min.y - 1e-4, bb.min.z - 1e-4, bb.max.x + 1e-4, bb.max.y + 1e-4, bb.max.z + 1e-4)) {
      return;
    }

    // Si la escala tiene determinante negativo (espejo), se invierte el culling local.
    if (cull !== 'double') {
      const det3 = we[0] * (we[5] * we[10] - we[9] * we[6]) - we[4] * (we[1] * we[10] - we[9] * we[2]) + we[8] * (we[1] * we[6] - we[5] * we[2]);
      if (det3 < 0) cull = cull === 'front' ? 'back' : 'front';
    }

    for (let t = 0; t < tris; t++) {
      const t3 = t * 3;
      const ia = idx ? idx[t3] : t3, ib = idx ? idx[t3 + 1] : t3 + 1, ic = idx ? idx[t3 + 2] : t3 + 2;
      const a3 = ia * 3, b3 = ib * 3, c3 = ic * 3;
      const lax = arr[a3], lay = arr[a3 + 1], laz = arr[a3 + 2];
      const lbx = arr[b3], lby = arr[b3 + 1], lbz = arr[b3 + 2];
      const lcx = arr[c3], lcy = arr[c3 + 1], lcz = arr[c3 + 2];

      const hit = rayTriangle(ox, oy, oz, dx, dy, dz, lax, lay, laz, lbx, lby, lbz, lcx, lcy, lcz, cull);
      if (!hit) continue;

      const u = hit.u, v = hit.v, w = 1 - u - v;
      const lx = lax * w + lbx * u + lcx * v;
      const ly = lay * w + lby * u + lcy * v;
      const lz = laz * w + lbz * u + lcz * v;
      const wx = we[0] * lx + we[4] * ly + we[8] * lz + we[12];
      const wy = we[1] * lx + we[5] * ly + we[9] * lz + we[13];
      const wz = we[2] * lx + we[6] * ly + we[10] * lz + we[14];
      const distance = (wx - rox) * rdx + (wy - roy) * rdy + (wz - roz) * rdz;
      if (distance < near || distance > far) continue;

      // Normal local y mundial solo para los triángulos realmente impactados.
      const le1x = lbx - lax, le1y = lby - lay, le1z = lbz - laz;
      const le2x = lcx - lax, le2y = lcy - lay, le2z = lcz - laz;
      let fnx = le1y * le2z - le1z * le2y, fny = le1z * le2x - le1x * le2z, fnz = le1x * le2y - le1y * le2x;
      const fnl = Math.hypot(fnx, fny, fnz) || 1;
      fnx /= fnl; fny /= fnl; fnz /= fnl;

      // Normal en mundo = transpose(inv(M3)) * localNormal
      let wnx = ie[0] * fnx + ie[1] * fny + ie[2] * fnz;
      let wny = ie[4] * fnx + ie[5] * fny + ie[6] * fnz;
      let wnz = ie[8] * fnx + ie[9] * fny + ie[10] * fnz;
      const wnl = Math.hypot(wnx, wny, wnz) || 1;
      wnx /= wnl; wny /= wnl; wnz /= wnl;

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
    return;
  }

  // Ruta con vértices ya deformados en espacio mundial (SkinnedMesh).
  for (let t = 0; t < tris; t++) {
    const t3 = t * 3;
    const ia = idx ? idx[t3] : t3, ib = idx ? idx[t3 + 1] : t3 + 1, ic = idx ? idx[t3 + 2] : t3 + 2;
    const a3 = ia * 3, b3 = ib * 3, c3 = ic * 3;
    const ax = worldPositions[a3], ay = worldPositions[a3 + 1], az = worldPositions[a3 + 2];
    const bx = worldPositions[b3], by = worldPositions[b3 + 1], bz = worldPositions[b3 + 2];
    const cx = worldPositions[c3], cy = worldPositions[c3 + 1], cz = worldPositions[c3 + 2];

    const hit = rayTriangle(rox, roy, roz, rdx, rdy, rdz, ax, ay, az, bx, by, bz, cx, cy, cz, cull);
    if (!hit) continue;

    const u = hit.u, v = hit.v, w = 1 - u - v;
    const wx = ax * w + bx * u + cx * v, wy = ay * w + by * u + cy * v, wz = az * w + bz * u + cz * v;
    const distance = (wx - rox) * rdx + (wy - roy) * rdy + (wz - roz) * rdz;
    if (distance < near || distance > far) continue;

    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    let wnx = e1y * e2z - e1z * e2y, wny = e1z * e2x - e1x * e2z, wnz = e1x * e2y - e1y * e2x;
    const wnl = Math.hypot(wnx, wny, wnz) || 1;
    wnx /= wnl; wny /= wnl; wnz /= wnl;

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
      face: { a: ia, b: ib, c: ic, normal: new Vec3(wnx, wny, wnz), materialIndex: 0 },
      faceIndex: t,
      uv,
    };
    if (extra) Object.assign(res, extra);
    intersects.push(res);
  }
}
