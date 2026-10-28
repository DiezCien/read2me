import { readEpub } from './epub.js';
import * as db from './db.js';
import { splitSentences, countWords, estimateSeconds, formatClock, formatLong } from './text.js';
import { SystemVoiceEngine, Reader, setupMediaSession } from './tts.js';
import { NeuralReader } from './neural-reader.js';
import { PiperSynth } from './neural-synth.js';
import { buildSegmentWav } from './audio.js';
import { VOICES, DEFAULT_VOICE, voiceById, formatMB, downloadedModels, downloadVoice, deleteVoiceModel } from './voices.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtRate = (r) => String(r).replace('.', ',') + '×';

const SPEEDS = [0.8, 1, 1.2, 1.5, 2, 2.5, 3];
const TIMERS = [['off', 'Apagado'], [15, '15 min'], [30, '30 min'], [45, '45 min'], ['chapter', 'Fin del capítulo']];
const COVER_COLORS = ['#3b4a6b', '#6b3b3b', '#3f5b4a', '#5b4a2e', '#4d3f5e', '#2f5560', '#5e3f4d'];

const ICONS = {
  play: '<path d="M8 5.5v13a1 1 0 0 0 1.5.9l10.4-6.5a1 1 0 0 0 0-1.8L9.5 4.6A1 1 0 0 0 8 5.5z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/>',
  back: '<path d="M15 6l-6 6 6 6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  lines: '<path d="M4 6h16M4 10h16M4 14h10M4 18h7"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  prev: '<path d="M6 5h2v14H6zM19 6.2v11.6a1 1 0 0 1-1.5.8L9.6 13a1.2 1.2 0 0 1 0-2l7.9-5.6a1 1 0 0 1 1.5.8z" fill="currentColor" stroke="none"/>',
  next: '<path d="M16 5h2v14h-2zM5 6.2v11.6a1 1 0 0 0 1.5.8l7.9-5.6a1.2 1.2 0 0 0 0-2L6.5 5.4A1 1 0 0 0 5 6.2z" fill="currentColor" stroke="none"/>',
  rew: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4 3.5v4h4"/>',
  fwd: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M20 3.5v4h-4"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  bookmark: '<path d="M6 3h12v18l-6-4-6 4z"/>',
  sentPrev: '<path d="M11 17l-5-5 5-5M18 17l-5-5 5-5"/>',
  sentNext: '<path d="M13 17l5-5-5-5M6 17l5-5-5-5"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
};
const icon = (name, size = 24, extra = '') =>
  `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ${extra}>${ICONS[name]}</svg>`;

/* ---------- estado ---------- */

const store = {
  get() {
    try { return JSON.parse(localStorage.getItem('read2me.settings')) || {}; } catch { return {}; }
  },
  set(patch) {
    try { localStorage.setItem('read2me.settings', JSON.stringify({ ...store.get(), ...patch })); } catch { /* sin almacenamiento */ }
  },
};

const S = {
  books: [],
  progress: new Map(),
  book: null,
  texts: null,
  ch: 0,
  chap: null, // { paras: [[sentence]], flat: [sentence], cum: [palabras acumuladas antes de cada frase] }
  rate: store.get().rate || 1,
  timer: 'off',
  timerId: null,
  playing: false,
  tab: 'chapters',
  bookmarks: [],
  engineKind: store.get().engine || 'system', // 'neural' | 'system'
  voiceId: store.get().neuralVoice || DEFAULT_VOICE,
  buffering: false,
};

const engine = new SystemVoiceEngine();
const synth = new PiperSynth();
const callbacks = {
  onSentence: (i) => onSentence(i),
  onChapterEnd: () => onChapterEnd(),
  onState: (p) => { S.playing = p; media.setPlaying(p); renderPlayState(); },
  onBuffering: (b) => { S.buffering = b; renderBuffering(); },
  onError: (err) => toast(err.message),
};

function makeReader() {
  const voice = voiceById(S.voiceId);
  const r = S.engineKind === 'neural' && voice ? new NeuralReader(synth, voice, callbacks) : new Reader(engine, callbacks);
  r.rate = S.rate;
  r.setRate?.(S.rate);
  return r;
}
let reader = makeReader();

// Cambia de motor (o de voz) conservando la frase por la que vas, sin ponerse a leer.
function applyEngine() {
  const index = reader.index;
  reader.stopSpeaking();
  reader = makeReader();
  if (S.book) reader.load(S.chap.flat, index, chapterMeta());
}

