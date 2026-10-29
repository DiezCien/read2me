// Puente con el Web Worker de Piper: carga una voz y sintetiza frases.

import { loadVoiceFiles } from './voices.js';

export class PiperSynth {
  constructor() {
    this.worker = null;
    this.loaded = null; // voiceId cargada en el worker
    this.loading = null;
    this.nextId = 1;
    this.jobs = new Map();
  }

  #worker() {
    if (!this.worker) {
      this.worker = new Worker(new URL('./piper-worker.js', import.meta.url));
      this.worker.onmessage = (e) => this.#onMessage(e.data);
      this.worker.onerror = (e) => this.#fail(new Error(e.message || 'Error en el motor de voz'));
    }
    return this.worker;
  }

  #onMessage(msg) {
    const job = this.jobs.get(msg.id);
    if (msg.type === 'sentence' && job) {
      job.pcms[msg.index] = msg.pcm;
      job.rate = msg.rate;
    } else if (msg.type === 'done' && job) {
      this.jobs.delete(msg.id);
      job.resolve({ pcms: job.pcms, rate: job.rate, stats: msg.stats });
    }
    else if (msg.type === 'error' && job) { this.jobs.delete(msg.id); job.reject(new Error(msg.message)); }
  }

  #fail(err) {
    for (const job of this.jobs.values()) job.reject(err);
    this.jobs.clear();
    this.worker?.terminate();
    this.worker = null;
    this.loaded = null;
    this.loading = null;
  }

  // Carga (o cambia) la voz. Puede tardar un par de segundos con un modelo de 60 MB.
  async useVoice(voice) {
    if (this.loaded === voice.model) return;
    if (this.loading?.model === voice.model) return this.loading.promise;
    const files = await loadVoiceFiles(voice);
    if (!files) throw new Error('Esta voz todavía no está descargada');
    const worker = this.#worker();
    const promise = new Promise((resolve, reject) => {
      const onMsg = (e) => {
        if (e.data.type === 'loaded') { worker.removeEventListener('message', onMsg); this.loaded = voice.model; this.loading = null; resolve(); }
        else if (e.data.type === 'load-error') { worker.removeEventListener('message', onMsg); this.loading = null; reject(new Error(e.data.message)); }
      };
      worker.addEventListener('message', onMsg);
      worker.postMessage({ type: 'load', voiceId: voice.model, model: files.model, config: files.config }, [files.model]);
    });
    this.loading = { model: voice.model, promise };
    return promise;
  }

  // Devuelve { promise, cancel }. promise → { pcms: Int16Array[], rate }
  synth(voice, texts) {
    const id = this.nextId++;
    const job = { pcms: new Array(texts.length), rate: 22050 };
    job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    this.jobs.set(id, job);
    this.#worker().postMessage({ type: 'synth', id, voiceId: voice.model, speaker: voice.speaker, texts });
    return {
      promise: job.promise,
      cancel: () => {
        if (!this.jobs.has(id)) return;
        this.jobs.delete(id);
        this.worker?.postMessage({ type: 'cancel', id });
        job.reject(Object.assign(new Error('cancelado'), { cancelled: true }));
      },
    };
  }

  // Tira el worker y lo vuelve a crear (con la voz cargada de nuevo) en la siguiente petición.
  reset() {
    this.#fail(new Error('motor reiniciado'));
  }

  dispose() {
    this.#fail(new Error('motor cerrado'));
  }
}
