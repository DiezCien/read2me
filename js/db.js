// Almacenamiento local (IndexedDB). No hay servidor: todo vive en este navegador.
//   books      → ficha del libro (título, autor, portada, capítulos sin texto)
//   texts      → el texto de cada libro, aparte para que listar la biblioteca sea ligero
//   progress   → por dónde vas en cada libro
//   bookmarks  → marcadores
//   voices     → voces neuronales descargadas (modelo ONNX + configuración)
//   audio      → trozos de audio ya generados con la voz neuronal (caché que se recorta)

const DB_NAME = 'read2me';
const DB_VERSION = 2;

let dbPromise;

function open() {
  dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const has = (n) => db.objectStoreNames.contains(n);
      if (!has('books')) db.createObjectStore('books', { keyPath: 'id' });
      if (!has('texts')) db.createObjectStore('texts', { keyPath: 'id' });
      if (!has('progress')) db.createObjectStore('progress', { keyPath: 'id' });
      if (!has('bookmarks')) db.createObjectStore('bookmarks', { keyPath: 'id', autoIncrement: true }).createIndex('bookId', 'bookId');
      // v2: voces neuronales descargadas y audio ya generado
      if (!has('voices')) db.createObjectStore('voices', { keyPath: 'id' });
      if (!has('audio')) {
        const audio = db.createObjectStore('audio', { keyPath: 'key' });
        audio.createIndex('bookId', 'bookId');
        audio.createIndex('at', 'at');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(stores, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let result;
    Promise.resolve(fn(t)).then((r) => (result = r), reject);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

export function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
}

export async function saveBook(parsed) {
  const id = newId();
  const book = {
    id,
    title: parsed.title,
    author: parsed.author,
    language: parsed.language,
    cover: parsed.cover,
    addedAt: Date.now(),
    chapters: parsed.chapters.map((c) => ({ title: c.title, words: c.words })),
    words: parsed.chapters.reduce((n, c) => n + c.words, 0),
  };
  const text = { id, chapters: parsed.chapters.map((c) => c.paragraphs) };
  await tx(['books', 'texts'], 'readwrite', (t) => {
    t.objectStore('books').put(book);
    t.objectStore('texts').put(text);
  });
  return book;
}

export const listBooks = () => tx(['books'], 'readonly', (t) => wrap(t.objectStore('books').getAll()));
export const getBook = (id) => tx(['books'], 'readonly', (t) => wrap(t.objectStore('books').get(id)));
export const getText = (id) => tx(['texts'], 'readonly', (t) => wrap(t.objectStore('texts').get(id)));
export const listProgress = () => tx(['progress'], 'readonly', (t) => wrap(t.objectStore('progress').getAll()));
export const getProgress = (id) => tx(['progress'], 'readonly', (t) => wrap(t.objectStore('progress').get(id)));

export const saveProgress = (id, chapter, sentence, extra = {}) =>
  tx(['progress'], 'readwrite', (t) => {
    t.objectStore('progress').put({ id, chapter, sentence, updatedAt: Date.now(), ...extra });
  });

export const listBookmarks = (bookId) =>
  tx(['bookmarks'], 'readonly', (t) => wrap(t.objectStore('bookmarks').index('bookId').getAll(bookId)));

export const addBookmark = (bookmark) =>
  tx(['bookmarks'], 'readwrite', (t) => {
    t.objectStore('bookmarks').add({ ...bookmark, at: Date.now() });
  });

export const removeBookmark = (id) =>
  tx(['bookmarks'], 'readwrite', (t) => {
    t.objectStore('bookmarks').delete(id);
  });

export async function deleteBook(id) {
  const marks = await listBookmarks(id);
  await tx(['books', 'texts', 'progress', 'bookmarks'], 'readwrite', (t) => {
    t.objectStore('books').delete(id);
    t.objectStore('texts').delete(id);
    t.objectStore('progress').delete(id);
    for (const m of marks) t.objectStore('bookmarks').delete(m.id);
  });
}

// Copia de seguridad: solo progreso y marcadores (los libros los vuelves a añadir).
// Los libros se identifican por título + autor para poder emparejarlos en otro móvil.
export async function exportBackup() {
  const [books, progress, allMarks] = await Promise.all([
    listBooks(),
    listProgress(),
    tx(['bookmarks'], 'readonly', (t) => wrap(t.objectStore('bookmarks').getAll())),
  ]);
  const key = new Map(books.map((b) => [b.id, { title: b.title, author: b.author }]));
  return {
    app: 'read2me',
    version: 1,
    exportedAt: new Date().toISOString(),
    progress: progress.filter((p) => key.has(p.id)).map((p) => ({ ...key.get(p.id), chapter: p.chapter, sentence: p.sentence, updatedAt: p.updatedAt })),
    bookmarks: allMarks.filter((m) => key.has(m.bookId)).map((m) => ({ ...key.get(m.bookId), chapter: m.chapter, sentence: m.sentence, label: m.label, at: m.at })),
  };
}

export async function importBackup(data) {
  if (data?.app !== 'read2me') throw new Error('Este archivo no es una copia de Lector EPUB');
  const books = await listBooks();
  const find = (x) => books.find((b) => b.title === x.title && b.author === x.author);
  let restored = 0;
  for (const p of data.progress || []) {
    const b = find(p);
    if (!b) continue;
    await saveProgress(b.id, p.chapter, p.sentence);
    restored++;
  }
  for (const m of data.bookmarks || []) {
    const b = find(m);
    if (b) await addBookmark({ bookId: b.id, chapter: m.chapter, sentence: m.sentence, label: m.label });
  }
  return restored;
}

/* ---------- voces neuronales y audio generado ---------- */

function eachCursor(source, fn) {
  return new Promise((resolve, reject) => {
    const req = source.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve();
      fn(cursor);
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

export const saveVoice = (voice) =>
  tx(['voices'], 'readwrite', (t) => {
    t.objectStore('voices').put({ ...voice, at: Date.now() });
  });
export const getVoice = (id) => tx(['voices'], 'readonly', (t) => wrap(t.objectStore('voices').get(id)));
export const deleteVoice = (id) =>
  tx(['voices'], 'readwrite', (t) => {
    t.objectStore('voices').delete(id);
  });
export const listVoiceIds = () => tx(['voices'], 'readonly', (t) => wrap(t.objectStore('voices').getAllKeys()));

export const putAudio = (rec) =>
  tx(['audio'], 'readwrite', (t) => {
    t.objectStore('audio').put({ ...rec, at: Date.now() });
  });
export const getAudio = (key) => tx(['audio'], 'readonly', (t) => wrap(t.objectStore('audio').get(key)));

// Metadatos (sin leer el audio) de los trozos guardados de un libro.
export const listAudio = (bookId) =>
  tx(['audio'], 'readonly', async (t) => {
    const out = [];
    const index = t.objectStore('audio').index('bookId');
    await eachCursor({ openCursor: () => index.openCursor(IDBKeyRange.only(bookId)) }, (c) => {
      const { key, voiceId, ch, seg, duration, bytes } = c.value;
      out.push({ key, voiceId, ch, seg, duration, bytes });
    });
    return out;
  });

export const audioUsage = () =>
  tx(['audio'], 'readonly', async (t) => {
    let bytes = 0;
    let count = 0;
    await eachCursor(t.objectStore('audio'), (c) => { bytes += c.value.bytes || 0; count++; });
    return { bytes, count };
  });

export const clearAudio = (bookId) =>
  tx(['audio'], 'readwrite', async (t) => {
    const store = t.objectStore('audio');
    if (bookId == null) return wrap(store.clear());
    await eachCursor({ openCursor: () => store.index('bookId').openCursor(IDBKeyRange.only(bookId)) }, (c) => c.delete());
  });

// Borra lo más antiguo hasta que el audio guardado ocupe como mucho `capBytes`.
// `protect(meta)` devuelve true para lo que no se debe borrar (el capítulo que suena).
export const trimAudio = (capBytes, protect = () => false) =>
  tx(['audio'], 'readwrite', async (t) => {
    const store = t.objectStore('audio');
    const entries = [];
    let total = 0;
    await eachCursor({ openCursor: () => store.index('at').openCursor() }, (c) => {
      const { key, bookId, ch, bytes } = c.value;
      entries.push({ key, bookId, ch, bytes: bytes || 0 });
      total += bytes || 0;
    });
    for (const e of entries) {
      if (total <= capBytes) break;
      if (protect(e)) continue;
      store.delete(e.key);
      total -= e.bytes;
    }
    return total;
  });
