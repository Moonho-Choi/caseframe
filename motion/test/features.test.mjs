import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cvReady } from './_cv.mjs';
import { makeTexture, warpGray, similarity } from './_synth.mjs';
import { detect, pairTransform, similarityRansac, sane, compose, invert, apply } from '../js/features.js';

test('similarityRansac recovers a known transform with outliers', () => {
  const M = similarity(1.1, 5, 30, -20);
  const src = [], dst = [];
  for (let i = 0; i < 60; i++) { const x = (i * 37) % 500, y = (i * 91) % 400; const [u, v] = apply(M, x, y); src.push(x, y); dst.push(u + (i % 7 === 0 ? 300 : 0), v); }
  const r = similarityRansac(Float32Array.from(src), Float32Array.from(dst), 3, 2000);
  assert.ok(r && r.k >= 50, 'inliers');
  for (let j = 0; j < 6; j++) assert.ok(Math.abs(r.M[j] - M[j]) < 0.05 + (j % 3 === 2 ? 2 : 0), `coef ${j}`);
});

test('sane rejects wild transforms', () => {
  assert.equal(sane(similarity(1, 0, 0, 0), 1280), true);
  assert.equal(sane(similarity(0.3, 0, 0, 0), 1280), false);
  assert.equal(sane(similarity(1, 45, 0, 0), 1280), false);
  assert.equal(sane(similarity(1, 0, 900, 0), 1280), false);
});

test('compose/invert are consistent', () => {
  const A = similarity(1.2, 10, 5, 6), B = similarity(0.9, -3, -7, 2);
  const [x, y] = apply(compose(A, B), 100, 50);
  const [bx, by] = apply(B, 100, 50); const [ax, ay] = apply(A, bx, by);
  assert.ok(Math.abs(x - ax) < 1e-9 && Math.abs(y - ay) < 1e-9);
  const [ix, iy] = apply(compose(invert(A), A), 33, 44);
  assert.ok(Math.abs(ix - 33) < 1e-9 && Math.abs(iy - 44) < 1e-9);
});

test('pairTransform recovers transform between texture and its warp', async () => {
  const cv = await cvReady();
  const W = 640, H = 480;
  const a = makeTexture(cv, W, H, 7);
  const M = similarity(1.08, 4, 25, -15);
  const b = warpGray(cv, a, M);          // b = M(a)  → pairTransform(fa, fb)는 b→a 이므로 M의 역
  const fa = detect(cv, a), fb = detect(cv, b);
  const r = pairTransform(cv, fa, fb, W);
  assert.ok(r && r.k >= 30, `inliers ${r && r.k}`);
  const Minv = invert(M);
  const [x, y] = apply(r.M, 320, 240), [ex, ey] = apply(Minv, 320, 240);
  assert.ok(Math.hypot(x - ex, y - ey) < 3, `center err ${Math.hypot(x - ex, y - ey)}`);
  fa.delete(); fb.delete(); a.delete(); b.delete();
});
