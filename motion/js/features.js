// 변환 M = Float64Array [a, b, tx, c, d, ty]  (x' = a x + b y + tx, y' = c x + d y + ty)
export function apply(M, x, y) { return [M[0] * x + M[1] * y + M[2], M[3] * x + M[4] * y + M[5]]; }
export function compose(A, B) {
  return new Float64Array([
    A[0] * B[0] + A[1] * B[3], A[0] * B[1] + A[1] * B[4], A[0] * B[2] + A[1] * B[5] + A[2],
    A[3] * B[0] + A[4] * B[3], A[3] * B[1] + A[4] * B[4], A[3] * B[2] + A[4] * B[5] + A[5]]);
}
export function invert(M) {
  const det = M[0] * M[4] - M[1] * M[3];
  const a = M[4] / det, b = -M[1] / det, c = -M[3] / det, d = M[0] / det;
  return new Float64Array([a, b, -(a * M[2] + b * M[5]), c, d, -(c * M[2] + d * M[5])]);
}
export const identity = () => new Float64Array([1, 0, 0, 0, 1, 0]);

export function sane(M, W) {
  const sc = Math.hypot(M[0], M[3]);
  const ang = Math.abs(Math.atan2(M[3], M[0]) * 180 / Math.PI);
  return sc > 0.6 && sc < 1.6 && ang < 20 && Math.abs(M[2]) < 0.5 * W && Math.abs(M[5]) < 0.5 * W;
}

export function toGray(cv, image) {
  const rgba = cv.matFromImageData(image);
  const gray = new cv.Mat();
  cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
  rgba.delete();
  const clahe = new cv.CLAHE(2.0, new cv.Size(8, 8));
  const out = new cv.Mat(); clahe.apply(gray, out);
  gray.delete(); clahe.delete();
  return out;
}

export function detect(cv, gray) {
  const orb = new cv.ORB(6000);
  const kp = new cv.KeyPointVector(); const des = new cv.Mat(); const mask = new cv.Mat();
  orb.detectAndCompute(gray, mask, kp, des);
  const n = kp.size(); const pts = new Float32Array(2 * n);
  for (let i = 0; i < n; i++) { const p = kp.get(i).pt; pts[2 * i] = p.x; pts[2 * i + 1] = p.y; }
  kp.delete(); orb.delete(); mask.delete();
  return { pts, des, n, delete() { des.delete(); } };
}

// 2점으로 유사변환 (a, b, tx, ty): x' = a x - b y + tx, y' = b x + a y + ty
function fit2(x1, y1, u1, v1, x2, y2, u2, v2) {
  const dx = x2 - x1, dy = y2 - y1, du = u2 - u1, dv = v2 - v1;
  const den = dx * dx + dy * dy; if (den < 1e-6) return null;
  const a = (dx * du + dy * dv) / den, b = (dx * dv - dy * du) / den;
  return new Float64Array([a, -b, u1 - (a * x1 - b * y1), b, a, v1 - (b * x1 + a * y1)]);
}
// 내점 전체로 최소제곱 유사변환
function fitLS(src, dst, idx) {
  let sx = 0, sy = 0, su = 0, sv = 0; const n = idx.length;
  for (const i of idx) { sx += src[2 * i]; sy += src[2 * i + 1]; su += dst[2 * i]; sv += dst[2 * i + 1]; }
  sx /= n; sy /= n; su /= n; sv /= n;
  let sxx = 0, sxu = 0, sxv = 0;
  for (const i of idx) {
    const x = src[2 * i] - sx, y = src[2 * i + 1] - sy, u = dst[2 * i] - su, v = dst[2 * i + 1] - sv;
    sxx += x * x + y * y; sxu += x * u + y * v; sxv += x * v - y * u;
  }
  const a = sxu / sxx, b = sxv / sxx;
  return new Float64Array([a, -b, su - (a * sx - b * sy), b, a, sv - (b * sx + a * sy)]);
}
export function similarityRansac(src, dst, thresh = 10, iters = 3000) {
  const n = src.length / 2; if (n < 2) return null;
  let best = null, bestK = 0, s = 12345;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const t2 = thresh * thresh;
  for (let it = 0; it < iters; it++) {
    const i = Math.floor(rnd() * n), j = Math.floor(rnd() * n); if (i === j) continue;
    const M = fit2(src[2 * i], src[2 * i + 1], dst[2 * i], dst[2 * i + 1], src[2 * j], src[2 * j + 1], dst[2 * j], dst[2 * j + 1]);
    if (!M) continue;
    let k = 0;
    for (let q = 0; q < n; q++) { const [u, v] = apply(M, src[2 * q], src[2 * q + 1]); if ((u - dst[2 * q]) ** 2 + (v - dst[2 * q + 1]) ** 2 < t2) k++; }
    if (k > bestK) { bestK = k; best = M; }
  }
  if (!best || bestK < 3) return null;
  const idx = [];
  for (let q = 0; q < n; q++) { const [u, v] = apply(best, src[2 * q], src[2 * q + 1]); if ((u - dst[2 * q]) ** 2 + (v - dst[2 * q + 1]) ** 2 < t2) idx.push(q); }
  const M = fitLS(src, dst, idx);
  let k = 0;
  for (let q = 0; q < n; q++) { const [u, v] = apply(M, src[2 * q], src[2 * q + 1]); if ((u - dst[2 * q]) ** 2 + (v - dst[2 * q + 1]) ** 2 < t2) k++; }
  return { M, k };
}

// fb(=b) → fa(=a) 변환. 반환 {M, k} 또는 null
export function pairTransform(cv, fa, fb, W) {
  if (!fa.n || !fb.n) return null;
  const bf = new cv.BFMatcher(cv.NORM_HAMMING, false);
  const mm = new cv.DMatchVectorVector();
  bf.knnMatch(fb.des, fa.des, mm, 2);
  const pairs = [];
  for (let i = 0; i < mm.size(); i++) { const p = mm.get(i); if (p.size() >= 2) pairs.push([p.get(0).queryIdx, p.get(0).trainIdx, p.get(0).distance, p.get(1).distance]); p.delete(); }
  mm.delete(); bf.delete();
  let best = null;
  for (const ratio of [0.7, 0.8]) {
    const good = pairs.filter(p => p[2] < ratio * p[3]);
    if (good.length < 8) continue;
    const src = new Float32Array(2 * good.length), dst = new Float32Array(2 * good.length);
    good.forEach((p, i) => { src[2 * i] = fb.pts[2 * p[0]]; src[2 * i + 1] = fb.pts[2 * p[0] + 1]; dst[2 * i] = fa.pts[2 * p[1]]; dst[2 * i + 1] = fa.pts[2 * p[1] + 1]; });
    const r = similarityRansac(src, dst, 10, 3000);
    if (r && r.k >= 8 && sane(r.M, W) && (!best || r.k > best.k)) best = r;
  }
  return best;
}
