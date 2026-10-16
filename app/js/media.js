/*
  The video engine shared by UW Color and UW Reels: open a clip, read frames, and re-encode it with
  every frame passed through a drawing step (colour correction, a moving crop). Up to 4K60 and beyond,
  whatever the device can decode and encode.

  Decoding, best first:
  1. WebCodecs through Mediabunny, as the file describes itself.
  2. WebCodecs with a cleaned-up decoder config. Safari rejects some perfectly playable files because
     of one field (an unusual colour-space value, an H.264 level it doesn't list), so a few safe
     variants are tried and the first one Safari accepts is used (PatchedDecoder below).
  3. The browser's own <video> player, which plays anything the Photos app can. Each frame is taken
     by seeking to it, which is exact.
  Encoding is always WebCodecs, paced so the encoder never skips frames (see makePacer), and the
  audio is copied over untouched. Every source frame in range becomes exactly one output frame.
*/
import {
  Input, Output, BlobSource, StreamTarget, Mp4OutputFormat, MP4, QTFF, Quality,
  VideoSampleSink, getFirstEncodableVideoCodec,
  CustomVideoDecoder, registerDecoder, VideoSample, EncodedPacketSink, EncodedAudioPacketSource, VideoSampleSource
} from '../vendor/mediabunny.js';
import { createSink } from './store.js';

export { Quality, getFirstEncodableVideoCodec };

var FORMATS = [MP4, QTFF]; // GoPro, phones and most cameras: .mp4 / .mov
var EPS = 1e-4; // decoded timestamps are whole microseconds; container ones are exact

export function canExportVideo() {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
}

var CODEC_NAMES = { avc: 'H.264', hevc: 'HEVC', vp9: 'VP9', av1: 'AV1', vp8: 'VP8' };
export function codecName(c) { return CODEC_NAMES[c] || (c ? String(c).toUpperCase() : 'unknown'); }

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

