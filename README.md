# Read2Me

Lee tus EPUB en voz alta. PWA sin servidor ni cuenta: los libros, el progreso, las voces y
el audio generado se guardan solo en el teléfono (IndexedDB).

HTML + CSS + JS vanilla, sin build ni dependencias de npm. En local con MAMP:
`http://localhost:8888/read2me/`. Para probarlo en el móvil por la wifi:
`http://<IP del Mac>:8888/read2me/`.

## Dos motores de voz

- **Neuronal (Piper):** genera el audio en el propio móvil con un modelo descargado una vez
  (60–73 MB). El audio se produce por adelantado en trozos de ~12 s, se guarda y se reproduce con un
  `<audio>` normal. Al ser audio de verdad, Android lo trata como un podcast: pantalla bloqueada,
  notificación con controles y botones de los auriculares (`MediaSession`).
- **Del sistema:** las voces de Android (`speechSynthesis`). Gratis y sin descarga, pero pueden
  cortarse con la pantalla bloqueada.

Voces en español: Dave (España), Sharvard M/F (España), Claude y Ald (México) y Carl (ligera).

## Estructura

- `js/zip.js`, `js/epub.js`: lector de EPUB (índice EPUB 3 `nav` / EPUB 2 `ncx`).
- `js/text.js`: frases y estimación de tiempos. `js/audio.js`: trozos de audio y WAV.
- `js/db.js`: IndexedDB (libros, progreso, marcadores, voces, audio) y copia de seguridad.
- `js/tts.js`: motor del sistema. `js/neural-reader.js`: motor neuronal (reproductor, caché, lookahead).
- `js/neural-synth.js` + `js/piper-worker.js`: Piper en un Web Worker. `js/voices.js`: catálogo y descarga.
- `js/app.js`: pantallas.
- `vendor/`: código de terceros alojado aquí (sin CDNs): onnxruntime-web 1.22.0 (`vendor/ort`, MIT)
  y el fonemizador de Piper compilado a WebAssembly (`vendor/piper`, `@diffusionstudio/piper-wasm` 1.0.0).
  Pesan ~30 MB.
- `.htaccess`: tipos MIME de `.wasm` y `.js`. Si despliegas en otro servidor, `.wasm` debe servirse
  como `application/wasm`.

## Pruebas

```bash
npm test
```

`tests/fixtures/ejemplo.epub` es un EPUB de prueba (dominio público).
`python3 tools/make-icons.py` genera los iconos desde `_private/logo-square.png` (necesita Pillow).

## Licencia

Read2Me se publica bajo **GNU GPL v3.0** (`LICENSE`), porque incluye espeak-ng (GPL-3.0).
Los créditos y el origen del código de terceros están en `THIRD-PARTY-NOTICES.md`.
La voz Sharvard exige atribución (CC BY 3.0). El nombre y el logotipo no están cubiertos por la GPL.

## Medido y por probar

- En un Mac, Piper (Dave) genera audio a ~0,16× tiempo real con un solo hilo (20 s de audio en 3,3 s).
  **No está medido en un móvil**: ahí depende del procesador. Si va justo, usa la voz ligera.
- Entre capítulos hay una espera de unos segundos mientras se prepara el primer trozo del siguiente.
- Sin probar en un Android real: pantalla bloqueada, notificación, botones Bluetooth y consumo de batería.
- El service worker (modo sin conexión) no se registra en el navegador de pruebas del entorno de desarrollo.
- El caché de audio se recorta a 600 MB (lo más antiguo primero, salvo el capítulo actual y el contiguo).
