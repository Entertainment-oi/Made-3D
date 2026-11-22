import { Texture } from './Texture.js';

const PI = Math.PI;
const TAU = Math.PI * 2;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const s2l = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));

function toUint8Array(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new Error('EnvironmentLoader: buffer inválido.');
}

/**
 * Calcula los 9 coeficientes de Armónicos Esféricos L2 (irradiancia / π)
 * en un arreglo Float32Array(36) alineado a 9 vec4 (r, g, b, 0) a partir de una
 * textura equirectangular Float32 RGBA (fila y=0 en el cenit +Y).
 */
export function computeIrradianceSH(rgbaFloat, width, height) {
  const sh = new Float32Array(36);
  if (!rgbaFloat || !width || !height) return sh;

  // Factores de convolución coseno normalizados por π (Ramamoorthi & Hanrahan, dividido por π)
  const A0 = 1.0;
  const A1 = 2.0 / 3.0;
  const A2 = 0.25;

  const Y00 = 0.28209479177387814;
  const Y1 = 0.4886025119029199;
  const Y2n = 1.0925484305920792;
  const Y20 = 0.31539156525252005;
  const Y22 = 0.5462742152960396;

  const acc = new Float64Array(27);
  let totalWeight = 0;

  const dPhi = TAU / width;
  const dTheta = PI / height;

  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    const theta = v * PI;
    const sinTheta = Math.sin(theta);
    const dy = Math.cos(theta);
    const dw = Math.max(1e-6, sinTheta * dTheta * dPhi);

    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const phi = (u - 0.5) * TAU;
      const dx = sinTheta * Math.cos(phi);
      const dz = sinTheta * Math.sin(phi);

      const off = (y * width + x) * 4;
      // Clampear picos extremos para estabilidad numérica de SH manteniendo balance energético
      const r = Math.min(rgbaFloat[off] || 0, 64);
      const g = Math.min(rgbaFloat[off + 1] || 0, 64);
      const b = Math.min(rgbaFloat[off + 2] || 0, 64);

      const b0 = Y00;
      const b1 = Y1 * dy;
      const b2 = Y1 * dz;
      const b3 = Y1 * dx;
      const b4 = Y2n * dx * dz;
      const b5 = Y2n * dz * dy;
      const b6 = Y20 * (3 * dy * dy - 1);
      const b7 = Y2n * dx * dy;
      const b8 = Y22 * (dx * dx - dz * dz);

      const basis = [b0, b1, b2, b3, b4, b5, b6, b7, b8];
      for (let k = 0; k < 9; k++) {
        const w = basis[k] * dw;
        acc[k * 3 + 0] += r * w;
        acc[k * 3 + 1] += g * w;
        acc[k * 3 + 2] += b * w;
      }
      totalWeight += dw;
    }
  }

  // Normalizar peso esférico exacto (~4π)
  const norm = totalWeight > 0 ? (TAU * 2) / totalWeight : 1;
  const bands = [A0, A1, A1, A1, A2, A2, A2, A2, A2];
  const weights = [Y00, Y1, Y1, Y1, Y2n, Y2n, Y20, Y2n, Y22];
  for (let k = 0; k < 9; k++) {
    const scale = norm * bands[k] * weights[k];
    sh[k * 4 + 0] = acc[k * 3 + 0] * scale;
    sh[k * 4 + 1] = acc[k * 3 + 1] * scale;
    sh[k * 4 + 2] = acc[k * 3 + 2] * scale;
    sh[k * 4 + 3] = 0;
  }
  return sh;
}

