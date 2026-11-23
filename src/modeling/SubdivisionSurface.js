import { EditableMesh, edgeKey } from './EditableMesh.js';
import { decimateMeshQEM } from './MeshUnion.js';

export const MAX_SUBSURF_FACES = 80000;
export const MIN_DENSITY_VERTS = 4;
export const MAX_DENSITY_FACES = 45000;
export const MAX_DENSITY_VERTS = 45000;

/**
 * Ejecuta un paso de subdivisión Catmull-Clark sobre un EditableMesh,
 * produciendo una malla compuesta únicamente de caras cuadrangulares suaves.
 */
export function catmullClarkStep(mesh, smoothness = 1) {
  if (!mesh || !mesh.faces.length) return mesh ? mesh.clone() : new EditableMesh();
  const s = Number.isFinite(Number(smoothness)) ? Math.max(0, Math.min(1, Number(smoothness))) : 1;

  const V = mesh.verts.length;
  const F = mesh.faces.length;
  const topo = mesh.getTopology();
  const { edges, vertFaces, vertEdges } = topo;
  const E = edges.length;

  // 1. Puntos de cara F_f (promedio de los vértices de cada cara)
  const facePoints = new Array(F);
  const faceUvs = new Array(F);
  for (let fi = 0; fi < F; fi++) {
    const f = mesh.faces[fi];
    const uvList = mesh.faceUvs[fi] || [];
    const k = f.length || 1;
    let sx = 0, sy = 0, sz = 0, su = 0, sv = 0;
    for (let i = 0; i < f.length; i++) {
      const p = mesh.verts[f[i]];
      sx += p.x; sy += p.y; sz += p.z;
      const uv = uvList[i];
      if (uv) { su += uv[0]; sv += uv[1]; }
    }
    const inv = 1 / k;
    facePoints[fi] = { x: sx * inv, y: sy * inv, z: sz * inv };
    faceUvs[fi] = [su * inv, sv * inv];
  }

  // 2. Puntos de arista E_e y puntos medios (respetando dureza individual / crease por arista)
  const edgePoints = new Array(E);
  const edgeMidPoints = new Array(E);
  const edgeMidUvs = new Array(E);
  const edgeCreases = new Float32Array(E);
  const isBoundaryEdge = new Uint8Array(E);

  for (let ei = 0; ei < E; ei++) {
    const e = edges[ei];
    const cr = mesh.getEdgeCrease ? mesh.getEdgeCrease(e.a, e.b) : 0;
    edgeCreases[ei] = cr;
    const sharpWeight = Math.max(0, Math.min(1, cr));
    const effectiveSmooth = s * (1 - sharpWeight);

    const va = mesh.verts[e.a];
    const vb = mesh.verts[e.b];
    const mx = (va.x + vb.x) * 0.5;
    const my = (va.y + vb.y) * 0.5;
    const mz = (va.z + vb.z) * 0.5;
    edgeMidPoints[ei] = { x: mx, y: my, z: mz };

    // Promediar UVs de los extremos desde la primera cara incidente
    let ua = 0, vaUv = 0, ub = 0, vbUv = 0;
    if (e.faces.length > 0) {
      const f0 = mesh.faces[e.faces[0]];
      const uv0 = mesh.faceUvs[e.faces[0]] || [];
      for (let i = 0; i < f0.length; i++) {
        if (f0[i] === e.a && uv0[i]) { ua = uv0[i][0]; vaUv = uv0[i][1]; }
        if (f0[i] === e.b && uv0[i]) { ub = uv0[i][0]; vbUv = uv0[i][1]; }
      }
    }
    edgeMidUvs[ei] = [(ua + ub) * 0.5, (vaUv + vbUv) * 0.5];

    if (e.faces.length === 2) {
      const fp0 = facePoints[e.faces[0]];
      const fp1 = facePoints[e.faces[1]];
      const cx = (va.x + vb.x + fp0.x + fp1.x) * 0.25;
      const cy = (va.y + vb.y + fp0.y + fp1.y) * 0.25;
      const cz = (va.z + vb.z + fp0.z + fp1.z) * 0.25;
      edgePoints[ei] = {
        x: mx + (cx - mx) * effectiveSmooth,
        y: my + (cy - my) * effectiveSmooth,
        z: mz + (cz - mz) * effectiveSmooth,
      };
    } else if (e.faces.length > 2) {
      let sx = va.x + vb.x, sy = va.y + vb.y, sz = va.z + vb.z;
      for (let i = 0; i < e.faces.length; i++) {
        const fp = facePoints[e.faces[i]];
        sx += fp.x; sy += fp.y; sz += fp.z;
      }
      const inv = 1 / (2 + e.faces.length);
      const cx = sx * inv, cy = sy * inv, cz = sz * inv;
      edgePoints[ei] = {
        x: mx + (cx - mx) * effectiveSmooth,
        y: my + (cy - my) * effectiveSmooth,
        z: mz + (cz - mz) * effectiveSmooth,
      };
    } else {
      isBoundaryEdge[ei] = 1;
      edgePoints[ei] = { x: mx, y: my, z: mz };
    }
  }

  // 3. Nuevas posiciones de vértices originales V'
  const newVerts = new Array(V + F + E);
  for (let vi = 0; vi < V; vi++) {
    const p = mesh.verts[vi];
    const incFaces = vertFaces[vi] || [];
    const incEdges = vertEdges[vi] || [];

    const boundaryEdges = [];
    const sharpEdges = [];
    for (let i = 0; i < incEdges.length; i++) {
      const ei = incEdges[i];
      if (isBoundaryEdge[ei]) boundaryEdges.push(ei);
      if (edgeCreases[ei] > 0.001) sharpEdges.push({ ei, w: edgeCreases[ei] });
    }

    // Calcular regla base (borde abierto o regla interior Catmull-Clark suave)
    let smoothPos;
    if (boundaryEdges.length >= 2) {
      let bx = 0, by = 0, bz = 0;
      for (let i = 0; i < boundaryEdges.length; i++) {
        const m = edgeMidPoints[boundaryEdges[i]];
        bx += m.x; by += m.y; bz += m.z;
      }
      const invB = 1 / boundaryEdges.length;
      const cx = p.x * 0.75 + bx * invB * 0.25;
      const cy = p.y * 0.75 + by * invB * 0.25;
      const cz = p.z * 0.75 + bz * invB * 0.25;
      smoothPos = {
        x: p.x + (cx - p.x) * s,
        y: p.y + (cy - p.y) * s,
        z: p.z + (cz - p.z) * s,
      };
    } else {
      const n = incFaces.length;
      const m = incEdges.length;
      if (n >= 3 && n === m) {
        let qx = 0, qy = 0, qz = 0;
        for (let i = 0; i < n; i++) {
          const fp = facePoints[incFaces[i]];
          qx += fp.x; qy += fp.y; qz += fp.z;
        }
        let rx = 0, ry = 0, rz = 0;
        for (let i = 0; i < m; i++) {
          const em = edgeMidPoints[incEdges[i]];
          rx += em.x; ry += em.y; rz += em.z;
        }
        const invN = 1 / n;
        qx *= invN; qy *= invN; qz *= invN;
        rx *= invN; ry *= invN; rz *= invN;
        const cx = (qx + 2 * rx + (n - 3) * p.x) * invN;
        const cy = (qy + 2 * ry + (n - 3) * p.y) * invN;
        const cz = (qz + 2 * rz + (n - 3) * p.z) * invN;
        smoothPos = {
          x: p.x + (cx - p.x) * s,
          y: p.y + (cy - p.y) * s,
          z: p.z + (cz - p.z) * s,
        };
      } else {
        smoothPos = { x: p.x, y: p.y, z: p.z };
      }
    }

    // Reglas Pixar de arista dura / esquina (crease): 0 o 1 arista dura -> suave, 2 -> pliegue, >= 3 -> esquina
    if (sharpEdges.length === 2 && boundaryEdges.length === 0) {
      const cMin = Math.min(sharpEdges[0].w, sharpEdges[1].w);
      const m0 = edgeMidPoints[sharpEdges[0].ei];
      const m1 = edgeMidPoints[sharpEdges[1].ei];
      // Regla de curva B-spline cúbica uniforme en pliegue: (va + 6*p + vb)/8 = 0.75*p + 0.125*(va + vb)
      // Como edgeMidPoint = (p + v_other)/2 -> va + vb = 2*(m0 + m1) - 2*p -> 0.5*p + 0.25*(m0 + m1)
      const creaseX = 0.5 * p.x + 0.25 * (m0.x + m1.x);
      const creaseY = 0.5 * p.y + 0.25 * (m0.y + m1.y);
      const creaseZ = 0.5 * p.z + 0.25 * (m0.z + m1.z);
      const csX = p.x + (creaseX - p.x) * s;
      const csY = p.y + (creaseY - p.y) * s;
      const csZ = p.z + (creaseZ - p.z) * s;
      newVerts[vi] = {
        x: smoothPos.x + (csX - smoothPos.x) * cMin,
        y: smoothPos.y + (csY - smoothPos.y) * cMin,
        z: smoothPos.z + (csZ - smoothPos.z) * cMin,
      };
    } else if (sharpEdges.length >= 3) {
      let wSum = 0;
      for (let i = 0; i < sharpEdges.length; i++) wSum += sharpEdges[i].w;
      const avgW = Math.min(1, wSum / sharpEdges.length);
      newVerts[vi] = {
        x: smoothPos.x + (p.x - smoothPos.x) * avgW,
        y: smoothPos.y + (p.y - smoothPos.y) * avgW,
        z: smoothPos.z + (p.z - smoothPos.z) * avgW,
      };
    } else {
      newVerts[vi] = smoothPos;
    }
  }

  for (let fi = 0; fi < F; fi++) newVerts[V + fi] = facePoints[fi];
  for (let ei = 0; ei < E; ei++) newVerts[V + F + ei] = edgePoints[ei];

  // 4. Emitir k quads nuevos por cada cara de k vértices y propagar durezas a aristas hijas
  const outFaces = [];
  const outFaceUvs = [];
  const outCreases = new Map();
  const { edgeMap } = topo;

  for (let ei = 0; ei < E; ei++) {
    const cr = edgeCreases[ei];
    if (cr <= 0.001) continue;
    // Dureza máxima (>= 0.99) permanece indefinidamente aguda; semi-dureza atenúa suavemente por paso
    const childCrease = cr >= 0.99 ? 1 : Math.max(0, cr - 0.35);
    if (childCrease > 0.001) {
      const e = edges[ei];
      const eVert = V + F + ei;
      outCreases.set(edgeKey(e.a, eVert), childCrease);
      outCreases.set(edgeKey(e.b, eVert), childCrease);
    }
  }

  for (let fi = 0; fi < F; fi++) {
    const f = mesh.faces[fi];
    const uvList = mesh.faceUvs[fi] || [];
    const k = f.length;
    const fVert = V + fi;
    const fUv = faceUvs[fi];

    for (let i = 0; i < k; i++) {
      const vCurr = f[i];
      const vNext = f[(i + 1) % k];
      const vPrev = f[(i - 1 + k) % k];
      const eNext = edgeMap.get(edgeKey(vCurr, vNext));
      const ePrev = edgeMap.get(edgeKey(vPrev, vCurr));
      if (eNext === undefined || ePrev === undefined) continue;

      const cUv = uvList[i] ? uvList[i].slice() : [0, 0];
      outFaces.push([vCurr, V + F + eNext, fVert, V + F + ePrev]);
      outFaceUvs.push([
        cUv,
        edgeMidUvs[eNext].slice(),
        fUv.slice(),
        edgeMidUvs[ePrev].slice(),
      ]);
    }
  }

  return new EditableMesh(
    newVerts,
    outFaces,
    outFaceUvs,
    mesh.looseEdges.map((e) => [e[0], e[1]]),
    outCreases
  );
}

