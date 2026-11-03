// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Yoav Bendor
//
// The page. Two workers do the work:
//   search-worker.js  nanolance's WebAssembly reader: the Lance tables, read by HTTP Range
//   ai-worker.js      transformers.js: the query embedder (bge-small-en-v1.5) and the answer model, sharing one
//                     onnxruntime and one WebAssembly memory
// The page itself runs no WebAssembly. Everything worth knowing about a crash goes to the debug log (debug.js).

const BUILD = { version: '0.9', date: '2026-11-03', note: 'one onnxruntime for embedder and answer; measured memory budget; small model on phones' };

const D = window.wlDebug || { log() {}, span() { return () => {}; }, attachWorker() {}, mem() {}, showPanel() {} };
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

// Where the tables are read from. On GitHub Pages, from the same repository through raw.githubusercontent.com:
// Pages' CDN answers a Range request with a slice of the gzip-compressed file whenever the browser accepts gzip
// (Safari and Firefox do), which breaks random access; raw.githubusercontent.com serves binary files as they are.
// `?data=<url>` overrides it (tests, other hosts).
function dataBase() {
  const override = params.get('data');
  if (override) return new URL(override, location.href).href;
  if (location.hostname.endsWith('.github.io')) {
    const owner = location.hostname.slice(0, -'.github.io'.length);
    const repo = location.pathname.split('/').filter(Boolean)[0];
    if (repo) return `https://raw.githubusercontent.com/${owner}/${repo}/main/data/wiki/`;
  }
  return new URL('data/wiki/', location.href).href;
}
const BASE = dataBase();

// ---------------------------------------------------------------------------------------------- the budget

// What the page holds in memory, in MB, measured in desktop Chromium (tools/measure_memory.cjs, 2026-11-03): the AI
// worker's WebAssembly memory after each step (the debug log's wasm= fields), and the browser's resident memory
// above what it used before the page opened. A WebAssembly memory never shrinks, and while a model loads its file
// is also held once as a JavaScript buffer. The answer model takes about 2.5x its file in WebAssembly memory.
const MODELS = {
  'HuggingFaceTB/SmolLM2-135M-Instruct': { fileMB: 137, wasmMB: 351, rssSteadyMB: 1180, rssPeakMB: 1510 },
  'HuggingFaceTB/SmolLM2-360M-Instruct': { fileMB: 365, wasmMB: 828, rssSteadyMB: 1550, rssPeakMB: 2050 },
  // not measured: 2.4x its file, as the two above
  'onnx-community/Qwen2.5-0.5B-Instruct': { fileMB: 512, wasmMB: 1230, rssSteadyMB: 2000, rssPeakMB: 2600, estimated: true },
};
const READY = { readerWasmMB: 22, aiWasmMB: 104, rssMB: 600 };  // page open, tables open, embedder loaded

function budget(model) {
  const m = MODELS[model] || { fileMB: 0, wasmMB: 0, rssSteadyMB: 0, rssPeakMB: 0 };
  const est = m.estimated ? ' (estimated)' : '';
  const rows = [
    ['Lance reader: search worker WebAssembly', latest.searchWasmMb || READY.readerWasmMB, latest.searchWasmMb || READY.readerWasmMB],
    ['onnxruntime + query embedder bge-small q8: AI worker WebAssembly', READY.aiWasmMB, READY.aiWasmMB],
    [`answer model ${model.split('/')[1]} q8 (${m.fileMB} MB file): AI worker WebAssembly${est}`, m.wasmMB, m.wasmMB + m.fileMB],
  ];
  const wasm = rows.reduce((a, r) => a + r[1], 0);
  return { rows, wasm, wasmPeak: rows.reduce((a, r) => a + r[2], 0), readyRss: READY.rssMB, rss: m.rssSteadyMB, rssPeak: m.rssPeakMB };
}

function budgetLines(model) {
  const b = budget(model);
  return ['memory budget for ' + model.split('/')[1] + ' (MB, measured in desktop Chromium; steady / while the model loads)']
    .concat(b.rows.map((r) => `  ${r[0]}: ${r[1]} / ${r[2]}`))
    .concat([`  WebAssembly total: ${b.wasm} / ${b.wasmPeak}`,
      `  whole page (browser memory above its baseline): ${b.readyRss} ready, ${b.rss} with the model / ${b.rssPeak} while it loads`]);
}

