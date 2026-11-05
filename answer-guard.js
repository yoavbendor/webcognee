// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Yoav Bendor
//
// A check before the answer model runs: a small model given passages about something else still answers from them
// (asked "What do armadillos eat?" over passages about aardvarks, it answered with the aardvark's diet). So the
// question's distinctive words -- 5 letters or more, not question or filler words -- must each appear in at least
// one passage. When none of them does, or the most specific one (the longest) does not, the passages are about
// something else, and the page says so instead of answering. Plural and possessive endings are folded ("armadillos" matches "armadillo").
(function () {
  'use strict';

  const SKIP = new Set(('about above after again against among another anyone anything around because been before ' +
    'being below between both could describe difference does doing during each either every explain from have having ' +
    'their there these thing things those through under until which while whose would what when where whom why with ' +
    'within without your yours known called used using often usually mean means much many most other others some such ' +
    'than that them then they this tell happen happened happens list name named kind kinds type types example').split(' '));

  function stem(word) {
    let w = word.toLowerCase().replace(/'s$/, '');
    if (w.length > 5 && w.endsWith('ies')) w = w.slice(0, -3) + 'y';
    else if (w.length > 5 && /(ches|shes|sses|xes|zes)$/.test(w)) w = w.slice(0, -2);
    else if (w.length > 4 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
    if (w.length > 6 && w.endsWith('ing')) w = w.slice(0, -3);
    else if (w.length > 5 && w.endsWith('ed')) w = w.slice(0, -2);
    return w;
  }

  function words(text) {
    return (String(text).toLowerCase().match(/[a-z0-9À-ɏ']+/g) || []).map(stem);
  }

  // The question's distinctive words (stemmed, deduplicated, in order).
  function keyTerms(query) {
    const out = [];
    for (const raw of String(query).toLowerCase().match(/[a-z0-9À-ɏ']+/g) || []) {
      if (raw.length < 5 || SKIP.has(raw)) continue;
      const s = stem(raw);
      if (!out.includes(s)) out.push(s);
    }
    return out;
  }

  // {terms, missing, offTopic}: the key terms, those no passage contains (as a word, or the start of one: "armadillo"
  // finds "armadillos'"), and whether the passages are about something else: every key term is missing, or the
  // longest one (7+ letters: usually the subject, "armadillos", "philosopher", "bauxite") is. Short generic words
  // ("animal", "night") alone do not count: passages often use a synonym ("nocturnal").
  function check(query, texts) {
    const terms = keyTerms(query);
    const seen = new Set();
    for (const t of texts) for (const w of words(t)) seen.add(w);
    const missing = terms.filter((term) => {
      if (seen.has(term)) return false;
      for (const w of seen) if (w.length > term.length && w.startsWith(term)) return false;
      return true;
    });
    const longest = terms.reduce((a, t) => (t.length > a.length ? t : a), '');
    const offTopic = terms.length > 0 &&
      (missing.length === terms.length || (longest.length >= 7 && missing.includes(longest)));
    return { terms, missing, offTopic };
  }

  window.answerGuard = { check, keyTerms, stem };
})();
