import type { SearchOptions, SearchResult } from "../types";
import { isExaConfigured, searchExa } from "./exa";
import { isFirecrawlSearchConfigured, searchFirecrawl } from "./firecrawl";
import { checkSearxngHealth, isSearxngConfigured, searchSearxng } from "./searxng";
import { isTavilyConfigured, searchTavily } from "./tavily";

export type SearchProviderId = "searxng" | "exa" | "firecrawl" | "tavily";

export interface SearchProviderInfo {
  id: SearchProviderId;
  label: string;
  configured: boolean;
  healthy?: boolean;
  description: string;
}

export async function listSearchProviders(): Promise<SearchProviderInfo[]> {
  const searxngConfigured = isSearxngConfigured();
  return [
    {
      id: "searxng",
      label: "SearXNG",
      configured: searxngConfigured,
      healthy: searxngConfigured ? await checkSearxngHealth() : false,
      description: "Local Docker — free web search",
    },
    {
      id: "exa",
      label: "Exa",
      configured: isExaConfigured(),
      description: "Semantic search — best for high-quality source discovery",
    },
    {
      id: "tavily",
      label: "Tavily",
      configured: isTavilyConfigured(),
      description: "Cloud search with relevance scores",
    },
    {
      id: "firecrawl",
      label: "Firecrawl",
      configured: isFirecrawlSearchConfigured(),
      description: "Cloud search (uses API credits)",
    },
  ];
}

/** Sync list without health probes (for simple cases). */
export function listSearchProvidersSync(): Omit<SearchProviderInfo, "healthy">[] {
  return [
    {
      id: "searxng",
      label: "SearXNG",
      configured: isSearxngConfigured(),
      description: "Local Docker — free web search",
    },
    {
      id: "exa",
      label: "Exa",
      configured: isExaConfigured(),
      description: "Semantic search — best for high-quality source discovery",
    },
    {
      id: "firecrawl",
      label: "Firecrawl",
      configured: isFirecrawlSearchConfigured(),
      description: "Cloud search (uses API credits)",
    },
    {
      id: "tavily",
      label: "Tavily",
      configured: isTavilyConfigured(),
      description: "Cloud search with relevance scores",
    },
  ];
}

export function defaultSearchProvider(): SearchProviderId {
  if (isSearxngConfigured()) return "searxng";
  if (isExaConfigured()) return "exa";
  if (isTavilyConfigured()) return "tavily";
  if (isFirecrawlSearchConfigured()) return "firecrawl";
  return "searxng";
}

export async function runSearch(
  provider: string,
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult[]> {
  switch (provider) {
    case "searxng":
      return searchSearxng(query, options);
    case "exa":
      return searchExa(query, options);
    case "firecrawl":
      return searchFirecrawl(query, options);
    case "tavily":
      return searchTavily(query, options);
    default:
      throw new Error(`Invalid search provider: ${provider}`);
  }
}
