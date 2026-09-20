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
// 방향 검사는 정밀한 정합이 필요 없으니 ORB 특징점을 2000개로 줄여 검출 자체를 가볍게 한다.
// 진행 콜백은 총 3n번(사진 n장 특징점 추출 + 1차 잠정 판정 n장 + 2차 최종 판정 n장)
// 불러서 세 단계 모두 눈에 보이게 움직이며, 각 단계 안에서도 사진 한 장이 끝날 때마다
// setTimeout(0)으로 한 틱 양보해 진행 막대·글씨가 실제로 화면에 그려지게 한다(그러지
// 않으면 각 단계를 한 번에 몰아서 처리하며 메인 스레드가 통째로 막힌다).
const ORB_FEATURES = 2000;

// 사진마다 "정방향으로 봤을 때"(F)와 "좌우로 뒤집어 봤을 때"(FF) 두 가지 특징점을
// 뽑아 두고, 이웃 사진과 어느 쪽이 더 잘 들어맞는지로 뒤집힘 여부를 판정한다(so=정방향
// 점수, sf=뒤집은 쪽 점수). 이때 이웃도 늘 F[j](이웃의 정방향 특징점)만 기준으로 쓰면
// 문제가 생긴다 — 이웃 자체가 실제로 뒤집혀 찍힌 사진이면 F[j]는 "틀린 방향"의 특징점
// 이라, 정상인 사진도 그 틀린 기준과 안 맞아 보여 잘못 "뒤집힘"으로 몰릴 수 있다(사진이
// 25장처럼 많으면 다른 정상 이웃들이 표를 눌러 주지만, 6장처럼 성기면 못 누른다).
// 그래서 2단계로 판정한다: 1차는 지금까지 하던 대로(이웃의 원래 특징점 기준)로 돌려서
// "이웃이 뒤집혔는지" 잠정 판단만 얻고, 2차에서 그 잠정 판단으로 이웃 특징점을
// 바로잡은(뒤집힌 이웃이면 FF[j]를 씀) 다음 다시 채점해 최종 판정으로 쓴다.
export async function checkOrientation(cv, grays, W, onProgress) {
  const n = grays.length;
  const workW = Math.min(640, W);
  const small = grays.map(g => downscaleGray(cv, g, workW));
  const F = [], FF = [];
  const total = 3 * n; // 특징점 추출 n + 1차 판정 n + 2차(최종) 판정 n
  for (let i = 0; i < n; i++) {
    F.push(detect(cv, small[i].m, ORB_FEATURES));
    const f = new cv.Mat(); cv.flip(small[i].m, f, 1);
    FF.push(detect(cv, f, ORB_FEATURES));
    f.delete();
    onProgress && onProgress(i + 1, total);
    await yieldToUI();
  }
  // 1차: 이웃의 "원래(정방향)" 특징점만 기준으로 잠정 판정.
  const pass1 = [];
  for (let i = 0; i < n; i++) {
    let so = 0, sf = 0;
    for (const j of [i - 2, i - 1, i + 1, i + 2]) {
      if (j < 0 || j >= n) continue;
      const a = pairTransform(cv, F[j], F[i], workW), b = pairTransform(cv, F[j], FF[i], workW);
      so += a ? a.k : 0; sf += b ? b.k : 0;
    }
    pass1.push(sf > so * 1.3 && sf >= 15);
    onProgress && onProgress(n + i + 1, total);
    await yieldToUI();
  }
  // 2차(최종): 이웃 j가 1차에서 "뒤집힘"으로 나왔으면 그 이웃은 FF[j](바로잡은 특징점)를
  // 기준으로 쓴다. 결과(flip/warn/so/sf)는 이 2차 채점을 최종 판정으로 삼는다.
  const out = [];
  for (let i = 0; i < n; i++) {
    let so = 0, sf = 0;
    for (const j of [i - 2, i - 1, i + 1, i + 2]) {
      if (j < 0 || j >= n) continue;
      const Fj = pass1[j] ? FF[j] : F[j];
      const a = pairTransform(cv, Fj, F[i], workW), b = pairTransform(cv, Fj, FF[i], workW);
      so += a ? a.k : 0; sf += b ? b.k : 0;
    }
    const flip = sf > so * 1.3 && sf >= 15;
    const warn = flip ? 'flip' : (so < 8 && sf < 8 ? 'other' : null);
    out.push({ flip, warn, so, sf });
    onProgress && onProgress(2 * n + i + 1, total);
    await yieldToUI();
  }
  F.forEach(f => f.delete()); FF.forEach(f => f.delete());
  small.forEach(s => { if (s.owned) s.m.delete(); });
  return out;
}
