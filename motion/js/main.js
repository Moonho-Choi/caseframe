import { loadFiles, monthsLabel, dateLabel, baseName } from './load.js';
import { toGray } from './features.js';
import { checkOrientation, flipImageData } from './orient.js';
import { chainTransforms, warpImage, alignedSize } from './align.js';
import { matchColors } from './color.js';
import { planTiming, aiLevelsFor, Rife, transition, imageToCHW, chwToImage } from './interp.js';
import { pickEncoder, Mp4Encoder, drawLabel, outputName } from './encode.js';
import { cvReady } from './cvready.js';

const $ = id => document.getElementById(id);
const state = { items: [], flags: [], status: [], cancelled: false, busy: false, loading: false };
const MAX = 40;
// RIFE 세션(21.6MB 모델 + GPU 버퍼)은 만들기를 누를 때마다 새로 올리면 그만큼씩 쌓인다.
// 한 번 만든 세션을 계속 돌려 쓰고, 추론이 고장난 경우에만 버린다.
let rifeCache = null;
// 이전 결과 영상의 object URL. 새 영상을 걸기 전에 풀어 주지 않으면 탭이 닫힐 때까지
// 수십 MB짜리 Blob이 그대로 붙잡혀 있다.
let lastUrl = null;
let lastName = '';                 // 저장 버튼이 쓸 파일 이름
let gpuLocked = false;             // WebGPU가 없어 품질을 "빠르게"로 고정한 경우
let uiState = 'empty';             // empty | ready | busy | done
let jobPct = 0;                    // 만들기 한 판 전체의 진행률(0~100)

