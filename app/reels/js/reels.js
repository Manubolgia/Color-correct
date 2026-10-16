/*
  UW Reels: cut a clip to a 9:16 reel with a crop that moves to keep you in shot.
  The preview is the browser's own player (smooth playback, any codec the device plays); the export
  goes through the shared engine in ../../js/media.js, frame by frame.
*/
import * as media from '../../js/media.js';
import * as store from '../../js/store.js';
import { isIOS, looksReencoded } from '../../js/ios.js';
import { clamp, cropSize, cropRect, fit, evaluate, keyNear, setKey, replaceRange, toKeys, MAX_ZOOM } from './path.js';
import { trackSubject } from './track.js';

var VERSION = '1.1'; // shown in the top bar; bump with every release
var $ = function (id) { return document.getElementById(id); };
var coarse = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
var PREFS = 'uw-reels-v1', PROJECTS = 'uw-reels-projects-v1';
var TABS = ['motion', 'frame', 'trim', 'output'];
store.useArea('exports-reels');

var prefs = { mode: 'smooth', fps: 'src', quality: 'high', tab: 'motion' };
try {
  var saved = JSON.parse(localStorage.getItem(PREFS) || '{}');
  if (['smooth', 'linear', 'jump'].indexOf(saved.mode) >= 0) prefs.mode = saved.mode;
  if (saved.fps === '30') prefs.fps = '30';
  if (saved.quality === 'std') prefs.quality = 'std';
  if (TABS.indexOf(saved.tab) >= 0) prefs.tab = saved.tab;
} catch (e) {}
function savePrefs() { try { localStorage.setItem(PREFS, JSON.stringify(prefs)); } catch (e) {} }

var S = {
  file: null, info: null, W: 0, H: 0, dur: 0, fps: 30, t: 0, frames: null,
  keys: [], in: 0, out: 0, hist: [],
  live: null,          // position while a finger is on the picture
  drag: null, pinch: null, pointers: new Map(),
  rec: null,           // samples of a move being recorded during playback
  view: 'frame', following: false,
  scan: null,          // small grey frames for tracking
  track: null,         // the last followed subject, for the dot
  still: null, stillT: 0, stillBusy: false, stillWant: null, // when the player can't play the file
  job: null, offered: null, ready: false
};

