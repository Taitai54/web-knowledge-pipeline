import { tavily } from "@tavily/core";
import type { SearchOptions, SearchResult } from "../types";

export function isTavilyConfigured(): boolean {
  const key = process.env.TAVILY_API_KEY;
  return Boolean(key && !key.startsWith("tvly-xxx"));
}

export async function searchTavily(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey || apiKey.startsWith("tvly-xxx")) {
    throw new Error("Tavily API key is missing or invalid");
  }

  const tvly = tavily({ apiKey });
  const timeRange = options.timeRange || "all";
  const days =
    timeRange === "day" ? 1 : timeRange === "week" ? 7 : timeRange === "month" ? 30 : timeRange === "year" ? 365 : undefined;

  const limit = options.limit ?? 20;
  const tavilyResponse = await tvly.search(query, {
    searchDepth: "advanced",
    includeImages: false,
    includeAnswer: false,
    maxResults: limit,
    days,
  });

  return tavilyResponse.results
    .map((r) => ({
      title: r.title,
      url: r.url,
      content: r.content,
      score: r.score,
      date: r.publishedDate || undefined,
    }))
    .sort((a, b) => b.score - a.score);
}
