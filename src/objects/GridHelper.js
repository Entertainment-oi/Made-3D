import { Mesh } from './Mesh.js';
import { Geometry } from '../geometry/Geometry.js';
import { BasicMaterial } from '../materials/BuiltinMaterials.js';
import { Color } from '../math/Color.js';

/**
 * Cuadrícula de referencia en el plano XZ.
 *
 *   const grid = new GridHelper(20, 20);       // 20×20 unidades, celdas de 1
 *   scene.add(grid);
 *
 * Se dibuja con líneas (no con triángulos) y lleva el color en los vértices: las líneas
 * centrales van con `color1` y el resto con `color2`.
 */
export class GridHelper extends Mesh {
  // size: lado de la cuadrícula · divisions: celdas por lado
  // color1: color de los ejes centrales · color2: color del resto
  constructor(size = 10, divisions = 10, color1 = 0x6d7893, color2 = 0x363c4d, opts = {}) {
    const geo = gridGeometry(size, divisions, color1, color2);
    const mat = new BasicMaterial({
      vertexColors: true, color: 0xffffff,
      transparent: opts.transparent !== false, opacity: opts.opacity ?? 0.9,
      depthWrite: false,
    });
    super(geo, mat);
    this.isGridHelper = true;
    this.drawMode = 'lines';       // líneas, no triángulos
    this.size = size;
    this.divisions = divisions;
  }
}

// Cuadrícula de líneas en el plano XZ, con el color por vértice.
function gridGeometry(size, divisions, color1, color2) {
  const n = Math.max(1, divisions | 0);
  const half = size / 2, step = size / n;
  const c1 = new Color(color1), c2 = new Color(color2);
  const pos = [], col = [], idx = [];
  const center = n % 2 === 0 ? n / 2 : -1;    // los ejes centrales están en el medio si hay un número par de celdas
  const push = (x, z, c) => {
    pos.push(x, 0, z);
    col.push(c.r, c.g, c.b);
    return pos.length / 3 - 1;
  };
  for (let i = 0; i <= n; i++) {
    const v = -half + i * step;
    const c = i === center ? c1 : c2;
    const a = push(-half, v, c), b = push(half, v, c);      // línea a lo largo de X
    idx.push(a, b);
    const d = push(v, -half, c), e = push(v, half, c);      // línea a lo largo de Z
    idx.push(d, e);
  }
  const g = new Geometry();
  g.setAttribute('position', new Float32Array(pos), 3);
  g.setAttribute('color', new Float32Array(col), 3);
  g.setIndex(new Uint16Array(idx));
  return g;
}
