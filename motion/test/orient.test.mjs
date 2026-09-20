import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cvReady } from './_cv.mjs';
import { makeTexture, warpGray, similarity } from './_synth.mjs';
import { checkOrientation, flipImageData } from '../js/orient.js';

test('flipImageData mirrors horizontally', () => {
  const img = { width: 3, height: 1, data: new Uint8ClampedArray([1, 1, 1, 255, 2, 2, 2, 255, 3, 3, 3, 255]) };
  const f = flipImageData(img);
  assert.deepEqual(Array.from(f.data), [3, 3, 3, 255, 2, 2, 2, 255, 1, 1, 1, 255]);
});

test('checkOrientation flags the one mirrored photo among five', async () => {
  const cv = await cvReady();
  const W = 640, H = 480;
  const base = makeTexture(cv, W, H, 3);
  const grays = [];
  for (let i = 0; i < 5; i++) grays.push(warpGray(cv, base, similarity(1 + 0.02 * i, i - 2, 5 * i, -3 * i)));
  const flipped = new cv.Mat(); cv.flip(grays[2], flipped, 1); grays[2].delete(); grays[2] = flipped;
  const r = await checkOrientation(cv, grays, W);
  assert.deepEqual(r.map(x => x.flip), [false, false, true, false, false]);
  assert.equal(r[2].warn, 'flip');
  grays.forEach(g => g.delete()); base.delete();
});

// 성긴(6장) 세트 재현 — 실제 환자 사진 25장 중 6장만 골라 돌렸을 때 나온 증상이다.
// 앞의 네 장(0~3)은 서로 비슷한 구도, 뒤의 두 장(4·5)은 그 넷과 꽤 다르면서 서로는
// 거의 같은 구도다. 여기서 4번만 좌우가 뒤집혀 있으면, 사진 한 장씩 "절대 방향"을
// 매기던 옛 방식은 4번의 뒤집힘이 5번의 표를 오염시켜(둘이 거의 같은 구도라 서로의
// 점수가 제일 크다) 결국 아무것도 못 잡아낸다. 상대 방향을 사슬로 이어 붙이는
// 방식이라야 4번 하나만 정확히 잡는다.
const SPARSE = [
  similarity(0.90, -4, -80, 80),
  similarity(0.91, -4, -77, 76),
  similarity(0.93, -3.5, -72, 71),
  similarity(0.95, -3, -68, 66),
  similarity(1.10, 4, 80, -80),
  similarity(1.10, 4, 80.5, -80),
];
function sparseSet(cv, base, mirror) {
  const grays = SPARSE.map(M => warpGray(cv, base, M));
  for (const i of mirror) { const f = new cv.Mat(); cv.flip(grays[i], f, 1); grays[i].delete(); grays[i] = f; }
  return grays;
}

test('checkOrientation on a sparse 6-photo set flags only the mirrored photo', async () => {
  const cv = await cvReady();
  const base = makeTexture(cv, 640, 480, 7);
  const grays = sparseSet(cv, base, [4]);
  const r = await checkOrientation(cv, grays, 640);
  assert.deepEqual(r.map(x => x.flip), [false, false, false, false, true, false]);
  assert.equal(r[5].warn, null);
  assert.equal(r[4].warn, 'flip');
  grays.forEach(g => g.delete()); base.delete();
});

// 같은 6장인데 이번엔 0·1·2·3·5번이 뒤집혀 있고 4번만 정방향이다 — 즉 "뒤집힌 쪽"이
// 다수다. 방향은 상대적인 값이라 다수 쪽을 정방향으로 보는 게 맞으므로, 결과는 위와
// 똑같이 4번 한 장만 "뒤집힘"이어야 한다.
test('checkOrientation calls the majority orientation normal (majority mirrored)', async () => {
  const cv = await cvReady();
  const base = makeTexture(cv, 640, 480, 7);
  const grays = sparseSet(cv, base, [0, 1, 2, 3, 5]);
  const r = await checkOrientation(cv, grays, 640);
  assert.deepEqual(r.map(x => x.flip), [false, false, false, false, true, false]);
  assert.equal(r[5].warn, null);
  grays.forEach(g => g.delete()); base.delete();
});

// 기준으로 삼는 첫 장(0번)이 하필 뒤집힌 한 장인 경우 — 사슬을 이어 붙이면 라벨이
// 전부 반대로 나오므로, "많은 쪽을 정방향으로" 규칙이 전체를 되뒤집어 0번 한 장만
// 뒤집힘으로 내놓아야 한다.
test('checkOrientation flips the whole labelling when the first photo is the mirrored one', async () => {
  const cv = await cvReady();
  const base = makeTexture(cv, 640, 480, 7);
  const grays = sparseSet(cv, base, [0]);
  const r = await checkOrientation(cv, grays, 640);
  assert.deepEqual(r.map(x => x.flip), [true, false, false, false, false, false]);
  assert.equal(r[0].warn, 'flip');
  grays.forEach(g => g.delete()); base.delete();
});

// 이웃과 아무 관계도 못 읽는 사진(여기서는 특징점이 하나도 안 나오는 민무늬 사진)은
// 뒤집지 않고 빨간 "다른 방향?" 표시만 붙어야 한다. 이 경로가 잘못 돌면 멀쩡한 사진을
// 뒤집거나, 반대로 섞여 들어온 다른 방향 사진을 아무 표시 없이 통과시킨다.
test('checkOrientation marks a photo it cannot relate to neighbours as other', async () => {
  const cv = await cvReady();
  const W = 640, H = 480;
  const base = makeTexture(cv, W, H, 21);
  const grays = [0, 1, 2].map(i => warpGray(cv, base, similarity(1 + 0.02 * i, i - 1, 6 * i, -4 * i)));
  grays.push(new cv.Mat(H, W, cv.CV_8UC1, new cv.Scalar(128)));   // 민무늬 = 특징점 0개
  const r = await checkOrientation(cv, grays, W);
  assert.deepEqual(r.map(x => x.flip), [false, false, false, false]);
  assert.equal(r[3].warn, 'other');
  assert.deepEqual(r.slice(0, 3).map(x => x.warn), [null, null, null]);
  grays.forEach(g => g.delete()); base.delete();
});
