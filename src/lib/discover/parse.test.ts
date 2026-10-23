import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOpml,
  feedTitle,
  findFeedLinks,
  isOpml,
  looksLikeFeed,
  parseFeed,
  parseOpmlFeedUrls,
  parseRobotsSitemaps,
  parseSitemap,
} from "./parse.ts";

test("sitemap index returns child sitemaps", () => {
  const xml = `<?xml version="1.0"?><sitemapindex><sitemap><loc>https://example.com/a.xml</loc></sitemap></sitemapindex>`;
  const parsed = parseSitemap(xml);
  assert.deepEqual(parsed.sitemaps, ["https://example.com/a.xml"]);
  assert.deepEqual(parsed.pages, []);
});

test("urlset returns page locs and decodes entities", () => {
  const xml = `<urlset><url><loc>https://example.com/docs/hello-world?x=1&amp;y=2</loc></url></urlset>`;
  const parsed = parseSitemap(xml);
  assert.equal(parsed.pages[0], "https://example.com/docs/hello-world?x=1&y=2");
});

test("rss items keep title link and date", () => {
  const xml = `<rss><channel><item><title><![CDATA[Hello &amp; co]]></title><link>https://example.com/hello</link><pubDate>Mon, 01 Jan 2024</pubDate><description>A note</description></item></channel></rss>`;
  const pages = parseFeed(xml);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].title, "Hello & co");
  assert.equal(pages[0].url, "https://example.com/hello");
  assert.equal(pages[0].date, "Mon, 01 Jan 2024");
});

test("atom uses the alternate link", () => {
  const xml = `<feed><entry><title>Post</title><link href="https://example.com/rel" rel="related" /><link href="https://example.com/post" rel="alternate" /></entry></feed>`;
  const pages = parseFeed(xml);
  assert.equal(pages[0].url, "https://example.com/post");
});

test("opml lists unique feed urls", () => {
  const xml = `<opml><body><outline xmlUrl="https://example.com/feed.xml" /><outline xmlUrl="https://example.com/feed.xml" /></body></opml>`;
  assert.equal(isOpml(xml), true);
  assert.deepEqual(parseOpmlFeedUrls(xml), ["https://example.com/feed.xml"]);
});

test("robots sitemap lines are collected", () => {
  const text = "User-agent: *\nSitemap: https://example.com/sitemap.xml\n";
  assert.deepEqual(parseRobotsSitemaps(text), ["https://example.com/sitemap.xml"]);
});

test("html feed links resolve relative hrefs and put comment feeds last", () => {
  const html = `<head>
    <link rel="stylesheet" href="/style.css">
    <link rel="alternate" type="application/rss+xml" title="Post comments" href="/post/comments/feed/">
    <link type='application/atom+xml' rel='alternate' href='/atom.xml'>
    <link rel="alternate" type="application/rss+xml" title="Blog" href="https://example.com/feed/">
    <link rel="alternate" hreflang="fr" href="/fr/">
  </head>`;
  assert.deepEqual(findFeedLinks(html, "https://example.com/post/"), [
    "https://example.com/atom.xml",
    "https://example.com/feed/",
    "https://example.com/post/comments/feed/",
  ]);
});

test("feed detection rejects html and reads the channel title", () => {
  assert.equal(looksLikeFeed("<!DOCTYPE html><html><body>feed</body></html>"), false);
  assert.equal(looksLikeFeed(`<?xml version="1.0"?><rss version="2.0"><channel>`), true);
  assert.equal(looksLikeFeed(`<feed xmlns="http://www.w3.org/2005/Atom">`), true);
  const xml = `<rss><channel><title>Example Blog</title><item><title>Post</title></item></channel></rss>`;
  assert.equal(feedTitle(xml), "Example Blog");
});

test("opml groups feeds by category, escapes, and round-trips", () => {
  const opml = buildOpml([
    { title: "B & Co", feedUrl: "https://b.com/feed?x=1&y=2", siteUrl: "https://b.com", category: "marketing" },
    { title: "A", feedUrl: "https://a.com/rss.xml", siteUrl: "https://a.com", category: "ai" },
  ]);
  assert.ok(opml.indexOf('text="ai"') < opml.indexOf('text="marketing"'));
  assert.ok(opml.includes('text="B &amp; Co"'));
  assert.deepEqual(parseOpmlFeedUrls(opml), ["https://a.com/rss.xml", "https://b.com/feed?x=1&y=2"]);
});
