import { baseName } from './load.js';

// 파일 이름에 쓸 수 없는 글자를 빼고 앞뒤 공백을 지운다. 너무 길면 40자에서 자른다.
export function safeName(text) {
  return String(text || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40).trim();
}
// title(원장이 직접 쓴 제목)이 있으면 첫 사진 이름 대신 그것으로 시작한다.
export function outputName(firstName, ext, quality = null, date = null, title = '') {
  const head = safeName(title) || baseName(firstName);
  const base = `${head}_교정진행`;
  const Q = { high: '고품질', fast: '빠르게', none: '단순' };
  let result = base;

  if (quality && Q[quality]) {
    result += `_${Q[quality]}`;
  }

  if (date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    result += `_${year}-${month}-${day}`;
  }

  return `${result}.${ext}`;
}
export function labelMetrics(w) { return { band: Math.round(w * 0.055), font: Math.round(w * 0.035), pad: Math.round(w * 0.012) }; }
// 왼쪽 위 띠(날짜·경과 기간). align='right'면 오른쪽 위 띠(제목).
export function drawLabel(ctx, text, w, align = 'left') {
  if (!text) return;
  const { band, font, pad } = labelMetrics(w);
  ctx.save();
  ctx.font = `bold ${font}px sans-serif`;
  const tw = Math.min(ctx.measureText(text).width, w * 0.6);
  const x0 = align === 'right' ? w - (tw + pad * 2) : 0;
  ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(x0, 0, tw + pad * 2, band);
  ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle';
  ctx.fillText(text, x0 + pad, band / 2, tw);
  ctx.restore();
}
export function drawTitle(ctx, text, w) { drawLabel(ctx, text, w, 'right'); }
// 'mp4'(WebCodecs 있음) 아니면 null. 예전에는 MediaRecorder로 WebM을 만드는 예비
// 경로가 있었지만, (1) 사파리 16.4+·파이어폭스 130+도 VideoEncoder를 갖고 있어 그
// 경로가 실제로 고른 적이 없고, (2) MediaRecorder는 실제 시계로 녹화해서 프레임마다
// 계산이 걸리는 만큼 영상 길이가 몇 배로 늘어난다. 브라우저에서 한 번도 돌려 본 적
// 없는 코드를 "사파리 지원"이라고 내보내느니, 크롬·엣지를 쓰라고 분명히 안내한다.
export function pickEncoder() {
  return (typeof VideoEncoder === 'function' && typeof VideoEncoder.isConfigSupported === 'function') ? 'mp4' : null;
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
    enc.done = false;
    return enc;
  }
  async addFrame(canvas, index) {
    if (this.error) throw this.error;
    const ts = Math.round(index * 1e6 / this.fps);
    const frame = new VideoFrame(canvas, { timestamp: ts, duration: Math.round(1e6 / this.fps) });
    try {
      this.encoder.encode(frame, { keyFrame: index % 60 === 0 });
    } finally {
      frame.close();
    }
    while (this.encoder.encodeQueueSize > 8) await new Promise(r => setTimeout(r, 20));
  }
  async finish() {
    await this.encoder.flush();
    // flush 도중에 인코더가 죽으면 지금까지 받은 조각만으로 조용히 짧은 MP4가 나온다.
    // 에러가 있었으면 여기서 던져 "완료"로 위장하지 않는다.
    if (this.error) throw this.error;
    this.encoder.close(); this.done = true; this.muxer.finalize();
    return new Blob([this.muxer.target.buffer], { type: 'video/mp4' });
  }
  // 오류·취소로 중간에 그만둘 때 하드웨어 인코더를 놓아 준다. 이걸 안 하면 취소를
  // 반복할수록 살아 있는 VideoEncoder가 쌓인다.
  abort() {
    if (this.done) return;
    this.done = true;
    try { if (this.encoder && this.encoder.state !== 'closed') this.encoder.close(); } catch (e) { /* 이미 닫힘 */ }
  }
}
