# 교정 진행 영상 도구 (caseframe.kr/motion) 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 같은 방향 교정 사진 묶음을 브라우저 안에서 구도 맞추기 → 인공지능 중간 그림 → MP4로 만드는 정적 웹 도구를 caseframe.kr/motion 에 추가한다.

**Architecture:** 부품 6개(load, orient, align, color, interp, encode)를 각각 ES 모듈로 두고 `main.js`가 순서대로 부른다. 사진 데이터는 부품 사이를 `ImageData`(RGBA, 같은 크기)로 오간다. OpenCV·ONNX 런타임은 인자로 주입해 Node 시험과 브라우저 실행에서 같은 코드를 쓴다. 인공지능 중간 그림은 한 쌍씩 만들어 곧바로 인코더에 넘겨 메모리를 아낀다.

**Tech Stack:** 순수 JS(ES 모듈, 빌드 도구 없음), opencv.js 4.x(ORB·BFMatcher·findTransformECC·warpAffine·CLAHE), onnxruntime-web 1.22 WebGPU + RIFE ONNX(입력 `[1,6,H,W]`, 출력 중간 프레임 `[1,3,H,W]`, 값 0~1), WebCodecs VideoEncoder(H.264) + mp4-muxer, Node 22 `node:test`로 부품 시험.

## Global Constraints

- 사진은 사용자 컴퓨터 밖으로 나가지 않는다. 네트워크 요청은 정적 파일(코드·모델)뿐이다.
- 서버·로그인·저장 없음. GitHub Pages 정적 파일만.
- 지원 브라우저: 크롬·엣지(WebGPU+WebCodecs). 그 외는 단순 겹치기 + WebM 저장으로 자동 전환.
- 한 번에 최대 40장. 가로 1280(짝수)으로 통일. 첫 사진 비율 기준.
- 사진 정렬 키: 파일 이름의 첫 `20\d{6}`, 없으면 파일 이름.
- 구도 맞추기 규칙(스펙 §5.3): 유사변환, 건전성(배율 0.6~1.6, 회전 20° 미만, 이동 가로 50% 미만), 앞의 최대 3장과 비교, ECC 유클리드 예비, ECC 아핀 미세 조정(마스크 세로 5~95%·가로 12~88%, 정규화 상관이 높은 쪽 채택), 중간 구도 기준 틀, 가장자리 5% 잘라내기, BORDER_REPLICATE.
- 방향 검사 규칙(§5.2): 뒤집은 쪽 점수 > 원본 × 1.3 이고 ≥ 15 → 반전. 두 쪽 모두 < 8 → "다른 방향" 경고.
- 인공지능 모델은 중간(t=0.5)만 만든다. 한 단계는 N=2^k 구간으로 나누고(`N = 2^ceil(log2(30·초))`, 최대 64), fps = N/초, 최대 60.
- 품질 모드: 고품질 = 모든 구간 인공지능. 빠르게 = 4구간만 인공지능, 나머지는 선형 겹치기. 없음(전환) = 전부 선형 겹치기.
- 글씨: 왼쪽 위 반투명 검은 띠 + 흰 글씨. "시작" / "N개월" / "N년" / "N년 M개월". 날짜 없는 사진이 하나라도 있으면 글씨 자동 끄기.
- 파일 이름: 첫 사진 이름을 `_`로 나눈 첫 토막 + `_교정진행.mp4` (WebM이면 `.webm`).
- 마지막 사진 1초 정지.
- 커밋 메시지는 한국어, 끝에 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- 푸시는 하지 않는다(원장이 GitHub Desktop으로).

## 파일 구조

```
caseframe/
  motion/
    index.html            화면. 부품 호출 순서와 상태 표시만.
    js/main.js            화면 이벤트 ↔ 부품 연결, 진행·취소
    js/load.js            파일 읽기, 날짜 추출, 정렬, 크기 통일, 글씨 문구
    js/features.js        회색 변환+CLAHE, ORB 특징점, 매칭, 유사변환 RANSAC, 건전성
    js/orient.js          좌우 반전 판정
    js/align.js           변환 사슬, ECC 예비·미세 조정, 중간 구도, 워핑
    js/color.js           LAB 밝기·색 맞추기
    js/interp.js          RIFE 실행, 이진 분할 중간 그림, 선형 겹치기
    js/encode.js          글씨 얹기, MP4(WebCodecs+mp4-muxer) / WebM 예비
    models/rife_fp32.onnx 21.6MB (huggingface FuryTMP/RIFE_fp32, MIT)
    test/*.test.mjs       node:test 부품 시험
    test/browser.html     브라우저 수동 확인 페이지(interp, encode)
  vendor/
    opencv.js             (docs.opencv.org 4.x, Apache-2.0, 11MB)
    ort/ort.webgpu.min.mjs, ort/ort-wasm-simd-threaded.jsep.mjs, ort/ort-wasm-simd-threaded.jsep.wasm  (onnxruntime-web 1.22.0, MIT)
    mp4-muxer.mjs         (mp4-muxer 5.x, MIT)
```

부품 간 자료형(모든 부품 공통):
- `Item = { name: string, date: Date|null, image: ImageData }` — image는 모두 같은 `W×H`.
- 변환 `M`은 `Float64Array(6)` = `[a, b, tx, c, d, ty]` (2×3 행 우선). 유사변환이면 `a=d, b=-c`.
- 회색 특징 `Feat = { pts: Float32Array(2n), des: cv.Mat(CV_8U n×32), n: number, delete(): void }`.

시험 실행: `cd caseframe && node --test motion/test/` (opencv.js는 `vendor/opencv.js`를 `require`로 읽는다. 초기화는 `await cvReady()`).

---

### Task 1: 외부 파일 vendor 넣기 + 시험 뼈대

**Files:**
- Create: `vendor/opencv.js`, `vendor/ort/*`, `vendor/mp4-muxer.mjs`, `motion/models/rife_fp32.onnx`
- Create: `motion/test/_cv.mjs` (Node에서 opencv.js 로드 도우미)
- Create: `motion/test/smoke.test.mjs`

**Interfaces:**
- Produces: `cvReady(): Promise<cv>` — Node 시험에서 opencv.js를 읽어 초기화된 `cv`를 돌려준다.

- [ ] **Step 1: 원장 허락 후 파일 내려받기** (이미 임시 폴더에 받아 둔 것은 복사)

```bash
cd /Users/eumtmj/Documents/이음랩/caseframe
mkdir -p vendor/ort motion/models motion/js motion/test
cp /private/tmp/claude-501/-Users-eumtmj/ceed8494-7b0f-4326-ba76-eb41c7e60194/scratchpad/spike/opencv.js vendor/opencv.js
cp /private/tmp/claude-501/-Users-eumtmj/ceed8494-7b0f-4326-ba76-eb41c7e60194/scratchpad/spike/RIFE_fp32.onnx motion/models/rife_fp32.onnx
B=https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist
curl -sL -o vendor/ort/ort.webgpu.min.mjs $B/ort.webgpu.min.mjs
curl -sL -o vendor/ort/ort-wasm-simd-threaded.jsep.mjs $B/ort-wasm-simd-threaded.jsep.mjs
curl -sL -o vendor/ort/ort-wasm-simd-threaded.jsep.wasm $B/ort-wasm-simd-threaded.jsep.wasm
curl -sL -o vendor/mp4-muxer.mjs https://cdn.jsdelivr.net/npm/mp4-muxer@5/build/mp4-muxer.mjs
ls -la vendor/ort vendor/mp4-muxer.mjs motion/models
```
확인: `vendor/ort/*.wasm`이 5MB 이상, `mp4-muxer.mjs`가 `export`를 포함(`grep -c "export" vendor/mp4-muxer.mjs`가 0이 아님). 실패하면 `https://unpkg.com/mp4-muxer@5/build/mp4-muxer.mjs`로 재시도.

- [ ] **Step 2: Node 로드 도우미 작성**

`motion/test/_cv.mjs`:
```js
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let cvPromise = null;
export function cvReady() {
  if (!cvPromise) cvPromise = new Promise((resolve) => {
    const cv = require('../../vendor/opencv.js');
    const tick = () => (cv.Mat ? resolve(cv) : setTimeout(tick, 100));
    tick();
  });
  return cvPromise;
}
```

- [ ] **Step 3: 시험 뼈대 작성 후 실행**

`motion/test/smoke.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cvReady } from './_cv.mjs';

test('opencv.js loads with ORB, BFMatcher, findTransformECC, CLAHE', async () => {
  const cv = await cvReady();
  for (const n of ['ORB', 'BFMatcher', 'findTransformECC', 'CLAHE', 'warpAffine', 'estimateAffine2D'])
    assert.equal(typeof cv[n], 'function', n);
});
```
Run: `cd /Users/eumtmj/Documents/이음랩/caseframe && node --test motion/test/`
Expected: 1 pass. (opencv.js 초기화에 5~8초 걸림.)

- [ ] **Step 4: 커밋**

