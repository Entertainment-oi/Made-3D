import { Geometry } from './Geometry.js';

function build(g, pos, nor, uv, idx) {
  g.setAttribute('position', pos, 3).setAttribute('normal', nor, 3).setAttribute('uv', uv, 2);
  g.setIndex(idx);
  return g;
}

export class BoxGeometry extends Geometry {
  constructor(width = 1, height = 1, depth = 1, wSeg = 1, hSeg = 1, dSeg = 1) {
    super();
    const ws = Math.max(1, Math.floor(wSeg));
    const hs = Math.max(1, Math.floor(hSeg));
    const ds = Math.max(1, Math.floor(dSeg));
    const h = [width / 2, height / 2, depth / 2];
    // [normal, eje u, eje v, segsU, segsV] con u × v = normal
    const faces = [
      [[1, 0, 0], [0, 0, -1], [0, 1, 0], ds, hs],
      [[-1, 0, 0], [0, 0, 1], [0, 1, 0], ds, hs],
      [[0, 1, 0], [1, 0, 0], [0, 0, -1], ws, ds],
      [[0, -1, 0], [1, 0, 0], [0, 0, 1], ws, ds],
      [[0, 0, 1], [1, 0, 0], [0, 1, 0], ws, hs],
      [[0, 0, -1], [-1, 0, 0], [0, 1, 0], ws, hs],
    ];
    const pos = [], nor = [], uv = [], idx = [];
    let vertexOffset = 0;
    for (const [n, u, v, segU, segV] of faces) {
      const hu = Math.abs(u[0]) * h[0] + Math.abs(u[1]) * h[1] + Math.abs(u[2]) * h[2];
      const hv = Math.abs(v[0]) * h[0] + Math.abs(v[1]) * h[1] + Math.abs(v[2]) * h[2];
      for (let j = 0; j <= segV; j++) {
        const tv = j / segV;
        const sv = tv * 2 - 1;
        for (let i = 0; i <= segU; i++) {
          const tu = i / segU;
          const su = tu * 2 - 1;
          for (let k = 0; k < 3; k++) {
            pos.push(n[k] * h[k] + u[k] * hu * su + v[k] * hv * sv);
          }
          nor.push(n[0], n[1], n[2]);
          uv.push(tu, tv);
        }
      }
      const stride = segU + 1;
      for (let j = 0; j < segV; j++) {
        for (let i = 0; i < segU; i++) {
          const a = vertexOffset + j * stride + i;
          const b = a + 1;
          const d = a + stride;
          const c = d + 1;
          idx.push(a, b, c, a, c, d);
        }
      }
      vertexOffset += (segU + 1) * (segV + 1);
    }
    build(this, pos, nor, uv, idx);
  }
}

export class PlaneGeometry extends Geometry {
  // Plano en XY mirando a +Z.
  constructor(width = 1, height = 1, wSeg = 1, hSeg = 1) {
    super();
    const ws = Math.max(1, Math.floor(wSeg));
    const hs = Math.max(1, Math.floor(hSeg));
    const pos = [], nor = [], uv = [], idx = [];
    for (let j = 0; j <= hs; j++) {
      for (let i = 0; i <= ws; i++) {
        pos.push((i / ws - 0.5) * width, (j / hs - 0.5) * height, 0);
        nor.push(0, 0, 1);
        uv.push(i / ws, j / hs);
      }
    }
    for (let j = 0; j < hs; j++) {
      for (let i = 0; i < ws; i++) {
        const a = j * (ws + 1) + i, b = a + 1, d = a + ws + 1, c = d + 1;
        idx.push(a, b, c, a, c, d);
      }
    }
    build(this, pos, nor, uv, idx);
  }
}

