export interface DiscoveredPage {
  url: string;
  title: string;
  snippet: string;
  date?: string;
}

function decodeEntities(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .trim();
}

function stripTags(value: string): string {
  const decoded = decodeEntities(value);
  return decoded.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function tagText(block: string, names: string[]): string {
  for (const name of names) {
    const match = block.match(new RegExp(`<(?:[\\w-]+:)?${name}[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, "i"));
    if (match) return stripTags(match[1]);
  }
  return "";
}

function isHttp(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
}

export function titleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const slug = parsed.pathname.split("/").filter(Boolean).pop() || parsed.hostname;
    return decodeURIComponent(slug).replace(/[-_]+/g, " ");
  } catch {
    return url;
  }
}

export function parseSitemap(xml: string): { pages: string[]; sitemaps: string[] } {
  const locs = [...xml.matchAll(/<(?:[\w-]+:)?loc[^>]*>\s*([\s\S]*?)\s*<\/(?:[\w-]+:)?loc>/gi)]
    .map((match) => decodeEntities(match[1]))
    .filter(isHttp);
  if (/<(?:[\w-]+:)?sitemapindex[\s>]/i.test(xml)) {
    return { pages: [], sitemaps: locs };
  }
  return { pages: locs, sitemaps: [] };
}

export function parseRobotsSitemaps(text: string): string[] {
  return [...text.matchAll(/^Sitemap:\s*(\S+)/gim)]
    .map((match) => match[1].trim())
    .filter(isHttp);
}

function atomLink(block: string): string {
  const links = [...block.matchAll(/<(?:[\w-]+:)?link\b([^>]*?)\/?>/gi)];
  const hrefOf = (attrs: string) => {
    const href = attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    return href ? decodeEntities(href[1]) : "";
  };
  const alternate = links.find((link) => /rel\s*=\s*["']alternate["']/i.test(link[1]));
  const chosen = alternate || links.find((link) => hrefOf(link[1]));
  return chosen ? hrefOf(chosen[1]) : "";
}

function pageFromBlock(block: string, kind: "rss" | "atom"): DiscoveredPage | null {
  const title = tagText(block, ["title"]);
  const link = kind === "atom" ? atomLink(block) : tagText(block, ["link"]) || tagText(block, ["guid"]);
  if (!isHttp(link)) return null;
  const snippet = tagText(block, ["description", "summary", "content"]);
  const date = tagText(block, ["pubDate", "published", "updated", "date"]);
  return {
    url: link,
    title: title || titleFromUrl(link),
    snippet: snippet.slice(0, 280) || "From feed",
    date: date || undefined,
  };
}

export function parseFeed(xml: string): DiscoveredPage[] {
  const kind = /<(?:[\w-]+:)?feed[\s>]/i.test(xml) ? "atom" : "rss";
  const splitter = kind === "atom" ? /<(?:[\w-]+:)?entry[\s>]/i : /<(?:[\w-]+:)?item[\s>]/i;
  const pages: DiscoveredPage[] = [];
  const seen = new Set<string>();
  for (const block of xml.split(splitter).slice(1)) {
    const page = pageFromBlock(block, kind);
    if (!page || seen.has(page.url)) continue;
    seen.add(page.url);
    pages.push(page);
  }
  return pages;
}

export function parseOpmlFeedUrls(xml: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const match of xml.matchAll(/\bxmlUrl\s*=\s*["']([^"']+)["']/gi)) {
    const url = decodeEntities(match[1]);
    if (!isHttp(url) || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

export function isOpml(xml: string): boolean {
  return /<(?:[\w-]+:)?opml[\s>]/i.test(xml);
}

function htmlAttr(tag: string, name: string): string {
  const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : "";
}

/** RSS/Atom URLs advertised by an HTML page, site-wide feeds before comment feeds. */
export function findFeedLinks(html: string, baseUrl: string): string[] {
  const found: { url: string; comments: boolean }[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const href = htmlAttr(tag, "href");
    if (!href || !/\balternate\b/i.test(htmlAttr(tag, "rel"))) continue;
    if (!/application\/(?:rss|atom)\+xml/i.test(htmlAttr(tag, "type"))) continue;
    let url: string;
    try {
      url = new URL(decodeEntities(href), baseUrl).toString();
    } catch {
      continue;
    }
    if (!isHttp(url) || seen.has(url)) continue;
    seen.add(url);
    found.push({ url, comments: /comment/i.test(htmlAttr(tag, "title")) || /comments?\/feed/i.test(url) });
  }
  return [...found.filter((link) => !link.comments), ...found.filter((link) => link.comments)].map(
    (link) => link.url,
  );
}

export function looksLikeFeed(text: string): boolean {
  const head = text.slice(0, 3000).trimStart();
  if (/^(?:<!doctype html|<html)/i.test(head)) return false;
  return /<(?:[\w-]+:)?(?:rss|feed|RDF)[\s>]/i.test(head);
}

export function feedTitle(xml: string): string {
  const top = xml.split(/<(?:[\w-]+:)?(?:item|entry)[\s>]/i)[0];
  return tagText(top, ["title"]);
}

export interface OpmlFeed {
  title: string;
  feedUrl: string;
  siteUrl: string;
  category: string;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** OPML 2.0 with one folder per knowledge-base category. */
export function buildOpml(
  feeds: OpmlFeed[],
  title = "Web Knowledge Pipeline sources",
  created = new Date(),
): string {
  const groups = new Map<string, OpmlFeed[]>();
  for (const feed of feeds) {
    const key = feed.category || "general";
    groups.set(key, [...(groups.get(key) || []), feed]);
  }
  const folders = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, items]) => {
      const outlines = items
        .map((feed) => {
          const name = escapeXml(feed.title);
          return `      <outline type="rss" text="${name}" title="${name}" xmlUrl="${escapeXml(feed.feedUrl)}" htmlUrl="${escapeXml(feed.siteUrl)}"/>`;
        })
        .join("\n");
      const folder = escapeXml(category);
      return `    <outline text="${folder}" title="${folder}">\n${outlines}\n    </outline>`;
    });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    "  <head>",
    `    <title>${escapeXml(title)}</title>`,
    `    <dateCreated>${created.toUTCString()}</dateCreated>`,
    "  </head>",
    "  <body>",
    ...folders,
    "  </body>",
    "</opml>",
    "",
  ].join("\n");
}
