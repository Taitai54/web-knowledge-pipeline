#!/usr/bin/env python3
"""
Pinecone MCP Server — stdio transport.
Exposes tools for querying and managing Pinecone indexes from Claude.

Tools:
  pinecone_search          — semantic search; free local embedding by default,
                             pass paid_embed=True for Pinecone integrated inference
  pinecone_filter_by_metadata — list records matching a metadata filter
  pinecone_upsert          — add/update records
  pinecone_delete          — remove records by ID or filter
  pinecone_index_info      — index statistics
  pinecone_summarize_namespace — local topic-model summary of a namespace (free, cached)

Usage (stdio, started by Claude Code):
  python pinecone_mcp.py

Registration in ~/.claude.json (adjust the path to wherever you cloned this repo):
  "pinecone-kb": {
    "type": "stdio",
    "command": "python",
    "args": ["C:\\Users\\<you>\\GitHub\\pinecone-management\\pinecone_mcp.py"],
    "env": {}
  }
"""

import os, sys, json, re, time, random
from pathlib import Path

# ── Dependency check ──────────────────────────────────────────────────────────
try:
    import requests
except ImportError:
    sys.exit("Missing dependency: pip install requests")

from pinecone_shared import (
    PINECONE_API_KEY,
    DIM_TO_LOCAL_MODEL as _DIM_TO_LOCAL_MODEL,
    e5_query_prefix,
    auth_headers as _auth_headers,
    request_with_retry as _request_with_retry,
    fetch_index_meta as _fetch_index_meta,
)

# ── Config ────────────────────────────────────────────────────────────────────

_INDEX_HOST_CACHE: dict[str, str] = {}
_LOCAL_MODEL_CACHE: dict[str, object] = {}  # model_name -> SentenceTransformer instance

MAX_RETRIES = 3
INITIAL_RETRY_DELAY = 1.0
MAX_BACKOFF = 30.0


def _resolve_host(index_name: str) -> str:
    if index_name in _INDEX_HOST_CACHE:
        return _INDEX_HOST_CACHE[index_name]
    if "." in index_name:
        host = index_name.split("://")[-1].strip("/")
        _INDEX_HOST_CACHE[index_name] = host
        return host
    host = _fetch_index_meta(index_name)["host"]
    _INDEX_HOST_CACHE[index_name] = host
    return host


def _list_index_names() -> list[str]:
    resp = _request_with_retry(
        "GET",
        "https://api.pinecone.io/indexes",
        headers={**_auth_headers(), "X-Pinecone-Api-Version": "2024-07"},
        timeout=15,
    )
    if not resp.ok:
        raise RuntimeError(f"Could not list indexes: HTTP {resp.status_code}")
    return [idx["name"] for idx in resp.json().get("indexes", [])]


# ── In-process query cache ────────────────────────────────────────────────────
# Avoids re-embedding/re-querying identical repeat searches within a session.
# Cleared on any upsert/delete in the same process so results can't go stale.

from collections import OrderedDict
import hashlib

_QUERY_CACHE: "OrderedDict[str, dict]" = OrderedDict()
_QUERY_CACHE_MAX = 128


def _cache_key(index_name, query, namespace, filter_json, limit, max_chars,
               full_text, paid_embed, rerank) -> str:
    norm_query = " ".join(query.strip().lower().split())
    raw = json.dumps(
        [index_name, norm_query, namespace, filter_json or {}, limit,
         max_chars, full_text, paid_embed, rerank],
        sort_keys=True,
    )
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def _cache_get(key):
    if key in _QUERY_CACHE:
        _QUERY_CACHE.move_to_end(key)
        return _QUERY_CACHE[key]
    return None


def _cache_put(key, value):
    _QUERY_CACHE[key] = value
    _QUERY_CACHE.move_to_end(key)
    if len(_QUERY_CACHE) > _QUERY_CACHE_MAX:
        _QUERY_CACHE.popitem(last=False)


def _cache_clear():
    _QUERY_CACHE.clear()


# ── Tool implementations ──────────────────────────────────────────────────────

def _truncate_text(text: str, max_chars: int, full_text: bool) -> str:
    """Shared truncation rule: a single chunk is ~600 words (800+ tokens), so
    returning it in full for every hit would cost thousands of tokens per
    search call. Pass full_text=True (or max_chars=0) to skip truncation."""
    if not full_text and max_chars and len(text) > max_chars:
        return text[:max_chars] + "…"
    return text


