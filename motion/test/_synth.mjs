export function makeTexture(cv, W, H, seed = 1) {
  const m = new cv.Mat(H, W, cv.CV_8UC1);
  let s = seed >>> 0;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  m.data.fill(128);
  for (let i = 0; i < 400; i++) {
    const x = Math.floor(rnd() * W), y = Math.floor(rnd() * H), r = 4 + Math.floor(rnd() * 30), v = Math.floor(rnd() * 255);
    cv.circle(m, new cv.Point(x, y), r, new cv.Scalar(v), -1);
  }
  const blur = new cv.Mat(); cv.GaussianBlur(m, blur, new cv.Size(3, 3), 0); m.delete();
  return blur;
}
export function warpGray(cv, gray, M) {
  const mat = cv.matFromArray(2, 3, cv.CV_64F, Array.from(M));
  const out = new cv.Mat();
  cv.warpAffine(gray, out, mat, new cv.Size(gray.cols, gray.rows), cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
  mat.delete();
  return out;
}
export function similarity(scale, deg, tx, ty) {
  const a = scale * Math.cos(deg * Math.PI / 180), b = scale * Math.sin(deg * Math.PI / 180);
  return new Float64Array([a, -b, tx, b, a, ty]);
}
