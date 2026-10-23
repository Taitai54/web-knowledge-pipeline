# Source feeds → OPML

Goal: every site you scrape becomes a site you can follow. The app looks for each
site's own RSS/Atom feed and lets you download the list as OPML for an RSS reader.

## Tasks

Status: all done. Live scan of the existing KB: 55 sites checked in ~30s, 17 feeds found.

1. Pure helpers in `src/lib/discover/parse.ts`: `findFeedLinks` (HTML `<link rel="alternate">`),
   `looksLikeFeed`, `feedTitle`, `buildOpml` (grouped by category). Tests in `parse.test.ts`.
2. `src/lib/discover/sources.ts`: detect a feed per site (page links → homepage links →
   `/feed`, `/rss`, `/rss.xml`, `/feed.xml`, `/atom.xml`), each verified as a real feed.
   Store one entry per origin in `content/feed-sources.json` (serialized, atomic writes).
3. Scrape route: after a save (or duplicate), check the site in the background. Never fails a scrape.
4. `src/lib/kb/markdown.ts`: `listSavedPages` so "Check saved pages" can backfill existing KB pages.
5. API: `GET/POST /api/sources` (list, scan, remove) and `GET /api/sources/opml` (download).
6. UI: `SourceFeedsPanel` in the Scrape workspace: count, list, remove, check saved pages, download.
7. Docs: README and ARCHITECTURE.

## Out of scope

- A clippings feed served by the app (localhost is unreachable from cloud/phone readers).
- JSON Feed detection, periodic re-checks of sites that had no feed.

## Validate

- `node --experimental-strip-types --test src/lib/discover/parse.test.ts`
- `npx tsc --noEmit`, eslint on changed files
- Live: scan saved pages, download OPML, round-trip through `parseOpmlFeedUrls`.