export class SphereGeometry extends Geometry {
  constructor(radius = 1, wSeg = 24, hSeg = 16) {
    super();
    const ws = Math.max(3, Math.floor(wSeg));
    const hs = Math.max(2, Math.floor(hSeg));
    const pos = [], nor = [], uv = [], idx = [], grid = [];
    for (let iy = 0; iy <= hs; iy++) {
      const row = [], v = iy / hs;
      for (let ix = 0; ix <= ws; ix++) {
        const u = ix / ws;
        const x = -Math.cos(u * Math.PI * 2) * Math.sin(v * Math.PI);
        const y = Math.cos(v * Math.PI);
        const z = Math.sin(u * Math.PI * 2) * Math.sin(v * Math.PI);
        pos.push(radius * x, radius * y, radius * z);
        nor.push(x, y, z);
        uv.push(u, 1 - v);
        row.push(pos.length / 3 - 1);
      }
      grid.push(row);
    }
    for (let iy = 0; iy < hs; iy++) {
      for (let ix = 0; ix < ws; ix++) {
        const a = grid[iy][ix + 1], b = grid[iy][ix], c = grid[iy + 1][ix], d = grid[iy + 1][ix + 1];
        if (iy !== 0) idx.push(a, b, d);
        if (iy !== hs - 1) idx.push(b, c, d);
      }
    }
    build(this, pos, nor, uv, idx);
  }
}

export class CylinderGeometry extends Geometry {
  constructor(
    radiusTop = 0.5,
    radiusBottom = 0.5,
    height = 1,
    radialSegments = 24,
    heightSegments = 1,
    openEnded = false,
    thetaStart = 0,
    thetaLength = Math.PI * 2
  ) {
    super();
    const rs = Math.max(3, Math.floor(radialSegments));
    const hs = Math.max(1, Math.floor(heightSegments));
    const halfH = height / 2;
    const slope = (radiusBottom - radiusTop) / (height || 1);
    const pos = [], nor = [], uv = [], idx = [], grid = [];

    for (let iy = 0; iy <= hs; iy++) {
      const row = [];
      const v = iy / hs;
      const r = radiusTop + v * (radiusBottom - radiusTop);
      const y = (0.5 - v) * height;
      for (let ix = 0; ix <= rs; ix++) {
        const u = ix / rs;
        const theta = thetaStart + u * thetaLength;
        const sinT = Math.sin(theta);
        const cosT = Math.cos(theta);
        pos.push(r * sinT, y, r * cosT);
        const nl = Math.hypot(sinT, slope, cosT) || 1;
        nor.push(sinT / nl, slope / nl, cosT / nl);
        uv.push(u, 1 - v);
        row.push(pos.length / 3 - 1);
      }
      grid.push(row);
    }

    for (let iy = 0; iy < hs; iy++) {
      for (let ix = 0; ix < rs; ix++) {
        const a = grid[iy][ix];
        const b = grid[iy + 1][ix];
        const c = grid[iy + 1][ix + 1];
        const d = grid[iy][ix + 1];
        if (!(iy === 0 && radiusTop === 0)) idx.push(a, b, d);
        if (!(iy === hs - 1 && radiusBottom === 0)) idx.push(b, c, d);
      }
    }

    const addCap = (top) => {
      const radius = top ? radiusTop : radiusBottom;
      if (radius <= 0) return;
      const sign = top ? 1 : -1;
      const y = halfH * sign;
      const centerIdx = pos.length / 3;
      pos.push(0, y, 0);
      nor.push(0, sign, 0);
      uv.push(0.5, 0.5);

      const ringStart = pos.length / 3;
      for (let ix = 0; ix <= rs; ix++) {
        const u = ix / rs;
        const theta = thetaStart + u * thetaLength;
        const sinT = Math.sin(theta);
        const cosT = Math.cos(theta);
        pos.push(radius * sinT, y, radius * cosT);
        nor.push(0, sign, 0);
        uv.push(sinT * 0.5 + 0.5, cosT * 0.5 * sign + 0.5);
      }
      for (let ix = 0; ix < rs; ix++) {
        const p1 = ringStart + ix;
        const p2 = ringStart + ix + 1;
        if (top) idx.push(centerIdx, p1, p2);
        else idx.push(centerIdx, p2, p1);
      }
    };

    if (!openEnded) {
      addCap(true);
      addCap(false);
    }
    build(this, pos, nor, uv, idx);
  }
}

export class ConeGeometry extends CylinderGeometry {
  constructor(
    radius = 0.5,
    height = 1,
    radialSegments = 24,
    heightSegments = 1,
    openEnded = false,
    thetaStart = 0,
    thetaLength = Math.PI * 2
  ) {
    super(0, radius, height, radialSegments, heightSegments, openEnded, thetaStart, thetaLength);
  }
}

