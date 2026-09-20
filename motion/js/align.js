import { detect, pairTransform, sane, compose, invert, identity, apply } from './features.js';

function mat23(cv, M, type = cv.CV_64F) { return cv.matFromArray(2, 3, type, Array.from(M)); }
// 주의: m.data64F는 Mat의 실제 타입과 무관하게 항상 값을 반환하는 getter이므로(존재 자체는 falsy가
// 아님), `m.data64F || m.data32F`로는 CV_32F 행렬을 절대 골라내지 못하고 바이트를 잘못 해석해
// NaN/쓰레기 값을 만든다. Mat의 실제 타입을 보고 뷰를 선택해야 한다.
function fromMat23(cv, m) { const d = m.type() === cv.CV_64F ? m.data64F : m.data32F; return new Float64Array([d[0], d[1], d[2], d[3], d[4], d[5]]); }

function small(cv, g, workW) {
  const s = workW / g.cols; const out = new cv.Mat();
  cv.resize(g, out, new cv.Size(Math.round(g.cols * s), Math.round(g.rows * s)), 0, 0, cv.INTER_AREA);
  const b = new cv.Mat(); cv.GaussianBlur(out, b, new cv.Size(5, 5), 0); out.delete();
  return { m: b, s };
}
function scaleM(M, s) { const R = Float64Array.from(M); R[2] *= s; R[5] *= s; return R; }

// ECC 공통: template=ga, input=gb, 초기 warp = (gb→ga 변환 M)의 역을 작업 해상도로
function runEcc(cv, ga, gb, M, motion, workW, mask) {
  const A = small(cv, ga, workW), B = small(cv, gb, workW);
  const init = scaleM(invert(M), A.s);
  const warp = mat23(cv, init, cv.CV_32F);
  const EPS = cv.TermCriteria_EPS !== undefined ? cv.TermCriteria_EPS : 2;
  const COUNT = cv.TermCriteria_COUNT !== undefined ? cv.TermCriteria_COUNT : 1;
  const crit = new cv.TermCriteria(EPS | COUNT, motion === cv.MOTION_EUCLIDEAN ? 200 : 100, 1e-6);
  let ok = false;
  let maskMat = mask ? mask(A.m.cols, A.m.rows) : new cv.Mat();
  try { cv.findTransformECC(A.m, B.m, warp, motion, crit, maskMat, 5); ok = true; } catch (e) { ok = false; }
  let R = null;
  if (ok) { R = scaleM(invert(fromMat23(cv, warp)), 1 / A.s); }
  const ctx = { A, B, maskMat };
  warp.delete();
  return { R, ctx };
}
function ncc(cv, ctx, M) {
  const { A, B, maskMat } = ctx;
  const w = mat23(cv, scaleM(M, A.s)); const wb = new cv.Mat();
  cv.warpAffine(B.m, wb, w, new cv.Size(A.m.cols, A.m.rows), cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
  let sx = 0, sy = 0, n = 0; const a = A.m.data, b = wb.data, mk = maskMat.rows ? maskMat.data : null;
  for (let i = 0; i < a.length; i++) if (!mk || mk[i]) { sx += a[i]; sy += b[i]; n++; }
  const mx = sx / n, my = sy / n; let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < a.length; i++) if (!mk || mk[i]) { const u = a[i] - mx, v = b[i] - my; sxy += u * v; sxx += u * u; syy += v * v; }
  w.delete(); wb.delete();
  return sxy / (Math.sqrt(sxx * syy) + 1e-6);
}
function freeCtx(ctx) { ctx.A.m.delete(); ctx.B.m.delete(); ctx.maskMat.delete(); }

function zerosMat(cv, h, w, type) {
  if (cv.Mat.zeros) { try { return cv.Mat.zeros(h, w, type); } catch (e) { /* fall through */ } }
  return new cv.Mat(h, w, type, new cv.Scalar(0));
}

export function eccEuclid(cv, ga, gb, W) {
  const { R, ctx } = runEcc(cv, ga, gb, identity(), cv.MOTION_EUCLIDEAN, 600, null);
  freeCtx(ctx);
  return R && sane(R, W) ? R : null;
}

export function eccRefine(cv, ga, gb, M) {
  const mask = (w, h) => { const m = zerosMat(cv, h, w, cv.CV_8UC1); cv.rectangle(m, new cv.Point(Math.round(w * 0.12), Math.round(h * 0.05)), new cv.Point(Math.round(w * 0.88), Math.round(h * 0.95)), new cv.Scalar(255), -1); return m; };
  const { R, ctx } = runEcc(cv, ga, gb, M, cv.MOTION_AFFINE, 800, mask);
  let out = M;
  if (R && sane(R, ga.cols)) { if (ncc(cv, ctx, R) > ncc(cv, ctx, M)) out = R; }
  freeCtx(ctx);
  return out;
}