```bash
git add vendor motion/models motion/test
git commit -m "motion: 외부 라이브러리·모델 vendor 추가, Node 시험 뼈대

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: load.js — 날짜 추출, 정렬, 글씨 문구

**Files:**
- Create: `motion/js/load.js`
- Test: `motion/test/load.test.mjs`

**Interfaces:**
- Produces:
  - `parseDate(name: string): Date|null` — 첫 `20\d{6}`을 YYYYMMDD로. 잘못된 날짜(13월 등)는 null.
  - `sortItems(items: {name, date}[]): items` — date 있는 것끼리 date 순, 없으면 name 순(로케일 무시 코드포인트).
  - `monthsLabel(d0: Date, d: Date): string` — "시작"/"N개월"/"N년"/"N년 M개월".
  - `baseName(name: string): string` — `_` 앞 첫 토막(확장자 제외).
  - `loadFiles(files: File[], width=1280): Promise<Item[]>` — 브라우저 전용. 첫 사진 비율로 `W×H` 통일(짝수), 검은 여백, HEIC/읽기 실패는 `{skipped: [names]}`로 함께 돌려준다: 반환값 `{ items, skipped }`.

- [ ] **Step 1: 실패하는 시험 작성**

`motion/test/load.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDate, sortItems, monthsLabel, baseName } from '../js/load.js';