export function estimateCatmullClarkFaces(editableMesh, levels = 1) {
  if (!editableMesh || !editableMesh.faces.length) return 0;
  const lv = Math.max(0, levels | 0);
  if (lv === 0) return editableMesh.faces.length;
  let firstStep = 0;
  for (let i = 0; i < editableMesh.faces.length; i++) {
    firstStep += editableMesh.faces[i].length;
  }
  return firstStep * Math.pow(4, lv - 1);
}

/**
 * Aplica N niveles de subdivisión Catmull-Clark controlando el presupuesto máximo de caras.
 */
export function catmullClark(editableMesh, levels = 1, maxFaces = MAX_SUBSURF_FACES, smoothness = 1) {
  if (!editableMesh) return new EditableMesh();
  const steps = Math.max(0, levels | 0);
  if (steps === 0) return editableMesh.clone();

  let current = editableMesh;
  for (let lv = 0; lv < steps; lv++) {
    let projectedQuads = 0;
    for (let fi = 0; fi < current.faces.length; fi++) {
      projectedQuads += current.faces[fi].length;
    }
    if (projectedQuads > maxFaces) break;
    current = catmullClarkStep(current, smoothness);
  }
  return current;
}

export function getMaxAllowedSubsurfLevel(editableMesh, maxFaces = MAX_SUBSURF_FACES) {
  if (!editableMesh || !editableMesh.faces.length) return 0;
  let lv = 0;
  let projected = 0;
  for (let i = 0; i < editableMesh.faces.length; i++) {
    projected += editableMesh.faces[i].length;
  }
  while (projected <= maxFaces && lv < 10) {
    lv++;
    projected *= 4;
  }
  return lv;
}

