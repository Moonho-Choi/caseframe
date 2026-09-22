import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickSmooth, percentile } from '../js/select.js';

test('pickSmooth: 문턱 아래 사진은 건너뛰고 첫·마지막은 남긴다', () => {
  // 0-1 비슷, 1-2 다름, 1-3 비슷, 3-4 비슷, 4-5(끝)
  const S = { '0,1': 0.9, '0,2': 0.5, '1,2': 0.5, '1,3': 0.85, '3,4': 0.9, '3,5': 0.3, '4,5': 0.4 };
  const score = (a, b) => S[`${a},${b}`] ?? 0;
  assert.deepEqual(pickSmooth(6, score, 0.8), [0, 1, 3, 4, 5]);
});

test('pickSmooth: 연속으로 maxSkip장 건너뛰면 그중 제일 나은 한 장을 남긴다', () => {
  const S = { '0,1': 0.2, '0,2': 0.6, '0,3': 0.4, '2,4': 0.9 };
  const score = (a, b) => S[`${a},${b}`] ?? 0;
  assert.deepEqual(pickSmooth(6, score, 0.8, 3), [0, 2, 4, 5]);
});

test('pickSmooth: 2장 이하면 전부', () => {
  assert.deepEqual(pickSmooth(2, () => 0, 0.9), [0, 1]);
  assert.deepEqual(pickSmooth(0, () => 0, 0.9), []);
});

test('percentile', () => {
  assert.equal(percentile([0.5, 0.9, 0.7, 0.6, 0.8], 0.5), 0.7);
  assert.equal(percentile([0.5, 0.9, 0.7, 0.6, 0.8], 0.75), 0.8);
  assert.equal(percentile([], 0.5), 0);
});