function buildMipmapsFromFloat(rgbaFloat, width, height) {
  let maxVal = 1.0;
  const totalPx = width * height;
  for (let i = 0; i < totalPx; i++) {
    const o = i * 4;
    const m = Math.max(rgbaFloat[o], rgbaFloat[o + 1], rgbaFloat[o + 2]);
    if (m > maxVal) maxVal = m;
  }
  // Limitar ganancia para preservar precisión 8-bit en tonos medios
  const gain = Math.max(1.0, Math.min(16.0, maxVal));
  const invGain = 1.0 / gain;

  const mipmaps = [];
  let curFloat = rgbaFloat;
  let w = width;
  let h = height;

  while (true) {
    const u8 = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const o = i * 4;
      // Compresión perceptual suave sRGB-gamma-libre sobre gain lineal: encode x^(1/2.2) o lineal directo
      // Se almacena lineal escalado por invGain para compatibilidad idéntica en WebGL2 y WebGPU
      u8[o + 0] = Math.round(clamp01(curFloat[o + 0] * invGain) * 255);
      u8[o + 1] = Math.round(clamp01(curFloat[o + 1] * invGain) * 255);
      u8[o + 2] = Math.round(clamp01(curFloat[o + 2] * invGain) * 255);
      u8[o + 3] = 255;
    }
    mipmaps.push({ data: u8, width: w, height: h });

    if (w === 1 && h === 1) break;
    const nw = Math.max(1, w >> 1);
    const nh = Math.max(1, h >> 1);
    const nextFloat = new Float32Array(nw * nh * 4);

    // Filtro separable suave 3x3 wrap-X / clamp-Y para pre-convolución limpia de rugosidad
    for (let y = 0; y < nh; y++) {
      const sy = Math.min(h - 1, y * 2);
      const sy0 = Math.max(0, sy - 1);
      const sy2 = Math.min(h - 1, sy + 1);
      const sy3 = Math.min(h - 1, sy + 2);
      for (let x = 0; x < nw; x++) {
        const sx = x * 2;
        const sxL = (sx - 1 + w) % w;
        const sxR = (sx + 1) % w;
        const sxR2 = (sx + 2) % w;

        const samples = [
          [sxL, sy0, 0.04], [sx, sy0, 0.06], [sxR, sy0, 0.06], [sxR2, sy0, 0.04],
          [sxL, sy, 0.06],  [sx, sy, 0.12],  [sxR, sy, 0.12],  [sxR2, sy, 0.06],
          [sxL, sy2, 0.06], [sx, sy2, 0.12], [sxR, sy2, 0.12], [sxR2, sy2, 0.06],
          [sxL, sy3, 0.04], [sx, sy3, 0.06], [sxR, sy3, 0.06], [sxR2, sy3, 0.04],
        ];
        let r = 0, g = 0, b = 0, wSum = 0;
        for (let k = 0; k < samples.length; k++) {
          const [px, py, wt] = samples[k];
          const idx = (py * w + px) * 4;
          r += curFloat[idx + 0] * wt;
          g += curFloat[idx + 1] * wt;
          b += curFloat[idx + 2] * wt;
          wSum += wt;
        }
        const dst = (y * nw + x) * 4;
        nextFloat[dst + 0] = r / wSum;
        nextFloat[dst + 1] = g / wSum;
        nextFloat[dst + 2] = b / wSum;
        nextFloat[dst + 3] = 1;
      }
    }
    curFloat = nextFloat;
    w = nw;
    h = nh;
  }

  return { mipmaps, gain, maxMip: Math.max(0, mipmaps.length - 1) };
}

function finalizeEnvTexture(rgbaFloat, width, height, preset = 'hdr') {
  const sh = computeIrradianceSH(rgbaFloat, width, height);
  const { mipmaps, gain, maxMip } = buildMipmapsFromFloat(rgbaFloat, width, height);
  const tex = new Texture(null, {
    mipmaps,
    width,
    height,
    colorSpace: 'linear',
    flipY: false,
    wrapS: 'repeat',
    wrapT: 'clamp',
    minFilter: 'linear-mipmap',
    magFilter: 'linear',
  });
  tex.userData.ibl = {
    sh,
    gain,
    maxMip,
    preset,
    width,
    height,
  };
  return tex;
}

/**
 * Parsea un archivo Radiance HDR (.hdr / RGBE) y construye un mapa equirectangular
 * con cadena de mipmaps + armónicos esféricos L2 para iluminación IBL.
 */