export function canIncrementSubsurf(mesh) {
  if (!isSubsurfSupported(mesh)) return false;
  const mod = mesh._subsurf;
  if (!mod || !mod.baseMesh) {
    const geo = mesh.geometry;
    const triCount = geo?.index
      ? Math.floor(geo.index.count / 3)
      : Math.floor((geo?.attributes?.position?.count || 0) / 3);
    if (triCount <= 0) return false;
    if (triCount * 2 > MAX_SUBSURF_FACES) return false;
    if (triCount * 3 <= MAX_SUBSURF_FACES) return true;
    if (geo?._modifiedBySculpt && triCount > 24000) return false;
    const est = EditableMesh.fromGeometry(geo, { reconstructQuads: triCount <= 24000 });
    return estimateCatmullClarkFaces(est, 1) <= MAX_SUBSURF_FACES;
  }
  const nextLevel = (mod.level | 0) + 1;
  return estimateCatmullClarkFaces(mod.baseMesh, nextLevel) <= MAX_SUBSURF_FACES;
}

export function getMeshSubsurf(mesh) {
  return mesh && mesh._subsurf ? mesh._subsurf : null;
}

export function isSubsurfSupported(mesh) {
  return Boolean(
    mesh &&
    mesh.isMesh &&
    !mesh.isInstancedMesh &&
    !mesh.isSkinnedMesh &&
    !(mesh.isHelper?.() || mesh.isGridHelper || mesh.isCameraHelper || mesh.isSkeletonHelper) &&
    (typeof mesh.isPickable === 'function' ? mesh.isPickable() : true) &&
    mesh.geometry?.attributes?.position
  );
}