test('parseDate finds YYYYMMDD', () => {
  assert.deepEqual(parseDate('임희진_20230724_143958.jpg'), new Date(2023, 6, 24));
  assert.equal(parseDate('photo.jpg'), null);
  assert.equal(parseDate('x_20231301.jpg'), null);
});
test('sortItems by date then name', () => {
  const s = sortItems([{ name: 'b', date: null }, { name: 'a_20230101.jpg', date: new Date(2023, 0, 1) }, { name: 'a_20220101.jpg', date: new Date(2022, 0, 1) }, { name: 'a', date: null }]);
  assert.deepEqual(s.map(i => i.name), ['a_20220101.jpg', 'a_20230101.jpg', 'a', 'b']);
});
test('monthsLabel', () => {
  const d0 = new Date(2022, 10, 28);
  assert.equal(monthsLabel(d0, d0), '시작');
  assert.equal(monthsLabel(d0, new Date(2022, 11, 20)), '시작');       // 30일 미만
  assert.equal(monthsLabel(d0, new Date(2023, 1, 6)), '2개월');
  assert.equal(monthsLabel(d0, new Date(2023, 10, 28)), '1년');
  assert.equal(monthsLabel(d0, new Date(2024, 1, 19)), '1년 2개월');
});
test('baseName', () => {
  assert.equal(baseName('임희진_20230724_143958.jpg'), '임희진');
  assert.equal(baseName('IMG_0001.JPG'), 'IMG');
  assert.equal(baseName('photo.png'), 'photo');
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test motion/test/load.test.mjs`
Expected: FAIL (module not found).

- [ ] **Step 3: 구현**

`motion/js/load.js`:
```js
export function parseDate(name) {
  const m = /20\d{6}/.exec(name);
  if (!m) return null;
  const y = +m[0].slice(0, 4), mo = +m[0].slice(4, 6), d = +m[0].slice(6, 8);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(y, mo - 1, d);
  return dt.getMonth() === mo - 1 ? dt : null;
}

export function sortItems(items) {
  return [...items].sort((a, b) => {
    if (a.date && b.date) return a.date - b.date;
    if (a.date) return -1;
    if (b.date) return 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

export function monthsLabel(d0, d) {
  let months = (d.getFullYear() - d0.getFullYear()) * 12 + (d.getMonth() - d0.getMonth());
  if (d.getDate() < d0.getDate()) months -= 1;
  if (months <= 0) return '시작';
  const y = Math.floor(months / 12), m = months % 12;
  if (y === 0) return `${m}개월`;
  return m === 0 ? `${y}년` : `${y}년 ${m}개월`;
}

export function baseName(name) {
  return name.replace(/\.[^.]+$/, '').split('_')[0];
}

async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(file); } catch (e) { /* HEIC 등 */ }
  }
  return null;
}

export async function loadFiles(files, width = 1280) {
  const items = [], skipped = [];
  let W = width - (width % 2), H = 0;
  for (const f of files) {
    const bmp = await decode(f);
    if (!bmp) { skipped.push(f.name); continue; }
    if (!H) { H = Math.round(W * bmp.height / bmp.width); H -= H % 2; }
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    const s = Math.min(W / bmp.width, H / bmp.height);
    const dw = Math.round(bmp.width * s), dh = Math.round(bmp.height * s);
    ctx.drawImage(bmp, (W - dw) / 2, (H - dh) / 2, dw, dh);
    bmp.close && bmp.close();
    items.push({ name: f.name, date: parseDate(f.name), image: ctx.getImageData(0, 0, W, H) });
  }
  return { items: sortItems(items), skipped };
}
```

- [ ] **Step 4: 통과 확인**

Run: `node --test motion/test/load.test.mjs`
Expected: 4 pass.

- [ ] **Step 5: 커밋**

```bash
git add motion/js/load.js motion/test/load.test.mjs
git commit -m "motion: 사진 읽기·날짜 정렬·글씨 문구(load.js)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: features.js — 회색 변환, ORB, 매칭, 유사변환 RANSAC

**Files:**
- Create: `motion/js/features.js`
- Test: `motion/test/features.test.mjs`, `motion/test/_synth.mjs` (합성 사진 도우미)

**Interfaces:**
- Consumes: `cv` (opencv.js 객체)
- Produces:
  - `toGray(cv, image: ImageData): cv.Mat` — CV_8UC1, CLAHE(2.0, 8×8) 적용. 호출자가 `delete()`.
  - `detect(cv, gray: cv.Mat): Feat` — ORB(6000).
  - `pairTransform(cv, fa: Feat, fb: Feat, W: number): {M: Float64Array(6), k: number}|null` — b→a 유사변환. 비율 0.7, 0.8 시도, 내점 ≥ 8, 건전성 통과 중 내점 최다.
  - `sane(M, W): boolean`.
  - `similarityRansac(src: Float32Array(2n), dst: Float32Array(2n), thresh=10, iters=3000): {M, k}|null` — 순수 JS.
  - `compose(A: Float64Array(6), B): Float64Array(6)` — A∘B (먼저 B, 다음 A). `invert(M)`, `apply(M, x, y): [x', y']`.
  - `_synth.mjs`: `makeTexture(cv, W, H, seed): cv.Mat`(CV_8UC1 무작위 얼룩 텍스처), `warpGray(cv, gray, M): cv.Mat`.

- [ ] **Step 1: 합성 도우미와 실패하는 시험 작성**

`motion/test/_synth.mjs`:
```js
export function makeTexture(cv, W, H, seed = 1) {
  const m = new cv.Mat(H, W, cv.CV_8UC1);
  let s = seed >>> 0;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  m.data.fill(128);
  for (let i = 0; i < 400; i++) {
    const x = Math.floor(rnd() * W), y = Math.floor(rnd() * H), r = 4 + Math.floor(rnd() * 30), v = Math.floor(rnd() * 255);
    cv.circle(m, new cv.Point(x, y), r, new cv.Scalar(v), -1);
  }
  const blur = new cv.Mat(); cv.GaussianBlur(m, blur, new cv.Size(3, 3), 0); m.delete();
  return blur;
}
export function warpGray(cv, gray, M) {
  const mat = cv.matFromArray(2, 3, cv.CV_64F, Array.from(M));
  const out = new cv.Mat();
  cv.warpAffine(gray, out, mat, new cv.Size(gray.cols, gray.rows), cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
  mat.delete();
  return out;
}
export function similarity(scale, deg, tx, ty) {
  const a = scale * Math.cos(deg * Math.PI / 180), b = scale * Math.sin(deg * Math.PI / 180);
  return new Float64Array([a, -b, tx, b, a, ty]);
}
```

`motion/test/features.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cvReady } from './_cv.mjs';
import { makeTexture, warpGray, similarity } from './_synth.mjs';
import { detect, pairTransform, similarityRansac, sane, compose, invert, apply } from '../js/features.js';

test('similarityRansac recovers a known transform with outliers', () => {
  const M = similarity(1.1, 5, 30, -20);
  const src = [], dst = [];
  for (let i = 0; i < 60; i++) { const x = (i * 37) % 500, y = (i * 91) % 400; const [u, v] = apply(M, x, y); src.push(x, y); dst.push(u + (i % 7 === 0 ? 300 : 0), v); }
  const r = similarityRansac(Float32Array.from(src), Float32Array.from(dst), 3, 2000);
  assert.ok(r && r.k >= 50, 'inliers');
  for (let j = 0; j < 6; j++) assert.ok(Math.abs(r.M[j] - M[j]) < 0.05 + (j % 3 === 2 ? 2 : 0), `coef ${j}`);
});

test('sane rejects wild transforms', () => {
  assert.equal(sane(similarity(1, 0, 0, 0), 1280), true);
  assert.equal(sane(similarity(0.3, 0, 0, 0), 1280), false);
  assert.equal(sane(similarity(1, 45, 0, 0), 1280), false);
  assert.equal(sane(similarity(1, 0, 900, 0), 1280), false);
});

test('compose/invert are consistent', () => {
  const A = similarity(1.2, 10, 5, 6), B = similarity(0.9, -3, -7, 2);
  const [x, y] = apply(compose(A, B), 100, 50);
  const [bx, by] = apply(B, 100, 50); const [ax, ay] = apply(A, bx, by);
  assert.ok(Math.abs(x - ax) < 1e-9 && Math.abs(y - ay) < 1e-9);
  const [ix, iy] = apply(compose(invert(A), A), 33, 44);
  assert.ok(Math.abs(ix - 33) < 1e-9 && Math.abs(iy - 44) < 1e-9);
});

test('pairTransform recovers transform between texture and its warp', async () => {
  const cv = await cvReady();
  const W = 640, H = 480;
  const a = makeTexture(cv, W, H, 7);
  const M = similarity(1.08, 4, 25, -15);
  const b = warpGray(cv, a, M);          // b = M(a)  → pairTransform(fa, fb)는 b→a 이므로 M의 역
  const fa = detect(cv, a), fb = detect(cv, b);
  const r = pairTransform(cv, fa, fb, W);
  assert.ok(r && r.k >= 30, `inliers ${r && r.k}`);
  const Minv = invert(M);
  const [x, y] = apply(r.M, 320, 240), [ex, ey] = apply(Minv, 320, 240);
  assert.ok(Math.hypot(x - ex, y - ey) < 3, `center err ${Math.hypot(x - ex, y - ey)}`);
  fa.delete(); fb.delete(); a.delete(); b.delete();
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test motion/test/features.test.mjs`
Expected: FAIL (module not found).

- [ ] **Step 3: 구현**

`motion/js/features.js`:
```js
// 변환 M = Float64Array [a, b, tx, c, d, ty]  (x' = a x + b y + tx, y' = c x + d y + ty)
export function apply(M, x, y) { return [M[0] * x + M[1] * y + M[2], M[3] * x + M[4] * y + M[5]]; }
export function compose(A, B) {
  return new Float64Array([
    A[0] * B[0] + A[1] * B[3], A[0] * B[1] + A[1] * B[4], A[0] * B[2] + A[1] * B[5] + A[2],
    A[3] * B[0] + A[4] * B[3], A[3] * B[1] + A[4] * B[4], A[3] * B[2] + A[4] * B[5] + A[5]]);
}
export function invert(M) {
  const det = M[0] * M[4] - M[1] * M[3];
  const a = M[4] / det, b = -M[1] / det, c = -M[3] / det, d = M[0] / det;
  return new Float64Array([a, b, -(a * M[2] + b * M[5]), c, d, -(c * M[2] + d * M[5])]);
}
export const identity = () => new Float64Array([1, 0, 0, 0, 1, 0]);

export function sane(M, W) {
  const sc = Math.hypot(M[0], M[3]);
  const ang = Math.abs(Math.atan2(M[3], M[0]) * 180 / Math.PI);
  return sc > 0.6 && sc < 1.6 && ang < 20 && Math.abs(M[2]) < 0.5 * W && Math.abs(M[5]) < 0.5 * W;
}

export function toGray(cv, image) {
  const rgba = cv.matFromImageData(image);
  const gray = new cv.Mat();
  cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
  rgba.delete();
  const clahe = new cv.CLAHE(2.0, new cv.Size(8, 8));
  const out = new cv.Mat(); clahe.apply(gray, out);
  gray.delete(); clahe.delete();
  return out;
}

export function detect(cv, gray) {
  const orb = new cv.ORB(6000);
  const kp = new cv.KeyPointVector(); const des = new cv.Mat();
  orb.detectAndCompute(gray, new cv.Mat(), kp, des);
  const n = kp.size(); const pts = new Float32Array(2 * n);
  for (let i = 0; i < n; i++) { const p = kp.get(i).pt; pts[2 * i] = p.x; pts[2 * i + 1] = p.y; }
  kp.delete(); orb.delete();
  return { pts, des, n, delete() { des.delete(); } };
}

// 2점으로 유사변환 (a, b, tx, ty): x' = a x - b y + tx, y' = b x + a y + ty
function fit2(x1, y1, u1, v1, x2, y2, u2, v2) {
  const dx = x2 - x1, dy = y2 - y1, du = u2 - u1, dv = v2 - v1;
  const den = dx * dx + dy * dy; if (den < 1e-6) return null;
  const a = (dx * du + dy * dv) / den, b = (dx * dv - dy * du) / den;
  return new Float64Array([a, -b, u1 - (a * x1 - b * y1), b, a, v1 - (b * x1 + a * y1)]);
}
// 내점 전체로 최소제곱 유사변환
function fitLS(src, dst, idx) {
  let sx = 0, sy = 0, su = 0, sv = 0; const n = idx.length;
  for (const i of idx) { sx += src[2 * i]; sy += src[2 * i + 1]; su += dst[2 * i]; sv += dst[2 * i + 1]; }
  sx /= n; sy /= n; su /= n; sv /= n;
  let sxx = 0, sxu = 0, sxv = 0;
  for (const i of idx) {
    const x = src[2 * i] - sx, y = src[2 * i + 1] - sy, u = dst[2 * i] - su, v = dst[2 * i + 1] - sv;
    sxx += x * x + y * y; sxu += x * u + y * v; sxv += x * v - y * u;
  }
  const a = sxu / sxx, b = sxv / sxx;
  return new Float64Array([a, -b, su - (a * sx - b * sy), b, a, sv - (b * sx + a * sy)]);
}
export function similarityRansac(src, dst, thresh = 10, iters = 3000) {
  const n = src.length / 2; if (n < 2) return null;
  let best = null, bestK = 0, s = 12345;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const t2 = thresh * thresh;
  for (let it = 0; it < iters; it++) {
    const i = Math.floor(rnd() * n), j = Math.floor(rnd() * n); if (i === j) continue;
    const M = fit2(src[2 * i], src[2 * i + 1], dst[2 * i], dst[2 * i + 1], src[2 * j], src[2 * j + 1], dst[2 * j], dst[2 * j + 1]);
    if (!M) continue;
    let k = 0;
    for (let q = 0; q < n; q++) { const [u, v] = apply(M, src[2 * q], src[2 * q + 1]); if ((u - dst[2 * q]) ** 2 + (v - dst[2 * q + 1]) ** 2 < t2) k++; }
    if (k > bestK) { bestK = k; best = M; }
  }
  if (!best || bestK < 3) return null;
  const idx = [];
  for (let q = 0; q < n; q++) { const [u, v] = apply(best, src[2 * q], src[2 * q + 1]); if ((u - dst[2 * q]) ** 2 + (v - dst[2 * q + 1]) ** 2 < t2) idx.push(q); }
  const M = fitLS(src, dst, idx);
  let k = 0;
  for (let q = 0; q < n; q++) { const [u, v] = apply(M, src[2 * q], src[2 * q + 1]); if ((u - dst[2 * q]) ** 2 + (v - dst[2 * q + 1]) ** 2 < t2) k++; }
  return { M, k };
}

// fb(=b) → fa(=a) 변환. 반환 {M, k} 또는 null
export function pairTransform(cv, fa, fb, W) {
  if (!fa.n || !fb.n) return null;
  const bf = new cv.BFMatcher(cv.NORM_HAMMING, false);
  const mm = new cv.DMatchVectorVector();
  bf.knnMatch(fb.des, fa.des, mm, 2);
  const pairs = [];
  for (let i = 0; i < mm.size(); i++) { const p = mm.get(i); if (p.size() >= 2) pairs.push([p.get(0).queryIdx, p.get(0).trainIdx, p.get(0).distance, p.get(1).distance]); }
  mm.delete(); bf.delete();
  let best = null;
  for (const ratio of [0.7, 0.8]) {
    const good = pairs.filter(p => p[2] < ratio * p[3]);
    if (good.length < 8) continue;
    const src = new Float32Array(2 * good.length), dst = new Float32Array(2 * good.length);
    good.forEach((p, i) => { src[2 * i] = fb.pts[2 * p[0]]; src[2 * i + 1] = fb.pts[2 * p[0] + 1]; dst[2 * i] = fa.pts[2 * p[1]]; dst[2 * i + 1] = fa.pts[2 * p[1] + 1]; });
    const r = similarityRansac(src, dst, 10, 3000);
    if (r && r.k >= 8 && sane(r.M, W) && (!best || r.k > best.k)) best = r;
  }
  return best;
}
```

- [ ] **Step 4: 통과 확인**

Run: `node --test motion/test/features.test.mjs`
Expected: 4 pass.

- [ ] **Step 5: 커밋**

```bash
git add motion/js/features.js motion/test/features.test.mjs motion/test/_synth.mjs
git commit -m "motion: ORB 특징점·매칭·유사변환 RANSAC(features.js)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: orient.js — 좌우 반전 판정

**Files:**
- Create: `motion/js/orient.js`
- Test: `motion/test/orient.test.mjs`

**Interfaces:**
- Consumes: `toGray, detect, pairTransform` (Task 3)
- Produces: `checkOrientation(cv, grays: cv.Mat[], W): {flip: boolean, warn: 'flip'|'other'|null, so: number, sf: number}[]` — 입력 회색 사진 배열(원본 순서). 뒤집지 않고 판정만 한다. 호출자가 `flip`인 사진의 ImageData와 gray를 뒤집는다.
- Produces: `flipImageData(image: ImageData): ImageData` (순수 JS 좌우 뒤집기).

- [ ] **Step 1: 실패하는 시험 작성**

`motion/test/orient.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cvReady } from './_cv.mjs';
import { makeTexture, warpGray, similarity } from './_synth.mjs';
import { checkOrientation, flipImageData } from '../js/orient.js';

test('flipImageData mirrors horizontally', () => {
  const img = { width: 3, height: 1, data: new Uint8ClampedArray([1, 1, 1, 255, 2, 2, 2, 255, 3, 3, 3, 255]) };
  const f = flipImageData(img);
  assert.deepEqual(Array.from(f.data), [3, 3, 3, 255, 2, 2, 2, 255, 1, 1, 1, 255]);
});

test('checkOrientation flags the one mirrored photo among five', async () => {
  const cv = await cvReady();
  const W = 640, H = 480;
  const base = makeTexture(cv, W, H, 3);
  const grays = [];
  for (let i = 0; i < 5; i++) grays.push(warpGray(cv, base, similarity(1 + 0.02 * i, i - 2, 5 * i, -3 * i)));
  const flipped = new cv.Mat(); cv.flip(grays[2], flipped, 1); grays[2].delete(); grays[2] = flipped;
  const r = checkOrientation(cv, grays, W);
  assert.deepEqual(r.map(x => x.flip), [false, false, true, false, false]);
  assert.equal(r[2].warn, 'flip');
  grays.forEach(g => g.delete()); base.delete();
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test motion/test/orient.test.mjs` → FAIL (module not found).

- [ ] **Step 3: 구현**

`motion/js/orient.js`:
```js
import { detect, pairTransform } from './features.js';

export function flipImageData(image) {
  const { width: w, height: h, data } = image;
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = (y * w + x) * 4, d = (y * w + (w - 1 - x)) * 4;
    out[d] = data[s]; out[d + 1] = data[s + 1]; out[d + 2] = data[s + 2]; out[d + 3] = data[s + 3];
  }
  return typeof ImageData === 'function' ? new ImageData(out, w, h) : { width: w, height: h, data: out };
}

export function checkOrientation(cv, grays, W) {
  const n = grays.length;
  const F = grays.map(g => detect(cv, g));
  const FF = grays.map(g => { const f = new cv.Mat(); cv.flip(g, f, 1); const d = detect(cv, f); f.delete(); return d; });
  const out = [];
  for (let i = 0; i < n; i++) {
    let so = 0, sf = 0;
    for (const j of [i - 2, i - 1, i + 1, i + 2]) {
      if (j < 0 || j >= n) continue;
      const a = pairTransform(cv, F[j], F[i], W), b = pairTransform(cv, F[j], FF[i], W);
      so += a ? a.k : 0; sf += b ? b.k : 0;
    }
    const flip = sf > so * 1.3 && sf >= 15;
    const warn = flip ? 'flip' : (so < 8 && sf < 8 ? 'other' : null);
    out.push({ flip, warn, so, sf });
  }
  F.forEach(f => f.delete()); FF.forEach(f => f.delete());
  return out;
}
```

- [ ] **Step 4: 통과 확인** — `node --test motion/test/orient.test.mjs` → 2 pass.

- [ ] **Step 5: 커밋**

```bash
git add motion/js/orient.js motion/test/orient.test.mjs
git commit -m "motion: 좌우 반전 판정(orient.js)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: align.js — 변환 사슬, ECC 미세 조정, 중간 구도, 워핑

**Files:**
- Create: `motion/js/align.js`
- Test: `motion/test/align.test.mjs`

**Interfaces:**
- Consumes: features.js 전부.
- Produces:
  - `chainTransforms(cv, grays: cv.Mat[], W, H, onProgress?): {T: Float64Array(6)[], status: ('ok'|'ecc'|'fail')[]}` — 첫 사진 기준 누적 변환(사진 i의 점 → 첫 사진 좌표). 중간 구도로 다시 기준 잡은 결과를 돌려준다.
  - `eccEuclid(cv, ga, gb, W): Float64Array(6)|null` — 대응점 실패 시 예비.
  - `eccRefine(cv, ga, gb, M): Float64Array(6)` — 아핀 미세 조정, 정규화 상관이 높은 쪽 반환.
  - `medianFrame(T, W, H): Float64Array(6)` — 중간 구도 Tref.
  - `warpImage(cv, image: ImageData, M, W, H, margin=0.05): ImageData` — 기준 틀로 옮기고 가장자리 자른 결과(크기 `cw×ch`, 짝수).
  - `alignedSize(W, H, margin=0.05): {cw, ch}`.

- [ ] **Step 1: 실패하는 시험 작성**

`motion/test/align.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cvReady } from './_cv.mjs';
import { makeTexture, warpGray, similarity } from './_synth.mjs';
import { chainTransforms, eccRefine, medianFrame, alignedSize, warpImage } from '../js/align.js';
import { apply, invert, compose } from '../js/features.js';

test('chainTransforms brings 4 warped copies back onto one frame', async () => {
  const cv = await cvReady();
  const W = 640, H = 480; const base = makeTexture(cv, W, H, 11);
  const Ms = [similarity(1, 0, 0, 0), similarity(1.06, 3, 20, -10), similarity(0.95, -2, -15, 12), similarity(1.02, 1, 8, 25)];
  const grays = Ms.map(M => warpGray(cv, base, M));
  const { T, status } = chainTransforms(cv, grays, W, H);
  assert.deepEqual(status, ['ok', 'ok', 'ok', 'ok']);
  // 모든 사진의 같은 원점(base의 (320,240))이 기준 틀에서 같은 자리로 가야 한다
  const pts = Ms.map((M, i) => { const [x, y] = apply(M, 320, 240); return apply(T[i], x, y); });
  for (const p of pts) assert.ok(Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]) < 4, `spread ${p}`);
  grays.forEach(g => g.delete()); base.delete();
});

test('eccRefine improves a slightly wrong initial transform', async () => {
  const cv = await cvReady();
  const W = 640, H = 480; const a = makeTexture(cv, W, H, 5);
  const M = similarity(1.03, 2, 12, -8); const b = warpGray(cv, a, M);
  const rough = compose(invert(M), similarity(1, 0, 6, 5));   // 6,5 픽셀 어긋난 초기값
  const R = eccRefine(cv, a, b, rough);
  const [x, y] = apply(R, 320, 240), [ex, ey] = apply(invert(M), 320, 240);
  const [rx, ry] = apply(rough, 320, 240);
  assert.ok(Math.hypot(x - ex, y - ey) < Math.hypot(rx - ex, ry - ey), 'closer than rough');
  a.delete(); b.delete();
});

test('medianFrame of identical transforms is identity-like', () => {
  const T = [similarity(1.1, 5, 10, 20), similarity(1.1, 5, 10, 20), similarity(1.1, 5, 10, 20)];
  const R = medianFrame(T, 640, 480);
  for (let j = 0; j < 6; j++) assert.ok(Math.abs(R[j] - T[0][j]) < 1e-6);
});

test('alignedSize is even and 90% of frame', () => {
  assert.deepEqual(alignedSize(1280, 854), { cw: 1152, ch: 770 });
});

test('warpImage returns cropped ImageData', async () => {
  const cv = await cvReady();
  const img = { width: 64, height: 48, data: new Uint8ClampedArray(64 * 48 * 4).fill(200) };
  const out = warpImage(cv, img, similarity(1, 0, 0, 0), 64, 48, 0.05);
  assert.equal(out.width, 58); assert.equal(out.height, 44); assert.equal(out.data[0], 200);
});
```

- [ ] **Step 2: 실패 확인** — `node --test motion/test/align.test.mjs` → FAIL.

- [ ] **Step 3: 구현**

`motion/js/align.js`:
```js
import { detect, pairTransform, sane, compose, invert, identity, apply } from './features.js';

function mat23(cv, M, type = cv.CV_64F) { return cv.matFromArray(2, 3, type, Array.from(M)); }
function fromMat23(m) { const d = m.data64F || m.data32F; return new Float64Array([d[0], d[1], d[2], d[3], d[4], d[5]]); }

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
  const crit = new cv.TermCriteria(cv.TermCriteria_EPS | cv.TermCriteria_COUNT, motion === cv.MOTION_EUCLIDEAN ? 200 : 100, 1e-6);
  let ok = false;
  let maskMat = mask ? mask(A.m.cols, A.m.rows) : new cv.Mat();
  try { cv.findTransformECC(A.m, B.m, warp, motion, crit, maskMat, 5); ok = true; } catch (e) { ok = false; }
  let R = null;
  if (ok) { R = scaleM(invert(fromMat23(warp)), 1 / A.s); }
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

export function eccEuclid(cv, ga, gb, W) {
  const { R, ctx } = runEcc(cv, ga, gb, identity(), cv.MOTION_EUCLIDEAN, 600, null);
  freeCtx(ctx);
  return R && sane(R, W) ? R : null;
}

export function eccRefine(cv, ga, gb, M) {
  const mask = (w, h) => { const m = new cv.Mat.zeros(h, w, cv.CV_8UC1); cv.rectangle(m, new cv.Point(Math.round(w * 0.12), Math.round(h * 0.05)), new cv.Point(Math.round(w * 0.88), Math.round(h * 0.95)), new cv.Scalar(255), -1); return m; };
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

export function chainTransforms(cv, grays, W, H, onProgress) {
  const n = grays.length;
  const F = grays.map(g => detect(cv, g));
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
    onProgress && onProgress(i + 1, n);
  }
  F.forEach(f => f.delete());
  const inv = invert(medianFrame(T, W, H));
  return { T: T.map(t => compose(inv, t)), status };
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
```
주의: `cv.Mat.zeros`가 없으면 `new cv.Mat(h, w, cv.CV_8UC1, new cv.Scalar(0))`로 바꾼다. `cv.TermCriteria_EPS`가 undefined면 숫자 2, `TermCriteria_COUNT`는 1을 쓴다.

- [ ] **Step 4: 통과 확인** — `node --test motion/test/align.test.mjs` → 5 pass.

- [ ] **Step 5: 실제 사진으로 대조 (스크립트, 시험 아님)**

`motion/test/real_align.mjs` (git에 넣되 node --test 대상이 아니게 `.test`를 붙이지 않는다):
```js
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
```
RGBA raw 만들기(한 번):
```bash
python3 -c "
import cv2,glob,os
for p in sorted(glob.glob('/Users/eumtmj/이음랩/rife/사진_선별/*.jpg')):
    im=cv2.cvtColor(cv2.resize(cv2.imread(p),(1280,854)),cv2.COLOR_BGR2RGBA); im.tofile(p[:-4]+'_1280x854.rgba')
print('ok')"
node motion/test/real_align.mjs /Users/eumtmj/이음랩/rife/사진_선별
```
Expected: status에 `fail` 없음, 일치도 0.62 이상, 25장 60초 이내. 미달이면 ORB 특징점 수(6000→8000)나 RANSAC 반복(3000→6000)을 올려 본다. 끝나면 `.rgba` 파일은 지운다(`rm /Users/eumtmj/이음랩/rife/사진_선별/*.rgba`).

- [ ] **Step 6: 커밋**

```bash
git add motion/js/align.js motion/test/align.test.mjs motion/test/real_align.mjs
git commit -m "motion: 구도 맞추기(align.js) — 변환 사슬·ECC 미세 조정·중간 구도

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: color.js — 밝기·색 맞추기

**Files:**
- Create: `motion/js/color.js`
- Test: `motion/test/color.test.mjs`

**Interfaces:**
- Produces: `matchColors(images: ImageData[]): ImageData[]` — 새 ImageData 배열. LAB 채널별 평균·표준편차를 전체 중앙값에 맞춘다. 통계는 4픽셀마다 표본.
- Produces: `rgbToLab(r,g,b): [L,a,b]`, `labToRgb(L,a,b): [r,g,b]` (0~255 ↔ L 0~100).

- [ ] **Step 1: 실패하는 시험**

`motion/test/color.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchColors, rgbToLab, labToRgb } from '../js/color.js';

test('rgb<->lab roundtrip', () => {
  for (const c of [[0, 0, 0], [255, 255, 255], [200, 120, 90], [30, 60, 200]]) {
    const [L, a, b] = rgbToLab(...c); const back = labToRgb(L, a, b);
    back.forEach((v, i) => assert.ok(Math.abs(v - c[i]) <= 1, `${c} -> ${back}`));
  }
});

test('matchColors equalizes mean brightness of a dark and a bright image', () => {
  const mk = v => ({ width: 8, height: 8, data: new Uint8ClampedArray(256).map((_, i) => (i % 4 === 3 ? 255 : v + ((i >> 2) % 5) * 3)) });
  const out = matchColors([mk(60), mk(120), mk(180)]);
  const mean = img => { let s = 0, n = 0; for (let i = 0; i < img.data.length; i += 4) { s += img.data[i]; n++; } return s / n; };
  const ms = out.map(mean);
  assert.ok(Math.abs(ms[0] - ms[1]) < 6 && Math.abs(ms[2] - ms[1]) < 6, `means ${ms}`);
});
```

- [ ] **Step 2: 실패 확인** — `node --test motion/test/color.test.mjs` → FAIL.

- [ ] **Step 3: 구현**

`motion/js/color.js`:
```js
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
  const mean = s.map(v => v / n); const std = ss.map((v, c) => Math.sqrt(Math.max(v / n - mean[c] * mean[c], 1e-6)));
  return { mean, std };
}
const median = arr => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
export function matchColors(images) {
  const st = images.map(stats);
  const tm = [0, 1, 2].map(c => median(st.map(s => s.mean[c]))), ts = [0, 1, 2].map(c => median(st.map(s => s.std[c])));
  return images.map((img, k) => {
    const { mean, std } = st[k]; const d = img.data; const out = new Uint8ClampedArray(d.length);
    for (let i = 0; i < d.length; i += 4) {
      const l = rgbToLab(d[i], d[i + 1], d[i + 2]);
      const L = (l[0] - mean[0]) / std[0] * ts[0] + tm[0], a = (l[1] - mean[1]) / std[1] * ts[1] + tm[1], b = (l[2] - mean[2]) / std[2] * ts[2] + tm[2];
      const rgb = labToRgb(L, a, b); out[i] = rgb[0]; out[i + 1] = rgb[1]; out[i + 2] = rgb[2]; out[i + 3] = 255;
    }
    return typeof ImageData === 'function' ? new ImageData(out, img.width, img.height) : { width: img.width, height: img.height, data: out };
  });
}
```

- [ ] **Step 4: 통과 확인** — `node --test motion/test/color.test.mjs` → 2 pass.

- [ ] **Step 5: 커밋**

```bash
git add motion/js/color.js motion/test/color.test.mjs
git commit -m "motion: LAB 밝기·색 맞추기(color.js)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: interp.js — RIFE 중간 그림과 이진 분할, 선형 겹치기

