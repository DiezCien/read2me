// Lector con voz neuronal. Mismo interfaz que Reader (tts.js), pero reproduce audio de verdad:
// el texto del capítulo se parte en trozos de ~12 s (audio.js), cada trozo se sintetiza con Piper
// en un worker, se guarda en IndexedDB y se reproduce con un <audio>. Como es audio normal, Android
// lo trata como un podcast: sigue sonando con la pantalla bloqueada y responde a los auriculares.

import * as db from './db.js';
import { planSegments, buildSegmentWav, pauseAfter, hashText } from './audio.js';
import { silentWavUrl } from './tts.js';
import { log } from './diag.js';

const LOOKAHEAD_SEGMENTS = 90; // ≈ 18 min de audio preparado por delante
const UPCOMING_SEGMENTS = 4; // primeros trozos del capítulo siguiente, para no esperar al cambiar
const CACHE_CAP_BYTES = 600 * 1048576;
const KEEP_RECORDS = 3; // trozos con su URL de audio en memoria

export class NeuralReader {
  constructor(synth, voice, { onSentence, onChapterEnd, onState, onBuffering, onError, prepare }) {
    Object.assign(this, { synth, voice, onSentence, onChapterEnd, onState, onBuffering, onError });
    this.prepare = prepare || ((t) => t); // pronunciaciones: lo que se dice puede diferir de lo que se muestra
    this.sentences = [];
    this.index = 0;
    this.rate = 1;
    this.playing = false;
    this.kind = 'neural';

    this.els = [new Audio(), new Audio()];
    this.active = 0;
    for (const el of this.els) {
      el.preservesPitch = true;
      el.preload = 'auto';
      el.addEventListener('timeupdate', () => el === this.el && this.#sync());
      el.addEventListener('ended', () => el === this.el && this.#onEnded());
      // el sistema puede pausar (llamada, otra app): reflejarlo en la interfaz
      el.addEventListener('pause', () => {
        if (el === this.el && this.playing && !el.ended && !this.switching && !this.holding) {
          log('el sistema pausó el audio');
          this.playing = false;
          this.onState?.(false);
        }
      });
    }
    this.recs = new Map(); // seg → { start, end, offsets, duration, url, seg }
    this.pending = new Map(); // seg → { promise, job, prefetch }
    this.durations = new Map(); // seg → duración real conocida
    this.inflight = new Map(); // clave de caché → generación en curso
    this.prefetchGen = 0;
    this.playGen = 0;
    this.loadGen = 0;
    this.raf = 0;
    this.upcoming = null;
    this.upTrack = null;
  }

  get el() { return this.els[this.active]; }

  /* ---------- carga ---------- */

  #makeCtx(ch, sentences, paraEnd) {
    return { ch, sentences, paraEnd, segs: planSegments(sentences) };
  }

  load(sentences, index = 0, meta = {}) {
    this.stopSpeaking();
    this.loadGen++;
    this.sentences = sentences;
    this.index = Math.min(index, Math.max(0, sentences.length - 1));
    this.bookId = meta.bookId;
    this.ch = meta.ch;
    this.ctx = this.#makeCtx(meta.ch, sentences, meta.paraEnd || []);
    this.segs = this.ctx.segs;
    this.segOf = new Int32Array(sentences.length);
    this.segs.forEach((s, i) => { for (let k = s.start; k < s.end; k++) this.segOf[k] = i; });
    this.#releaseRecords(true);
    this.durations = new Map();
    this.upcoming = null;
    this.onSentence?.(this.index);
    this.#loadKnownDurations();
    db.trimAudio(CACHE_CAP_BYTES, (e) => e.bookId === this.bookId && Math.abs(e.ch - this.ch) <= 1).catch(() => {});
  }

  // La app indica cuál es el capítulo siguiente para ir preparando sus primeros trozos.
  setUpcoming(info) {
    this.upcoming = info ? this.#makeCtx(info.ch, info.sentences, info.paraEnd || []) : null;
  }

  async #loadKnownDurations() {
    const gen = this.loadGen;
    const ctx = this.ctx;
    try {
      const list = await db.listAudio(this.bookId);
      if (gen !== this.loadGen) return;
      for (const a of list) {
        if (a.ch === ctx.ch && a.voiceId === this.voice.id && ctx.segs[a.seg] && a.key === this.#key(ctx, a.seg)) this.durations.set(a.seg, a.duration);
      }
    } catch { /* sin datos: se usan estimaciones */ }
  }

  setVoice(voice) {
    this.voice = voice;
  }

  /* ---------- controles ---------- */

  setRate(rate) {
    this.rate = rate;
    for (const el of this.els) el.playbackRate = rate;
  }

  async play() {
    if (!this.sentences.length) return;
    log(`play · frase ${this.index} · ${document.hidden ? 'pantalla apagada' : 'pantalla encendida'}`);
    this.playing = true;
    this.onState?.(true);
    await this.#startAt(this.index);
  }

  pause() {
    this.playing = false;
    this.playGen++;
    this.el.pause();
    this.#releaseMedia();
    this.onBuffering?.(false);
    this.onState?.(false);
    cancelAnimationFrame(this.raf);
  }

  toggle() {
    this.playing ? this.pause() : this.play();
  }

  seek(index) {
    this.index = Math.min(Math.max(0, index), this.sentences.length - 1);
    this.onSentence?.(this.index);
    if (!this.playing) return;
    const rec = this.recs.get(this.segOf[this.index]);
    if (rec && this.el.src === rec.url) this.el.currentTime = rec.offsets[this.index - rec.start]; // mismo trozo: salto inmediato
    else this.#startAt(this.index);
  }

  next() { this.seek(this.index + 1); }
  prev() { this.seek(this.index - 1); }

  stopSpeaking() {
    this.playing = false;
    this.playGen++;
    for (const el of this.els) el.pause();
    this.#releaseMedia();
    for (const p of this.pending.values()) p.job?.cancel();
    this.upTrack?.job?.cancel();
    this.pending.clear();
    cancelAnimationFrame(this.raf);
    this.onBuffering?.(false);
    this.onState?.(false);
  }

  /* ---------- tiempos (en segundos a 1×) ---------- */

  timeInfo() {
    const segs = this.segs || [];
    const dur = (i) => this.durations.get(i) ?? segs[i].estimate;
    const total = segs.reduce((n, _, i) => n + dur(i), 0);
    const cur = this.segOf?.[this.index] ?? 0;
    let elapsed = 0;
    for (let i = 0; i < cur; i++) elapsed += dur(i);
    const rec = this.recs.get(cur);
    if (rec) elapsed += this.playing && this.el.src === rec.url ? this.el.currentTime : rec.offsets[this.index - rec.start];
    else if (segs[cur]) elapsed += segs[cur].estimate * ((this.index - segs[cur].start) / Math.max(1, segs[cur].end - segs[cur].start));
    return { elapsed, total, exact: segs.every((_, i) => this.durations.has(i)) };
  }

  // Cuántos trozos del capítulo están ya preparados (para mostrar "Listo").
  preparedCount() { return this.durations.size; }
  segmentCount() { return this.segs?.length || 0; }

  /* ---------- reproducción ---------- */

  async #startAt(i) {
    const my = ++this.playGen;
    const seg = this.segOf[i];
    this.#cancelPrefetch();
    if (!this.recs.has(seg)) {
      log(`esperando audio del trozo ${seg}`);
      this.onBuffering?.(true);
      this.#holdMedia();
    }
    let rec;
    try {
      rec = await this.#ensure(seg, false);
    } catch (err) {
      if (err.cancelled) return;
      log(`error: ${err.message}`);
      this.pause();
      this.onError?.(new Error('El motor de voz falló y no se pudo recuperar. Pulsa play para reintentar.'));
      return;
    }
    if (!rec) rec = await this.#ensure(seg, false); // se unió a una preparación lejana que no creó la URL
    if (my !== this.playGen || !this.playing) return;
    this.onBuffering?.(false);
    this.#attach(rec, i - rec.start);
    this.#prefetch(my);
  }