function undecodable(codec, detail) {
  return new Error('This browser can’t decode ' + codecName(codec) + ' video' + (detail ? ' (' + detail + ')' : '') +
    (codec === 'hevc' ? '. Try Safari, or Chrome/Edge on a device with HEVC hardware support. On the GoPro, H.264 is the most compatible setting.' : '.'));
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function withTimeout(p, ms, what) {
  return Promise.race([p, sleep(ms).then(function () { throw new Error(what + ' timed out'); })]);
}
function aborted() { return new DOMException('Canceled', 'AbortError'); }

/* ---------- 2. WebCodecs with a patched decoder config ---------- */

var patched = new Map(); // original config key -> config the browser accepts
function cfgKey(c) {
  var d = c.description, n = d ? d.byteLength : 0, sum = 0;
  if (d) { var b = d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength); for (var i = 0; i < b.length; i++) sum = (sum * 31 + b[i]) >>> 0; }
  return [c.codec, c.codedWidth, c.codedHeight, JSON.stringify(c.colorSpace || null), n, sum].join('|');
}
async function nativeOK(c) {
  try { return (await VideoDecoder.isConfigSupported(c)).supported === true; } catch (e) { return false; }
}
function configVariants(c) {
  var codecs = [c.codec], m;
  if ((m = /^(avc[13])\.([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c.codec))) {
    ['avc1', 'avc3'].forEach(function (pre) {
      [m[4], '34', '33', '3c', '3d', '3e', '32', '2a', '28'].forEach(function (lvl) {
        [m[3], '00'].forEach(function (cons) { codecs.push(pre + '.' + m[2] + cons + lvl); });
      });
    });
  } else if ((m = /^(hvc1|hev1)\.(.+)$/i.exec(c.codec))) {
    ['hvc1', 'hev1'].forEach(function (pre) {
      [null, 'L150', 'L153', 'L156', 'L183', 'L186', 'L123'].forEach(function (lvl) {
        codecs.push(pre + '.' + (lvl ? m[2].replace(/[LH]\d+/, lvl) : m[2]));
      });
    });
  }
  codecs = codecs.filter(function (x, i) { return codecs.indexOf(x) === i; });
  var spaces = [c.colorSpace, null, { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false }];
  var out = [];
  spaces.forEach(function (sp) {
    codecs.forEach(function (codec) {
      var v = { codec: codec, codedWidth: c.codedWidth, codedHeight: c.codedHeight };
      if (c.description) v.description = c.description;
      if (sp) v.colorSpace = sp;
      out.push(v);
    });
  });
  out.push(c.description ? { codec: c.codec, description: c.description } : { codec: c.codec });
  return out;
}

class PatchedDecoder extends CustomVideoDecoder {
  static supports(codec, config) { return patched.has(cfgKey(config)); }
  init() {
    var self = this;
    this.queue = [];
    this.decoder = new VideoDecoder({
      output: function (frame) { self.push(new VideoSample(frame)); },
      error: function (e) { self.onError(e); }
    });
    this.decoder.configure(patched.get(cfgKey(this.config)));
  }
  // Safari can hand frames out of presentation order; hold them until a later one arrives.
  push(s) {
    var q = this.queue, self = this;
    if (q.length && s.timestamp >= q[q.length - 1].timestamp) { q.forEach(function (x) { self.onSample(x); }); q.length = 0; }
    var i = q.length;
    while (i > 0 && q[i - 1].timestamp > s.timestamp) i--;
    q.splice(i, 0, s);
  }
  async decode(packet) {
    while (this.decoder.decodeQueueSize > 6 && this.decoder.state === 'configured') await sleep(2);
    this.decoder.decode(packet.toEncodedVideoChunk());
  }
  async flush() {
    await this.decoder.flush();
    var self = this;
    this.queue.forEach(function (x) { self.onSample(x); });
    this.queue.length = 0;
  }
  close() {
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    (this.queue || []).forEach(function (x) { x.close(); });
    this.queue = [];
  }
}
registerDecoder(PatchedDecoder);

/* Whether WebCodecs can decode this track, as is or with a patched config. Returns a short reason when it can't. */
var FORCE = (function () { try { return localStorage.getItem('uw-force-decoder'); } catch (e) { return null; } })(); // testing aid: 'patched' | 'element'
async function webCodecsDecodable(track) {
  try { return await checkDecodable(track); } catch (e) { return { ok: false, why: String(e && e.message || e) }; }
}
async function checkDecodable(track) {
  if (typeof VideoDecoder === 'undefined') return { ok: false, why: 'no VideoDecoder' };
  var cfg = await track.getDecoderConfig();
  if (!cfg) return { ok: false, why: 'unknown codec' };
  if (FORCE === 'element') return { ok: false, why: 'forced' };
  if (FORCE === 'patched') { patched.set(cfgKey(cfg), cfg); return { ok: true, patched: true }; }
  if (patched.has(cfgKey(cfg)) || await nativeOK(cfg)) return { ok: true };
  var vs = configVariants(cfg);
  for (var i = 0; i < vs.length; i++) {
    if (await nativeOK(vs[i])) { patched.set(cfgKey(cfg), vs[i]); return { ok: true, patched: true }; }
  }
  return { ok: false, why: cfg.codec + ', ' + cfg.codedWidth + '×' + cfg.codedHeight };
}

/* ---------- 3. The browser's own player ---------- */

function loadElement(file) {
  return new Promise(function (resolve, reject) {
    var v = document.createElement('video'), url = URL.createObjectURL(file), done = false;
    v.muted = true; v.defaultMuted = true; v.playsInline = true; v.preload = 'auto';
    v.setAttribute('playsinline', ''); v.setAttribute('muted', '');
    // Kept in the page (but invisible) so every browser keeps decoding and presenting frames.
    v.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:.01;pointer-events:none;z-index:-1';
    var api = {
      el: v,
      dispose: function () {
        try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) {}
        v.remove(); URL.revokeObjectURL(url);
      }
    };
    var timer = 0;
    var fail = function () { if (done) return; done = true; clearTimeout(timer); api.dispose(); reject(new Error('The built-in player can’t open this file either.')); };
    var ready = function () {
      if (done || v.readyState < 2 || !v.videoWidth) return;
      done = true; clearTimeout(timer); resolve(api);
    };
    v.addEventListener('error', fail, { once: true });
    timer = setTimeout(fail, 30000);
    ['loadeddata', 'canplay', 'seeked'].forEach(function (t) { v.addEventListener(t, ready); });
    v.addEventListener('loadedmetadata', function () {
      if (!v.videoWidth) { fail(); return; }
      // iOS loads and paints picture data only once playback has started, and refuses play() in
      // Low Power Mode, so start it briefly and also nudge it with a seek.
      var after = function () { v.pause(); if (v.readyState < 2) v.currentTime = Math.min(0.001, v.duration || 0); ready(); };
      var p = v.play();
      if (p && p.then) p.then(after, after); else after();
    }, { once: true });
    document.body.appendChild(v);
    v.src = url;
    v.load();
  });
}

