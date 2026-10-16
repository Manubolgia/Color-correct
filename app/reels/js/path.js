/*
  The moving 9:16 crop. A keyframe is { t, x, y, z }: time in seconds, the crop's centre as a fraction
  of the source width and height, and zoom (1 = as large as the frame allows). Between keyframes the
  crop moves SMOOTH (monotone cubic: no overshoot, eases in and out where the motion turns), LINEAR,
  or JUMP (holds, then cuts). Before the first and after the last keyframe it holds still.
*/

export var ASPECT = 9 / 16;
export var MAX_ZOOM = 4;
export var DEFAULT = { x: 0.5, y: 0.5, z: 1 };

export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

/* Crop size in source pixels at zoom z. */
export function cropSize(W, H, z) {
  var w, h;
  if (W / H > ASPECT) { h = H; w = H * ASPECT; } else { w = W; h = W / ASPECT; }
  z = clamp(z || 1, 1, MAX_ZOOM);
  return { w: w / z, h: h / z };
}

/* Keep the crop inside the frame: returns the position with its centre clamped. */
export function fit(W, H, p) {
  var z = clamp(p.z || 1, 1, MAX_ZOOM), s = cropSize(W, H, z);
  var hx = s.w / (2 * W), hy = s.h / (2 * H);
  return { x: clamp(p.x, hx, 1 - hx), y: clamp(p.y, hy, 1 - hy), z: z };
}

/* The crop rectangle in source pixels. */
export function cropRect(W, H, p) {
  var q = fit(W, H, p), s = cropSize(W, H, q.z);
  return { x: q.x * W - s.w / 2, y: q.y * H - s.h / 2, w: s.w, h: s.h };
}

function tangent(keys, i, c) { // PCHIP slope at key i for component c, flat at the ends and where the motion turns
  if (i <= 0 || i >= keys.length - 1) return 0;
  var h0 = keys[i].t - keys[i - 1].t, h1 = keys[i + 1].t - keys[i].t;
  if (h0 <= 0 || h1 <= 0) return 0;
  var d0 = (keys[i][c] - keys[i - 1][c]) / h0, d1 = (keys[i + 1][c] - keys[i][c]) / h1;
  if (d0 * d1 <= 0) return 0;
  var w1 = 2 * h1 + h0, w2 = h1 + 2 * h0;
  return (w1 + w2) / (w1 / d0 + w2 / d1);
}

/* Index of the last key at or before t (-1 if none). */
function before(keys, t) {
  var lo = 0, hi = keys.length;
  while (lo < hi) { var m = (lo + hi) >> 1; if (keys[m].t <= t) lo = m + 1; else hi = m; }
  return lo - 1;
}

/* Position of the crop at time t. */
export function evaluate(keys, t, mode) {
  if (!keys.length) return { x: DEFAULT.x, y: DEFAULT.y, z: DEFAULT.z };
  var i = before(keys, t);
  if (i < 0) i = 0;
  var a = keys[i];
  if (i >= keys.length - 1 || t <= a.t || mode === 'jump') return { x: a.x, y: a.y, z: a.z };
  var b = keys[i + 1], h = b.t - a.t, s = (t - a.t) / h;
  if (mode === 'linear') return { x: a.x + (b.x - a.x) * s, y: a.y + (b.y - a.y) * s, z: a.z + (b.z - a.z) * s };
  var s2 = s * s, s3 = s2 * s;
  var h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
  var out = {};
  ['x', 'y', 'z'].forEach(function (c) {
    out[c] = h00 * a[c] + h10 * h * tangent(keys, i, c) + h01 * b[c] + h11 * h * tangent(keys, i + 1, c);
  });
  return out;
}

/* Index of a key within eps seconds of t, or -1. */
export function keyNear(keys, t, eps) {
  var best = -1, bd = eps;
  for (var i = 0; i < keys.length; i++) { var d = Math.abs(keys[i].t - t); if (d <= bd) { bd = d; best = i; } }
  return best;
}

/* Add or replace the key at t (within eps). Returns a new sorted array. */
export function setKey(keys, k, eps) {
  var out = keys.slice(), i = keyNear(out, k.t, eps);
  if (i >= 0) out[i] = { t: out[i].t, x: k.x, y: k.y, z: k.z };
  else { out.push({ t: k.t, x: k.x, y: k.y, z: k.z }); out.sort(function (p, q) { return p.t - q.t; }); }
  return out;
}

/* Swap the keys between t0 and t1 for new ones. */
export function replaceRange(keys, t0, t1, fresh) {
  return keys.filter(function (k) { return k.t < t0 - 1e-6 || k.t > t1 + 1e-6; }).concat(fresh)
    .sort(function (p, q) { return p.t - q.t; });
}

/* Gaussian smoothing over time (sigma in seconds) of samples [{ t, x, y, z }]; ends stay put. */
export function smooth(samples, sigma) {
  if (!(sigma > 0) || samples.length < 3) return samples.slice();
  var out = [], n = samples.length, lo = 0;
  for (var i = 0; i < n; i++) {
    var t = samples[i].t, sw = 0, sx = 0, sy = 0, sz = 0;
    while (samples[lo].t < t - 3 * sigma) lo++;
    for (var j = lo; j < n && samples[j].t <= t + 3 * sigma; j++) {
      var d = (samples[j].t - t) / sigma, w = Math.exp(-0.5 * d * d);
      sw += w; sx += w * samples[j].x; sy += w * samples[j].y; sz += w * samples[j].z;
    }
    out.push({ t: t, x: sx / sw, y: sy / sw, z: sz / sw });
  }
  return out;
}

/*
  Fewest keys that keep the path within tol (fraction of the frame) of the samples
  (Ramer–Douglas–Peucker on each component against straight lines between kept samples).
*/
export function simplify(samples, tol) {
  var n = samples.length;
  if (n <= 2) return samples.slice();
  var keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1;
  var stack = [[0, n - 1]];
  while (stack.length) {
    var seg = stack.pop(), a = samples[seg[0]], b = samples[seg[1]], worst = -1, wi = -1;
    for (var i = seg[0] + 1; i < seg[1]; i++) {
      var p = samples[i], s = (p.t - a.t) / (b.t - a.t || 1);
      var e = Math.max(Math.abs(p.x - (a.x + (b.x - a.x) * s)), Math.abs(p.y - (a.y + (b.y - a.y) * s)), Math.abs(p.z - (a.z + (b.z - a.z) * s)) / 4);
      if (e > worst) { worst = e; wi = i; }
    }
    if (worst > tol) { keep[wi] = 1; stack.push([seg[0], wi], [wi, seg[1]]); }
  }
  return samples.filter(function (_, j) { return keep[j]; });
}

/* A recorded or tracked run of samples, turned into editable keys. */
export function toKeys(samples, sigma, tol) {
  return simplify(smooth(samples, sigma), tol).map(function (s) {
    return { t: Math.round(s.t * 1000) / 1000, x: s.x, y: s.y, z: s.z };
  });
}