/* ---------- Small helpers ---------- */
function fmtTime(t, frac) {
  t = Math.max(0, t || 0);
  var m = Math.floor(t / 60), s = t - m * 60;
  return m + ':' + (s < 10 ? '0' : '') + (frac ? s.toFixed(2) : Math.floor(s));
}
function fmtBytes(b) { return b >= 1073741824 ? (b / 1073741824).toFixed(2) + ' GB' : b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'; }
function errMsg(e) { return e && e.message ? e.message : 'Something went wrong.'; }
function frameDur() { return 1 / (S.fps || 30); }
/* Frame times from the file: steps, trim points and keyframes land exactly on frames. */
function frameIndex(t) {
  var f = S.frames; if (!f || !f.length) return -1;
  var lo = 0, hi = f.length - 1;
  while (hi - lo > 1) { var m = (lo + hi) >> 1; if (f[m] <= t) lo = m; else hi = m; }
  return Math.abs(f[hi] - t) < Math.abs(f[lo] - t) ? hi : lo;
}
function snap(t) { var i = frameIndex(t); return i < 0 ? Math.round(t / frameDur()) * frameDur() : S.frames[i]; }
function stepFrame(n) {
  var i = frameIndex(now());
  if (i < 0) return clamp(now() + n * frameDur(), 0, S.dur);
  return S.frames[clamp(i + n, 0, S.frames.length - 1)];
}
function vid() { return $('vid'); }
// The playhead: where the last seek went (seeks are asynchronous), or the frame on screen while playing.
function now() { return S.still ? S.stillT : playing() ? vid().currentTime || 0 : S.t; }
function playing() { return !S.still && !vid().paused && !vid().ended; }

/* ---------- Tabs ---------- */
function setTab(t) {
  prefs.tab = t; savePrefs();
  document.querySelectorAll('.tabs button').forEach(function (b) { var on = b.dataset.tab === t; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
  document.querySelectorAll('.pane').forEach(function (p) { p.classList.toggle('on', p.dataset.pane === t); });
}
document.querySelectorAll('.tabs button').forEach(function (b) { b.onclick = function () { setTab(b.dataset.tab); }; });
setTab(prefs.tab);

/* ---------- Projects: the moves for each clip are remembered ---------- */
function projectKey() { return S.file ? S.file.name + '|' + S.file.size : null; }
var saveTimer = 0;
function saveProject() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(function () {
    var k = projectKey(); if (!k) return;
    try {
      var all = JSON.parse(localStorage.getItem(PROJECTS) || '{}');
      all[k] = { keys: S.keys, in: S.in, out: S.out, at: Date.now() };
      var names = Object.keys(all).sort(function (a, b) { return all[b].at - all[a].at; });
      names.slice(20).forEach(function (n) { delete all[n]; });
      localStorage.setItem(PROJECTS, JSON.stringify(all));
    } catch (e) {}
  }, 300);
}
function loadProject() {
  try {
    var p = JSON.parse(localStorage.getItem(PROJECTS) || '{}')[projectKey()];
    if (!p) return false;
    S.keys = (p.keys || []).filter(function (k) { return isFinite(k.t) && isFinite(k.x) && isFinite(k.y) && isFinite(k.z); });
    if (isFinite(p.in) && isFinite(p.out) && p.out > p.in) { S.in = clamp(p.in, 0, S.dur); S.out = clamp(p.out, S.in, S.dur); }
    return true;
  } catch (e) { return false; }
}

/* ---------- Undo ---------- */
function snapshot() { return JSON.stringify({ keys: S.keys, in: S.in, out: S.out }); }
function pushHist() { S.hist.push(snapshot()); if (S.hist.length > 80) S.hist.shift(); $('undoBtn').disabled = false; }
function undo() {
  if (!S.hist.length) return;
  var p = JSON.parse(S.hist.pop());
  S.keys = p.keys; S.in = p.in; S.out = p.out;
  $('undoBtn').disabled = !S.hist.length;
  changed();
}
$('undoBtn').onclick = undo;
function changed() { saveProject(); renderTimeline(); updateUI(); place(now()); }

/* ---------- Opening a clip ---------- */
function openFile(f) {
  if (!f) return;
  if (!/^video\//.test(f.type) && !/\.(mp4|mov|m4v)$/i.test(f.name)) { toast('Choose a video (MP4 or MOV).'); return; }
  if (!f.size) { toast('The file came through empty. Clips kept only in iCloud or Google Photos have to download to the phone first, which needs a connection.'); return; }
  closeClip();
  S.file = f; S.keys = []; S.hist = []; S.scan = null; S.track = null; S.ready = false;
  $('undoBtn').disabled = true;
  $('empty').hidden = true; $('editor').hidden = false;
  $('fileName').textContent = f.name; $('fileInfo').textContent = fmtBytes(f.size);
  setLoading(true); stageMsg(null);
  var url = URL.createObjectURL(f), v = vid();
  S.url = url;
  var meta = media.probeVideo(f).catch(function () { return null; });
  var playable = new Promise(function (res) {
    var done = false, finish = function (ok) { if (!done) { done = true; res(ok); } };
    v.onerror = function () { finish(false); };
    v.onloadedmetadata = function () {
      if (!v.videoWidth) { finish(false); return; }
      // iOS paints a frame only once playback has started: start it muted for a moment.
      v.muted = true;
      var after = function () { v.pause(); v.muted = false; if (v.readyState < 2) v.currentTime = 0; finish(true); };
      var p = v.play(); if (p && p.then) p.then(after, after); else after();
    };
    setTimeout(function () { finish(v.readyState >= 1 && v.videoWidth > 0); }, 20000);
    v.src = url; v.load();
  });
  Promise.all([meta, playable]).then(function (r) {
    if (S.file !== f) return;
    var info = r[0], ok = r[1];
    S.info = info;
    S.fps = info && info.fps > 1 ? info.fps : 30;
    S.frames = info && info.frames && info.frames.length ? info.frames : null;
    if (ok) {
      S.W = v.videoWidth; S.H = v.videoHeight;
      S.dur = isFinite(v.duration) && v.duration > 0 ? v.duration : (info ? info.end : 0);
      return ready();
    }
    // The player can't show it (e.g. HEVC without hardware support): stills through WebCodecs, no playback.
    return media.openVideo(f).then(function (clip) {
      if (S.file !== f) { clip.dispose(); return; }
      S.still = clip; S.W = clip.info.width; S.H = clip.info.height; S.dur = clip.info.end - clip.info.start;
      v.removeAttribute('src'); v.load();
      $('still').hidden = false; v.hidden = true;
      return ready().then(function () { stageMsg('This browser can’t play this clip, so the preview shows still frames. Export works as usual.'); });
    });
  }).catch(function (e) {
    if (S.file !== f) return;
    setLoading(false);
    stageMsg('Can’t open this video here. ' + errMsg(e));
  });
}
function ready() {
  S.in = 0; S.out = S.dur;
  var restored = loadProject();
  S.ready = true;
  layout();
  var t = S.in;
  return seek(t).then(function () {
    setLoading(false);
    renderTimeline(); updateUI();
    var parts = [S.W + '×' + S.H];
    if (S.info) parts.push(Math.round(S.info.fps * 100) / 100 + ' FPS', media.codecName(S.info.codec));
    parts.push(fmtTime(S.dur), fmtBytes(S.file.size));
    if (looksReencoded(S.file)) parts.push('RE-ENCODED BY iOS');
    $('fileInfo').textContent = parts.join(' · ');
    if (restored && S.keys.length) toast('Picked up your ' + S.keys.length + ' keyframe' + (S.keys.length > 1 ? 's' : '') + ' for this clip.', { label: 'CLEAR', fn: clearKeys });
    else warnReencoded();
  });
}
function closeClip() {
  stopFollow();
  var v = vid();
  try { v.pause(); } catch (e) {}
  v.removeAttribute('src'); v.load(); v.hidden = false;
  if (S.url) { URL.revokeObjectURL(S.url); S.url = null; }
  if (S.still) { S.still.dispose(); S.still = null; }
  $('still').hidden = true;
}
$('file').addEventListener('change', function () { openFile(this.files[0]); this.value = ''; });
$('openBtn').onclick = function () { if (!S.job) $('file').click(); };

function warnReencoded() {
  if (!looksReencoded(S.file) || !$('sheet').hidden) return;
  var choppy = S.info && S.info.fps > 0 && S.info.fps < 23.5;
  $('sheetTitle').textContent = choppy ? 'iOS CUT THIS CLIP TO ' + Math.round(S.info.fps) + ' FPS' : 'iOS RE-ENCODED THIS CLIP';
  $('sheetSub').textContent = 'Videos picked from Photo Library are converted by iOS before any app gets them' + (choppy ? ', and this one lost frames. ' : '. ') +
    'For the original: in Photos, Share → Save to Files. Then open it here with Choose Files instead of Photo Library.';
  var btns = $('sheetBtns'); btns.innerHTML = '';
  var b = document.createElement('button'); b.type = 'button'; b.className = 'btn primary'; b.textContent = 'GOT IT';
  b.onclick = closeSheet; btns.appendChild(b);
  $('sheetClose').hidden = true;
  $('sheet').hidden = false;
}

/* ---------- Stage layout ---------- */
var box = { vw: 0, vh: 0 }; // size of the viewport on screen
function layout() {
  if (!S.W) return;
  var st = $('stage'), cs = getComputedStyle(st);
  var aw = st.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  var ah = st.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  var ar = S.view === 'reel' ? 9 / 16 : S.W / S.H;
  var w = aw, h = aw / ar;
  if (h > ah) { h = ah; w = ah * ar; }
  box.vw = Math.max(1, Math.floor(w)); box.vh = Math.max(1, Math.floor(h));
  var vp = $('vp');
  vp.style.width = box.vw + 'px'; vp.style.height = box.vh + 'px';
  vp.classList.toggle('reel', S.view === 'reel');
  if (S.still) {
    var c = $('still'), s = Math.min(1, 1280 / Math.max(S.W, S.H));
    c.width = Math.round(S.W * s); c.height = Math.round(S.H * s);
  }
  place(now());
}
if (window.ResizeObserver) new window.ResizeObserver(function () { layout(); }).observe($('stage'));
window.addEventListener('resize', layout);

/* The crop position at t: what's under the finger, else the keyframed path. */
function posAt(t) { return fit(S.W, S.H, S.live || evaluate(S.keys, t, prefs.mode)); }

function place(t) {
  if (!S.W || !box.vw) return;
  var p = posAt(t), r = cropRect(S.W, S.H, p), el = S.still ? $('still') : vid();
  var k, tx = 0, ty = 0;
  if (S.view === 'reel') { k = box.vw / r.w; tx = -r.x * k; ty = -r.y * k; } else k = box.vw / S.W;
  el.style.width = (S.W * k) + 'px'; el.style.height = (S.H * k) + 'px';
  el.style.transform = 'translate(' + tx + 'px,' + ty + 'px)';
  var win = $('win');
  if (S.view === 'frame') {
    win.style.transform = 'translate(' + (r.x * k) + 'px,' + (r.y * k) + 'px)';
    win.style.width = (r.w * k) + 'px'; win.style.height = (r.h * k) + 'px';
    var onKey = !S.live && keyNear(S.keys, t, frameDur() * 0.6) >= 0;
    win.classList.toggle('key', onKey);
    win.classList.toggle('rec', !!S.rec);
  }
  var dot = $('dot'), d = S.view === 'frame' && subjectAt(t);
  dot.hidden = !d;
  if (d) dot.style.transform = 'translate(' + (d.x * box.vw) + 'px,' + (d.y * box.vh) + 'px)';
}
function subjectAt(t) {
  var tr = S.track;
  if (!tr || t < tr.t[0] - 0.05 || t > tr.t[tr.t.length - 1] + 0.05) return null;
  var lo = 0, hi = tr.t.length - 1;
  while (hi - lo > 1) { var m = (lo + hi) >> 1; if (tr.t[m] <= t) lo = m; else hi = m; }
  var s = clamp((t - tr.t[lo]) / ((tr.t[hi] - tr.t[lo]) || 1), 0, 1);
  return { x: tr.x[lo] + (tr.x[hi] - tr.x[lo]) * s, y: tr.y[lo] + (tr.y[hi] - tr.y[lo]) * s };
}

/* ---------- Time ---------- */
var seekBusy = false, seekWant = null;
function seek(t) {
  t = clamp(t, 0, Math.max(0, S.dur - 0.001));
  S.t = t;
  place(t); tick(t);
  if (S.still) return showStill(t);
  var v = vid();
  if (seekBusy) { seekWant = t; return Promise.resolve(); }
  seekBusy = true;
  return new Promise(function (res) {
    var done = false, fin = function () {
      if (done) return; done = true; seekBusy = false;
      if (seekWant != null) { var w = seekWant; seekWant = null; seek(w).then(res); } else res();
    };
    v.addEventListener('seeked', fin, { once: true });
    setTimeout(fin, 3000);
    if (Math.abs(v.currentTime - t) < 1e-4 && v.readyState >= 2) fin(); else v.currentTime = t;
  });
}
function showStill(t) {
  S.stillT = t;
  if (S.stillBusy) { S.stillWant = t; return Promise.resolve(); }
  S.stillBusy = true;
  var c = $('still');
  return S.still.draw(t + S.still.info.start, c.getContext('2d')).catch(function () {}).then(function () {
    S.stillBusy = false;
    if (S.stillWant != null) { var w = S.stillWant; S.stillWant = null; return showStill(w); }
  });
}
function tick(t) {
  $('timeLabel').textContent = fmtTime(t, true) + ' / ' + fmtTime(S.dur);
  var ph = $('tlPh'); ph.style.left = pct(t);
  var k = keyNear(S.keys, t, frameDur() * 0.6);
  $('keyBtn').classList.toggle('on', k >= 0);
  $('keyBtn').textContent = k >= 0 ? '◆' : '◇';
  $('keyBtn').setAttribute('aria-label', k >= 0 ? 'Delete this keyframe' : 'Add a keyframe here');
  if (S.lastOnKey !== k) { S.lastOnKey = k; document.querySelectorAll('.tl-k').forEach(function (e, i) { e.classList.toggle('on', i === k); }); }
}

/* ---------- Playback ---------- */
var loopReq = 0;
function frameLoop() {
  var v = vid(), id = ++loopReq;
  var step = function (t) {
    if (id !== loopReq) return;
    if (S.rec && S.live) S.rec.push({ t: t, x: S.live.x, y: S.live.y, z: S.live.z });
    if (t >= S.out - frameDur() * 0.5 && playing()) {
      if (S.rec) { v.pause(); finishRecording(); }
      else { v.currentTime = S.in; }
    }
    place(t); tick(t);
  };
  if (v.requestVideoFrameCallback) {
    var cb = function (_, md) { if (id !== loopReq) return; step(md.mediaTime); if (playing()) v.requestVideoFrameCallback(cb); };
    v.requestVideoFrameCallback(cb);
  } else {
    var raf = function () { if (id !== loopReq) return; step(v.currentTime); if (playing()) requestAnimationFrame(raf); };
    requestAnimationFrame(raf);
  }
}
function play() {
  if (S.still || !S.ready) return;
  stopFollow();
  var v = vid();
  if (now() >= S.out - frameDur() || now() < S.in - 0.01) S.t = S.in;
  if (Math.abs(v.currentTime - S.t) > 1e-4) v.currentTime = S.t;
  var p = v.play(); if (p && p.catch) p.catch(function () {});
}
function pause() { if (playing()) { S.t = vid().currentTime; S.pausing = true; vid().pause(); } }
vid().addEventListener('play', function () { $('playBtn').textContent = '❚❚'; $('playBtn').setAttribute('aria-label', 'Pause'); frameLoop(); updateHint(); });
vid().addEventListener('pause', function () {
  if (!S.pausing) S.t = vid().currentTime; // stopped by itself (end of file, a phone call): stay where it stopped
  S.pausing = false;
  $('playBtn').textContent = '▶'; $('playBtn').setAttribute('aria-label', 'Play');
  loopReq++; if (S.rec) finishRecording();
  place(now()); tick(now()); updateHint();
});
$('playBtn').onclick = function () { if (playing()) pause(); else play(); };
$('backBtn').onclick = function () { pause(); seek(stepFrame(-1)); };
$('fwdBtn').onclick = function () { pause(); seek(stepFrame(1)); };
var RATES = [1, 0.5, 0.25];
$('rateBtn').onclick = function () {
  var i = (RATES.indexOf(vid().playbackRate) + 1) % RATES.length, r = RATES[i];
  vid().playbackRate = r;
  $('rateBtn').textContent = r === 1 ? '1×' : r === 0.5 ? '½×' : '¼×';
  toast(r === 1 ? 'Normal speed.' : 'Playing at ' + (r === 0.5 ? 'half' : 'quarter') + ' speed: easier to follow with your finger.');
};

/* ---------- Keyframes ---------- */
function keyEps() { return frameDur() * 0.6; }
function addKeyHere(p) {
  pushHist();
  S.keys = setKey(S.keys, Object.assign({ t: snap(now()) }, fit(S.W, S.H, p || evaluate(S.keys, now(), prefs.mode))), keyEps());
  changed();
}
$('keyBtn').onclick = function () {
  if (!S.ready) return;
  pause();
  var i = keyNear(S.keys, now(), keyEps());
  if (i >= 0) { pushHist(); S.keys = S.keys.filter(function (_, j) { return j !== i; }); changed(); }
  else addKeyHere();
};
function clearKeys() {
  if (!S.keys.length) return;
  pushHist(); S.keys = []; S.track = null; changed();
  toast('Keyframes cleared.', { label: 'UNDO', fn: undo });
}
$('clearBtn').onclick = clearKeys;
document.querySelectorAll('#modeSeg button').forEach(function (b) {
  b.onclick = function () { prefs.mode = b.dataset.mode; savePrefs(); updateUI(); place(now()); };
});
$('centerBtn').onclick = function () { if (!S.ready) return; pause(); var p = evaluate(S.keys, now(), prefs.mode); addKeyHere({ x: 0.5, y: 0.5, z: p.z }); };
$('unzoomBtn').onclick = function () { if (!S.ready) return; pause(); var p = evaluate(S.keys, now(), prefs.mode); addKeyHere({ x: p.x, y: p.y, z: 1 }); };
$('zoom').addEventListener('input', function () {
  if (!S.ready) return;
  pause();
  var p = evaluate(S.keys, now(), prefs.mode);
  if (!S.zoomDrag) { S.zoomDrag = true; pushHist(); }
  S.keys = setKey(S.keys, Object.assign({ t: snap(now()) }, fit(S.W, S.H, { x: p.x, y: p.y, z: this.value / 100 })), keyEps());
  place(now()); updateZoomUI();
});
$('zoom').addEventListener('change', function () { S.zoomDrag = false; changed(); });

/* ---------- Gestures on the picture ---------- */
function local(e) { var r = $('vp').getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
var vp = $('vp');
vp.addEventListener('pointerdown', function (e) {
  if (!S.ready || S.job) return;
  e.preventDefault();
  try { vp.setPointerCapture(e.pointerId); } catch (_) {}
  S.pointers.set(e.pointerId, local(e));
  var base = posAt(now());
  if (S.pointers.size === 2) {
    var pts = Array.from(S.pointers.values());
    S.pinch = { d0: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1, z0: base.z, base: base };
    if (S.drag) S.drag.moved = true;
    return;
  }
  if (S.pointers.size > 2) return;
  S.drag = { id: e.pointerId, p: local(e), base: base, moved: false, recording: playing() };
});
vp.addEventListener('pointermove', function (e) {
  if (!S.pointers.has(e.pointerId)) return;
  S.pointers.set(e.pointerId, local(e));
  var r = cropRect(S.W, S.H, S.drag ? S.drag.base : posAt(now()));
  if (S.pinch && S.pointers.size >= 2) {
    var pts = Array.from(S.pointers.values()), d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    var f = S.view === 'reel' ? d / S.pinch.d0 : S.pinch.d0 / d; // spread: zoom in on the reel / a bigger window on the frame
    S.live = fit(S.W, S.H, { x: S.pinch.base.x, y: S.pinch.base.y, z: clamp(S.pinch.z0 * f, 1, MAX_ZOOM) });
    beginRecording();
    place(now()); updateZoomUI();
    return;
  }
  var dr = S.drag; if (!dr || dr.id !== e.pointerId) return;
  var q = local(e), dx = q.x - dr.p.x, dy = q.y - dr.p.y;
  if (!dr.moved && Math.hypot(dx, dy) < 6) return;
  dr.moved = true;
  var nx, ny;
  if (S.view === 'reel') { var k = box.vw / r.w; nx = dr.base.x - dx / k / S.W; ny = dr.base.y - dy / k / S.H; } // drag the picture
  else { nx = dr.base.x + dx / box.vw; ny = dr.base.y + dy / box.vh; } // drag the window
  S.live = fit(S.W, S.H, { x: nx, y: ny, z: dr.base.z });
  beginRecording();
  place(now());
});
function endPointer(e) {
  if (!S.pointers.has(e.pointerId)) return;
  S.pointers.delete(e.pointerId);
  if (S.pinch) {
    if (S.pointers.size >= 2) return;
    var p = S.pinch; S.pinch = null;
    if (!S.pointers.size) { S.drag = null; commitLive(); return; }
    // one finger still down: it carries on dragging from where the pinch left the frame
    var rest = Array.from(S.pointers.entries())[0];
    S.drag = { id: rest[0], p: rest[1], base: S.live || p.base, moved: true };
    return;
  }
  var dr = S.drag; if (!dr || dr.id !== e.pointerId) return;
  S.drag = null;
  if (!dr.moved) {
    var q = local(e);
    if (S.following) { followFrom(q.x / box.vw, q.y / box.vh).catch(function (err) { console.error(err); toast(errMsg(err)); }); return; }
    if (S.view === 'reel') { if (playing()) pause(); else play(); return; }
    if (playing()) return;
    // tap: put the frame's centre there
    addKeyHere({ x: q.x / box.vw, y: q.y / box.vh, z: dr.base.z });
    return;
  }
  commitLive();
}
vp.addEventListener('pointerup', endPointer);
vp.addEventListener('pointercancel', endPointer);

function beginRecording() {
  if (S.rec || !playing()) return;
  pushHist();
  S.rec = [{ t: now(), x: S.live.x, y: S.live.y, z: S.live.z }];
  updateHint();
}
function commitLive() {
  if (S.rec) { finishRecording(); return; }
  if (!S.live) return;
  var p = S.live; S.live = null;
  addKeyHere(p);
}
function finishRecording() {
  var rec = S.rec; S.rec = null;
  var last = S.live; S.live = null;
  if (!rec) return;
  if (last && rec.length && rec[rec.length - 1].t < now() - 1e-3) rec.push({ t: now(), x: last.x, y: last.y, z: last.z });
  rec.sort(function (a, b) { return a.t - b.t; });
  rec = rec.filter(function (s, i) { return !i || s.t > rec[i - 1].t; });
  if (rec.length < 2) { if (last) S.keys = setKey(S.keys, Object.assign({ t: snap(now()) }, last), keyEps()); changed(); return; }
  var fresh = toKeys(rec, 0.08, 0.004);
  S.keys = replaceRange(S.keys, rec[0].t, rec[rec.length - 1].t, fresh);
  changed(); updateHint();
  toast('Recorded a ' + (rec[rec.length - 1].t - rec[0].t).toFixed(1) + ' s move as ' + fresh.length + ' keyframes.', { label: 'UNDO', fn: undo });
}

/* ---------- Follow me ---------- */
$('followBtn').onclick = function () {
  if (!S.ready || S.job) return;
  if (S.following) { stopFollow(); return; }
  pause();
  S.following = true;
  if (S.view !== 'frame') setView('frame');
  $('followBtn').classList.add('on'); $('stage').classList.add('following');
  updateHint();
};
function stopFollow() {
  S.following = false;
  $('followBtn').classList.remove('on'); $('stage').classList.remove('following');
  updateHint();
}

/* Small grey copies of the whole clip, ~10 a second (fewer for long clips), for the tracker. */
function scanClip(progress, signal) {
  var target = 36000, aw = Math.max(32, Math.round(Math.sqrt(target * S.W / S.H))), ah = Math.max(32, Math.round(aw * S.H / S.W));
  var c = document.createElement('canvas'); c.width = aw; c.height = ah;
  var x = c.getContext('2d', { willReadFrequently: true });
  var scan = { w: aw, h: ah, times: [], frames: [] };
  var fps = Math.min(10, 1200 / Math.max(1, S.dur));
  return media.scanFrames(S.file, {
    fps: fps, signal: signal,
    onStart: function (i) { scan.times = i.times; scan.frames = new Array(i.times.length); },
    onFrame: function (f) {
      x.drawImage(f.image(aw, ah), 0, 0, aw, ah);
      var d = x.getImageData(0, 0, aw, ah).data, g = new Uint8Array(aw * ah);
      for (var i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
      scan.frames[f.index] = g;
    },
    onProgress: function (p) { progress(p); }
  }).then(function () {
    for (var i = 0; i < scan.frames.length; i++) if (!scan.frames[i]) scan.frames[i] = scan.frames[i - 1] || scan.frames.find(Boolean);
    return scan;
  });
}

async function followFrom(u, v) {
  stopFollow();
  var t = now();
  if (!S.scan) {
    try {
      S.scan = await runTask('READING THE CLIP', 'Small copies for tracking, once per clip', scanClip);
    } catch (e) {
      if (!(e && e.name === 'AbortError')) toast('Couldn’t read the clip for tracking. ' + errMsg(e));
      return;
    }
    if (!S.scan) return;
  }
  var sc = S.scan, i0 = 0;
  for (var i = 1; i < sc.times.length; i++) if (Math.abs(sc.times[i] - t) < Math.abs(sc.times[i0] - t)) i0 = i;
  var tr = trackSubject(sc.frames, sc.w, sc.h, i0, u * sc.w, v * sc.h);
  // Keep to the trimmed part.
  var a = tr.first, b = tr.last;
  while (a < b && sc.times[a] < S.in - 0.05) a++;
  while (b > a && sc.times[b] > S.out + 0.05) b--;
  if (b - a < 3) { toast('Couldn’t lock on there. Tap a part of you with clear detail: mask, fins, torso.'); return; }
  var z = evaluate(S.keys, t, prefs.mode).z, samples = [], dt = [], dx = [], dy = [];
  for (var j = a; j <= b; j++) {
    var x = tr.x[j] / sc.w, y = tr.y[j] / sc.h;
    samples.push({ t: sc.times[j], x: x, y: y, z: z });
    dt.push(sc.times[j]); dx.push(x); dy.push(y);
  }
  pushHist();
  var fresh = toKeys(samples, 0.5, 0.006).map(function (k) { return Object.assign(k, fit(S.W, S.H, k)); });
  S.keys = replaceRange(S.keys, samples[0].t, samples[samples.length - 1].t, fresh);
  S.track = { t: dt, x: dx, y: dy };
  changed();
  toast('Following you ' + fmtTime(samples[0].t) + '–' + fmtTime(samples[samples.length - 1].t) + ' (' + fresh.length + ' keyframes). Play it back; drag to fix any moment.', { label: 'UNDO', fn: function () { undo(); S.track = null; place(now()); } });
}

/* ---------- Timeline ---------- */
function pct(t) { return (S.dur > 0 ? clamp(t / S.dur, 0, 1) * 100 : 0) + '%'; }
function renderTimeline() {
  $('tlShadeL').style.left = '0'; $('tlShadeL').style.width = pct(S.in);
  $('tlShadeR').style.left = pct(S.out); $('tlShadeR').style.right = '0';
  $('tlRange').style.left = pct(S.in); $('tlRange').style.width = 'calc(' + pct(S.out) + ' - ' + pct(S.in) + ')';
  $('hIn').style.left = pct(S.in); $('hOut').style.left = pct(S.out);
  var ks = $('tlKeys'); ks.innerHTML = '';
  S.keys.forEach(function (k) { var d = document.createElement('i'); d.className = 'tl-k'; d.style.left = pct(k.t); ks.appendChild(d); });
  S.lastOnKey = null;
  var tt = $('tlTrack');
  if (S.track) { tt.hidden = false; tt.style.left = pct(S.track.t[0]); tt.style.width = 'calc(' + pct(S.track.t[S.track.t.length - 1]) + ' - ' + pct(S.track.t[0]) + ')'; } else tt.hidden = true;
  tick(now());
}
(function () {
  var tl = $('tl'), mode = null, wasPlaying = false;
  var tAt = function (e) { var b = tl.querySelector('.tl-bar').getBoundingClientRect(); return clamp((e.clientX - b.left) / b.width, 0, 1) * S.dur; };
  var xOf = function (t) { var b = tl.querySelector('.tl-bar').getBoundingClientRect(); return b.left + (S.dur ? t / S.dur : 0) * b.width; };
  tl.addEventListener('pointerdown', function (e) {
    if (!S.ready || S.job) return;
    e.preventDefault();
    try { tl.setPointerCapture(e.pointerId); } catch (_) {}
    var top = e.clientY - tl.getBoundingClientRect().top < 20 || prefs.tab === 'trim';
    var dIn = Math.abs(e.clientX - xOf(S.in)), dOut = Math.abs(e.clientX - xOf(S.out));
    if (top && Math.min(dIn, dOut) < 22) { mode = dIn <= dOut ? 'in' : 'out'; pushHist(); pause(); }
    else { mode = 'scrub'; wasPlaying = playing(); pause(); }
    move(e);
  });
  var move = function (e) {
    if (!mode) return;
    var t = tAt(e);
    if (mode === 'scrub') {
      // snap to a keyframe within ~8px
      var b = tl.querySelector('.tl-bar').getBoundingClientRect(), tol = 8 / b.width * S.dur, k = keyNear(S.keys, t, tol);
      seek(k >= 0 ? S.keys[k].t : snap(t));
    } else {
      var min = Math.min(0.5, S.dur / 4);
      if (mode === 'in') S.in = clamp(snap(t), 0, S.out - min); else S.out = t >= S.dur - frameDur() ? S.dur : clamp(snap(t), S.in + min, S.dur);
      renderTimeline(); updateTrimUI();
      seek(mode === 'in' ? S.in : S.out);
    }
  };
  tl.addEventListener('pointermove', move);
  var end = function () { if (mode === 'in' || mode === 'out') { saveProject(); updateUI(); } if (mode === 'scrub' && wasPlaying) play(); mode = null; };
  tl.addEventListener('pointerup', end);
  tl.addEventListener('pointercancel', end);
})();
$('inBtn').onclick = function () { if (!S.ready) return; pushHist(); S.in = clamp(snap(now()), 0, S.out - 0.1); changed(); };
$('outBtn').onclick = function () { if (!S.ready) return; pushHist(); S.out = clamp(snap(now()), S.in + 0.1, S.dur); changed(); };
$('trimReset').onclick = function () { if (!S.ready) return; pushHist(); S.in = 0; S.out = S.dur; changed(); };

/* ---------- View ---------- */
function setView(v) {
  S.view = v;
  $('viewBtn').setAttribute('aria-pressed', v === 'reel');
  $('viewBtn').textContent = v === 'reel' ? 'FULL FRAME' : '9:16 VIEW';
  layout(); updateHint();
}
$('viewBtn').onclick = function () { setView(S.view === 'reel' ? 'frame' : 'reel'); };

/* ---------- UI state ---------- */
function setLoading(on) { $('loading').hidden = !on; }
function stageMsg(text) { $('stageMsg').hidden = !text; $('stageMsg').textContent = text || ''; }
function updateHint() {
  var h = $('hint'), txt, hot = false;
  if (S.following) { txt = 'TAP YOURSELF IN THE FRAME'; hot = true; }
  else if (S.rec) { txt = 'RECORDING THE MOVE — LIFT TO FINISH'; hot = true; }
  else if (playing()) txt = S.view === 'reel' ? 'DRAG TO RECORD A MOVE · TAP TO PAUSE' : 'DRAG THE FRAME TO RECORD A MOVE';
  else txt = S.view === 'reel' ? 'DRAG TO PAN · PINCH TO ZOOM · TAP TO PLAY' : 'DRAG OR TAP TO PLACE THE FRAME · PINCH TO ZOOM';
  h.textContent = txt; h.classList.toggle('hot', hot);
}
function updateZoomUI() {
  var p = posAt(now());
  $('zoom').value = Math.round(p.z * 100);
  $('zoomVal').textContent = p.z.toFixed(1) + '×';
  var s = cropSize(S.W, S.H, p.z), up = 1080 / s.w;
  $('cropNote').textContent = 'Crop ' + Math.round(s.w) + '×' + Math.round(s.h) + ' px of ' + S.W + '×' + S.H + ' → 1080×1920' +
    (up > 1.6 ? '. Upscaled ' + up.toFixed(1) + '×: it will look soft.' : '.') + ' Zoom is keyframed like position.';
}
function updateTrimUI() {
  var len = S.out - S.in;
  $('trimNote').textContent = fmtTime(S.in, true) + ' → ' + fmtTime(S.out, true) + ' · ' + len.toFixed(1) + ' s' +
    (len > 180 ? '. Longer than 3 minutes: Instagram may refuse it as a reel.' : '. Drag the brackets above the timeline, or play to a moment and set it here.');
}
function outFps() { var f = S.fps || 30; return prefs.fps === '30' ? Math.min(30, f) : Math.min(60, f); }
function bitrateFor(fps) { return Math.round(clamp(1080 * 1920 * fps * (prefs.quality === 'std' ? 0.09 : 0.16), 3e6, 40e6)); }
function updateUI() {
  document.querySelectorAll('#modeSeg button').forEach(function (b) { b.classList.toggle('on', b.dataset.mode === prefs.mode); });
  document.querySelectorAll('#fpsSeg button').forEach(function (b) { b.classList.toggle('on', b.dataset.fps === prefs.fps); });
  document.querySelectorAll('#qualSeg button').forEach(function (b) { b.classList.toggle('on', b.dataset.q === prefs.quality); });
  var src = S.fps ? Math.round(S.fps * 100) / 100 : null;
  $('fpsSeg').querySelector('[data-fps="src"]').textContent = src ? 'SOURCE ' + (src > 60 ? '→ 60' : Math.round(src)) : 'SOURCE';
  var n = S.keys.length;
  $('motionNote').textContent = (n ? n + ' keyframe' + (n > 1 ? 's' : '') + '. ' : 'No keyframes yet: the frame stays centred. ') +
    'Drag the frame to set it at this moment; drag while playing to record a move. FOLLOW ME: tap yourself and the frame tracks you.';
  var fps = outFps();
  $('outNote').textContent = '1080×1920 · ' + Math.round(fps * 100) / 100 + ' FPS · ≈' + Math.round(bitrateFor(fps) / 1e6) + ' Mb/s · H.264 where the device has it · audio copied. ' +
    (S.fps > 60 && prefs.fps === 'src' ? 'Instagram tops out at 60 FPS, so every other frame is used. ' : '') + 'Keep this screen open while exporting.';
  $('clearBtn').disabled = !n;
  updateZoomUI(); updateTrimUI();
  $('exportBtn').disabled = !media.canExportVideo() || !S.ready;
  if (!media.canExportVideo()) $('outNote').textContent = 'Video export needs WebCodecs (recent Safari, Chrome, Edge or Firefox).';
}
document.querySelectorAll('#fpsSeg button').forEach(function (b) { b.onclick = function () { prefs.fps = b.dataset.fps; savePrefs(); updateUI(); }; });
document.querySelectorAll('#qualSeg button').forEach(function (b) { b.onclick = function () { prefs.quality = b.dataset.q; savePrefs(); updateUI(); }; });

/* ---------- Jobs: export, reading the clip ---------- */
var wake = null;
function keepAwake(on) {
  if (on && 'wakeLock' in navigator && document.visibilityState === 'visible') {
    navigator.wakeLock.request('screen').then(function (w) { wake = w; }, function () {});
  } else if (!on && wake) { wake.release().catch(function () {}); wake = null; }
}
document.addEventListener('visibilitychange', function () { if (S.job && document.visibilityState === 'visible') keepAwake(true); });
window.addEventListener('beforeunload', function (e) { if (S.job) { e.preventDefault(); e.returnValue = ''; } });

/* Run fn(progress, signal) with the progress dock up. */
async function runTask(title, sub0, fn) {
  if (S.job) throw new Error('Busy');
  var ctl = new AbortController(), start = performance.now(), sub = sub0 || '';
  S.job = { ctl: ctl };
  pause(); closeSheet(); keepAwake(true);
  $('editor').classList.add('busy');
  $('job').hidden = false; $('cancelBtn').disabled = false;
  $('jobTitle').textContent = title;
  var progress = function (f, s) {
    if (s != null) sub = s;
    f = clamp(f || 0, 0, 1);
    var el = (performance.now() - start) / 1000, left = f > 0.02 ? el / f * (1 - f) : null;
    $('jobPct').textContent = Math.floor(f * 100) + '%';
    $('jobBar').style.width = (f * 100) + '%';
    $('jobSub').textContent = [sub, left != null && el > 3 ? fmtTime(left) + ' LEFT' : ''].filter(Boolean).join(' · ');
  };
  progress(0);
  try { return await fn(progress, ctl.signal); } finally {
    S.job = null; $('job').hidden = true; $('editor').classList.remove('busy'); keepAwake(false);
  }
}
$('cancelBtn').onclick = function () { if (S.job) { S.job.ctl.abort(); $('cancelBtn').disabled = true; $('jobTitle').textContent = 'CANCELING'; } };

async function reelPlan(src) {
  var sizes = [[1080, 1920], [720, 1280]];
  for (var i = 0; i < sizes.length; i++) {
    var w = sizes[i][0], h = sizes[i][1], b = Math.round(bitrateFor(src.fps) * (w * h) / (1080 * 1920));
    var codec = await media.getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9', 'av1'], { width: w, height: h, quality: new media.Quality({ bitrate: b }) });
    if (codec) return { codec: codec, width: w, height: h, bitrate: b };
  }
  throw new Error('This browser can’t encode video.');
}

$('exportBtn').onclick = async function () {
  if (!S.ready || S.job) return;
  var keys = S.keys.slice(), mode = prefs.mode, file = S.file;
  var name = file.name.replace(/\.[^.]+$/, '') + '_reel.mp4';
  var full = S.out >= S.dur - 0.01;
  try {
    var out = await runTask('EXPORTING — ' + file.name, '', function (progress, signal) {
      return media.transcode(file, {
        name: name, signal: signal, start: S.in, end: full ? null : S.out, maxFps: prefs.fps === '30' ? 30 : 60,
        plan: reelPlan,
        renderer: function (plan, src) {
          var c = document.createElement('canvas'); c.width = plan.width; c.height = plan.height;
          var x = c.getContext('2d', { alpha: false });
          x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
          return {
            kind: 'cpu',
            draw: function (f) {
              var r = cropRect(src.width, src.height, evaluate(keys, f.t, mode)), s = plan.width / r.w;
              // Crop by placing the whole frame so the crop fills the canvas (the rest is clipped). Safari ignores
              // the source rectangle when drawing a VideoFrame and would squeeze the full frame into 9:16.
              x.drawImage(f.image(), -r.x * s, -r.y * s, src.width * s, src.height * s);
              return c;
            },
            dispose: function () { c.width = c.height = 1; }
          };
        },
        onStart: function (o) {
          progress(0, o.width + '×' + o.height + ' · ' + Math.round(o.fps * 100) / 100 + ' FPS → ' + media.codecName(o.codec) + ' ' + Math.round(o.bitrate / 1e6) + ' Mb/s' + (o.via === 'element' ? ' · PLAYER DECODE' : ''));
        },
        onProgress: function (f) { progress(f); }
      });
    });
    offer(out);
  } catch (e) {
    if (e && e.name === 'AbortError') toast('Canceled.');
    else { console.error(e); toast(errMsg(e)); }
  }
};

/* ---------- Saving ---------- */
function offer(file) {
  S.offered = file;
  var share = store.canShareFiles([file]), mobile = isIOS || coarse;
  $('sheetTitle').textContent = file.name;
  $('sheetSub').textContent = fmtBytes(file.size) + (share && mobile ? ' · Share straight to Instagram, or choose “Save Video” to put it in Photos' : '');
  $('sheetClose').hidden = false;
  var btns = $('sheetBtns'); btns.innerHTML = '';
  var add = function (label, fn, primary) {
    var b = document.createElement('button'); b.type = 'button'; b.className = 'btn' + (primary ? ' primary' : ''); b.textContent = label;
    b.onclick = function () { fn().catch(function (e) { if (!e || e.name !== 'AbortError') toast(errMsg(e)); }); };
    btns.appendChild(b); return b;
  };
  var first = null;
  if (share && mobile) first = add('SAVE / SHARE', function () { return store.shareFiles([file]).then(function (ok) { if (ok) closeSheet(); }); }, true);
  var dl = add('DOWNLOAD', function () { return store.downloadFiles([file]).then(closeSheet); }, !first);
  first = first || dl;
  if (share && !mobile) add('SHARE', function () { return store.shareFiles([file]).then(function (ok) { if (ok) closeSheet(); }); });
  $('sheet').hidden = false;
  first.focus({ preventScroll: true });
}
function closeSheet() { $('sheet').hidden = true; S.offered = null; }
$('sheetClose').onclick = closeSheet;

var toastTimer = 0;
function toast(msg, action) {
  var t = $('toast'); t.textContent = ''; t.hidden = false;
  var span = document.createElement('span'); span.textContent = msg; t.appendChild(span);
  if (action) {
    var b = document.createElement('button'); b.type = 'button'; b.textContent = action.label;
    b.onclick = function () { t.hidden = true; action.fn(); };
    t.appendChild(b);
  }
  clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, action ? 6000 : Math.min(9000, 3000 + msg.length * 40));
}

/* ---------- Keyboard (computers) ---------- */
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') { if (!$('sheet').hidden) closeSheet(); else if (S.following) stopFollow(); return; }
  if (!S.ready || S.job || /INPUT|TEXTAREA/.test(document.activeElement && document.activeElement.tagName)) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
  if (e.key === ' ') { e.preventDefault(); if (playing()) pause(); else play(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); pause(); seek(e.shiftKey ? snap(now() - 1) : stepFrame(-1)); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); pause(); seek(e.shiftKey ? snap(now() + 1) : stepFrame(1)); }
  else if (e.key.toLowerCase() === 'k') $('keyBtn').click();
});

/* ---------- Files in from elsewhere ---------- */
['dragenter', 'dragover'].forEach(function (t) {
  window.addEventListener(t, function (e) { if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0) { e.preventDefault(); $('drop').classList.add('over'); } });
});
window.addEventListener('dragleave', function (e) { if (!e.relatedTarget) $('drop').classList.remove('over'); });
window.addEventListener('drop', function (e) {
  $('drop').classList.remove('over');
  if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) { e.preventDefault(); if (!S.job) openFile(e.dataTransfer.files[0]); }
});
$('drop').addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); } });
// It's an app: no pinch zoom of the page (iOS ignores user-scalable=no).
['gesturestart', 'gesturechange', 'gestureend'].forEach(function (t) { document.addEventListener(t, function (e) { e.preventDefault(); }, { passive: false }); });
document.addEventListener('touchmove', function (e) { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });

