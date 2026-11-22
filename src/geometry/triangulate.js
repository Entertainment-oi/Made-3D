// Utilidades puras de geometría 2D: área firmada, punto en polígono,
// simplificación Ramer-Douglas-Peucker y triangulación Earcut con soporte de huecos.

/**
 * Área firmada de un polígono 2D cerrado `[[x, y], ...]`.
 * Positiva = sentido antihorario (CCW), negativa = sentido horario (CW).
 */
export function polygonArea(pts) {
  let area = 0;
  const n = pts.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    area += (pts[j][0] - pts[i][0]) * (pts[j][1] + pts[i][1]);
  }
  return area * 0.5;
}

/**
 * Comprueba si un punto (x, y) está dentro de un polígono 2D cerrado.
 */
export function pointInPolygon(x, y, poly) {
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-12) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

function perpDistSq(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) {
    const px = p[0] - a[0];
    const py = p[1] - a[1];
    return px * px + py * py;
  }
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq));
  const cx = a[0] + t * dx - p[0];
  const cy = a[1] + t * dy - p[1];
  return cx * cx + cy * cy;
}

function rdpOpen(pts, start, end, tolSq, keep) {
  let maxDist = 0;
  let maxIdx = -1;
  const a = pts[start];
  const b = pts[end];
  for (let i = start + 1; i < end; i++) {
    const d = perpDistSq(pts[i], a, b);
    if (d > maxDist) {
      maxDist = d;
      maxIdx = i;
    }
  }
  if (maxDist > tolSq && maxIdx > start) {
    keep[maxIdx] = 1;
    rdpOpen(pts, start, maxIdx, tolSq, keep);
    rdpOpen(pts, maxIdx, end, tolSq, keep);
  }
}

/**
 * Simplifica un contorno cerrado conservando sus esquinas principales.
 */
export function simplifyRDP(pts, tolerance = 0.45) {
  const n = pts.length;
  if (n <= 4 || tolerance <= 0) return pts.slice();

  // Dividir por los dos puntos más lejanos para evitar artefactos en el punto de cierre.
  let idxA = 0;
  let maxD = -1;
  for (let i = 1; i < n; i++) {
    const dx = pts[i][0] - pts[0][0];
    const dy = pts[i][1] - pts[0][1];
    const d = dx * dx + dy * dy;
    if (d > maxD) {
      maxD = d;
      idxA = i;
    }
  }
  let idxB = 0;
  maxD = -1;
  for (let i = 0; i < n; i++) {
    const dx = pts[i][0] - pts[idxA][0];
    const dy = pts[i][1] - pts[idxA][1];
    const d = dx * dx + dy * dy;
    if (d > maxD) {
      maxD = d;
      idxB = i;
    }
  }
  if (idxA === idxB) return pts.slice();

  // Reordenar anillo para que empiece en idxA
  const ring = [];
  let bPos = 0;
  for (let k = 0; k < n; k++) {
    const idx = (idxA + k) % n;
    if (idx === idxB) bPos = k;
    ring.push(pts[idx]);
  }
  ring.push(pts[idxA]);

  const keep = new Uint8Array(ring.length);
  keep[0] = 1;
  keep[bPos] = 1;
  keep[ring.length - 1] = 1;
  const tolSq = tolerance * tolerance;
  rdpOpen(ring, 0, bPos, tolSq, keep);
  rdpOpen(ring, bPos, ring.length - 1, tolSq, keep);

  const out = [];
  for (let i = 0; i < ring.length - 1; i++) {
    if (keep[i]) out.push(ring[i]);
  }
  return out.length >= 3 ? out : pts.slice();
}

// ───────── Earcut con puenteo de huecos (puro JS) ─────────
function area2(ax, ay, bx, by, cx, cy) {
  return (by - ay) * (cx - bx) - (bx - ax) * (cy - by);
}

function pointInTri(ax, ay, bx, by, cx, cy, px, py) {
  return (
    (cx - px) * (ay - py) >= (ax - px) * (cy - py) &&
    (ax - px) * (by - py) >= (bx - px) * (ay - py) &&
    (bx - px) * (cy - py) >= (cx - px) * (by - py)
  );
}

function makeNode(i, x, y) {
  return { i, x, y, prev: null, next: null, steiner: false };
}

function insertNode(i, x, y, last) {
  const p = makeNode(i, x, y);
  if (!last) {
    p.prev = p;
    p.next = p;
  } else {
    p.next = last.next;
    p.prev = last;
    last.next.prev = p;
    last.next = p;
  }
  return p;
}

function removeNode(p) {
  p.next.prev = p.prev;
  p.prev.next = p.next;
}