// ── 알림(토스트) ───────────────────────────────────────────────
let toastTimer;
function toast(msg) {
  if (!msg) return;
  const t = $('toast');
  // 한 틱 안에 알림이 여러 번 뜨면(예: "40장까지만" 다음 곧바로 "비율이 달라") 뒤엣것이
  // 앞엣것을 지워 버려 사용자가 첫 알림을 못 본다. 아직 떠 있는 알림이 있으면 지우지 않고
  // 새 줄에 이어 붙이고, 타이머만 늘린다.
  t.textContent = t.classList.contains('show') ? `${t.textContent}\n${msg}` : msg;
  t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

// 만들기(make)가 도는 동안에는 사진 줄을 건드릴 수 없어야 한다. make()는 state.items를
// 통째로 읽어 T(변환 배열)와 길이를 맞춰 두는데, 그 사이에 한 장이라도 빼거나 순서를
// 바꾸면 T[i]가 엉뚱한 사진에 붙거나 아예 undefined가 되어 도중에 터진다.
function locked() { return state.busy || state.loading; }

// ── 상태 기계 ─────────────────────────────────────────────────
// empty: 사진 없음 / ready: 만들 수 있음 / busy: 만드는 중 / done: 영상 완성
function setState(s) {
  uiState = s;
  // 만들기 버튼은 조절판 안에 있고 저장 버튼은 따로 있다(v3 설계 §2). 만들기가
  // 저장으로 바뀌지 않으므로, 완성된 뒤에도 사진을 손보고 바로 다시 만들 수 있다.
  const mk = $('makeBtn');
  if (s === 'busy') {
    mk.textContent = `만드는 중 ${jobPct}%`; mk.disabled = true;
  } else {
    mk.textContent = '영상 만들기';
    mk.disabled = state.items.length < 2 || locked();
  }
  // 저장 버튼 두 개(조절판 결과 칸·영상 아래)는 같은 일을 하고 같이 켜지고 깜빡인다.
  const saves = [$('saveBtn'), $('saveBtn2')];
  const hasResult = !!(lastUrl && lastName);
  for (const b of saves) { b.classList.remove('pulse'); b.disabled = !hasResult; }
  if (s === 'done' && hasResult) {
    for (const b of saves) {
      void b.offsetWidth;                     // 같은 상태로 다시 들어와도 애니메이션이 돌도록
      b.classList.add('pulse');
    }
  }
  $('emptySheet').style.display = s === 'empty' ? '' : 'none';
  $('grid').style.display = s === 'done' ? 'none' : '';
  $('videoWrap').hidden = s !== 'done';
  $('cancel').disabled = s !== 'busy';
  document.body.classList.toggle('locked', locked());
  syncSettings();
}
function syncState() {
  if (state.busy) { setState('busy'); return; }
  if (uiState === 'done') { setState('done'); return; }
  setState(state.items.length ? 'ready' : 'empty');
}
// 사진 구성을 건드리면 화면에 걸린 영상은 더 이상 그 사진들의 결과가 아니다.
function leaveDone() { if (uiState === 'done') { uiState = 'ready'; progress(''); } }
function syncSettings() {
  const lock = locked();
  $('quality').disabled = gpuLocked || lock;
  $('step').disabled = lock;
  $('labelMode').disabled = lock;
  // 날짜 없는 사진이 섞여도 선택을 강제로 바꾸지 않는다. 그 사진 구간만 글씨 없이
  // 가고, 왜 비었는지는 작은 안내로 알린다 (v3 설계 §1).
  const noDate = state.items.reduce((n, it) => n + (it.date ? 0 : 1), 0);
  const note = $('labelNote');
  note.textContent = noDate ? `날짜 없는 사진 ${noDate}장은 글씨 없이 갑니다` : '';
  note.hidden = !noDate || $('labelMode').value === 'none';
}

// ── 진행 표시 ─────────────────────────────────────────────────
// 단계마다 i/n을 따로 세면 "만드는 중 54%"까지 올라갔다가 다음 단계에서 0%로 떨어진다.
// 만들기 한 판을 100으로 놓고 단계마다 몫을 정해, 그 안에서만 움직이게 한다.
// [시작 지점, 이 단계의 몫] — 합이 100이다.
const PHASE = {
  '구도 맞추는 중': [0, 15],
  '밝기·색 맞추는 중': [15, 5],
  '인공지능 모델 준비 중': [20, 0],
  '중간 그림 그리는 중': [20, 75],
  '영상 파일 만드는 중': [95, 5],
  '완료': [100, 0],
};
function progress(stage, i, n) {
  $('stageText').textContent = n ? `${stage} ${i}/${n}` : (stage || '');
  const slice = PHASE[stage];
  if (slice) {
    // 단계 순서가 정해져 있어도 되돌아가는 일이 없도록 지금까지의 최대값만 남긴다.
    jobPct = Math.max(jobPct, Math.min(100, Math.round(slice[0] + (n ? slice[1] * i / n : 0))));
    $('bar').firstElementChild.style.width = `${jobPct}%`;
  } else {
    // 사진 읽기·방향 검사는 만들기 전 단계라 그 단계만의 진행을 보여 준다.
    jobPct = 0;
    $('bar').firstElementChild.style.width = n ? `${Math.round(100 * i / n)}%` : '0%';
  }
  if (uiState === 'busy') $('makeBtn').textContent = `만드는 중 ${jobPct}%`;
}
// 남은 시간 = (경과 시간 / 처리한 프레임) × 남은 프레임, 10초마다 갱신 (설계 §3)
let runStart = 0, etaAt = 0;
function etaReset() { runStart = etaAt = (typeof performance !== 'undefined' ? performance.now() : Date.now()); $('eta').textContent = ''; }
function etaUpdate(done, total) {
  if (!done || done >= total) return;
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (now - etaAt < 10000) return;
  etaAt = now;
  const sec = Math.round((now - runStart) / done * (total - done) / 1000);
  const m = Math.floor(sec / 60), s = sec % 60;
  $('eta').textContent = m ? `남은 시간 약 ${m}분 ${s}초` : `남은 시간 약 ${s}초`;
}

// ── 사진 그리기 (격자와 사진 줄은 같은 state.items에서 그린다) ──
// 작은 그림은 만들 때마다 1280px 원본을 JPEG로 다시 짜내야 해서 40장이면 화살표 한
// 번에 1초씩 멈춘다. 사진에 붙여 두고 좌우를 뒤집을 때만 다시 만든다.
function thumbOf(it) {
  if (!it.thumb) {
    const c = document.createElement('canvas'); c.width = it.image.width; c.height = it.image.height;
    c.getContext('2d').putImageData(it.image, 0, 0);
    it.thumb = c.toDataURL('image/jpeg', 0.6);
  }
  return it.thumb;
}
// 격자 카드와 사진 줄이 같은 형식을 쓴다: `번호 · 2023-02-20` (v3 설계 §4).
// 날짜가 없는 사진은 파일 이름 앞토막으로 대신한다.
function captionOf(it, i) { return `${i + 1} · ${it.date ? dateLabel(it.date) : baseName(it.name)}`; }
function badgesFor(i) {
  const out = [], f = state.flags[i];
  if (f && f.warn === 'flip') out.push(['flip', '자동 뒤집음']);
  else if (f && f.warn === 'other') out.push(['other', '다른 방향?']);
  if (state.status[i] === 'fail') out.push(['fail', '구도 실패']);
  return out;
}
// 순서 바꾸기·파일 받기는 큰 카드와 작은 사진이 똑같이 동작한다.
function wireDrag(el, i, lock) {
  el.draggable = !lock;
  el.ondragstart = e => { if (lock) { e.preventDefault(); return; } e.dataTransfer.setData('text/plain', String(i)); };
  el.ondragover = e => e.preventDefault();
  // 운영체제에서 끌어온 파일은 text/plain이 빈 문자열이라 +'' === 0이 되고, 예전에는
  // 그게 moveTo(0, i)로 해석되어 사진 1이 슬쩍 옮겨지고 끌어온 파일은 사라졌다.
  // 파일이 실려 있으면 순서 바꾸기가 아니라 "사진 추가"로 보낸다.
  el.ondrop = e => {
    e.preventDefault(); e.stopPropagation(); endDrag();
    if (e.dataTransfer.files && e.dataTransfer.files.length) { addFiles(e.dataTransfer.files); return; }
    const from = +e.dataTransfer.getData('text/plain');
    if (!Number.isInteger(from) || from < 0 || from >= state.items.length) return;
    moveTo(from, i);
  };
}
function btnRow(i, lock, defs) {
  const b = document.createElement('div'); b.className = 'btns';
  for (const [t, title, fn] of defs) {
    const x = document.createElement('button');
    x.textContent = t; x.title = title; x.setAttribute('aria-label', title); x.onclick = ev => { ev.stopPropagation(); fn(); }; x.disabled = lock;
    b.appendChild(x);
  }
  return b;
}
function renderGrid() {
  const g = $('grid'); g.innerHTML = '';
  const lock = locked();
  state.items.forEach((it, i) => {
    const d = document.createElement('div'); d.className = 'card';
    if (state.status[i] === 'fail') d.classList.add('fail');
    d.title = it.name;
    const img = document.createElement('img'); img.src = thumbOf(it); img.alt = it.name; d.appendChild(img);
    const no = document.createElement('div'); no.className = 'num';
    no.textContent = captionOf(it, i);
    d.appendChild(no);
    const bl = badgesFor(i);
    if (bl.length) {
      const wrap = document.createElement('div'); wrap.className = 'badges';
      for (const [cls, text] of bl) { const s = document.createElement('span'); s.className = `badge ${cls}`; s.textContent = text; wrap.appendChild(s); }
      d.appendChild(wrap);
    }
    d.appendChild(btnRow(i, lock, [
      ['◀', '앞으로 옮기기', () => move(i, -1)],
      ['▶', '뒤로 옮기기', () => move(i, 1)],
      ['⇄', '좌우 뒤집기', () => flip(i)],
      ['✕', '빼기', () => remove(i)],
    ]));
    wireDrag(d, i, lock);
    g.appendChild(d);
  });
}
function renderStrip() {
  const list = $('assetList');
  [...list.querySelectorAll('.asset')].forEach(el => el.remove());
  $('assetEmpty').style.display = state.items.length ? 'none' : '';
  const lock = locked();
  state.items.forEach((it, i) => {
    const d = document.createElement('div'); d.className = 'asset';
    const f = state.flags[i];
    if (f && f.warn === 'flip') d.classList.add('warn-flip');
    if (f && f.warn === 'other') d.classList.add('warn-other');
    if (state.status[i] === 'fail') d.classList.add('fail');
    d.title = `${i + 1}. ${it.name}`;
    const img = document.createElement('img'); img.src = thumbOf(it); img.alt = it.name; d.appendChild(img);
    const no = document.createElement('div'); no.className = 'no'; no.textContent = captionOf(it, i); d.appendChild(no);
    const bl = badgesFor(i);
    if (bl.length) {
      const tags = document.createElement('div'); tags.className = 'tags';
      bl.forEach(([cls, text], k) => {
        const sp = document.createElement('span'); sp.className = cls; sp.textContent = (k ? ' · ' : '') + text;
        tags.appendChild(sp);
      });
      d.appendChild(tags);
    }
    d.appendChild(btnRow(i, lock, [
      ['⇄', '좌우 뒤집기', () => flip(i)],
      ['✕', '빼기', () => remove(i)],
    ]));
    wireDrag(d, i, lock);
    list.appendChild(d);
  });
}
function render() { renderGrid(); renderStrip(); syncState(); }

// state.status(정합 성공/실패 표시)는 chainTransforms가 채운 배열이라 items/flags와
// 길이·순서가 항상 같아야 한다. 어긋나면(예: 아직 한 번도 만들기를 안 돌렸거나, 다른
// 조작으로 길이가 안 맞으면) 통째로 비워서 엉뚱한 사진에 회색 "구도 실패" 표시가
// 붙는 사고를 막는다 — 어차피 사진 구성이 바뀌면 다시 만들기를 눌러야 최신 상태가 된다.
function move(i, d) { moveTo(i, i + d); }
function moveTo(from, to) {
  if (locked()) return;
  if (to < 0 || to >= state.items.length || from === to) return;
  if (state.status.length === state.items.length) { const [st] = state.status.splice(from, 1); state.status.splice(to, 0, st); }
  else state.status = [];
  const [it] = state.items.splice(from, 1); state.items.splice(to, 0, it);
  const [f] = state.flags.splice(from, 1); state.flags.splice(to, 0, f);
  leaveDone(); render();
}
function flip(i) {
  if (locked()) return;
  state.items[i].image = flipImageData(state.items[i].image); state.items[i].thumb = null; state.flags[i] = { warn: null };
  // 사용자가 직접 정한 방향은 나중에 사진을 더 넣어도 자동 판정이 뒤엎지 않는다.
  state.items[i].userFlipped = true;
  state.status = []; // 뒤집으면 이전 정합 결과가 더 이상 맞지 않는다
  leaveDone(); render();
}
function remove(i) {
  if (locked()) return;
  if (state.status.length === state.items.length) state.status.splice(i, 1);
  else state.status = [];
  state.items.splice(i, 1); state.flags.splice(i, 1);
  leaveDone(); render();
}

async function addFiles(files) {
  if (locked()) { toast('영상을 만드는 중에는 사진을 넣을 수 없습니다. 취소 후 넣어 주세요.'); return; }
  state.loading = true; leaveDone(); render();
  let grays = null;
  try {
    const arr = [...files];
    const remain = MAX - state.items.length;
    if (remain <= 0) { toast('이미 40장이 있어 더 넣을 수 없습니다.'); return; }
    const list = arr.slice(0, remain);
    if (arr.length > list.length) toast(`한 번에 ${MAX}장까지만 넣을 수 있어 앞 ${list.length}장만 받았습니다.`);
    progress('사진 읽는 중');
    const { items, skipped } = await loadFiles(list, 1280);
    if (skipped.length) toast(`읽지 못한 파일 ${skipped.length}개(HEIC 등): JPG로 바꿔 넣어 주세요. ` + skipped.slice(0, 3).join(', '));
    if (state.items.length && items.length && (items[0].image.width !== state.items[0].image.width || items[0].image.height !== state.items[0].image.height)) { toast('앞서 넣은 사진과 비율이 달라 넣지 못했습니다. 한 번에 넣어 주세요.'); return; }
    state.items.push(...items); state.flags.push(...items.map(() => ({ warn: null })));
    state.status = [];
    const cv = await cvReady();
    progress('방향 검사 중');
    // toGray가 도중에 터져도 그때까지 만든 Mat이 finally에서 풀리도록 하나씩 담는다
    // (map으로 한 번에 만들면 예외가 나는 순간 grays는 아직 null이라 전부 샌다).
    grays = [];
    for (const it of state.items) grays.push(toGray(cv, it.image));
    const W = state.items[0].image.width;
    const res = await checkOrientation(cv, grays, W, (i, n) => progress('방향 검사 중', i, n));
    grays.forEach(g => g.delete()); grays = null;
    applyOrientation(res, state.items.length - items.length);
  } catch (e) {
    toast('오류: ' + (e.message || e));
  } finally {
    if (grays) { grays.forEach(g => g.delete()); grays = null; }
    state.loading = false;
    progress(''); render();
  }
}

// 방향 판정은 사진 전체를 한 사슬로 이어 붙여야 정확해서 매번 전부 다시 잰다. 하지만
// 결과를 전부에 적용하면, 사진 한 장 더 넣었을 뿐인데 사용자가 ⇄로 고쳐 둔 사진이
// 도로 뒤집히고(기준 방향의 부호가 바뀌면 전혀 다른 묶음이 뒤집힌다) 아무 설명도 없다.
// 그래서 판정은 "이번에 새로 들어온 사진"에만 적용하고, 이미 화면에 있던 사진은
// 사용자가 본 그대로 둔다. 다만 이번 투표에서 기준 방향이 지난번과 반대로 잡혔다면
// (= 기존 사진 과반이 "뒤집어라"로 나오면) 새 사진에는 부호를 되돌려 적용해야
// 기존 사진들과 같은 방향이 된다.
function applyOrientation(res, prevCount) {
  let flipVotes = 0;
  for (let i = 0; i < prevCount; i++) if (res[i].flip) flipVotes++;
  const opposite = prevCount > 0 && flipVotes * 2 > prevCount;
  res.forEach((r, i) => {
    if (i < prevCount || state.items[i].userFlipped) return;
    const doFlip = opposite ? !r.flip : r.flip;
    if (doFlip) { state.items[i].image = flipImageData(state.items[i].image); state.items[i].thumb = null; }
    state.flags[i] = { warn: doFlip ? 'flip' : (r.warn === 'other' ? 'other' : null) };
  });
}

async function make() {
  if (state.busy || state.loading) return;
  state.busy = true; state.cancelled = false;
  uiState = 'ready';                 // 이전 결과 화면은 내려 두고 격자를 보여 준다
  jobPct = 0; $('eta').textContent = '';
  // 잠금 표시는 여기서 바로 그려야 한다. 예전에는 chainTransforms가 끝난 뒤에야
  // renderStrip()이 불려서, 제일 오래 걸리는 "구도 맞추는 중" 내내 ◀▶⇄✕ 버튼이
  // 그대로 눌렸다 — H1이 막으려던 바로 그 구간이 열려 있었다.
  render();
  const cancelled = () => state.cancelled;
  let grays = null, enc = null, rife = null;
  try {
    const cv = await cvReady();
    const W = state.items[0].image.width, H = state.items[0].image.height;
    grays = [];
    for (const it of state.items) grays.push(toGray(cv, it.image));
    const { T, status } = await chainTransforms(cv, grays, W, H, (i, n) => progress('구도 맞추는 중', i, n), cancelled);
    grays.forEach(g => g.delete()); grays = null; state.status = status; render();
    if (cancelled()) throw new Error('취소');
    progress('밝기·색 맞추는 중');
    const aligned = await matchColors(state.items.map((it, i) => warpImage(cv, it.image, T[i], W, H)), (i, n) => progress('밝기·색 맞추는 중', i, n), cancelled);
    const { cw, ch } = alignedSize(W, H);
    const stepSec = +$('step').value, { N, fps } = planTiming(stepSec);
    const quality = $('quality').value;
    progress('인공지능 모델 준비 중');
    const ort = await import('../../vendor/ort/ort.webgpu.min.mjs'); ort.env.wasm.wasmPaths = '/vendor/ort/';
    if (!rifeCache) rifeCache = await Rife.create(ort, '/motion/models/rife_fp32.onnx');
    rife = rifeCache;
    const aiLevels = rife ? aiLevelsFor(quality, N) : 0;
    if (!pickEncoder()) throw new Error('이 브라우저는 영상 저장을 지원하지 않습니다. 크롬이나 엣지를 써 주세요.');
    const canvas = document.createElement('canvas'); canvas.width = cw; canvas.height = ch; const ctx = canvas.getContext('2d');
    const Mp4Muxer = await import('../../vendor/mp4-muxer.mjs');
    enc = await Mp4Encoder.create(Mp4Muxer, cw, ch, fps);
    // 글씨는 처음 고른 대로 한 벌만 만든다(미리보기 = 저장 파일). 날짜가 없는 사진은
    // 어느 쪽을 골랐든 그 구간만 글씨 없이 간다 (v3 설계 §1).
    const labelMode = $('labelMode').value;
    const firstDated = state.items.find(it => it.date);
    const labels = state.items.map(it => {
      if (labelMode === 'none' || !it.date || !firstDated) return '';
      return labelMode === 'date' ? dateLabel(it.date) : monthsLabel(firstDated.date, it.date);
    });
    // CHW(float32 3채널) 한 장은 1152×768 기준 약 10.6MB다. 40장을 한꺼번에 만들면
    // 그것만 425MB이고 원본·정렬본까지 같이 살아 있어 진료실 PC가 버티지 못한다.
    // 필요한 순간에 만들고(i, i+1 두 장만 살려 둔다) 쓴 것은 바로 버린다.
    const n = aligned.length;
    const chwCache = new Map();
    const chwAt = k => {
      let v = chwCache.get(k);
      if (!v) { v = imageToCHW(aligned[k]); chwCache.set(k, v); aligned[k] = null; }
      return v;
    };
    let idx = 0; const total = (n - 1) * N + Math.round(fps);
    etaReset();
    for (let i = 0; i < n - 1; i++) {
      await transition(chwAt(i), chwAt(i + 1), cw, ch, N, aiLevels, rife, async f => {
        ctx.putImageData(chwToImage(f, cw, ch), 0, 0); drawLabel(ctx, labels[i], cw);
        await enc.addFrame(canvas, idx++);
        progress('중간 그림 그리는 중', idx, total);
        etaUpdate(idx, total);
        // 인공지능 없이(단순 겹치기) 돌 때는 이 안쪽이 전부 마이크로태스크라 화면이 한 번도
        // 다시 그려지지 않는다 — 진행 표시도 안 보이고 취소 클릭조차 전달되지 않았다.
        // 8장마다 한 틱 양보해 브라우저가 화면을 그리고 클릭을 처리할 틈을 준다.
        if (idx % 8 === 0) await new Promise(r => setTimeout(r, 0));
      }, cancelled);
      chwCache.delete(i);
      if (cancelled()) throw new Error('취소');
    }
    ctx.putImageData(chwToImage(chwAt(n - 1), cw, ch), 0, 0); drawLabel(ctx, labels[labels.length - 1], cw);
    for (let k = 0; k < Math.round(fps); k++) await enc.addFrame(canvas, idx++);
    progress('영상 파일 만드는 중');
    const blob = await enc.finish();
    if (lastUrl) URL.revokeObjectURL(lastUrl);
    const url = URL.createObjectURL(blob); lastUrl = url;
    $('video').src = url;
    // 인공지능이 돌지 않아 단순 겹치기로 만들었으면 파일 이름도 "단순"으로 남긴다.
    const usedQuality = (!rife || rife.failed) ? 'none' : quality;
    lastName = outputName(state.items[0].name, 'mp4', usedQuality, new Date());
    showResult(total / fps, cw, ch, blob.size, lastName, usedQuality === 'none');
    $('eta').textContent = '';
    uiState = 'done'; progress('완료', total, total);
  } catch (e) { toast(e.message === '취소' ? '취소했습니다.' : '오류: ' + (e.message || e)); progress(''); $('eta').textContent = ''; }
  finally {
    if (grays) { grays.forEach(g => g.delete()); grays = null; }
    // 오류·취소로 빠져나온 경우에도 인코더는 반드시 닫는다(성공 경로에서는 이미 닫혀 있다).
    if (enc && enc.abort) enc.abort();
    // 추론이 고장난 세션은 캐시에서 버리고 GPU 자원을 돌려준다.
    if (rife && rife.failed) { try { rife.release(); } catch (e) { /* 무시 */ } if (rifeCache === rife) rifeCache = null; }
    state.busy = false;
    render();
  }
}

function showResult(sec, w, h, bytes, name, simple) {
  const box = $('resultInfo'); box.textContent = '';
  const lines = [
    ['길이 ', `${sec.toFixed(1)}초`],
    ['해상도 ', `${w}×${h}`],
    ['크기 ', `${(bytes / 1048576).toFixed(1)} MB`],
    ['파일 이름 ', name],
  ];
  for (const [k, v] of lines) {
    const d = document.createElement('div');
    d.append(k);
    const b = document.createElement('b'); b.textContent = v; d.appendChild(b);
    box.appendChild(d);
  }
  if (simple) {
    const d = document.createElement('div');
    d.textContent = '이 컴퓨터에서는 빠른 방식(단순 겹치기)으로 만들었습니다.';
    box.appendChild(d);
  }
}

// ── 저장·다시 만들기·비우기 ────────────────────────────────────
function save() {
  if (!lastUrl || !lastName) { toast('아직 저장할 영상이 없습니다.'); return; }
  const a = document.createElement('a');
  a.href = lastUrl; a.download = lastName; a.style.display = 'none';
  document.body.appendChild(a); a.click(); a.remove();
  toast('저장됨: ' + lastName);
}
function remake() { $('video').pause(); uiState = 'ready'; progress(''); render(); }
function clearAll() {
  if (locked()) return;
  state.items = []; state.flags = []; state.status = [];
  if (lastUrl) { URL.revokeObjectURL(lastUrl); lastUrl = null; }
  lastName = '';
  // src=''로 지우면 브라우저가 페이지 주소를 영상으로 다시 받으러 간다. 속성을 떼고 비운다.
  $('video').removeAttribute('src'); $('video').load();
  $('resultInfo').textContent = '아직 만든 영상이 없습니다.';
  progress(''); $('eta').textContent = '';
  uiState = 'empty'; render();
  toast('비웠습니다');
}

// ── 전체 화면 ─────────────────────────────────────────────────
// 페이지 전체를 띄우면 위쪽 막대·조절판·사진 줄까지 같이 커져서 정작 보고 싶은
// 것이 작게 남는다. 영상이 있으면 영상만, 없으면 사진 격자만 띄운다 (v3 설계 §3).
function fsTarget() {
  const v = $('video');
  return (uiState === 'done' && v.getAttribute('src')) ? v : $('stage');
}
function toggleFs() {
  if (document.fullscreenElement) { document.exitFullscreen(); return; }
  const el = fsTarget();
  if (!el.requestFullscreen) { toast('전체화면을 사용할 수 없습니다'); return; }
  const p = el.requestFullscreen();
  if (p && p.catch) p.catch(() => toast('전체화면을 사용할 수 없습니다'));
}
// Esc로 빠져나와도 버튼 글씨가 맞아야 해서 이벤트로 맞춘다.
function syncFsLabel() {
  const on = !!document.fullscreenElement;
  $('bFs').textContent = on ? '전체화면 해제' : '전체화면';
  $('bFs').title = on ? '전체화면 해제 (F)' : '전체화면 (F)';
}
document.addEventListener('fullscreenchange', syncFsLabel);

// ── 화면 어디에 떨어뜨려도 사진 추가 ───────────────────────────
// 사진 줄이나 격자 밖(조절판·여백·배경)에 떨어뜨리면 브라우저 기본 동작으로 그 파일
// 주소로 이동해 버려 작업하던 사진이 전부 날아간다. 창 전체에서 기본 동작을 막는다.
let dragDepth = 0;
function hasFiles(e) { return [...(e.dataTransfer?.types || [])].includes('Files'); }
function endDrag() { dragDepth = 0; document.body.classList.remove('drag'); }
window.addEventListener('dragenter', e => {
  e.preventDefault();
  if (!hasFiles(e) || locked()) return;
  dragDepth++; document.body.classList.add('drag');
});
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('dragleave', e => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove('drag');
});
// 카드·사진에 떨어진 경우는 그쪽에서 stopPropagation 하므로, 덮개는 캡처 단계에서 내린다.
window.addEventListener('drop', endDrag, true);
window.addEventListener('drop', e => {
  e.preventDefault(); endDrag();
  if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
});