const chapterMeta = () => ({ bookId: S.book.id, ch: S.ch, paraEnd: S.chap.paraEnd });
const media = setupMediaSession({
  play: () => reader.play(),
  pause: () => reader.pause(),
  prevChapter: () => gotoChapter(S.ch - 1, S.playing),
  nextChapter: () => gotoChapter(S.ch + 1, S.playing),
  back30: () => skipSeconds(-30),
  forward30: () => skipSeconds(30),
});

/* ---------- utilidades de libro ---------- */

function buildChapter(ch) {
  const paras = S.texts.chapters[ch].map(splitSentences).filter((p) => p.length);
  const flat = paras.flat();
  const cum = [];
  let words = 0;
  for (const s of flat) { cum.push(words); words += countWords(s); }
  const paraEnd = [];
  for (const p of paras) p.forEach((_, k) => paraEnd.push(k === p.length - 1));
  return { paras, flat, cum, words, paraEnd };
}

// Tiempos del capítulo en segundos de escucha (ya divididos por la velocidad).
// Con voz neuronal son reales para lo ya preparado y estimados para el resto.
function chapterTimes() {
  if (reader.timeInfo) {
    const t = reader.timeInfo();
    return { done: t.elapsed / S.rate, total: t.total / S.rate };
  }
  return { done: estimateSeconds(S.chap.cum[reader.index] || 0, S.rate), total: estimateSeconds(S.chap.words, S.rate) };
}

const coverColor = (title) => COVER_COLORS[[...title].reduce((n, c) => n + c.charCodeAt(0), 0) % COVER_COLORS.length];

function coverHtml(book, cls = '', pct = 0) {
  const inner = book.cover
    ? `<img alt="" src="${coverUrl(book)}">`
    : `<span class="t">${esc(book.title)}</span>`;
  const bar = pct ? `<span class="prog"><i style="width:${pct}%"></i></span>` : '';
  return `<span class="cover ${cls}" style="background:${coverColor(book.title)}">${inner}${bar}</span>`;
}

const coverUrls = new Map();
function coverUrl(book) {
  if (!coverUrls.has(book.id)) coverUrls.set(book.id, URL.createObjectURL(book.cover));
  return coverUrls.get(book.id);
}

function bookPercent(book) {
  const p = S.progress.get(book.id);
  if (!p) return 0;
  const before = book.chapters.slice(0, p.chapter).reduce((n, c) => n + c.words, 0);
  const inChapter = (book.chapters[p.chapter]?.words || 0) * (p.fraction || 0);
  return Math.min(100, Math.round(((before + inChapter) / Math.max(1, book.words)) * 100));
}

function remainingSeconds(book, chapterIdx, wordsDoneInChapter) {
  const rest = book.chapters.slice(chapterIdx + 1).reduce((n, c) => n + c.words, 0);
  const cur = Math.max(0, book.chapters[chapterIdx].words - wordsDoneInChapter);
  return estimateSeconds(rest + cur, S.rate);
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 3200);
}

/* ---------- navegación ---------- */

const VIEWS = { '': 'library', '#/': 'library', '#/player': 'player', '#/text': 'text', '#/chapters': 'chapters', '#/settings': 'settings' };
let current = null;

async function route() {
  let name = VIEWS[location.hash] || 'library';
  if (name !== 'library' && name !== 'settings' && !S.book) name = 'library';
  current = name;
  for (const v of ['library', 'player', 'text', 'chapters', 'settings']) $(`#view-${v}`).hidden = v !== name;
  await render(name);
}

async function render(name) {
  if (name === 'library') await renderLibrary();
  if (name === 'player') renderPlayer();
  if (name === 'text') renderText();
  if (name === 'chapters') await renderChapters();
  if (name === 'settings') await renderSettings();
}

/* ---------- biblioteca ---------- */

async function refreshLibrary() {
  S.books = (await db.listBooks()).sort((a, b) => b.addedAt - a.addedAt);
  S.progress = new Map((await db.listProgress()).map((p) => [p.id, p]));
}

