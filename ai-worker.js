// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Yoav Bendor
//
// The AI worker (a module worker): the query embedder and the answer model, both run by transformers.js in this one
// worker, so the page has a single onnxruntime and a single WebAssembly memory for them. (Before, the embedder ran
// on the page and the answer model in a second worker: two onnxruntime instances, two memories. On an iPhone 15 the
// answer then failed with "RangeError: Out of memory" whatever the model's size.) WebAssembly on the CPU by
// default; WebGPU only when asked for. Messages:
//   {type:'embed-load', model}                 -> {type:'embed-loaded'}
//   {type:'embed', id, text}                    -> {type:'embedded', id, vector}
//   {type:'load', model, webgpu, simulateOom}   -> {type:'progress', ...} while downloading, then {type:'loaded', ...}
//   {type:'ask', id, messages, maxTokens}       -> {type:'token', id, text} as the answer streams, then {type:'done', id}
// and {type:'stage', what, ...} for the debug log, each with this worker's WebAssembly memories.

import './memprobe.js?v=9';

const TRANSFORMERS = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/dist/transformers.min.js';

let T = null;
let embedder = null;
let generator = null;
let loaded = null;

function stage(what, fields) {
  self.postMessage({ type: 'stage', what, wasm: globalThis.wasmMem.line(), ...(fields || {}) });
}

async function transformers() {
  if (!T) {
    stage('transformers.import');
    T = await import(TRANSFORMERS);
    T.env.allowLocalModels = false;
    stage('transformers.imported', { version: T.env.version, onnx: JSON.stringify(T.env.backends.onnx.versions || {}) });
  }
  return T;
}

function progress(kind) {
  const tenths = {};
  return (p) => {
    if (p.status === 'progress') {
      if (p.file && /\.onnx/.test(p.file)) {
        self.postMessage({ type: 'progress', kind, file: p.file, loaded: p.loaded, total: p.total, progress: p.progress });
        const tenth = Math.floor((p.progress || 0) / 10);
        if (tenths[p.file] !== tenth) {
          tenths[p.file] = tenth;
          stage('download', { kind, file: p.file, pct: tenth * 10, loaded: p.loaded, total: p.total });
        }
      }
    } else if (p.status !== 'progress_total') {  // progress_total fires hundreds of times: not logged
      stage('file.' + p.status, { kind, file: p.file, name: p.name });
      // downloaded: next onnxruntime copies the weights into WebAssembly memory and builds the session
      if (p.status === 'done' && p.file && /\.onnx/.test(p.file)) stage('session.creating', { kind, file: p.file });
    }
  };
}

async function loadEmbedder(model) {
  await transformers();
  stage('embed.load', { model });
  embedder = await T.pipeline('feature-extraction', model, { dtype: 'q8', progress_callback: progress('embed') });
  stage('embed.loaded', { model });
  self.postMessage({ type: 'embed-loaded', model });
}

async function embed(m) {
  const out = await embedder(m.text, { pooling: 'cls', normalize: true });
  const vector = new Float32Array(out.data);
  self.postMessage({ type: 'embedded', id: m.id, vector, wasm: globalThis.wasmMem.line() }, [vector.buffer]);
}

async function pickDevice(webgpu) {
  if (!webgpu) return { device: 'wasm', dtype: 'q8' };
  try {
    const adapter = navigator.gpu && await navigator.gpu.requestAdapter();
    if (adapter) return { device: 'webgpu', dtype: adapter.features.has('shader-f16') ? 'q4f16' : 'q4' };
  } catch (e) { /* no WebGPU: WebAssembly below */ }
  return { device: 'wasm', dtype: 'q8' };
}

async function load(model, webgpu, simulateOom) {
  const key = model + (webgpu ? ' webgpu' : ' wasm');
  if (loaded === key) return;
  // test hook (?oom=<model> on the page): fail as an iPhone did, to exercise the step-down
  if (simulateOom === model) throw new RangeError('Out of memory (simulated for ' + model + ')');
  stage('load.begin', { model, webgpu, crossOriginIsolated: self.crossOriginIsolated,
    sab: typeof SharedArrayBuffer !== 'undefined', gpu: !!navigator.gpu });
  await transformers();
  const { device, dtype } = await pickDevice(webgpu);
  stage('device', { device, dtype });
  if (generator) {
    // one answer model at a time: the previous one's session is released before the next is built
    stage('previous.dispose');
    await generator.dispose();
    generator = null;
    loaded = null;
  }
  generator = await T.pipeline('text-generation', model, { device, dtype, progress_callback: progress('llm') });
  stage('session.created', { device, dtype });
  loaded = key;
  self.postMessage({ type: 'loaded', model, device, dtype });
}

async function ask(m) {
  const t0 = performance.now();
  let tokens = 0;
  stage('ask.begin', { promptChars: m.messages.reduce((a, x) => a + x.content.length, 0), maxTokens: m.maxTokens });
  const streamer = new T.TextStreamer(generator.tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (text) => {
      tokens++;
      if (tokens === 1) stage('ask.first', { ms: Math.round(performance.now() - t0) });
      else if (tokens % 25 === 0) stage('ask.tokens', { tokens, ms: Math.round(performance.now() - t0) });
      self.postMessage({ type: 'token', id: m.id, text });
    },
  });
  await generator(m.messages, { max_new_tokens: m.maxTokens, do_sample: false, repetition_penalty: 1.1, streamer });
  stage('ask.done', { tokens, ms: Math.round(performance.now() - t0) });
  self.postMessage({ type: 'done', id: m.id, ms: performance.now() - t0, tokens });
}

self.addEventListener('error', (e) => stage('uncaught', { msg: e.message, where: (e.filename || '') + ':' + e.lineno }));
self.addEventListener('unhandledrejection', (e) => stage('unhandled', { msg: String((e.reason && e.reason.message) || e.reason) }));
stage('worker.started');

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'embed-load') await loadEmbedder(m.model);
    else if (m.type === 'embed') await embed(m);
    else if (m.type === 'load') await load(m.model, !!m.webgpu, m.simulateOom);
    else if (m.type === 'ask') await ask(m);
  } catch (e) {
    stage('error', { op: m.type, error: String((e && e.message) || e), stack: String((e && e.stack) || '').slice(0, 300) });
    self.postMessage({ type: 'error', op: m.type, id: m.id, error: String((e && e.message) || e) });
  }
};
