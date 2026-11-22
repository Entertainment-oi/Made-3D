import { Mat4 } from '../math/Mat4.js';

function isExportableNode(obj, onlyVisible) {
  if (!obj) return false;
  if (onlyVisible && !obj.visible) return false;
  if (obj.isExportable) return obj.isExportable();
  if (obj.exportable === false) return false;
  if (obj.userData && obj.userData.exportable === false) return false;
  return true;
}

function sanitizeName(name, fallback) {
  const s = String(name || fallback).trim().replace(/\s+/g, '_');
  return s || fallback;
}

function computeNormalMatrix3(mat4, out9) {
  const e = mat4.elements;
  const a00 = e[0], a01 = e[1], a02 = e[2];
  const a10 = e[4], a11 = e[5], a12 = e[6];
  const a20 = e[8], a21 = e[9], a22 = e[10];

  const b01 = a22 * a11 - a12 * a21;
  const b11 = -a22 * a10 + a12 * a20;
  const b21 = a21 * a10 - a11 * a20;
  const det = a00 * b01 + a01 * b11 + a02 * b21;
  if (Math.abs(det) < 1e-12) {
    out9[0] = 1; out9[1] = 0; out9[2] = 0;
    out9[3] = 0; out9[4] = 1; out9[5] = 0;
    out9[6] = 0; out9[7] = 0; out9[8] = 1;
    return out9;
  }
  const invDet = 1 / det;
  // Transpuesta de la inversa (column-major -> filas para multiplicar directamente)
  out9[0] = b01 * invDet;
  out9[1] = (-a22 * a01 + a02 * a21) * invDet;
  out9[2] = (a12 * a01 - a02 * a11) * invDet;
  out9[3] = b11 * invDet;
  out9[4] = (a22 * a00 - a02 * a20) * invDet;
  out9[5] = (-a12 * a00 + a02 * a10) * invDet;
  out9[6] = b21 * invDet;
  out9[7] = (-a21 * a00 + a01 * a20) * invDet;
  out9[8] = (a11 * a00 - a01 * a10) * invDet;
  return out9;
}

/**
 * Exportador Wavefront OBJ (+ MTL opcional) para Made3D.
 *
 *   const exporter = new OBJExporter();
 *   const objText = exporter.parse(scene);
 *   const { obj, mtl } = exporter.parseWithMaterials(scene, { mtlFilename: 'modelo.mtl' });
 */
export class OBJExporter {
  parse(input, opts = {}) {
    return this._build(input, { ...opts, includeMtl: false }).obj;
  }

  parseWithMaterials(input, opts = {}) {
    return this._build(input, { ...opts, includeMtl: true });
  }