**Files:**
- Create: `motion/js/interp.js`
- Test: `motion/test/interp.test.mjs` (순수 JS 부분), `motion/test/browser.html` (브라우저 수동 확인)

**Interfaces:**
- Produces:
  - `planTiming(stepSec: number): {N: number, fps: number}` — `N = min(64, 2^ceil(log2(30·stepSec)))`, `fps = min(60, N/stepSec)`.
  - `imageToCHW(img: ImageData): Float32Array(3·w·h)` (0~1), `chwToImage(chw, w, h): ImageData`.
  - `blend(a: Float32Array, b: Float32Array, t: number): Float32Array`.
  - `class Rife { static async create(ort, modelUrl): Promise<Rife|null>` (WebGPU 없거나 실패 시 null), `async mid(a: Float32Array, b: Float32Array, w, h): Promise<Float32Array>`, `release()` }`.
  - `async transition(a: Float32Array, b: Float32Array, w, h, N, aiLevels, rife: Rife|null, emit: (chw)=>Promise<void>, isCancelled: ()=>boolean)` — 첫 프레임 a부터 b 직전까지 N장을 시간 순으로 emit. `aiLevels`단계까지 이진 분할은 인공지능(`rife.mid`), 그 아래는 선형 겹치기. `rife`가 null이면 전부 선형.
  - 품질 모드 → aiLevels: `'high'` → `log2(N)`, `'fast'` → 2, `'none'` → 0.

- [ ] **Step 1: 실패하는 시험(순수 JS 부분)**

`motion/test/interp.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planTiming, blend, transition, imageToCHW, chwToImage } from '../js/interp.js';

