import { Geometry } from './Geometry.js';
import { BufferAttribute } from './BufferAttribute.js';
import {
  polygonArea,
  pointInPolygon,
  simplifyRDP,
  triangulatePolygonWithHoles,
} from './triangulate.js';

const DEFAULT_OPTIONS = {
  text: 'Made3D',
  size: 0.72,
  depth: 0.18,
  fontFamily: 'Plus Jakarta Sans, system-ui, -apple-system, sans-serif',
  fontWeight: '700',
  fontStyle: 'normal',
  align: 'center',
  letterSpacing: 0,
  lineHeight: 1.18,
  curveResolution: 72,
  simplifyTolerance: 0.36,
};

// Fuente bitmap 5x7 de respaldo para entornos sin DOM (p. ej. Node.js)
const BITMAP_5X7 = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11100', '10010', '10001', '10001', '10001', '10010', '11100'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  J: ['00111', '00010', '00010', '00010', '10010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  '0': ['01110', '10011', '10101', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  ',': ['00000', '00000', '00000', '00000', '00100', '00100', '01000'],
  ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
  ';': ['00000', '01100', '01100', '00000', '01100', '00100', '01000'],
  '!': ['00100', '00100', '00100', '00100', '00100', '00000', '00100'],
  '?': ['01110', '10001', '00001', '00110', '00100', '00000', '00100'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '_': ['00000', '00000', '00000', '00000', '00000', '00000', '11111'],
  '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
  '/': ['00001', '00010', '00100', '00100', '01000', '10000', '00000'],
  '(': ['00010', '00100', '01000', '01000', '01000', '00100', '00010'],
  ')': ['01000', '00100', '00010', '00010', '00010', '00100', '01000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

function clamp01(t) {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/**
 * Extrae contornos cerrados subpíxel desde un buffer alfa usando Marching Squares.
 * El umbral semientero (127.5) evita degeneraciones cuando el alfa coincide con el umbral.
 */
export function extractAlphaContours(alpha, width, height, threshold = 127.5) {
  const nodes = new Map();
  const adj = new Map();

  const addSeg = (k1, p1, k2, p2) => {
    if (k1 === k2) return;
    if (!nodes.has(k1)) nodes.set(k1, p1);
    if (!nodes.has(k2)) nodes.set(k2, p2);
    let a1 = adj.get(k1);
    if (!a1) {
      a1 = [];
      adj.set(k1, a1);
    }
    a1.push(k2);
    let a2 = adj.get(k2);
    if (!a2) {
      a2 = [];
      adj.set(k2, a2);
    }
    a2.push(k1);
  };

  const interpH = (cx, cy, aL, aR) => {
    const d = aR - aL;
    const t = Math.abs(d) > 1e-6 ? clamp01((threshold - aL) / d) : 0.5;
    return [cx + t, cy];
  };

  const interpV = (cx, cy, aT, aB) => {
    const d = aB - aT;
    const t = Math.abs(d) > 1e-6 ? clamp01((threshold - aT) / d) : 0.5;
    return [cx, cy + t];
  };

  for (let cy = 0; cy < height - 1; cy++) {
    const row0 = cy * width;
    const row1 = (cy + 1) * width;
    for (let cx = 0; cx < width - 1; cx++) {
      const a0 = alpha[row0 + cx];
      const a1 = alpha[row0 + cx + 1];
      const a2 = alpha[row1 + cx + 1];
      const a3 = alpha[row1 + cx];

      const code =
        (a0 >= threshold ? 8 : 0) |
        (a1 >= threshold ? 4 : 0) |
        (a2 >= threshold ? 2 : 0) |
        (a3 >= threshold ? 1 : 0);

      if (code === 0 || code === 15) continue;

      const k0 = `H:${cx}:${cy}`;
      const k1 = `V:${cx + 1}:${cy}`;
      const k2 = `H:${cx}:${cy + 1}`;
      const k3 = `V:${cx}:${cy}`;

      const getEdge = (e) => {
        if (e === 0) return [k0, interpH(cx, cy, a0, a1)];
        if (e === 1) return [k1, interpV(cx + 1, cy, a1, a2)];
        if (e === 2) return [k2, interpH(cx, cy + 1, a3, a2)];
        return [k3, interpV(cx, cy, a0, a3)];
      };

      const pair = (eA, eB) => {
        const [ka, pa] = getEdge(eA);
        const [kb, pb] = getEdge(eB);
        addSeg(ka, pa, kb, pb);
      };

      switch (code) {
        case 1:
        case 14:
          pair(3, 2);
          break;
        case 2:
        case 13:
          pair(2, 1);
          break;
        case 3:
        case 12:
          pair(3, 1);
          break;
        case 4:
        case 11:
          pair(1, 0);
          break;
        case 5: {
          const avg = (a0 + a1 + a2 + a3) * 0.25;
          if (avg >= threshold) {
            pair(3, 0);
            pair(1, 2);
          } else {
            pair(0, 1);
            pair(2, 3);
          }
          break;
        }
        case 6:
        case 9:
          pair(2, 0);
          break;
        case 7:
        case 8:
          pair(0, 3);
          break;
        case 10: {
          const avg = (a0 + a1 + a2 + a3) * 0.25;
          if (avg >= threshold) {
            pair(0, 1);
            pair(2, 3);
          } else {
            pair(3, 0);
            pair(1, 2);
          }
          break;
        }
        default:
          break;
      }
    }
  }

  // Encadenar segmentos en anillos cerrados
  const used = new Set();
  const edgeKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const loops = [];

  for (const startKey of adj.keys()) {
    const startNeighbors = adj.get(startKey);
    for (const firstNext of startNeighbors) {
      const ek0 = edgeKey(startKey, firstNext);
      if (used.has(ek0)) continue;

      const loop = [nodes.get(startKey)];
      used.add(ek0);
      let prev = startKey;
      let curr = firstNext;
      let guard = nodes.size + 4;

      while (curr !== startKey && guard-- > 0) {
        loop.push(nodes.get(curr));
        const neighbors = adj.get(curr);
        if (!neighbors || !neighbors.length) break;
        let next = null;
        for (const cand of neighbors) {
          if (cand === prev && neighbors.length > 1) continue;
          const ek = edgeKey(curr, cand);
          if (!used.has(ek)) {
            next = cand;
            used.add(ek);
            break;
          }
        }
        if (!next) break;
        prev = curr;
        curr = next;
      }

      if (loop.length >= 3) loops.push(loop);
    }
  }

  return loops;
}

function measureLineWidthWithSpacing(ctx, chars, spacingPx) {
  if (!chars.length) return 0;
  let w = 0;
  for (let i = 0; i < chars.length; i++) {
    const prev = chars.slice(0, i).join('');
    const curr = prev + chars[i];
    w += ctx.measureText(curr).width - ctx.measureText(prev).width;
    if (i < chars.length - 1) w += spacingPx;
  }
  return w;
}

function fillLineWithSpacing(ctx, chars, startX, y, spacingPx) {
  let cursor = startX;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    ctx.fillText(ch, cursor, y);
    const prev = chars.slice(0, i).join('');
    const curr = prev + ch;
    const adv = ctx.measureText(curr).width - ctx.measureText(prev).width;
    cursor += adv + spacingPx;
  }
}

function rasterizeCanvasText(opts) {
  const rawLines = String(opts.text ?? '').split(/\r?\n/);
  const lines = rawLines.length ? rawLines : [''];
  let pxPerLine = Math.max(24, Math.min(140, Math.round(opts.curveResolution || 72)));
  const spacingPx = (opts.letterSpacing || 0) * pxPerLine;
  const lineStepPx = pxPerLine * (opts.lineHeight || 1.18);

  const cv = document.createElement('canvas');
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const fontDecl = `${opts.fontStyle || 'normal'} ${opts.fontWeight || '700'} ${pxPerLine}px ${opts.fontFamily}`;
  ctx.font = fontDecl;

  const lineChars = lines.map((l) => Array.from(l));
  const useManualSpacing = Math.abs(spacingPx) > 1e-4;
  let lineWidths = lineChars.map((chars, idx) =>
    useManualSpacing ? measureLineWidthWithSpacing(ctx, chars, spacingPx) : ctx.measureText(lines[idx]).width
  );
  let maxW = Math.max(pxPerLine * 0.5, ...lineWidths);

  // Limitar tamaño de canvas para textos muy extensos sin agotar memoria
  const maxCanvasDim = 1800;
  const rawW = maxW + pxPerLine * 1.1;
  const rawH = lines.length * lineStepPx + pxPerLine * 1.1;
  const downScale = Math.min(1, maxCanvasDim / Math.max(rawW, rawH));
  if (downScale < 0.999) {
    pxPerLine = Math.max(16, Math.floor(pxPerLine * downScale));
  }

  const finalSpacingPx = (opts.letterSpacing || 0) * pxPerLine;
  const finalLineStepPx = pxPerLine * (opts.lineHeight || 1.18);
  const finalFont = `${opts.fontStyle || 'normal'} ${opts.fontWeight || '700'} ${pxPerLine}px ${opts.fontFamily}`;
  ctx.font = finalFont;
  lineWidths = lineChars.map((chars, idx) =>
    Math.abs(finalSpacingPx) > 1e-4
      ? measureLineWidthWithSpacing(ctx, chars, finalSpacingPx)
      : ctx.measureText(lines[idx]).width
  );
  maxW = Math.max(pxPerLine * 0.5, ...lineWidths);

  const padX = Math.ceil(pxPerLine * 0.55);
  const padY = Math.ceil(pxPerLine * 0.55);
  const W = Math.max(8, Math.ceil(maxW + padX * 2));
  const H = Math.max(8, Math.ceil((lines.length - 1) * finalLineStepPx + pxPerLine * 1.35 + padY * 2));
  cv.width = W;
  cv.height = H;

  ctx.clearRect(0, 0, W, H);
  ctx.font = finalFont;
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';

  const align = opts.align || 'center';
  const ascentApprox = pxPerLine * 0.92;
  for (let i = 0; i < lines.length; i++) {
    const lw = lineWidths[i];
    let x = padX;
    if (align === 'center') x = padX + (maxW - lw) * 0.5;
    else if (align === 'right') x = padX + (maxW - lw);
    const y = padY + ascentApprox + i * finalLineStepPx;

    if (Math.abs(finalSpacingPx) > 1e-4) {
      fillLineWithSpacing(ctx, lineChars[i], x, y, finalSpacingPx);
    } else {
      ctx.fillText(lines[i], x, y);
    }
  }

  const img = ctx.getImageData(0, 0, W, H).data;
  const alpha = new Uint8Array(W * H);
  for (let i = 0, j = 3; i < alpha.length; i++, j += 4) {
    alpha[i] = img[j];
  }

  return { alpha, width: W, height: H, pxPerLine };
}

function rasterizeHeadlessBitmap(opts) {
  const lines = String(opts.text ?? '').split(/\r?\n/);
  const cell = 3;
  const glyphW = 5 * cell;
  const glyphH = 7 * cell;
  const advX = Math.max(1, Math.round((6 + (opts.letterSpacing || 0) * 5) * cell));
  const lineH = Math.max(glyphH + cell, Math.round(glyphH * (opts.lineHeight || 1.18)));
  const pad = 4;

  const normalizeChar = (ch) => {
    const upper = ch
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase();
    return BITMAP_5X7[upper] || BITMAP_5X7[' '];
  };

  const lineLengths = lines.map((l) => Array.from(l).length);
  const maxCols = Math.max(1, ...lineLengths);
  const maxLinePxW = Math.max(glyphW, (maxCols - 1) * advX + glyphW);
  const W = maxLinePxW + pad * 2;
  const H = (lines.length - 1) * lineH + glyphH + pad * 2;
  const alpha = new Uint8Array(W * H);

  for (let li = 0; li < lines.length; li++) {
    const chars = Array.from(lines[li]);
    const lw = chars.length ? (chars.length - 1) * advX + glyphW : 0;
    let ox = pad;
    if (opts.align === 'center') ox = pad + Math.round((maxLinePxW - lw) * 0.5);
    else if (opts.align === 'right') ox = pad + (maxLinePxW - lw);
    const oy = pad + li * lineH;

    for (let ci = 0; ci < chars.length; ci++) {
      const rows = normalizeChar(chars[ci]);
      const gx = ox + ci * advX;
      for (let r = 0; r < 7; r++) {
        for (let c = 0; c < 5; c++) {
          if (rows[r][c] !== '1') continue;
          for (let py = 0; py < cell; py++) {
            for (let px = 0; px < cell; px++) {
              const ax = gx + c * cell + px;
              const ay = oy + r * cell + py;
              if (ax >= 0 && ax < W && ay >= 0 && ay < H) {
                alpha[ay * W + ax] = 255;
              }
            }
          }
        }
      }
    }
  }

  return { alpha, width: W, height: H, pxPerLine: glyphH };
}

function buildShapesFromLoops(loops, scale, cx, cy, simplifyTol) {
  const rings = [];
  const minAreaPx = 1.2;

  for (const raw of loops) {
    const tol = Math.max(0.12, simplifyTol);
    const simp = simplifyRDP(raw, tol);
    if (simp.length < 3) continue;
    // Convertir de coordenadas píxel (Y abajo) a plano cartesiano 3D (Y arriba)
    const mapped = simp.map(([px, py]) => [(px - cx) * scale, (cy - py) * scale]);
    const areaPx = Math.abs(polygonArea(simp));
    if (areaPx < minAreaPx) continue;
    const area3d = polygonArea(mapped);
    if (Math.abs(area3d) < 1e-8) continue;
    rings.push({
      pts: mapped,
      absArea: Math.abs(area3d),
      parent: -1,
      depth: 0,
    });
  }

  // Calcular anidamiento: depth par => exterior (outer), depth impar => hueco (hole)
  for (let i = 0; i < rings.length; i++) {
    const testPt = rings[i].pts[0];
    let depth = 0;
    let bestParent = -1;
    let bestParentArea = Infinity;
    for (let j = 0; j < rings.length; j++) {
      if (i === j || rings[j].absArea <= rings[i].absArea) continue;
      if (pointInPolygon(testPt[0], testPt[1], rings[j].pts)) {
        depth++;
        if (rings[j].absArea < bestParentArea) {
          bestParentArea = rings[j].absArea;
          bestParent = j;
        }
      }
    }
    rings[i].depth = depth;
    rings[i].parent = bestParent;
  }

  const shapes = [];
  const byIndex = new Map();
  for (let i = 0; i < rings.length; i++) {
    if (rings[i].depth % 2 === 0) {
      const outer = polygonArea(rings[i].pts) > 0 ? rings[i].pts : rings[i].pts.slice().reverse();
      const shape = { outer, holes: [] };
      shapes.push(shape);
      byIndex.set(i, shape);
    }
  }
  for (let i = 0; i < rings.length; i++) {
    if (rings[i].depth % 2 === 1) {
      const hole = polygonArea(rings[i].pts) < 0 ? rings[i].pts : rings[i].pts.slice().reverse();
      const parentShape = byIndex.get(rings[i].parent);
      if (parentShape) parentShape.holes.push(hole);
    }
  }

  return shapes;
}

function buildExtrudedBuffers(shapes, depth) {
  if (!shapes.length) {
    return {
      pos: new Float32Array(0),
      nor: new Float32Array(0),
      uv: new Float32Array(0),
      idx: new Uint16Array(0),
    };
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of shapes) {
    for (const [x, y] of s.outer) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const spanX = Math.max(1e-4, maxX - minX);
  const spanY = Math.max(1e-4, maxY - minY);
  const invSpan = 1 / Math.max(spanX, spanY);

  const d = Math.max(0.002, depth);
  const zFront = d * 0.5;
  const zBack = -d * 0.5;

  const pos = [];
  const nor = [];
  const uv = [];
  const idx = [];
  const creaseCos = Math.cos((35 * Math.PI) / 180);

  const pushVertex = (x, y, z, nx, ny, nz, u, v) => {
    const vi = pos.length / 3;
    pos.push(x, y, z);
    nor.push(nx, ny, nz);
    uv.push(u, v);
    return vi;
  };

  for (const shape of shapes) {
    // 1. Tapas frontal (+Z) y trasera (-Z)
    const { vertices, triangles } = triangulatePolygonWithHoles(shape.outer, shape.holes);
    if (triangles.length >= 3) {
      const frontBase = pos.length / 3;
      for (let i = 0; i < vertices.length; i++) {
        const [x, y] = vertices[i];
        pushVertex(x, y, zFront, 0, 0, 1, (x - minX) / spanX, (y - minY) / spanY);
      }
      for (let t = 0; t < triangles.length; t += 3) {
        idx.push(frontBase + triangles[t], frontBase + triangles[t + 1], frontBase + triangles[t + 2]);
      }

      const backBase = pos.length / 3;
      for (let i = 0; i < vertices.length; i++) {
        const [x, y] = vertices[i];
        pushVertex(x, y, zBack, 0, 0, -1, 1 - (x - minX) / spanX, (y - minY) / spanY);
      }
      for (let t = 0; t < triangles.length; t += 3) {
        idx.push(backBase + triangles[t], backBase + triangles[t + 2], backBase + triangles[t + 1]);
      }
    }

    // 2. Paredes laterales extruidas con normales suavizadas hasta umbral de 35°
    const rings = [shape.outer, ...shape.holes];
    for (const ring of rings) {
      const n = ring.length;
      if (n < 3) continue;

      const segNormals = new Array(n);
      const segLengths = new Array(n);
      for (let i = 0; i < n; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % n];
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const len = Math.hypot(dx, dy) || 1;
        segLengths[i] = len;
        segNormals[i] = [dy / len, -dx / len];
      }

      let uAccum = 0;
      for (let i = 0; i < n; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % n];
        const nCurr = segNormals[i];
        const nPrev = segNormals[(i - 1 + n) % n];
        const nNext = segNormals[(i + 1) % n];

        let nAx = nCurr[0], nAy = nCurr[1];
        if (nPrev[0] * nCurr[0] + nPrev[1] * nCurr[1] >= creaseCos) {
          const sx = nPrev[0] + nCurr[0];
          const sy = nPrev[1] + nCurr[1];
          const sl = Math.hypot(sx, sy) || 1;
          nAx = sx / sl;
          nAy = sy / sl;
        }

        let nBx = nCurr[0], nBy = nCurr[1];
        if (nCurr[0] * nNext[0] + nCurr[1] * nNext[1] >= creaseCos) {
          const sx = nCurr[0] + nNext[0];
          const sy = nCurr[1] + nNext[1];
          const sl = Math.hypot(sx, sy) || 1;
          nBx = sx / sl;
          nBy = sy / sl;
        }

        const u0 = uAccum * invSpan;
        uAccum += segLengths[i];
        const u1 = uAccum * invSpan;

        const vAF = pushVertex(a[0], a[1], zFront, nAx, nAy, 0, u0, 1);
        const vAB = pushVertex(a[0], a[1], zBack, nAx, nAy, 0, u0, 0);
        const vBB = pushVertex(b[0], b[1], zBack, nBx, nBy, 0, u1, 0);
        const vBF = pushVertex(b[0], b[1], zFront, nBx, nBy, 0, u1, 1);

        idx.push(vAF, vAB, vBB, vAF, vBB, vBF);
      }
    }
  }

  return { pos, nor, uv, idx };
}

/**
 * Geometría 3D de texto extruido en JavaScript puro.
 * Uso:
 *   new TextGeometry('Hola 3D', { size: 0.75, depth: 0.18 })
 *   new TextGeometry({ text: 'Hola 3D', align: 'center', fontWeight: '700' })
 */
export class TextGeometry extends Geometry {
  constructor(textOrOptions = 'Made3D', options = {}) {
    super();
    this.isTextGeometry = true;

    let opts;
    if (textOrOptions && typeof textOrOptions === 'object') {
      opts = { ...DEFAULT_OPTIONS, ...textOrOptions };
    } else {
      opts = {
        ...DEFAULT_OPTIONS,
        ...options,
        text: textOrOptions === undefined || textOrOptions === null ? '' : String(textOrOptions),
      };
    }
    this.textOptions = opts;

    if (!opts._skipBuild) {
      this.rebuild(opts);
    }
  }

  rebuild(nextOpts = {}) {
    const opts = { ...this.textOptions, ...nextOpts };
    this.textOptions = opts;

    if (!String(opts.text || '').trim()) {
      this.setAttribute('position', new Float32Array(0), 3);
      this.setAttribute('normal', new Float32Array(0), 3);
      this.setAttribute('uv', new Float32Array(0), 2);
      this.setIndex(new Uint16Array(0));
      this.boundingBox = null;
      this.boundingSphere = null;
      return this;
    }

    const raster =
      typeof document !== 'undefined'
        ? rasterizeCanvasText(opts)
        : rasterizeHeadlessBitmap(opts);

    const loops = extractAlphaContours(raster.alpha, raster.width, raster.height, 127.5);
    if (!loops.length) {
      this.setAttribute('position', new Float32Array(0), 3);
      this.setAttribute('normal', new Float32Array(0), 3);
      this.setAttribute('uv', new Float32Array(0), 2);
      this.setIndex(new Uint16Array(0));
      this.boundingBox = null;
      this.boundingSphere = null;
      return this;
    }

    // Calcular centro del contenido en píxeles para centrar la malla en (0, 0, 0)
    let minPxX = Infinity, minPxY = Infinity, maxPxX = -Infinity, maxPxY = -Infinity;
    for (const loop of loops) {
      for (const [px, py] of loop) {
        if (px < minPxX) minPxX = px;
        if (px > maxPxX) maxPxX = px;
        if (py < minPxY) minPxY = py;
        if (py > maxPxY) maxPxY = py;
      }
    }
    const cx = (minPxX + maxPxX) * 0.5;
    const cy = (minPxY + maxPxY) * 0.5;
    const scale = Math.max(0.05, Number(opts.size) || DEFAULT_OPTIONS.size) / Math.max(1, raster.pxPerLine);
    const tol = (opts.simplifyTolerance ?? DEFAULT_OPTIONS.simplifyTolerance) * (raster.pxPerLine / 72);

    const shapes = buildShapesFromLoops(loops, scale, cx, cy, tol);
    const { pos, nor, uv, idx } = buildExtrudedBuffers(shapes, Number(opts.depth) || DEFAULT_OPTIONS.depth);

    this.setAttribute('position', pos, 3);
    this.setAttribute('normal', nor, 3);
    this.setAttribute('uv', uv, 2);
    this.setIndex(idx);
    this.boundingBox = null;
    this.boundingSphere = null;
    return this;
  }

  clone() {
    const cloned = new TextGeometry({ ...this.textOptions, _skipBuild: true });
    for (const k in this.attributes) {
      const a = this.attributes[k];
      cloned.setAttribute(k, a.array.slice(), a.itemSize);
    }
    for (const k in this.morphAttributes) {
      cloned.morphAttributes[k] = (this.morphAttributes[k] || []).map((a) => new BufferAttribute(a.array.slice(), a.itemSize));
    }
    cloned.morphTargetsRelative = this.morphTargetsRelative;
    if (this.index) cloned.setIndex(this.index.array.slice());
    delete cloned.textOptions._skipBuild;
    return cloned;
  }
}