/* Seek and resolve once the new frame is actually ready to draw. */
function seekEl(v, t) {
  return new Promise(function (resolve) {
    var target = clamp(t, 0, Math.max(0, (v.duration || 0) - 0.001)), fin = false;
    var finish = function () { if (fin) return; fin = true; resolve(); };
    if (Math.abs(v.currentTime - target) < 0.0005 && v.readyState >= 2) { finish(); return; }
    var onSeeked = function () {
      // Safari can still hold the previous picture right after 'seeked'; wait for the new one to be presented.
      if (v.requestVideoFrameCallback) { v.requestVideoFrameCallback(function () { finish(); }); setTimeout(finish, 120); } else setTimeout(finish, 30);
    };
    v.addEventListener('seeked', onSeeked, { once: true });
    setTimeout(finish, 5000);
    v.currentTime = target;
  });
}

/* ---------- Opening a clip for preview ---------- */

export async function openVideo(file) {
  var input = new Input({ source: new BlobSource(file), formats: FORMATS });
  try {
    var track = null, dec = { ok: false, why: '' };
    var info = { width: 0, height: 0, codec: null, start: 0, end: 0, fps: 0, bitrate: 0, hdr: false, via: 'webcodecs' };
    try { track = await input.getPrimaryVideoTrack(); } catch (e) { dec.why = String(e && e.message || e); }
    if (!track && !dec.why) throw new Error('This file has no video track.');
    if (track) {
      var safe = function (p, d) { return Promise.resolve(p).then(null, function () { return d; }); };
      var r = await Promise.all([
        safe(track.getDisplayWidth(), 0), safe(track.getDisplayHeight(), 0), safe(track.getCodec(), null),
        safe(track.getFirstTimestamp(), 0), safe(input.computeDuration(), 0), safe(track.computePacketStats(240), {}), safe(track.hasHighDynamicRange(), false)
      ]);
      info = { width: r[0], height: r[1], codec: r[2], start: Math.max(0, r[3]), end: r[4], fps: r[5].averagePacketRate || 0, bitrate: r[5].averageBitrate || 0, hdr: r[6], via: 'webcodecs' };
      dec = await webCodecsDecodable(track);
    }
    if (dec.ok) {
      try {
        var sink = new VideoSampleSink(track);
        var first = await withTimeout(sink.getSample(info.start), 15000, 'Decoding');
        if (!first) throw new Error('No frames');
        first.close();
        if (dec.patched) info.via = 'webcodecs-patched';
        return {
          info: info,
          /* Draw the frame shown at time t (seconds) so that it fills the context's canvas. */
          draw: async function (t, ctx) {
            var s = await sink.getSample(clamp(t, info.start, info.end));
            if (!s) s = await sink.getSample(info.start);
            if (!s) throw new Error('No frame at this time.');
            try { s.drawWithFit(ctx, { fit: 'fill' }); } finally { s.close(); }
          },
          dispose: function () { try { input.dispose(); } catch (e) {} }
        };
      } catch (e) { dec = { ok: false, why: String(e && e.message || e) }; }
    }

    // Fall back to the browser's own player.
    var el;
    try { el = await loadElement(file); } catch (e) { throw undecodable(info.codec, dec.why); }
    try { input.dispose(); } catch (e) {}
    var v = el.el;
    info.width = v.videoWidth; info.height = v.videoHeight;
    info.start = 0; info.end = isFinite(v.duration) && v.duration > 0 ? v.duration : info.end;
    if (!info.fps) info.fps = 30;
    info.via = 'element';
    var busy = Promise.resolve();
    return {
      info: info,
      draw: function (t, ctx) {
        // one seek at a time on the shared element
        var job = busy.then(function () { return seekEl(v, t); }).then(function () { ctx.drawImage(v, 0, 0, ctx.canvas.width, ctx.canvas.height); });
        busy = job.catch(function () {});
        return job;
      },
      dispose: el.dispose
    };
  } catch (e) {
    try { input.dispose(); } catch (_) {}
    throw e;
  }
}

