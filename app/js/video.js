/*
  Video: frame preview and full export (up to 4K60 and beyond, whatever the device can decode and
  encode). Decoding/encoding is WebCodecs via Mediabunny; the colour correction runs on the GPU.
*/
import {
  Input, Output, Conversion, BlobSource, StreamTarget, Mp4OutputFormat, MP4, QTFF, Quality,
  VideoSampleSink, getFirstEncodableVideoCodec
} from '../vendor/mediabunny.js';
import { computeParams, blendParams, toneCurve, applyCorrection, clamp } from './color.js';
import { createGLRenderer } from './gl.js';
import { createSink } from './store.js';

var FORMATS = [MP4, QTFF]; // GoPro, phones and most cameras: .mp4 / .mov

export function canExportVideo() {
  return typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined' && typeof VideoFrame !== 'undefined';
}

var CODEC_NAMES = { avc: 'H.264', hevc: 'HEVC', vp9: 'VP9', av1: 'AV1', vp8: 'VP8' };
export function codecName(c) { return CODEC_NAMES[c] || (c ? String(c).toUpperCase() : 'unknown'); }

function undecodable(codec) {
  return new Error('This browser can’t decode ' + codecName(codec) + ' video' +
    (codec === 'hevc' ? '. Try Safari, or Chrome/Edge on a device with HEVC hardware support. On the GoPro, H.264 is the most compatible setting.' : '.'));
}

/* Open a clip for previewing frames. */
export async function openVideo(file) {
  var input = new Input({ source: new BlobSource(file), formats: FORMATS });
  try {
    var track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('This file has no video track.');
    var r = await Promise.all([
      track.getDisplayWidth(), track.getDisplayHeight(), track.getCodec(), track.canDecode(),
      track.getFirstTimestamp(), input.computeDuration(), track.computePacketStats(240), track.hasHighDynamicRange()
    ]);
    if (!r[3]) throw undecodable(r[2]);
    var sink = new VideoSampleSink(track);
    var info = { width: r[0], height: r[1], codec: r[2], start: Math.max(0, r[4]), end: r[5], fps: r[6].averagePacketRate, bitrate: r[6].averageBitrate, hdr: r[7] };
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
  } catch (e) {
    try { input.dispose(); } catch (_) {}
    throw e;
  }
}

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

var QUALITY = { std: 0.55, high: 1, max: 1.4 };

/*
  Export a corrected copy of the clip. Options:
    settings      slider values
    locked        params to use for the whole clip, or null for adaptive (re-analysed as the scene changes)
    quality       'std' | 'high' | 'max' (bitrate relative to the source)
    name          output file name
    onStart(info) called once the output format is known
    onProgress(fraction)
    signal        AbortSignal
  Resolves to a File.
*/
export async function exportVideo(file, o) {
  var input = new Input({ source: new BlobSource(file), formats: FORMATS });
  var renderer = null, sink = null, conversion = null, onAbort = null;
  try {
    var track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('This file has no video track.');
    var srcCodec = await track.getCodec();
    if (!(await track.canDecode())) throw undecodable(srcCodec);
    var W = await track.getDisplayWidth(), H = await track.getDisplayHeight();
    var stats = await track.computePacketStats(300), fps = stats.averagePacketRate || 30;
    var base = Math.max(stats.averageBitrate || 0, W * H * fps * 0.08);
    var bitrate = Math.round(clamp(base * (QUALITY[o.quality] || 1), 2e6, 200e6));
    var order = srcCodec === 'hevc' ? ['hevc', 'avc', 'vp9', 'av1'] : ['avc', 'hevc', 'vp9', 'av1'];

    // Full size if the device can encode it, otherwise the largest size it can (e.g. some phones top out at 1080p).
    var outW = W, outH = H, codec = null;
    for (var scale = 1; scale >= 0.25 && !codec; scale /= 2) {
      outW = Math.round(W * scale / 2) * 2; outH = Math.round(H * scale / 2) * 2;
      codec = await getFirstEncodableVideoCodec(order, { width: outW, height: outH, quality: new Quality({ bitrate: Math.round(bitrate * scale * scale) }) });
      if (codec) bitrate = Math.round(bitrate * scale * scale);
    }
    if (!codec) throw new Error('This browser can’t encode video.');

    try { renderer = createGLRenderer(); } catch (e) { renderer = null; }
    if (!renderer) renderer = createCPURenderer();

    sink = await createSink(o.name, 'video/mp4');
    var output = new Output({
      format: new Mp4OutputFormat({ fastStart: false }),
      target: new StreamTarget(sink.stream, { chunked: true, chunkSize: 16 * 1024 * 1024 })
    });

    var cur = null, target = null, lastA = -Infinity, lastT = null;
    var process = function (sample) {
      var frame = sample.toVideoFrame();
      try { renderer.upload(frame, frame.displayWidth, frame.displayHeight); } finally { frame.close(); }
      if (renderer.lost()) throw new Error('The graphics processor was reset. Please try again.');
      var p = o.locked;
      if (!p) {
        var t = sample.timestamp;
        // re-analyse ~10x a second; ease towards the new look over ~0.8 s so depth changes don't flicker
        if (!target || t - lastA >= 0.1 || t < lastA) { target = computeParams(renderer.analyse(), o.settings, null); lastA = t; }
        cur = cur ? blendParams(cur, target, 1 - Math.exp(-Math.max(0, t - lastT) / 0.8)) : target;
        lastT = t;
        p = cur;
      }
      return renderer.render(p);
    };

    var video = { codec: codec, quality: new Quality({ bitrate: bitrate }), keyFrameInterval: 1, forceTranscode: true, process: process };
    if (outW !== W) { video.width = outW; video.height = outH; video.fit = 'fill'; }
    conversion = await Conversion.init({ input: input, output: output, tracks: 'primary', video: video, showWarnings: false });
    if (!conversion.isValid || conversion.discardedTracks.some(function (d) { return d.track.type === 'video'; })) {
      var why = conversion.discardedTracks.map(function (d) { return d.reason; }).join(', ');
      throw new Error('This video can’t be converted here' + (why ? ' (' + why + ')' : '') + '.');
    }
    if (o.onStart) o.onStart({ width: outW, height: outH, srcWidth: W, srcHeight: H, fps: fps, codec: codec, bitrate: bitrate, gpu: renderer.kind === 'gpu' });
    conversion.onProgress = function (f) { if (o.onProgress) o.onProgress(f); };
    if (o.signal) {
      if (o.signal.aborted) throw new DOMException('Canceled', 'AbortError');
      onAbort = function () { conversion.cancel(); };
      o.signal.addEventListener('abort', onAbort);
    }
    await conversion.execute();
    var out = await sink.finish();
    sink = null;
    return out;
  } catch (e) {
    if (o.signal && o.signal.aborted) throw new DOMException('Canceled', 'AbortError');
    throw e;
  } finally {
    if (onAbort) o.signal.removeEventListener('abort', onAbort);
    if (sink) sink.abort();
    if (renderer) renderer.dispose();
    try { input.dispose(); } catch (e) {}
  }
}
