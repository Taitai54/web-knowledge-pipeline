#!/usr/bin/env python3
"""
Local factorization / topic-modeling layer for the pinecone-management
knowledge base.

Fetches chunk text for free (a zero-vector /query call — the same pattern
tool_list_sources/tool_filter_by_metadata already use in pinecone_mcp.py, no
embedding cost), then runs entirely local scikit-learn clustering to produce
a compact topic summary: a few hundred tokens instead of the thousands raw
`pinecone_search` chunks would cost. Intended use: "what are the themes in
namespace X" -> cheap summary -> Claude turns that into insight/action plans.

Default method (tfidf_nmf) works purely off already-fetched chunk text — no
vector values are pulled, since a namespace of thousands of 1024-dim floats
would be hundreds of MB of JSON. An embeddings-based k-means method is
available as an explicit, size-capped opt-in for semantic (not just lexical)
clustering on a smaller, deliberately-scoped subset.

Results are cached to a local JSON file per (index, namespace, filter), so
repeat "give me insights on X" calls without new uploads are instant and
free; the cache auto-invalidates when the namespace's vector count changes
(a cheap describe_index_stats check) or after DEFAULT_TTL_SECONDS.
"""

import json
import time
from pathlib import Path

from pinecone_shared import auth_headers, fetch_index_meta, request_with_retry

CACHE_DIR = Path(__file__).parent / ".pinecone_insights_cache"
DEFAULT_TTL_SECONDS = 7 * 24 * 3600   # 7 days — personal KB, doesn't churn hourly
DEFAULT_N_TOPICS = 8
DEFAULT_MAX_RECORDS = 5000            # same cap tool_list_sources uses
KMEANS_MAX_RECORDS = 1500             # includeValues=True is expensive; keep small
EXCERPTS_PER_TOPIC = 2
EXCERPT_CHARS = 220


def _require_sklearn():
    try:
        import sklearn  # noqa: F401
    except ImportError:
        raise RuntimeError(
            "pinecone_insights requires scikit-learn.\n"
            "  Install:  pip install scikit-learn"
        )


# ── Free data fetch (zero-vector query, no embedding cost) ──────────────────

def _fetch_chunks(index_name: str, namespace: str = "", filter_json: dict = None,
                   max_records: int = DEFAULT_MAX_RECORDS, include_values: bool = False) -> list:
    """Fetch chunk text + metadata (optionally raw vector values) for free."""
    meta = fetch_index_meta(index_name)
    host = meta["host"]
    dim = int(meta.get("dimension") or 1024)

    url = f"https://{host}/query"
    body = {
        "vector": [0.0] * dim,
        "top_k": min(int(max_records), 10000),
        "includeMetadata": True,
        "includeValues": bool(include_values),
    }
    if namespace:
        body["namespace"] = namespace
    if filter_json:
        body["filter"] = filter_json

    resp = request_with_retry(
        "POST", url,
        headers={**auth_headers(), "Content-Type": "application/json"},
        json=body, timeout=60,
    )
    if not resp.ok:
        raise RuntimeError(f"Fetch chunks failed: HTTP {resp.status_code} — {resp.text[:300]}")

    matches = resp.json().get("matches", [])
    chunks = []
    for m in matches:
        md = m.get("metadata") or {}
        text = md.get("text", "")
        if not text:
            continue
        chunk = {
            "id":         m.get("id", ""),
            "text":       text,
            "source":     md.get("source", ""),
            "title":      md.get("title", ""),
            "doc_type":   md.get("doc_type", ""),
            "tags":       md.get("tags", ""),
            "collection": md.get("collection", ""),
        }
        if include_values and m.get("values"):
            chunk["_vector"] = m["values"]
        chunks.append(chunk)
    return chunks


def _fetch_total_vector_count(index_name: str, namespace: str = "") -> int:
    """Cheap /describe_index_stats call, used only to detect whether a
    namespace's size changed since the cache was written (i.e. an upload
    happened) — not to fetch content."""
    meta = fetch_index_meta(index_name)
    host = meta["host"]
    resp = request_with_retry(
        "GET", f"https://{host}/describe_index_stats",
        headers=auth_headers(), timeout=15,
    )
    if not resp.ok:
        raise RuntimeError(f"describe_index_stats failed: HTTP {resp.status_code}")
    data = resp.json()
    namespaces = data.get("namespaces", {})
    if namespace:
        return int((namespaces.get(namespace) or {}).get("vectorCount", 0))
    return int(data.get("totalVectorCount", data.get("total_vector_count", 0)))


# ── Local clustering / labeling (no Pinecone/API calls) ──────────────────────

def _label_clusters(chunks: list, cluster_labels, n_clusters: int) -> list:
    """Given chunk texts and an already-assigned cluster label per chunk
    (from either NMF-argmax or k-means over embeddings), produce a compact,
    human-readable topic summary per cluster via TF-IDF top-terms."""
    import numpy as np
    from sklearn.feature_extraction.text import TfidfVectorizer

    texts = [c["text"] for c in chunks]
    vectorizer = TfidfVectorizer(stop_words="english", max_df=0.95, min_df=1)
    X = vectorizer.fit_transform(texts)
    terms = vectorizer.get_feature_names_out()
    labels_arr = np.asarray(cluster_labels)

    topics = []
    for k in range(n_clusters):
        idx = np.where(labels_arr == k)[0]
        if len(idx) == 0:
            continue
        cluster_mean = np.asarray(X[idx].mean(axis=0)).ravel()
        top_term_idx = cluster_mean.argsort()[::-1][:8]
        top_terms = [terms[i] for i in top_term_idx if cluster_mean[i] > 0]

        # Representative excerpts: docs whose own TF-IDF vector best matches
        # the cluster's mean vector (cheap proxy for "most typical of this topic").
        scores = np.asarray(X[idx].dot(cluster_mean)).ravel()
        order = idx[np.argsort(scores)[::-1][:EXCERPTS_PER_TOPIC]]

        sources = sorted({chunks[i]["source"] for i in idx if chunks[i].get("source")})
        topics.append({
            "topic":          k,
            "top_terms":      top_terms,
            "chunk_count":    int(len(idx)),
            "source_count":   len(sources),
            "sample_sources": sources[:5],
            "excerpts": [
                (chunks[i]["text"][:EXCERPT_CHARS] + "…")
                if len(chunks[i]["text"]) > EXCERPT_CHARS else chunks[i]["text"]
                for i in order
            ],
        })
    topics.sort(key=lambda t: -t["chunk_count"])
    return topics


