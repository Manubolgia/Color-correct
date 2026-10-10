import { DEFAULTS, clamp, computeParams, applyCorrection, makeCube } from './color.js';
import { renderJPEG, warmPhotoWorkers, sourceSize } from './photo.js';
import { readExif } from './exif.js';
import * as store from './store.js';

var $ = function (id) { return document.getElementById(id); };
var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
var coarse = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
var PREVIEW_EDGE = 1440, ANALYSIS_EDGE = 320;
var PREFS = 'uw-color-v2';
var JPEG_Q = { std: 90, high: 95, max: 100 };
var VIDEO_Q = { std: 0.55, high: 1, max: 1.4 }; // keep in step with video.js

var SLIDERS = [
  { k: 'strength', label: 'STRENGTH', min: 0, max: 100, unit: '%' },
  { k: 'warmth', label: 'WARMTH', min: -100, max: 100, signed: true },
  { k: 'tint', label: 'TINT  GREEN ↔ MAGENTA', min: -100, max: 100, signed: true },
  { k: 'bright', label: 'BRIGHTNESS', min: -100, max: 100, signed: true },
  { k: 'contrast', label: 'CONTRAST', min: -50, max: 100, signed: true },
  { k: 'sat', label: 'SATURATION', min: -100, max: 100, signed: true }
];

var prefs = { settings: Object.assign({}, DEFAULTS), quality: 'high' };
try {
  var saved = JSON.parse(localStorage.getItem(PREFS) || localStorage.getItem('uw-color-settings-v1') || '{}');
  var ss = saved.settings || saved;
  SLIDERS.forEach(function (s) { if (typeof ss[s.k] === 'number') prefs.settings[s.k] = clamp(ss[s.k], s.min, s.max); });
  if (JPEG_Q[saved.quality]) prefs.quality = saved.quality;
} catch (e) {}
function persist() { try { localStorage.setItem(PREFS, JSON.stringify(prefs)); } catch (e) {} }

