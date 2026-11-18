'use strict';
/* ===== helpers ===== */
const $ = s => document.querySelector(s);
const AD = '٠١٢٣٤٥٦٧٨٩';   // Kurdish (Arabic-Indic) digits
const fa = n => String(n).replace(/\d/g, d => AD[d]);
const KMONTHS = ['کانوونی دووەم', 'شوبات', 'ئازار', 'نیسان', 'ئایار', 'حوزەیران', 'تەمووز', 'ئاب', 'ئەیلوول', 'تشرینی یەکەم', 'تشرینی دووەم', 'کانوونی یەکەم'];
const KDAYS = ['یەکشەممە', 'دووشەممە', 'سێشەممە', 'چوارشەممە', 'پێنجشەممە', 'هەینی', 'شەممە'];
const kdate = (ts, wd) => { const d = new Date(ts); return (wd ? KDAYS[d.getDay()] + '، ' : '') + fa(d.getDate()) + 'ی ' + KMONTHS[d.getMonth()] + ' ' + fa(d.getFullYear()); };
const COLL = ['ckb', 'ar'];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ic = n => `<svg class="i"><use href="#i-${n}"/></svg>`;
const DEFAULT_FOLDER = 'فایلە جیاکان';
const LEGACY_FOLDER = 'فایل‌های جداگانه';
const SILENT = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=';
const audio = $('#audio');

function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.h);
  if (ms) toast.h = setTimeout(() => t.classList.remove('show'), ms);
}
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const fmt = s => { if (!isFinite(s)) return '٠:٠٠'; s = Math.floor(s); return fa(Math.floor(s / 60)) + ':' + String(s % 60).padStart(2, '0').replace(/\d/g, d => fa(d)); };

/* ===== themes: day / night / straw ===== */
const THEMES = { day: ['ڕۆژ', '#eef3f9', 'sun'], night: ['شەو', '#131d36', 'moon'], straw: ['ڕەنگی کا', '#f2e7cc', 'leaf'] };
let theme = document.documentElement.dataset.theme in THEMES ? document.documentElement.dataset.theme : 'night';
function applyTheme(n) {
  theme = n; document.documentElement.dataset.theme = n; save('mp_theme', n);
  const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = THEMES[n][1];
  $('#themeBtn').innerHTML = ic(THEMES[n][2]);
}
function themeSheet() {
  openSheet('ڕووکار', Object.keys(THEMES).map(k => ({ label: (k === theme ? '✓  ' : '') + THEMES[k][0], fn: () => applyTheme(k) })));
}

