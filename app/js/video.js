/*
  Video: frame preview and full export (up to 4K60 and beyond, whatever the device can decode and
  encode). The colour correction runs on the GPU.

  Decoding, best first:
  1. WebCodecs through Mediabunny, as the file describes itself.
  2. WebCodecs with a cleaned-up decoder config. Safari rejects some perfectly playable files because
     of one field (an unusual colour-space value, an H.264 level it doesn't list), so a few safe
     variants are tried and the first one Safari accepts is used (PatchedDecoder below).
  3. The browser's own <video> player, which plays anything the Photos app can. Each frame is taken
     by seeking to it, which is exact.
  Encoding is always WebCodecs, paced so the encoder never skips frames (see makePacer), and the
  audio is copied over untouched. Every source frame becomes exactly one output frame.
*/
import {
  Input, Output, BlobSource, StreamTarget, Mp4OutputFormat, MP4, QTFF, Quality,
  VideoSampleSink, getFirstEncodableVideoCodec,
  CustomVideoDecoder, registerDecoder, VideoSample, EncodedPacketSink, EncodedAudioPacketSource, VideoSampleSource
} from '../vendor/mediabunny.js';
import { computeParams, blendParams, toneCurve, applyCorrection, clamp } from './color.js';
import { createGLRenderer } from './gl.js';
import { createSink } from './store.js';

var FORMATS = [MP4, QTFF]; // GoPro, phones and most cameras: .mp4 / .mov

export function canExportVideo() {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
}

var CODEC_NAMES = { avc: 'H.264', hevc: 'HEVC', vp9: 'VP9', av1: 'AV1', vp8: 'VP8' };
export function codecName(c) { return CODEC_NAMES[c] || (c ? String(c).toUpperCase() : 'unknown'); }

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

/* ---------- Renderers ---------- */

/* CPU stand-in for gl.js, for browsers without WebGL2. Same interface, much slower. */
function createCPURenderer() {
  var c = document.createElement('canvas'), x = c.getContext('2d', { willReadFrequently: true });
  var a = document.createElement('canvas'), ax = a.getContext('2d', { willReadFrequently: true });
  var img = null, w0 = 0, h0 = 0;
  return {
    kind: 'cpu',
    canvas: c,
    upload: function (src, w, h) {
      if (w !== w0 || h !== h0) { c.width = w0 = w; c.height = h0 = h; }
      x.drawImage(src, 0, 0, w, h);
      img = x.getImageData(0, 0, w, h);
    },
    analyse: function () {
      var s = Math.min(1, 256 / Math.max(w0, h0));
      a.width = Math.max(1, Math.round(w0 * s)); a.height = Math.max(1, Math.round(h0 * s));
      ax.drawImage(c, 0, 0, a.width, a.height);
      return ax.getImageData(0, 0, a.width, a.height).data;
    },
    render: function (p) {
      if (!p.tone) p = Object.assign({}, p, { tone: toneCurve(p.gamma, p.ct) });
      applyCorrection(img.data, img.data, p);
      x.putImageData(img, 0, 0);
      return c;
    },
    lost: function () { return false; },
    dispose: function () { c.width = c.height = a.width = a.height = 1; img = null; }
  };
}

/* Correct the uploaded frame shown at time t: fixed params, or re-analysed ~10x a second and eased over ~0.8 s. */
function corrector(renderer, o) {
  var cur = null, target = null, lastA = -Infinity, lastT = null;
  return function (t) {
    if (renderer.lost()) throw new Error('The graphics processor was reset. Please try again.');
    var p = o.locked;
    if (!p) {
      if (!target || t - lastA >= 0.1 || t < lastA) { target = computeParams(renderer.analyse(), o.settings, null); lastA = t; }
      cur = cur ? blendParams(cur, target, 1 - Math.exp(-Math.max(0, t - lastT) / 0.8)) : target;
      lastT = t;
      p = cur;
    }
    return renderer.render(p);
  };
}

/* ---------- Export ---------- */

var QUALITY = { std: 0.55, high: 1, max: 1.4 };