var S = {
  items: [], cur: -1, prevOrig: null, outImg: null, analysis: null, params: null, split: 0.5, picking: false,
  token: 0, loading: false, job: null, clipP: null, clipItem: null, offered: null
};
function cur() { return S.items[S.cur]; }
function closeSrc(src) { if (src && typeof src.close === 'function') src.close(); }
function stem(name) { return (name || 'image').replace(/\.[^.]+$/, ''); }
function fmtTime(t) { t = Math.max(0, t || 0); var m = Math.floor(t / 60), s = Math.floor(t % 60); return m + ':' + (s < 10 ? '0' : '') + s; }
function stamp(t) { t = Math.max(0, t || 0); var m = Math.floor(t / 60), s = Math.floor(t % 60); return m + 'm' + (s < 10 ? '0' : '') + s + 's'; }
function fmtBytes(b) { return b >= 1073741824 ? (b / 1073741824).toFixed(2) + ' GB' : b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'; }
function errMsg(e) { return e && e.message && e.message !== 'decode' ? e.message : 'Something went wrong.'; }

var videoMod = null;
function loadVideo() {
  if (!videoMod) videoMod = import('./video.js').catch(function (e) { videoMod = null; throw e; });
  return videoMod;
}

/* ---------- Sliders ---------- */
var box = $('sliders');
SLIDERS.forEach(function (s) {
  var wrap = document.createElement('label'); wrap.className = 'sl';
  wrap.innerHTML = '<span class="sl-top"><span>' + s.label + '</span><output></output></span><input type="range" min="' + s.min + '" max="' + s.max + '" step="1">';
  s.input = wrap.querySelector('input'); s.out = wrap.querySelector('output');
  s.input.setAttribute('aria-label', s.label.toLowerCase());
  s.input.addEventListener('input', function () { prefs.settings[s.k] = +s.input.value; showSlider(s); persist(); schedule(); });
  s.input.addEventListener('dblclick', function () { prefs.settings[s.k] = DEFAULTS[s.k]; syncSliders(); persist(); schedule(); });
  box.appendChild(wrap);
});
function showSlider(s) {
  var v = prefs.settings[s.k], p = (v - s.min) / (s.max - s.min) * 100, z = s.signed ? (0 - s.min) / (s.max - s.min) * 100 : 0;
  s.out.textContent = (s.signed && v > 0 ? '+' : '') + v + (s.unit || '');
  s.input.style.setProperty('--a', Math.min(p, z) + '%');
  s.input.style.setProperty('--b', Math.max(p, z) + '%');
}
function syncSliders() { SLIDERS.forEach(function (s) { s.input.value = prefs.settings[s.k]; showSlider(s); }); }
syncSliders();
$('resetBtn').onclick = function () { Object.assign(prefs.settings, DEFAULTS); syncSliders(); persist(); schedule(); };

/* Output quality */
function syncQuality() {
  Array.prototype.forEach.call($('qualSeg').children, function (b) {
    var on = b.dataset.q === prefs.quality;
    b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
  });
  updateKindUI();
}
Array.prototype.forEach.call($('qualSeg').children, function (b) {
  b.onclick = function () { prefs.quality = b.dataset.q; persist(); syncQuality(); };
});

/* ---------- Preview pipeline ---------- */
var raf = 0;
function schedule() { if (raf) return; raf = requestAnimationFrame(function () { raf = 0; recompute(); }); }
function paramsFor(it, analysis) {
  if (it.kind === 'video' && it.lock) return computeParams(it.lock.analysis, prefs.settings, it.lock.pick ? it.lock.pick.rgb : null);
  return computeParams(analysis, prefs.settings, it.kind === 'image' && it.pick ? it.pick.rgb : null);
}
function recompute() {
  var it = cur();
  if (!S.analysis || !it) return;
  S.params = paramsFor(it, S.analysis);
  renderPreview();
}
function renderPreview() {
  if (!S.prevOrig || !S.params) return;
  S.outImg.data.set(S.prevOrig.data);
  applyCorrection(S.outImg.data, S.outImg.data, S.params);
  $('after').getContext('2d').putImageData(S.outImg, 0, 0);
}
function analysisPixels(src) {
  var d = sourceSize(src), sc = Math.min(1, ANALYSIS_EDGE / Math.max(d[0], d[1]));
  var c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(d[0] * sc)); c.height = Math.max(1, Math.round(d[1] * sc));
  var x = c.getContext('2d', { willReadFrequently: true });
  x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
  x.drawImage(src, 0, 0, c.width, c.height);
  return x.getImageData(0, 0, c.width, c.height).data;
}
function previewSize(w, h) {
  var sc = Math.min(1, PREVIEW_EDGE / Math.max(w, h));
  return [Math.max(1, Math.round(w * sc)), Math.max(1, Math.round(h * sc))];
}
function setSource(src) {
  var d = sourceSize(src);
  if (!d[0] || !d[1]) throw new Error('No image data');
  var p = previewSize(d[0], d[1]), pw = p[0], ph = p[1];
  var before = $('before'), after = $('after');
  if (before.width !== pw || before.height !== ph) { before.width = after.width = pw; before.height = after.height = ph; }
  var bx = before.getContext('2d', { willReadFrequently: true });
  bx.imageSmoothingEnabled = true; bx.imageSmoothingQuality = 'high';
  bx.clearRect(0, 0, pw, ph);
  bx.drawImage(src, 0, 0, pw, ph);
  S.prevOrig = bx.getImageData(0, 0, pw, ph);
  S.outImg = after.getContext('2d').createImageData(pw, ph);
  S.analysis = analysisPixels(before);
  layoutStage();
  recompute();
}
function clearStage() {
  S.prevOrig = S.outImg = S.analysis = S.params = null;
  $('before').width = $('after').width = 0;
  $('after').style.width = $('after').style.height = '0px';
}
function layoutStage() {
  var a = $('after'); if (!a.width) return;
  var st = $('stage'), cs = getComputedStyle(st), wide = window.innerWidth >= 980;
  var aw = st.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  var it = cur(), chrome = $('stage').getBoundingClientRect().top + window.scrollY + (it && it.kind === 'video' ? 46 : 0) + 38 + 24;
  var ah = Math.max(200, wide ? window.innerHeight - chrome : window.innerHeight * 0.56);
  var sc = Math.min(aw / a.width, ah / a.height);
  a.style.width = Math.floor(a.width * sc) + 'px';
  a.style.height = Math.floor(a.height * sc) + 'px';
}
window.addEventListener('resize', layoutStage);
function setLoading(on) { S.loading = on; $('loading').hidden = !on; }
function stageMsg(text) { $('stageMsg').hidden = !text; $('stageMsg').textContent = text || ''; }

