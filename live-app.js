// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Yoav Bendor
//
// The live page. The index is on this device (live-search-worker.js reads the Lance tables by HTTP Range); the
// passage text is not. Each result's section is fetched from en.wikipedia.org at the revision that was indexed, and
// the passage is located in it by its anchor. The answer model (ai-worker.js: embedder and answer model in one worker)
// reads the fetched texts. Nothing is stored in the bundle but indexes and links.

const BUILD = { version: '0.1.0', date: '2026-11-05', note: 'passage text live from en.wikipedia.org at the indexed revisions' };

const D = window.wlDebug || { log() {}, span() { return () => {}; }, attachWorker() {}, mem() {}, showPanel() {} };
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

// Where the tables are read from: data/wiki10k/ next to this page, or the same repository's raw files on GitHub Pages
// (see app.js for why). `?data=<url>` overrides it.
function dataBase() {
  const override = params.get('data');
  if (override) return new URL(override, location.href).href;
  if (location.hostname.endsWith('.github.io')) {
    const owner = location.hostname.slice(0, -'.github.io'.length);
    const repo = location.pathname.split('/').filter(Boolean)[0];
    if (repo) return `https://raw.githubusercontent.com/${owner}/${repo}/main/data/wiki10k/`;
  }
  return new URL('data/wiki10k/', location.href).href;
}
const BASE = dataBase();

// ---------------------------------------------------------------------------------------------- the budget
// The same measurements as app.js (desktop Chromium, 2026-11-03): the answer model is the only large part.

const MODELS = {
  'HuggingFaceTB/SmolLM2-135M-Instruct': { fileMB: 137, wasmMB: 351, rssSteadyMB: 1180, rssPeakMB: 1510 },
  'HuggingFaceTB/SmolLM2-360M-Instruct': { fileMB: 365, wasmMB: 828, rssSteadyMB: 1550, rssPeakMB: 2050 },
  'onnx-community/Qwen2.5-0.5B-Instruct': { fileMB: 512, wasmMB: 1230, rssSteadyMB: 2000, rssPeakMB: 2600, estimated: true },
};
const READY = { readerWasmMB: 22, aiWasmMB: 104, rssMB: 600 };

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

const PHONE = /iPhone|iPad|iPod|Android|Mobile/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// ---------------------------------------------------------------------------------------------- the report

const latest = { searchWasm: '', searchWasmMb: 0, aiWasm: '', storage: '', model: '', device: '', stage: '' };

window.wlDebugContext = () => {
  const model = latest.model || ($('model') && $('model').value) || '';
  return [
    `webcognee live ${BUILD.version} (${BUILD.date}): ${BUILD.note}`,
    `data: ${BASE}${meta ? ` · ${meta.articles} articles, ${meta.passages} passages, built ${meta.built}` : ''}`,
    `wikipedia: ${net.requests} requests, ${net.bytes} bytes, ${net.throttled} HTTP 429, ${net.retries} retries, ${net.failed} failed`,
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
let last = null;  // {query, hits}: the results on screen

function track(m) {
  if (m && m.wasm) {
    latest.searchWasm = m.wasm;
    const mb = /, (\d+) MB/.exec(m.wasm);
    if (mb) latest.searchWasmMb = Number(mb[1]);
  }
}

const search = new Worker('live-search-worker.js?v=1');
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

let ai = null;
let aiModel = null;
const aiPending = new Map();
let embedReady = null;

function aiCall(msg, onToken) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    aiPending.set(id, { resolve, reject, onToken });
    ai.postMessage({ ...msg, id });
  });
}

