# RAG chat ready

## Outcome

Double-clicking `run-web-knowledge-pipeline.bat` starts Docker (when it is available), the Pinecone search server, and the Next app. Chat can target any namespace that already has vectors, including on the first question.

## Tasks

- [x] Search server warms the embedding model and reranker at startup, and exposes `/health` plus `/namespaces`.
- [x] `/search` reranks a larger candidate pool with the same cross-encoder as `pinecone_mcp.py`.
- [x] Chat sends recent turns, waits long enough for a warm server, and the playground blocks send until the model is ready.
- [x] Namespace control lists live Pinecone namespaces and opens on one that has vectors.
- [x] Scrape skips a URL already saved in the knowledge base, and drops a few lines of page chrome.
- [x] Pipeline guide includes sync and ask.
- [x] `env.example` documents `BRAVE_API_KEY`. `scripts/ingest.mjs` is labeled as a preview.
- [x] `run-web-knowledge-pipeline.bat` starts Docker, the search server, and the Next app.