export function syncEditableBaseFromGeometry(mesh) {
  if (!isSubsurfSupported(mesh)) return null;
  const geo = mesh.geometry;
  const triCount = geo?.index
    ? Math.floor(geo.index.count / 3)
    : Math.floor((geo?.attributes?.position?.count || 0) / 3);
  const skipQuadMerge = Boolean(geo?._modifiedBySculpt && triCount > 24000);
  const nextBase = EditableMesh.fromGeometry(geo, { reconstructQuads: !skipQuadMerge });
  if (!mesh._subsurf) {
    mesh._subsurf = {
      level: 0,
      smoothness: 1,
      smoothShading: true,
      showCage: true,
      alwaysShowCage: false,
      baseMesh: nextBase,
    };
  } else {
    mesh._subsurf.baseMesh = nextBase;
    mesh._subsurf.level = 0;
    if (mesh._subsurf.alwaysShowCage === undefined) mesh._subsurf.alwaysShowCage = false;
    if (mesh._subsurf.smoothness === undefined) mesh._subsurf.smoothness = 1;
  }
  mesh._subsurfDirtyFromGeometry = false;
  if (mesh.geometry) {
    mesh.geometry._modifiedBySculpt = false;
    mesh.geometry._isGeneratedSubsurf = false;
  }
  return mesh._subsurf;
}

export function ensureEditableBase(mesh) {
  if (!isSubsurfSupported(mesh)) return null;
  if (!mesh._subsurf) {
    const baseMesh = EditableMesh.fromGeometry(mesh.geometry);
    mesh._subsurf = {
      level: 0,
      smoothness: 1,
      smoothShading: true,
      showCage: true,
      alwaysShowCage: false,
      baseMesh,
    };
    mesh._subsurfDirtyFromGeometry = false;
    if (mesh.geometry) mesh.geometry._modifiedBySculpt = false;
  } else if (
    mesh._subsurfDirtyFromGeometry ||
    (mesh.geometry && mesh.geometry._modifiedBySculpt && !mesh.geometry._isGeneratedSubsurf)
  ) {
    return syncEditableBaseFromGeometry(mesh);
  } else {
    if (!mesh._subsurf.baseMesh) {
      mesh._subsurf.baseMesh = EditableMesh.fromGeometry(mesh.geometry);
    }
    if (mesh._subsurf.alwaysShowCage === undefined) {
      mesh._subsurf.alwaysShowCage = false;
    }
    if (mesh._subsurf.smoothness === undefined) {
      mesh._subsurf.smoothness = 1;
    }
  }
  return mesh._subsurf;
}

