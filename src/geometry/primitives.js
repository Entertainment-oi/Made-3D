import { Geometry } from './Geometry.js';

function build(g, pos, nor, uv, idx) {
  g.setAttribute('position', pos, 3).setAttribute('normal', nor, 3).setAttribute('uv', uv, 2);
  g.setIndex(idx);
  return g;
}

export class BoxGeometry extends Geometry {
  constructor(width = 1, height = 1, depth = 1) {
    super();
    const h = [width / 2, height / 2, depth / 2];
    // [normal, eje u, eje v] con u × v = normal
    const faces = [
      [[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
      [[0, 1, 0], [1, 0, 0], [0, 0, -1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
      [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
    ];
    const pos = [], nor = [], uv = [], idx = [];
    const corners = [[-1, -1, 0, 0], [1, -1, 1, 0], [1, 1, 1, 1], [-1, 1, 0, 1]];
    faces.forEach(([n, u, v], f) => {
      const hu = Math.abs(u[0]) * h[0] + Math.abs(u[1]) * h[1] + Math.abs(u[2]) * h[2];
      const hv = Math.abs(v[0]) * h[0] + Math.abs(v[1]) * h[1] + Math.abs(v[2]) * h[2];
      for (const [su, sv, tu, tv] of corners) {
        for (let k = 0; k < 3; k++) pos.push(n[k] * h[k] + u[k] * hu * su + v[k] * hv * sv);
        nor.push(n[0], n[1], n[2]);
        uv.push(tu, tv);
      }
      const o = f * 4;
      idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
    });
    build(this, pos, nor, uv, idx);
  }
}

export class PlaneGeometry extends Geometry {
  // Plano en XY mirando a +Z.
  constructor(width = 1, height = 1, wSeg = 1, hSeg = 1) {
    super();
    const pos = [], nor = [], uv = [], idx = [];
    for (let j = 0; j <= hSeg; j++) {
      for (let i = 0; i <= wSeg; i++) {
        pos.push((i / wSeg - 0.5) * width, (j / hSeg - 0.5) * height, 0);
        nor.push(0, 0, 1);
        uv.push(i / wSeg, j / hSeg);
      }
    }
    for (let j = 0; j < hSeg; j++) {
      for (let i = 0; i < wSeg; i++) {
        const a = j * (wSeg + 1) + i, b = a + 1, d = a + wSeg + 1, c = d + 1;
        idx.push(a, b, c, a, c, d);
      }
    }
    build(this, pos, nor, uv, idx);
  }
}

export class SphereGeometry extends Geometry {
  constructor(radius = 1, wSeg = 24, hSeg = 16) {
    super();
    const pos = [], nor = [], uv = [], idx = [], grid = [];
    for (let iy = 0; iy <= hSeg; iy++) {
      const row = [], v = iy / hSeg;
      for (let ix = 0; ix <= wSeg; ix++) {
        const u = ix / wSeg;
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
    for (let iy = 0; iy < hSeg; iy++) {
      for (let ix = 0; ix < wSeg; ix++) {
        const a = grid[iy][ix + 1], b = grid[iy][ix], c = grid[iy + 1][ix], d = grid[iy + 1][ix + 1];
        if (iy !== 0) idx.push(a, b, d);
        if (iy !== hSeg - 1) idx.push(b, c, d);
      }
    }
    build(this, pos, nor, uv, idx);
  }
}
