import { loadFiles, monthsLabel } from './load.js';
import { toGray } from './features.js';
import { checkOrientation, flipImageData } from './orient.js';
import { chainTransforms, warpImage, alignedSize } from './align.js';
import { matchColors } from './color.js';
import { planTiming, aiLevelsFor, Rife, transition, imageToCHW, chwToImage } from './interp.js';
import { pickEncoder, Mp4Encoder, WebmEncoder, drawLabel, outputName } from './encode.js';
import { cvReady } from './cvready.js';

const $ = id => document.getElementById(id);
const state = { items: [], flags: [], status: [], cancelled: false, busy: false, loading: false };
const MAX = 40;

function setMsg(t) { $('msg').textContent = t || ''; }
function progress(stage, i, n) { $('stage').textContent = n ? `${stage} ${i}/${n}` : stage; $('bar').firstElementChild.style.width = n ? `${Math.round(100 * i / n)}%` : '0%'; }
// 만들기(make)가 도는 동안에는 사진 줄을 건드릴 수 없어야 한다. make()는 state.items를
// 통째로 읽어 T(변환 배열)와 길이를 맞춰 두는데, 그 사이에 한 장이라도 빼거나 순서를
// 바꾸면 T[i]가 엉뚱한 사진에 붙거나 아예 undefined가 되어 도중에 터진다.
function locked() { return state.busy || state.loading; }
function renderStrip() {
  const s = $('strip'); s.innerHTML = '';
  const lock = locked();
  $('drop').classList.toggle('off', lock);
  state.items.forEach((it, i) => {
    const d = document.createElement('div'); d.className = 'thumb'; d.draggable = !lock;
    const f = state.flags[i]; if (f && f.warn === 'flip') d.classList.add('warn-flip'); if (f && f.warn === 'other') d.classList.add('warn-other'); if (state.status[i] === 'fail') d.classList.add('fail');
    const c = document.createElement('canvas'); c.width = it.image.width; c.height = it.image.height; c.getContext('2d').putImageData(it.image, 0, 0);
    const img = document.createElement('img'); img.src = c.toDataURL('image/jpeg', 0.6); d.appendChild(img);
    const cap = document.createElement('div'); cap.className = 'cap'; cap.textContent = `${i + 1}. ${it.name}` + (f && f.warn === 'flip' ? ' (자동 뒤집음)' : f && f.warn === 'other' ? ' (다른 방향?)' : ''); d.appendChild(cap);
    const b = document.createElement('div'); b.className = 'btns';
    for (const [t, fn] of [['◀', () => move(i, -1)], ['▶', () => move(i, 1)], ['⇄', () => flip(i)], ['✕', () => remove(i)]]) { const x = document.createElement('button'); x.textContent = t; x.onclick = fn; x.disabled = lock; b.appendChild(x); }
    d.appendChild(b);
    d.ondragstart = e => { if (lock) { e.preventDefault(); return; } e.dataTransfer.setData('text/plain', String(i)); };
    d.ondragover = e => e.preventDefault();
    // 운영체제에서 끌어온 파일은 text/plain이 빈 문자열이라 +'' === 0이 되고, 예전에는
    // 그게 moveTo(0, i)로 해석되어 사진 1이 슬쩍 옮겨지고 끌어온 파일은 사라졌다.
    // 파일이 실려 있으면 순서 바꾸기가 아니라 "사진 추가"로 보낸다.
    d.ondrop = e => {
      e.preventDefault(); e.stopPropagation();
      if (e.dataTransfer.files && e.dataTransfer.files.length) { addFiles(e.dataTransfer.files); return; }
      const from = +e.dataTransfer.getData('text/plain');
      if (!Number.isInteger(from) || from < 0 || from >= state.items.length) return;
      moveTo(from, i);
    };
    s.appendChild(d);
  });
  $('go').disabled = state.items.length < 2 || lock;
  const noDate = state.items.some(it => !it.date);
  $('label').disabled = noDate; if (noDate) $('label').checked = false;
}
// state.status(정합 성공/실패 표시)는 chainTransforms가 채운 배열이라 items/flags와
// 길이·순서가 항상 같아야 한다. 어긋나면(예: 아직 한 번도 만들기를 안 돌렸거나, 다른
// 조작으로 길이가 안 맞으면) 통째로 비워서 엉뚱한 사진에 회색 "구도 실패" 표시가
// 붙는 사고를 막는다 — 어차피 사진 구성이 바뀌면 다시 만들기를 눌러야 최신 상태가 된다.
function move(i, d) { moveTo(i, i + d); }
function moveTo(from, to) {
  if (to < 0 || to >= state.items.length || from === to) return;
  if (state.status.length === state.items.length) { const [st] = state.status.splice(from, 1); state.status.splice(to, 0, st); }
  else state.status = [];
  const [it] = state.items.splice(from, 1); state.items.splice(to, 0, it);
  const [f] = state.flags.splice(from, 1); state.flags.splice(to, 0, f);
  renderStrip();
}
function flip(i) {
  state.items[i].image = flipImageData(state.items[i].image); state.flags[i] = { warn: null };
  // 사용자가 직접 정한 방향은 나중에 사진을 더 넣어도 자동 판정이 뒤엎지 않는다.
  state.items[i].userFlipped = true;
  state.status = []; // 뒤집으면 이전 정합 결과가 더 이상 맞지 않는다
  renderStrip();
}
function remove(i) {
  if (state.status.length === state.items.length) state.status.splice(i, 1);
  else state.status = [];
  state.items.splice(i, 1); state.flags.splice(i, 1);
  renderStrip();
}