// ── 연결 ─────────────────────────────────────────────────────
$('makeBtn').onclick = make;
$('saveBtn').onclick = save;
$('saveBtn2').onclick = save;
$('remakeBtn').onclick = remake;
$('clearBtn').onclick = clearAll;
$('cancel').onclick = () => { state.cancelled = true; };
$('bOpen').onclick = () => { if (!locked()) $('file').click(); };
$('file').onchange = e => { addFiles(e.target.files); e.target.value = ''; };
$('emptySheet').onclick = () => { if (!locked()) $('file').click(); };
$('emptySheet').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (!locked()) $('file').click(); } });
$('bFs').onclick = toggleFs;
$('step').oninput = () => { $('stepv').textContent = `${$('step').value}초`; };
$('labelMode').onchange = syncSettings;
const brandHome = $('brandHome');
brandHome.addEventListener('click', () => { location.href = '/'; });
brandHome.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); location.href = '/'; } });
window.addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
  if (e.key === 'f' || e.key === 'F') { e.preventDefault(); toggleFs(); }
});

// M8: 인공지능(RIFE)은 WebGPU가 있어야 돈다. 예전에는 만들기를 누르고 몇 분 지난
// 뒤에야 "빠른 방식으로 만들었습니다"라고 알려 줬다. 화면을 열 때 미리 확인해서
// 품질을 "빠르게"로 고정하고 이유를 그 자리에 적어 둔다.
if (typeof navigator === 'undefined' || !navigator.gpu) {
  gpuLocked = true;
  $('quality').value = 'fast';
  $('gpunote').textContent = '이 컴퓨터는 인공지능 그림을 쓸 수 없어 "빠르게"로 고정됩니다.';
  $('gpunote').hidden = false;
}

syncFsLabel();
render();