function startAi() {
  D.log('ai.stage', { what: 'worker.create' });
  ai = new Worker('ai-worker.js?v=10', { type: 'module' });
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

// ---------------------------------------------------------------------------------------------- Wikipedia
// Every request to en.wikipedia.org goes through wikiGet: at most three at once, and on HTTP 429 or a network error
// a retry after 1, 2 and 4 s. Each request is logged (status, ms, bytes, retries) and counted in `net`, which the
// status line shows. Nothing else is sent to Wikipedia.

const WIKI = 'https://en.wikipedia.org/w/api.php';
const WIKI_HEADERS = { 'Api-User-Agent': 'webcognee/0.1 (https://github.com/yoavbendor/webcognee)' };
const RETRY_MS = [1000, 2000, 4000];
const WIKI_CONCURRENCY = 3;
const WIKI_TIMEOUT_MS = 30000;  // a request that has not answered (headers and body) by then is abandoned and retried
const net = { requests: 0, bytes: 0, ms: 0, throttled: 0, unreadable: 0, retries: 0, failed: 0 };
let pausedUntil = 0;  // after a refusal, no request starts before this time (Retry-After, or the schedule's wait)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let inFlight = 0;
const waiting = [];
function gate() {
  if (inFlight < WIKI_CONCURRENCY) { inFlight++; return Promise.resolve(); }
  return new Promise((resolve) => waiting.push(resolve));
}
function ungate() {
  const next = waiting.shift();
  if (next) next(); else inFlight--;  // the slot passes to the next waiter
}

class WikiError extends Error {}

async function wikiGet(query, what) {
  const url = WIKI + '?' + new URLSearchParams({ ...query, format: 'json', formatversion: '2', origin: '*' });
  await gate();
  try {
    for (let attempt = 0; ; attempt++) {
      const hold = pausedUntil - Date.now();
      if (hold > 0) await sleep(hold);
      const t0 = performance.now();
      let status = 0;
      let bytes = 0;
      let body = null;
      let problem = '';
      let network = false;
      let retryAfter = 0;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), WIKI_TIMEOUT_MS);
      try {
        const res = await fetch(url, { headers: WIKI_HEADERS, signal: ctl.signal });
        status = res.status;
        retryAfter = Number(res.headers.get('retry-after')) * 1000 || 0;
        const buf = await res.arrayBuffer();
        bytes = buf.byteLength;
        if (res.ok) body = new TextDecoder().decode(buf);
        else problem = `HTTP ${status}`;
      } catch (err) {
        network = true;
        problem = (ctl.signal.aborted ? `no answer in ${WIKI_TIMEOUT_MS / 1000} s` : 'network error: ' + ((err && err.message) || err));
      } finally {
        clearTimeout(timer);
      }
      const ms = performance.now() - t0;
      net.requests++;
      net.bytes += bytes;
      net.ms += ms;
      const throttled = status === 429;
      const retry = throttled || network;
      if (throttled) net.throttled++;
      // the browser hides the status of a response without CORS headers: such a refusal shows as a network error
      if (network) net.unreadable++;
      if (body !== null) {
        D.log('wiki.fetch', { what, status, ms: Math.round(ms), bytes, retries: attempt });
        updateWikiStatus();
        return JSON.parse(body);
      }
      if (!retry || attempt >= RETRY_MS.length) {
        net.failed++;
        D.log('wiki.fetch', { what, status: status || 'none', ms: Math.round(ms), bytes, retries: attempt, failed: problem });
        updateWikiStatus();
        throw new WikiError(throttled
          ? `Wikipedia throttled every try (HTTP 429, ${attempt} ${attempt === 1 ? 'retry' : 'retries'})`
          : `${problem}${attempt ? ` after ${attempt} ${attempt === 1 ? 'retry' : 'retries'}` : ''}`);
      }
      net.retries++;
      const wait = Math.max(RETRY_MS[attempt], retryAfter);
      pausedUntil = Math.max(pausedUntil, Date.now() + wait);
      D.log('wiki.retry', { what, status: status || 'none', attempt: attempt + 1, waitMs: wait, retryAfterMs: retryAfter,
        ms: Math.round(ms) });
      updateWikiStatus();
    }
  } finally {
    ungate();
  }
}

function apiData(d, what) {
  if (d.error) throw new WikiError(`Wikipedia answered "${d.error.code || d.error.info || 'error'}" for ${what}`);
  return d;
}

// The sections of pinned revisions, by (revid, section): the parsed HTML's heading and its words. Failed fetches are
// not kept, so a retry asks again.
const sections = new Map();
const DROP = '.mw-editsection, .reference, sup, table, .infobox, .navbox, .thumb, figure, style, .hatnote, .mw-empty-elt';