export class CapsuleGeometry extends Geometry {
  constructor(radius = 0.4, length = 0.8, capSegments = 8, radialSegments = 20) {
    super();
    const cs = Math.max(2, Math.floor(capSegments));
    const rs = Math.max(3, Math.floor(radialSegments));
    const halfL = length * 0.5;
    const totalHeight = Math.max(1e-4, length + radius * 2);

    // Perfil de arriba hacia abajo: semiesfera superior + cilindro + semiesfera inferior
    const profile = [];
    for (let i = 0; i <= cs; i++) {
      const a = (i / cs) * (Math.PI * 0.5); // 0 (polo) .. pi/2 (ecuador)
      const nr = Math.sin(a);
      const ny = Math.cos(a);
      profile.push([nr * radius, halfL + ny * radius, nr, ny]);
    }
    for (let i = 0; i <= cs; i++) {
      const a = (i / cs) * (Math.PI * 0.5); // 0 (ecuador) .. pi/2 (polo inferior)
      const nr = Math.cos(a);
      const ny = -Math.sin(a);
      profile.push([nr * radius, -halfL + ny * radius, nr, ny]);
    }

    const pos = [], nor = [], uv = [], idx = [], grid = [];
    for (let iy = 0; iy < profile.length; iy++) {
      const [pr, py, pnr, pny] = profile[iy];
      const v = (py + halfL + radius) / totalHeight;
      const row = [];
      for (let ix = 0; ix <= rs; ix++) {
        const u = ix / rs;
        const theta = u * Math.PI * 2;
        const sinT = Math.sin(theta);
        const cosT = Math.cos(theta);
        pos.push(pr * sinT, py, pr * cosT);
        nor.push(pnr * sinT, pny, pnr * cosT);
        uv.push(u, v);
        row.push(pos.length / 3 - 1);
      }
      grid.push(row);
    }

    for (let iy = 0; iy < profile.length - 1; iy++) {
      for (let ix = 0; ix < rs; ix++) {
        const a = grid[iy][ix];
        const b = grid[iy + 1][ix];
        const c = grid[iy + 1][ix + 1];
        const d = grid[iy][ix + 1];
        if (iy !== 0) idx.push(a, b, d);
        if (iy !== profile.length - 2) idx.push(b, c, d);
      }
    }
    build(this, pos, nor, uv, idx);
  }
}

export class TorusGeometry extends Geometry {
  constructor(radius = 0.65, tube = 0.22, radialSegments = 16, tubularSegments = 36, arc = Math.PI * 2) {
    super();
    const rs = Math.max(3, Math.floor(radialSegments));
    const ts = Math.max(3, Math.floor(tubularSegments));
    const pos = [], nor = [], uv = [], idx = [];

    for (let j = 0; j <= rs; j++) {
      const v = (j / rs) * Math.PI * 2;
      const cosV = Math.cos(v);
      const sinV = Math.sin(v);
      for (let i = 0; i <= ts; i++) {
        const u = (i / ts) * arc;
        const cosU = Math.cos(u);
        const sinU = Math.sin(u);
        const cx = radius * cosU;
        const cy = radius * sinU;
        const px = (radius + tube * cosV) * cosU;
        const py = (radius + tube * cosV) * sinU;
        const pz = tube * sinV;
        pos.push(px, py, pz);
        const nx = px - cx, ny = py - cy, nz = pz;
        const nl = Math.hypot(nx, ny, nz) || 1;
        nor.push(nx / nl, ny / nl, nz / nl);
        uv.push(i / ts, j / rs);
      }
    }

    const stride = ts + 1;
    for (let j = 0; j < rs; j++) {
      for (let i = 0; i < ts; i++) {
        const a = j * stride + i;
        const d = a + 1;
        const b = a + stride;
        const c = b + 1;
        idx.push(a, d, b, d, c, b);
      }
    }
    build(this, pos, nor, uv, idx);
  }
}

