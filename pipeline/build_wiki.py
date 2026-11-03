#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 Yoav Bendor
"""Build the pocket Wikipedia: a fragment of an English Wikipedia dump as three Lance tables a static page searches.

    python pipeline/build_wiki.py --dump head.xml.bz2 --articles 300 --out data/wiki

Input: the first bytes of a Wikimedia XML dump (bzip2). A prefix is enough -- the parse stops at the cut. Output,
written with nanolance.lancedb (LanceDB's API over nanolance), next to a `meta.json`:

- `articles.lance`: one row per article -- title, url, lead text, categories, and its links to the other
  articles of the fragment (the graph).
- `chunks.lance`: the articles cut into passages (by section, ~150 words), each with a bge-small-en-v1.5 vector
  (float16, 384). Rows are sorted by IVF partition, so a partition is a contiguous run of rows: a browser query
  reads a few runs by HTTP Range, not the whole table.
- `partitions.lance`: the partitions' centroids and their [start, start + count) row ranges in chunks.lance.

Every directory then gets a `.lance-tree.json` listing, which nanolance's WebAssembly reader uses on static hosts
(GitHub Pages lists no directories).
"""

from __future__ import annotations

import argparse
import bz2
import datetime
import json
import os
import re
import shutil
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path

import mwparserfromhell
import numpy as np
import pyarrow as pa

import nanolance.lancedb as lancedb

MODEL = "BAAI/bge-small-en-v1.5"  # the browser embeds queries with Xenova/bge-small-en-v1.5, the same model
DIM = 384
SKIP_SECTIONS = {"references", "external links", "see also", "notes", "further reading", "bibliography",
                 "sources", "citations", "footnotes", "works cited", "notes and references", "gallery",
                 "explanatory notes", "general and cited references", "cited sources"}
HEADING = re.compile(r"^(={2,6})\s*(.+?)\s*\1\s*$", re.M)
CHUNK_WORDS = 150
LINK = re.compile(r"\[\[\s*([^\]\[|#{}]+?)\s*(?:[|#][^\]\[]*)?\]\]")
CATEGORY = re.compile(r"\[\[\s*Category\s*:\s*([^\]|]+)", re.I)


# ---------------------------------------------------------------------------------------------- the dump


def dump_xml(path: Path):
    """The XML of a bzip2 dump prefix (one or more streams), decompressed up to the cut."""
    data, out = path.read_bytes(), bytearray()
    while data:
        d = bz2.BZ2Decompressor()
        try:
            out += d.decompress(data)
        except (OSError, EOFError):
            break
        if not d.eof:
            break
        data = d.unused_data
    return bytes(out)


def pages(xml: bytes):
    """(title, page id, redirect target or None, wikitext) of each complete namespace-0 page."""
    parser = ET.XMLPullParser(events=("end",))
    step = 1 << 20
    for i in range(0, len(xml), step):
        try:
            parser.feed(xml[i:i + step])
        except ET.ParseError:
            return
        for _, el in parser.read_events():
            if el.tag.rsplit("}", 1)[-1] != "page":
                continue
            get = lambda name: el.find(f"{{*}}{name}")  # noqa: E731
            if get("ns") is None or get("ns").text != "0":
                el.clear()
                continue
            redirect = get("redirect")
            text = el.find("{*}revision/{*}text")
            yield (get("title").text, int(get("id").text), redirect.get("title") if redirect is not None else None,
                   text.text or "" if text is not None else "")
            el.clear()


def norm_title(title: str) -> str:
    title = title.split("#", 1)[0].replace("_", " ").strip()
    return title[:1].upper() + title[1:] if title else title


# ---------------------------------------------------------------------------------------------- wikitext


def clean(wikitext: str):
    """Plain text of a section's wikitext, its article links (normalized titles) and categories."""
    code = mwparserfromhell.parse(wikitext)
    links, categories = [], []
    for link in code.filter_wikilinks(recursive=False):
        target = str(link.title).strip()
        low = target.lower()
        if low.startswith("category:"):
            categories.append(target.split(":", 1)[1].strip())
            _remove(code, link)
        elif low.startswith(("file:", "image:", "media:")) or ":" in target.lstrip(":").split("|")[0][:12]:
            _remove(code, link)
        else:
            links.append(norm_title(target))
    for tag in code.filter_tags(recursive=False):
        if str(tag.tag).lower() in ("ref", "gallery", "math", "table", "references", "timeline", "score"):
            _remove(code, tag)
    text = code.strip_code(normalize=True, collapse=True)
    text = re.sub(r"\{\|.*?\|\}", " ", text, flags=re.S)  # wiki tables strip_code leaves behind
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"[ \t]+", " ", text).strip()
    return text, links, categories


def _remove(code, node):
    try:
        code.remove(node)
    except ValueError:
        pass


