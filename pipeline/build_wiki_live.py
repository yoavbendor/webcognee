#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 Yoav Bendor
"""Build the live Wikipedia index: passages embedded through cognee, stored as nanolance tables, text fetched live.

    python pipeline/build_wiki_live.py --dump head.xml.bz2 --articles 10000 --out data/wiki10k --work /var/cache/wiki

Input: the first bytes of a Wikimedia XML dump (bzip2). The parse stops at the cut. Passages are indexed through
cognee (custom pipeline, LLM-free: cognee embeds with fastembed BAAI/bge-small-en-v1.5). cognee's LanceDB
collections and graph live under --work; the static bundle written to --out holds only indexes and links:

- `articles.lance`: one row per article (page id, pinned revision, title, url, categories, links, counts).
- `passages.lance`: one row per passage (article row, section number, part, words, anchor, partition, vector).
  No passage text: the page fetches that live from en.wikipedia.org at the pinned revision.
- `partitions.lance`: IVF centroids and their row ranges in passages.lance.
- `meta.json` and `.lance-tree.json` listings, as build_wiki.py writes them.

`--verify K` checks K sampled articles' section numbers and headings against the Wikipedia API.
"""

import argparse
import bz2
import datetime
import importlib.metadata
import json
import random
import re
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

import mwparserfromhell
import numpy as np
import pyarrow as pa

import build_wiki as bw  # sibling module: clean, passages, kmeans, write_listings, constants
import nanolance.lance as nlance
import nanolance.lancedb as lancedb

DIM = bw.DIM
MODEL = bw.MODEL
MAX_PARTITIONS = 512
BATCH_ARTICLES = 100  # articles per cognee data item
ANCHOR_WORDS = 12
USER_AGENT = "webcognee-build/0.1 (https://github.com/yoavbendor/webcognee)"
API = "https://en.wikipedia.org/w/api.php"
COMMENT = re.compile(r"<!--.*?-->", re.S)
HEADING = re.compile(r"^(={1,6})\s*(.+?)\s*\1\s*$", re.M)