// Phones get the small answer model first: the 360M one needs ~1.6 GB, ~2 GB while loading, about what iOS allows
// one tab (it crashed an iPhone 15). Desktops get the 360M one.
const PHONE = /iPhone|iPad|iPod|Android|Mobile/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// ---------------------------------------------------------------------------------------------- the report

// The latest facts, for the report's header (debug.js calls wlDebugContext() when it builds the report).
const latest = { searchWasm: '', searchWasmMb: 0, aiWasm: '', storage: '', model: '', device: '', stage: '' };

window.wlDebugContext = () => {
  const model = latest.model || ($('model') && $('model').value) || '';
  return [
    `webcognee ${BUILD.version} (${BUILD.date}): ${BUILD.note}`,
    `data: ${BASE}${meta ? ` · ${meta.articles} articles, ${meta.chunks} passages, built ${meta.built}` : ''}`,
    `answer model: ${model || 'not chosen'}${latest.device ? ' on ' + latest.device : ''} · last AI stage: ${latest.stage || 'none'}`,
    `isolation: crossOriginIsolated=${self.crossOriginIsolated} SharedArrayBuffer=${typeof SharedArrayBuffer !== 'undefined'} ` +
      `WebGPU=${!!navigator.gpu} deviceMemoryGB=${navigator.deviceMemory || 'n/a'} cores=${navigator.hardwareConcurrency || 'n/a'}`,
    `storage: ${latest.storage || 'unknown'}`,
    `WebAssembly memories: search worker: ${latest.searchWasm || 'n/a'} · AI worker: ${latest.aiWasm || 'n/a'} · page: ` +
      (globalThis.wasmMem ? globalThis.wasmMem.line() : 'n/a'),
  ].concat(model ? budgetLines(model) : []);
};

async function logStorage(where) {
  try {
    const e = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
    if (e) latest.storage = `${Math.round(e.usage / 1048576)} MB used of ${Math.round(e.quota / 1048576)} MB`;
  } catch (err) {
    latest.storage = 'estimate failed: ' + err;
  }
  D.log('mem', { where, storage: latest.storage, jsMB: D.mem(), searchWasm: latest.searchWasm, aiWasm: latest.aiWasm });
}

// ---------------------------------------------------------------------------------------------- workers

const pending = new Map();
let nextId = 1;
let meta = null;
let last = null;

function track(m) {
  if (m && m.wasm) {
    latest.searchWasm = m.wasm;
    const mb = /, (\d+) MB/.exec(m.wasm);
    if (mb) latest.searchWasmMb = Number(mb[1]);
  }
}

const search = new Worker('search-worker.js?v=9');
D.attachWorker(search, 'search');
search.onerror = (e) => status('The search worker failed to start: ' + (e.message || 'unknown error'), true);
let initDone;
const initReady = new Promise((r) => { initDone = r; });
search.onmessage = (ev) => {
  const m = ev.data;
  track(m);
  if (m.type === 'abort') { status('The reader stopped: ' + m.what, true); return; }
  if (m.type === 'init') { initDone(m); return; }
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  if (m.ok) p.resolve(m); else p.reject(new Error(m.error));
};

function call(msg) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    search.postMessage({ ...msg, id });
  });
}

let ai = null;           // the AI worker: embedder + answer model
let aiModel = null;      // the answer model it has loaded
const aiPending = new Map();
let embedReady = null;   // resolves once the embedder is loaded

function aiCall(msg, onToken) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    aiPending.set(id, { resolve, reject, onToken });
    ai.postMessage({ ...msg, id });
  });
}

