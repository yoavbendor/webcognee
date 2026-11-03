// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Yoav Bendor
//
// The on-device answer, end to end in headless Chromium (WebAssembly: no GPU here): search, load the model, stream an
// answer, check it names the expected thing and lists the passages it came from.
//   node tools/test_answer.cjs <range_server.py> [model] [page query, e.g. oom=<model> to test the step-down]
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');

const [server, model, query] = process.argv.slice(2);
const root = path.resolve(__dirname, '..');
const CASES = [{ q: 'which philosopher tutored Alexander the Great', expect: /Aristotle/ }];

(async () => {
  const srv = spawn('python3', [server, root, '0'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const port = await new Promise((r) => srv.stdout.on('data', (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) r(m[1]); }));
  const proxy = process.env.HTTPS_PROXY;
  const b = await chromium.launch(proxy ? { proxy: { server: proxy, bypass: '127.0.0.1' } } : {});
  const pg = await (await b.newContext({ ignoreHTTPSErrors: true })).newPage();
  pg.on('pageerror', (e) => console.log('pageerror', e.message));
  let failed = 0;
  try {
    await pg.goto(`http://127.0.0.1:${port}/index.html${query ? '?' + query : ''}`);
    await pg.waitForFunction(() => /^Ready/.test(document.getElementById('status').textContent), null, { timeout: 600000 });
    if (model) await pg.evaluate((m) => { document.getElementById('model').value = m; }, model);  // inside closed <details>
    for (const c of CASES) {
      await pg.fill('#q', c.q);
      await pg.click('#go');
      await pg.waitForFunction(() => /passages ·/.test(document.getElementById('status').textContent), null, { timeout: 120000 });
      const t0 = Date.now();
      await pg.click('#ask');
      await pg.waitForFunction(() => /^Answered|^Could not/.test(document.getElementById('answer-stats').textContent),
        null, { timeout: 1800000, polling: 2000 });
      const text = await pg.textContent('#answer');
      const stats = await pg.textContent('#answer-stats');
      const cites = await pg.$$eval('#answer .cite, #answer-sources .cite', (e) => e.length);
      const ok = c.expect.test(text) && cites > 0;
      if (!ok) failed++;
      console.log('  model used:', await pg.inputValue('#model'));
      console.log(`${ok ? 'ok  ' : 'FAIL'} "${c.q}" in ${Math.round((Date.now() - t0) / 1000)} s\n  answer: ${text}\n  ${stats}\n  citations: ${cites}`);
    }
  } finally {
    await b.close();
    srv.kill();
  }
  console.log(failed ? `${failed} failed` : 'all checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