/* ---------- Before/after split and tap-to-balance ---------- */
var frame = $('frame');
function setSplit(f) {
  S.split = clamp(f, 0, 1);
  var inset = 'inset(0 ' + ((1 - S.split) * 100) + '% 0 0)', b = $('before');
  b.style.clipPath = inset; b.style.webkitClipPath = inset;
  $('divider').style.left = (S.split * 100) + '%';
  $('tagL').style.opacity = S.split < 0.12 ? 0 : 1;
  $('tagR').style.opacity = S.split > 0.88 ? 0 : 1;
  frame.setAttribute('aria-valuenow', Math.round(S.split * 100));
}
setSplit(0.5);
function rel(e) { var r = frame.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]; }
var drag = null;
frame.addEventListener('pointerdown', function (e) {
  if (!S.prevOrig || S.loading) return;
  var p = rel(e);
  if (S.picking) { e.preventDefault(); setPick(clamp(p[0], 0, 1), clamp(p[1], 0, 1)); return; }
  drag = { x: e.clientX, active: e.pointerType === 'mouse' };
  if (drag.active) { try { frame.setPointerCapture(e.pointerId); } catch (_) {} setSplit(p[0]); }
});
frame.addEventListener('pointermove', function (e) {
  if (!drag) return;
  if (!drag.active && Math.abs(e.clientX - drag.x) > 6) { drag.active = true; try { frame.setPointerCapture(e.pointerId); } catch (_) {} }
  if (drag.active) setSplit(rel(e)[0]);
});
frame.addEventListener('pointerup', function (e) { if (drag && !drag.active) setSplit(rel(e)[0]); drag = null; });
frame.addEventListener('pointercancel', function () { drag = null; });
frame.addEventListener('keydown', function (e) {
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); setSplit(S.split + (e.key === 'ArrowLeft' ? -0.05 : 0.05)); }
});

function samplePick(fx, fy) {
  var im = S.prevOrig, w = im.width, h = im.height, d = im.data;
  var cx = Math.round(fx * (w - 1)), cy = Math.round(fy * (h - 1)), rad = Math.max(2, Math.round(Math.max(w, h) / 250));
  var r = 0, g = 0, b = 0, c = 0;
  for (var y = Math.max(0, cy - rad); y <= Math.min(h - 1, cy + rad); y++) {
    for (var x = Math.max(0, cx - rad); x <= Math.min(w - 1, cx + rad); x++) {
      var j = (y * w + x) * 4; r += d[j]; g += d[j + 1]; b += d[j + 2]; c++;
    }
  }
  return [r / c / 255, g / c / 255, b / c / 255];
}
function setPick(fx, fy) {
  var rgb = samplePick(fx, fy), it = cur();
  var mx = Math.max(rgb[0], rgb[1], rgb[2]), avg = (rgb[0] + rgb[1] + rgb[2]) / 3;
  if (mx > 0.985) { toast('That spot is blown out. Tap a slightly darker grey or white.'); return; }
  if (avg < 0.03) { toast('That spot is too dark. Tap something lighter.'); return; }
  var pick = { rgb: rgb, fx: fx, fy: fy };
  if (it.kind === 'video') it.lock = { analysis: S.analysis.slice(), t: it.time, pick: pick };
  else it.pick = pick;
  S.picking = false; updateModeUI(); recompute();
}
function pickOf(it) { return it.kind === 'video' ? (it.lock && it.lock.pick) : it.pick; }
function updateModeUI() {
  var it = cur(); if (!it) return;
  var pick = pickOf(it), isV = it.kind === 'video';
  var seg = function (id, on) { $(id).classList.toggle('on', on); $(id).setAttribute('aria-pressed', String(on)); };
  seg('autoBtn', !pick && !S.picking);
  seg('pickBtn', !!pick || S.picking);
  $('pickBtn').textContent = S.picking ? 'TAP THE IMAGE' : pick ? 'NEUTRAL ✓' : 'TAP NEUTRAL';
  if (isV) {
    seg('adaptBtn', !it.lock); seg('lockBtn', !!it.lock);
    $('lockBtn').textContent = it.lock ? 'LOCKED @ ' + fmtTime(it.lock.t - (it.vinfo ? it.vinfo.start : 0)) : 'LOCK TO FRAME';
    $('modeNote').textContent = it.lock
      ? 'The balance from this frame is used for the whole clip. Best for one scene at a steady depth.'
      : 'Re-balances continuously as depth and light change through the clip. The preview shows this frame.';
  }
  frame.classList.toggle('picking', S.picking);
  $('hint').textContent = S.picking ? 'TAP SOMETHING WHITE OR GREY — SAND, A TANK, A FIN, A SLATE' : 'DRAG ACROSS THE IMAGE TO COMPARE';
  var m = $('marker'), show = !!pick && (!isV || it.lock.t === it.time);
  m.hidden = !show;
  if (show) { m.style.left = (pick.fx * 100) + '%'; m.style.top = (pick.fy * 100) + '%'; }
}
$('autoBtn').onclick = function () {
  var it = cur(); if (!it) return;
  if (it.kind === 'video') { if (it.lock) it.lock.pick = null; } else it.pick = null;
  S.picking = false; updateModeUI(); recompute();
};
$('pickBtn').onclick = function () { if (!S.prevOrig) return; S.picking = !S.picking; updateModeUI(); };
$('adaptBtn').onclick = function () { var it = cur(); if (!it) return; it.lock = null; S.picking = false; updateModeUI(); recompute(); };
$('lockBtn').onclick = function () {
  var it = cur(); if (!it || !S.analysis) return;
  it.lock = { analysis: S.analysis.slice(), t: it.time, pick: null };
  updateModeUI(); recompute();
};

