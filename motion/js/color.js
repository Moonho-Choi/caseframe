const f = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
const fi = t => (t > 0.206893 ? t * t * t : (t - 16 / 116) / 7.787);
const lin = c => { c /= 255; return c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92; };
const gam = c => { c = c > 0.0031308 ? 1.055 * c ** (1 / 2.4) - 0.055 : 12.92 * c; return Math.max(0, Math.min(255, Math.round(c * 255))); };
export function rgbToLab(r, g, b) {
  const R = lin(r), G = lin(g), B = lin(b);
  const x = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047, y = 0.2126 * R + 0.7152 * G + 0.0722 * B, z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
export function labToRgb(L, a, b) {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const x = fi(fx) * 0.95047, y = fi(fy), z = fi(fz) * 1.08883;
  const R = 3.2406 * x - 1.5372 * y - 0.4986 * z, G = -0.9689 * x + 1.8758 * y + 0.0415 * z, B = 0.0557 * x - 0.2040 * y + 1.0570 * z;
  return [gam(R), gam(G), gam(B)];
}
function stats(img) {
  const d = img.data; const s = [0, 0, 0], ss = [0, 0, 0]; let n = 0;
  for (let i = 0; i < d.length; i += 16) { const l = rgbToLab(d[i], d[i + 1], d[i + 2]); for (let c = 0; c < 3; c++) { s[c] += l[c]; ss[c] += l[c] * l[c]; } n++; }
  const mean = s.map(v => v / n); const std = ss.map((v, c) => Math.sqrt(Math.max(v / n - mean[c] * mean[c], 1e-6)));
  return { mean, std };
}
const median = arr => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
export function matchColors(images) {
  const st = images.map(stats);
  const tm = [0, 1, 2].map(c => median(st.map(s => s.mean[c]))), ts = [0, 1, 2].map(c => median(st.map(s => s.std[c])));
  return images.map((img, k) => {
    const { mean, std } = st[k]; const d = img.data; const out = new Uint8ClampedArray(d.length);
    for (let i = 0; i < d.length; i += 4) {
      const l = rgbToLab(d[i], d[i + 1], d[i + 2]);
      const L = (l[0] - mean[0]) / std[0] * ts[0] + tm[0], a = (l[1] - mean[1]) / std[1] * ts[1] + tm[1], b = (l[2] - mean[2]) / std[2] * ts[2] + tm[2];
      const rgb = labToRgb(L, a, b); out[i] = rgb[0]; out[i + 1] = rgb[1]; out[i + 2] = rgb[2]; out[i + 3] = 255;
    }
    return typeof ImageData === 'function' ? new ImageData(out, img.width, img.height) : { width: img.width, height: img.height, data: out };
  });
}