test('planTiming', () => {
  assert.deepEqual(planTiming(1.2), { N: 64, fps: 53.333333333333336 });
  assert.deepEqual(planTiming(0.5), { N: 16, fps: 32 });
  assert.deepEqual(planTiming(2.0), { N: 64, fps: 32 });
});

test('image<->chw roundtrip', () => {
  const img = { width: 2, height: 1, data: new Uint8ClampedArray([255, 0, 128, 255, 0, 255, 64, 255]) };
  const chw = imageToCHW(img);
  assert.deepEqual(Array.from(chw).map(v => Math.round(v * 255)), [255, 0, 0, 255, 128, 64]);
  assert.deepEqual(Array.from(chwToImage(chw, 2, 1).data), Array.from(img.data));
});

test('transition without AI emits N linear frames in order', async () => {
  const a = Float32Array.from([0, 0, 0]), b = Float32Array.from([1, 1, 1]);
  const got = [];
  await transition(a, b, 1, 1, 8, 0, null, async f => { got.push(f[0]); }, () => false);
  assert.deepEqual(got.map(v => +v.toFixed(3)), [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875]);
});

test('transition with fake AI uses mid() at top levels and blend below', async () => {
  const calls = [];
  const fake = { mid: async (x, y) => { calls.push([x[0], y[0]]); return blend(x, y, 0.5); } };
  const got = [];
  await transition(Float32Array.from([0]), Float32Array.from([1]), 1, 1, 8, 1, fake, async f => { got.push(f[0]); }, () => false);
  assert.deepEqual(calls, [[0, 1]]);              // 1단계만 AI (0.5 한 장)
  assert.deepEqual(got.map(v => +v.toFixed(3)), [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875]);
});

