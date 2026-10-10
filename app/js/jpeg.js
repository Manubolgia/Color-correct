/*
  Baseline JPEG encoder (4:4:4, no chroma subsampling) that works on horizontal strips.

  Every MCU row ends with a restart marker, so strips are independent: they can be encoded in
  parallel by several workers and simply concatenated. This is what lets us write photos at full
  resolution on devices whose canvas size limits (iOS: ~16.7 MP) are smaller than the photo.
*/

var ZIGZAG = new Uint8Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21,
  28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61,
  54, 47, 55, 62, 63
]);

// ITU T.81 Annex K quantisation tables (natural order)
var STD_LUM = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99
];
var STD_CHR = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99
];

// Annex K.3 Huffman tables: code counts per length (1..16), then symbols
var DC_LUM_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
var DC_LUM_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
var DC_CHR_BITS = [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
var DC_CHR_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
var AC_LUM_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
var AC_LUM_VALS = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08,
  0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
  0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
  0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa
];
var AC_CHR_BITS = [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];
var AC_CHR_VALS = [
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91,
  0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
  0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58,
  0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
  0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4,
  0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
  0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa
];

var AAN = [1.0, 1.387039845, 1.306562965, 1.175875602, 1.0, 0.785694958, 0.5411961, 0.275899379];

function quantTable(std, quality) {
  var q = Math.max(1, Math.min(100, quality | 0));
  var scale = q < 50 ? 5000 / q : 200 - 2 * q, t = new Uint8Array(64);
  for (var i = 0; i < 64; i++) t[i] = Math.max(1, Math.min(255, Math.floor((std[i] * scale + 50) / 100)));
  return t;
}

// Codes indexed by symbol: [code, length]
function huffCodes(bits, vals) {
  var codes = [], code = 0, k = 0;
  for (var len = 1; len <= 16; len++) {
    for (var i = 0; i < bits[len - 1]; i++) codes[vals[k++]] = [code++, len];
    code <<= 1;
  }
  return codes;
}

var tablesCache = {};
function tables(quality) {
  if (tablesCache[quality]) return tablesCache[quality];
  var ql = quantTable(STD_LUM, quality), qc = quantTable(STD_CHR, quality);
  // Divisors with the AAN DCT scale factors folded in, in natural order
  var fl = new Float32Array(64), fc = new Float32Array(64);
  for (var row = 0; row < 8; row++) for (var col = 0; col < 8; col++) {
    var i = row * 8 + col, s = AAN[row] * AAN[col] * 8;
    fl[i] = 1 / (ql[i] * s); fc[i] = 1 / (qc[i] * s);
  }
  var t = {
    ql: ql, qc: qc, fl: fl, fc: fc,
    dcl: huffCodes(DC_LUM_BITS, DC_LUM_VALS), acl: huffCodes(AC_LUM_BITS, AC_LUM_VALS),
    dcc: huffCodes(DC_CHR_BITS, DC_CHR_VALS), acc: huffCodes(AC_CHR_BITS, AC_CHR_VALS)
  };
  tablesCache[quality] = t;
  return t;
}

/* Everything up to and including the start-of-scan header. `app1` is an optional, complete Exif APP1 segment. */
export function jpegHeader(width, height, quality, app1) {
  var t = tables(quality), b = [], i;
  var w16 = function (v) { b.push((v >> 8) & 255, v & 255); };
  b.push(0xff, 0xd8);
  if (app1) { for (i = 0; i < app1.length; i++) b.push(app1[i]); }
  else b.push(0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0);
  b.push(0xff, 0xdb); w16(132);
  b.push(0); for (i = 0; i < 64; i++) b.push(t.ql[ZIGZAG[i]]);
  b.push(1); for (i = 0; i < 64; i++) b.push(t.qc[ZIGZAG[i]]);
  b.push(0xff, 0xc0); w16(17); b.push(8); w16(height); w16(width);
  b.push(3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1);
  var dht = [[0x00, DC_LUM_BITS, DC_LUM_VALS], [0x10, AC_LUM_BITS, AC_LUM_VALS], [0x01, DC_CHR_BITS, DC_CHR_VALS], [0x11, AC_CHR_BITS, AC_CHR_VALS]];
  var dl = 2; dht.forEach(function (d) { dl += 17 + d[2].length; });
  b.push(0xff, 0xc4); w16(dl);
  dht.forEach(function (d) { b.push(d[0]); b.push.apply(b, d[1]); b.push.apply(b, d[2]); });
  b.push(0xff, 0xdd); w16(4); w16(Math.ceil(width / 8)); // restart after every MCU row
  b.push(0xff, 0xda); w16(12); b.push(3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0);
  return new Uint8Array(b);
}

export var JPEG_EOI = new Uint8Array([0xff, 0xd9]);

