# Handoff: RAG chat, local models, discovery, and sites-to-follow OPML

**Date**: 2026-09-26 07:05
**Module**: 09-validation

## Session Summary

Reviewed the pipeline and wrote the missing architecture docs. Got RAG chat working against the Pinecone index `peace`, with a picker for any of its 25 namespaces. Added local models (Ollama, LM Studio) and API keys that can be entered in the UI. Made one launcher that starts everything. Added sitemap and RSS/OPML discovery plus Jina Reader. Fixed the app not starting (a stale Next process was holding port 3010). Finally built **Sites to follow**: detect each scraped site's own RSS/Atom feed, tick or untick sites, and export the ticked ones as OPML.

## Validation State

### Tests
- Status: Passing
- Last run: 2026-09-25, late afternoon
- `node --experimental-strip-types --test src/lib/discover/parse.test.ts`: 9/9 pass.
- `python -m pytest pinecone-management/tests/test_search_server.py -q`: 2/2 pass.
- `npx tsc --noEmit`: clean.
- eslint on new files: clean. One pre-existing error remains, not introduced this session: `no-explicit-any` at `src/app/page.tsx:332` (`catch (err: any)`).
- Issues: none failing.

### Visual Verification
- Browser checks done in the Cursor browser (no screenshots saved to the repo):
  - Namespace dropdown, and a reranked answer from Ollama `llama3.2:3b`.
  - Key fields and the LM Studio model list.
  - HN RSS import and sitemap discovery.
  - Sites to follow: unticking a site dropped it from the OPML (4 → 3), then it was re-ticked.
- OPML is valid 2.0 (PowerShell `[xml]` parse), and all listed feeds returned HTTP 200.

## Current State

### Completed
- [x] `ARCHITECTURE.md` created; `README.md` rewritten; `pinecone-management/README.md` has a search server section.
- [x] `search_server.py`:
  - `/health`, `/namespaces`, and rerank on `/search`.
  - Models warm up in the background.
  - Tests in `pinecone-management/tests/test_search_server.py`.
- [x] RAG chat (`/api/rag/chat`, `/api/rag/status`, `RagPlayground.tsx`):
  - Namespace picker with vector counts.
  - Send is blocked until the model is ready.
  - Keeps chat history, reranks results, 90s timeout.
- [x] LLM providers (`src/lib/rag/llm.ts`, `/api/rag/llm`, `LlmSettingsBar.tsx`):
  - Ollama, LM Studio, OpenAI, Gemini.
  - Keys are saved to the gitignored `.llm-settings.json` and are never returned to the browser.
- [x] Launcher `run-web-knowledge-pipeline.bat` and `scripts/dev-port.ps1`:
  - Starts Docker if available, then the search server on :8765, then Next on :3010.
  - Handles port 3010 being FREE, READY (already running), or STUCK (stale process gets killed).
- [x] Discovery:
  - `src/lib/discover/` and `POST /api/discover`, surfaced in `DiscoverPanel.tsx`.
  - Sitemap (including sitemap indexes and robots.txt) and RSS/Atom/OPML import.
- [x] Jina Reader scrape engine (`src/lib/providers/scrape/jina.ts`).
- [x] Duplicate-URL check before scraping; cleanup of scraped markdown (`src/lib/kb/markdown.ts`).
- [x] Sites to follow (`src/lib/discover/sources.ts`, `/api/sources`, `/api/sources/opml`, `SourceFeedsPanel.tsx`):
  - Checks each site once, in the background after each scrape.
  - Sites from scraped pages start ticked; sites from "Check saved pages" start unticked.
  - ✕ removes a site for good.
  - OPML has one folder per category.
- [x] `content/feed-sources.json` cleared down to today's 8 wellness sites (4 with feeds: Global Wellness Summit, Who What Wear UK, Outside Online, Vogue).

### In Progress
- [ ] Nothing mid-edit.

### Pending
- [ ] Commit this session's work (nothing is committed yet; last commit is `ebae9a7 updates`).
- [ ] The `general` folder, including the new wellness and AI-marketing pages, has not been synced to Pinecone. It was deliberately left alone because syncing changes the shared `peace` index.
- [ ] Docker Desktop was off, so SearXNG (:8888) and Crawl4AI (:11235) were offline. Brave, Jina and Firecrawl work without Docker.

## Files Modified

Modified:
- `.gitignore`, `README.md`, `env.example`, `global.env.example`, `tsconfig.json`
- `pinecone-management/README.md`, `pinecone-management/search_server.py`
- `run-web-knowledge-pipeline.bat`, `scripts/ingest.mjs`
- `src/app/api/rag/chat/route.ts`, `src/app/api/scrape/route.ts`, `src/app/page.tsx`
- `src/components/PipelineGuide.tsx`, `src/components/RagPlayground.tsx`
- `src/lib/providers/scrape/index.ts`

New:
- Docs and plans: `ARCHITECTURE.md`, `plans/rag-chat-ready.md`, `plans/sitemap-rss-discovery.md`, `plans/source-feeds-opml.md`
- Scripts and tests: `scripts/dev-port.ps1`, `pinecone-management/tests/test_search_server.py`
- API routes: `src/app/api/discover/`, `src/app/api/rag/llm/`, `src/app/api/rag/status/`, `src/app/api/sources/`
- Components: `src/components/DiscoverPanel.tsx`, `src/components/LlmSettingsBar.tsx`, `src/components/SourceFeedsPanel.tsx`
- Libraries: `src/lib/discover/` (parse, collect, sources, tests), `src/lib/kb/markdown.ts`, `src/lib/providers/scrape/jina.ts`, `src/lib/rag/`

## Uncommitted Changes

- 15 modified tracked files, as listed above.
- New untracked source, docs and plans, as listed above.
- `content/feed-sources.json` (user data, "Sites to follow" list).
- 14 new markdown pages in `content/knowledge-base/general/`: wellness trends and AI in marketing, scraped by the user.

## Next Steps

1. Review and commit the session's work. Decide whether `content/feed-sources.json` and the new `content/knowledge-base/general/*.md` pages belong in git.
2. Split `general` into topic categories (e.g. `wellness`, `ai-marketing`), so both the Pinecone namespaces and the OPML folders are meaningful. Then sync them to Pinecone.
3. Optional follow-ups for Sites to follow:
   - Add "tick all / none" controls.
   - Periodically re-check sites that had no feed.
   - Add more fallback paths (e.g. `/feed/rss` for nngroup.com).

## Notes

- **Start the app** with `run-web-knowledge-pipeline.bat`. It reuses a healthy server on :3010 and kills a stuck one.
- **Where feed detection looks:** page `<link rel="alternate">`, then the homepage, then `/feed`, `/rss`, `/rss.xml`, `/feed.xml`, `/atom.xml`. It trusts what the site advertises. For example, fool.co.uk advertised The Twelfth Magpie's feed; that entry has since been cleared.
- **Rechecking cleared sites:** "Check saved pages" re-adds sites from all older KB pages, unticked. The user found the earlier auto-included backfill confusing, which is why sites now start unticked.
- **OpenAI key:** it had no quota (`insufficient_quota`). Local Ollama is the working answer path.
- **Dev log warning:** firecrawl-js logs "can't resolve 'undici'" in dev. It's harmless and has not been addressed.
- **Pinecone rules:** always pass a namespace against `peace`. Local e5 embedding is the default, which costs zero tokens.