def _tfidf_nmf_topics(chunks: list, n_topics: int) -> list:
    """Default method: TF-IDF + NMF over raw chunk text. No vector values
    needed — works purely off metadata already fetched for free."""
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.decomposition import NMF

    if not chunks:
        return []
    texts = [c["text"] for c in chunks]
    vectorizer = TfidfVectorizer(stop_words="english", max_df=0.95, min_df=1)
    X = vectorizer.fit_transform(texts)
    if X.shape[1] == 0:
        return []

    n_topics = max(1, min(n_topics, len(texts), X.shape[1]))
    model = NMF(n_components=n_topics, init="nndsvda", random_state=0, max_iter=300)
    W = model.fit_transform(X)
    labels = W.argmax(axis=1)
    return _label_clusters(chunks, labels, n_topics)


def _kmeans_topics(chunks: list, n_clusters: int) -> list:
    """Opt-in method: k-means over already-fetched embedding vectors — more
    semantically aware than TF-IDF+NMF, but requires includeValues=True on
    the fetch (expensive), so callers should cap max_records small."""
    import numpy as np
    from sklearn.cluster import KMeans

    vectored = [c for c in chunks if c.get("_vector")]
    if not vectored:
        return []
    X = np.array([c["_vector"] for c in vectored])
    n_clusters = max(1, min(n_clusters, len(vectored)))
    km = KMeans(n_clusters=n_clusters, n_init=10, random_state=0)
    labels = km.fit_predict(X)
    return _label_clusters(vectored, labels, n_clusters)


# ── Caching ───────────────────────────────────────────────────────────────────

def _cache_path(index_name: str, namespace: str, filter_json: dict) -> Path:
    import hashlib
    key_raw = json.dumps([index_name, namespace, filter_json or {}], sort_keys=True)
    digest = hashlib.sha1(key_raw.encode("utf-8")).hexdigest()
    CACHE_DIR.mkdir(exist_ok=True)
    return CACHE_DIR / f"{digest}.json"


def _is_cache_stale(cache_path: Path, index_name: str, namespace: str, ttl_seconds: int) -> bool:
    if not cache_path.exists():
        return True
    try:
        with open(cache_path, "r", encoding="utf-8") as f:
            cached = json.load(f)
    except Exception:
        return True
    age = time.time() - cached.get("generated_at", 0)
    if age > ttl_seconds:
        return True
    try:
        current_count = _fetch_total_vector_count(index_name, namespace)
    except Exception:
        return False  # can't verify — trust the TTL rather than fail the call
    return current_count != cached.get("total_vector_count")


# ── Entry point ───────────────────────────────────────────────────────────────

def summarize_namespace(index_name: str, namespace: str = "", filter_json: dict = None,
                         n_topics: int = DEFAULT_N_TOPICS, max_records: int = DEFAULT_MAX_RECORDS,
                         method: str = "tfidf_nmf", refresh: bool = False,
                         ttl_seconds: int = DEFAULT_TTL_SECONDS) -> dict:
    """Turn a namespace's (optionally metadata-filtered) chunks into a compact
    topic summary — top terms, representative excerpts, and chunk/source
    counts per topic — instead of Claude having to read raw pinecone_search
    chunks to find themes. Cached per (index, namespace, filter); repeat
    calls without new uploads are instant and free.

    method: "tfidf_nmf" (default, free/lexical) or "kmeans_embeddings"
    (semantic, opt-in, capped at KMEANS_MAX_RECORDS since it needs raw vectors).
    """
    if method not in ("tfidf_nmf", "kmeans_embeddings"):
        raise ValueError("method must be 'tfidf_nmf' or 'kmeans_embeddings'")

    cache_path = _cache_path(index_name, namespace, filter_json)
    if not refresh and not _is_cache_stale(cache_path, index_name, namespace, ttl_seconds):
        with open(cache_path, "r", encoding="utf-8") as f:
            cached = json.load(f)
        cached["cached"] = True
        return cached

    _require_sklearn()

    if method == "kmeans_embeddings":
        capped = min(int(max_records), KMEANS_MAX_RECORDS)
        chunks = _fetch_chunks(index_name, namespace, filter_json, capped, include_values=True)
        topics = _kmeans_topics(chunks, n_topics)
        max_records = capped
    else:
        chunks = _fetch_chunks(index_name, namespace, filter_json, max_records)
        topics = _tfidf_nmf_topics(chunks, n_topics)

    total_count = _fetch_total_vector_count(index_name, namespace)
    records_scanned = len(chunks)

    result = {
        "index":              index_name,
        "namespace":          namespace,
        "filter":             filter_json or {},
        "method":             method,
        "n_topics_requested": n_topics,
        "records_scanned":    records_scanned,
        "truncated":          records_scanned >= max_records,
        "total_vector_count": total_count,
        "generated_at":       time.time(),
        "topics":             topics,
        "cached":             False,
    }

    try:
        cache_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    except Exception:
        pass  # cache is a nice-to-have; don't fail the call over a write error

    return result