/* ---------- Files ---------- */
var nextId = 1;
function isVideoFile(f) { return /^video\//.test(f.type) || /\.(mp4|mov|m4v)$/i.test(f.name); }
function addFiles(list) {
  var files = Array.prototype.filter.call(list || [], function (f) {
    return /^(image|video)\//.test(f.type) || /\.(jpe?g|png|webp|gif|avif|heic|heif|mp4|mov|m4v)$/i.test(f.name);
  });
  if (!files.length) { toast('Choose photos or videos.'); return; }
  var first = S.items.length;
  files.forEach(function (f) {
    S.items.push({ id: nextId++, file: f, name: f.name, kind: isVideoFile(f) ? 'video' : 'image', pick: null, lock: null, time: null });
  });
  $('empty').hidden = true; $('editor').hidden = false;
  warmPhotoWorkers();
  buildStrip();
  if (!S.job) select(first);
}
$('file').addEventListener('change', function () { addFiles(this.files); this.value = ''; });
function hasFiles(e) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0; }
['dragenter', 'dragover'].forEach(function (t) {
  window.addEventListener(t, function (e) { if (hasFiles(e)) { e.preventDefault(); $('drop').classList.add('over'); } });
});
window.addEventListener('dragleave', function (e) { if (!e.relatedTarget) $('drop').classList.remove('over'); });
window.addEventListener('drop', function (e) {
  $('drop').classList.remove('over');
  if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) { e.preventDefault(); addFiles(e.dataTransfer.files); }
});

function decode(file) {
  var viaImg = function () {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () { res(img); setTimeout(function () { URL.revokeObjectURL(url); }, 0); };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error('decode')); };
      img.decoding = 'async'; img.src = url;
    });
  };
  if (window.createImageBitmap) return createImageBitmap(file, { imageOrientation: 'from-image' }).catch(viaImg);
  return viaImg();
}

function buildStrip() {
  var strip = $('strip'); strip.innerHTML = '';
  S.items.forEach(function (it, i) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'thumb'; b.setAttribute('aria-label', it.name);
    b.innerHTML = '<span class="n">' + String(i + 1).padStart(2, '0') + '</span>';
    b.onclick = function () { if (!S.job && i !== S.cur) select(i); };
    it.btn = b; strip.appendChild(b);
  });
  var add = document.createElement('button');
  add.type = 'button'; add.className = 'add'; add.textContent = '+'; add.setAttribute('aria-label', 'Add files');
  add.onclick = function () { $('file').click(); };
  strip.appendChild(add);
  refreshThumbs();
}
function refreshThumbs() {
  S.items.forEach(function (it, i) {
    if (!it.btn) return;
    it.btn.classList.toggle('on', i === S.cur);
    it.btn.classList.toggle('vid', it.kind === 'video');
    it.btn.classList.toggle('done', !!it.done);
    if (it.thumb) it.btn.style.backgroundImage = 'url("' + it.thumb + '")';
  });
}
function thumbFrom(src) {
  var d = sourceSize(src), T = 128, s = T / Math.min(d[0], d[1]);
  var c = document.createElement('canvas'); c.width = c.height = T;
  var x = c.getContext('2d'); x.imageSmoothingQuality = 'high';
  x.drawImage(src, (T - d[0] * s) / 2, (T - d[1] * s) / 2, d[0] * s, d[1] * s);
  return c.toDataURL('image/jpeg', 0.75);
}
var pumping = false;
function pumpThumbs() {
  if (pumping) return; pumping = true;
  (function next() {
    var it = S.items.filter(function (x) { return x.kind === 'image' && !x.thumb && !x.noThumb; })[0];
    if (!it) { pumping = false; return; }
    if (S.loading || S.job) { setTimeout(next, 500); return; }
    decode(it.file).then(function (src) { it.dims = it.dims || sourceSize(src); it.thumb = thumbFrom(src); closeSrc(src); })
      .catch(function () { it.noThumb = true; })
      .then(function () { refreshThumbs(); setTimeout(next, 60); });
  })();
}

function infoLine(it) {
  var parts = [];
  if (it.kind === 'video' && it.vinfo) {
    var v = it.vinfo;
    parts.push(v.width + '×' + v.height, (Math.round(v.fps * 100) / 100) + ' FPS', codecLabel(v.codec), fmtTime(v.end - v.start));
    if (v.hdr) parts.push('HDR');
  } else if (it.dims) {
    parts.push(it.dims[0] + '×' + it.dims[1], (it.dims[0] * it.dims[1] / 1e6).toFixed(1) + ' MP');
  }
  parts.push(fmtBytes(it.file.size));
  return parts.join(' · ');
}
function codecLabel(c) { return ({ avc: 'H.264', hevc: 'HEVC', vp9: 'VP9', av1: 'AV1' })[c] || String(c || '').toUpperCase(); }