async function renderLibrary() {
  await refreshLibrary();
  const root = $('#view-library');
  const last = [...S.progress.values()]
    .filter((p) => S.books.some((b) => b.id === p.id))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const lastBook = last && S.books.find((b) => b.id === last.id);

  const resume = lastBook ? (() => {
    const pct = bookPercent(lastBook);
    const wordsDone = (lastBook.chapters[last.chapter]?.words || 0) * (last.fraction || 0);
    return `
    <button class="continue" data-open="${lastBook.id}" data-play="1" aria-label="Seguir escuchando ${esc(lastBook.title)}">
      <span class="row">
        ${coverHtml(lastBook, 'mini-cover')}
        <span class="info">
          <span class="kicker">Seguir escuchando</span>
          <span class="title">${esc(lastBook.title)}</span>
          <span class="where">${esc(lastBook.chapters[last.chapter]?.title || '')}</span>
        </span>
        <span class="play-fab">${icon('play', 22)}</span>
      </span>
      <span><span class="bar" style="display:block"><i style="width:${pct}%"></i></span>
        <span class="meta"><span>${pct} %</span><span>Quedan ${formatLong(remainingSeconds(lastBook, last.chapter, wordsDone))}</span></span></span>
    </button>`;
  })() : '';

  root.innerHTML = `
    <div class="top">
      <h1 id="t-library" class="view-library-title grow">Biblioteca</h1>
      <a class="icon-btn filled" href="#/settings" aria-label="Ajustes">${icon('gear', 22)}</a>
    </div>
    <p class="local-pill">${icon('phone', 16)} Tus libros y tu progreso están solo en este teléfono</p>
    ${resume}
    <h2 class="section-title">Tus libros</h2>
    ${S.books.length ? '' : '<p class="empty">Todavía no hay ningún libro. Añade un archivo .epub sin DRM desde tu teléfono.</p>'}
    <div class="grid">
      ${S.books.map((b) => {
        const pct = bookPercent(b);
        const label = pct >= 99 ? 'Terminado' : pct ? `${pct} %` : 'Nuevo';
        return `<button class="book" data-open="${b.id}" aria-label="${esc(b.title)}, ${esc(b.author)}, ${label}">
          ${coverHtml(b, '', pct)}
          <span><span class="author" style="display:block">${esc(b.author)}</span><span class="state">${label}</span></span>
        </button>`;
      }).join('')}
      <label class="book">
        <span class="add-book">${icon('plus', 26)}Añadir EPUB</span>
        <span class="state">Desde Archivos</span>
        <input id="file" type="file" accept=".epub,application/epub+zip" multiple hidden>
      </label>
    </div>`;

  root.querySelectorAll('[data-open]').forEach((el) =>
    el.addEventListener('click', () => openBook(el.dataset.open, { play: el.dataset.play === '1' })));
  $('#file', root).addEventListener('change', onFiles);
}

async function onFiles(e) {
  const files = [...e.target.files];
  e.target.value = '';
  for (const file of files) {
    try {
      toast(`Importando “${file.name}”…`);
      const parsed = await readEpub(await file.arrayBuffer());
      await db.saveBook(parsed);
      toast(`Añadido: ${parsed.title}`);
    } catch (err) {
      console.error(err);
      toast(`No se pudo abrir “${file.name}”: ${err.message}`);
    }
  }
  if (current === 'library') await renderLibrary();
}

/* ---------- abrir libro y capítulos ---------- */

async function openBook(id, { play = false } = {}) {
  const [book, texts, prog, marks] = await Promise.all([db.getBook(id), db.getText(id), db.getProgress(id), db.listBookmarks(id)]);
  if (!book || !texts) return toast('No se encuentra ese libro');
  reader.stopSpeaking();
  S.book = book;
  S.texts = texts;
  S.bookmarks = marks;
  await loadChapter(prog?.chapter ?? 0, prog?.sentence ?? 0);
  location.hash = '#/player';
  if (play) startPlayback();
}

async function loadChapter(ch, sentence = 0) {
  S.ch = Math.min(Math.max(0, ch), S.book.chapters.length - 1);
  S.chap = buildChapter(S.ch);
  reader.load(S.chap.flat, sentence, chapterMeta());
  media.update({
    title: S.book.chapters[S.ch].title,
    artist: S.book.author,
    album: S.book.title,
    cover: S.book.cover,
  });
  if (current === 'text') renderText();
}

async function gotoChapter(ch, keepPlaying) {
  if (ch < 0 || ch >= S.book.chapters.length) return;
  const was = keepPlaying ?? S.playing;
  reader.stopSpeaking();
  await loadChapter(ch, 0);
  if (current === 'player') renderPlayer();
  if (current === 'chapters') renderChapters();
  if (was) startPlayback();
}

async function startPlayback() {
  if (S.engineKind === 'neural') {
    const voice = voiceById(S.voiceId);
    if (!voice || !(await downloadedModels()).has(voice.model)) {
      toast('Descarga primero una voz neuronal en Ajustes');
      location.hash = '#/settings';
      return;
    }
  } else {
    await engine.ready();
  }
  reader.play();
}

function onChapterEnd() {
  if (S.timer === 'chapter') { setTimer('off'); toast('Temporizador: fin del capítulo'); return; }
  if (S.ch + 1 < S.book.chapters.length) gotoChapter(S.ch + 1, true);
  else toast('Has terminado el libro');
}

