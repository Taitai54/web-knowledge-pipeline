# Web Knowledge Pipeline

Search the web, save pages as Markdown, upload them to Pinecone, and ask questions against that namespace.

The running shape of the system is in [ARCHITECTURE.md](ARCHITECTURE.md). Provider setup for local Docker is in [docker/README.md](docker/README.md). The uploader, MCP server, and embedding rules are in [pinecone-management/README.md](pinecone-management/README.md).

## What you can do

- Search with SearXNG (local), Brave, Exa, Tavily, or Firecrawl.
- Paste URLs, or import a sitemap or an RSS, Atom, or OPML feed.
- Scrape to Markdown with Crawl4AI (local), Firecrawl, or Jina Reader, into `content/knowledge-base/{category}/`.
- Follow the sites you scrape. After each save the app looks for that site's own RSS or Atom feed. **Sites to follow** lists them, ticked. **Check saved pages** adds sites from older saved pages, unticked. **Download OPML** exports only the ticked feeds, one folder per category, for your RSS reader. The list lives in `content/feed-sources.json`.
- Sync a category folder into the Pinecone index `peace`. The category name is the namespace.
- Ask questions in **RAG Chat Playground**. Retrieval is local. The answer comes from Ollama, LM Studio, Gemini, or OpenAI, cited from the retrieved chunks.

## Setup

Node.js 18+.

```bash
npm install
```

Copy `env.example` to `.env.local`. For free search and scrape, start Docker first:

```bat
scripts\start-docker-services.bat
```

Python side (upload + chat retrieval):

```bash
pip install requests pypdf pyyaml
pip install -r pinecone-management/requirements.txt -r pinecone-management/requirements-search.txt
pip install sentence-transformers
```

`PINECONE_API_KEY` must be set for sync and for the search server. `OPENAI_API_KEY` or `GEMINI_API_KEY` must be visible to Next.js for generated answers. User environment variables count; `.env.local` is the reliable place to put them.

## Run

```bat
run-web-knowledge-pipeline.bat
```

Or `npm run dev`. The app is at [http://localhost:3010](http://localhost:3010).

### RAG chat

`run-web-knowledge-pipeline.bat` starts the web app, the Pinecone search server, and Docker when Docker is available. Chat stays disabled until the search window prints `Ready for chat` (the first model load takes a minute or two). Later launches reuse the search server if it is already listening, so after updating `search_server.py` close its window and relaunch, or the old code keeps running.

The **Index** menu lists every index in your Pinecone project. The **Namespaces** checklist lists that index's namespaces; tick several to search them together (up to 8). `peace-docs` (the document index built with Qwen3) and `multimodal-rag` load their own query model the first time you pick them; indexes with no local model, such as `gravity-claw`, are greyed out. Ticked namespaces with no vectors are unticked, and if none are left the one with the most data opens.

On `peace-docs`, each search also runs keyword (BM25) search, so exact names and terms are found even when the wording differs. Answers found this way show a **keyword + meaning** badge. `peace` and `multimodal-rag` use meaning search only.

The download button beside **Namespaces** saves the whole chat as one Markdown file: each question, its answer, and the numbered sources with their passages.

The **Model** row chooses Ollama, LM Studio, OpenAI, or Gemini. Local servers are detected on `http://127.0.0.1:11434` and `http://127.0.0.1:1234`. Ollama keeps the chat model loaded for 30 minutes after each answer, so only the first question after a break waits for the model to load. Search itself takes 1–3 seconds; most of the wait is the model writing. **Keys and servers** saves an OpenAI or Gemini key in this app (`.llm-settings.json`, not committed) and can point the local URLs somewhere else.

Scraped files stay on disk until you sync that folder. `scripts/ingest.mjs` only previews chunks. It does not upload.

## Layout

| Path | Role |
|------|------|
| `src/` | Next.js UI and API routes |
| `content/knowledge-base/` | Saved Markdown |
| `pinecone-management/` | Chunk, embed, upload, and the chat search server |
| `docker/` | SearXNG and Crawl4AI |
| `plans/` | Design notes for search and scrape providers |

## License

MIT
