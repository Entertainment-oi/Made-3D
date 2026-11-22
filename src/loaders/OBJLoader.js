import { Object3D } from '../core/Object3D.js';
import { Mesh } from '../objects/Mesh.js';
import { Geometry } from '../geometry/Geometry.js';
import { StandardMaterial } from '../materials/BuiltinMaterials.js';
import { Texture } from '../textures/Texture.js';
import { computeBounds, autoScaleObject } from '../core/autoScale.js';

/**
 * Importador de Wavefront OBJ (+ MTL), sin huesos ni animación.
 *   const obj = await new OBJLoader().load('modelo.obj');   // carga también el .mtl y sus texturas
 *   scene.add(obj);
 *
 * Soporta v / vt / vn / f (polígonos de cualquier tamaño, índices negativos), o / g / usemtl / mtllib.
 * Cada combinación objeto + material es un Mesh (hijo del grupo devuelto). Si el archivo no trae normales
 * se calculan. MTL: Kd (color), map_Kd (textura), d / Tr (opacidad), Ns + Ks (brillo), Ke (emisivo).
 * Ignorados: líneas (l), puntos (p), suavizado (s), curvas y superficies.
 *
 * `parse(texto, { mtl, basePath, textureLoader })`: `mtl` es el texto del .mtl (opcional) y `textureLoader`
 * una función `(ruta) => Texture` (por defecto Texture.load).
 */
export class OBJLoader {
  constructor(opts = {}) {
    this.autoScale = typeof opts.autoScale === 'object' ? opts.autoScale.enabled !== false : !!opts.autoScale;
    this.autoScaleOptions = {
      ...(typeof opts.autoScale === 'object' && opts.autoScale ? opts.autoScale : {}),
      ...(opts.autoScaleOptions || {}),
      ...(opts.scene ? { scene: opts.scene } : {}),
      ...(opts.targetSize !== undefined ? { targetSize: opts.targetSize } : {}),
    };
  }