function updateKindUI() {
  var it = cur(); if (!it) return;
  var isV = it.kind === 'video';
  $('fileName').textContent = it.name;
  $('fileInfo').textContent = infoLine(it);
  $('saveBtn').textContent = isV ? 'EXPORT VIDEO' : 'SAVE PHOTO';
  $('frameBtn').hidden = !isV;
  $('modeGroup').hidden = !isV;
  $('videoBar').hidden = !isV;
  $('allBtn').hidden = S.items.length < 2;
  $('allBtn').textContent = 'ALL ' + S.items.length;
  $('folderRow').hidden = !store.canPickFolder;
  var note;
  if (isV) {
    var v = it.vinfo, f = VIDEO_Q[prefs.quality];
    note = (v && v.bitrate ? '≈' + Math.round(v.bitrate * f / 1e6) + ' Mb/s · ' : '') + Math.round(f * 100) + '% of source bitrate. Same resolution and frame rate, audio copied. Keep this screen open while exporting.' +
      (isIOS ? ' iPhone: if the size above is lower than you filmed, iOS shrank it on import. Pick the clip via Files instead.' : '');
    if (!videoSupport) note = 'Video export needs WebCodecs (recent Chrome, Edge, Safari or Firefox). You can still save frames and export a LUT.';
  } else {
    note = 'JPEG ' + JPEG_Q[prefs.quality] + ', no chroma subsampling, full ' + (it.dims ? it.dims[0] + '×' + it.dims[1] : 'resolution') +
      (/\.jpe?g$/i.test(it.name) || /jpeg/.test(it.file.type) ? '. Keeps date, camera and GPS metadata.' : '.');
  }
  $('qualNote').textContent = note;
  $('saveBtn').disabled = isV && !videoSupport;
}
var videoSupport = typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined';

/* ---------- Selecting an item ---------- */
function openClip(it) {
  if (S.clipItem === it && S.clipP) return S.clipP;
  closeClip();
  S.clipItem = it;
  var p = S.clipP = loadVideo().then(function (V) { return V.openVideo(it.file); }).then(function (clip) {
    if (S.clipItem !== it) { clip.dispose(); throw new Error('stale'); }
    it.vinfo = clip.info;
    return clip;
  });
  p.catch(function () { if (S.clipP === p) { S.clipP = null; S.clipItem = null; } });
  return p;
}
function closeClip() {
  if (S.clipP) S.clipP.then(function (c) { c.dispose(); }, function () {});
  S.clipP = null; S.clipItem = null;
}
var frameReq = 0;
function showFrame(it, t, token) {
  var req = ++frameReq; // only the most recently requested frame may reach the screen
  return openClip(it).then(function (clip) {
    var p = previewSize(clip.info.width, clip.info.height), c = document.createElement('canvas');
    c.width = p[0]; c.height = p[1];
    return clip.draw(t, c.getContext('2d')).then(function () {
      if (token !== S.token || req !== frameReq) return;
      it.time = t;
      setSource(c);
      if (!it.thumb) { it.thumb = thumbFrom(c); refreshThumbs(); }
    });
  });
}
function select(i) {
  if (i < 0 || i >= S.items.length) return;
  var token = ++S.token, it = S.items[i];
  S.cur = i; S.picking = false;
  refreshThumbs(); updateKindUI(); updateModeUI(); stageMsg(null);
  if (it.btn && it.btn.scrollIntoView) it.btn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  setLoading(true);
  var job;
  if (it.kind === 'video') {
    job = openClip(it).then(function (clip) {
      if (token !== S.token) return;
      var v = clip.info;
      if (it.time == null) it.time = Math.min(v.start + (v.end - v.start) * 0.5, v.start + 2);
      syncScrub(it);
      updateKindUI(); updateModeUI();
      return showFrame(it, it.time, token);
    });
  } else {
    closeClip();
    job = decode(it.file).then(function (src) {
      try {
        if (token !== S.token) return;
        it.dims = sourceSize(src);
        setSource(src);
        if (!it.thumb) { it.thumb = thumbFrom(src); refreshThumbs(); }
        updateKindUI();
      } finally { closeSrc(src); }
    });
  }
  job.then(function () { if (token === S.token) updateModeUI(); }).catch(function (e) {
    if (token !== S.token) return;
    clearStage();
    if (it.kind === 'video') stageMsg('Can’t open this video here. ' + (e && e.message && e.message !== 'stale' ? e.message : ''));
    else stageMsg(/\.hei[cf]$/i.test(it.name) ? 'This browser can’t open HEIC photos. Use Safari, or export the photo as JPEG.' : 'This browser can’t open that image. Try a JPEG.');
  }).then(function () {
    if (token === S.token) setLoading(false);
    pumpThumbs();
  });
}