test('transition stops when cancelled', async () => {
  let n = 0;
  await transition(Float32Array.from([0]), Float32Array.from([1]), 1, 1, 8, 0, null, async () => { n++; }, () => n >= 3);
  assert.equal(n, 3);
});
```

- [ ] **Step 2: 실패 확인** — `node --test motion/test/interp.test.mjs` → FAIL.

- [ ] **Step 3: 구현**

`motion/js/interp.js`:
```js
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
  for (let i = 0; i < n; i++) { d[4 * i] = chw[i] * 255 + 0.5; d[4 * i + 1] = chw[n + i] * 255 + 0.5; d[4 * i + 2] = chw[2 * n + i] * 255 + 0.5; d[4 * i + 3] = 255; }
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
```

- [ ] **Step 4: 통과 확인** — `node --test motion/test/interp.test.mjs` → 5 pass.

- [ ] **Step 5: 브라우저 수동 확인 페이지**

`motion/test/browser.html` (실제 RIFE로 두 사진 사이 8장을 그려 화면에 나열):
```html
<!doctype html><html lang="ko"><meta charset="utf-8"><title>motion 부품 확인</title>
<body style="font-family:sans-serif;background:#222;color:#eee">
<p>사진 2장 선택 → RIFE로 사이 8장 생성 (WebGPU 필요) <input type="file" id="f" multiple accept="image/*"></p>
<pre id="log"></pre><div id="out" style="display:flex;flex-wrap:wrap;gap:4px"></div>
<script type="module">
import * as ort from '../../vendor/ort/ort.webgpu.min.mjs';
import { loadFiles } from '../js/load.js';
import { Rife, transition, imageToCHW, chwToImage } from '../js/interp.js';
ort.env.wasm.wasmPaths = '../../vendor/ort/';
const log = m => document.getElementById('log').textContent += m + '\n';
document.getElementById('f').onchange = async e => {
  const { items } = await loadFiles([...e.target.files].slice(0, 2), 640);
  const w = items[0].image.width, h = items[0].image.height;
  const t0 = performance.now(); const rife = await Rife.create(ort, '../models/rife_fp32.onnx');
  log(`모델 ${rife ? '준비' : '없음(단순 겹치기)'} ${Math.round(performance.now() - t0)}ms, ${w}x${h}`);
  const t1 = performance.now(); let n = 0;
  await transition(imageToCHW(items[0].image), imageToCHW(items[1].image), w, h, 8, 3, rife, async chw => {
    const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').putImageData(chwToImage(chw, w, h), 0, 0); c.style.width = '300px'; document.getElementById('out').appendChild(c); n++;
  }, () => false);
  log(`${n}장 ${Math.round(performance.now() - t1)}ms`);
};
</script></body></html>
```
확인 절차: `~/.claude/launch.json`에 caseframe 폴더를 서비스하는 항목(`python3 -m http.server <port> -d /Users/eumtmj/Documents/이음랩/caseframe`)이 있으면 preview_start로 열고 `/motion/test/browser.html`로 이동. `/Users/eumtmj/이음랩/rife/사진_선별_미세/`의 두 장을 넣어 8장이 자연스럽게 이어지는지 스크린샷으로 확인. 기대: 8장 생성에 이 맥 기준 2초 이내.

- [ ] **Step 6: 커밋**

```bash
git add motion/js/interp.js motion/test/interp.test.mjs motion/test/browser.html
git commit -m "motion: RIFE 중간 그림·이진 분할·선형 겹치기(interp.js)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: encode.js — 글씨 얹기, MP4/WebM 저장

**Files:**
- Create: `motion/js/encode.js`
- Test: `motion/test/encode.test.mjs` (순수 JS 부분), `motion/test/browser.html` 수정(인코더 확인 추가)

**Interfaces:**
- Produces:
  - `drawLabel(ctx: CanvasRenderingContext2D, text: string, w: number)` — 왼쪽 위 반투명 검은 띠(높이 `round(w*0.055)`), 흰 글씨(`bold ${round(w*0.035)}px sans-serif`), 여백 `round(w*0.012)`.
  - `pickEncoder(): 'mp4'|'webm'|null` — `VideoEncoder`와 `VideoEncoder.isConfigSupported`가 있으면 'mp4', `MediaRecorder`가 있으면 'webm', 아니면 null.
  - `class Mp4Encoder { static async create(Mp4Muxer, w, h, fps): Promise<Mp4Encoder>; async addFrame(canvas: HTMLCanvasElement, index: number): Promise<void>; async finish(): Promise<Blob> }` — 60장마다 키프레임, 코덱 `avc1.640029`, 비트레이트 `w*h*fps*0.12` bps(1280×768×53 → 약 6.3Mbps).
  - `class WebmEncoder { constructor(canvas, fps); addFrame(): void (captureStream(0)의 requestFrame); async finish(): Promise<Blob> }`.
  - `outputName(firstName: string, ext: 'mp4'|'webm'): string` — `baseName(firstName) + '_교정진행.' + ext`.

- [ ] **Step 1: 실패하는 시험(순수 JS 부분)**

`motion/test/encode.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outputName, pickEncoder, labelMetrics } from '../js/encode.js';

test('outputName', () => {
  assert.equal(outputName('임희진_20221128_160831.jpg', 'mp4'), '임희진_교정진행.mp4');
  assert.equal(outputName('case.png', 'webm'), 'case_교정진행.webm');
});
test('pickEncoder returns null in Node', () => { assert.equal(pickEncoder(), null); });
test('labelMetrics scale with width', () => {
  assert.deepEqual(labelMetrics(1152), { band: 63, font: 40, pad: 14 });
});
```

- [ ] **Step 2: 실패 확인** — `node --test motion/test/encode.test.mjs` → FAIL.

- [ ] **Step 3: 구현**

`motion/js/encode.js`:
```js
import { baseName } from './load.js';

export function outputName(firstName, ext) { return `${baseName(firstName)}_교정진행.${ext}`; }
export function labelMetrics(w) { return { band: Math.round(w * 0.055), font: Math.round(w * 0.035), pad: Math.round(w * 0.012) }; }
export function drawLabel(ctx, text, w) {
  if (!text) return;
  const { band, font, pad } = labelMetrics(w);
  ctx.save();
  ctx.font = `bold ${font}px sans-serif`;
  const tw = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, 0, tw + pad * 2, band);
  ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.fillText(text, pad, band / 2);
  ctx.restore();
}
export function pickEncoder() {
  if (typeof VideoEncoder === 'function' && typeof VideoEncoder.isConfigSupported === 'function') return 'mp4';
  if (typeof MediaRecorder === 'function') return 'webm';
  return null;
}

export class Mp4Encoder {
  static async create(Mp4Muxer, w, h, fps) {
    const cfg = { codec: 'avc1.640029', width: w, height: h, framerate: fps, bitrate: Math.round(w * h * fps * 0.12), latencyMode: 'quality' };
    const sup = await VideoEncoder.isConfigSupported(cfg);
    if (!sup.supported) throw new Error('H.264 인코더를 쓸 수 없습니다');
    const enc = new Mp4Encoder(); enc.w = w; enc.h = h; enc.fps = fps;
    enc.muxer = new Mp4Muxer.Muxer({ target: new Mp4Muxer.ArrayBufferTarget(), video: { codec: 'avc', width: w, height: h, frameRate: fps }, fastStart: 'in-memory', firstTimestampBehavior: 'offset' });
    enc.encoder = new VideoEncoder({ output: (chunk, meta) => enc.muxer.addVideoChunk(chunk, meta), error: e => { enc.error = e; } });
    enc.encoder.configure(cfg);
    return enc;
  }
  async addFrame(canvas, index) {
    if (this.error) throw this.error;
    const ts = Math.round(index * 1e6 / this.fps);
    const frame = new VideoFrame(canvas, { timestamp: ts, duration: Math.round(1e6 / this.fps) });
    this.encoder.encode(frame, { keyFrame: index % 60 === 0 });
    frame.close();
    if (this.encoder.encodeQueueSize > 8) await new Promise(r => setTimeout(r, 20));
  }
  async finish() {
    await this.encoder.flush(); this.encoder.close(); this.muxer.finalize();
    return new Blob([this.muxer.target.buffer], { type: 'video/mp4' });
  }
}

export class WebmEncoder {
  constructor(canvas, fps) {
    this.stream = canvas.captureStream(0); this.track = this.stream.getVideoTracks()[0];
    this.chunks = []; this.rec = new MediaRecorder(this.stream, { mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: 8e6 });
    this.rec.ondataavailable = e => e.data.size && this.chunks.push(e.data); this.rec.start(); this.fps = fps;
  }
  async addFrame() { this.track.requestFrame && this.track.requestFrame(); await new Promise(r => setTimeout(r, 1000 / this.fps)); }
  async finish() { await new Promise(r => { this.rec.onstop = r; this.rec.stop(); }); return new Blob(this.chunks, { type: 'video/webm' }); }
}
```

- [ ] **Step 4: 통과 확인** — `node --test motion/test/encode.test.mjs` → 3 pass.

- [ ] **Step 5: 브라우저 확인 추가**

`motion/test/browser.html`의 `<script type="module">` 끝에 추가:
```js
import * as Mp4Muxer from '../../vendor/mp4-muxer.mjs';
import { Mp4Encoder, drawLabel } from '../js/encode.js';
window.testEncode = async () => {
  const w = 640, h = 480, c = document.createElement('canvas'); c.width = w; c.height = h; const ctx = c.getContext('2d');
  const enc = await Mp4Encoder.create(Mp4Muxer, w, h, 30);
  for (let i = 0; i < 60; i++) { ctx.fillStyle = `hsl(${i * 6},60%,50%)`; ctx.fillRect(0, 0, w, h); drawLabel(ctx, `${i}개월`, w); await enc.addFrame(c, i); }
  const blob = await enc.finish(); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'test.mp4'; a.textContent = `MP4 ${blob.size} bytes 내려받기`; document.body.appendChild(a);
  const v = document.createElement('video'); v.src = a.href; v.controls = true; document.body.appendChild(v); log('encode ok ' + blob.size);
};
```
확인: 브라우저에서 `testEncode()` 실행(javascript_tool) → 2초짜리 MP4가 재생되고 글씨가 왼쪽 위에 보인다.