/* ---------- Install, offline, updates ---------- */
$('ver').textContent = 'V' + VERSION;
var deferredInstall = null;
window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferredInstall = e; $('installBtn').hidden = false; });
window.addEventListener('appinstalled', function () { $('installBtn').hidden = true; });
$('installBtn').onclick = function () { if (!deferredInstall) return; deferredInstall.prompt(); deferredInstall = null; $('installBtn').hidden = true; };
var standalone = navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
if (isIOS && !standalone) $('iosTip').hidden = false;
if (isIOS) $('iosVidTip').hidden = false;

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  var reloading = false, wantUpdate = false;
  navigator.serviceWorker.addEventListener('controllerchange', function () {
    $('offline').hidden = false;
    if (wantUpdate && !reloading) { reloading = true; location.reload(); }
  });
  if (navigator.serviceWorker.controller) $('offline').hidden = false;
  navigator.serviceWorker.register('sw.js').then(function (reg) {
    var offerUpdate = function (w) {
      // Only a newer version of this app is an update (not the first install, even when UW Color's worker is in charge).
      if (!w || !reg.active || reg.active === w) return;
      if (!S.file && !S.job) { wantUpdate = true; w.postMessage('skipWaiting'); return; }
      $('updateBtn').hidden = false;
      $('updateBtn').onclick = function () {
        if (S.job) { toast('Finish or cancel the export first.'); return; }
        wantUpdate = true; w.postMessage('skipWaiting');
      };
    };
    offerUpdate(reg.waiting);
    reg.addEventListener('updatefound', function () {
      var w = reg.installing;
      w.addEventListener('statechange', function () { if (w.state === 'installed') offerUpdate(w); });
    });
    setInterval(function () { reg.update().catch(function () {}); }, 3600000);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') reg.update().catch(function () {}); });
  }).catch(function () {});
}

// Computers: "Open with UW Reels"
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(function (params) {
    if (params.files && params.files.length) params.files[0].getFile().then(openFile);
  });
}
// Android: shared from the gallery / GoPro Quik (the service worker stashed the file)
if (/[?&]share-target\b/.test(location.search) && window.caches) {
  history.replaceState(null, '', location.pathname);
  caches.open('uw-reels-share').then(function (c) {
    return c.keys().then(function (ks) {
      return Promise.all(ks.map(function (k) {
        return c.match(k).then(function (r) {
          return r.blob().then(function (b) {
            c.delete(k);
            return new File([b], decodeURIComponent(r.headers.get('x-name') || 'shared.mp4'), { type: b.type });
          });
        });
      }));
    });
  }).then(function (files) { if (files.length) openFile(files[0]); }).catch(function () {});
}

store.clearExports();
updateHint();