export class TorusKnotGeometry extends Geometry {
  constructor(radius = 0.55, tube = 0.16, tubularSegments = 72, radialSegments = 12, p = 2, q = 3) {
    super();
    const ts = Math.max(12, Math.floor(tubularSegments));
    const rs = Math.max(3, Math.floor(radialSegments));
    const pos = [], nor = [], uv = [], idx = [];

    const evalCurve = (u) => {
      const cu = Math.cos(u), su = Math.sin(u);
      const quOverP = (q / p) * u;
      const cs = Math.cos(quOverP);
      const tx = radius * (2 + cs) * 0.5 * cu;
      const ty = radius * (2 + cs) * 0.5 * su;
      const tz = radius * Math.sin(quOverP) * 0.5;
      return [tx, ty, tz];
    };

    for (let i = 0; i <= ts; i++) {
      const u = (i / ts) * p * Math.PI * 2;
      const p1 = evalCurve(u);
      const p2 = evalCurve(u + 0.01);
      let Tx = p2[0] - p1[0], Ty = p2[1] - p1[1], Tz = p2[2] - p1[2];
      const tl = Math.hypot(Tx, Ty, Tz) || 1;
      Tx /= tl; Ty /= tl; Tz /= tl;

      let Nx = p1[0] + p2[0], Ny = p1[1] + p2[1], Nz = p1[2] + p2[2];
      let nl = Math.hypot(Nx, Ny, Nz);
      if (nl < 1e-5) { Nx = 0; Ny = 0; Nz = 1; } else { Nx /= nl; Ny /= nl; Nz /= nl; }
      // B = T × N, luego N = normalize(B × T) para marco ortonormal
      let Bx = Ty * Nz - Tz * Ny, By = Tz * Nx - Tx * Nz, Bz = Tx * Ny - Ty * Nx;
      const bl = Math.hypot(Bx, By, Bz) || 1;
      Bx /= bl; By /= bl; Bz /= bl;
      Nx = By * Tz - Bz * Ty; Ny = Bz * Tx - Bx * Tz; Nz = Bx * Ty - By * Tx;
      nl = Math.hypot(Nx, Ny, Nz) || 1;
      Nx /= nl; Ny /= nl; Nz /= nl;

      for (let j = 0; j <= rs; j++) {
        const v = (j / rs) * Math.PI * 2;
        const cv = -Math.cos(v);
        const sv = Math.sin(v);
        const nx = cv * Nx + sv * Bx;
        const ny = cv * Ny + sv * By;
        const nz = cv * Nz + sv * Bz;
        pos.push(p1[0] + tube * nx, p1[1] + tube * ny, p1[2] + tube * nz);
        nor.push(nx, ny, nz);
        uv.push(i / ts, j / rs);
      }
    }

    const stride = rs + 1;
    for (let i = 0; i < ts; i++) {
      for (let j = 0; j < rs; j++) {
        const a = i * stride + j;
        const b = (i + 1) * stride + j;
        const c = b + 1;
        const d = a + 1;
        idx.push(a, b, d, b, c, d);
      }
    }
    build(this, pos, nor, uv, idx);
  }
}

export class CircleGeometry extends Geometry {
  // Disco en XY mirando a +Z.
  constructor(radius = 0.75, segments = 24, thetaStart = 0, thetaLength = Math.PI * 2) {
    super();
    const seg = Math.max(3, Math.floor(segments));
    const pos = [0, 0, 0], nor = [0, 0, 1], uv = [0.5, 0.5], idx = [];
    for (let i = 0; i <= seg; i++) {
      const a = thetaStart + (i / seg) * thetaLength;
      const ca = Math.cos(a), sa = Math.sin(a);
      pos.push(radius * ca, radius * sa, 0);
      nor.push(0, 0, 1);
      uv.push(ca * 0.5 + 0.5, sa * 0.5 + 0.5);
    }
    for (let i = 1; i <= seg; i++) {
      idx.push(0, i, i + 1);
    }
    build(this, pos, nor, uv, idx);
  }
}

export class RingGeometry extends Geometry {
  // Anillo en XY mirando a +Z.
  constructor(innerRadius = 0.35, outerRadius = 0.75, thetaSegments = 24, phiSegments = 1, thetaStart = 0, thetaLength = Math.PI * 2) {
    super();
    const ts = Math.max(3, Math.floor(thetaSegments));
    const ps = Math.max(1, Math.floor(phiSegments));
    const pos = [], nor = [], uv = [], idx = [];
    const maxR = Math.max(1e-5, outerRadius);
    for (let j = 0; j <= ps; j++) {
      const r = innerRadius + (j / ps) * (outerRadius - innerRadius);
      for (let i = 0; i <= ts; i++) {
        const a = thetaStart + (i / ts) * thetaLength;
        const x = r * Math.cos(a);
        const y = r * Math.sin(a);
        pos.push(x, y, 0);
        nor.push(0, 0, 1);
        uv.push((x / maxR + 1) * 0.5, (y / maxR + 1) * 0.5);
      }
    }
    const stride = ts + 1;
    for (let j = 0; j < ps; j++) {
      for (let i = 0; i < ts; i++) {
        const a = j * stride + i;
        const b = a + stride;
        const c = b + 1;
        const d = a + 1;
        idx.push(a, b, d, b, c, d);
      }
    }
    build(this, pos, nor, uv, idx);
  }
}

