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
