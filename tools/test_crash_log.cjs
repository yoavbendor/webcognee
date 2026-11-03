// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Yoav Bendor
//
// The crash log: crash the tab (chrome://crash) while the answer model loads, open the page again, and check the
// banner offers the report and the report holds the stages logged before the crash.
//   node tools/test_crash_log.cjs <range_server.py>
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');

(async () => {
  const srv = spawn('python3', [process.argv[2], path.resolve(__dirname, '..'), '0'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const port = await new Promise((r) => srv.stdout.on('data', (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) r(m[1]); }));
  const proxy = process.env.HTTPS_PROXY;
  const b = await chromium.launch(proxy ? { proxy: { server: proxy, bypass: '127.0.0.1' } } : {});
  const ctx = await b.newContext({ ignoreHTTPSErrors: true, permissions: ['clipboard-read', 'clipboard-write'] });
  const url = `http://127.0.0.1:${port}/index.html`;
  let failed = 0;
  const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) failed++; };
  try {
    const pg = await ctx.newPage();
    await pg.goto(url);
    await pg.waitForFunction(() => /^Ready/.test(document.getElementById('status').textContent), null, { timeout: 600000 });
    await pg.fill('#q', 'which philosopher tutored Alexander the Great');
    await pg.click('#go');
    await pg.waitForFunction(() => /passages ·/.test(document.getElementById('status').textContent), null, { timeout: 120000 });
    await pg.click('#ask');
    await pg.waitForFunction(() => /Downloading|Model ready|Answered/.test(document.getElementById('answer-stats').textContent),
      null, { timeout: 600000 });
    await pg.waitForTimeout(1500);
    await pg.goto('chrome://crash').catch(() => {});  // the renderer dies; no pagehide
    await pg.close().catch(() => {});
    const again = await ctx.newPage();
    await again.goto(url);
    await again.waitForSelector('.wl-banner:not([hidden])', { timeout: 30000 });
    check(true, 'banner shown after the crash: ' + (await again.textContent('.wl-banner')).slice(0, 60));
    const report = await again.evaluate(() => window.wlDebug.report());
    check(/\(CRASHED\)/.test(report), 'report has the crashed visit');
    check(/ai\.stage .*what=answer\.click/.test(report), 'report has the answer click');
    check(/ai\.(stage|progress) .*what=(load\.begin|download|file\.)/.test(report), 'report has model-load stages');
    check(/search q=/.test(report), 'report has the search');
    await again.click('.wl-banner button');  // Copy debug report
    await again.waitForTimeout(500);
    const clip = await again.evaluate(() => navigator.clipboard.readText().catch(() => ''));
    check(clip.startsWith('webcognee debug report'), 'Copy put the report on the clipboard (' + clip.length + ' chars)');
    console.log('--- report excerpt ---\n' + report.split('\n').filter((l) => /crashed|CRASHED|ai\.|search q=|webcognee 0|memory|WebAssembly/.test(l)).slice(0, 14).join('\n'));
  } finally {
    await b.close();
    srv.kill();
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
