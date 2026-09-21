import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cvReady } from './_cv.mjs';
import { makeTexture, warpGray, similarity } from './_synth.mjs';
import { chainTransforms, eccRefine, medianFrame, alignedSize, warpImage, neighborScores } from '../js/align.js';
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

test('alignedSize is a multiple of 16 and about 90% of frame', () => {
  assert.deepEqual(alignedSize(1280, 854), { cw: 1152, ch: 768 });
});

test('warpImage returns cropped ImageData', async () => {
  const cv = await cvReady();
  const img = { width: 64, height: 48, data: new Uint8ClampedArray(64 * 48 * 4).fill(200) };
  const out = warpImage(cv, img, similarity(1, 0, 0, 0), 64, 48, 0.05);
  assert.equal(out.width, 48); assert.equal(out.height, 32); assert.equal(out.data[0], 200);
});

// 흑백 Mat을 neighborScores가 받는 RGBA 사진(ImageData 모양)으로 바꾼다.
function grayToImage(gray) {
  const w = gray.cols, h = gray.rows, d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { const v = gray.data[i]; d[4 * i] = d[4 * i + 1] = d[4 * i + 2] = v; d[4 * i + 3] = 255; }
  return { width: w, height: h, data: d };
}

// 설계 §6-1: 구도를 맞춘 뒤의 상태를 흉내 낸다 — 같은 텍스처를 조금씩 옮긴 4장 사이에
// 전혀 다른 텍스처 한 장을 끼워 넣으면, 그 한 장만 점수가 뚜렷하게 낮아야 한다.
test('neighborScores singles out the one photo that does not match its neighbours', async () => {
  const cv = await cvReady();
  const W = 640, H = 427;
  const base = makeTexture(cv, W, H, 21);
  const odd = makeTexture(cv, W, H, 99);
  const shifts = [similarity(1, 0, 0, 0), similarity(1, 0, 3, -2), similarity(1, 0, -3, 2), similarity(1, 0, 2, 3)];
  const mats = [
    warpGray(cv, base, shifts[0]),
    warpGray(cv, base, shifts[1]),
    odd,                                   // 가운데(2번)가 이웃과 전혀 다른 사진
    warpGray(cv, base, shifts[2]),
    warpGray(cv, base, shifts[3]),
  ];
  const scores = await neighborScores(cv, mats.map(grayToImage));
  assert.equal(scores.length, 5);
  const others = scores.filter((_, i) => i !== 2).sort((a, b) => a - b);
  const median = others[Math.floor(others.length / 2)];
  assert.equal(scores.indexOf(Math.min(...scores)), 2, `가장 낮은 점수가 2번이어야 한다: ${scores}`);
  assert.ok(scores[2] < 0.75 * median, `2번 ${scores[2]} < 0.75 × 중앙값 ${median}`);
  mats.forEach(m => m.delete()); base.delete();
});

// 정합은 25장에 몇 분씩 걸리므로 중간에 취소가 들어야 한다. 예전에는 취소 여부를
// 다 끝난 뒤에야 확인해서 취소 버튼이 사실상 듣지 않았다.
test('chainTransforms stops with 취소 while it is still working', async () => {
  const cv = await cvReady();
  const W = 320, H = 240; const base = makeTexture(cv, W, H, 13);
  const grays = [base, warpGray(cv, base, similarity(1.02, 2, 5, -4)), warpGray(cv, base, similarity(1.04, -2, -6, 5))];
  let calls = 0;
  await assert.rejects(
    () => chainTransforms(cv, grays, W, H, () => { calls++; }, () => calls >= 2),
    /취소/);
  assert.equal(calls, 2, '사진 두 장째에서 멈춰야 한다');
  grays.forEach(g => g.delete());
});