/* ===== IndexedDB (tracks meta + blobs) ===== */
let db;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('musicpwa', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('tracks', { keyPath: 'id' }); r.result.createObjectStore('blobs'); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const tx = (stores, mode, fn) => new Promise((res, rej) => {
  const t = db.transaction(stores, mode);
  const out = fn(t);
  t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
  t.onerror = t.onabort = () => rej(t.error);
});
const getBlob = id => tx('blobs', 'readonly', t => t.objectStore('blobs').get(id));
const putTrack = (meta, blob) => tx(['tracks', 'blobs'], 'readwrite', t => { t.objectStore('tracks').put(meta); t.objectStore('blobs').put(blob, meta.id); });
const delTrackDB = id => tx(['tracks', 'blobs'], 'readwrite', t => { t.objectStore('tracks').delete(id); t.objectStore('blobs').delete(id); });
const clearDB = () => tx(['tracks', 'blobs'], 'readwrite', t => { t.objectStore('tracks').clear(); t.objectStore('blobs').clear(); });

/* ===== state ===== */
let tracks = [], byId = new Map();
let favs = new Set(load('mp_favs', []));
let lists = load('mp_lists', []);            // [{id,name,ids:[]}]
let tab = 'home', sub = null;                 // sub: {type:'folder'|'list', key}
let curList = [], folderKeys = [], listKeys = [];
let queue = [], orig = [], qi = -1, shuffle = load('mp_shuffle', false), repeat = load('mp_repeat', 0);
let curUrl = null, errStreak = 0, coverShown = null;

const saveFavs = () => save('mp_favs', [...favs]);
const saveLists = () => save('mp_lists', lists);
const cur = () => byId.get(queue[qi]);
const sortedAll = () => tracks.slice().sort((a, b) => a.title.localeCompare(b.title, COLL)).map(t => t.id);

/* ===== covers: embedded art, or a generated one ===== */
const coverUrls = new Map();
function coverUrl(t) {
  if (!t.cover) return null;
  if (!coverUrls.has(t.id)) coverUrls.set(t.id, URL.createObjectURL(t.cover));
  return coverUrls.get(t.id);
}
function hue(s) { let h = 7; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; }
function cv(t, cls) {
  const u = coverUrl(t);
  if (u) return `<div class="cv ${cls}" style="background-image:url(${u})"></div>`;
  const ch = [...(t.title || '♪')][0] || '♪';
  return `<div class="cv gen ${cls}" style="--h:${hue(t.title + t.artist)}"><span>${esc(ch)}</span></div>`;
}

/* ===== ID3 tags (title / artist / album / cover) ===== */
function decodeText(b) {
  if (!b.length) return '';
  const enc = b[0]; let d = b.subarray(1), label = 'iso-8859-1';
  if (enc === 1) {
    if (d[0] === 0xFF && d[1] === 0xFE) { label = 'utf-16le'; d = d.subarray(2); }
    else if (d[0] === 0xFE && d[1] === 0xFF) { label = 'utf-16be'; d = d.subarray(2); }
    else label = 'utf-16le';
  } else if (enc === 2) label = 'utf-16be';
  else if (enc === 3) label = 'utf-8';
  return new TextDecoder(label).decode(d).replace(/\0+$/g, '').replace(/\0.*$/, '').trim();
}
function parseApic(b) {
  const enc = b[0]; let i = 1;
  while (i < b.length && b[i] !== 0) i++;
  i++;
  const type = b[i++];
  if (enc === 0 || enc === 3) { while (i < b.length && b[i] !== 0) i++; i++; }
  else { while (i + 1 < b.length && !(b[i] === 0 && b[i + 1] === 0)) i += 2; i += 2; }
  const d = b.subarray(i);
  if (d.length < 100 || d.length > 3 * 1048576) return null;
  const mime = d[0] === 0xFF && d[1] === 0xD8 ? 'image/jpeg' : (d[0] === 0x89 && d[1] === 0x50 ? 'image/png' : null);
  if (!mime) return null;
  return { type, blob: new Blob([d.slice()], { type: mime }) };
}
async function readTags(file) {
  try {
    const h = new DataView(await file.slice(0, 10).arrayBuffer());
    if (h.byteLength < 10 || h.getUint8(0) !== 0x49 || h.getUint8(1) !== 0x44 || h.getUint8(2) !== 0x33) return {};
    const ver = h.getUint8(3);
    if (ver < 3) return {};
    const ss = (v, o) => ((v.getUint8(o) & 127) << 21) | ((v.getUint8(o + 1) & 127) << 14) | ((v.getUint8(o + 2) & 127) << 7) | (v.getUint8(o + 3) & 127);
    const tagEnd = 10 + ss(h, 6);
    const buf = await file.slice(0, Math.min(tagEnd, 6 * 1048576)).arrayBuffer();
    const v = new DataView(buf), end = buf.byteLength;
    let p = 10;
    if (v.getUint8(5) & 0x40) p += ver === 4 ? ss(v, p) : v.getUint32(p) + 4;
    const out = {};
    while (p + 10 <= end) {
      const id = String.fromCharCode(v.getUint8(p), v.getUint8(p + 1), v.getUint8(p + 2), v.getUint8(p + 3));
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const fs = ver === 4 ? ss(v, p + 4) : v.getUint32(p + 4);
      if (fs <= 0 || p + 10 + fs > end) break;
      const body = new Uint8Array(buf, p + 10, fs);
      if (id === 'TIT2' || id === 'TPE1' || id === 'TALB') out[id] = decodeText(body);
      else if (id === 'APIC') { const c = parseApic(body); if (c && (c.type === 3 || !out.cover)) out.cover = c.blob; }
      p += 10 + fs;
    }
    return { title: out.TIT2, artist: out.TPE1, album: out.TALB, cover: out.cover };
  } catch { return {}; }
}

/* ===== import ===== */
const isAudio = f => (f.type && f.type.startsWith('audio/')) || /\.(mp3|m4a|aac|wav|flac|ogg|oga|opus|aif|aiff|caf)$/i.test(f.name);
async function importFiles(fileList) {
  const files = [...fileList].filter(isAudio);
  if (!files.length) { toast('هیچ فایلێکی مۆسیقا نەدۆزرایەوە'); return; }
  let added = 0, dup = 0, fail = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    toast(`زیادکردنی ${fa(i + 1)} لە ${fa(files.length)} …`, 0);
    const parts = (f.webkitRelativePath || '').split('/').filter(Boolean);
    const folder = parts.length > 1 ? parts.slice(0, -1).join(' / ') : DEFAULT_FOLDER;
    const id = folder + '|' + f.name + '|' + f.size;
    if (byId.has(id)) { dup++; continue; }
    const tags = await readTags(f);
    const base = f.name.replace(/\.[^.]+$/, '');
    let title = tags.title, artist = tags.artist;
    if (!title) {
      const m = base.match(/^(.+?)\s+-\s+(.+)$/);
      if (m) { artist = artist || m[1].trim(); title = m[2].trim(); } else title = base;
    }
    const meta = { id, name: f.name, title, artist: artist || '', album: tags.album || '', folder, size: f.size, added: Date.now(), cover: tags.cover || null };
    try { await putTrack(meta, f); tracks.push(meta); byId.set(id, meta); added++; }
    catch (e) { fail++; if (e && /quota/i.test(e.name || e.message || '')) { toast('شوێنی هەڵگرتن پڕ بوو'); break; } }
    if (i % 5 === 4) await new Promise(r => setTimeout(r));
  }
  fillDurations();
  toast(`${fa(added)} گۆرانی زیادکرا` + (dup ? ` · ${fa(dup)} دووبارە` : '') + (fail ? ` · ${fa(fail)} سەرنەکەوت` : ''), 3500);
  render();
}