  async load(url, opts = {}) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`OBJLoader: no se pudo cargar ${url} (${res.status})`);
    const text = await res.text();
    const base = url.includes('/') ? url.slice(0, url.lastIndexOf('/') + 1) : '';
    let mtl = '';
    for (const lib of findMtllibs(text)) {
      try { const r = await fetch(base + lib); if (r.ok) mtl += '\n' + (await r.text()); else console.warn(`OBJLoader: no se encontró ${lib}`); }
      catch (e) { console.warn(`OBJLoader: no se pudo leer ${lib}: ${e.message}`); }
    }
    return this.parse(text, { ...opts, mtl, basePath: base });
  }

  // File (selector de archivos / ZIP / carpeta). Pasa en `extraFiles` el .mtl y las imágenes.
  async loadFile(file, extraFiles = [], opts = {}) {
    const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
    const allFiles = [file, ...extraFiles];
    const filesByPath = {};
    const filesByName = {};
    for (const f of allFiles) {
      const rp = norm(f.relativePath || f.webkitRelativePath || '');
      if (rp) filesByPath[rp] = f;
      if (f.name && !filesByName[f.name]) filesByName[f.name] = f;
    }
    const baseDir = (() => {
      const rp = norm(file.relativePath || file.webkitRelativePath || '');
      const idx = rp.lastIndexOf('/');
      return idx >= 0 ? rp.slice(0, idx + 1) : '';
    })();
    const findFile = (rawPath) => {
      const clean = norm(decodeURIComponent(rawPath || ''));
      const joined = baseDir && !clean.startsWith(baseDir) ? norm(baseDir + clean) : clean;
      return (
        filesByPath[joined] ||
        filesByPath[clean] ||
        filesByName[clean] ||
        filesByName[clean.split('/').pop()] ||
        null
      );
    };

    const text = await file.text();
    let mtl = '';
    for (const lib of findMtllibs(text)) {
      const f = findFile(lib);
      if (f) mtl += '\n' + (await f.text());
    }
    const textureLoader = (path) => {
      const f = findFile(path);
      if (!f) { console.warn(`OBJLoader: falta la imagen ${path}`); return null; }
      const u = URL.createObjectURL(f);
      const tex = Texture.load(u);
      const img = tex.image;
      if (img && typeof img.addEventListener === 'function') {
        const revoke = () => URL.revokeObjectURL(u);
        img.addEventListener('load', revoke, { once: true });
        img.addEventListener('error', revoke, { once: true });
      } else if (img) {
        const prevLoad = img.onload;
        const prevErr = img.onerror;
        img.onload = () => { if (prevLoad) prevLoad(); URL.revokeObjectURL(u); };
        img.onerror = () => { if (prevErr) prevErr(); URL.revokeObjectURL(u); };
      }
      return tex;
    };
    return this.parse(text, { ...opts, mtl, textureLoader });
  }

  parse(text, opts = {}) {
    const base = opts.basePath || '';
    const loadTex = opts.textureLoader || ((p) => (typeof Image === 'undefined' ? null : Texture.load(base + p)));
    const mats = opts.mtl ? parseMTL(opts.mtl, loadTex) : {};
    const V = [], VT = [], VN = [];
    const groups = new Map();
    let obj = '', grp = '', mat = '';
    const builder = () => {
      const key = obj + '\u0001' + grp + '\u0001' + mat;
      let b = groups.get(key);
      if (!b) { b = { name: obj || grp || mat, mat, pos: [], nor: [], uv: [], idx: [], lookup: new Map(), hasN: false, missN: false, hasT: false }; groups.set(key, b); }
      return b;
    };
    const corner = (b, tok) => {
      const parts = tok.split('/');
      let vi = parseInt(parts[0], 10), ti = parts.length > 1 && parts[1] !== '' ? parseInt(parts[1], 10) : 0, ni = parts.length > 2 && parts[2] !== '' ? parseInt(parts[2], 10) : 0;
      vi = vi < 0 ? V.length / 3 + vi : vi - 1;
      ti = ti ? (ti < 0 ? VT.length / 2 + ti : ti - 1) : -1;
      ni = ni ? (ni < 0 ? VN.length / 3 + ni : ni - 1) : -1;
      let list = b.lookup.get(vi);
      if (list) for (let k = 0; k < list.length; k += 3) if (list[k] === ti && list[k + 1] === ni) return list[k + 2];
      const out = b.pos.length / 3;
      const vx = vi >= 0 && vi * 3 + 2 < V.length ? V[vi * 3] : 0;
      const vy = vi >= 0 && vi * 3 + 2 < V.length ? V[vi * 3 + 1] : 0;
      const vz = vi >= 0 && vi * 3 + 2 < V.length ? V[vi * 3 + 2] : 0;
      b.pos.push(vx, vy, vz);
      if (ni >= 0 && ni * 3 + 2 < VN.length) { b.nor.push(VN[ni * 3], VN[ni * 3 + 1], VN[ni * 3 + 2]); b.hasN = true; }
      else { b.nor.push(0, 0, 0); b.missN = true; }
      if (ti >= 0 && ti * 2 + 1 < VT.length) { b.uv.push(VT[ti * 2], VT[ti * 2 + 1]); b.hasT = true; }
      else b.uv.push(0, 0);
      if (!list) { list = []; b.lookup.set(vi, list); }
      list.push(ti, ni, out);
      return out;
    };

    const lines = text.split('\n');
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li].trim();
      if (!line || line.charCodeAt(0) === 35) continue;   // vacía o comentario (#)
      const t = line.split(/\s+/), k = t[0];
      if (k === 'v') V.push(+t[1] || 0, +t[2] || 0, +t[3] || 0);
      else if (k === 'vt') VT.push(+t[1] || 0, +t[2] || 0);
      else if (k === 'vn') VN.push(+t[1] || 0, +t[2] || 0, +t[3] || 0);
      else if (k === 'f') {
        const b = builder(), n = t.length - 1;
        if (n < 3) continue;
        const c0 = corner(b, t[1]);
        for (let i = 2; i < n; i++) b.idx.push(c0, corner(b, t[i]), corner(b, t[i + 1]));   // abanico de triángulos
      } else if (k === 'o') obj = line.slice(k.length).trim();
      else if (k === 'g') grp = line.slice(k.length).trim();
      else if (k === 'usemtl') mat = line.slice(k.length).trim();
    }

    const root = new Object3D();
    const made = {};
    const materialFor = (name) => {
      if (!(name in made)) made[name] = mats[name] || new StandardMaterial({ color: 0xcccccc });
      return made[name];
    };
    let n = 0;
    for (const b of groups.values()) {
      if (!b.idx.length) continue;
      const g = new Geometry();
      g.setAttribute('position', Float32Array.from(b.pos), 3);
      if (b.hasN && !b.missN) g.setAttribute('normal', Float32Array.from(b.nor), 3);
      if (b.hasT) g.setAttribute('uv', Float32Array.from(b.uv), 2);
      g.setIndex(b.idx);
      if (!g.attributes.normal) g.computeNormals();
      const mesh = new Mesh(g, materialFor(b.mat));
      mesh.name = b.name || 'obj' + n++;
      mesh.castShadow = true;
      root.add(mesh);
    }
    root.userData.materials = made;
    root.userData.bounds = computeBounds(root);
    const scaleOpt = opts.autoScale !== undefined ? opts.autoScale : this.autoScale;
    const scaleEnabled = typeof scaleOpt === 'object' ? scaleOpt.enabled !== false : !!scaleOpt;
    if (scaleEnabled) {
      const merged = {
        ...this.autoScaleOptions,
        ...(typeof scaleOpt === 'object' && scaleOpt ? scaleOpt : {}),
        ...opts,
      };
      root.userData.autoScale = autoScaleObject(root, merged);
      root.userData.bounds = computeBounds(root);
    }
    return root;
  }
}

