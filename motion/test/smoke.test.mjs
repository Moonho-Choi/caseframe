import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cvReady } from './_cv.mjs';

test('opencv.js loads with ORB, BFMatcher, findTransformECC, CLAHE', async () => {
  const cv = await cvReady();
  for (const n of ['ORB', 'BFMatcher', 'findTransformECC', 'CLAHE', 'warpAffine', 'estimateAffine2D'])
    assert.equal(typeof cv[n], 'function', n);
});
