import type { SearchOptions, SearchResult } from "../types";

const EXA_SEARCH_URL = "https://api.exa.ai/search";

export function isExaConfigured(): boolean {
  const key = process.env.EXA_API_KEY?.trim();
  return Boolean(key && !key.startsWith("exa-xxx") && key.length > 8);
}

function publishedDateFilter(timeRange?: string): { startPublishedDate?: string } {
  if (!timeRange || timeRange === "any" || timeRange === "all") {
    return {};
  }

  const start = new Date();
  switch (timeRange) {
    case "day":
      start.setDate(start.getDate() - 1);
      break;
    case "week":
      start.setDate(start.getDate() - 7);
      break;
    case "month":
      start.setMonth(start.getMonth() - 1);
      break;
    case "year":
      start.setFullYear(start.getFullYear() - 1);
      break;
    default:
      return {};
  }

  return { startPublishedDate: start.toISOString() };
}

function scoreFromHighlights(index: number, highlightScores?: number[]): number {
  if (highlightScores?.length) {
    const avg = highlightScores.reduce((a, b) => a + b, 0) / highlightScores.length;
    return Math.min(1, Math.max(0.1, avg));
  }
  return Math.max(0.1, 1 - index * 0.05);
}

export async function searchExa(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult[]> {
  const apiKey = process.env.EXA_API_KEY?.trim();
  if (!apiKey || apiKey.startsWith("exa-xxx")) {
    throw new Error("EXA_API_KEY is missing or invalid. Get a key at https://dashboard.exa.ai");
  }

  const limit = options.limit ?? 20;

  const res = await fetch(EXA_SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      query,
      type: "auto",
      numResults: limit,
      ...publishedDateFilter(options.timeRange),
      contents: {
        highlights: true,
      },
    }),
    signal: AbortSignal.timeout(45_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Exa error ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as {
    results?: Array<{
      title?: string | null;
      url?: string;
      publishedDate?: string | null;
      highlights?: string[];
      highlightScores?: number[];
      summary?: string;
    }>;
  };

  const raw = data.results ?? [];

  return raw
    .map((r, i) => ({
      title: r.title || "Untitled",
      url: r.url || "",
      content: (r.highlights?.join(" ") || r.summary || "").trim(),
      score: scoreFromHighlights(i, r.highlightScores),
      date: r.publishedDate || undefined,
    }))
    .filter((r) => r.url)
    .sort((a, b) => b.score - a.score);
}
