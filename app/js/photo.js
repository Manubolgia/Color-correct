/*
  Full-resolution photo export. The source is read in horizontal strips (so no canvas ever has to
  hold the whole photo), each strip is colour-corrected and JPEG-encoded by a pool of workers, and
  the encoded strips are concatenated into one file.
*/
import { applyCorrection } from './color.js';
import { jpegHeader, encodeStrip, JPEG_EOI } from './jpeg.js';

var pool = null;

function startPool() {
  var n = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
  var P = { workers: [], idle: [], queue: [], seq: 0, inline: false };
  var pings = [];
  try {
    for (var i = 0; i < n; i++) {
      var w = new Worker(new URL('./photo-worker.js', import.meta.url), { type: 'module' });
      P.workers.push(w);
      pings.push(ping(w));
    }
  } catch (e) { P.inline = true; }
  P.ready = (P.inline ? Promise.reject(new Error('no workers')) : Promise.all(pings)).then(function () {
    P.workers.forEach(function (w) { wire(P, w); P.idle.push(w); });
  }, function () {
    P.workers.forEach(function (w) { w.terminate(); });
    P.workers = []; P.inline = true;
  });
  return P;
}

function ping(w) {
  return new Promise(function (res, rej) {
    var t = setTimeout(function () { rej(new Error('timeout')); }, 8000);
    w.onmessage = function (e) { if (e.data && e.data.pong) { clearTimeout(t); res(); } };
    w.onerror = function (e) { if (e.preventDefault) e.preventDefault(); clearTimeout(t); rej(new Error('worker')); };
    w.postMessage({ ping: true, id: 0 });
  });
}

function wire(P, w) {
  w.onmessage = function (e) {
    var job = w.job; w.job = null; P.idle.push(w);
    if (job) { if (e.data.error) job.rej(new Error(e.data.error)); else job.res(e.data.out); }
    pump(P);
  };
  w.onerror = function (e) {
    if (e.preventDefault) e.preventDefault();
    var job = w.job; w.job = null; P.idle.push(w);
    if (job) job.rej(new Error('Processing failed. Please try again.'));
    pump(P);
  };
}

function pump(P) {
  while (P.idle.length && P.queue.length) {
    var w = P.idle.pop(), job = P.queue.shift(), t = job.task;
    w.job = job;
    w.postMessage({ id: ++P.seq, buf: t.buf, w: t.w, rows: t.rows, row0: t.row0, totalRows: t.totalRows, quality: t.quality, p: t.p }, [t.buf]);
  }
}

function runStrip(task) {
  if (pool.inline) {
    return new Promise(function (r) { setTimeout(r, 0); }).then(function () {
      var px = new Uint8ClampedArray(task.buf);
      applyCorrection(px, px, task.p);
      return encodeStrip(px, task.w, task.rows, task.row0, task.totalRows, task.quality);
    });
  }
  return new Promise(function (res, rej) { pool.queue.push({ task: task, res: res, rej: rej }); pump(pool); });
}

export function warmPhotoWorkers() { if (!pool) pool = startPool(); return pool.ready; }

export function sourceSize(src) {
  return [src.displayWidth || src.videoWidth || src.naturalWidth || src.width, src.displayHeight || src.videoHeight || src.naturalHeight || src.height];
}

/* Returns a JPEG Blob. `opts`: { quality, exif (APP1 bytes or null), onProgress(f), signal } */
export async function renderJPEG(src, p, opts) {
  opts = opts || {};
  await warmPhotoWorkers();
  var d = sourceSize(src), W = d[0], H = d[1], quality = opts.quality || 95;
  if (!W || !H) throw new Error('No image data');
  if (W > 65500 || H > 65500) throw new Error('This image is too large for JPEG.');
  var totalRows = Math.ceil(H / 8);
  var S = Math.max(8, Math.min(256, Math.floor(4194304 / W / 8) * 8));
  var nStrips = Math.ceil(H / S);
  var c = document.createElement('canvas'); c.width = W; c.height = S;
  var x = c.getContext('2d', { willReadFrequently: true });
  if (!x) throw new Error('Not enough memory for this image.');
  x.imageSmoothingEnabled = false;
  var parts = new Array(nStrips), inflight = [], done = 0;
  var maxInflight = pool.inline ? 1 : pool.workers.length * 2;
  try {
    for (var s = 0; s < nStrips; s++) {
      if (opts.signal && opts.signal.aborted) throw new DOMException('Canceled', 'AbortError');
      var y0 = s * S, rows = Math.min(S, H - y0);
      x.clearRect(0, 0, W, S);
      x.drawImage(src, 0, y0, W, rows, 0, 0, W, rows);
      var data = x.getImageData(0, 0, W, rows).data;
      inflight.push(runStrip({ buf: data.buffer, w: W, rows: rows, row0: y0 / 8, totalRows: totalRows, quality: quality, p: p })
        .then(function (k) {
          return function (out) { parts[k] = out; done++; if (opts.onProgress) opts.onProgress(done / nStrips); };
        }(s)));
      if (inflight.length >= maxInflight) await inflight.shift();
    }
    await Promise.all(inflight);
  } finally {
    inflight.forEach(function (pr) { pr.catch(function () {}); });
    c.width = c.height = 0;
  }
  return new Blob([jpegHeader(W, H, quality, opts.exif || null)].concat(parts, [JPEG_EOI]), { type: 'image/jpeg' });
}