export function parseRGBE(buffer) {
  const u8 = toUint8Array(buffer);
  let pos = 0;

  const readLine = () => {
    const start = pos;
    while (pos < u8.length && u8[pos] !== 0x0a) pos++;
    let end = pos;
    if (end > start && u8[end - 1] === 0x0d) end--;
    if (pos < u8.length && u8[pos] === 0x0a) pos++;
    let line = '';
    for (let i = start; i < end; i++) line += String.fromCharCode(u8[i]);
    return line;
  };

  const magic = readLine();
  if (!magic.startsWith('#?RADIANCE') && !magic.startsWith('#?RGBE')) {
    throw new Error('parseRGBE: cabecera Radiance HDR no válida.');
  }

  let exposure = 1.0;
  let formatValid = false;
  while (pos < u8.length) {
    const line = readLine();
    if (!line.trim()) break;
    if (line.startsWith('FORMAT=')) {
      const fmt = line.slice(7).trim();
      if (fmt === '32-bit_rle_rgbe' || fmt === '32-bit_rle_xyze') formatValid = true;
    } else if (line.startsWith('EXPOSURE=')) {
      const ex = parseFloat(line.slice(9).trim());
      if (Number.isFinite(ex) && ex > 0) exposure *= ex;
    }
  }
  if (!formatValid && pos >= u8.length) {
    throw new Error('parseRGBE: archivo HDR incompleto.');
  }

  const resLine = readLine().trim();
  const match = resLine.match(/^([-+][XY])\s+(\d+)\s+([-+][XY])\s+(\d+)$/);
  if (!match) {
    throw new Error(`parseRGBE: resolución inválida "${resLine}".`);
  }

  const axisA = match[1];
  const dimA = parseInt(match[2], 10);
  const axisB = match[3];
  const dimB = parseInt(match[4], 10);

  const flipY = axisA === '+Y';
  const flipX = axisB === '-X';
  const height = axisA.endsWith('Y') ? dimA : dimB;
  const width = axisB.endsWith('X') ? dimB : dimA;

  if (!width || !height || width > 16384 || height > 16384) {
    throw new Error(`parseRGBE: dimensiones fuera de rango (${width}×${height}).`);
  }

  const rgbaFloat = new Float32Array(width * height * 4);
  const scanline = new Uint8Array(width * 4);
  const invExposure = 1.0 / exposure;

  for (let y = 0; y < height; y++) {
    if (pos + 4 > u8.length) break;
    const b0 = u8[pos];
    const b1 = u8[pos + 1];
    const b2 = u8[pos + 2];
    const b3 = u8[pos + 3];

    if (b0 !== 2 || b1 !== 2 || (b2 & 0x80) !== 0 || ((b2 << 8) | b3) !== width) {
      // Sin RLE moderno o RLE antiguo sin compresión por canal
      const needed = width * 4;
      if (pos + needed > u8.length) {
        throw new Error('parseRGBE: datos RGBE truncados.');
      }
      scanline.set(u8.subarray(pos, pos + needed));
      pos += needed;
    } else {
      pos += 4;
      for (let ch = 0; ch < 4; ch++) {
        let ptr = 0;
        while (ptr < width && pos < u8.length) {
          const count = u8[pos++];
          if (count > 128) {
            const run = count - 128;
            const val = u8[pos++];
            for (let k = 0; k < run && ptr < width; k++) {
              scanline[ptr++ * 4 + ch] = val;
            }
          } else {
            const run = count;
            for (let k = 0; k < run && ptr < width && pos < u8.length; k++) {
              scanline[ptr++ * 4 + ch] = u8[pos++];
            }
          }
        }
      }
    }

    const dstY = flipY ? (height - 1 - y) : y;
    for (let x = 0; x < width; x++) {
      const dstX = flipX ? (width - 1 - x) : x;
      const sOff = x * 4;
      const r = scanline[sOff];
      const g = scanline[sOff + 1];
      const b = scanline[sOff + 2];
      const e = scanline[sOff + 3];
      const dOff = (dstY * width + dstX) * 4;
      if (e > 0) {
        const f = Math.pow(2.0, e - 128 - 8) * invExposure;
        rgbaFloat[dOff + 0] = (r + 0.5) * f;
        rgbaFloat[dOff + 1] = (g + 0.5) * f;
        rgbaFloat[dOff + 2] = (b + 0.5) * f;
      } else {
        rgbaFloat[dOff + 0] = 0;
        rgbaFloat[dOff + 1] = 0;
        rgbaFloat[dOff + 2] = 0;
      }
      rgbaFloat[dOff + 3] = 1;
    }
  }

  return finalizeEnvTexture(rgbaFloat, width, height, 'hdr');
}

function addSoftLight(dir, lightDir, sizeSin, color) {
  const dot = Math.max(0, dir[0] * lightDir[0] + dir[1] * lightDir[1] + dir[2] * lightDir[2]);
  const falloff = Math.pow(dot, Math.max(1, 2.0 / Math.max(0.02, sizeSin * sizeSin)));
  return [color[0] * falloff, color[1] * falloff, color[2] * falloff];
}

function addRectBox(dir, center, right, up, halfW, halfH, color) {
  const denom = dir[0] * center[0] + dir[1] * center[1] + dir[2] * center[2];
  if (denom <= 0.05) return [0, 0, 0];
  const dx = dir[0] * right[0] + dir[1] * right[1] + dir[2] * right[2];
  const dy = dir[0] * up[0] + dir[1] * up[1] + dir[2] * up[2];
  const u = dx / denom;
  const v = dy / denom;
  const edgeX = clamp01(1 - Math.max(0, Math.abs(u) - halfW) / 0.14);
  const edgeY = clamp01(1 - Math.max(0, Math.abs(v) - halfH) / 0.14);
  const m = edgeX * edgeY;
  return [color[0] * m, color[1] * m, color[2] * m];
}