/* ===== playback ===== */
function shuffleQueue(first) {
  for (let i = queue.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [queue[i], queue[j]] = [queue[j], queue[i]]; }
  const k = queue.indexOf(first);
  if (k > 0) { queue.splice(k, 1); queue.unshift(first); }
  qi = queue.length ? 0 : -1;
}
function playList(ids, startId) {
  if (!ids.length) return;
  orig = ids.slice(); queue = orig.slice();
  startId = startId ?? queue[0];
  if (shuffle) shuffleQueue(startId); else qi = queue.indexOf(startId);
  errStreak = 0;
  loadCurrent(true);
}
async function loadCurrent(autoplay) {
  const t = cur(); if (!t) return;
  let blob;
  try { blob = await getBlob(t.id); } catch {}
  if (cur() !== t) return;
  if (!blob) { toast('فایلەکە نەدۆزرایەوە'); return next(true); }
  if (curUrl) URL.revokeObjectURL(curUrl);
  curUrl = URL.createObjectURL(blob);
  audio.src = curUrl;
  setProg(0); $('#tCur').textContent = fmt(0); $('#tDur').textContent = t.dur > 0 ? fmt(t.dur) : fmt(0);
  save('mp_last', t.id);
  updateUI(); setSession(t);
  if (autoplay) audio.play().catch(() => {});
}
function next(auto) {
  if (!queue.length) return;
  if (auto && repeat === 2) { audio.currentTime = 0; audio.play().catch(() => {}); return; }
  if (qi + 1 < queue.length) qi++;
  else if (repeat === 1 || !auto) qi = 0;
  else { audio.pause(); audio.currentTime = 0; updateUI(); return; }
  loadCurrent(true);
}
function prev() {
  if (!queue.length) return;
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  qi = qi > 0 ? qi - 1 : queue.length - 1;
  loadCurrent(true);
}
function togglePlay() {
  if (qi < 0) { const ids = sortedAll(); if (ids.length) playList(ids, ids[0]); return; }
  if (!audio.src || audio.src === SILENT) return loadCurrent(true);
  audio.paused ? audio.play().catch(() => {}) : audio.pause();
}
function toggleShuffle() {
  shuffle = !shuffle; save('mp_shuffle', shuffle);
  const c = queue[qi];
  if (shuffle) shuffleQueue(c); else { queue = orig.slice(); qi = queue.indexOf(c); }
  updateUI();
}
function toggleRepeat() { repeat = (repeat + 1) % 3; save('mp_repeat', repeat); updateUI(); }

function setProg(v) {
  ['#seek', '#miniSeek'].forEach(s => { const e = $(s); e.value = v; e.style.setProperty('--p', (v / 10) + '%'); });
}
audio.addEventListener('ended', () => next(true));
audio.addEventListener('play', updateUI);
audio.addEventListener('pause', updateUI);
audio.addEventListener('error', () => {
  if (!audio.src || audio.src === SILENT || !cur()) return;
  toast('ئەم فۆرماتە لەسەر ئەم ئامێرە لێنادرێت');
  if (++errStreak < queue.length) setTimeout(() => next(true), 800);
});
audio.addEventListener('loadedmetadata', () => { $('#tDur').textContent = fmt(audio.duration); });
let lastPos = 0;
audio.addEventListener('timeupdate', () => {
  if (audio.duration) setProg((audio.currentTime / audio.duration) * 1000);
  $('#tCur').textContent = fmt(audio.currentTime);
  if (Date.now() - lastPos > 1000 && 'mediaSession' in navigator && audio.duration) {
    lastPos = Date.now();
    try { navigator.mediaSession.setPositionState({ duration: audio.duration, position: audio.currentTime, playbackRate: audio.playbackRate }); } catch {}
  }
});
audio.addEventListener('playing', () => { errStreak = 0; });
['#seek', '#miniSeek'].forEach(s => $(s).addEventListener('input', e => {
  setProg(e.target.value);
  if (audio.duration) audio.currentTime = (e.target.value / 1000) * audio.duration;
}));

// iOS: unlock audio on the first touch so later programmatic play() works
function unlock() {
  if (audio.src) return;
  audio.src = SILENT;
  audio.play().then(() => { if (audio.src === SILENT) audio.pause(); }).catch(() => {});
}
['touchend', 'click'].forEach(e => document.addEventListener(e, unlock, { passive: true }));

function setSession(t) {
  if (!('mediaSession' in navigator)) return;
  const u = coverUrl(t);
  navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist || 'نەناسراو', album: t.album || t.folder, artwork: u ? [{ src: u, sizes: '512x512', type: t.cover.type }] : [] });
  const h = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch {} };
  h('play', () => audio.play()); h('pause', () => audio.pause());
  h('previoustrack', prev); h('nexttrack', () => next(false));
  h('seekto', d => { if (d.seekTime != null) audio.currentTime = d.seekTime; });
}