function fdct(d) {
  var i, o, t0, t1, t2, t3, t4, t5, t6, t7, t10, t11, t12, t13, z1, z2, z3, z4, z5, z11, z13;
  for (i = 0; i < 8; i++) {
    o = i * 8;
    t0 = d[o] + d[o + 7]; t7 = d[o] - d[o + 7]; t1 = d[o + 1] + d[o + 6]; t6 = d[o + 1] - d[o + 6];
    t2 = d[o + 2] + d[o + 5]; t5 = d[o + 2] - d[o + 5]; t3 = d[o + 3] + d[o + 4]; t4 = d[o + 3] - d[o + 4];
    t10 = t0 + t3; t13 = t0 - t3; t11 = t1 + t2; t12 = t1 - t2;
    d[o] = t10 + t11; d[o + 4] = t10 - t11;
    z1 = (t12 + t13) * 0.707106781; d[o + 2] = t13 + z1; d[o + 6] = t13 - z1;
    t10 = t4 + t5; t11 = t5 + t6; t12 = t6 + t7;
    z5 = (t10 - t12) * 0.382683433; z2 = 0.5411961 * t10 + z5; z4 = 1.306562965 * t12 + z5; z3 = t11 * 0.707106781;
    z11 = t7 + z3; z13 = t7 - z3;
    d[o + 5] = z13 + z2; d[o + 3] = z13 - z2; d[o + 1] = z11 + z4; d[o + 7] = z11 - z4;
  }
  for (i = 0; i < 8; i++) {
    t0 = d[i] + d[i + 56]; t7 = d[i] - d[i + 56]; t1 = d[i + 8] + d[i + 48]; t6 = d[i + 8] - d[i + 48];
    t2 = d[i + 16] + d[i + 40]; t5 = d[i + 16] - d[i + 40]; t3 = d[i + 24] + d[i + 32]; t4 = d[i + 24] - d[i + 32];
    t10 = t0 + t3; t13 = t0 - t3; t11 = t1 + t2; t12 = t1 - t2;
    d[i] = t10 + t11; d[i + 32] = t10 - t11;
    z1 = (t12 + t13) * 0.707106781; d[i + 16] = t13 + z1; d[i + 48] = t13 - z1;
    t10 = t4 + t5; t11 = t5 + t6; t12 = t6 + t7;
    z5 = (t10 - t12) * 0.382683433; z2 = 0.5411961 * t10 + z5; z4 = 1.306562965 * t12 + z5; z3 = t11 * 0.707106781;
    z11 = t7 + z3; z13 = t7 - z3;
    d[i + 40] = z13 + z2; d[i + 24] = z13 - z2; d[i + 8] = z11 + z4; d[i + 56] = z11 - z4;
  }
}

/*
  Entropy-code one strip. `px` is RGBA, `w` wide and `rows` tall (rows is a multiple of 8 except for
  the last strip of the image, which is padded by repeating its bottom row). `row0` is the index of
  the strip's first MCU row in the whole image and `totalRows` the image's MCU row count, so the
  right restart marker numbers can be written.
*/
export function encodeStrip(px, w, rows, row0, totalRows, quality) {
  var t = tables(quality), fl = t.fl, fc = t.fc;
  var mcuW = Math.ceil(w / 8), mcuRows = Math.ceil(rows / 8);
  var cap = Math.max(65536, (w * rows * 1.6) | 0), out = new Uint8Array(cap), pos = 0;
  var bitBuf = 0, bitCnt = 0;

  function grow() { var n = new Uint8Array(out.length * 2); n.set(out); out = n; }
  function emit(b) {
    if (pos + 2 > out.length) grow();
    out[pos++] = b;
    if (b === 0xff) out[pos++] = 0;
  }
  function put(code, len) {
    bitBuf = (bitBuf << len) | code; bitCnt += len;
    while (bitCnt >= 8) { bitCnt -= 8; emit((bitBuf >>> bitCnt) & 255); }
    bitBuf &= (1 << bitCnt) - 1;
  }
  function flushBits() { if (bitCnt > 0) put((1 << (8 - bitCnt)) - 1, 8 - bitCnt); }
  function bitsOf(v) { var a = v < 0 ? -v : v, n = 0; while (a) { n++; a >>= 1; } return n; }

  var Yb = new Float32Array(64), Ub = new Float32Array(64), Vb = new Float32Array(64), q = new Int32Array(64);
  function block(d, f, prevDC, dc, ac) {
    fdct(d);
    for (var i = 0; i < 64; i++) {
      var v = d[ZIGZAG[i]] * f[ZIGZAG[i]];
      q[i] = v < 0 ? -((0.5 - v) | 0) : ((v + 0.5) | 0);
    }
    var diff = q[0] - prevDC, n = bitsOf(diff), c = dc[n];
    put(c[0], c[1]);
    if (n) put(diff < 0 ? diff + (1 << n) - 1 : diff, n);
    var end = 63; while (end > 0 && q[end] === 0) end--;
    var run = 0;
    for (var k = 1; k <= end; k++) {
      var a = q[k];
      if (a === 0) { run++; continue; }
      while (run > 15) { c = ac[0xf0]; put(c[0], c[1]); run -= 16; }
      n = bitsOf(a); c = ac[(run << 4) | n];
      put(c[0], c[1]);
      put(a < 0 ? a + (1 << n) - 1 : a, n);
      run = 0;
    }
    if (end < 63) { c = ac[0]; put(c[0], c[1]); }
    return q[0];
  }

  for (var my = 0; my < mcuRows; my++) {
    var pY = 0, pU = 0, pV = 0;
    for (var mx = 0; mx < mcuW; mx++) {
      for (var yy = 0; yy < 8; yy++) {
        var sy = my * 8 + yy; if (sy >= rows) sy = rows - 1;
        var base = sy * w;
        for (var xx = 0; xx < 8; xx++) {
          var sx = mx * 8 + xx; if (sx >= w) sx = w - 1;
          var j = (base + sx) * 4, r = px[j], g = px[j + 1], b = px[j + 2], k = yy * 8 + xx;
          Yb[k] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
          Ub[k] = -0.168736 * r - 0.331264 * g + 0.5 * b;
          Vb[k] = 0.5 * r - 0.418688 * g - 0.081312 * b;
        }
      }
      pY = block(Yb, fl, pY, t.dcl, t.acl);
      pU = block(Ub, fc, pU, t.dcc, t.acc);
      pV = block(Vb, fc, pV, t.dcc, t.acc);
    }
    flushBits();
    var row = row0 + my;
    if (row < totalRows - 1) {
      if (pos + 2 > out.length) grow();
      out[pos++] = 0xff; out[pos++] = 0xd0 + (row & 7);
    }
  }
  return out.slice(0, pos);
}
