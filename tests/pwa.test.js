import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMade3dZip } from '../vite.config.js';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readPngDimensions(filePath) {
  const buf = fs.readFileSync(filePath);
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(buf.subarray(12, 16).toString('ascii'), 'IHDR');
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  };
}

function listZipEntries(zipBuf) {
  const names = [];
  let offset = 0;
  while (offset + 30 <= zipBuf.length) {
    const sig = zipBuf.readUInt32LE(offset);
    if (sig !== 0x04034b50) break;
    const method = zipBuf.readUInt16LE(offset + 8);
    const compSize = zipBuf.readUInt32LE(offset + 18);
    const nameLen = zipBuf.readUInt16LE(offset + 26);
    const extraLen = zipBuf.readUInt16LE(offset + 28);
    assert.ok(method === 0 || method === 8);
    const nameStart = offset + 30;
    const nameEnd = nameStart + nameLen;
    names.push(zipBuf.subarray(nameStart, nameEnd).toString('utf8'));
    offset = nameEnd + extraLen + compSize;
  }
  return names;
}

test('PWA icons exist with valid PNG dimensions', () => {
  const svgPath = path.join(ROOT_DIR, 'public', 'icon.svg');
  assert.ok(fs.existsSync(svgPath), 'public/icon.svg missing');

  const expected = [
    ['apple-touch-icon.png', 180, 180],
    ['pwa-192x192.png', 192, 192],
    ['pwa-512x512.png', 512, 512],
    ['pwa-maskable-512x512.png', 512, 512],
  ];

  for (const [file, width, height] of expected) {
    const dims = readPngDimensions(path.join(ROOT_DIR, 'public', file));
    assert.deepEqual(dims, { width, height }, `Unexpected dimensions for ${file}`);
  }
});

test('index.html declares mobile/iOS PWA head metadata and in-app install UI', () => {
  const html = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');
  assert.match(html, /<meta\s+name="theme-color"/i);
  assert.match(html, /<meta\s+name="apple-mobile-web-app-capable"\s+content="yes"/i);
  assert.match(html, /<link\s+rel="apple-touch-icon"\s+href="\/apple-touch-icon\.png"/i);
  assert.match(html, /<link\s+rel="icon"\s+type="image\/svg\+xml"\s+href="\/icon\.svg"/i);
  assert.match(html, /id="btn-install-pwa"/);
  assert.match(html, /id="pwa-offline-banner"/);
  assert.match(html, /id="pwa-install-modal"/);
});

test('Made-3D.zip packages source code and PWA assets without recursion', () => {
  const result = buildMade3dZip(ROOT_DIR);
  assert.ok(result.byteLength > 0);
  const zipBuf = fs.readFileSync(result.outPath);
  const entries = listZipEntries(zipBuf);

  for (const required of [
    'Made-3D/package.json',
    'Made-3D/vite.config.js',
    'Made-3D/index.html',
    'Made-3D/editor/pwaController.js',
    'Made-3D/public/icon.svg',
    'Made-3D/public/apple-touch-icon.png',
    'Made-3D/public/pwa-192x192.png',
    'Made-3D/public/pwa-512x512.png',
    'Made-3D/public/pwa-maskable-512x512.png',
  ]) {
    assert.ok(entries.includes(required), `Zip missing ${required}`);
  }

  assert.ok(!entries.some((name) => name.endsWith('Made-3D.zip')), 'Zip must not contain itself');
});
