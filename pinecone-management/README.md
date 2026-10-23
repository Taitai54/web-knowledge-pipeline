# Pinecone Management

Bulk-upload documents to a Pinecone index and query them via an MCP server in Claude Code. Embeds locally by default on both the upload and query sides, so normal use costs zero embedding tokens.

| Script | Role |
|--------|------|
| `pinecone_bulk.py` | CLI — chunk, embed, and upload `.md / .txt / .rst / .pdf` files |
| `pinecone_gui.py` | CustomTkinter GUI wrapper around the CLI |
| `pinecone_mcp.py` | MCP server — exposes Pinecone search tools to Claude |
| `pinecone_insights.py` | Local topic-modeling — turns a namespace into a compact theme summary (free, cached) |
| `pinecone_shared.py` | Shared config/constants + HTTP helpers used by the four scripts above |

---

## Prerequisites

```bash
# Core (always required)
pip install requests pypdf pyyaml

# GUI
pip install -r requirements.txt -r requirements-gui.txt

# Local embedding — the default for uploads and queries (~2 GB download on first run)
pip install sentence-transformers

# Local topic-modeling / insights (pinecone_insights.py, --summarize-namespace)
pip install scikit-learn

# search_server.py — HTTP retrieval for the Next.js RAG chat (port 8765).
# Not used by the CLI, GUI, or MCP server. See ../ARCHITECTURE.md.
pip install -r requirements.txt -r requirements-search.txt
```

Set your API key:
```bash
# Windows (persists across sessions)
setx PINECONE_API_KEY "your-key-here"

# Or per-session
set PINECONE_API_KEY=your-key-here
```

---

## CLI — `pinecone_bulk.py`

```bash
# Upload a folder of books (embeds locally by default — no flag needed)
python pinecone_bulk.py "C:\Books\Marketing" --index-name peace --namespace books

# Auto-tag each book's chunks with its top folder name as 'collection' metadata
python pinecone_bulk.py "C:\Books" --index-name peace --namespace books \
    --collection-from-top-folder

# Preview without uploading
python pinecone_bulk.py "C:\Books\book.pdf" --index-name peace --dry-run

# List what's already uploaded
python pinecone_bulk.py --index-name peace --list-sources --limit 50
python pinecone_bulk.py --index-name peace --list-sources --namespace books --limit 100

# Local topic-model summary of a namespace (free, cached — see pinecone_insights.py)
python pinecone_bulk.py --index-name peace --namespace books --summarize-namespace
```

### Key flags

| Flag | Effect |
|------|--------|
| `--paid-embed` | Use Pinecone's integrated (token-billed) embedding instead of the free local default. |
| `--client-embed` | Deprecated no-op — local embedding is already the default; kept for backward compatibility. |
| `--collection-from-top-folder` | Tags each chunk with its top subfolder as `collection` metadata — enables book-scoped filtering at query time. |
| `--namespace-from-top-folder` | Routes each file to a namespace named after its top subfolder. |
| `--prune-by-source` | Delete existing chunks for each source before re-uploading (use when editing files). |
| `--force` | Re-upload even if chunk IDs already exist in the index. |
| `--dry-run` | Preview chunking and first record; no network writes. |
| `--list-sources` | List unique sources in the index sorted by most-recent timestamp. |
| `--summarize-namespace` | Print a local topic-model summary of a namespace instead of uploading (requires `scikit-learn`). |

### Auto-fallbacks

The uploader self-heals without requiring manual intervention:
- **Quota exhausted (429)** → switches to local `sentence-transformers` embedding for the rest of the run
- **Inference not configured (400)** → same, and auto-selects the model matching the index's dimension
- **Dimension mismatch (400)** → extracts the correct dimension from the error message, swaps model, retries

---

## GUI — `pinecone_gui.py`

```bash
python pinecone_gui.py
```

Provides a point-and-click interface over all CLI flags. Settings persist between sessions in `pinecone_config.json`.

**Tip:** Tick **"Auto-collection from top folder"** so each book's chunks are tagged with the folder name — makes book-scoped queries reliable.

---

## MCP Server — `pinecone_mcp.py`

Register in `~/.claude.json` (adjust path):

```json
{
  "mcpServers": {
    "pinecone-kb": {
      "type": "stdio",
      "command": "python",
      "args": ["C:\\Users\\you\\GitHub\\pinecone-management\\pinecone_mcp.py"]
    }
  }
}
```

### Tools exposed to Claude

| Tool | What it does |
|------|-------------|
| `pinecone_search` | Semantic search. Embeds the query locally by default (zero token cost); pass `paid_embed=true` to use Pinecone's integrated inference instead. Also reranks a larger candidate pool locally with a free cross-encoder by default (`rerank=false` to disable) — dense similarity alone often misses the best chunk outside the top-k. Text is truncated to 500 chars by default (`max_chars`/`full_text` override). Repeat identical searches in a session are served from an in-memory cache. |
| `pinecone_summarize_namespace` | Local topic-model summary of a namespace (top terms, excerpts, chunk/source counts per topic) — free and cached; use this before turning a namespace into insight/action plans instead of reading raw search chunks. |
| `pinecone_filter_by_metadata` | Filter by exact metadata values (collection, doc_type, tags, source). |
| `pinecone_list_sources` | Inventory of distinct sources with chunk counts. |
| `pinecone_list_collections` | Inventory of distinct `collection` values. |
| `pinecone_index_info` | Index stats, namespace list, vector counts. |
| `pinecone_upsert` | Add/update records. |
| `pinecone_delete` | Delete records by ID or filter. |

### Querying from Claude

**Always specify a namespace** — the default namespace is empty:

```
Search my books namespace for the key ideas in 100 million dollar offers
```

Key namespaces in the `peace` index: `books`, `Recall upload`, `notebook-lm-knowledge`, `advisory-marketing`, `advisory-strategy`, `ai-technology`.

To scope a query to one book:
```
Search the books namespace, filter by collection = "100M-Offers", find ideas about pricing
```

---

## Supported file types

| Extension | doc_type default |
|-----------|-----------------|
| `.pdf` | `book` |
| `.md` | `markdown` |
| `.txt`, `.rst` | `notes` |

Override with `--doc-type {book,kb,notes,markdown}` or `--doc-type-from-folder`.

---

## Search server — RAG chat retrieval

The web app's RAG Chat Playground calls this process. It is not started by `npm run dev`.

```bash
# from the repo root, with PINECONE_API_KEY set
npm run search-server
```

It listens on http://localhost:8765, embeds the query locally (`query:` prefix), and returns Pinecone matches. Claude's `pinecone_mcp.py` search is a separate path and adds reranking; the chat UI does not use it.

The full pipeline (scrape → sync → chat) is documented in `../ARCHITECTURE.md`.

## Tests

```bash
python -m pytest -q                          # all tests
python -m pytest tests/ -q -k "sentinel"     # single test by keyword
```

Tests run without a real Pinecone connection — all network calls are monkeypatched. Covers
`pinecone_bulk.py`/`pinecone_gui.py` (`test_upload_hang_fixes.py`), `pinecone_mcp.py`
(`test_pinecone_mcp.py`), and `pinecone_insights.py` (`test_pinecone_insights.py`, which runs the real
scikit-learn TF-IDF/NMF code against synthetic multi-topic text).
