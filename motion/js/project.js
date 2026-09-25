// Portable project metadata. Pixel data is encoded/decoded locally by the UI.
export const settingIds = ['quality', 'step', 'title', 'labelMode', 'vshift', 'hshift', 'crop'];
const sources = new WeakMap();
let nextSource = 1;
export function sourceKey(it) {
  const source = it.original || it.image;
  if (!source) return 0;
  if (!sources.has(source)) sources.set(source, nextSource++);
  return sources.get(source);
}
export function editMetadata(it) {
  return { name: it.name, no: it.no, date: it.date?.getTime() ?? null,
    flipped: !!it.flipped, flips: it.flips || 0, userFlipped: !!it.userFlipped,
    excluded: !!it.excluded, autoExcluded: !!it.autoExcluded, protected: !!it.protected,
    adjust: { ...(it.adjust || { scale: 1, rotation: 0, dx: 0, dy: 0 }) },
    T: it.T ? Array.from(it.T) : null, status: it.status || 'ok' };
}
export function resultKey(items, settings, reference) {
  // Protection changes only future selection; it does not alter the current video.
  return JSON.stringify({ settings, reference, items: items.filter(it => !it.excluded).map(it => {
    const m = editMetadata(it); delete m.protected; delete m.autoExcluded;
    return { ...m, source: sourceKey(it) };
  }) });
}
export function validateProject(p) {
  const fail = () => { throw new Error('지원하지 않거나 손상된 CaseFrame 작업 파일입니다.'); };
  if (!p || p.format !== 'caseframe-motion' || p.version !== 1 || !Array.isArray(p.items) || !p.items.length || p.items.length > 40) fail();
  const s = p.settings;
  if (!s || !['high','fast','none'].includes(s.quality) || !['date','months','none'].includes(s.labelMode) || typeof s.title !== 'string' || s.title.length > 40) fail();
  for (const [key, min, max] of [['step',.5,3],['vshift',-10,10],['hshift',-10,10],['crop',0,15]]) {
    if (typeof s[key] !== 'string' || !s[key].trim() || !Number.isFinite(+s[key]) || +s[key] < min || +s[key] > max) fail();
  }
  const numbers = new Set();
  for (const it of p.items) {
    if (!it || typeof it.name !== 'string' || it.name.length > 1024 || !Number.isInteger(it.no) || it.no < 1 || numbers.has(it.no)) fail();
    numbers.add(it.no);
    if (it.date !== null && (!Number.isFinite(it.date) || !Number.isFinite(new Date(it.date).getTime()))) fail();
    if (!Number.isInteger(it.flips) || it.flips < 0) fail();
    for (const k of ['flipped','userFlipped','excluded','autoExcluded','protected']) if (typeof it[k] !== 'boolean') fail();
    if (it.protected && it.excluded) fail();
    const a = it.adjust;
    if (!a || ![a.scale,a.rotation,a.dx,a.dy].every(Number.isFinite) || a.scale < .5 || a.scale > 2 || Math.abs(a.rotation) > 10 || Math.abs(a.dx) > 1e6 || Math.abs(a.dy) > 1e6) fail();
    if (it.T !== null && (!Array.isArray(it.T) || it.T.length !== 6 || !it.T.every(Number.isFinite) || Math.abs(it.T[0]*it.T[4]-it.T[1]*it.T[3]) < 1e-8)) fail();
    if (!['ok','ecc','fail'].includes(it.status) || typeof it.png !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(it.png)) fail();
  }
  if (typeof p.reference !== 'string' || (p.reference !== '' && !numbers.has(Number(p.reference)))) fail();
  return p;
}
