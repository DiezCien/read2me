# Créditos y licencias de terceros

Read2Me se distribuye bajo **GNU GPL v3.0** (ver `LICENSE`). Usa estas piezas de terceros:

## Código incluido en `vendor/`

| Pieza | Dónde | Licencia | Origen |
|---|---|---|---|
| ONNX Runtime Web 1.22.0 | `vendor/ort/` | MIT | https://github.com/microsoft/onnxruntime |
| piper-phonemize (WebAssembly) | `vendor/piper/` | MIT (envoltorio); incluye **espeak-ng** | https://github.com/diffusionstudio/piper-wasm (paquete npm `@diffusionstudio/piper-wasm` 1.0.0) |
| espeak-ng y sus datos de voz (`piper_phonemize.data`) | `vendor/piper/` | **GPL-3.0** | https://github.com/espeak-ng/espeak-ng |

### Código fuente correspondiente de lo compilado

Los ficheros `vendor/piper/piper_phonemize.{js,wasm,data}` son una compilación a WebAssembly de
piper-phonemize y espeak-ng. Su código fuente y las instrucciones de compilación están en:

- https://github.com/diffusionstudio/piper-wasm (pasos de compilación en su README)
- https://github.com/rhasspy/espeak-ng y https://github.com/wide-video/piper-phonemize (ramas usadas en esa compilación)
- https://github.com/espeak-ng/espeak-ng (proyecto original)

## Voces (modelos de Piper, descargados por el usuario desde Hugging Face)

No se incluyen en este repositorio: cada usuario las descarga desde
`huggingface.co/diffusionstudio/piper-voices` (copia de https://huggingface.co/rhasspy/piper-voices).

| Voz | Licencia del conjunto de datos |
|---|---|
| es_ES-davefx-medium | CC0 |
| es_ES-sharvard-medium | CC BY 3.0 — Universidad de Edimburgo, https://datashare.ed.ac.uk/handle/10283/574 |
| es_MX-claude-high, es_MX-ald-medium, es_ES-carlfm-x_low | Consultar el `MODEL_CARD` de cada voz antes de redistribuirlas |

## Marca

El nombre «Read2Me» y el logotipo (`icons/`) son de DiezCien y **no** están cubiertos por la GPL.