/* Pick codec, size and bitrate the device can encode: full size if possible, else the largest it can (e.g. 1080p). */
async function encodePlan(srcCodec, W, H, fps, srcBitrate, quality) {
  var base = Math.max(srcBitrate || 0, W * H * fps * 0.08);
  var bitrate = Math.round(clamp(base * (QUALITY[quality] || 1), 2e6, 200e6));
  var order = srcCodec === 'hevc' ? ['hevc', 'avc', 'vp9', 'av1'] : ['avc', 'hevc', 'vp9', 'av1'];
  for (var scale = 1; scale >= 0.25; scale /= 2) {
    var w = Math.round(W * scale / 2) * 2, h = Math.round(H * scale / 2) * 2, b = Math.round(bitrate * scale * scale);
    var codec = await getFirstEncodableVideoCodec(order, { width: w, height: h, quality: new Quality({ bitrate: b }) });
    if (codec) return { codec: codec, width: w, height: h, bitrate: b };
  }
  throw new Error('This browser can’t encode video.');
}

/* Presentation times of every frame in the file, read from the container (cheap: no decoding). */
async function frameTimes(track) {
  var times = [];
  for await (var p of new EncodedPacketSink(track).packets(undefined, undefined, { metadataOnly: true })) times.push(p.timestamp);
  times.sort(function (a, b) { return a - b; });
  if (!times.length) throw new Error('This video has no frames.');
  return times;
}
function frameRateOf(times) {
  if (times.length < 2) return 30;
  var d = [];
  for (var i = 1; i < times.length; i++) d.push(times[i] - times[i - 1]);
  d.sort(function (a, b) { return a - b; });
  var med = d[d.length >> 1];
  return med > 0 ? 1 / med : 30;
}
function countUpTo(times, t) { // number of frames starting at or before t
  var lo = 0, hi = times.length;
  while (lo < hi) { var mid = (lo + hi) >> 1; if (times[mid] <= t + 1e-6) lo = mid + 1; else hi = mid; }
  return lo;
}

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

