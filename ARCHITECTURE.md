# Architecture

Web Knowledge Pipeline turns live web pages into a queryable knowledge base. Discovery and extraction run in a Next.js app. Vectors live in the Pinecone index `peace` (1024 dimensions, cosine). Chat retrieves through a local Python search server, then asks an LLM to answer from those chunks.

## Flow

```
Discover                Curate                 Extract
SearXNG / Exa /         Select cards           Crawl4AI or Firecrawl
Tavily / Firecrawl /    or paste URLs
Brave
        │                      │                      │
        └──────────────────────┴──────────────────────┘
                               │
                               ▼
              content/knowledge-base/{category}/{slug}.md
              YAML frontmatter: title, url, category, date
                               │
                               ▼  POST /api/pinecone/sync
              pinecone_bulk.py  (local e5 embeddings, zero token cost)
                               │
                               ▼
              Pinecone index peace, namespace = slugified category
                               │
                               ▼
              RAG Chat  →  search_server.py :8765  →  Gemini or OpenAI
```

The category field in the UI is both the folder name and the Pinecone namespace. `general` becomes `content/knowledge-base/general/` and namespace `general`. A custom absolute path uses the folder's basename as the namespace.

## Runtime pieces

| Piece | Where | Role |
|-------|--------|------|
| Launcher | `run-web-knowledge-pipeline.bat` | Starts Docker when available, the search server, and the Next app |
| Next.js app | `src/`, port **3010** (`npm run dev`) | Search, select, scrape, sync, chat UI |
| Search providers | `src/lib/providers/search/` | SearXNG, Brave, Exa, Tavily, Firecrawl |
| Sitemap and feeds | `src/lib/discover/`, `POST /api/discover` | Sitemap (including indexes and robots.txt) and RSS, Atom, or OPML into the same result list |
| Scrape providers | `src/lib/providers/scrape/` | Crawl4AI, Firecrawl, Jina Reader |
| Sites to follow | `src/lib/discover/sources.ts`, `/api/sources`, `/api/sources/opml` | After a save, finds the site's feed (page links, homepage links, then `/feed`-style paths), one check per site, stored in `content/feed-sources.json`; exports OPML |
| Save path | `src/lib/kb/paths.ts` | Folder + frontmatter category |
| Sync route | `src/app/api/pinecone/sync/route.ts` | Spawns `pinecone_bulk.py --namespace <category> --prune-by-source` |
| Chat route | `src/app/api/rag/chat/route.ts` | Calls the search server, then an LLM |
| Chat UI | `src/components/RagPlayground.tsx` | Namespace box, answer, citation panel |
| Search server | `pinecone-management/search_server.py`, port **8765** | Local query embedding + Pinecone `/query` |
| Uploader | `pinecone-management/pinecone_bulk.py` | Chunk, embed, upsert. See `pinecone-management/CLAUDE.md` |
| Claude search | `pinecone-management/pinecone_mcp.py` | Same index, used by Claude, not by the web chat |
| Local search/scrape | `docker/docker-compose.yml` | SearXNG `:8888`, Crawl4AI `:11235` |

`scripts/ingest.mjs` is a mock. It prints chunk counts and does not write to Pinecone. The real ingest path is **Sync to Pinecone** in the scrape workspace, or `pinecone_bulk.py` directly.

## RAG chat contract

`POST /api/rag/chat` with `{ query, index, namespaces, history }` (a single `namespace` still works):

