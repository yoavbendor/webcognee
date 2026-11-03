// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Yoav Bendor
//
// node tools/measure_memory.cjs <model> -- run from the repository root; needs nanolance's wasm/test/range_server.py at
// ../nanolance (edit the path below). The numbers behind MODELS / READY in app.js.
// For one answer model: the AI worker's WebAssembly memory at each stage (from the debug log), and the browser's total
// resident memory sampled every 200 ms (Linux ps over Chromium's processes), at its peak and at the end.
const { chromium } = require('playwright');
const { spawn, execSync } = require('child_process');
const model = process.argv[2];
function rssMB() {
  try {
    const out = execSync("ps -eo rss,args | grep -E 'chrom(e|ium)' | grep -v grep | awk '{s+=$1} END {print s}'").toString().trim();
    return Math.round(Number(out) / 1024);
  } catch (e) { return 0; }
}
(async () => {
  const srv = spawn('python3', ['/home/user/nanolance/wasm/test/range_server.py', '/home/user/webcognee', '0'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const port = await new Promise((r) => srv.stdout.on('data', (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) r(m[1]); }));
  const b = await chromium.launch({ proxy: { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1' } });
  const base = rssMB();
  const pg = await (await b.newContext({ ignoreHTTPSErrors: true })).newPage();
  await pg.goto(`http://127.0.0.1:${port}/index.html?q=${encodeURIComponent('which philosopher tutored Alexander the Great')}`);
  await pg.waitForFunction(() => /passages ·/.test(document.getElementById('status').textContent), null, { timeout: 600000 });
  const ready = rssMB();
  await pg.evaluate((m) => { document.getElementById('model').value = m; }, model);
  let peak = 0;
  const timer = setInterval(() => { peak = Math.max(peak, rssMB()); }, 200);
  await pg.click('#ask');
  await pg.waitForFunction(() => /^Answered|^Could not/.test(document.getElementById('answer-stats').textContent), null, { timeout: 1800000, polling: 2000 });
  clearInterval(timer);
  const end = rssMB();
  const report = await pg.evaluate(() => window.wlDebug.report());
  const wasm = (what) => { const l = report.split('\n').reverse().find((x) => x.includes('what=' + what)); const m = l && / (\d+) MB: /.exec(l); return m ? Number(m[1]) : null; };
  console.log(JSON.stringify({ model, answer: await pg.textContent('#answer'), browserBaselineMB: base, pageReadyMB: ready,
    peakMB: peak, afterAnswerMB: end, aiWasmAfterEmbedderMB: wasm('embed.loaded'), aiWasmAfterModelMB: wasm('session.created'),
    reportChars: report.length }));
  await b.close(); srv.kill();
})();
