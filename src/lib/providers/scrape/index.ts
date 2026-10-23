import type { ScrapeResult } from "../types";
import { checkCrawl4aiHealth, isCrawl4aiConfigured, scrapeCrawl4ai } from "./crawl4ai";
import { isFirecrawlScrapeConfigured, scrapeFirecrawl } from "./firecrawl";
import { isJinaConfigured, scrapeJina } from "./jina";

export type ScrapeProviderId = "crawl4ai" | "firecrawl" | "jina";

export interface ScrapeProviderInfo {
  id: ScrapeProviderId;
  label: string;
  configured: boolean;
  healthy?: boolean;
  description: string;
}

export async function listScrapeProviders(): Promise<ScrapeProviderInfo[]> {
  const crawl4aiConfigured = isCrawl4aiConfigured();
  return [
    {
      id: "crawl4ai",
      label: "Crawl4AI",
      configured: crawl4aiConfigured,
      healthy: crawl4aiConfigured ? await checkCrawl4aiHealth() : false,
      description: "Local Docker — free Markdown extraction",
    },
    {
      id: "firecrawl",
      label: "Firecrawl",
      configured: isFirecrawlScrapeConfigured(),
      description: "Cloud scrape (uses API credits)",
    },
    {
      id: "jina",
      label: "Jina Reader",
      configured: isJinaConfigured(),
      description: "Free reader — one URL to Markdown, no local Docker",
    },
  ];
}

export function defaultScrapeProvider(): ScrapeProviderId {
  const env = process.env.SCRAPE_ENGINE?.toLowerCase();
  if (env === "firecrawl" && isFirecrawlScrapeConfigured()) return "firecrawl";
  if (env === "jina") return "jina";
  if (env === "crawl4ai" && isCrawl4aiConfigured()) return "crawl4ai";
  if (isCrawl4aiConfigured()) return "crawl4ai";
  if (isFirecrawlScrapeConfigured()) return "firecrawl";
  return "crawl4ai";
}

export async function runScrape(provider: string, url: string): Promise<ScrapeResult> {
  switch (provider) {
    case "crawl4ai":
      return scrapeCrawl4ai(url);
    case "firecrawl":
      return scrapeFirecrawl(url);
    case "jina":
      return scrapeJina(url);
    default:
      throw new Error(`Invalid scrape provider: ${provider}`);
  }
}
