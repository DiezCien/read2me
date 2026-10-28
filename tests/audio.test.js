import test from 'node:test';
import assert from 'node:assert/strict';
import { planSegments, pauseAfter, buildSegmentWav, hashText } from '../js/audio.js';

const sentence = (words) => Array.from({ length: words }, () => 'palabra').join(' ') + '.';

test('agrupa frases en trozos de unos 12 s y cubre todo el capítulo sin huecos', () => {
  const sentences = Array.from({ length: 40 }, () => sentence(10)); // ≈ 3,75 s por frase
  const plan = planSegments(sentences);
  assert.equal(plan[0].start, 0);
  assert.equal(plan.at(-1).end, 40);
  plan.forEach((seg, i) => { if (i) assert.equal(seg.start, plan[i - 1].end); });
  assert.ok(plan.every((seg) => seg.end > seg.start));
  assert.ok(plan.slice(0, -1).every((seg) => seg.estimate >= 12 && seg.estimate < 12 + 4));
});

test('un capítulo corto cabe en un solo trozo y uno vacío no genera ninguno', () => {
  assert.equal(planSegments([sentence(5)]).length, 1);
  assert.deepEqual(planSegments([]), []);
});

test('el plan es determinista', () => {
  const sentences = Array.from({ length: 25 }, (_, i) => sentence(5 + (i % 7)));
  assert.deepEqual(planSegments(sentences), planSegments(sentences));
});

test('pausas: más larga al acabar párrafo, corta en un corte por coma', () => {
  assert.ok(pauseAfter('Hola.', true) > pauseAfter('Hola.', false));
  assert.ok(pauseAfter('Hola.', false) > pauseAfter('Hola, y además', false));
  assert.equal(pauseAfter('«¿Qué?»', false), pauseAfter('Qué.', false));
});

test('el WAV tiene cabecera válida, silencios y desplazamientos correctos', () => {
  const rate = 1000;
  const a = Int16Array.from({ length: 500 }, () => 1000);
  const b = Int16Array.from({ length: 250 }, () => -1000);
  const { wav, offsets, duration } = buildSegmentWav([a, b], rate, [0.1, 0.2]);

  const view = new DataView(wav);
  const text = (o, n) => String.fromCharCode(...new Uint8Array(wav, o, n));
  assert.equal(text(0, 4), 'RIFF');
  assert.equal(text(8, 4), 'WAVE');
  assert.equal(view.getUint32(24, true), rate);
  assert.equal(view.getUint16(34, true), 16);

  assert.deepEqual(offsets, [0, 0.6]); // 500 muestras + 100 de silencio
  assert.equal(duration, 0.5 + 0.1 + 0.25 + 0.2);
  assert.equal(view.getUint32(40, true), (500 + 100 + 250 + 200) * 2);
  const samples = new Int16Array(wav, 44);
  assert.equal(samples[0], 1000);
  assert.equal(samples[550], 0); // dentro del silencio tras la primera frase
  assert.equal(samples[600], -1000);
});

test('la huella cambia con el texto y es estable', () => {
  assert.equal(hashText('Capítulo I'), hashText('Capítulo I'));
  assert.notEqual(hashText('Capítulo I'), hashText('Capítulo II'));
  assert.notEqual(hashText('a\nb'), hashText('ab'));
});
