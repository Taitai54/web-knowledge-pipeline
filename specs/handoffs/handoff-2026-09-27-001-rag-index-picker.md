# Handoff: RAG index picker and Norton TLS fix

**Date**: 2026-09-27 13:49
**Module**: 09-validation

## Session Summary

The RAG playground was locked to one Pinecone index (`peace`). It now has an **Index** picker covering every index in the project. Each index is searched with the model and endpoint that match how it was built.

While doing that, I found that Norton Antivirus's Web/Mail Shield intercepts HTTPS and re-signs it with its own root certificate. Windows trusts that root, but Python (certifi) and Node do not. As a result every Pinecone call and every web fetch was failing certificate checks. This is now fixed without disabling verification.

Previous handoff: `handoff-2026-09-26-001-rag-chat-discovery-feeds.md`.

## Validation State

### Tests
- Status: Passing
- Last run: 2026-09-27 ~13:05
- `python -m pytest pinecone-management/tests/test_search_server.py -q`: 4/4 pass. New tests cover index rows for the old and 2026-07 schema shapes, document indexes and hosted models.
- `py_compile` on `search_server.py`, `pinecone_shared.py`, `pinecone_bulk.py`, `pinecone_mcp.py`: clean.
- `npx tsc --noEmit`: clean. eslint on `RagPlayground.tsx` and `api/rag/status`: clean.
- Issues: pre-existing `no-explicit-any` errors in `src/app/api/rag/chat/route.ts` (lines ~47, 67, 127) and `src/app/page.tsx:332`. Not introduced this session.

### Live checks (search server, query "how does advertising persuade people")
- `peace-docs/books`: 3 reranked chunks, top score 0.688 (Qwen3 scores run lower than e5).
- `peace/books`: 3 reranked chunks, top score 0.857.
- `multimodal-rag/Recall upload`: 3 reranked chunks, top score 0.856.
- `gravity-claw`: refused with "No local query model for 1536-dimension vectors" (expected).

### Visual Verification
- Screenshots captured: 2
- Last capture: `rag-index-picker-answer.png`, in the Cursor temp screenshots folder (not in the repo).
- End-to-end: selected `peace-docs` → namespace list reloaded (27 namespaces; auto-switched away from missing `general`) → asked in `books` → cited answer from Ollama `llama3.2:3b`.

## Current State

### Completed
- [x] `pinecone-management/pinecone_shared.py` calls `truststore.inject_into_ssl()` (guarded by ImportError). `truststore` is installed and added to `requirements.txt`.
- [x] `run-web-knowledge-pipeline.bat` sets `NODE_OPTIONS=--use-system-ca` before `npm run dev`, only if the installed Node supports the flag (Node 24.19 here does).
- [x] `search_server.py` rewritten for multiple indexes:
  - `GET /indexes`: control plane, API version 2026-07, cached 60 seconds.
  - `/health?index=`, `/namespaces?index=`, and `index` in the `/search` body.
  - Reads each index schema:
    - vector indexes use e5 by dimension and `/query`;
    - document indexes use the model in the `embed_model=` schema tag (Qwen3) and `/namespaces/{ns}/documents/search`;
    - hosted-embedding indexes are mapped only when a local equivalent exists.
  - Per-model lazy loading. Selecting an index warms its model in the background.
- [x] Next:
  - `/api/rag/status?index=` also returns the `indexes` list.
  - `/api/rag/chat` forwards `index`.
  - `RagPlayground.tsx` has the Index select. Unsupported indexes are disabled. States: ready, loading, not searchable.
- [x] Docs: ARCHITECTURE (index table, Norton note) and README (Index menu).

### In Progress
- [ ] Nothing mid-edit. The search server (:8765) and Next dev (:3010) are running from agent shells. Use the launcher next time.

### Pending
- [ ] Commit everything. Still no commits since `ebae9a7`; this covers work from both sessions.
- [ ] **Sync target decision.** The sibling repo `C:\Users\mattieform\GitHub\pinecone-management` retired `peace` for writes (copied into `peace-docs` on 2026-09-11). This app's Sync still writes to `peace`, because the bundled older `pinecone_bulk.py` can't write document indexes. Options:
  - point Sync at the sibling repo's uploader;
  - port its documents support;
  - keep `peace` as this app's write target.
- [ ] Carried over: split `general` into topic categories and sync; Docker (SearXNG, Crawl4AI) was off.

## Files Modified

This session:
- `pinecone-management/search_server.py`, `pinecone-management/pinecone_shared.py`, `pinecone-management/requirements.txt`
- `pinecone-management/tests/test_search_server.py`
- `src/app/api/rag/status/route.ts`, `src/app/api/rag/chat/route.ts`, `src/components/RagPlayground.tsx`
- `run-web-knowledge-pipeline.bat`, `ARCHITECTURE.md`, `README.md`

Earlier sessions (still uncommitted): see `handoff-2026-09-26-001-rag-chat-discovery-feeds.md`.

## Uncommitted Changes

About 50 entries in `git status`:
- 17 modified tracked files.
- New sources, plans and docs (`ARCHITECTURE.md`, `src/lib/discover/`, `src/lib/rag/`, `src/app/api/{discover,sources,rag/llm,rag/status}/`, components, `scripts/dev-port.ps1`, `specs/`).
- `content/feed-sources.json`.
- 14 scraped pages in `content/knowledge-base/general/`.

## Next Steps

1. Review and commit (consider two commits: the earlier session's features, then the index picker and TLS fix).
2. Decide the Sync target (`peace` vs `peace-docs`, see Pending) and implement it.
3. Optionally:
   - remember the last chosen index in the playground (it currently resets to `peace` on reload);
   - show index vector totals in the picker.

## Notes

- **If Norton is ever disabled or reconfigured,** the truststore and `--use-system-ca` fixes are harmless. If they're removed while Norton is on, Pinecone calls fail with `CERTIFICATE_VERIFY_FAILED` / `UNABLE_TO_VERIFY_LEAF_SIGNATURE`.
- **Starting the app without the launcher:** running `npm run dev` directly skips `--use-system-ca`. In that case set `$env:NODE_OPTIONS="--use-system-ca"` first.
- **Where the index settings come from:** `peace-docs` schema is `embedding` (dense_vector 1024, `embed_model=Qwen/Qwen3-Embedding-0.6B`) plus `text` (BM25). Qwen queries use `prompt_name="query"`, matching the sibling repo's `EMBED_MODELS`.
- **Default index:** set by `PINECONE_INDEX` (default `peace`); this is also the index the server warms at startup.
- **Documents API `_score`** is on a different scale from `/query` scores. Don't compare scores across indexes.
