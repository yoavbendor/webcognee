// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Yoav Bendor
//
// Counts the WebAssembly memories of this context (the page, or a worker) and their sizes, for the debug log. A plain
// script with no imports or exports, so it loads with <script>, importScripts() and a side-effect import alike.
// It wraps WebAssembly.instantiate / instantiateStreaming / Instance / Memory to see every memory a module creates or
// exports. Safari reserves a large address range for each memory, so their number matters as much as their size.
(function () {
  'use strict';
  if (globalThis.wasmMem) return;
  const W = globalThis.WebAssembly;
  const seen = [];  // {name, memory, peak}

  function note(memory, name) {
    if (!memory || !(memory instanceof W.Memory) || seen.some((s) => s.memory === memory)) return;
    seen.push({ name: name || 'memory' + (seen.length + 1), memory, peak: memory.buffer.byteLength });
  }

  function noteExports(instance, name) {
    if (!instance || !instance.exports) return;
    for (const v of Object.values(instance.exports)) note(v, name);
  }

  function guessName(source) {
    try {
      const url = source && (source.url || (source instanceof Request && source.url));
      if (url) return url.split('/').pop().split('?')[0];
    } catch (e) { /* not a Response */ }
    return undefined;
  }

  const origInstantiate = W.instantiate;
  W.instantiate = function (source, imports) {
    if (imports) for (const mod of Object.values(imports)) for (const v of Object.values(mod || {})) note(v);
    return origInstantiate.apply(this, arguments).then((r) => {
      noteExports(r.instance || r);
      return r;
    });
  };
  if (W.instantiateStreaming) {
    const origStreaming = W.instantiateStreaming;
    W.instantiateStreaming = function (source, imports) {
      if (imports) for (const mod of Object.values(imports)) for (const v of Object.values(mod || {})) note(v);
      return Promise.resolve(source).then((resp) => {
        const name = guessName(resp);
        return origStreaming.call(this, resp, imports).then((r) => {
          noteExports(r.instance, name);
          return r;
        });
      });
    };
  }
  const OrigMemory = W.Memory;
  W.Memory = function (desc) {
    const m = new OrigMemory(desc);
    note(m, 'Memory(initial=' + (desc && desc.initial) + ',max=' + (desc && desc.maximum) + (desc && desc.shared ? ',shared' : '') + ')');
    return m;
  };
  W.Memory.prototype = OrigMemory.prototype;

  globalThis.wasmMem = {
    // [{name, mb, peakMb}] of every memory seen in this context, and their total
    snapshot() {
      const list = seen.map((s) => {
        const b = s.memory.buffer.byteLength;
        if (b > s.peak) s.peak = b;
        return { name: s.name, mb: Math.round(b / 1048576), peakMb: Math.round(s.peak / 1048576) };
      });
      return { count: list.length, totalMb: list.reduce((a, x) => a + x.mb, 0), list };
    },
    // one line for the log: "2 memories, 412 MB: ort-wasm-simd.wasm 390/390, weblance.wasm 22/22"
    line() {
      const s = this.snapshot();
      return s.count + ' memories, ' + s.totalMb + ' MB' + (s.count ? ': ' + s.list.map((x) => x.name + ' ' + x.mb + '/' + x.peakMb).join(', ') : '');
    },
  };
})();
