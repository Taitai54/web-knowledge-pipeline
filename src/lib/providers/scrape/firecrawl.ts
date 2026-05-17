import FirecrawlApp from "@mendable/firecrawl-js";
import type { ScrapeResult } from "../types";

export function isFirecrawlScrapeConfigured(): boolean {
  const key = process.env.FIRECRAWL_API_KEY;
  return Boolean(key && !key.startsWith("fc-xxx"));
}

export async function scrapeFirecrawl(url: string): Promise<ScrapeResult> {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey || apiKey.startsWith("fc-xxx")) {
    throw new Error("Firecrawl API key is missing or invalid");
  }

  const fcApp = new FirecrawlApp({ apiKey });
  const scrapeResponse = await fcApp.scrape(url, { formats: ["markdown"] });

  if (!scrapeResponse?.markdown) {
    throw new Error("Firecrawl returned no markdown content");
  }

  return { markdown: scrapeResponse.markdown };
}
