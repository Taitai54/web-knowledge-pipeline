import FirecrawlApp from "@mendable/firecrawl-js";
import type { SearchOptions, SearchResult } from "../types";

export function isFirecrawlSearchConfigured(): boolean {
  const key = process.env.FIRECRAWL_API_KEY;
  return Boolean(key && !key.startsWith("fc-xxx"));
}

export async function searchFirecrawl(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult[]> {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey || apiKey.startsWith("fc-xxx")) {
    throw new Error("Firecrawl API key is missing or invalid");
  }

  const fcApp = new FirecrawlApp({ apiKey });
  const limit = options.limit ?? 10;
  const searchResponse = await fcApp.search(query, { limit });

  const dataArray =
    searchResponse.web ||
    (searchResponse as { data?: unknown[] }).data ||
    (Array.isArray(searchResponse) ? searchResponse : []);

  return (dataArray as Array<Record<string, unknown>>).map((r) => ({
    title: (r.title as string) || (r.metadata as { title?: string })?.title || "Untitled",
    url: r.url as string,
    content: (r.description as string) || (r.metadata as { description?: string })?.description || "",
    score: 1.0,
    date: (r.metadata as { date?: string })?.date,
  }));
}