function startAi() {
  D.log('ai.stage', { what: 'worker.create' });
  ai = new Worker('ai-worker.js?v=9', { type: 'module' });
  D.attachWorker(ai, 'ai');
  ai.onerror = (e) => {
    const err = new Error('The AI worker failed to start: ' + (e.message || 'unknown'));
    D.log('ai.error', { error: err.message });
    for (const p of aiPending.values()) p.reject(err);
    aiPending.clear();
  };
  ai.onmessage = (ev) => {
    const m = ev.data;
    if (m.wasm) latest.aiWasm = m.wasm;
    if (m.type === 'stage') {
      const { type, ...fields } = m;
      latest.stage = m.what;
      D.log(m.what === 'download' ? 'ai.progress' : 'ai.stage', fields);
      if (m.what === 'session.creating') logStorage('before session ' + m.kind);
      return;
    }
    if (m.type === 'progress') {
      const mb = (n) => Math.round((n || 0) / 1e6);
      const text = `${mb(m.loaded)} of ${mb(m.total)} MB`;
      if (m.kind === 'embed') $('status').textContent = `Loading the embedding model (once, then cached): ${text}`;
      else $('answer-stats').textContent = `Downloading the answer model (once, then cached): ${text}`;
      return;
    }
    if (m.type === 'error') D.log('ai.error', { op: m.op, error: m.error });
    const key = m.type === 'embed-loaded' || (m.type === 'error' && m.op === 'embed-load') ? 'embed-load'
      : m.type === 'loaded' || (m.type === 'error' && m.op === 'load') ? 'load' : m.id;
    const p = aiPending.get(key);
    if (!p) return;
    if (m.type === 'token') { p.onToken(m.text); return; }
    aiPending.delete(key);
    if (m.type === 'error') p.reject(new Error(m.error)); else p.resolve(m);
  };
  embedReady = new Promise((resolve, reject) => aiPending.set('embed-load', { resolve, reject }));
  ai.postMessage({ type: 'embed-load', model: meta.model.queries });
}

// A worker whose WebAssembly memory could not grow keeps it: it is closed, and a new one starts clean.
function restartAi() {
  if (ai) ai.terminate();
  ai = null;
  aiModel = null;
  for (const p of aiPending.values()) p.reject(new Error('restarted'));
  aiPending.clear();
  startAi();
}

async function embed(text) {
  await embedReady;
  const r = await aiCall({ type: 'embed', text });
  return r.vector;
}

// ---------------------------------------------------------------------------------------------- the page

function status(text, error) {
  window.webcogneeStarted = true;  // the watchdog in index.html stands down
  D.log(error ? 'status.error' : 'status', { text });
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
  const vector = await embed(meta.model.query_prefix + query);
  const t1 = performance.now();
  status('Searching…');
  const nprobe = Number($('nprobe').value);
  const r = await call({ type: 'search', vector, k: 10, nprobe });
  D.log('search', { q: query, nprobe, embedMs: Math.round(t1 - t0), ms: Math.round(r.ms), scanned: r.scanned,
    req: r.stats.requests, bytes: r.stats.bytes, searchWasm: r.wasm, aiWasm: latest.aiWasm,
    top: r.hits[0] && r.hits[0].title });
  last = { query, hits: r.hits };
  const list = $('results');
  list.replaceChildren();
  r.hits.forEach((h, i) => {
    list.append(el('li', { class: 'hit', id: 'hit-' + (i + 1) },
      el('span', { class: 'num' }, `[${i + 1}] `),
      el('button', { class: 'title', onclick: () => showArticle(h.article_id) }, h.title),
      h.section ? el('span', { class: 'section' }, ' › ' + h.section) : null,
      el('p', {}, snippet(h.text, query)),
      el('span', { class: 'score' }, 'similarity ' + h.score.toFixed(3))));
  });
  $('answer-box').hidden = false;
  $('answer').replaceChildren();
  $('answer-sources').replaceChildren();
  $('answer-stats').textContent = '';
  showBudget();
  if ($('auto-answer').checked) answer().catch((err) => answerError(err));
  status(`${r.hits.length} passages · embedded in ${Math.round(t1 - t0)} ms · searched ${r.scanned} of ` +
    `${meta.chunks} passages in ${r.probed} partitions, ${r.stats.requests} range requests, ${kb(r.stats.bytes)}, ` +
    `${Math.round(r.ms)} ms`);
}

