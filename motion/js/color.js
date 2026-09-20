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
  const mean = s.map(v => v / n); const std = ss.map((v, c) => Math.max(Math.sqrt(Math.max(v / n - mean[c] * mean[c], 0)), 1));
  return { mean, std };
}
const median = arr => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
function yieldToUI() { return new Promise(r => setTimeout(r, 0)); }

// 사진 한 장이 1280×854면 약 109만 화소이고, 화소마다 LAB 왕복(Math.pow 네 번)을 돈다.
// 25장이면 2700만 화소라 예전에는 이 함수 하나가 몇 초씩 화면을 통째로 얼렸고 그동안
// 취소 버튼도 눌리지 않았다. 그래서 사진 한 장을 끝낼 때마다 진행 상황을 알리고
// setTimeout(0)으로 한 틱 양보한다. onProgress는 총 2n번(통계 n + 보정 n) 불린다.
// isCancelled()가 true면 Error('취소')를 던진다.
export async function matchColors(images, onProgress, isCancelled) {
  const n = images.length, total = 2 * n;
  const stop = () => { if (isCancelled && isCancelled()) throw new Error('취소'); };
  const st = [];
  for (let k = 0; k < n; k++) {
    st.push(stats(images[k]));
    onProgress && onProgress(k + 1, total);
    await yieldToUI();
    stop();
  }
  const tm = [0, 1, 2].map(c => median(st.map(s => s.mean[c]))), ts = [0, 1, 2].map(c => median(st.map(s => s.std[c])));
  const out = [];
  for (let k = 0; k < n; k++) {
    const img = images[k];
    const { mean, std } = st[k]; const d = img.data; const o = new Uint8ClampedArray(d.length);
    for (let i = 0; i < d.length; i += 4) {
      const l = rgbToLab(d[i], d[i + 1], d[i + 2]);
      const L = (l[0] - mean[0]) / std[0] * ts[0] + tm[0], a = (l[1] - mean[1]) / std[1] * ts[1] + tm[1], b = (l[2] - mean[2]) / std[2] * ts[2] + tm[2];
      const rgb = labToRgb(L, a, b); o[i] = rgb[0]; o[i + 1] = rgb[1]; o[i + 2] = rgb[2]; o[i + 3] = 255;
    }
    out.push(typeof ImageData === 'function' ? new ImageData(o, img.width, img.height) : { width: img.width, height: img.height, data: o });
    onProgress && onProgress(n + k + 1, total);
    await yieldToUI();
    stop();
  }
  return out;
}
