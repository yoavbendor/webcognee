// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Yoav Bendor
//
// Drives the live page in headless Chromium against a local HTTP Range server (nanolance's wasm/test/range_server.py,
// which serves the repository root). The index is read locally; the text of each result comes from en.wikipedia.org.
//   node tools/test_live.cjs <range_server.py> [query]
// Without a query, three questions whose answers are in data/wiki-small are run (the page is opened with
// ?data=data/wiki-small/). Checks, per question: the expected article is in the top 5; at least 3 results show live
// text (not the placeholder or a failure); the article panel loads its lead. Reports the anchor match rate, the
// Wikipedia requests and bytes, and every HTTP 429 seen. Exit codes: 0 all checks passed, 1 a check failed,
// 3 Wikipedia throttled the run (429s, too few live texts): reported as such, not as a page failure.
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');

const [server, customQuery] = process.argv.slice(2);
const root = path.resolve(__dirname, '..');
const DEFAULT = [
  { q: 'which philosopher tutored Alexander the Great', title: 'Aristotle' },
  // Either title answers it: in the 10,000-article bundle the more specific article wins (exact search agrees)
  { q: 'which metal is refined from bauxite', title: ['Aluminium', 'Bauxite'] },
  { q: 'an animal that eats termites at night', title: ['Aardvark', 'Aardwolf'] },
];
const CASES = customQuery ? [{ q: customQuery, title: null }] : DEFAULT;
const MIN_LIVE = 3;
const TRACE = !!process.env.TRACE;  // TRACE=1 prints each step
const step = (what) => { if (TRACE) console.log('trace', new Date().toISOString().slice(11, 19), what); };

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
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log('console:', m.text()); });

  // Counted on the wire, independently of the page's own counters.
  const wire = { requests: 0, throttled: 0, other: 0 };
  page.on('request', (r) => { if (r.url().startsWith('https://en.wikipedia.org/')) wire.requests++; });
  page.on('response', (r) => {
    if (!r.url().startsWith('https://en.wikipedia.org/')) return;
    if (r.status() === 429) wire.throttled++;
    else if (r.status() !== 200) wire.other++;
  });

  let failed = 0;
  let throttledRun = false;
  const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) failed++; };
  let totalLive = 0;
  let totalLocated = 0;
  let totalAnswered = 0;
  try {
    await page.goto(`http://127.0.0.1:${srv.port}/live.html?data=${process.env.LIVE_DATA || "data/wiki-small/"}`);
    await page.waitForFunction(() => /^Ready|error|Error/.test(document.getElementById('status').textContent),
      null, { timeout: 600000 });
    const ready = await page.textContent('#status');
    check(ready.startsWith('Ready'), 'page ready: ' + ready);
    for (const c of CASES) {
      const before = await page.textContent('#status');
      step('fill and click: ' + c.q);
      await page.fill('#q', c.q);
      await page.click('#go');
      step('clicked');
      await page.waitForFunction((prev) => /passages ·/.test(document.getElementById('status').textContent) &&
        document.getElementById('status').textContent !== prev, before, { timeout: 120000 });
      step('index answered');
      const t0 = Date.now();
      const settledOk = await Promise.race([
        page.evaluate(() => window.webcognee.settled()).then(() => true),
        new Promise((r) => setTimeout(() => r(false), 240000)),
      ]);
      check(settledOk, `"${c.q}": the live texts and the edit check settled within 4 min`);
      const secs = Math.round((Date.now() - t0) / 1000);
      const hits = await page.$$eval('.hit', (lis) => lis.map((li) => ({
        state: li.dataset.state,
        match: li.dataset.match,
        title: li.querySelector('.title') ? li.querySelector('.title').textContent : '',
        text: (li.querySelector('.live, .failed, .placeholder') || { textContent: '' }).textContent,
        oldid: Array.from(li.querySelectorAll('a')).some((a) => /oldid=\d+/.test(a.href)),
        edited: li.querySelector('.badge') ? li.querySelector('.badge').textContent : '',
      })));
      const titles = hits.map((h) => h.title);
      const live = hits.filter((h) => h.state === 'live' || h.state === 'unlocated');
      const located = hits.filter((h) => h.state === 'live');
      const failedHits = hits.filter((h) => h.state === 'failed');
      const pending = hits.filter((h) => h.state === 'pending');
      totalLive += live.length;
      totalLocated += located.length;
      console.log(`\n"${c.q}" (${secs} s after the index answered)`);
      console.log('  top 5: ' + JSON.stringify(titles.slice(0, 5)));
      console.log(`  live text: ${live.length} of ${hits.length} (located ${located.length}, unlocated ${live.length - located.length}), ` +
        `failed ${failedHits.length}, pending ${pending.length}`);
      const anchorTotal = live.length;
      console.log(`  anchor match rate: ${anchorTotal ? (located.length / anchorTotal * 100).toFixed(0) + '%' : 'n/a'} ` +
        `(${located.map((h) => h.match).join(', ') || 'none'})`);
      const edited = hits.filter((h) => h.edited);
      console.log(`  later edits: ${edited.length} of ${hits.length} results (${[...new Set(edited.map((h) => h.edited.split(' \u2014')[0]))].join('; ') || 'none'})`);
      console.log('  first live text: ' + JSON.stringify((live[0] || { text: '' }).text.slice(0, 160)));
      if (c.title) {
        const want = [].concat(c.title);
        check(want.some((t) => titles.slice(0, 5).includes(t)), `"${c.q}": top 5 has ${want.map((t) => `"${t}"`).join(' or ')}`);
      }
      check(live.length >= MIN_LIVE, `"${c.q}": ${live.length} results show live text (need ${MIN_LIVE})`);
      check(hits.every((h) => h.oldid), `"${c.q}": every result links to its pinned revision`);
      check(pending.length === 0, `"${c.q}": no result still waiting`);
      if (failedHits.length) console.log('  failures: ' + failedHits.map((h) => h.text.trim()).join(' | '));
      const net = await page.textContent('#wiki-status');
      console.log('  ' + net);
      const note = await page.evaluate(() => { const n = document.getElementById('wiki-note'); return n.hidden ? '' : n.textContent; });
      if (note) console.log('  note: ' + note);
      if (live.length < MIN_LIVE && wire.throttled) throttledRun = true;
      if (CASES.indexOf(c) === 0) {
        // the article panel: the lead of the pinned revision, fetched live
        await page.click('.hit .title');
        await page.waitForSelector('#article:not([hidden]) h2', { timeout: 60000 });
        await page.waitForFunction(() => {
          const l = document.querySelector('#article .lead, #article .failed');
          return !!l;
        }, null, { timeout: 120000 });
        const lead = await page.textContent('#article .lead, #article .failed');
        const isLead = await page.$('#article .lead') !== null;
        check(isLead && lead.length > 100, `article panel: lead of ${lead.length} characters, live`);
        console.log('  lead: ' + JSON.stringify(lead.slice(0, 120)));
      }
      totalAnswered++;
    }
  } finally {
    await browser.close();
    srv.p.kill();
  }
  const gets = (srv.log().match(/^GET /mg) || []).length;
  console.log(`\nWikipedia on the wire: ${wire.requests} requests, ${wire.throttled} HTTP 429, ${wire.other} other non-200`);
  console.log(`range server (local index): ${gets} GETs`);
  console.log(`live text across ${totalAnswered} questions: ${totalLive} results, ${totalLocated} located at the anchor`);
  if (failed && throttledRun) {
    console.log(`RESULT: Wikipedia throttled this run (${wire.throttled} HTTP 429); live text was not verified (${failed} check(s) failed)`);
    process.exit(3);
  }
  if (wire.throttled) console.log(`note: Wikipedia answered ${wire.throttled} HTTP 429 during this run (retried)`);
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
