import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { unzip } from '../js/zip.js';

// Construye un ZIP mínimo en memoria: [{name, data, deflate}]
function makeZip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name);
    const raw = Buffer.from(f.data);
    const body = f.deflate ? deflateRawSync(raw) : raw;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(f.deflate ? 8 : 0, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, body);

    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(f.deflate ? 8 : 0, 10);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(raw.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += local.length + name.length + body.length;
  }
  const dir = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(dir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, dir, eocd]));
}

test('lee archivos almacenados y comprimidos', async () => {
  const zip = await unzip(makeZip([
    { name: 'mimetype', data: 'application/epub+zip' },
    { name: 'OEBPS/cap1.xhtml', data: '<p>Hola ñandú</p>'.repeat(50), deflate: true },
  ]));
  assert.deepEqual(zip.names, ['mimetype', 'OEBPS/cap1.xhtml']);
  assert.equal(await zip.readText('mimetype'), 'application/epub+zip');
  assert.equal(await zip.readText('OEBPS/cap1.xhtml'), '<p>Hola ñandú</p>'.repeat(50));
});

test('devuelve null si el archivo no existe', async () => {
  const zip = await unzip(makeZip([{ name: 'a.txt', data: 'x' }]));
  assert.equal(await zip.read('b.txt'), null);
  assert.equal(zip.has('a.txt'), true);
});

test('rechaza lo que no es un ZIP', async () => {
  await assert.rejects(() => unzip(new TextEncoder().encode('esto no es un epub')), /ZIP|EPUB/);
});
