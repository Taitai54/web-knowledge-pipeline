#!/usr/bin/env python3
"""
Shared config and helpers for the pinecone-management toolkit.

Single-sourced here to remove the drift that existed when pinecone_bulk.py,
pinecone_mcp.py, and search_server.py each carried their own copy of the
chunking constants, the dimension->local-model table, and the Pinecone HTTP
helpers. pinecone_insights.py imports its HTTP helpers from here rather than
from pinecone_mcp.py, since pinecone_mcp.py imports pinecone_insights.py to
register the pinecone_summarize_namespace tool — importing the other
direction would be circular.

Note: n8n_pinecone_gdrive_watcher.json duplicates CHUNK_WORDS/OVERLAP/model
selection in JavaScript and cannot import this module. It has no local-embed
fallback and always consumes paid embedding tokens — treat pinecone_bulk.py
as the canonical ingestion path; update the n8n JS manually if these
constants change here.
"""

import os
import random
import time

import requests

# ── Chunking ──────────────────────────────────────────────────────────────────
CHUNK_WORDS = 600       # target words per chunk
OVERLAP_WORDS = 80      # word overlap between consecutive chunks
MIN_CHUNK_WORDS = 30    # discard chunks shorter than this

# ── Embedding model selection ────────────────────────────────────────────────
# Maps Pinecone index dimension -> the intfloat e5 model that produces it.
DIM_TO_LOCAL_MODEL = {
    384:  "intfloat/multilingual-e5-small",
    768:  "intfloat/multilingual-e5-base",
    1024: "intfloat/multilingual-e5-large",
}


def e5_passage_prefix(text: str) -> str:
    """e5 models require this prefix on the indexed ('passage') side."""
    return f"passage: {text}"


def e5_query_prefix(text: str) -> str:
    """e5 models require this prefix on the query side."""
    return f"query: {text}"


# ── Pinecone API auth ────────────────────────────────────────────────────────

def get_api_key() -> str:
    key = os.environ.get("PINECONE_API_KEY", "")
    if not key:
        try:
            import winreg
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Environment") as reg:
                key, _ = winreg.QueryValueEx(reg, "PINECONE_API_KEY")
        except Exception:
            pass
    return key or ""


PINECONE_API_KEY = get_api_key()

MAX_RETRIES = 3
INITIAL_RETRY_DELAY = 1.0
MAX_BACKOFF = 30.0

_INDEX_META_CACHE: dict = {}  # name -> {"host": ..., "dimension": ..., "metric": ...}


def auth_headers() -> dict:
    return {
        "Api-Key": PINECONE_API_KEY,
        "X-Pinecone-API-Version": "2025-04",
    }


def request_with_retry(method: str, url: str, **kwargs) -> "requests.Response":
    """HTTP request with exponential-backoff retry on 429/5xx and timeouts."""
    last_exc = None
    for attempt in range(MAX_RETRIES + 1):
        try:
            resp = requests.request(method, url, **kwargs)
            if resp.ok or (resp.status_code < 500 and resp.status_code != 429):
                return resp
            if attempt >= MAX_RETRIES:
                return resp
            retry_after = resp.headers.get("Retry-After", "")
            try:
                delay = float(retry_after) if retry_after else INITIAL_RETRY_DELAY * (2 ** attempt)
            except ValueError:
                delay = INITIAL_RETRY_DELAY * (2 ** attempt)
            delay = min(delay + random.uniform(0, 0.25 * delay), MAX_BACKOFF)
            time.sleep(delay)
        except (requests.Timeout, requests.RequestException) as exc:
            last_exc = exc
            if attempt >= MAX_RETRIES:
                raise
            time.sleep(min(INITIAL_RETRY_DELAY * (2 ** attempt), MAX_BACKOFF))
    if last_exc:
        raise last_exc
    raise RuntimeError("Request failed after retries")


def fetch_index_meta(index_name: str) -> dict:
    """Look up host, dimension, and metric for a given index. Cached."""
    if index_name in _INDEX_META_CACHE:
        return _INDEX_META_CACHE[index_name]
    resp = request_with_retry(
        "GET",
        "https://api.pinecone.io/indexes",
        headers={**auth_headers(), "X-Pinecone-Api-Version": "2024-07"},
        timeout=15,
    )
    if not resp.ok:
        raise RuntimeError(f"Could not list indexes: HTTP {resp.status_code}")
    for idx in resp.json().get("indexes", []):
        meta = {
            "host": idx.get("host", ""),
            "dimension": idx.get("dimension", 1024),
            "metric": idx.get("metric", "cosine"),
        }
        _INDEX_META_CACHE[idx.get("name", "")] = meta
    if index_name not in _INDEX_META_CACHE:
        raise RuntimeError(f"Index '{index_name}' not found in your Pinecone project.")
    return _INDEX_META_CACHE[index_name]