export function medianFrame(T, W, H) {
  const med = arr => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const sc = med(T.map(t => Math.hypot(t[0], t[3])));
  const ang = med(T.map(t => Math.atan2(t[3], t[0])));
  const cs = T.map(t => apply(t, W / 2, H / 2));
  const cx = med(cs.map(c => c[0])), cy = med(cs.map(c => c[1]));
  const a = sc * Math.cos(ang), b = sc * Math.sin(ang);
  return new Float64Array([a, -b, cx - (a * W / 2 - b * H / 2), b, a, cy - (b * W / 2 + a * H / 2)]);
}

function yieldToUI() { return new Promise(r => setTimeout(r, 0)); }

// ORB 특징점 추출(detect)도 사진마다 수백 ms 걸리는데, 예전에는 grays.map(detect)으로
// n장을 한 번에 몰아서 계산해 그 시간 내내 화면이 멈춘 것처럼 보였다. ECC 정합(runEcc)도
// 사진 한 장마다 수백 ms씩 걸릴 수 있어, 25장 넘게 돌리면 메인 스레드가 오래 막힌다.
// 그래서 (1) 특징점 추출, (2) 이웃과 이어붙이기 두 단계 모두 사진 한 장 끝낼 때마다
// onProgress로 알리고 setTimeout(0)으로 한 틱 양보해 진행 화면이 실제로 갱신되게 한다.
// onProgress는 총 2n번(추출 n장 + 이어붙이기 n-1장) 불린다.
// isCancelled()가 true면 그 양보 지점에서 Error('취소')를 던진다 — 25장 정합은 몇 분씩
// 걸리는데 예전에는 다 끝난 뒤에야 취소를 확인해서 취소 버튼이 사실상 듣지 않았다.
// 던진 예외는 아래 finally가 받아 F(특징점 Mat)를 전부 풀어 준다.
export async function chainTransforms(cv, grays, W, H, onProgress, isCancelled) {
  const n = grays.length;
  const stop = () => { if (isCancelled && isCancelled()) throw new Error('취소'); };
  const F = [];
  // detect/pairTransform/eccRefine 어디서 터지든 그때까지 만든 Feat Mat이 새지 않게
  // try/finally로 감싼다(사진 한 장당 6000×32바이트짜리 기술자 행렬이다).
  try {
    for (let i = 0; i < n; i++) {
      F.push(detect(cv, grays[i]));
      onProgress && onProgress(i + 1, 2 * n);
      await yieldToUI();
      stop();
    }
    const T = [identity()]; const status = ['ok'];
    for (let i = 1; i < n; i++) {
      let best = null, bj = i - 1;
      for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
        const r = pairTransform(cv, F[j], F[i], W);
        if (r && (!best || r.k > best.k)) { best = r; bj = j; }
      }
      let M, st;
      if (best) { M = eccRefine(cv, grays[bj], grays[i], best.M); st = 'ok'; }
      else { const e = eccEuclid(cv, grays[i - 1], grays[i], W); bj = i - 1; if (e) { M = e; st = 'ecc'; } else { M = identity(); st = 'fail'; } }
      T.push(compose(T[bj], M)); status.push(st);
      onProgress && onProgress(n + i + 1, 2 * n);
      await yieldToUI();
      stop();
    }
    const inv = invert(medianFrame(T, W, H));
    return { T: T.map(t => compose(inv, t)), status };
  } finally {
    F.forEach(f => f.delete());
  }
}

export function alignedSize(W, H, margin = 0.05) {
  const x0 = Math.floor(W * margin), y0 = Math.floor(H * margin);
  const cw = (W - 2 * x0) - ((W - 2 * x0) % 2), ch = (H - 2 * y0) - ((H - 2 * y0) % 2);
  return { cw, ch };
}

export function warpImage(cv, image, M, W, H, margin = 0.05) {
  const src = cv.matFromImageData(image); const dst = new cv.Mat();
  const m = mat23(cv, M);
  cv.warpAffine(src, dst, m, new cv.Size(W, H), cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
  const { cw, ch } = alignedSize(W, H, margin);
  const x0 = Math.floor(W * margin), y0 = Math.floor(H * margin);
  const roi = dst.roi(new cv.Rect(x0, y0, cw, ch)); const cont = new cv.Mat(); roi.copyTo(cont);
  const data = new Uint8ClampedArray(cont.data);
  src.delete(); dst.delete(); m.delete(); roi.delete(); cont.delete();
  return typeof ImageData === 'function' ? new ImageData(data, cw, ch) : { width: cw, height: ch, data };
}