let saveTimer;
function onSentence(i) {
  if (!S.book) return;
  const frac = S.chap.words ? S.chap.cum[i] / S.chap.words : 0;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => db.saveProgress(S.book.id, S.ch, i, { fraction: frac }), 400);
  S.progress.set(S.book.id, { id: S.book.id, chapter: S.ch, sentence: i, fraction: frac, updatedAt: Date.now() });
  if (current === 'player') renderScrub();
  if (current === 'text') renderTextCursor();
}

function skipSeconds(sec) {
  const words = (Math.abs(sec) / 60) * 160 * S.rate;
  const target = S.chap.cum[reader.index] + Math.sign(sec) * words;
  let idx = S.chap.cum.findIndex((w) => w >= target);
  if (idx < 0) idx = S.chap.flat.length - 1;
  if (sec < 0 && target <= 0) idx = 0;
  reader.seek(idx);
}

/* ---------- reproductor ---------- */

function renderPlayer() {
  const b = S.book;
  const root = $('#view-player');
  root.innerHTML = `
    <div class="top">
      <a class="icon-btn" href="#/" aria-label="Volver a la biblioteca">${icon('down')}</a>
      <span class="eyebrow grow" style="text-align:center">Escuchando</span>
      <a class="icon-btn" href="#/text" aria-label="Ver el texto">${icon('lines', 22)}</a>
    </div>
    ${coverHtml(b, 'player-cover')}
    <div class="player-titles">
      <h1>${esc(b.title)}</h1>
      <a class="chapter-link" href="#/chapters"><span class="clamp">${esc(b.chapters[S.ch].title)}</span> ${icon('chevron', 16)}</a>
    </div>
    <div class="scrub">
      <input id="scrub" type="range" min="0" max="${Math.max(0, S.chap.flat.length - 1)}" value="${reader.index}" aria-label="Posición en el capítulo">
      <div class="times"><span id="t-el">0:00</span><span id="t-left">0:00</span></div>
      <div class="note buffering" aria-live="polite" style="text-align:center;min-height:16px"></div>
    </div>
    <div class="transport">
      <button class="sm" id="b-prev" aria-label="Capítulo anterior">${icon('prev', 26)}</button>
      <button class="skip" id="b-back" aria-label="Retroceder 30 segundos">${icon('rew', 34)}<span>30</span></button>
      <button class="big" id="b-play"></button>
      <button class="skip" id="b-fwd" aria-label="Avanzar 30 segundos">${icon('fwd', 34)}<span>30</span></button>
      <button class="sm" id="b-next" aria-label="Capítulo siguiente">${icon('next', 26)}</button>
    </div>
    <div class="quick">
      <button id="b-speed"><b></b>Velocidad</button>
      <button id="b-timer"></button>
      <a href="#/settings">${icon('mic', 20)}Voz</a>
      <button id="b-mark">${icon('bookmark', 20)}Marcador</button>
    </div>`;

  $('#scrub', root).addEventListener('input', (e) => { reader.seek(Number(e.target.value)); });
  $('#b-play', root).addEventListener('click', () => (S.playing ? reader.pause() : startPlayback()));
  $('#b-prev', root).addEventListener('click', () => gotoChapter(S.ch - 1));
  $('#b-next', root).addEventListener('click', () => gotoChapter(S.ch + 1));
  $('#b-back', root).addEventListener('click', () => skipSeconds(-30));
  $('#b-fwd', root).addEventListener('click', () => skipSeconds(30));
  $('#b-speed', root).addEventListener('click', cycleSpeed);
  $('#b-timer', root).addEventListener('click', cycleTimer);
  $('#b-mark', root).addEventListener('click', addBookmark);
  renderPlayState();
  renderScrub();
  renderQuick();
}

function renderPlayState() {
  const btn = $('#b-play');
  if (btn) {
    btn.innerHTML = icon(S.playing ? 'pause' : 'play', 32);
    btn.setAttribute('aria-label', S.playing ? 'Pausa' : 'Reproducir');
  }
  const mini = $('#m-play');
  if (mini) {
    mini.innerHTML = icon(S.playing ? 'pause' : 'play', 24);
    mini.setAttribute('aria-label', S.playing ? 'Pausa' : 'Reproducir');
  }
}

function renderBuffering() {
  document.querySelectorAll('.buffering').forEach((el) => {
    if (S.buffering) el.textContent = 'Preparando audio…';
    else el.textContent = el.closest('.mini') ? 'Toca cualquier frase para leer desde ahí' : '';
  });
}

