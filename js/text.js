// Utilidades de texto puras (sin DOM): partir en frases y estimar tiempos.

export const WORDS_PER_MINUTE = 160; // voz en español a 1×; se puede afinar por voz

const ABBREVIATIONS = /\b(?:Sr|Sra|Srta|Dr|Dra|Ud|Uds|pág|págs|cap|etc|Mr|Mrs|Ms|St|vs)\.$/;
const MAX_CHUNK = 220; // Chrome corta las locuciones muy largas

export function splitSentences(text) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const raw = clean.split(/(?<=[.!?…»”"])\s+(?=[A-ZÁÉÍÓÚÜÑ¿¡«“(\d])/);

  const merged = [];
  for (const piece of raw) {
    const prev = merged[merged.length - 1];
    if (prev && ABBREVIATIONS.test(prev)) merged[merged.length - 1] = prev + ' ' + piece;
    else merged.push(piece);
  }
  return merged.flatMap(chunkLong);
}

function chunkLong(sentence) {
  if (sentence.length <= MAX_CHUNK) return [sentence];
  const out = [];
  let rest = sentence;
  while (rest.length > MAX_CHUNK) {
    const window = rest.slice(0, MAX_CHUNK);
    let cut = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(': '));
    if (cut < MAX_CHUNK / 3) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = MAX_CHUNK;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export function countWords(text) {
  const m = String(text).match(/\S+/g);
  return m ? m.length : 0;
}

export function estimateSeconds(words, rate = 1) {
  return (words / (WORDS_PER_MINUTE * rate)) * 60;
}

export function formatClock(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// "14 h 20 min", "18 min", "< 1 min"
export function formatLong(seconds) {
  const min = Math.round(seconds / 60);
  if (min < 1) return '< 1 min';
  const h = Math.floor(min / 60);
  return h ? `${h} h ${String(min % 60).padStart(2, '0')} min` : `${min} min`;
}
