import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { resolveSavePath } from "@/lib/kb/paths";
import { cleanScrapedMarkdown, findExistingSource } from "@/lib/kb/markdown";
import { defaultScrapeProvider, runScrape } from "@/lib/providers/scrape";
import { recordSiteFeed } from "@/lib/discover/sources";

function checkSiteFeed(url: string, category: string) {
  void recordSiteFeed(url, category).catch((error) => console.error("Site feed check failed:", error));
}

export async function POST(request: Request) {
  try {
    const { url, category, title, returnContentOnly, engine } = await request.json();

    if (!url) {
      return NextResponse.json({ success: false, error: "URL is required" }, { status: 400 });
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return NextResponse.json({ success: false, error: "URL is not valid" }, { status: 400 });
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return NextResponse.json({ success: false, error: "Only http(s) URLs are allowed" }, { status: 400 });
    }

    const scrapeEngine = engine || defaultScrapeProvider();
    const { saveDir, frontmatterCategory, safeTitle } = resolveSavePath(
      category,
      title || "untitled",
    );

    const kbRoot = path.join(process.cwd(), "content", "knowledge-base");
    const filePath = path.join(saveDir, `${safeTitle}.md`);
    if (!returnContentOnly) {
      const existing = await findExistingSource([saveDir, kbRoot], url, filePath);
      if (existing) {
        checkSiteFeed(url, frontmatterCategory);
        return NextResponse.json({
          success: true,
          duplicate: true,
          path: existing,
          engine: scrapeEngine,
        });
      }
    }

    const { markdown: rawMarkdown } = await runScrape(scrapeEngine, url);
    const cleaned = cleanScrapedMarkdown(rawMarkdown);
    const markdownContent = cleaned.trim() ? cleaned : rawMarkdown;

    const frontmatter = `---
title: "${String(title || "untitled").replace(/"/g, '\\"')}"
url: "${url}"
category: "${frontmatterCategory}"
date: "${new Date().toISOString()}"
scrape_engine: "${scrapeEngine}"
---

`;

    const fullContent = frontmatter + markdownContent;

    if (returnContentOnly) {
      return NextResponse.json({ success: true, content: fullContent });
    }

    await fs.mkdir(saveDir, { recursive: true });
    await fs.writeFile(filePath, fullContent, "utf-8");
    checkSiteFeed(url, frontmatterCategory);

    return NextResponse.json({ success: true, path: filePath, engine: scrapeEngine });
  } catch (error) {
    console.error("Scrape API error:", error);
    const errMsg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ success: false, error: errMsg || "Internal Server Error" }, { status: 500 });
  }
}