- [ ] **Step 6: 커밋**

```bash
git add motion/js/encode.js motion/test/encode.test.mjs motion/test/browser.html
git commit -m "motion: 글씨 얹기·MP4/WebM 저장(encode.js)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: index.html + main.js — 화면과 연결

**Files:**
- Create: `motion/index.html`, `motion/js/main.js`
- Modify: `index.html`(caseframe 첫 화면)의 도구 목록에 링크 한 줄 추가 — 기존 `/line`, `/sx` 링크가 있는 자리 옆에 `<a href="/motion/">교정 진행 영상</a>` (기존 링크의 마크업을 그대로 따라 한다).
- Modify: `sitemap.xml`에 `<url><loc>https://caseframe.kr/motion/</loc></url>` 추가.

**Interfaces:**
- Consumes: 모든 부품.
- Produces: 완성 화면. `main.js`는 `state = { items, flags[], settings, cancelled }`를 가진다.

- [ ] **Step 1: index.html 작성**

`motion/index.html` (기존 `line/index.html`의 머리 부분 — meta, 글꼴, 색 — 을 따라 하되 내용은 아래):
```html
<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>교정 진행 영상 — CaseFrame</title>
<meta name="description" content="같은 방향으로 찍은 교정 진행 사진을 넣으면 치아가 움직이는 영상(MP4)을 브라우저 안에서 만듭니다. 사진은 서버로 전송되지 않습니다.">
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#1c1e21;--muted:#666;--line:#ddd;--accent:#1565c0;--warn:#f9a825;--bad:#c62828}
body{margin:0;font-family:-apple-system,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;background:var(--bg);color:var(--ink)}
main{max-width:1100px;margin:0 auto;padding:16px}
h1{font-size:22px;margin:8px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:12px 0}
#drop{border:2px dashed var(--accent);border-radius:10px;padding:28px;text-align:center;color:var(--muted);cursor:pointer}
#drop.over{background:#e3f2fd}
#strip{display:flex;gap:8px;overflow-x:auto;padding:6px 0}
.thumb{position:relative;flex:0 0 160px;border:1px solid var(--line);border-radius:6px;background:#000;cursor:grab}
.thumb img{width:160px;height:107px;object-fit:cover;display:block;border-radius:6px 6px 0 0}
.thumb .cap{font-size:11px;padding:4px;background:#fff;border-radius:0 0 6px 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.thumb .btns{position:absolute;top:2px;right:2px;display:flex;gap:2px}
.thumb button{font-size:11px;padding:2px 5px;border:0;border-radius:4px;background:rgba(255,255,255,.9);cursor:pointer}
.thumb.warn-flip{outline:3px solid var(--warn)}.thumb.warn-other{outline:3px solid var(--bad)}.thumb.fail{filter:grayscale(1)}
.row{display:flex;flex-wrap:wrap;gap:16px;align-items:center}
label.opt{display:flex;gap:6px;align-items:center;font-size:14px}
button.primary{background:var(--accent);color:#fff;border:0;border-radius:8px;padding:10px 18px;font-size:16px;cursor:pointer}
button.primary:disabled{background:#aaa}
#bar{height:10px;background:#eee;border-radius:5px;overflow:hidden}#bar i{display:block;height:100%;width:0;background:var(--accent)}
#msg{color:var(--bad);font-size:14px}#note{color:var(--muted);font-size:13px}
video{max-width:100%;border-radius:8px;background:#000}
</style></head><body><main>
<h1>교정 진행 영상</h1>
<p id="note">같은 방향(예: 상악 교합면)으로 찍은 사진만 넣어 주세요. 사진은 이 컴퓨터 밖으로 나가지 않습니다. 크롬·엣지 권장.</p>
<div class="card"><div id="drop">여기에 사진을 끌어다 놓거나 클릭해서 선택 (JPG/PNG, 최대 40장)<input type="file" id="file" multiple accept="image/*" hidden></div>
<div id="strip"></div><div id="msg"></div></div>
<div class="card row">
 <label class="opt">품질 <select id="quality"><option value="high">고품질</option><option value="fast">빠르게</option></select></label>
 <label class="opt">한 단계 <input type="range" id="step" min="0.5" max="2" step="0.1" value="1.2"> <span id="stepv">1.2초</span></label>
 <label class="opt"><input type="checkbox" id="label" checked> 경과 글씨</label>
 <button class="primary" id="go" disabled>영상 만들기</button><button id="cancel" hidden>취소</button>
</div>
<div class="card"><div id="bar"><i></i></div><div id="stage"></div></div>
<div class="card" id="result" hidden><video id="video" controls></video><p><a id="dl" class="primary" style="display:inline-block;text-decoration:none">MP4 저장</a> <span id="rnote"></span></p></div>
<p id="note">© 이음턱편한치과 · <a href="/">CaseFrame</a></p>
</main><script src="../vendor/opencv.js" async></script><script type="module" src="js/main.js"></script></body></html>
```

- [ ] **Step 2: main.js 작성**

