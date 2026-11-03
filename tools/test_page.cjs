// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Yoav Bendor
//
// Drives the page in headless Chromium against a local HTTP Range server (nanolance's wasm/test/range_server.py,
// which serves the repository root; the page reads the static .lance-tree.json listings as on GitHub Pages).
//   node tools/test_page.cjs <range_server.py> <expected.json>
// expected.json: {"queries": [{"q": ..., "title": <a title expected in the top 5>, "vector": [query embedding
// from fastembed]}]}. Checks: the page opens, each query finds its title, the browser's query embedding matches
// fastembed's (cosine >= 0.98), and an article panel loads with its links. Prints each query's cost.
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const [server, expectedPath] = process.argv.slice(2);
const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
const root = path.resolve(__dirname, '..');

function startServer() {
  return new Promise((resolve, reject) => {
    const p = spawn('python3', [server, root, '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    p.stderr.on('data', (d) => { log += d; });
    p.stdout.on('data', (d) => {
      const m = /PORT (\d+)/.exec(String(d));
      if (m) resolve({ p, port: Number(m[1]), log: () => log });
    });
    p.on('exit', (c) => reject(new Error('server exited ' + c + '\n' + log)));
  });
}

(async () => {
  const srv = await startServer();
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const browser = await chromium.launch(proxy ? { proxy: { server: proxy, bypass: '127.0.0.1,localhost' } } : {});
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('console:', m.text()); });
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  let failed = 0;
  const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) failed++; };
  try {
    await page.goto(`http://127.0.0.1:${srv.port}/index.html`);
    await page.waitForFunction(() => /^Ready|error|Error/.test(document.getElementById('status').textContent),
      null, { timeout: 600000 });
    const ready = await page.textContent('#status');
    check(ready.startsWith('Ready'), 'page ready: ' + ready);
    for (const e of expected.queries) {
      const v = await page.evaluate((q) => window.webcognee.embedQuery(q), e.q);
      let dot = 0;
      for (let i = 0; i < v.length; i++) dot += v[i] * e.vector[i];
      check(dot >= 0.98, `"${e.q}": browser embedding vs fastembed cosine ${dot.toFixed(4)}`);
      await page.fill('#q', e.q);
      await page.click('#go');
      await page.waitForFunction(() => /passages ·/.test(document.getElementById('status').textContent), null,
        { timeout: 120000 });
      const titles = await page.$$eval('.hit .title', (els) => els.map((x) => x.textContent));
      const st = await page.textContent('#status');
      check(titles.slice(0, 5).includes(e.title), `"${e.q}": top 5 ${JSON.stringify(titles.slice(0, 5))} has "${e.title}"`);
      console.log('      ' + st);
    }
    await page.click('.hit .title');
    await page.waitForSelector('#article:not([hidden]) h2', { timeout: 60000 });
    const art = await page.textContent('#article h3');
    check(/Links to \d+ articles/.test(art), 'article panel: ' + art);
  } finally {
    await browser.close();
    srv.p.kill();
  }
  const gets = (srv.log().match(/^GET /mg) || []).length;
  console.log(`range server: ${gets} GETs`);
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
