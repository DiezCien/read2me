// Service worker: deja la app disponible sin conexión (cache del "cascarón").
// Sube CACHE cuando cambies cualquier archivo de la lista.
const CACHE = 'read2me-v17';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest',
  'css/app.css?v=17', 'js/app.js?v=17',
  'js/zip.js', 'js/epub.js', 'js/db.js', 'js/text.js', 'js/tts.js',
  'js/audio.js', 'js/diag.js', 'js/voices.js', 'js/neural-synth.js', 'js/neural-reader.js', 'js/piper-worker.js',
  'icons/logo-horiz-light.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' evita que la instalación se quede con copias viejas de la caché HTTP del navegador
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // las fuentes de Google van por red; hay fallback del sistema

  // La página en sí: primero la red (así se ve siempre la última versión) y, sin conexión o si tarda
  // más de 4 s, la copia guardada.
  if (e.request.mode === 'navigate') {
    e.respondWith(
      Promise.race([fetch(e.request), new Promise((_, reject) => setTimeout(reject, 4000))])
        .catch(() => caches.match('index.html').then((hit) => hit || caches.match('./'))),
    );
    return;
  }
  e.respondWith(
    caches.match(e.request, { ignoreSearch: false }).then((hit) => hit || fetch(e.request).then((res) => {
      const copy = res.clone();
      // los archivos del motor de voz (≈30 MB) se guardan la primera vez que se usan
      if (res.ok && res.status === 200) caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
      return res;
    })),
  );
});