function renderScrub() {
  const scrub = $('#scrub');
  if (!scrub) return;
  scrub.value = reader.index;
  const { done, total } = chapterTimes();
  $('#t-el').textContent = formatClock(done);
  $('#t-left').textContent = '−' + formatClock(total - done);
}

function renderQuick() {
  const speed = $('#b-speed b');
  if (speed) speed.textContent = fmtRate(S.rate);
  const t = $('#b-timer');
  if (t) {
    const label = S.timer === 'off' ? 'Dormir' : S.timer === 'chapter' ? 'Fin cap.' : `${S.timer} min`;
    t.className = S.timer === 'off' ? '' : 'on';
    t.innerHTML = `${icon('moon', 20)}${label}`;
  }
}

function setRate(rate) {
  S.rate = rate;
  store.set({ rate });
  reader.setRate(rate);
  renderQuick();
  renderScrub();
}

function cycleSpeed() {
  const i = SPEEDS.indexOf(S.rate);
  setRate(SPEEDS[(i + 1) % SPEEDS.length]);
}

function setTimer(value) {
  S.timer = value;
  clearTimeout(S.timerId);
  if (typeof value === 'number') {
    S.timerId = setTimeout(() => { reader.pause(); S.timer = 'off'; renderQuick(); toast('Temporizador: pausa'); }, value * 60000);
  }
  renderQuick();
}

function cycleTimer() {
  const keys = TIMERS.map((t) => t[0]);
  setTimer(keys[(keys.indexOf(S.timer) + 1) % keys.length]);
}

async function addBookmark() {
  const label = S.chap.flat[reader.index].slice(0, 80);
  await db.addBookmark({ bookId: S.book.id, chapter: S.ch, sentence: reader.index, label });
  S.bookmarks = await db.listBookmarks(S.book.id);
  toast('Marcador guardado');
}

/* ---------- texto ---------- */

let sentenceEls = [];

function renderText() {
  const b = S.book;
  const root = $('#view-text');
  let n = 0;
  const body = S.chap.paras.map((para) =>
    `<p>${para.map((s) => `<span class="s" data-i="${n++}">${esc(s)} </span>`).join('')}</p>`).join('');
  root.innerHTML = `
    <div class="top">
      <a class="icon-btn" href="#/player" aria-label="Volver al reproductor">${icon('back')}</a>
      <div class="grow"><div class="sub">${esc(b.title)}</div><div class="clamp" style="font-size:15px;font-weight:600">${esc(b.chapters[S.ch].title)}</div></div>
    </div>
    <div class="reading" id="reading">${body}</div>
    <div class="mini">
      <div class="times"><span id="t-el">0:00</span><span id="t-left">0:00</span></div>
      <div class="controls">
        <span>${fmtRate(S.rate)}</span>
        <div class="mid">
          <button id="m-prev" aria-label="Frase anterior">${icon('sentPrev', 22)}</button>
          <button id="m-play" class="play"></button>
          <button id="m-next" aria-label="Frase siguiente">${icon('sentNext', 22)}</button>
        </div>
        <span></span>
      </div>
      <small class="buffering" aria-live="polite">Toca cualquier frase para leer desde ahí</small>
    </div>`;
  sentenceEls = [...root.querySelectorAll('.s')];
  $('#reading', root).addEventListener('click', (e) => {
    const s = e.target.closest('.s');
    if (!s) return;
    reader.seek(Number(s.dataset.i));
    if (!S.playing) startPlayback();
  });
  $('#m-play', root).addEventListener('click', () => (S.playing ? reader.pause() : startPlayback()));
  $('#m-prev', root).addEventListener('click', () => reader.prev());
  $('#m-next', root).addEventListener('click', () => reader.next());
  renderPlayState();
  renderTextCursor(true);
}

function renderTextCursor(jump = false) {
  const i = reader.index;
  sentenceEls.forEach((el, k) => {
    el.classList.toggle('read', k < i);
    el.classList.toggle('now', k === i);
  });
  sentenceEls[i]?.scrollIntoView({ block: 'center', behavior: jump ? 'instant' : 'smooth' });
  const { done, total } = chapterTimes();
  const el = $('#view-text #t-el'), left = $('#view-text #t-left');
  if (el) { el.textContent = formatClock(done); left.textContent = '−' + formatClock(total - done); }
}

/* ---------- capítulos y marcadores ---------- */

