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

// 성긴(6장) 세트 재현: 이웃이 적으면 뒤집힌 이웃 하나가 표를 오염시켜 그 옆의 정상
// 사진까지 "뒤집힘"으로 잘못 몰 수 있다(사진이 25장처럼 많을 땐 다른 정상 이웃들이
// 눌러 주지만 6장에서는 못 누른다) — 1차 판정만으로 끝내던 예전 코드에서 실제로
// 재현된 문제(관악구 이음턱편한치과 25장 중 6장만 골랐을 때 보고됨). 마지막 사진(5번)은
// 바로 앞 사진(4번, 뒤집힘)과 변환이 거의 같고 그 앞(3번)과는 꽤 달라서, "이웃의
// 원래 특징점"만 보는 1차 판정으로는 5번까지 뒤집힘으로 오판하게 되어 있다.
// 2단계(잠정 → 이웃 특징점 보정 → 최종) 판정으로 고쳤는지 검사한다.
test('checkOrientation on a sparse 6-photo set does not also flag the mirrored photo\'s neighbor', async () => {
  const cv = await cvReady();
  const W = 640, H = 480;
  const base = makeTexture(cv, W, H, 7);
  const T = [
    similarity(0.90, -4, -80, 50),
    similarity(0.95, -2, -45, 25),
    similarity(1.00, 0, -15, 0),
    similarity(1.00, 0, 5, -5),
    similarity(1.10, 4, 40, -30),   // 뒤집힘
    similarity(1.10, 4, 41, -30.5), // 바로 앞(4번)과 변환이 거의 같음
  ];
  const grays = T.map(M => warpGray(cv, base, M));
  const flipped = new cv.Mat(); cv.flip(grays[4], flipped, 1); grays[4].delete(); grays[4] = flipped;
  const r = await checkOrientation(cv, grays, W);
  assert.deepEqual(r.map(x => x.flip), [false, false, false, false, true, false]);
  assert.equal(r[5].warn, null);
  grays.forEach(g => g.delete()); base.delete();
});
