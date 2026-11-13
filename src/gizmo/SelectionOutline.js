import { Vec3 as Vector3 } from '../math/Vec3.js';
import { Mat4 as Matrix4 } from '../math/Mat4.js';

/**
 * Contorno de selección estilo Blender, dibujado en el canvas 2D del gizmo (sin modelos 3D).
 * Se rellena la silueta (lo que el objeto cubre en pantalla) y se dibuja un anillo por fuera.
 * Naranja claro = objeto activo (el último), naranja = el resto. Lo comparten GizmoMade3d y GizmoClassic.
 */

// Topología por geometría: vértices soldados por posición, normales de cara y si la malla es abierta.
const _topo = new WeakMap();
let _stamp = 0;

export function topology(g, maxFaces = 150000) {
  const pos = g.attributes.position && g.attributes.position.array; if (!pos) return null;
  let t = _topo.get(g); if (t && t.version === g.version) return t;
  const n0 = pos.length / 3, idx = g.index && g.index.array, nf = Math.floor((idx ? idx.length : n0) / 3);
  if (nf > maxFaces) return null;
  const map = new Map(), cid = new Int32Array(n0), cp = [];
  for (let i = 0; i < n0; i++) {
    const k = Math.round(pos[3 * i] * 1e5) + ',' + Math.round(pos[3 * i + 1] * 1e5) + ',' + Math.round(pos[3 * i + 2] * 1e5);
    let c = map.get(k);
    if (c === undefined) { c = cp.length / 3; map.set(k, c); cp.push(pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]); }
    cid[i] = c;
  }
  const nvc = cp.length / 3, fn = new Float32Array(nf * 3), fi = new Int32Array(nf), fv = new Int32Array(nf * 3), em = new Map();
  for (let f = 0; f < nf; f++) {
    const a = cid[idx ? idx[3 * f] : 3 * f], b = cid[idx ? idx[3 * f + 1] : 3 * f + 1], c = cid[idx ? idx[3 * f + 2] : 3 * f + 2];
    const e1x = cp[3 * b] - cp[3 * a], e1y = cp[3 * b + 1] - cp[3 * a + 1], e1z = cp[3 * b + 2] - cp[3 * a + 2];
    const e2x = cp[3 * c] - cp[3 * a], e2y = cp[3 * c + 1] - cp[3 * a + 1], e2z = cp[3 * c + 2] - cp[3 * a + 2];
    fn[3 * f] = e1y * e2z - e1z * e2y; fn[3 * f + 1] = e1z * e2x - e1x * e2z; fn[3 * f + 2] = e1x * e2y - e1y * e2x;
    fi[f] = a; fv[3 * f] = a; fv[3 * f + 1] = b; fv[3 * f + 2] = c;
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      if (p === q) continue;
      const k = p < q ? p * nvc + q : q * nvc + p, e = em.get(k);
      em.set(k, e === undefined ? 1 : e + 1);
    }
  }
  let open = false; for (const n of em.values()) if (n === 1) { open = true; break; }   // aristas con una sola cara: malla abierta (plano, etc.)
  t = { version: g.version, nf, open, cp: Float32Array.from(cp), fn, fi, fv, sx: new Float32Array(nvc), sy: new Float32Array(nvc), sw: new Float32Array(nvc), st: new Int32Array(nvc) };
  _topo.set(g, t); return t;
}

const _M = new Matrix4(), _I = new Matrix4(), _cl = new Vector3(), _ct = new Vector3();