def log(msg):
    print(msg, file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------------------------- the dump


def bz2_blocks(path: Path):
    """Decompressed bytes of a bzip2 file (all streams, in order), read as they are needed. A cut ends it quietly."""
    dec = bz2.BZ2Decompressor()
    with path.open("rb") as f:
        while True:
            block = f.read(1 << 20)
            if not block:
                return
            while block:
                if dec.eof:
                    dec = bz2.BZ2Decompressor()
                out = dec.decompress(block)
                block = dec.unused_data if dec.eof else b""
                if out:
                    yield out


def local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def parse_dump(path: Path, want: int):
    """(articles, redirects). Articles are the first ``want`` namespace-0 non-redirect pages of the prefix, as
    (title, page id, revision id, wikitext). Redirects come from the whole prefix, as build_wiki.py reads it."""
    parser = ET.XMLPullParser(events=("end",))
    articles, redirects = [], {}
    for block in bz2_blocks(path):
        parser.feed(block)
        for _, el in parser.read_events():
            if local(el.tag) != "page":
                continue
            if el.findtext("{*}ns") == "0":
                title = el.findtext("{*}title")
                redirect = el.find("{*}redirect")
                if redirect is not None:
                    redirects[bw.norm_title(title)] = bw.norm_title(redirect.get("title"))
                elif len(articles) < want:
                    text = el.findtext("{*}revision/{*}text") or ""
                    if not text.lower().lstrip().startswith("#redirect"):
                        articles.append((title, int(el.findtext("{*}id")),
                                         int(el.findtext("{*}revision/{*}id")), text))
            el.clear()
    return articles, redirects


# ---------------------------------------------------------------------------------------------- sections


def plain(title: str) -> str:
    return mwparserfromhell.parse(title).strip_code().strip()


def numbered_sections(wikitext: str):
    """[(number, heading path, heading, body)] with MediaWiki's section numbers: 0 is the lead, and every heading
    counts, in order, so section N here is section N of action=parse."""
    text = COMMENT.sub("", wikitext)
    out, stack, last, number = [], [], 0, 0
    current = (0, "", "")
    for m in HEADING.finditer(text):
        out.append((*current, text[last:m.start()]))
        number += 1
        title = plain(m.group(2))
        stack = stack[: max(len(m.group(1)) - 2, 0)] + [title]
        current = (number, " › ".join(stack), title)
        last = m.end()
    out.append((*current, text[last:]))
    return out


def article_passages(title: str, sections, max_passages: int):
    """The first ``max_passages`` passages of an article in document order, from sections not in SKIP_SECTIONS."""
    out = []
    for number, path, _, body in sections:
        if len(out) >= max_passages:
            break
        if path.split(" › ")[0].lower() in bw.SKIP_SECTIONS:
            continue
        text, _, _ = bw.clean(body)
        for part, passage in enumerate(bw.passages(text)):
            if len(out) >= max_passages:
                break
            words = passage.split()
            out.append({
                "section": number, "part": part, "words": len(words),
                "anchor": " ".join(words[:ANCHOR_WORDS]), "text": passage,
                "embed_text": f"{title}. {path}. {passage}" if path else f"{title}. {passage}",
            })
    return out


def build_articles(raw, redirects, max_passages: int):
    """Article records (dump order) with passages, headings (all numbered), categories and resolved links."""
    index = {bw.norm_title(t): i for i, (t, _, _, _) in enumerate(raw)}
    arts = []
    for aid, (title, page_id, revid, wikitext) in enumerate(raw):
        sections = numbered_sections(wikitext)
        links = set()
        for target in bw.LINK.findall(wikitext):  # whole page, infoboxes and navigation included
            if ":" in target:
                continue
            target = redirects.get(bw.norm_title(target), bw.norm_title(target))
            if target in index and index[target] != aid:
                links.add(index[target])
        categories = list(dict.fromkeys(c.strip() for c in bw.CATEGORY.findall(wikitext)))
        arts.append({
            "id": aid, "title": title, "page_id": page_id, "revid": revid,
            "url": "https://en.wikipedia.org/wiki/" + title.replace(" ", "_"),
            "categories": "; ".join(categories), "links": sorted(links),
            "headings": [(n, h) for n, _, h, _ in sections if n > 0],
            "passages": article_passages(title, sections, max_passages),
        })
    return arts


# ---------------------------------------------------------------------------------------------- cognee


async def index_in_cognee(arts, work: Path):
    """Write WikiArticle and WikiPassage DataPoints through cognee, then the links_to edges. Returns the link edges
    read back from cognee's graph and the embedding counts."""
    import cognee
    from cognee.infrastructure.databases.graph import get_graph_engine
    from cognee.infrastructure.databases.vector.embeddings.FastembedEmbeddingEngine import (
        FastembedEmbeddingEngine,
    )
    from cognee.low_level import DataPoint
    from cognee.modules.pipelines import Task
    from cognee.tasks.storage import add_data_points

    class WikiArticle(DataPoint):
        title: str
        page_id: int
        revid: int
        url: str
        categories: str
        # identity is the page id: titles differing only in case or punctuation (e.g. "AA" and "Aa") are separate
        # articles, but cognee normalizes identity values, so title identity merged 4 of 10,000 articles
        metadata: dict = {"index_fields": ["title"], "identity_fields": ["page_id"]}

    class WikiPassage(DataPoint):
        key: str
        embed_text: str
        article_title: str
        page_id: int
        revid: int
        section: int
        part: int
        words: int
        anchor: str
        article: WikiArticle
        metadata: dict = {"index_fields": ["embed_text"], "identity_fields": ["key"]}

    def article_id(page_id: int) -> str:
        return str(WikiArticle(title="", page_id=page_id, revid=0, url="", categories="").id)

    async def to_datapoints(batches: list):
        out = []
        for a in batches[0]:
            article = WikiArticle(title=a["title"], page_id=a["page_id"], revid=a["revid"], url=a["url"],
                                  categories=a["categories"])
            out.append(article)
            for p in a["passages"]:
                out.append(WikiPassage(
                    key=f"{a['page_id']}:{p['section']}:{p['part']}", embed_text=p["embed_text"],
                    article_title=a["title"], page_id=a["page_id"], revid=a["revid"], section=p["section"],
                    part=p["part"], words=p["words"], anchor=p["anchor"], article=article))
        return out

    async def write_links(_items: list):
        graph = await get_graph_engine()
        edges = [(article_id(arts[i]["page_id"]), article_id(arts[j]["page_id"]), "links_to", {})
                 for i, a in enumerate(arts) for j in a["links"]]
        await graph.add_edges(edges)
        return []

    stats = {"texts": 0, "embed_seconds": 0.0}
    original = FastembedEmbeddingEngine.embed_text

    async def counted(self, text):
        start = time.time()
        result = await original(self, text)
        stats["texts"] += len(text)
        stats["embed_seconds"] += time.time() - start
        return result

    FastembedEmbeddingEngine.embed_text = counted

    await cognee.run_migrations()
    batches = [arts[i:i + BATCH_ARTICLES] for i in range(0, len(arts), BATCH_ARTICLES)]
    timings = {}

    t = time.time()
    result = await cognee.run_custom_pipeline(
        tasks=[Task(to_datapoints, needs_llm=False), Task(add_data_points, needs_llm=False, index_edges=False)],
        data=batches, dataset="wiki")
    timings["cognee_nodes_and_passages"] = time.time() - t
    check_runs(result, "nodes and passages")

    t = time.time()
    result = await cognee.run_custom_pipeline(
        tasks=[Task(write_links, needs_llm=False)], data=[{}], dataset="wiki")
    timings["cognee_links"] = time.time() - t
    check_runs(result, "links")

    graph = await get_graph_engine()
    nodes, edges = await graph.get_graph_data()
    link_edges = [(s, d) for s, d, rel, _ in edges if rel == "links_to"]
    wiki_nodes = {nid: props for nid, props in nodes
                  if props.get("type") in ("WikiArticle", "WikiPassage")}
    return {"link_edges": link_edges, "nodes": wiki_nodes, "embedded_texts": stats["texts"],
            "embed_call_seconds": stats["embed_seconds"], "graph": type(graph).__name__,
            "timings": timings, "batches": len(batches)}


def check_runs(result: dict, what: str):
    for info in result.values():
        log(f"  cognee {what}: {type(info).__name__}")
        if "Errored" in type(info).__name__:
            raise RuntimeError(f"cognee {what} failed: {info}")


def find_store(system: Path, name: str) -> Path:
    found = sorted(system.rglob(name))
    if len(found) != 1:
        raise RuntimeError(f"expected one {name} under {system}, found {found}")
    return found[0]


# ---------------------------------------------------------------------------------------------- bundle


def read_store(path: Path):
    return nlance.dataset(str(path)).to_table()


def write_bundle(out: Path, arts, cognee_out, work: Path, dump: Path, source_url: str):
    """Read cognee's stores (vectors and ids) and graph (DataPoint fields), write the static bundle."""
    t = time.time()
    system = work / "system"
    article_path = find_store(system, "WikiArticle_title.lance")
    passage_path = find_store(system, "WikiPassage_embed_text.lance")
    log(f"  store paths: {article_path} ; {passage_path}")
    article_store = read_store(article_path)
    passage_store = read_store(passage_path)

    # The vector stores hold the indexed text and the DataPoint id; the other fields are graph node properties.
    nodes = cognee_out["nodes"]
    article_props = {str(nid): p for nid, p in nodes.items() if p.get("type") == "WikiArticle"}
    passage_props = {str(nid): p for nid, p in nodes.items() if p.get("type") == "WikiPassage"}
    index = {a["page_id"]: i for i, a in enumerate(arts)}

    # article node id -> row, through the node's page_id (unique; titles are not after normalization)
    index_of_uid = {uid: index[int(p["page_id"])] for uid, p in article_props.items()}
    stored = {str(u) for u in article_store.column("id").to_pylist()}
    if len(index_of_uid) != len(arts) or not stored >= set(index_of_uid):
        raise RuntimeError(f"cognee holds {len(stored)} article vectors and {len(article_props)} "
                           f"article nodes, expected {len(arts)}")
    by_index = {index_of_uid[uid]: p for uid, p in article_props.items()}

    links = [set() for _ in arts]
    for s, d in cognee_out["link_edges"]:
        links[index_of_uid[str(s)]].add(index_of_uid[str(d)])
    expected = sum(len(a["links"]) for a in arts)
    if sum(len(x) for x in links) != expected:
        raise RuntimeError(f"graph holds {sum(len(x) for x in links)} links_to edges, expected {expected}")
    inlinks = np.zeros(len(arts), np.int32)
    for targets in links:
        for j in targets:
            inlinks[j] += 1
    art_rows = []
    for i, a in enumerate(arts):
        p = by_index[i]
        art_rows.append({"id": i, "page_id": p["page_id"], "revid": p["revid"], "title": p["title"],
                         "url": p["url"], "categories": p["categories"],
                         "links": ",".join(str(j) for j in sorted(links[i])),
                         "n_links": len(links[i]), "n_inlinks": int(inlinks[i])})

    ids = [str(x) for x in passage_store.column("id").to_pylist()]
    n = len(ids)
    if n != sum(len(a["passages"]) for a in arts) or len(passage_props) != n:
        raise RuntimeError(f"cognee holds {n} passage vectors and {len(passage_props)} passage nodes, "
                           f"expected {sum(len(a['passages']) for a in arts)}")
    props = [passage_props[i] for i in ids]
    vectors = passage_store.column("vector").combine_chunks().flatten().to_numpy().reshape(n, -1)
    vectors = vectors.astype(np.float32)
    vectors /= np.linalg.norm(vectors, axis=1, keepdims=True) + 1e-12
    article = np.array([index[int(p["page_id"])] for p in props], np.int32)
    section = np.array([p["section"] for p in props], np.int32)
    part = np.array([p["part"] for p in props], np.int32)
    words = np.array([p["words"] for p in props], np.int32)
    anchor = [p["anchor"] for p in props]
    log(f"  read {n} passages, {len(arts)} articles from cognee ({time.time() - t:.1f}s)")

    t = time.time()
    k = min(MAX_PARTITIONS, max(1, int(round(np.sqrt(n)))))
    centroids, assign = bw.kmeans(vectors, k)
    order = np.lexsort((part, section, article, assign))  # by partition, then article, section, part
    assign_sorted = assign[order]
    starts = np.searchsorted(assign_sorted, np.arange(k))
    counts = np.bincount(assign, minlength=k)
    log(f"  {k} partitions, {counts.min()}..{counts.max()} passages each ({time.time() - t:.1f}s)")

    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    db = lancedb.connect(out)

    def vec(a):
        return pa.FixedSizeListArray.from_arrays(pa.array(a.astype(np.float16).ravel(), pa.float16()), DIM)

    db.create_table("articles", data=pa.Table.from_pylist(art_rows, schema=pa.schema([
        ("id", pa.int32()), ("page_id", pa.int64()), ("revid", pa.int64()), ("title", pa.string()),
        ("url", pa.string()), ("categories", pa.string()), ("links", pa.string()),
        ("n_links", pa.int32()), ("n_inlinks", pa.int32())])))
    db.create_table("passages", data=pa.table({
        "article": pa.array(article[order], pa.int32()),
        "section": pa.array(section[order], pa.int32()),
        "part": pa.array(part[order], pa.int32()),
        "words": pa.array(words[order], pa.int32()),
        "anchor": pa.array([anchor[i] for i in order], pa.string()),
        "partition": pa.array(assign_sorted, pa.int32()),
        "vector": vec(vectors[order]),
    }))
    db.create_table("partitions", data=pa.table({
        "id": pa.array(range(k), pa.int32()), "start": pa.array(starts, pa.int64()),
        "count": pa.array(counts, pa.int64()), "centroid": vec(centroids)}))
    sizes = {name: sum(f.stat().st_size for f in (out / f"{name}.lance").rglob("*") if f.is_file())
             for name in ("articles", "passages", "partitions")}
    return {"sizes": sizes, "partitions": k, "links": expected, "passages": n}


def versions():
    def v(name):
        try:
            return importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            return "unknown"
    return {"cognee": v("cognee"), "nanolance": v("nanolance") if v("nanolance") != "unknown" else __import__("nanolance").__dict__.get("__version__", "unknown")}


# ---------------------------------------------------------------------------------------------- verify


def api_get(params: dict) -> dict:
    url = API + "?" + urllib.parse.urlencode(params)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": USER_AGENT}),
                                        timeout=60) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code != 429 or attempt == 3:
                raise
            log("  HTTP 429, waiting 5 s")
            time.sleep(5)
    raise RuntimeError("unreachable")