def _normalize_match(m: dict, max_chars: int = 500, full_text: bool = False) -> dict:
    """Pinecone returns slightly different shapes from /query vs /records/search.
    Normalize to a single dict shape that callers can rely on."""
    meta = m.get("metadata") or m.get("fields") or {}
    score = m.get("score", m.get("_score", 0)) or 0
    text = _truncate_text(meta.get("text", "") or "", max_chars, full_text)
    return {
        "id":       m.get("id", m.get("_id", "")),
        "score":    round(score, 4),
        "text":     text,
        "title":    meta.get("title", ""),
        "source":   meta.get("source", ""),
        "doc_type": meta.get("doc_type", ""),
        "section":  meta.get("section", ""),
        "tags":     meta.get("tags", ""),
    }


# ── Local reranking (cross-encoder, optional) ────────────────────────────────
# Dense cosine similarity alone is good at "vibes" but sloppy at precision —
# the actually-best-matching chunk is often outside the top-k. A small local
# cross-encoder re-scores a larger candidate pool for free, no API cost.

RERANK_MODEL = "cross-encoder/ms-marco-MiniLM-L-6-v2"
_RERANK_MODEL_CACHE: dict = {}
RERANK_POOL_MULTIPLIER = 4
RERANK_POOL_MIN = 20
RERANK_POOL_MAX = 30


def _get_reranker():
    if RERANK_MODEL not in _RERANK_MODEL_CACHE:
        try:
            from sentence_transformers import CrossEncoder
        except ImportError:
            raise RuntimeError(
                "Local reranking requires sentence-transformers.\n"
                "  Install:  pip install sentence-transformers"
            )
        _RERANK_MODEL_CACHE[RERANK_MODEL] = CrossEncoder(RERANK_MODEL)
    return _RERANK_MODEL_CACHE[RERANK_MODEL]


def _rerank_results(query: str, results: list, top_n: int) -> tuple:
    """Re-score a candidate pool with a local cross-encoder and keep the best
    top_n. Falls back to the original (dense-similarity) order — truncated to
    top_n — if the cross-encoder isn't installed, rather than failing the
    search. Returns (results, did_rerank)."""
    if not results:
        return results, False
    try:
        model = _get_reranker()
    except RuntimeError:
        return results[:top_n], False
    pairs = [(query, r["text"]) for r in results]
    scores = model.predict(pairs)
    for r, s in zip(results, scores):
        r["rerank_score"] = round(float(s), 4)
    ranked = sorted(results, key=lambda r: r["rerank_score"], reverse=True)
    return ranked[:top_n], True


def _local_embed_query(text: str, dimension: int) -> list:
    """Encode a query string locally using sentence-transformers.

    Uses the same intfloat/multilingual-e5-* family that Pinecone's integrated
    inference uses, so the resulting vector is compatible with any index built
    with either integrated or local (--client-embed) uploads.

    The 'query: ' prefix is required by e5 models for retrieval queries
    (as opposed to 'passage: ' used during indexing).
    """
    model_name = _DIM_TO_LOCAL_MODEL.get(dimension, "intfloat/multilingual-e5-large")
    if model_name not in _LOCAL_MODEL_CACHE:
        try:
            from sentence_transformers import SentenceTransformer
        except ImportError:
            raise RuntimeError(
                "Local embedding fallback requires sentence-transformers.\n"
                "  Install:  pip install sentence-transformers"
            )
        _LOCAL_MODEL_CACHE[model_name] = SentenceTransformer(model_name)
    model = _LOCAL_MODEL_CACHE[model_name]
    vec = model.encode([e5_query_prefix(text)], normalize_embeddings=True, show_progress_bar=False)
    return vec[0].tolist()


