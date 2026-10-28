// Voz neuronal Piper en un Web Worker (clásico, para poder usar importScripts).
// Recibe la voz ya descargada (ArrayBuffer) y trabaja a base de tareas:
//   { type: 'load',  voiceId, model: ArrayBuffer, config: object }
//   { type: 'synth', id, voiceId, speaker, texts: string[] }  → varios mensajes 'sentence' y un 'done'
//   { type: 'cancel', id }
// Todo el código de terceros (onnxruntime-web y el fonemizador de Piper/espeak-ng)
// está en vendor/, así que no se carga nada de CDNs.

importScripts('../vendor/ort/ort.wasm.min.js', '../vendor/piper/piper_phonemize.js');

// El .mjs de onnxruntime va renombrado a .js: muchos servidores no mandan MIME para .mjs.
ort.env.wasm.wasmPaths = {
  mjs: new URL('../vendor/ort/ort-wasm-simd-threaded.js', self.location.href).href,
  wasm: new URL('../vendor/ort/ort-wasm-simd-threaded.wasm', self.location.href).href,
};
// Sin cabeceras COOP/COEP no hay SharedArrayBuffer, así que un solo hilo.
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;

let session = null;
let config = null;
let loadedVoice = null;
let phonemizer = null;
let sink = null;

const queue = [];
const cancelled = new Set();
let running = false;

async function getPhonemizer() {
  if (!phonemizer) {
    phonemizer = await createPiperPhonemize({
      print: (line) => sink && sink(line),
      printErr: () => {},
      locateFile: (file) => new URL('../vendor/piper/' + file, self.location.href).href,
    });
  }
  return phonemizer;
}

// Devuelve un array de ids de fonemas por texto (null si el texto no tiene nada que decir).
async function phonemize(texts) {
  const mod = await getPhonemizer();
  const run = (list) => {
    const lines = [];
    sink = (l) => lines.push(l);
    mod.callMain(['-l', config.espeak.voice, '--input', JSON.stringify(list.map((text) => ({ text }))), '--espeak_data', '/espeak-ng-data']);
    sink = null;
    return lines;
  };
  const lines = run(texts);
  if (lines.length === texts.length) return lines.map((l) => JSON.parse(l).phoneme_ids);
  // Si alguna frase no produjo salida, se reintenta una a una para no desalinear.
  return texts.map((t) => {
    const out = run([t]);
    return out.length ? JSON.parse(out[0]).phoneme_ids : null;
  });
}

async function infer(ids, speaker) {
  const feeds = {
    input: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
    input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new ort.Tensor('float32', Float32Array.from([config.inference.noise_scale, config.inference.length_scale, config.inference.noise_w]), [3]),
  };
  if (config.num_speakers > 1) feeds.sid = new ort.Tensor('int64', BigInt64Array.from([BigInt(speaker || 0)]), [1]);
  const { output } = await session.run(feeds);
  const f = output.data;
  const pcm = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const s = Math.max(-1, Math.min(1, f[i]));
    pcm[i] = s < 0 ? s * 32768 : s * 32767;
  }
  return pcm;
}

async function loadVoice(msg) {
  session = await ort.InferenceSession.create(msg.model, { executionProviders: ['wasm'] });
  config = msg.config;
  loadedVoice = msg.voiceId;
}

async function runJob(job) {
  if (job.voiceId !== loadedVoice) throw new Error('La voz no está cargada en el motor');
  const t0 = performance.now();
  const ids = await phonemize(job.texts);
  const phonemizeMs = performance.now() - t0;
  const t1 = performance.now();
  for (let i = 0; i < job.texts.length; i++) {
    if (cancelled.has(job.id)) return;
    const pcm = ids[i] && ids[i].length ? await infer(ids[i], job.speaker) : new Int16Array(0);
    self.postMessage({ type: 'sentence', id: job.id, index: i, pcm, rate: config.audio.sample_rate }, [pcm.buffer]);
  }
  self.postMessage({ type: 'done', id: job.id, stats: { phonemizeMs: Math.round(phonemizeMs), inferMs: Math.round(performance.now() - t1) } });
}

async function pump() {
  if (running) return;
  running = true;
  while (queue.length) {
    const job = queue.shift();
    if (cancelled.has(job.id)) { cancelled.delete(job.id); continue; }
    try {
      await runJob(job);
    } catch (err) {
      self.postMessage({ type: 'error', id: job.id, message: String((err && err.message) || err) });
    }
    cancelled.delete(job.id);
  }
  running = false;
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === 'load') {
    try {
      await loadVoice(msg);
      self.postMessage({ type: 'loaded', voiceId: msg.voiceId });
    } catch (err) {
      self.postMessage({ type: 'load-error', message: String((err && err.message) || err) });
    }
  } else if (msg.type === 'synth') {
    queue.push(msg);
    pump();
  } else if (msg.type === 'cancel') {
    cancelled.add(msg.id);
  }
};
