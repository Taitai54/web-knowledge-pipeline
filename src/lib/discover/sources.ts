import fs from "fs/promises";
import path from "path";
import { listSavedPages } from "@/lib/kb/markdown";
import { buildOpml, feedTitle, findFeedLinks, looksLikeFeed } from "./parse";

const STORE_PATH = path.join(process.cwd(), "content", "feed-sources.json");
const KB_ROOT = path.join(process.cwd(), "content", "knowledge-base");
const FALLBACK_PATHS = ["/feed", "/rss", "/rss.xml", "/feed.xml", "/atom.xml"];
const PAGE_TIMEOUT_MS = 6000;
const FEED_TIMEOUT_MS = 5000;
const SCAN_CONCURRENCY = 6;
const SCAN_LIMIT = 80;
const USER_AGENT = "Mozilla/5.0 (compatible; web-knowledge-pipeline/0.1)";

export interface SiteSource {
  origin: string;
  title: string;
  feedUrl: string | null;
  category: string;
  checkedAt: string;
  /** Ticked for OPML export. Missing means ticked. */
  included?: boolean;
  excluded?: boolean;
}

const isIncluded = (site: SiteSource) => site.included !== false;

interface SourceStore {
  sites: Record<string, SiteSource>;
}

async function readStore(): Promise<SourceStore> {
  try {
    const parsed = JSON.parse(await fs.readFile(STORE_PATH, "utf8"));
    if (parsed?.sites && typeof parsed.sites === "object") return parsed as SourceStore;
  } catch {
    // Missing or unreadable store starts empty.
  }
  return { sites: {} };
}

let writeChain: Promise<unknown> = Promise.resolve();

function updateStore<T>(change: (store: SourceStore) => T): Promise<T> {
  const run = writeChain.then(async () => {
    const store = await readStore();
    const result = change(store);
    await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
    const tempPath = `${STORE_PATH}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(store, null, 2), "utf8");
    await fs.rename(tempPath, STORE_PATH);
    return result;
  });
  writeChain = run.catch(() => undefined);
  return run;
}

async function fetchText(url: string, timeoutMs: number, htmlOnly = false) {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/rss+xml,application/atom+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const contentType = response.headers.get("content-type") || "";
    if (!response.ok || (htmlOnly && !/html/i.test(contentType))) {
      await response.body?.cancel();
      return null;
    }
    return { text: await response.text(), finalUrl: response.url || url };
  } catch {
    return null;
  }
}

async function verifyFeed(url: string): Promise<{ feedUrl: string; title: string } | null> {
  const result = await fetchText(url, FEED_TIMEOUT_MS);
  if (!result || !looksLikeFeed(result.text)) return null;
  return { feedUrl: result.finalUrl, title: feedTitle(result.text) };
}

async function feedFromHtml(pageUrl: string) {
  const page = await fetchText(pageUrl, PAGE_TIMEOUT_MS, true);
  if (!page) return null;
  for (const link of findFeedLinks(page.text, page.finalUrl).slice(0, 3)) {
    const feed = await verifyFeed(link);
    if (feed) return feed;
  }
  return null;
}

/** The site's own RSS/Atom feed: page links, then homepage links, then common paths. */
export async function detectFeed(pageUrl: string): Promise<{ feedUrl: string; title: string } | null> {
  const parsed = new URL(pageUrl);
  const fromPage = await feedFromHtml(pageUrl);
  if (fromPage) return fromPage;
  if (parsed.pathname !== "/") {
    const fromHome = await feedFromHtml(`${parsed.origin}/`);
    if (fromHome) return fromHome;
  }
  const guesses = await Promise.all(FALLBACK_PATHS.map((suffix) => verifyFeed(`${parsed.origin}${suffix}`)));
  return guesses.find((feed) => feed !== null) ?? null;
}

function httpOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

const inFlight = new Map<string, Promise<void>>();

/** Checks a site once (by origin) and remembers its feed, or that it has none. */
export function recordSiteFeed(pageUrl: string, category: string, included = true): Promise<void> {
  const origin = httpOrigin(pageUrl);
  if (!origin) return Promise.resolve();
  const pending = inFlight.get(origin);
  if (pending) return pending;

  const run = (async () => {
    if ((await readStore()).sites[origin]) return;
    const feed = await detectFeed(pageUrl);
    await updateStore((store) => {
      if (store.sites[origin]) return;
      store.sites[origin] = {
        origin,
        title: feed?.title || new URL(origin).hostname,
        feedUrl: feed?.feedUrl ?? null,
        category: category || "general",
        checkedAt: new Date().toISOString(),
        included,
      };
    });
  })().finally(() => inFlight.delete(origin));
  inFlight.set(origin, run);
  return run;
}

export async function listSources() {
  const store = await readStore();
  const sites = Object.values(store.sites)
    .filter((site) => !site.excluded)
    .map((site) => ({ ...site, included: isIncluded(site) }))
    .sort(
      (a, b) =>
        Number(Boolean(b.feedUrl)) - Number(Boolean(a.feedUrl)) ||
        a.category.localeCompare(b.category) ||
        a.title.localeCompare(b.title),
    );
  return {
    sites,
    withFeed: sites.filter((site) => site.feedUrl).length,
    withoutFeed: sites.filter((site) => !site.feedUrl).length,
  };
}

/** Checks sites from already-saved knowledge-base pages that have not been checked yet. */
export async function scanSavedPages(): Promise<{ checked: number; found: number; remaining: number }> {
  const store = await readStore();
  const unchecked = new Map<string, { url: string; category: string }>();
  for (const page of await listSavedPages(KB_ROOT)) {
    const origin = httpOrigin(page.url);
    if (!origin || store.sites[origin] || unchecked.has(origin)) continue;
    unchecked.set(origin, page);
  }

  const batch = [...unchecked.entries()].slice(0, SCAN_LIMIT);
  let next = 0;
  const worker = async () => {
    while (next < batch.length) {
      const [, page] = batch[next++];
      await recordSiteFeed(page.url, page.category, false).catch(() => undefined);
    }
  };
  await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, batch.length) }, worker));

  const after = await readStore();
  return {
    checked: batch.length,
    found: batch.filter(([origin]) => after.sites[origin]?.feedUrl).length,
    remaining: unchecked.size - batch.length,
  };
}

export function excludeSource(origin: string): Promise<boolean> {
  return updateStore((store) => {
    const site = store.sites[origin];
    if (!site) return false;
    site.excluded = true;
    return true;
  });
}

export function setSourceIncluded(origin: string, included: boolean): Promise<boolean> {
  return updateStore((store) => {
    const site = store.sites[origin];
    if (!site) return false;
    site.included = included;
    return true;
  });
}

export async function sourcesOpml(): Promise<string> {
  const { sites } = await listSources();
  return buildOpml(
    sites.flatMap((site) =>
      site.feedUrl && isIncluded(site)
        ? [{ title: site.title, feedUrl: site.feedUrl, siteUrl: site.origin, category: site.category }]
        : [],
    ),
  );
}
