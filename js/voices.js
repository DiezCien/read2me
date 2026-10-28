// Catálogo de voces neuronales (Piper) y su descarga.
// Los modelos se bajan una vez de Hugging Face y se guardan en IndexedDB
// (no en Cache Storage, para que también funcione en http dentro de la wifi de casa).

import * as db from './db.js';

const HF = 'https://huggingface.co/diffusionstudio/piper-voices/resolve/main/';

// Una "voz" es un modelo + un hablante. Sharvard trae dos hablantes en un solo modelo.
export const VOICES = [
  { id: 'es_ES-davefx-medium', model: 'es_ES-davefx-medium', speaker: 0, path: 'es/es_ES/davefx/medium/es_ES-davefx-medium', label: 'Dave · España', note: 'Calidad media', bytes: 63201294 },
  { id: 'es_ES-sharvard-medium:M', model: 'es_ES-sharvard-medium', speaker: 0, path: 'es/es_ES/sharvard/medium/es_ES-sharvard-medium', label: 'Sharvard · España (voz M)', note: 'Calidad media', bytes: 76733615 },
  { id: 'es_ES-sharvard-medium:F', model: 'es_ES-sharvard-medium', speaker: 1, path: 'es/es_ES/sharvard/medium/es_ES-sharvard-medium', label: 'Sharvard · España (voz F)', note: 'Calidad media', bytes: 76733615 },
  { id: 'es_MX-claude-high', model: 'es_MX-claude-high', speaker: 0, path: 'es/es_MX/claude/high/es_MX-claude-high', label: 'Claude · México', note: 'Calidad alta', bytes: 63122309 },
  { id: 'es_MX-ald-medium', model: 'es_MX-ald-medium', speaker: 0, path: 'es/es_MX/ald/medium/es_MX-ald-medium', label: 'Ald · México', note: 'Calidad media', bytes: 63201294 },
  { id: 'es_ES-carlfm-x_low', model: 'es_ES-carlfm-x_low', speaker: 0, path: 'es/es_ES/carlfm/x_low/es_ES-carlfm-x_low', label: 'Carl · España (ligera)', note: 'Más rápida, suena peor', bytes: 28130791 },
];

export const DEFAULT_VOICE = 'es_ES-davefx-medium';

export const voiceById = (id) => VOICES.find((v) => v.id === id) || null;

export const formatMB = (bytes) => `${Math.round(bytes / 1048576)} MB`;

// Qué modelos hay descargados (varias voces pueden compartir modelo).
export async function downloadedModels() {
  return new Set(await db.listVoiceIds());
}

async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`No se pudo descargar la voz (${res.status})`);
  const total = Number(res.headers.get('Content-Length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress?.(loaded, total);
  }
  return new Blob(chunks);
}

export async function downloadVoice(voice, onProgress) {
  const config = await (await fetch(`${HF}${voice.path}.onnx.json`)).json();
  const model = await fetchWithProgress(`${HF}${voice.path}.onnx`, onProgress);
  await db.saveVoice({ id: voice.model, model, config, bytes: model.size });
}

export const deleteVoiceModel = (voice) => db.deleteVoice(voice.model);

export async function loadVoiceFiles(voice) {
  const rec = await db.getVoice(voice.model);
  if (!rec) return null;
  return { model: await rec.model.arrayBuffer(), config: rec.config };
}
