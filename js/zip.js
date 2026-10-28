// Lector mínimo de ZIP (un EPUB es un ZIP). Sin dependencias: usa
// DecompressionStream, disponible en Chrome/Android y en Node 18+.
// No soporta ZIP64 ni cifrado, que un EPUB normal no usa.

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;

export async function unzip(input) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const text = new TextDecoder();

  let eocd = -1;
  const min = Math.max(0, u8.length - 22 - 65535);
  for (let i = u8.length - 22; i >= min; i--) {
    if (dv.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('El archivo no es un ZIP/EPUB válido');

  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== SIG_CENTRAL) throw new Error('Directorio ZIP dañado');
    const method = dv.getUint16(p + 10, true);
    const size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const offset = dv.getUint32(p + 42, true);
    const name = text.decode(u8.subarray(p + 46, p + 46 + nameLen));
    entries.set(name, { method, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }

  async function read(name) {
    const e = entries.get(name);
    if (!e) return null;
    const start = e.offset + 30 + dv.getUint16(e.offset + 26, true) + dv.getUint16(e.offset + 28, true);
    const data = u8.subarray(start, start + e.size);
    if (e.method === 0) return data.slice();
    if (e.method !== 8) throw new Error('Método de compresión no soportado: ' + e.method);
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  return {
    names: [...entries.keys()],
    has: (name) => entries.has(name),
    read,
    async readText(name) {
      const d = await read(name);
      return d ? text.decode(d) : null;
    },
  };
}
