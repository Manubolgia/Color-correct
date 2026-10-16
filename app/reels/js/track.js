/*
  Follows what you tap through the clip: normalised cross-correlation of a small patch against each
  next frame (small grey copies, ~10 a second), searched coarse then fine around where it's expected.
  The patch slowly adapts to the subject turning, but only while the match is confident, and keeps a
  little of the original so it doesn't drift onto the background. When the match is lost, the whole
  frame is searched for the original patch; after ~3 s without it the run stops there.
*/

function integral(img, w, h) { // sums of I and I² over rectangles in O(1)
  var W = w + 1, s = new Float64Array(W * (h + 1)), s2 = new Float64Array(W * (h + 1));
  for (var y = 0; y < h; y++) {
    var r = 0, r2 = 0;
    for (var x = 0; x < w; x++) {
      var v = img[y * w + x]; r += v; r2 += v * v;
      s[(y + 1) * W + x + 1] = s[y * W + x + 1] + r;
      s2[(y + 1) * W + x + 1] = s2[y * W + x + 1] + r2;
    }
  }
  return { s: s, s2: s2, W: W };
}

function patch(img, w, cx, cy, n) { // zero-mean, unit-length n×n patch centred on (cx, cy)
  var half = n >> 1, out = new Float32Array(n * n), m = 0, i, x, y;
  for (y = 0; y < n; y++) for (x = 0; x < n; x++) { var v = img[(cy - half + y) * w + cx - half + x]; out[y * n + x] = v; m += v; }
  m /= n * n;
  var e = 0;
  for (i = 0; i < out.length; i++) { out[i] -= m; e += out[i] * out[i]; }
  e = Math.sqrt(e) || 1;
  for (i = 0; i < out.length; i++) out[i] /= e;
  return out;
}

function ncc(img, w, ii, T, n, cx, cy) {
  var half = n >> 1, x0 = cx - half, y0 = cy - half, W = ii.W, cnt = n * n;
  var a = y0 * W + x0, b = y0 * W + x0 + n, c = (y0 + n) * W + x0, d = (y0 + n) * W + x0 + n;
  var sum = ii.s[d] - ii.s[b] - ii.s[c] + ii.s[a], sum2 = ii.s2[d] - ii.s2[b] - ii.s2[c] + ii.s2[a];
  var vr = sum2 - sum * sum / cnt;
  if (vr < cnt * 4) return -1; // flat (open water): nothing to lock on to
  var cross = 0, k = 0;
  for (var y = 0; y < n; y++) {
    var row = (y0 + y) * w + x0;
    for (var x = 0; x < n; x++) cross += T[k++] * img[row + x];
  }
  return cross / Math.sqrt(vr);
}

function search(img, w, h, ii, T, n, px, py, r) {
  var half = n >> 1, best = -2, bx = px, by = py;
  var x0 = Math.max(half, Math.round(px - r)), x1 = Math.min(w - half - 1, Math.round(px + r));
  var y0 = Math.max(half, Math.round(py - r)), y1 = Math.min(h - half - 1, Math.round(py + r));
  var x, y, s;
  for (y = y0; y <= y1; y += 2) for (x = x0; x <= x1; x += 2) {
    s = ncc(img, w, ii, T, n, x, y);
    if (s > best) { best = s; bx = x; by = y; }
  }
  var cx = bx, cy = by;
  for (y = Math.max(y0, cy - 1); y <= Math.min(y1, cy + 1); y++) for (x = Math.max(x0, cx - 1); x <= Math.min(x1, cx + 1); x++) {
    s = ncc(img, w, ii, T, n, x, y);
    if (s > best) { best = s; bx = x; by = y; }
  }
  return { x: bx, y: by, score: best };
}

function mix(T, P, T0, a, b) {
  var out = new Float32Array(T.length), e = 0, i;
  for (i = 0; i < T.length; i++) { out[i] = (1 - a - b) * T[i] + a * P[i] + b * T0[i]; e += out[i] * out[i]; }
  e = Math.sqrt(e) || 1;
  for (i = 0; i < T.length; i++) out[i] /= e;
  return out;
}

/*
  frames: grey images (Uint8Array w×h), in time order. Start at frame i0 on pixel (px, py).
  Returns { x, y } arrays (pixels, NaN where it wasn't found) and the first/last frame it covers.
*/
export function trackSubject(frames, w, h, i0, px, py, opts) {
  opts = opts || {};
  var n = Math.max(11, Math.min(41, Math.round(Math.min(w, h) * (opts.size || 0.16)) | 1)), half = n >> 1;
  var R = Math.max(10, Math.round(Math.min(w, h) * 0.13)), maxLost = opts.maxLost || 30;
  var N = frames.length, xs = new Float32Array(N).fill(NaN), ys = new Float32Array(N).fill(NaN);
  var cache = new Map();
  var ii = function (i) { var v = cache.get(i); if (!v) { v = integral(frames[i], w, h); cache.set(i, v); if (cache.size > 4) cache.delete(cache.keys().next().value); } return v; };
  px = Math.max(half, Math.min(w - half - 1, Math.round(px)));
  py = Math.max(half, Math.min(h - half - 1, Math.round(py)));
  var T0 = patch(frames[i0], w, px, py, n);
  xs[i0] = px; ys[i0] = py;
  var first = i0, last = i0;
  [1, -1].forEach(function (dir) {
    var T = T0, x = px, y = py, vx = 0, vy = 0, lost = 0;
    for (var i = i0 + dir; i >= 0 && i < N; i += dir) {
      var ex = x + vx, ey = y + vy;
      var m = search(frames[i], w, h, ii(i), T, n, ex, ey, lost ? R * 1.6 : R);
      // Lost for a moment (swam behind something, out of frame): look for the original patch anywhere.
      if (m.score < 0.5 && lost >= 3 && lost % 2 === 1) {
        var g = search(frames[i], w, h, ii(i), T0, n, w / 2, h / 2, Math.max(w, h));
        if (g.score >= 0.65) m = g;
      }
      if (m.score >= 0.5) {
        vx = 0.5 * vx + 0.5 * (m.x - x); vy = 0.5 * vy + 0.5 * (m.y - y);
        x = m.x; y = m.y; lost = 0;
        xs[i] = x; ys[i] = y;
        if (dir > 0) last = i; else first = i;
        if (m.score > 0.7) T = mix(T, patch(frames[i], w, x, y, n), T0, 0.12, 0.06);
      } else {
        if (++lost > maxLost) break;
        x = Math.max(half, Math.min(w - half - 1, ex)); y = Math.max(half, Math.min(h - half - 1, ey));
        vx *= 0.7; vy *= 0.7;
      }
    }
  });
  // Bridge short losses with straight lines.
  var prev = -1;
  for (var i = first; i <= last; i++) {
    if (isNaN(xs[i])) continue;
    if (prev >= 0 && i - prev > 1) for (var j = prev + 1; j < i; j++) { var s = (j - prev) / (i - prev); xs[j] = xs[prev] + (xs[i] - xs[prev]) * s; ys[j] = ys[prev] + (ys[i] - ys[prev]) * s; }
    prev = i;
  }
  return { x: xs, y: ys, first: first, last: last };
}