  _build(input, opts = {}) {
    const onlyVisible = opts.onlyVisible !== undefined ? !!opts.onlyVisible : true;
    const includeMtl = !!opts.includeMtl;
    const mtlFilename = opts.mtlFilename || 'materials.mtl';
    const roots = Array.isArray(input) ? input : [input];

    for (const r of roots) {
      if (r && r.updateWorldMatrix) r.updateWorldMatrix(true, true);
    }

    const lines = ['# Exportado por Made3D OBJExporter'];
    if (includeMtl) lines.push(`mtllib ${mtlFilename}`);

    const mtlLines = ['# Materiales exportados por Made3D OBJExporter'];
    const matNames = new Map();
    const usedMatNames = new Set();
    const nm = new Float32Array(9);
    const worldMat = new Mat4();
    const instMat = new Mat4();

    let vOffset = 0;
    let vtOffset = 0;
    let vnOffset = 0;
    let objCounter = 0;
    let matCounter = 0;

    const getMaterialName = (mat) => {
      if (!mat) return null;
      if (matNames.has(mat)) return matNames.get(mat);
      const base = sanitizeName(mat.name, `mat_${++matCounter}`);
      let name = base;
      let suffix = 2;
      while (usedMatNames.has(name)) name = `${base}_${suffix++}`;
      usedMatNames.add(name);
      matNames.set(mat, name);

      if (includeMtl) {
        const c = mat.color || { r: 0.8, g: 0.8, b: 0.8 };
        mtlLines.push(`newmtl ${name}`);
        mtlLines.push(`Kd ${c.r.toFixed(4)} ${c.g.toFixed(4)} ${c.b.toFixed(4)}`);
        if (mat.opacity !== undefined && mat.opacity < 1) {
          mtlLines.push(`d ${mat.opacity.toFixed(4)}`);
        }
        if (mat.shininess > 0) {
          mtlLines.push(`Ns ${Math.min(1000, mat.shininess * 2).toFixed(2)}`);
          const sp = mat.specular !== undefined ? mat.specular : 0.5;
          mtlLines.push(`Ks ${sp.toFixed(4)} ${sp.toFixed(4)} ${sp.toFixed(4)}`);
        }
        if (mat.emissive && (mat.emissive.r > 0 || mat.emissive.g > 0 || mat.emissive.b > 0)) {
          mtlLines.push(`Ke ${mat.emissive.r.toFixed(4)} ${mat.emissive.g.toFixed(4)} ${mat.emissive.b.toFixed(4)}`);
        }
        mtlLines.push('');
      }
      return name;
    };

    const emitGeometry = (geo, matrix, name, mat) => {
      if (!geo || !geo.attributes || !geo.attributes.position) return;
      const pos = geo.attributes.position;
      const nor = geo.attributes.normal || null;
      const uv = geo.attributes.uv || null;
      const idx = geo.index ? geo.index.array : null;

      lines.push(`o ${sanitizeName(name, `mesh_${++objCounter}`)}`);
      const matName = getMaterialName(mat);
      if (includeMtl && matName) lines.push(`usemtl ${matName}`);

      const e = matrix.elements;
      const pArr = pos.array;
      const pCount = pos.count;
      for (let i = 0; i < pCount; i++) {
        const x = pArr[i * 3];
        const y = pArr[i * 3 + 1];
        const z = pArr[i * 3 + 2];
        const wx = e[0] * x + e[4] * y + e[8] * z + e[12];
        const wy = e[1] * x + e[5] * y + e[9] * z + e[13];
        const wz = e[2] * x + e[6] * y + e[10] * z + e[14];
        lines.push(`v ${wx.toFixed(6)} ${wy.toFixed(6)} ${wz.toFixed(6)}`);
      }

      if (uv) {
        const uArr = uv.array;
        for (let i = 0; i < uv.count; i++) {
          lines.push(`vt ${uArr[i * 2].toFixed(6)} ${uArr[i * 2 + 1].toFixed(6)}`);
        }
      }

      if (nor) {
        computeNormalMatrix3(matrix, nm);
        const nArr = nor.array;
        for (let i = 0; i < nor.count; i++) {
          const x = nArr[i * 3];
          const y = nArr[i * 3 + 1];
          const z = nArr[i * 3 + 2];
          let nx = nm[0] * x + nm[1] * y + nm[2] * z;
          let ny = nm[3] * x + nm[4] * y + nm[5] * z;
          let nz = nm[6] * x + nm[7] * y + nm[8] * z;
          const len = Math.hypot(nx, ny, nz) || 1;
          nx /= len; ny /= len; nz /= len;
          lines.push(`vn ${nx.toFixed(6)} ${ny.toFixed(6)} ${nz.toFixed(6)}`);
        }
      }

      const fmtVertex = (vi) => {
        const v = vOffset + vi + 1;
        if (uv && nor) return `${v}/${vtOffset + vi + 1}/${vnOffset + vi + 1}`;
        if (uv) return `${v}/${vtOffset + vi + 1}`;
        if (nor) return `${v}//${vnOffset + vi + 1}`;
        return `${v}`;
      };

      const totalIdx = idx ? idx.length : pCount;
      for (let i = 0; i + 2 < totalIdx; i += 3) {
        const a = idx ? idx[i] : i;
        const b = idx ? idx[i + 1] : i + 1;
        const c = idx ? idx[i + 2] : i + 2;
        lines.push(`f ${fmtVertex(a)} ${fmtVertex(b)} ${fmtVertex(c)}`);
      }

      vOffset += pCount;
      if (uv) vtOffset += uv.count;
      if (nor) vnOffset += nor.count;
    };

    const emitSkinnedPosed = (obj) => {
      const geo = obj.geometry;
      if (!geo || !geo.attributes || !geo.attributes.position) return;
      const pos = geo.attributes.position;
      const uv = geo.attributes.uv || null;
      const nor = geo.attributes.normal || null;
      const idx = geo.index ? geo.index.array : null;
      const pCount = pos.count;

      const sk = obj.skeleton;
      if (sk && sk.bones) {
        for (let i = 0; i < sk.bones.length; i++) sk.bones[i].updateWorldMatrix(true, false);
        sk.update();
      }

      const posedPos = new Float32Array(pCount * 3);
      obj.computeSkinnedWorld(posedPos, pCount);

      lines.push(`o ${sanitizeName(obj.name, `mesh_${++objCounter}`)}`);
      const matName = getMaterialName(obj.material);
      if (includeMtl && matName) lines.push(`usemtl ${matName}`);

      for (let i = 0; i < pCount; i++) {
        lines.push(`v ${posedPos[i * 3].toFixed(6)} ${posedPos[i * 3 + 1].toFixed(6)} ${posedPos[i * 3 + 2].toFixed(6)}`);
      }

      if (uv) {
        const uArr = uv.array;
        for (let i = 0; i < uv.count; i++) {
          lines.push(`vt ${uArr[i * 2].toFixed(6)} ${uArr[i * 2 + 1].toFixed(6)}`);
        }
      }

      let hasNormals = false;
      if (nor) {
        hasNormals = true;
        const nArr = new Float32Array(pCount * 3);
        const totalIdx = idx ? idx.length : pCount;
        for (let t = 0; t + 2 < totalIdx; t += 3) {
          const a = idx ? idx[t] : t;
          const b = idx ? idx[t + 1] : t + 1;
          const c = idx ? idx[t + 2] : t + 2;
          const ax = posedPos[a * 3], ay = posedPos[a * 3 + 1], az = posedPos[a * 3 + 2];
          const e1x = posedPos[b * 3] - ax, e1y = posedPos[b * 3 + 1] - ay, e1z = posedPos[b * 3 + 2] - az;
          const e2x = posedPos[c * 3] - ax, e2y = posedPos[c * 3 + 1] - ay, e2z = posedPos[c * 3 + 2] - az;
          const nx = e1y * e2z - e1z * e2y;
          const ny = e1z * e2x - e1x * e2z;
          const nz = e1x * e2y - e1y * e2x;
          nArr[a * 3] += nx; nArr[a * 3 + 1] += ny; nArr[a * 3 + 2] += nz;
          nArr[b * 3] += nx; nArr[b * 3 + 1] += ny; nArr[b * 3 + 2] += nz;
          nArr[c * 3] += nx; nArr[c * 3 + 1] += ny; nArr[c * 3 + 2] += nz;
        }
        for (let i = 0; i < pCount; i++) {
          const o = i * 3;
          const l = Math.hypot(nArr[o], nArr[o + 1], nArr[o + 2]) || 1;
          lines.push(`vn ${(nArr[o] / l).toFixed(6)} ${(nArr[o + 1] / l).toFixed(6)} ${(nArr[o + 2] / l).toFixed(6)}`);
        }
      }

      const fmtVertex = (vi) => {
        const v = vOffset + vi + 1;
        if (uv && hasNormals) return `${v}/${vtOffset + vi + 1}/${vnOffset + vi + 1}`;
        if (uv) return `${v}/${vtOffset + vi + 1}`;
        if (hasNormals) return `${v}//${vnOffset + vi + 1}`;
        return `${v}`;
      };

      const totalIdx = idx ? idx.length : pCount;
      for (let i = 0; i + 2 < totalIdx; i += 3) {
        const a = idx ? idx[i] : i;
        const b = idx ? idx[i + 1] : i + 1;
        const c = idx ? idx[i + 2] : i + 2;
        lines.push(`f ${fmtVertex(a)} ${fmtVertex(b)} ${fmtVertex(c)}`);
      }

      vOffset += pCount;
      if (uv) vtOffset += uv.count;
      if (hasNormals) vnOffset += pCount;
    };

    const walk = (obj) => {
      if (!isExportableNode(obj, onlyVisible)) return;

      if (obj.isInstancedMesh && obj.geometry && obj.instanceMatrix) {
        const arr = obj.instanceMatrix.array;
        const total = Math.min(obj.count || 0, Math.floor(arr.length / 16));
        for (let i = 0; i < total; i++) {
          instMat.elements.set(arr.subarray(i * 16, i * 16 + 16));
          worldMat.multiplyMatrices(obj.matrixWorld, instMat);
          emitGeometry(obj.geometry, worldMat, `${obj.name || 'instancia'}_${i}`, obj.material);
        }
      } else if (obj.isSkinnedMesh && obj.skeleton && obj.skeleton.bones?.length && obj.geometry && (!obj.drawMode || obj.drawMode === 'triangles')) {
        emitSkinnedPosed(obj);
      } else if (obj.isMesh && obj.geometry && (!obj.drawMode || obj.drawMode === 'triangles')) {
        emitGeometry(obj.geometry, obj.matrixWorld, obj.name, obj.material);
      }

      if (obj.children) {
        for (const ch of obj.children) walk(ch);
      }
    };

    for (const root of roots) walk(root);

    return {
      obj: lines.join('\n') + '\n',
      mtl: includeMtl && matNames.size ? mtlLines.join('\n') + '\n' : '',
    };
  }
}
