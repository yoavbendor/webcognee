// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Yoav Bendor
//
// The answering worker (a module worker): a small instruct model run by transformers.js on this device -- WebGPU
// when the browser has it, WebAssembly otherwise. Messages:
//   {type:'load', model}                   -> {type:'progress', ...} while downloading, then {type:'loaded', device}
//   {type:'ask', id, messages, maxTokens}  -> {type:'token', id, text} as the answer streams, then {type:'done', id}

const TRANSFORMERS = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/dist/transformers.min.js';

let T = null;
let generator = null;
let loaded = null;

async function pickDevice() {
  try {
    const adapter = navigator.gpu && await navigator.gpu.requestAdapter();
    if (adapter) return { device: 'webgpu', dtype: adapter.features.has('shader-f16') ? 'q4f16' : 'q4' };
  } catch (e) { /* no WebGPU: WebAssembly below */ }
  return { device: 'wasm', dtype: 'q8' };
}

async function load(model) {
  if (loaded === model) return;
  T = T || await import(TRANSFORMERS);
  const { device, dtype } = await pickDevice();
  generator = await T.pipeline('text-generation', model, {
    device, dtype,
    progress_callback: (p) => {
      if (p.status === 'progress' && p.file && /\.onnx/.test(p.file)) {
        self.postMessage({ type: 'progress', file: p.file, loaded: p.loaded, total: p.total, progress: p.progress });
      }
    },
  });
  loaded = model;
  self.postMessage({ type: 'loaded', model, device, dtype });
}

async function ask(m) {
  const t0 = performance.now();
  let tokens = 0;
  const streamer = new T.TextStreamer(generator.tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (text) => { tokens++; self.postMessage({ type: 'token', id: m.id, text }); },
  });
  await generator(m.messages, { max_new_tokens: m.maxTokens, do_sample: false, repetition_penalty: 1.1, streamer });
  self.postMessage({ type: 'done', id: m.id, ms: performance.now() - t0, tokens });
}

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'load') await load(m.model);
    else if (m.type === 'ask') await ask(m);
  } catch (e) {
    self.postMessage({ type: 'error', id: m.id, error: String((e && e.message) || e) });
  }
};