export class SelectionOutline {
  constructor() {
    this.samples = 12;          // más muestras = anillo más liso (y más caro)
    this.width = 2.4;           // grosor del anillo en píxeles CSS
    // por encima de este número de caras se usa el círculo de respaldo (en teléfonos, menos)
    this.maxFaces = (typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '')) ? 60000 : 150000;
    this._m = null;
    this._cache = new WeakMap();   // contorno ya calculado por objeto: si nada cambió, solo se vuelve a pintar
  }
  _masks(w, h) {
    let m = this._m;
    if (!m) m = this._m = [0, 1].map(() => { const cv = document.createElement('canvas'); return { cv, cx: cv.getContext('2d') }; });
    if (m[0].cv.width !== w || m[0].cv.height !== h) m.forEach((k) => { k.cv.width = w; k.cv.height = h; });
    return m;
  }
  // Dibuja el contorno de `o` y de todas sus mallas hijas en el contexto `c` del gizmo `g`.
  drawTree(c, g, o, col) {
    if (!o.visible) return;
    if (o.isMesh) this.draw(c, g, o, col);
    for (const k of o.children) this.drawTree(c, g, k, col);
  }
  draw(c, g, o, col) {
    o.updateWorldMatrix(true, false);
    const geo = o.geometry, t = geo && !o.isSkinnedMesh && !o.isInstancedMesh && topology(geo, this.maxFaces), dpr = g.dpr, ov = g.ov;
    if (!t) {   // respaldo (esqueletos, instancias, mallas enormes): círculo sobre la esfera envolvente
      let r = 0, hasSphere = false;
      if (o.isSkinnedMesh && o.skeleton && o.skeleton.bones.length) {
        o.skeleton.update();
        _ct.copy(o.skeleton.center);
        r = o.skeleton.radius + o.skinPad * o.skeleton.maxScale;
        hasSphere = true;
      } else if (o.isInstancedMesh && !o.boundingSphere && o.geometry) {
        const bs = o.geometry.getBoundingSphere();
        const arr = o.instanceMatrix && o.instanceMatrix.array;
        const total = arr ? Math.min(o.count, (arr.length / 16) | 0) : 0;
        if (bs && total > 0) {
          const me = o.matrixWorld.elements, ms = o.matrixWorld.getMaxScale();
          const cx = bs.center.x, cy = bs.center.y, cz = bs.center.z;
          let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
          for (let i = 0; i < total; i++) {
            const k = i * 16;
            const ix = arr[k] * cx + arr[k + 4] * cy + arr[k + 8] * cz + arr[k + 12];
            const iy = arr[k + 1] * cx + arr[k + 5] * cy + arr[k + 9] * cz + arr[k + 13];
            const iz = arr[k + 2] * cx + arr[k + 6] * cy + arr[k + 10] * cz + arr[k + 14];
            const wx = me[0] * ix + me[4] * iy + me[8] * iz + me[12];
            const wy = me[1] * ix + me[5] * iy + me[9] * iz + me[13];
            const wz = me[2] * ix + me[6] * iy + me[10] * iz + me[14];
            if (wx < x0) x0 = wx; if (wx > x1) x1 = wx;
            if (wy < y0) y0 = wy; if (wy > y1) y1 = wy;
            if (wz < z0) z0 = wz; if (wz > z1) z1 = wz;
          }
          _ct.set((x0 + x1) * 0.5, (y0 + y1) * 0.5, (z0 + z1) * 0.5);
          for (let i = 0; i < total; i++) {
            const k = i * 16;
            const ix = arr[k] * cx + arr[k + 4] * cy + arr[k + 8] * cz + arr[k + 12];
            const iy = arr[k + 1] * cx + arr[k + 5] * cy + arr[k + 9] * cz + arr[k + 13];
            const iz = arr[k + 2] * cx + arr[k + 6] * cy + arr[k + 10] * cz + arr[k + 14];
            const wx = me[0] * ix + me[4] * iy + me[8] * iz + me[12];
            const wy = me[1] * ix + me[5] * iy + me[9] * iz + me[13];
            const wz = me[2] * ix + me[6] * iy + me[10] * iz + me[14];
            const s = Math.sqrt(Math.max(
              arr[k] * arr[k] + arr[k + 1] * arr[k + 1] + arr[k + 2] * arr[k + 2],
              arr[k + 4] * arr[k + 4] + arr[k + 5] * arr[k + 5] + arr[k + 6] * arr[k + 6],
              arr[k + 8] * arr[k + 8] + arr[k + 9] * arr[k + 9] + arr[k + 10] * arr[k + 10]));
            const d = Math.hypot(wx - _ct.x, wy - _ct.y, wz - _ct.z) + bs.radius * ms * s;
            if (d > r) r = d;
          }
          hasSphere = true;
        }
      } else if (o.boundingSphere) {
        _ct.copy(o.boundingSphere.center).applyMatrix4(o.matrixWorld);
        r = o.boundingSphere.radius * o.matrixWorld.getMaxScale();
        hasSphere = true;
      } else if (o.getWorldSphere) {
        r = o.getWorldSphere(_ct);
        hasSphere = true;
      }
      if (hasSphere) {
        const p = g._proj(_ct);
        if (p.w <= 0.01) return;
        const worldH = g.camera.fov ? 2 * p.w * Math.tan(g.camera.fov * Math.PI / 360) : Math.abs((g.camera.top ?? 1) - (g.camera.bottom ?? -1));
        c.strokeStyle = col; c.lineWidth = this.width; c.beginPath();
        c.arc(p.x, p.y, Math.min(r / ((worldH || 1) / g.H), 2000), 0, 7); c.stroke();
      }
      return;
    }
    const cam = g.camera;
    _M.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).multiply(o.matrixWorld);
    const M = _M.elements, ce = cam.matrixWorld.elements;
    // Caché: si ni la cámara, ni el objeto, ni el tamaño cambiaron se reutiliza el contorno anterior.
    // Los objetos muy pesados (> 10 ms) se recalculan como máximo un cuadro sí y uno no mientras se mueven.
    let ent = this._cache.get(o);
    if (!ent) { ent = { M: new Float32Array(16), key: '', cv: null, cx: null, bx: 0, by: 0, bw: 0, bh: 0, empty: true, cost: 0, skip: 0, valid: false }; this._cache.set(o, ent); }
    const key = g.W + ',' + g.H + ',' + dpr + ',' + col + ',' + t.version + ',' + this.width + ',' + this.samples;
    let same = ent.valid && ent.key === key;
    if (same) for (let i = 0; i < 16; i++) if (ent.M[i] !== M[i]) { same = false; break; }
    if (same || (ent.valid && ent.key === key && ent.cost > 10 && ent.skip < 1)) {
      if (!same) ent.skip++;
      if (!ent.empty) c.drawImage(ent.cv, 0, 0, ent.bw, ent.bh, ent.bx / dpr, ent.by / dpr, ent.bw / dpr, ent.bh / dpr);
      return;
    }
    ent.skip = 0; const t0 = performance.now();
    _I.copy(o.matrixWorld).invert();
    const isOrtho = cam.fov === undefined;
    if (isOrtho) {
      const ie = _I.elements, vx = ce[8], vy = ce[9], vz = ce[10];
      _cl.set(ie[0] * vx + ie[4] * vy + ie[8] * vz, ie[1] * vx + ie[5] * vy + ie[9] * vz, ie[2] * vx + ie[6] * vy + ie[10] * vz);
    } else {
      _cl.set(ce[12], ce[13], ce[14]).applyMatrix4(_I);
    }
    const { cp, fn, fi, fv, sx, sy, sw, st } = t, stamp = ++_stamp, W = g.W, H = g.H;
    const P = (i) => {
      if (st[i] === stamp) return;
      const x = cp[3 * i], y = cp[3 * i + 1], z = cp[3 * i + 2], w = M[3] * x + M[7] * y + M[11] * z + M[15];
      sw[i] = w; sx[i] = ((M[0] * x + M[4] * y + M[8] * z + M[12]) / w * 0.5 + 0.5) * W; sy[i] = (1 - ((M[1] * x + M[5] * y + M[9] * z + M[13]) / w * 0.5 + 0.5)) * H; st[i] = stamp;
    };
    const path = new Path2D(); let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (let f = 0; f < t.nf; f++) {
      if (!t.open) {
        let facing;
        if (isOrtho) facing = fn[3 * f] * _cl.x + fn[3 * f + 1] * _cl.y + fn[3 * f + 2] * _cl.z > 0;
        else { const v = fi[f] * 3; facing = fn[3 * f] * (_cl.x - cp[v]) + fn[3 * f + 1] * (_cl.y - cp[v + 1]) + fn[3 * f + 2] * (_cl.z - cp[v + 2]) > 0; }
        if (!facing) continue;
      }
      const a = fv[3 * f], b = fv[3 * f + 1], d = fv[3 * f + 2]; P(a); P(b); P(d);
      if (sw[a] < 0.01 || sw[b] < 0.01 || sw[d] < 0.01) continue;
      const flip = (sx[b] - sx[a]) * (sy[d] - sy[a]) - (sx[d] - sx[a]) * (sy[b] - sy[a]) < 0, q = flip ? d : b, r = flip ? b : d;   // mismo sentido en todas: la unión rellena sin huecos
      path.moveTo(sx[a], sy[a]); path.lineTo(sx[q], sy[q]); path.lineTo(sx[r], sy[r]); path.closePath();
      x0 = Math.min(x0, sx[a], sx[b], sx[d]); y0 = Math.min(y0, sy[a], sy[b], sy[d]); x1 = Math.max(x1, sx[a], sx[b], sx[d]); y1 = Math.max(y1, sy[a], sy[b], sy[d]);
    }
    if (x0 > x1) { ent.empty = true; ent.valid = true; ent.key = key; ent.M.set(M); ent.cost = performance.now() - t0; return; }
    const R = this.width * dpr, pad = Math.ceil(R) + 2, bx = Math.max(0, Math.floor(x0 * dpr) - pad), by = Math.max(0, Math.floor(y0 * dpr) - pad);
    const bw = Math.min(ov.width, Math.ceil(x1 * dpr) + pad) - bx, bh = Math.min(ov.height, Math.ceil(y1 * dpr) + pad) - by;
    if (bw <= 0 || bh <= 0) { ent.empty = true; ent.valid = true; ent.key = key; ent.M.set(M); ent.cost = performance.now() - t0; return; }
    const [A, B] = this._masks(ov.width, ov.height), a = A.cx, b = B.cx, n = this.samples;
    a.setTransform(1, 0, 0, 1, 0, 0); a.clearRect(bx, by, bw, bh); a.setTransform(dpr, 0, 0, dpr, 0, 0); a.fillStyle = '#000'; a.fill(path);   // máscara de la silueta
    b.setTransform(1, 0, 0, 1, 0, 0); b.globalCompositeOperation = 'source-over'; b.clearRect(bx, by, bw, bh);
    for (let i = 0; i < n; i++) { const an = i / n * Math.PI * 2; b.drawImage(A.cv, bx, by, bw, bh, bx + Math.cos(an) * R, by + Math.sin(an) * R, bw, bh); }   // dilatación
    b.globalCompositeOperation = 'destination-out'; b.drawImage(A.cv, bx, by, bw, bh, bx, by, bw, bh);   // anillo = dilatada − silueta
    b.globalCompositeOperation = 'source-in'; b.fillStyle = col; b.fillRect(bx, by, bw, bh); b.globalCompositeOperation = 'source-over';
    c.drawImage(B.cv, bx, by, bw, bh, bx / dpr, by / dpr, bw / dpr, bh / dpr);
    // guardar el resultado para los próximos cuadros
    if (!ent.cv) { ent.cv = document.createElement('canvas'); ent.cx = ent.cv.getContext('2d'); }
    if (ent.cv.width !== bw || ent.cv.height !== bh) { ent.cv.width = bw; ent.cv.height = bh; } else ent.cx.clearRect(0, 0, bw, bh);
    ent.cx.drawImage(B.cv, bx, by, bw, bh, 0, 0, bw, bh);
    ent.bx = bx; ent.by = by; ent.bw = bw; ent.bh = bh; ent.empty = false; ent.valid = true; ent.key = key; ent.M.set(M); ent.cost = performance.now() - t0;
  }
}