function buildRing(coords, startIdx, ccw, last) {
  let head = null;
  let tail = last;
  const n = coords.length;
  // polygonArea > 0 => CCW
  const isCcw = polygonArea(coords) > 0;
  if (isCcw === ccw) {
    for (let k = 0; k < n; k++) {
      tail = insertNode(startIdx + k, coords[k][0], coords[k][1], tail);
      if (!head) head = tail;
    }
  } else {
    for (let k = n - 1; k >= 0; k--) {
      tail = insertNode(startIdx + k, coords[k][0], coords[k][1], tail);
      if (!head) head = tail;
    }
  }
  return tail;
}

function filterCollinear(start, end) {
  if (!start) return start;
  if (!end) end = start;
  let p = start;
  let again;
  do {
    again = false;
    if (!p.steiner && ((Math.abs(p.x - p.next.x) < 1e-8 && Math.abs(p.y - p.next.y) < 1e-8) ||
      Math.abs(area2(p.prev.x, p.prev.y, p.x, p.y, p.next.x, p.next.y)) < 1e-9)) {
      removeNode(p);
      p = end = p.prev;
      if (p === p.next) break;
      again = true;
    } else {
      p = p.next;
    }
  } while (again || p !== end);
  return end;
}

function getLeftmost(start) {
  let p = start;
  let leftmost = start;
  do {
    if (p.x < leftmost.x || (p.x === leftmost.x && p.y < leftmost.y)) leftmost = p;
    p = p.next;
  } while (p !== start);
  return leftmost;
}

function splitPolygon(a, b) {
  const a2 = makeNode(a.i, a.x, a.y);
  const b2 = makeNode(b.i, b.x, b.y);
  const an = a.next;
  const bp = b.prev;

  a.next = b;
  b.prev = a;
  a2.next = an;
  an.prev = a2;
  b2.next = a2;
  a2.prev = b2;
  bp.next = b2;
  b2.prev = bp;

  return b2;
}

function locallyInside(a, b) {
  return area2(a.prev.x, a.prev.y, a.x, a.y, a.next.x, a.next.y) < 0
    ? area2(a.x, a.y, b.x, b.y, a.next.x, a.next.y) >= 0 && area2(a.x, a.y, a.prev.x, a.prev.y, b.x, b.y) >= 0
    : area2(a.x, a.y, b.x, b.y, a.prev.x, a.prev.y) < 0 || area2(a.x, a.y, a.next.x, a.next.y, b.x, b.y) < 0;
}

function findHoleBridge(hole, outerNode) {
  let p = outerNode;
  const hx = hole.x;
  const hy = hole.y;
  let qx = -Infinity;
  let m = null;

  do {
    if (hy <= p.y && hy >= p.next.y && p.next.y !== p.y) {
      const x = p.x + ((hy - p.y) * (p.next.x - p.x)) / (p.next.y - p.y);
      if (x <= hx && x > qx) {
        qx = x;
        m = p.x < p.next.x ? p : p.next;
        if (x === hx) return m;
      }
    }
    p = p.next;
  } while (p !== outerNode);

  if (!m) return null;

  const stop = m;
  const mx = m.x;
  const my = m.y;
  let tanMin = Infinity;
  p = m;

  do {
    if (hx >= p.x && p.x >= mx && hx !== p.x &&
      pointInTri(hy < my ? hx : qx, hy, mx, my, hy < my ? qx : hx, hy, p.x, p.y)) {
      const tan = Math.abs(hy - p.y) / (hx - p.x);
      if (locallyInside(p, hole) &&
        (tan < tanMin || (tan === tanMin && (p.x > m.x || (p.x === m.x && sectorContainsSector(m, p)))))) {
        m = p;
        tanMin = tan;
      }
    }
    p = p.next;
  } while (p !== stop);

  return m;
}

function sectorContainsSector(m, p) {
  return area2(m.prev.x, m.prev.y, m.x, m.y, p.prev.x, p.prev.y) < 0 &&
    area2(p.next.x, p.next.y, m.x, m.y, m.next.x, m.next.y) < 0;
}

function eliminateHole(hole, outerNode) {
  const bridge = findHoleBridge(hole, outerNode);
  if (!bridge) return outerNode;
  const bridgeReverse = splitPolygon(bridge, hole);
  filterCollinear(bridgeReverse, bridgeReverse.next);
  return filterCollinear(bridge, bridge.next);
}

function isEar(ear) {
  const a = ear.prev;
  const b = ear;
  const c = ear.next;
  // Para vértices CCW: en area2 = (by-ay)*(cx-bx) - (bx-ax)*(cy-by) = -(AB × BC)
  // Un vértice convexo CCW tiene area2 < 0.
  if (area2(a.x, a.y, b.x, b.y, c.x, c.y) >= 0) return false;

  const x0 = a.x, y0 = a.y, x1 = b.x, y1 = b.y, x2 = c.x, y2 = c.y;
  const minX = Math.min(x0, x1, x2);
  const minY = Math.min(y0, y1, y2);
  const maxX = Math.max(x0, x1, x2);
  const maxY = Math.max(y0, y1, y2);

  let p = c.next;
  while (p !== a) {
    if (p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY &&
      pointInTri(x0, y0, x1, y1, x2, y2, p.x, p.y) &&
      area2(p.prev.x, p.prev.y, p.x, p.y, p.next.x, p.next.y) >= 0) {
      return false;
    }
    p = p.next;
  }
  return true;
}

