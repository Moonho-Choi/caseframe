import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outputName, pickEncoder, labelMetrics } from '../js/encode.js';

test('outputName', () => {
  assert.equal(outputName('임희진_20221128_160831.jpg', 'mp4'), '임희진_교정진행.mp4');
  assert.equal(outputName('case.png', 'mp4'), 'case_교정진행.mp4');
});
// WebCodecs가 없으면 null만 돌려준다(예비 WebM 경로 없음) → main.js가 "크롬이나
// 엣지를 써 주세요"로 안내한다.
test('pickEncoder returns null without WebCodecs', () => { assert.equal(pickEncoder(), null); });
test('labelMetrics scale with width', () => {
  assert.deepEqual(labelMetrics(1152), { band: 63, font: 40, pad: 14 });
});
