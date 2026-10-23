# RAG playground: multi-namespace, hybrid search, Ollama keep-alive, chat download

**Status: done 2026-09-27.** Validated:
- 6 pytest tests pass; `tsc` is clean. The only ESLint errors are the old `any` types in the chat route.
- Live search takes 1.6–2.5 s across two namespaces and with hybrid on.
- Ollama expiry was +30 min after a chat.
- Browser: checklist, sources with namespaces, and download all work.

**Found while testing:** on `peace`, Recall upload has the same article twice under two import folders, so both copies can fill result slots. A per-document cap, as the connector does, would fix it; not built.

Asked for 2026-09-27 after timing the playground: search takes 1–2.5 s, the local LLM 30–105 s.

## Findings

- The playground never touches Supabase. Supabase only hosts the claude.ai connector (`pinecone-management/connector`), whose `peace-docs` search is BM25 per namespace, merged round-robin by rank, then reranked.
- Ollama's `/v1/chat/completions` ignores `keep_alive` (tested on Ollama 0.34.4: expiry stayed at +5 min). The native `/api/chat` honours it.
- `peace-docs` has a BM25 `text` field. Keyword search is `score_by: [{type: "text", fields: ["text"], query}]` on `/namespaces/{ns}/documents/search`. BM25 scores depend on each namespace's term statistics, so lists are merged by rank, not score.

## Tasks

1. **Search server** (`pinecone-management/search_server.py`):
   - `/search` accepts `namespaces: [...]` (up to 8); `namespace` still works.
   - Per namespace, in parallel: dense search; on document indexes, also BM25 keyword search.
   - Merge all lists with reciprocal-rank fusion, dedupe by id, keep the rerank pool size, then rerank as before.
   - Each chunk carries its `namespace`. The response adds `hybrid` and any per-namespace `errors`. It fails only if every namespace fails.
   - Tests for the fusion helper and the `namespaces` parsing.
2. **Chat route**: forward `namespaces` (array).
3. **Ollama keep-alive** (`src/lib/rag/llm.ts`): Ollama uses native `/api/chat` with `keep_alive: "30m"`; content falls back to `thinking`. LM Studio and OpenAI are unchanged.
4. **Playground UI**:
   - The namespace dropdown becomes a checklist (at least one ticked). Auto-pick keeps its behaviour for missing or empty namespaces.
   - Source cards show the namespace, plus a "keyword + meaning" badge when the search was hybrid.
   - A "Download" button saves the whole chat as one Markdown file: each question, its answer, and numbered sources with title, link or path, namespace and passage.
5. **Docs**: README and ARCHITECTURE sections for the playground.

## Validation

- `python -m pytest tests/test_search_server.py -q`
- Live `/search` on `peace` (two namespaces) and `peace-docs` (hybrid): timings and titles.
- `npx tsc --noEmit`, ESLint on the touched files.
- Ollama `/api/ps` shows about 30 min expiry after a chat.
- Browser: tick two namespaces, ask, check the sources and badges, download the file.