/*
  Size, codec, frame rate and length from the container alone (no decoding), plus the time of every
  frame (seconds from the first one), for stepping and trimming exactly on frames.
*/
export async function probeVideo(file) {
  var input = new Input({ source: new BlobSource(file), formats: FORMATS });
  try {
    var track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('This file has no video track.');
    var safe = function (p, d) { return Promise.resolve(p).then(null, function () { return d; }); };
    var r = await Promise.all([
      safe(track.getDisplayWidth(), 0), safe(track.getDisplayHeight(), 0), safe(track.getCodec(), null),
      safe(input.computeDuration(), 0), safe(track.computePacketStats(240), {}), safe(track.hasHighDynamicRange(), false), safe(frameTimes(track), null)
    ]);
    var times = r[6], frames = null;
    if (times) { var t0 = times[0]; frames = Float64Array.from(times.filter(function (t) { return t >= 0; }), function (t) { return t - t0; }); }
    return {
      width: r[0], height: r[1], codec: r[2], end: r[3], bitrate: r[4].averageBitrate || 0, hdr: r[5],
      fps: times ? frameRateOf(times) : r[4].averagePacketRate || 0, frames: frames
    };
  } finally {
    try { input.dispose(); } catch (e) {}
  }
}

/* ---------- Frames ---------- */

/* Presentation times of every frame in the file, read from the container (cheap: no decoding). */
async function frameTimes(track) {
  var times = [];
  for await (var p of new EncodedPacketSink(track).packets(undefined, undefined, { metadataOnly: true })) times.push(p.timestamp);
  times.sort(function (a, b) { return a - b; });
  if (!times.length) throw new Error('This video has no frames.');
  return times;
}
export function frameRateOf(times) {
  if (times.length < 2) return 30;
  var d = [];
  for (var i = 1; i < times.length; i++) d.push(times[i] - times[i - 1]);
  d.sort(function (a, b) { return a - b; });
  var med = d[d.length >> 1];
  return med > 0 ? 1 / med : 30;
}
function countUpTo(times, t) { // number of frames starting at or before t
  var lo = 0, hi = times.length;
  while (lo < hi) { var mid = (lo + hi) >> 1; if (times[mid] <= t + EPS) lo = mid + 1; else hi = mid; }
  return lo;
}
/*
  The frames to use: those from `start` to `end` (seconds from the first frame; either may be null),
  thinned out to at most `maxFps` frames a second (so 120 fps becomes 60 by keeping every other one).
*/
function pickFrames(times, start, end, maxFps) {
  var t0 = times[0], a = start != null ? t0 + start : -Infinity, b = end != null ? t0 + end : Infinity;
  var out = [], lastSlot = -Infinity;
  for (var i = 0; i < times.length; i++) {
    var t = times[i];
    if (t < 0 || t < a - EPS || t >= b - EPS) continue;
    if (maxFps) { var slot = Math.floor((t - t0) * maxFps + 1e-3); if (slot <= lastSlot) continue; lastSlot = slot; } // 120 → 60: frames 0, 2, 4…
    out.push(t);
  }
  return out;
}

function codedError(message, code) { var e = new Error(message); e.code = code; return e; }

/*
  A decoded frame, upright. `image(w, h)` returns something drawImage / texImage2D can take: the
  frame itself, or (for rotated phone clips) a copy drawn upright at w×h (default: full size).
*/
function sampleFrame(sample, t, index, W, H, turned, shared) {
  var vf = null;
  return {
    t: t, index: index, width: W, height: H,
    image: function (w, h) {
      if (!turned) { if (!vf) vf = sample.toVideoFrame(); return vf; }
      w = w || W; h = h || H;
      if (!shared.c) { shared.c = document.createElement('canvas'); shared.x = shared.c.getContext('2d'); }
      if (shared.c.width !== w || shared.c.height !== h) { shared.c.width = w; shared.c.height = h; }
      sample.drawWithFit(shared.x, { fit: 'fill' });
      return shared.c;
    },
    close: function () { if (vf) { vf.close(); vf = null; } }
  };
}

