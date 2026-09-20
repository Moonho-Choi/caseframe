import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cvReady } from './_cv.mjs';
import { makeTexture, warpGray, similarity } from './_synth.mjs';
import { chainTransforms, eccRefine, medianFrame, alignedSize, warpImage } from '../js/align.js';
import { apply, invert, compose } from '../js/features.js';

test('chainTransforms brings 4 warped copies back onto one frame', async () => {
  const cv = await cvReady();
  const W = 640, H = 480; const base = makeTexture(cv, W, H, 11);
  const Ms = [similarity(1, 0, 0, 0), similarity(1.06, 3, 20, -10), similarity(0.95, -2, -15, 12), similarity(1.02, 1, 8, 25)];
  const grays = Ms.map(M => warpGray(cv, base, M));
  const { T, status } = await chainTransforms(cv, grays, W, H);
  assert.deepEqual(status, ['ok', 'ok', 'ok', 'ok']);
  // 모든 사진의 같은 원점(base의 (320,240))이 기준 틀에서 같은 자리로 가야 한다
  const pts = Ms.map((M, i) => { const [x, y] = apply(M, 320, 240); return apply(T[i], x, y); });
  for (const p of pts) assert.ok(Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]) < 4, `spread ${p}`);
  grays.forEach(g => g.delete()); base.delete();
});

test('eccRefine improves a slightly wrong initial transform', async () => {
  const cv = await cvReady();
  const W = 640, H = 480; const a = makeTexture(cv, W, H, 5);
  const M = similarity(1.03, 2, 12, -8); const b = warpGray(cv, a, M);
  const rough = compose(invert(M), similarity(1, 0, 6, 5));   // 6,5 픽셀 어긋난 초기값
  const R = eccRefine(cv, a, b, rough);
  const [x, y] = apply(R, 320, 240), [ex, ey] = apply(invert(M), 320, 240);
  const [rx, ry] = apply(rough, 320, 240);
  assert.ok(Math.hypot(x - ex, y - ey) < Math.hypot(rx - ex, ry - ey), 'closer than rough');
  a.delete(); b.delete();
});

test('medianFrame of identical transforms is identity-like', () => {
  const T = [similarity(1.1, 5, 10, 20), similarity(1.1, 5, 10, 20), similarity(1.1, 5, 10, 20)];
  const R = medianFrame(T, 640, 480);
  for (let j = 0; j < 6; j++) assert.ok(Math.abs(R[j] - T[0][j]) < 1e-6);
});

test('alignedSize is even and 90% of frame', () => {
  assert.deepEqual(alignedSize(1280, 854), { cw: 1152, ch: 770 });
});

test('warpImage returns cropped ImageData', async () => {
  const cv = await cvReady();
  const img = { width: 64, height: 48, data: new Uint8ClampedArray(64 * 48 * 4).fill(200) };
  const out = warpImage(cv, img, similarity(1, 0, 0, 0), 64, 48, 0.05);
  assert.equal(out.width, 58); assert.equal(out.height, 44); assert.equal(out.data[0], 200);
});