def _search_local(index_name: str, host: str, query: str, limit: int, namespace: str,
                   filter_json: dict, max_chars: int, full_text: bool) -> dict:
    """Embed the query locally and hit Pinecone's raw vector endpoint. Zero
    embedding-token cost. Raises if sentence-transformers isn't installed —
    tool_search catches that and falls back to paid_embed in that case only."""
    meta = _fetch_index_meta(index_name)
    dim = int(meta.get("dimension") or 1024)
    vector = _local_embed_query(query, dim)
    vec_url = f"https://{host}/query"
    vec_body: dict = {
        "vector": vector,
        "top_k": int(limit),
        "includeMetadata": True,
    }
    if namespace:
        vec_body["namespace"] = namespace
    if filter_json:
        vec_body["filter"] = filter_json
    vec_resp = _request_with_retry(
        "POST", vec_url,
        headers={**_auth_headers(), "Content-Type": "application/json"},
        json=vec_body, timeout=30,
    )
    if vec_resp.ok:
        matches = vec_resp.json().get("matches", [])
        results = [_normalize_match(m, max_chars, full_text) for m in matches]
        return {"query": query, "index": index_name, "namespace": namespace,
                "filter": filter_json or {}, "results": results, "count": len(results),
                "embedding": "local"}
    raise RuntimeError(
        f"Local-embed search failed: HTTP {vec_resp.status_code} — {vec_resp.text[:300]}"
    )


def _search_paid(index_name: str, host: str, query: str, limit: int, namespace: str,
                  filter_json: dict, max_chars: int, full_text: bool) -> dict:
    """Search via Pinecone's integrated-embedding records endpoint (costs
    embedding tokens). Falls back to local embedding if the index has no
    inference configured (400/404) or the monthly quota is exhausted (429)."""
    from urllib.parse import quote
    ns = namespace or "__default__"
    url = f"https://{host}/records/namespaces/{quote(ns)}/search"
    query_body = {"top_k": int(limit), "inputs": {"text": query}}
    if filter_json:
        query_body["filter"] = filter_json
    body = {
        "query": query_body,
        "fields": ["text", "title", "source", "doc_type", "section", "tags"],
    }
    resp = _request_with_retry(
        "POST", url,
        headers={**_auth_headers(), "Content-Type": "application/json"},
        json=body, timeout=30,
    )
    if resp.ok:
        hits = (resp.json().get("result") or {}).get("hits", [])
        results = [_normalize_match(h, max_chars, full_text) for h in hits]
        return {"query": query, "index": index_name, "namespace": namespace,
                "filter": filter_json or {}, "results": results, "count": len(results),
                "embedding": "paid"}

    body_lower = resp.text.lower()
    quota_hit = resp.status_code == 429 and (
        "resource_exhausted" in body_lower or "embedding token limit" in body_lower
        or "quota" in body_lower
    )
    if resp.status_code in (400, 404) or quota_hit:
        return _search_local(index_name, host, query, limit, namespace, filter_json,
                              max_chars, full_text)

    raise RuntimeError(f"Search failed: HTTP {resp.status_code} — {resp.text[:300]}")


def tool_search(index_name: str, query: str, limit: int = 5, namespace: str = "",
                filter_json: dict = None, max_chars: int = 500, full_text: bool = False,
                paid_embed: bool = False, rerank: bool = True) -> dict:
    """Semantic search across the knowledge base.

    Defaults to free local embedding (sentence-transformers, same intfloat/e5
    model family Pinecone's integrated inference uses) so searches cost zero
    embedding tokens. Pass paid_embed=True to use Pinecone's integrated
    inference instead (costs tokens against the shared monthly quota).
    Optionally scope results with a metadata filter (e.g. {"doc_type": {"$eq": "book"}}).
    Repeat identical searches within the same server process are served from
    an in-memory cache (see "cached" key in the response).

    Reranking (default on): dense cosine similarity alone often misses the
    actually-best chunk outside the top-k. When rerank=True, a larger
    candidate pool is fetched and re-scored locally with a cross-encoder
    (free, no API cost) before truncating to `limit`. Falls back to plain
    dense ordering if sentence-transformers isn't installed (see the
    "reranked" key in the response).
    """
    cache_key = _cache_key(index_name, query, namespace, filter_json, limit,
                            max_chars, full_text, paid_embed, rerank)
    cached = _cache_get(cache_key)
    if cached is not None:
        return {**cached, "cached": True}

    host = _resolve_host(index_name)

    # When reranking, fetch a larger pool with full (untruncated) text so the
    # cross-encoder judges relevance against the whole chunk; truncate the
    # final, already-reranked selection per the caller's own preference.
    fetch_limit = min(max(limit * RERANK_POOL_MULTIPLIER, RERANK_POOL_MIN), RERANK_POOL_MAX) if rerank else limit
    fetch_full_text = True if rerank else full_text

    if paid_embed:
        result = _search_paid(index_name, host, query, fetch_limit, namespace, filter_json,
                               max_chars, fetch_full_text)
    else:
        try:
            result = _search_local(index_name, host, query, fetch_limit, namespace, filter_json,
                                    max_chars, fetch_full_text)
        except RuntimeError as e:
            if "sentence-transformers" not in str(e):
                raise
            result = _search_paid(index_name, host, query, fetch_limit, namespace, filter_json,
                                   max_chars, fetch_full_text)

    if rerank and result["results"]:
        result["results"], did_rerank = _rerank_results(query, result["results"], limit)
        for r in result["results"]:
            r["text"] = _truncate_text(r["text"], max_chars, full_text)
        result["count"] = len(result["results"])
        result["reranked"] = did_rerank
    else:
        result["results"] = result["results"][:limit]
        result["count"] = len(result["results"])
        result["reranked"] = False

    _cache_put(cache_key, result)
    return result