/* Video scrubbing: one frame request at a time, always jumping to the latest position. */
function syncScrub(it) {
  var v = it.vinfo; if (!v) return;
  var span = Math.max(0.001, v.end - v.start);
  $('scrub').value = Math.round((it.time - v.start) / span * 1000);
  scrubFill();
  $('timeLabel').textContent = fmtTime(it.time - v.start) + ' / ' + fmtTime(span);
}
function scrubFill() { var s = $('scrub'); s.style.setProperty('--a', '0%'); s.style.setProperty('--b', (s.value / 10) + '%'); }
var seeking = false, pendingT = null;
function scrubTo(t) {
  var it = cur(); if (!it || it.kind !== 'video') return;
  if (seeking) { pendingT = t; return; }
  seeking = true;
  showFrame(it, t, S.token).then(function () { updateModeUI(); }, function () {}).then(function () {
    seeking = false;
    if (pendingT != null) { var n = pendingT; pendingT = null; scrubTo(n); }
  });
}
$('scrub').addEventListener('input', function () {
  var it = cur(); if (!it || !it.vinfo) return;
  var v = it.vinfo, t = v.start + this.value / 1000 * (v.end - v.start);
  scrubFill();
  $('timeLabel').textContent = fmtTime(t - v.start) + ' / ' + fmtTime(v.end - v.start);
  scrubTo(t);
});

$('removeBtn').onclick = function () {
  if (S.job) return;
  var i = S.cur; if (i < 0) return;
  if (S.items[i] === S.clipItem) closeClip();
  S.items.splice(i, 1);
  if (!S.items.length) { S.cur = -1; clearStage(); $('editor').hidden = true; $('empty').hidden = false; return; }
  buildStrip();
  select(Math.min(i, S.items.length - 1));
};

/* ---------- Export tasks ---------- */
function photoTask(it, params) {
  return {
    it: it,
    run: async function (progress, signal) {
      var src = await decode(it.file);
      try {
        var p = params || computeParams(analysisPixels(src), prefs.settings, it.pick ? it.pick.rgb : null);
        it.dims = sourceSize(src);
        progress(0, it.dims[0] + '×' + it.dims[1] + ' · JPEG ' + JPEG_Q[prefs.quality]);
        var blob = await renderJPEG(src, p, { quality: JPEG_Q[prefs.quality], exif: await readExif(it.file), signal: signal, onProgress: function (f) { progress(f * 0.95); } });
        return store.keepBlob(blob, stem(it.name) + '_fixed.jpg', 'image/jpeg');
      } finally { closeSrc(src); }
    }
  };
}
function videoTask(it) {
  var locked = it.lock ? computeParams(it.lock.analysis, prefs.settings, it.lock.pick ? it.lock.pick.rgb : null) : null;
  var settings = Object.assign({}, prefs.settings), quality = prefs.quality;
  return {
    it: it,
    run: async function (progress, signal) {
      var V = await loadVideo(), sub = '';
      return V.exportVideo(it.file, {
        settings: settings, locked: locked, quality: quality, name: stem(it.name) + '_fixed.mp4', signal: signal,
        onStart: function (o) {
          sub = o.width + '×' + o.height + ' · ' + Math.round(o.fps * 100) / 100 + ' FPS → ' + codecLabel(o.codec) + ' ' + Math.round(o.bitrate / 1e6) + ' Mb/s' +
            (o.width !== o.srcWidth ? ' (device limit)' : '') + (o.gpu ? '' : ' · CPU');
          progress(0, sub);
        },
        onProgress: function (f) { progress(f, sub); }
      });
    }
  };
}
function frameTask(it, params) {
  return {
    it: it,
    run: async function (progress, signal) {
      var clip = await openClip(it), v = clip.info;
      var c = document.createElement('canvas'); c.width = v.width; c.height = v.height;
      try {
        await clip.draw(it.time, c.getContext('2d'));
        progress(0, v.width + '×' + v.height + ' · JPEG ' + JPEG_Q[prefs.quality]);
        var blob = await renderJPEG(c, params, { quality: JPEG_Q[prefs.quality], signal: signal, onProgress: function (f) { progress(f * 0.95); } });
        return store.keepBlob(blob, stem(it.name) + '_' + stamp(it.time - v.start) + '_fixed.jpg', 'image/jpeg');
      } finally { c.width = c.height = 0; }
    }
  };
}