`motion/js/main.js`:
```js
import { loadFiles, monthsLabel } from './load.js';
import { toGray } from './features.js';
import { checkOrientation, flipImageData } from './orient.js';
import { chainTransforms, warpImage, alignedSize } from './align.js';
import { matchColors } from './color.js';
import { planTiming, aiLevelsFor, Rife, transition, imageToCHW, chwToImage } from './interp.js';
import { pickEncoder, Mp4Encoder, WebmEncoder, drawLabel, outputName } from './encode.js';

const $ = id => document.getElementById(id);
const state = { items: [], flags: [], status: [], cancelled: false, busy: false };
const MAX = 40;

function cvReady() { return new Promise(r => { const t = () => (window.cv && window.cv.Mat ? r(window.cv) : setTimeout(t, 100)); t(); }); }
function setMsg(t) { $('msg').textContent = t || ''; }
function progress(stage, i, n) { $('stage').textContent = n ? `${stage} ${i}/${n}` : stage; $('bar').firstElementChild.style.width = n ? `${Math.round(100 * i / n)}%` : '0%'; }
function renderStrip() {
  const s = $('strip'); s.innerHTML = '';
  state.items.forEach((it, i) => {
    const d = document.createElement('div'); d.className = 'thumb'; d.draggable = true; d.dataset.i = i;
    const f = state.flags[i]; if (f && f.warn === 'flip') d.classList.add('warn-flip'); if (f && f.warn === 'other') d.classList.add('warn-other'); if (state.status[i] === 'fail') d.classList.add('fail');
    const c = document.createElement('canvas'); c.width = it.image.width; c.height = it.image.height; c.getContext('2d').putImageData(it.image, 0, 0);
    const img = document.createElement('img'); img.src = c.toDataURL('image/jpeg', 0.6); d.appendChild(img);
    const cap = document.createElement('div'); cap.className = 'cap'; cap.textContent = `${i + 1}. ${it.name}` + (f && f.warn === 'flip' ? ' (자동 뒤집음)' : f && f.warn === 'other' ? ' (다른 방향?)' : ''); d.appendChild(cap);
    const b = document.createElement('div'); b.className = 'btns';
    for (const [t, fn] of [['◀', () => move(i, -1)], ['▶', () => move(i, 1)], ['⇄', () => flip(i)], ['✕', () => remove(i)]]) { const x = document.createElement('button'); x.textContent = t; x.onclick = fn; b.appendChild(x); }
    d.appendChild(b);
    d.ondragstart = e => e.dataTransfer.setData('text/plain', i);
    d.ondragover = e => e.preventDefault();
    d.ondrop = e => { e.preventDefault(); const from = +e.dataTransfer.getData('text/plain'); moveTo(from, i); };
    s.appendChild(d);
  });
  $('go').disabled = state.items.length < 2 || state.busy;
  const noDate = state.items.some(it => !it.date);
  $('label').disabled = noDate; if (noDate) $('label').checked = false;
}
function move(i, d) { moveTo(i, i + d); }
function moveTo(from, to) { if (to < 0 || to >= state.items.length || from === to) return; const [it] = state.items.splice(from, 1); state.items.splice(to, 0, it); const [f] = state.flags.splice(from, 1); state.flags.splice(to, 0, f); renderStrip(); }
function flip(i) { state.items[i].image = flipImageData(state.items[i].image); state.flags[i] = { warn: null }; renderStrip(); }
function remove(i) { state.items.splice(i, 1); state.flags.splice(i, 1); renderStrip(); }

async function addFiles(files) {
  setMsg('');
  const list = [...files].slice(0, MAX - state.items.length);
  if ([...files].length > list.length) setMsg(`한 번에 ${MAX}장까지만 넣을 수 있어 앞 ${list.length}장만 받았습니다.`);
  progress('사진 읽는 중');
  const { items, skipped } = await loadFiles(list, 1280);
  if (skipped.length) setMsg(`읽지 못한 파일 ${skipped.length}개(HEIC 등): JPG로 바꿔 넣어 주세요. ` + skipped.slice(0, 3).join(', '));
  if (state.items.length && items.length && (items[0].image.width !== state.items[0].image.width || items[0].image.height !== state.items[0].image.height)) { setMsg('앞서 넣은 사진과 비율이 달라 넣지 못했습니다. 한 번에 넣어 주세요.'); return; }
  state.items.push(...items); state.flags.push(...items.map(() => ({ warn: null })));
  const cv = await cvReady();
  progress('방향 검사 중');
  const grays = state.items.map(it => toGray(cv, it.image));
  const W = state.items[0].image.width;
  const res = checkOrientation(cv, grays, W);
  grays.forEach(g => g.delete());
  res.forEach((r, i) => { if (r.flip) state.items[i].image = flipImageData(state.items[i].image); state.flags[i] = { warn: r.warn }; });
  state.status = [];
  progress(''); renderStrip();
}

async function make() {
  if (state.busy) return; state.busy = true; state.cancelled = false; $('go').disabled = true; $('cancel').hidden = false; $('result').hidden = true; setMsg('');
  const cancelled = () => state.cancelled;
  try {
    const cv = await cvReady();
    const W = state.items[0].image.width, H = state.items[0].image.height;
    const grays = state.items.map(it => toGray(cv, it.image));
    const { T, status } = chainTransforms(cv, grays, W, H, (i, n) => progress('구도 맞추는 중', i, n));
    grays.forEach(g => g.delete()); state.status = status; renderStrip();
    if (cancelled()) throw new Error('취소');
    progress('밝기·색 맞추는 중');
    const aligned = matchColors(state.items.map((it, i) => warpImage(cv, it.image, T[i], W, H)));
    const { cw, ch } = alignedSize(W, H);
    const stepSec = +$('step').value, { N, fps } = planTiming(stepSec);
    const quality = $('quality').value;
    progress('인공지능 모델 준비 중');
    const ort = await import('../../vendor/ort/ort.webgpu.min.mjs'); ort.env.wasm.wasmPaths = '../../vendor/ort/';
    const rife = await Rife.create(ort, '../models/rife_fp32.onnx');
    const aiLevels = rife ? aiLevelsFor(quality, N) : 0;
    const kind = pickEncoder(); if (!kind) throw new Error('이 브라우저는 영상 저장을 지원하지 않습니다. 크롬이나 엣지를 써 주세요.');
    const canvas = document.createElement('canvas'); canvas.width = cw; canvas.height = ch; const ctx = canvas.getContext('2d');
    let enc;
    if (kind === 'mp4') { const Mp4Muxer = await import('../../vendor/mp4-muxer.mjs'); enc = await Mp4Encoder.create(Mp4Muxer, cw, ch, fps); }
    else enc = new WebmEncoder(canvas, fps);
    const useLabel = $('label').checked && state.items.every(it => it.date);
    const labels = state.items.map(it => useLabel ? monthsLabel(state.items[0].date, it.date) : '');
    const chws = aligned.map(imageToCHW);
    let idx = 0; const total = (chws.length - 1) * N + Math.round(fps);
    for (let i = 0; i < chws.length - 1; i++) {
      await transition(chws[i], chws[i + 1], cw, ch, N, aiLevels, rife, async f => {
        ctx.putImageData(chwToImage(f, cw, ch), 0, 0); drawLabel(ctx, labels[i], cw);
        await enc.addFrame(canvas, idx++); if (idx % 8 === 0) progress('중간 그림 그리는 중', idx, total);
      }, cancelled);
      if (cancelled()) throw new Error('취소');
    }
    ctx.putImageData(chwToImage(chws[chws.length - 1], cw, ch), 0, 0); drawLabel(ctx, labels[labels.length - 1], cw);
    for (let k = 0; k < Math.round(fps); k++) await enc.addFrame(canvas, idx++);
    progress('영상 파일 만드는 중');
    const blob = await enc.finish(); rife && rife.release();
    const url = URL.createObjectURL(blob); $('video').src = url; $('dl').href = url; $('dl').download = outputName(state.items[0].name, kind);
    $('dl').textContent = kind === 'mp4' ? 'MP4 저장' : 'WebM 저장';
    $('rnote').textContent = (rife ? '' : '이 컴퓨터에서는 빠른 방식(단순 겹치기)으로 만들었습니다. ') + (kind === 'webm' ? '이 브라우저에서는 WebM으로 저장됩니다.' : '');
    $('result').hidden = false; progress('완료', total, total);
  } catch (e) { setMsg(e.message === '취소' ? '취소했습니다.' : '오류: ' + (e.message || e)); progress(''); }
  finally { state.busy = false; $('cancel').hidden = true; $('go').disabled = state.items.length < 2; }
}

$('drop').onclick = () => $('file').click();
$('file').onchange = e => addFiles(e.target.files);
$('drop').ondragover = e => { e.preventDefault(); $('drop').classList.add('over'); };
$('drop').ondragleave = () => $('drop').classList.remove('over');
$('drop').ondrop = e => { e.preventDefault(); $('drop').classList.remove('over'); addFiles(e.dataTransfer.files); };
$('step').oninput = () => { $('stepv').textContent = `${$('step').value}초`; };
$('go').onclick = make;
$('cancel').onclick = () => { state.cancelled = true; };
```

- [ ] **Step 3: 첫 화면 링크와 sitemap 수정**

`index.html`에서 `/line/` 링크를 찾아(`grep -n 'line/' index.html`) 같은 형식으로 `/motion/` 링크를 바로 뒤에 추가. `sitemap.xml`에 `<url><loc>https://caseframe.kr/motion/</loc></url>` 추가.

- [ ] **Step 4: 브라우저에서 끝까지 실행**

launch.json의 caseframe 항목을 이 저장소 경로로 맞춘 뒤 preview_start → `/motion/`. `/Users/eumtmj/이음랩/rife/사진_선별/` 25장(원본 JPG, 반전 3장 포함)을 넣는다.
기대:
- 사진 줄에 25장, 2025-01-13·2025-04-18·2025-11-03에 노란 표시 "(자동 뒤집음)".
- 고품질·1.2초·글씨 켬으로 만들기 → 진행 막대가 3단계로 움직이고 이 맥에서 3분 이내 완료.
- 결과 영상 재생, 글씨 "시작 → 2개월 → … → 3년"이 보이고, MP4 저장 파일 이름 `임희진_교정진행.mp4`.
- 내려받은 MP4를 `ffprobe`로 확인: h264, 1152x770, fps≈53, 길이 ≈ 24×1.2+1 = 29.8초.
- 취소 버튼: 중간 그림 단계에서 누르면 "취소했습니다." 표시, 사진 줄 유지.
- 사진 1장만 넣으면 만들기 버튼 비활성.

- [ ] **Step 5: 커밋**

```bash
git add motion/index.html motion/js/main.js index.html sitemap.xml
git commit -m "motion: 교정 진행 영상 화면(index.html, main.js), 첫 화면 링크

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: 검사 마무리와 문서

**Files:**
- Modify: `README.md` (도구 목록에 한 줄), `docs/superpowers/specs/2026-09-20-motion-tool-design.md` (상태 줄을 "구현 완료, 공개 대기"로)
- Create: `motion/README.md` (원장·회원용 사용법 10줄)

- [ ] **Step 1: 전체 시험 실행**

Run: `node --test motion/test/` → 전부 pass.

- [ ] **Step 2: 맥 결과와 비교**

Task 9 Step 4에서 받은 MP4와 `/Users/eumtmj/이음랩/rife/진행영상_미세.mp4`를 SendUserFile로 나란히 원장에게 보여 준다. 차이점(ORB vs SIFT, 프레임 수)을 한 줄로 적는다.

- [ ] **Step 3: 사파리 확인**

이 맥의 사파리로 `http://localhost:<port>/motion/`을 열어(computer-use로 Safari 실행 또는 원장에게 부탁) 2장으로 만들기 → "빠른 방식" 안내와 WebM 저장이 되는지 확인. 안 되면 오류 문구가 사용자에게 보이는지 확인.

- [ ] **Step 4: 문서**

`motion/README.md`:
```md
# 교정 진행 영상 (caseframe.kr/motion)

같은 방향으로 찍은 교정 사진을 넣으면 치아가 움직이는 영상(MP4)을 만듭니다.
사진은 컴퓨터 밖으로 나가지 않습니다. 크롬·엣지에서 쓰세요.

1. 같은 방향 사진만 골라 끌어다 놓습니다(최대 40장). 파일 이름에 날짜(20230724 형식)가 있으면 자동 정렬됩니다.
2. 뒤집힌 사진은 자동으로 바로잡고 노란 표시를 붙입니다. 틀렸으면 ⇄ 버튼으로 되돌리세요.
3. 품질(고품질/빠르게), 한 단계 시간, 경과 글씨를 고르고 "영상 만들기"를 누릅니다.
4. 25장 기준 보통 2~5분 걸립니다. 끝나면 화면에서 재생되고 MP4로 저장할 수 있습니다.

촬영 팁: 카메라 각도와 거리를 매번 비슷하게 맞추면 영상이 훨씬 매끄럽습니다.
```
README.md 도구 목록에 `- **교정 진행 영상** (/motion): 교정 진행 사진을 이어 붙여 치아가 움직이는 영상을 만듭니다.` 추가.

- [ ] **Step 5: 커밋**

```bash
git add README.md motion/README.md docs/superpowers/specs/2026-09-20-motion-tool-design.md
git commit -m "motion: 사용법 문서, 설계 상태 갱신

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 6: 원장 보고** — 한 일 / 달라지는 점 / 원장이 할 것(GitHub Desktop으로 푸시 → caseframe.kr/motion 확인) 형식으로. 진료실 윈도우 PC에서 시간 측정은 공개 후 원장이 한 번 해 보고 알려 주기로.