function assignMeshGeometry(mesh, nextGeo) {
  const prevGeo = mesh.geometry;
  nextGeo._isGeneratedSubsurf = true;
  if (typeof mesh.setGeometry === 'function') mesh.setGeometry(nextGeo);
  else mesh.geometry = nextGeo;
  if (prevGeo && prevGeo !== nextGeo && prevGeo._isGeneratedSubsurf && typeof prevGeo.dispose === 'function') {
    prevGeo.dispose();
  }
}

/**
 * Reconstruye la geometría suavizada visible a partir de la jaula base `baseMesh`.
 */
export function syncMeshSubsurf(mesh) {
  const mod = mesh?._subsurf;
  if (!mod || !mod.baseMesh) return null;
  const smoothness = mod.smoothness !== undefined ? Math.max(0, Math.min(1, Number(mod.smoothness))) : 1;
  const subdiv = mod.level > 0 ? catmullClark(mod.baseMesh, mod.level, MAX_SUBSURF_FACES, smoothness) : mod.baseMesh;
  const flatShading = !mod.smoothShading;
  const nextGeo = subdiv.toGeometry({ flatShading });
  assignMeshGeometry(mesh, nextGeo);
  return nextGeo;
}

/**
 * Configura el modificador de Subdivisión Suave (alisado no destructivo) en un Mesh.
 */
export function setMeshSubsurf(mesh, options = {}) {
  if (!isSubsurfSupported(mesh)) return null;
  const mod = ensureEditableBase(mesh);
  if (!mod) return null;

  if (options.baseMesh) {
    mod.baseMesh = options.baseMesh;
    mesh._subsurfDirtyFromGeometry = false;
    if (mesh.geometry) mesh.geometry._modifiedBySculpt = false;
  }
  if (options.level !== undefined) {
    const maxLv = Math.max(mod.level | 0, getMaxAllowedSubsurfLevel(mod.baseMesh));
    mod.level = Math.max(0, Math.min(maxLv, options.level | 0));
  }
  if (options.smoothness !== undefined) {
    const raw = Number(options.smoothness);
    if (Number.isFinite(raw)) {
      mod.smoothness = Math.max(0, Math.min(1, raw));
    }
  }
  if (options.smoothShading !== undefined) {
    mod.smoothShading = Boolean(options.smoothShading);
  }
  if (options.showCage !== undefined) {
    mod.showCage = Boolean(options.showCage);
  }
  if (options.alwaysShowCage !== undefined) {
    mod.alwaysShowCage = Boolean(options.alwaysShowCage);
  }

  syncMeshSubsurf(mesh);
  return mod;
}

/**
 * Hornea ("Aplica") la subdivisión actual dentro de la malla base editable y reinicia el nivel a 0.
 */
export function applyMeshSubsurf(mesh) {
  const mod = ensureEditableBase(mesh);
  if (!mod || !mod.baseMesh || mod.level <= 0) return false;
  const smoothness = mod.smoothness !== undefined ? Math.max(0, Math.min(1, Number(mod.smoothness))) : 1;
  mod.baseMesh = catmullClark(mod.baseMesh, mod.level, MAX_SUBSURF_FACES, smoothness);
  mod.level = 0;
  syncMeshSubsurf(mesh);
  return true;
}

export function snapshotMeshModelingState(mesh) {
  if (!isSubsurfSupported(mesh)) return null;
  const mod = ensureEditableBase(mesh);
  return {
    baseMesh: mod.baseMesh.clone(),
    level: mod.level,
    smoothness: mod.smoothness !== undefined ? mod.smoothness : 1,
    smoothShading: mod.smoothShading,
    showCage: mod.showCage,
    alwaysShowCage: Boolean(mod.alwaysShowCage),
  };
}

