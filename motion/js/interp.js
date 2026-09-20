export function planTiming(stepSec) {
  const N = Math.min(64, 2 ** Math.ceil(Math.log2(30 * stepSec)));
  return { N, fps: Math.min(60, N / stepSec) };
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
  constructor(ort, sess) { this.ort = ort; this.sess = sess; }
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
export async function transition(a, b, w, h, N, aiLevels, rife, emit, isCancelled) {
  const total = Math.log2(N);
  async function gen(x, y, depth, ai) {
    if (isCancelled()) return;
    if (depth === 0) { await emit(x); return; }
    const m = (ai > 0 && rife) ? await rife.mid(x, y, w, h) : blend(x, y, 0.5);
    await gen(x, m, depth - 1, ai - 1);
    await gen(m, y, depth - 1, ai - 1);
  }
  await gen(a, b, total, rife ? aiLevels : 0);
}