async function renderChapters() {
  const b = S.book;
  const root = $('#view-chapters');
  S.bookmarks = await db.listBookmarks(b.id);
  const marks = S.tab === 'marks';
  const list = marks
    ? (S.bookmarks.length
      ? S.bookmarks.sort((a, c) => a.chapter - c.chapter || a.sentence - c.sentence).map((m) => `
        <div class="row-item">
          <button class="txt" data-mark="${m.id}" style="text-align:left">
            <span class="name">“${esc(m.label)}”</span>
            <span class="meta">${esc(b.chapters[m.chapter]?.title || '')}</span>
          </button>
          <button class="del" data-del="${m.id}" aria-label="Borrar marcador">${icon('trash', 20)}</button>
        </div>`).join('')
      : '<p class="empty">Aún no hay marcadores. Pulsa “Marcador” en el reproductor para guardar un punto.</p>')
    : b.chapters.map((c, i) => {
      const cur = i === S.ch;
      const done = i < S.ch;
      const meta = cur
        ? (() => { const t = chapterTimes(); return `${formatClock(t.done)} de ${formatClock(t.total)}${reader.preparedCount ? ` · audio ${reader.preparedCount()}/${reader.segmentCount()}` : ''}`; })()
        : `≈ ${formatLong(estimateSeconds(c.words, S.rate))}`;
      const mark = cur ? icon('play', 18, 'style="color:var(--accent)"') : done ? icon('check', 20, 'style="color:var(--muted)"') : '';
      return `<button class="row-item ${cur ? 'current' : ''} ${done ? 'done' : ''}" data-ch="${i}" ${cur ? 'aria-current="true"' : ''}>
        <span class="num">${i + 1}</span>
        <span class="txt"><span class="name">${esc(c.title)}</span><span class="meta">${meta}</span></span>${mark}
      </button>`;
    }).join('');

  root.innerHTML = `
    <div class="top">
      <a class="icon-btn" href="#/player" aria-label="Volver al reproductor">${icon('back')}</a>
      <div class="grow"><h1 id="t-chapters">Capítulos</h1><div class="sub">${esc(b.title)}</div></div>
      <button class="icon-btn" id="b-del" aria-label="Eliminar libro">${icon('trash', 20)}</button>
    </div>
    <div class="tabs" role="tablist">
      <button role="tab" aria-selected="${!marks}" data-tab="chapters">Capítulos</button>
      <button role="tab" aria-selected="${marks}" data-tab="marks">Marcadores (${S.bookmarks.length})</button>
    </div>
    <div class="list">${list}</div>`;

  root.querySelectorAll('[data-tab]').forEach((el) => el.addEventListener('click', () => { S.tab = el.dataset.tab; renderChapters(); }));
  root.querySelectorAll('[data-ch]').forEach((el) => el.addEventListener('click', async () => {
    await gotoChapter(Number(el.dataset.ch), true);
    location.hash = '#/player';
  }));
  root.querySelectorAll('[data-mark]').forEach((el) => el.addEventListener('click', async () => {
    const m = S.bookmarks.find((x) => x.id === Number(el.dataset.mark));
    reader.stopSpeaking();
    await loadChapter(m.chapter, m.sentence);
    location.hash = '#/player';
  }));
  root.querySelectorAll('[data-del]').forEach((el) => el.addEventListener('click', async () => {
    await db.removeBookmark(Number(el.dataset.del));
    renderChapters();
  }));
  $('#b-del', root).addEventListener('click', async () => {
    if (!confirm(`¿Eliminar “${S.book.title}” de este teléfono? También se borra tu progreso y tus marcadores.`)) return;
    reader.stopSpeaking();
    await db.deleteBook(S.book.id);
    await db.clearAudio(S.book.id);
    S.book = null;
    location.hash = '#/';
  });
}

/* ---------- ajustes ---------- */

