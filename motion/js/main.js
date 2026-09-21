import { loadFiles, monthsLabel, dateLabel, baseName } from './load.js';
import { toGray } from './features.js';
import { checkOrientation, flipImageData } from './orient.js';
import { chainTransforms, warpImage, alignedSize, neighborScores } from './align.js';
import { matchColors } from './color.js';
import { planTiming, aiLevelsFor, Rife, transition, imageToCHW, chwToImage } from './interp.js';
import { pickEncoder, Mp4Encoder, drawLabel, outputName } from './encode.js';
import { cvReady } from './cvready.js';

const $ = id => document.getElementById(id);
// cache: 각도 검사에서 얻은 구도 맞추기 결과({ key, T, status, aligned }). aligned는 밝기·색을
//        맞추기 **전**의 기준 틀 사진이라 영상 만들기가 그대로 이어받을 수 있다 (각도 검사 설계 §4).
// angle:  각도 검사 결과({ scores, threshold, median, flagged:Set }).
// job:    지금 도는 일 — 'make'(영상 만들기) 또는 'check'(각도 검사). 버튼 글씨·진행 몫이 다르다.
const state = { items: [], flags: [], status: [], cancelled: false, busy: false, loading: false, cache: null, angle: null, job: 'make' };
const MAX = 40;
const MIN_CHECK = 3;               // 사진 3장 미만이면 이웃이 부족해 검사하지 않는다 (설계 §2)
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
  const mk = $('makeBtn'), ck = $('checkBtn');
  if (s === 'busy') {
    // 각도 검사도 같은 잠금·진행 틀을 쓰므로, 지금 도는 일 쪽 버튼에만 퍼센트를 적는다.
    mk.textContent = state.job === 'check' ? '영상 만들기' : `만드는 중 ${jobPct}%`;
    ck.textContent = state.job === 'check' ? `검사 중 ${jobPct}%` : '각도 검사';
    mk.disabled = ck.disabled = true;
  } else {
    // 제외한 사진은 영상에 들어가지 않으므로 버튼을 켤지 말지도 "포함된 장수"로 센다 (제외 설계 §2).
    const on = activeCount();
    mk.textContent = '영상 만들기';
    mk.disabled = on < 2 || locked();
    ck.textContent = '각도 검사';
    ck.disabled = on < MIN_CHECK || locked();
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

// ── 사진 한 장 다시 만들기 (뒤집기·회전) ──────────────────────
// 사진 한 장은 세 가지로 적어 둔다 (회전 설계 §3).
//   it.original — 읽은 직후의 ImageData. 절대 손대지 않는다.
//   it.flipped  — 좌우 뒤집힘(자동 판정 + 사용자 ⇄의 최종 상태)
//   it.rotation — 미세회전(도, 기본 0)
// it.image(표시·계산용)는 언제나 original에서 "뒤집기 → 회전" 순으로 **다시** 만든다.
// 예전처럼 image를 그때그때 덮어쓰면 뒤집기·회전을 반복할수록 다시 표본한 그림이
// 쌓여 화질이 깎인다. 원본에서 한 번에 만들면 몇 번을 고쳐도 손실이 한 번뿐이다.
function degLabel(deg) { return `${deg > 0 ? '+' : deg < 0 ? '-' : ''}${Math.abs(deg).toFixed(1)}°`; }
// 회전하면 네 모서리가 비는데, 검게 두면 영상에서 그 자리가 깜빡인다. OpenCV의
// BORDER_REPLICATE와 비슷한 효과를 캔버스만으로 내려고, 회전한 사진을 얹기 전에
// 같은 사진을 살짝 키워(빈 모서리를 덮을 만큼) 바탕에 깔아 둔다 (설계 §3).
function coverScale(deg) {
  const r = Math.abs(deg) * Math.PI / 180;
  return Math.cos(r) + Math.sin(r);
}
// ctx 변환만으로 "뒤집기 → 회전"을 한 번에 그린다. 뷰어 미리보기와 rotateImageData가
// 같은 함수를 쓰므로, 슬라이더로 본 그림과 실제로 적용되는 그림이 어긋나지 않는다.
function drawOriented(ctx, src, w, h, deg, flipped) {
  const s = coverScale(deg);
  ctx.save();
  ctx.translate(w / 2, h / 2);
  if (flipped) ctx.scale(-1, 1);
  ctx.drawImage(src, -w * s / 2, -h * s / 2, w * s, h * s);   // 빈 모서리를 채울 바탕
  ctx.restore();
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate(deg * Math.PI / 180);
  if (flipped) ctx.scale(-1, 1);
  ctx.drawImage(src, -w / 2, -h / 2, w, h);
  ctx.restore();
}
function canvasOf(image) {
  const c = document.createElement('canvas'); c.width = image.width; c.height = image.height;
  c.getContext('2d').putImageData(image, 0, 0);
  return c;
}
// 뒤집기도 회전도 없으면 original을 그대로 가리킨다(사진 한 장이 4.4MB라 사본을 하나
// 덜 만든다). 그래서 it.image의 픽셀을 그 자리에서 고치면 안 된다 — 고칠 일이 있으면
// 여기서 새로 만든다.
function rebuildImage(it) {
  const deg = it.rotation || 0;
  if (!deg && !it.flipped) { it.image = it.original; it.thumb = null; return; }
  if (!deg) { it.image = flipImageData(it.original); it.thumb = null; return; }
  const w = it.original.width, h = it.original.height;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  drawOriented(ctx, canvasOf(it.original), w, h, deg, !!it.flipped);
  it.image = ctx.getImageData(0, 0, w, h);
  it.thumb = null;
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
  // 미세회전한 사진에는 청록 배지를 붙여, 크게 보기에서 손댄 사진을 격자에서도 알아본다 (회전 설계 §3).
  const rot = state.items[i].rotation || 0;
  if (rot) out.push(['rot', `회전 ${degLabel(rot)}`, '크게 보기에서 미세회전한 사진입니다']);
  const a = state.angle;
  if (a && a.flagged.has(i)) out.push(['angle', '이웃과 많이 다름', `겹침 점수 ${a.scores[i].toFixed(2)} (기준 ${a.threshold.toFixed(2)})`]);
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
    const no = document.createElement('div'); no.className = 'num';
    no.textContent = captionOf(it);
    d.appendChild(no);
    const bl = badgesFor(i);
    if (bl.length) {
      const wrap = document.createElement('div'); wrap.className = 'badges';
      for (const [cls, text, tip] of bl) { const s = document.createElement('span'); s.className = `badge ${cls}`; s.textContent = text; if (tip) s.title = tip; wrap.appendChild(s); }
      d.appendChild(wrap);
    }
    d.appendChild(btnRow(i, lock, [
      ['◀', '앞으로 옮기기', () => move(i, -1)],
      ['▶', '뒤로 옮기기', () => move(i, 1)],
      ['⇄', '좌우 뒤집기', () => flip(i)],
      excludeBtn(i, it),
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
    if (it.excluded) d.classList.add('excluded');
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
}
function render() { renderGrid(); renderStrip(); syncState(); }

// ── 크게 보기 (뷰어) ──────────────────────────────────────────
// 격자 카드를 누르면 가운데 판이 뷰어로 바뀐다. 사진을 크게 확인하고, 기울어 찍힌
// 사진을 슬라이더로 조금 돌려 놓는 자리다 (회전 설계 §2).
// 슬라이더 값은 "아직 적용하지 않은 값"이고, 뷰어를 닫거나 다른 사진으로 넘어갈 때
// 한 번에 적용한다(commitRotation). 별도 "적용" 버튼은 없다.
let viewIdx = -1;
let viewSrc = null;                // { it, canvas } 지금 사진의 원본 캔버스(회전 전)
let viewOnionSrc = null;           // { key, canvas } 겹쳐 볼 앞 사진(최종본)
// 겹쳐 보기는 "바로 앞 순서의 **포함된** 사진"과 비교한다. 뺀 사진은 영상에 없으므로
// 그것과 각도를 맞춰 봐야 소용이 없다.
function prevIncluded(i) {
  for (let k = i - 1; k >= 0; k--) if (!state.items[k].excluded) return k;
  return -1;
}

function openViewer(i) {
  if (locked() || !state.items[i]) return;
  if (uiState === 'done') leaveDone();      // 결과 영상 자리를 뷰어가 쓴다
  viewIdx = i;
  uiState = 'view';
  $('rotSlider').value = String(state.items[i].rotation || 0);
  render();
}
// 닫기·이동·다른 작업으로 뷰어를 떠날 때 슬라이더 값을 사진에 적용한다.
function commitRotation() {
  const it = state.items[viewIdx];
  if (!it) return;
  const deg = +$('rotSlider').value;
  if (deg === (it.rotation || 0)) return;
  it.rotation = deg;
  rebuildImage(it);                  // 작은 그림(thumb)도 여기서 버려진다
  state.status = [];                 // 회전하면 이전 구도 맞추기 결과가 맞지 않는다
  invalidateCheck();
  leaveDone();
}
function closeViewer() {
  if (uiState !== 'view') return;
  commitRotation();
  viewIdx = -1; viewSrc = null; viewOnionSrc = null;
  uiState = state.items.length ? 'ready' : 'empty';
}
// 사진을 전부 비울 때처럼 적용할 대상이 사라지는 경우는 값을 버리고 나온다.
function discardViewer() {
  viewIdx = -1; viewSrc = null; viewOnionSrc = null;
  if (uiState === 'view') uiState = 'ready';
}
function stepViewer(d) {
  const j = viewIdx + d;
  if (uiState !== 'view' || !state.items[j]) return;
  commitRotation();
  viewIdx = j;
  $('rotSlider').value = String(state.items[j].rotation || 0);
  render();
}
// 뷰어 화면 전체를 지금 상태에 맞춘다(setState가 부른다).
function syncViewer() {
  const it = state.items[viewIdx];
  if (!it) return;
  $('viewCap').textContent = captionOf(it) + (it.excluded ? ' · 제외' : '');
  // 슬라이더 값 글씨는 여기서도 맞춘다 — 회전해 둔 사진을 열면 손잡이만 옮겨 가고
  // 글씨는 0.0°로 남아 있었다.
  $('rotValue').textContent = degLabel(+$('rotSlider').value);
  $('viewPrev').disabled = viewIdx <= 0;
  $('viewNext').disabled = viewIdx >= state.items.length - 1;
  $('viewExclude').textContent = it.excluded ? '↩ 넣기' : '✕ 빼기';
  $('viewExclude').title = it.excluded ? '영상에 다시 넣기' : '영상에서 빼기';
  const p = prevIncluded(viewIdx);
  // 첫 사진(앞에 포함된 사진이 없음)에서는 겹쳐 볼 것이 없다.
  $('onion').disabled = p < 0;
  if (p < 0) $('onion').checked = false;
  if (!viewSrc || viewSrc.it !== it) viewSrc = { it, canvas: canvasOf(it.original) };
  if (p < 0) viewOnionSrc = null;
  else {
    const pit = state.items[p];
    const key = `${p}:${pit.flips || 0}:${pit.rotation || 0}:${pit.name}`;
    if (!viewOnionSrc || viewOnionSrc.key !== key) viewOnionSrc = { key, canvas: canvasOf(pit.image) };
  }
  drawView();
}
// 슬라이더를 움직이는 동안 매번 불린다. 사진 데이터를 다시 만들지 않고 캔버스 변환만
// 쓰므로 바로바로 따라온다 (회전 설계 §2).
function drawView() {
  const it = state.items[viewIdx];
  if (!it || !viewSrc) return;
  const c = $('viewCanvas'), w = it.original.width, h = it.original.height;
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const ctx = c.getContext('2d');
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
  const deg = +$('rotSlider').value;
  const onion = $('onion').checked && viewOnionSrc;
  // 겹쳐 보기: 앞 사진을 아래에 깔고 지금 사진을 반투명으로 얹는다. 앞 사진 쪽을
  // 0.5로 그리면 검은 바탕과 섞여 둘 다 어두워지므로, 아래는 그대로 두고 위만 반투명
  // 으로 그려 정확히 반반으로 섞이게 한다.
  if (onion) ctx.drawImage(viewOnionSrc.canvas, 0, 0, w, h);
  if (onion) ctx.globalAlpha = 0.5;
  drawOriented(ctx, viewSrc.canvas, w, h, deg, !!it.flipped);
  ctx.globalAlpha = 1;
}

// state.status(정합 성공/실패 표시)는 chainTransforms가 채운 배열이라 items/flags와
// 길이·순서가 항상 같아야 한다. 어긋나면(예: 아직 한 번도 만들기를 안 돌렸거나, 다른
// 조작으로 길이가 안 맞으면) 통째로 비워서 엉뚱한 사진에 회색 "구도 실패" 표시가
// 붙는 사고를 막는다 — 어차피 사진 구성이 바뀌면 다시 만들기를 눌러야 최신 상태가 된다.
// ── 각도 검사 캐시 ────────────────────────────────────────────
// 캐시가 지금 화면의 사진 구성에서 나온 것인지 가리는 열쇠. 이름·순서·뒤집은 횟수를 잇는다
// (같은 사진을 두 번 뒤집으면 원래대로 돌아오지만 그동안 그림이 바뀌었으므로 횟수를 센다).
// 제외 여부도 함께 잇는다 — 한 장을 빼면 구도 맞추기 사슬 자체가 달라지기 때문이다 (제외 설계 §2).
// 미세회전도 그림을 바꾸므로 열쇠에 넣는다 — 회전만 고치고 다시 만들면 낡은 구도
// 맞추기 결과를 이어받아 엉뚱한 틀로 영상이 나온다 (회전 설계 §3).
function cacheKey() { return state.items.map((it, i) => `${i}:${it.name}:${it.flips || 0}:${it.excluded ? 1 : 0}:${it.rotation || 0}`).join('|'); }
function setCheckNote(t) { $('checkNote').textContent = t; }
// 사진을 하나라도 건드리면 구도 맞추기 결과도 겹침 점수도 더 이상 맞지 않는다.
// 배지를 지우고, 이미 한 번 검사한 뒤였다면 다시 검사하라고 알린다 (설계 §3).
function invalidateCheck() {
  state.cache = null;
  const had = !!state.angle;
  state.angle = null;
  if (had) setCheckNote('다시 검사하세요');
}

function move(i, d) { moveTo(i, i + d); }
function moveTo(from, to) {
  if (locked()) return;
  // 순서가 바뀌면 뷰어가 보던 자리(viewIdx)가 다른 사진을 가리키게 된다. 먼저 나온다.
  closeViewer();
  if (to < 0 || to >= state.items.length || from === to) return;
  if (state.status.length === state.items.length) { const [st] = state.status.splice(from, 1); state.status.splice(to, 0, st); }
  else state.status = [];
  const [it] = state.items.splice(from, 1); state.items.splice(to, 0, it);
  const [f] = state.flags.splice(from, 1); state.flags.splice(to, 0, f);
  invalidateCheck();
  leaveDone(); render();
}
function flip(i) {
  if (locked()) return;
  const it = state.items[i];
  // 뒤집기는 이제 표시만 바꾸는 깃발이다. 그림은 원본에서 다시 만든다 (회전 설계 §3).
  it.flipped = !it.flipped;
  rebuildImage(it);
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
  state.items[i].excluded = !state.items[i].excluded;
  state.status = [];
  invalidateCheck();
  leaveDone(); render();
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
    // 원본은 자동 뒤집기가 돌기 **전에** 잡아 둔다. 이 뒤로 뒤집기·회전은 전부
    // original에서 다시 만들므로, 여기서 한 번 놓치면 영영 손상된 그림만 남는다.
    items.forEach(it => { it.original = it.image; it.flipped = false; it.rotation = 0; });
    if (skipped.length) toast(`읽지 못한 파일 ${skipped.length}개(HEIC 등): JPG로 바꿔 넣어 주세요. ` + skipped.slice(0, 3).join(', '));
    if (state.items.length && items.length && (items[0].image.width !== state.items[0].image.width || items[0].image.height !== state.items[0].image.height)) { toast('앞서 넣은 사진과 비율이 달라 넣지 못했습니다. 한 번에 넣어 주세요.'); return; }
    // 번호는 여기서 한 번만 정하고 다시는 바뀌지 않는다. loadFiles가 이미 날짜순으로
    // 돌려주므로 순서대로 최댓값+1부터 매기면 된다 (고정 번호 설계 §3).
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
    // 새로 들어온 사진은 제외 표시가 없으므로 포함 목록의 뒤쪽 items.length장이 그대로 새 사진이다.
    applyOrientation(res, active, active.length - items.length);
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
function applyOrientation(res, active, prevCount) {
  let flipVotes = 0;
  for (let k = 0; k < prevCount; k++) if (res[k].flip) flipVotes++;
  const opposite = prevCount > 0 && flipVotes * 2 > prevCount;
  res.forEach((r, k) => {
    const { it, i } = active[k];
    if (k < prevCount || it.userFlipped) return;
    const doFlip = opposite ? !r.flip : r.flip;
    if (doFlip) { it.flipped = !it.flipped; rebuildImage(it); }
    state.flags[i] = { warn: doFlip ? 'flip' : (r.warn === 'other' ? 'other' : null) };
  });
}

const median = arr => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

// ── 각도 검사 ─────────────────────────────────────────────────
// 각도가 크게 다른 사진이 섞이면 영상이 어른거린다. 자동으로 빼지는 않고, 이웃과 잘
// 겹치지 않는 사진에 주황 배지를 붙여 원장이 ✕로 빼도록 한다 (각도 검사 설계 §1).
// 만들기(make)와 같은 잠금·취소·진행·자원 정리 틀을 쓴다.
async function checkAngles() {
  if (state.busy || state.loading) return;
  const active = activeItems();
  if (active.length < MIN_CHECK) { toast(`영상에 넣는 사진이 ${MIN_CHECK}장 이상일 때 검사할 수 있습니다.`); return; }
  closeViewer();                     // 크게 보기에서 조절하던 회전을 먼저 적용하고 시작한다
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
    const key = cacheKey();
    let T, status, aligned;
    if (state.cache && state.cache.key === key) {
      ({ T, status, aligned } = state.cache);
      progress('구도 맞추는 중', 1, 1);
    } else {
      state.cache = null;
      grays = [];
      for (const { it } of active) grays.push(toGray(cv, it.image));
      ({ T, status } = await chainTransforms(cv, grays, W, H, (i, n) => progress('구도 맞추는 중', i, n), cancelled));
      grays.forEach(g => g.delete()); grays = null;
      if (cancelled()) throw new Error('취소');
      // 밝기·색 맞추기 **전**의 기준 틀 사진을 담아 둔다. 영상 만들기가 이 배열을 그대로
      // 이어받아 구도 맞추기를 통째로 건너뛴다 (설계 §4).
      aligned = active.map(({ it }, k) => warpImage(cv, it.image, T[k], W, H));
      state.cache = { key, T, status, aligned };
    }
    state.status = spread(status, active); render();
    if (cancelled()) throw new Error('취소');
    progress('겹침 점수 계산 중');
    const scores = await neighborScores(cv, aligned, (i, n) => progress('겹침 점수 계산 중', i, n), cancelled);
    const med = median(scores), threshold = 0.75 * med;
    // 배지는 원래 자리에 붙어야 하므로 표시할 사진도 원본 번호(x.i)로 담는다.
    const flagged = new Set();
    scores.forEach((s, k) => { if (s < threshold) flagged.add(active[k].i); });
    state.angle = { scores: spread(scores, active), threshold, median: med, flagged };
    progress('완료');
    setCheckNote(`각도 검사: ${flagged.size}장 표시 (중앙값 ${med.toFixed(2)})`);
    toast(flagged.size
      ? `이웃과 많이 다른 사진 ${flagged.size}장을 표시했습니다. 각도가 다르거나 간격이 긴 사진입니다. ✕(빼기)로 빼면 영상이 매끄러워집니다.`
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
  closeViewer();                     // 크게 보기에서 조절하던 회전을 먼저 적용하고 시작한다
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
    let warped, status;
    if (state.cache && state.cache.key === cacheKey()) {
      status = state.cache.status; warped = state.cache.aligned;
      progress('구도 맞추는 중', 1, 1);      // 막대는 이 단계 몫을 한 번에 채운다
    } else {
      state.cache = null;
      grays = [];
      for (const { it } of active) grays.push(toGray(cv, it.image));
      const chain = await chainTransforms(cv, grays, W, H, (i, n) => progress('구도 맞추는 중', i, n), cancelled);
      grays.forEach(g => g.delete()); grays = null;
      status = chain.status;
      warped = active.map(({ it }, k) => warpImage(cv, it.image, chain.T[k], W, H));
    }
    state.status = spread(status, active); render();
    if (cancelled()) throw new Error('취소');
    progress('밝기·색 맞추는 중');
    // matchColors는 새 배열·새 사진을 돌려주므로 캐시의 aligned는 그대로 살아남는다.
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
    lastName = outputName(active[0].it.name, 'mp4', usedQuality, new Date());
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
$('checkBtn').onclick = checkAngles;
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
// ── 크게 보기 버튼·슬라이더 ───────────────────────────────────
$('viewClose').onclick = () => { closeViewer(); render(); };
$('viewPrev').onclick = () => stepViewer(-1);
$('viewNext').onclick = () => stepViewer(1);
$('viewFlip').onclick = () => { if (uiState === 'view') flip(viewIdx); };
$('viewExclude').onclick = () => { if (uiState === 'view') toggleExclude(viewIdx); };
// 슬라이더는 사진 데이터를 건드리지 않고 캔버스만 다시 그린다 — 끌면 바로 따라온다.
$('rotSlider').oninput = () => { $('rotValue').textContent = degLabel(+$('rotSlider').value); drawView(); };
$('rotZero').onclick = () => { $('rotSlider').value = '0'; $('rotValue').textContent = degLabel(0); drawView(); };
$('onion').onchange = () => { if (uiState === 'view') syncViewer(); };
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
  // ←/→는 입력칸에 커서가 없을 때만 앞뒤 사진으로 간다 (회전 설계 §2). 슬라이더를
  // 잡고 있을 때는 화살표가 각도를 0.5도씩 움직이는 편이 자연스럽다.
  if (uiState === 'view' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault(); stepViewer(e.key === 'ArrowLeft' ? -1 : 1); return;
  }
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
