import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRGBE,
  computeIrradianceSH,
  createProceduralEnvironment,
} from '../src/modules/environment.js';

test('createProceduralEnvironment genera pirámide de mipmaps y SH L2 válidos para todos los presets', () => {
  const presets = ['studio', 'sunset', 'outdoor', 'warehouse'];
  for (const preset of presets) {
    const tex = createProceduralEnvironment(preset, 64, 32);
    assert.equal(tex.isTexture, true);
    assert.equal(tex.width, 64);
    assert.equal(tex.height, 32);
    assert.equal(tex.colorSpace, 'linear');
    assert.ok(Array.isArray(tex.mipmaps) && tex.mipmaps.length === 7);
    assert.equal(tex.mipmaps[0].width, 64);
    assert.equal(tex.mipmaps[0].height, 32);
    assert.equal(tex.mipmaps[tex.mipmaps.length - 1].width, 1);
    assert.equal(tex.mipmaps[tex.mipmaps.length - 1].height, 1);

    const ibl = tex.userData.ibl;
    assert.ok(ibl);
    assert.ok(ibl.sh instanceof Float32Array && ibl.sh.length === 36);
    assert.ok(ibl.gain >= 1.0);
    assert.equal(ibl.maxMip, tex.mipmaps.length - 1);
    assert.ok(ibl.sh[0] > 0 && ibl.sh[1] > 0 && ibl.sh[2] > 0);
  }
});

test('computeIrradianceSH normaliza correctamente un entorno blanco uniforme', () => {
  const w = 32;
  const h = 16;
  const rgba = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4 + 0] = 1.0;
    rgba[i * 4 + 1] = 1.0;
    rgba[i * 4 + 2] = 1.0;
    rgba[i * 4 + 3] = 1.0;
  }
  const sh = computeIrradianceSH(rgba, w, h);
  assert.ok(Math.abs(sh[0] - 1.0) < 0.03);
  assert.ok(Math.abs(sh[1] - 1.0) < 0.03);
  assert.ok(Math.abs(sh[2] - 1.0) < 0.03);
  // Armónicos direccionales de orden >= 1 deben anularse en un campo uniforme
  for (let k = 1; k < 9; k++) {
    assert.ok(Math.abs(sh[k * 4 + 0]) < 0.03);
    assert.ok(Math.abs(sh[k * 4 + 1]) < 0.03);
    assert.ok(Math.abs(sh[k * 4 + 2]) < 0.03);
  }
});

test('parseRGBE decodifica archivos Radiance .hdr sin RLE y con RLE moderno', () => {
  const enc = new TextEncoder();
  const buildHdr = (bodyBytes, w = 4, h = 2) => {
    const header = enc.encode(
      `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${h} +X ${w}\n`
    );
    const out = new Uint8Array(header.length + bodyBytes.length);
    out.set(header, 0);
    out.set(bodyBytes, header.length);
    return out;
  };

  // 1. Scanlines RGBE sin RLE: valor exponente 128 => f = 2^-8, (128+0.5)*2^-8 ~= 0.502
  const raw = new Uint8Array(4 * 2 * 4);
  for (let i = 0; i < 4 * 2; i++) {
    raw[i * 4 + 0] = 128;
    raw[i * 4 + 1] = 64;
    raw[i * 4 + 2] = 255;
    raw[i * 4 + 3] = 128;
  }
  const texRaw = parseRGBE(buildHdr(raw, 4, 2));
  assert.equal(texRaw.width, 4);
  assert.equal(texRaw.height, 2);
  assert.ok(texRaw.userData.ibl.sh[2] > texRaw.userData.ibl.sh[0]);
  assert.ok(texRaw.userData.ibl.sh[0] > texRaw.userData.ibl.sh[1]);

  // 2. Scanlines con RLE moderno (width = 8)
  const w = 8;
  const h = 2;
  const rleRows = [];
  for (let y = 0; y < h; y++) {
    rleRows.push(2, 2, (w >> 8) & 0xff, w & 0xff);
    // Canal R=200, G=100, B=50, E=130 (ganancia ~2x)
    rleRows.push(128 + w, 200);
    rleRows.push(128 + w, 100);
    rleRows.push(128 + w, 50);
    rleRows.push(128 + w, 130);
  }
  const texRle = parseRGBE(buildHdr(new Uint8Array(rleRows), w, h));
  assert.equal(texRle.width, 8);
  assert.equal(texRle.height, 2);
  assert.ok(texRle.userData.ibl.sh[0] > texRle.userData.ibl.sh[1]);
  assert.ok(texRle.userData.ibl.sh[1] > texRle.userData.ibl.sh[2]);
});
