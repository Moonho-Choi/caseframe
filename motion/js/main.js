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

function cvReady() {
  if (window.cv && typeof window.cv.then === 'function') window.cv.then(m => { window.cv = m; });
  return new Promise(r => { const t = () => (window.cv && window.cv.Mat ? r(window.cv) : setTimeout(t, 100)); t(); });
}
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