1. `POST http://localhost:8765/search` with `{ query, index, namespaces, topK: 5, rerank: true }`. The request waits up to 90 seconds.
2. `search_server.py` looks the index up in the Pinecone control plane (API version 2026-07, cached 60 seconds) and picks the query model from its schema:

   | Index kind | Query model | Read endpoint |
   |------------|-------------|---------------|
   | Vector index (`peace`, `multimodal-rag`) | `intfloat/multilingual-e5-*` by dimension, `query:` prefix | `/query` |
   | Document index (`peace-docs`) | The model named in the schema (`embed_model=Qwen/Qwen3-Embedding-0.6B`), its `query` prompt | `/namespaces/{ns}/documents/search` |
   | No local model (`gravity-claw`, 1536 dimensions) | none; shown disabled in the picker | — |

   For each namespace (up to 8, in parallel) it runs dense search. On document indexes with a full-text field (`peace-docs`: `text`) it also runs BM25 keyword search (`score_by: [{type: "text", ...}]`). BM25 scores depend on each namespace's term statistics, so all ranked lists are merged by reciprocal-rank fusion, deduplicated by id, and cut to the candidate pool. The pool is reranked with the same local cross-encoder as `pinecone_mcp.py` (`cross-encoder/ms-marco-MiniLM-L-6-v2`). Each chunk carries its `namespace` and `matchedBy` (`meaning`, `keyword`), and `score` is the dense score, or null for keyword-only hits. The response adds `hybrid` and per-namespace `errors`; the search fails only if every namespace fails. Each model loads once, the first time an index that needs it is selected.
3. Short follow-ups reuse the previous user question as extra retrieval text. The last eight turns go to the LLM with the chunks.
4. If chunks come back, the route calls the model chosen in RAG Chat. Ollama goes through its native `/api/chat` with `keep_alive: "30m"`, because its OpenAI-compatible endpoint ignores `keep_alive` and unloads the model after 5 idle minutes. Ollama (`http://127.0.0.1:11434`) and LM Studio (`http://127.0.0.1:1234`) are local and need no key. OpenAI and Gemini use a key saved in the app (`.llm-settings.json`, gitignored) or the environment. The prompt requires answers from the retrieved snippets and `[1]`-style citations.
5. The playground lists indexes from `GET /indexes` and that index's namespaces from `GET /namespaces?index=`. It enables send when `/health?index=` reports the index's model is ready. The server warms the default index's model (`PINECONE_INDEX`, default `peace`) at startup.

Norton Web/Mail Shield on this machine re-signs HTTPS with its own root, which only Windows trusts. `pinecone_shared.py` calls `truststore.inject_into_ssl()` so Python uses the Windows store, and the launcher sets `NODE_OPTIONS=--use-system-ca` for the Next process. Without them every Pinecone and web fetch fails certificate checks.

`run-web-knowledge-pipeline.bat` starts this server in a second window. `npm run search-server` still starts it on its own.

## What has to be true for an answer

1. `PINECONE_API_KEY` is visible to the Python process. It is a user environment variable on this machine. It is not in `.env.local`.
2. The search server is listening on port 8765.
3. The chosen namespace already has vectors. Sync writes them. Scraping alone does not.
4. `OPENAI_API_KEY` or `GEMINI_API_KEY` is visible to the Next process. OpenAI is set in the user environment. Neither key is in `.env.local`. Next.js reads both `.env.local` and the process environment, so a normal Windows launch of `run-web-knowledge-pipeline.bat` should see the user-level OpenAI key.

As of the last index read, `peace` held about 148k vectors across 25 namespaces (`Recall upload`, `my book collection`, `notebook-lm-knowledge`, `books`, and others). There is no `general` namespace. The on-disk corpus is 60 markdown files (`general` 49, `ai-thnking` 9, `test` 1, `test-category` 1). Chat defaults to namespace `general`, so it will report that nothing relevant was found until that folder is synced.

## Two query stacks

The web chat uses `search_server.py`: dense cosine search, top 5, full chunk text, no rerank.

Claude uses `pinecone_mcp.py`: local embeddings, a larger candidate pool, local cross-encoder rerank, truncation, and an in-memory cache. That server is not on the HTTP path the playground calls.

Uploads and both query paths must keep the e5 prefix split: `passage:` on ingest, `query:` on search. `pinecone_shared.py` owns that helper.

## Local services

| Service | URL | Required for |
|---------|-----|----------------|
| Next app | http://localhost:3010 | UI |
| SearXNG | http://localhost:8888 | Free search (`docker/`) |
| Crawl4AI | http://localhost:11235 | Free scrape (`docker/`) |
| Search server | http://localhost:8765 | RAG chat retrieval |

Cloud search and scrape keys are optional. See `env.example`.
