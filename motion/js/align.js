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
    let T2 = T.map(t => compose(inv, t));
    // ── 세로·가로 안전 이동(2026-09-22 설계) ──────────────────────────
    // median frame으로 재기준하면, 치열궁이 자기 프레임 안에서 아래쪽으로 치우쳐
    // 찍힌 사진은 위로 밀려 올라가 원래 윗변(자기 프레임의 y=0)이 캔버스 밖(y<0)으로
    // 나가버린다 → 그 위의 앞니 끝이 잘린다. 사진 i의 윗변이 재기준 뒤 어디로
    // 가는지(apply(T[i], W/2, 0)[1])를 모두 구해, 가장 많이 밖으로 나간 사진 기준으로
    // 전체 사진을 같은 양만큼 아래로 민다(개별 사진만 밀면 사진끼리 상대 위치가
    // 어긋난다). 위쪽으로 잘리는 대신 아래쪽(아랫니·혀)이 양보하게 하는 것이 목적이라
    // 이동량은 H의 4%로 위로 제한한다. 25장 실사진 측정: 기존 12%/10% 설정이 평균
    // ~160px을 하단에서 자르므로, 4%/4%로 변경하면 상단을 ~4px 이내로 유지하면서도
    // 하단 손실을 예전 수준으로 돌릴 수 있다.
    // 가로도 같은 논리로, 다만 좌우는 공평하게 6%까지만 허용한다.
    const topYs = T2.map(t => apply(t, W / 2, 0)[1]);
    const minTop = Math.min(...topYs);
    const dy = minTop < 0 ? Math.min(-minTop, 0.04 * H) : 0;
    const leftXs = T2.map(t => apply(t, 0, H / 2)[0]);
    const minLeft = Math.min(...leftXs);
    const dx = minLeft < 0 ? Math.min(-minLeft, 0.06 * W) : 0;
    if (dy || dx) {
      const shift = new Float64Array([1, 0, dx, 0, 1, dy]);
      T2 = T2.map(t => compose(shift, t));
    }
    return { T: T2, status };
  } finally {
    F.forEach(f => f.delete());
  }
}

// ── 이웃 겹침 점수(각도 검사) ─────────────────────────────────
// 구도를 맞춘(warpImage를 거친) 사진들을 받아, 각 사진이 앞뒤 이웃과 얼마나 잘 겹치는지를
// 0~1 점수로 돌려준다. 각도가 크게 다른 사진은 구도를 맞춰도 이웃과 어긋나서 점수가 낮다.
// 정의는 맥 파이썬 실험과 같다(2026-09-22 설계 §2):
//   640×427로 줄이고(INTER_AREA) 7×7 블러 → 가장자리(위아래 60·좌우 80px)를 잘라내고
//   → z-정규화(평균 0, 표준편차 1) → 이웃과 화소별 곱의 평균(= 정규화 상관).
// 가장자리를 버리는 이유: 구도를 맞출 때 테두리가 복제되어(BORDER_REPLICATE) 사진마다
// 다른 얼룩이 생기는데, 그 얼룩이 점수를 크게 흔든다.
const SCORE_W = 640, SCORE_H = 427, SCORE_CROP_Y = 60, SCORE_CROP_X = 80;

// 줄이기·블러·흑백 변환만 cv.Mat으로 하고, 통계와 곱셈은 순수 JS로 한다(작은 배열이라
// Mat 연산보다 빠르고, Mat이 오래 살아 있지 않아 메모리도 안전하다).
function scoreVector(cv, image) {
  const src = cv.matFromImageData(image);
  const gray = new cv.Mat(), small = new cv.Mat(), blur = new cv.Mat();
  let roi = null, cont = null;
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.resize(gray, small, new cv.Size(SCORE_W, SCORE_H), 0, 0, cv.INTER_AREA);
    cv.GaussianBlur(small, blur, new cv.Size(7, 7), 0);
    roi = blur.roi(new cv.Rect(SCORE_CROP_X, SCORE_CROP_Y, SCORE_W - 2 * SCORE_CROP_X, SCORE_H - 2 * SCORE_CROP_Y));
    cont = new cv.Mat(); roi.copyTo(cont);
    const d = cont.data, n = d.length, v = new Float32Array(n);
    let s = 0;
    for (let i = 0; i < n; i++) s += d[i];
    const m = s / n;
    let ss = 0;
    for (let i = 0; i < n; i++) { const u = d[i] - m; v[i] = u; ss += u * u; }
    // 완전히 단색인 사진(표준편차 0)에서 0으로 나누지 않도록 막는다.
    const sd = Math.sqrt(ss / n) || 1;
    for (let i = 0; i < n; i++) v[i] /= sd;
    return v;
  } finally {
    src.delete(); gray.delete(); small.delete(); blur.delete();
    if (roi) roi.delete(); if (cont) cont.delete();
  }
}