export function restoreMeshModelingState(mesh, state) {
  if (!mesh || !state || !state.baseMesh) return false;
  mesh._subsurf = {
    baseMesh: state.baseMesh.clone(),
    level: state.level | 0,
    smoothness: state.smoothness !== undefined ? Math.max(0, Math.min(1, Number(state.smoothness))) : 1,
    smoothShading: Boolean(state.smoothShading),
    showCage: Boolean(state.showCage),
    alwaysShowCage: Boolean(state.alwaysShowCage),
  };
  mesh._subsurfDirtyFromGeometry = false;
  syncMeshSubsurf(mesh);
  return true;
}

export function cloneSubsurfState(srcMesh, dstMesh) {
  if (!srcMesh || !dstMesh || !srcMesh._subsurf) return;
  if (
    srcMesh._subsurfDirtyFromGeometry ||
    (srcMesh.geometry && srcMesh.geometry._modifiedBySculpt && !srcMesh.geometry._isGeneratedSubsurf)
  ) {
    syncEditableBaseFromGeometry(srcMesh);
  }
  dstMesh._subsurf = {
    level: srcMesh._subsurf.level | 0,
    smoothness: srcMesh._subsurf.smoothness !== undefined ? Math.max(0, Math.min(1, Number(srcMesh._subsurf.smoothness))) : 1,
    smoothShading: Boolean(srcMesh._subsurf.smoothShading),
    showCage: Boolean(srcMesh._subsurf.showCage),
    alwaysShowCage: Boolean(srcMesh._subsurf.alwaysShowCage),
    baseMesh: srcMesh._subsurf.baseMesh ? srcMesh._subsurf.baseMesh.clone() : null,
  };
  dstMesh._subsurfDirtyFromGeometry = false;
  if (dstMesh._subsurf.baseMesh && dstMesh._subsurf.level > 0) {
    syncMeshSubsurf(dstMesh);
  }
}

function estimateLinearSubdivCounts(editableMesh) {
  if (!editableMesh || !editableMesh.faces.length) {
    return { verts: 0, faces: 0 };
  }
  const topo = editableMesh.getTopology();
  let nextFaces = 0;
  for (let i = 0; i < editableMesh.faces.length; i++) {
    nextFaces += editableMesh.faces[i].length;
  }
  const nextVerts = editableMesh.verts.length + editableMesh.faces.length + topo.edges.length;
  return { verts: nextVerts, faces: nextFaces };
}

export function canIncreaseMeshDensity(editableMesh, maxFaces = MAX_DENSITY_FACES, maxVerts = MAX_DENSITY_VERTS) {
  if (!editableMesh || !editableMesh.faces.length || !editableMesh.verts.length) return false;
  if (editableMesh._densityOrigin && editableMesh.verts.length < editableMesh._densityOrigin.verts.length) {
    return true;
  }
  const est = estimateLinearSubdivCounts(editableMesh);
  return est.faces <= maxFaces && est.verts <= maxVerts;
}

export function canDecreaseMeshDensity(editableMesh) {
  if (!editableMesh || !editableMesh.faces.length || !editableMesh.verts.length) return false;
  return editableMesh.verts.length > 5 && editableMesh.faces.length > 4;
}

function decimateTowardGoal(sourceMesh, beforeVerts, goal, fallbackMesh = null) {
  const work = sourceMesh.clone();
  work._densityOrigin = null;
  const res = decimateMeshQEM(work, goal, {
    preserveUvs: true,
    preserveCreases: true,
    protectBoundaries: true,
  });
  if (res.changed && work.verts.length < beforeVerts) {
    return work;
  }
  if (fallbackMesh && fallbackMesh !== sourceMesh) {
    const fb = fallbackMesh.clone();
    fb._densityOrigin = null;
    const fbRes = decimateMeshQEM(fb, goal, {
      preserveUvs: true,
      preserveCreases: true,
      protectBoundaries: true,
    });
    if (fbRes.changed && fb.verts.length < beforeVerts) {
      return fb;
    }
  }
  return null;
}