def norm_heading(s: str) -> str:
    return re.sub(r"[\W_]+", "", mwparserfromhell.parse(s).strip_code().lower())


def verify(arts, k: int):
    """Compare our section numbers and headings with action=parse&prop=sections of each sampled revision."""
    sample = random.Random(0).sample(arts, min(k, len(arts)))
    matched = total = same_count = checked = unchecked = 0
    examples = []
    for n, a in enumerate(sample):
        if n:
            time.sleep(1)
        try:
            data = api_get({"action": "parse", "oldid": a["revid"], "prop": "sections",
                            "format": "json", "formatversion": "2"})
        except (urllib.error.URLError, OSError) as e:
            unchecked += 1
            log(f"  {a['title']}: not checked, {e}")
            continue
        if "error" in data:
            unchecked += 1
            log(f"  {a['title']}: API error {data['error'].get('code')}")
            continue
        checked += 1
        api = {s["index"]: norm_heading(s["line"]) for s in data["parse"]["sections"]
               if not s["index"].startswith("T-")}
        for number, heading in a["headings"]:
            total += 1
            if api.get(str(number)) == norm_heading(heading):
                matched += 1
            elif len(examples) < 8:
                examples.append((a["title"], number, heading, api.get(str(number))))
        same_count += len(api) == len(a["headings"])
    rate = 100 * matched / max(total, 1)
    log(f"verify: {matched}/{total} sections match ({rate:.1f}%) over {checked} checked articles "
        f"({unchecked} not checked); section counts equal in {same_count}/{checked}")
    for ex in examples:
        log(f"  mismatch: {ex}")
    return rate