function findMtllibs(text) {
  const out = [];
  for (const l of text.split('\n')) { const m = /^\s*mtllib\s+(.+?)\s*$/.exec(l); if (m) out.push(m[1]); }
  return out;
}

function parseMTL(text, loadTex) {
  const mats = {};
  let cur = null, ks = 0;
  const finish = () => {
    if (cur && ks > 0.02 && cur.shininess > 0) cur.specular = Math.min(1, ks);
    else if (cur) cur.shininess = 0;
  };
  const num = (s, d = 0) => { const v = Number(s); return Number.isFinite(v) ? v : d; };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.charCodeAt(0) === 35) continue;
    const t = line.split(/\s+/), k = t[0];
    if (k === 'newmtl') { finish(); cur = new StandardMaterial({ color: 0xcccccc }); cur.name = line.slice(7).trim(); mats[cur.name] = cur; ks = 0; }
    else if (!cur) continue;
    else if (k === 'Kd') {
      const r = num(t[1], 1), g = t[2] !== undefined ? num(t[2], r) : r, b = t[3] !== undefined ? num(t[3], r) : r;
      cur.color.set(r, g, b);
    } else if (k === 'Ke') {
      const r = num(t[1], 0), g = t[2] !== undefined ? num(t[2], r) : r, b = t[3] !== undefined ? num(t[3], r) : r;
      cur.emissive.set(r, g, b);
    } else if (k === 'Ks') {
      const r = num(t[1], 0), g = t[2] !== undefined ? num(t[2], r) : r, b = t[3] !== undefined ? num(t[3], r) : r;
      ks = (r + g + b) / 3;
    } else if (k === 'Ns') cur.shininess = Math.max(0, Math.min(128, num(t[1], 0)));
    else if (k === 'd' || k === 'Tr') {
      const a = k === 'd' ? num(t[1], 1) : 1 - num(t[1], 0);
      if (a < 1) { cur.opacity = Math.max(0, Math.min(1, a)); cur.transparent = true; }
    } else if (k === 'map_Kd') {
      const file = mapFile(t.slice(1));
      const tex = file ? loadTex(file) : null;
      if (tex) cur.map = tex;
    }
  }
  finish();
  return mats;
}

// Opciones de los mapas del MTL (-s 1 1 1, -o 0 0 0, -bm 1...): cuántos valores lleva cada una.
const MAP_OPT = { '-s': 3, '-o': 3, '-t': 3, '-mm': 2, '-bm': 1, '-blendu': 1, '-blendv': 1, '-cc': 1, '-clamp': 1, '-imfchan': 1, '-texres': 1, '-type': 1 };
function mapFile(tokens) {
  let i = 0;
  while (i < tokens.length && tokens[i].startsWith('-') && tokens[i] in MAP_OPT) i += 1 + MAP_OPT[tokens[i]];
  return tokens.slice(i).join(' ');   // el nombre puede llevar espacios
}
