import test from 'node:test';
import assert from 'node:assert/strict';
import { splitSentences, countWords, estimateSeconds, formatClock, formatLong, applyPronunciations } from '../js/text.js';

test('parte en frases respetando signos de apertura', () => {
  assert.deepEqual(
    splitSentences('Hola, mundo. ¿Cómo estás? ¡Muy bien! Y tú.'),
    ['Hola, mundo.', '¿Cómo estás?', '¡Muy bien!', 'Y tú.'],
  );
});

test('no corta tras abreviaturas ni dentro de un diálogo con raya', () => {
  assert.deepEqual(splitSentences('Habló el Sr. Pérez con calma.'), ['Habló el Sr. Pérez con calma.']);
  assert.deepEqual(splitSentences('—¿Qué gigantes? —dijo Sancho Panza.'), ['—¿Qué gigantes? —dijo Sancho Panza.']);
});

test('trocea las frases larguísimas sin perder texto', () => {
  const long = Array.from({ length: 80 }, (_, i) => `palabra${i}`).join(' ');
  const parts = splitSentences(long + '.');
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length <= 221));
  assert.equal(parts.join(' ').replace(/\s+/g, ' '), long + '.');
});

test('texto vacío no genera frases', () => {
  assert.deepEqual(splitSentences('   \n  '), []);
});

test('cuenta palabras y estima tiempo según la velocidad', () => {
  assert.equal(countWords('uno dos  tres\ncuatro'), 4);
  assert.equal(estimateSeconds(160, 1), 60);
  assert.equal(estimateSeconds(160, 2), 30);
});

test('formatea tiempos', () => {
  assert.equal(formatClock(724), '12:04');
  assert.equal(formatClock(3725), '1:02:05');
  assert.equal(formatLong(51600), '14 h 20 min');
  assert.equal(formatLong(18 * 60), '18 min');
  assert.equal(formatLong(10), '< 1 min');
});

test('pronunciaciones: sustituye palabras enteras sin distinguir mayúsculas', () => {
  const dict = [{ from: 'Bryce', to: 'Brais' }];
  assert.equal(applyPronunciations('Bryce miró a Bryce.', dict), 'Brais miró a Brais.');
  assert.equal(applyPronunciations('BRYCE y bryce', dict), 'Brais y Brais');
  assert.equal(applyPronunciations('Brycena no cambia, ni Abryce', dict), 'Brycena no cambia, ni Abryce');
  assert.equal(applyPronunciations('«Bryce», dijo', dict), '«Brais», dijo');
});

test('pronunciaciones: caracteres especiales y entradas vacías no rompen nada', () => {
  assert.equal(applyPronunciations('Mr. X (1+1)', [{ from: 'Mr.', to: 'Mister' }, { from: '(1+1)', to: 'dos' }, { from: '', to: 'x' }]), 'Mister X dos');
  assert.equal(applyPronunciations('Hola', undefined), 'Hola');
});
