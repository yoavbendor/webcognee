// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Yoav Bendor
//
// The search worker. Opens the three Lance tables of a pocket corpus with nanolance's WebAssembly reader (HTTP Range
// reads, no server code), keeps the IVF centroids in memory, and answers:
//   {type:'search', id, vector, k, nprobe}  -> the k nearest passages: the nprobe nearest partitions are contiguous
//                                              row runs of chunks.lance, read with wl_take_vectors, then ranked
//   {type:'article', id, article}            -> one article's row and the titles of the articles it links to
// Every reply carries the requests and bytes that call cost.

importScripts('lib/weblance.js');

let M = null;
const tables = {};
let partitions = null; // {centroids: Float32Array(P*dim), start: [], count: [], dim}

function post(msg, transfer) {
  self.postMessage(msg, transfer || []);
}

function utf8(s) {
  const n = M.lengthBytesUTF8(s) + 1;
  const p = M._malloc(n);
  M.stringToUTF8(s, p, n);
  return p;
}

function takeText(ptr) {
  if (!ptr) return null;
  const text = M.UTF8ToString(ptr);
  M._wl_free(ptr);
  return text;
}

function lastError() {
  return M.ccall('wl_error', 'string', [], []) || 'unknown error';
}

function takeStats() {
  const s = JSON.parse(takeText(M.ccall('wl_stats_json', 'number', [], [])));
  M.ccall('wl_reset_stats', null, [], []);
  return { requests: s.requests, bytes: s.bytes, ms: s.ms };
}

function open(url) {
  const p = utf8(url);
  const h = M.ccall('wl_open', 'number', ['number'], [p]);
  M._free(p);
  if (!h) throw new Error('opening ' + url + ': ' + lastError());
  return h;
}

function withRows(rows, fn) {
  const p = M._malloc(rows.length * 8);
  const view = new BigInt64Array(M.HEAPU8.buffer, p, rows.length);
  for (let i = 0; i < rows.length; i++) view[i] = BigInt(rows[i]);
  try {
    return fn(p);
  } finally {
    M._free(p);
  }
}

function takeJson(table, rows, columns) {
  if (!rows.length) return [];
  return withRows(rows, (rp) => {
    const cp = utf8(columns.join(','));
    const text = takeText(M.ccall('wl_take_json', 'number', ['number', 'number', 'number', 'number'],
      [tables[table], rp, rows.length, cp]));
    M._free(cp);
    if (text === null) throw new Error('wl_take_json: ' + lastError());
    return JSON.parse(text);
  });
}

function takeVectors(table, rows, column) {
  return withRows(rows, (rp) => {
    const cp = utf8(column);
    const dimPtr = M._malloc(4);
    const vp = M._wl_take_vectors(tables[table], rp, rows.length, cp, dimPtr);
    const dim = new Int32Array(M.HEAPU8.buffer, dimPtr, 1)[0];
    M._free(cp);
    M._free(dimPtr);
    if (!vp) throw new Error('wl_take_vectors: ' + lastError());
    const out = new Float32Array(M.HEAPU8.buffer, vp, rows.length * dim).slice();
    M._wl_free(vp);
    return { vectors: out, dim };
  });
}

function range(n) {
  return Array.from({ length: n }, (_, i) => i);
}

async function init(base) {
  const t0 = performance.now();
  M = await createWeblance({ locateFile: (p) => 'lib/' + p,
    onAbort: (what) => post({ type: 'abort', what: String(what) }) });
  for (const name of ['articles', 'chunks', 'partitions']) tables[name] = open(base + name + '.lance');
  const info = JSON.parse(takeText(M.ccall('wl_info_json', 'number', ['number'], [tables.partitions])));
  const n = info.rows;
  const rows = range(n);
  const meta = takeJson('partitions', rows, ['start', 'count']);
  const { vectors, dim } = takeVectors('partitions', rows, 'centroid');
  partitions = { centroids: vectors, dim, start: meta.map((r) => Number(r.start)), count: meta.map((r) => Number(r.count)) };
  return { ms: performance.now() - t0, partitions: n, stats: takeStats() };
}

function nearest(scores, k) {
  const idx = range(scores.length);
  idx.sort((a, b) => scores[b] - scores[a]);
  return idx.slice(0, k);
}

function dotAll(q, vectors, dim) {
  const n = vectors.length / dim;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const o = i * dim;
    for (let j = 0; j < dim; j++) s += q[j] * vectors[o + j];
    out[i] = Number.isNaN(s) ? -Infinity : s;
  }
  return out;
}

function search(m) {
  const t0 = performance.now();
  const q = m.vector;
  const P = partitions;
  const probe = nearest(dotAll(q, P.centroids, P.dim), m.nprobe);
  const rows = [];
  for (const p of probe) for (let r = P.start[p]; r < P.start[p] + P.count[p]; r++) rows.push(r);
  const { vectors, dim } = takeVectors('chunks', rows, 'vector');
  const scores = dotAll(q, vectors, dim);
  const top = nearest(scores, m.k);
  const hitRows = top.map((i) => rows[i]);
  const hits = takeJson('chunks', hitRows, ['article_id', 'title', 'section', 'text']);
  hits.forEach((h, i) => { h.score = scores[top[i]]; h.row = hitRows[i]; });
  return { hits, scanned: rows.length, probed: probe.length, ms: performance.now() - t0 };
}

function article(id) {
  const [a] = takeJson('articles', [id], ['id', 'title', 'url', 'lead', 'categories', 'links', 'n_links', 'n_inlinks']);
  const ids = a.links ? a.links.split(',').map(Number) : [];
  const linked = takeJson('articles', ids, ['id', 'title']);
  return { article: a, linked };
}

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'init') {
      const r = await init(m.base);
      post({ type: 'init', ok: true, ...r });
    } else if (m.type === 'search') {
      const r = search(m);
      post({ type: 'search', id: m.id, ok: true, ...r, stats: takeStats() });
    } else if (m.type === 'article') {
      const r = article(m.article);
      post({ type: 'article', id: m.id, ok: true, ...r, stats: takeStats() });
    }
  } catch (e) {
    post({ type: m.type, id: m.id, ok: false, error: String((e && e.message) || e), stats: M ? takeStats() : null });
  }
};
