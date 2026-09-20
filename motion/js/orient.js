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
const ORB_FEATURES = 2000;
// 이웃과의 관계를 "읽었다"고 인정하는 최소 짝짓기 점수(RANSAC 내점 수).
const REL_MIN = 8;

// 사진 한 장만 떼어 놓고 "이 사진은 뒤집혔나"를 절대적으로 판정하는 건 원래 불가능하다
// (거울상 얼굴도 그 자체로는 멀쩡해 보인다). 실제로 잴 수 있는 건 두 사진 사이의
// **상대 방향**뿐이다 — "이 둘은 같은 방향인가, 서로 반대인가".
// 그래서 다음 순서로 판정한다.
//   1) 사진마다 정방향 특징점 F[i]와 좌우로 뒤집은 특징점 FF[i]를 뽑는다.
//   2) 앞선 이웃 j(i-1, i-2)마다 so=k(F[j],F[i]), sf=k(F[j],FF[i])를 재서
//      "반대"(sf가 so보다 뚜렷이 크다) / "같음" / "알 수 없음"을 정한다.
//   3) 첫 장을 0(기준)으로 놓고 이 상대 관계를 사슬처럼 이어 붙여 각 사진의 라벨을
//      정한다. 이웃이 여럿이면 짝짓기 점수를 표의 무게로 삼아 다수결한다.
//   4) 라벨 0/1 중 어느 쪽이 "정방향"인지는 다수결로 정한다 — 뒤집힌 사진이 과반이면
//      전체를 뒤집어, 항상 "많은 쪽"을 정방향으로 본다.
// 이렇게 하면 뒤집힌 이웃 하나가 옆 사진의 판정을 오염시키지 않는다. 그 이웃과의
// 관계는 "반대"로 정확히 읽히고, 라벨을 이어 붙일 때 그 반대 관계가 그대로 반영되기
// 때문이다(사진이 6장처럼 성겨도 마찬가지).
// 진행 콜백은 총 2n번(특징점 추출 n + 이웃 비교·라벨 n) 부르고, 각 단계에서 사진 한
// 장이 끝날 때마다 setTimeout(0)으로 한 틱 양보해 진행 막대가 실제로 그려지게 한다.
export async function checkOrientation(cv, grays, W, onProgress) {
  const n = grays.length;
  const workW = Math.min(640, W);
  const small = grays.map(g => downscaleGray(cv, g, workW));
  const F = [], FF = [];
  const total = 2 * n; // 특징점 추출 n + 이웃 비교 n
  try {
    for (let i = 0; i < n; i++) {
      F.push(detect(cv, small[i].m, ORB_FEATURES));
      const f = new cv.Mat();
      try {
        cv.flip(small[i].m, f, 1);
        FF.push(detect(cv, f, ORB_FEATURES));
      } finally { f.delete(); }
      onProgress && onProgress(i + 1, total);
      await yieldToUI();
    }
    // 이웃과의 상대 방향을 재서 라벨(o[i]: 0=기준 방향, 1=그 반대)을 이어 붙인다.
    const o = new Array(n).fill(0);
    const unknown = new Array(n).fill(false);
    const soSum = new Array(n).fill(0), sfSum = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      if (i > 0) {
        let wSame = 0, wOpp = 0, known = false;
        for (const j of [i - 1, i - 2]) {
          if (j < 0) continue;
          const a = pairTransform(cv, F[j], F[i], workW);
          const b = pairTransform(cv, F[j], FF[i], workW);
          const so = a ? a.k : 0, sf = b ? b.k : 0;
          soSum[i] += so; sfSum[i] += sf;
          // 한쪽 점수가 다른 쪽보다 뚜렷이(1.3배 넘게) 크고, 그 자체도 최소한(8점)은
          // 되어야 관계를 읽은 것으로 친다. 두 방향이 비슷하거나 둘 다 약하면 이 이웃은
          // 표를 못 던진다(실제 사진에서는 짝짓기 점수가 10~50점 수준이라, 이 문턱을
          // 더 올리면 "정방향 0점 대 뒤집힘 9점"처럼 명백한 관계까지 놓친다).
          let rel; // 1 = 서로 반대 방향, 0 = 같은 방향
          if (sf > so * 1.3 && sf >= REL_MIN) rel = 1;
          else if (so > sf * 1.3 && so >= REL_MIN) rel = 0;
          else continue;
          known = true;
          const w = Math.max(so, sf);
          if ((o[j] ^ rel) === 1) wOpp += w; else wSame += w;
        }
        if (known) o[i] = wOpp > wSame ? 1 : 0;
        else { o[i] = o[i - 1]; unknown[i] = true; }
      }
      onProgress && onProgress(n + i + 1, total);
      await yieldToUI();
    }
    // 많은 쪽을 정방향으로 삼는다(같으면 그대로 둔다).
    let ones = 0;
    for (let i = 0; i < n; i++) if (o[i] === 1) ones++;
    if (ones > n / 2) for (let i = 0; i < n; i++) o[i] ^= 1;

    const out = [];
    for (let i = 0; i < n; i++) {
      const flip = o[i] === 1;
      out.push({ flip, warn: flip ? 'flip' : (unknown[i] ? 'other' : null), so: soSum[i], sf: sfSum[i] });
    }
    return out;
  } finally {
    F.forEach(f => f.delete()); FF.forEach(f => f.delete());
    small.forEach(s => { if (s.owned) s.m.delete(); });
  }
}
