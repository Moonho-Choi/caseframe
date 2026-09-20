// 실행: node motion/test/real_align.mjs /Users/eumtmj/이음랩/rife/사진_선별
// PNG/JPG 읽기는 opencv.js가 못 하므로 파이썬으로 RGBA raw를 만들어 둔다 (아래 파이썬 한 줄 참조)
import fs from 'node:fs'; import path from 'node:path';
import { cvReady } from './_cv.mjs';
import { toGray } from '../js/features.js';
import { chainTransforms, warpImage } from '../js/align.js';
const dir = process.argv[2];
const cv = await cvReady();
const files = fs.readdirSync(dir).filter(f => f.endsWith('.rgba')).sort();
const items = files.map(f => { const [w, h] = f.match(/(\d+)x(\d+)\.rgba$/).slice(1).map(Number); return { name: f, image: { width: w, height: h, data: new Uint8ClampedArray(fs.readFileSync(path.join(dir, f))) } }; });
const W = items[0].image.width, H = items[0].image.height;
const t0 = Date.now();
const grays = items.map(it => toGray(cv, it.image));
const { T, status } = await chainTransforms(cv, grays, W, H, (i, n) => process.stdout.write(`\r${i}/${n}`));
console.log('\nstatus', status.join(' '), 'time', ((Date.now() - t0) / 1000).toFixed(1), 's');
// 이웃 일치도 (맥 파이썬과 같은 정의): 640x427로 축소 → 7x7 블러 → 위아래 60px/좌우 80px 잘라낸
// 가운데 영역의 정규화 상관 평균
function metricGray(cv, image) {
  const rgba = cv.matFromImageData(image);
  const gray = new cv.Mat(); cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY); rgba.delete();
  const resized = new cv.Mat(); cv.resize(gray, resized, new cv.Size(640, 427), 0, 0, cv.INTER_AREA); gray.delete();
  const blurred = new cv.Mat(); cv.GaussianBlur(resized, blurred, new cv.Size(7, 7), 0); resized.delete();
  const roi = blurred.roi(new cv.Rect(80, 60, 480, 307));
  const cont = new cv.Mat(); roi.copyTo(cont); roi.delete(); blurred.delete();
  const g = new Float32Array(cont.rows * cont.cols); for (let k = 0; k < g.length; k++) g[k] = cont.data[k];
  cont.delete();
  return g;
}
let prev = null, sum = 0, cnt = 0;
items.forEach((it, i) => {
  const out = warpImage(cv, it.image, T[i], W, H);
  const g = metricGray(cv, out);
  if (prev) { let mx = 0, my = 0; for (let k = 0; k < g.length; k++) { mx += prev[k]; my += g[k]; } mx /= g.length; my /= g.length; let sxy = 0, sxx = 0, syy = 0; for (let k = 0; k < g.length; k++) { const u = prev[k] - mx, v = g[k] - my; sxy += u * v; sxx += u * u; syy += v * v; } sum += sxy / Math.sqrt(sxx * syy); cnt++; }
  prev = g;
});
console.log('이웃 일치도 평균', (sum / cnt).toFixed(3), '(맥 파이썬 SIFT+ECC 0.684 부근이면 합격)');
grays.forEach(g => g.delete());
