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
