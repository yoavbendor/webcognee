// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Yoav Bendor
//
// The answering worker (a module worker): a small instruct model run by transformers.js on this device --
// WebAssembly on the CPU by default; WebGPU only when asked for (on an iPhone 15 it was no faster, often slower).
// Messages:
//   {type:'load', model, webgpu}         -> {type:'progress', ...} while downloading, then {type:'loaded', device}
//   {type:'ask', id, messages, maxTokens}  -> {type:'token', id, text} as the answer streams, then {type:'done', id}

const TRANSFORMERS = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/dist/transformers.min.js';

let T = null;

// Stages reach the page's debug log (workers cannot write localStorage); the page stores them at once, so the
// last stage before a crash survives it.
function stage(what, fields) {
  self.postMessage({ type: 'stage', what, ...(fields || {}) });
}
let generator = null;
let loaded = null;

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
  if (!T) {
    stage('transformers.import');
    T = await import(TRANSFORMERS);
    stage('transformers.imported');
  }
  const { device, dtype } = await pickDevice(webgpu);
  stage('device', { device, dtype, wasmThreads: T.env.backends.onnx.wasm && T.env.backends.onnx.wasm.numThreads });
  const tenths = {};
  generator = await T.pipeline('text-generation', model, {
    device, dtype,
    progress_callback: (p) => {
      // initiate / download / progress / done per file, then ready: every step but the progress ticks is logged,
      // and the ticks of the model file each 10%
      if (p.status === 'progress') {
        if (p.file && /\.onnx/.test(p.file)) {
          self.postMessage({ type: 'progress', file: p.file, loaded: p.loaded, total: p.total, progress: p.progress });
          const tenth = Math.floor((p.progress || 0) / 10);
          if (tenths[p.file] !== tenth) { tenths[p.file] = tenth; stage('download', { file: p.file, pct: tenth * 10, loaded: p.loaded, total: p.total }); }
        }
      } else {
        stage('file.' + p.status, { file: p.file, name: p.name });
        // the model is downloaded; next onnxruntime copies it into WebAssembly memory and builds the session --
        // the step most likely to run out of memory on a phone
        if (p.status === 'done' && p.file && /\.onnx/.test(p.file)) stage('session.creating', { file: p.file });
      }
    },
  });
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
    if (m.type === 'load') await load(m.model, !!m.webgpu, m.simulateOom);
    else if (m.type === 'ask') await ask(m);
  } catch (e) {
    stage('error', { op: m.type, error: String((e && e.message) || e), stack: String((e && e.stack) || '').slice(0, 300) });
    self.postMessage({ type: 'error', id: m.id, error: String((e && e.message) || e) });
  }
};
