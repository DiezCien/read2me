// Lector con voz neuronal. Mismo interfaz que Reader (tts.js), pero reproduce audio de verdad:
// el texto del capítulo se parte en trozos de ~12 s (audio.js), cada trozo se sintetiza con Piper
// en un worker, se guarda en IndexedDB y se reproduce con un <audio>. Como es audio normal, Android
// lo trata como un podcast: sigue sonando con la pantalla bloqueada y responde a los auriculares.

import * as db from './db.js';
import { planSegments, buildSegmentWav, pauseAfter } from './audio.js';

const LOOKAHEAD_SEGMENTS = 30; // ≈ 6 min de audio preparado por delante
const CACHE_CAP_BYTES = 600 * 1048576;
const KEEP_RECORDS = 3; // trozos con su blob decodificable en memoria

export class NeuralReader {
  constructor(synth, voice, { onSentence, onChapterEnd, onState, onBuffering, onError }) {
    Object.assign(this, { synth, voice, onSentence, onChapterEnd, onState, onBuffering, onError });
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
        if (el === this.el && this.playing && !el.ended && !this.switching) { this.playing = false; this.onState?.(false); }
      });
    }
    this.recs = new Map(); // seg → { start, end, offsets, duration, url, seg }
    this.pending = new Map(); // seg → { promise, job, prefetch }
    this.durations = new Map(); // seg → duración real conocida
    this.playGen = 0;
    this.loadGen = 0;
    this.raf = 0;
  }

  get el() { return this.els[this.active]; }

  /* ---------- carga ---------- */

  load(sentences, index = 0, meta = {}) {
    this.stopSpeaking();
    this.loadGen++;
    this.sentences = sentences;
    this.index = Math.min(index, Math.max(0, sentences.length - 1));
    this.bookId = meta.bookId;
    this.ch = meta.ch;
    this.paraEnd = meta.paraEnd || [];
    this.segs = planSegments(sentences);
    this.segOf = new Int32Array(sentences.length);
    this.segs.forEach((s, i) => { for (let k = s.start; k < s.end; k++) this.segOf[k] = i; });
    this.#releaseRecords(true);
    this.durations = new Map();
    this.onSentence?.(this.index);
    this.#loadKnownDurations();
    db.trimAudio(CACHE_CAP_BYTES, (e) => e.bookId === this.bookId && Math.abs(e.ch - this.ch) <= 1).catch(() => {});
  }

  async #loadKnownDurations() {
    const gen = this.loadGen;
    try {
      const list = await db.listAudio(this.bookId);
      if (gen !== this.loadGen) return;
      for (const a of list) if (a.ch === this.ch && a.voiceId === this.voice.id) this.durations.set(a.seg, a.duration);
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
    this.playing = true;
    this.onState?.(true);
    await this.#startAt(this.index);
  }

  pause() {
    this.playing = false;
    this.playGen++;
    this.el.pause();
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
    for (const p of this.pending.values()) p.job?.cancel();
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
    if (!this.recs.has(seg)) this.onBuffering?.(true);
    let rec;
    try {
      rec = await this.#ensure(seg, false);
    } catch (err) {
      if (err.cancelled) return;
      this.pause();
      this.onError?.(err);
      return;
    }
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
    el.play().catch((err) => {
      if (err.name === 'NotAllowedError') { this.pause(); this.onError?.(new Error('El navegador bloqueó el audio: pulsa play otra vez')); }
    });
    this.#tick();
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

  #key(seg) {
    return `${this.bookId}|${this.voice.id}|${this.ch}|${seg}`;
  }

  #ensure(seg, prefetch) {
    if (this.recs.has(seg)) return Promise.resolve(this.recs.get(seg));
    const existing = this.pending.get(seg);
    if (existing) { if (!prefetch) existing.prefetch = false; return existing.promise; }

    const gen = this.loadGen;
    const entry = { prefetch, job: null };
    entry.promise = (async () => {
      let stored = await db.getAudio(this.#key(seg));
      if (!stored) {
        const { start, end } = this.segs[seg];
        const texts = this.sentences.slice(start, end);
        await this.synth.useVoice(this.voice);
        entry.job = this.synth.synth(this.voice, texts);
        const { pcms, rate } = await entry.job.promise;
        const pauses = texts.map((t, k) => pauseAfter(t, !!this.paraEnd[start + k]));
        const { wav, offsets, duration } = buildSegmentWav(pcms, rate, pauses);
        stored = { key: this.#key(seg), bookId: this.bookId, voiceId: this.voice.id, ch: this.ch, seg, bytes: wav.byteLength, duration, offsets, blob: new Blob([wav], { type: 'audio/wav' }) };
        await db.putAudio(stored);
      }
      if (gen !== this.loadGen) throw Object.assign(new Error('cancelado'), { cancelled: true });
      this.durations.set(seg, stored.duration);
      const rec = { seg, start: this.segs[seg].start, end: this.segs[seg].end, offsets: stored.offsets, duration: stored.duration, url: URL.createObjectURL(stored.blob) };
      this.recs.set(seg, rec);
      this.#releaseRecords();
      return rec;
    })().finally(() => this.pending.delete(seg));
    this.pending.set(seg, entry);
    return entry.promise;
  }

  async #prefetch(gen) {
    const cur = this.segOf[this.index];
    const limit = Math.min(this.segs.length, cur + 1 + LOOKAHEAD_SEGMENTS);
    for (let s = cur + 1; s < limit; s++) {
      if (!this.playing || gen !== this.playGen) return;
      try { await this.#ensure(s, true); } catch { return; }
      if (s === cur + 1) this.#standby(s);
    }
  }

  #cancelPrefetch() {
    for (const [seg, p] of this.pending) if (p.prefetch) { p.job?.cancel(); this.pending.delete(seg); }
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