def tool_list_sources(index_name: str, namespace: str = "",
                      max_records: int = 5000) -> dict:
    """Return an inventory of distinct sources in an index/namespace, with chunk
    counts and titles aggregated from record metadata. Lets you (or the chat
    model) see what's actually loaded without having to guess via semantic search.

    Implementation: one zero-vector query against /query with includeMetadata=True,
    grouped in Python. `max_records` caps how many records we scan (Pinecone caps
    top_k at 10000); if you have more than that in a namespace, results are an
    approximation of the most recently written chunks.
    """
    meta = _fetch_index_meta(index_name)
    host = meta["host"]
    dim = int(meta.get("dimension") or 1024)

    url = f"https://{host}/query"
    body = {
        "vector": [0.0] * dim,
        "top_k": min(int(max_records), 10000),
        "includeMetadata": True,
    }
    if namespace:
        body["namespace"] = namespace

    resp = _request_with_retry(
        "POST", url,
        headers={**_auth_headers(), "Content-Type": "application/json"},
        json=body, timeout=60,
    )
    if not resp.ok:
        raise RuntimeError(f"List sources failed: HTTP {resp.status_code} — {resp.text[:300]}")

    matches = resp.json().get("matches", [])
    sources: dict[str, dict] = {}
    for m in matches:
        md = m.get("metadata") or {}
        src = md.get("source") or "(no source)"
        entry = sources.setdefault(src, {
            "source":         src,
            "title":          md.get("title", ""),
            "doc_type":       md.get("doc_type", ""),
            "tags":           md.get("tags", ""),
            "chunks":         0,
            "latest_timestamp": 0,
        })
        entry["chunks"] += 1
        ts = md.get("timestamp") or 0
        try:
            ts = int(ts)
        except (TypeError, ValueError):
            ts = 0
        if ts > entry["latest_timestamp"]:
            entry["latest_timestamp"] = ts

    inventory = sorted(sources.values(), key=lambda s: s["chunks"], reverse=True)
    truncated = len(matches) >= body["top_k"]
    return {
        "index":             index_name,
        "namespace":         namespace,
        "records_scanned":   len(matches),
        "distinct_sources":  len(inventory),
        "truncated":         truncated,
        "sources":           inventory,
    }


