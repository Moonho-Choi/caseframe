import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchColors, rgbToLab, labToRgb } from '../js/color.js';

test('rgb<->lab roundtrip', () => {
  for (const c of [[0, 0, 0], [255, 255, 255], [200, 120, 90], [30, 60, 200]]) {
    const [L, a, b] = rgbToLab(...c); const back = labToRgb(L, a, b);
    back.forEach((v, i) => assert.ok(Math.abs(v - c[i]) <= 1, `${c} -> ${back}`));
  }
});

test('matchColors equalizes mean brightness of a dark and a bright image', () => {
  const mk = v => ({ width: 8, height: 8, data: new Uint8ClampedArray(256).map((_, i) => (i % 4 === 3 ? 255 : v + ((i >> 2) % 5) * 3)) });
  const out = matchColors([mk(60), mk(120), mk(180)]);
  const mean = img => { let s = 0, n = 0; for (let i = 0; i < img.data.length; i += 4) { s += img.data[i]; n++; } return s / n; };
  const ms = out.map(mean);
  assert.ok(Math.abs(ms[0] - ms[1]) < 6 && Math.abs(ms[2] - ms[1]) < 6, `means ${ms}`);
});

test('flat image has no banding when matched', () => {
  const flat = { width: 8, height: 8, data: new Uint8ClampedArray(256).fill(0).map((_, i) => (i % 4 === 3 ? 255 : 128)) };
  const mk = v => ({ width: 8, height: 8, data: new Uint8ClampedArray(256).map((_, i) => (i % 4 === 3 ? 255 : v + ((i >> 2) % 5) * 3)) });
  const out = matchColors([flat, mk(60), mk(180)]);
  const flatOut = out[0];
  let minR = 255, maxR = 0;
  for (let i = 0; i < flatOut.data.length; i += 4) {
    const r = flatOut.data[i];
    minR = Math.min(minR, r);
    maxR = Math.max(maxR, r);
  }
  assert.ok(maxR - minR <= 8, `R channel range ${maxR - minR} should be ≤ 8, got min=${minR} max=${maxR}`);
});