function showBudget() {
  const b = budget($('model').value);
  $('budget').replaceChildren(
    el('summary', {}, `Memory with this model: ~${(b.rss / 1024).toFixed(1)} GB, ~${(b.rssPeak / 1024).toFixed(1)} GB while it loads`),
    el('table', {}, el('tr', {}, el('th', {}, 'part'), el('th', {}, 'MB'), el('th', {}, 'loading')),
      ...b.rows.map((r) => el('tr', {}, el('td', {}, r[0]), el('td', {}, String(r[1])), el('td', {}, String(r[2])))),
      el('tr', {}, el('th', {}, 'WebAssembly total'), el('th', {}, String(b.wasm)), el('th', {}, String(b.wasmPeak))),
      el('tr', {}, el('th', {}, 'whole page, ready / with the model'), el('th', {}, String(b.readyRss)), el('th', {}, b.rss + ' / ' + b.rssPeak))),
    el('p', { class: 'fine' }, 'Measured in desktop Chromium; Safari differs, but in proportion. "Whole page" is ' +
      'the browser\'s memory above what it used before the page: the workers, compiled code, JavaScript and caches ' +
      'besides the WebAssembly heaps. The debug log records the WebAssembly memory at every stage on this device.'));
}

// ---------------------------------------------------------------------------------------------- answers

const SYSTEM = 'You are a helpful assistant. Answer questions from the Wikipedia passages the user gives you, ' +
  'and cite the passage numbers you used, like [1].';

// Small models follow a prompt that states the question before the passages and asks it again after them.
function prompt(query, hits) {
  const context = hits.map((h, i) => `[${i + 1}] (${h.title}${h.section ? ', ' + h.section : ''}) ${h.text}`).join('\n\n');
  return `Question: ${query}\n\nPassages:\n\n${context}\n\nUsing the passages above, answer the question ` +
    `"${query}" in one to three sentences, citing passages like [1]. If they do not answer it, say so.`;
}

async function loadModel(model, webgpu) {
  const key = model + (webgpu ? ' webgpu' : ' wasm');
  if (aiModel === key) return;
  $('answer-stats').textContent = 'Loading the model…';
  latest.model = model;
  const b = budget(model);
  D.log('ai.stage', { what: 'load.request', model, webgpu, expectWasmMB: b.wasm, expectPeakWasmMB: b.wasmPeak,
    expectPageMB: b.rss, expectPeakPageMB: b.rssPeak });
  const loaded = new Promise((resolve, reject) => aiPending.set('load', { resolve, reject }));
  ai.postMessage({ type: 'load', model, webgpu, simulateOom: params.get('oom') });
  const m = await loaded;
  latest.device = `${m.device} ${m.dtype}`;
  logStorage('model loaded');
  aiModel = key;
  $('answer-stats').textContent = `Model ready (${m.device === 'webgpu' ? 'WebGPU' : 'WebAssembly, CPU'}, ${m.dtype}).`;
}

function renderAnswer(text) {
  // [n] citations become links to the numbered results above
  const frag = document.createDocumentFragment();
  for (const part of text.split(/(\[\d+\])/)) {
    const m = /^\[(\d+)\]$/.exec(part);
    if (m && last && Number(m[1]) >= 1 && Number(m[1]) <= last.hits.length) {
      frag.append(el('a', { href: '#hit-' + m[1], class: 'cite' }, part));
    } else {
      frag.append(part);
    }
  }
  $('answer').replaceChildren(frag);
}

function answerError(err) {
  D.log('ai.error', { what: 'answer.failed', error: String((err && err.message) || err), aiWasm: latest.aiWasm });
  $('answer-stats').textContent = 'Could not answer: ' + ((err && err.message) || err);
  $('answer-stats').classList.add('error');
}

// Smaller models to step down to when one runs out of memory (an iPhone 15 could not load the 510 MB one).
const SMALLER = {
  'onnx-community/Qwen2.5-0.5B-Instruct': 'HuggingFaceTB/SmolLM2-360M-Instruct',
  'HuggingFaceTB/SmolLM2-360M-Instruct': 'HuggingFaceTB/SmolLM2-135M-Instruct',
};

function outOfMemory(err) {
  return /out of memory|RangeError|Aborted\(\)|memory access out of bounds|could not allocate/i.test(String((err && err.message) || err));
}

async function loadModelSteppingDown(webgpu) {
  for (;;) {
    const model = $('model').value;
    try {
      await loadModel(model, webgpu);
      return model;
    } catch (err) {
      const smaller = SMALLER[model];
      D.log('ai.error', { what: 'load.failed', model, oom: outOfMemory(err), next: smaller, aiWasm: latest.aiWasm,
        error: String((err && err.message) || err) });
      if (!outOfMemory(err) || !smaller) throw err;
      restartAi();
      $('model').value = smaller;
      showBudget();
      $('answer-stats').textContent = `${model.split('/')[1]} ran out of memory on this device; trying ${smaller.split('/')[1]}…`;
    }
  }
}