/* ===== favourites / playlists ===== */
function toggleFav(id) {
  favs.has(id) ? favs.delete(id) : favs.add(id);
  saveFavs(); render(); updateUI();
}
function promptName(title, cb, val = '') {
  const box = $('#sheetBox');
  box.innerHTML = `<h3>${esc(title)}</h3><input type="text" id="nameIn" placeholder="ناوی لیست" value="${esc(val)}"><button class="opt primary" id="nameOk">باشە</button>`;
  $('#sheet').classList.remove('hidden');
  const ok = () => { const v = $('#nameIn').value.trim(); if (!v) return; closeSheet(); cb(v); };
  $('#nameOk').onclick = ok;
  $('#nameIn').addEventListener('keydown', e => { if (e.key === 'Enter') ok(); });
  setTimeout(() => $('#nameIn').focus(), 50);
}
function newList(name, firstId) {
  const l = { id: 'l' + Date.now(), name, ids: firstId ? [firstId] : [] };
  lists.push(l); saveLists(); render();
  return l;
}
function addToList(l, id) {
  if (l.ids.includes(id)) { toast('پێشتر لەم لیستەدا بووە'); return; }
  l.ids.push(id); saveLists(); toast('زیادکرا بۆ «' + l.name + '»'); render();
}
function pickList(id) {
  openSheet('زیادکردن بۆ لیستی لێدان', [
    { label: '＋ لیستی لێدانی نوێ', fn: () => promptName('لیستی لێدانی نوێ', n => { newList(n, id); toast('لیستی لێدان دروستکرا'); }) },
    ...lists.map(l => ({ label: `${l.name} (${fa(l.ids.length)})`, fn: () => addToList(l, id) }))
  ]);
}
function trackMenu(id) {
  const t = byId.get(id); if (!t) return;
  const items = [
    { label: favs.has(id) ? 'لادان لە دڵخوازەکان' : 'زیادکردن بۆ دڵخوازەکان', fn: () => toggleFav(id) },
    { label: 'زیادکردن بۆ لیستی لێدان', fn: () => pickList(id) }
  ];
  if (sub && sub.type === 'list') {
    const l = lists.find(x => x.id === sub.key);
    if (l) items.push({ label: 'لادان لەم لیستە', fn: () => { l.ids = l.ids.filter(x => x !== id); saveLists(); render(); } });
  }
  items.push({ label: 'سڕینەوە لە کتێبخانە', cls: 'danger', fn: () => { if (confirm('ئەم گۆرانییە لە بەرنامەکە بسڕدرێتەوە؟')) removeTrack(id); } });
  openSheet(t.title, items, `<div class="hint">زیادکرا لە ${kdate(t.added)}</div>`);
}
async function removeTrack(id) {
  const curId = queue[qi], wasCur = curId === id;
  tracks = tracks.filter(t => t.id !== id); byId.delete(id);
  favs.delete(id); saveFavs();
  lists.forEach(l => l.ids = l.ids.filter(x => x !== id)); saveLists();
  queue = queue.filter(x => x !== id); orig = orig.filter(x => x !== id);
  try { await delTrackDB(id); } catch {}
  if (wasCur) { audio.pause(); audio.removeAttribute('src'); qi = -1; $('#full').classList.add('hidden'); if (queue.length) { qi = 0; loadCurrent(true); } }
  else qi = queue.indexOf(curId);
  render(); updateUI();
}

/* ===== sheet ===== */
function openSheet(title, items, extra = '') {
  const box = $('#sheetBox');
  box.innerHTML = `<h3>${esc(title)}</h3>${extra}`;
  items.forEach(it => {
    const b = document.createElement('button');
    b.className = 'opt ' + (it.cls || ''); b.textContent = it.label;
    b.onclick = () => { closeSheet(); it.fn(); };
    box.appendChild(b);
  });
  $('#sheet').classList.remove('hidden');
}
function closeSheet() { $('#sheet').classList.add('hidden'); }
$('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') closeSheet(); });

async function addSheet() {
  let usage = '';
  try { const e = await navigator.storage.estimate(); usage = `شوێنی بەکارهاتوو: ${fa((e.usage / 1048576).toFixed(0))} مێگابایت<br>`; } catch {}
  openSheet('زیادکردنی مۆسیقا', [
    { label: 'هەڵبژاردنی فایلەکانی مۆسیقا', fn: () => $('#fileInput').click() },
    { label: 'هەڵبژاردنی بوخچە', fn: () => $('#dirInput').click() },
    ...(tracks.length ? [{ label: 'سڕینەوەی هەموو گۆرانییەکان لە بەرنامەکە', cls: 'danger', fn: async () => {
      if (!confirm('هەموو گۆرانییەکان لە بەرنامەکە بسڕدرێنەوە؟ (لیستەکانی لێدان بەتاڵ دەبن)')) return;
      audio.pause(); audio.removeAttribute('src'); queue = []; orig = []; qi = -1; $('#full').classList.add('hidden');
      await clearDB(); tracks = []; byId.clear(); favs.clear(); lists.forEach(l => l.ids = []);
      saveFavs(); saveLists(); render(); updateUI(); toast('کتێبخانە بەتاڵ بوو');
    } }] : [])
  ], `<div class="hint">${usage}ئایفۆن ڕێگە بە وێبئەپەکان نادات خۆکارانە بەدوای مۆسیقادا لە مۆبایلەکەدا بگەڕێن؛ بوخچە یان فایلەکان لە «Files» هەڵبژێرە. مۆسیقاکان لە ناو خودی بەرنامەکەدا هەڵدەگیرێن و بەبێ ئینتەرنێت لێدەدرێن.</div>`);
}
$('#btnAdd').onclick = addSheet;
$('#themeBtn').onclick = themeSheet;
$('#fileInput').onchange = e => { importFiles(e.target.files); e.target.value = ''; };
$('#dirInput').onchange = e => { importFiles(e.target.files); e.target.value = ''; };