/* WebCodecs: yields the frames at the times in `want`, and fails ('skipped') if the decoder drops any. */
async function* decodeFrames(track, times, want, signal) {
  var W = await track.getDisplayWidth(), H = await track.getDisplayHeight();
  var turned = (await track.getRotation()) !== 0 || (await track.getFlip());
  var first = want[0], lastWant = want[want.length - 1], base = countUpTo(times, first - 2 * EPS);
  var k = 0, decoded = 0, last = -Infinity, shared = {};
  var check = function (t) {
    var expected = countUpTo(times, t) - base;
    if (expected - decoded > Math.max(10, expected * 0.02)) throw codedError('The decoder skipped frames.', 'skipped');
  };
  for await (var sample of new VideoSampleSink(track).samples(first, lastWant + 0.001)) {
    var f = null;
    try {
      if (signal && signal.aborted) throw aborted();
      var t = sample.timestamp;
      if (t < 0 || t <= last) continue; // not shown / repeated
      last = t;
      if (t < first - EPS) continue; // lead-in before the range
      if (t > lastWant + EPS) break;
      decoded++;
      check(t); // the decoder must hand over every frame the file has; if not, the built-in player route is used
      while (k < want.length && want[k] < t - EPS) k++;
      if (k >= want.length || Math.abs(want[k] - t) > EPS) continue; // thinned out
      f = sampleFrame(sample, want[k], k, W, H, turned, shared);
      k++;
      yield f;
    } finally {
      if (f) f.close();
      sample.close();
    }
  }
  check(lastWant);
}

/* Built-in player: one exact seek per frame. */
async function* elementFrames(el, times, want, signal) {
  var v = el.el, t0 = times[0];
  v.pause();
  for (var i = 0; i < want.length; i++) {
    if (signal && signal.aborted) throw aborted();
    await seekEl(v, want[i] - t0 + 0.001);
    yield { t: want[i], index: i, width: v.videoWidth, height: v.videoHeight, image: function () { return v; }, close: function () {} };
  }
}

/*
  Read frames without encoding (e.g. small copies for tracking). Options: start, end (seconds from
  the first frame), fps (frames a second to read), signal, onStart({ times, via, width, height }),
  onFrame(frame) where frame = { t (seconds from the first frame), index, width, height, image() },
  onProgress(fraction). A run that fails half-way through WebCodecs starts over on the built-in player
  (onStart is called again).
*/
export async function scanFrames(file, o) {
  var input = new Input({ source: new BlobSource(file), formats: FORMATS });
  try {
    var track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('This file has no video track.');
    var times = await frameTimes(track), t0 = times[0];
    var want = pickFrames(times, o.start, o.end, o.fps);
    if (!want.length) throw new Error('No frames in this range.');
    var rel = want.map(function (t) { return t - t0; });
    var run = async function (frames, via, W, H) {
      if (o.onStart) o.onStart({ times: rel, via: via, width: W, height: H });
      var n = 0;
      for await (var f of frames) {
        o.onFrame({ t: f.t - t0, index: f.index, width: f.width, height: f.height, image: f.image });
        if (o.onProgress) o.onProgress(++n / want.length);
      }
    };
    var dec = await webCodecsDecodable(track), firstError = null;
    if (dec.ok) {
      try { await run(decodeFrames(track, times, want, o.signal), 'webcodecs', await track.getDisplayWidth(), await track.getDisplayHeight()); return; } catch (e) {
        if (o.signal && o.signal.aborted) throw aborted();
        firstError = e;
      }
    }
    var el;
    try { el = await loadElement(file); } catch (e) { throw firstError && firstError.code !== 'skipped' ? firstError : undecodable(await track.getCodec(), dec.why); }
    try { await run(elementFrames(el, times, want, o.signal), 'element', el.el.videoWidth, el.el.videoHeight); } finally { el.dispose(); }
  } finally {
    try { input.dispose(); } catch (e) {}
  }
}