function normVec(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/**
 * Genera un entorno HDRI procedural equirectangular listo para PBR/IBL.
 * Presets disponibles: 'studio', 'sunset', 'outdoor', 'warehouse'.
 */
export function createProceduralEnvironment(preset = 'studio', width = 256, height = 128) {
  const mode = String(preset || 'studio').toLowerCase();
  const rgbaFloat = new Float32Array(width * height * 4);

  const keyDir = normVec([0.45, 0.78, 0.42]);
  const fillDir = normVec([-0.78, 0.36, 0.5]);
  const rimDir = normVec([-0.25, 0.55, -0.8]);

  const sunSunset = normVec([0.82, 0.16, -0.55]);
  const sunOutdoor = normVec([0.55, 0.72, 0.42]);

  // Bases para paneles rectangulares de estudio
  const stUp1 = normVec([-0.42, 0.62, -0.66]);
  const stRight1 = normVec([0.72, 0, -0.69]);
  const stCenter2 = normVec([-0.82, 0.35, 0.45]);
  const stRight2 = normVec([0.48, 0, 0.88]);
  const stUp2 = normVec([0.15, 0.94, -0.08]);

  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    const theta = v * PI;
    const sinTheta = Math.sin(theta);
    const dy = Math.cos(theta);

    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const phi = (u - 0.5) * TAU;
      const dx = sinTheta * Math.cos(phi);
      const dz = sinTheta * Math.sin(phi);
      const dir = [dx, dy, dz];

      let r = 0, g = 0, b = 0;

      if (mode === 'sunset') {
        const up = clamp01(dy);
        const down = clamp01(-dy);
        const horiz = Math.exp(-Math.abs(dy) * 5.0);
        // Cielo violeta profundo -> naranja cálido en horizonte -> suelo oscuro
        r = 0.08 * up + 1.35 * horiz + 0.14 * (1 - down);
        g = 0.10 * up + 0.55 * horiz + 0.09 * (1 - down);
        b = 0.28 * up + 0.34 * horiz + 0.11 * (1 - down);
        if (dy < 0) {
          r *= 1 - down * 0.65;
          g *= 1 - down * 0.65;
          b *= 1 - down * 0.6;
        }
        const s = addSoftLight(dir, sunSunset, 0.12, [9.5, 4.4, 1.8]);
        const halo = addSoftLight(dir, sunSunset, 0.45, [2.2, 0.95, 0.4]);
        r += s[0] + halo[0];
        g += s[1] + halo[1];
        b += s[2] + halo[2];
      } else if (mode === 'outdoor') {
        const up = clamp01(dy);
        const down = clamp01(-dy);
        const horiz = Math.exp(-Math.abs(dy) * 4.5);
        r = 0.24 * up + 0.72 * horiz + 0.22 * down;
        g = 0.48 * up + 0.84 * horiz + 0.20 * down;
        b = 0.96 * up + 0.98 * horiz + 0.16 * down;
        const sun = addSoftLight(dir, sunOutdoor, 0.09, [10.0, 9.2, 7.6]);
        const glow = addSoftLight(dir, sunOutdoor, 0.42, [0.9, 0.86, 0.72]);
        r += sun[0] + glow[0];
        g += sun[1] + glow[1];
        b += sun[2] + glow[2];
      } else if (mode === 'warehouse') {
        const skyMask = dy > 0 ? 1 : 0;
        const wall = Math.exp(-Math.abs(dy) * 6.0);
        r = 0.09 + 0.14 * wall + (dy < 0 ? 0.06 : 0.04);
        g = 0.10 + 0.14 * wall + (dy < 0 ? 0.06 : 0.05);
        b = 0.13 + 0.15 * wall + (dy < 0 ? 0.06 : 0.07);
        // Claraboyas industriales en el techo
        if (skyMask && dy > 0.42) {
          const sx = Math.abs(Math.sin(dx * 5.2));
          const sz = Math.abs(Math.cos(dz * 3.4));
          if (sx > 0.78 && sz > 0.45) {
            r += 5.2; g += 5.7; b += 6.4;
          }
        }
        const warmBounce = addSoftLight(dir, normVec([0.9, 0.12, 0.2]), 0.35, [2.6, 1.45, 0.65]);
        r += warmBounce[0]; g += warmBounce[1]; b += warmBounce[2];
      } else {
        // 'studio' (por defecto): gradiente suave + 3 cajas de luz nítidas para contraste PBR
        const up = clamp01(dy);
        const horiz = Math.exp(-Math.abs(dy) * 3.2);
        r = 0.14 + 0.18 * up + 0.22 * horiz;
        g = 0.15 + 0.19 * up + 0.23 * horiz;
        b = 0.18 + 0.23 * up + 0.26 * horiz;
        if (dy < 0) {
          const floorFade = clamp01(-dy);
          r *= 1 - floorFade * 0.55;
          g *= 1 - floorFade * 0.55;
          b *= 1 - floorFade * 0.55;
        }
        const box1 = addRectBox(dir, keyDir, stRight1, stUp1, 0.32, 0.2, [5.8, 5.4, 4.9]);
        const box2 = addRectBox(dir, stCenter2, stRight2, stUp2, 0.26, 0.38, [3.2, 3.8, 4.7]);
        const rim = addSoftLight(dir, rimDir, 0.28, [3.8, 4.1, 4.5]);
        const keyGlow = addSoftLight(dir, fillDir, 0.55, [0.55, 0.65, 0.85]);
        r += box1[0] + box2[0] + rim[0] + keyGlow[0];
        g += box1[1] + box2[1] + rim[1] + keyGlow[1];
        b += box1[2] + box2[2] + rim[2] + keyGlow[2];
      }

      const off = (y * width + x) * 4;
      rgbaFloat[off + 0] = r;
      rgbaFloat[off + 1] = g;
      rgbaFloat[off + 2] = b;
      rgbaFloat[off + 3] = 1;
    }
  }

  return finalizeEnvTexture(rgbaFloat, width, height, mode);
}