function readSection(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll(DROP).forEach((e) => e.remove());
  const h = doc.querySelector('h1, h2, h3, h4, h5, h6');
  const idEl = h && (h.id ? h : h.querySelector('[id]'));
  const heading = h ? { id: idEl ? idEl.id : '', text: h.textContent.replace(/\s+/g, ' ').trim() } : null;
  // leaf blocks only: a list item with a nested list would otherwise repeat the nested text
  const paras = Array.from(doc.querySelectorAll('p, li')).filter((e) => !e.querySelector('p, li'))
    .map((e) => e.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const tokens = paras.join(' ').split(' ').filter(Boolean);
  return { heading, tokens };
}

function section(revid, n) {
  const key = `${revid}:${n}`;
  if (!sections.has(key)) {
    const p = wikiGet({ action: 'parse', oldid: revid, section: n, prop: 'text' }, `section ${n} of revision ${revid}`)
      .then((d) => readSection(apiData(d, `section ${n} of revision ${revid}`).parse.text));
    p.catch(() => sections.delete(key));
    sections.set(key, p);
  }
  return sections.get(key);
}

// Words compare by letters and digits only, lowercased: punctuation and pronunciation brackets do not count.
const norm = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

// The window of the section's words that shares the most words with the anchor (the passage's first words), as a
// multiset overlap. Located only when at least half the anchor's words are in it.
function locate(tokens, anchor) {
  const at = anchor.split(/\s+/).filter(Boolean);
  const need = new Map();
  let total = 0;
  for (const w of at.map(norm)) if (w) { need.set(w, (need.get(w) || 0) + 1); total++; }
  const len = at.length;
  const norms = tokens.map(norm);
  const have = new Map();
  let score = 0;
  let best = -1;
  let bestAt = 0;
  const add = (w) => {
    if (!need.has(w)) return;
    const h = have.get(w) || 0;
    if (h < need.get(w)) score++;
    have.set(w, h + 1);
  };
  const drop = (w) => {
    if (!need.has(w)) return;
    const h = have.get(w) - 1;
    have.set(w, h);
    if (h < need.get(w)) score--;
  };
  for (let i = 0; i < norms.length; i++) {
    if (i >= len) drop(norms[i - len]);
    add(norms[i]);
    if (i >= len - 1 && score > best) { best = score; bestAt = i - len + 1; }
  }
  const matched = Math.max(best, 0);
  if (!total || best < 0 || best * 2 < total) return { ok: false, matched, total };
  return { ok: true, start: bestAt, matched, total };
}

// The live text of one result: the passage at its anchor in the pinned section, or the section's start when the anchor
// is not found there.
async function liveText(h) {
  const s = await section(h.revid, h.section);
  const loc = locate(s.tokens, h.anchor);
  const text = loc.ok ? s.tokens.slice(loc.start, loc.start + h.words).join(' ') : s.tokens.slice(0, 120).join(' ');
  return { heading: s.heading, text, located: loc.ok, matched: loc.matched, total: loc.total };
}

// ---------------------------------------------------------------------------------------------- the page

function status(text, error) {
  window.webcogneeStarted = true;  // the watchdog below stands down
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

function updateWikiStatus() {
  const parts = [`${net.requests} Wikipedia requests, ${kb(net.bytes)}, ${Math.round(net.ms)} ms`];
  if (net.retries) parts.push(`${net.retries} retries`);
  const line = $('wiki-status');
  line.textContent = 'Live from Wikipedia: ' + parts.join(' · ');
  const note = $('wiki-note');
  if (net.throttled) {
    note.hidden = false;
    note.textContent = `Wikipedia is throttling this network: it answered HTTP 429 ${net.throttled} time${net.throttled === 1 ? '' : 's'} ` +
      (net.unreadable ? `and ${net.unreadable} request${net.unreadable === 1 ? ' failed' : 's failed'} at the network level (a refusal without CORS headers hides its status, so some may be 429s) ` : '') +
      `in this visit. Requests wait for its Retry-After (or 1, 2 and 4 s) and retry up to three times; a text that is still refused is marked "not fetched", with a retry button.` +
      (net.failed ? ` ${net.failed} request${net.failed === 1 ? '' : 's'} gave up.` : '');
  } else if (net.unreadable) {
    note.hidden = false;
    note.textContent = `${net.unreadable} Wikipedia request${net.unreadable === 1 ? ' failed' : 's failed'} at the network level ` +
      '(a refusal without CORS headers looks the same: it may be HTTP 429). Requests are retried with backoff.' +
      (net.failed ? ` ${net.failed} request${net.failed === 1 ? '' : 's'} gave up.` : '');
  } else if (net.failed) {
    note.hidden = false;
    note.textContent = `${net.failed} Wikipedia request${net.failed === 1 ? '' : 's'} failed (see the debug log).`;
  }
}

function paintHit(h) {
  const li = h.el;
  li.dataset.state = h.state;
  li.dataset.match = h.total ? `${h.matched}/${h.total}` : '';
  const q = last ? last.query : '';
  const sectionName = h.section ? (h.heading ? h.heading.text : `section ${h.section}`) : '';
  let body;
  if (h.state === 'pending') {
    body = el('p', { class: 'placeholder' }, 'fetching from Wikipedia…');
  } else if (h.state === 'failed') {
    body = el('p', { class: 'failed' }, `Not fetched: ${h.error} `,
      el('button', { class: 'retry', onclick: () => retryHit(h) }, 'retry'));
  } else {
    body = el('p', { class: 'live' },
      h.located ? null : el('span', { class: 'fine' }, '(passage not located; section start shown) '),
      snippet(h.text, q));
  }
  const edited = h.edited ? el('p', { class: 'badge' }, h.edited + ' · ',
    el('a', { href: `https://en.wikipedia.org/?curid=${h.page_id}`, target: '_blank', rel: 'noopener' }, 'current page')) : null;
  const anchorHref = `https://en.wikipedia.org/w/index.php?oldid=${h.revid}` +
    (h.heading && h.heading.id ? '#' + encodeURIComponent(h.heading.id) : '');
  li.replaceChildren(
    el('span', { class: 'num' }, `[${h.n}] `),
    el('button', { class: 'title', onclick: () => showArticle(h.article) }, h.title),
    sectionName ? el('span', { class: 'section' }, ' › ' + sectionName) : null,
    body,
    edited,
    el('p', { class: 'meta' },
      el('span', { class: 'score' }, 'similarity ' + h.score.toFixed(3) + ' · '),
      el('a', { href: anchorHref, target: '_blank', rel: 'noopener' }, `revision ${h.revid}, this section on Wikipedia`)));
}

function renderResults(hits) {
  const list = $('results');
  list.replaceChildren();
  for (const h of hits) {
    h.el = el('li', { class: 'hit', id: 'hit-' + h.n, 'data-state': 'pending' });
    list.append(h.el);
    paintHit(h);
  }
}

// Fetches one result's live text and records it on the hit. Never rejects: `ready` settles once the hit has a state.
function fetchHit(h) {
  h.state = 'pending';
  h.ready = liveText(h).then((r) => {
    Object.assign(h, { state: r.located ? 'live' : 'unlocated', text: r.text, heading: r.heading, located: r.located,
      matched: r.matched, total: r.total });
    D.log('anchor', { n: h.n, title: h.title, section: h.section, located: r.located, matched: r.matched, of: r.total,
      words: h.words });
  }, (err) => {
    Object.assign(h, { state: 'failed', error: String((err && err.message) || err) });
    D.log('wiki.failed', { n: h.n, title: h.title, section: h.section, error: h.error });
  }).then(() => { paintHit(h); });
  return h.ready;
}

function retryHit(h) {
  sections.delete(`${h.revid}:${h.section}`);
  h.el.dataset.state = 'pending';
  fetchHit(h);
}

// One request for the hits' page ids: is the indexed revision still the current one?
async function checkEdits(hits) {
  const ids = [...new Set(hits.map((h) => h.page_id))];
  try {
    const d = apiData(await wikiGet({ action: 'query', prop: 'info', pageids: ids.join('|') }, 'edit check'), 'edit check');
    const byId = new Map();
    const byTitle = new Map();
    for (const p of d.query.pages) {
      if (p.pageid !== undefined) byId.set(Number(p.pageid), p);
      byTitle.set(p.title, p);
    }
    for (const h of hits) {
      const p = byId.get(Number(h.page_id)) || byTitle.get(h.title);
      if (!p || p.missing) h.edited = 'deleted or moved since indexing';
      else if (Number(p.lastrevid) !== Number(h.revid)) h.edited = 'edited since indexing — showing the indexed revision';
      else h.edited = null;
      if (h.el) paintHit(h);
    }
  } catch (err) {
    D.log('wiki.failed', { what: 'edit check', error: String((err && err.message) || err) });
    $('wiki-note').hidden = false;
    $('wiki-note').textContent = 'Could not check the results for later edits: ' + ((err && err.message) || err);
  }
}

let indexLine = '';

async function runSearch(query) {
  if (!query.trim()) return;
  const t0 = performance.now();
  status('Embedding the question…');
  const vector = await embed(meta.model.query_prefix + query);
  const t1 = performance.now();
  status('Searching the index on this device…');
  const nprobe = Number($('nprobe').value);
  const r = await call({ type: 'search', vector, k: 10, nprobe });
  D.log('search', { q: query, nprobe, embedMs: Math.round(t1 - t0), ms: Math.round(r.ms), scanned: r.scanned,
    req: r.stats.requests, bytes: r.stats.bytes, searchWasm: r.wasm, aiWasm: latest.aiWasm,
    top: r.hits[0] && r.hits[0].title });
  const hits = r.hits.map((h, i) => ({ ...h, n: i + 1, state: 'pending' }));
  last = { query, hits, edits: null };
  renderResults(hits);
  $('answer-box').hidden = false;
  $('answer').replaceChildren();
  $('answer-sources').replaceChildren();
  $('answer-stats').textContent = '';
  showBudget();
  for (const h of hits) fetchHit(h);
  last.edits = checkEdits(hits);
  indexLine = `${r.hits.length} passages · embedded in ${Math.round(t1 - t0)} ms · searched ${r.scanned} of ` +
    `${meta.passages} passages in ${r.probed} partitions, ${r.stats.requests} range requests, ${kb(r.stats.bytes)}, ` +
    `${Math.round(r.ms)} ms`;
  status(indexLine);
  if ($('auto-answer').checked) answer().catch((err) => answerError(err));
}

function showBudget() {
  const b = budget($('model').value);
  $('budget').replaceChildren(
    el('summary', {}, `Memory with this model: ~${(b.rss / 1024).toFixed(1)} GB, ~${(b.rssPeak / 1024).toFixed(1)} GB while it loads`),
    el('table', {}, el('tr', {}, el('th', {}, 'part'), el('th', {}, 'MB'), el('th', {}, 'loading')),
      ...b.rows.map((r) => el('tr', {}, el('td', {}, r[0]), el('td', {}, String(r[1])), el('td', {}, String(r[2])))),
      el('tr', {}, el('th', {}, 'WebAssembly total'), el('th', {}, String(b.wasm)), el('th', {}, String(b.wasmPeak))),
      el('tr', {}, el('th', {}, 'whole page, ready / with the model'), el('th', {}, String(b.readyRss)), el('th', {}, b.rss + ' / ' + b.rssPeak))),
    el('p', { class: 'fine' }, 'Measured in desktop Chromium; Safari differs, but in proportion. The debug log records ' +
      'the WebAssembly memory at every stage on this device.'));
}

// ---------------------------------------------------------------------------------------------- answers

const SYSTEM = 'You are a helpful assistant. Answer questions from the Wikipedia passages the user gives you, ' +
  'and cite the passage numbers you used, like [1].';

// passages: [{n, title, section, heading, text}]; the numbers are the results' numbers on the page.
function prompt(query, passages) {
  const context = passages.map((p) => `[${p.n}] (${p.title}${p.section ? ', ' + (p.heading ? p.heading.text : 'section ' + p.section) : ''}) ${p.text}`)
    .join('\n\n');
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

// The answer reads the live texts of the first N results, once they have arrived. A result that could not be fetched
// is left out and named; with none, there is nothing to answer from.
async function answer() {
  if (!last) return;
  D.log('ai.stage', { what: 'answer.click', model: $('model').value, webgpu: $('webgpu').checked });
  $('answer-stats').classList.remove('error');
  $('ask').disabled = true;
  try {
    const n = Number($('passages').value);
    const top = last.hits.slice(0, n);
    $('answer-stats').textContent = 'Waiting for the passages from Wikipedia…';
    await Promise.all(top.map((h) => h.ready));
    const usable = top.filter((h) => h.state === 'live' || h.state === 'unlocated');
    const skipped = top.length - usable.length;
    if (!usable.length) throw new Error('none of these passages could be fetched from Wikipedia');
    const asked = $('model').value;
    const model = await loadModelSteppingDown($('webgpu').checked);
    if (model !== asked) D.log('ai.stage', { what: 'stepped.down', from: asked, to: model });
    const messages = [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: prompt(last.query, usable) },
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
    $('answer-sources').replaceChildren('From ', ...usable.flatMap((h, i) => [
      i ? ', ' : '', el('a', { href: '#hit-' + h.n, class: 'cite' }, `[${h.n}] ${h.title}`)]));
    const secs = (r.ms - first) / 1000;
    $('answer-stats').textContent = `Answered on this device from passages ${usable.map((h) => h.n).join(', ')}` +
      (skipped ? ` (${skipped} not fetched from Wikipedia)` : '') + `: first words after ${(first / 1000).toFixed(1)} s, ` +
      `${r.tokens} pieces at ${secs > 0 ? (r.tokens / secs).toFixed(1) : '–'}/s.`;
    D.log('ai.stage', { what: 'answer.shown', tokens: r.tokens, firstMs: Math.round(first), aiWasm: latest.aiWasm });
  } finally {
    $('ask').disabled = false;
  }
}

// ---------------------------------------------------------------------------------------------- the article panel

async function showArticle(id) {
  const r = await call({ type: 'article', article: id });
  const a = r.article;
  const panel = $('article');
  const lead = el('p', { class: 'placeholder' }, 'fetching the lead from Wikipedia…');
  panel.replaceChildren(
    el('h2', {}, el('a', { href: a.url, target: '_blank', rel: 'noopener' }, a.title)),
    lead,
    a.categories ? el('p', { class: 'cats' }, a.categories.split('; ').slice(0, 12).join(' · ')) : null,
    el('h3', {}, `Links to ${a.n_links} articles here · linked from ${a.n_inlinks}`),
    el('div', { class: 'links' }, ...r.linked.map((l) => el('button', { onclick: () => showArticle(l.id) }, l.title))),
    el('p', { class: 'fine' }, `Indexed revision ${a.revid} · `,
      el('a', { href: `https://en.wikipedia.org/w/index.php?oldid=${a.revid}`, target: '_blank', rel: 'noopener' }, 'the indexed revision on Wikipedia'),
      ` · ${r.stats.requests} range requests, ${kb(r.stats.bytes)}`));
  panel.hidden = false;
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    const s = await section(a.revid, 0);
    lead.className = 'lead';
    lead.textContent = s.tokens.slice(0, 150).join(' ') + (s.tokens.length > 150 ? '…' : '');
  } catch (err) {
    lead.className = 'failed';
    lead.textContent = 'Not fetched: ' + ((err && err.message) || err);
  }
}

// ---------------------------------------------------------------------------------------------- start

async function main() {
  if (PHONE) $('model').value = 'HuggingFaceTB/SmolLM2-135M-Instruct';
  D.log('stage', { what: 'main.begin', build: `${BUILD.version} ${BUILD.date}`, base: BASE, phone: PHONE,
    model: $('model').value });
  $('build').textContent = `live ${BUILD.version} · ${BUILD.date}`;
  logStorage('start');
  status('Reading the corpus description…');
  const res = await fetch(BASE + 'meta.json');
  if (!res.ok) throw new Error(`${BASE}meta.json: HTTP ${res.status}. Build the bundle with pipeline/build_wiki_live.py, or pass ?data=<folder>.`);
  meta = await res.json();
  $('corpus').textContent = `${meta.articles} articles · ${meta.passages} passages · ${meta.links} links between them · ` +
    `text is fetched live from en.wikipedia.org at the revisions indexed ${meta.built}`;
  status('Opening the index and loading the embedding model…');
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
  status(`Ready. Index opened in ${Math.round(init.ms)} ms (${init.stats.requests} requests, ${kb(init.stats.bytes)}).`);
  logStorage('ready');
  const preset = params.get('q');
  if (preset) { $('q').value = preset; runSearch(preset).catch((err) => status(String(err), true)); }
}

$('show-debug').addEventListener('click', () => D.showPanel());
$('ask').addEventListener('click', () => answer().catch((err) => answerError(err)));
$('model').addEventListener('change', showBudget);
$('form').addEventListener('submit', (e) => { e.preventDefault(); runSearch($('q').value).catch((err) => status(String(err), true)); });
for (const b of document.querySelectorAll('.example')) {
  b.addEventListener('click', () => { $('q').value = b.textContent; runSearch(b.textContent).catch((err) => status(String(err), true)); });
}
updateWikiStatus();
main().catch((err) => status(String(err), true));

async function embedQuery(query) {
  return Array.from(await embed(meta.model.query_prefix + query));
}
// settled() resolves once the last search's live texts and edit check have arrived (the tests wait on it)
const settled = () => (last ? Promise.all([...last.hits.map((h) => h.ready), last.edits]).then(() => true) : Promise.resolve(true));
window.webcognee = { runSearch, showArticle, call, embedQuery, answer, budget, net, settled, wiki: { section, liveText, locate } };
