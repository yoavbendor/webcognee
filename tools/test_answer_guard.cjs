// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Yoav Bendor
//
// answer-guard.js on real cases: node tools/test_answer_guard.cjs
global.window = {}; require(require('path').join(__dirname, '..', 'answer-guard.js')); const g = window.answerGuard;
const aard = ['The aardvark is nocturnal and is a solitary creature that feeds almost exclusively on ants and termites',
  'In fact, the cucumber and the aardvark have a symbiotic relationship as they eat the subterranean fruit'];
const ari = ['In 343/42 BC, Aristotle was invited to Pella by Philip II of Macedon to become the tutor to his thirteen-year-old son Alexander; Aristotle was a Greek philosopher'];
const cases = [['What do armadillos eat', aard, true], ['What do armadillos eat in Africa', aard.concat(['Africa is large']), true],
  ['which philosopher tutored Alexander the Great', ari, false], ['an animal that eats termites at night', aard, false],
  ['What does the aardvark eat?', aard, false], ['which metal is refined from bauxite', ['Bauxite is refined into alumina, then aluminium'], false]];
let bad = 0;
for (const [q, texts, want] of cases) { const r = g.check(q, texts); const ok = r.offTopic === want; if (!ok) bad++;
  console.log(ok ? 'ok  ' : 'FAIL', JSON.stringify(q), 'terms', r.terms, 'missing', r.missing, 'offTopic', r.offTopic); }
process.exit(bad ? 1 : 0);
