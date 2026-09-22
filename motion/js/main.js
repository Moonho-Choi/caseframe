import { loadFiles, sortItems, monthsLabel, dateLabel, baseName } from './load.js';
import { toGray, compose } from './features.js';
import { checkOrientation, flipImageData } from './orient.js';
import { chainTransforms, warpImage, alignedSize, cropRect, adjustMatrix, DEFAULT_ADJUST, neighborScores, scoreVectors, pairScore } from './align.js';
import { pickSmooth, percentile } from './select.js';
import { matchColors } from './color.js';
import { planTiming, aiLevelsFor, Rife, transition, imageToCHW, chwToImage } from './interp.js';
import { pickEncoder, Mp4Encoder, drawLabel, drawTitle, outputName } from './encode.js';
import { cvReady } from './cvready.js';

const $ = id => document.getElementById(id);
// cache: 각도 검사에서 얻은 구도 맞추기 결과({ key, T, status }). 제일 오래 걸리는 단계라
//        영상 만들기가 그대로 이어받는다 (각도 검사 설계 §4). 기준 틀 사진은 담지 않는다 —
//        수동 맞춤이 바뀔 때마다 낡아 버리므로 필요할 때 warpImage로 다시 만든다
//        (25장 1~2초, 수동 맞춤 설계 §1).
// angle:  각도 검사 결과({ scores, threshold, median, flagged:Set }).
// job:    지금 도는 일 — 'make'(영상 만들기) 또는 'check'(각도 검사). 버튼 글씨·진행 몫이 다르다.
const state = { items: [], flags: [], status: [], cancelled: false, busy: false, loading: false, cache: null, angle: null, job: 'make' };
const MAX = 40;
const MIN_CHECK = 2;               // 2장이면 구도만 맞추고(수동 맞춤용), 배지는 3장부터 (원장 소감 09-22)
// RIFE 세션(21.6MB 모델 + GPU 버퍼)은 만들기를 누를 때마다 새로 올리면 그만큼씩 쌓인다.
// 한 번 만든 세션을 계속 돌려 쓰고, 추론이 고장난 경우에만 버린다.
let rifeCache = null;
// 이전 결과 영상의 object URL. 새 영상을 걸기 전에 풀어 주지 않으면 탭이 닫힐 때까지
// 수십 MB짜리 Blob이 그대로 붙잡혀 있다.
let lastUrl = null;
let lastName = '';                 // 저장 버튼이 쓸 파일 이름
let gpuLocked = false;             // WebGPU가 없어 품질을 "빠르게"로 고정한 경우
let uiState = 'empty';             // empty | ready | busy | done | view(크게 보기)
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

// ── 제외한 사진 ───────────────────────────────────────────────
// 빼기(✕)를 눌러도 목록에서 없애지 않고 excluded 표시만 붙인다. 그래야 그 자리에 그대로
// 남아 넣기(↩)로 되돌릴 수 있다 (제외 설계 §2).
// 영상 만들기·각도 검사·방향 검사는 이 "포함된 사진"만 받는다. 원래 자리(i)를 함께 들고
// 다녀야 결과 배지(구도 실패·이웃과 많이 다름)가 엉뚱한 사진에 붙지 않는다.
function activeItems() { return state.items.map((it, i) => ({ it, i })).filter(x => !x.it.excluded); }
function activeCount() { return state.items.reduce((n, it) => n + (it.excluded ? 0 : 1), 0); }
// 포함된 사진만큼 나온 결과(구도 성공/실패, 겹침 점수)를 원본 길이 배열로 되돌린다.
// 제외한 자리는 null이라 어떤 배지도 붙지 않는다.
function spread(arr, active) {
  const out = new Array(state.items.length).fill(null);
  active.forEach((x, k) => { out[x.i] = arr[k]; });
  return out;
}

// ── 상태 기계 ─────────────────────────────────────────────────
// empty: 사진 없음 / ready: 만들 수 있음 / busy: 만드는 중 / done: 영상 완성
function setState(s) {
  uiState = s;
  // 만들기 버튼은 조절판 안에 있고 저장 버튼은 따로 있다(v3 설계 §2). 만들기가
  // 저장으로 바뀌지 않으므로, 완성된 뒤에도 사진을 손보고 바로 다시 만들 수 있다.
  const mk = $('makeBtn'), ck = $('checkBtn'), pk = $('pickBtn');
  if (s === 'busy') {
    // 각도 검사·부드럽게 고르기도 같은 잠금·진행 틀을 쓰므로, 지금 도는 일 쪽 버튼에만 퍼센트를 적는다.
    mk.textContent = state.job === 'make' ? `만드는 중 ${jobPct}%` : '영상 만들기';
    ck.textContent = state.job === 'check' ? `검사 중 ${jobPct}%` : '각도 검사';
    pk.textContent = state.job === 'pick' ? `고르는 중 ${jobPct}%` : '부드럽게 고르기';
    mk.disabled = ck.disabled = pk.disabled = true;
  } else {
    // 제외한 사진은 영상에 들어가지 않으므로 버튼을 켤지 말지도 "포함된 장수"로 센다 (제외 설계 §2).
    const on = activeCount();
    mk.textContent = '영상 만들기';
    mk.disabled = on < 2 || locked();
    // 검사 결과(구도 캐시 + 겹침 점수)가 아직 유효하면 눌러도 같은 결과라 "검사 완료"로
    // 잠근다. 새 사진·순서·뒤집기·수동 맞춤으로 결과가 낡으면 다시 켜진다 (원장 소감 09-22).
    const fresh = !!state.angle && !!state.cache && state.cache.key === cacheKey();
    ck.textContent = fresh ? '검사 완료' : '각도 검사';
    ck.disabled = on < MIN_CHECK || locked() || fresh;
    pk.textContent = '부드럽게 고르기';
    pk.disabled = pickCandidates().length < 3 || locked();
  }
  // 저장 버튼 두 개(조절판 결과 칸·영상 아래)는 같은 일을 하고 같이 켜지고 깜빡인다.
  // 만드는 중에는 화면에 걸린 영상이 곧 갈아치워질 이전 판이라 저장을 막는다.
  const saves = [$('saveBtn'), $('saveBtn2')];
  const hasResult = !!(lastUrl && lastName) && !state.busy;
  for (const b of saves) { b.classList.remove('pulse'); b.disabled = !hasResult; }
  if (s === 'done' && hasResult) {
    for (const b of saves) {
      void b.offsetWidth;                     // 같은 상태로 다시 들어와도 애니메이션이 돌도록
      b.classList.add('pulse');
    }
  }
  $('emptySheet').style.display = s === 'empty' ? '' : 'none';
  $('grid').style.display = (s === 'done' || s === 'view') ? 'none' : '';
  $('videoWrap').hidden = s !== 'done';
  // 크게 보기는 영상 화면과 같은 자리를 쓴다 — 둘이 함께 보이는 일은 없다 (회전 설계 §2).
  $('viewer').hidden = s !== 'view';
  $('cancel').disabled = s !== 'busy';
  document.body.classList.toggle('locked', locked());
  syncSettings();
  if (s === 'view') syncViewer();
}
function syncState() {
  if (state.busy) { setState('busy'); return; }
  // 사진이 한 장도 없으면(전부 비우기) 크게 보기를 유지할 수 없다.
  if (uiState === 'view' && state.items[viewIdx]) { setState('view'); return; }
  if (uiState === 'view') viewIdx = -1;
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
  $('title').disabled = lock;
  $('sortBtn').disabled = lock || state.items.length < 2;
  $('pickLevel').disabled = lock;
  // 날짜 없는 사진이 섞여도 선택을 강제로 바꾸지 않는다. 그 사진 구간만 글씨 없이
  // 가고, 왜 비었는지는 작은 안내로 알린다 (v3 설계 §1).
  const noDate = state.items.reduce((n, it) => n + (it.date || it.excluded ? 0 : 1), 0);
  const note = $('labelNote');
  note.textContent = noDate ? `날짜 없는 사진 ${noDate}장은 글씨 없이 갑니다` : '';
  note.hidden = !noDate || $('labelMode').value === 'none';
}

