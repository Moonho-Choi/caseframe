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

// 설계(2026-09-22): median frame으로 재기준하면 자기 프레임 안에서 치열궁이 아래쪽에
// 있던 사진은 위로 밀려 올라가 원래 윗변이 캔버스 밖(y<0)으로 나가버린다 → 앞니 끝이
// 잘린다. chainTransforms는 재기준 뒤 모든 사진의 윗변이 캔버스 안에 들어오도록
// 전체를 최대 4%(H)까지 아래로 미는 안전 이동을 해야 한다.
test('chainTransforms shifts the whole set down when a photo would lose its top edge', async () => {
  const cv = await cvReady();
  const W = 640, H = 480; const base = makeTexture(cv, W, H, 33);
  // 케이스 1: 15px 오프셋 (H=480의 4% 안전 이동 한도 19.2px보다 작음)
  // 가운데(1번) 사진만 원본 콘텐츠가 자기 프레임 안에서 15px 아래로 치우쳐 있다
  // (치열궁이 낮게 찍힌 사진 흉내, 안전 이동만으로 완전히 회복되는 경우를 확인한다).
  // 재기준하면 이 사진은 위로 15px 밀려 올라가서 원래 윗변(y=0)이 캔버스 밖(y<0)으로
  // 나가버리는 상황이 재현돼야 한다.
  const Ms1 = [similarity(1, 0, 0, 0), similarity(1, 0, 0, 15), similarity(1, 0, 0, 0)];
  const grays1 = Ms1.map(M => warpGray(cv, base, M));
  const { T: T1, status: status1 } = await chainTransforms(cv, grays1, W, H);
  assert.deepEqual(status1, ['ok', 'ok', 'ok']);
  for (let i = 0; i < T1.length; i++) {
    const top = apply(T1[i], W / 2, 0)[1];
    assert.ok(top >= -0.5, `케이스1 사진 ${i}의 윗변이 캔버스 밖(${top})`);
  }
  // 안전 이동은 전체를 똑같이 밀 뿐, 사진끼리 맞춰놓은 상대 위치는 그대로여야 한다
  const pts1 = Ms1.map((M, i) => { const [x, y] = apply(M, 320, 240); return apply(T1[i], x, y); });
  for (const p of pts1) assert.ok(Math.hypot(p[0] - pts1[0][0], p[1] - pts1[0][1]) < 4, `spread ${p}`);
  grays1.forEach(g => g.delete());

  // 케이스 2: 40px 오프셋 (4% 캡 19.2px을 초과하므로 잔여 예상)
  // 40 - 19.2 = 20.8px 잔여, 상단 엣지 ≈ -20.8 → -23~-18 범위
  const Ms2 = [similarity(1, 0, 0, 0), similarity(1, 0, 0, 40), similarity(1, 0, 0, 0)];
  const grays2 = Ms2.map(M => warpGray(cv, base, M));
  const { T: T2, status: status2 } = await chainTransforms(cv, grays2, W, H);
  assert.deepEqual(status2, ['ok', 'ok', 'ok']);
  for (let i = 0; i < T2.length; i++) {
    const top = apply(T2[i], W / 2, 0)[1];
    if (i === 1) {
      // 오프셋 40 - 캡 19.2 = 잔여 20.8
      assert.ok(top >= -23 && top <= -18, `케이스2 사진 ${i}의 윗변 잔여가 예상 범위(${top})`);
    }
  }
  grays2.forEach(g => g.delete()); base.delete();
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
  assert.deepEqual(alignedSize(1280, 854), { cw: 1152, ch: 816 });
});

test('alignedSize still accepts a plain number margin (all four sides)', () => {
  assert.deepEqual(alignedSize(1280, 854, 0.05), { cw: 1152, ch: 768 });
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