async function renderSettings() {
  const root = $('#view-settings');
  await engine.ready();
  const voices = engine.voices();
  const es = voices.filter((v) => v.lang.toLowerCase().startsWith('es'));
  const rest = voices.filter((v) => !v.lang.toLowerCase().startsWith('es'));
  const chosen = engine.voice?.voiceURI;
  const opt = (v) => `<option value="${esc(v.voiceURI)}" ${v.voiceURI === chosen ? 'selected' : ''}>${esc(v.name)} · ${esc(v.lang)}${v.localService ? '' : ' (en línea)'}</option>`;

  let usage = '';
  try {
    const est = await navigator.storage.estimate();
    usage = `${(est.usage / 1048576).toFixed(1)} MB usados en este teléfono`;
  } catch { usage = ''; }
  await refreshLibrary();
  const have = await downloadedModels();
  const audio = await db.audioUsage();
  const neural = S.engineKind === 'neural';

  const voiceRows = VOICES.map((v) => {
    const ready = have.has(v.model);
    const using = S.voiceId === v.id;
    return `<div class="voice-row ${using ? 'using' : ''}">
      <span class="voice-info"><span class="voice-name">${esc(v.label)}</span><span class="note">${esc(v.note)} · ${formatMB(v.bytes)}${ready ? ' · descargada' : ''}</span></span>
      ${ready
        ? `<button class="btn small" data-use="${v.id}" ${using ? 'disabled' : ''}>${using ? 'En uso' : 'Usar'}</button>
           <button class="icon-btn" data-rm="${v.id}" aria-label="Borrar ${esc(v.label)}">${icon('trash', 18)}</button>`
        : `<button class="btn small" data-dl="${v.id}">Descargar</button>`}
    </div>`;
  }).join('');

  const voiceGroup = neural
    ? `<div class="group">
        <h2 class="eyebrow">Voz neuronal</h2>
        <div class="voice-list">${voiceRows}</div>
        <button class="btn" id="try-neural">Escuchar una muestra</button>
        <p class="note">Se descarga una vez y funciona sin conexión. Genera el audio en tu móvil, por adelantado, y se reproduce como un audio normal: por eso sigue sonando con la pantalla bloqueada. Si tu móvil es lento, elige la voz ligera.</p>
      </div>`
    : `<div class="group">
        <h2 class="eyebrow"><label for="voice">Voz del sistema</label></h2>
        <select id="voice">
          ${es.length ? `<optgroup label="Español">${es.map(opt).join('')}</optgroup>` : ''}
          ${rest.length ? `<optgroup label="Otros idiomas">${rest.map(opt).join('')}</optgroup>` : ''}
        </select>
        <button class="btn" id="try">Escuchar una muestra</button>
        <p class="note">Son las voces de tu Android, gratis y sin descarga. Con la pantalla bloqueada pueden cortarse en algunos móviles.</p>
      </div>`;

  root.innerHTML = `
    <div class="top">
      <a class="icon-btn" href="${S.book ? '#/player' : '#/'}" aria-label="Volver">${icon('back')}</a>
      <h1 id="t-settings" class="grow">Escucha</h1>
    </div>
    <div class="stack" style="margin-top:8px">
      <div class="group">
        <h2 class="eyebrow">Temporizador de apagado</h2>
        <div class="chips">
          ${TIMERS.map(([k, label]) => `<button class="chip" data-timer="${k}" aria-pressed="${String(S.timer) === String(k)}">${label}</button>`).join('')}
        </div>
      </div>
      <div class="group">
        <div class="range-head"><h2 class="eyebrow"><label for="rate">Velocidad</label></h2><b id="rate-v">${fmtRate(S.rate)}</b></div>
        <input id="rate" type="range" min="0.5" max="3" step="0.1" value="${S.rate}">
        <div class="range-foot"><span>0,5×</span><span>3×</span></div>
      </div>
      <div class="group">
        <h2 class="eyebrow">Tipo de voz</h2>
        <div class="chips">
          <button class="chip" data-engine="neural" aria-pressed="${neural}">Neuronal</button>
          <button class="chip" data-engine="system" aria-pressed="${!neural}">Del sistema</button>
        </div>
      </div>
      ${voiceGroup}
      <div class="group">
        <h2 class="eyebrow">Tus datos</h2>
        <div class="panel">
          <span style="display:flex;gap:10px;align-items:flex-start">${icon('phone', 20, 'style="flex:none;color:var(--accent)"')}Todo se guarda solo en este teléfono. No hay cuenta ni servidor.</span>
          <span class="note" style="margin:0">${esc(usage)} · ${S.books.length} libro${S.books.length === 1 ? '' : 's'}</span>
          <span class="note" style="margin:0">Audio preparado: ${formatMB(audio.bytes)} <button class="link" id="free-audio" ${audio.bytes ? '' : 'disabled'}>Liberar</button></span>
          <div class="two">
            <button class="btn" id="backup">Copia de seguridad</button>
            <label class="btn">Restaurar copia<input id="restore" type="file" accept="application/json,.json" hidden></label>
          </div>
          <span class="note">La copia guarda tu progreso y marcadores en un archivo, para pasarlos a otro móvil. Los libros hay que volver a añadirlos.</span>
        </div>
      </div>
      <div class="group">
        <h2 class="eyebrow">Acerca de</h2>
        <p class="note">Read2Me es software libre (GNU GPL v3.0). Incluye onnxruntime, Piper y espeak-ng; la voz Sharvard es CC BY 3.0 (Universidad de Edimburgo).</p>
        <div class="two">
          <a class="btn" href="https://github.com/DiezCien/read2me" target="_blank" rel="noopener">Código fuente</a>
          <a class="btn" href="THIRD-PARTY-NOTICES.md" target="_blank" rel="noopener">Créditos y licencias</a>
        </div>
      </div>
    </div>`;

  root.querySelectorAll('[data-timer]').forEach((el) => el.addEventListener('click', () => {
    const k = el.dataset.timer;
    setTimer(k === 'off' || k === 'chapter' ? k : Number(k));
    renderSettings();
  }));
  $('#rate', root).addEventListener('input', (e) => {
    const r = Math.round(Number(e.target.value) * 10) / 10;
    $('#rate-v', root).textContent = fmtRate(r);
    setRate(r);
  });
  root.querySelectorAll('[data-engine]').forEach((el) => el.addEventListener('click', () => {
    S.engineKind = el.dataset.engine;
    store.set({ engine: S.engineKind });
    applyEngine();
    renderSettings();
  }));
  $('#voice', root)?.addEventListener('change', (e) => { engine.setVoice(e.target.value); store.set({ voiceURI: e.target.value }); });
  $('#try', root)?.addEventListener('click', async () => {
    reader.pause();
    await engine.speak('Hola, así suena esta voz leyendo tu libro.', S.rate);
  });
  root.querySelectorAll('[data-dl]').forEach((el) => el.addEventListener('click', async () => {
    const voice = voiceById(el.dataset.dl);
    el.disabled = true;
    try {
      await downloadVoice(voice, (loaded, total) => { el.textContent = total ? `${Math.round((loaded / total) * 100)} %` : formatMB(loaded); });
      S.voiceId = voice.id;
      store.set({ neuralVoice: voice.id });
      applyEngine();
      toast(`Voz lista: ${voice.label}`);
    } catch (err) {
      toast(err.message || 'No se pudo descargar la voz');
    }
    renderSettings();
  }));
  root.querySelectorAll('[data-use]').forEach((el) => el.addEventListener('click', () => {
    S.voiceId = el.dataset.use;
    store.set({ neuralVoice: S.voiceId });
    applyEngine();
    renderSettings();
  }));
  root.querySelectorAll('[data-rm]').forEach((el) => el.addEventListener('click', async () => {
    const voice = voiceById(el.dataset.rm);
    if (!confirm(`¿Borrar la voz “${voice.label}” de este teléfono? Se puede volver a descargar.`)) return;
    await deleteVoiceModel(voice);
    renderSettings();
  }));
  $('#try-neural', root)?.addEventListener('click', tryNeuralVoice);
  $('#free-audio', root)?.addEventListener('click', async () => {
    reader.pause();
    await db.clearAudio();
    toast('Audio preparado eliminado');
    renderSettings();
  });
  $('#backup', root).addEventListener('click', downloadBackup);
  $('#restore', root).addEventListener('change', restoreBackup);
}

