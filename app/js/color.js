/* Colour science. Pure functions, shared by the UI thread, the photo workers and the video renderer. */

export var DEFAULTS = { strength: 100, warmth: 0, tint: 0, bright: 0, contrast: 20, sat: 15 };

var HIST_SCALE = 1023.5;
var TONE_N = 1024;

export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

function percentile(h, n, q) {
  var t = q * n, c = 0;
  for (var k = 0; k < h.length; k++) { c += h[k]; if (c >= t) return k / HIST_SCALE; }
  return (h.length - 1) / HIST_SCALE;
}

/*
  Per-pixel correction. src/dst are RGBA arrays in 0..255 (Uint8ClampedArray or Float32Array).
  1. Red (and a little blue) recovery: borrow detail from the green channel, which survives
     underwater, into the weak channel:  r' = r + k * (1 - r) * g
  2. White balance gains + per-channel levels, folded into one multiply-add (A, B)
  3. Tone curve (auto exposure gamma + contrast) through a lookup table
  4. Saturation, then blend with the original by "strength"
  The WebGL shader in gl.js is a line-by-line port of this function; keep them in sync.
*/
export function applyCorrection(src, dst, p) {
  var kr = p.kr, kb = p.kb, A0 = p.A[0], A1 = p.A[1], A2 = p.A[2], B0 = p.B[0], B1 = p.B[1], B2 = p.B[2];
  var sat = p.sat, st = p.st, T = p.tone, N = T.length - 1, len = src.length;
  for (var i = 0; i < len; i += 4) {
    var r = src[i] / 255, g = src[i + 1] / 255, b = src[i + 2] / 255;
    var x = (r + kr * (1 - r) * g) * A0 + B0; x = x < 0 ? 0 : (x > 1 ? 1 : x);
    var R = T[(x * N + 0.5) | 0];
    x = g * A1 + B1; x = x < 0 ? 0 : (x > 1 ? 1 : x);
    var G = T[(x * N + 0.5) | 0];
    x = (b + kb * (1 - b) * g) * A2 + B2; x = x < 0 ? 0 : (x > 1 ? 1 : x);
    var Bl = T[(x * N + 0.5) | 0];
    var Y = 0.2126 * R + 0.7152 * G + 0.0722 * Bl;
    R = Y + sat * (R - Y); G = Y + sat * (G - Y); Bl = Y + sat * (Bl - Y);
    R = r + st * (R - r); G = g + st * (G - g); Bl = b + st * (Bl - b);
    dst[i] = (R < 0 ? 0 : R > 1 ? 1 : R) * 255;
    dst[i + 1] = (G < 0 ? 0 : G > 1 ? 1 : G) * 255;
    dst[i + 2] = (Bl < 0 ? 0 : Bl > 1 ? 1 : Bl) * 255;
    dst[i + 3] = src[i + 3];
  }
}

export function toneCurve(gamma, ct) {
  var tone = new Float32Array(TONE_N + 1);
  for (var k = 0; k <= TONE_N; k++) {
    var x = Math.pow(k / TONE_N, gamma), sm = x * x * (3 - 2 * x), y = x + ct * (sm - x);
    tone[k] = y < 0 ? 0 : y > 1 ? 1 : y;
  }
  return tone;
}