def tool_list_collections(index_name: str, namespace: str = "",
                          max_records: int = 5000) -> dict:
    """Return an inventory of distinct 'collection' values in a namespace.
    A 'collection' is a per-batch label set at upload time (e.g.
    'recall-04-05'). Lets you see what batches you've uploaded, how big each
    one is, and what kinds of content they contain — useful before deleting
    or filtering."""
    meta = _fetch_index_meta(index_name)
    host = meta["host"]
    dim = int(meta.get("dimension") or 1024)

    url = f"https://{host}/query"
    body = {
        "vector": [0.0] * dim,
        "top_k": min(int(max_records), 10000),
        "includeMetadata": True,
    }
    if namespace:
        body["namespace"] = namespace

    resp = _request_with_retry(
        "POST", url,
        headers={**_auth_headers(), "Content-Type": "application/json"},
        json=body, timeout=60,
    )
    if not resp.ok:
        raise RuntimeError(f"List collections failed: HTTP {resp.status_code} — {resp.text[:300]}")

    matches = resp.json().get("matches", [])
    collections: dict[str, dict] = {}
    untagged_chunks = 0
    for m in matches:
        md = m.get("metadata") or {}
        coll = md.get("collection")
        if not coll:
            untagged_chunks += 1
            continue
        entry = collections.setdefault(coll, {
            "collection":       coll,
            "chunks":           0,
            "distinct_sources": set(),
            "doc_types":        set(),
            "tags":             set(),
            "latest_timestamp": 0,
        })
        entry["chunks"] += 1
        if md.get("source"):
            entry["distinct_sources"].add(md["source"])
        if md.get("doc_type"):
            entry["doc_types"].add(md["doc_type"])
        for t in (md.get("tags") or "").split(","):
            t = t.strip()
            if t:
                entry["tags"].add(t)
        ts = md.get("timestamp") or 0
        try:
            ts = int(ts)
        except (TypeError, ValueError):
            ts = 0
        if ts > entry["latest_timestamp"]:
            entry["latest_timestamp"] = ts

    inventory = []
    for c in collections.values():
        inventory.append({
            "collection":         c["collection"],
            "chunks":             c["chunks"],
            "distinct_sources":   len(c["distinct_sources"]),
            "doc_types":          sorted(c["doc_types"]),
            "tags":               sorted(c["tags"])[:20],  # cap to keep payload sane
            "latest_timestamp":   c["latest_timestamp"],
        })
    inventory.sort(key=lambda c: c["chunks"], reverse=True)
    return {
        "index":              index_name,
        "namespace":          namespace,
        "records_scanned":    len(matches),
        "untagged_chunks":    untagged_chunks,
        "distinct_collections": len(inventory),
        "collections":        inventory,
    }


def tool_filter_by_metadata(index_name: str, filter_json: dict,
                             limit: int = 20, namespace: str = "") -> dict:
    """List records matching a metadata filter without a text query.
    Uses the index's actual dimension instead of assuming 1024."""
    meta = _fetch_index_meta(index_name)
    host = meta["host"]
    dim = int(meta.get("dimension") or 1024)

    url = f"https://{host}/query"
    body = {
        "vector": [0.0] * dim,
        "top_k": int(limit),
        "filter": filter_json,
        "includeMetadata": True,
    }
    if namespace:
        body["namespace"] = namespace

    resp = _request_with_retry(
        "POST", url,
        headers={**_auth_headers(), "Content-Type": "application/json"},
        json=body, timeout=30,
    )
    if not resp.ok:
        raise RuntimeError(f"Filter query failed: HTTP {resp.status_code} — {resp.text[:300]}")

    matches = resp.json().get("matches", [])
    results = []
    for m in matches:
        normalized = _normalize_match(m)
        normalized["text"] = (normalized["text"] or "")[:300]
        results.append(normalized)
    return {"filter": filter_json, "index": index_name, "results": results, "count": len(results)}


def tool_upsert(index_name: str, records: list[dict], namespace: str = "") -> dict:
    """Add or update records. Each record must have '_id' and 'text' fields."""
    if not records:
        return {"upserted": 0, "index": index_name, "namespace": namespace}
    for r in records:
        if "_id" not in r or "text" not in r:
            raise ValueError("Every record must include '_id' and 'text' fields.")

    host = _resolve_host(index_name)
    if namespace:
        from urllib.parse import quote
        url = f"https://{host}/records/namespaces/{quote(namespace)}/upsert"
    else:
        url = f"https://{host}/records/upsert"

    headers = {**_auth_headers(), "Content-Type": "application/x-ndjson"}
    ndjson = "\n".join(json.dumps(r) for r in records)

    resp = _request_with_retry("POST", url, headers=headers, data=ndjson, timeout=60)
    if not resp.ok:
        raise RuntimeError(f"Upsert failed: HTTP {resp.status_code} — {resp.text[:300]}")
    _cache_clear()  # avoid serving stale search results after an edit
    return {"upserted": len(records), "index": index_name, "namespace": namespace}