async function tryNeuralVoice() {
  const voice = voiceById(S.voiceId);
  if (!(await downloadedModels()).has(voice.model)) return toast('Descarga primero esta voz');
  reader.pause();
  toast('Preparando la muestra…');
  try {
    await synth.useVoice(voice);
    const { pcms, rate } = await synth.synth(voice, ['Hola, así suena esta voz leyendo tu libro.']).promise;
    const { wav } = buildSegmentWav(pcms, rate, [0.2]);
    const sample = new Audio(URL.createObjectURL(new Blob([wav], { type: 'audio/wav' })));
    sample.playbackRate = S.rate;
    await sample.play();
  } catch (err) {
    toast(err.message);
  }
}

async function downloadBackup() {
  const data = await db.exportBackup();
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `read2me-copia-${new Date().toISOString().slice(0, 10)}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function restoreBackup(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const n = await db.importBackup(JSON.parse(await file.text()));
    toast(n ? `Progreso restaurado en ${n} libro${n === 1 ? '' : 's'}` : 'Copia leída, pero no hay libros que coincidan: añádelos primero');
  } catch (err) {
    toast(err.message);
  }
}

/* ---------- arranque ---------- */

async function init() {
  await engine.ready();
  const saved = store.get().voiceURI;
  if (saved) engine.setVoice(saved);
  if (!engine.voice) engine.voice = engine.pickDefault('es');
  reader.rate = S.rate;
  window.addEventListener('hashchange', route);
  document.addEventListener('visibilitychange', () => { if (document.hidden && S.book) db.saveProgress(S.book.id, S.ch, reader.index, { fraction: S.chap.cum[reader.index] / (S.chap.words || 1) }); });
  await route();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();

// Para depurar y para las pruebas en el navegador.
window.__read2me = { S, get reader() { return reader; }, engine, synth, db, readEpub, openBook };
