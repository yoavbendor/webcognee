// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Yoav Bendor
//
// The page: embeds the question in the browser (transformers.js, bge-small-en-v1.5, the model the passages were
// embedded with) and hands the vector to search-worker.js, which reads the Lance tables by HTTP Range.

// Loaded with import() inside main(), not a static import: a static import that fails (a blocked CDN, a browser
// that cannot run the bundle) stops this whole module before it can say why, and the page just sits there.
const TRANSFORMERS = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/dist/transformers.min.js';

// Where the tables are read from. On GitHub Pages, from the same repository through raw.githubusercontent.com:
// Pages' CDN answers a Range request with a slice of the gzip-compressed file whenever the browser accepts gzip
// (Safari and Firefox do), which breaks random access; raw.githubusercontent.com serves binary files as they are.
// `?data=<url>` overrides it (tests, other hosts).
function dataBase() {
  const override = new URLSearchParams(location.search).get('data');
  if (override) return new URL(override, location.href).href;
  if (location.hostname.endsWith('.github.io')) {
    const owner = location.hostname.slice(0, -'.github.io'.length);
    const repo = location.pathname.split('/').filter(Boolean)[0];
    if (repo) return `https://raw.githubusercontent.com/${owner}/${repo}/main/data/wiki/`;
  }
  return new URL('data/wiki/', location.href).href;
}
const BASE = dataBase();
const $ = (id) => document.getElementById(id);
const worker = new Worker('search-worker.js?v=4');
worker.onerror = (e) => status('The search worker failed to start: ' + (e.message || 'unknown error'), true);
const pending = new Map();
let nextId = 1;
let meta = null;
let embed = null;

function call(msg) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...msg, id });
  });
}

let initDone;
const initReady = new Promise((r) => { initDone = r; });

worker.onmessage = (ev) => {
  const m = ev.data;
  if (m.type === 'abort') { status('The reader stopped: ' + m.what, true); return; }
  if (m.type === 'init') { initDone(m); return; }
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  if (m.ok) p.resolve(m); else p.reject(new Error(m.error));
};

function status(text, error) {
  window.webcogneeStarted = true;  // the watchdog in index.html stands down
  const el = $('status');
  el.textContent = text;
  el.classList.toggle('error', !!error);
}

function kb(bytes) {
  return bytes >= 1 << 20 ? (bytes / (1 << 20)).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

function el(tag, attrs, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v);
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}

function snippet(text, query) {
  const words = new Set(query.toLowerCase().match(/[a-z0-9]{4,}/g) || []);
  const frag = document.createDocumentFragment();
  for (const part of text.split(/(\s+)/)) {
    const w = part.toLowerCase().replace(/[^a-z0-9]/g, '');
    frag.append(words.has(w) ? el('mark', {}, part) : part);
  }
  return frag;
}

async function runSearch(query) {
  if (!query.trim()) return;
  const t0 = performance.now();
  status('Embedding the question…');
  const out = await embed(meta.model.query_prefix + query, { pooling: 'cls', normalize: true });
  const vector = new Float32Array(out.data);
  const t1 = performance.now();
  status('Searching…');
  const nprobe = Number($('nprobe').value);
  const r = await call({ type: 'search', vector, k: 10, nprobe });
  const list = $('results');
  list.replaceChildren();
  for (const h of r.hits) {
    list.append(el('li', { class: 'hit' },
      el('button', { class: 'title', onclick: () => showArticle(h.article_id) }, h.title),
      h.section ? el('span', { class: 'section' }, ' › ' + h.section) : null,
      el('p', {}, snippet(h.text, query)),
      el('span', { class: 'score' }, 'similarity ' + h.score.toFixed(3))));
  }
  status(`${r.hits.length} passages · embedded in ${Math.round(t1 - t0)} ms · searched ${r.scanned} of ` +
    `${meta.chunks} passages in ${r.probed} partitions, ${r.stats.requests} range requests, ${kb(r.stats.bytes)}, ` +
    `${Math.round(r.ms)} ms`);
}

async function showArticle(id) {
  const r = await call({ type: 'article', article: id });
  const a = r.article;
  const panel = $('article');
  panel.replaceChildren(
    el('h2', {}, el('a', { href: a.url, target: '_blank', rel: 'noopener' }, a.title)),
    el('p', {}, a.lead + (a.lead.length >= 600 ? '…' : '')),
    a.categories ? el('p', { class: 'cats' }, a.categories.split('; ').slice(0, 12).join(' · ')) : null,
    el('h3', {}, `Links to ${a.n_links} articles here · linked from ${a.n_inlinks}`),
    el('div', { class: 'links' }, ...r.linked.map((l) => el('button', { onclick: () => showArticle(l.id) }, l.title))),
    el('p', { class: 'fine' }, `${r.stats.requests} range requests, ${kb(r.stats.bytes)}`));
  panel.hidden = false;
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function main() {
  status('Reading the corpus description…');
  const res = await fetch(BASE + 'meta.json');
  if (!res.ok) throw new Error(`data/wiki/meta.json: HTTP ${res.status}`);
  meta = await res.json();
  $('corpus').textContent = `${meta.articles} articles · ${meta.chunks} passages · ${meta.links} links between them`;
  status('Opening the tables and loading the embedding model…');
  worker.postMessage({ type: 'init', base: BASE });
  let transformers;
  try {
    transformers = await import(TRANSFORMERS);
  } catch (err) {
    throw new Error('Could not load transformers.js from cdn.jsdelivr.net (blocked, offline, or this browser cannot ' +
      'run it): ' + ((err && err.message) || err));
  }
  const { pipeline, env } = transformers;
  env.allowLocalModels = false;
  const model = pipeline('feature-extraction', meta.model.queries, { dtype: 'q8',
    progress_callback: (p) => {
      if (p.status === 'progress' && p.file && p.file.endsWith('.onnx')) {
        status(`Loading the embedding model (about 34 MB, once)… ${Math.round(p.progress)}%`);
      }
    } }).catch((err) => {
    throw new Error('Could not load the embedding model from huggingface.co: ' + ((err && err.message) || err));
  });
  const [init, extractor] = await Promise.all([initReady, model]);
  if (!init.ok) throw new Error(init.error);
  embed = extractor;
  $('q').disabled = false;
  $('go').disabled = false;
  status(`Ready. Tables opened in ${Math.round(init.ms)} ms (${init.stats.requests} requests, ${kb(init.stats.bytes)}).`);
  const preset = new URLSearchParams(location.search).get('q');
  if (preset) { $('q').value = preset; runSearch(preset); }
}

$('form').addEventListener('submit', (e) => { e.preventDefault(); runSearch($('q').value).catch((err) => status(String(err), true)); });
for (const b of document.querySelectorAll('.example')) {
  b.addEventListener('click', () => { $('q').value = b.textContent; runSearch(b.textContent).catch((err) => status(String(err), true)); });
}
main().catch((err) => status(String(err), true));
async function embedQuery(query) {
  const out = await embed(meta.model.query_prefix + query, { pooling: 'cls', normalize: true });
  return Array.from(out.data);
}
window.webcognee = { runSearch, showArticle, call, embedQuery };
