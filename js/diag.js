// Registro de diagnóstico: guarda las últimas líneas (en este navegador) para poder ver qué pasó
// cuando el audio se corta con la pantalla apagada. Se copia desde Ajustes → Diagnóstico.

const KEY = 'read2me.log';
const MAX_LINES = 150;

let lines = [];
try { lines = JSON.parse(localStorage.getItem(KEY)) || []; } catch { /* sin registro previo */ }

export function log(message) {
  lines.push(`${new Date().toTimeString().slice(0, 8)} ${message}`);
  if (lines.length > MAX_LINES) lines = lines.slice(-MAX_LINES);
  try { localStorage.setItem(KEY, JSON.stringify(lines)); } catch { /* sin almacenamiento */ }
}

export const getLog = () => lines.join('\n');

export function clearLog() {
  lines = [];
  try { localStorage.removeItem(KEY); } catch { /* sin almacenamiento */ }
}
