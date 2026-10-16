/*
  Where finished exports live until the user saves them, and the ways of saving them.
  Files go to the origin-private file system when available (disk-backed, so a batch of 27 MP photos
  or a 4K video doesn't have to fit in memory); otherwise they're kept in memory.
*/

var worker = null, seq = 0, waiting = new Map(), opfsOK = null, counter = 0;
var area = 'exports'; // folder in the private file system; each app keeps its own, so one never clears the other's

export function useArea(name) { area = name; }

function call(msg, transfer) {
  return new Promise(function (res, rej) {
    msg.id = ++seq;
    msg.dir = area;
    waiting.set(msg.id, { res: res, rej: rej });
    worker.postMessage(msg, transfer || []);
  });
}

export function opfsReady() {
  if (opfsOK) return opfsOK;
  opfsOK = new Promise(function (res) {
    if (!navigator.storage || !navigator.storage.getDirectory || typeof Worker === 'undefined') { res(false); return; }
    try {
      worker = new Worker(new URL('./opfs-worker.js', import.meta.url));
      worker.onmessage = function (e) {
        var w = waiting.get(e.data.id); if (!w) return;
        waiting.delete(e.data.id);
        if (e.data.ok) w.res(); else w.rej(new Error(e.data.error));
      };
      worker.onerror = function (e) { if (e.preventDefault) e.preventDefault(); res(false); };
      var t = setTimeout(function () { res(false); }, 5000);
      call({ op: 'probe' }).then(function () { clearTimeout(t); res(true); }, function () { clearTimeout(t); res(false); });
    } catch (e) { res(false); }
  });
  return opfsOK;
}

/* Forget exports from earlier sessions. */
export function clearExports() {
  return opfsReady().then(function (ok) { if (ok) return call({ op: 'clear' }); }).catch(function () {});
}

async function opfsFile(internal, name, type) {
  var root = await navigator.storage.getDirectory();
  var dir = await root.getDirectoryHandle(area);
  var f = await (await dir.getFileHandle(internal)).getFile();
  return new File([f], name, { type: type, lastModified: Date.now() });
}

function internalName(name) { return (++counter) + '-' + Date.now().toString(36) + '-' + name.replace(/[^\w.-]+/g, '_'); }

/* Keep a finished Blob (a photo, a LUT) as a File, moving it out of memory when possible. */
export async function keepBlob(blob, name, type) {
  if (await opfsReady()) {
    var internal = internalName(name);
    try {
      await call({ op: 'open', name: internal });
      await call({ op: 'blob', name: internal, blob: blob });
      await call({ op: 'close', name: internal });
      return await opfsFile(internal, name, type);
    } catch (e) {
      call({ op: 'remove', name: internal }).catch(function () {});
    }
  }
  return new File([blob], name, { type: type, lastModified: Date.now() });
}

/*
  A positioned-write sink for the MP4 muxer: { stream, finish() -> File, abort() }.
  `stream` accepts { type: 'write', data, position } chunks.
*/
export async function createSink(name, type) {
  if (await opfsReady()) {
    var internal = internalName(name);
    await call({ op: 'open', name: internal });
    return {
      stream: new WritableStream({
        write: function (c) { var d = c.data.slice(); return call({ op: 'write', name: internal, pos: c.position, data: d }, [d.buffer]); }
      }),
      finish: async function () { await call({ op: 'close', name: internal }); return opfsFile(internal, name, type); },
      abort: function () { return call({ op: 'remove', name: internal }).catch(function () {}); }
    };
  }
  // In memory: non-overlapping segments sorted by position; later writes patch earlier bytes.
  var segs = [];
  function write(pos, data) {
    var end = pos + data.length, covered = [];
    segs.forEach(function (s) {
      var a = Math.max(pos, s.pos), b = Math.min(end, s.pos + s.data.length);
      if (a < b) { s.data.set(data.subarray(a - pos, b - pos), a - s.pos); covered.push([a, b]); }
    });
    covered.sort(function (x, y) { return x[0] - y[0]; });
    var cur = pos;
    covered.concat([[end, end]]).forEach(function (c) {
      if (c[0] > cur) segs.push({ pos: cur, data: data.slice(cur - pos, c[0] - pos) });
      cur = Math.max(cur, c[1]);
    });
    segs.sort(function (x, y) { return x.pos - y.pos; });
  }
  return {
    stream: new WritableStream({ write: function (c) { write(c.position, c.data); } }),
    finish: async function () {
      var parts = [], at = 0;
      segs.forEach(function (s) { if (s.pos > at) parts.push(new Uint8Array(s.pos - at)); parts.push(s.data); at = s.pos + s.data.length; });
      segs = [];
      return new File(parts, name, { type: type, lastModified: Date.now() });
    },
    abort: function () { segs = []; return Promise.resolve(); }
  };
}

/* ---------- Saving ---------- */

export function canShareFiles(files) {
  try { return !!(navigator.canShare && navigator.canShare({ files: files })); } catch (e) { return false; }
}

export function shareFiles(files) {
  return navigator.share({ files: files }).then(function () { return true; }, function (e) {
    if (e && e.name === 'AbortError') return false;
    throw e;
  });
}

export function downloadFiles(files) {
  var i = 0;
  return new Promise(function (res) {
    (function next() {
      if (i >= files.length) { res(true); return; }
      var f = files[i++], a = document.createElement('a');
      a.href = URL.createObjectURL(f); a.download = f.name; a.rel = 'noopener';
      document.body.appendChild(a); a.click();
      setTimeout(function (u, el) { URL.revokeObjectURL(u); el.remove(); }, 60000, a.href, a);
      setTimeout(next, files.length > 1 ? 500 : 0);
    })();
  });
}

export var canPickFolder = typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
var folder = null;

export function folderName() { return folder ? folder.name : null; }
export function forgetFolder() { folder = null; }

export async function pickFolder() {
  folder = await window.showDirectoryPicker({ id: 'uw-color', mode: 'readwrite', startIn: 'pictures' });
  return folder.name;
}

/* Call straight from a click: the browser may need to ask again, which requires a user gesture. */
export async function ensureFolderPermission() {
  if (!folder) throw new Error('No folder');
  if (!folder.queryPermission) return;
  if ((await folder.queryPermission({ mode: 'readwrite' })) === 'granted') return;
  if ((await folder.requestPermission({ mode: 'readwrite' })) !== 'granted') throw new Error('Permission denied');
}

async function freeName(dir, name) {
  var stem = name.replace(/\.[^.]+$/, ''), ext = name.slice(stem.length), n = 1, cand = name;
  for (;;) {
    try { await dir.getFileHandle(cand); } catch (e) { return cand; }
    cand = stem + ' (' + (n++) + ')' + ext;
  }
}

/* Write files into the folder picked earlier this session. */
export async function saveToFolder(files) {
  await ensureFolderPermission();
  for (var i = 0; i < files.length; i++) {
    var fh = await folder.getFileHandle(await freeName(folder, files[i].name), { create: true });
    var w = await fh.createWritable();
    await files[i].stream().pipeTo(w);
  }
  return true;
}
