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

// 화면·영상에 쓰는 날짜 글씨. 파일 이름에서 읽은 날짜는 그 지역 시간의 자정이라
// toISOString()을 쓰면 시간대에 따라 하루 앞으로 밀린다. 지역 시간 그대로 적는다.
export function dateLabel(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function baseName(name) {
  return name.replace(/\.[^.]+$/, '').split('_')[0];
}

export function sortFiles(files) {
  return [...files].sort((a, b) => {
    const aDate = parseDate(a.name), bDate = parseDate(b.name);
    if (aDate && bDate) return aDate - bDate;
    if (aDate) return -1;
    if (bDate) return 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
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
  for (const f of sortFiles(files)) {
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
