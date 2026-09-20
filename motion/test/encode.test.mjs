import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outputName, pickEncoder, labelMetrics } from '../js/encode.js';

test('outputName', () => {
  assert.equal(outputName('임희진_20221128_160831.jpg', 'mp4'), '임희진_교정진행.mp4');
  assert.equal(outputName('case.png', 'webm'), 'case_교정진행.webm');
});
test('pickEncoder returns null in Node', () => { assert.equal(pickEncoder(), null); });
test('labelMetrics scale with width', () => {
  assert.deepEqual(labelMetrics(1152), { band: 63, font: 40, pad: 14 });
});