# ---------------------------------------------------------------------------------------------- main


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--dump", required=True, type=Path, help="a bzip2 Wikimedia XML dump (a prefix is enough)")
    ap.add_argument("--articles", type=int, default=10000, help="articles to keep (the first in the dump)")
    ap.add_argument("--max-passages", type=int, default=8, help="passages kept per article (from the top)")
    ap.add_argument("--out", required=True, type=Path, help="the bundle directory, e.g. data/wiki10k")
    ap.add_argument("--work", required=True, type=Path, help="cognee's data and system roots live here")
    ap.add_argument("--source-url", default="", help="where the dump came from (recorded in meta.json)")
    ap.add_argument("--verify", type=int, default=0, help="articles to check against the Wikipedia API")
    args = ap.parse_args()

    t0 = time.time()
    timings = {}

    t = time.time()
    raw, redirects = parse_dump(args.dump, args.articles)
    log(f"parsed {len(raw)} articles, {len(redirects)} redirects ({time.time() - t:.1f}s)")
    if len(raw) < args.articles:
        log(f"  the prefix holds only {len(raw)} of the {args.articles} requested articles")
    t = time.time()
    arts = build_articles(raw, redirects, args.max_passages)
    del raw
    timings["sections_and_passages"] = time.time() - t
    n_passages = sum(len(a["passages"]) for a in arts)
    log(f"{len(arts)} articles, {n_passages} passages, {sum(len(a['links']) for a in arts)} links "
        f"({timings['sections_and_passages']:.1f}s)")

    # cognee reads its roots from the environment when it is imported: set them before the import, and start
    # from empty roots so a rebuild does not keep the rows of an earlier one
    args.work.mkdir(parents=True, exist_ok=True)
    for sub in ("data", "system"):
        shutil.rmtree(args.work / sub, ignore_errors=True)
    import os

    os.environ.update({
        "TELEMETRY_DISABLED": "1",
        "DATA_ROOT_DIRECTORY": str(args.work / "data"),
        "SYSTEM_ROOT_DIRECTORY": str(args.work / "system"),
        "ENABLE_BACKEND_ACCESS_CONTROL": "false",
    })
    import asyncio

    t = time.time()
    cognee_out = asyncio.run(index_in_cognee(arts, args.work))
    timings.update(cognee_out.pop("timings"))
    timings["cognee_total"] = time.time() - t
    embed_rate = cognee_out["embedded_texts"] / max(timings["cognee_nodes_and_passages"], 1e-9)
    log(f"cognee: {cognee_out['batches']} batches, graph {cognee_out['graph']}, "
        f"{cognee_out['embedded_texts']} texts embedded ({cognee_out['embed_call_seconds']:.1f}s in embed calls), "
        f"{embed_rate:.1f} texts/s over the nodes-and-passages run, {len(cognee_out['link_edges'])} links_to edges")

    t = time.time()
    bundle = write_bundle(args.out, arts, cognee_out, args.work, args.dump, args.source_url)
    timings["bundle"] = time.time() - t
    log(f"bundle: {bundle['passages']} passages, {bundle['partitions']} partitions, {bundle['links']} links "
        f"({timings['bundle']:.1f}s)")

    meta = {"title": "Live Wikipedia", "built": datetime.date.today().isoformat(),
            "source": {"dump": args.source_url or args.dump.name, "dump_bytes": args.dump.stat().st_size,
                       "license": "CC BY-SA 4.0", "license_url": "https://creativecommons.org/licenses/by-sa/4.0/"},
            "model": {"passages": MODEL, "queries": "Xenova/bge-small-en-v1.5",
                      "query_prefix": "Represent this sentence for searching relevant passages: ",
                      "dim": DIM, "pooling": "cls", "normalize": True},
            "articles": len(arts), "passages": bundle["passages"], "partitions": bundle["partitions"],
            "links": bundle["links"], "text": "live from en.wikipedia.org, pinned revisions",
            "bytes": bundle["sizes"], "built_with": versions()}
    (args.out / "meta.json").write_text(json.dumps(meta, indent=2))
    bw.write_listings(args.out)

    for name in ("articles", "passages", "partitions"):
        rows = nlance.dataset(str(args.out / f"{name}.lance")).count_rows()
        log(f"  reopened {name}.lance with nanolance: {rows} rows")

    if args.verify:
        t = time.time()
        verify(arts, args.verify)
        timings["verify"] = time.time() - t

    for name, seconds in timings.items():
        log(f"  time {name}: {seconds:.1f}s")
    log(f"done in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
