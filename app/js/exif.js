/*
  Carries the camera's Exif block (date, camera, lens, exposure, GPS…) over to the fixed JPEG.
  The pixels are written upright, so Orientation is reset to 1, and the embedded thumbnail is
  unlinked because it still shows the uncorrected colours.
*/
export async function readExif(file) {
  try {
    if (!/jpe?g$/i.test(file.type) && !/\.jpe?g$/i.test(file.name || '')) return null;
    var buf = new Uint8Array(await file.slice(0, 262144).arrayBuffer());
    if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
    var i = 2;
    while (i + 4 <= buf.length) {
      if (buf[i] !== 0xff) return null;
      var m = buf[i + 1];
      if (m === 0xff) { i++; continue; }
      if (m === 0xda || m === 0xd9) return null;
      var len = (buf[i + 2] << 8) | buf[i + 3];
      if (m === 0xe1 && i + 2 + len <= buf.length && len > 16 &&
          buf[i + 4] === 0x45 && buf[i + 5] === 0x78 && buf[i + 6] === 0x69 && buf[i + 7] === 0x66 && buf[i + 8] === 0 && buf[i + 9] === 0) {
        var seg = buf.slice(i, i + 2 + len);
        return patch(seg) ? seg : null;
      }
      i += 2 + len;
    }
  } catch (e) {}
  return null;
}

function patch(seg) {
  var T = 10, n = seg.length, le;
  if (seg[T] === 0x49 && seg[T + 1] === 0x49) le = true;
  else if (seg[T] === 0x4d && seg[T + 1] === 0x4d) le = false;
  else return false;
  var r16 = function (o) { return le ? seg[o] | (seg[o + 1] << 8) : (seg[o] << 8) | seg[o + 1]; };
  var r32 = function (o) { return le ? (seg[o] | (seg[o + 1] << 8) | (seg[o + 2] << 16)) + seg[o + 3] * 16777216 : seg[o] * 16777216 + ((seg[o + 1] << 16) | (seg[o + 2] << 8) | seg[o + 3]); };
  var w16 = function (o, v) { if (le) { seg[o] = v & 255; seg[o + 1] = v >> 8; } else { seg[o] = v >> 8; seg[o + 1] = v & 255; } };
  var ifd = T + r32(T + 4);
  if (ifd + 2 > n) return false;
  var count = r16(ifd);
  if (ifd + 2 + count * 12 + 4 > n) return false;
  for (var k = 0; k < count; k++) {
    var e = ifd + 2 + k * 12;
    if (r16(e) === 0x0112 && r16(e + 2) === 3) w16(e + 8, 1);
  }
  var next = ifd + 2 + count * 12;
  seg[next] = seg[next + 1] = seg[next + 2] = seg[next + 3] = 0;
  return true;
}
