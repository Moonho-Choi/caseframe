import { detect, pairTransform } from './features.js';

function yieldToUI() { return new Promise(r => setTimeout(r, 0)); }

// 640px보다 넓으면 640으로 줄인 사본을 돌려주고(owned:true → 나중에 delete 필요),
// 이미 640 이하면 원본 Mat을 그대로 돌려준다(owned:false → delete 금지, 이중 해제 방지).
function downscaleGray(cv, g, workW) {
  if (g.cols <= workW) return { m: g, owned: false };
  const s = workW / g.cols;
  const out = new cv.Mat();
  cv.resize(g, out, new cv.Size(workW, Math.round(g.rows * s)), 0, 0, cv.INTER_AREA);
  return { m: out, owned: true };
}

export function flipImageData(image) {
  const { width: w, height: h, data } = image;
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = (y * w + x) * 4, d = (y * w + (w - 1 - x)) * 4;
    out[d] = data[s]; out[d + 1] = data[s + 1]; out[d + 2] = data[s + 2]; out[d + 3] = data[s + 3];
  }
  return typeof ImageData === 'function' ? new ImageData(out, w, h) : { width: w, height: h, data: out };
}

// 640px로 줄인 사본에서 방향(뒤집힘)을 검사한다 — 원본 해상도(최대 1280px)에서 ORB
// 6000점 검출 + 브루트포스 매칭을 25장 넘게 돌리면 메인 스레드가 수 분씩 멈춘다.
// onProgress(i, n)은 사진 한 장(정방향+뒤집기 특징점 추출)을 끝낼 때마다 부르고,
// 그 직후 setTimeout(0)으로 한 틱 양보해 진행 막대·글씨가 실제로 화면에 그려지게 한다.
export async function checkOrientation(cv, grays, W, onProgress) {
  const n = grays.length;
  const workW = Math.min(640, W);
  const small = grays.map(g => downscaleGray(cv, g, workW));
  const F = [], FF = [];
  for (let i = 0; i < n; i++) {
    F.push(detect(cv, small[i].m));
    const f = new cv.Mat(); cv.flip(small[i].m, f, 1);
    FF.push(detect(cv, f));
    f.delete();
    onProgress && onProgress(i + 1, n);
    await yieldToUI();
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    let so = 0, sf = 0;
    for (const j of [i - 2, i - 1, i + 1, i + 2]) {
      if (j < 0 || j >= n) continue;
      const a = pairTransform(cv, F[j], F[i], workW), b = pairTransform(cv, F[j], FF[i], workW);
      so += a ? a.k : 0; sf += b ? b.k : 0;
    }
    const flip = sf > so * 1.3 && sf >= 15;
    const warn = flip ? 'flip' : (so < 8 && sf < 8 ? 'other' : null);
    out.push({ flip, warn, so, sf });
  }
  F.forEach(f => f.delete()); FF.forEach(f => f.delete());
  small.forEach(s => { if (s.owned) s.m.delete(); });
  return out;
}