def tool_delete(index_name: str, ids: list[str] = None,
                filter_json: dict = None, namespace: str = "",
                delete_all: bool = False, confirm: str = "") -> dict:
    """Delete records by ID list, metadata filter, or wipe a namespace.

    `delete_all=True` is destructive and requires `confirm` to equal the literal
    string 'DELETE' to actually run, so an LLM can't accidentally wipe a namespace.
    """
    if delete_all and confirm != "DELETE":
        raise ValueError(
            "delete_all=True requires confirm='DELETE' (verbatim). "
            "Refusing to wipe namespace without explicit confirmation."
        )

    host = _resolve_host(index_name)
    url = f"https://{host}/vectors/delete"
    body = {}
    if delete_all:
        body["deleteAll"] = True
    elif ids:
        body["ids"] = ids
    elif filter_json:
        body["filter"] = filter_json
    else:
        raise ValueError("Provide ids, filter_json, or delete_all=True.")
    if namespace:
        body["namespace"] = namespace

    resp = _request_with_retry(
        "POST", url,
        headers={**_auth_headers(), "Content-Type": "application/json"},
        json=body, timeout=30,
    )
    if not resp.ok:
        raise RuntimeError(f"Delete failed: HTTP {resp.status_code} — {resp.text[:300]}")
    _cache_clear()  # avoid serving stale search results after an edit
    return {"deleted": True, "index": index_name, "params": body}


def tool_index_info(index_name: str = "") -> dict:
    """Return index statistics. If index_name is empty, lists all indexes."""
    if not index_name:
        names = _list_index_names()
        return {"indexes": names}

    meta = _fetch_index_meta(index_name)
    host = meta["host"]
    resp = _request_with_retry(
        "GET",
        f"https://{host}/describe_index_stats",
        headers=_auth_headers(),
        timeout=15,
    )
    if not resp.ok:
        raise RuntimeError(f"Stats failed: HTTP {resp.status_code} — {resp.text[:300]}")
    data = resp.json()
    return {
        "index":            index_name,
        "total_vectors":    data.get("totalVectorCount", data.get("total_vector_count", 0)),
        "dimension":        data.get("dimension", meta.get("dimension", 1024)),
        "metric":           meta.get("metric", "cosine"),
        "namespaces":       data.get("namespaces", {}),
        "fullness":         data.get("indexFullness", 0),
    }


# ── MCP stdio protocol ────────────────────────────────────────────────────────