$('saveBtn').onclick = function () {
  var it = cur(); if (!it || S.job || !S.params) return;
  runJob([it.kind === 'video' ? videoTask(it) : photoTask(it, S.params)]);
};
$('frameBtn').onclick = function () {
  var it = cur(); if (!it || S.job || !S.params || it.kind !== 'video') return;
  runJob([frameTask(it, S.params)]);
};
$('allBtn').onclick = function () {
  if (S.job || !S.items.length) return;
  runJob(S.items.map(function (it) {
    if (it.kind === 'video') return videoTask(it);
    return photoTask(it, it === cur() ? S.params : null);
  }));
};
$('lutBtn').onclick = function () {
  var it = cur(); if (!it || !S.params || S.job) return;
  var text = makeCube(S.params, 33, stem(it.name) + ' underwater fix');
  var file = new File([text], stem(it.name) + '_underwater.cube', { type: 'text/plain' });
  var done = function () { toast('LUT exported. Use it on clips from the same dive and depth.'); };
  if (store.folderName()) store.saveToFolder([file]).then(done, function (e) { toast(errMsg(e)); });
  else if (coarse && store.canShareFiles([file])) store.shareFiles([file]).then(function (ok) { if (ok) done(); }, function () { store.downloadFiles([file]).then(done); });
  else store.downloadFiles([file]).then(done);
};

/* ---------- Running exports ---------- */
var wake = null;
function keepAwake(on) {
  if (on && 'wakeLock' in navigator && document.visibilityState === 'visible') {
    navigator.wakeLock.request('screen').then(function (w) { wake = w; }, function () {});
  } else if (!on && wake) { wake.release().catch(function () {}); wake = null; }
}
document.addEventListener('visibilitychange', function () { if (S.job && document.visibilityState === 'visible') keepAwake(true); });
window.addEventListener('beforeunload', function (e) { if (S.job) { e.preventDefault(); e.returnValue = ''; } });

function setBusyUI(on) {
  $('editor').classList.toggle('busy', on);
  ['saveBtn', 'frameBtn', 'allBtn', 'lutBtn', 'removeBtn'].forEach(function (id) { $(id).disabled = on; });
  if (!on) updateKindUI();
}

async function runJob(tasks) {
  if (S.job) return;
  var ctl = new AbortController(), files = [], failed = [], saved = 0;
  var toFolder = !!store.folderName();
  if (toFolder) { try { await store.ensureFolderPermission(); } catch (e) { toFolder = false; } }
  S.job = { ctl: ctl };
  closeSheet(); setBusyUI(true); keepAwake(true);
  $('job').hidden = false; $('cancelBtn').disabled = false;
  var n = tasks.length;
  for (var i = 0; i < n; i++) {
    if (ctl.signal.aborted) break;
    var t = tasks[i], start = performance.now(), sub = '';
    $('jobTitle').textContent = (n > 1 ? (i + 1) + '/' + n + ' — ' : 'EXPORTING — ') + t.it.name;
    var progress = (function (i) {
      return function (f, s) {
        if (s != null) sub = s;
        f = clamp(f || 0, 0, 1);
        var all = (i + f) / n, el = (performance.now() - start) / 1000, left = f > 0.02 ? el / f * (1 - f) : null;
        $('jobPct').textContent = Math.floor(all * 100) + '%';
        $('jobBar').style.width = (all * 100) + '%';
        $('jobSub').textContent = [sub, left != null && el > 3 ? fmtTime(left) + ' LEFT' : ''].filter(Boolean).join(' · ');
      };
    })(i);
    progress(0, '');
    try {
      var f = await t.run(progress, ctl.signal);
      if (toFolder) { await store.saveToFolder([f]); saved++; } else files.push(f);
      t.it.done = true; refreshThumbs();
    } catch (e) {
      if (ctl.signal.aborted || (e && e.name === 'AbortError')) break;
      console.error(e);
      failed.push(t.it.name + ': ' + errMsg(e));
    }
  }
  S.job = null; $('job').hidden = true; setBusyUI(false); keepAwake(false);
  if (saved) toast('Saved ' + saved + ' file' + (saved > 1 ? 's' : '') + ' to “' + store.folderName() + '”.' + (failed.length ? ' ' + failed.join(' · ') : ''));
  if (files.length) offer(files, failed);
  else if (failed.length && !saved) toast(failed.join(' · '));
  else if (ctl.signal.aborted && !saved) toast('Canceled.');
  if (S.items.length && !S.prevOrig && cur()) select(S.cur);
}
$('cancelBtn').onclick = function () { if (S.job) { S.job.ctl.abort(); $('cancelBtn').disabled = true; $('jobTitle').textContent = 'CANCELING'; } };

