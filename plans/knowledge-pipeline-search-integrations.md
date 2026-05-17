# Knowledge Pipeline: Search & Discovery Integration Plan

**Status:** Draft for discussion  
**Repo:** azure-hawking (Web Knowledge Pipeline)  
**Date:** 2026-05-17

## Goal

Make domain knowledge building **effective without burning paid API credits**, by splitting the product into two layers and plugging in the right tool per job.

| Layer | Question | Today | Target |
|-------|----------|-------|--------|
| **Discovery** | Which URLs matter? | Tavily or Firecrawl search (max 10) | Multiple providers + free/local options |
| **Extraction** | What is the page content? | Firecrawl scrape only | Pluggable scrapers (Firecrawl, Crawl4AI, …) |
| **Corpus** | How is the domain organized? | Flat folders + frontmatter | Manifest, dedup, gap hints (later) |

## Key insight: Crawl4AI vs “search”

**Crawl4AI is not a web search engine.** It does not replace Tavily/Firecrawl *search*. It excels at:

- URL → clean Markdown (`fit_markdown`, pruning filters)
- Deep crawl / site sections when you already have a seed URL
- URL seeding and adaptive crawl (v0.7+) **within** a site or URL list
- **Self-hosted** → no per-page SaaS credits after setup

**Best fit for this product:** optional **extraction** and **site-crawl** backend, paired with a **free or self-hosted discovery** layer (SearXNG, paste URLs, RSS, sitemap).

