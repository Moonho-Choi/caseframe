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
const { T, status } = chainTransforms(cv, grays, W, H, (i, n) => process.stdout.write(`\r${i}/${n}`));
console.log('\nstatus', status.join(' '), 'time', ((Date.now() - t0) / 1000).toFixed(1), 's');
// 이웃 일치도 (맥 파이썬과 같은 정의): 가운데 영역 정규화 상관 평균
let prev = null, sum = 0, cnt = 0;
items.forEach((it, i) => {
  const out = warpImage(cv, it.image, T[i], W, H);
  const g = new Float32Array(out.width * out.height); for (let k = 0; k < g.length; k++) g[k] = 0.299 * out.data[4 * k] + 0.587 * out.data[4 * k + 1] + 0.114 * out.data[4 * k + 2];
  if (prev) { let mx = 0, my = 0; for (let k = 0; k < g.length; k++) { mx += prev[k]; my += g[k]; } mx /= g.length; my /= g.length; let sxy = 0, sxx = 0, syy = 0; for (let k = 0; k < g.length; k++) { const u = prev[k] - mx, v = g[k] - my; sxy += u * v; sxx += u * u; syy += v * v; } sum += sxy / Math.sqrt(sxx * syy); cnt++; }
  prev = g;
});
console.log('이웃 일치도 평균', (sum / cnt).toFixed(3), '(맥 파이썬 0.684 부근이면 합격)');
grays.forEach(g => g.delete());
