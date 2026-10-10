import { applyCorrection } from './color.js';
import { encodeStrip } from './jpeg.js';

self.onmessage = function (e) {
  var d = e.data;
  if (d.ping) { self.postMessage({ id: d.id, pong: true }); return; }
  try {
    var px = new Uint8ClampedArray(d.buf);
    applyCorrection(px, px, d.p);
    var out = encodeStrip(px, d.w, d.rows, d.row0, d.totalRows, d.quality);
    self.postMessage({ id: d.id, out: out }, [out.buffer]);
  } catch (err) {
    self.postMessage({ id: d.id, error: String(err && err.message || err) });
  }
};