/* ---------- Encoding ---------- */

/*
  Keeps the encoder from being handed frames faster than it finishes them. Safari's hardware encoders
  behave like video-call encoders and silently skip frames that arrive while they're busy: at 4K 8:7
  that turned a 60 fps clip into 15 fps. So each frame waits until the previous ones have come out.
  An encoder that holds frames back on purpose (no output until several have gone in) shows up as a
  long wait with no output; then more frames are allowed in flight, unless `strict`.
*/
function makePacer(strict) {
  var sent = 0, done = 0, ahead = 0, wake = null;
  var tick = function () { if (wake) { var w = wake; wake = null; w(); } };
  return {
    packet: function () { done++; tick(); },
    wait: async function () {
      var since = performance.now(), seen = done;
      while (sent - done > ahead) {
        await new Promise(function (r) { wake = r; setTimeout(r, 50); });
        if (done !== seen) { seen = done; since = performance.now(); continue; }
        if (!strict && performance.now() - since > (done ? 1500 : 4000)) { ahead = Math.min(16, ahead * 2 + 2); since = performance.now(); }
      }
      sent++;
    },
    dropped: function () { return sent - done; }
  };
}

/*
  Output file with the video track, and the source's audio copied packet for packet. Audio from
  `from` to `to` (source seconds) is kept and moved back by `from`, matching the video.
*/
async function openOutput(input, name, plan, fps, pacer, from, to) {
  var sink = await createSink(name, 'video/mp4'), output = null;
  try {
    output = new Output({
      format: new Mp4OutputFormat({ fastStart: false }),
      target: new StreamTarget(sink.stream, { chunked: true, chunkSize: 16 * 1024 * 1024 })
    });
    var vsrc = new VideoSampleSource({
      codec: plan.codec, quality: new Quality({ bitrate: plan.bitrate }), keyFrameInterval: 1,
      latencyMode: 'quality', // WebCodecs: "must not drop frames" in this mode
      sizeChangeBehavior: 'fill', onEncodedPacket: function () { pacer.packet(); }
    });
    output.addVideoTrack(vsrc, { frameRate: fps });
    var atrack = null, acodec = null, asrc = null;
    try { atrack = await input.getPrimaryAudioTrack(); acodec = atrack ? await atrack.getCodec() : null; } catch (e) { atrack = null; }
    if (acodec) { asrc = new EncodedAudioPacketSource(acodec); output.addAudioTrack(asrc); }
    await output.start();
    var stopAudio = false;
    var audioDone = (async function () {
      if (!asrc) return;
      var cfg = await atrack.getDecoderConfig(), first = true;
      for await (var p of new EncodedPacketSink(atrack).packets()) {
        if (stopAudio) return;
        if (p.timestamp < from - EPS) continue; // encoder priming before the start of the clip, or trimmed off
        if (p.timestamp >= to) break;
        if (from) p = p.clone({ timestamp: p.timestamp - from });
        await asrc.add(p, first && cfg ? { decoderConfig: cfg } : undefined);
        first = false;
      }
      asrc.close();
    })();
    audioDone.catch(function () {});
    return {
      vsrc: vsrc,
      finish: async function () {
        vsrc.close();
        await audioDone;
        await output.finalize();
        output = null;
        var file = await sink.finish();
        sink = null;
        return file;
      },
      cancel: async function () {
        stopAudio = true;
        if (output) { try { await output.cancel(); } catch (e) {} output = null; }
        if (sink) { await sink.abort(); sink = null; }
      }
    };
  } catch (e) {
    if (output) { try { await output.cancel(); } catch (_) {} }
    await sink.abort();
    throw e;
  }
}