Reference: [Firecrawl vs Crawl4AI](https://www.firecrawl.dev/alternatives/firecrawl-vs-crawl4ai) — Firecrawl = search + scrape SaaS; Crawl4AI = crawl/scrape OSS you operate.

## Skills & surfaces to use when implementing

| Skill | Use when |
|-------|----------|
| `surface-router` | MCP/CLI for one-off vs bulk; don’t bloat the Next app with CLI logic |
| `firecrawl` / `pp-firecrawl` | Firecrawl search/scrape/crawl; batch site jobs via CLI |
| `pp-crawl4ai` | Local Crawl4AI server: `md`, `crawl`, `map` via `crawl4ai-pp-cli` |
| `rss-curation` | Domain feeds → URL lists without search API |
| `kb-builder` | Harvest/corpus patterns (when adding manifest + Pinecone) |
| `seo-firecrawl` | Site map / full-site discovery patterns |

**Rule:** Keep **discovery + scrape orchestration in the Next app**; use **CLI/MCP** for heavy batch crawls and agent-driven workflows outside the UI.

---

## Provider matrix (brainstorm)

### Discovery (find URLs) — integrate as UI “Search provider”

| Provider | Cost | Strengths | Weaknesses | Priority |
|----------|------|-----------|------------|----------|
| **Paste URLs / import** | Free | Zero API; bibliographies, newsletters | No discovery | **P0** |
| **SearXNG** (self-hosted) | Free (you host) | Real web search, JSON API, many engines | Docker setup; rate limits on upstream engines | **P0** |
| **Firecrawl search** | Credits | Already integrated; same key as scrape | No relevance score; 10 result cap | Keep (default) |
| **Sitemap / site map** | Free | Great for docs sites (e.g. `docs.example.com`) | Needs seed domain | **P1** |
| **RSS / OPML** | Free | Steady domain updates | Not broad web search | **P1** |
| **Brave Search API** | Free tier (~2k/mo) | Simple REST, good quality | Key + limits | **P1** |
| **Serper** | Low $ | Google SERP JSON | Paid | P2 |
| **Exa** | Paid | Semantic / similar pages | Niche | P2 |
| **Tavily** | Paid | Scores, time filter | User may not subscribe | Optional |
| **DuckDuckGo** (unofficial libs) | Free | No key | Fragile, ToS grey area | P3 fallback |
| **arXiv / Semantic Scholar** | Free | Academic domains | Narrow | P2 if domain = research |

### Extraction (URL → Markdown) — integrate as “Scrape engine”

| Engine | Cost | Strengths | Weaknesses | Priority |
|--------|------|-----------|------------|----------|
| **Firecrawl** | Credits | Already wired; reliable | Paid; OneDrive + Turbopack issues on dev | Keep default |
| **Crawl4AI** (local Docker) | Infra only | `fit_markdown`, pruning, deep crawl | Requires running service; no search | **P0** |
| **Jina Reader** (`r.jina.ai`) | Free tier | One URL → MD, trivial HTTP | External dependency | **P1** |
| **Trafilatura** (Python sidecar) | Free | Fast article extract | Extra process | P3 |
| **Playwright** (local) | Free | Hard pages | Heavy, maintenance | P3 |

### “Crawl mode” (many pages from one site) — separate UI tab

| Tool | Role |
|------|------|
| **Firecrawl `map` + `crawl`** | SaaS site harvest |
| **Crawl4AI `crawl`** | Self-hosted bulk from seed URL / path prefix |
| **Sitemap parser** | Cheap URL list from `sitemap.xml` then batch scrape |

---

## Recommended architecture

```
┌─────────────────────────────────────────────────────────┐
│  Web Knowledge Pipeline UI                               │
├─────────────────────────────────────────────────────────┤
│  Discover          │  Curate        │  Extract          │
│  · SearXNG         │  · Dedup URL   │  · Firecrawl      │
│  · Firecrawl search│  · Scores      │  · Crawl4AI       │
│  · Brave (opt)     │  · Paste list  │  · Jina (opt)     │
│  · Sitemap/RSS     │  · Manifest    │                   │
└─────────────────────────────────────────────────────────┘
                              │
                              ▼
              content/knowledge-base/{domain}/*.md
                              │
                              ▼
              ingest → Pinecone (namespace = domain)
```

**Provider interface (TypeScript):**

```ts
// lib/providers/types.ts
type SearchResult = { title: string; url: string; snippet: string; score?: number; date?: string };

interface SearchProvider {
  id: string;
  label: string;
  search(query: string, opts: SearchOpts): Promise<SearchResult[]>;
}

interface ScrapeProvider {
  id: string;
  scrape(url: string, opts: ScrapeOpts): Promise<{ markdown: string; meta?: object }>;
}
```

Implement adapters in `lib/providers/{firecrawl,searxng,crawl4ai,jina,...}.ts`.  
Routes: `GET /api/search?provider=searxng`, `POST /api/scrape` with `engine=crawl4ai`.

---

## Phased plan

### Phase 0 — Foundation (1–2 days) *no new vendors*

- [ ] Provider registry + env-driven availability (show only configured providers)
- [ ] Paste-URLs panel (textarea → scrape queue)
- [ ] URL canonicalization + dedup against existing frontmatter
- [ ] Raise search limit (10 → 25) for Firecrawl/Tavily
- [ ] `env.example` document all keys

**Outcome:** Better pipeline with current keys only.

### Phase 1 — Free discovery (2–4 days)

- [ ] **SearXNG** adapter (`SEARXNG_URL=http://localhost:8080`)
  - Docker Compose snippet in repo `docker/searxng/`
  - UI provider: “Local search (SearXNG)”
- [ ] **Sitemap mode:** input domain → fetch `sitemap.xml` → list URLs → select → scrape
- [ ] Health check on startup: which providers are configured

**Outcome:** Build domains without Tavily; search credits mostly Firecrawl scrape-only.

### Phase 2 — Crawl4AI extraction (2–4 days)

- [ ] Document `docker compose up crawl4ai` (official image / your stack)
- [ ] `CRAWL4AI_BASE_URL` → `POST /md` or SDK call from `scrape/route.ts`
- [ ] UI: Scrape engine toggle **Firecrawl | Crawl4AI (local)**
- [ ] Compare output: prefer `fit_markdown` when available

**Outcome:** Self-hosted scrape path; Firecrawl reserved for search or hard pages.

### Phase 3 — Site crawl mode (3–5 days)

- [ ] New view: **“Harvest site”** — seed URL + path prefix + max pages
- [ ] Backend: Firecrawl crawl OR Crawl4AI crawl job (async status)
- [ ] Write manifest: `{ domain, seed, urls[], scraped_at }`

**Outcome:** Entire doc sites (e.g. OWASP, framework docs) in one workflow.

### Phase 4 — Enrichment (optional)

- [ ] Brave or Serper as paid-lite Google-quality search
- [ ] RSS/OPML import (feeds → periodic URL refresh)
- [ ] Academic: arXiv API when category = research
- [ ] Real Pinecone ingest (semantic chunking)

---

## Crawl4AI: concrete integration sketch

1. User runs Crawl4AI Docker on `localhost:11235` (or your port).
2. `.env.local`:
   ```env
   CRAWL4AI_BASE_URL=http://localhost:11235
   SCRAPE_ENGINE=firecrawl|crawl4ai|auto
   SEARXNG_URL=http://localhost:8080
   ```
3. `scrape/route.ts`: if `engine=crawl4ai`, `POST {base}/md` with `{ url, f: "fit" }` (exact path per Crawl4AI version docs).
4. Optional **CLI path** (agents): `crawl4ai-pp-cli crawl` for batch jobs → output JSONL → import script into `content/knowledge-base/`.

Use **pp-crawl4ai** skill for ops/debugging; keep UI on HTTP API.

## SearXNG: concrete integration sketch

1. `docker compose -f docker/searxng/docker-compose.yml up -d`
2. Enable JSON in `settings.yml`.
3. `lib/providers/searxng.ts`:
   ```ts
   fetch(`${SEARXNG_URL}/search?q=${encodeURIComponent(q)}&format=json`)
   ```
4. Map `results[].title`, `url`, `content` → `SearchResult[]`.

No API key; ideal default for “I don’t have Tavily.”

## What NOT to prioritize early

- Another paid search API before paste-URLs + SearXNG work
- Turbopack (keep `--webpack` on Windows/OneDrive)
- In-app LLM query expansion (cost + complexity)
- Replacing Firecrawl entirely (search + hard JS pages still useful)

## Success criteria (domain-building)

1. Define domain folder + manifest with target count.
2. Discover 30+ candidate URLs via **SearXNG or sitemap** without Tavily.
3. Scrape 20+ pages via **Crawl4AI or Firecrawl** with deduped files.
4. Ingest to Pinecone with filterable metadata.
5. Spot-check retrieval: top-k chunks are on-topic, low nav boilerplate.

## Open questions for you

1. Will you run **Docker Desktop** locally for SearXNG + Crawl4AI? (Determines P1 vs cloud-only path.)
2. Is **Google-quality SERP** required, or is SearXNG + manual curation enough?
3. Primary domains: **general web**, **docs sites**, or **academic papers**? (Tunes arXiv/RSS weight.)
4. Budget ceiling for **Firecrawl credits** per month?

## Next implementation step

**Phase 0 + SearXNG (Phase 1)** gives the best ROI: free discovery, keep Firecrawl for scrape until Crawl4AI Docker is up.

---

## References

- [Crawl4AI Markdown / fit_markdown](https://docs.crawl4ai.com/core/markdown-generation)
- [SearXNG Search API](https://docs.searxng.org/dev/search_api)
- [Firecrawl skill workflow](file://~/.claude/skills/firecrawl/SKILL.md) — search → scrape → map → crawl escalation
