# Sitemap, RSS, and Jina

## Outcome

From the scrape workspace, a site URL or feed URL becomes a selectable list of pages. Jina Reader is available as a scrape engine when Crawl4AI or Firecrawl fails.

## Tasks

- [x] Parse sitemap indexes, urlsets, RSS, Atom, and OPML.
- [x] `POST /api/discover` fetches a sitemap (via robots.txt when needed) or a feed, with a path filter and a cap.
- [x] Discover panel adds those URLs to the existing result list.
- [x] Jina Reader scrape engine (`https://r.jina.ai/`).
- [x] A full async site crawl (Firecrawl crawl / Crawl4AI crawl jobs) stays out of this pass. Path-filtered sitemap listing is the harvest step.
