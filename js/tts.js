// Motor de voz. Hoy usa las voces del sistema (Web Speech API).
// La interfaz está pensada para cambiar el motor sin tocar la app: un motor
// de voz neuronal local solo tiene que implementar speak(text, rate) → Promise.
//
// Para que Android mantenga la reproducción con la pantalla bloqueada, se
// reproduce en bucle un audio silencioso y se registra la sesión multimedia
// (notificación con controles y botones de los auriculares).

export class SystemVoiceEngine {
  constructor() {
    this.voice = null;
    this.token = 0;
  }

  voices() {
    return speechSynthesis.getVoices();
  }

  async ready() {
    if (this.voices().length) return;
    await new Promise((resolve) => {
      speechSynthesis.addEventListener('voiceschanged', resolve, { once: true });
      setTimeout(resolve, 1500);
    });
  }

  setVoice(uri) {
    this.voice = this.voices().find((v) => v.voiceURI === uri) || null;
  }

  pickDefault(lang = 'es') {
    const all = this.voices();
    const wanted = all.filter((v) => v.lang.toLowerCase().startsWith(lang));
    return wanted.find((v) => /es[-_]ES/i.test(v.lang)) || wanted[0] || null;
  }

  // Resuelve true si terminó de hablar, false si se canceló.
  speak(text, rate = 1) {
    const mine = ++this.token;
    return new Promise((resolve) => {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      if (this.voice) { u.voice = this.voice; u.lang = this.voice.lang; } else u.lang = 'es-ES';
      u.rate = rate;
      u.onend = () => resolve(mine === this.token);
      u.onerror = () => resolve(false);
      speechSynthesis.speak(u);
    });
  }

  cancel() {
    this.token++;
    speechSynthesis.cancel();
  }
}

function silentWavUrl(seconds = 2) {
  const rate = 8000;
  const n = rate * seconds;
  const buf = new ArrayBuffer(44 + n);
  const dv = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); dv.setUint32(4, 36 + n, true); str(8, 'WAVE'); str(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate, true); dv.setUint16(32, 1, true); dv.setUint16(34, 8, true);
  str(36, 'data'); dv.setUint32(40, n, true);
  new Uint8Array(buf, 44).fill(128); // 128 = silencio en PCM de 8 bits
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

export class Reader {
  // sentences: string[] del capítulo actual. Callbacks: onSentence(i), onChapterEnd()
  constructor(engine, { onSentence, onChapterEnd, onState, prepare }) {
    this.engine = engine;
    this.prepare = prepare; // transforma el texto antes de decirlo (pronunciaciones)
    this.onSentence = onSentence;
    this.onChapterEnd = onChapterEnd;
    this.onState = onState;
    this.sentences = [];
    this.index = 0;
    this.rate = 1;
    this.playing = false;
    this.keepAlive = null;
  }

  load(sentences, index = 0) {
    this.stopSpeaking();
    this.sentences = sentences;
    this.index = Math.min(index, Math.max(0, sentences.length - 1));
    this.onSentence?.(this.index);
  }

  setRate(rate) {
    this.rate = rate;
    if (this.playing) this.#speakCurrent(); // reinicia la frase con la nueva velocidad
  }

  play() {
    if (!this.sentences.length) return;
    this.playing = true;
    this.#startKeepAlive();
    this.onState?.(true);
    this.#speakCurrent();
  }

  // Se cancela y se reinicia la frase al reanudar: pause()/resume() de
  // speechSynthesis es poco fiable en Chrome para Android.
  pause() {
    this.playing = false;
    this.engine.cancel();
    this.keepAlive?.pause();
    this.onState?.(false);
  }

  toggle() {
    this.playing ? this.pause() : this.play();
  }

  seek(index) {
    this.index = Math.min(Math.max(0, index), this.sentences.length - 1);
    this.onSentence?.(this.index);
    if (this.playing) this.#speakCurrent();
  }

  next() { this.seek(this.index + 1); }
  prev() { this.seek(this.index - 1); }

  stopSpeaking() {
    this.playing = false;
    this.engine.cancel();
    this.keepAlive?.pause();
    this.onState?.(false);
  }

  async #speakCurrent() {
    const i = this.index;
    this.onSentence?.(i);
    const finished = await this.engine.speak(this.prepare ? this.prepare(this.sentences[i]) : this.sentences[i], this.rate);
    if (!finished || !this.playing || this.index !== i) return;
    if (i + 1 >= this.sentences.length) {
      this.playing = false;
      this.onState?.(false);
      this.keepAlive?.pause();
      this.onChapterEnd?.();
    } else {
      this.index = i + 1;
      this.#speakCurrent();
    }
  }

  #startKeepAlive() {
    if (!this.keepAlive) {
      this.keepAlive = new Audio(silentWavUrl());
      this.keepAlive.loop = true;
    }
    this.keepAlive.play().catch(() => {});
  }
}

export function setupMediaSession(handlers) {
  if (!('mediaSession' in navigator)) return { update() {}, setPlaying() {} };
  const set = (action, fn) => { try { navigator.mediaSession.setActionHandler(action, fn); } catch { /* no soportada */ } };
  set('play', handlers.play);
  set('pause', handlers.pause);
  set('previoustrack', handlers.prevChapter);
  set('nexttrack', handlers.nextChapter);
  set('seekbackward', handlers.back30);
  set('seekforward', handlers.forward30);

  let artworkUrl = null;
  return {
    update({ title, artist, album, cover }) {
      if (artworkUrl) URL.revokeObjectURL(artworkUrl);
      artworkUrl = cover ? URL.createObjectURL(cover) : null;
      navigator.mediaSession.metadata = new MediaMetadata({
        title, artist, album,
        artwork: artworkUrl ? [{ src: artworkUrl, sizes: '512x512', type: cover.type }] : [],
      });
    },
    setPlaying(playing) {
      navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    },
  };
}