/* Work out correction parameters from a small analysis image (RGBA bytes). */
export function computeParams(px, s, pick) {
  var n = (px.length / 4) | 0, i, j, k;
  var sr = 0, sg = 0, sb = 0;
  for (j = 0; j < px.length; j += 4) { sr += px[j]; sg += px[j + 1]; sb += px[j + 2]; }
  var mr = sr / n / 255, mg = sg / n / 255, mb = sb / n / 255;

  // 1. channel recovery strength, based on how far red (and blue) trail green
  var a = 0.3;
  var kr = Math.max(0, mg - mr) * a, kb = Math.max(0, mg - mb) * a * 0.5;

  var R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n);
  var er = 0, eg = 0, eb = 0;
  for (i = 0, j = 0; i < n; i++, j += 4) {
    var r = px[j] / 255, g = px[j + 1] / 255, b = px[j + 2] / 255;
    r += kr * (1 - r) * g; b += kb * (1 - b) * g;
    R[i] = r; G[i] = g; B[i] = b;
    er += r * r; eg += g * g; eb += b * b;
  }

  // 2. white balance: a picked neutral spot, or "shades of grey" (RMS) estimate
  var gr, gg, gb;
  if (pick) {
    var pr = pick[0] + kr * (1 - pick[0]) * pick[1], pg = pick[1], pb = pick[2] + kb * (1 - pick[2]) * pick[1];
    var py = (pr + pg + pb) / 3;
    gr = py / Math.max(pr, 0.004); gg = py / Math.max(pg, 0.004); gb = py / Math.max(pb, 0.004);
  } else {
    er = Math.sqrt(er / n); eg = Math.sqrt(eg / n); eb = Math.sqrt(eb / n);
    var e = (er + eg + eb) / 3;
    gr = e / Math.max(er, 0.004); gg = e / Math.max(eg, 0.004); gb = e / Math.max(eb, 0.004);
  }
  gr = clamp(gr, 0.25, 5); gg = clamp(gg, 0.25, 5); gb = clamp(gb, 0.25, 5);

  // 3. levels: per-channel black and white points (removes the water haze)
  var BINS = 2048;
  var hr = new Uint32Array(BINS), hg = new Uint32Array(BINS), hb = new Uint32Array(BINS);
  for (i = 0; i < n; i++) {
    hr[Math.min(BINS - 1, (R[i] * gr * HIST_SCALE) | 0)]++;
    hg[Math.min(BINS - 1, (G[i] * gg * HIST_SCALE) | 0)]++;
    hb[Math.min(BINS - 1, (B[i] * gb * HIST_SCALE) | 0)]++;
  }
  // black points are pulled halfway back so scenes without true shadows don't lose their reds
  var lo = [percentile(hr, n, 0.004) * 0.5, percentile(hg, n, 0.004) * 0.5, percentile(hb, n, 0.004) * 0.5];
  var hi = [percentile(hr, n, 0.996), percentile(hg, n, 0.996), percentile(hb, n, 0.996)];
  if (pick) { // keep the picked balance: same levels on every channel
    var l = Math.min(lo[0], lo[1], lo[2]), h = Math.max(hi[0], hi[1], hi[2]);
    lo = [l, l, l]; hi = [h, h, h];
  }
  // user warmth / tint are applied after the levels so the auto-levels can't undo them
  var w = s.warmth / 100, tn = s.tint / 100;
  var gains = [gr, gg, gb], user = [1 + 0.2 * w, 1 - 0.16 * tn, 1 - 0.2 * w], A = [0, 0, 0], Bo = [0, 0, 0];
  for (k = 0; k < 3; k++) {
    var span = hi[k] - lo[k];
    if (span < 0.2) { lo[k] = Math.max(0, (hi[k] + lo[k]) / 2 - 0.1); span = 0.2; }
    A[k] = gains[k] / span * user[k]; Bo[k] = -lo[k] / span * user[k];
  }

  // 4. exposure: nudge mean brightness towards a natural level, then user brightness
  var m = 0;
  for (i = 0; i < n; i++) {
    m += 0.2126 * clamp(R[i] * A[0] + Bo[0], 0, 1) + 0.7152 * clamp(G[i] * A[1] + Bo[1], 0, 1) + 0.0722 * clamp(B[i] * A[2] + Bo[2], 0, 1);
  }
  m /= n;
  var gamma = Math.log(0.42) / Math.log(clamp(m, 0.04, 0.92));
  gamma = clamp(Math.pow(gamma, 0.7), 0.6, 1.35) * Math.pow(2, -s.bright / 100);
  var ct = s.contrast / 100;

  return { kr: kr, kb: kb, A: A, B: Bo, gamma: gamma, ct: ct, sat: 1 + s.sat / 100, st: s.strength / 100, tone: toneCurve(gamma, ct) };
}

/* Move params `cur` towards `target` by fraction f (video: smooth changes in depth and light). */
export function blendParams(cur, target, f) {
  var mix = function (a, b) { return a + (b - a) * f; };
  return {
    kr: mix(cur.kr, target.kr), kb: mix(cur.kb, target.kb),
    A: [mix(cur.A[0], target.A[0]), mix(cur.A[1], target.A[1]), mix(cur.A[2], target.A[2])],
    B: [mix(cur.B[0], target.B[0]), mix(cur.B[1], target.B[1]), mix(cur.B[2], target.B[2])],
    gamma: mix(cur.gamma, target.gamma), ct: target.ct, sat: target.sat, st: target.st, tone: null
  };
}

/* 3D LUT (.cube) of the exact same transform, for video editors. */
export function makeCube(p, size, title) {
  var n = size * size * size, src = new Float32Array(n * 4), dst = new Float32Array(n * 4), i = 0, r, g, b;
  for (b = 0; b < size; b++) for (g = 0; g < size; g++) for (r = 0; r < size; r++) {
    src[i] = r / (size - 1) * 255; src[i + 1] = g / (size - 1) * 255; src[i + 2] = b / (size - 1) * 255; src[i + 3] = 255; i += 4;
  }
  applyCorrection(src, dst, p);
  var out = ['TITLE "' + String(title).replace(/[^\x20-\x7e]|"/g, '') + '"', '# UW Color', 'LUT_3D_SIZE ' + size, 'DOMAIN_MIN 0.0 0.0 0.0', 'DOMAIN_MAX 1.0 1.0 1.0'];
  for (i = 0; i < n * 4; i += 4) out.push((dst[i] / 255).toFixed(6) + ' ' + (dst[i + 1] / 255).toFixed(6) + ' ' + (dst[i + 2] / 255).toFixed(6));
  return out.join('\n') + '\n';
}
