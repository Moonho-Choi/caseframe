export function planTiming(stepSec) {
  const N = Math.min(64, 2 ** Math.ceil(Math.log2(30 * stepSec)));
  // fps는 정수여야 한다 — mp4-muxer/VideoEncoder가 정수가 아닌 frameRate를 거부한다
  // ("Invalid video frame rate ... Must be a positive integer.").
  return { N, fps: Math.min(60, Math.round(N / stepSec)) };
}
export function imageToCHW(img) {
  const { width: w, height: h, data } = img; const n = w * h; const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) { out[i] = data[4 * i] / 255; out[n + i] = data[4 * i + 1] / 255; out[2 * n + i] = data[4 * i + 2] / 255; }
  return out;
}
export function chwToImage(chw, w, h) {
  const n = w * h; const d = new Uint8ClampedArray(4 * n);
  // Uint8ClampedArray 대입 자체가 최근접·짝수 반올림을 적용하므로 +0.5를 더하지 않는다.
  // (imageToCHW가 float32로 저장하며 생기는 근사 오차 때문에 +0.5를 더하면 128 같은 정확한
  // 경계값이 129로 밀려 올라가는 왕복 오차가 생긴다.)
  for (let i = 0; i < n; i++) { d[4 * i] = chw[i] * 255; d[4 * i + 1] = chw[n + i] * 255; d[4 * i + 2] = chw[2 * n + i] * 255; d[4 * i + 3] = 255; }
  return typeof ImageData === 'function' ? new ImageData(d, w, h) : { width: w, height: h, data: d };
}
export function blend(a, b, t) { const o = new Float32Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] + (b[i] - a[i]) * t; return o; }

export class Rife {
  static async create(ort, modelUrl) {
    if (typeof navigator === 'undefined' || !navigator.gpu) return null;
    try {
      const sess = await ort.InferenceSession.create(modelUrl, { executionProviders: ['webgpu'] });
      return new Rife(ort, sess);
    } catch (e) { console.warn('RIFE 로드 실패', e); return null; }
  }
  constructor(ort, sess) { this.ort = ort; this.sess = sess; this.failed = false; }
  async mid(a, b, w, h) {
    const input = new Float32Array(a.length * 2); input.set(a, 0); input.set(b, a.length);
    const r = await this.sess.run({ input: new this.ort.Tensor('float32', input, [1, 6, h, w]) });
    const out = r.output.data;
    return out instanceof Float32Array ? out : Float32Array.from(out);
  }
  release() { this.sess.release && this.sess.release(); }
}

export function aiLevelsFor(quality, N) { return quality === 'high' ? Math.log2(N) : quality === 'fast' ? Math.min(2, Math.log2(N)) : 0; }

// a에서 b 직전까지 N장을 시간 순으로 emit. levels = 남은 분할 단계, aiLevels = 그중 AI로 할 단계 수
// 추론이 한 번이라도 실패하면(GPU 메모리 부족 등) rife.failed를 세워 두고 그 뒤로는
// 단순 겹치기로 계속 간다 — 몇 분 기다린 끝에 "오류:"만 남기느니, 조금 무른 영상이라도
// 끝까지 나오는 편이 낫다. 경고는 한 번만 적는다.
export async function transition(a, b, w, h, N, aiLevels, rife, emit, isCancelled) {
  const total = Math.log2(N);
  const usable = () => rife && !rife.failed;
  async function gen(x, y, depth, ai) {
    if (isCancelled()) return;
    if (depth === 0) { await emit(x); return; }
    let m = null;
    if (ai > 0 && usable()) {
      try { m = await rife.mid(x, y, w, h); }
      catch (e) { rife.failed = true; console.warn('RIFE 추론 실패 — 남은 구간은 단순 겹치기로 만듭니다', e); m = null; }
    }
    if (!m) m = blend(x, y, 0.5);
    await gen(x, m, depth - 1, ai - 1);
    await gen(m, y, depth - 1, ai - 1);
  }
  await gen(a, b, total, usable() ? aiLevels : 0);
}