/**
 * Convierte una imagen equirectangular LDR (PNG/JPG/WebP) en un mapa IBL completo
 * con mipmaps prefiltrados y coeficientes SH.
 */
export function createEnvironmentFromImage(img, name = 'image') {
  const wRaw = img.naturalWidth || img.videoWidth || img.width || 256;
  const hRaw = img.naturalHeight || img.videoHeight || img.height || 128;
  const width = Math.min(1024, Math.max(32, wRaw));
  const height = Math.min(512, Math.max(16, hRaw));

  if (typeof document !== 'undefined') {
    const cv = document.createElement('canvas');
    cv.width = width;
    cv.height = height;
    const ctx = cv.getContext('2d');
    if (ctx) {
      ctx.drawImage(img, 0, 0, width, height);
      const imgData = ctx.getImageData(0, 0, width, height).data;
      const rgbaFloat = new Float32Array(width * height * 4);
      for (let i = 0; i < width * height; i++) {
        const o = i * 4;
        rgbaFloat[o + 0] = s2l(imgData[o + 0] / 255) * 1.35;
        rgbaFloat[o + 1] = s2l(imgData[o + 1] / 255) * 1.35;
        rgbaFloat[o + 2] = s2l(imgData[o + 2] / 255) * 1.35;
        rgbaFloat[o + 3] = 1;
      }
      return finalizeEnvTexture(rgbaFloat, width, height, name);
    }
  }

  const fallback = new Texture(img, {
    colorSpace: 'srgb',
    flipY: false,
    wrapS: 'repeat',
    wrapT: 'clamp',
    minFilter: 'linear-mipmap',
    magFilter: 'linear',
  });
  const sh = new Float32Array(36);
  sh[0] = 0.45; sh[1] = 0.45; sh[2] = 0.48;
  fallback.userData.ibl = { sh, gain: 1.0, maxMip: 6, preset: name, width, height };
  return fallback;
}

/**
 * Carga un archivo de entorno HDRI (.hdr) o equirectangular LDR (.png/.jpg/.jpeg/.webp).
 */
export async function loadEnvironmentFromFile(file) {
  if (!file) throw new Error('Archivo de entorno inválido.');
  const lower = (file.name || '').toLowerCase();
  const ab = await file.arrayBuffer();
  const head = new Uint8Array(ab, 0, Math.min(10, ab.byteLength));
  const isHdrHeader = head[0] === 0x23 && head[1] === 0x3f; // "#?"
  if (lower.endsWith('.hdr') || isHdrHeader) {
    return parseRGBE(ab);
  }

  if (typeof Blob === 'undefined' || typeof Image === 'undefined') {
    throw new Error('La carga de imágenes equirectangulares requiere un entorno con DOM.');
  }
  const blob = new Blob([ab], { type: file.type || 'image/png' });
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('No se pudo decodificar la imagen de entorno.'));
      im.src = url;
    });
    return createEnvironmentFromImage(img, file.name || 'image');
  } finally {
    URL.revokeObjectURL(url);
  }
}
