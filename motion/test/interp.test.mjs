import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planTiming, blend, transition, imageToCHW, chwToImage } from '../js/interp.js';

test('planTiming', () => {
  assert.deepEqual(planTiming(1.2), { N: 64, fps: 53.333333333333336 });
  assert.deepEqual(planTiming(0.5), { N: 16, fps: 32 });
  assert.deepEqual(planTiming(2.0), { N: 64, fps: 32 });
});

test('image<->chw roundtrip', () => {
  const img = { width: 2, height: 1, data: new Uint8ClampedArray([255, 0, 128, 255, 0, 255, 64, 255]) };
  const chw = imageToCHW(img);
  assert.deepEqual(Array.from(chw).map(v => Math.round(v * 255)), [255, 0, 0, 255, 128, 64]);
  assert.deepEqual(Array.from(chwToImage(chw, 2, 1).data), Array.from(img.data));
});

test('transition without AI emits N linear frames in order', async () => {
  const a = Float32Array.from([0, 0, 0]), b = Float32Array.from([1, 1, 1]);
  const got = [];
  await transition(a, b, 1, 1, 8, 0, null, async f => { got.push(f[0]); }, () => false);
  assert.deepEqual(got.map(v => +v.toFixed(3)), [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875]);
});

test('transition with fake AI uses mid() at top levels and blend below', async () => {
  const calls = [];
  const fake = { mid: async (x, y) => { calls.push([x[0], y[0]]); return blend(x, y, 0.5); } };
  const got = [];
  await transition(Float32Array.from([0]), Float32Array.from([1]), 1, 1, 8, 1, fake, async f => { got.push(f[0]); }, () => false);
  assert.deepEqual(calls, [[0, 1]]);              // 1단계만 AI (0.5 한 장)
  assert.deepEqual(got.map(v => +v.toFixed(3)), [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875]);
});

test('transition stops when cancelled', async () => {
  let n = 0;
  await transition(Float32Array.from([0]), Float32Array.from([1]), 1, 1, 8, 0, null, async () => { n++; }, () => n >= 3);
  assert.equal(n, 3);
});