/* Output file with the video track and the source's audio copied packet for packet. */
async function openOutput(input, o, plan, fps, pacer) {
  var sink = await createSink(o.name, 'video/mp4'), output = null;
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
        if (p.timestamp < 0) continue; // encoder priming before the start of the clip
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

function newRenderer() {
  var r = null;
  try { r = createGLRenderer(); } catch (e) { r = null; }
  return r || createCPURenderer();
}

function codedError(message, code) { var e = new Error(message); e.code = code; return e; }

/*
  Export a corrected copy of the clip. Options:
    settings      slider values
    locked        params to use for the whole clip, or null for adaptive (re-analysed as the scene changes)
    quality       'std' | 'high' | 'max' (bitrate relative to the source)
    name          output file name
    onStart(info) called once the output format is known
    onProgress(fraction)
    signal        AbortSignal
  Every source frame becomes exactly one output frame with its original timestamp. Resolves to a File.
*/
export async function exportVideo(file, o) {
  if (typeof VideoEncoder === 'undefined') throw new Error('Video export needs a browser with WebCodecs.');
  var input = new Input({ source: new BlobSource(file), formats: FORMATS }), firstError = null, strict = false;
  var isAbort = function () { return o.signal && o.signal.aborted; };
  try {
    var track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('This file has no video track.');
    var times = await frameTimes(track);
    var dec = await webCodecsDecodable(track);
    if (dec.ok) {
      for (var attempt = 0; attempt < 2; attempt++) {
        try { return await exportWithWebCodecs(input, track, times, o, strict); } catch (e) {
          if (isAbort()) throw aborted();
          if (e.code === 'dropped' && !strict) { strict = true; continue; } // encoder skipped frames: again, one frame at a time
          firstError = e; // e.g. the decoder skipped frames or failed late: the built-in player is exact
          break;
        }
      }
    }
    try { return await exportWithElement(file, input, track, times, o, strict); } catch (e) {
      if (isAbort()) throw aborted();
      if (e.code === 'dropped' && !strict) return await exportWithElement(file, input, track, times, o, true);
      if (firstError && firstError.code !== 'skipped') throw firstError;
      if (/built-in player/.test(e.message)) throw undecodable(await track.getCodec(), dec.why);
      throw e;
    }
  } finally {
    try { input.dispose(); } catch (e) {}
  }
}

async function exportWithWebCodecs(input, track, times, o, strict) {
  var renderer = null, out = null, N = times.length;
  try {
    var srcCodec = await track.getCodec();
    var W = await track.getDisplayWidth(), H = await track.getDisplayHeight();
    var turned = (await track.getRotation()) !== 0 || (await track.getFlip());
    var stats = await track.computePacketStats(300), fps = frameRateOf(times);
    var plan = await encodePlan(srcCodec, W, H, fps, stats.averageBitrate, o.quality);
    renderer = newRenderer();
    var correct = corrector(renderer, o), pacer = makePacer(strict);
    out = await openOutput(input, o, plan, fps, pacer);
    if (o.onStart) o.onStart({ width: plan.width, height: plan.height, srcWidth: W, srcHeight: H, fps: fps, codec: plan.codec, bitrate: plan.bitrate, gpu: renderer.kind === 'gpu', via: 'webcodecs' });

    // Rotated clips (phones held upright) are drawn upright first, so the output needs no rotation flag.
    var upright = null, uctx = null;
    if (turned) { upright = document.createElement('canvas'); upright.width = plan.width; upright.height = plan.height; uctx = upright.getContext('2d'); }

    var decoded = 0, last = -Infinity;
    for await (var sample of new VideoSampleSink(track).samples()) {
      try {
        if (o.signal && o.signal.aborted) throw aborted();
        var t = sample.timestamp;
        if (t < 0 || t <= last) continue; // not shown / repeated
        last = t;
        decoded++;
        // The decoder must hand over every frame the file has; if it skips some, the built-in player route is used.
        var expected = countUpTo(times, t);
        if (expected - decoded > Math.max(10, expected * 0.02)) throw codedError('The decoder skipped frames.', 'skipped');
        if (turned) {
          sample.drawWithFit(uctx, { fit: 'fill' });
          renderer.upload(upright, plan.width, plan.height);
        } else {
          var frame = sample.toVideoFrame();
          try { renderer.upload(frame, plan.width, plan.height); } finally { frame.close(); }
        }
        var canvas = correct(t);
        await pacer.wait();
        var outSample = new VideoSample(canvas, { timestamp: t, duration: sample.duration > 0 ? sample.duration : 1 / fps });
        try { await out.vsrc.add(outSample); } finally { outSample.close(); }
        if (o.onProgress) o.onProgress(Math.min(0.99, decoded / N));
      } finally {
        sample.close();
      }
    }
    if (N - decoded > Math.max(10, N * 0.02)) throw codedError('The decoder skipped frames.', 'skipped');
    var file = await out.finish();
    out = null;
    if (pacer.dropped() > 0) throw codedError('The encoder skipped ' + pacer.dropped() + ' frames.', 'dropped');
    if (o.onProgress) o.onProgress(1);
    return file;
  } finally {
    if (out) await out.cancel();
    if (renderer) renderer.dispose();
  }
}

/*
  Built-in player route. Frame times come from the file itself, the player supplies the pictures (one
  exact seek per frame: during playback the element may already show a newer picture than the one it
  reports, which would make the output judder), and every source frame gets exactly one output frame.
*/
async function exportWithElement(file, input, track, times, o, strict) {
  var el = await loadElement(file), renderer = null, out = null, N = times.length, t0 = times[0];
  try {
    var v = el.el, W = v.videoWidth, H = v.videoHeight;
    var srcCodec = await track.getCodec();
    var stats = await track.computePacketStats(300), fps = frameRateOf(times);
    var plan = await encodePlan(srcCodec, W, H, fps, stats.averageBitrate, o.quality);
    renderer = newRenderer();
    var correct = corrector(renderer, o), pacer = makePacer(strict);
    out = await openOutput(input, o, plan, fps, pacer);
    if (o.onStart) o.onStart({ width: plan.width, height: plan.height, srcWidth: W, srcHeight: H, fps: fps, codec: plan.codec, bitrate: plan.bitrate, gpu: renderer.kind === 'gpu', via: 'element' });

    v.pause();
    for (var i = 0; i < N; i++) {
      if (o.signal && o.signal.aborted) throw aborted();
      if (times[i] < 0) continue;
      await seekEl(v, times[i] - t0 + 0.001);
      renderer.upload(v, plan.width, plan.height);
      var canvas = correct(times[i] - t0);
      await pacer.wait();
      var s = new VideoSample(canvas, { timestamp: times[i], duration: i + 1 < N ? times[i + 1] - times[i] : 1 / fps });
      try { await out.vsrc.add(s); } finally { s.close(); }
      if (o.onProgress) o.onProgress(Math.min(0.99, (i + 1) / N));
    }
    var result = await out.finish();
    out = null;
    if (pacer.dropped() > 0) throw codedError('The encoder skipped ' + pacer.dropped() + ' frames.', 'dropped');
    if (o.onProgress) o.onProgress(1);
    return result;
  } finally {
    if (out) await out.cancel();
    if (renderer) renderer.dispose();
    el.dispose();
  }
}