function buildIncreasedTowardOrigin(origin, beforeVerts, goal) {
  const originVerts = origin.verts.length;
  if (goal >= originVerts) {
    return origin.clone();
  }
  const work = origin.clone();
  work._densityOrigin = null;
  decimateMeshQEM(work, goal, {
    preserveUvs: true,
    preserveCreases: true,
    protectBoundaries: true,
  });
  if (work.verts.length > beforeVerts) {
    return work;
  }
  const retryTargets = [
    Math.min(originVerts, goal + Math.max(2, Math.round((originVerts - goal) * 0.25))),
    Math.min(originVerts, goal + Math.max(4, Math.round((originVerts - goal) * 0.55))),
  ];
  for (const nextGoal of retryTargets) {
    if (nextGoal >= originVerts) return origin.clone();
    const retry = origin.clone();
    retry._densityOrigin = null;
    decimateMeshQEM(retry, nextGoal, {
      preserveUvs: true,
      preserveCreases: true,
      protectBoundaries: true,
    });
    if (retry.verts.length > beforeVerts) {
      return retry;
    }
  }
  return origin.clone();
}

/**
 * Aumenta o disminuye la densidad de vértices de un EditableMesh conservando la forma original, UVs y durezas.
 * Recuerda el estado inicial (_densityOrigin) para que bajar mucho la densidad y volver a subirla
 * reconstruya el objeto original en lugar de subdividir la versión degradada.
 * - mode: 'inc' | 'dec' | 'scale' | 'target'
 * - reference: 'current' | 'origin'
 */