export class PyramidGeometry extends Geometry {
  // Pirámide de base cuadrada centrada en el origen.
  constructor(width = 1.2, height = 1.2, depth = 1.2) {
    super();
    const hw = width * 0.5, hh = height * 0.5, hd = depth * 0.5;
    const apex = [0, hh, 0];
    const bl = [-hw, -hh, -hd], br = [hw, -hh, -hd], fr = [hw, -hh, hd], fl = [-hw, -hh, hd];
    const pos = [], nor = [], uv = [], idx = [];

    const pushTri = (a, b, c, uvs) => {
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      const base = pos.length / 3;
      pos.push(...a, ...b, ...c);
      nor.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
      uv.push(...uvs);
      idx.push(base, base + 1, base + 2);
    };

    // 4 caras laterales en orden CCW hacia afuera
    pushTri(fl, fr, apex, [0, 0, 1, 0, 0.5, 1]);
    pushTri(fr, br, apex, [0, 0, 1, 0, 0.5, 1]);
    pushTri(br, bl, apex, [0, 0, 1, 0, 0.5, 1]);
    pushTri(bl, fl, apex, [0, 0, 1, 0, 0.5, 1]);
    // Base mirando hacia -Y
    pushTri(bl, br, fr, [0, 0, 1, 0, 1, 1]);
    pushTri(bl, fr, fl, [0, 0, 1, 1, 0, 1]);

    build(this, pos, nor, uv, idx);
  }
}

