import { gunzipSync } from "zlib";
import {
  isOpml,
  parseFeed,
  parseOpmlFeedUrls,
  parseRobotsSitemaps,
  parseSitemap,
  titleFromUrl,
  type DiscoveredPage,
} from "./parse";

const MAX_SITEMAP_FETCHES = 12;
const MAX_FEEDS = 8;
const DEFAULT_LIMIT = 50;
const HARD_LIMIT = 200;

export interface DiscoverRequest {
  source: "sitemap" | "feed";
  url: string;
  pathPrefix?: string;
  limit?: number;
}

function clampLimit(limit: number | undefined): number {
  const value = Number.isFinite(limit) ? Number(limit) : DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(value), 1), HARD_LIMIT);
}

export function normalizeHttpUrl(input: string): string {
  const trimmed = input.trim();
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(withProtocol);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Use an http or https URL");
  }
  return url.toString();
}

function pathAllowed(pageUrl: string, prefix: string): boolean {
  if (!prefix.trim()) return true;
  let path = prefix.trim();
  if (!path.startsWith("/")) path = `/${path}`;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  try {
    const pathname = new URL(pageUrl).pathname.replace(/\/$/, "") || "/";
    return pathname === path || pathname.startsWith(`${path}/`);
  } catch {
    return false;
  }
}

async function fetchBody(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "web-knowledge-pipeline/0.1",
      Accept: "application/xml,text/xml,application/rss+xml,text/plain,*/*",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    return gunzipSync(buffer).toString("utf8");
  }
  return buffer.toString("utf8");
}

function sitemapCandidates(siteUrl: string): string[] {
  const url = new URL(siteUrl);
  if (/\.xml(\.gz)?$/i.test(url.pathname)) return [url.toString()];
  const origin = url.origin;
  return [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`, `${origin}/sitemap-index.xml`];
}

async function collectSitemapPages(siteUrl: string, pathPrefix: string, limit: number): Promise<DiscoveredPage[]> {
  const queue = sitemapCandidates(siteUrl);
  if (!/\.xml(\.gz)?$/i.test(new URL(siteUrl).pathname)) {
    try {
      const robots = await fetchBody(`${new URL(siteUrl).origin}/robots.txt`);
      queue.unshift(...parseRobotsSitemaps(robots));
    } catch {
      // robots.txt is optional
    }
  }

  const seenSitemaps = new Set<string>();
  const pages: DiscoveredPage[] = [];
  const seenPages = new Set<string>();
  let fetches = 0;

  while (queue.length > 0 && fetches < MAX_SITEMAP_FETCHES && pages.length < limit) {
    const next = queue.shift();
    if (!next || seenSitemaps.has(next)) continue;
    seenSitemaps.add(next);
    let xml = "";
    try {
      xml = await fetchBody(next);
      fetches += 1;
    } catch {
      continue;
    }
    const parsed = parseSitemap(xml);
    for (const child of parsed.sitemaps) {
      if (!seenSitemaps.has(child)) queue.push(child);
    }
    for (const pageUrl of parsed.pages) {
      if (seenPages.has(pageUrl) || !pathAllowed(pageUrl, pathPrefix)) continue;
      seenPages.add(pageUrl);
      pages.push({
        url: pageUrl,
        title: titleFromUrl(pageUrl),
        snippet: "From sitemap",
      });
      if (pages.length >= limit) break;
    }
  }

  if (pages.length === 0) {
    throw new Error("No sitemap pages found. Try the full sitemap.xml URL, or check the path filter.");
  }
  return pages;
}

async function pagesFromFeedXml(xml: string, limit: number, depth: number): Promise<DiscoveredPage[]> {
  if (isOpml(xml)) {
    if (depth > 0) return [];
    const feeds = parseOpmlFeedUrls(xml).slice(0, MAX_FEEDS);
    const pages: DiscoveredPage[] = [];
    const seen = new Set<string>();
    for (const feedUrl of feeds) {
      if (pages.length >= limit) break;
      try {
        const nested = await pagesFromFeedXml(await fetchBody(feedUrl), limit - pages.length, depth + 1);
        for (const page of nested) {
          if (seen.has(page.url)) continue;
          seen.add(page.url);
          pages.push(page);
        }
      } catch {
        // skip a feed that fails inside an OPML list
      }
    }
    return pages;
  }
  return parseFeed(xml).slice(0, limit);
}

export async function discoverPages(request: DiscoverRequest): Promise<DiscoveredPage[]> {
  const url = normalizeHttpUrl(request.url);
  const limit = clampLimit(request.limit);
  const pathPrefix = request.pathPrefix || "";
  if (request.source === "sitemap") {
    const fromPath = pathPrefix || (/\.xml(\.gz)?$/i.test(new URL(url).pathname) ? "" : new URL(url).pathname);
    return collectSitemapPages(url, fromPath === "/" ? "" : fromPath, limit);
  }
  if (request.source === "feed") {
    const pages = await pagesFromFeedXml(await fetchBody(url), limit, 0);
    if (pages.length === 0) throw new Error("No articles found in that feed.");
    return pages;
  }
  throw new Error("Choose a sitemap or a feed");
}