/* ---------- Saving ---------- */
function offer(files, failed) {
  S.offered = files;
  var size = files.reduce(function (a, f) { return a + f.size; }, 0);
  var share = store.canShareFiles(files), mobile = isIOS || coarse;
  $('sheetTitle').textContent = files.length === 1 ? files[0].name : files.length + ' FILES READY';
  var sub = [fmtBytes(size)];
  if (failed && failed.length) sub.push(failed.length + ' failed — ' + failed.join(' · '));
  if (share && isIOS) sub.push('In the share sheet, choose “Save Image” / “Save Video” to put them in Photos');
  $('sheetSub').textContent = sub.join(' · ');
  var btns = $('sheetBtns'); btns.innerHTML = '';
  var add = function (label, fn, primary) {
    var b = document.createElement('button'); b.type = 'button'; b.className = 'btn' + (primary ? ' primary' : ''); b.textContent = label;
    b.onclick = function () { fn().catch(function (e) { if (!e || e.name !== 'AbortError') toast(errMsg(e)); }); };
    btns.appendChild(b); return b;
  };
  var first = null;
  if (share && mobile) first = add('SAVE / SHARE', function () { return store.shareFiles(files).then(function (ok) { if (ok) closeSheet(); }); }, true);
  var dl = add('DOWNLOAD', function () { return store.downloadFiles(files).then(closeSheet); }, !first);
  first = first || dl;
  if (share && !mobile) add('SHARE', function () { return store.shareFiles(files).then(function (ok) { if (ok) closeSheet(); }); });
  if (store.canPickFolder) add('SAVE TO FOLDER…', function () {
    return store.pickFolder().then(function () { updateFolderUI(); return store.saveToFolder(files); }).then(function () {
      toast('Saved to “' + store.folderName() + '”. Next exports go there directly.'); closeSheet();
    });
  });
  $('sheet').hidden = false;
  first.focus({ preventScroll: true });
}
function closeSheet() { $('sheet').hidden = true; S.offered = null; }
$('sheetClose').onclick = closeSheet;

function updateFolderUI() {
  var name = store.folderName();
  $('folderName').textContent = name ? '“' + name + '”' : 'ASK EACH TIME';
  $('folderBtn').textContent = name ? 'RESET' : 'CHOOSE FOLDER';
}
$('folderBtn').onclick = function () {
  if (store.folderName()) { store.forgetFolder(); updateFolderUI(); return; }
  store.pickFolder().then(updateFolderUI, function (e) { if (!e || e.name !== 'AbortError') toast(errMsg(e)); });
};
updateFolderUI();

document.addEventListener('keydown', function (e) {
  if (e.key !== 'Escape') return;
  if (!$('sheet').hidden) closeSheet();
  else if (S.picking) { S.picking = false; updateModeUI(); }
});

var toastTimer = 0;
function toast(msg) {
  var t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, Math.min(9000, 3000 + msg.length * 40));
}

$('drop').addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); } });
document.querySelector('.mark').addEventListener('click', function (e) {
  if (S.items.length && !confirm('Start over? Files you haven’t saved will be cleared.')) e.preventDefault();
});

/* ---------- Install, offline, updates, launching with files ---------- */
var deferredInstall = null;
window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferredInstall = e; $('installBtn').hidden = false; });
window.addEventListener('appinstalled', function () { $('installBtn').hidden = true; });
$('installBtn').onclick = function () {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  deferredInstall = null; $('installBtn').hidden = true;
};
var standalone = navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
if (isIOS && !standalone) $('iosTip').hidden = false;

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  var reloading = false, wantUpdate = false;
  navigator.serviceWorker.addEventListener('controllerchange', function () {
    $('offline').hidden = false;
    if (wantUpdate && !reloading) { reloading = true; location.reload(); }
  });
  if (navigator.serviceWorker.controller) $('offline').hidden = false;
  navigator.serviceWorker.register('sw.js').then(function (reg) {
    var offerUpdate = function (w) {
      if (!w || !navigator.serviceWorker.controller) return;
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
  }).catch(function () {});
}

// Desktop: "Open with UW Color" from the file manager
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(function (params) {
    if (!params.files || !params.files.length) return;
    Promise.all(params.files.map(function (h) { return h.getFile(); })).then(addFiles);
  });
}
// Android: shared from the gallery / GoPro Quik (the service worker stashed the files)
if (/[?&]share-target\b/.test(location.search) && window.caches) {
  history.replaceState(null, '', location.pathname);
  caches.open('uw-share').then(function (c) {
    return c.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return c.match(k).then(function (r) {
          return r.blob().then(function (b) {
            var name = decodeURIComponent(r.headers.get('x-name') || 'shared');
            return new File([b], name, { type: b.type || r.headers.get('content-type') || '' });
          });
        });
      })).then(function (files) {
        if (files.length) addFiles(files);
        return Promise.all(keys.map(function (k) { return c.delete(k); }));
      });
    });
  }).catch(function () { toast('Couldn’t open the shared files.'); });
}

store.clearExports();
syncQuality();
