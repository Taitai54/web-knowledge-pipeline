# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Run all tests
python -m pytest -q

# Run a single test
python -m pytest tests/test_upload_hang_fixes.py::test_vector_upsert_batches_respect_payload_limit -q

# Syntax check all three files
python -m py_compile pinecone_bulk.py pinecone_gui.py pinecone_mcp.py

# Dry-run upload (no network writes, previews first record)
python pinecone_bulk.py <paths> --dry-run --index-name peace

# List uploaded sources in the index
python pinecone_bulk.py --index-name peace --list-sources --limit 50

# Install core deps
pip install requests pypdf pyyaml

# Install GUI deps
pip install -r requirements.txt -r requirements-gui.txt

# Install local-embedding deps (~2 GB download on first run; this is now the default embed path)
pip install sentence-transformers

# Install local topic-modeling deps (pinecone_insights.py / --summarize-namespace)
pip install scikit-learn
```

## Architecture

`pinecone_bulk.py`, `pinecone_mcp.py`, `pinecone_insights.py`, and `search_server.py` share constants,
the dimension->model table, and e5 prefix helpers via `pinecone_shared.py` (also home to the
`_auth_headers`/`_request_with_retry`/`_fetch_index_meta` HTTP helpers, hoisted there specifically so
`pinecone_insights.py` doesn't have to import from `pinecone_mcp.py` and risk a circular import, since
`pinecone_mcp.py` imports `pinecone_insights` to register the `pinecone_summarize_namespace` tool).

`n8n_pinecone_gdrive_watcher.json` cannot import Python and hand-duplicates the chunking constants and
model table in JS. It has no local-embed fallback and always consumes paid embedding tokens on every
Drive-sourced upload. This is a known, accepted gap — update the n8n JS constants by hand if
`pinecone_shared.py`'s values change, or prefer running `pinecone_bulk.py` over the synced folder instead.

### `pinecone_bulk.py` — CLI uploader
Entry point is `main()`. Flow:
1. `resolve_index_info(name)` — single API call returns `(host, dimension)`
2. `iter_supported_files(paths, recursive)` — deduplicates file targets, returns `(file, root)` pairs
3. Per-file: `process_file(...)` → chunks → records with `_namespace` internal field
4. Records accumulate in `buckets[ns]`; `_flush_bucket()` uploads when a bucket hits `STREAM_FLUSH_RECORDS=1000` or at end-of-run
5. `_flush_bucket` calls either `upsert_batch` (integrated inference) or `upsert_batch_local` (local embedding)

**Two upload paths:**
- `upsert_batch` → POST `/records/upsert` (NDJSON, Pinecone embeds text, costs embedding tokens)
- `upsert_batch_local` → local sentence-transformers encode → POST `/vectors/upsert` (raw vectors, zero token cost)

**Auto-fallbacks in `_flush_bucket`** (checked in order after each batch):
- `quota_exhausted` (429) → switch to local embed
- `inference_not_configured` (400) → switch to local embed + auto-select model from `DIM_TO_LOCAL_MODEL`
- `dim_mismatch` (400 with dimension error) → extract correct dim from error message, reload model, retry once

**Local embed pipeline (`upsert_batch_local`):**
Producer/consumer via `queue.Queue(maxsize=2)`. Encoder runs on main thread; uploader thread drains the queue. Sentinel (`None`) delivered via retry loop (`while upload_thread.is_alive(): queue.put(None, timeout=5)`) to avoid hang when queue is full at encoding completion.

**Record metadata fields:** `_id` (SHA-1 content hash), `text`, `source`, `title`, `doc_type`, `section`, `chunk_index`, `chunk_count`, `timestamp`, optionally `tags`, `collection`, `_namespace` (stripped before upsert).

### `pinecone_gui.py` — CustomTkinter GUI
Wraps `pinecone_bulk.py` as a subprocess. Key design:
- `_build_cmd(paths)` constructs `[sys.executable, "-u", SCRIPT, *paths, ...]` — `-u` forces unbuffered output
- `_run_upload()` runs in a daemon thread; reads stdout line-by-line, queues `("log", line, tag)` and `("done", returncode)` messages
- `_drain_output()` runs on Tk main thread via `self.after(40, ...)`, drains the queue, calls `_set_idle()` only when `done` arrives
- `_stop()` calls `terminate()` but does NOT set `_upload_running=False` — drain loop keeps polling until the `done` sentinel arrives naturally
- `_render_sources()` caps at `MAX_VISIBLE=10` rows to avoid CTkFrame cascade freezes on large selections

### `pinecone_mcp.py` — MCP server (stdio transport)
Exposes 8 tools to Claude via JSON-RPC. Registered as `pinecone-kb` in `~/.claude.json`.

**`tool_search` local-first design (inverted from the original paid-first design):**
1. Default (`paid_embed=False`): `_search_local` — `_local_embed_query(text, dim)` → raw `/query`. Zero embedding tokens.
2. Only falls back to `_search_paid` (`/records/namespaces/{ns}/search`, costs tokens) if local embedding raises
   because `sentence-transformers` isn't installed.
3. `paid_embed=True` inverts it: tries `_search_paid` first, falling back to `_search_local` on 400/404/429-quota
   (the original reactive-fallback logic, preserved for this opt-in path).
4. Results are truncated to `max_chars` (default 500) via `_normalize_match`; pass `full_text=True` or
   `max_chars=0` for the untruncated chunk.
5. An in-memory LRU cache (`_QUERY_CACHE`, ~128 entries) keyed on the full call signature serves repeat
   identical searches within the same server process for free; `tool_upsert`/`tool_delete` clear it.
6. Reranking (default on, `rerank=True`): dense cosine similarity alone often misses the best-matching
   chunk outside the top-k. When enabled, a larger candidate pool (`limit * 4`, clamped to 20-30) is fetched
   with full untruncated text, re-scored locally with `cross-encoder/ms-marco-MiniLM-L-6-v2`
   (`_rerank_results`, free, ~80MB model, lazy-loaded/cached like the embedding models), then truncated to
   `limit` and re-applied the caller's `max_chars`/`full_text` preference. Falls back to plain dense
   ordering (`"reranked": false` in the response) if `sentence-transformers` isn't installed — never fails
   the search over a missing optional dependency.

`_local_embed_query` lazy-loads the matching `intfloat/multilingual-e5-*` model from `_DIM_TO_LOCAL_MODEL`
(imported from `pinecone_shared.DIM_TO_LOCAL_MODEL`), encodes with the `e5_query_prefix` helper, caches the
model in `_LOCAL_MODEL_CACHE`.

`tool_list_sources` and `tool_list_collections` use a zero-vector `/query` — no embedding cost.
`pinecone_insights.py`'s `_fetch_chunks` reuses this same zero-vector pattern to pull chunk text/metadata
(and optionally raw vector values) for local topic-modeling — also no embedding cost.

### `pinecone_insights.py` — local topic-modeling (no shared MCP/CLI process)
`summarize_namespace(index_name, namespace, filter_json, method="tfidf_nmf"|"kmeans_embeddings", ...)`:
fetches chunk text for free (zero-vector query), then runs local scikit-learn clustering — TF-IDF+NMF over
raw text by default (works off metadata already fetched, no vector values pulled), or k-means over embedding
vectors as an explicit opt-in capped at `KMEANS_MAX_RECORDS=1500` records (`includeValues=True` is expensive).
Results cache to `.pinecone_insights_cache/<hash>.json` (gitignored), invalidated by a 7-day TTL or a
`describe_index_stats` vector-count mismatch (i.e. a new upload happened). Exposed as the MCP tool
`pinecone_summarize_namespace` and the CLI flag `pinecone_bulk.py --summarize-namespace`.

## Pinecone Index: `peace`

**Always specify `namespace`** — the default namespace is empty. Key namespaces:

| Namespace | Contents |
|-----------|----------|
| `books` | Uploaded books (~17K vectors) |
| `Recall upload` | Bulk recall/notes (~52K vectors) |
| `notebook-lm-knowledge` | NotebookLM exports (~9K vectors) |
| `advisory-*` | Board advisor context (marketing, strategy, finance, etc.) |
| `ai-technology`, `coding`, `projects` | Misc knowledge |

Index dimension: 1024 (cosine metric). Compatible with `intfloat/multilingual-e5-large`.

## Known Gotchas

### Python `global` in nested functions
`_flush_bucket` is a nested function inside `main()`. Python's compile-time global resolution means **all** `global` declarations for the same name must appear once, at the top of the function — not inside conditional branches. Adding a second `global LOCAL_MODEL_ID, _LOCAL_MODEL` anywhere inside `_flush_bucket` causes `SyntaxError: name used prior to global declaration`. The single declaration lives at the very top of `_flush_bucket`.

### `resolve_index_info` returns `dim=1024` for host URLs
When the user passes a raw host URL (contains a `.`), the function can't look up the real dimension from the Pinecone API and defaults to 1024. This is why `_flush_bucket` has the `dim_mismatch` self-correction path: after the first failed upload, it extracts the actual required dimension from the HTTP 400 error body (`"dimension of the index (\d+)"` regex) and reloads the correct model. Don't trust `_get_dim()` to return the real index dimension when a host URL was passed.

### CTkLabel `<Configure>` cascade freezes Tkinter
`CTkLabel.configure(wraplength=...)` resizes the internal canvas, which fires another `<Configure>` event on the same label, which calls configure again — an infinite cascade that locks the Tk event loop. `_render_sources` previously bound `<Configure>` on each path label for dynamic wrapping; this was the cause of the GUI freezing when many files were added. The fix: truncate path strings statically to the last 3 path components instead. Never bind `<Configure>` on CTkLabel to call `configure()`.

### `_stop()` must not call `_set_idle()`
`_run_upload` always puts `("done", returncode)` on the queue in a `finally`-equivalent block (line after the try/except). If `_stop()` set `_upload_running=False`, `_drain_output` would stop polling before the `done` sentinel arrived, silently dropping the final returncode log and leaving the progress bar in a broken state. Only `_drain_output`'s `done` branch calls `_set_idle()`.

### Two distinct Pinecone upsert endpoints
- `/records/upsert` — NDJSON body, `Content-Type: application/x-ndjson`, requires integrated inference configured on the index. Used by `upsert_batch`.
- `/vectors/upsert` — JSON body, `Content-Type: application/json`, works on any index regardless of inference config. Used by `upsert_batch_local`.

These are not interchangeable. The records endpoint rejects raw vectors; the vectors endpoint rejects text records.

### Embedding token budget
The `peace` index has 10M embedding tokens/month shared between uploads and queries. **Local embedding is
now the default on both sides** — `pinecone_bulk.py` uploads and `pinecone_mcp.py`'s `pinecone_search` both
embed locally (zero tokens, same model quality) unless `--paid-embed`/`paid_embed=True` is explicitly passed.
The old `--client-embed` flag still works but is now a no-op (kept for backward compatibility). Paid
integrated embedding still self-heals: on quota exhaustion (429) it falls back to local automatically in
both the upload and query paths, so explicitly requesting `--paid-embed`/`paid_embed=True` never leaves you
stuck if the quota runs out mid-run.

### Sentence-transformers prefix convention
`intfloat/multilingual-e5-*` models require a task prefix:
- **Uploads:** `"passage: {text}"` — applied in `local_embed_passages`
- **Queries:** `"query: {text}"` — applied in `_local_embed_query` (MCP)

Using the wrong prefix silently degrades retrieval quality. Integrated inference handles this automatically; local paths must apply it explicitly.

### `collection` metadata for book-scoped retrieval
Every chunk can carry a `collection` field set via `--collection "name"` or `--collection-from-top-folder` (derives from top subfolder name). Use this for precise book-level filtering in the MCP:
```python
pinecone_filter_by_metadata(index="peace", namespace="books",
                             filter={"collection": {"$eq": "100M-Offers"}})
```
Without `collection`, you can only filter by `source` (full file path) or `title` (filename-derived).

## Testing Approach

Tests in `tests/test_upload_hang_fixes.py` cover upload-hang regressions without real Pinecone calls:
- `_gui_for_build_cmd()` builds a mock `App` using `object.__new__` to avoid Tkinter init
- `monkeypatch` replaces `_upload_embedded_batch`, `local_embed_passages`, and `requests.get`
- Sentinel hang tests run real threads with `thread.join(timeout=N)` and assert `not t.is_alive()`

When adding a new flag to `pinecone_gui.py`, add a matching `_Var(default)` entry to `_gui_for_build_cmd()` in the test file or `test_gui_launches_bulk_script_unbuffered` will fail with a RecursionError.

`tests/test_pinecone_mcp.py` and `tests/test_pinecone_insights.py` also run without real Pinecone calls
(monkeypatched `_request_with_retry`/`_local_embed_query`/`_fetch_chunks`) but exercise the real
`scikit-learn` TF-IDF/NMF code on synthetic multi-topic text, since scikit-learn is cheap enough to just run
in tests rather than mock.
