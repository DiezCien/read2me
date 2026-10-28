// Lee un EPUB: metadatos, portada, índice y texto de cada capítulo.
// Todo ocurre en el navegador; el resultado se guarda en IndexedDB (db.js).

import { unzip } from './zip.js';
import { countWords } from './text.js';

const BLOCK_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, dd, dt, figcaption';
const SKIP_SELECTOR = 'script, style, nav, aside, sup.footnote, a.noteref';

function parseXml(str, type = 'application/xhtml+xml') {
  const doc = new DOMParser().parseFromString(str, type);
  if (doc.querySelector('parsererror') && type !== 'text/html') {
    return new DOMParser().parseFromString(str, 'text/html');
  }
  return doc;
}

function dirname(path) {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i + 1);
}

function resolve(base, href) {
  const parts = (base + decodeURIComponent(href.split('#')[0])).split('/');
  const out = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p && p !== '.') out.push(p);
  }
  return out.join('/');
}

const byLocal = (root, name) => [...root.getElementsByTagName('*')].filter((n) => n.localName === name);

export async function readEpub(arrayBuffer) {
  const zip = await unzip(arrayBuffer);

  const container = await zip.readText('META-INF/container.xml');
  if (!container) throw new Error('Falta META-INF/container.xml: no parece un EPUB');
  const rootfile = byLocal(parseXml(container, 'text/xml'), 'rootfile')[0];
  const opfPath = rootfile?.getAttribute('full-path');
  if (!opfPath) throw new Error('No se encuentra el archivo OPF del libro');
  const base = dirname(opfPath);

  const opf = parseXml(await zip.readText(opfPath), 'text/xml');
  const meta = (name) => byLocal(opf, name)[0]?.textContent.trim() || '';

  const manifest = new Map();
  for (const item of byLocal(opf, 'item')) {
    manifest.set(item.getAttribute('id'), {
      href: resolve(base, item.getAttribute('href')),
      type: item.getAttribute('media-type') || '',
      props: item.getAttribute('properties') || '',
    });
  }
  const spine = byLocal(opf, 'itemref')
    .map((r) => manifest.get(r.getAttribute('idref')))
    .filter((m) => m && /x?html/.test(m.type));

  const titlesByHref = await readToc(zip, opf, manifest);
  const cover = await readCover(zip, opf, manifest);

  const chapters = [];
  for (const item of spine) {
    const html = await zip.readText(item.href);
    if (!html) continue;
    const doc = parseXml(html);
    const paragraphs = extractParagraphs(doc);
    if (!paragraphs.length) continue;
    const title =
      titlesByHref.get(item.href) ||
      doc.querySelector('h1, h2, h3')?.textContent.replace(/\s+/g, ' ').trim() ||
      '';
    chapters.push({ href: item.href, title, paragraphs });
  }
  if (!chapters.length) throw new Error('El libro no tiene texto legible (¿es un PDF escaneado o tiene DRM?)');

  chapters.forEach((c, i) => {
    if (!c.title) c.title = `Sección ${i + 1}`;
    c.words = c.paragraphs.reduce((n, p) => n + countWords(p), 0);
  });

  return {
    title: meta('title') || 'Sin título',
    author: meta('creator') || 'Autor desconocido',
    language: meta('language'),
    cover,
    chapters,
  };
}

function extractParagraphs(doc) {
  const body = doc.body || doc.documentElement;
  const out = [];
  const seen = new Set();
  for (const el of body.querySelectorAll(BLOCK_SELECTOR)) {
    if (el.closest(SKIP_SELECTOR)) continue;
    // un <li> o <blockquote> con <p> dentro se lee a través de sus párrafos
    if (el.querySelector(BLOCK_SELECTOR)) continue;
    const text = el.textContent.replace(/\s+/g, ' ').trim();
    if (text.length < 2 || seen.has(el)) continue;
    seen.add(el);
    out.push(text);
  }
  return out;
}

async function readToc(zip, opf, manifest) {
  const titles = new Map();
  const add = (href, label) => {
    const key = resolve('', href);
    const text = label.replace(/\s+/g, ' ').trim();
    if (text && !titles.has(key)) titles.set(key, text);
  };

  // EPUB 3: nav.xhtml
  const navItem = [...manifest.values()].find((m) => m.props.split(/\s+/).includes('nav'));
  if (navItem) {
    const nav = parseXml(await zip.readText(navItem.href));
    const navBase = dirname(navItem.href);
    const tocNav =
      [...nav.querySelectorAll('nav')].find((n) => (n.getAttribute('epub:type') || n.getAttribute('type') || '').includes('toc')) ||
      nav.querySelector('nav');
    for (const a of tocNav ? tocNav.querySelectorAll('a[href]') : []) {
      add(resolve(navBase, a.getAttribute('href')), a.textContent);
    }
    if (titles.size) return titles;
  }

  // EPUB 2: toc.ncx
  const spineEl = byLocal(opf, 'spine')[0];
  const ncx = manifest.get(spineEl?.getAttribute('toc')) || [...manifest.values()].find((m) => m.type === 'application/x-dtbncx+xml');
  if (ncx) {
    const doc = parseXml(await zip.readText(ncx.href), 'text/xml');
    const ncxBase = dirname(ncx.href);
    for (const point of byLocal(doc, 'navPoint')) {
      const label = byLocal(point, 'text')[0]?.textContent || '';
      const src = byLocal(point, 'content')[0]?.getAttribute('src');
      if (src) add(resolve(ncxBase, src), label);
    }
  }
  return titles;
}

async function readCover(zip, opf, manifest) {
  let item = [...manifest.values()].find((m) => m.props.split(/\s+/).includes('cover-image'));
  if (!item) {
    const coverId = byLocal(opf, 'meta').find((m) => m.getAttribute('name') === 'cover')?.getAttribute('content');
    item = manifest.get(coverId);
  }
  if (!item || !item.type.startsWith('image/')) return null;
  const data = await zip.read(item.href);
  return data ? new Blob([data], { type: item.type }) : null;
}