def sections(wikitext: str):
    """(heading path, wikitext) of the lead and each section, top to bottom."""
    out, path, last = [], [], 0
    for m in HEADING.finditer(wikitext):
        out.append((" › ".join(path), wikitext[last:m.start()]))
        level = len(m.group(1)) - 1
        title = mwparserfromhell.parse(m.group(2)).strip_code().strip()
        path = path[: level - 1] + [title]
        last = m.end()
    out.append((" › ".join(path), wikitext[last:]))
    return out


def passages(text: str, words: int = CHUNK_WORDS):
    """``text`` in passages of about ``words`` words, broken at paragraph ends where possible."""
    out, cur, n = [], [], 0
    for para in [p.strip() for p in text.split("\n") if p.strip()]:
        w = len(para.split())
        if n and n + w > words * 1.3:
            out.append(" ".join(cur))
            cur, n = [], 0
        if w > words * 1.3:  # one long paragraph: split by sentences
            for sent in re.split(r"(?<=[.!?])\s+", para):
                sw = len(sent.split())
                if n and n + sw > words:
                    out.append(" ".join(cur))
                    cur, n = [], 0
                cur.append(sent)
                n += sw
        else:
            cur.append(para)
            n += w
    if cur:
        out.append(" ".join(cur))
    return [p for p in out if len(p.split()) >= 12]


# ---------------------------------------------------------------------------------------------- build


def kmeans(x: np.ndarray, k: int, iters: int = 25, seed: int = 0):
    """Spherical k-means: unit centroids, assignment by cosine."""
    rng = np.random.default_rng(seed)
    c = x[rng.choice(len(x), k, replace=False)].copy()
    for _ in range(iters):
        assign = np.argmax(x @ c.T, axis=1)
        for j in range(k):
            members = x[assign == j]
            if len(members):
                m = members.sum(axis=0)
                c[j] = m / (np.linalg.norm(m) + 1e-12)
            else:
                c[j] = x[rng.integers(len(x))]
    return c, np.argmax(x @ c.T, axis=1)


