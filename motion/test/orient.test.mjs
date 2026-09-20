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