/*
  Re-encode a clip, passing every frame through a drawing step. Job:
    name              output file name
    start, end        optional range, seconds from the first frame (the output then starts at 0)
    maxFps            optional frame-rate cap (frames are dropped evenly, never invented)
    plan(src)         async; src = { width, height, fps, codec, bitrate } of the source (fps after the cap).
                      Returns { codec, width, height, bitrate } for the output.
    renderer(plan, src) returns { kind, draw(frame) -> canvas of plan.width × plan.height, dispose() };
                      frame = { t (seconds from the first frame), width, height, image(w, h) }
    onStart(info), onProgress(fraction), signal (AbortSignal)
  Every source frame in range becomes exactly one output frame. Resolves to a File.
*/
export async function transcode(file, job) {
  if (typeof VideoEncoder === 'undefined') throw new Error('Video export needs a browser with WebCodecs.');
  var input = new Input({ source: new BlobSource(file), formats: FORMATS }), firstError = null, strict = false;
  var isAbort = function () { return job.signal && job.signal.aborted; };
  try {
    var track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('This file has no video track.');
    var times = await frameTimes(track);
    var want = pickFrames(times, job.start, job.end, job.maxFps);
    if (!want.length) throw new Error('No frames in this range.');
    var dec = await webCodecsDecodable(track);
    if (dec.ok) {
      for (var attempt = 0; attempt < 2; attempt++) {
        try { return await encodeRun(input, track, times, want, job, strict, null); } catch (e) {
          if (isAbort()) throw aborted();
          if (e.code === 'dropped' && !strict) { strict = true; continue; } // encoder skipped frames: again, one frame at a time
          firstError = e; // e.g. the decoder skipped frames or failed late: the built-in player is exact
          break;
        }
      }
    }
    var viaElement = async function () {
      var el = await loadElement(file);
      try { return await encodeRun(input, track, times, want, job, strict, el); } finally { el.dispose(); }
    };
    try { return await viaElement(); } catch (e) {
      if (isAbort()) throw aborted();
      if (e.code === 'dropped' && !strict) { strict = true; return await viaElement(); }
      if (firstError && firstError.code !== 'skipped') throw firstError;
      if (/built-in player/.test(e.message)) throw undecodable(await track.getCodec(), dec.why);
      throw e;
    }
  } finally {
    try { input.dispose(); } catch (e) {}
  }
}

async function encodeRun(input, track, times, want, job, strict, el) {
  var r = null, out = null, N = want.length, t0 = times[0];
  try {
    var W = el ? el.el.videoWidth : await track.getDisplayWidth(), H = el ? el.el.videoHeight : await track.getDisplayHeight();
    var stats = await track.computePacketStats(300), fps = frameRateOf(want);
    var src = { width: W, height: H, fps: fps, codec: await track.getCodec(), bitrate: stats.averageBitrate };
    var plan = await job.plan(src);
    r = job.renderer(plan, src);
    var pacer = makePacer(strict);
    // Trimmed: the output starts at 0 and the audio moves with it. Untrimmed: timestamps are kept as they are.
    var from = job.start != null ? t0 + job.start : 0, to = job.end != null ? t0 + job.end : Infinity;
    out = await openOutput(input, job.name, plan, fps, pacer, from, to);
    if (job.onStart) job.onStart({ width: plan.width, height: plan.height, srcWidth: W, srcHeight: H, fps: fps, codec: plan.codec, bitrate: plan.bitrate, gpu: r.kind === 'gpu', via: el ? 'element' : 'webcodecs', frames: N });

    var frames = el ? elementFrames(el, times, want, job.signal) : decodeFrames(track, times, want, job.signal), n = 0;
    for await (var f of frames) {
      var canvas = r.draw({ t: f.t - t0, width: f.width, height: f.height, image: f.image });
      await pacer.wait();
      var next = f.index + 1 < N ? want[f.index + 1] : f.t + 1 / fps;
      var s = new VideoSample(canvas, { timestamp: f.t - from, duration: next - f.t });
      try { await out.vsrc.add(s); } finally { s.close(); }
      if (job.onProgress) job.onProgress(Math.min(0.99, ++n / N));
    }
    var file = await out.finish();
    out = null;
    if (pacer.dropped() > 0) throw codedError('The encoder skipped ' + pacer.dropped() + ' frames.', 'dropped');
    if (job.onProgress) job.onProgress(1);
    return file;
  } finally {
    if (out) await out.cancel();
    if (r) r.dispose();
  }
}