function intersects(p1, q1, p2, q2) {
  const o1 = Math.sign(area2(p1.x, p1.y, q1.x, q1.y, p2.x, p2.y));
  const o2 = Math.sign(area2(p1.x, p1.y, q1.x, q1.y, q2.x, q2.y));
  const o3 = Math.sign(area2(p2.x, p2.y, q2.x, q2.y, p1.x, p1.y));
  const o4 = Math.sign(area2(p2.x, p2.y, q2.x, q2.y, q1.x, q1.y));
  return o1 !== o2 && o3 !== o4;
}

function isValidDiagonal(a, b) {
  return (
    a.next.i !== b.i &&
    a.prev.i !== b.i &&
    !intersectsPolygon(a, b) &&
    locallyInside(a, b) &&
    locallyInside(b, a) &&
    middleInside(a, b)
  );
}

function intersectsPolygon(a, b) {
  let p = a;
  do {
    if (p.i !== a.i && p.next.i !== a.i && p.i !== b.i && p.next.i !== b.i && intersects(p, p.next, a, b)) {
      return true;
    }
    p = p.next;
  } while (p !== a);
  return false;
}

function middleInside(a, b) {
  let p = a;
  let inside = false;
  const px = (a.x + b.x) * 0.5;
  const py = (a.y + b.y) * 0.5;
  do {
    if ((p.y > py) !== (p.next.y > py) && p.next.y !== p.y &&
      px < ((p.next.x - p.x) * (py - p.y)) / (p.next.y - p.y) + p.x) {
      inside = !inside;
    }
    p = p.next;
  } while (p !== a);
  return inside;
}

function splitEarcut(start, triangles) {
  let a = start;
  do {
    let b = a.next.next;
    while (b !== a.prev) {
      if (a.i !== b.i && isValidDiagonal(a, b)) {
        let c = splitPolygon(a, b);
        a = filterCollinear(a, a.next);
        c = filterCollinear(c, c.next);
        earcutLinked(a, triangles, 0);
        earcutLinked(c, triangles, 0);
        return;
      }
      b = b.next;
    }
    a = a.next;
  } while (a !== start);
}

function cureLocalIntersections(start, triangles) {
  let p = start;
  do {
    const a = p.prev;
    const b = p.next.next;
    if (a.i !== b.i && intersects(a, p, p.next, b) && locallyInside(a, b) && locallyInside(b, a)) {
      triangles.push(a.i, p.i, b.i);
      removeNode(p);
      removeNode(p.next);
      p = start = b;
    }
    p = p.next;
  } while (p !== start);
  return filterCollinear(p);
}

function earcutLinked(ear, triangles, pass) {
  if (!ear) return;
  let stop = ear;
  while (ear.prev !== ear.next) {
    const prev = ear.prev;
    const next = ear.next;
    if (isEar(ear)) {
      triangles.push(prev.i, ear.i, next.i);
      removeNode(ear);
      ear = next.next;
      stop = next.next;
      continue;
    }
    ear = next;
    if (ear === stop) {
      if (!pass) {
        earcutLinked(filterCollinear(ear), triangles, 1);
      } else if (pass === 1) {
        ear = cureLocalIntersections(filterCollinear(ear), triangles);
        earcutLinked(ear, triangles, 2);
      } else if (pass === 2) {
        splitEarcut(ear, triangles);
      }
      break;
    }
  }
}

/**
 * Triangula un polígono exterior 2D junto con sus huecos.
 * Devuelve `{ vertices: [[x, y], ...], triangles: [i0, i1, i2, ...] }`.
 */
export function triangulatePolygonWithHoles(outer, holes = []) {
  const vertices = [];
  const outerRing = polygonArea(outer) > 0 ? outer.slice() : outer.slice().reverse();
  let outerNode = buildRing(outerRing, 0, true, null);
  for (let i = 0; i < outerRing.length; i++) vertices.push(outerRing[i]);

  if (holes && holes.length) {
    const queue = [];
    for (let h = 0; h < holes.length; h++) {
      const hr = polygonArea(holes[h]) < 0 ? holes[h].slice() : holes[h].slice().reverse();
      if (hr.length < 3) continue;
      const startIdx = vertices.length;
      for (let i = 0; i < hr.length; i++) vertices.push(hr[i]);
      const list = buildRing(hr, startIdx, false, null);
      if (list === list.next) list.steiner = true;
      queue.push(getLeftmost(list));
    }
    queue.sort((a, b) => a.x - b.x);
    for (let i = 0; i < queue.length; i++) {
      outerNode = eliminateHole(queue[i], outerNode);
    }
  }

  outerNode = filterCollinear(outerNode);
  const triangles = [];
  earcutLinked(outerNode, triangles, 0);
  return { vertices, triangles };
}