// ── 진행 표시 ─────────────────────────────────────────────────
// 단계마다 i/n을 따로 세면 "만드는 중 54%"까지 올라갔다가 다음 단계에서 0%로 떨어진다.
// 만들기 한 판을 100으로 놓고 단계마다 몫을 정해, 그 안에서만 움직이게 한다.
// [시작 지점, 이 단계의 몫] — 합이 100이다.
const PHASE_MAKE = {
  '구도 맞추는 중': [0, 15],
  '밝기·색 맞추는 중': [15, 5],
  '인공지능 모델 준비 중': [20, 0],
  '중간 그림 그리는 중': [20, 75],
  '영상 파일 만드는 중': [95, 5],
  '완료': [100, 0],
};
// 각도 검사는 두 단계뿐이라 만들기의 몫을 그대로 쓰면 막대가 15%에서 멈춘 것처럼 보인다.
const PHASE_CHECK = {
  '구도 맞추는 중': [0, 80],
  '겹침 점수 계산 중': [80, 20],
  '완료': [100, 0],
};
let phases = PHASE_MAKE;           // 지금 도는 일의 단계 몫
function progress(stage, i, n) {
  $('stageText').textContent = n ? `${stage} ${i}/${n}` : (stage || '');
  const slice = phases[stage];
  if (slice) {
    // 단계 순서가 정해져 있어도 되돌아가는 일이 없도록 지금까지의 최대값만 남긴다.
    jobPct = Math.max(jobPct, Math.min(100, Math.round(slice[0] + (n ? slice[1] * i / n : 0))));
    $('bar').firstElementChild.style.width = `${jobPct}%`;
  } else {
    // 사진 읽기·방향 검사는 만들기 전 단계라 그 단계만의 진행을 보여 준다.
    jobPct = 0;
    $('bar').firstElementChild.style.width = n ? `${Math.round(100 * i / n)}%` : '0%';
  }
  if (uiState === 'busy') {
    if (state.job === 'check') $('checkBtn').textContent = `검사 중 ${jobPct}%`;
    else $('makeBtn').textContent = `만드는 중 ${jobPct}%`;
  }
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

// ── 사진 한 장 다시 만들기 (뒤집기) ───────────────────────────
// 사진 한 장은 이렇게 적어 둔다 (수동 맞춤 설계 §1).
//   it.original — 읽은 직후의 ImageData. 절대 손대지 않는다.
//   it.flipped  — 좌우 뒤집힘(자동 판정 + 사용자 ⇄의 최종 상태)
//   it.adjust   — 수동 맞춤 { scale, rotation, dx, dy }. 사진 픽셀은 건드리지 않고
//                 구도 맞추기 변환 위에 덧붙는 값이다(영상·각도 검사에만 반영).
// it.image(표시·계산용)는 언제나 original에서 다시 만든다. 예전처럼 image를 그때그때
// 덮어쓰면 고칠수록 다시 표본한 그림이 쌓여 화질이 깎인다.
function degLabel(deg) { return `${deg > 0 ? '+' : deg < 0 ? '-' : ''}${Math.abs(deg).toFixed(2)}°`; }
function canvasOf(image) {
  const c = document.createElement('canvas'); c.width = image.width; c.height = image.height;
  c.getContext('2d').putImageData(image, 0, 0);
  return c;
}
// 뒤집지 않았으면 original을 그대로 가리킨다(사진 한 장이 4.4MB라 사본을 하나 덜
// 만든다). 그래서 it.image의 픽셀을 그 자리에서 고치면 안 된다 — 고칠 일이 있으면
// 여기서 새로 만든다.
function rebuildImage(it) {
  it.image = it.flipped ? flipImageData(it.original) : it.original;
  it.thumb = null;
}

// ── 수동 맞춤 값 ──────────────────────────────────────────────
// 자동 구도 맞추기가 어긋난 사진을 원장이 손으로 맞추는 값이다. 기본값이면 "손질 없음".
function newAdjust() { return { ...DEFAULT_ADJUST }; }
function adjustOf(it) { if (!it.adjust) it.adjust = newAdjust(); return it.adjust; }
function isAdjusted(it) {
  const a = it.adjust;
  return !!a && (a.scale !== 1 || a.rotation !== 0 || a.dx !== 0 || a.dy !== 0);
}
function resetAdjust(it) { it.adjust = newAdjust(); }
// 최종 변환 = 자동 구도 맞추기(T) 뒤에 손 보정. 영상·각도 검사·맞춤 화면이 모두 이것을 쓴다.
function finalT(it, T) { return compose(adjustMatrix(it.adjust, it.image.width, it.image.height), T); }

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
// 번호는 넣을 때 한 번 정해진 it.no다. 순서를 바꿔도 따라 바뀌지 않아야 원장이 무엇을
// 옮겼는지 알 수 있다 (고정 번호 설계 §3) — 자리(i)로 세지 않는다.
function captionOf(it) { return `${it.no} · ${it.date ? dateLabel(it.date) : baseName(it.name)}`; }
// [CSS 이름, 글씨, 마우스를 올렸을 때 설명(없으면 빈 값)]. 여러 개가 함께 붙을 수 있다.
function badgesFor(i) {
  const out = [], f = state.flags[i];
  if (state.items[i].excluded) out.push(['excluded', '제외', '영상에 넣지 않습니다. ↩로 다시 넣을 수 있습니다']);
  if (f && f.warn === 'flip') out.push(['flip', '자동 뒤집음', '']);
  else if (f && f.warn === 'other') out.push(['other', '다른 방향?', '']);
  if (state.status[i] === 'fail') out.push(['fail', '구도 실패', '']);
  // 손으로 맞춘 사진에는 청록 배지를 붙여, 크게 보기에서 손댄 사진을 격자에서도 알아본다 (수동 맞춤 설계 §3).
  if (isAdjusted(state.items[i])) out.push(['adjust', '수동 맞춤', '크게 보기에서 손으로 맞춘 사진입니다']);
  const a = state.angle;
  if (a && a.flagged.has(i)) out.push(['angle', '이웃과 많이 다름', `겹침 점수 ${a.scores[i].toFixed(2)} (기준 ${a.threshold.toFixed(2)})`]);
  return out;
}
// 순서 바꾸기·파일 받기는 큰 카드와 작은 사진이 똑같이 동작한다.
// 끄는 동안의 표시(원장 소감 09-22: 끌어도 아무 표시가 없어 되는지 몰랐음): 끌리는 사진은
// 반투명(.dragging), 놓일 자리에는 청록 세로 선(.drop-before/.drop-after). moveTo(from, i)는
// from > i면 i번 앞에, from < i면 i번 뒤에 놓으므로 선도 그쪽 가장자리에 긋는다.
// dragover 중에는 dataTransfer를 읽을 수 없어(크롬 보호) 끌기 시작 번호를 dragFrom에 둔다.
let dragFrom = -1;
function clearDropMarks() {
  document.querySelectorAll('.dragging').forEach(el => el.classList.remove('dragging'));
  clearSlotMarks();
}
// 마우스가 사진의 왼쪽 반이면 그 앞, 오른쪽 반이면 그 뒤에 놓는다.
function sideOf(el, x) { const r = el.getBoundingClientRect(); return x < r.left + r.width / 2; }
// "j번 앞/뒤"를 moveTo(from, to)의 to로 바꾼다(from을 뺀 뒤의 자리).
function dropTarget(from, j, before) {
  if (before) return from < j ? j - 1 : j;
  return from < j ? j : j + 1;
}
// 사진 사이 틈이나 빈 자리에 놓았을 때: 마우스에서 가장 가까운 사진을 고른다.
function nearestCard(container, sel, x, y) {
  let best = null, bd = Infinity;
  cardsOf(container, sel).forEach((el, k) => {
    const r = el.getBoundingClientRect();
    const dx = Math.max(r.left - x, 0, x - r.right), dy = Math.max(r.top - y, 0, y - r.bottom);
    const d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = { el, k }; }
  });
  return best;
}
// 놓일 자리(슬롯 k = "k번 사진 앞", k==n이면 맨 뒤) 표시: 사진 k가 오른쪽으로 살짝 밀리고 그 앞에
// 청록 선이 선다. 배치는 바꾸지 않으므로 마우스 아래 사진이 바뀌지 않는다 — 빈 칸을 실제로 끼워
// 넣던 방식은 재배치 때문에 주변 사진이 떨렸다(원장 소감 09-23, 하루 만에 철회).
let dropSlotIdx = -1, dropContainer = null;
function cardsOf(container, sel) { return [...container.querySelectorAll(sel)]; }
function clearSlotMarks() {
  document.querySelectorAll('.gap-before,.gap-after').forEach(el => el.classList.remove('gap-before', 'gap-after'));
  dropSlotIdx = -1; dropContainer = null;
}
function setSlot(container, sel, k) {
  if (dropContainer === container && dropSlotIdx === k) return;
  clearSlotMarks();
  const els = cardsOf(container, sel);
  if (!els.length) return;
  if (k < els.length) els[k].classList.add('gap-before');
  else els[els.length - 1].classList.add('gap-after');
  dropSlotIdx = k; dropContainer = container;
}
// 슬롯 p를 moveTo의 to로: 끌던 사진(from)을 빼면 그 뒤 슬롯은 하나씩 당겨진다.
function slotToIndex(from, p) { return p > from ? p - 1 : p; }
function markDrop(el, before) {
  const container = el.closest('#grid') ? $('grid') : $('assetList');
  const sel = el.classList.contains('card') ? '.card' : '.asset';
  const j = cardsOf(container, sel).indexOf(el);
  const k = before ? j : j + 1;
  // 끌던 사진의 바로 앞·뒤 슬롯은 제자리라 표시하지 않는다.
  if (k === dragFrom || k === dragFrom + 1) { clearSlotMarks(); return; }
  setSlot(container, sel, k);
}
function currentSlot(container) { return dropContainer === container ? dropSlotIdx : -1; }
// 격자(세로)·사진 줄(가로)의 가장자리 근처로 끌고 가면 저절로 밀린다 — 화면 밖의 자리로도
// 옮길 수 있게 (원장 소감 09-22: 여러 칸 이동이 안 됨).
function autoScroll(e) {
  if (dragFrom < 0) return;
  const EDGE = 48, STEP = 14;
  const g = $('grid'), gr = g.getBoundingClientRect();
  if (e.clientX >= gr.left && e.clientX <= gr.right) {
    if (e.clientY > gr.top && e.clientY < gr.top + EDGE) g.scrollTop -= STEP;
    else if (e.clientY < gr.bottom && e.clientY > gr.bottom - EDGE) g.scrollTop += STEP;
  }
  const l = $('assetList'), lr = l.getBoundingClientRect();
  if (e.clientY >= lr.top && e.clientY <= lr.bottom) {
    if (e.clientX > lr.left && e.clientX < lr.left + EDGE) l.scrollLeft -= STEP;
    else if (e.clientX < lr.right && e.clientX > lr.right - EDGE) l.scrollLeft += STEP;
  }
}
// 틈에 놓기: 격자·사진 줄 자체가 놓는 자리를 받는다.
function wireContainerDrop(container, sel) {
  container.addEventListener('dragover', e => {
    if (dragFrom < 0) return;
    e.preventDefault();
    if (e.target.closest && e.target.closest(sel)) return;        // 사진 위는 사진이 맡는다
    // 틈 위에서는 이미 표시한 자리를 지킨다(밀린 사진의 가장자리에서 표시가 오락가락하지 않게).
    if (currentSlot(container) >= 0) return;
    const n = nearestCard(container, sel, e.clientX, e.clientY);
    if (!n || n.k === dragFrom) return;
    markDrop(n.el, sideOf(n.el, e.clientX));
  });
  container.addEventListener('drop', e => {
    if (dragFrom < 0 || (e.target.closest && e.target.closest(sel))) return;
    e.preventDefault(); e.stopPropagation(); endDrag();
    const from = dragFrom; dragFrom = -1;
    const p = currentSlot(container);
    clearDropMarks();
    if (p >= 0) { moveTo(from, slotToIndex(from, p)); return; }
    const n = nearestCard(container, sel, e.clientX, e.clientY);
    if (!n || n.k === from) return;
    moveTo(from, dropTarget(from, n.k, sideOf(n.el, e.clientX)));
  });
}
function wireDrag(el, i, lock) {
  el.draggable = !lock;
  el.ondragstart = e => {
    if (lock) { e.preventDefault(); return; }
    e.dataTransfer.setData('text/plain', String(i)); e.dataTransfer.effectAllowed = 'move';
    dragFrom = i; el.classList.add('dragging');
  };
  el.ondragend = () => { dragFrom = -1; clearDropMarks(); };
  el.ondragover = e => {
    e.preventDefault();
    if (dragFrom < 0 || dragFrom === i) return;
    markDrop(el, sideOf(el, e.clientX));
  };
  el.ondragleave = () => {};
  // 운영체제에서 끌어온 파일은 text/plain이 빈 문자열이라 +'' === 0이 되고, 예전에는
  // 그게 moveTo(0, i)로 해석되어 사진 1이 슬쩍 옮겨지고 끌어온 파일은 사라졌다.
  // 파일이 실려 있으면 순서 바꾸기가 아니라 "사진 추가"로 보낸다.
  el.ondrop = e => {
    e.preventDefault(); e.stopPropagation(); endDrag();
    if (e.dataTransfer.files && e.dataTransfer.files.length) { dragFrom = -1; clearDropMarks(); addFiles(e.dataTransfer.files); return; }
    // 안에서 끈 사진은 dragFrom이 안다(getData는 브라우저에 따라 비어 올 수 있다).
    const from = dragFrom >= 0 ? dragFrom : +e.dataTransfer.getData('text/plain');
    dragFrom = -1;
    // 사진 위에 놓았으면 표시해 둔 자리보다 "지금 놓은 지점"(이 사진의 왼쪽/오른쪽 반)을 믿는다 —
    // 마우스 이동 중 표시 갱신이 빠졌더라도 놓은 곳으로 간다. 틈에 놓았을 때만 표시한 자리를 쓴다.
    clearDropMarks();
    if (!Number.isInteger(from) || from < 0 || from >= state.items.length || from === i) return;
    moveTo(from, dropTarget(from, i, sideOf(el, e.clientX)));
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
// 같은 버튼 하나가 빼기와 넣기를 번갈아 맡는다. 개별 삭제는 없다 (제외 설계 §2).
function excludeBtn(i, it) {
  return it.excluded
    ? ['↩', '영상에 다시 넣기', () => toggleExclude(i)]
    : ['✕', '영상에서 빼기', () => toggleExclude(i)];
}
function renderGrid() {
  const g = $('grid'); g.innerHTML = '';
  const lock = locked();
  state.items.forEach((it, i) => {
    const d = document.createElement('div'); d.className = 'card';
    if (state.status[i] === 'fail') d.classList.add('fail');
    if (it.excluded) d.classList.add('excluded');
    d.title = `${it.name} — 누르면 크게 보기`;
    // 사진을 누르면 크게 보기로 들어간다. 위에 얹힌 ◀▶⇄✕ 버튼은 btnRow에서
    // stopPropagation 하므로 여기까지 오지 않는다 (회전 설계 §2).
    d.onclick = () => openViewer(i);
    const img = document.createElement('img'); img.src = thumbOf(it); img.alt = it.name; d.appendChild(img);
    if (it.excluded) {
      // 뺀 사진 한가운데 되돌리기 버튼 (원장 요청 09-23). 모서리 ↩와 같은 일을 한다.
      const rb = document.createElement('button'); rb.className = 'restore'; rb.type = 'button';
      rb.textContent = '↩ 다시 넣기'; rb.title = '영상에 다시 넣기'; rb.disabled = lock;
      rb.onclick = ev => { ev.stopPropagation(); toggleExclude(i); };
      d.appendChild(rb);
    }
    const no = document.createElement('div'); no.className = 'num';
    no.textContent = captionOf(it);
    d.appendChild(no);
    const bl = badgesFor(i);
    if (bl.length) {
      const wrap = document.createElement('div'); wrap.className = 'badges';
      for (const [cls, text, tip] of bl) { const s = document.createElement('span'); s.className = `badge ${cls}`; s.textContent = text; if (tip) s.title = tip; wrap.appendChild(s); }
      d.appendChild(wrap);
    }
    // 순서는 끌어서 바꾼다(◀▶ 버튼은 09-22 원장 요청으로 제거).
    d.appendChild(btnRow(i, lock, [
      ['⇄', '좌우 뒤집기', () => flip(i)],
      excludeBtn(i, it),
    ]));
    wireDrag(d, i, lock);
    g.appendChild(d);
  });
}
function renderStrip() {
  const list = $('assetList');
  // 통째로 다시 그리면 내용이 잠깐 비어 scrollLeft가 0으로 돌아간다(빼기를 누르면 맨 앞으로
  // 튀던 원인, 원장 소감 09-22). 그리기 전 위치를 기억했다가 되돌린다.
  const keep = list.scrollLeft;
  [...list.querySelectorAll('.asset')].forEach(el => el.remove());
  $('assetEmpty').style.display = state.items.length ? 'none' : '';
  const lock = locked();
  state.items.forEach((it, i) => {
    const d = document.createElement('div'); d.className = 'asset';
    const f = state.flags[i];
    if (f && f.warn === 'flip') d.classList.add('warn-flip');
    if (f && f.warn === 'other') d.classList.add('warn-other');
    if (state.status[i] === 'fail') d.classList.add('fail');
    if (it.excluded) d.classList.add('excluded');
    // 크게 보기 중인 사진은 사진 줄에서도 청록 테두리로 알아본다 (원장 소감 09-22).
    if (uiState === 'view' && i === viewIdx) d.classList.add('current');
    d.title = `${it.no}. ${it.name}`;
    const img = document.createElement('img'); img.src = thumbOf(it); img.alt = it.name; d.appendChild(img);
    const no = document.createElement('div'); no.className = 'no'; no.textContent = captionOf(it); d.appendChild(no);
    const bl = badgesFor(i);
    if (bl.length) {
      const tags = document.createElement('div'); tags.className = 'tags';
      bl.forEach(([cls, text, tip], k) => {
        const sp = document.createElement('span'); sp.className = cls; sp.textContent = (k ? ' · ' : '') + text;
        if (tip) sp.title = tip;
        tags.appendChild(sp);
      });
      d.appendChild(tags);
    }
    d.appendChild(btnRow(i, lock, [
      ['⇄', '좌우 뒤집기', () => flip(i)],
      excludeBtn(i, it),
    ]));
    wireDrag(d, i, lock);
    list.appendChild(d);
  });
  list.scrollLeft = keep;
  // 보고 있는 사진이 줄 밖에 있으면 그 자리까지만 따라간다(보이면 움직이지 않는다).
  const cur = list.querySelector('.asset.current');
  if (cur) cur.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}
function render() { renderGrid(); renderStrip(); syncState(); }

// ── 크게 보기 = 수동 맞춤 모드 ────────────────────────────────
// 격자 카드를 누르면 가운데 판이 뷰어로 바뀐다. 자동 구도 맞추기가 어긋난 사진을
// 원장이 크기·회전·이동으로 직접 맞추는 자리다 (수동 맞춤 설계 §2).
// 슬라이더를 움직이면 it.adjust에 곧바로 들어간다 — 따로 "적용" 단계가 없다.
let viewIdx = -1;
let viewSrc = null;                // { it, canvas } 지금 사진(뒤집기만 반영된 그림)
let viewOnionSrc = null;           // { key, canvas, idx } 겹쳐 볼 앞·뒤 사진
// 겹쳐 보기는 "바로 앞(뒤) 순서의 **포함된** 사진"과 비교한다. 뺀 사진은 영상에 없으므로
// 그것과 각도를 맞춰 봐야 소용이 없다.
function prevIncluded(i) {
  for (let k = i - 1; k >= 0; k--) if (!state.items[k].excluded) return k;
  return -1;
}
function nextIncluded(i) {
  for (let k = i + 1; k < state.items.length; k++) if (!state.items[k].excluded) return k;
  return -1;
}
// 캐시의 T는 "포함된 사진"만큼이라, 원래 자리(i)로 찾으려면 펼쳐 둔다.
// 캐시가 없거나 사진 구성이 달라졌으면 null — 그때는 아직 맞출 수 없는 상태다.
function alignedT() {
  if (!state.cache || state.cache.key !== cacheKey()) return null;
  return cachedT();
}
// 뷰어의 세 가지 상태: 'adjust'(맞춤 모드) / 'excluded'(뺀 사진) / 'need'(구도 준비 안 됨)
function viewMode() {
  const it = state.items[viewIdx];
  if (!it) return 'need';
  if (it.excluded) return 'excluded';
  const T = alignedT();
  return T && T[viewIdx] ? 'adjust' : 'need';
}

// ── 보기 확대·축소 (보기 전용) ────────────────────────────────
// 휠로 1~4배까지 키워 본다. 끌기는 사진을 옮기는 편집이므로 확대해도 끌어서 보기
// 이동(팬)은 하지 않는다 — 확대는 커서 자리를 기준으로만 움직인다 (수동 맞춤 설계 §2).
const ZOOM_MIN = 1, ZOOM_MAX = 4;
let viewZoom = 1, panX = 0, panY = 0;
function resetZoom() { viewZoom = 1; panX = 0; panY = 0; }
// 확대한 채로 밀어도 캔버스 밖의 빈 자리가 보이지 않게 이동량을 가둔다.
function clampPan() {
  const c = $('viewCanvas');
  panX = Math.min(0, Math.max(c.width * (1 - viewZoom), panX));
  panY = Math.min(0, Math.max(c.height * (1 - viewZoom), panY));
}
// 커서 아래에 있던 지점이 그 자리에 머물도록 배율과 이동량을 함께 고친다.
function zoomAt(cx, cy, next) {
  const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
  if (z === viewZoom) return;
  panX = cx - (cx - panX) * (z / viewZoom);
  panY = cy - (cy - panY) * (z / viewZoom);
  viewZoom = z;
  if (viewZoom === ZOOM_MIN) { panX = 0; panY = 0; }
  clampPan();
}
// 캔버스는 CSS 크기와 픽셀 수가 다를 수 있으므로(화면 배율), 마우스 자리를 캔버스
// 좌표로 되돌릴 때 그 비율을 곱해 줘야 커서가 가리키던 곳이 그대로 확대된다.
function canvasScale() {
  const c = $('viewCanvas'), r = c.getBoundingClientRect();
  return { x: r.width ? c.width / r.width : 1, y: r.height ? c.height / r.height : 1, r };
}
function canvasPoint(e) {
  const c = $('viewCanvas'), { x: sx, y: sy, r } = canvasScale();
  if (!r.width || !r.height) return { x: c.width / 2, y: c.height / 2 };
  return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy };
}
function syncZoomUi() {
  $('viewFit').disabled = viewZoom === ZOOM_MIN;
  $('viewZoom').textContent = viewZoom > ZOOM_MIN ? ` · ${viewZoom.toFixed(1)}배` : '';
}
function fitView() { resetZoom(); syncZoomUi(); drawView(); }

// ── 캔버스 크기·좌표 ──────────────────────────────────────────
// 캔버스는 판(view-stage)을 꽉 채운다. 그 안에 기준 틀(W×H) 전체가 들어가도록
// 줄여 그리고(contain), 그 위에 보기 확대를 얹는다.
function fitCanvas() {
  const c = $('viewCanvas'), box = $('viewStage');
  const dpr = Math.min(2, (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1);
  const w = Math.max(16, Math.round(box.clientWidth)), h = Math.max(16, Math.round(box.clientHeight));
  const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
  if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; }
  c.style.width = `${w}px`; c.style.height = `${h}px`;
}
// 기준 틀 좌표 → 캔버스 좌표 변환([a,b,tx,c,d,ty] 규약).
function viewMatrix(W, H) {
  const c = $('viewCanvas');
  const s = Math.min(c.width / W, c.height / H);
  const fx = (c.width - W * s) / 2, fy = (c.height - H * s) / 2;
  const k = s * viewZoom;
  return new Float64Array([k, 0, viewZoom * fx + panX, 0, k, viewZoom * fy + panY]);
}
// M = [a,b,tx,c,d,ty]를 캔버스 변환으로 건다(캔버스는 a,c,b,d,tx,ty 순서다).
function setM(ctx, M) { ctx.setTransform(M[0], M[3], M[1], M[4], M[2], M[5]); }

function openViewer(i) {
  if (locked() || !state.items[i]) return;
  if (uiState === 'done') leaveDone();      // 결과 영상 자리를 뷰어가 쓴다
  viewIdx = i;
  uiState = 'view';
  resetZoom();                              // 사진이 바뀌면 보기 확대는 맞춤으로 돌아간다
  render();
}
function closeViewer() {
  if (uiState !== 'view') return;
  viewIdx = -1; viewSrc = null; viewOnionSrc = null;
  uiState = state.items.length ? 'ready' : 'empty';
}
// 사진을 전부 비울 때처럼 보던 대상이 사라지는 경우.
function discardViewer() {
  viewIdx = -1; viewSrc = null; viewOnionSrc = null;
  if (uiState === 'view') uiState = 'ready';
}
function stepViewer(d) {
  const j = viewIdx + d;
  if (uiState !== 'view' || !state.items[j]) return;
  viewIdx = j;
  resetZoom();
  render();
}
// 뷰어 화면 전체를 지금 상태에 맞춘다(setState가 부른다).
function syncViewer() {
  const it = state.items[viewIdx];
  if (!it) return;
  const mode = viewMode();
  $('viewCap').textContent = captionOf(it) + (it.excluded ? ' · 제외' : '');
  syncZoomUi();
  $('viewPrev').disabled = viewIdx <= 0;
  $('viewNext').disabled = viewIdx >= state.items.length - 1;
  $('viewExclude').textContent = it.excluded ? '↩ 넣기' : '✕ 빼기';
  $('viewExclude').title = it.excluded ? '영상에 다시 넣기' : '영상에서 빼기';
  // 구도 준비 안 됨 / 뺀 사진: 조절 줄 대신 안내를 보여 준다 (수동 맞춤 설계 §2).
  $('viewAdjust').hidden = mode !== 'adjust';
  $('viewNeedCheck').hidden = mode === 'adjust';
  $('viewNeedText').textContent = mode === 'excluded'
    ? '영상에서 뺀 사진이라 구도를 맞추지 않습니다. ↩ 넣기로 되돌리면 맞출 수 있습니다.'
    : '먼저 각도 검사를 하면 앞뒤 사진과 맞출 수 있습니다';
  $('viewRunCheck').hidden = mode !== 'need';
  $('viewCanvas').classList.toggle('adjust', mode === 'adjust');
  // 뺀 사진은 크게 보기에서도 어둡게 — 위 글씨만으로는 한눈에 안 보인다 (원장 소감 09-22).
  $('viewCanvas').classList.toggle('excluded', mode === 'excluded');
  $('viewRestore').hidden = mode !== 'excluded';
  const adj = adjustOf(it);
  $('adjScale').value = String(adj.scale);
  $('adjRot').value = String(adj.rotation);
  syncAdjustLabels();
  $('adjReset').disabled = !isAdjusted(it);
  // 겹쳐 보기: 첫·마지막 사진이면 해당 항목을 끄고, 고른 쪽이 없으면 반대쪽을 대신 보여 준다.
  const p = prevIncluded(viewIdx), n = nextIncluded(viewIdx);
  const sel = $('onionMode');
  sel.options[1].disabled = p < 0;
  sel.options[2].disabled = n < 0;
  let eff = onionPref;
  if (eff === 'prev' && p < 0) eff = n >= 0 ? 'next' : 'none';
  if (eff === 'next' && n < 0) eff = p >= 0 ? 'prev' : 'none';
  sel.value = eff;
  sel.disabled = mode !== 'adjust';
  if (!viewSrc || viewSrc.it !== it) viewSrc = { it, canvas: canvasOf(it.image) };
  const oi = mode === 'adjust' ? onionIdx() : -1;
  if (oi < 0) viewOnionSrc = null;
  else {
    const oit = state.items[oi];
    const key = `${oi}:${oit.flips || 0}:${oit.name}`;
    if (!viewOnionSrc || viewOnionSrc.key !== key) viewOnionSrc = { key, idx: oi, canvas: canvasOf(oit.image) };
  }
  drawView();
}
// 겹쳐 보기에서 사용자가 고른 값. 첫 사진(앞 사진 없음)·마지막 사진(뒤 사진 없음)에서는
// 반대쪽을 대신 보여 주되 이 값은 건드리지 않아, 다음 사진으로 가면 고른 대로 돌아온다
// (원장 소감: 첫 사진으로 가면 "없음"으로 굳어 버려 편집이 불편).
let onionPref = 'prev';
function onionIdx() {
  const m = $('onionMode').value;
  if (m === 'prev') return prevIncluded(viewIdx);
  if (m === 'next') return nextIncluded(viewIdx);
  return -1;
}
function syncAdjustLabels() {
  $('adjScaleValue').textContent = `${(+$('adjScale').value).toFixed(2)}배`;
  $('adjRotValue').textContent = degLabel(+$('adjRot').value);
}
// 슬라이더를 움직이는 동안 매번 불린다. 사진 데이터를 다시 만들지 않고 캔버스 변환만
// 쓰므로 바로바로 따라온다.
function drawView() {
  const it = state.items[viewIdx];
  if (!it || !viewSrc) return;
  fitCanvas();
  const c = $('viewCanvas'), ctx = c.getContext('2d');
  const W = it.image.width, H = it.image.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#0b1117'; ctx.fillRect(0, 0, c.width, c.height);   // 틀 밖은 어두운 바탕
  clampPan();
  const V = viewMatrix(W, H);
  const mode = viewMode();
  if (mode !== 'adjust') {
    // 구도가 아직 없으면 사진만 크게 보여 준다(뒤집기는 반영된 그림).
    setM(ctx, V);
    ctx.drawImage(viewSrc.canvas, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return;
  }
  const T = alignedT();
  // 기준 틀 전체를 어두운 회색으로 깔아 사진이 틀의 어디에 앉았는지 보이게 한다.
  setM(ctx, V);
  ctx.fillStyle = '#232c36'; ctx.fillRect(0, 0, W, H);
  // 겹쳐 보기: 이웃 사진을 아래에 깔고 지금 사진을 50%로 얹는다. 아래쪽을 반투명으로
  // 그리면 바탕과 섞여 둘 다 어두워지므로, 위만 반투명으로 그려 반반으로 섞는다.
  if (viewOnionSrc && T && T[viewOnionSrc.idx]) {
    const oit = state.items[viewOnionSrc.idx];
    setM(ctx, compose(V, finalT(oit, T[viewOnionSrc.idx])));
    ctx.drawImage(viewOnionSrc.canvas, 0, 0);
  }
  setM(ctx, compose(V, finalT(it, T[viewIdx])));
  ctx.globalAlpha = viewOnionSrc ? 0.5 : 1;
  ctx.drawImage(viewSrc.canvas, 0, 0);
  ctx.globalAlpha = 1;
  // 잘라낼 창(영상에 들어갈 범위)을 청록 점선으로 (수동 맞춤 설계 §2)
  const { x0, y0, cw, ch } = cropRect(W, H);
  setM(ctx, V);
  const k = V[0] || 1;
  ctx.strokeStyle = '#35C7B0'; ctx.lineWidth = 1.5 / k; ctx.setLineDash([9 / k, 7 / k]);
  ctx.strokeRect(x0, y0, cw, ch);
  ctx.setLineDash([]);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

// ── 수동 맞춤 조작 ────────────────────────────────────────────
// 값이 바뀌면 곧바로 it.adjust에 넣고 화면만 다시 그린다. 구도 맞추기 캐시는 그대로
// 살아 있지만(보정은 자동 계산의 입력이 아니다) 겹침 점수는 달라지므로 배지를 지운다
// (수동 맞춤 설계 §1).
let adjBadgeTimer;
function adjustChanged() {
  drawView();
  syncAdjustLabels();
  const it = state.items[viewIdx];
  if (it) $('adjReset').disabled = !isAdjusted(it);
  invalidateScores();
  leaveDone();
  // 배지(수동 맞춤)는 격자·사진 줄을 다시 그려야 바뀐다. 슬라이더를 끄는 동안 40장을
  // 매번 다시 그리면 뚝뚝 끊기므로 손을 멈춘 뒤에 한 번만 그린다.
  clearTimeout(adjBadgeTimer);
  adjBadgeTimer = setTimeout(() => { if (uiState === 'view') { renderGrid(); renderStrip(); } }, 220);
}
function setAdjustScale(v) {
  const it = state.items[viewIdx];
  if (!it || viewMode() !== 'adjust') return;
  const s = Math.min(2, Math.max(0.5, Math.round(v * 100) / 100));
  adjustOf(it).scale = s;
  $('adjScale').value = String(s);
  adjustChanged();
}
function setAdjustRotation(v) {
  const it = state.items[viewIdx];
  if (!it || viewMode() !== 'adjust') return;
  const r = Math.min(10, Math.max(-10, Math.round(v * 4) / 4));
  adjustOf(it).rotation = r;
  $('adjRot').value = String(r);
  adjustChanged();
}
function moveAdjust(dx, dy) {
  const it = state.items[viewIdx];
  if (!it || viewMode() !== 'adjust') return;
  const a = adjustOf(it);
  a.dx += dx; a.dy += dy;
  adjustChanged();
}
function resetViewAdjust() {
  const it = state.items[viewIdx];
  if (!it || viewMode() !== 'adjust') return;
  if (!isAdjusted(it)) return;
  resetAdjust(it);
  $('adjScale').value = '1'; $('adjRot').value = '0';
  adjustChanged();
  toast('이 사진의 수동 맞춤을 되돌렸습니다');
}
// 구도 준비 안 됨 상태에서 누르는 `각도 검사`: 뷰어를 닫고 검사한 뒤 같은 사진으로 돌아온다.
async function runCheckFromViewer() {
  if (uiState !== 'view') return;
  const i = viewIdx;
  closeViewer(); render();
  await checkAngles();
  if (!state.cancelled && state.items[i]) openViewer(i);
}

// state.status(정합 성공/실패 표시)는 chainTransforms가 채운 배열이라 items/flags와
// 길이·순서가 항상 같아야 한다. 어긋나면(예: 아직 한 번도 만들기를 안 돌렸거나, 다른
// 조작으로 길이가 안 맞으면) 통째로 비워서 엉뚱한 사진에 회색 "구도 실패" 표시가
// 붙는 사고를 막는다 — 어차피 사진 구성이 바뀌면 다시 만들기를 눌러야 최신 상태가 된다.
// ── 각도 검사 캐시 ────────────────────────────────────────────
// 캐시가 지금 화면의 사진 구성에서 나온 것인지 가리는 열쇠. 이름·순서·뒤집은 횟수를 잇는다
// (같은 사진을 두 번 뒤집으면 원래대로 돌아오지만 그동안 그림이 바뀌었으므로 횟수를 센다).
// 제외 여부도 함께 잇는다 — 한 장을 빼면 구도 맞추기 사슬 자체가 달라지기 때문이다 (제외 설계 §2).
// 수동 맞춤(it.adjust)은 **넣지 않는다**: 자동 계산에 들어가는 값이 아니라 그 결과 위에
// 덧붙는 값이라, 손질해도 구도 맞추기 결과는 그대로 유효하다 (수동 맞춤 설계 §1).
// 제외 여부도 **넣지 않는다**(2026-09-21 개정): 구도는 뺀 사진까지 전부 넣고 한 번 맞춰 두고,
// 빼기/넣기는 그 결과에서 고르기만 한다. 그래야 뺐다 넣어도 검사를 다시 하지 않고 바로
// 수동 맞춤·만들기가 되고, 사진을 빼도 전체 구도(잘림)가 흔들리지 않는다.
// 순서도 **넣지 않는다**(2026-09-23 개정): 구도 변환은 사진마다 하나씩(it.T) 붙여 두므로 순서를
// 바꿔도 그대로 쓴다. 키는 "어떤 사진들(이름·뒤집힘)이 있나"만 본다. 새 사진·뒤집기만 다시 계산.
function cacheKey() { return state.items.map(it => `${it.name}:${it.flips || 0}`).sort().join('|'); }
// 지금 순서대로 사진에 붙은 변환·상태를 배열로 꺼낸다(캐시가 유효할 때만).
function cachedT() { return state.items.map(it => it.T); }
function cachedStatus() { return state.items.map(it => it.status || 'ok'); }
function storeAlignment(key, T, status) {
  state.items.forEach((it, k) => { it.T = T[k]; it.status = status[k]; });
  state.cache = { key };
}
function setCheckNote(t) { $('checkNote').textContent = t; }
// 겹침 점수만 낡은 경우(수동 맞춤을 고쳤을 때). 구도 맞추기 결과(캐시)는 그대로 둔다.
function invalidateScores() {
  const had = !!state.angle;
  state.angle = null;
  if (had) setCheckNote('다시 검사하세요');
}
// 사진을 하나라도 건드리면 구도 맞추기 결과도 겹침 점수도 더 이상 맞지 않는다.
// 배지를 지우고, 이미 한 번 검사한 뒤였다면 다시 검사하라고 알린다 (설계 §3).
function invalidateCheck() {
  state.cache = null;
  invalidateScores();
}

function moveTo(from, to) {
  if (locked()) return;
  // 순서가 바뀌면 뷰어가 보던 자리(viewIdx)가 다른 사진을 가리키게 된다. 먼저 나온다.
  closeViewer();
  if (to < 0 || to >= state.items.length || from === to) return;
  if (state.status.length === state.items.length) { const [st] = state.status.splice(from, 1); state.status.splice(to, 0, st); }
  else state.status = [];
  const [it] = state.items.splice(from, 1); state.items.splice(to, 0, it);
  const [f] = state.flags.splice(from, 1); state.flags.splice(to, 0, f);
  // 구도(it.T)는 순서와 무관하므로 그대로. 이웃 점수(배지)만 낡는다 → 다시 검사는 몇 초.
  invalidateScores();
  leaveDone(); render();
}
// 날짜순 정렬 버튼: 전체를 날짜순(날짜 없는 사진은 이름순으로 뒤)으로 다시 세우고 번호를 1부터
// 다시 매긴다. 손으로 옮긴 뒤 되돌리는 용도로도 쓴다 (원장 요청 09-23).
function sortByDate() {
  if (locked() || state.items.length < 2) return;
  const sorted = sortItems(state.items);
  if (sorted.every((it, k) => it === state.items[k])) { toast('이미 날짜순입니다.'); return; }
  closeViewer();
  const idx = sorted.map(it => state.items.indexOf(it));
  state.flags = idx.map(k => state.flags[k]);
  state.status = state.status.length === state.items.length ? idx.map(k => state.status[k]) : [];
  state.items = sorted;
  state.items.forEach((it, k) => { it.no = k + 1; });
  invalidateScores();
  leaveDone(); render();
  toast('날짜순으로 정렬하고 번호를 1부터 다시 매겼습니다.');
}
function flip(i) {
  if (locked()) return;
  const it = state.items[i];
  // 뒤집기는 이제 표시만 바꾸는 깃발이다. 그림은 원본에서 다시 만든다 (회전 설계 §3).
  it.flipped = !it.flipped;
  rebuildImage(it);
  // 뒤집힌 상태에서 맞춰 둔 값은 의미가 없으므로 수동 맞춤은 초기화한다 (수동 맞춤 설계 §1).
  if (isAdjusted(it)) { resetAdjust(it); toast('뒤집어서 수동 맞춤을 초기화했습니다'); }
  viewSrc = null;                    // 뷰어가 들고 있던 그림도 새 것으로 바꾼다
  state.flags[i] = { warn: null };
  // 사용자가 직접 정한 방향은 나중에 사진을 더 넣어도 자동 판정이 뒤엎지 않는다.
  it.userFlipped = true;
  it.flips = (it.flips || 0) + 1;
  state.status = []; // 뒤집으면 이전 정합 결과가 더 이상 맞지 않는다
  invalidateCheck();
  leaveDone(); render();
}
// 빼기(✕)·넣기(↩). 목록에서 없애지 않으므로 items/flags/status의 길이·자리는 그대로다.
// 구도 맞추기 사슬이 달라지므로 이전 결과(구도 실패·각도 배지·캐시)는 모두 무효로 한다.
function toggleExclude(i) {
  if (locked()) return;
  const it = state.items[i];
  it.excluded = !it.excluded;
  it.autoExcluded = false;          // 손으로 정한 것은 '부드럽게 고르기'가 다시 건드리지 않는다
  // 구도 결과(캐시)·구도 실패 표시·각도 배지는 그대로 둔다. 뺀 사진까지 한 번에 맞춰 두었으므로
  // 다시 넣어도 바로 쓸 수 있고, "이웃과 많이 다름" 표시는 빼는 동안 계속 보여야 한다.
  leaveDone(); render();
  // 새로 그린 카드가 이전 밝기에서 출발해 서서히 바뀌도록, 한 프레임 동안 이전 상태를 입힌다
  // (원장 소감 09-23: 확 어두워져 다른 사진으로 바뀐 것처럼 보임). 뷰어 캔버스는 그대로 있어
  // CSS transition만으로 된다.
  const cls = it.excluded ? 'from-bright' : 'from-dark';
  const els = [$('grid').children[i], $('assetList').querySelectorAll('.asset')[i]].filter(Boolean);
  els.forEach(el => el.classList.add(cls));
  requestAnimationFrame(() => requestAnimationFrame(() => els.forEach(el => el.classList.remove(cls))));
}

async function addFiles(files) {
  if (locked()) { toast('영상을 만드는 중에는 사진을 넣을 수 없습니다. 취소 후 넣어 주세요.'); return; }
  closeViewer(); state.loading = true; leaveDone(); render();
  let grays = null;
  try {
    const arr = [...files];
    const remain = MAX - state.items.length;
    if (remain <= 0) { toast('이미 40장이 있어 더 넣을 수 없습니다.'); return; }
    const list = arr.slice(0, remain);
    if (arr.length > list.length) toast(`한 번에 ${MAX}장까지만 넣을 수 있어 앞 ${list.length}장만 받았습니다.`);
    progress('사진 읽는 중');
    const { items, skipped } = await loadFiles(list, 1280);
    // 원본은 자동 뒤집기가 돌기 **전에** 잡아 둔다. 이 뒤로 뒤집기는 전부 original에서
    // 다시 만들므로, 여기서 한 번 놓치면 영영 손상된 그림만 남는다.
    items.forEach(it => { it.original = it.image; it.flipped = false; it.adjust = newAdjust(); });
    if (skipped.length) toast(`읽지 못한 파일 ${skipped.length}개(HEIC 등): JPG로 바꿔 넣어 주세요. ` + skipped.slice(0, 3).join(', '));
    if (state.items.length && items.length && (items[0].image.width !== state.items[0].image.width || items[0].image.height !== state.items[0].image.height)) { toast('앞서 넣은 사진과 비율이 달라 넣지 못했습니다. 한 번에 넣어 주세요.'); return; }
    // 새 사진은 뒤에 붙인다(그 묶음 안에서는 날짜순). 전체를 날짜순으로 세우는 것은
    // "날짜순 정렬" 버튼이 맡는다(09-23 원장 결정: 저절로 끼어들지 말 것). 번호는 최댓값+1부터.
    const fresh = new Set(items);
    const maxNo = state.items.reduce((m, it) => Math.max(m, it.no || 0), 0);
    items.forEach((it, k) => { it.no = maxNo + 1 + k; });
    state.items.push(...items); state.flags.push(...items.map(() => ({ warn: null })));
    state.status = [];
    invalidateCheck();
    const active = activeItems();
    if (!active.length) return;
    const cv = await cvReady();
    progress('방향 검사 중');
    // toGray가 도중에 터져도 그때까지 만든 Mat이 finally에서 풀리도록 하나씩 담는다
    // (map으로 한 번에 만들면 예외가 나는 순간 grays는 아직 null이라 전부 샌다).
    grays = [];
    for (const { it } of active) grays.push(toGray(cv, it.image));
    const W = active[0].it.image.width;
    const res = await checkOrientation(cv, grays, W, (i, n) => progress('방향 검사 중', i, n));
    grays.forEach(g => g.delete()); grays = null;
    applyOrientation(res, active, fresh);
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
// res는 "포함된 사진"만큼 나오므로, 결과를 되돌릴 때는 원래 자리(x.i)에 적는다.
// fresh = 이번에 새로 들어온 사진들. 기존 사진(fresh 아님)의 판정으로 전체가 뒤집힌 세트인지
// 가늠하고, 새 사진에만 뒤집기·표시를 적용한다. (새 사진이 날짜 자리로 끼어들므로 자리로는
// 구분할 수 없다.)
function applyOrientation(res, active, fresh) {
  let flipVotes = 0, prevCount = 0;
  res.forEach((r, k) => { if (!fresh.has(active[k].it)) { prevCount++; if (r.flip) flipVotes++; } });
  const opposite = prevCount > 0 && flipVotes * 2 > prevCount;
  res.forEach((r, k) => {
    const { it, i } = active[k];
    if (!fresh.has(it) || it.userFlipped) return;
    const doFlip = opposite ? !r.flip : r.flip;
    if (doFlip) { it.flipped = !it.flipped; rebuildImage(it); }
    state.flags[i] = { warn: doFlip ? 'flip' : (r.warn === 'other' ? 'other' : null) };
  });
}

const median = arr => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

// 구도 맞추기 결과를 마련한다: 캐시가 유효하면 그대로, 아니면 전체 사진(뺀 사진 포함)으로
// 새로 계산해 사진에 붙여 둔다. 각도 검사·부드럽게 고르기·만들기가 함께 쓴다.
async function ensureAlignment(cv, W, H, cancelled) {
  const key = cacheKey();
  if (state.cache && state.cache.key === key) { progress('구도 맞추는 중', 1, 1); return { T: cachedT(), status: cachedStatus() }; }
  state.cache = null;
  const grays = [];
  try {
    for (const it of state.items) grays.push(toGray(cv, it.image));
    const { T, status } = await chainTransforms(cv, grays, W, H, (i, n) => progress('구도 맞추는 중', i, n), cancelled);
    if (cancelled()) throw new Error('취소');
    storeAlignment(key, T, status);
    return { T, status };
  } finally { grays.forEach(g => g.delete()); }
}
// 이웃 점수 → 배지. 중앙값의 75% 아래면 "이웃과 많이 다름". 배지는 원래 자리(x.i)에 붙는다.
function applyScores(active, scores) {
  const med = median(scores), threshold = 0.75 * med;
  const flagged = new Set();
  scores.forEach((s, k) => { if (s < threshold) flagged.add(active[k].i); });
  state.angle = { scores: spread(scores, active), threshold, median: med, flagged };
  return { med, flagged };
}

// ── 부드럽게 고르기 ─────────────────────────────────────────────
// 원장 관찰(09-23): 사진을 전부 넣으면 구도가 계속 바뀌어 어수선하고, 구도가 비슷한 사진만
// 2~3장 간격으로 남기면 부드럽다. 그 고르기를 겹침 점수로 자동화한다 — 앞에서 남긴 사진과
// 잘 겹치는 사진만 남기고 나머지는 빼 둔다(흐리게 남으므로 ↩로 되돌릴 수 있다).
// 후보 = 지금 들어 있는 사진 + 지난 고르기가 자동으로 뺀 사진. 손으로 뺀 사진은 건드리지 않는다.
function pickCandidates() { return state.items.map((it, i) => ({ it, i })).filter(x => !x.it.excluded || x.it.autoExcluded); }
async function pickSmoothPhotos() {
  if (state.busy || state.loading) return;
  const cand = pickCandidates();
  if (cand.length < 3) { toast('고를 사진이 3장 이상일 때 쓸 수 있습니다.'); return; }
  closeViewer();
  state.busy = true; state.cancelled = false; state.job = 'pick'; phases = PHASE_CHECK;
  state.angle = null; setCheckNote('');
  uiState = 'ready'; jobPct = 0; $('eta').textContent = '';
  render();
  const cancelled = () => state.cancelled;
  try {
    const cv = await cvReady();
    const W = cand[0].it.image.width, H = cand[0].it.image.height;
    const { T, status } = await ensureAlignment(cv, W, H, cancelled);
    state.status = status.slice(); render();
    if (cancelled()) throw new Error('취소');
    progress('겹침 점수 계산 중');
    const warped = cand.map(({ it, i }) => warpImage(cv, it.image, finalT(it, T[i]), W, H));
    const V = await scoreVectors(cv, warped, (i, n) => progress('겹침 점수 계산 중', i, n), cancelled);
    const score = (a, b) => pairScore(V[a], V[b]);
    // 문턱은 후보들의 이웃 점수 분포에서 정한다: 보통 = 중앙값(평범한 이웃만큼은 겹쳐야 남김),
    // 강하게 = 상위 25% 경계.
    const consecutive = [];
    for (let k = 0; k + 1 < V.length; k++) consecutive.push(score(k, k + 1));
    const thr = percentile(consecutive, $('pickLevel').value === 'strong' ? 0.75 : 0.5);
    const keptIdx = pickSmooth(cand.length, score, thr, 3);
    const kept = new Set(keptIdx);
    let removed = 0;
    cand.forEach(({ it }, k) => { const keep = kept.has(k); if (!keep) removed++; it.excluded = !keep; it.autoExcluded = !keep; });
    // 남긴 사진끼리의 이웃 점수로 배지를 바로 갱신한다(다시 검사할 필요 없음).
    const keptActive = keptIdx.map(k => cand[k]);
    const scores = keptIdx.map((k, j) => {
      let s = 0, c = 0;
      if (j > 0) { s += score(keptIdx[j - 1], k); c++; }
      if (j + 1 < keptIdx.length) { s += score(k, keptIdx[j + 1]); c++; }
      return c ? s / c : 1;
    });
    applyScores(keptActive, scores);
    progress('완료');
    setCheckNote(`부드럽게 고르기: ${cand.length}장 중 ${keptIdx.length}장 남김 (기준 ${thr.toFixed(2)})`);
    toast(removed
      ? `잘 이어지지 않는 사진 ${removed}장을 뺐습니다. 흐린 사진은 ↩로 되돌릴 수 있고, 마음에 안 들면 "강하게/보통"을 바꿔 다시 고르세요.`
      : '모든 사진이 잘 이어져 뺄 사진이 없습니다.');
    leaveDone();
  } catch (e) {
    toast(e.message === '취소' ? '취소했습니다.' : '오류: ' + (e.message || e));
    state.angle = null; setCheckNote(''); progress('');
  } finally {
    state.busy = false; state.job = 'make'; phases = PHASE_MAKE;
    render();
  }
}

// ── 각도 검사 ─────────────────────────────────────────────────
// 각도가 크게 다른 사진이 섞이면 영상이 어른거린다. 자동으로 빼지는 않고, 이웃과 잘
// 겹치지 않는 사진에 주황 배지를 붙여 원장이 ✕로 빼도록 한다 (각도 검사 설계 §1).
// 만들기(make)와 같은 잠금·취소·진행·자원 정리 틀을 쓴다.
async function checkAngles() {
  if (state.busy || state.loading) return;
  const active = activeItems();
  if (active.length < MIN_CHECK) { toast(`영상에 넣는 사진이 ${MIN_CHECK}장 이상일 때 검사할 수 있습니다.`); return; }
  closeViewer();                     // 크게 보기(수동 맞춤)는 닫고 시작한다 — 값은 이미 사진에 들어 있다
  state.busy = true; state.cancelled = false; state.job = 'check'; phases = PHASE_CHECK;
  // 앞선 검사 결과는 먼저 지운다 — 도중에 취소하면 낡은 배지가 남아 있으면 안 된다.
  state.angle = null; setCheckNote('');
  uiState = 'ready';                 // 배지는 격자 카드에 붙으므로 결과 영상 화면은 내려 둔다
  jobPct = 0; $('eta').textContent = '';
  render();
  const cancelled = () => state.cancelled;
  let grays = null;
  try {
    const cv = await cvReady();
    const W = active[0].it.image.width, H = active[0].it.image.height;
    const { T, status } = await ensureAlignment(cv, W, H, cancelled);
    state.status = status.slice(); render();
    if (cancelled()) throw new Error('취소');
    progress('겹침 점수 계산 중');
    // 점수는 수동 맞춤까지 반영한 최종 변환으로 낸다 — 손질한 사진은 이웃과 더 잘
    // 겹쳐야 하고, 그 결과가 배지에 그대로 보여야 한다 (수동 맞춤 설계 §1).
    const warped = active.map(({ it, i }) => warpImage(cv, it.image, finalT(it, T[i]), W, H));
    const scores = await neighborScores(cv, warped, (i, n) => progress('겹침 점수 계산 중', i, n), cancelled);
    const { med, flagged } = applyScores(active, scores);
    progress('완료');
    setCheckNote(`각도 검사: ${flagged.size}장 표시 (중앙값 ${med.toFixed(2)})`);
    toast(flagged.size
      ? `이웃과 많이 다른 사진 ${flagged.size}장을 표시했습니다. 각도가 다르거나 간격이 긴 사진입니다. ✕(빼기)로 빼면 영상이 매끄러워집니다.`
      : active.length < 3 ? '구도를 맞췄습니다. 사진을 누르면 크게 보며 손볼 수 있습니다.'
      : '모든 사진이 고르게 겹칩니다.');
  } catch (e) {
    toast(e.message === '취소' ? '취소했습니다.' : '오류: ' + (e.message || e));
    state.angle = null; setCheckNote(''); progress('');
  } finally {
    if (grays) { grays.forEach(g => g.delete()); grays = null; }
    state.busy = false; state.job = 'make'; phases = PHASE_MAKE;
    render();
  }
}

async function make() {
  if (state.busy || state.loading) return;
  // 제외한 사진은 영상에 들어가지 않는다. 남은 사진이 2장 미만이면 이어 붙일 구간이 없다.
  const active = activeItems();
  if (active.length < 2) { toast('영상에 넣는 사진이 2장 이상이어야 합니다.'); return; }
  closeViewer();                     // 크게 보기(수동 맞춤)는 닫고 시작한다 — 값은 이미 사진에 들어 있다
  state.busy = true; state.cancelled = false; state.job = 'make'; phases = PHASE_MAKE;
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
    const W = active[0].it.image.width, H = active[0].it.image.height;
    // 각도 검사가 이미 같은 사진 구성으로 구도를 맞춰 뒀으면 그 결과를 그대로 쓴다.
    // 제일 오래 걸리는 단계라, 검사 뒤 바로 만들면 그만큼 시간이 통째로 빠진다 (설계 §4).
    const { T, status } = await ensureAlignment(cv, W, H, cancelled);
    // 기준 틀 사진은 만들 때마다 새로 만든다 — 수동 맞춤이 바뀌어도 늘 지금 값대로 나온다.
    const warped = active.map(({ it, i }) => warpImage(cv, it.image, finalT(it, T[i]), W, H));
    state.status = status.slice(); render();
    if (cancelled()) throw new Error('취소');
    progress('밝기·색 맞추는 중');
    // matchColors는 새 배열·새 사진을 돌려준다(warped는 여기서 역할이 끝난다).
    const aligned = await matchColors(warped, (i, n) => progress('밝기·색 맞추는 중', i, n), cancelled);
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
    const title = $('title').value.trim();
    const firstDated = active.map(x => x.it).find(it => it.date);
    const labels = active.map(({ it }) => {
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
        ctx.putImageData(chwToImage(f, cw, ch), 0, 0); drawLabel(ctx, labels[i], cw, 'right'); drawTitle(ctx, title, cw);
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
    ctx.putImageData(chwToImage(chwAt(n - 1), cw, ch), 0, 0); drawLabel(ctx, labels[labels.length - 1], cw, 'right'); drawTitle(ctx, title, cw);
    for (let k = 0; k < Math.round(fps); k++) await enc.addFrame(canvas, idx++);
    progress('영상 파일 만드는 중');
    const blob = await enc.finish();
    if (lastUrl) URL.revokeObjectURL(lastUrl);
    const url = URL.createObjectURL(blob); lastUrl = url;
    $('video').src = url;
    // 인공지능이 돌지 않아 단순 겹치기로 만들었으면 파일 이름도 "단순"으로 남긴다.
    const usedQuality = (!rife || rife.failed) ? 'none' : quality;
    lastName = outputName(active[0].it.name, 'mp4', usedQuality, new Date(), title);
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
  discardViewer();                   // 사진이 사라지므로 조절 중이던 값은 버린다
  state.items = []; state.flags = []; state.status = [];
  // 사진이 하나도 없으니 "다시 검사하세요"가 아니라 결과 줄까지 통째로 비운다.
  invalidateCheck(); setCheckNote('');
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
window.addEventListener('dragover', e => { e.preventDefault(); autoScroll(e); });
wireContainerDrop($('grid'), '.card');
wireContainerDrop($('assetList'), '.asset');
window.addEventListener('dragleave', e => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove('drag');
});
// 카드·사진에 떨어진 경우는 그쪽에서 stopPropagation 하므로, 덮개는 캡처 단계에서 내린다.
window.addEventListener('drop', endDrag, true);
window.addEventListener('drop', e => {
  e.preventDefault(); endDrag(); clearDropMarks(); dragFrom = -1;
  if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
});

// ── 연결 ─────────────────────────────────────────────────────
$('checkBtn').onclick = checkAngles;
$('pickBtn').onclick = pickSmoothPhotos;
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
// ── 크게 보기(수동 맞춤) 버튼·슬라이더 ────────────────────────
$('viewClose').onclick = () => { closeViewer(); render(); };
$('viewPrev').onclick = () => stepViewer(-1);
$('viewNext').onclick = () => stepViewer(1);
$('viewFlip').onclick = () => { if (uiState === 'view') flip(viewIdx); };
$('viewExclude').onclick = () => { if (uiState === 'view') toggleExclude(viewIdx); };
$('viewRestore').onclick = () => { if (uiState === 'view') toggleExclude(viewIdx); };
$('sortBtn').onclick = sortByDate;
$('viewRunCheck').onclick = runCheckFromViewer;
// 슬라이더는 사진 데이터를 건드리지 않고 캔버스만 다시 그린다 — 끌면 바로 따라온다.
$('adjScale').oninput = () => setAdjustScale(+$('adjScale').value);
$('adjScaleDown').onclick = () => setAdjustScale(+$('adjScale').value - 0.01);
$('adjScaleUp').onclick = () => setAdjustScale(+$('adjScale').value + 0.01);
$('adjRot').oninput = () => setAdjustRotation(+$('adjRot').value);
$('adjReset').onclick = resetViewAdjust;
$('onionMode').onchange = () => { onionPref = $('onionMode').value; if (uiState === 'view') syncViewer(); };
$('viewFit').onclick = () => { if (uiState === 'view') fitView(); };
// 판 크기가 바뀌면 캔버스도 다시 맞춘다(창 크기 조절·전체화면).
window.addEventListener('resize', () => { if (uiState === 'view') drawView(); });
// ── 보기 확대(휠)·사진 옮기기(끌기) ───────────────────────────
{
  const vc = $('viewCanvas');
  let dragging = false, dragLast = null;
  // passive:false여야 preventDefault가 먹는다 — 아니면 좁은 화면에서 작업 영역이 같이 스크롤된다.
  vc.addEventListener('wheel', e => {
    if (uiState !== 'view') return;
    e.preventDefault();
    // deltaY 단위가 브라우저·장치마다 달라(픽셀/줄/페이지) 부호만 쓰고 한 칸씩 키운다.
    const p = canvasPoint(e);
    zoomAt(p.x, p.y, viewZoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
    syncZoomUi(); drawView();
  }, { passive: false });
  // 끌기는 사진을 옮기는 편집이다(보기 이동이 아니다). 맞춤 모드에서만 듣는다.
  vc.addEventListener('pointerdown', e => {
    if (uiState !== 'view' || e.button) return;
    if (vc.focus) vc.focus();        // 화살표 키로 1px씩 미는 조작을 이어서 할 수 있게
    if (viewMode() !== 'adjust') return;
    dragging = true; dragLast = { x: e.clientX, y: e.clientY };
    vc.classList.add('drag');
    // 포인터를 잡아 두면 캔버스 밖으로 나가도 끌기가 이어지고 손을 뗀 것도 놓치지 않는다.
    if (vc.setPointerCapture) { try { vc.setPointerCapture(e.pointerId); } catch (_) { /* 무시 */ } }
    e.preventDefault();
  });
  vc.addEventListener('pointermove', e => {
    if (!dragging) return;
    const it = state.items[viewIdx];
    if (!it) return;
    // 화면에서 끈 거리를 기준 틀 좌표로 되돌린다(캔버스 배율 ÷ 지금 보기 배율).
    const { x: sx, y: sy } = canvasScale();
    const k = viewMatrix(it.image.width, it.image.height)[0] || 1;
    moveAdjust((e.clientX - dragLast.x) * sx / k, (e.clientY - dragLast.y) * sy / k);
    dragLast = { x: e.clientX, y: e.clientY };
  });
  const endDragMove = e => {
    if (!dragging) return;
    dragging = false; vc.classList.remove('drag');
    if (vc.releasePointerCapture) { try { vc.releasePointerCapture(e.pointerId); } catch (_) { /* 무시 */ } }
  };
  vc.addEventListener('pointerup', endDragMove);
  vc.addEventListener('pointercancel', endDragMove);
  // 사진을 더블클릭하면 닫는다 (수동 맞춤 설계 §2).
  vc.addEventListener('dblclick', e => {
    if (uiState !== 'view') return;
    e.preventDefault(); closeViewer(); render();
  });
}
$('step').oninput = () => { $('stepv').textContent = `${$('step').value}초`; };
$('labelMode').onchange = syncSettings;
const brandHome = $('brandHome');
brandHome.addEventListener('click', () => { location.href = '/'; });
brandHome.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); location.href = '/'; } });
window.addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  // Esc는 슬라이더에 커서가 가 있어도 들어야 한다 — 크게 보기에서 빠져나오는 길이다.
  if (uiState === 'view' && e.key === 'Escape') { e.preventDefault(); closeViewer(); render(); return; }
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
  // 화살표 키는 두 가지로 쓰인다. 사진을 한 번 누른(= 사진에 커서가 가 있는) 상태에서는
  // 사진을 1px(Shift 10px)씩 밀고, 그 밖에서는 ←/→로 앞뒤 사진을 넘긴다 (수동 맞춤 설계 §2).
  const onPhoto = uiState === 'view' && t === $('viewCanvas');
  if (onPhoto && viewMode() === 'adjust' && e.key.startsWith('Arrow')) {
    const d = e.shiftKey ? 10 : 1;
    e.preventDefault();
    if (e.key === 'ArrowLeft') moveAdjust(-d, 0);
    else if (e.key === 'ArrowRight') moveAdjust(d, 0);
    else if (e.key === 'ArrowUp') moveAdjust(0, -d);
    else moveAdjust(0, d);
    return;
  }
  if (uiState === 'view' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault(); stepViewer(e.key === 'ArrowLeft' ? -1 : 1); return;
  }
  // 0 = 맞춤(보기 확대 되돌리기). 수동 맞춤을 되돌리는 것은 조절 줄의 `되돌리기` 버튼이다.
  if (uiState === 'view' && e.key === '0') { e.preventDefault(); fitView(); return; }
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
