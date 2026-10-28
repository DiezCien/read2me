// Piezas puras del audio neuronal (sin DOM): agrupar frases en trozos y montar el WAV.

import { WORDS_PER_MINUTE, countWords } from './text.js';

export const SEGMENT_SECONDS = 12; // duración aproximada de cada trozo de audio

// Agrupa frases consecutivas en trozos de ~SEGMENT_SECONDS (a 1×, estimado por palabras).
// Es determinista: depende solo del texto, así el audio guardado vale aunque cambies de punto de inicio.
export function planSegments(sentences, target = SEGMENT_SECONDS) {
  const segments = [];
  let start = 0;
  let seconds = 0;
  for (let i = 0; i < sentences.length; i++) {
    seconds += (countWords(sentences[i]) / WORDS_PER_MINUTE) * 60;
    if (seconds >= target || i === sentences.length - 1) {
      segments.push({ start, end: i + 1, estimate: seconds });
      start = i + 1;
      seconds = 0;
    }
  }
  return segments;
}

// Pausa (en segundos) que se deja después de cada frase.
export function pauseAfter(sentence, endsParagraph) {
  if (endsParagraph) return 0.55;
  if (/[.!?…]["»”)’]*$/.test(sentence)) return 0.28;
  return 0.1; // trozo de una frase larga cortado en una coma
}

// Une el audio de varias frases en un WAV mono de 16 bits.
// Devuelve el WAV y en qué segundo empieza cada frase (para resaltar el texto).
export function buildSegmentWav(pcms, rate, pauses) {
  const gaps = pauses.map((p) => Math.round(p * rate));
  const total = pcms.reduce((n, pcm, i) => n + pcm.length + gaps[i], 0);
  const buffer = new ArrayBuffer(44 + total * 2);
  const view = new DataView(buffer);
  const tag = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
  tag(0, 'RIFF'); view.setUint32(4, 36 + total * 2, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  tag(36, 'data'); view.setUint32(40, total * 2, true);

  const samples = new Int16Array(buffer, 44, total);
  const offsets = [];
  let at = 0;
  pcms.forEach((pcm, i) => {
    offsets.push(at / rate);
    samples.set(pcm, at);
    at += pcm.length + gaps[i]; // los huecos quedan en silencio (ceros)
  });
  return { wav: buffer, offsets, duration: total / rate };
}