/* ===== rendering ===== */
const PAGES = ['home', 'all', 'folders', 'lists', 'fav'];
const PAGE_TITLE = { home: 'مۆسیقاکەم', all: 'هەموو گۆرانییەکان', folders: 'بوخچەکان', lists: 'لیستەکانی لێدان', fav: 'دڵخوازەکان' };
let viewMode = load('mp_view', 'list');   // list | grid | frame
let recentIds = [];

function itemHTML(id, i) {
  const t = byId.get(id); if (!t) return '';
  const isCur = queue[qi] === id, fav = favs.has(id), c = isCur ? ' cur' : '';
  const favB = `<button class="ov r${fav ? ' on' : ''}" data-fav aria-label="دڵخواز">${ic(fav ? 'heartf' : 'heart')}</button><button class="ov l" data-more aria-label="زیاتر">${ic('more')}</button>`;
  if (viewMode === 'grid') return `<div class="gc${c}" data-i="${i}"><div class="cwrap">${cv(t, 'sq')}${favB}</div><div class="t">${esc(t.title)}</div><div class="s">${esc(t.artist || 'نەناسراو')}</div></div>`;
  if (viewMode === 'frame') return `<div class="fc${c}" data-i="${i}">${cv(t, 'fill')}<div class="shade"></div>${favB}<div class="ftxt"><div class="t">${esc(t.title)}</div><div class="s">${esc(t.artist || 'نەناسراو')}</div></div><span class="fplay">${ic('play')}</span></div>`;
  const m1 = [t.folder !== DEFAULT_FOLDER ? t.folder : '', t.dur > 0 ? fmt(t.dur) : ''].filter(Boolean).join('  •  ');
  return `<div class="row${c}" data-i="${i}">${cv(t, 'th')}<div class="meta"><div class="m1">${esc(m1 || '—')}</div><div class="t">${esc(t.title)}</div><div class="s">${esc(t.artist || 'نەناسراو')}</div></div><div class="racts"><button data-more aria-label="زیاتر">${ic('more')}</button><button data-fav class="${fav ? 'on' : ''}" aria-label="دڵخواز">${ic(fav ? 'heartf' : 'heart')}</button></div></div>`;
}
const tracksHTML = ids => `<div class="tracks ${viewMode}">${ids.map(itemHTML).join('')}</div>`;
const viewSeg = () => `<span class="seg">${[['list', 'rows', 'لیست'], ['grid', 'grid', 'تۆڕ'], ['frame', 'frame', 'چوارچێوە']].map(([m, i, n]) => `<button data-vm="${m}" class="${viewMode === m ? 'on' : ''}" aria-label="${n}">${ic(i)}</button>`).join('')}</span>`;
function actionsBar(count, extra = '') {
  return `<div class="sect"><span>${fa(count)} گۆرانی</span><span class="acts">${extra}${viewSeg()}<button data-act="shuffleall" class="ibtn" aria-label="هەڕەمەکی">${ic('shuffle')}</button><button data-act="playall" class="primary">${ic('play')} لێدان</button></span></div>`;
}
const backBtn = (name, extra = '') => `<div class="sect"><button data-back>گەڕانەوە</button><span>${esc(name)}</span><span class="acts">${extra}</span></div>`;
function emptyHTML() {
  const standalone = window.navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  return `<div class="empty"><span class="big">🎶</span>هێشتا هیچ مۆسیقایەکت زیاد نەکردووە.<br>بوخچەی مۆسیقا یان چەند فایلێک لە مۆبایلەکەتەوە هەڵبژێرە.<br><button data-act="addmusic">زیادکردنی مۆسیقا</button>${standalone ? '' : '<br><small>بۆ دامەزراندن: دوگمەی Share لە Safari ← Add to Home Screen</small>'}</div>`;
}
function homeHTML() {
  const nf = new Set(tracks.map(t => t.folder)).size;
  const T = [['all', 'note', 'هەموو گۆرانییەکان', tracks.length, 'گۆرانی'], ['folders', 'folder', 'بوخچەکان', nf, 'بوخچە'], ['lists', 'list', 'لیستەکانی لێدان', lists.length, 'لیست'], ['fav', 'heartf', 'دڵخوازەکان', [...favs].filter(id => byId.has(id)).length, 'گۆرانی']];
  let h = `<div class="today">${kdate(Date.now(), true)}</div><div class="tiles">${T.map(([k, i, n, c, u]) => `<button class="tile t-${k}" data-go="${k}"><span class="tico">${ic(i)}</span><span class="tn">${n}</span><span class="tc">${fa(c)} ${u}</span></button>`).join('')}</div>`;
  const rec = tracks.slice().sort((a, b) => b.added - a.added).slice(0, 12);
  recentIds = rec.map(t => t.id);
  if (rec.length) h += `<div class="sec-h"><b>نوێترین زیادکراوەکان</b></div><div class="strip">${rec.map((t, i) => `<div class="sc" data-r="${i}">${cv(t, 'sq')}<div class="t">${esc(t.title)}</div><div class="s">${esc(t.artist || 'نەناسراو')}</div></div>`).join('')}</div>`;
  else h += emptyHTML();
  return h;
}
function render() {
  const q = $('#q').value.trim().toLowerCase();
  const v = $('#view');
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  moveInd();
  $('#libTitle').textContent = PAGE_TITLE[tab];
  document.querySelector('.search').classList.toggle('hidden', tab === 'home');
  let html = '';
  curList = [];
  const match = t => !q || [t.title, t.artist, t.album, t.folder].join(' ').toLowerCase().includes(q);

  if (tab === 'home') html = homeHTML();
  else if (!tracks.length && tab !== 'lists') html = emptyHTML();
  else if (tab === 'all') {
    curList = sortedAll().filter(id => match(byId.get(id)));
    html = actionsBar(curList.length) + tracksHTML(curList);
  } else if (tab === 'fav') {
    curList = [...favs].reverse().filter(id => byId.has(id) && match(byId.get(id)));
    html = curList.length ? actionsBar(curList.length) + tracksHTML(curList) : '<div class="empty"><span class="big">🤍</span>هیچ گۆرانییەکی دڵخوازت نییە.<br>لەسەر ♡ ی ناو هەر گۆرانییەک دابگرە.</div>';
  } else if (tab === 'folders') {
    if (sub && sub.type === 'folder') {
      curList = sortedAll().filter(id => byId.get(id).folder === sub.key && match(byId.get(id)));
      html = backBtn(sub.key) + actionsBar(curList.length) + tracksHTML(curList);
    } else {
      const m = new Map();
      tracks.forEach(t => m.set(t.folder, (m.get(t.folder) || 0) + 1));
      folderKeys = [...m.keys()].filter(k => !q || k.toLowerCase().includes(q)).sort((a, b) => a.localeCompare(b, COLL));
      html = folderKeys.map((k, i) => `<div class="row" data-f="${i}"><div class="cv th ico">${ic('folder')}</div><div class="meta"><div class="t">${esc(k)}</div><div class="s">${fa(m.get(k))} گۆرانی</div></div></div>`).join('') || '<div class="empty">هیچ بوخچەیەک نەدۆزرایەوە</div>';
    }
  } else if (tab === 'lists') {
    const l = sub && sub.type === 'list' ? lists.find(x => x.id === sub.key) : null;
    if (l) {
      curList = l.ids.filter(id => byId.has(id) && match(byId.get(id)));
      html = backBtn(l.name, '<button data-act="renlist">ناو</button><button data-act="dellist" class="danger">سڕینەوە</button>') + actionsBar(curList.length) +
        (curList.length ? tracksHTML(curList) : '<div class="empty">ئەم لیستە بەتاڵە.<br>لە ⋯ ی ناو هەر گۆرانییەک زیادی بکە.</div>');
    } else {
      listKeys = lists.filter(x => !q || x.name.toLowerCase().includes(q));
      html = `<div class="sect"><span>${fa(lists.length)} لیست</span><span class="acts"><button class="primary" data-act="newlist">لیستی لێدانی نوێ</button></span></div>` +
        (listKeys.map((x, i) => `<div class="row" data-l="${i}"><div class="cv th ico">${ic('list')}</div><div class="meta"><div class="t">${esc(x.name)}</div><div class="s">${fa(x.ids.filter(id => byId.has(id)).length)} گۆرانی</div></div></div>`).join('') || '<div class="empty"><span class="big">📃</span>هێشتا هیچ لیستێکی لێدانت دروست نەکردووە.</div>');
    }
  }
  v.innerHTML = html;
}
const REDUCE = matchMedia('(prefers-reduced-motion: reduce)').matches;
function moveInd() {
  const b = document.querySelector('#tabs button.on'), ind = document.querySelector('#tabs .ind');
  if (!b || !ind || !b.offsetWidth) return;
  ind.style.width = b.offsetWidth + 'px';
  ind.style.transform = `translateX(${b.offsetLeft}px)`;
}
window.addEventListener('resize', moveInd);
function stagger() {
  const v = $('#view');
  v.classList.remove('enter'); void v.offsetWidth;
  v.querySelectorAll('.tile,.tracks>*,#view>.row,.sc,.sect,.empty,.sec-h').forEach((el, i) => el.style.setProperty('--n', Math.min(i, 14)));
  v.classList.add('enter');
}
let animating = false;
/* slide the current content out, run fn (re-render), slide new content in. dir 'L': new content enters from the left. */
async function transition(dir, fn) {
  const v = $('#view');
  if (REDUCE || !v.animate) { fn(); return; }
  animating = true;
  const sgn = dir === 'L' ? 1 : -1;               // old content leaves to the opposite side
  const from = parseFloat((v.style.transform.match(/-?[\d.]+/) || [0])[0]) || 0;
  try {
    await v.animate([{ transform: `translateX(${from}px)`, opacity: v.style.opacity || 1 }, { transform: `translateX(${sgn * 70}px)`, opacity: 0 }], { duration: 170, easing: 'ease-in' }).finished;
  } catch {}
  v.style.transform = ''; v.style.opacity = '';
  fn();
  $('#library').scrollTop = 0;
  stagger();
  try {
    await v.animate([{ transform: `translateX(${-sgn * 70}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 380, easing: 'cubic-bezier(.2,.9,.3,1)' }).finished;
  } catch {}
  animating = false;
}
function setTab(t, anim) {
  if (animating) return;
  if (t === tab && !sub) return;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t)); moveInd();
  transition(anim || (PAGES.indexOf(t) > PAGES.indexOf(tab) ? 'L' : 'R'), () => { tab = t; sub = null; render(); });
}
function subGo(fn, dir) { if (animating) return; transition(dir, () => { fn(); render(); }); }

function updateUI() {
  const t = cur(), playing = !audio.paused && !!t;
  $('#mini').classList.toggle('hidden', !t);
  if (t) {
    $('#miniTitle').textContent = t.title; $('#miniArtist').textContent = t.artist || 'نەناسراو';
    $('#fTitle').textContent = t.title; $('#fArtist').textContent = [t.artist || 'نەناسراو', t.album].filter(Boolean).join(' · ');
    $('#fSrc').textContent = t.folder !== DEFAULT_FOLDER ? t.folder : 'کتێبخانە';
    if (coverShown !== t.id) {
      coverShown = t.id;
      $('#miniCover').innerHTML = cv(t, 'sm');
      $('#fCover').innerHTML = cv(t, 'big');
    }
    $('#fFav').innerHTML = ic(favs.has(t.id) ? 'heartf' : 'heart');
    $('#fFav').classList.toggle('on', favs.has(t.id));
  }
  const pi = ic(playing ? 'pause' : 'play');
  $('#miniPlay').innerHTML = pi; $('#fPlay').innerHTML = pi;
  $('#btnShuffle').classList.toggle('on', shuffle);
  $('#btnRepeat').classList.toggle('on', repeat > 0);
  $('#btnRepeat').innerHTML = ic(repeat === 2 ? 'repeat1' : 'repeat');
  document.querySelectorAll('#view [data-i]').forEach(r => {
    r.classList.toggle('cur', curList[+r.dataset.i] === queue[qi]);
  });
}

/* ===== durations, filled in the background ===== */
let durBusy = false;
async function fillDurations() {
  if (durBusy) return; durBusy = true;
  let n = 0;
  for (const t of tracks.slice()) {
    if (t.dur) continue;
    const blob = await getBlob(t.id).catch(() => null);
    if (!blob) continue;
    const d = await new Promise(res => {
      const a = new Audio(), u = URL.createObjectURL(blob);
      a.preload = 'metadata';
      const done = v => { URL.revokeObjectURL(u); res(v); };
      a.onloadedmetadata = () => done(isFinite(a.duration) ? a.duration : -1);
      a.onerror = () => done(-1);
      setTimeout(() => done(-1), 4000);
      a.src = u;
    });
    t.dur = d > 0 ? d : -1;
    try { await tx('tracks', 'readwrite', s => s.objectStore('tracks').put(t)); } catch {}
    if (++n % 10 === 0) render();
  }
  if (n) render();
  durBusy = false;
}

/* ===== events ===== */
$('#tabs').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const t = b.dataset.tab;
  setTab(t, PAGES.indexOf(t) > PAGES.indexOf(tab) ? 'L' : 'R');
});
$('#q').addEventListener('input', render);
$('#view').addEventListener('click', e => {
  const vm = e.target.closest('[data-vm]');
  if (vm) { viewMode = vm.dataset.vm; save('mp_view', viewMode); render(); return; }
  const go = e.target.closest('[data-go]');
  if (go) { setTab(go.dataset.go, 'L'); return; }
  const rc = e.target.closest('[data-r]');
  if (rc) { playList(recentIds, recentIds[+rc.dataset.r]); return; }
  if (e.target.closest('[data-back]')) { subGo(() => { sub = null; }, 'R'); return; }
  const act = e.target.closest('[data-act]');
  if (act) {
    const a = act.dataset.act;
    if (a === 'addmusic') addSheet();
    else if (a === 'playall') playList(curList, curList[0]);
    else if (a === 'shuffleall') { if (!shuffle) { shuffle = true; save('mp_shuffle', true); } playList(curList, curList[Math.floor(Math.random() * curList.length)]); }
    else if (a === 'newlist') promptName('لیستی لێدانی نوێ', n => newList(n));
    else if (a === 'dellist') { const l = lists.find(x => x.id === sub.key); if (l && confirm('لیستی «' + l.name + '» بسڕدرێتەوە؟ (گۆرانییەکان ناسڕدرێنەوە)')) { lists = lists.filter(x => x !== l); saveLists(); sub = null; render(); } }
    else if (a === 'renlist') { const l = lists.find(x => x.id === sub.key); if (l) promptName('ناوی نوێ', n => { l.name = n; saveLists(); render(); }, l.name); }
    return;
  }
  const row = e.target.closest('[data-i],[data-f],[data-l]'); if (!row) return;
  if (row.dataset.f != null) { const k = folderKeys[+row.dataset.f]; subGo(() => { sub = { type: 'folder', key: k }; }, 'L'); return; }
  if (row.dataset.l != null) { const k = listKeys[+row.dataset.l].id; subGo(() => { sub = { type: 'list', key: k }; }, 'L'); return; }
  const id = curList[+row.dataset.i];
  if (e.target.closest('[data-fav]')) toggleFav(id);
  else if (e.target.closest('[data-more]')) trackMenu(id);
  else playList(curList, id);
});

/* ===== touch: swipe between pages, swipe down to close player ===== */
let sx = 0, sy = 0, stt = 0, swOK = false, drag = false;
const lib = $('#library');
function resetDrag(animate) {
  const v = $('#view');
  if (animate && v.animate && v.style.transform) {
    const from = v.style.transform;
    v.style.transform = ''; v.style.opacity = '';
    v.animate([{ transform: from }, { transform: 'none' }], { duration: 300, easing: 'cubic-bezier(.2,1.2,.4,1)' });
  } else { v.style.transform = ''; v.style.opacity = ''; }
  drag = false;
}
lib.addEventListener('touchstart', e => {
  if (e.touches.length !== 1 || animating) { swOK = false; return; }
  const t = e.touches[0]; sx = t.clientX; sy = t.clientY; stt = Date.now(); drag = false;
  swOK = !e.target.closest('input, .strip');
}, { passive: true });
lib.addEventListener('touchmove', e => {
  if (!swOK) return;
  const t = e.touches[0], dx = t.clientX - sx, dy = t.clientY - sy;
  if (!drag && Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.4) drag = true;
  if (!drag) return;
  const i = PAGES.indexOf(tab), n = i + (dx > 0 ? 1 : -1);
  const k = (n < 0 || n >= PAGES.length) ? 0.18 : 0.7;      // rubber-band at the ends
  const v = $('#view');
  v.style.transform = `translateX(${dx * k}px)`;
  v.style.opacity = String(Math.max(0.35, 1 - Math.abs(dx) / 420));
}, { passive: true });
lib.addEventListener('touchcancel', () => { if (drag) resetDrag(true); swOK = false; }, { passive: true });
lib.addEventListener('touchend', e => {
  if (!swOK) return; swOK = false;
  const t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
  const fast = Date.now() - stt < 450;
  const ok = Math.abs(dx) > (fast ? 40 : 90) && Math.abs(dx) > Math.abs(dy) * 1.5;
  // RTL: dragging to the right brings the next page (which sits on the left)
  const n = PAGES.indexOf(tab) + (dx > 0 ? 1 : -1);
  if (ok && n >= 0 && n < PAGES.length) { drag = false; setTab(PAGES[n], dx > 0 ? 'L' : 'R'); }
  else if (drag) resetDrag(true);
}, { passive: true });
let fy = 0, fx = 0, fOK = false;
$('#full').addEventListener('touchstart', e => {
  const t = e.touches[0]; fx = t.clientX; fy = t.clientY;
  fOK = e.touches.length === 1 && !e.target.closest('input') && $('.psheet').scrollTop === 0;
}, { passive: true });
$('#full').addEventListener('touchend', e => {
  if (!fOK) return; fOK = false;
  const t = e.changedTouches[0], dy = t.clientY - fy, dx = t.clientX - fx;
  if (dy > 90 && dy > Math.abs(dx) * 1.5) closeFull();
}, { passive: true });

/* ===== splash ===== */
const splash = $('#splash');
let spTimer = setTimeout(closeSplash, 5200);
function closeSplash() {
  clearTimeout(spTimer);
  splash.classList.add('out');
  setTimeout(() => splash.remove(), 500);
}
splash.addEventListener('click', e => {
  if (e.target.closest('a')) { clearTimeout(spTimer); splash.querySelector('.sp-prog').remove(); return; }
  closeSplash();
});

$('#miniPlay').onclick = togglePlay; $('#fPlay').onclick = togglePlay;
$('#miniNext').onclick = $('#fNext').onclick = () => next(false);
$('#miniPrev').onclick = $('#fPrev').onclick = prev;
function openFull() {
  const f = $('#full'); f.classList.remove('hidden');
  if (!REDUCE && f.animate) f.animate([{ transform: 'translateY(100%)' }, { transform: 'none' }], { duration: 420, easing: 'cubic-bezier(.2,.9,.3,1)' });
}
function closeFull() {
  const f = $('#full');
  if (REDUCE || !f.animate) { f.classList.add('hidden'); return; }
  f.animate([{ transform: 'none' }, { transform: 'translateY(100%)' }], { duration: 300, easing: 'cubic-bezier(.5,0,.8,.4)' }).finished.then(() => f.classList.add('hidden')).catch(() => f.classList.add('hidden'));
}
$('#miniInfo').onclick = $('#miniCover').onclick = openFull;
$('#closeFull').onclick = closeFull;
$('#btnShuffle').onclick = toggleShuffle;
$('#btnRepeat').onclick = toggleRepeat;
$('#fFav').onclick = () => { const t = cur(); if (t) toggleFav(t.id); };
$('#fAddList').onclick = () => { const t = cur(); if (t) pickList(t.id); };
$('#fMore').onclick = () => { const t = cur(); if (t) trackMenu(t.id); };

/* ===== init ===== */
(async () => {
  applyTheme(theme);
  try {
    db = await openDB();
    tracks = await tx('tracks', 'readonly', t => t.objectStore('tracks').getAll());
    tracks.forEach(t => { if (t.folder === LEGACY_FOLDER) { t.folder = DEFAULT_FOLDER; tx('tracks', 'readwrite', s => s.objectStore('tracks').put(t)).catch(() => {}); } byId.set(t.id, t); });
  } catch { toast('هەڵگرتن لەم دۆخەدا (Private) کار ناکات', 5000); }
  favs = new Set([...favs].filter(id => byId.has(id)));
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch {}
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  const last = load('mp_last', null);
  if (last && byId.has(last)) { orig = sortedAll(); queue = orig.slice(); qi = queue.indexOf(last); loadCurrent(false); }
  render(); updateUI(); stagger();
  fillDurations();
})();
