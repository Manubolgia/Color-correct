/* Writes export files into the origin-private file system, so big videos never have to sit in memory. */
var handles = new Map();

async function dir() {
  var root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('exports', { create: true });
}

async function handle(m) {
  switch (m.op) {
    case 'open': {
      var d = await dir(), fh = await d.getFileHandle(m.name, { create: true });
      var h = await fh.createSyncAccessHandle();
      await h.truncate(0); // (older Safari returns promises from these calls; awaiting is harmless elsewhere)
      handles.set(m.name, h);
      return;
    }
    case 'write': {
      var h1 = handles.get(m.name);
      await h1.write(m.data, { at: m.pos });
      return;
    }
    case 'blob': {
      var h2 = handles.get(m.name), pos = 0, step = 8388608;
      while (pos < m.blob.size) {
        var chunk = new Uint8Array(await m.blob.slice(pos, pos + step).arrayBuffer());
        await h2.write(chunk, { at: pos });
        pos += chunk.length;
      }
      return;
    }
    case 'close': {
      var h3 = handles.get(m.name);
      if (h3) { await h3.flush(); await h3.close(); handles.delete(m.name); }
      return;
    }
    case 'remove': {
      var h4 = handles.get(m.name);
      if (h4) { try { await h4.close(); } catch (e) {} handles.delete(m.name); }
      try { await (await dir()).removeEntry(m.name); } catch (e) {}
      return;
    }
    case 'clear': {
      var root = await navigator.storage.getDirectory();
      try { await root.removeEntry('exports', { recursive: true }); } catch (e) {}
      return;
    }
    case 'probe': {
      var d2 = await dir(), f2 = await d2.getFileHandle('.probe', { create: true });
      var h5 = await f2.createSyncAccessHandle();
      await h5.close();
      await d2.removeEntry('.probe');
      return;
    }
  }
}

// Messages are handled strictly in order: a write must never overtake the open before it.
var chain = Promise.resolve();
self.onmessage = function (e) {
  var m = e.data;
  chain = chain.then(function () { return handle(m); }).then(function () { self.postMessage({ id: m.id, ok: true }); },
    function (err) { self.postMessage({ id: m.id, ok: false, error: String(err && err.message || err) }); });
};