  #attach(rec, k) {
    const el = this.el;
    if (el.src !== rec.url) el.src = rec.url;
    el.currentTime = rec.offsets[k] || 0;
    el.playbackRate = this.rate;
    el.play().then(() => this.#releaseMedia()).catch((err) => {
      if (err.name === 'NotAllowedError') { this.pause(); this.onError?.(new Error('El navegador bloqueó el audio: pulsa play otra vez')); }
    });
    this.#tick();
  }

  // Mientras se prepara el siguiente trozo suena un audio silencioso en bucle: así Android sigue
  // viendo una reproducción activa y no congela la página (ni la generación de voz) con la pantalla apagada.
  #holdMedia() {
    if (!this.silence) {
      this.silence = new Audio(silentWavUrl());
      this.silence.loop = true;
    }
    this.holding = true;
    this.silence.play().catch(() => {});
  }

  #releaseMedia() {
    this.holding = false;
    this.silence?.pause();
  }

  #tick() {
    cancelAnimationFrame(this.raf);
    const loop = () => { this.#sync(); if (this.playing) this.raf = requestAnimationFrame(loop); };
    this.raf = requestAnimationFrame(loop);
  }

  #sync() {
    if (!this.playing) return;
    const rec = [...this.recs.values()].find((r) => r.url === this.el.src);
    if (!rec) return;
    const t = this.el.currentTime;
    let k = rec.offsets.length - 1;
    while (k > 0 && rec.offsets[k] > t + 0.03) k--;
    const i = rec.start + k;
    if (i !== this.index) { this.index = i; this.onSentence?.(i); }
  }

  async #onEnded() {
    const cur = this.segOf[this.index];
    const next = cur + 1;
    if (next >= this.segs.length) {
      this.playing = false;
      this.#releaseMedia();
      this.onState?.(false);
      this.onChapterEnd?.();
      return;
    }
    const my = this.playGen;
    const standby = this.els[1 - this.active];
    const ready = this.recs.get(next);
    if (ready && standby.src === ready.url) {
      // el siguiente trozo ya está cargado en el otro <audio>: sin hueco apreciable
      this.switching = true;
      standby.currentTime = 0;
      standby.playbackRate = this.rate;
      this.active = 1 - this.active;
      await standby.play().catch(() => {});
      this.switching = false;
      this.index = ready.start;
      this.onSentence?.(this.index);
      this.#prefetch(my);
      return;
    }
    log(`fin del trozo ${cur} sin el siguiente listo`);
    this.index = this.segs[next].start;
    this.onSentence?.(this.index);
    await this.#startAt(this.index);
  }

  // Deja el trozo siguiente cargado en el <audio> en espera.
  #standby(seg) {
    const rec = this.recs.get(seg);
    const spare = this.els[1 - this.active];
    if (rec && spare.src !== rec.url) { spare.src = rec.url; spare.load(); }
  }

  /* ---------- síntesis y caché ---------- */

  #spoken(ctx, seg) {
    const { start, end } = ctx.segs[seg];
    return ctx.sentences.slice(start, end).map((t) => this.prepare(t));
  }

  #key(ctx, seg) {
    return `${this.bookId}|${this.voice.id}|${ctx.ch}|${seg}|${hashText(this.#spoken(ctx, seg).join('\n'))}`;
  }

  // Sintetiza con un reintento: si el motor (WebAssembly) falla, se reinicia y se vuelve a probar.
  async #synthesize(texts, track) {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.synth.useVoice(this.voice);
        track.job = this.synth.synth(this.voice, texts);
        return await track.job.promise;
      } catch (err) {
        if (err.cancelled || attempt >= 1) throw err;
        log(`fallo del motor (${err.message}); se reinicia`);
        this.synth.reset();
      }
    }
  }

  // Devuelve el trozo guardado, o lo genera y lo guarda. `track.job` permite cancelarlo.
  // Un mismo trozo nunca se genera dos veces a la vez: quien llega después espera al que ya lo está haciendo.
  async #record(ctx, seg, track) {
    const key = this.#key(ctx, seg);
    for (;;) {
      const running = this.inflight.get(key);
      if (!running) break;
      try { return await running; } catch (err) { if (!err.cancelled) throw err; /* lo canceló otro: se genera de nuevo */ }
    }
    const p = this.#generate(key, ctx, seg, track);
    this.inflight.set(key, p);
    const clear = () => { if (this.inflight.get(key) === p) this.inflight.delete(key); };
    p.then(clear, clear);
    return p;
  }

  async #generate(key, ctx, seg, track) {
    const stored = await db.getAudio(key);
    if (stored) return stored;
    const { start, end } = ctx.segs[seg];
    const t0 = performance.now();
    const { pcms, rate } = await this.#synthesize(this.#spoken(ctx, seg), track);
    const pauses = ctx.sentences.slice(start, end).map((t, k) => pauseAfter(t, !!ctx.paraEnd[start + k]));
    const { wav, offsets, duration } = buildSegmentWav(pcms, rate, pauses);
    const rec = { key, bookId: this.bookId, voiceId: this.voice.id, ch: ctx.ch, seg, bytes: wav.byteLength, duration, offsets, blob: new Blob([wav], { type: 'audio/wav' }) };
    await db.putAudio(rec);
    const ms = performance.now() - t0;
    log(`cap ${ctx.ch} trozo ${seg}: ${duration.toFixed(1)} s de audio en ${(ms / 1000).toFixed(1)} s (${(ms / 1000 / duration).toFixed(2)}×) · ${document.hidden ? 'pantalla apagada' : 'pantalla encendida'}`);
    return rec;
  }

  #ensure(seg, prefetch) {
    if (this.recs.has(seg)) return Promise.resolve(this.recs.get(seg));
    const existing = this.pending.get(seg);
    if (existing) { if (!prefetch) existing.prefetch = false; return existing.promise; }

    const gen = this.loadGen;
    const ctx = this.ctx;
    const entry = { prefetch, job: null };
    entry.promise = (async () => {
      const stored = await this.#record(ctx, seg, entry);
      if (gen !== this.loadGen) throw Object.assign(new Error('cancelado'), { cancelled: true });
      this.durations.set(seg, stored.duration);
      const cur = this.segOf[this.index];
      // los trozos lejanos solo se guardan; su URL de audio se crea cuando se acercan
      if (prefetch && seg > cur + KEEP_RECORDS) return null;
      const rec = { seg, start: ctx.segs[seg].start, end: ctx.segs[seg].end, offsets: stored.offsets, duration: stored.duration, url: URL.createObjectURL(stored.blob) };
      this.recs.set(seg, rec);
      this.#releaseRecords();
      return rec;
    })().finally(() => this.pending.delete(seg));
    this.pending.set(seg, entry);
    return entry.promise;
  }

  // Un solo bucle de prefetch a la vez; la ventana se recalcula en cada vuelta según dónde se esté escuchando.
  async #prefetch(gen) {
    if (this.prefetchGen === gen) return;
    this.prefetchGen = gen;
    try {
      for (let s = this.segOf[this.index] + 1; s < Math.min(this.segs.length, this.segOf[this.index] + 1 + LOOKAHEAD_SEGMENTS); s++) {
        if (!this.playing || gen !== this.playGen) return;
        try { await this.#ensure(s, true); } catch { return; }
        if (s === this.segOf[this.index] + 1) this.#standby(s);
      }
      await this.#prefetchUpcoming(gen);
    } finally {
      if (this.prefetchGen === gen) this.prefetchGen = 0;
    }
  }

  async #prefetchUpcoming(gen) {
    const ctx = this.upcoming;
    if (!ctx) return;
    for (let s = 0; s < Math.min(UPCOMING_SEGMENTS, ctx.segs.length); s++) {
      if (!this.playing || gen !== this.playGen) return;
      this.upTrack = {};
      try { await this.#record(ctx, s, this.upTrack); } catch { return; }
    }
  }

  #cancelPrefetch() {
    for (const [seg, p] of this.pending) if (p.prefetch) { p.job?.cancel(); this.pending.delete(seg); }
    this.upTrack?.job?.cancel();
  }

  // Conserva solo unos pocos trozos con URL de blob (memoria); el resto sigue en IndexedDB.
  #releaseRecords(all = false) {
    const cur = this.segOf?.[this.index] ?? 0;
    for (const [seg, rec] of this.recs) {
      if (all || seg < cur - 1 || seg > cur + KEEP_RECORDS) {
        if (all || (this.els[0].src !== rec.url && this.els[1].src !== rec.url)) { URL.revokeObjectURL(rec.url); this.recs.delete(seg); }
      }
    }
  }
}