// 사진 한 장을 줄이고 흐리는 데만 수십 ms가 걸려, 40장이면 화면이 통째로 멈춘 것처럼
// 보인다. chainTransforms와 같은 방식으로 한 장마다 진행을 알리고 한 틱 양보한다.
// onProgress는 총 n번 불린다. isCancelled()가 true면 Error('취소')를 던진다.
export async function neighborScores(cv, images, onProgress, isCancelled) {
  const n = images.length;
  const stop = () => { if (isCancelled && isCancelled()) throw new Error('취소'); };
  const V = [];
  for (let i = 0; i < n; i++) {
    V.push(scoreVector(cv, images[i]));
    onProgress && onProgress(i + 1, n);
    await yieldToUI();
    stop();
  }
  // pair[i] = 사진 i와 i+1의 겹침 점수
  const pair = [];
  for (let i = 0; i + 1 < n; i++) {
    const a = V[i], b = V[i + 1];
    let s = 0;
    for (let k = 0; k < a.length; k++) s += a[k] * b[k];
    pair.push(s / a.length);
  }
  // 사진 한 장의 점수 = 있는 쪽 이웃(앞·뒤) 점수의 평균. 양 끝은 한쪽만,
  // 사진이 2장이면 둘 다 같은 점수가 된다(설계 §2).
  return V.map((_, i) => {
    let s = 0, c = 0;
    if (i > 0) { s += pair[i - 1]; c++; }
    if (i + 1 < n) { s += pair[i]; c++; }
    return c ? s / c : 1;
  });
}

// 잘라내는 여백은 네 변이 다르다(2026-09-22 설계). chainTransforms의 세로 안전
// 이동은 "위가 잘리는 대신 아래(아랫니·혀)가 양보"하게 만드므로, 크롭 여백도
// 위는 0%로 두고 아래를 4% 잘라 그 양보분을 흡수한다. 좌우는 원래대로 5%씩
// 공평하게. margin은 { top, bottom, left, right } 객체이고, 숫자 하나를 주면
// (예전 방식과 호환) 네 변 모두 그 값으로 취급한다.
const DEFAULT_MARGIN = { top: 0, bottom: 0.04, left: 0.05, right: 0.05 };
function normMargin(margin) {
  if (margin === undefined) return DEFAULT_MARGIN;
  if (typeof margin === 'number') return { top: margin, bottom: margin, left: margin, right: margin };
  return { ...DEFAULT_MARGIN, ...margin };
}

// 잘라낸 크기는 16의 배수로 내림한다. RIFE는 내부에서 화면을 여러 번 반으로 줄이므로
// 가로·세로가 16으로 나눠떨어지지 않으면 추론이 실패하거나 가장자리가 어긋난다
// (예전에는 짝수만 보장해서 1280×854 → 770처럼 16의 배수가 아닌 높이가 나왔다).
// H.264 인코더에도 16의 배수가 가장 안전하다.
export function alignedSize(W, H, margin) {
  const m = normMargin(margin);
  const x0 = Math.floor(W * m.left), x1 = Math.floor(W * m.right);
  const y0 = Math.floor(H * m.top), y1 = Math.floor(H * m.bottom);
  const unit = 16;
  const cw = Math.max(unit, (W - x0 - x1) - ((W - x0 - x1) % unit));
  const ch = Math.max(unit, (H - y0 - y1) - ((H - y0 - y1) % unit));
  return { cw, ch };
}

// 잘라낼 창을 기준 틀(W×H) 좌표로 돌려준다 — warpImage가 실제로 오려 내는 바로 그
// 사각형이다. 수동 맞춤 화면이 이 사각형을 점선으로 그려, 영상에 들어갈 범위를
// 눈으로 확인하게 한다 (수동 맞춤 설계 §2).
export function cropRect(W, H, margin) {
  const m = normMargin(margin);
  const { cw, ch } = alignedSize(W, H, m);
  return { x0: Math.floor(W * m.left), y0: Math.floor(H * m.top), cw, ch };
}

// ── 수동 맞춤 보정 행렬 ───────────────────────────────────────
// 자동 구도 맞추기(T) 위에 덧붙는 손 보정이다. 기준 틀 한가운데(W/2, H/2)를 축으로
// 배율·회전을 주고, 그 뒤에 (dx, dy)만큼 옮긴다 (수동 맞춤 설계 §1).
//   M = translate(dx,dy) ∘ translate(cx,cy) ∘ rotate(rotation) ∘ scale(scale) ∘ translate(−cx,−cy)
// 가운데를 축으로 삼는 이유: 크기·회전을 건드려도 사진이 화면 밖으로 달아나지 않아야
// 원장이 슬라이더를 끝까지 밀어 봐도 길을 잃지 않는다.
export const DEFAULT_ADJUST = { scale: 1, rotation: 0, dx: 0, dy: 0 };
export function adjustMatrix(adj, W, H) {
  const a = adj || DEFAULT_ADJUST;
  const s = a.scale === undefined ? 1 : a.scale;
  const r = (a.rotation || 0) * Math.PI / 180;
  const dx = a.dx || 0, dy = a.dy || 0;
  const cx = W / 2, cy = H / 2;
  const co = Math.cos(r) * s, si = Math.sin(r) * s;
  return new Float64Array([
    co, -si, cx + dx - (co * cx - si * cy),
    si, co, cy + dy - (si * cx + co * cy),
  ]);
}

export function warpImage(cv, image, M, W, H, margin) {
  const src = cv.matFromImageData(image); const dst = new cv.Mat();
  const m = mat23(cv, M);
  cv.warpAffine(src, dst, m, new cv.Size(W, H), cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
  const mg = normMargin(margin);
  const { cw, ch } = alignedSize(W, H, mg);
  const x0 = Math.floor(W * mg.left), y0 = Math.floor(H * mg.top);
  const roi = dst.roi(new cv.Rect(x0, y0, cw, ch)); const cont = new cv.Mat(); roi.copyTo(cont);
  const data = new Uint8ClampedArray(cont.data);
  src.delete(); dst.delete(); m.delete(); roi.delete(); cont.delete();
  return typeof ImageData === 'function' ? new ImageData(data, cw, ch) : { width: cw, height: ch, data };
}
