# webcognee

Your own knowledge, searchable in your pocket: semantic search and (next) a graph of what links to what, running
**entirely in the browser** from static files. No server, no account; a phone on a cellular link is enough.

**Live:** https://yoavbendor.github.io/webcognee/

On GitHub Pages the page reads the tables through raw.githubusercontent.com. When a request accepts gzip, which
Safari and Firefox do, Pages' CDN answers byte-range requests with slices of the gzip-compressed file.

The first corpus is a **pocket Wikipedia**, the first 300 articles of the 2026-10-01 English dump, 6k passages.
The goal is your own chats (Cursor, Codex, Claude, WhatsApp), built into a cognee-style memory graph. Wikipedia
comes first because anyone can check it.

## How it works

```
offline (pipeline/build_wiki.py)                      in the browser (index.html)
───────────────────────────────                       ──────────────────────────────────────────────
Wikipedia dump prefix (bz2)                           question
 → pages → sections → ~150-word passages               → bge-small-en-v1.5, transformers.js (q8)
 → bge-small-en-v1.5 embeddings (fastembed)            → nearest IVF centroids (partitions.lance, in memory)
 → k-means: √n partitions; rows sorted by partition    → read those partitions' rows: a few HTTP Range
 → Lance tables, written with nanolance.lancedb           requests (nanolance WebAssembly, search-worker.js)
     chunks.lance      passages + float16 vectors      → exact cosine over them → top 10 passages
     partitions.lance  centroids + row ranges          → article panel: lead, categories, links in and out
     articles.lance    lead, categories, link graph       (articles.lance)
 → .lance-tree.json listings (static hosts list no directories)
```

- **Lance end to end.** The tables are plain Lance datasets, so pylance and LanceDB open them too. They are written
  by [nanolance](https://github.com/yoavbendor/nanolance) through `nanolance.lancedb`, its LanceDB-compatible API,
  and read in the page by nanolance's reader compiled to WebAssembly (`lib/weblance.wasm`, ~310 KB gzipped).
- **Serverless IVF.** Passages are stored sorted by partition, so one partition is one contiguous run of rows. A
  question reads only the nearest partitions (6 by default, changeable under *Search settings*): a few hundred KB,
  not the whole table. The page shows each question's request and byte count.
- **Same model on both sides.** Passages were embedded with `BAAI/bge-small-en-v1.5` (fastembed) and questions
  are embedded with its ONNX export `Xenova/bge-small-en-v1.5`, so both live in one vector space. `tools/test_page.cjs`
  checks that the two agree to cosine ≥ 0.98.

## Answers on the device

Under the results, **Answer from these passages** writes a short answer from the top passages (3 by default) with a
small instruct model, run by transformers.js in a module worker (`llm-worker.js`). Nothing leaves the browser.
- **Backend:** WebGPU when the browser has it (q4f16, or q4 without `shader-f16`); otherwise WebAssembly on the CPU (q8).
- **Models:** Qwen2.5-0.5B-Instruct by default (~480–510 MB) or SmolLM2-360M-Instruct (~270–365 MB). Either
  downloads once, on the first answer, and stays in the browser cache.
- **Sources:** small models cite unreliably, so the passages an answer was written from are always listed under it,
  linked to the numbered results. Any `[n]` the model writes is linked too.
- **Speed:** in this repository's sandbox (4 slow cores, no GPU) the WebAssembly path takes about 35 s to the first
  word and produces 0.6 tokens/s. A phone with WebGPU is much faster; that is the case the feature is for.

`node tools/test_answer.cjs <nanolance>/wasm/test/range_server.py` checks it end to end: search, download the model,
stream an answer that names the expected article, and list its sources.

## Build the corpus

```sh
pip install -r pipeline/requirements.txt          # nanolance: pip install -e <nanolance>/bindings/python
curl -r 0-50331647 -o head.xml.bz2 \
  https://dumps.wikimedia.org/other/mediawiki_content_current/enwiki/2026-10-01/xml/bzip2/enwiki-2026-10-01-p10p1113635.xml.bz2
python pipeline/build_wiki.py --dump head.xml.bz2 --articles 300 --out data/wiki
```

A prefix of a dump is enough: the parser stops at the cut. Embedding runs on the CPU. The current corpus took about
10 minutes on 4 slow cores; `--articles` and `--max-chunks` scale it.

## Test

```sh
node tools/test_page.cjs <nanolance>/wasm/test/range_server.py tools/expected.json
```

The test serves the repository over HTTP Range. Like GitHub Pages, it serves the static listings, not a directory
API. It drives the page in headless Chromium and checks:
- the page opens
- each sample question finds its article
- the browser's query embedding matches fastembed's
- the article panel loads

## Next

1. Follow-up questions in a conversation, and a smaller download for the answer model.
2. Your own chats as the corpus (Cursor/Codex/Claude/WhatsApp exports), built into a cognee memory graph with
   [cppognee](https://github.com/yoavbendor/cppognee) on nanolance. cognee's LanceDB adapter already runs unchanged
   on nanolance.
3. Analytics over the chats: when, what about, which model, and at what cost.

## Licenses

Code: Apache-2.0 ([LICENSE](LICENSE)). Wikipedia text and the tables derived from it: CC BY-SA 4.0.
Third-party components: [LICENSE-NOTICES.md](LICENSE-NOTICES.md).