TOOLS = [
    {
        "name": "pinecone_search",
        "description": (
            "Semantic search across your Pinecone knowledge base using natural language. "
            "Returns the most relevant chunks with scores, titles, sources, and text snippets. "
            "Optionally accepts a metadata filter to scope results (e.g. only one source file or doc_type). "
            "Defaults to free local embedding (zero cost against the monthly quota) plus a free local "
            "cross-encoder rerank pass over a larger candidate pool for better precision; "
            "identical repeat searches are served from cache within the same session."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "index_name":  {"type": "string", "description": "Pinecone index name (e.g. 'peace')"},
                "query":       {"type": "string", "description": "Natural language search query"},
                "limit":       {"type": "integer", "description": "Max results to return (default 5)", "default": 5},
                "namespace":   {"type": "string", "description": "Namespace to search (default: all)", "default": ""},
                "filter_json": {
                    "type": "object",
                    "description": "Optional Pinecone metadata filter, e.g. {\"doc_type\":{\"$eq\":\"book\"}} or {\"source\":{\"$eq\":\"C:/Notes/X.md\"}}",
                },
                "max_chars":   {"type": "integer", "description": "Truncate each result's text to this many characters (default 500, 0 = no truncation)", "default": 500},
                "full_text":   {"type": "boolean", "description": "Return each result's full untruncated chunk text (default false)", "default": False},
                "paid_embed":  {"type": "boolean", "description": "Use Pinecone's paid integrated-embedding inference instead of free local embedding (default false)", "default": False},
                "rerank":      {"type": "boolean", "description": "Re-score a larger candidate pool with a local cross-encoder before truncating to limit — improves precision, free (default true)", "default": True},
            },
            "required": ["index_name", "query"],
        },
    },
    {
        "name": "pinecone_list_collections",
        "description": (
            "List every distinct 'collection' batch label loaded in a namespace, "
            "with chunk counts, source counts, doc types and tags. Use this to see "
            "which upload batches exist (e.g. 'recall-04-05', 'books-2026-q2') so "
            "you can filter or delete them as a unit."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "index_name":  {"type": "string", "description": "Pinecone index name"},
                "namespace":   {"type": "string", "description": "Namespace to scan", "default": ""},
                "max_records": {"type": "integer", "description": "Max records to scan when aggregating (default 5000, cap 10000)", "default": 5000},
            },
            "required": ["index_name"],
        },
    },
    {
        "name": "pinecone_list_sources",
        "description": (
            "List every distinct source file currently loaded in the index/namespace, "
            "with chunk counts, titles, doc types and tags. Use this BEFORE searching to see "
            "what knowledge is actually available, or to confirm an upload landed."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "index_name":  {"type": "string", "description": "Pinecone index name"},
                "namespace":   {"type": "string", "description": "Namespace (default: root)", "default": ""},
                "max_records": {"type": "integer", "description": "Max records to scan when aggregating (default 5000, cap 10000)", "default": 5000},
            },
            "required": ["index_name"],
        },
    },
    {
        "name": "pinecone_filter_by_metadata",
        "description": (
            "List records matching a metadata filter without a text query. "
            "Useful for browsing by doc_type, tags, source path, etc."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "index_name":  {"type": "string", "description": "Pinecone index name"},
                "filter_json": {
                    "type": "object",
                    "description": "Pinecone metadata filter, e.g. {\"doc_type\": {\"$eq\": \"book\"}} or {\"tags\": {\"$in\": [\"philosophy\"]}}",
                },
                "limit":     {"type": "integer", "description": "Max results (default 20)", "default": 20},
                "namespace": {"type": "string", "description": "Namespace (default: all)", "default": ""},
            },
            "required": ["index_name", "filter_json"],
        },
    },
    {
        "name": "pinecone_upsert",
        "description": "Add or update records in a Pinecone index. Each record needs '_id' and 'text' at minimum.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "index_name": {"type": "string", "description": "Pinecone index name"},
                "records": {
                    "type": "array",
                    "description": "Array of records. Each must have '_id' (string) and 'text' (string). Optional: title, doc_type, tags, source.",
                    "items": {"type": "object"},
                },
                "namespace": {"type": "string", "description": "Target namespace (default: root)", "default": ""},
            },
            "required": ["index_name", "records"],
        },
    },
    {
        "name": "pinecone_delete",
        "description": (
            "Delete records from a Pinecone index by ID list, metadata filter, or wipe a whole namespace. "
            "Wiping a namespace (delete_all=true) requires the human-supplied confirm='DELETE' guard."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "index_name":  {"type": "string", "description": "Pinecone index name"},
                "ids":         {"type": "array", "items": {"type": "string"}, "description": "List of record IDs to delete"},
                "filter_json": {"type": "object", "description": "Delete all records matching this metadata filter"},
                "namespace":   {"type": "string", "description": "Target namespace", "default": ""},
                "delete_all":  {"type": "boolean", "description": "If true, delete all records in the namespace (requires confirm='DELETE')", "default": False},
                "confirm":     {"type": "string", "description": "Must be the literal string 'DELETE' when delete_all is true.", "default": ""},
            },
            "required": ["index_name"],
        },
    },
    {
        "name": "pinecone_index_info",
        "description": "Get index statistics (vector count, dimension, namespaces). If no index_name given, lists all available indexes.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "index_name": {"type": "string", "description": "Index name (leave empty to list all indexes)", "default": ""},
            },
        },
    },
    {
        "name": "pinecone_summarize_namespace",
        "description": (
            "Turn a namespace's (optionally metadata-filtered) chunks into a compact topic "
            "summary — top terms, representative excerpts, and chunk/source counts per topic — "
            "instead of reading raw pinecone_search chunks to find themes. Use this before "
            "writing an insight or action-plan summary of a knowledge-base namespace. Entirely "
            "local and free (zero embedding tokens); cached per (index, namespace, filter), so "
            "repeat calls without new uploads are instant."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "index_name":  {"type": "string", "description": "Pinecone index name (e.g. 'peace')"},
                "namespace":   {"type": "string", "description": "Namespace to summarize", "default": ""},
                "filter_json": {
                    "type": "object",
                    "description": "Optional Pinecone metadata filter to scope which chunks are summarized, e.g. {\"collection\":{\"$eq\":\"100M-Offers\"}}",
                },
                "n_topics":    {"type": "integer", "description": "Number of topics to extract (default 8)", "default": 8},
                "max_records": {"type": "integer", "description": "Max chunks to scan (default 5000, cap 10000)", "default": 5000},
                "method":      {"type": "string", "enum": ["tfidf_nmf", "kmeans_embeddings"], "description": "'tfidf_nmf' (default, free/lexical) or 'kmeans_embeddings' (semantic, capped at 1500 records since it needs raw vectors)", "default": "tfidf_nmf"},
                "refresh":     {"type": "boolean", "description": "Force recompute even if a fresh cache exists (default false)", "default": False},
            },
            "required": ["index_name"],
        },
    },
]