async function answer() {
  if (!last) return;
  D.log('ai.stage', { what: 'answer.click', model: $('model').value, webgpu: $('webgpu').checked });
  $('answer-stats').classList.remove('error');
  $('ask').disabled = true;
  try {
    const asked = $('model').value;
    const model = await loadModelSteppingDown($('webgpu').checked);
    if (model !== asked) D.log('ai.stage', { what: 'stepped.down', from: asked, to: model });
    const n = Number($('passages').value);
    const messages = [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: prompt(last.query, last.hits.slice(0, n)) },
    ];
    let text = '';
    $('answer').replaceChildren();
    const t0 = performance.now();
    let first = 0;
    const r = await aiCall({ type: 'ask', messages, maxTokens: 120 }, (t) => {
      if (!first) first = performance.now() - t0;
      text += t;
      renderAnswer(text);
    });
    // The passages the answer was written from, always shown: small models cite unreliably.
    $('answer-sources').replaceChildren('From ', ...last.hits.slice(0, n).flatMap((h, i) => [
      i ? ', ' : '', el('a', { href: '#hit-' + (i + 1), class: 'cite' }, `[${i + 1}] ${h.title}`)]));
    const secs = (r.ms - first) / 1000;
    $('answer-stats').textContent = `Answered on this device from passages 1–${n}: first words after ` +
      `${(first / 1000).toFixed(1)} s, ${r.tokens} pieces at ${secs > 0 ? (r.tokens / secs).toFixed(1) : '–'}/s.`;
    D.log('ai.stage', { what: 'answer.shown', tokens: r.tokens, firstMs: Math.round(first), aiWasm: latest.aiWasm });
  } finally {
    $('ask').disabled = false;
  }
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
  if (PHONE) $('model').value = 'HuggingFaceTB/SmolLM2-135M-Instruct';
  D.log('stage', { what: 'main.begin', build: `${BUILD.version} ${BUILD.date}`, base: BASE, phone: PHONE,
    model: $('model').value });
  $('build').textContent = `webcognee ${BUILD.version} · ${BUILD.date}`;
  logStorage('start');
  status('Reading the corpus description…');
  const res = await fetch(BASE + 'meta.json');
  if (!res.ok) throw new Error(`data/wiki/meta.json: HTTP ${res.status}`);
  meta = await res.json();
  $('corpus').textContent = `${meta.articles} articles · ${meta.chunks} passages · ${meta.links} links between them`;
  status('Opening the tables and loading the embedding model…');
  search.postMessage({ type: 'init', base: BASE });
  startAi();
  const endEmbed = D.span('stage', { what: 'embedder.load', model: meta.model.queries });
  const [init] = await Promise.all([initReady, embedReady.catch((err) => {
    throw new Error('Could not load the embedding model: ' + ((err && err.message) || err));
  })]);
  endEmbed({ aiWasm: latest.aiWasm });
  D.log('stage', { what: 'tables.open', ok: init.ok, ms: init.ms, req: init.stats && init.stats.requests,
    bytes: init.stats && init.stats.bytes, searchWasm: init.wasm });
  if (!init.ok) throw new Error(init.error);
  $('q').disabled = false;
  $('go').disabled = false;
  status(`Ready. Tables opened in ${Math.round(init.ms)} ms (${init.stats.requests} requests, ${kb(init.stats.bytes)}).`);
  logStorage('ready');
  const preset = params.get('q');
  if (preset) { $('q').value = preset; runSearch(preset); }
}

$('show-debug').addEventListener('click', () => D.showPanel());
$('ask').addEventListener('click', () => answer().catch((err) => answerError(err)));
$('model').addEventListener('change', showBudget);
$('form').addEventListener('submit', (e) => { e.preventDefault(); runSearch($('q').value).catch((err) => status(String(err), true)); });
for (const b of document.querySelectorAll('.example')) {
  b.addEventListener('click', () => { $('q').value = b.textContent; runSearch(b.textContent).catch((err) => status(String(err), true)); });
}
main().catch((err) => status(String(err), true));

async function embedQuery(query) {
  return Array.from(await embed(meta.model.query_prefix + query));
}
window.webcognee = { runSearch, showArticle, call, embedQuery, answer, budget };
