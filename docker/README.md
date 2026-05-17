# Local Docker services

Runs **SearXNG** (free web search) and **Crawl4AI** (local Markdown extraction) for the Web Knowledge Pipeline.

## Start

From the **repo root**:

```bat
docker compose -f docker/docker-compose.yml up -d
```

Or double-click `scripts/start-docker-services.bat`.

## URLs

| Service   | URL                                      | Used for        |
|-----------|------------------------------------------|-----------------|
| SearXNG   | http://localhost:8888                    | Search in UI    |
| Crawl4AI  | http://localhost:11235                   | Scrape in UI    |
| Crawl4AI playground | http://localhost:11235/playground | Manual tests    |

## App configuration

Add to `.env.local` (see `env.example`):

```env
SEARXNG_URL=http://localhost:8888
CRAWL4AI_BASE_URL=http://localhost:11235
SCRAPE_ENGINE=crawl4ai
```

Then run `run-web-knowledge-pipeline.bat` and choose **SearXNG** for search and **Crawl4AI** for scrape.

## Stop

```bat
docker compose -f docker/docker-compose.yml down
```

## Troubleshooting

- **SearXNG 403 on JSON**: Ensure `search.formats` includes `json` in `docker/searxng/settings.yml`.
- **Crawl4AI slow first request**: Chromium cold start; wait for health check to pass.
- **Out of memory**: Crawl4AI needs ~2–4 GB RAM allocated to Docker Desktop.