export class PolyhedronGeometry extends Geometry {
  constructor(vertices, indices, radius = 0.75, detail = 0) {
    super();
    const det = Math.max(0, Math.floor(detail));
    const nDiv = det + 1;
    const pos = [], nor = [], uv = [], idx = [];

    const project = (v) => {
      const l = Math.hypot(v[0], v[1], v[2]) || 1;
      return [(v[0] / l) * radius, (v[1] / l) * radius, (v[2] / l) * radius];
    };
    const lerpVec = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

    const pushTriangle = (pa, pb, pc) => {
      // Asegurar orientación CCW hacia afuera respecto al origen
      const ux = pb[0] - pa[0], uy = pb[1] - pa[1], uz = pb[2] - pa[2];
      const vx = pc[0] - pa[0], vy = pc[1] - pa[1], vz = pc[2] - pa[2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const cx = pa[0] + pb[0] + pc[0], cy = pa[1] + pb[1] + pc[1], cz = pa[2] + pb[2] + pc[2];
      if (nx * cx + ny * cy + nz * cz < 0) {
        const tmp = pb; pb = pc; pc = tmp;
        nx = -nx; ny = -ny; nz = -nz;
      }
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;

      const base = pos.length / 3;
      const verts = [pa, pb, pc];
      for (let i = 0; i < 3; i++) {
        const p = verts[i];
        pos.push(p[0], p[1], p[2]);
        if (det > 0) {
          const pl = Math.hypot(p[0], p[1], p[2]) || 1;
          nor.push(p[0] / pl, p[1] / pl, p[2] / pl);
        } else {
          nor.push(nx, ny, nz);
        }
        const pl = Math.hypot(p[0], p[1], p[2]) || 1;
        const u = Math.atan2(p[2], -p[0]) / (Math.PI * 2) + 0.5;
        const v = Math.acos(Math.max(-1, Math.min(1, p[1] / pl))) / Math.PI;
        uv.push(u, 1 - v);
      }
      idx.push(base, base + 1, base + 2);
    };

    for (let f = 0; f < indices.length; f += 3) {
      const v0 = [vertices[indices[f] * 3], vertices[indices[f] * 3 + 1], vertices[indices[f] * 3 + 2]];
      const v1 = [vertices[indices[f + 1] * 3], vertices[indices[f + 1] * 3 + 1], vertices[indices[f + 1] * 3 + 2]];
      const v2 = [vertices[indices[f + 2] * 3], vertices[indices[f + 2] * 3 + 1], vertices[indices[f + 2] * 3 + 2]];

      if (det === 0) {
        pushTriangle(project(v0), project(v1), project(v2));
        continue;
      }

      const rows = [];
      for (let i = 0; i <= nDiv; i++) {
        const row = [];
        const aj = lerpVec(v0, v2, i / nDiv);
        const bj = lerpVec(v1, v2, i / nDiv);
        const numCols = nDiv - i;
        for (let j = 0; j <= numCols; j++) {
          const p = (j === 0 && i === nDiv) ? aj : lerpVec(aj, bj, j / Math.max(1, numCols));
          row.push(project(p));
        }
        rows.push(row);
      }
      for (let i = 0; i < nDiv; i++) {
        const rowA = rows[i];
        const rowB = rows[i + 1];
        for (let j = 0; j < nDiv - i; j++) {
          pushTriangle(rowA[j], rowA[j + 1], rowB[j]);
          if (j + 1 < rowB.length) {
            pushTriangle(rowA[j + 1], rowB[j + 1], rowB[j]);
          }
        }
      }
    }
    build(this, pos, nor, uv, idx);
  }
}

export class TetrahedronGeometry extends PolyhedronGeometry {
  constructor(radius = 0.75, detail = 0) {
    const verts = [
      1, 1, 1,
      -1, -1, 1,
      -1, 1, -1,
      1, -1, -1,
    ];
    const indices = [
      2, 1, 0,
      0, 3, 2,
      1, 3, 0,
      2, 3, 1,
    ];
    super(verts, indices, radius, detail);
  }
}

export class OctahedronGeometry extends PolyhedronGeometry {
  constructor(radius = 0.75, detail = 0) {
    const verts = [
      1, 0, 0, -1, 0, 0,
      0, 1, 0, 0, -1, 0,
      0, 0, 1, 0, 0, -1,
    ];
    const indices = [
      0, 2, 4, 0, 4, 3, 0, 3, 5, 0, 5, 2,
      1, 2, 5, 1, 5, 3, 1, 3, 4, 1, 4, 2,
    ];
    super(verts, indices, radius, detail);
  }
}

export class DodecahedronGeometry extends PolyhedronGeometry {
  constructor(radius = 0.75, detail = 0) {
    const t = (1 + Math.sqrt(5)) / 2;
    const r = 1 / t;
    const verts = [
      -1, -1, -1, -1, -1, 1, -1, 1, -1, -1, 1, 1,
      1, -1, -1, 1, -1, 1, 1, 1, -1, 1, 1, 1,
      0, -r, -t, 0, -r, t, 0, r, -t, 0, r, t,
      -r, -t, 0, -r, t, 0, r, -t, 0, r, t, 0,
      -t, 0, -r, t, 0, -r, -t, 0, r, t, 0, r,
    ];
    const indices = [
      3, 11, 7, 3, 7, 15, 3, 15, 13,
      7, 19, 17, 7, 17, 6, 7, 6, 15,
      17, 4, 8, 17, 8, 10, 17, 10, 6,
      8, 0, 16, 8, 16, 2, 8, 2, 10,
      0, 12, 1, 0, 1, 18, 0, 18, 16,
      6, 10, 2, 6, 2, 13, 6, 13, 15,
      2, 16, 18, 2, 18, 3, 2, 3, 13,
      18, 1, 9, 18, 9, 11, 18, 11, 3,
      4, 14, 12, 4, 12, 0, 4, 0, 8,
      11, 9, 5, 11, 5, 19, 11, 19, 7,
      19, 5, 14, 19, 14, 4, 19, 4, 17,
      1, 12, 14, 1, 14, 5, 1, 5, 9,
    ];
    super(verts, indices, radius, detail);
  }
}

export class IcosahedronGeometry extends PolyhedronGeometry {
  constructor(radius = 0.75, detail = 0) {
    const t = (1 + Math.sqrt(5)) / 2;
    const verts = [
      -1, t, 0, 1, t, 0, -1, -t, 0, 1, -t, 0,
      0, -1, t, 0, 1, t, 0, -1, -t, 0, 1, -t,
      t, 0, -1, t, 0, 1, -t, 0, -1, -t, 0, 1,
    ];
    const indices = [
      0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11,
      1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
      3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9,
      4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1,
    ];
    super(verts, indices, radius, detail);
  }
}
