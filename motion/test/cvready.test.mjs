import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cvReady } from '../js/cvready.js';

// 실제 opencv.js 빌드가 겪은 사고를 흉내 낸다: Module.then(f)이 f(Module)으로 "자기
// 자신"을 넘겨 준다. 이런 thenable을 그냥 Promise.resolve()로 넘기면 네이티브
// Promise의 thenable 처리 알고리즘이 then(cb) → cb(자기 자신) → 또 thenable 취급을
// 영원히 반복해 브라우저가 멈춘 것처럼 보인다. cvReady가 이걸 안전하게 풀어내는지
// 검사한다 — 만약 예전처럼 그냥 resolve(win.cv)를 했다면 이 테스트는 2초 안에
// 끝나지 못하고 타임아웃으로 실패한다.
test('cvReady resolves safely even when window.cv.then calls back with itself', async () => {
  const fake = { Mat: function () {}, then(f) { f(fake); } };
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('cvReady가 2초 안에 끝나지 않음(thenable 무한 루프 의심)')), 2000));
  const result = await Promise.race([cvReady({ cv: fake }), timeout]);
  assert.ok(result, 'cvReady가 값 없이 끝남');
  assert.equal(typeof result.Mat, 'function');
});

test('cvReady resolves plain cv objects (no then) as-is', async () => {
  const plain = { Mat: function () {} };
  const result = await cvReady({ cv: plain });
  assert.equal(result, plain);
});