async function addFiles(files) {
  if (state.loading || state.busy) return; // 읽는 중이거나 영상 만드는 중이면 무시
  state.loading = true; setMsg(''); renderStrip();
  let grays = null;
  try {
    const arr = [...files];
    const remain = MAX - state.items.length;
    if (remain <= 0) { setMsg('이미 40장이 있어 더 넣을 수 없습니다.'); return; }
    const list = arr.slice(0, remain);
    if (arr.length > list.length) setMsg(`한 번에 ${MAX}장까지만 넣을 수 있어 앞 ${list.length}장만 받았습니다.`);
    progress('사진 읽는 중');
    const { items, skipped } = await loadFiles(list, 1280);
    if (skipped.length) setMsg(`읽지 못한 파일 ${skipped.length}개(HEIC 등): JPG로 바꿔 넣어 주세요. ` + skipped.slice(0, 3).join(', '));
    if (state.items.length && items.length && (items[0].image.width !== state.items[0].image.width || items[0].image.height !== state.items[0].image.height)) { setMsg('앞서 넣은 사진과 비율이 달라 넣지 못했습니다. 한 번에 넣어 주세요.'); return; }
    state.items.push(...items); state.flags.push(...items.map(() => ({ warn: null })));
    state.status = [];
    const cv = await cvReady();
    progress('방향 검사 중');
    grays = state.items.map(it => toGray(cv, it.image));
    const W = state.items[0].image.width;
    const res = await checkOrientation(cv, grays, W, (i, n) => progress('방향 검사 중', i, n));
    grays.forEach(g => g.delete()); grays = null;
    applyOrientation(res, state.items.length - items.length);
  } catch (e) {
    setMsg('오류: ' + (e.message || e));
  } finally {
    if (grays) { grays.forEach(g => g.delete()); grays = null; }
    state.loading = false;
    progress(''); renderStrip();
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
  state.busy = true; state.cancelled = false; $('go').disabled = true; $('cancel').hidden = false; $('result').hidden = true; setMsg('');
  const cancelled = () => state.cancelled;
  let grays = null;
  try {
    const cv = await cvReady();
    const W = state.items[0].image.width, H = state.items[0].image.height;
    grays = state.items.map(it => toGray(cv, it.image));
    const { T, status } = await chainTransforms(cv, grays, W, H, (i, n) => progress('구도 맞추는 중', i, n));
    grays.forEach(g => g.delete()); grays = null; state.status = status; renderStrip();
    if (cancelled()) throw new Error('취소');
    progress('밝기·색 맞추는 중');
    const aligned = matchColors(state.items.map((it, i) => warpImage(cv, it.image, T[i], W, H)));
    const { cw, ch } = alignedSize(W, H);
    const stepSec = +$('step').value, { N, fps } = planTiming(stepSec);
    const quality = $('quality').value;
    progress('인공지능 모델 준비 중');
    const ort = await import('../../vendor/ort/ort.webgpu.min.mjs'); ort.env.wasm.wasmPaths = '/vendor/ort/';
    const rife = await Rife.create(ort, '/motion/models/rife_fp32.onnx');
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
  finally {
    if (grays) { grays.forEach(g => g.delete()); grays = null; }
    state.busy = false; $('cancel').hidden = true; $('go').disabled = state.items.length < 2;
  }
}

$('drop').onclick = () => $('file').click();
$('file').onchange = e => addFiles(e.target.files);
$('drop').ondragover = e => { e.preventDefault(); $('drop').classList.add('over'); };
$('drop').ondragleave = () => $('drop').classList.remove('over');
$('drop').ondrop = e => { e.preventDefault(); e.stopPropagation(); $('drop').classList.remove('over'); addFiles(e.dataTransfer.files); };
// 사진 줄이나 넣는 칸 밖(카드 여백·설정 줄·배경)에 사진을 떨어뜨리면 브라우저 기본
// 동작으로 그 파일 주소로 이동해 버려 작업하던 사진이 전부 날아간다. 창 전체에서
// 기본 동작을 막고, 떨어진 파일은 그냥 사진 추가로 받아 준다.
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => {
  e.preventDefault();
  if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
});
$('step').oninput = () => { $('stepv').textContent = `${$('step').value}초`; };
$('go').onclick = make;
$('cancel').onclick = () => { state.cancelled = true; };