def _send(obj: dict):
    line = json.dumps(obj, ensure_ascii=False)
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def _error(req_id, code: int, message: str):
    _send({"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}})


def _call_tool(name: str, args: dict) -> str:
    if name == "pinecone_search":
        result = tool_search(
            index_name=args["index_name"],
            query=args["query"],
            limit=int(args.get("limit", 5)),
            namespace=args.get("namespace", ""),
            filter_json=args.get("filter_json"),
            max_chars=int(args.get("max_chars", 500)),
            full_text=bool(args.get("full_text", False)),
            paid_embed=bool(args.get("paid_embed", False)),
            rerank=bool(args.get("rerank", True)),
        )
    elif name == "pinecone_list_sources":
        result = tool_list_sources(
            index_name=args["index_name"],
            namespace=args.get("namespace", ""),
            max_records=int(args.get("max_records", 5000)),
        )
    elif name == "pinecone_list_collections":
        result = tool_list_collections(
            index_name=args["index_name"],
            namespace=args.get("namespace", ""),
            max_records=int(args.get("max_records", 5000)),
        )
    elif name == "pinecone_filter_by_metadata":
        result = tool_filter_by_metadata(
            index_name=args["index_name"],
            filter_json=args["filter_json"],
            limit=int(args.get("limit", 20)),
            namespace=args.get("namespace", ""),
        )
    elif name == "pinecone_upsert":
        result = tool_upsert(
            index_name=args["index_name"],
            records=args["records"],
            namespace=args.get("namespace", ""),
        )
    elif name == "pinecone_delete":
        result = tool_delete(
            index_name=args["index_name"],
            ids=args.get("ids"),
            filter_json=args.get("filter_json"),
            namespace=args.get("namespace", ""),
            delete_all=bool(args.get("delete_all", False)),
            confirm=args.get("confirm", ""),
        )
    elif name == "pinecone_index_info":
        result = tool_index_info(index_name=args.get("index_name", ""))
    elif name == "pinecone_summarize_namespace":
        import pinecone_insights
        result = pinecone_insights.summarize_namespace(
            index_name=args["index_name"],
            namespace=args.get("namespace", ""),
            filter_json=args.get("filter_json"),
            n_topics=int(args.get("n_topics", 8)),
            max_records=int(args.get("max_records", 5000)),
            method=args.get("method", "tfidf_nmf"),
            refresh=bool(args.get("refresh", False)),
        )
    else:
        raise ValueError(f"Unknown tool: {name}")
    return json.dumps(result, indent=2, ensure_ascii=False)


def serve():
    # MCP is UTF-8 by spec; on Windows Python defaults stdout to cp1252 which
    # blows up the moment any non-ASCII slips through (arrows, smart quotes,
    # accented letters, emoji). Force UTF-8 here.
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

    if not PINECONE_API_KEY:
        sys.stderr.write("WARNING: PINECONE_API_KEY not set — tools will fail.\n")
        sys.stderr.flush()

    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            req = json.loads(raw)
        except json.JSONDecodeError:
            continue

        req_id = req.get("id")
        method = req.get("method", "")

        if method == "initialize":
            _send({
                "jsonrpc": "2.0", "id": req_id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "pinecone-kb", "version": "1.0.0"},
                },
            })

        elif method == "tools/list":
            _send({"jsonrpc": "2.0", "id": req_id, "result": {"tools": TOOLS}})

        elif method == "tools/call":
            params = req.get("params", {})
            name   = params.get("name", "")
            args   = params.get("arguments") or {}
            try:
                text = _call_tool(name, args)
                _send({
                    "jsonrpc": "2.0", "id": req_id,
                    "result": {"content": [{"type": "text", "text": text}]},
                })
            except Exception as exc:
                _error(req_id, -32603, str(exc))

        elif method in ("notifications/initialized", "ping"):
            if req_id is not None:
                _send({"jsonrpc": "2.0", "id": req_id, "result": {}})

        else:
            if req_id is not None:
                _error(req_id, -32601, f"Method not found: {method}")


if __name__ == "__main__":
    serve()
