/*
  UW Color's video side: frame preview and full export with the colour correction applied on the GPU.
  The decoding, frame-exact encoding and audio copy live in media.js (shared with UW Reels).
*/
import { transcode, Quality, getFirstEncodableVideoCodec } from './media.js';
import { computeParams, blendParams, toneCurve, applyCorrection, clamp } from './color.js';
import { createGLRenderer } from './gl.js';

export { openVideo, canExportVideo, codecName } from './media.js';

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

function newRenderer() {
  var r = null;
  try { r = createGLRenderer(); } catch (e) { r = null; }
  return r || createCPURenderer();
}

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
export function exportVideo(file, o) {
  return transcode(file, {
    name: o.name, signal: o.signal, onStart: o.onStart, onProgress: o.onProgress,
    plan: function (src) { return encodePlan(src.codec, src.width, src.height, src.fps, src.bitrate, o.quality); },
    renderer: function (plan) {
      var r = newRenderer(), correct = corrector(r, o);
      return {
        kind: r.kind,
        draw: function (f) { r.upload(f.image(plan.width, plan.height), plan.width, plan.height); return correct(f.t); },
        dispose: function () { r.dispose(); }
      };
    }
  });
}
