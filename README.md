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
small instruct model, run by transformers.js in a module worker (`ai-worker.js`). The same worker embeds the questions. Nothing leaves the browser.
- **Backend:** WebAssembly on the CPU (q8) by default. On an iPhone 15, WebGPU was no faster and often slower, so it is an opt-in under *Answer settings* (q4f16, or q4 without `shader-f16`).
- **Models:** SmolLM2-360M-Instruct by default (~365 MB), SmolLM2-135M-Instruct (~137 MB), or Qwen2.5-0.5B-Instruct
  (~510 MB, the best answers). On an iPhone 15, Qwen ran out of WebAssembly memory. When a model runs out of memory,
  the page closes that worker and steps down to the next smaller model. A model downloads once, on the first answer,
  and stays in the browser cache.
- **Sources:** small models cite unreliably, so the passages an answer was written from are always listed under it,
  linked to the numbered results. Any `[n]` the model writes is linked too.
- **Speed:** in this repository's sandbox (4 slow cores, no GPU) the WebAssembly path takes about 35 s to the first
  word and produces 0.6 tokens/s. A phone with WebGPU is much faster; that is the case the feature is for.

**Memory.** These figures are from desktop Chromium, measured with `tools/measure_memory.cjs` and recorded in
`app.js`. The page shows the table for the chosen model under the answer button.

| | WebAssembly | whole page (browser memory above its baseline) |
|---|---|---|
| page ready: Lance reader + onnxruntime + query embedder | 22 + 104 MB | ~600 MB |
| + SmolLM2-135M (137 MB file) | +351 MB | ~1.2 GB, ~1.5 GB while loading |
| + SmolLM2-360M (365 MB file) | +828 MB | ~1.6 GB, ~2.0 GB while loading |
| + Qwen2.5-0.5B (512 MB file, estimated) | +~1.2 GB | ~2 GB, ~2.6 GB while loading |

- **Answer model:** it takes about 2.4 times its file in WebAssembly memory, and a WebAssembly memory never shrinks.
  Phones therefore default to the 135M model and desktops to the 360M one.
- **One onnxruntime:** the embedder and the answer model share one instance in `ai-worker.js`. Each instance creates a
  shared WebAssembly memory with a 4 GB maximum, and Safari reserves that maximum up front. Two such memories
  plausibly caused the iPhone's "RangeError: Out of memory".

**Debug log.** Every stage worth knowing about is written to this browser's `localStorage` as it happens:
- page start, the tables opening, each search with its bytes and memory
- each model-load step, with download progress every 10% and the moment the inference session is created
- each answer's first word and token counts
- every error and status line

A visit that ends in a crash keeps its log. On the next load a banner says so and offers **Copy debug report**. The
*Debug log* button in the answer panel, the footer link, `?debug=1` or Shift+D open the log at any time. Nothing is
sent anywhere. `tools/test_crash_log.cjs` crashes the renderer while the model loads and checks the report.

`node tools/test_answer.cjs <nanolance>/wasm/test/range_server.py` checks it end to end: search, download the model,
stream an answer that names the expected article, and list its sources.

## Live Wikipedia: indexes here, text from Wikipedia (`live.html`)

https://yoavbendor.github.io/webcognee/live.html searches **10,000 articles** (71,868 passages, 148,831 links
between them) but this site stores **no article text**. The bundle (`data/wiki10k/`, 59 MB, almost all of it
vectors) holds:
- per passage: its vector, article, MediaWiki section number, position in the section, word count, and an
  anchor of its first 12 words;
- per article: title, page ID and the **revision ID** that was indexed, categories and links.

A result's text is fetched live, at most three requests at a time, from
`en.wikipedia.org/w/api.php?action=parse&oldid=<revision>&section=<n>`: exactly the revision that was indexed.
The page finds the passage in that section by its anchor. One more request checks whether each result's article
has been edited since, and if so marks it "edited since indexing" with a link to the current page. Answers are
written from the fetched texts by the same on-device model as the offline page.

**Privacy.** Your question never leaves the device, but Wikipedia learns which articles and sections your
results are in.

**Built with cognee and nanolance.** `pipeline/build_wiki_live.py`:
1. Streams the first 10,000 articles of the 2026-10-01 dump, keeping revision IDs and MediaWiki section numbers.
2. Stores them through a cognee custom pipeline with no LLM: `WikiArticle` and `WikiPassage` DataPoints and
   `links_to` edges. Cognee writes the graph to Ladybug and the vectors to LanceDB served by nanolance
   (`install_as_lancedb`), embedding with fastembed's bge-small.
3. Exports the bundle from cognee's own stores.

The full build took 75 minutes on this sandbox's 4 cores, 71 of them in cognee's embedding and storage. Its
`--verify` check matched the section numbers Wikipedia's API reports, 100 of 100.

```sh
PYTHONPATH=<dir with a sitecustomize.py calling nanolance.lancedb.install_as_lancedb()> \
python pipeline/build_wiki_live.py --dump head192.xml.bz2 --articles 10000 --max-passages 8 \
  --out data/wiki10k --work <cognee work dir> --verify 10
```

**Search quality.** The partitioned search reads 6 of 268 partitions (about 1.2 MB). Measured against exact
search over all passages, it finds 89% of the exact top 10 at 6 partitions, 95% at 12 and 99% at 24. The number is
adjustable under *Search settings*.

**Test:** `LIVE_DATA=data/wiki10k/ node tools/test_live.cjs <nanolance>/wasm/test/range_server.py`. It runs three
questions and checks that every result shows live text located at its anchor (30 of 30). Wikipedia throttles
shared IPs (HTTP 429); the page waits for `Retry-After` and retries, and the test reports throttling rather than
hiding it.

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