def embed(docs, cache: Path, t0: float) -> np.ndarray:
    """Unit bge-small vectors of ``docs``. With a cache directory, a passage embedded before (same text, same
    model) is read back instead of embedded again."""
    import hashlib

    keys = [hashlib.sha1((MODEL + "\0" + d).encode()).hexdigest() for d in docs]
    known = {}
    if cache:
        cache.mkdir(parents=True, exist_ok=True)
        f = cache / "embeddings.npz"
        if f.exists():
            z = np.load(f)
            known = dict(zip(z["keys"].tolist(), z["vectors"]))
    todo = [i for i, k in enumerate(keys) if k not in known]
    if todo:
        from fastembed import TextEmbedding

        model = TextEmbedding(MODEL)
        batch = 32
        for j in range(0, len(todo), batch):
            part = todo[j:j + batch]
            for i, v in zip(part, model.embed([docs[i] for i in part], batch_size=batch)):
                known[keys[i]] = np.asarray(v, np.float32)
            if (j // batch) % 40 == 0:
                print(f"  embedded {j + len(part)}/{len(todo)} ({time.time() - t0:.0f}s)", file=sys.stderr)
        if cache:
            np.savez(cache / "embeddings.npz", keys=np.array(list(known)), vectors=np.stack(list(known.values())))
    vectors = np.stack([known[k] for k in keys]).astype(np.float32)
    return vectors / (np.linalg.norm(vectors, axis=1, keepdims=True) + 1e-12)


def write_listings(root: Path):
    """A `.lance-tree.json` in every directory under ``root``: its entries, in the Hugging Face tree API's
    shape, each path being the entry's name."""
    for d, dirs, files in os.walk(root):
        entries = [{"type": "directory", "path": n, "size": 0} for n in sorted(dirs)]
        entries += [{"type": "file", "path": n, "size": os.path.getsize(os.path.join(d, n))}
                    for n in sorted(files) if n != ".lance-tree.json"]
        Path(d, ".lance-tree.json").write_text(json.dumps(entries, separators=(",", ":")))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--dump", required=True, type=Path, help="a bzip2 Wikimedia XML dump (a prefix is enough)")
    ap.add_argument("--source-url", default="", help="where the dump came from (recorded in meta.json)")
    ap.add_argument("--articles", type=int, default=300, help="articles to keep (the first in the dump)")
    ap.add_argument("--max-chunks", type=int, default=30, help="passages kept per article (from the top)")
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--cache", type=Path, default=None, help="keep passage embeddings here between builds")
    args = ap.parse_args()

    t0 = time.time()
    xml = dump_xml(args.dump)
    raw, redirects = [], {}
    for title, pid, redirect, text in pages(xml):
        if redirect is not None:
            redirects[norm_title(title)] = norm_title(redirect)
        elif len(raw) < args.articles and not text.lower().lstrip().startswith("#redirect"):
            raw.append((title, pid, text))
    print(f"{len(raw)} articles, {len(redirects)} redirects ({time.time() - t0:.1f}s)", file=sys.stderr)

    index = {norm_title(t): i for i, (t, _, _) in enumerate(raw)}
    articles, chunks = [], []
    for aid, (title, pid, wikitext) in enumerate(raw):
        links, lead = set(), ""
        # categories sit at the end of the page, in sections the passages skip: read them from the whole page
        categories = [c.strip() for c in CATEGORY.findall(wikitext)]
        # links from the whole page (infoboxes and navigation templates included), resolved through redirects
        for target in LINK.findall(wikitext):
            if ":" in target:
                continue
            target = norm_title(target)
            target = redirects.get(target, target)
            if target in index and index[target] != aid:
                links.add(index[target])
        kept = 0
        for path, body in sections(wikitext):
            if path.split(" › ")[0].lower() in SKIP_SECTIONS:
                continue
            text, _, _ = clean(body)
            if not lead and text:
                lead = text[:600]
            for p in passages(text):
                if kept < args.max_chunks:
                    chunks.append((aid, title, path, p))
                    kept += 1
        articles.append({"id": aid, "page_id": pid, "title": title,
                         "url": "https://en.wikipedia.org/wiki/" + title.replace(" ", "_"),
                         "lead": lead, "categories": "; ".join(dict.fromkeys(categories)),
                         "links": ",".join(str(i) for i in sorted(links)), "n_links": len(links)})
    inlinks = np.zeros(len(articles), np.int32)
    for a in articles:
        for i in filter(None, a["links"].split(",")):
            inlinks[int(i)] += 1
    for a, n in zip(articles, inlinks):
        a["n_inlinks"] = int(n)
    print(f"{len(chunks)} passages ({time.time() - t0:.1f}s)", file=sys.stderr)

    docs = [f"{t}. {s}. {p}" if s else f"{t}. {p}" for _, t, s, p in chunks]
    vectors = embed(docs, args.cache, t0)

    k = max(8, int(round(np.sqrt(len(chunks)))))
    centroids, assign = kmeans(vectors, k)
    order = np.lexsort((np.array([c[0] for c in chunks]), assign))
    starts = np.searchsorted(assign[order], np.arange(k))
    counts = np.bincount(assign, minlength=k)
    print(f"{k} partitions, {counts.min()}..{counts.max()} passages each ({time.time() - t0:.1f}s)",
          file=sys.stderr)

    if args.out.exists():
        shutil.rmtree(args.out)
    args.out.mkdir(parents=True)
    db = lancedb.connect(args.out)
    f16 = pa.list_(pa.field("item", pa.float16()), DIM)

    def vec(a):
        return pa.FixedSizeListArray.from_arrays(pa.array(a.astype(np.float16).ravel(), pa.float16()), DIM)

    db.create_table("articles", data=pa.Table.from_pylist(articles))
    ordered = [chunks[i] for i in order]
    db.create_table("chunks", data=pa.table({
        "article_id": pa.array([c[0] for c in ordered], pa.int32()),
        "title": [c[1] for c in ordered],
        "section": [c[2] for c in ordered],
        "text": [c[3] for c in ordered],
        "partition": pa.array(assign[order], pa.int32()),
        "vector": vec(vectors[order]),
    }))
    db.create_table("partitions", data=pa.table({
        "id": pa.array(range(k), pa.int32()), "start": pa.array(starts, pa.int64()),
        "count": pa.array(counts, pa.int64()), "centroid": vec(centroids)}))
    assert db.open_table("chunks").schema.field("vector").type == f16

    sizes = {name: sum(f.stat().st_size for f in (args.out / f"{name}.lance").rglob("*") if f.is_file())
             for name in ("articles", "chunks", "partitions")}
    meta = {"title": "Pocket Wikipedia", "built": datetime.date.today().isoformat(),
            "source": {"dump": args.source_url or args.dump.name, "dump_bytes": args.dump.stat().st_size,
                       "license": "CC BY-SA 4.0", "license_url": "https://creativecommons.org/licenses/by-sa/4.0/"},
            "model": {"passages": MODEL, "queries": "Xenova/bge-small-en-v1.5",
                      "query_prefix": "Represent this sentence for searching relevant passages: ",
                      "dim": DIM, "pooling": "cls", "normalize": True},
            "articles": len(articles), "chunks": len(chunks), "partitions": int(k),
            "links": int(sum(a["n_links"] for a in articles)), "bytes": sizes}
    (args.out / "meta.json").write_text(json.dumps(meta, indent=2))
    write_listings(args.out)
    print(json.dumps(meta, indent=2), file=sys.stderr)
    print(f"done in {time.time() - t0:.0f}s", file=sys.stderr)


if __name__ == "__main__":
    main()
