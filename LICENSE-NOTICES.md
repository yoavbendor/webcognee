# Third-party notices

## The WebAssembly module (`lib/weblance.wasm`, `lib/weblance.js`)

Built from nanolance's `wasm/weblance_glue.cpp` (`wasm/build_weblance.sh`, Emscripten 6.0.12, `-Oz`). It contains:

| Component | License | Source | Full text |
|---|---|---|---|
| nanolance (Lance reader, the worker API) | Apache-2.0 | Copyright 2026 Yoav Bendor, https://github.com/yoavbendor/nanolance | [licenses/nanolance-APACHE-2.0.txt](licenses/nanolance-APACHE-2.0.txt), [licenses/nanolance-NOTICE.txt](licenses/nanolance-NOTICE.txt) |
| Apache Arrow nanoarrow (with the flatcc runtime) | Apache-2.0 | https://github.com/apache/arrow-nanoarrow | [licenses/nanoarrow-LICENSE.txt](licenses/nanoarrow-LICENSE.txt), [licenses/nanoarrow-NOTICE.txt](licenses/nanoarrow-NOTICE.txt) |
| Zstandard | BSD-3-Clause | https://github.com/facebook/zstd | [licenses/zstd-LICENSE.txt](licenses/zstd-LICENSE.txt) |
| Emscripten runtime | MIT or NCSA | https://emscripten.org | [licenses/emscripten-LICENSE.txt](licenses/emscripten-LICENSE.txt) |
| musl libc | MIT | https://musl.libc.org | [licenses/musl-COPYRIGHT.txt](licenses/musl-COPYRIGHT.txt) |
| LLVM libc++ / libc++abi | Apache-2.0 WITH LLVM-exception | https://libcxx.llvm.org | [licenses/libcxx-LICENSE.txt](licenses/libcxx-LICENSE.txt), [licenses/libcxxabi-LICENSE.txt](licenses/libcxxabi-LICENSE.txt) |

The Lance format definitions behind nanolance's protobuf types are Apache-2.0, Copyright The Lance Authors
(https://github.com/lance-format/lance).

## Loaded at run time, not part of this repository

- transformers.js 4.2.0 (Apache-2.0, Hugging Face), from cdn.jsdelivr.net.
- The query model `Xenova/bge-small-en-v1.5` (MIT; the ONNX export of BAAI's bge-small-en-v1.5), from huggingface.co.

## Data (`data/wiki/`)

Text from English Wikipedia (the 2026-10-01 dump, a fragment: see `data/wiki/meta.json`), licensed
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). The tables are derived from it (passages cut by
section, embeddings, the link graph) and are distributed under the same license. Every result on the page links to
its source article, where the authors are listed in the page history.
