import { detect, pairTransform } from './features.js';

export function flipImageData(image) {
  const { width: w, height: h, data } = image;
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = (y * w + x) * 4, d = (y * w + (w - 1 - x)) * 4;
    out[d] = data[s]; out[d + 1] = data[s + 1]; out[d + 2] = data[s + 2]; out[d + 3] = data[s + 3];
  }
  return typeof ImageData === 'function' ? new ImageData(out, w, h) : { width: w, height: h, data: out };
}

export function checkOrientation(cv, grays, W) {
  const n = grays.length;
  const F = grays.map(g => detect(cv, g));
  const FF = grays.map(g => { const f = new cv.Mat(); cv.flip(g, f, 1); const d = detect(cv, f); f.delete(); return d; });
  const out = [];
  for (let i = 0; i < n; i++) {
    let so = 0, sf = 0;
    for (const j of [i - 2, i - 1, i + 1, i + 2]) {
      if (j < 0 || j >= n) continue;
      const a = pairTransform(cv, F[j], F[i], W), b = pairTransform(cv, F[j], FF[i], W);
      so += a ? a.k : 0; sf += b ? b.k : 0;
    }
    const flip = sf > so * 1.3 && sf >= 15;
    const warn = flip ? 'flip' : (so < 8 && sf < 8 ? 'other' : null);
    out.push({ flip, warn, so, sf });
  }
  F.forEach(f => f.delete()); FF.forEach(f => f.delete());
  return out;
}