export function adjustMeshVertexDensity(editableMesh, {
  mode = 'target',
  factor = 1,
  targetVerts = null,
  reference = 'current',
  maxFaces = MAX_DENSITY_FACES,
  maxVerts = MAX_DENSITY_VERTS,
} = {}) {
  if (!editableMesh || !editableMesh.verts.length || !editableMesh.faces.length) {
    return { changed: false, error: 'No hay geometría editable activa.' };
  }

  const origin = editableMesh._densityOrigin
    ? editableMesh._densityOrigin.clone()
    : editableMesh.clone();
  origin._densityOrigin = null;
  const originVerts = origin.verts.length;
  const beforeVerts = editableMesh.verts.length;

  const applyFromEditable = (nextMesh) => {
    editableMesh.verts = nextMesh.verts;
    editableMesh.faces = nextMesh.faces;
    editableMesh.faceUvs = nextMesh.faceUvs;
    editableMesh.looseEdges = nextMesh.looseEdges;
    editableMesh.creases = nextMesh.creases;
    editableMesh.invalidateTopology();
    editableMesh._densityOrigin = origin;
  };

  if (mode === 'inc') {
    if (beforeVerts < originVerts) {
      const stepRatio = Number(factor) > 0 && Number(factor) < 1 ? Number(factor) : 0.65;
      let goal = Math.max(beforeVerts + 1, Math.round(beforeVerts / stepRatio));
      if (goal >= Math.round(originVerts * 0.9) || goal >= originVerts) {
        goal = originVerts;
      }
      const nextMesh = goal >= originVerts
        ? origin.clone()
        : buildIncreasedTowardOrigin(origin, beforeVerts, goal);
      if (!nextMesh || nextMesh.verts.length <= beforeVerts) {
        return { changed: false, error: 'No se pudo aumentar más la densidad.' };
      }
      applyFromEditable(nextMesh);
      return {
        changed: true,
        beforeVerts,
        afterVerts: editableMesh.verts.length,
        originVerts,
        faceCount: editableMesh.faces.length,
      };
    }

    if (!canIncreaseMeshDensity(editableMesh, maxFaces, maxVerts)) {
      return { changed: false, error: 'Se alcanzó el límite seguro de densidad de vértices.' };
    }
    const next = catmullClarkStep(editableMesh, 0);
    if (next.verts.length <= beforeVerts) {
      return { changed: false, error: 'No se pudo aumentar más la densidad.' };
    }
    applyFromEditable(next);
    return {
      changed: true,
      beforeVerts,
      afterVerts: editableMesh.verts.length,
      originVerts,
      faceCount: editableMesh.faces.length,
    };
  }

  if (mode === 'dec') {
    if (!canDecreaseMeshDensity(editableMesh)) {
      return { changed: false, error: 'La malla ya tiene la densidad mínima posible.' };
    }
    const ratio = Number(factor) > 0 && Number(factor) < 1 ? Number(factor) : 0.65;
    let goal = Math.max(MIN_DENSITY_VERTS, Math.min(beforeVerts - 1, Math.round(beforeVerts * ratio)));
    if (beforeVerts > originVerts && goal < originVerts && goal >= Math.round(originVerts * 0.85)) {
      goal = originVerts;
    }

    let nextMesh = null;
    if (goal === originVerts && beforeVerts > originVerts) {
      nextMesh = origin.clone();
    } else if (goal < originVerts) {
      nextMesh = decimateTowardGoal(origin, beforeVerts, goal, editableMesh);
    } else {
      nextMesh = decimateTowardGoal(editableMesh, beforeVerts, goal, null);
    }

    if (!nextMesh || nextMesh.verts.length >= beforeVerts) {
      return { changed: false, error: 'No se pudo reducir más sin deformar la malla.' };
    }
    applyFromEditable(nextMesh);
    return {
      changed: true,
      beforeVerts,
      afterVerts: editableMesh.verts.length,
      originVerts,
      faceCount: editableMesh.faces.length,
    };
  }

  // mode === 'scale' o 'target'
  const refVerts = reference === 'origin' ? originVerts : beforeVerts;
  const rawGoal = targetVerts !== null && targetVerts !== undefined
    ? Math.round(Number(targetVerts))
    : Math.round(refVerts * (Number(factor) || 1));
  if (!Number.isFinite(rawGoal)) {
    return { changed: false, error: 'Cantidad de vértices inválida.' };
  }
  const effectiveMaxVerts = Math.max(maxVerts, originVerts);
  const goal = Math.max(MIN_DENSITY_VERTS, Math.min(effectiveMaxVerts, rawGoal));

  if (goal === beforeVerts) {
    return { changed: false, error: 'La densidad solicitada ya coincide con la actual.' };
  }

  if (goal === originVerts) {
    applyFromEditable(origin.clone());
    return {
      changed: true,
      beforeVerts,
      afterVerts: editableMesh.verts.length,
      originVerts,
      faceCount: editableMesh.faces.length,
    };
  }

  if (goal < beforeVerts) {
    if (!canDecreaseMeshDensity(editableMesh)) {
      return { changed: false, error: 'La malla ya tiene la densidad mínima posible.' };
    }
    const nextMesh = goal < originVerts
      ? decimateTowardGoal(origin, beforeVerts, goal, editableMesh)
      : decimateTowardGoal(editableMesh, beforeVerts, goal, null);
    if (!nextMesh || nextMesh.verts.length >= beforeVerts) {
      return { changed: false, error: 'No se pudo reducir más sin deformar la silueta.' };
    }
    applyFromEditable(nextMesh);
    return {
      changed: true,
      beforeVerts,
      afterVerts: editableMesh.verts.length,
      originVerts,
      faceCount: editableMesh.faces.length,
    };
  }

  // goal > beforeVerts
  if (goal < originVerts) {
    const nextMesh = buildIncreasedTowardOrigin(origin, beforeVerts, goal);
    if (!nextMesh || nextMesh.verts.length <= beforeVerts) {
      return { changed: false, error: 'No se pudo aumentar más la densidad.' };
    }
    applyFromEditable(nextMesh);
    return {
      changed: true,
      beforeVerts,
      afterVerts: editableMesh.verts.length,
      originVerts,
      faceCount: editableMesh.faces.length,
    };
  }

  // goal > originVerts && goal > beforeVerts:
  // Si la malla estaba reducida por debajo del original, subdividir desde el original completo
  let current = beforeVerts >= originVerts ? editableMesh.clone() : origin.clone();
  current._densityOrigin = null;
  for (let pass = 0; pass < 3; pass++) {
    if (current.verts.length >= goal) break;
    if (!canIncreaseMeshDensity(current, maxFaces, maxVerts)) break;
    current = catmullClarkStep(current, 0);
  }

  if (current.verts.length <= beforeVerts) {
    return { changed: false, error: 'Se alcanzó el límite seguro de densidad de vértices.' };
  }

  if (current.verts.length > goal && goal > beforeVerts && current.verts.length * 0.88 > goal) {
    const work = current.clone();
    work._densityOrigin = null;
    decimateMeshQEM(work, goal, {
      preserveUvs: true,
      preserveCreases: true,
      protectBoundaries: true,
    });
    if (work.verts.length > beforeVerts) {
      current = work;
    }
  }

  applyFromEditable(current);
  return {
    changed: editableMesh.verts.length !== beforeVerts,
    beforeVerts,
    afterVerts: editableMesh.verts.length,
    originVerts,
    faceCount: editableMesh.faces.length,
  };
}
